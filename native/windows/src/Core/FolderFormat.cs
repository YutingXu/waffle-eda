// The shared WAFFLE-TXN 1 wire format. All lengths and offsets are physical bytes.
using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Security.Cryptography;
using System.Text;
using System.Text.RegularExpressions;

namespace Waffle.Windows
{
    using Map = Dictionary<string, object>;

    internal static class FolderFormat
    {
        internal const int MaxEntries = 8192, MaxDescriptor = 4 * 1024 * 1024;
        internal const long MaxFile = Policy.ProjectReadCap, MaxTotal = 2 * MaxFile;
        internal static readonly UTF8Encoding Utf8 = new UTF8Encoding(false, true);
        static readonly Regex Device = new Regex(@"^(CON|PRN|AUX|NUL|CLOCK\$|CONIN\$|CONOUT\$|(?:COM|LPT)[1-9¹²³])(?:\.|$)", RegexOptions.IgnoreCase | RegexOptions.CultureInvariant);
        static readonly Regex Hash = new Regex("^[0-9a-f]{64}\\z", RegexOptions.CultureInvariant);
        static readonly Regex Model = new Regex(@"^models/[0-9a-f]{64}\.[a-z0-9]{1,16}\.gz\z");
        static readonly string[] DocumentFileSuffixes = { ".wsch", ".wpcb", ".wdraw", ".wpanel", ".wlib" };
        internal static HostError Invalid(string detail) => new HostError("Invalid folder project " + detail + ".");
        internal static object Get(Map map, string key) => map.TryGetValue(key, out var value) ? value : null;
        internal static string Text(Map map, string key) => Get(map, key) as string;
        internal static bool IsDigest(string value) => value != null && Hash.IsMatch(value);
        internal static string Hex(byte[] bytes) => BitConverter.ToString(bytes).Replace("-", "").ToLowerInvariant();
        internal static string Sha(byte[] bytes) => Hex(Digest.Of(bytes));
        internal static long Number(object value, long maximum)
        {
            if (!(value is double || value is int || value is long)) throw Invalid("length or offset");
            var n = Convert.ToDouble(value);
            if (n < 0 || n > maximum || n != Math.Floor(n)) throw Invalid("length or offset");
            return (long)n;
        }
        internal static string Id(string s)
        {
            if (string.IsNullOrWhiteSpace(s) || s.Length > 256 || s.Any(char.IsControl)) throw Invalid("identity");
            Utf8.GetByteCount(s);
            return s;
        }
        internal static string PathName(string path)
        {
            if (string.IsNullOrEmpty(path) || path.Length > 4096 || !path.IsNormalized(NormalizationForm.FormC)) throw Invalid("path");
            string[] parts = path.Split('/');
            for (int i = 0; i < parts.Length; i++)
            {
                string part = parts[i];
                if (part.Length == 0 || Utf8.GetByteCount(part) > 255 || part.EndsWith(".", StringComparison.Ordinal) ||
                    part.EndsWith(" ", StringComparison.Ordinal) || part.Any(c => char.IsControl(c) || "<>:\"\\|?*".IndexOf(c) >= 0) ||
                    Device.IsMatch(part.Split('.')[0].TrimEnd(' '))) throw Invalid("path");
                if (i < parts.Length - 1 && DocumentFileSuffixes.Any(s => part.EndsWith(s, StringComparison.OrdinalIgnoreCase)))
                    throw Invalid("document filename used as a directory");
            }
            return path;
        }
        internal static bool IsAsset(string path) => path.StartsWith("assets/", StringComparison.Ordinal) && IsDigest(path.Substring(7));
        internal static string ImmutableDigest(string path)
        {
            if (IsAsset(path)) return path.Substring(7);
            var parts = path.Split('/');
            return parts.Length == 4 && parts[0] == ".waffle" && parts[1] == "imports" && IsDigest(parts[2]) && parts[3] == "source" ? parts[2] : null;
        }
        internal static string MemberKind(string path)
        {
            switch (Path.GetExtension(path))
            {
                case ".wsch": return "schematic";
                case ".wpcb": return "pcb";
                case ".wdraw": return "drawing";
                case ".wpanel": return "panel";
                case ".wlib": return "library";
                case ".wblock": return "block";
                default: return null;
            }
        }
        internal static string StandaloneKind(string filename) =>
            filename != null && DocumentFileSuffixes.Any(s => filename.EndsWith(s, StringComparison.OrdinalIgnoreCase))
                ? MemberKind(filename.ToLowerInvariant()) : null;
        internal static bool Authored(string path, string manifest)
        {
            PathName(path);
            if (path == manifest || path == ".waffle/.gitignore" || IsAsset(path) || Model.IsMatch(path)) return true;
            var parts = path.Split('/');
            if (parts[0].Equals("assets", StringComparison.OrdinalIgnoreCase) || parts[0].Equals("models", StringComparison.OrdinalIgnoreCase)) return false;
            if (parts[0] == ".waffle")
                return parts.Length >= 4 && parts[1] == "imports" && IsDigest(parts[2]) && parts.Skip(3).All(p => !p.StartsWith(".", StringComparison.Ordinal));
            if (parts.Any(p => p.StartsWith(".", StringComparison.Ordinal))) return false;
            switch (Path.GetExtension(path).ToLowerInvariant())
            {
                case ".wlib": case ".wblock": return parts.Length > 1 && parts[0] == "libraries";
                case ".wsch": case ".wpcb": case ".wpanel": case ".wdraw": return true;
                default: return false;
            }
        }
        internal static Map Header(Stream stream)
        {
            using (var line = new MemoryStream())
            {
                for (int c; line.Length < 65536 && (c = stream.ReadByte()) >= 0;)
                {
                    if (c != 10) { line.WriteByte((byte)c); continue; }
                    try { return Json.ParseHeader(Utf8.GetString(line.ToArray())) as Map; }
                    catch (Exception e) when (e is JsonException || e is DecoderFallbackException) { return null; }
                }
                return null;
            }
        }
        internal static int Minor(Map header)
        {
            string version = header == null ? null : Text(header, "formatVersion");
            if (version == "2.0") return 0;
            if (version == null || !Regex.IsMatch(version, @"^2\.[1-9][0-9]{0,3}\z")) return -1;
            return int.Parse(version.Substring(2), System.Globalization.CultureInfo.InvariantCulture);
        }
        internal static bool FuturePath(string path, string kind)
        {
            if (string.IsNullOrEmpty(kind) || new[] { "project", "schematic", "pcb", "drawing", "panel", "library", "block", "snapshot", "import-index" }.Contains(kind)) return false;
            var parts = PathName(path).Split('/');
            if (parts.Any(p => p.StartsWith(".", StringComparison.Ordinal)) ||
                new[] { "assets", "models", "libraries" }.Contains(parts[0], StringComparer.OrdinalIgnoreCase)) return false;
            return MemberKind(path) == null && !path.EndsWith(".waffle", StringComparison.OrdinalIgnoreCase) &&
                Regex.IsMatch(Path.GetExtension(path), @"^\.w[a-z][a-z0-9-]{0,30}\z");
        }
        internal static bool IsVersion2(Map header) => Minor(header) >= 0;
        internal static bool IsManifest(Map header) => IsVersion2(header) && Text(header, "kind") == "project" && !string.IsNullOrEmpty(Text(header, "id"));
        internal static IEnumerable<Map> Records(byte[] bytes)
        {
            using (var reader = new StringReader(Utf8.GetString(bytes)))
            {
                string line;
                while ((line = reader.ReadLine()) != null)
                {
                    if (!(Json.ParseStrict(line) is Map record)) throw Invalid("record");
                    yield return record;
                }
            }
        }
        internal static IEnumerable<Map> Members(byte[] manifest)
        {
            foreach (var r in Records(manifest))
                if (new[] { "document", "library", "layoutBlock", "importIndex" }.Contains(Text(r, "kind"))) yield return r;
        }
        internal sealed class Entry
        {
            internal string Path, Expected, Desired;
            internal long Length;
            internal Map Wire() => new Map
            {
                ["desired"] = Desired == null ? null : new Map { ["length"] = Length, ["sha256"] = Desired },
                ["expected"] = Expected,
                ["path"] = Path
            };
        }
        internal sealed class Descriptor
        {
            internal string ProjectId, Transaction;
            internal List<Entry> Plan = new List<Entry>();
            internal byte[] Encode()
            {
                var wire = new Map { ["plan"] = Plan.Select(e => e.Wire()).ToList(), ["projectId"] = ProjectId, ["transaction"] = Transaction };
                // Descriptor strings are valid NFC paths or IDs without controls. JSON leaves all printable Unicode literal.
                var payload = Utf8.GetBytes(Json.Canonical(wire) + "\n");
                var prefix = Encoding.ASCII.GetBytes("WAFFLE-TXN 1\n" + Sha(payload) + "\n");
                var output = new byte[prefix.Length + payload.Length];
                Buffer.BlockCopy(prefix, 0, output, 0, prefix.Length);
                Buffer.BlockCopy(payload, 0, output, prefix.Length, payload.Length);
                return output;
            }
            internal static Descriptor Decode(byte[] bytes, string manifest)
            {
                const int prefix = 78;
                if (bytes.Length <= prefix || bytes.Length > MaxDescriptor || bytes[bytes.Length - 1] != 10) throw Invalid("journal");
                var header = Encoding.ASCII.GetString(bytes, 0, prefix);
                if (!header.StartsWith("WAFFLE-TXN 1\n", StringComparison.Ordinal) || header[prefix - 1] != '\n') throw Invalid("journal version");
                var payload = new byte[bytes.Length - prefix]; Buffer.BlockCopy(bytes, prefix, payload, 0, payload.Length);
                if (Sha(payload) != header.Substring(13, 64) || !(Json.Parse(Utf8.GetString(payload)) is Map obj)) throw Invalid("journal checksum");
                var descriptor = new Descriptor { ProjectId = Id(Text(obj, "projectId")), Transaction = Text(obj, "transaction") };
                if (!Guid.TryParseExact(descriptor.Transaction, "D", out var guid) || guid.ToString("D") != descriptor.Transaction ||
                    !(Get(obj, "plan") is List<object> list) || list.Count < 1 || list.Count > MaxEntries) throw Invalid("journal plan");
                foreach (var item in list)
                {
                    if (!(item is Map e)) throw Invalid("journal entry");
                    var p = new Entry { Path = Text(e, "path"), Expected = Text(e, "expected") };
                    if (!Authored(p.Path, manifest) || (Get(e, "expected") != null && !IsDigest(p.Expected))) throw Invalid("journal entry");
                    if (Get(e, "desired") is Map desired)
                    {
                        p.Desired = Text(desired, "sha256"); p.Length = Number(Get(desired, "length"), MaxFile);
                        if (!IsDigest(p.Desired)) throw Invalid("journal payload");
                    }
                    else if (p.Expected == null || Get(e, "desired") != null) throw Invalid("journal deletion");
                    if (ImmutableDigest(p.Path) is string pinned && p.Desired != pinned) throw Invalid("immutable asset");
                    descriptor.Plan.Add(p);
                }
                descriptor.CheckNames(manifest);
                if (!Digest.Same(bytes, descriptor.Encode())) throw Invalid("noncanonical journal");
                return descriptor;
            }
            internal void CheckNames(string manifest)
            {
                var names = new Dictionary<string, Entry>(StringComparer.OrdinalIgnoreCase);
                for (int i = 0; i < Plan.Count; i++)
                {
                    var entry = Plan[i];
                    if (entry.Path == manifest && i != Plan.Count - 1) throw Invalid("manifest order");
                    if (names.TryGetValue(entry.Path, out var previous) && !(previous.Path != entry.Path && previous.Desired == null && entry.Expected == null && entry.Desired != null))
                        throw Invalid("duplicate target");
                    names[entry.Path] = entry;
                }
                foreach (string path in names.Keys)
                    for (int i = path.IndexOf('/'); i >= 0; i = path.IndexOf('/', i + 1))
                        if (names.ContainsKey(path.Substring(0, i))) throw Invalid("target used as a directory");
            }
        }
    }
}
