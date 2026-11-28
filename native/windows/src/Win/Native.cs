// Win32 declarations used by the Windows host. Kept to the few calls .NET Framework lacks.
using System;
using System.Runtime.InteropServices;
using System.Text;
using Microsoft.Win32.SafeHandles;

namespace Waffle.Windows
{
    static class Native
    {
        public const uint GENERIC_READ = 0x80000000;
        public const uint FILE_READ_ATTRIBUTES = 0x80;
        public const uint FILE_SHARE_READ = 1, FILE_SHARE_WRITE = 2, FILE_SHARE_DELETE = 4;
        public const uint OPEN_EXISTING = 3;
        public const uint FILE_FLAG_BACKUP_SEMANTICS = 0x02000000;
        public const uint FILE_FLAG_OPEN_REPARSE_POINT = 0x00200000;
        public const uint FILE_ATTRIBUTE_DIRECTORY = 0x10;
        public const uint FILE_ATTRIBUTE_REPARSE_POINT = 0x400;
        public const uint FILE_TYPE_DISK = 1;
        public const uint MOVEFILE_REPLACE_EXISTING = 1, MOVEFILE_WRITE_THROUGH = 8;
        public const int ERROR_FILE_NOT_FOUND = 2, ERROR_PATH_NOT_FOUND = 3;
        public const uint IO_REPARSE_TAG_NAME_SURROGATE = 0x20000000;

