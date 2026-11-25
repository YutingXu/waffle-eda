// IHostFs on Win32: canonical paths through GetFinalPathNameByHandle, link checks through
// reparse tags (name surrogates only, so OneDrive placeholders still open), atomic writes with
// MoveFileEx, owner-only ACLs for private files and a per-folder named mutex for saves.
using System;
using System.IO;
using System.Runtime.InteropServices;
using System.Security.AccessControl;
using System.Security.Cryptography;
using System.Security.Principal;
using System.Text;
using System.Threading;
using Microsoft.Win32.SafeHandles;

namespace Waffle.Windows
{
    sealed partial class WinFs : IHostFs
    {
        public StringComparer PathComparer => StringComparer.OrdinalIgnoreCase;

        static HostError Failure(string message) => new HostError(message);

        static SafeFileHandle OpenMeta(string path, bool followLink)
        {
            uint flags = Native.FILE_FLAG_BACKUP_SEMANTICS | (followLink ? 0 : Native.FILE_FLAG_OPEN_REPARSE_POINT);
            return Native.CreateFileW(path, Native.FILE_READ_ATTRIBUTES,
                Native.FILE_SHARE_READ | Native.FILE_SHARE_WRITE | Native.FILE_SHARE_DELETE,
                IntPtr.Zero, Native.OPEN_EXISTING, flags, IntPtr.Zero);
        }

        static string FinalPath(SafeFileHandle handle)
        {
            var b = new StringBuilder(1024);
            uint n = Native.GetFinalPathNameByHandleW(handle, b, (uint)b.Capacity, 0);
            if (n > b.Capacity) { b = new StringBuilder((int)n + 1); n = Native.GetFinalPathNameByHandleW(handle, b, (uint)b.Capacity, 0); }
            if (n == 0) throw Failure("The file could not be opened.");
            return WinPath.FromFinalPath(b.ToString());
        }

        static string Full(string path)
        {
            if (string.IsNullOrEmpty(path) || path.IndexOf('\0') >= 0) throw Failure("Choose a file again.");
            if (path.StartsWith("\\\\?\\", StringComparison.Ordinal) || path.StartsWith("\\\\.\\", StringComparison.Ordinal))
                throw Failure("Choose a file on a drive or a network share.");
            return Path.GetFullPath(path);
        }

        public string Canonical(string path)
        {
            var full = Full(path);
            using (var h = OpenMeta(full, true))
            {
                if (!h.IsInvalid) return FinalPath(h);
                int error = Marshal.GetLastWin32Error();
                if (error != Native.ERROR_FILE_NOT_FOUND) throw Failure("The file could not be opened.");
            }
            // A missing final component: refuse a dangling link there, else resolve the folder.
            long size;
            if (Kind(full, out size) != EntryKind.None) throw Failure("The file is now a symbolic link. Choose it again.");
            var parent = Path.GetDirectoryName(full);
            if (parent == null) throw Failure("Choose a file, not a drive.");
            using (var h = OpenMeta(parent, true))
            {
                if (h.IsInvalid) throw Failure("The folder could not be opened.");
                return Path.Combine(FinalPath(h), Path.GetFileName(full));
            }
        }

        public string CheckedPath(object value)
        {
            if (!WinPath.Acceptable(value)) return null;
            try { return Canonical((string)value); } catch (Exception) { return null; }
        }

        public bool IsAbsolute(string path) => WinPath.Acceptable(path);
        public string Name(string path) => Path.GetFileName(path);
        public string Parent(string path) => Path.GetDirectoryName(path);
        public string Join(string folder, string name) => Path.Combine(folder, name);

        public byte[] ReadFile(string path, long cap)
        {
            using (var stream = new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.ReadWrite | FileShare.Delete))
            {
                if (stream.Length > cap) throw Failure("The file is too large.");
                return ReadAll(stream, cap);
            }
        }

        static byte[] ReadAll(Stream stream, long cap)
        {
            using (var memory = new MemoryStream())
            {
                var buffer = new byte[81920];
                int n;
                while ((n = stream.Read(buffer, 0, buffer.Length)) > 0)
                {
                    memory.Write(buffer, 0, n);
                    if (memory.Length > cap) throw Failure("The file is too large.");
                }
                return memory.ToArray();
            }
        }

        static bool IsLinkTag(SafeFileHandle h)
        {
            Native.FILE_ATTRIBUTE_TAG_INFO tag;
            if (!Native.GetFileInformationByHandleEx(h, Native.FileAttributeTagInfo, out tag, (uint)Marshal.SizeOf(typeof(Native.FILE_ATTRIBUTE_TAG_INFO))))
                return true; // unknown: treat as a link
            return (tag.Attributes & Native.FILE_ATTRIBUTE_REPARSE_POINT) != 0 && (tag.ReparseTag & Native.IO_REPARSE_TAG_NAME_SURROGATE) != 0;
        }

