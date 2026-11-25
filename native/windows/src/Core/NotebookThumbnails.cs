// Preview data is isolated from authored attachments. The grant resolves its own
// owner, original and cache name before any caller can receive or replace a PNG.
using System;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using System.IO.Compression;
using System.Linq;

namespace Waffle.Windows
{
    using Map = Dictionary<string, object>;

    internal sealed class NotebookClipboardItem
    {
        internal string MediaType, Name;
        // Typed clipboard bytes are copied while the clipboard is open on the window thread.
        // Conversion of a bitmap-only clipboard can then run away from the window.
        internal Func<byte[]> Bytes;
    }
    internal interface INotebookClipboard
    {
        NotebookClipboardItem ReadNotebookClipboard();
    }

    internal static class NotebookThumbnail
    {
        internal const int Limit = 8 * 1024 * 1024;
        static readonly int[] Tiers = { 128, 256, 512, 1024, 2048, 4096 };
        static readonly byte[] Signature = { 137, 80, 78, 71, 13, 10, 26, 10 };
        static readonly uint[] CrcTable = MakeCrcTable();
        static uint[] MakeCrcTable()
        {
            var table = new uint[256];
            for (uint i = 0; i < 256; i++)
            {
                uint n = i;
                for (int bit = 0; bit < 8; bit++) n = (n & 1) == 0 ? n >> 1 : (n >> 1) ^ 0xedb88320;
                table[i] = n;
            }
            return table;
        }
        internal static bool Tier(int side) => Array.IndexOf(Tiers, side) >= 0;
        static uint Word(byte[] b, int p) => (uint)b[p] << 24 | (uint)b[p + 1] << 16 | (uint)b[p + 2] << 8 | b[p + 3];
        static bool Pixels(MemoryStream compressed, int width, int height, int colour, int depth, bool interlaced)
        {
            if (compressed.Length < 6) return false;
            var bytes = compressed.GetBuffer(); int length = (int)compressed.Length;
            if ((bytes[0] & 15) != 8 || (bytes[0] >> 4) > 7 || ((bytes[0] << 8) | bytes[1]) % 31 != 0 || (bytes[1] & 32) != 0) return false;
            int channels = colour == 6 ? 4 : colour == 2 ? 3 : colour == 4 ? 2 : 1;
            var row = new byte[1 + (width * channels * depth + 7) / 8];
            // The seventh Adam7 pass covers every column in every other row. A
            // noninterlaced image uses a single full-resolution pass.
            int[] xs = { 0, 4, 0, 2, 0, 1, 0 }, ys = { 0, 0, 4, 0, 2, 0, 1 };
            int[] dx = { 8, 8, 4, 4, 2, 2, 1 }, dy = { 8, 8, 8, 4, 4, 2, 2 };
            uint first = 1, second = 0;
            try
            {
                using (var source = new MemoryStream(bytes, 2, length - 6, false))
                using (var inflate = new DeflateStream(source, CompressionMode.Decompress))
                {
                    for (int pass = 0; pass < (interlaced ? 7 : 1); pass++)
                    {
                        int wide = interlaced ? Math.Max(0, (width - xs[pass] + dx[pass] - 1) / dx[pass]) : width;
                        int tall = interlaced ? Math.Max(0, (height - ys[pass] + dy[pass] - 1) / dy[pass]) : height;
                        if (wide == 0) continue;
                        int count = 1 + (wide * channels * depth + 7) / 8;
                        for (int y = 0; y < tall; y++)
                        {
                            for (int at = 0; at < count;)
                            {
                                int read = inflate.Read(row, at, count - at);
                                if (read == 0) return false;
                                at += read;
                            }
                            if (row[0] > 4) return false;
                            for (int at = 0; at < count;)
                            {
                                int end = Math.Min(count, at + 5552);
                                for (; at < end; at++) { first += row[at]; second += first; }
                                first %= 65521; second %= 65521;
                            }
                        }
                    }
                    return inflate.ReadByte() < 0 && (second << 16 | first) == Word(bytes, length - 4);
                }
            }
            catch (InvalidDataException) { return false; }
            catch (IOException) { return false; }
        }

        internal static bool Valid(byte[] b, int side)
        {
            if (b == null || b.Length < 57 || b.Length > Limit || !b.Take(8).SequenceEqual(Signature)) return false;
            bool data = false, endedData = false, palette = false;
            int colour = -1, depth = 0, width = 0, height = 0;
            bool interlaced = false;
            using var compressed = new MemoryStream();
            for (int at = 8; at <= b.Length - 12;)
            {
                uint length = Word(b, at), type = Word(b, at + 4);
                if (length > b.Length - 12 - at) return false;
                int next = at + (int)length + 12;
                uint crc = uint.MaxValue;
                for (int i = at + 4; i < next - 4; i++) crc = (crc >> 8) ^ CrcTable[(byte)(crc ^ b[i])];
                if (~crc != Word(b, next - 4)) return false;
                if (at == 8)
                {
                    if (type != 0x49484452 || length != 13) return false;
                    width = (int)Word(b, at + 8); height = (int)Word(b, at + 12);
                    if (width < 1 || height < 1 || width > side || height > side || (long)width * height > 8 * 1048576) return false;
                    depth = b[at + 16]; colour = b[at + 17]; interlaced = b[at + 20] != 0;
                    if (!(colour == 0 && new[] { 1, 2, 4, 8, 16 }.Contains(depth) || colour == 3 && new[] { 1, 2, 4, 8 }.Contains(depth) ||
                        (colour == 2 || colour == 4 || colour == 6) && (depth == 8 || depth == 16)) ||
                        b[at + 18] != 0 || b[at + 19] != 0 || b[at + 20] > 1) return false;
                }
                else if (type == 0x49444154) // IDAT
                {
                    if (endedData || colour == 3 && !palette) return false;
                    data |= length != 0;
                    compressed.Write(b, at + 8, (int)length);
                }
                else if (type == 0x49454e44) return data && length == 0 && next == b.Length && Pixels(compressed, width, height, colour, depth, interlaced); // IEND
                else
                {
                    endedData |= data;
                    if (type == 0x504c5445) // PLTE
                    {
                        if (palette || data || colour == 0 || colour == 4 || length == 0 || length > 768 || length % 3 != 0 ||
                            colour == 3 && length > 3 * (1 << depth)) return false;
                        palette = true;
                    }
                    else if ((b[at + 4] & 32) == 0 || type == 0x6163544c || type == 0x6663544c || type == 0x66644154) return false;
                }
                at = next;
            }
            return false;
        }
    }

