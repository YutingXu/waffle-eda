# The Windows desktop half of the title bar check (title-bar-host.cjs): reads the real Waffle window
# and drives it with real mouse and keyboard input, in physical pixels.
#   -Action state     the window, its visible frame, its client area on screen, its monitor and state
#   -Action input     a JSON list of steps: {"css":[x,y]} moves to a point of the page (CSS pixels,
#                     -Scale = devicePixelRatio), {"dx":n,"dy":n} moves relative to the last css point,
#                     {"down":"left|right"}, {"up":"left|right"}, {"key":"escape"}, {"wait":ms}
#   -Action restore   restores a minimised or maximised window and brings it to the front
#   -Action capture   saves the window and the desktop around its top edge as a PNG (-Out)
param(
    [Parameter(Mandatory=$true)][int]$WafflePid,
    [Parameter(Mandatory=$true)][ValidateSet('state','input','restore','capture')][string]$Action,
    [double]$Scale = 1,
    [string]$Steps = '[]',
    [string]$Out,
    [uint32]$OwnTick = 0
)
$ErrorActionPreference = 'Stop'
Add-Type @'
using System;
using System.Runtime.InteropServices;
public static class TitleBarDesktop {
    [StructLayout(LayoutKind.Sequential)] public struct Point { public int X, Y; }
    [StructLayout(LayoutKind.Sequential)] public struct Rect { public int Left, Top, Right, Bottom; }
    [StructLayout(LayoutKind.Sequential)] struct MonitorInfo { public int Size; public Rect Monitor, Work; public uint Flags; }
    [StructLayout(LayoutKind.Sequential)] struct LastInput { public uint Size, Time; }
    [DllImport("user32.dll")] static extern IntPtr SetThreadDpiAwarenessContext(IntPtr context);
    [DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr window, out Rect rect);
    [DllImport("user32.dll")] static extern bool GetClientRect(IntPtr window, out Rect rect);
    [DllImport("user32.dll")] static extern bool ClientToScreen(IntPtr window, ref Point point);
    [DllImport("user32.dll")] static extern bool IsZoomed(IntPtr window);
    [DllImport("user32.dll")] static extern bool IsIconic(IntPtr window);
    [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr window);
    [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] static extern bool SetForegroundWindow(IntPtr window);
    [DllImport("user32.dll")] static extern bool ShowWindow(IntPtr window, int command);
    [DllImport("user32.dll")] static extern uint GetDpiForWindow(IntPtr window);
    [DllImport("user32.dll")] static extern IntPtr MonitorFromWindow(IntPtr window, uint flags);
    [DllImport("user32.dll")] static extern bool GetMonitorInfo(IntPtr monitor, ref MonitorInfo info);
    [DllImport("user32.dll", CharSet=CharSet.Unicode)] static extern IntPtr FindWindow(string cls, string name);
    [DllImport("user32.dll")] static extern bool SetCursorPos(int x, int y);
    [DllImport("user32.dll")] static extern bool GetCursorPos(out Point point);
    [DllImport("user32.dll")] static extern IntPtr WindowFromPoint(Point point);
    [DllImport("user32.dll")] static extern IntPtr GetAncestor(IntPtr window, uint kind);
    [DllImport("user32.dll")] static extern void mouse_event(uint flags, uint x, uint y, uint data, UIntPtr extra);
    [DllImport("user32.dll")] static extern void keybd_event(byte key, byte scan, uint flags, UIntPtr extra);
    [DllImport("user32.dll")] static extern bool GetLastInputInfo(ref LastInput last);
    [DllImport("user32.dll")] static extern short GetAsyncKeyState(int key);
    [DllImport("dwmapi.dll")] static extern int DwmGetWindowAttribute(IntPtr window, uint attribute, out Rect value, uint size);

