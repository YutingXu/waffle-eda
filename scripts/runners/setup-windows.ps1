<#
.SYNOPSIS
  Registers this Windows x64 machine as a self-hosted GitHub Actions runner for Waffle and installs
  it as a Windows service. Run in an elevated PowerShell (service installation needs admin).

.EXAMPLE
  $env:RUNNER_TOKEN = (gh api -X POST repos/OWNER/REPO/actions/runners/registration-token --jq .token)
  .\scripts\runners\setup-windows.ps1 -Repo OWNER/REPO
  # Remove:
  .\scripts\runners\setup-windows.ps1 -Repo OWNER/REPO -Remove

.NOTES
  Labels: self-hosted, Windows, X64 (added by the runner) plus "atrium". After registering, set the
  repository variable WINDOWS_RUNNER=true so the gated Windows jobs run.
  The token comes from -Token, $env:RUNNER_TOKEN or gh, and is never printed or written to disk by
  this script (config.cmd stores only the runner's own credentials in the install folder).
#>
[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)][ValidatePattern('^[^/]+/[^/]+$')][string]$Repo,
  [string]$Token = $env:RUNNER_TOKEN,
  [string]$Name = "atrium-windows-$env:COMPUTERNAME",
  [string]$Dir = "C:\actions-runner-atrium",
  [string]$Labels = "atrium",
  [string]$ServiceAccount = "",   # default: NT AUTHORITY\NETWORK SERVICE
  [switch]$NoService,
  [switch]$Remove
)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

# Pinned release; SHA-256 copied from the v2.338.2 release notes ("SHA-256 Checksums").
$PinnedVersion = '2.338.2'
$PinnedSha = @{
  'win-x64'   = 'a1f17aa987fc8158bc7521d284912267a0d01b7c2c4684b33c86783b5e8221cc'
  'win-arm64' = '0790e3f586c2c5388ed8e293e7cef01bd0e8a2c5c68dd0a628f848b61da4b3a7'
}

function Get-RunnerToken([string]$Kind) {
  if ($script:Token) { return $script:Token }
  if (-not (Get-Command gh -ErrorAction SilentlyContinue)) { throw "No token: set RUNNER_TOKEN, pass -Token, or install and log in to gh." }
  $t = gh api -X POST "repos/$Repo/actions/runners/$Kind" --jq .token
  if (-not $t) { throw "gh could not create a $Kind for $Repo (needs admin rights on the repository)." }
  return $t
}

if ($Remove) {
  if (-not (Test-Path "$Dir\.runner")) { Write-Host "No configured runner in $Dir"; exit 0 }
  Push-Location $Dir
  try { & .\config.cmd remove --token (Get-RunnerToken 'remove-token') } finally { Pop-Location }
  Write-Host "Runner removed from $Repo (config.cmd also removes its service). Delete $Dir when done."
  exit 0
}

$platform = if ($env:PROCESSOR_ARCHITECTURE -eq 'ARM64') { 'win-arm64' } else { 'win-x64' }
$version = if ($env:RUNNER_VERSION) { $env:RUNNER_VERSION } else { $PinnedVersion }
if ($version -eq $PinnedVersion) {
  $expected = $PinnedSha[$platform]
} else {
  $notes = (Invoke-RestMethod "https://api.github.com/repos/actions/runner/releases/tags/v$version").body
  $m = [regex]::Match($notes, "BEGIN SHA $platform -->([0-9a-f]{64})<!-- END SHA")
  if (-not $m.Success) { throw "No SHA-256 for $platform in the v$version release notes." }
  $expected = $m.Groups[1].Value
}

if (Test-Path "$Dir\config.cmd") { throw "$Dir already holds a runner; use -Remove first, or -Dir." }
New-Item -ItemType Directory -Force -Path $Dir | Out-Null
$file = "actions-runner-$platform-$version.zip"
$zip = Join-Path ([IO.Path]::GetTempPath()) $file
Write-Host "Downloading actions/runner v$version ($platform)"
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
Invoke-WebRequest -UseBasicParsing -Uri "https://github.com/actions/runner/releases/download/v$version/$file" -OutFile $zip
$actual = (Get-FileHash -Algorithm SHA256 $zip).Hash.ToLowerInvariant()
if ($actual -ne $expected) { Remove-Item $zip; throw "SHA-256 mismatch for ${file}: got $actual, expected $expected" }
Write-Host "SHA-256 verified: $actual"
Add-Type -AssemblyName System.IO.Compression.FileSystem
[IO.Compression.ZipFile]::ExtractToDirectory($zip, $Dir)
Remove-Item $zip

$cfgArgs = @('--unattended', '--url', "https://github.com/$Repo", '--token', (Get-RunnerToken 'registration-token'),
          '--name', $Name, '--labels', $Labels, '--work', '_work', '--replace', '--disableupdate')
if (-not $NoService) {
  $cfgArgs += '--runasservice'
  if ($ServiceAccount) { $cfgArgs += @('--windowslogonaccount', $ServiceAccount) }  # prompts for its password
}
Push-Location $Dir
try { & .\config.cmd @cfgArgs } finally { Pop-Location }
if ($LASTEXITCODE -ne 0) { throw "config.cmd failed ($LASTEXITCODE)" }
if ($NoService) { Write-Host "Configured. Start it with: $Dir\run.cmd" }
else { Get-Service 'actions.runner.*' | Format-Table Name, Status, StartType }
Write-Host "Next: set the repository variable WINDOWS_RUNNER=true (gh variable set WINDOWS_RUNNER --body true --repo $Repo)."