    internal sealed partial class FolderProject
    {
        internal Map PasteNotebook(string owner, NotebookClipboardItem item)
        {
            CheckOpen();
            var bytes = item.Bytes();
            if (bytes == null || bytes.Length == 0 || bytes.Length > NotebookInput.MaxBytes) throw FolderFormat.Invalid("clipboard image size");
            using (var input = new MemoryStream(bytes, false))
            {
                string media = MediaOf(input);
                if (item.MediaType != media && !(item.MediaType == "image/heif" && media == "image/heic"))
                    throw FolderFormat.Invalid("clipboard media type");
                var result = (Map)StageAsset(owner, media, input);
                result["name"] = item.Name; return result;
            }
        }

        void VerifyThumbnailOriginal(Map r, string owner, string hash, string type, long size)
        {
            string token = FolderFormat.Text(r, "assetToken");
            if (token != null)
            {
                var asset = StagedAsset(token, "assets/" + hash);
                if (asset.Owner != owner || asset.Type != type || asset.Length != size) throw FolderFormat.Invalid("attachment owner");
                return;
            }
            var path = Members(disk.Read(Manifest)).FirstOrDefault(referral => referral.Value == owner).Key;
            var bytes = path == null ? null : disk.Read(path);
            if (bytes == null || First(bytes) is not Map header || FolderFormat.Text(header, "id") != owner ||
                FolderFormat.Text(header, "kind") != FolderFormat.MemberKind(path) || !FolderFormat.Records(bytes).Any(row => HasRef(row, hash, type, size)))
                throw FolderFormat.Invalid("attachment owner");
            using (var original = disk.Open("assets/" + hash))
            using (var checksum = System.Security.Cryptography.SHA256.Create())
            {
                if (original == null || original.Length != size || MediaOf(original) != type || FolderFormat.Hex(checksum.ComputeHash(original)) != hash)
                    throw new FolderConflict("assets/" + hash);
            }
        }

        internal Map Derivative(Map r)
        {
            lock (gate)
            {
                CheckOpen();
                string owner = FolderFormat.Id(FolderFormat.Text(r, "ownerId"));
                if (!(FolderFormat.Get(r, "assetRef") is Map reference)) throw FolderFormat.Invalid("thumbnail source");
                string hash = FolderFormat.Text(reference, "sha256"), type = FolderFormat.Text(reference, "mediaType"), op = FolderFormat.Text(r, "op");
                long size = FolderFormat.Number(FolderFormat.Get(reference, "byteLength"), NotebookInput.MaxBytes);
                int side = (int)FolderFormat.Number(FolderFormat.Get(r, "side"), 4096);
                if (size == 0 || !FolderFormat.IsDigest(hash) || !Types.Contains(type) || !NotebookThumbnail.Tier(side) || op != "read" && op != "write")
                    throw FolderFormat.Invalid("thumbnail request");
                string lease = (string)((Map)AcquireLease())["lease"];
                try
                {
                    VerifyThumbnailOriginal(r, owner, hash, type, size);
                    string dir = ".waffle/cache/images-v1/" + hash;
                    string path = dir + "/screen-v1-s" + side.ToString(CultureInfo.InvariantCulture) + ".png";
                    if (op == "read")
                    {
                        using (var existing = disk.Open(path))
                        {
                            if (existing == null || existing.Length == 0 || existing.Length > NotebookThumbnail.Limit) return new Map();
                            var png = FolderStorage.Bytes(existing, NotebookThumbnail.Limit);
                            if (!NotebookThumbnail.Valid(png, side)) return new Map();
                            return new Map { ["png"] = Convert.ToBase64String(png), ["sha256"] = FolderFormat.Sha(png) };
                        }
                    }
                    string encoded = FolderFormat.Text(r, "png");
                    if (string.IsNullOrEmpty(encoded) || encoded.Length > (NotebookThumbnail.Limit + 2) / 3 * 4) throw FolderFormat.Invalid("thumbnail size");
                    byte[] data = Convert.FromBase64String(encoded);
                    if (!NotebookThumbnail.Valid(data, side)) throw FolderFormat.Invalid("thumbnail PNG");
                    string temporary = dir + "/.media-" + Guid.NewGuid().ToString("N");
                    try
                    {
                        if (disk.Spelling(path) != null)
                            using (var existing = disk.Open(path)) if (existing == null) throw FolderFormat.Invalid("thumbnail name");
                        disk.WriteTemp(temporary, s => s.Write(data, 0, data.Length), true, null, null);
                        disk.Move(temporary, path, true);
                    }
                    finally { disk.Delete(temporary); }
                    return new Map { ["saved"] = true };
                }
                finally { Release(lease); }
            }
        }
    }
}
