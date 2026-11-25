// A newer additive minor can be edited only when its physical unknown content survives.
// The common field and record policy is exercised against folder-transaction/additive.json.
using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Text.RegularExpressions;

namespace Waffle.Windows
{
    using Map = Dictionary<string, object>;
    using Entry = FolderFormat.Entry;
    using Descriptor = FolderFormat.Descriptor;

    internal static class FolderAdditive
    {
        internal const string TableFeature = "notebook.table.v1";
        static HashSet<string> Names(string words) => new HashSet<string>(words.Split(' '), StringComparer.Ordinal);
        internal static readonly HashSet<string> ScalarFields = Names("order text name label ref value x y z w h width height size length radius diameter thickness rotation angle sweep layer hidden locked");
        internal static readonly HashSet<string> CoordinateFields = Names("at start end points");
        const string Items = "part wire track graphic label netlabel junction via pad polygon power port offsheet sheetsymbol bus busentry noerc textframe image frame richtext math calculation widget imageMarkup notesLayer sticky callout reviewItem inkStroke";
        internal static readonly HashSet<string> DocumentRows = Names(Items + " documentSettings panelCell drawingView drawingDimension boardBody modelAlias layer copperRegion");
        internal static readonly HashSet<string> LibraryRows = Names("librarySettings pin pad shape boardBody modelAlias");
        internal static readonly HashSet<string> BlockRows = Names(Items + " blockSettings blockLibrary");
        static readonly HashSet<string> BaselineProjectRows = Names("document library layoutBlock importIndex release projectSetting rule signal tag variant bomView outputJob reviewThread reviewReply");
        static readonly HashSet<string> ProjectEnvelope = Names("kind id order value");
        static readonly Regex ProjectRecordId = new Regex(@"^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\z");
        static readonly Dictionary<string, string> OptionalProjectFields = new Dictionary<string, string>(StringComparer.Ordinal)
        {
            ["savedQuery"] = "name query languageVersion source bindings scope columns documentId instanceId span target docId itemId signalId entityId pinId definitionId parameterId projectId field kind detached needsRebind",
            ["link"] = "source target objectId documentId kind projectId fragment label",
            ["linkAnchor"] = "kind documentId ownerId terminal terminalId",
            ["savedView"] = "name documentId camera center scale referenceScale flipped rotationRadians viewport pixelWidth pixelHeight selection layers hidden active mode filter scope savedQueryId mask highlight netHighlight languageVersion source bindings span target docId itemId instanceId signalId entityId pinId definitionId parameterId projectId field kind detached needsRebind $number",
            ["slide"] = "name aspect notes source kind documentId frameId savedViewId",
            ["datasheetRef"] = "sha256 byteLength title version sourceURL pageCount asset mediaType",
            ["datasheetAnnotation"] = "datasheetId page region type text points",
        };

        internal static HostError Refused() => new HostError("This change requires a newer Waffle writer. The folder is read-only for this operation.");

        internal static bool TableProfile(Map header)
        {
            if (header == null || FolderFormat.Text(header, "formatVersion") != "2.1" || header.ContainsKey("compatibleWith"))
                return false;
            string kind = FolderFormat.Text(header, "kind");
            return (kind == "project" || kind == "schematic") &&
                (!header.ContainsKey("tableBaseVersion") || kind == "project" && FolderFormat.Text(header, "tableBaseVersion") == "2.1") &&
                FolderFormat.Get(header, "requires") is List<object> flags && flags.Count == 1 && Equals(flags[0], TableFeature) &&
                (!header.TryGetValue("readerRequires", out var minimum) ||
                    minimum is Map versions && versions.Count == 1 && FolderFormat.Text(versions, TableFeature) == "2.1");
        }

        internal static bool RegularVersion(Map header) => FolderFormat.Minor(header) == 0 || TableProfile(header);

        static bool SameTokens(Dictionary<string,string> left, Dictionary<string,string> right) =>
            left.Count == right.Count && left.All(pair => right.TryGetValue(pair.Key, out var token) && Equals(pair.Value, token));

