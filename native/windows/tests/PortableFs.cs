// IHostFs on System.IO (.NET 8), so the shared rules can be tested on macOS, Linux and
// Windows. It stands in for WinFs: canonical paths resolve every link; a link at the final
// component is refused when reading; writes go through a temporary and an atomic rename.
using System;
using System.Collections.Generic;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using Microsoft.Win32.SafeHandles;

namespace Waffle.Windows.Tests
{
    sealed partial class PortableFs : IHostFs
    {
        static readonly HashSet<string> Locks = new HashSet<string>();

        public StringComparer PathComparer => OperatingSystem.IsWindows() ? StringComparer.OrdinalIgnoreCase : StringComparer.Ordinal;

        static FileSystemInfo Info(string path) => Directory.Exists(path) ? new DirectoryInfo(path) : (FileSystemInfo)new FileInfo(path);

        static string Resolve(string path, int depth = 0)
        {
            if (depth > 40) throw new HostError("Too many links.");
            var full = Path.GetFullPath(path);
            var root = Path.GetPathRoot(full);
            var current = root;
            var parts = full.Substring(root.Length).Split(new[] { Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar }, StringSplitOptions.RemoveEmptyEntries);
            for (int i = 0; i < parts.Length; i++)
            {
                var next = Path.Combine(current, parts[i]);
                var info = Info(next);
                if (info.LinkTarget != null)
                {
                    var target = info.LinkTarget;
                    if (!Path.IsPathRooted(target)) target = Path.Combine(current, target);
                    var resolved = Resolve(target, depth + 1);
                    if (i == parts.Length - 1 && !File.Exists(resolved) && !Directory.Exists(resolved))
                        throw new HostError("The file is now a symbolic link. Choose it again.");
                    next = resolved;
                }
                current = next;
            }
            return current;
        }

        public string Canonical(string path) => Resolve(path);

        public string CheckedPath(object value)
        {
            var text = value as string;
            if (text == null || !IsAbsolute(text) || text.Length > 4096 || text.IndexOf('\0') >= 0) return null;
            foreach (var part in text.Split('/', '\\')) if (part == "." || part == "..") return null;
            try { return Canonical(text); } catch (Exception) { return null; }
        }

        public bool IsAbsolute(string path) => !string.IsNullOrEmpty(path) && Path.IsPathFullyQualified(path);
        public string Name(string path) => Path.GetFileName(path);
        public string Parent(string path) => Path.GetDirectoryName(path);
        public string Join(string folder, string name) => Path.Combine(folder, name);

        public byte[] ReadFile(string path, long cap)
        {
            var bytes = File.ReadAllBytes(path);
            if (bytes.Length > cap) throw new HostError("The file is too large.");
            return bytes;
        }

        public RegularRead ReadRegular(string path, long cap, bool singleLink = false)
        {
            var info = Info(path);
            if (info.LinkTarget != null) throw new HostError("The file is now a symbolic link. Choose it again.");
            if (!(info is FileInfo file) || !file.Exists) throw new HostError(info is DirectoryInfo ? "That path is not a regular file." : "The file could not be opened.");
            if (file.Length > cap) throw new HostError("The file is too large.");
            return new RegularRead { Bytes = File.ReadAllBytes(path), ModifiedUtc = file.LastWriteTimeUtc, Identity = Identity(path) };
        }

        public byte[] ReadIfExists(string path) => File.Exists(path) ? File.ReadAllBytes(path) : null;

        internal Action<string, string> ObserveLockStaging;
        public void AtomicWrite(string path, byte[] bytes, bool privateFile, DateTime? modifiedUtc = null, bool collaborationLock = false)
        {
            var nonce = Guid.NewGuid().ToString("N").Substring(0, 12);
            var temporary = Path.Combine(Path.GetDirectoryName(path), collaborationLock ? CollabLocks.PendingName(nonce) : "." + Path.GetFileName(path) + "." + nonce + ".tmp");
            bool owned = false;
            try
            {
                using (var stream = new FileStream(temporary, FileMode.CreateNew, FileAccess.Write, FileShare.None))
                {
                    owned = true;
                    stream.Write(bytes, 0, bytes.Length);
                    stream.Flush(true);
                }
                if (modifiedUtc.HasValue) File.SetLastWriteTimeUtc(temporary, modifiedUtc.Value);
                if (privateFile && !OperatingSystem.IsWindows()) File.SetUnixFileMode(temporary, UnixFileMode.UserRead | UnixFileMode.UserWrite);
                if (collaborationLock) ObserveLockStaging?.Invoke(temporary, path);
                File.Move(temporary, path, true); // rename(2): replaces a link, never follows it
            }
            finally { if (owned && File.Exists(temporary)) File.Delete(temporary); }
        }