    public static void Physical() { SetThreadDpiAwarenessContext(new IntPtr(-4)); }
    static int[] Of(Rect r) { return new [] { r.Left, r.Top, r.Right, r.Bottom }; }
    public static Point ClientOrigin(IntPtr window) { var p = new Point(); ClientToScreen(window, ref p); return p; }
    public static object State(IntPtr window) {
        Rect bounds, client, frame;
        GetWindowRect(window, out bounds);
        GetClientRect(window, out client);
        var origin = ClientOrigin(window);
        bool framed = DwmGetWindowAttribute(window, 9, out frame, (uint)Marshal.SizeOf(typeof(Rect))) == 0; // DWMWA_EXTENDED_FRAME_BOUNDS
        var info = new MonitorInfo { Size = Marshal.SizeOf(typeof(MonitorInfo)) };
        GetMonitorInfo(MonitorFromWindow(window, 2), ref info);
        IntPtr menu = FindWindow("#32768", null);
        return new {
            window = Of(bounds), frame = framed ? Of(frame) : Of(bounds),
            client = new [] { origin.X, origin.Y, origin.X + client.Right, origin.Y + client.Bottom },
            monitor = Of(info.Monitor), work = Of(info.Work), dpi = GetDpiForWindow(window),
            zoomed = IsZoomed(window), iconic = IsIconic(window), visible = IsWindowVisible(window),
            foreground = GetForegroundWindow() == window, menuOpen = menu != IntPtr.Zero && IsWindowVisible(menu)
        };
    }
    // A person using the desktop wins: no synthetic input while they type or move the mouse. Input up
    // to `own` (the tick after this check's previous input) is the check's own.
    public static bool Busy(uint own) {
        var last = new LastInput { Size = (uint)Marshal.SizeOf(typeof(LastInput)) };
        if (!GetLastInputInfo(ref last)) return true;
        bool ours = own != 0 && unchecked((int)(last.Time - own)) <= 0;
        return !ours && unchecked(Tick() - last.Time) < 15000 ||
            GetAsyncKeyState(0x01) < 0 || GetAsyncKeyState(0x02) < 0 || GetAsyncKeyState(0x10) < 0 || GetAsyncKeyState(0x11) < 0;
    }
    public static uint Tick() { return unchecked((uint)Environment.TickCount); }
    public static bool Front(IntPtr window) {
        // The window menu is the foreground while it is open; it belongs to the Waffle window.
        IntPtr menu = FindWindow("#32768", null);
        if (GetForegroundWindow() == window || menu != IntPtr.Zero && IsWindowVisible(menu)) return true;
        SetForegroundWindow(window);
        System.Threading.Thread.Sleep(120);
        return GetForegroundWindow() == window;
    }
    public static bool Over(IntPtr window, int x, int y) {
        var hit = WindowFromPoint(new Point { X = x, Y = y });
        return hit == window || GetAncestor(hit, 2) == window;
    }
    public static void Move(int x, int y) { SetCursorPos(x, y); }
    public static void Button(string button, bool down) {
        uint flag = button == "right" ? (down ? 0x08u : 0x10u) : (down ? 0x02u : 0x04u);
        mouse_event(flag, 0, 0, 0, UIntPtr.Zero);
    }
    public static void Key(byte key) { keybd_event(key, 0, 0, UIntPtr.Zero); keybd_event(key, 0, 2, UIntPtr.Zero); }
    public static void Restore(IntPtr window) { ShowWindow(window, 9); SetForegroundWindow(window); }
}
'@
[TitleBarDesktop]::Physical()
$window = (Get-Process -Id $WafflePid).MainWindowHandle
if ($window -eq [IntPtr]::Zero) { throw 'The Waffle window is not open.' }
function Write-Result($value) { ConvertTo-Json -InputObject $value -Depth 6 -Compress }

switch ($Action) {
    'state' { Write-Result ([TitleBarDesktop]::State($window)) }
    'restore' { [TitleBarDesktop]::Restore($window); Start-Sleep -Milliseconds 400; Write-Result ([TitleBarDesktop]::State($window)) }
    'capture' {
        Add-Type -AssemblyName System.Drawing
        $state = [TitleBarDesktop]::State($window)
        $r = $state.frame
        $left = [Math]::Max($state.monitor[0], $r[0] - 16); $top = [Math]::Max($state.monitor[1], $r[1] - 16)
        $width = [Math]::Min($state.monitor[2], $r[2] + 16) - $left; $height = [Math]::Min($state.monitor[3], $r[3] + 16) - $top
        $bitmap = [Drawing.Bitmap]::new($width, $height)
        try {
            $graphics = [Drawing.Graphics]::FromImage($bitmap)
            try { $graphics.CopyFromScreen($left, $top, 0, 0, $bitmap.Size) } finally { $graphics.Dispose() }
            $bitmap.Save($Out, [Drawing.Imaging.ImageFormat]::Png)
        } finally { $bitmap.Dispose() }
        Write-Result @{saved=$Out; area=@($left, $top, $width, $height)}
    }
    'input' {
        if ([TitleBarDesktop]::Busy($OwnTick)) { Write-Result @{status='busy'; reason='The desktop received recent keyboard or mouse input.'}; exit 0 }
        if (-not [TitleBarDesktop]::Front($window)) { Write-Result @{status='background'; reason='The Waffle window could not be brought to the front.'}; exit 0 }
        $start = $null
        foreach ($step in @(ConvertFrom-Json -InputObject $Steps)) {
            if ($null -ne $step.css) {
                $origin = [TitleBarDesktop]::ClientOrigin($window)
                $start = @([int]($origin.X + $step.css[0] * $Scale), [int]($origin.Y + $step.css[1] * $Scale))
                if (-not [TitleBarDesktop]::Over($window, $start[0], $start[1])) {
                    Write-Result @{status='covered'; reason='Another window covers the point.'; point=$start}; exit 0
                }
                [TitleBarDesktop]::Move($start[0], $start[1])
            } elseif ($null -ne $step.dx) {
                # In small steps, as a hand moves: Windows' move and size loops follow the pointer.
                $from = @($start[0], $start[1]); $to = @(($start[0] + [int]$step.dx), ($start[1] + [int]$step.dy))
                for ($i = 1; $i -le 12; $i++) {
                    [TitleBarDesktop]::Move([int]($from[0] + ($to[0] - $from[0]) * $i / 12), [int]($from[1] + ($to[1] - $from[1]) * $i / 12))
                    Start-Sleep -Milliseconds 16
                }
            } elseif ($null -ne $step.down) { [TitleBarDesktop]::Button($step.down, $true) }
            elseif ($null -ne $step.up) { [TitleBarDesktop]::Button($step.up, $false) }
            elseif ($step.key -eq 'escape') { [TitleBarDesktop]::Key(0x1B) }
            elseif ($null -ne $step.wait) { Start-Sleep -Milliseconds ([int]$step.wait) }
        }
        Start-Sleep -Milliseconds 20
        $tick = [TitleBarDesktop]::Tick()
        Write-Result @{status='sent'; tick=$tick; state=[TitleBarDesktop]::State($window)}
    }
}