        static bool HasOptionalRows(byte[] bytes, string project)
        {
            int boundary = bytes == null ? -1 : Array.IndexOf(bytes, (byte)10);
            if (boundary <= 0 || bytes[bytes.Length - 1] != 10) throw Refused();
            return Records(bytes, boundary + 1, project).Any(row => OptionalProjectFields.ContainsKey(row.Kind));
        }

        static Record ProjectHeader(byte[] bytes, string project, string path, out int boundary)
        {
            if (bytes == null || (boundary = Array.IndexOf(bytes, (byte)10)) <= 0 || bytes[bytes.Length-1] != 10) throw Refused();
            var row = new Record(FolderFormat.Utf8.GetString(bytes,0,boundary));
            if (row.Kind != "project" || row.Id != project) throw Refused();
            RequireWritable(row.Values,path);
            return row;
        }

        internal static void VerifyProjectWrite(byte[] original, byte[] desired, string project, string path)
        {
            var next = ProjectHeader(desired,project,path,out int to);
            var prior = original == null ? null : ProjectHeader(original,project,path,out _);
            int before = prior == null ? -1 : FolderFormat.Minor(prior.Values), after = FolderFormat.Minor(next.Values);
            if (after > 1) throw Refused();
            bool oldTable = TableProfile(prior?.Values), newTable = TableProfile(next.Values);
            if (!oldTable && !newTable)
            {
                if (after == 1) PreserveOptionalProject(original,desired,project,path);
                else if (before > 0) throw Refused();
            }
            else if (oldTable && newTable)
            {
                if (FolderFormat.Text(prior.Values,"tableBaseVersion") != FolderFormat.Text(next.Values,"tableBaseVersion")) throw Refused();
            }
            else if (before == 1 && after == 1)
            {
                var table = newTable ? next : prior;
                var plain = newTable ? prior : next;
                if (plain.Values.ContainsKey("compatibleWith") ||
                    FolderFormat.Text(table.Values,"tableBaseVersion") != "2.1" && (newTable || !HasOptionalRows(original,project)))
                    throw Refused();
                var x = prior.Tokens(); var y = next.Tokens();
                foreach (var key in new[] { "tableBaseVersion","requires","readerRequires" }) { x.Remove(key); y.Remove(key); }
                if (!SameTokens(x,y)) throw Refused();
                int boundary = Array.IndexOf(original,(byte)10);
                using (var left = Records(original,boundary+1,project).GetEnumerator())
                using (var right = Records(desired,to+1,project).GetEnumerator())
                {
                    bool changed = false;
                    while (left.MoveNext())
                    {
                        if (!right.MoveNext()) throw Refused();
                        if (left.Current.Line == right.Current.Line) continue;
                        var p = newTable ? left.Current : right.Current;
                        var t = newTable ? right.Current : left.Current;
                        if (p.Id != t.Id || p.Kind != "document" || t.Kind != "document" ||
                            FolderFormat.Text(p.Values,"docKind") != "schematic" ||
                            p.Values.TryGetValue("requires", out var oldFlags) && (!(oldFlags is List<object> oldList) || oldList.Count != 0) ||
                            !(FolderFormat.Get(t.Values,"requires") is List<object> flags) || flags.Count != 1 || !Equals(flags[0],TableFeature))
                            throw Refused();
                        x = p.Tokens(); y = t.Tokens(); x.Remove("requires"); y.Remove("requires");
                        if (!SameTokens(x,y)) throw Refused();
                        changed = true;
                    }
                    if (!changed || right.MoveNext()) throw Refused();
                }
            }
            else if (newTable)
            {
                if (before > 0 || next.Values.ContainsKey("tableBaseVersion")) throw Refused();
            }
            else if (after != 0 || prior.Values.ContainsKey("tableBaseVersion") || HasOptionalRows(original,project)) throw Refused();
        }

