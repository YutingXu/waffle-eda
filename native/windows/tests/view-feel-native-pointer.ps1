param(
    [Parameter(Mandatory=$true)][int]$WafflePid,
    [Parameter(Mandatory=$true)][double]$CssX,
    [Parameter(Mandatory=$true)][double]$CssY,
    [Parameter(Mandatory=$true)][double]$Scale,
    [Parameter(Mandatory=$true)][ValidateSet("inside","outside","cancel","pan","marker")][string]$Action
)
$ErrorActionPreference = 'Stop'
Add-Type @'
using System;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
public static class ViewFeelPointer {
    [StructLayout(LayoutKind.Sequential)] public struct Point { public int X, Y; }
    [StructLayout(LayoutKind.Sequential)] private struct Rect {
        public int Left, Top, Right, Bottom;
        public bool Contains(Point p) => p.X >= Left && p.X < Right && p.Y >= Top && p.Y < Bottom;
    }
    [StructLayout(LayoutKind.Sequential)] private struct MonitorInfo { public uint Size; public Rect Monitor, Work; public uint Flags; }
    [StructLayout(LayoutKind.Sequential)] private struct LastInput { public uint Size, Time; }
    [StructLayout(LayoutKind.Sequential)] private struct Mouse { public int X, Y; public uint Data, Flags, Time; public UIntPtr Extra; }
    [StructLayout(LayoutKind.Sequential)] private struct Key { public ushort VirtualKey, Scan; public uint Flags, Time; public UIntPtr Extra; }
    [StructLayout(LayoutKind.Explicit)] private struct Payload {
        [FieldOffset(0)] public Mouse Mouse;
        [FieldOffset(0)] public Key Key;
    }
    [StructLayout(LayoutKind.Sequential)] private struct Input { public uint Type; public Payload Data; }
    [DllImport("user32.dll")] private static extern bool GetCursorPos(out Point point);
    [DllImport("user32.dll")] private static extern bool SetCursorPos(int x, int y);
    [DllImport("user32.dll")] private static extern bool ClientToScreen(IntPtr window, ref Point point);
    [DllImport("user32.dll")] private static extern IntPtr WindowFromPoint(Point point);
    [DllImport("user32.dll")] private static extern IntPtr GetAncestor(IntPtr window, uint kind);
    [DllImport("user32.dll")] private static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] private static extern IntPtr GetShellWindow();
    [DllImport("user32.dll", CharSet=CharSet.Unicode)] private static extern int GetClassName(IntPtr window, StringBuilder name, int count);
    [DllImport("user32.dll")] private static extern IntPtr MonitorFromWindow(IntPtr window, uint mode);
    [DllImport("user32.dll")] private static extern bool GetMonitorInfo(IntPtr monitor, ref MonitorInfo info);
    [DllImport("user32.dll")] private static extern bool GetWindowRect(IntPtr window, out Rect rect);
    [DllImport("user32.dll")] private static extern bool GetLastInputInfo(ref LastInput last);
    [DllImport("user32.dll")] private static extern short GetAsyncKeyState(int key);
    [DllImport("user32.dll")] private static extern IntPtr SetThreadDpiAwarenessContext(IntPtr value);
    [DllImport("user32.dll", SetLastError=true)] private static extern uint SendInput(uint count, Input[] input, int size);
    public sealed class Result {
        public string status {get;set;}
        public string reason {get;set;}
        public Point press {get;set;}
        public Point release {get;set;}
        public int accepted {get;set;}
    }
    private static bool Same(Point a, Point b) => a.X == b.X && a.Y == b.Y;
    private static Point At(int x, int y) => new Point { X=x, Y=y };
    private static bool Owns(Point point, IntPtr window) {
        var hit = WindowFromPoint(point);
        return hit == window || GetAncestor(hit, 2) == window;
    }
    private static bool Busy() {
        var last = new LastInput { Size = (uint)Marshal.SizeOf(typeof(LastInput)) };
        return !GetLastInputInfo(ref last) || unchecked((uint)Environment.TickCount-last.Time)<15000 ||
            GetAsyncKeyState(1)<0 || GetAsyncKeyState(2)<0 || GetAsyncKeyState(4)<0 ||
            GetAsyncKeyState(0x10)<0 || GetAsyncKeyState(0x11)<0 || GetAsyncKeyState(0x12)<0;
    }
    private static Point? FindOutside(IntPtr window, Point at) {
        var info = new MonitorInfo { Size = (uint)Marshal.SizeOf(typeof(MonitorInfo)) };
        if (!GetWindowRect(window, out var box) || !GetMonitorInfo(MonitorFromWindow(window,2),ref info)) return null;
        foreach (var point in new[] { At(box.Left-24,at.Y), At(box.Right+24,at.Y), At(at.X,box.Bottom+24), At(at.X,box.Top-24) }) {
            if (!info.Work.Contains(point) || box.Contains(point)) continue;
            var hit = WindowFromPoint(point);
            if (hit == IntPtr.Zero) continue;
            var root = GetAncestor(hit,2);
            var name = new StringBuilder(128);
            GetClassName(root,name,name.Capacity);
            // Only release outside over Windows desktop, never over an unrelated app.
            if (root == GetShellWindow() || name.ToString() == "WorkerW" || name.ToString() == "Progman") return point;
        }
        return null;
    }
    private static void Send(Input input) {
        if (SendInput(1,new[] { input },Marshal.SizeOf(typeof(Input))) != 1)
            throw new InvalidOperationException("Win32 did not admit the scoped pointer or Escape event.");
    }
    private static void Button(uint flags) => Send(new Input { Type=0, Data=new Payload { Mouse=new Mouse { Flags=flags }} });
    private static void Escape(uint flags) => Send(new Input { Type=1, Data=new Payload { Key=new Key { VirtualKey=0x1B, Flags=flags }} });
    public static Result Run(IntPtr window, int x, int y, double scale, string action) {
        if (Busy()) return new Result {status="unavailable",reason="The physical console received recent input."};
        var prior=SetThreadDpiAwarenessContext(new IntPtr(-4));
        var press=At(x,y);
        Point original=default, current=default;
        bool pressed=false, moved=false, escapeDown=false;
        uint down=action=="pan" ? 0x20u : 2u, up=action=="pan" ? 0x40u : 4u;
        try {
            if (window == IntPtr.Zero || GetForegroundWindow()!=window || !ClientToScreen(window,ref press) ||
                !Owns(press,window) || !GetCursorPos(out original))
                return new Result {status="unavailable",reason="Pointer target is outside the visible foreground Waffle editor."};
            var nearby=action=="marker" ? press : At(press.X+(int)Math.Round(64*scale),press.Y+(int)Math.Round(46*scale));
            var release=action=="outside" ? FindOutside(window,press) : nearby;
            if (!release.HasValue || !Owns(nearby,window))
                return new Result {status="unavailable",reason="No safe desktop release point or unobstructed inside drag path."};
            current=original;
            Action ensureOwned = () => {
                if (GetForegroundWindow()!=window || !GetCursorPos(out var cursor) || !Same(cursor,current))
                    throw new InvalidOperationException("The scoped foreground or pointer changed.");
            };
            Action<Point> move = point => {
                ensureOwned();
                if (!SetCursorPos(point.X,point.Y)) throw new InvalidOperationException("Could not move the scoped pointer.");
                current=point;
                moved=true;
            };
            move(press);
            Thread.Sleep(70);
            ensureOwned();
            if (!Owns(press,window)) throw new InvalidOperationException("The native press target became obstructed.");
            Button(down);
            pressed=true;
            if (action=="marker") Thread.Sleep(90);
            else for (int i=1;i<=8;i++) {
                move(At(press.X+(nearby.X-press.X)*i/8,press.Y+(nearby.Y-press.Y)*i/8));
                Thread.Sleep(20);
            }
            if (action=="outside") {
                var outside=FindOutside(window,press);
                if (!outside.HasValue || !Same(outside.Value,release.Value))
                    throw new InvalidOperationException("The safe desktop area changed before release.");
                move(release.Value);
                Thread.Sleep(80);
            }
            if (action=="cancel") {
                ensureOwned();
                Escape(0); escapeDown=true;
                Escape(2); escapeDown=false;
                Thread.Sleep(80);
            }
            ensureOwned();
            Button(up);
            pressed=false;
            Thread.Sleep(85);
            return new Result {status="performed",press=press,release=release.Value,accepted=action=="cancel" ? 4 : 2};
        } finally {
            try {
                if (escapeDown) Escape(2);
                if (pressed) Button(up);
            } finally {
                if (moved && GetCursorPos(out var cursor) && Same(cursor,current))
                    SetCursorPos(original.X,original.Y);
                if (prior != IntPtr.Zero) SetThreadDpiAwarenessContext(prior);
            }
        }
    }
}
'@
$target = (Get-Process -Id $WafflePid).MainWindowHandle
$result = [ViewFeelPointer]::Run($target,[int]($CssX*$Scale),[int]($CssY*$Scale),$Scale,$Action)
ConvertTo-Json -InputObject $result -Depth 4 -Compress