        [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
        public static extern SafeFileHandle CreateFileW(string name, uint access, uint share, IntPtr security,
                                                         uint disposition, uint flags, IntPtr template);

        [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
        public static extern uint GetFinalPathNameByHandleW(SafeFileHandle handle, StringBuilder path, uint size, uint flags);

        [StructLayout(LayoutKind.Sequential)]
        public struct BY_HANDLE_FILE_INFORMATION
        {
            public uint Attributes;
            public System.Runtime.InteropServices.ComTypes.FILETIME Created, Accessed, Written;
            public uint VolumeSerial, SizeHigh, SizeLow, Links, IndexHigh, IndexLow;
        }

        [DllImport("kernel32.dll", SetLastError = true)]
        public static extern bool GetFileInformationByHandle(SafeFileHandle handle, out BY_HANDLE_FILE_INFORMATION info);

        [StructLayout(LayoutKind.Sequential)]
        public struct FILE_ATTRIBUTE_TAG_INFO { public uint Attributes; public uint ReparseTag; }

        [StructLayout(LayoutKind.Sequential)]
        public struct FILE_ID_INFO { public ulong VolumeSerial; public ulong IdLow; public ulong IdHigh; }

        public const int FileAttributeTagInfo = 9, FileIdInfo = 18;

        [DllImport("kernel32.dll", SetLastError = true)]
        public static extern bool GetFileInformationByHandleEx(SafeFileHandle handle, int kind, out FILE_ATTRIBUTE_TAG_INFO info, uint size);

        [DllImport("kernel32.dll", SetLastError = true)]
        public static extern bool GetFileInformationByHandleEx(SafeFileHandle handle, int kind, out FILE_ID_INFO info, uint size);

        [DllImport("kernel32.dll")]
        public static extern uint GetFileType(SafeFileHandle handle);

        [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
        public static extern bool MoveFileExW(string from, string to, uint flags);

        [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
        public static extern bool DeleteFileW(string path);

        public const int ERROR_FILE_EXISTS = 80, ERROR_ALREADY_EXISTS = 183;

        /// Writes the file's buffered data and metadata to the drive (FileStream.Flush(true) calls it too).
        [DllImport("kernel32.dll", SetLastError = true)]
        public static extern bool FlushFileBuffers(SafeFileHandle handle);

        [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
        public struct WIN32_FIND_DATA
        {
            public uint Attributes;
            public System.Runtime.InteropServices.ComTypes.FILETIME Created, Accessed, Written;
            public uint SizeHigh, SizeLow, Reserved0, Reserved1;
            [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 260)] public string FileName;
            [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 14)] public string AlternateName;
        }

        [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
        public static extern IntPtr FindFirstFileW(string path, out WIN32_FIND_DATA data);

        [DllImport("kernel32.dll")]
        public static extern bool FindClose(IntPtr handle);

        [DllImport("kernel32.dll", ExactSpelling = true)]
        static extern IntPtr GetCurrentProcess();

        [DllImport("kernel32.dll", ExactSpelling = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        static extern bool IsWow64Process2(IntPtr process, out ushort processMachine, out ushort nativeMachine);

        public static string SupportArchitecture()
        {
            try
            {
                // The native machine identifies the host even when Waffle runs under emulation.
                return IsWow64Process2(GetCurrentProcess(), out _, out ushort nativeMachine)
                    ? SupportArchitectureName(nativeMachine) : "unknown";
            }
            catch (EntryPointNotFoundException) { return "unknown"; }
        }

        internal static string SupportArchitectureName(ushort nativeMachine) => nativeMachine switch
        {
            0x8664 => "x64",
            0xAA64 => "arm64",
            _ => "unknown"
        };

        // ------------------------------------------------------------------ network adapters

        [DllImport("iphlpapi.dll", ExactSpelling = true)]
        static extern int GetIfEntry2(IntPtr row);

        /// Whether the adapter with this interface index is hardware (MIB_IF_ROW2's
        /// InterfaceAndOperStatusFlags.HardwareInterface): Wi-Fi and Ethernet cards and USB adapters,
        /// not Hyper-V, WSL, VPN or other virtual adapters. null when Windows cannot say (LanNetworks
        /// then treats the adapter as virtual).
        public static bool? HardwareInterface(int index)
        {
            // MIB_IF_ROW2 (netioapi.h) is 1352 bytes on 32- and 64-bit Windows: InterfaceLuid (8),
            // InterfaceIndex at 8, ..., DirectionType at 1148, then the flags byte at 1152 (bit 0:
            // HardwareInterface). A zero LUID makes GetIfEntry2 look the row up by index.
            const int size = 2048, indexOffset = 8, flagsOffset = 1152;
            var row = Marshal.AllocHGlobal(size);
            try
            {
                for (int i = 0; i < size; i++) Marshal.WriteByte(row, i, 0);
                Marshal.WriteInt32(row, indexOffset, index);
                if (GetIfEntry2(row) != 0) return null;
                return (Marshal.ReadByte(row, flagsOffset) & 1) != 0;
            }
            catch (Exception e) when (e is DllNotFoundException || e is EntryPointNotFoundException) { return null; }
            finally { Marshal.FreeHGlobal(row); }
        }

        // ------------------------------------------------------------------ shell and windows

        public const uint SHARD_PATHW = 3;
        [DllImport("shell32.dll", CharSet = CharSet.Unicode)]
        public static extern void SHAddToRecentDocs(uint flags, string path);

        [DllImport("shell32.dll", CharSet = CharSet.Unicode)]
        public static extern int SetCurrentProcessExplicitAppUserModelID(string id);

        public const int DWMWA_USE_IMMERSIVE_DARK_MODE = 20;
        [DllImport("dwmapi.dll")]
        public static extern int DwmSetWindowAttribute(IntPtr hwnd, int attribute, ref int value, int size);
        [DllImport("dwmapi.dll")]
        public static extern int DwmGetColorizationColor(out uint color, out bool opaque);
        public const int WM_DWMCOLORIZATIONCOLORCHANGED = 0x0320;

        [DllImport("user32.dll")]
        public static extern IntPtr GetSystemMenu(IntPtr hwnd, bool revert);

        public const uint MF_STRING = 0, MF_SEPARATOR = 0x800, MF_GRAYED = 1;
        [DllImport("user32.dll", CharSet = CharSet.Unicode)]
        public static extern bool AppendMenuW(IntPtr menu, uint flags, UIntPtr id, string text);

        [DllImport("user32.dll")]
        public static extern IntPtr CreatePopupMenu();

        [DllImport("user32.dll")]
        public static extern bool DestroyMenu(IntPtr menu);

        public const uint TPM_RETURNCMD = 0x100, TPM_NONOTIFY = 0x80;
        [DllImport("user32.dll")]
        public static extern int TrackPopupMenuEx(IntPtr menu, uint flags, int x, int y, IntPtr hwnd, IntPtr reserved);

        [DllImport("user32.dll")]
        public static extern short GetKeyState(int key);

        [DllImport("user32.dll")]
        public static extern bool MessageBeep(uint type);

        public const int WM_SYSCOMMAND = 0x0112, WM_SETTINGCHANGE = 0x001A, WM_MOVE = 0x0003, WM_MOVING = 0x0216;
        public const int VK_SHIFT = 0x10, VK_CONTROL = 0x11, VK_MENU = 0x12;

        public static bool Down(int key) => (GetKeyState(key) & 0x8000) != 0;

        // ------------------------------------------------------------------ Waffle's own title bar

        public const int WM_NCCALCSIZE = 0x0083, WM_NCLBUTTONDOWN = 0x00A1;
        public const int HTCAPTION = 2, HTTOP = 12, HTTOPLEFT = 13, HTTOPRIGHT = 14;
        public const int SC_SIZE = 0xF000, SC_MOVE = 0xF010, SC_MINIMIZE = 0xF020, SC_MAXIMIZE = 0xF030, SC_CLOSE = 0xF060, SC_RESTORE = 0xF120;
        public const uint MF_BYCOMMAND = 0, MF_ENABLED = 0;
        public const int SM_CYFRAME = 33, SM_CXPADDEDBORDER = 92;
        public const uint SWP_NOSIZE = 0x1, SWP_NOMOVE = 0x2, SWP_NOZORDER = 0x4, SWP_NOACTIVATE = 0x10, SWP_FRAMECHANGED = 0x20, SWP_NOOWNERZORDER = 0x200;

        [StructLayout(LayoutKind.Sequential)]
        public struct RECT { public int Left, Top, Right, Bottom; }

        [StructLayout(LayoutKind.Sequential)]
        public struct NCCALCSIZE_PARAMS { public RECT Proposed, Before, Client; public IntPtr Position; }

        [DllImport("user32.dll")]
        public static extern bool ReleaseCapture();

        [DllImport("user32.dll")]
        public static extern bool PostMessageW(IntPtr hwnd, int message, IntPtr wParam, IntPtr lParam);

        [DllImport("user32.dll")]
        public static extern bool SetWindowPos(IntPtr hwnd, IntPtr after, int x, int y, int width, int height, uint flags);

        [DllImport("user32.dll")]
        public static extern bool IsZoomed(IntPtr hwnd);

        [DllImport("user32.dll")]
        public static extern bool EnableMenuItem(IntPtr menu, uint id, uint flags);

        /// Windows 10 1607 and later; the host targets 1903+.
        [DllImport("user32.dll")]
        public static extern uint GetDpiForWindow(IntPtr hwnd);

        [DllImport("user32.dll")]
        public static extern int GetSystemMetricsForDpi(int index, uint dpi);

        [StructLayout(LayoutKind.Sequential)]
        public struct MONITORINFO { public int Size; public RECT Monitor, Work; public uint Flags; }

        public const uint MONITOR_DEFAULTTONEAREST = 2;
        [DllImport("user32.dll")]
        public static extern IntPtr MonitorFromWindow(IntPtr hwnd, uint flags);

        [DllImport("user32.dll")]
        public static extern bool GetMonitorInfoW(IntPtr monitor, ref MONITORINFO info);

        [StructLayout(LayoutKind.Sequential)]
        public struct APPBARDATA { public int Size; public IntPtr Window; public uint CallbackMessage; public uint Edge; public RECT Rect; public IntPtr Param; }

        public const uint ABM_GETAUTOHIDEBAREX = 0x0B;
        public const uint ABE_LEFT = 0, ABE_TOP = 1, ABE_RIGHT = 2, ABE_BOTTOM = 3;
        [DllImport("shell32.dll")]
        public static extern IntPtr SHAppBarMessage(uint message, ref APPBARDATA data);

        /// A screen point packed as a mouse message's lParam (signed 16-bit coordinates).
        public static IntPtr PointParam(int x, int y) => (IntPtr)(((y & 0xFFFF) << 16) | (x & 0xFFFF));

        // ------------------------------------------------------------------ power saving (PowerSaving.cs)

        [StructLayout(LayoutKind.Sequential)]
        public struct SYSTEM_POWER_STATUS { public byte ACLineStatus, BatteryFlag, BatteryLifePercent, SystemStatusFlag; public uint BatteryLifeTime, BatteryFullLifeTime; }

        [DllImport("kernel32.dll")]
        public static extern bool GetSystemPowerStatus(out SYSTEM_POWER_STATUS status);

        /// The fixed head of POWERBROADCAST_SETTING; the setting's value (a DWORD here) follows at PowerSettingData.
        [StructLayout(LayoutKind.Sequential)]
        public struct POWERBROADCAST_SETTING { public Guid PowerSetting; public uint DataLength; }
        public const int PowerSettingData = 20;

        public const int WM_POWERBROADCAST = 0x0218, PBT_APMPOWERSTATUSCHANGE = 0x000A, PBT_POWERSETTINGCHANGE = 0x8013;
        public const int DEVICE_NOTIFY_WINDOW_HANDLE = 0;
        [DllImport("user32.dll", SetLastError = true)]
        public static extern IntPtr RegisterPowerSettingNotification(IntPtr recipient, ref Guid setting, int flags);

        [DllImport("user32.dll")]
        public static extern bool UnregisterPowerSettingNotification(IntPtr handle);
    }
}