        internal static void RequireWritable(Map header, string path, bool exactNativeCopy = false)
        {
            if (FolderFormat.Minor(header) < 0) throw Refused();
            if (header.ContainsKey("tableBaseVersion") && !TableProfile(header)) throw Refused();
            var required = new List<string>();
            if (header.TryGetValue("requires", out var raw))
            {
                if (!(raw is List<object> tokens) || tokens.Any(token => !(token is string name) || name.Length == 0))
                    throw new HostError("Invalid required feature list. (" + path + ")");
                required = tokens.Cast<string>().ToList();
            }
            var names = new HashSet<string>(required, StringComparer.Ordinal);
            if (names.Count != required.Count) throw new HostError("Invalid required feature list. (" + path + ")");
            Map minima = null;
            if (header.TryGetValue("readerRequires", out var rawMinima))
            {
                minima = rawMinima as Map;
                if (minima == null || minima.Any(pair => !names.Contains(pair.Key) || !(pair.Value is string version) ||
                    !Regex.IsMatch(version, @"\A(?:0|[1-9][0-9]{0,3})\.(?:0|[1-9][0-9]{0,3})\z")))
                    throw new HostError("Invalid required reader versions. (" + path + ")");
            }
            string token = exactNativeCopy ? required.FirstOrDefault(name => name == "continuation-parts-v1") :
                TableProfile(header) ? null : required.FirstOrDefault();
            if (token != null)
            {
                string minimum = minima == null ? null : FolderFormat.Text(minima, token);
                string explanation = minimum == null ? "The file declares native format " + FolderFormat.Text(header, "formatVersion") + "." :
                    "A reader supporting native format " + minimum + " is required.";
                throw new HostError("Unsupported required feature " + token + ". " + explanation + " (" + path + ")");
            }
        }

        static bool Integer(object value) => value is double n && Math.Floor(n) == n && Math.Abs(n) <= 9007199254740991d;
        static bool Vector(object value) =>
            value is List<object> coordinates && coordinates.Count >= 2 && coordinates.Count <= 3 && coordinates.All(Integer);
        static bool Mutable(string key, object value)
        {
            if (ScalarFields.Contains(key)) return value == null || value is string || value is bool || Integer(value);
            return CoordinateFields.Contains(key) && (Vector(value) || value is List<object> vertices && vertices.All(Vector));
        }

        sealed class Record
        {
            internal readonly string Line, Id, Kind;
            internal readonly Map Values;
            internal Record(string line)
            {
                Line = line;
                Values = Json.ParseStrict(line) as Map ?? throw Refused();
                Id = FolderFormat.Text(Values, "id"); Kind = FolderFormat.Text(Values, "kind");
                if (string.IsNullOrEmpty(Id) || string.IsNullOrEmpty(Kind)) throw Refused();
            }
            internal Dictionary<string, string> Tokens()
            {
                var tokens = new Dictionary<string, string>(StringComparer.Ordinal);
                Json.ParseStrict(Line, tokens); return tokens;
            }
        }

