// Copy bytes only from known HGLOBAL clipboard formats. Arbitrary clipboard
// objects and paths never reach a decoder. Conversion runs after CloseClipboard.
using System;
using System.Drawing;
using System.Drawing.Imaging;
using System.IO;
using System.Runtime.InteropServices;

namespace Waffle.Windows
{
    static class WinNotebookClipboard
    {
        [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
        [DllImport("user32.dll", SetLastError = true)] static extern bool OpenClipboard(IntPtr owner);
        [DllImport("user32.dll")] static extern bool CloseClipboard();
        [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern uint RegisterClipboardFormatW(string name);
        [DllImport("user32.dll")] static extern bool IsClipboardFormatAvailable(uint format);
        [DllImport("user32.dll")] static extern IntPtr GetClipboardData(uint format);
        [DllImport("kernel32.dll")] static extern UIntPtr GlobalSize(IntPtr handle);
        [DllImport("kernel32.dll")] static extern IntPtr GlobalLock(IntPtr handle);
        [DllImport("kernel32.dll")] static extern bool GlobalUnlock(IntPtr handle);

        static readonly (string Type, string Ext, string[] Formats)[] Originals = {
            ("image/png", "png", new[] { "PNG", "image/png" }),
            ("image/jpeg", "jpg", new[] { "JFIF", "image/jpeg" }),
            ("image/webp", "webp", new[] { "image/webp", "WebP" }),
            ("image/heic", "heic", new[] { "image/heic", "image/heif" }),
            ("image/svg+xml", "svg", new[] { "image/svg+xml" }),
            ("application/pdf", "pdf", new[] { "application/pdf", "Portable Document Format" })
        };

        static byte[] Copy(uint format)
        {
            var handle = GetClipboardData(format);
            ulong size = handle == IntPtr.Zero ? 0 : GlobalSize(handle).ToUInt64();
            if (size == 0 || size > NotebookInput.MaxBytes) throw FolderFormat.Invalid("clipboard media size");
            var source = GlobalLock(handle);
            if (source == IntPtr.Zero) throw new HostError("Windows could not read this clipboard image.");
            try { var data = new byte[(int)size]; Marshal.Copy(source, data, 0, data.Length); return data; }
            finally { GlobalUnlock(handle); }
        }

        static byte[] Png(byte[] dib)
        {
            var bmp = NotebookBitmap.FileBytes(dib);
            using (var memory = new MemoryStream(bmp, false))
            using (var image = Image.FromStream(memory, false, true))
            using (var output = new MemoryStream())
            {
                image.Save(output, ImageFormat.Png);
                if (output.Length == 0 || output.Length > NotebookInput.MaxBytes) throw FolderFormat.Invalid("clipboard PNG size");
                return output.ToArray();
            }
        }

        internal static NotebookClipboardItem Read(IntPtr owner)
        {
            if (GetForegroundWindow() != owner) throw new HostError("Bring this project to the front to paste an image.");
            if (!OpenClipboard(owner)) throw new HostError("The clipboard is busy. Try Paste again.");
            try
            {
                foreach (var original in Originals)
                {
                    foreach (string name in original.Formats)
                    {
                        uint format = RegisterClipboardFormatW(name);
                        if (format == 0 || !IsClipboardFormatAvailable(format)) continue;
                        var bytes = Copy(format);
                        return new NotebookClipboardItem { MediaType = original.Type, Name = "Clipboard." + original.Ext, Bytes = () => bytes };
                    }
                }
                const uint dibV5 = 17, dib = 8;
                uint bitmap = IsClipboardFormatAvailable(dibV5) ? dibV5 : IsClipboardFormatAvailable(dib) ? dib : 0;
                if (bitmap == 0) return null;
                var pixels = Copy(bitmap);
                return new NotebookClipboardItem { MediaType = "image/png", Name = "Clipboard.png", Bytes = () => Png(pixels) };
            }
            finally { CloseClipboard(); }
        }
    }
}
