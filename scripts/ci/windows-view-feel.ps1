param(
    [string]$Package,
    [string]$Output,
    [string]$ExpectedSHA256,
    [string]$ExpectedExecutableSHA256,
    [string]$PackagedCandidate,
    [string]$PackagedTree,
    [ValidateSet('GargantuRAM','PiDP')][string]$Board = 'GargantuRAM',
    [string]$ExpectedAdapter = 'NVIDIA GeForce RTX 5080',
    [int[]]$ExpectedDisplay = @(),
    [ValidateRange(1,5)][int]$Repetitions = 2,
    [switch]$Trace,
    [int]$ProbePid = 0,
    [switch]$ActivateProbeWindow
)
$ErrorActionPreference = 'Stop'

Add-Type @'
using System;
using System.Runtime.InteropServices;
using System.Text;
public static class ViewFeelWindow {
    [StructLayout(LayoutKind.Sequential)] public struct Point { public int X, Y; }
    [StructLayout(LayoutKind.Sequential)] private struct LastInput { public uint Size, Time; }
    [StructLayout(LayoutKind.Sequential)] public struct Rect { public int Left, Top, Right, Bottom; }
    [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)]
    public struct MonitorInformation {
        public int Size;
        public Rect Monitor, Work;
        public uint Flags;
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst=32)] public string Name;
    }
    [StructLayout(LayoutKind.Explicit, CharSet=CharSet.Unicode, Size=220)]
    public struct DisplayMode {
        [FieldOffset(68)] public ushort Size;
        [FieldOffset(172)] public uint Width;
        [FieldOffset(176)] public uint Height;
        [FieldOffset(184)] public uint Refresh;
    }
    [DllImport("kernel32.dll")] public static extern uint WTSGetActiveConsoleSessionId();
    [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr window);
    [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr window);
    [DllImport("user32.dll")] public static extern uint GetDpiForWindow(IntPtr window);
    [DllImport("user32.dll")] public static extern IntPtr MonitorFromWindow(IntPtr window, uint flags);
    [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr window, out Rect rect);
    [DllImport("user32.dll")] private static extern bool SetForegroundWindow(IntPtr window);
    [DllImport("user32.dll")] private static extern IntPtr WindowFromPoint(Point point);
    [DllImport("user32.dll")] private static extern IntPtr GetAncestor(IntPtr window, uint mode);
    [DllImport("user32.dll")] private static extern bool GetCursorPos(out Point point);
    [DllImport("user32.dll")] private static extern bool SetCursorPos(int x, int y);
    [DllImport("user32.dll")] private static extern bool GetLastInputInfo(ref LastInput result);
    [DllImport("user32.dll")] private static extern short GetAsyncKeyState(int key);
    [DllImport("user32.dll")] private static extern void mouse_event(uint flags, uint x, uint y, uint data, UIntPtr extra);
    [DllImport("user32.dll")] private static extern IntPtr SetThreadDpiAwarenessContext(IntPtr context);
    [DllImport("user32.dll", CharSet=CharSet.Unicode)] private static extern bool GetMonitorInfo(IntPtr monitor, ref MonitorInformation info);
    [DllImport("user32.dll", CharSet=CharSet.Unicode)] private static extern bool EnumDisplaySettings(string name, int index, ref DisplayMode mode);
    [DllImport("user32.dll", SetLastError=true)] private static extern IntPtr OpenInputDesktop(uint flags, bool inherit, uint access);
    [DllImport("user32.dll")] private static extern bool CloseDesktop(IntPtr desktop);
    [DllImport("user32.dll", CharSet=CharSet.Unicode)]
    private static extern bool GetUserObjectInformation(IntPtr handle, int index, StringBuilder value, uint length, out uint needed);
    [DllImport("dwmapi.dll")] private static extern int DwmGetWindowAttribute(IntPtr window, uint attribute, out int value, uint size);
    public static bool Unlocked() {
        var desktop = OpenInputDesktop(0, false, 1);
        if (desktop == IntPtr.Zero) return false;
        try {
            var name = new StringBuilder(128);
            return GetUserObjectInformation(desktop, 2, name, 256, out _) && name.ToString() == "Default";
        } finally { CloseDesktop(desktop); }
    }
    public static bool TryActivate(IntPtr window, uint session) {
        if (window == IntPtr.Zero || session == 0 || session != WTSGetActiveConsoleSessionId() || !Unlocked() ||
            !IsWindowVisible(window) || IsIconic(window)) return false;
        if (GetForegroundWindow() == window) return true;
        var last = new LastInput { Size = (uint)Marshal.SizeOf(typeof(LastInput)) };
        if (!GetLastInputInfo(ref last) || unchecked((uint)Environment.TickCount-last.Time) < 15000 ||
            GetAsyncKeyState(1) < 0 || GetAsyncKeyState(2) < 0 || GetAsyncKeyState(4) < 0) return false;
        SetForegroundWindow(window);
        System.Threading.Thread.Sleep(90);
        if (GetForegroundWindow() == window) return true;
        var prior = SetThreadDpiAwarenessContext(new IntPtr(-4));
        try {
            if (!GetWindowRect(window, out Rect bounds) || !GetCursorPos(out Point old)) return false;
            var spot = new Point { X = (bounds.Left + bounds.Right)/2,
                Y = bounds.Top + Math.Max(12, (int)(GetDpiForWindow(window)/6)) };
            IntPtr hit = WindowFromPoint(spot);
            if (hit != window && GetAncestor(hit,2) != window) return false;
            if (!SetCursorPos(spot.X,spot.Y)) return false;
            try {
                mouse_event(2,0,0,0,UIntPtr.Zero);
                mouse_event(4,0,0,0,UIntPtr.Zero);
                System.Threading.Thread.Sleep(90);
                return GetForegroundWindow() == window;
            } finally {
                if (GetCursorPos(out Point current) && current.X == spot.X && current.Y == spot.Y)
                    SetCursorPos(old.X,old.Y);
            }
        } finally { if (prior != IntPtr.Zero) SetThreadDpiAwarenessContext(prior); }
    }
    public static object Inspect(IntPtr window, int pid, uint session) {
        var prior = SetThreadDpiAwarenessContext(new IntPtr(-4));
        try {
            var monitor = MonitorFromWindow(window, 0);
            MonitorInformation info = new MonitorInformation { Size = Marshal.SizeOf(typeof(MonitorInformation)) };
            DisplayMode mode = new DisplayMode { Size = (ushort)Marshal.SizeOf(typeof(DisplayMode)) };
            bool found = monitor != IntPtr.Zero && GetMonitorInfo(monitor, ref info) && EnumDisplaySettings(info.Name, -1, ref mode);
            Rect bounds;
            GetWindowRect(window, out bounds);
            bool visible = window != IntPtr.Zero && IsWindowVisible(window) && !IsIconic(window)
                && DwmGetWindowAttribute(window, 14, out int cloaked, 4) == 0 && cloaked == 0;
            var foregroundWindow = GetForegroundWindow();
            return new {
                visible, foreground = window != IntPtr.Zero && foregroundWindow == window, pid, session,
                activeConsole = session > 0 && session == WTSGetActiveConsoleSessionId() && Unlocked(),
                refreshHz = found ? mode.Refresh : 0, width = found ? mode.Width : 0, height = found ? mode.Height : 0,
                monitor = found ? info.Name : null, dpi = GetDpiForWindow(window),
                windowHandle = window.ToInt64(), foregroundHandle = foregroundWindow.ToInt64(),
                bounds = new [] { bounds.Left, bounds.Top, bounds.Right, bounds.Bottom }
            };
        } finally { if (prior != IntPtr.Zero) SetThreadDpiAwarenessContext(prior); }
    }
}
'@