        // UTF-8 lexicographic order matches Unicode scalar ordering, including supplementary IDs.
        static int CompareId(string left, string right)
        {
            var a = FolderFormat.Utf8.GetBytes(left); var b = FolderFormat.Utf8.GetBytes(right);
            for (int i = 0; i < Math.Min(a.Length, b.Length); i++) if (a[i] != b[i]) return a[i] - b[i];
            return a.Length.CompareTo(b.Length);
        }
        static IEnumerable<Record> Records(byte[] bytes, int start, string owner)
        {
            string prior = null;
            for (int i = start; i < bytes.Length;)
            {
                int end = Array.IndexOf(bytes, (byte)10, i);
                if (end < 0) throw Refused();
                var record = new Record(FolderFormat.Utf8.GetString(bytes, i, end - i));
                if (record.Id == owner || prior != null && CompareId(prior, record.Id) >= 0) throw Refused();
                yield return record;
                prior = record.Id; i = end + 1;
            }
        }
        static void ChangedRow(Record before, Record after, HashSet<string> allowed)
        {
            if (before != null && after != null && before.Line == after.Line) return;
            if (!allowed.Contains((before ?? after).Kind) || before != null && after != null && before.Kind != after.Kind) throw Refused();
            var a = before?.Tokens() ?? new Dictionary<string, string>();
            var b = after?.Tokens() ?? new Dictionary<string, string>();
            foreach (string key in a.Keys.Union(b.Keys, StringComparer.Ordinal))
            {
                if (key == "kind" || key == "id") continue;
                bool existed = a.TryGetValue(key, out var oldToken), remains = b.TryGetValue(key, out var newToken);
                if (existed && remains && oldToken == newToken) continue;
                if (existed && !Mutable(key, before.Values[key]) || remains && !Mutable(key, after.Values[key])) throw Refused();
            }
        }
        static bool AllowedProjectValue(object value, HashSet<string> keys)
        {
            if (value is Map fields) return fields.All(entry => keys.Contains(entry.Key) && AllowedProjectValue(entry.Value, keys));
            return !(value is List<object> list) || list.All(item => AllowedProjectValue(item, keys));
        }
        static bool KnownProjectRow(Record row)
        {
            if (!OptionalProjectFields.TryGetValue(row.Kind, out string fields)) return false;
            if (!ProjectRecordId.IsMatch(row.Id) || !row.Values.Keys.All(ProjectEnvelope.Contains) ||
                !(FolderFormat.Get(row.Values, "value") is Map value) ||
                value.ContainsKey("id") && FolderFormat.Text(value, "id") != row.Id ||
                !AllowedProjectValue(value, Names("id " + fields))) throw Refused();
            return true;
        }
        internal static void PreserveOptionalProject(byte[] original, byte[] desired, string project, string path)
        {
            Record Header(byte[] bytes, out int boundary)
            {
                if (bytes == null || (boundary = Array.IndexOf(bytes, (byte)10)) <= 0 || bytes[bytes.Length - 1] != 10) throw Refused();
                var record = new Record(FolderFormat.Utf8.GetString(bytes, 0, boundary));
                if (record.Kind != "project" || record.Id != project) throw Refused();
                RequireWritable(record.Values, path);
                return record;
            }
            var next = Header(desired, out int nextBoundary);
            if (FolderFormat.Minor(next.Values) != 1) throw Refused();
            if (original != null && original.SequenceEqual(desired)) return;
            int oldBoundary = -1;
            if (original != null)
            {
                var prior = Header(original, out oldBoundary);
                int minor = FolderFormat.Minor(prior.Values);
                if (minor > 1) throw Refused();
                if (prior.Line != next.Line)
                {
                    var a = prior.Tokens(); a.Remove("formatVersion");
                    var b = next.Tokens(); b.Remove("formatVersion");
                    if (minor != 0 || a.Count != b.Count || a.Any(pair => !b.TryGetValue(pair.Key, out var token) || pair.Value != token)) throw Refused();
                }
            }
            using (var oldRows = (original == null ? Enumerable.Empty<Record>() : Records(original, oldBoundary + 1, project)).GetEnumerator())
            using (var nextRows = Records(desired, nextBoundary + 1, project).GetEnumerator())
            {
                bool oldRow = oldRows.MoveNext(), newRow = nextRows.MoveNext(), changed = false;
                while (oldRow || newRow)
                {
                    int order = !oldRow ? 1 : !newRow ? -1 : CompareId(oldRows.Current.Id, nextRows.Current.Id);
                    var left = order <= 0 ? oldRows.Current : null;
                    var right = order >= 0 ? nextRows.Current : null;
                    if (left?.Line != right?.Line && !(original == null && BaselineProjectRows.Contains(right.Kind)))
                    {
                        if (left != null && !KnownProjectRow(left) || right != null && !KnownProjectRow(right) ||
                            left != null && right != null && left.Kind != right.Kind) throw Refused();
                        changed = true;
                    }
                    if (order <= 0) oldRow = oldRows.MoveNext();
                    if (order >= 0) newRow = nextRows.MoveNext();
                }
                if (!changed) throw Refused();
            }
        }
        internal static void Preserve(byte[] original, byte[] desired, string ownerId, string ownerKind, int minor, string projectId)
        {
            int boundary = Array.IndexOf(original, (byte)10);
            if (boundary <= 0 || Array.IndexOf(desired, (byte)10) != boundary) throw Refused();
            for (int i = 0; i < boundary; i++) if (original[i] != desired[i]) throw Refused();
            Map header;
            using (var stream = new MemoryStream(original, false)) header = FolderFormat.Header(stream);
            if (FolderFormat.Minor(header) < 0 || FolderFormat.Minor(header) > minor || FolderFormat.Text(header, "kind") != ownerKind ||
                FolderFormat.Text(header, "id") != ownerId || (header.ContainsKey("projectId") && FolderFormat.Text(header, "projectId") != projectId))
                throw Refused();

            HashSet<string> allowed = ownerKind == "library" ? LibraryRows : ownerKind == "block" ? BlockRows : DocumentRows;
            using (var oldRows = Records(original, boundary + 1, ownerId).GetEnumerator())
            using (var newRows = Records(desired, boundary + 1, ownerId).GetEnumerator())
            {
                bool oldRow = oldRows.MoveNext(), newRow = newRows.MoveNext();
                while (oldRow || newRow)
                {
                    int order = !oldRow ? 1 : !newRow ? -1 : CompareId(oldRows.Current.Id, newRows.Current.Id);
                    ChangedRow(order <= 0 ? oldRows.Current : null, order >= 0 ? newRows.Current : null, allowed);
                    if (order <= 0) oldRow = oldRows.MoveNext();
                    if (order >= 0) newRow = newRows.MoveNext();
                }
            }
        }
    }

