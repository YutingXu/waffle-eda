// The Windows bitmap clipboard supplies a packed DIB without a BMP file header.
// Build a bounded pixel-only BMP stream. Linked colour profiles are never opened.
using System;
using System.IO;

namespace Waffle.Windows
{
    internal static class NotebookBitmap
    {
        internal static byte[] FileBytes(byte[] dib)
        {
            if (dib == null || dib.Length < 40 || dib.Length > NotebookInput.MaxBytes) throw FolderFormat.Invalid("clipboard bitmap size");
            uint header = BitConverter.ToUInt32(dib, 0);
            if ((header != 40 && header != 52 && header != 56 && header != 108 && header != 124) || header > dib.Length)
                throw FolderFormat.Invalid("clipboard bitmap header");
            int width = BitConverter.ToInt32(dib, 4), height = BitConverter.ToInt32(dib, 8);
            int depth = BitConverter.ToUInt16(dib, 14);
            uint compression = BitConverter.ToUInt32(dib, 16), colours = BitConverter.ToUInt32(dib, 32);
            if (width < 1 || height == 0 || height == int.MinValue || (long)width * Math.Abs(height) > NotebookInput.MaxBytes / 4 ||
                BitConverter.ToUInt16(dib, 12) != 1 || (depth != 1 && depth != 4 && depth != 8 && depth != 16 && depth != 24 && depth != 32) ||
                (compression != 0 && compression != 3 && compression != 6) || (compression != 0 && depth != 16 && depth != 32))
                throw FolderFormat.Invalid("clipboard bitmap layout");
            if (header >= 108 && BitConverter.ToUInt32(dib, 56) == 0x4c494e4b) throw FolderFormat.Invalid("linked clipboard colour profile");
            if (depth <= 8)
            {
                if (colours == 0) colours = 1u << depth;
                if (colours > (1u << depth)) throw FolderFormat.Invalid("clipboard bitmap palette");
            }
            var palette = 4L * colours;
            int masks = header == 40 && compression != 0 ? (compression == 6 ? 16 : 12) : 0;
            long start = header + palette + masks;
            long pixels = ((width * (long)depth + 31) / 32 * 4) * Math.Abs(height);
            if (start > dib.Length || pixels > dib.Length - start) throw FolderFormat.Invalid("clipboard bitmap pixels");
            if (header == 124 && BitConverter.ToUInt32(dib, 116) != 0)
                throw FolderFormat.Invalid("profiled clipboard bitmap");
            int used = (int)(start + pixels);
            using (var output = new MemoryStream(14 + used))
            using (var writer = new BinaryWriter(output))
            {
                writer.Write((ushort)0x4d42); writer.Write(14 + used); writer.Write(0); writer.Write((int)start + 14);
                writer.Write(dib, 0, used); return output.ToArray();
            }
        }
    }
}
