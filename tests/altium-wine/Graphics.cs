// Build as a 64-bit Windows executable using the compiler in the Wine prefix.
using System;
using System.Runtime.InteropServices;

class Graphics
{
    [DllImport("d3d11.dll", ExactSpelling = true)]
    private static extern int D3D11CreateDevice(
        IntPtr adapter, uint driverType, IntPtr software, uint flags,
        [In] uint[] levels, uint levelCount, uint sdkVersion,
        out IntPtr device, out uint selected, out IntPtr context);

    static int Main()
    {
        uint[] levels = { 0xb000, 0xa100, 0xa000, 0x9300 };
        IntPtr device, context;
        uint selected;
        // D3D_DRIVER_TYPE_HARDWARE = 1, D3D11_SDK_VERSION = 7.
        int hr = D3D11CreateDevice(IntPtr.Zero, 1, IntPtr.Zero, 0, levels,
            (uint)levels.Length, 7, out device, out selected, out context);
        Console.WriteLine("Windows process {0}-bit, D3D11CreateDevice HRESULT 0x{1:X8}, feature level 0x{2:X4}",
            IntPtr.Size * 8, hr, selected);
        if (hr < 0) return 1;
        Marshal.Release(context);
        Marshal.Release(device);
        return IntPtr.Size == 8 && selected >= 0xb000 ? 0 : 1;
    }
}