    internal sealed partial class FolderProject
    {
        sealed class WriteScope
        {
            internal int Minor;
            internal string Hash;
            internal Dictionary<string, string> Members;
        }

        WriteScope Scope(string project)
        {
            using (var stream = disk.Open(Manifest))
            {
                if (stream == null)
                {
                    if (disk.Spelling(Manifest) != null) throw new FolderConflict(Manifest);
                    return new WriteScope();
                }
                var header = FolderFormat.Header(stream);
                if (!FolderFormat.IsManifest(header)) throw FolderAdditive.Refused();
                FolderAdditive.RequireWritable(header, Manifest);
                if (FolderFormat.Text(header, "id") != project) throw new FolderConflict(Manifest);
                stream.Position = 0;
                var bytes = FolderStorage.Bytes(stream, FolderFormat.MaxFile);
                int minor = FolderAdditive.TableProfile(header) ? 0 : FolderFormat.Minor(header);
                return new WriteScope { Minor = minor, Hash = FolderFormat.Sha(bytes), Members = minor > 0 ? Members(bytes) : null };
            }
        }
        void VerifyScope(WriteScope scope)
        {
            if (disk.Hash(Manifest, out _) != scope.Hash) throw new FolderConflict(Manifest);
        }

        // Read only the proposed first line on the common 2.0 whole-file save path.
        // A splice beyond the first line cannot change the required version or flags.
        Map ProposedHeader(Map row, Entry entry, Map current, long headerSize)
        {
            if (row.ContainsKey("text"))
            {
                string text = FolderFormat.Text(row, "text") ?? "";
                int end = text.IndexOf('\n', 0, Math.Min(65537, text.Length));
                return end < 0 ? null : First(FolderFormat.Utf8.GetBytes(text.Substring(0, end + 1)));
            }
            if (row.ContainsKey("data"))
            {
                string data = FolderFormat.Text(row, "data") ?? "";
                // 87,384 base64 characters decode to 65,538 bytes (including a possible LF).
                return First(Convert.FromBase64String(data.Substring(0, Math.Min(87384, data.Length))));
            }
            if (!(FolderFormat.Get(row, "splice") is Map splice) || !(FolderFormat.Get(splice, "edits") is List<object> edits))
                throw FolderFormat.Invalid("splice request");
            if (current != null && edits.All(value => value is Map edit &&
                FolderFormat.Number(FolderFormat.Get(edit, "offset"), FolderFormat.MaxFile) >= headerSize)) return current;
            return First(Desired(row, entry));
        }
        static bool NativeCopyOwner(string path)
        {
            string kind = FolderFormat.MemberKind(path);
            return kind != null && kind != "block";
        }

