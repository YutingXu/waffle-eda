# Checks Waffle's own title bar in the real Windows app: starts the packaged Waffle.exe on the
# runner's unlocked desktop with a loopback WebView2 debugging port, and runs
# native/windows/tests/title-bar-host.cjs, which drives the window with real mouse input.
# Receipts and PNG captures go to -Output. Like windows-view-feel.ps1, it needs the waffle-windows
# runner in its unlocked console session and an unused native Waffle profile, which it reserves
# for the run and archives afterwards.
#   scripts/ci/windows-title-bar.ps1 -Package dist/Waffle-<version>-windows.zip -Output windows-title-bar
param(
    [Parameter(Mandatory=$true)][string]$Package,
    [Parameter(Mandatory=$true)][string]$Output
)
$ErrorActionPreference = 'Stop'
Add-Type @'
using System;
using System.Runtime.InteropServices;
using System.Text;
public static class TitleBarConsole {
    [DllImport("kernel32.dll")] public static extern uint WTSGetActiveConsoleSessionId();
    [DllImport("user32.dll", SetLastError=true)] static extern IntPtr OpenInputDesktop(uint flags, bool inherit, uint access);
    [DllImport("user32.dll")] static extern bool CloseDesktop(IntPtr desktop);
    [DllImport("user32.dll", CharSet=CharSet.Unicode)]
    static extern bool GetUserObjectInformation(IntPtr handle, int index, StringBuilder value, uint length, out uint needed);
    public static bool Unlocked() {
        var desktop = OpenInputDesktop(0, false, 1);
        if (desktop == IntPtr.Zero) return false;
        try { var name = new StringBuilder(128); return GetUserObjectInformation(desktop, 2, name, 256, out _) && name.ToString() == "Default"; }
        finally { CloseDesktop(desktop); }
    }
}
'@
if ($env:RUNNER_NAME -and $env:RUNNER_NAME -ne 'waffle-windows') { throw 'The title bar check runs on waffle-windows.' }
$Package = (Resolve-Path -LiteralPath $Package).Path
$Output = (New-Item -ItemType Directory -Force $Output).FullName
$session = [Diagnostics.Process]::GetCurrentProcess().SessionId
if ($session -eq 0 -or $session -ne [TitleBarConsole]::WTSGetActiveConsoleSessionId() -or -not [TitleBarConsole]::Unlocked()) {
    throw 'The runner is outside the unlocked console session; the title bar needs a real desktop.'
}
$support = Join-Path ([Environment]::GetFolderPath('LocalApplicationData')) 'Waffle'
if ((Test-Path -LiteralPath $support) -or (Get-Process -Name Waffle -ErrorAction SilentlyContinue)) {
    throw 'An existing Waffle application or profile prevents an isolated test.'
}
$node = if ($env:RUNNER_TEMP) { Join-Path (Split-Path -Parent (Split-Path -Parent $env:RUNNER_TEMP)) 'externals/node24/bin/node.exe' } else { (Get-Command node).Source }
if (-not (Test-Path -LiteralPath $node)) { throw 'Node 24 was not found.' }

$scratch = (New-Item -ItemType Directory (Join-Path ([IO.Path]::GetTempPath()) ('waffle-title-bar-' + [Guid]::NewGuid().ToString('N').Substring(0,8)))).FullName
$application = $null
$ownsProfile = $false
$token = [Guid]::NewGuid().ToString('N')
$ownerFile = Join-Path $support '.waffle-title-bar-owner'
try {
    # WinForms keeps native state in the Known Folder, which a WebView2 folder alone does not redirect.
    New-Item -ItemType Directory -Path $support -ErrorAction Stop | Out-Null
    [IO.File]::WriteAllText($ownerFile, $token)
    $ownsProfile = $true
    $app = Join-Path $scratch 'app'
    Expand-Archive -LiteralPath $Package -DestinationPath $app
    $exe = Join-Path $app 'Waffle.exe'
    if (-not (Test-Path -LiteralPath (Join-Path $app 'window-caption.js'))) { throw 'The package has no window-caption.js.' }
    $listener = [Net.Sockets.TcpListener]::new([Net.IPAddress]::Loopback, 0)
    $listener.Start(); $port = $listener.LocalEndpoint.Port; $listener.Stop()
    $launch = [Diagnostics.ProcessStartInfo]::new($exe)
    $launch.UseShellExecute = $false
    $launch.WorkingDirectory = $app
    $launch.Environment['WEBVIEW2_USER_DATA_FOLDER'] = Join-Path $scratch 'webview2-profile'
    $launch.Environment['WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS'] = "--remote-debugging-address=127.0.0.1 --remote-debugging-port=$port"
    $application = [Diagnostics.Process]::Start($launch)
    $env:WAFFLE_TITLE_BAR_PWSH = Join-Path $PSHOME 'pwsh.exe'
    & $node (Join-Path $PSScriptRoot '../../native/windows/tests/title-bar-host.cjs') "$port" $Output "$($application.Id)" (Join-Path $PSScriptRoot '../../native/windows/tests/title-bar-native.ps1')
    if ($LASTEXITCODE -ne 0) { throw "The title bar check failed ($LASTEXITCODE); see $Output/title-bar.json." }
} finally {
    if ($application) {
        if (-not $application.HasExited) {
            [void]$application.CloseMainWindow()
            if (-not $application.WaitForExit(2500)) { $application.Kill($true) }
        }
        $application.Dispose()
    }
    if ($ownsProfile -and (Test-Path -LiteralPath $support)) {
        $unexpected = @(Get-ChildItem -LiteralPath $support -Force | Where-Object {
            $_.PSIsContainer -or ($_.Attributes -band [IO.FileAttributes]::ReparsePoint) -or $_.Name -notin @('.waffle-title-bar-owner', 'window.json')
        })
        if ($unexpected.Count -or (Get-Content -Raw -LiteralPath $ownerFile) -ne $token -or (Get-Process -Name Waffle -ErrorAction SilentlyContinue)) {
            Write-Warning 'Kept the native Waffle profile: it could not be proven to hold only this check''s state.'
        } else {
            [IO.Directory]::Move($support, (Join-Path (Split-Path -Parent $support) ('Waffle-title-bar-retained-' + $token)))
        }
    }
    Remove-Item -LiteralPath $scratch -Recurse -Force -ErrorAction Continue
}