        public bool AtomicCreate(string path, byte[] bytes)
        {
            var temporary = Path.Combine(Path.GetDirectoryName(path), "." + Path.GetFileName(path) + "." + Guid.NewGuid().ToString("N").Substring(0, 12) + ".tmp");
            try
            {
                using (var stream = new FileStream(temporary, FileMode.CreateNew, FileAccess.Write, FileShare.None))
                {
                    stream.Write(bytes, 0, bytes.Length);
                    stream.Flush(true);
                }
                long size;
                if (Kind(path, out size) != EntryKind.None) return false;
                try { File.Move(temporary, path, false); } // link(2) on Unix: refuses an existing name
                catch (IOException) { return false; }
                return true;
            }
            finally { if (File.Exists(temporary)) File.Delete(temporary); }
        }

        /// Stands in for volume + file id: the resolved path, plus size and last write time.
        public FileStamp Stamp(string path)
        {
            var info = new FileInfo(path);
            if (!info.Exists || info.LinkTarget != null) return null;
            return new FileStamp(Path.GetFullPath(path), info.Length, info.LastWriteTimeUtc.Ticks);
        }

        [DllImport("libc", EntryPoint = "open", SetLastError = true)]
        static extern int OpenFolder(string path, int flags);
        [DllImport("libc", EntryPoint = "flock", SetLastError = true)]
        static extern int Flock(int fd, int operation);

        public IDisposable TryLockFolder(string folder)
        {
            // The journal worker runs as a separate process. On macOS/Linux it must see the
            // same directory lock as the Python MCP reader and the native writers.
            if (!OperatingSystem.IsWindows())
            {
                int fd = OpenFolder(folder, 0);
                if (fd < 0) throw new IOException("Could not open the project folder.");
                var handle = new SafeFileHandle((IntPtr)fd, true);
                const int exclusiveNonblocking = 2 | 4;
                if (Flock(fd, exclusiveNonblocking) == 0) return handle;
                handle.Dispose();
                return null;
            }
            lock (Locks) { if (!Locks.Add(folder)) return null; }
            return new Release(folder);
        }

        sealed class Release : IDisposable
        {
            readonly string folder;
            public Release(string f) { folder = f; }
            public void Dispose() { lock (Locks) Locks.Remove(folder); }
        }

        public EntryKind Kind(string path, out long size)
        {
            size = 0;
            var info = Info(path);
            if (info.LinkTarget != null)
                return Directory.Exists(path) ? EntryKind.Other : EntryKind.FileLink;
            if (info is DirectoryInfo) return EntryKind.Directory;
            if (!info.Exists) return EntryKind.None;
            size = ((FileInfo)info).Length;
            return EntryKind.File;
        }

        public bool CreateNew(string path, byte[] bytes)
        {
            FileStream stream;
            try { stream = new FileStream(path, FileMode.CreateNew, FileAccess.Write, FileShare.Read); }
            catch (IOException) { long size; if (Kind(path, out size) != EntryKind.None) return false; throw; }
            using (stream) { stream.Write(bytes, 0, bytes.Length); stream.Flush(true); }
            return true;
        }
        public IList<string> ListNames(string folder)
        {
            var names = new List<string>();
            try { foreach (var path in Directory.EnumerateFiles(folder)) names.Add(Path.GetFileName(path)); } catch (Exception) { }
            return names;
        }
        public DateTime? ModifiedUtc(string path) => File.Exists(path) ? File.GetLastWriteTimeUtc(path) : (DateTime?)null;
        public bool IsFile(string path) => File.Exists(path);
        public void Unlink(string path) => File.Delete(path);
        public void EnsurePrivateFolder(string folder) => Directory.CreateDirectory(folder);
        public IHeldFile OpenHeld(string path) => new Held(path, Canonical(path));

        sealed class Held : IHeldFile
        {
            readonly FileStream stream;
            public string Identity { get; }
            public Held(string path, string identity) { stream = File.OpenRead(path); Identity = identity; }
            public byte[] ReadAll() { stream.Position = 0; var m = new MemoryStream(); stream.CopyTo(m); return m.ToArray(); }
            public void Dispose() => stream.Dispose();
        }

        /// Stands in for volume + file id: the fully resolved path.
        public string Identity(string path) { try { var c = Canonical(path); return File.Exists(c) ? c : null; } catch (HostError) { return null; } }
    }
}