        void CheckNativeHeader(Map row, Entry entry, bool exactNativeCopy)
        {
            using (var old = disk.Open(entry.Path))
            {
                if (exactNativeCopy && (old == null) != (entry.Expected == null)) throw new FolderConflict(entry.Path);
                var current = old == null ? null : FolderFormat.Header(old);
                if (old != null)
                {
                    FolderAdditive.RequireWritable(current, entry.Path, exactNativeCopy && row.ContainsKey("remove"));
                    if (exactNativeCopy ? FolderFormat.Minor(current) != 0 : !FolderAdditive.RegularVersion(current))
                        throw FolderAdditive.Refused();
                }
                if (row.ContainsKey("remove")) return;
                var next = ProposedHeader(row, entry, current, old?.Position ?? 0);
                FolderAdditive.RequireWritable(next, entry.Path, exactNativeCopy);
                if (exactNativeCopy ? FolderFormat.Minor(next) != 0 : !FolderAdditive.RegularVersion(next))
                    throw FolderAdditive.Refused();
            }
        }
        string AdditiveOwner(WriteScope scope, string path, string expected)
        {
            if (Auxiliary(path) || FolderFormat.MemberKind(path) == null || !FolderFormat.IsDigest(expected) || !scope.Members.TryGetValue(path, out var id))
                throw FolderAdditive.Refused();
            return id;
        }
        void VerifyOwner(WriteScope scope, string project, Entry entry, byte[] original, byte[] proposed)
        {
            string owner = AdditiveOwner(scope, entry.Path, entry.Expected);
            if (original == null || proposed == null) throw FolderAdditive.Refused();
            FolderAdditive.RequireWritable(First(original), entry.Path);
            FolderAdditive.Preserve(original, proposed, owner, FolderFormat.MemberKind(entry.Path), scope.Minor, project);
        }

        // Refuse unsupported changes before creating ignored state, then repeat against the locked base.
        WriteScope CheckWriteCompatibility(string project, List<object> plan, IReadOnlyDictionary<string, string> nativeCopyHashes)
        {
            var scope = Scope(project);
            var projectPdfs = new List<(string Digest, long Length)>();
            byte[] nextRoot = null;
            if (scope.Minor == 1 && plan.OfType<Map>().FirstOrDefault(row => FolderFormat.Text(row,"path") == Manifest) is Map root)
            {
                using (var old = disk.Open(Manifest))
                {
                    var head = old == null ? null : FolderFormat.Header(old);
                    var change = new Entry { Path=Manifest, Expected=FolderFormat.Text(root,"expected") };
                    if (!root.ContainsKey("remove") && FolderAdditive.TableProfile(ProposedHeader(root,change,head,old?.Position ?? 0)))
                    {
                        var bytes = disk.Read(Manifest);
                        if (bytes == null || FolderFormat.Sha(bytes) != change.Expected) throw new FolderConflict(Manifest);
                        FolderAdditive.VerifyProjectWrite(bytes,Desired(root,change,bytes),project,Manifest);
                        scope.Minor = 0;
                    }
                }
            }
            int checkedCopies = 0;
            foreach (var item in plan)
            {
                if (!(item is Map row)) throw FolderFormat.Invalid("entry");
                var entry = new Entry { Path = FolderFormat.Text(row, "path"), Expected = FolderFormat.Text(row, "expected") };
                if (!FolderFormat.Authored(entry.Path, Manifest)) throw FolderAdditive.Refused();
                string witnessedHash = null;
                bool witnessed = nativeCopyHashes != null && nativeCopyHashes.TryGetValue(entry.Path, out witnessedHash);
                bool exactNativeCopy = row.ContainsKey("nativeCopy");
                if (witnessed || exactNativeCopy)
                {
                    bool createCopy = row.TryGetValue("expected", out var expected) && expected == null &&
                        row.ContainsKey("text") != row.ContainsKey("data") && !row.ContainsKey("remove");
                    bool reverseCopy = entry.Expected == witnessedHash && Equals(FolderFormat.Get(row, "remove"), true) &&
                        !row.ContainsKey("text") && !row.ContainsKey("data");
                    if (!witnessed || !(FolderFormat.Get(row, "nativeCopy") is Map marker) ||
                        string.IsNullOrEmpty(FolderFormat.Text(marker, "grant")) || !FolderFormat.IsDigest(witnessedHash) ||
                        FolderFormat.Text(marker, "sha256") != witnessedHash || scope.Minor != 0 || !NativeCopyOwner(entry.Path) ||
                        !(createCopy || reverseCopy) || row.ContainsKey("splice") || row.ContainsKey("assetToken"))
                        throw FolderFormat.Invalid("exact native copy grant");
                    checkedCopies++;
                }
                if (entry.Path == Manifest && scope.Minor <= 1)
                {
                    if (row.ContainsKey("remove") || row.ContainsKey("assetToken")) throw FolderAdditive.Refused();
                    using (var old = disk.Open(Manifest))
                    {
                        var current = old == null ? null : FolderFormat.Header(old);
                        var next = ProposedHeader(row, entry, current, old?.Position ?? 0);
                        if (FolderFormat.Minor(next) == 1 || FolderAdditive.TableProfile(current))
                        {
                            var oldManifest = disk.Read(Manifest);
                            var proposed = Desired(row, entry, oldManifest);
                            FolderAdditive.VerifyProjectWrite(oldManifest, proposed, project, Manifest);
                            if (oldManifest == null || !oldManifest.SequenceEqual(proposed))
                                nextRoot = proposed;
                            continue;
                        }
                        if (scope.Minor != 0) throw FolderAdditive.Refused();
                    }
                }
                if (scope.Minor == 0)
                {
                    if (!Auxiliary(entry.Path) && (entry.Path == Manifest || FolderFormat.MemberKind(entry.Path) != null))
                        CheckNativeHeader(row, entry, exactNativeCopy);
                    continue;
                }
                if (scope.Minor == 1 && entry.Expected == null && entry.Path.StartsWith("assets/", StringComparison.Ordinal) &&
                    FolderFormat.ImmutableDigest(entry.Path) is string digest)
                {
                    if (row.ContainsKey("assetToken"))
                    {
                        var asset = StagedAsset(FolderFormat.Text(row, "assetToken"), entry.Path);
                        if (asset.Owner != project || asset.Type != "application/pdf") throw FolderAdditive.Refused();
                        projectPdfs.Add((asset.Digest, asset.Length));
                    }
                    else
                    {
                        if (!row.ContainsKey("data")) throw FolderAdditive.Refused();
                        var bytes = Desired(row, entry);
                        if (bytes == null || !IsPdf(bytes) ||
                            FolderFormat.Sha(bytes) != digest) throw FolderAdditive.Refused();
                        projectPdfs.Add((digest, bytes.LongLength));
                    }
                    continue;
                }
                AdditiveOwner(scope, entry.Path, entry.Expected);
                if (row.ContainsKey("remove") || row.ContainsKey("assetToken")) throw FolderAdditive.Refused();
                var original = disk.Read(entry.Path);
                if (original == null || FolderFormat.Sha(original) != entry.Expected) throw new FolderConflict(entry.Path);
                VerifyOwner(scope, project, entry, original, Desired(row, entry, original));
            }
            if (checkedCopies != (nativeCopyHashes?.Count ?? 0)) throw FolderFormat.Invalid("exact native copy grant");
            if (projectPdfs.Any(pdf => !ManifestHasPdf(nextRoot, project, pdf.Digest, "application/pdf", pdf.Length)))
                throw FolderAdditive.Refused();
            return scope;
        }