        public RegularRead ReadRegular(string path, long cap, bool singleLink = false)
        {
            string firstId;
            // First look at the entry itself: a symbolic link or junction there is refused.
            using (var meta = OpenMeta(path, false))
            {
                if (meta.IsInvalid) throw Failure("The file could not be opened.");
                if (IsLinkTag(meta)) throw Failure("The file is now a symbolic link. Choose it again.");
                Native.BY_HANDLE_FILE_INFORMATION info;
                if (!Native.GetFileInformationByHandle(meta, out info) || (info.Attributes & Native.FILE_ATTRIBUTE_DIRECTORY) != 0)
                    throw Failure("That path is not a regular file.");
                firstId = IdentityOf(meta);
            }
            // Then open it for reading (cloud placeholders hydrate here) and check it is the same file.
            var h = Native.CreateFileW(path, Native.GENERIC_READ, Native.FILE_SHARE_READ | Native.FILE_SHARE_WRITE | Native.FILE_SHARE_DELETE,
                                       IntPtr.Zero, Native.OPEN_EXISTING, 0, IntPtr.Zero);
            if (h.IsInvalid) throw Failure("The file could not be opened.");
            using (var stream = new FileStream(h, FileAccess.Read))
            {
                if (Native.GetFileType(h) != Native.FILE_TYPE_DISK || IdentityOf(h) != firstId)
                    throw Failure("The file changed while it was opened. Choose it again.");
                Native.BY_HANDLE_FILE_INFORMATION info;
                if (!Native.GetFileInformationByHandle(h, out info)) throw Failure("The file could not be opened.");
                if (singleLink && info.Links != 1) throw Failure("The output has multiple links.");
                if (stream.Length > cap) throw Failure("The file is too large.");
                long ticks = ((long)(uint)info.Written.dwHighDateTime << 32) | (uint)info.Written.dwLowDateTime;
                return new RegularRead { Bytes = ReadAll(stream, cap), ModifiedUtc = DateTime.FromFileTimeUtc(ticks), Identity = firstId };
            }
        }

        public byte[] ReadIfExists(string path)
        {
            try { return ReadFile(path, Policy.ProjectReadCap); }
            catch (FileNotFoundException) { return null; }
            catch (DirectoryNotFoundException) { return null; }
        }

        /// A fresh temporary beside path ("." + name + "." + random + ".tmp", the only extra name a
        /// write creates), written and flushed to the drive with FlushFileBuffers.
        static string WriteTemporary(string path, byte[] bytes, bool privateFile, bool collaborationLock = false)
        {
            var folder = Path.GetDirectoryName(path);
            var suffix = new byte[6];
            using (var random = RandomNumberGenerator.Create()) random.GetBytes(suffix);
            var nonce = BitConverter.ToString(suffix).Replace("-", "").ToLowerInvariant();
            var temporary = Path.Combine(folder, collaborationLock ? CollabLocks.PendingName(nonce) : "." + Path.GetFileName(path) + "." + nonce + ".tmp");
            bool owned = false;
            try
            {
                // CreateNew never follows or reuses an existing entry at the temporary name.
                using (var stream = privateFile
                    ? new FileStream(temporary, FileMode.CreateNew, FileSystemRights.Write | FileSystemRights.ReadData, FileShare.None, 4096, FileOptions.None, OwnerOnly())
                    : new FileStream(temporary, FileMode.CreateNew, FileAccess.Write, FileShare.None))
                {
                    owned = true;
                    stream.Write(bytes, 0, bytes.Length);
                    stream.Flush(true);
                    if (!Native.FlushFileBuffers(stream.SafeFileHandle)) throw Failure("Could not write the file.");
                }
            }
            catch (IOException) { if (owned) Native.DeleteFileW(temporary); throw Failure("Could not write the file."); }
            catch (Exception) { if (owned) Native.DeleteFileW(temporary); throw; }
            return temporary;
        }

        public void AtomicWrite(string path, byte[] bytes, bool privateFile, DateTime? modifiedUtc = null, bool collaborationLock = false)
        {
            var temporary = WriteTemporary(path, bytes, privateFile, collaborationLock);
            bool moved = false;
            try
            {
                if (modifiedUtc.HasValue) File.SetLastWriteTimeUtc(temporary, modifiedUtc.Value);
                // MoveFileEx replaces a link at the destination rather than writing through it, and
                // MOVEFILE_WRITE_THROUGH returns only once the rename is on the drive.
                // Antivirus and indexers hold files briefly, so retry a sharing violation a few times.
                for (int attempt = 0; ; attempt++)
                {
                    if (Native.MoveFileExW(temporary, path, Native.MOVEFILE_REPLACE_EXISTING | Native.MOVEFILE_WRITE_THROUGH)) { moved = true; break; }
                    int error = Marshal.GetLastWin32Error();
                    if (attempt >= 4 || (error != 5 && error != 32)) throw Failure(error == 5 ? "Waffle does not have permission to replace that file." : "Could not replace the file.");
                    Thread.Sleep(60);
                }
            }
            finally { if (!moved) Native.DeleteFileW(temporary); }
        }

