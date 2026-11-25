// Format 2 uses file-handle range locks shared by all local Waffle processes.
// Directory handles deny delete-sharing for the whole operation to pin the traversed entries.
using System;
using System.IO;
using System.Runtime.InteropServices;
using System.Security.AccessControl;
using System.Security.Principal;
using System.Threading;
using Microsoft.Win32.SafeHandles;

namespace Waffle.Windows
{
#if NET8_0_OR_GREATER
    [System.Runtime.Versioning.SupportedOSPlatform("windows")]
#endif
    sealed partial class WinFs : IFolderPlatform, IFolderDraftIdentity, IImportExportPlatform
    {
        const uint WriteAccess = 0x40000000, NoFollow = Native.FILE_FLAG_OPEN_REPARSE_POINT;
        const int SharingViolation = 32, LockViolation = 33;
        [StructLayout(LayoutKind.Sequential)] struct Range { internal UIntPtr Internal, InternalHigh; internal uint Offset, OffsetHigh; internal IntPtr Event; }
        [DllImport("kernel32.dll", SetLastError = true)] static extern bool LockFileEx(SafeFileHandle h, uint flags, uint reserved, uint low, uint high, ref Range range);
        static string NativeFolderPath(string path)
        {
            // Managed staging supports long paths, but raw Win32 calls may still enforce
            // MAX_PATH. Keep the prefix local to these calls on the validated absolute paths.
            if (path.Length < 260 || path.StartsWith(@"\\?\", StringComparison.Ordinal)) return path;
            return path.StartsWith(@"\\", StringComparison.Ordinal) ? @"\\?\UNC\" + path.Substring(2) : @"\\?\" + path;
        }
        static SafeFileHandle StrictHandle(string path, uint access, uint share, bool directory, bool allowBusy = false)
        {
            var h = Native.CreateFileW(NativeFolderPath(path), access, share, IntPtr.Zero, Native.OPEN_EXISTING, NoFollow | (directory ? Native.FILE_FLAG_BACKUP_SEMANTICS : 0), IntPtr.Zero);
            if (h.IsInvalid)
            {
                int error = Marshal.GetLastWin32Error(); h.Dispose();
                if (allowBusy && (error == SharingViolation || error == LockViolation)) return null;
                throw new IOException("The project entry could not be opened (" + error + ").");
            }
            if (Native.GetFileType(h) != Native.FILE_TYPE_DISK || !Native.GetFileInformationByHandle(h, out var info) ||
                (info.Attributes & Native.FILE_ATTRIBUTE_REPARSE_POINT) != 0 || ((info.Attributes & Native.FILE_ATTRIBUTE_DIRECTORY) != 0) != directory ||
                (!directory && info.Links != 1))
            {
                h.Dispose(); throw new HostError("The folder project requires regular, singly linked files and local directories without reparse points.");
            }
            return h;
        }
        public bool ReadHandlesPreventChanges => true;
        public IDisposable PinDirectory(string p) => StrictHandle(p, Native.FILE_READ_ATTRIBUTES, Native.FILE_SHARE_READ | Native.FILE_SHARE_WRITE, true);
        public Stream OpenRegular(string p) => new FileStream(StrictHandle(p, Native.GENERIC_READ, Native.FILE_SHARE_READ, false), FileAccess.Read);
        static string IdentityOf(SafeFileHandle h)
        {
            Native.FILE_ID_INFO id;
            if (Native.GetFileInformationByHandleEx(h, Native.FileIdInfo, out id, (uint)Marshal.SizeOf(typeof(Native.FILE_ID_INFO))))
                return id.VolumeSerial.ToString("x16") + ":" + id.IdHigh.ToString("x16") + id.IdLow.ToString("x16");
            Native.BY_HANDLE_FILE_INFORMATION info;
            if (Native.GetFileInformationByHandle(h, out info))
                return info.VolumeSerial.ToString("x8") + ":" + info.IndexHigh.ToString("x8") + info.IndexLow.ToString("x8");
            return null;
        }

        public string ExportIdentity(string path,bool directory)
        {
            using (var file=StrictHandle(path,Native.FILE_READ_ATTRIBUTES,Native.FILE_SHARE_READ|Native.FILE_SHARE_WRITE,directory))
                return IdentityOf(file);
        }

        [DllImport("KtmW32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
        static extern SafeFileHandle CreateTransaction(IntPtr attributes,IntPtr unit,uint options,uint level,uint flags,uint timeout,string description);
        [DllImport("KtmW32.dll", SetLastError=true)] static extern bool CommitTransaction(SafeFileHandle transaction);
        [DllImport("KtmW32.dll", SetLastError=true)] static extern bool RollbackTransaction(SafeFileHandle transaction);
        [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
        static extern bool MoveFileTransactedW(string source,string destination,IntPtr progress,IntPtr data,uint flags,SafeFileHandle transaction);
        public void ExchangeExport(string staged,string prior,bool single)
        {
            var backup=staged+".prior";
            if(single) {
                File.Replace(staged,prior,backup);
                try {File.Move(backup,staged);}
                catch {File.Replace(backup,prior,staged);throw;}
                return;
            }
            // Windows cannot atomically overwrite a populated directory. Publish all three
            // renames through the filesystem transaction, or leave the prior target intact.
            using(var tx=CreateTransaction(IntPtr.Zero,IntPtr.Zero,0,0,0,0,"Waffle project export")) {
                if(tx.IsInvalid)throw new IOException("This volume does not support atomic replacement of project export folders.");
                if(!MoveFileTransactedW(NativeFolderPath(prior),NativeFolderPath(backup),IntPtr.Zero,IntPtr.Zero,0,tx)||
                   !MoveFileTransactedW(NativeFolderPath(staged),NativeFolderPath(prior),IntPtr.Zero,IntPtr.Zero,0,tx)||
                   !MoveFileTransactedW(NativeFolderPath(backup),NativeFolderPath(staged),IntPtr.Zero,IntPtr.Zero,0,tx)||!CommitTransaction(tx)) {
                    int code=Marshal.GetLastWin32Error();RollbackTransaction(tx);
                    throw new IOException("The volume could not atomically replace the project export ("+code+").");
                }
            }
        }

        public string RecoveryIdentity(string p)
        {
            using (var handle = StrictHandle(p, Native.GENERIC_READ, Native.FILE_SHARE_READ | Native.FILE_SHARE_WRITE, true))
                return IdentityOf(handle);
        }
        public IDisposable TryBarrier(string p, bool directory, bool writer)
        {
            // Until the journal lock exists, reader handles share reads and deny writes.
            // A writer asks for write access and also denies writes, so it excludes both
            // kinds of barrier. Ordinary enumeration and the folder watcher share writes.
            if (directory) return StrictHandle(p, writer ? WriteAccess | Native.FILE_READ_ATTRIBUTES : Native.GENERIC_READ,
                Native.FILE_SHARE_READ, true, allowBusy: true);
            var h = StrictHandle(p, Native.GENERIC_READ | (writer ? WriteAccess : 0), Native.FILE_SHARE_READ | Native.FILE_SHARE_WRITE, false, allowBusy: true);
            if (h == null) return null;
            var range = new Range();
            if (LockFileEx(h, 1u | (writer ? 2u : 0u), 0, 1, 0, ref range)) return h;
            int error = Marshal.GetLastWin32Error(); h.Dispose();
            if (error == SharingViolation || error == LockViolation) return null;
            throw new HostError("The volume could not lock the project.");
        }
        static void FlushDirectory(SafeFileHandle directory)
        {
            if (!Native.FlushFileBuffers(directory)) throw new HostError("The volume could not confirm the folder change. Choose a local folder that supports durable saves.");
        }
        public void SyncDirectory(string p, IDisposable heldDirectory = null)
        {
            // The bootstrap writer denies other write handles, including another handle of our own.
            if (heldDirectory is SafeFileHandle held) { FlushDirectory(held); return; }
            using (var h = StrictHandle(p, WriteAccess, Native.FILE_SHARE_READ | Native.FILE_SHARE_WRITE, true)) FlushDirectory(h);
        }
        public void MoveEntry(string from, string to, bool replace)
        {
            string source = NativeFolderPath(from), destination = NativeFolderPath(to);
            for (int attempt = 0; ; attempt++)
            {
                if (Native.MoveFileExW(source, destination, Native.MOVEFILE_WRITE_THROUGH | (replace ? Native.MOVEFILE_REPLACE_EXISTING : 0))) return;
                int error = Marshal.GetLastWin32Error();
                if ((error != SharingViolation && error != LockViolation) || attempt >= 4) throw new IOException("Could not install the project entry (" + error + ").");
                Thread.Sleep(5 << attempt);
            }
        }
        public void DeleteEntry(string p)
        {
            if (!Native.DeleteFileW(NativeFolderPath(p))) throw new IOException("Could not remove the project entry (" + Marshal.GetLastWin32Error() + ").");
        }
        static FileSecurity OwnerOnly()
        {
            var security = new FileSecurity();
            security.SetAccessRuleProtection(true, false);
            security.AddAccessRule(new FileSystemAccessRule(WindowsIdentity.GetCurrent().User, FileSystemRights.FullControl, AccessControlType.Allow));
            return security;
        }

        public FileStream NewFile(string p, bool isPrivate) => isPrivate
#if NET8_0_OR_GREATER
            ? new FileInfo(p).Create(FileMode.CreateNew,FileSystemRights.Write|FileSystemRights.ReadData,FileShare.None,65536,FileOptions.WriteThrough,OwnerOnly())
#else
            ? new FileStream(p, FileMode.CreateNew, FileSystemRights.Write | FileSystemRights.ReadData, FileShare.None, 65536, FileOptions.WriteThrough, OwnerOnly())
#endif
            : new FileStream(p, FileMode.CreateNew, FileAccess.Write, FileShare.None, 65536, FileOptions.WriteThrough);
        public void CheckWritableVolume(string p)
        {
            if (p.StartsWith(@"\\", StringComparison.Ordinal)) throw new HostError("Choose a local Windows drive for a durable folder project save.");
            var volume = new DriveInfo(Path.GetPathRoot(p));
            if ((volume.DriveType != DriveType.Fixed && volume.DriveType != DriveType.Removable) ||
               !(volume.DriveFormat == "NTFS" || volume.DriveFormat == "ReFS"))
                throw new HostError("Choose a local NTFS or ReFS drive for a durable folder project save.");
        }
    }
}
