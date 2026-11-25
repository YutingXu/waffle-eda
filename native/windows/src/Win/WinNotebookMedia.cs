// Windows Imaging Component and Windows.Data.Pdf run off the WebView2 thread.
// Both decode byte streams without navigation, network access or a caller-supplied file path.
using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Threading;
using System.Threading.Tasks;
using global::Windows.Data.Pdf;
using global::Windows.Graphics.Imaging;
using global::Windows.Storage.Streams;

namespace Waffle.Windows
{
    using Map = Dictionary<string, object>;

    sealed partial class WinFs : INotebookMedia
    {
        const int MaxPixels = 8 * 1024 * 1024;

        public Map Decode(Map options, byte[] bytes, CancellationToken cancellation)
        {
            if (bytes.Length < 1 || bytes.Length > NotebookInput.MaxBytes) throw FolderFormat.Invalid("media size");
            var side = (int)FolderFormat.Number(FolderFormat.Get(options, "side") ?? 1200, 4096);
            if (side == 0) throw FolderFormat.Invalid("preview size");
            try { return DecodeAsync(options, bytes, side, cancellation).GetAwaiter().GetResult(); }
            catch (OperationCanceledException) { throw new HostError("The media request was cancelled."); }
            catch (Exception e) when (e is System.Runtime.InteropServices.COMException || e is ArgumentException || e is NotSupportedException)
            { throw new HostError("The Windows media codec could not read this document."); }
        }
        static async Task<Map> DecodeAsync(Map options, byte[] raw, int side, CancellationToken token)
        {
            using (var input = new InMemoryRandomAccessStream())
            {
                using (var writer = new DataWriter(input))
                {
                    writer.WriteBytes(raw); await writer.StoreAsync().AsTask(token).ConfigureAwait(false); writer.DetachStream();
                }
                input.Seek(0); var op = FolderFormat.Text(options, "op");
                if (op == "pdfInfo" || op == "pdfPage") return await Pdf(options, input, raw, side, token).ConfigureAwait(false);
                if (op != "info" && op != "decode") throw FolderFormat.Invalid("media operation");
                string expected = FolderFormat.Text(options, "mediaType"), actual;
                bool gif = raw.Length >= 6 && raw[0] == 'G' && raw[1] == 'I' && raw[2] == 'F' && raw[3] == '8' && (raw[4] == '7' || raw[4] == '9') && raw[5] == 'a';
                using (var source = new MemoryStream(raw, false)) actual = gif ? "image/gif" : FolderProject.MediaOf(source);
                if ((actual != expected && !(actual == "image/heic" && expected == "image/heif")) || actual == "image/svg+xml" || actual == "application/pdf")
                    throw FolderFormat.Invalid("raster media type");
                var decoder = await BitmapDecoder.CreateAsync(input).AsTask(token).ConfigureAwait(false);
                var width = decoder.OrientedPixelWidth; var height = decoder.OrientedPixelHeight;
                if (width == 0 || height == 0 || width > 100000 || height > 100000 || (long)width * height > 120000000)
                    throw FolderFormat.Invalid("image extent");
                var result = new Map { ["extent"] = new[] { (int)width, (int)height } };
                if (op == "info") return result;
                var scale = Math.Min(1.0, Math.Min(side / (double)Math.Max(width, height), Math.Sqrt(MaxPixels / ((double)width * height))));
                int w = Pixels(width * scale), h = Pixels(height * scale);
                var transform = new BitmapTransform
                {
                    ScaledWidth = (uint)Pixels(decoder.PixelWidth * scale),
                    ScaledHeight = (uint)Pixels(decoder.PixelHeight * scale),
                    InterpolationMode = BitmapInterpolationMode.Fant
                };
                var pixels = await decoder.GetPixelDataAsync(BitmapPixelFormat.Rgba8, BitmapAlphaMode.Straight, transform,
                    ExifOrientationMode.RespectExifOrientation, ColorManagementMode.ColorManageToSRgb).AsTask(token).ConfigureAwait(false);
                var rgba = pixels.DetachPixelData();
                if ((long)w * h > MaxPixels || rgba.Length != (long)w * h * 4) throw FolderFormat.Invalid("decoded image dimensions");
                result["width"] = w; result["height"] = h; result["rgba"] = Convert.ToBase64String(rgba); return result;
            }
        }
        static int Pixels(double value) => Math.Max(1, (int)Math.Round(value, MidpointRounding.AwayFromZero));
        static async Task<Map> Pdf(Map r, IRandomAccessStream source, byte[] raw, int side, CancellationToken token)
        {
            if (!FolderProject.IsPdf(raw)) throw FolderFormat.Invalid("PDF input");
            var document = await PdfDocument.LoadFromStreamAsync(source).AsTask(token).ConfigureAwait(false);
            if (document.PageCount < 1 || document.PageCount > 100000) throw FolderFormat.Invalid("PDF page count");
            if (FolderFormat.Text(r, "op") == "pdfInfo") return new Map { ["pages"] = (int)document.PageCount };
            var index = (int)FolderFormat.Number(FolderFormat.Get(r, "page"), document.PageCount);
            if (index < 1 || !(FolderFormat.Get(r, "region") is List<object> region) || region.Count != 4) throw FolderFormat.Invalid("PDF page or region");
            var uv = region.Select(v => FolderFormat.Number(v, 1000000) / 1000000.0).ToArray();
            if (uv[0] >= uv[2] || uv[1] >= uv[3]) throw FolderFormat.Invalid("PDF region");
            using (var page = document.GetPage((uint)(index - 1)))
            using (var output = new InMemoryRandomAccessStream())
            {
                // PdfPage.Size is the displayed CropBox/MediaBox with rotation in 96-DPI units.
                var size = page.Size; double pw = size.Width * 0.75, ph = size.Height * 0.75;
                if (!(pw > 0 && pw <= 1e7 && ph > 0 && ph <= 1e7)) throw FolderFormat.Invalid("PDF page dimensions");
                double rw = pw * (uv[2] - uv[0]), rh = ph * (uv[3] - uv[1]);
                double scale = Math.Min(32, Math.Min(side / Math.Max(rw, rh), Math.Sqrt(MaxPixels / (rw * rh))));
                int w = Pixels(rw * scale), h = Pixels(rh * scale);
                if ((long)w * h > MaxPixels) throw FolderFormat.Invalid("PDF output dimensions");
                var options = new PdfPageRenderOptions
                {
                    DestinationWidth = (uint)w,
                    DestinationHeight = (uint)h,
                    SourceRect = new global::Windows.Foundation.Rect(size.Width * uv[0], size.Height * uv[1], size.Width * (uv[2] - uv[0]), size.Height * (uv[3] - uv[1])),
                    BitmapEncoderId = BitmapEncoder.PngEncoderId,
                    BackgroundColor = global::Windows.UI.Colors.White,
                    IsIgnoringHighContrast = true
                };
                await page.RenderToStreamAsync(output, options).AsTask(token).ConfigureAwait(false);
                if (output.Size < 1 || output.Size > NotebookInput.MaxBytes) throw FolderFormat.Invalid("PDF image size");
                using (var reader = new DataReader(output.GetInputStreamAt(0)))
                {
                    uint length = (uint)output.Size;
                    if (await reader.LoadAsync(length).AsTask(token).ConfigureAwait(false) != length) throw FolderFormat.Invalid("short PDF image");
                    var png = new byte[length]; reader.ReadBytes(png);
                    return new Map { ["width"] = w, ["height"] = h, ["physical"] = new[] { pw, ph }, ["png"] = Convert.ToBase64String(png) };
                }
            }
        }
    }
}
