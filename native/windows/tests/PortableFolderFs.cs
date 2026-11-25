// The exact Windows adapter runs on Windows. Elsewhere the same coordinator is exercised with
// real file flushes, shared/exclusive flock and directory fsync. This makes the worker usable
// by the independent cross-host journal oracle without making a claim about Windows hardware.
using System;
using System.IO;
using System.Runtime.InteropServices;
using Microsoft.Win32.SafeHandles;

namespace Waffle.Windows.Tests
{
    sealed partial class PortableFs : IFolderPlatform, IFolderDraftIdentity, INotebookMedia, IImportExportPlatform
    {
        [System.Runtime.Versioning.SupportedOSPlatformGuard("windows")]
        static bool Windows => OperatingSystem.IsWindows();
        readonly WinFs windows = Windows ? new WinFs() : null;
        [DllImport("libc", EntryPoint = "fsync", SetLastError = true)] static extern int Sync(int fd);
        [DllImport("libc", EntryPoint = "fstat$INODE64", SetLastError = true)] static extern int MacStatus(int fd, IntPtr info);
        [DllImport("libc", EntryPoint = "fstat", SetLastError = true)] static extern int UnixStatus(int fd, IntPtr info);
        static int Fd(SafeFileHandle h) => h.DangerousGetHandle().ToInt32();
        static SafeFileHandle DirectoryHandle(string p)
        {
            var i = new DirectoryInfo(p);
            if (!i.Exists || i.LinkTarget != null) throw new HostError("A project directory is unavailable.");
            int fd = OpenFolder(p, 0);
            if (fd < 0) throw new IOException("Could not open directory.");
            return new SafeFileHandle((IntPtr)fd, true);
        }
        static T InspectStat<T>(SafeFileHandle handle, Func<IntPtr, T> read)
        {
            var stat = Marshal.AllocHGlobal(512);
            try
            {
                int fd = Fd(handle);
                int result = OperatingSystem.IsMacOS() && RuntimeInformation.ProcessArchitecture == Architecture.X64 ?
                    MacStatus(fd, stat) : UnixStatus(fd, stat);
                if (result != 0) throw new IOException("Could not inspect opened file.");
                return read(stat);
            }
            finally { Marshal.FreeHGlobal(stat); }
        }
        static void RequireSingleLink(FileStream file)
        {
            long links = InspectStat(file.SafeFileHandle, stat => OperatingSystem.IsMacOS() ? (ushort)Marshal.ReadInt16(stat, 6) :
                RuntimeInformation.ProcessArchitecture == Architecture.Arm64 ? (uint)Marshal.ReadInt32(stat, 20) : Marshal.ReadInt64(stat, 16));
            if (links != 1) throw new HostError("A folder member has multiple links.");
        }
        public string ExportIdentity(string path,bool directory)
        {
            if(Windows)return windows.ExportIdentity(path,directory);
            if(directory)return RecoveryIdentity(path);
            using(var file=(FileStream)OpenRegular(path))
                return InspectStat(file.SafeFileHandle,st=>(OperatingSystem.IsMacOS()?(long)(uint)Marshal.ReadInt32(st):Marshal.ReadInt64(st))+
                    ":"+Marshal.ReadInt64(st,8));
        }
        [DllImport("libc",EntryPoint="renameatx_np",SetLastError=true)]
        static extern int MacExchange(int fd,string from,int other,string to,uint flags);
        [DllImport("libc",EntryPoint="renameat2",SetLastError=true)]
        static extern int LinuxExchange(int fd,string from,int other,string to,uint flags);
        public void ExchangeExport(string from,string to,bool single)
        {
            if(Windows){windows.ExchangeExport(from,to,single);return;}
            int result=OperatingSystem.IsMacOS()?MacExchange(-2,from,-2,to,2):LinuxExchange(-100,from,-100,to,2);
            if(result!=0)throw new IOException("Atomic test export exchange failed ("+Marshal.GetLastWin32Error()+").");
        }

        public string RecoveryIdentity(string root)
        {
            if (Windows) return windows.RecoveryIdentity(root);
            using (var directory = DirectoryHandle(root))
                return InspectStat(directory, stat =>
                {
                    long device = OperatingSystem.IsMacOS() ? (uint)Marshal.ReadInt32(stat) : Marshal.ReadInt64(stat);
                    return device.ToString("x") + ":" + Marshal.ReadInt64(stat, 8).ToString("x");
                });
        }
        internal Func<System.Collections.Generic.Dictionary<string, object>, byte[], System.Collections.Generic.Dictionary<string, object>> NotebookDecoder;
        public System.Collections.Generic.Dictionary<string, object> Decode(System.Collections.Generic.Dictionary<string, object> r, byte[] bytes,
            System.Threading.CancellationToken cancellation)
        {
            cancellation.ThrowIfCancellationRequested();
            return NotebookDecoder?.Invoke(r, bytes) ?? throw new HostError("No test media decoder.");
        }
        public bool ReadHandlesPreventChanges => Windows;
        public IDisposable PinDirectory(string p) => Windows ? windows.PinDirectory(p) : DirectoryHandle(p);
        public Stream OpenRegular(string p)
        {
            if (Windows) return windows.OpenRegular(p);
            var info = new FileInfo(p);
            if (!info.Exists || info.LinkTarget != null) throw new HostError("A project entry must be a regular file.");
            var f = new FileStream(p, FileMode.Open, FileAccess.Read, FileShare.ReadWrite | FileShare.Delete);
            try { RequireSingleLink(f); return f; } catch { f.Dispose(); throw; }
        }
        public IDisposable TryBarrier(string p, bool directory, bool writer)
        {
            if (Windows) return windows.TryBarrier(p, directory, writer);
            var h = directory ? DirectoryHandle(p) : new SafeFileHandle((IntPtr)OpenFolder(p, writer ? 2 : 0), true);
            if (h.IsInvalid) { h.Dispose(); throw new IOException("Could not open project lock."); }
            if (Flock(Fd(h), (writer ? 2 : 1) | 4) == 0) return h;
            h.Dispose(); return null;
        }
        public void SyncDirectory(string p, IDisposable heldDirectory = null)
        {
            if (Windows) windows.SyncDirectory(p, heldDirectory);
            else using (var h = DirectoryHandle(p)) if (Sync(Fd(h)) != 0) throw new IOException("Could not sync directory.");
        }
        public void MoveEntry(string from, string to, bool replace)
        {
            if (Windows) windows.MoveEntry(from, to, replace);
            else if (Directory.Exists(from)) Directory.Move(from, to);
            else File.Move(from, to, replace);
        }
        public void DeleteEntry(string p) { if (Windows) windows.DeleteEntry(p); else File.Delete(p); }
        public FileStream NewFile(string p, bool secret)
        {
            if (Windows) return windows.NewFile(p, secret);
            return new FileStream(p, new FileStreamOptions
            {
                Mode = FileMode.CreateNew,
                Access = FileAccess.Write,
                Share = FileShare.None,
                UnixCreateMode = secret ? UnixFileMode.UserRead | UnixFileMode.UserWrite : UnixFileMode.UserRead | UnixFileMode.UserWrite | UnixFileMode.GroupRead | UnixFileMode.OtherRead
            });
        }
        public void CheckWritableVolume(string root) { if (Windows) windows.CheckWritableVolume(root); }
    }
}