        // The checksummed descriptor carries complete desired bytes and both hashes, so a
        // partial install can be verified without retaining the old working file separately.
        void CheckInstallCompatibility(Descriptor descriptor)
        {
            var scope = Scope(descriptor.ProjectId);
            Dictionary<string, string> finalMembers = null;
            var finalTables = new HashSet<string>(StringComparer.Ordinal);
            byte[] nextRoot = null;
            var manifestEntry = descriptor.Plan.SingleOrDefault(e => e.Path == Manifest);
            if (scope.Minor == 1 && manifestEntry?.Desired != null && manifestEntry.Expected == null && scope.Hash == manifestEntry.Desired)
                scope.Minor = 0; // A just-created root may already be installed when recovery resumes.
            if (manifestEntry != null && scope.Minor <= 1)
            {
                if (manifestEntry.Desired == null) throw FolderAdditive.Refused();
                var next = disk.Read(Payload(descriptor, manifestEntry));
                if (next == null) throw FolderAdditive.Refused();
                var header = First(next);
                var original = disk.Read(Manifest);
                if (FolderFormat.Minor(header) == 1 || original != null && FolderAdditive.TableProfile(First(original)))
                {
                    string hash = original == null ? null : FolderFormat.Sha(original);
                    if (hash != manifestEntry.Expected && hash != manifestEntry.Desired) throw new FolderConflict(Manifest);
                    FolderAdditive.VerifyProjectWrite(original, next, descriptor.ProjectId, Manifest);
                    if (manifestEntry.Expected != manifestEntry.Desired) nextRoot = next;
                    if (FolderAdditive.TableProfile(header)) scope.Minor = 0;
                }
                else if (scope.Minor != 0) throw FolderAdditive.Refused();
            }
            if (scope.Minor == 0)
            {
                if (manifestEntry != null && manifestEntry.Desired == null) throw FolderAdditive.Refused();
                var bytes = disk.Read(manifestEntry == null ? Manifest : Payload(descriptor, manifestEntry));
                if (bytes == null) throw FolderFormat.Invalid("recovery manifest");
                var header = First(bytes);
                if (!FolderFormat.IsManifest(header) || FolderFormat.Minor(header) > 1 ||
                    FolderFormat.Text(header, "id") != descriptor.ProjectId) throw FolderAdditive.Refused();
                FolderAdditive.RequireWritable(header, Manifest);
                finalMembers = Members(bytes, tableOwners: finalTables);
            }
            foreach (var entry in descriptor.Plan)
            {
                if (entry.Path == Manifest && scope.Minor <= 1) continue;
                if (scope.Minor == 0)
                {
                    string kind = FolderFormat.MemberKind(entry.Path);
                    if (kind == null || Auxiliary(entry.Path)) continue;
                    bool declared = finalMembers.TryGetValue(entry.Path, out var id);
                    bool canReplayCopy = manifestEntry != null && NativeCopyOwner(entry.Path);
                    if (entry.Expected != null)
                    {
                        bool exactNativeUndo = canReplayCopy && !declared && entry.Desired == null;
                        using (var old = disk.Open(entry.Path))
                            if (old != null)
                            {
                                var savedHeader = FolderFormat.Header(old);
                                bool copy = exactNativeUndo && !FolderAdditive.TableProfile(savedHeader);
                                if (copy && FolderFormat.Minor(savedHeader) != 0) throw FolderAdditive.Refused();
                                FolderAdditive.RequireWritable(savedHeader, entry.Path, copy);
                            }
                    }
                    if (entry.Desired == null) { if (declared) throw FolderFormat.Invalid("recovery removal"); continue; }
                    using (var staged = disk.Open(Payload(descriptor, entry)))
                    {
                        var header = staged == null ? null : FolderFormat.Header(staged);
                        if (!declared || !FolderAdditive.RegularVersion(header) ||
                            FolderAdditive.TableProfile(header) != finalTables.Contains(entry.Path) ||
                            FolderFormat.Text(header, "kind") != kind || FolderFormat.Text(header, "id") != id) throw FolderAdditive.Refused();
                        // A pinned descriptor already carries the verified complete new owner.
                        bool exactNativeCopy = !finalTables.Contains(entry.Path) && canReplayCopy && entry.Expected == null;
                        FolderAdditive.RequireWritable(header, entry.Path, exactNativeCopy);
                    }
                    continue;
                }
                if (scope.Minor == 1 && entry.Expected == null && entry.Desired != null &&
                    entry.Path == "assets/" + entry.Desired &&
                    ManifestHasPdf(nextRoot, descriptor.ProjectId, entry.Desired, "application/pdf", entry.Length))
                {
                    using (var staged = disk.Open(Payload(descriptor, entry)))
                    {
                        if (staged == null) throw FolderAdditive.Refused();
                        var prefix = new byte[(int)Math.Min(8, entry.Length)];
                        int count = 0;
                        while (count < prefix.Length)
                        {
                            int read = staged.Read(prefix, count, prefix.Length - count);
                            if (read == 0) throw FolderAdditive.Refused();
                            count += read;
                        }
                        if (!IsPdf(prefix)) throw FolderAdditive.Refused();
                    }
                    continue;
                }
                AdditiveOwner(scope, entry.Path, entry.Expected);
                var current = disk.Read(entry.Path);
                string hash = current == null ? null : FolderFormat.Sha(current);
                if (hash != entry.Expected && hash != entry.Desired) throw new FolderConflict(entry.Path);
                if (entry.Desired == null) throw FolderAdditive.Refused();
                VerifyOwner(scope, descriptor.ProjectId, entry, current, disk.Read(Payload(descriptor, entry)));
            }
        }
    }
}