if ($ProbePid) {
    $application = Get-Process -Id $ProbePid
    if ($ActivateProbeWindow) {
        [void][ViewFeelWindow]::TryActivate($application.MainWindowHandle, [uint32]$application.SessionId)
        $application.Refresh()
    }
    [ViewFeelWindow]::Inspect($application.MainWindowHandle, $ProbePid, [uint32]$application.SessionId) | ConvertTo-Json -Compress
    exit
}

function Check-File([string]$path, [string]$sha) {
    $actual = (Get-FileHash -LiteralPath $path -Algorithm SHA256).Hash
    if ($actual -ne $sha) { throw "Checksum mismatch for $(Split-Path -Leaf $path)." }
}
function Write-Receipt([string]$name, $data) {
    ConvertTo-Json -InputObject $data -Depth 12 | Set-Content -LiteralPath (Join-Path $Output $name) -Encoding utf8
}

if (-not $Package -or -not $Output -or
    $ExpectedSHA256 -notmatch '^[a-f0-9]{64}$' -or $ExpectedExecutableSHA256 -notmatch '^[a-f0-9]{64}$' -or
    $PackagedCandidate -notmatch '^[a-f0-9]{40}$' -or $PackagedTree -notmatch '^[a-f0-9]{40}$') {
    throw 'Set -Package, -Output, -ExpectedSHA256, -ExpectedExecutableSHA256, -PackagedCandidate and -PackagedTree.'
}
if ($env:RUNNER_NAME -ne 'waffle-windows') { throw 'The Windows timing gate requires waffle-windows.' }
$Package = (Resolve-Path -LiteralPath $Package).Path
Check-File $Package $ExpectedSHA256
$Output = (New-Item -ItemType Directory -Force $Output).FullName
$session = [Diagnostics.Process]::GetCurrentProcess().SessionId
if ($session -eq 0 -or $session -ne [ViewFeelWindow]::WTSGetActiveConsoleSessionId() -or -not [ViewFeelWindow]::Unlocked()) {
    throw 'The runner is outside the unlocked physical console session.'
}
$support = Join-Path ([Environment]::GetFolderPath('LocalApplicationData')) 'Waffle'
if ((Test-Path -LiteralPath $support) -or (Get-Process -Name Waffle -ErrorAction SilentlyContinue)) {
    throw 'An existing Waffle application or profile prevents an isolated test.'
}

