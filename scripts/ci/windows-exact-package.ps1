param([switch]$Acquire)
$ErrorActionPreference = 'Stop'
$root = (Resolve-Path (Join-Path $PSScriptRoot '../..')).Path
$evidence = (New-Item -ItemType Directory -Force (Join-Path $root '.evidence/exact-windows')).FullName
function Write-Receipt([string]$Name, $Value) {
    $Value | ConvertTo-Json -Depth 12 | Set-Content -LiteralPath (Join-Path $evidence $Name) -Encoding utf8
}
function File-SHA([string]$Path) {
    (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash.ToLowerInvariant()
}
function Assert-SHA([string]$Path, [string]$Expected) {
    if ((File-SHA $Path) -cne $Expected) { throw "SHA-256 mismatch for $(Split-Path -Leaf $Path)." }
}

if ($env:RUNNER_NAME -ne 'waffle-windows' -or $env:GITHUB_EVENT_NAME -ne 'workflow_dispatch') {
    throw 'The exact package probe requires manual dispatch on waffle-windows.'
}
$receipt = Get-Content -Raw -LiteralPath (Join-Path $root 'build-receipt.json') | ConvertFrom-Json
$win = $receipt.windows
$version = $receipt.version
if ($version -notmatch '^\d+\.\d+\.\d+$' -or $env:GITHUB_REF -cnotmatch ('^refs/tags/v' + [regex]::Escape($version) + '-preview\.[1-9]\d*$') -or
    $receipt.tag -cne $env:GITHUB_REF_NAME -or $receipt.releaseSource -cnotmatch '^[a-f0-9]{40}$' -or
    $receipt.releaseSourceTree -cnotmatch '^[a-f0-9]{40}$' -or $win.file -cne "Waffle-$version-windows.zip" -or
    $win.bytes -le 0 -or $env:QA_PACKAGE_SHA256 -cnotmatch '^[a-f0-9]{64}$' -or
    $win.sha256 -cne $env:QA_PACKAGE_SHA256 -or $win.executableSha256 -cnotmatch '^[a-f0-9]{64}$' -or
    $win.productVersion -cnotin @($version, "$version+$($receipt.releaseSource)")) {
    throw 'The tag, release source, version and independently supplied Windows ZIP digest must match the build receipt.'
}
$zip = Join-Path $env:RUNNER_TEMP ('waffle-exact-' + $env:GITHUB_RUN_ID + '-' + $env:GITHUB_RUN_ATTEMPT + '.zip')

if ($Acquire) {
    if ($env:QA_RELEASE_ID -notmatch '^[1-9]\d{0,18}$' -or $env:QA_ASSET_ID -notmatch '^[1-9]\d{0,18}$' -or
        $env:GITHUB_REPOSITORY -notmatch '^[a-zA-Z0-9_.-]+/[a-zA-Z0-9_.-]+$' -or -not $env:GH_TOKEN) {
        throw 'Set the numeric Preview release and Windows asset IDs for this repository.'
    }
    $base = "https://api.github.com/repos/$env:GITHUB_REPOSITORY/releases"
    $headers = @{ Authorization = "Bearer $env:GH_TOKEN"; Accept = 'application/vnd.github+json'; 'X-GitHub-Api-Version' = '2022-11-28' }
    $release = Invoke-RestMethod -Uri "$base/$env:QA_RELEASE_ID" -Headers $headers -TimeoutSec 30
    $asset = @($release.assets | Where-Object { [string]$_.id -ceq $env:QA_ASSET_ID })
    if ((-not $release.draft -and -not $release.prerelease) -or $release.tag_name -cne $receipt.tag -or $asset.Count -ne 1 -or
        $asset[0].name -cne $win.file -or $asset[0].state -cne 'uploaded' -or $asset[0].size -ne $win.bytes -or
        ($asset[0].digest -and $asset[0].digest -cne "sha256:$($win.sha256)")) {
        throw 'The asset must belong to the matching Preview draft or published prerelease and have the expected filename, digest and size.'
    }
    if (Test-Path -LiteralPath $zip) { throw 'The runner download path already exists.' }
    $headers.Accept = 'application/octet-stream'
    try {
        # Invoke-WebRequest strips Authorization when GitHub redirects to asset storage.
        Invoke-WebRequest -Uri "$base/assets/$env:QA_ASSET_ID" -Headers $headers -OutFile $zip -TimeoutSec 120
        Assert-SHA $zip $win.sha256
    } catch {
        Remove-Item -LiteralPath $zip -Force -ErrorAction SilentlyContinue
        throw
    }
    Write-Receipt 'asset.json' @{
        tag=$receipt.tag; releaseId=$release.id; assetId=$asset[0].id; file=$win.file; bytes=$win.bytes
        sha256=$win.sha256; source=$receipt.releaseSource; sourceTree=$receipt.releaseSourceTree
        releaseDraft=$release.draft; releasePrerelease=$release.prerelease
    }
    return
}

Add-Type @'
using System;
using System.Runtime.InteropServices;
using System.Text;
public static class ExactWaffleConsole {
    [DllImport("kernel32.dll")] public static extern uint WTSGetActiveConsoleSessionId();
    [DllImport("user32.dll")] private static extern IntPtr OpenInputDesktop(uint flags, bool inherit, uint access);
    [DllImport("user32.dll")] private static extern bool CloseDesktop(IntPtr desktop);
    [DllImport("user32.dll")] private static extern bool GetUserObjectInformation(IntPtr handle, int index, StringBuilder value, uint length, out uint needed);
    [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr window);
    [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr window);
    [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr window);
    public static bool Unlocked() {
        var desktop = OpenInputDesktop(0, false, 1);
        if (desktop == IntPtr.Zero) return false;
        try {
            var name = new StringBuilder(128);
            return GetUserObjectInformation(desktop, 2, name, 256, out _) && name.ToString() == "Default";
        } finally { CloseDesktop(desktop); }
    }
}
'@
$session = [Diagnostics.Process]::GetCurrentProcess().SessionId
if ($session -eq 0) { throw 'Native WebView2 smoke requires an interactive Windows user session.' }
$activeConsole = $session -eq [ExactWaffleConsole]::WTSGetActiveConsoleSessionId()
$desktopUnlocked = $activeConsole -and [ExactWaffleConsole]::Unlocked()
$node = Join-Path (Split-Path -Parent (Split-Path -Parent $env:RUNNER_TEMP)) 'externals/node24/bin/node.exe'
if (-not (Test-Path -LiteralPath $node)) { throw 'The installed runner Node 24 executable is missing.' }
$adapters = @(Get-CimInstance Win32_VideoController | Where-Object { $_.PNPDeviceID -like 'PCI*' -and $_.Name -eq 'NVIDIA GeForce RTX 5080' })
$expectedAdapter = 'NVIDIA GeForce RTX 5080'
$scratch = (New-Item -ItemType Directory (Join-Path $env:RUNNER_TEMP ('waffle-smoke-' + [Guid]::NewGuid().ToString('N')))).FullName
function Invoke-Smoke([string]$Phase) {
    $listener = [Net.Sockets.TcpListener]::new([Net.IPAddress]::Loopback,0)
    $listener.Start()
    $port = $listener.LocalEndpoint.Port
    $listener.Stop()
    $start = [Diagnostics.ProcessStartInfo]::new($exe)
    $start.UseShellExecute = $false
    $start.WorkingDirectory = $package
    $start.ArgumentList.Add((Join-Path $fixture 'Board.waffle'))
    $phaseTemp = (New-Item -ItemType Directory (Join-Path $scratch ('waffle-preview-' + [Guid]::NewGuid().ToString('N')))).FullName
    $support = Join-Path $phaseTemp 'waffle-native-profile'
    $start.Environment['TMP'] = $phaseTemp
    $start.Environment['TEMP'] = $phaseTemp
    $start.Environment['WAFFLE_QUALIFICATION_PROFILE'] = '1'
    $start.Environment['WEBVIEW2_USER_DATA_FOLDER'] = Join-Path $support 'WebView2'
    $start.Environment['WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS'] = "--remote-debugging-address=127.0.0.1 --remote-debugging-port=$port"
    $app = [Diagnostics.Process]::Start($start)
    try {
        $foreground = $false
        for ($attempt = 0; $attempt -lt 24 -and $desktopUnlocked; $attempt++) {
            Start-Sleep -Milliseconds 250
            $app.Refresh()
            if ($app.HasExited) { throw "Waffle exited with $($app.ExitCode)." }
            $handle = $app.MainWindowHandle
            if ($handle -eq [IntPtr]::Zero -or -not [ExactWaffleConsole]::IsWindowVisible($handle) -or
                [ExactWaffleConsole]::IsIconic($handle)) { continue }
            if ([ExactWaffleConsole]::GetForegroundWindow() -ne $handle) { [void][ExactWaffleConsole]::SetForegroundWindow($handle) }
            if ([ExactWaffleConsole]::GetForegroundWindow() -eq $handle) { $foreground = $true; break }
        }
        Write-Receipt "window-$Phase.json" @{
            pid=$app.Id; foreground=$foreground; userSession=$session; activeConsole=$activeConsole; desktopUnlocked=$desktopUnlocked
        }
        & $node (Join-Path $PSScriptRoot 'windows-exact-package.cjs') $Phase $port $evidence $version $expectedAdapter ([int]($foreground -and $adapters.Count -eq 1))
        if ($LASTEXITCODE -ne 0) { throw "Native WebView2 smoke failed in $Phase." }
        if (-not (Test-Path -LiteralPath (Join-Path $support 'recent-projects.json'))) {
            throw "The packaged host did not prove native support isolation in $Phase."
        }
        Write-Receipt "native-profile-$Phase.json" @{ status='verified-in-runner-temp'; ephemeral=$true }
    } finally {
        if (-not $app.HasExited) {
            [void]$app.CloseMainWindow()
            if (-not $app.WaitForExit(3000)) { $app.Kill($true); $app.WaitForExit() }
        }
        $app.Dispose()
    }
}
try {
    Assert-SHA $zip $win.sha256
    if ((Get-Item -LiteralPath $zip).Length -ne $win.bytes) { throw 'Windows ZIP size changed.' }
    $package = Join-Path $scratch 'portable'
    Expand-Archive -LiteralPath $zip -DestinationPath $package
    $exe = Join-Path $package 'Waffle.exe'
    Assert-SHA $exe $win.executableSha256
    # The managed host embeds this UTF-16 constant. Reject older hosts before
    # launching, since they could otherwise use the ordinary user profile.
    $image = [IO.File]::ReadAllBytes($exe)
    $profileMarker = 'WAFFLE_QUALIFICATION_PROFILE'
    $hasIsolation = (0,1).Where({ [Text.Encoding]::Unicode.GetString($image, $_, $image.Length - $_).Contains($profileMarker) })
    if (-not $hasIsolation.Count) { throw 'The executable does not implement the isolated qualification support path.' }
    $product = (Get-Item -LiteralPath $exe).VersionInfo.ProductVersion
    $appVersion = (Get-Content -Raw -LiteralPath (Join-Path $package 'app/VERSION')).Trim()
    if ($product -cne $win.productVersion -or $appVersion -cne $version) { throw 'The extracted executable or app version differs from the release receipt.' }
    Write-Receipt 'package.json' @{
        sha256=$win.sha256; executableSha256=$win.executableSha256; productVersion=$product; appVersion=$appVersion
        source=$receipt.releaseSource; sourceTree=$receipt.releaseSourceTree; observedAdapters=$adapters
    }
    $fixture = Join-Path $scratch 'project'
    $original = Join-Path $root 'mcp/examples/sensor-interface'
    $originalBoard = Join-Path $original 'Sensor board.wpcb'
    $originalHash = File-SHA $originalBoard
    Copy-Item -LiteralPath $original -Destination $fixture -Recurse
    $fixtureBoard = Join-Path $fixture 'Sensor board.wpcb'
    Assert-SHA $fixtureBoard $originalHash

    Invoke-Smoke 'save'
    $savedHash = File-SHA $fixtureBoard
    if ($savedHash -ceq $originalHash) { throw 'The native Save did not change the persisted board.' }
    Assert-SHA $originalBoard $originalHash
    Invoke-Smoke 'reopen'
    Assert-SHA $fixtureBoard $savedHash
    Assert-SHA $originalBoard $originalHash
    Write-Receipt 'saved-board.json' @{ originalSha256=$originalHash; savedSha256=$savedHash; freshNativeReopen=$true }

    # Inventory existing WSL only. The Preview qualification does not install or start a distribution.
    $wsl = Get-Command wsl.exe -ErrorAction SilentlyContinue
    if ($wsl) {
        $installed = & $wsl.Source --list --quiet 2>$null
        Write-Receipt 'wsl.json' @{ listExit=$LASTEXITCODE; distributions=@($installed | ForEach-Object { ($_ -replace "\x00",'').Trim() } | Where-Object { $_ }) }
    }
} finally {
    Remove-Item -LiteralPath $scratch -Recurse -Force -ErrorAction Continue
    Remove-Item -LiteralPath $zip -Force -ErrorAction Continue
}