        public bool AtomicCreate(string path, byte[] bytes)
        {
            var temporary = WriteTemporary(path, bytes, false);
            bool moved = false;
            try
            {
                // Without MOVEFILE_REPLACE_EXISTING the rename fails if anything (even a link) is at the name.
                if (Native.MoveFileExW(temporary, path, Native.MOVEFILE_WRITE_THROUGH)) { moved = true; return true; }
                int error = Marshal.GetLastWin32Error();
                if (error == Native.ERROR_ALREADY_EXISTS || error == Native.ERROR_FILE_EXISTS) return false;
                throw Failure(error == 5 ? "Waffle does not have permission to create that file." : "Could not create the file.");
            }
            finally { if (!moved) Native.DeleteFileW(temporary); }
        }

        public FileStamp Stamp(string path)
        {
            try
            {
                using (var h = OpenMeta(path, false))
                {
                    if (h.IsInvalid || IsLinkTag(h)) return null;
                    Native.BY_HANDLE_FILE_INFORMATION info;
                    if (!Native.GetFileInformationByHandle(h, out info) || (info.Attributes & Native.FILE_ATTRIBUTE_DIRECTORY) != 0) return null;
                    long written = ((long)(uint)info.Written.dwHighDateTime << 32) | (uint)info.Written.dwLowDateTime;
                    return new FileStamp(IdentityOf(h), ((long)info.SizeHigh << 32) | info.SizeLow, written);
                }
            }
            catch (Exception) { return null; }
        }

        public IDisposable TryLockFolder(string folder)
        {
            byte[] hash;
            using (var sha = SHA256.Create()) hash = sha.ComputeHash(Encoding.UTF8.GetBytes(folder.ToUpperInvariant()));
            var mutex = new Mutex(false, "Local\\Atrium.save." + BitConverter.ToString(hash, 0, 16).Replace("-", ""));
            bool owned;
            try { owned = mutex.WaitOne(0); }
            catch (AbandonedMutexException) { owned = true; }
            if (!owned) { mutex.Dispose(); return null; }
            return new Held(mutex);
        }

        sealed class Held : IDisposable
        {
            Mutex mutex;
            public Held(Mutex m) { mutex = m; }
            public void Dispose() { if (mutex != null) { mutex.ReleaseMutex(); mutex.Dispose(); mutex = null; } }
        }

        public EntryKind Kind(string path, out long size)
        {
            size = 0;
            if (path.IndexOf('*') >= 0 || path.IndexOf('?') >= 0) return EntryKind.Other;
            Native.WIN32_FIND_DATA data;
            var find = Native.FindFirstFileW(path, out data);
            if (find == new IntPtr(-1)) return EntryKind.None;
            Native.FindClose(find);
            bool directory = (data.Attributes & Native.FILE_ATTRIBUTE_DIRECTORY) != 0;
            bool link = (data.Attributes & Native.FILE_ATTRIBUTE_REPARSE_POINT) != 0 && (data.Reserved0 & Native.IO_REPARSE_TAG_NAME_SURROGATE) != 0;
            size = ((long)data.SizeHigh << 32) | data.SizeLow;
            if (directory) return EntryKind.Directory;
            return link ? EntryKind.FileLink : EntryKind.File;
        }

        public bool CreateNew(string path, byte[] bytes)
        {
            FileStream stream;
            try { stream = new FileStream(path, FileMode.CreateNew, FileAccess.Write, FileShare.Read); }
            catch (IOException) { long size; if (Kind(path, out size) != EntryKind.None) return false; throw Failure("Could not create the lock file."); }
            using (stream) { stream.Write(bytes, 0, bytes.Length); stream.Flush(true); }
            return true;
        }

        public System.Collections.Generic.IList<string> ListNames(string folder)
        {
            var names = new System.Collections.Generic.List<string>();
            try { foreach (var path in Directory.EnumerateFiles(folder)) names.Add(Path.GetFileName(path)); } catch (Exception) { }
            return names;
        }

        public DateTime? ModifiedUtc(string path) { try { return File.Exists(path) ? File.GetLastWriteTimeUtc(path) : (DateTime?)null; } catch (Exception) { return null; } }

        public bool IsFile(string path) => File.Exists(path);

        public void Unlink(string path) { Native.DeleteFileW(path); }

        public void EnsurePrivateFolder(string folder) { Directory.CreateDirectory(folder); }

        public IHeldFile OpenHeld(string path) => new HeldFile(path);

        sealed class HeldFile : IHeldFile
        {
            readonly FileStream stream;
            public string Identity { get; }
            public HeldFile(string path)
            {
                stream = new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.ReadWrite | FileShare.Delete);
                Identity = IdentityOf(stream.SafeFileHandle);
            }
            public byte[] ReadAll()
            {
                stream.Seek(0, SeekOrigin.Begin);
                return WinFs.ReadAll(stream, Policy.ProjectReadCap);
            }
            public void Dispose() => stream.Dispose();
        }

        public string Identity(string path)
        {
            using (var h = OpenMeta(path, true)) return h.IsInvalid ? null : IdentityOf(h);
        }
    }
}
