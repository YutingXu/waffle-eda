param(
    [Parameter(Mandatory=$true)][int]$WafflePid,
    [Parameter(Mandatory=$true)][double]$CssX,
    [Parameter(Mandatory=$true)][double]$CssY,
    [Parameter(Mandatory=$true)][double]$Scale,
    [Parameter(Mandatory=$true)][string]$Steps,
    [Parameter(Mandatory=$true)][ValidateRange(18,100)][int]$IntervalMs
)
$ErrorActionPreference = 'Stop'
Add-Type @'
using System;
using System.Runtime.InteropServices;
using System.Diagnostics;
using System.Threading;
public static class DesktopWheel {
    [StructLayout(LayoutKind.Sequential)] public struct Point { public int X, Y; }
    [StructLayout(LayoutKind.Sequential)] private struct LastInput { public uint Size, Time; }
    [DllImport("user32.dll")] public static extern bool GetCursorPos(out Point point);
    [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
    [DllImport("user32.dll")] public static extern bool ClientToScreen(IntPtr window, ref Point point);
    [DllImport("user32.dll")] public static extern IntPtr WindowFromPoint(Point point);
    [DllImport("user32.dll")] public static extern IntPtr GetAncestor(IntPtr window, uint kind);
    [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr window);
    [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] private static extern void mouse_event(uint flags, uint x, uint y, uint data, UIntPtr extra);
    [DllImport("user32.dll")] private static extern void keybd_event(byte key, byte scan, uint flags, UIntPtr extra);
    [DllImport("user32.dll")] private static extern short GetAsyncKeyState(int key);
    [DllImport("user32.dll")] private static extern bool GetLastInputInfo(ref LastInput last);
    [DllImport("user32.dll")] private static extern IntPtr SetThreadDpiAwarenessContext(IntPtr value);
    public static void UsePhysicalCoordinates() { SetThreadDpiAwarenessContext(new IntPtr(-4)); }
    public static void Ctrl(bool down) { keybd_event(0x11, 0, down ? 0u : 2u, UIntPtr.Zero); }
    public static double[] Send(int[] steps, int interval, IntPtr window, Point point) {
        var clock = Stopwatch.StartNew();
        var emitted = new double[steps.Length];
        for (int i = 0; i < steps.Length; i++) {
            var deadline = i * interval;
            for (;;) {
                var remaining = deadline - clock.Elapsed.TotalMilliseconds;
                if (remaining <= 0) break;
                if (remaining > 1.2) Thread.Sleep(1);
                else Thread.SpinWait(50);
            }
            Point cursor;
            if (!GetCursorPos(out cursor) || cursor.X != point.X || cursor.Y != point.Y || GetForegroundWindow() != window)
                throw new InvalidOperationException("Foreground or pointer placement changed during the benchmark.");
            emitted[i] = clock.Elapsed.TotalMilliseconds;
            mouse_event(0x0800, 0, 0, unchecked((uint)steps[i]), UIntPtr.Zero);
        }
        return emitted;
    }
    public static bool Busy() {
        var last = new LastInput { Size = (uint)Marshal.SizeOf(typeof(LastInput)) };
        return !GetLastInputInfo(ref last) || unchecked((uint)Environment.TickCount - last.Time) < 15000 ||
            GetAsyncKeyState(0x01) < 0 || GetAsyncKeyState(0x02) < 0 || GetAsyncKeyState(0x04) < 0 ||
            GetAsyncKeyState(0x10) < 0 || GetAsyncKeyState(0x11) < 0 || GetAsyncKeyState(0x12) < 0;
    }
}
'@
function Write-Result($value) {
    ConvertTo-Json -InputObject $value -Depth 5 -Compress
}
if ([DesktopWheel]::Busy()) {
    Write-Result @{status='skip'; reason='Windows desktop received recent keyboard or mouse input.'}
    exit 0
}
[DesktopWheel]::UsePhysicalCoordinates()
$target = (Get-Process -Id $WafflePid).MainWindowHandle
$point = New-Object DesktopWheel+Point
$point.X = [int]($CssX*$Scale)
$point.Y = [int]($CssY*$Scale)
if ($target -eq [IntPtr]::Zero -or -not [DesktopWheel]::ClientToScreen($target,[ref]$point)) {
    throw 'Could not map the WebView2 canvas to the Waffle desktop window.'
}
if ([DesktopWheel]::GetForegroundWindow() -ne $target -or [DesktopWheel]::GetAncestor([DesktopWheel]::WindowFromPoint($point),2) -ne $target) {
    Write-Result @{status='skip'; reason='The canvas is not on the foreground Waffle window.'}
    exit 0
}
$detents = [int[]]@(ConvertFrom-Json -InputObject $Steps)
if ($detents.Count -lt 2 -or $detents.Count -gt 160 -or @($detents | Where-Object { [Math]::Abs($_) -ne 120 }).Count) {
    throw 'The native wheel workload must contain only signed 120-unit detents.'
}
$start = New-Object DesktopWheel+Point
[void][DesktopWheel]::GetCursorPos([ref]$start)
try {
    if (-not [DesktopWheel]::SetCursorPos($point.X,$point.Y)) { throw 'Could not place Windows pointer over the editor.' }
    [DesktopWheel]::Ctrl($true)
    try {
        $sourceMs = [DesktopWheel]::Send($detents,$IntervalMs,$target,$point)
    } finally {
        [DesktopWheel]::Ctrl($false)
    }
    Write-Result @{status='performed'; input='Win32 Control key and 120-unit mouse-wheel detents';
        devicePixels=@($point.X,$point.Y); detents=$detents; sourceMs=$sourceMs; intervalMs=$IntervalMs}
} finally {
    $last = New-Object DesktopWheel+Point
    if ([DesktopWheel]::GetCursorPos([ref]$last) -and $last.X -eq $point.X -and $last.Y -eq $point.Y) {
        [void][DesktopWheel]::SetCursorPos($start.X,$start.Y)
    }
}