$windows = Get-CimInstance Win32_OperatingSystem | Select-Object Caption,Version,BuildNumber,OSArchitecture
$adapters = @(Get-CimInstance Win32_VideoController | Select-Object Name,DriverVersion,PNPDeviceID)
$adapter = @($adapters | Where-Object { $_.Name -eq $ExpectedAdapter -and $_.PNPDeviceID -like 'PCI*' })
if ($adapter.Count -ne 1) { throw "The physical $ExpectedAdapter adapter could not be identified." }
$principal = [Security.Principal.WindowsPrincipal]::new([Security.Principal.WindowsIdentity]::GetCurrent())
$perfLogUsers = $principal.IsInRole([Security.Principal.SecurityIdentifier]::new('S-1-5-32-559'))
$administrator = $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)

$fixture = switch ($Board) {
    GargantuRAM { @{
        name='MainBoard_6_layers.PcbDoc'; minimumItems=10000
        url='https://raw.githubusercontent.com/Ternary-Computer-System/GargantuRAM/7d48745b4b1027b681f03a2f810d2202c69f7508/Altium%20Project/MainBoard_6_layers.PcbDoc'
        sha='627ede540df6411cfd9bb37b4a7d98e4574e1bd891e1a0cba15579ee8e703729'
    } }
    PiDP { @{
        name='PiDP11IOExpander.PcbDoc'; minimumItems=250
        path=(Join-Path $PSScriptRoot '../../tests/fixtures/altium/pidp11-io-expander/PiDP11IOExpander.PcbDoc')
        sha='1ff7234670ec5e20092d23ecf0cd5e7380e842ef7efff2b5cb992f53f84c9c69'
    } }
}
$node = Join-Path (Split-Path -Parent (Split-Path -Parent $env:RUNNER_TEMP)) 'externals/node24/bin/node.exe'
if (-not (Test-Path -LiteralPath $node)) { throw 'The runner Node 24 executable was not found.' }
& $node (Join-Path $PSScriptRoot '../../native/windows/tests/view-feel.test.cjs')
if ($LASTEXITCODE -ne 0) { throw 'The Windows timing receipt controls failed.' }
$scratch = (New-Item -ItemType Directory (Join-Path $env:RUNNER_TEMP ('waffle-feel-' + [Guid]::NewGuid().ToString('N').Substring(0,8)))).FullName
$packageDirectory = Join-Path $scratch 'app'
$boardPath = Join-Path $scratch $fixture.name
$application = $null
$ownsNativeProfile = $false
$profileToken = [Guid]::NewGuid().ToString('N')
$ownerFile = Join-Path $support '.waffle-timing-owner'
try {
    # WinForms uses .NET Framework Known Folders. A private WebView2 folder alone does
    # not redirect native state. Create an exclusive reservation only on an unused profile.
    New-Item -ItemType Directory -Path $support -ErrorAction Stop | Out-Null
    [IO.File]::WriteAllText($ownerFile, $profileToken)
    $ownsNativeProfile = $true
    if ($fixture.url) {
        curl.exe --fail --location --silent --show-error --connect-timeout 20 --max-time 120 --output $boardPath $fixture.url
        if ($LASTEXITCODE -ne 0) { throw 'Pinned public board download failed.' }
    } else {
        Copy-Item -LiteralPath $fixture.path -Destination $boardPath
    }
    Check-File $boardPath $fixture.sha
    Expand-Archive -LiteralPath $Package -DestinationPath $packageDirectory
    $exe = Join-Path $packageDirectory 'Waffle.exe'
    Check-File $exe $ExpectedExecutableSHA256
    Write-Receipt 'environment.json' ([ordered]@{
        package=(Split-Path -Leaf $Package); packageSHA256=$ExpectedSHA256; executableSHA256=$ExpectedExecutableSHA256
        packagedCandidate=$PackagedCandidate; packagedTree=$PackagedTree
        packageProductVersion=(Get-Item -LiteralPath $exe).VersionInfo.ProductVersion; recipe=(git rev-parse HEAD)
        board=$Board; boardName=$fixture.name; boardUrl=$fixture.url; boardSHA256=$fixture.sha
        boardBytes=(Get-Item -LiteralPath $boardPath).Length; repetitions=$Repetitions; trace=[bool]$Trace
        runner=$env:RUNNER_NAME; windows=$windows; consoleSession=$session; adapters=$adapters
        expectedAdapter=$adapter[0].Name; performanceLogUsers=$perfLogUsers; elevated=$administrator; node=(& $node --version)
    })
    $listener = [Net.Sockets.TcpListener]::new([Net.IPAddress]::Loopback,0)
    $listener.Start()
    $port = $listener.LocalEndpoint.Port
    $listener.Stop()
    $launch = [Diagnostics.ProcessStartInfo]::new($exe)
    $launch.UseShellExecute = $false
    $launch.WorkingDirectory = $packageDirectory
    $launch.Environment['WEBVIEW2_USER_DATA_FOLDER'] = Join-Path $scratch 'webview2-profile'
    $launch.Environment['WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS'] = "--remote-debugging-address=127.0.0.1 --remote-debugging-port=$port"
    $application = [Diagnostics.Process]::Start($launch)
    $nodeEntry = Join-Path $PSScriptRoot '../../native/windows/tests/view-feel-host.cjs'
    $env:WAFFLE_TIMING_PWSH = Join-Path $PSHOME 'pwsh.exe'
    $env:WAFFLE_TIMING_EXPECTED_DISPLAY = ConvertTo-Json -InputObject @($ExpectedDisplay) -Compress
    & $node $nodeEntry "$port" $Output "$($application.Id)" $PSCommandPath $adapter[0].Name $boardPath "$($fixture.minimumItems)" "$Repetitions" "$([int][bool]$Trace)"
    $timingExit = $LASTEXITCODE
    Check-File $boardPath $fixture.sha
    Write-Receipt 'unchanged-board.json' @{sourceSHA256=$fixture.sha; unchanged=$true}
    if ($timingExit -ne 0) { throw "Native WebView2 timing harness returned $timingExit." }
} finally {
    if ($application) {
        if (-not $application.HasExited) {
            [void]$application.CloseMainWindow()
            if (-not $application.WaitForExit(2500)) { $application.Kill($true) }
        }
        $application.Dispose()
    }
    if ($ownsNativeProfile -and (Test-Path -LiteralPath $support)) {
        $entry = Get-Item -LiteralPath $support -Force
        $children = @(Get-ChildItem -LiteralPath $support -Force)
        $unexpected = @($children | Where-Object {
            $_.PSIsContainer -or ($_.Attributes -band [IO.FileAttributes]::ReparsePoint) -or
            $_.Name -notin @('.waffle-timing-owner','window.json')
        })
        if (($entry.Attributes -band [IO.FileAttributes]::ReparsePoint) -or $unexpected.Count -or
            -not (Test-Path -LiteralPath $ownerFile) -or (Get-Content -Raw -LiteralPath $ownerFile) -ne $profileToken -or
            (Get-Process -Name Waffle -ErrorAction SilentlyContinue)) {
            Write-Receipt 'native-profile' @{status='retained'; reason='The native data directory could not be proven to contain only timing state.'}
            Write-Warning 'Retained native Waffle data because its ownership could not be proven.'
        } else {
            # Preserve the timing window state out of the shared profile path. A new
            # profile created by another process after this move is never touched.
            $archive = Join-Path (Split-Path -Parent $support) ('Waffle-timing-retained-' + $profileToken)
            [IO.Directory]::Move($support, $archive)
            Write-Receipt 'native-profile' @{status='reserved-state-archived'; archivedLeaf=(Split-Path -Leaf $archive)}
        }
    }
    Remove-Item -LiteralPath $scratch -Recurse -Force -ErrorAction Continue
}
