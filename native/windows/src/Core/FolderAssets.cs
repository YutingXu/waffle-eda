// Attachment selection and staging never give page JavaScript a path to an outside file.
// A staged token owns one held immutable byte stream until the owner is saved or cancels.
using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Security.Cryptography;
using System.Text;

namespace Waffle.Windows
{
    using Map = Dictionary<string, object>;

    internal sealed partial class FolderProject
    {
        internal const int AssetLimit = (int)FolderFormat.MaxFile, ChunkLimit = 1024 * 1024;
        sealed class Asset : IDisposable
        {
            internal string Owner, Digest, Type, Path;
            internal long Length;
            internal Stream Content;
            internal Map Reference => new Map { ["sha256"] = Digest, ["mediaType"] = Type, ["byteLength"] = Length };
            public void Dispose() { Content?.Dispose(); try { File.Delete(Path); } catch (Exception e) when (e is IOException || e is UnauthorizedAccessException) { } }
        }
        readonly Dictionary<string, Asset> assets = new Dictionary<string, Asset>();
        readonly Dictionary<string, Dictionary<string, Asset>> savedMedia = new Dictionary<string, Dictionary<string, Asset>>();
        static readonly Dictionary<string, string[]> media = new Dictionary<string, string[]>
        {
            ["image/png"] = new[] { "png" },
            ["image/jpeg"] = new[] { "jpg", "jpeg" },
            ["image/webp"] = new[] { "webp" },
            ["image/heic"] = new[] { "heic", "heif" },
            ["image/svg+xml"] = new[] { "svg" },
            ["application/pdf"] = new[] { "pdf" }
        };
        internal static IList<string> AssetExtensions(string type) => media.TryGetValue(type ?? "", out var ext) ? ext : throw FolderFormat.Invalid("attachment media type");
        internal static string[] Types => media.Keys.ToArray();
        internal static string MediaOf(Stream selected)
        {
            if (selected.Length <= 0 || selected.Length > AssetLimit) throw FolderFormat.Invalid("attachment size");
            var prefix = new byte[(int)Math.Min(selected.Length, 8192)];
            int read = 0;
            while (read < prefix.Length)
            {
                int n = selected.Read(prefix, read, prefix.Length - read);
                if (n == 0) throw FolderFormat.Invalid("short attachment");
                read += n;
            }
            selected.Position = 0;
            return Types.FirstOrDefault(type => MatchesMedia(type, prefix)) ?? throw FolderFormat.Invalid("attachment media type");
        }
        internal static bool IsPdf(byte[] bytes)
        {
            int at = bytes.Length >= 3 && bytes[0] == 0xef && bytes[1] == 0xbb && bytes[2] == 0xbf ? 3 : 0;
            return bytes.Length >= at + 5 && bytes[at] == '%' && bytes[at + 1] == 'P' &&
                bytes[at + 2] == 'D' && bytes[at + 3] == 'F' && bytes[at + 4] == '-';
        }
        static bool MatchesMedia(string type, byte[] b)
        {
            string ascii = Encoding.ASCII.GetString(b);
            switch (type)
            {
                case "image/png": return b.Take(8).SequenceEqual(new byte[] { 137, 80, 78, 71, 13, 10, 26, 10 });
                case "image/jpeg": return b.Length >= 3 && b[0] == 255 && b[1] == 216 && b[2] == 255;
                case "image/webp": return ascii.StartsWith("RIFF", StringComparison.Ordinal) && ascii.Length >= 12 && ascii.Substring(8, 4) == "WEBP";
                case "image/heic": return ascii.Length >= 12 && ascii.Substring(4, 4) == "ftyp" && new[] { "heic", "heix", "hevc", "hevx", "mif1", "msf1" }.Contains(ascii.Substring(8, 4));
                case "application/pdf": return IsPdf(b);
                case "image/svg+xml": return System.Text.RegularExpressions.Regex.IsMatch(Encoding.UTF8.GetString(b).TrimStart('\uFEFF'), @"^\s*(?:<\?xml[^?]*\?>\s*)?<svg(?:\s|>)", System.Text.RegularExpressions.RegexOptions.CultureInvariant);
                default: return false;
            }
        }
        internal object StageAsset(string owner, string type, Stream selected)
        {
            owner = FolderFormat.Id(owner); AssetExtensions(type);
            lock (gate)
            {
                CheckOpen();
                if (assets.Count >= 32 || selected.Length <= 0 || selected.Length > AssetLimit || assets.Values.Sum(a => a.Length) + selected.Length > FolderFormat.MaxTotal)
                    throw FolderFormat.Invalid("attachment size");
                var a = new Asset { Owner = owner, Type = type, Length = selected.Length, Path = Path.Combine(Path.GetTempPath(), "waffle-asset-" + Guid.NewGuid().ToString("N")) };
                try
                {
                    using (var target = disk.Platform.NewFile(a.Path, true))
                    using (var sha = SHA256.Create())
                    {
                        var b = new byte[65536]; long n = 0; int count;
                        while ((count = selected.Read(b, 0, b.Length)) > 0)
                        {
                            CheckOpen();
                            if (n == 0 && !MatchesMedia(type, b.Take(count).Take(4096).ToArray())) throw FolderFormat.Invalid("attachment media type");
                            n += count; if (n > a.Length) throw FolderFormat.Invalid("attachment size");
                            sha.TransformBlock(b, 0, count, null, 0); target.Write(b, 0, count);
                        }
                        if (n != a.Length) throw FolderFormat.Invalid("short attachment");
                        sha.TransformFinalBlock(Array.Empty<byte>(), 0, 0); a.Digest = FolderFormat.Hex(sha.Hash);
                        target.Flush(true);
                    }
                    a.Content = disk.Platform.OpenRegular(a.Path);
                    var key = Guid.NewGuid().ToString("D"); assets.Add(key, a);
                    return new Map { ["assetToken"] = key, ["assetRef"] = a.Reference, ["ownerId"] = a.Owner };
                }
                catch { a.Dispose(); throw; }
            }
        }
        byte[] DraftKey(string profile, bool create)
        {
            string dir = Path.Combine(profile, "folder-recovery"), path = Path.Combine(dir, "provenance-v1");
            if (create && !File.Exists(path))
            {
                Directory.CreateDirectory(dir);
                string temp = Path.Combine(dir, Guid.NewGuid().ToString("N"));
                try
                {
                    var key = new byte[32];
                    using (var rng = RandomNumberGenerator.Create()) rng.GetBytes(key);
                    using (var f = disk.Platform.NewFile(temp, true)) { f.Write(key, 0, key.Length); f.Flush(true); }
                    try { File.Move(temp, path); }
                    catch (IOException) when (File.Exists(path)) { }
                }
                finally { if (File.Exists(temp)) File.Delete(temp); }
            }
            using (var f = disk.Platform.OpenRegular(path))
            {
                if (f.Length != 32) throw FolderFormat.Invalid("private draft key");
                using (var reader = new BinaryReader(f)) {
                    byte[] key = reader.ReadBytes(32);
                    if (key.Length != 32) throw FolderFormat.Invalid("private draft key");
                    return key;
                }
            }
        }
        internal Map DraftAsset(Map r, bool restore, string profile)
        {
            lock (gate)
            {
                CheckOpen();
                var scope = DraftScope ?? throw FolderFormat.Invalid("private draft root");
                string owner = FolderFormat.Id(FolderFormat.Text(r,"ownerId"));
                var reference = FolderFormat.Get(r,"assetRef") as Map ?? throw FolderFormat.Invalid("private attachment");
                string hash = FolderFormat.Text(reference,"sha256"), mediaType = FolderFormat.Text(reference,"mediaType");
                var size = FolderFormat.Number(FolderFormat.Get(reference,"byteLength"), AssetLimit);
                if (!FolderFormat.IsDigest(hash) || size <= 0) throw FolderFormat.Invalid("private attachment");
                AssetExtensions(mediaType);
                if (!restore)
                {
                    var a = StagedAsset(FolderFormat.Text(r,"assetToken"), "assets/" + hash);
                    if (a.Owner != owner || a.Type != mediaType || a.Length != size) throw FolderFormat.Invalid("private attachment owner");
                }
                string proof;
                using (var hmac = new HMACSHA256(DraftKey(profile, !restore)))
                    proof = FolderFormat.Hex(hmac.ComputeHash(Encoding.UTF8.GetBytes(string.Join("\n", scope, hash,
                        size.ToString(System.Globalization.CultureInfo.InvariantCulture), mediaType, owner))));
                if (!restore) return new Map { ["proof"] = proof };
                string encoded = FolderFormat.Text(r,"data");
                if (FolderFormat.Text(r,"proof") != proof || encoded == null || encoded.Length != (size+2)/3*4) throw FolderFormat.Invalid("private attachment receipt");
                var bytes = Convert.FromBase64String(encoded);
                if (bytes.Length != size || FolderFormat.Sha(bytes) != hash) throw FolderFormat.Invalid("private attachment bytes");
                using (var source = new MemoryStream(bytes, false))
                {
                    if (MediaOf(source) != mediaType) throw FolderFormat.Invalid("private attachment media");
                    return (Map)StageAsset(owner, mediaType, source);
                }
            }
        }
        Asset StagedAsset(string key, string path)
        {
            if (key == null || !assets.TryGetValue(key, out var a) || path != "assets/" + a.Digest) throw FolderFormat.Invalid("attachment token");
            return a;
        }
        static bool HasRef(object node, string hash, string type, long length)
        {
            if (node is Map m)
            {
                if (FolderFormat.Text(m, "sha256") == hash && FolderFormat.Text(m, "mediaType") == type && m.ContainsKey("byteLength") &&
                   FolderFormat.Number(m["byteLength"], FolderFormat.MaxFile) == length) return true;
                return m.Values.Any(v => HasRef(v, hash, type, length));
            }
            return node is List<object> list && list.Any(v => HasRef(v, hash, type, length));
        }
        static bool ManifestHasPdf(byte[] bytes, string owner, string hash, string type, long length)
        {
            if (bytes == null || type != "application/pdf") return false;
            var header = First(bytes) ?? new Map();
            return FolderFormat.Text(header,"kind") == "project" && FolderFormat.Text(header,"id") == owner &&
                FolderFormat.Records(bytes).Any(row => FolderFormat.Text(row,"kind") == "datasheetRef" &&
                    FolderFormat.Get(row,"value") is Map value && FolderFormat.Text(value,"sha256") == hash &&
                    FolderFormat.Get(value,"byteLength") != null && FolderFormat.Number(value["byteLength"],FolderFormat.MaxFile) == length &&
                    FolderFormat.Get(value,"asset") is Map asset && FolderFormat.Text(asset,"sha256") == hash &&
                    FolderFormat.Get(asset,"byteLength") != null && FolderFormat.Number(asset["byteLength"],FolderFormat.MaxFile) == length &&
                    FolderFormat.Text(asset,"mediaType") == type);
        }
        void ValidateAssetOwners(List<object> plan, FolderFormat.Descriptor d, Dictionary<string, byte[]> desired)
        {
            for (int i = 0; i < plan.Count; i++)
            {
                string key = FolderFormat.Text((Map)plan[i], "assetToken"); if (key == null) continue;
                var a = assets[key];
                if (!d.Plan.Skip(i + 1).Where(e => e.Desired != null && desired.ContainsKey(e.Path)).Any(e =>
                    e.Path == Manifest ? ManifestHasPdf(desired[e.Path],a.Owner,a.Digest,a.Type,a.Length) :
                    !Auxiliary(e.Path) && FolderFormat.Text(First(desired[e.Path]) ?? new Map(), "id") == a.Owner &&
                    FolderFormat.Records(desired[e.Path]).Any(r => HasRef(r, a.Digest, a.Type, a.Length))))
                    throw FolderFormat.Invalid("attachment owner in this save");
            }
        }
        void SpendAssets(List<object> plan)
        {
            foreach (var row in plan.Cast<Map>()) { var key = FolderFormat.Text(row, "assetToken"); if (key != null) DropAsset(key); }
        }
        internal bool DropAsset(string key)
        {
            lock (gate) { if (key != null && assets.TryGetValue(key, out var a)) { assets.Remove(key); a.Dispose(); } return true; }
        }
        void ReleaseMedia(string lease)
        {
            if (lease == null || !savedMedia.TryGetValue(lease, out var cache)) return;
            foreach (var item in cache.Values) item.Dispose();
            savedMedia.Remove(lease);
        }
        void CloseAssets()
        {
            foreach (var a in assets.Values) a.Dispose();
            assets.Clear();
            foreach (var lease in savedMedia.Keys.ToArray()) ReleaseMedia(lease);
        }
        static Map Chunk(Stream stream, long offset, int count)
        {
            if (offset > stream.Length) throw FolderFormat.Invalid("attachment offset");
            int n = (int)Math.Min(count, stream.Length - offset); var b = new byte[n]; stream.Position = offset;
            for (int i = 0; i < n;) { int read = stream.Read(b, i, n - i); if (read == 0) throw FolderFormat.Invalid("short attachment"); i += read; }
            return new Map { ["data"] = Convert.ToBase64String(b), ["offset"] = offset, ["length"] = n, ["eof"] = offset + n == stream.Length };
        }
        internal object ReadAsset(Map r)
        {
            lock (gate)
            {
                CheckOpen();
                var owner = FolderFormat.Id(FolderFormat.Text(r, "ownerId"));
                if (!(FolderFormat.Get(r, "assetRef") is Map reference)) throw FolderFormat.Invalid("attachment reference");
                string hash = FolderFormat.Text(reference, "sha256"), type = FolderFormat.Text(reference, "mediaType"); AssetExtensions(type);
                if (!FolderFormat.IsDigest(hash)) throw FolderFormat.Invalid("attachment digest");
                long size = FolderFormat.Number(FolderFormat.Get(reference, "byteLength"), AssetLimit);
                long offset = FolderFormat.Number(FolderFormat.Get(r, "offset") ?? 0, size);
                int count = (int)FolderFormat.Number(FolderFormat.Get(r, "length") ?? ChunkLimit, ChunkLimit);
                string key = FolderFormat.Text(r, "assetToken");
                if (key != null && assets.TryGetValue(key, out var staged) && staged.Owner == owner && staged.Type == type && staged.Digest == hash && staged.Length == size)
                    return Chunk(staged.Content, offset, count);
                string lease = FolderFormat.Text(r, "lease");
                Lease(lease);
                if (!savedMedia.TryGetValue(lease, out var cache)) savedMedia.Add(lease, cache = new Dictionary<string, Asset>());
                string identity = owner + "\n" + type + "\n" + hash + "\n" + size;
                if (cache.TryGetValue(identity, out var cached)) return Chunk(cached.Content, offset, count);
                var manifestBytes = disk.Read(Manifest);
                if (!ManifestHasPdf(manifestBytes,owner,hash,type,size))
                {
                    var path = Members(manifestBytes).FirstOrDefault(p => p.Value == owner).Key;
                    var ownerBytes = path == null ? null : disk.Read(path);
                    if (ownerBytes == null || !FolderFormat.Records(ownerBytes).Any(item => HasRef(item, hash, type, size)))
                        throw FolderFormat.Invalid("attachment owner");
                }
                if (cache.Count >= 16 || cache.Values.Sum(a => a.Length) + size > FolderFormat.MaxTotal)
                {
                    foreach (var item in cache.Values) item.Dispose();
                    cache.Clear();
                }
                var copy = new Asset { Owner = owner, Digest = hash, Type = type, Length = size, Path = Path.Combine(Path.GetTempPath(), "waffle-read-" + Guid.NewGuid().ToString("N")) };
                try
                {
                    using (var f = disk.Open("assets/" + hash))
                    using (var output = disk.Platform.NewFile(copy.Path, true))
                    using (var sha = SHA256.Create())
                    {
                        if (f == null || f.Length != size) throw new HostError("The attached file is missing or changed.");
                        byte[] buffer = new byte[65536]; long length = 0;
                        for (int n; (n = f.Read(buffer, 0, buffer.Length)) > 0;)
                        {
                            CheckOpen(); length += n; if (length > size) throw FolderFormat.Invalid("changed attachment");
                            sha.TransformBlock(buffer, 0, n, null, 0); output.Write(buffer, 0, n);
                        }
                        sha.TransformFinalBlock(Array.Empty<byte>(), 0, 0);
                        if (length != size || FolderFormat.Hex(sha.Hash) != hash) throw new FolderConflict("assets/" + hash);
                    }
                    copy.Content = disk.Platform.OpenRegular(copy.Path);
                    cache.Add(identity, copy);
                    return Chunk(copy.Content, offset, count);
                }
                catch { copy.Dispose(); throw; }
            }
        }
        internal object LocalState(Map r)
        {
            lock (gate)
            {
                CheckOpen();
                var p = ".waffle/local/workspace-v1.json"; const int cap = 1024 * 1024;
                var value = FolderFormat.Get(r, "state") ?? FolderFormat.Get(r, "localState");
                if (value == null)
                {
                    var bytes = disk.Read(p, cap);
                    return bytes == null ? new Map() : Json.Parse(FolderFormat.Utf8.GetString(bytes)) as Map ?? throw FolderFormat.Invalid("local state");
                }
                if (!(value is Map)) throw FolderFormat.Invalid("local state");
                var raw = FolderFormat.Utf8.GetBytes(Json.Write(value));
                if (raw.Length > cap) throw FolderFormat.Invalid("local state size");
                var tmp = ".waffle/local/" + Guid.NewGuid().ToString("N") + ".tmp";
                try
                {
                    disk.WriteTemp(tmp, s => s.Write(raw, 0, raw.Length), true, null, null);
                    var current = disk.Spelling(p); if (current != null) using (var f = disk.Open(p)) if (f == null) throw FolderFormat.Invalid("local state entry");
                    disk.Move(tmp, p, current != null); disk.SyncParent(p);
                }
                finally { disk.Delete(tmp); }
                return value;
            }
        }
    }
}
