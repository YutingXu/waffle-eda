using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;
using System.Threading;
using Microsoft.Win32.SafeHandles;

class RunDesigner
{
    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    struct ProcessEntry
    {
        public uint size, usage, id;
        public UIntPtr heap;
        public uint module, threads, parent;
        public int priority;
        public uint flags;
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 260)] public string executable;
    }
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern SafeFileHandle CreateToolhelp32Snapshot(uint flags, uint pid);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    static extern bool Process32FirstW(SafeFileHandle snapshot, ref ProcessEntry entry);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    static extern bool Process32NextW(SafeFileHandle snapshot, ref ProcessEntry entry);

    // Wine Mono's managed process names can differ from the Windows image name.
    static List<uint> EditorProcesses(string executable)
    {
        var ids = new List<uint>();
        using (var snapshot = CreateToolhelp32Snapshot(2, 0))
        {
            if (snapshot.IsInvalid) throw new Win32Exception(Marshal.GetLastWin32Error());
            var entry = new ProcessEntry { size = (uint)Marshal.SizeOf(typeof(ProcessEntry)) };
            if (!Process32FirstW(snapshot, ref entry)) throw new Win32Exception(Marshal.GetLastWin32Error());
            do
            {
                if (String.Equals(entry.executable, executable, StringComparison.OrdinalIgnoreCase))
                    ids.Add(entry.id);
            } while (Process32NextW(snapshot, ref entry));
            if (Marshal.GetLastWin32Error() != 18) throw new Win32Exception(Marshal.GetLastWin32Error());
        }
        return ids;
    }
    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    static extern IntPtr FindWindow(string className, string title);
    [DllImport("user32.dll")]
    static extern uint GetWindowThreadProcessId(IntPtr window, out uint processId);
    [DllImport("user32.dll")]
    static extern bool IsWindowEnabled(IntPtr window);
    [DllImport("user32.dll")]
    static extern bool IsWindowVisible(IntPtr window);
    [DllImport("user32.dll")]
    static extern IntPtr SendMessageTimeout(IntPtr window, uint message, UIntPtr wParam,
        IntPtr lParam, uint flags, uint timeout, out UIntPtr result);

    static int Fail(string reason)
    {
        Console.WriteLine("Altium check: " + reason);
        return 1;
    }

    static bool Ready(IntPtr window, uint processId)
    {
        uint owner;
        UIntPtr reply;
        GetWindowThreadProcessId(window, out owner);
        return owner == processId && IsWindowVisible(window) && IsWindowEnabled(window) &&
            SendMessageTimeout(window, 0, UIntPtr.Zero, IntPtr.Zero, 2, 1000, out reply) != IntPtr.Zero;
    }

    // start.exe /unix detaches X2. Keep a Windows handle to the specific process
    // created for this command, even when another X2 already owns the workspace.
    static void CloseOwnedProcess(Process child)
    {
        try
        {
            if (child.WaitForExit(300)) return;
            if (child.CloseMainWindow() && child.WaitForExit(2000)) return;
            child.Kill();
            child.WaitForExit();
        }
        catch (InvalidOperationException)
        {
            if (!child.HasExited) throw;
        }
    }

    static int Main(string[] args)
    {
        bool existingOnly = args.Length == 5 && args[4] == "--existing";
        if (args.Length != 4 && !existingOnly)
            return Fail("Expected executable, script command, report path and timeout.");
        int timeout = int.Parse(args[3]);
        bool first;
        using (var guard = new Mutex(false, @"Local\AtriumAltiumSmoke", out first))
        {
            if (!first) return Fail("Another Designer check is running.");
            List<uint> editors = EditorProcesses(Path.GetFileName(args[0]));
            if (editors.Count > 1) return Fail("Multiple copies of Designer are already running.");
            if (existingOnly && editors.Count == 0) return Fail("Designer has closed.");
            IntPtr window = FindWindow("TDocumentForm", null);
            if (editors.Count == 1 && !Ready(window, editors[0]))
                return Fail("Designer is starting, busy or waiting for a dialog.");
            // A Finder request may open a user's document only in this interactive window.
            if (existingOnly)
                File.WriteAllText(Path.Combine(Path.GetDirectoryName(args[2]), "window.txt"),
                    window.ToInt64().ToString(System.Globalization.CultureInfo.InvariantCulture));

            var launch = new ProcessStartInfo(args[0], args[1]);
            launch.UseShellExecute = false;
            launch.WorkingDirectory = Path.GetDirectoryName(args[0]);
            using (Process child = Process.Start(launch))
            {
                try
                {
                    var clock = Stopwatch.StartNew();
                    while (!File.Exists(args[2]))
                    {
                        if (child.HasExited && child.ExitCode != 0)
                            return Fail("Designer exited with code " + child.ExitCode + ".");
                        if (clock.ElapsedMilliseconds >= timeout)
                            return Fail("Designer did not return a report before the timeout.");
                        Thread.Sleep(150);
                    }
                    return 0;
                }
                finally
                {
                    CloseOwnedProcess(child);
                }
            }
        }
    }
}
