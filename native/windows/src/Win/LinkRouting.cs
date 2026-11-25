using System;
using System.Runtime.InteropServices;
using System.Windows.Forms;

namespace Waffle.Windows
{
    // Each process registers a message-only window. Explorer activations first ask which
    // process owns the adopted identity, then deliver the validated address to that process.
    sealed class LinkRouting : NativeWindow, IDisposable
    {
        const string Caption = "Waffle record link routing";
        const int CopyDataMessage = 0x004a, Probe = 0x574101, Follow = 0x574102;
        static readonly IntPtr MessageOnly = new IntPtr(-3);
        readonly Func<string, bool, Result> route;

        internal enum Result { Missing, Found, Ambiguous }

        internal LinkRouting(Func<string, bool, Result> route)
        {
            this.route = route;
            CreateHandle(new CreateParams { Caption = Caption, Parent = MessageOnly });
        }

        public void Dispose() => DestroyHandle();

        protected override void WndProc(ref Message message)
        {
            if (message.Msg != CopyDataMessage || message.LParam == IntPtr.Zero)
            {
                base.WndProc(ref message);
                return;
            }
            var data = Marshal.PtrToStructure<CopyData>(message.LParam);
            if (data.Operation != (IntPtr)Probe && data.Operation != (IntPtr)Follow ||
                data.Length < 1 || data.Length > 228 || data.Length % 2 != 0 || data.Address == IntPtr.Zero)
                return;
            var url = Marshal.PtrToStringUni(data.Address, data.Length / 2);
            if (WaffleLink.Valid(url))
                message.Result = (IntPtr)route(url, data.Operation == (IntPtr)Follow);
        }

        internal static Result Forward(string url)
        {
            if (!WaffleLink.Valid(url)) return Result.Missing;
            var address = Marshal.StringToHGlobalUni(url);
            try
            {
                var data = new CopyData { Operation = (IntPtr)Probe, Length = url.Length * 2, Address = address };
                IntPtr owner = IntPtr.Zero, peer = IntPtr.Zero;
                while ((peer = FindWindowEx(MessageOnly, peer, null, Caption)) != IntPtr.Zero)
                {
                    var result = Send(peer, ref data);
                    if (result == Result.Ambiguous || result == Result.Found && owner != IntPtr.Zero)
                        return Result.Ambiguous;
                    if (result == Result.Found) owner = peer;
                }
                if (owner == IntPtr.Zero) return Result.Missing;
                GetWindowThreadProcessId(owner, out uint process);
                if (process != 0) AllowSetForegroundWindow(process);
                data.Operation = (IntPtr)Follow;
                return Send(owner, ref data);
            }
            finally { Marshal.FreeHGlobal(address); }
        }

        static Result Send(IntPtr window, ref CopyData data)
        {
            const uint abortIfHung = 0x0002, errorOnExit = 0x0020;
            return SendMessageTimeout(window, CopyDataMessage, IntPtr.Zero, ref data, abortIfHung | errorOnExit, 300, out var result) != IntPtr.Zero
                ? (Result)result.ToInt32() : Result.Missing;
        }

        [StructLayout(LayoutKind.Sequential)]
        struct CopyData { internal IntPtr Operation; internal int Length; internal IntPtr Address; }

        [DllImport("user32.dll", CharSet = CharSet.Unicode)]
        static extern IntPtr FindWindowEx(IntPtr parent, IntPtr after, string name, string caption);

        [DllImport("user32.dll", CharSet = CharSet.Unicode)]
        static extern IntPtr SendMessageTimeout(IntPtr window, int message, IntPtr sender, ref CopyData data, uint flags, uint timeout, out IntPtr result);

        [DllImport("user32.dll")]
        static extern uint GetWindowThreadProcessId(IntPtr window, out uint process);

        [DllImport("user32.dll")]
        static extern bool AllowSetForegroundWindow(uint process);
    }
}
