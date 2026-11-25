// Native notebook decoding consumes bytes already held by the application. A clip can
// reference only an attachment owned by the selected sheet, including an uncommitted one.
using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Threading;

namespace Waffle.Windows
{
    using Map = Dictionary<string, object>;

    internal interface INotebookMedia
    {
        Map Decode(Map options, byte[] bytes, CancellationToken cancellation);
    }

    internal static class NotebookInput
    {
        internal const int MaxBytes = 128 * 1024 * 1024;
        internal static byte[] Bytes(Map request)
        {
            string encoded = FolderFormat.Text(request, "data");
            if (string.IsNullOrEmpty(encoded) || encoded.Length > (MaxBytes + 2L) / 3 * 4) throw FolderFormat.Invalid("notebook media size");
            var data = Convert.FromBase64String(encoded);
            if (data.Length == 0 || data.Length > MaxBytes) throw FolderFormat.Invalid("notebook media size");
            if (request.ContainsKey("sha256") && FolderFormat.Text(request, "sha256") != FolderFormat.Sha(data)) throw FolderFormat.Invalid("notebook media digest");
            return data;
        }
    }

    internal sealed partial class FolderProject
    {
        internal Map Transfer(Map r)
        {
            if (!new[] { "drop", "paste", "camera" }.Contains(FolderFormat.Text(r, "origin"))) throw FolderFormat.Invalid("attachment origin");
            using (var input = new MemoryStream(NotebookInput.Bytes(r), false))
            {
                string type = MediaOf(input);
                var expected = FolderFormat.Text(r, "mediaType");
                if (!string.IsNullOrEmpty(expected) && expected != type && !(expected == "image/heif" && type == "image/heic")) throw FolderFormat.Invalid("attachment media type");
                return (Map)StageAsset(FolderFormat.Text(r, "ownerId"), type, input);
            }
        }
        internal Map Clip(INotebookMedia renderer, Map r, CancellationToken cancellation)
        {
            if (!(FolderFormat.Get(r, "assetRef") is Map source) || FolderFormat.Text(source, "mediaType") != "application/pdf")
                throw FolderFormat.Invalid("datasheet source");
            string owner = FolderFormat.Id(FolderFormat.Text(r, "ownerId"));
            long size = FolderFormat.Number(FolderFormat.Get(source, "byteLength"), NotebookInput.MaxBytes);
            if (size == 0) throw FolderFormat.Invalid("empty datasheet");
            string lease = null;
            var read = new Map { ["ownerId"] = owner, ["assetRef"] = source, ["purpose"] = "clip", ["length"] = ChunkLimit, ["assetToken"] = FolderFormat.Get(r, "assetToken") };
            using (var bytes = new MemoryStream((int)size))
            {
                try
                {
                    if (FolderFormat.Text(r, "assetToken") == null) { lease = (string)((Map)AcquireLease())["lease"]; read["lease"] = lease; }
                    while (bytes.Length < size)
                    {
                        cancellation.ThrowIfCancellationRequested(); read["offset"] = bytes.Length;
                        var chunk = (Map)ReadAsset(read);
                        var data = Convert.FromBase64String((string)chunk["data"]);
                        if (data.Length == 0 || bytes.Length + data.Length > size) throw FolderFormat.Invalid("datasheet range");
                        bytes.Write(data, 0, data.Length);
                    }
                }
                finally { if (lease != null) Release(lease); }
                var options = new Map(r) { ["op"] = "pdfPage" };
                var image = renderer.Decode(options, bytes.ToArray(), cancellation);
                cancellation.ThrowIfCancellationRequested();
                using (var png = new MemoryStream(Convert.FromBase64String((string)image["png"]), false))
                {
                    var result = (Map)StageAsset(owner, "image/png", png);
                    result["width"] = image["width"]; result["height"] = image["height"]; return result;
                }
            }
        }
    }
}
