# Builds, tests and packages Waffle for Windows on Windows (PowerShell 5.1 or 7).
#   scripts\build-windows.ps1 [-OutDir dist] [-Msix] [-SkipTests]
#                             [-CertificateThumbprint <sha1>] [-TimestampUrl <url>]
# Needs the .NET SDK 8+, Python 3 and the pinned Rust toolchain with the WASM target.
# -Msix also needs makeappx.exe from the Windows SDK.
# Output: <OutDir>\Waffle-windows\, <OutDir>\Waffle-<version>-windows.zip and, with -Msix,
# <OutDir>\Waffle-<version>.msix (unsigned unless a certificate thumbprint is given).
#
# Code signing slots (unused by default): pass -CertificateThumbprint to sign Waffle.exe
# before zipping and the .msix after packing with signtool.exe (Windows SDK). The MSIX
# Publisher in native\windows\packaging\AppxManifest.xml must then equal the certificate subject.
param(
  [string]$OutDir = "",
  [switch]$Msix,
  [switch]$SkipTests,
  [string]$CertificateThumbprint = "",
  [string]$TimestampUrl = "http://timestamp.digicert.com"
)
$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
$win = Join-Path $root "native\windows"
if (-not $OutDir) { $OutDir = Join-Path $root "dist" }
New-Item -ItemType Directory -Force -Path $OutDir | Out-Null
$OutDir = (Resolve-Path $OutDir).Path
$env:DOTNET_CLI_TELEMETRY_OPTOUT = "1"; $env:DOTNET_NOLOGO = "1"

function Invoke-Checked([string]$exe, [string[]]$arguments) {
  & $exe @arguments
  if ($LASTEXITCODE -ne 0) { throw "$exe $($arguments -join ' ') failed with exit code $LASTEXITCODE" }
}

function Find-SdkTool([string]$name) {
  $found = Get-Command $name -ErrorAction SilentlyContinue
  if ($found) { return $found.Source }
  $kits = Join-Path ${env:ProgramFiles(x86)} "Windows Kits\10\bin"
  if (Test-Path $kits) {
    $tool = Get-ChildItem -Path $kits -Recurse -Filter $name -ErrorAction SilentlyContinue |
      Where-Object { $_.FullName -match "\\x64\\" } | Sort-Object FullName -Descending | Select-Object -First 1
    if ($tool) { return $tool.FullName }
  }
  throw "$name was not found. Install the Windows SDK or add it to PATH."
}

function Sign-File([string]$path) {
  if (-not $CertificateThumbprint) { return }
  $signtool = Find-SdkTool "signtool.exe"
  Invoke-Checked $signtool @("sign", "/sha1", $CertificateThumbprint, "/fd", "SHA256", "/tr", $TimestampUrl, "/td", "SHA256", $path)
}

if (-not $SkipTests) {
  Invoke-Checked "dotnet" @("run", "--project", (Join-Path $win "tests"), "-c", "Release")
}
$version = (Get-Content -Raw (Join-Path $root "app\VERSION")).Trim()
if ($version -notmatch '^\d+\.\d+\.\d+$') { throw "Invalid app/VERSION: $version" }
$stage = Join-Path $OutDir "Waffle-windows"
Invoke-Checked "dotnet" @("build", (Join-Path $win "Waffle.Windows.csproj"), "-c", "Release", "-t:WafflePackage", "-p:WaffleDist=$OutDir", "-nologo", "-v:minimal")
$zip = Join-Path $OutDir "Waffle-$version-windows.zip"
if ($CertificateThumbprint) {
  # Sign the staged executable, then zip again so the archive carries the signed copy.
  Sign-File (Join-Path $stage "Waffle.exe")
  Remove-Item -Force $zip
  Compress-Archive -Path (Join-Path $stage "*") -DestinationPath $zip
}
Write-Host $zip

if ($Msix) {
  $makeappx = Find-SdkTool "makeappx.exe"
  $msixStage = Join-Path $OutDir "Waffle-msix"
  if (Test-Path $msixStage) { Remove-Item -Recurse -Force $msixStage }
  Copy-Item -Recurse $stage $msixStage
  Copy-Item -Recurse (Join-Path $win "packaging\Assets") (Join-Path $msixStage "Assets")
  (Get-Content -Raw (Join-Path $win "packaging\AppxManifest.xml")).Replace("__VERSION__", "$version.0") |
    Set-Content -Encoding UTF8 (Join-Path $msixStage "AppxManifest.xml")
  $package = Join-Path $OutDir "Waffle-$version.msix"
  Invoke-Checked $makeappx @("pack", "/o", "/d", $msixStage, "/p", $package)
  Sign-File $package
  Remove-Item -Recurse -Force $msixStage
  Write-Host $package
  if (-not $CertificateThumbprint) { Write-Host "Unsigned: install with Add-AppxPackage -AllowUnsigned (Windows 11, administrator)." }
}
