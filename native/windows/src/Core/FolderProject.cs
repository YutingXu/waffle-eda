// A durable descriptor owns the whole write set. Its independent payload copies survive
// any partial install. A writer transfers its lock to the background apply after commit.
using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Threading;

namespace Waffle.Windows
{
    using Map = Dictionary<string, object>;
    using Entry = FolderFormat.Entry;
    using Descriptor = FolderFormat.Descriptor;

    internal sealed partial class FolderProject : IDisposable
    {
        readonly FolderStorage disk;
        readonly object gate = new object();
        readonly Dictionary<string, IDisposable> leases = new Dictionary<string, IDisposable>();
        readonly Dictionary<string, Dictionary<string, Stream>> leaseFiles = new Dictionary<string, Dictionary<string, Stream>>();
        readonly Dictionary<string, Dictionary<string, string>> leaseMembership = new Dictionary<string, Dictionary<string, string>>();
        sealed class FutureMember
        {
            internal string Id, Kind;
            internal int ManifestMinor;
            internal bool Opaque;
            internal void Check(Map header)
            {
                var minor = FolderFormat.Minor(header);
                if (minor < (Opaque ? 1 : 0) || minor > ManifestMinor || FolderFormat.Text(header, "id") != Id || FolderFormat.Text(header, "kind") != Kind)
                    throw FolderFormat.Invalid("future member identity or version");
            }
        }
        readonly Dictionary<string, Dictionary<string, FutureMember>> leaseFuture = new Dictionary<string, Dictionary<string, FutureMember>>();
        readonly Dictionary<string, Map> leaseHashes = new Dictionary<string, Map>();
        readonly Action<string> checkpoint;
        volatile string state = "settled";
        string[] conflicts = Array.Empty<string>();
        volatile bool closing, applying;
        readonly string token = Guid.NewGuid().ToString("D");
        string projectId;
        internal string WorkspaceIdentity => projectId;
        internal string Grant => token;
        internal string Root => disk.Root;
        internal string Manifest => disk.Manifest;
        string DraftScope {
            get {
                var identity = (disk.Platform as IFolderDraftIdentity)?.RecoveryIdentity(disk.Root);
                return identity == null ? null : FolderFormat.Sha(System.Text.Encoding.UTF8.GetBytes(identity));
            }
        }
        internal Map Info => new Map { ["grant"] = token, ["manifest"] = Manifest, ["name"] = Path.GetFileName(disk.Root), ["draftScope"] = DraftScope };
        readonly bool standalone;
        internal FolderProject(IFolderPlatform platform, string root, string manifest, Action<string> checkpoint = null, bool standalone = false)
        {
            disk = new FolderStorage(platform, root, manifest, standalone);
            this.standalone = standalone;
            this.checkpoint = checkpoint ?? (_ => { });
        }
        internal static string SelectedManifest(IFolderPlatform platform, string root)
        {
            // A first save can be committed before the working manifest exists. Recover its bound
            // root-level basename only from a canonical, checksummed descriptor under the reader lock.
            using (var probe = new FolderStorage(platform, root, "Untitled.waffle"))
            using (var reader = probe.Barrier(false))
            {
                var namesOnDisk = Directory.EnumerateFiles(root).Select(Path.GetFileName).Where(name =>
                    !name.StartsWith(".", StringComparison.Ordinal) && name.EndsWith(".waffle", StringComparison.OrdinalIgnoreCase)).Take(65).ToList();
                if (namesOnDisk.Count == 1) return namesOnDisk[0];
                if (namesOnDisk.Count > 1)
                {
                    const string chooseManifest = "Choose the project manifest in this folder.";
                    if (namesOnDisk.Count > 64) throw new HostError(chooseManifest);
                    string selected = null;
                    foreach (var name in namesOnDisk)
                    {
                        using (var file = probe.Open(name))
                        {
                            if (file == null || !FolderFormat.IsManifest(FolderFormat.Header(file))) continue;
                            if (selected != null) throw new HostError(chooseManifest);
                            selected = name;
                        }
                    }
                    return selected ?? throw new HostError(chooseManifest);
                }
                var raw = probe.Read(probe.Active, FolderFormat.MaxDescriptor);
                if (raw != null && raw.Length > 78 && Json.Parse(FolderFormat.Utf8.GetString(raw, 78, raw.Length - 78)) is Map obj &&
                    FolderFormat.Get(obj, "plan") is List<object> list)
                {
                    var names = list.OfType<Map>().Select(r => FolderFormat.Text(r, "path")).Where(p => p != null && !p.Contains("/") &&
                        p.EndsWith(".waffle", StringComparison.OrdinalIgnoreCase)).Take(2).ToArray();
                    if (names.Length == 1 && Descriptor.Decode(raw, names[0]).Plan.Any(e => e.Path == names[0] && e.Desired != null)) return names[0];
                }
                throw new HostError("Select a folder containing one Waffle project manifest.");
            }
        }
        internal bool Detect()
        {
            using (var f = disk.Open(Manifest))
            {
                if (f == null) return false;
                var h = FolderFormat.Header(f);
                if (!FolderFormat.IsManifest(h)) return false;
                projectId = FolderFormat.Id(FolderFormat.Text(h, "id")); return true;
            }
        }
        internal object Status() => new Map { ["state"] = state, ["paths"] = conflicts };
        internal object WithCollaboration(Func<object> operation)
        {
            lock (gate)
            {
                CheckOpen();
                using (disk.Barrier(false))
                using (var file = disk.Open(Manifest))
                {
                    var header = file == null ? null : FolderFormat.Header(file);
                    if (!FolderFormat.IsManifest(header) || FolderFormat.Text(header, "id") != projectId)
                        throw new HostError("The selected Waffle project changed.");
                    return operation();
                }
            }
        }
        void Failure(Exception e)
        {
            conflicts = e is FolderConflict conflict ? new[] { conflict.Target } : Array.Empty<string>();
            state = e is FolderConflict ? "conflict" : "recoveryPending";
        }
        void CheckOpen() { if (closing) throw new HostError("The folder project has closed."); }
        internal void Recover()
        {
            lock (gate)
            {
                CheckOpen();
                bool active;
                using (var reader = disk.Barrier(false))
                {
                    active = disk.Spelling(disk.Active) != null;
                    if (!active && !disk.Orphans().Any()) return;
                }
                if (active) { using (var writer = disk.Barrier(true)) ReplayActive(); }
                else
                {
                    // A clean read-only checkout can ignore uncommitted staging. After a process
                    // stopped between unlink and directory flush, persist the absence of active
                    // before reclaiming the sole retained contents of its transaction.
                    IDisposable writer;
                    try { writer = disk.Barrier(true); }
                    catch (Exception e) when (e is IOException || e is UnauthorizedAccessException || e is HostError) { return; }
                    using (writer)
                    {
                        ReplayActive();
                        try { disk.SyncParent(disk.Active); }
                        catch (Exception e) { Failure(e); throw; }
                        disk.ReclaimOrphans();
                    }
                }
            }
        }
        void ReplayActive()
        {
            try
            {
                var raw = disk.Read(disk.Active, FolderFormat.MaxDescriptor);
                if (raw == null)
                {
                    if (disk.Spelling(disk.Active) != null) throw FolderFormat.Invalid("journal spelling");
                    conflicts = Array.Empty<string>(); state = "settled"; return;
                }
                var active = Descriptor.Decode(raw, Manifest);
                if (projectId != null && projectId != active.ProjectId) throw FolderFormat.Invalid("journal project identity");
                if (standalone) CheckStandalone(active);
                else if (projectId == null)
                {
                    using (var file = disk.Open(Manifest))
                    {
                        if (file != null)
                        {
                            var h = FolderFormat.Header(file);
                            if (!FolderFormat.IsManifest(h) || FolderFormat.Text(h, "id") != active.ProjectId) throw FolderFormat.Invalid("journal project identity");
                        }
                        else if (!active.Plan.Any(p => p.Path == Manifest && p.Desired != null)) throw FolderFormat.Invalid("journal manifest");
                    }
                }
                disk.SyncParent(disk.Active);
                Apply(active); projectId = active.ProjectId;
            }
            catch (Exception e) { Failure(e); throw; }
        }
        internal object AcquireLease()
        {
            lock (gate)
            {
                CheckOpen();
                if (leases.Count >= 16) throw new HostError("Too many open project readers.");
                var barrier = disk.Barrier(false);
                try
                {
                    if (disk.Spelling(disk.Active) != null)
                    {
                        if (state != "conflict") state = "recoveryPending";
                        if (conflicts.Length > 0) throw new FolderConflict(conflicts[0]);
                        throw new HostError("Project recovery is pending.");
                    }
                    var key = Guid.NewGuid().ToString("D"); leases.Add(key, barrier); leaseHashes.Add(key, new Map());
                    leaseFiles.Add(key, new Dictionary<string, Stream>(StringComparer.Ordinal)); barrier = null;
                    return new Map { ["lease"] = key };
                }
                finally { barrier?.Dispose(); }
            }
        }
        void Lease(string lease)
        {
            CheckOpen();
            if (lease == null || !leases.ContainsKey(lease)) throw new HostError("Open a project read lease first.");
        }
        internal bool Release(string key)
        {
            lock (gate)
            {
                if (key == null || !leases.TryGetValue(key, out var reader)) return true;
                foreach (var file in leaseFiles[key].Values) file.Dispose();
                leaseFiles.Remove(key); leaseMembership.Remove(key); leaseFuture.Remove(key); leaseHashes.Remove(key); leases.Remove(key); ReleaseMedia(key);
                reader.Dispose(); return true;
            }
        }
        internal T WithLease<T>(string lease, Func<string, string, T> read)
        {
            lock (gate) { Lease(lease); return read(Root, Manifest); }
        }

        Dictionary<string, string> Members(byte[] bytes, Dictionary<string, FutureMember> forward = null, HashSet<string> tableOwners = null)
        {
            var result = new Dictionary<string, string>(StringComparer.Ordinal);
            if (bytes == null) return result;
            var header = First(bytes);
            bool tables = FolderAdditive.TableProfile(header), hasTable = false;
            int minor = tables ? 0 : FolderFormat.Minor(header);
            var folded = new HashSet<string>(StringComparer.OrdinalIgnoreCase) { Manifest };
            var ids = new HashSet<string>(StringComparer.Ordinal);
            foreach (var member in FolderFormat.Members(bytes))
            {
                string path = FolderFormat.Text(member, "path"), id = FolderFormat.Id(FolderFormat.Text(member, "id"));
                string recordKind = FolderFormat.Text(member, "kind");
                string kind = recordKind == "document" ? FolderFormat.Text(member, "docKind") : recordKind == "layoutBlock" ? "block" : recordKind;
                bool future = minor > 0 && recordKind == "document" && FolderFormat.FuturePath(path, kind);
                if (!future)
                {
                    if (!FolderFormat.Authored(path, Manifest)) throw FolderFormat.Invalid("manifest member");
                    if (recordKind == "importIndex")
                    {
                        if (!path.StartsWith(".waffle/imports/", StringComparison.Ordinal)) throw FolderFormat.Invalid("import index path");
                    }
                    else if (kind == null || FolderFormat.MemberKind(path) != kind || Auxiliary(path) ||
                        recordKind == "document" && (kind == "library" || kind == "block"))
                        throw FolderFormat.Invalid("manifest member kind");
                }
                if (!folded.Add(path) || !ids.Add(id)) throw FolderFormat.Invalid("duplicate manifest member");
                if (FolderFormat.Get(member, "requires") is List<object> flags && flags.Contains(FolderAdditive.TableFeature))
                {
                    if (!tables || kind != "schematic") throw FolderFormat.Invalid("table member requirement");
                    tableOwners?.Add(path);
                    hasTable = true;
                }
                if (minor > 0 && forward != null && recordKind != "importIndex")
                    forward.Add(path, new FutureMember { Id = id, Kind = kind, ManifestMinor = minor, Opaque = future });
                result.Add(path, id);
            }
            if (tables && !hasTable) throw FolderFormat.Invalid("missing table owner");
            return result;
        }
        byte[] ReadObserved(string lease, string path, long cap)
        {
            if (!disk.Platform.ReadHandlesPreventChanges) return disk.Read(path, cap);
            var held = leaseFiles[lease];
            if (!held.TryGetValue(path, out var file))
            {
                if (held.Count >= FolderFormat.MaxEntries) throw FolderFormat.Invalid("snapshot member count");
                file = disk.Open(path); if (file == null) return null;
                // Win32 opens without write or delete sharing. Earlier bytes cannot change
                // while later members are being gathered by a saved export.
                held.Add(path, file);
            }
            file.Position = 0; return FolderStorage.Bytes(file, cap);
        }
        internal object Read(string lease, List<object> paths)
        {
            lock (gate)
            {
                Lease(lease);
                if (paths == null || paths.Count > FolderFormat.MaxEntries) throw FolderFormat.Invalid("read request");
                var files = new List<object>(); long remaining = FolderFormat.MaxFile;
                Dictionary<string, string> members = null;
                if (paths.Any(p => p as string != Manifest) && !leaseMembership.TryGetValue(lease, out members))
                {
                    var bytes = ReadObserved(lease, Manifest, FolderFormat.MaxFile);
                    if (bytes == null) throw new HostError("The project manifest is missing.");
                    string hash = FolderFormat.Sha(bytes);
                    if (leaseHashes[lease].TryGetValue(Manifest, out var earlier) && !Equals(earlier, hash)) throw new FolderConflict(Manifest);
                    leaseHashes[lease][Manifest] = hash;
                    members = Members(bytes);
                    if (!FolderAdditive.RegularVersion(First(bytes)))
                    {
                        // Only the selected manifest, returned to this caller, grants its forward owners.
                        foreach (var value in paths.TakeWhile(value => value as string != Manifest))
                            if (!(value is string path) || !Auxiliary(path))
                                throw FolderFormat.Invalid("unlisted member; read the selected manifest on this lease first");
                    }
                    else leaseMembership.Add(lease, members);
                }
                foreach (var value in paths)
                {
                    var p = value as string;
                    FutureMember future = null;
                    if (leaseFuture.TryGetValue(lease, out var opaque) && p != null) opaque.TryGetValue(p, out future);
                    if (future == null && (!FolderFormat.Authored(p, Manifest) || (p != Manifest && !Auxiliary(p) && !members.ContainsKey(p)))) throw FolderFormat.Invalid("unlisted member");
                    var bytes = ReadObserved(lease, p, remaining);
                    if (bytes == null) throw new HostError("The project file is missing: " + p);
                    remaining -= bytes.Length;
                    if (p == Manifest)
                    {
                        var header = First(bytes);
                        if (!FolderFormat.IsManifest(header) || (projectId != null && FolderFormat.Text(header, "id") != projectId)) throw new FolderConflict(Manifest);
                        var declared = new Dictionary<string, FutureMember>(StringComparer.Ordinal);
                        members = Members(bytes, declared); leaseMembership[lease] = members; leaseFuture[lease] = declared;
                    }
                    future?.Check(First(bytes));
                    string hash = FolderFormat.Sha(bytes);
                    if (FolderFormat.ImmutableDigest(p) is string pinned && hash != pinned) throw new FolderConflict(p);
                    if (leaseHashes[lease].TryGetValue(p, out var earlier) && !Equals(earlier, hash)) throw new FolderConflict(p);
                    leaseHashes[lease][p] = hash;
                    files.Add(new Map { ["path"] = p, ["data"] = Convert.ToBase64String(bytes), ["sha256"] = hash, ["length"] = bytes.Length });
                }
                if (!disk.Platform.ReadHandlesPreventChanges) VerifyReadSet(leaseHashes[lease]);
                return new Map { ["files"] = files };
            }
        }
        void VerifyReadSet(Map reads, string lease = null)
        {
            if (reads == null || reads.Count == 0) return;
            if (reads.Count > FolderFormat.MaxEntries) throw FolderFormat.Invalid("read set");
            var opaque = new Dictionary<string, FutureMember>(StringComparer.Ordinal);
            var members = Members(disk.Read(Manifest), opaque);
            foreach (var row in reads)
            {
                if (!FolderFormat.IsDigest(row.Value as string)) throw FolderFormat.Invalid("read set digest");
                if (opaque.TryGetValue(row.Key, out var future))
                {
                    if (lease != null && (!leaseFuture.TryGetValue(lease, out var declared) || !declared.ContainsKey(row.Key)))
                        throw FolderFormat.Invalid("unlisted read set member");
                    using (var f = disk.Open(row.Key)) future.Check(f == null ? null : FolderFormat.Header(f));
                }
                else if (!FolderFormat.Authored(row.Key, Manifest) || (row.Key != Manifest && !Auxiliary(row.Key) && !members.ContainsKey(row.Key)))
                    throw FolderFormat.Invalid("read set member");
                if (disk.Hash(row.Key, out _) != row.Value as string) throw new FolderConflict(row.Key);
            }
        }
        internal bool VerifyLease(string lease, Map additional = null)
        {
            lock (gate) { Lease(lease); VerifyReadSet(leaseHashes[lease], lease); VerifyReadSet(additional, lease); return true; }
        }
        static bool Auxiliary(string p) => p.StartsWith("assets/", StringComparison.Ordinal) || p.StartsWith("models/", StringComparison.Ordinal) ||
            p.StartsWith(".waffle/imports/", StringComparison.Ordinal) || p == ".waffle/.gitignore";
        static void CheckIgnore(byte[] existing, byte[] desired)
        {
            if (desired == null) throw FolderFormat.Invalid("ignored-state rules");
            var old = existing == null ? "" : FolderFormat.Utf8.GetString(existing);
            var lines = new HashSet<string>(old.Replace("\r\n", "\n").Split('\n'), StringComparer.Ordinal);
            var missing = new[] { "/cache/", "/previews/", "/history/", "/journal/", "/local/" }.Where(p => !lines.Contains(p)).ToArray();
            string final = old;
            if (missing.Length != 0)
            {
                if (final.Length > 0 && !final.EndsWith("\n", StringComparison.Ordinal)) final += "\n";
                final += string.Join("\n", missing) + "\n";
            }
            if (FolderFormat.Utf8.GetString(desired) != final) throw FolderFormat.Invalid("ignored-state rules");
        }
        string Payload(Descriptor d, Entry p) => disk.Journal + "/" + d.Transaction + "/" + p.Desired;
        byte[] Desired(Map row, Entry entry, byte[] original = null)
        {
            var choices = new[] { "text", "data", "splice", "remove", "assetToken" }.Where(row.ContainsKey).ToList();
            if (choices.Count != 1) throw FolderFormat.Invalid("write request");
            switch (choices[0])
            {
                case "remove":
                    if (!Equals(row["remove"], true) || entry.Expected == null) throw FolderFormat.Invalid("removal");
                    return null;
                case "text": return FolderFormat.Utf8.GetBytes(FolderFormat.Text(row, "text") ?? throw FolderFormat.Invalid("text"));
                case "data":
                    {
                        string text = FolderFormat.Text(row, "data");
                        if (text == null || text.Length > (FolderFormat.MaxFile + 2) / 3 * 4) throw FolderFormat.Invalid("payload");
                        return Convert.FromBase64String(text);
                    }
                case "assetToken": throw FolderFormat.Invalid("attachment request");
                default:
                    if (!(row["splice"] is Map splice) || entry.Expected == null || FolderFormat.Text(splice, "base") != entry.Expected ||
                        !(FolderFormat.Get(splice, "edits") is List<object> edits) || edits.Count > FolderFormat.MaxEntries) throw FolderFormat.Invalid("splice base");
                    var bytes = original ?? disk.Read(entry.Path);
                    if (bytes == null || FolderFormat.Sha(bytes) != entry.Expected) throw new FolderConflict(entry.Path);
                    using (var output = new MemoryStream())
                    {
                        int cursor = 0;
                        foreach (var v in edits)
                        {
                            if (!(v is Map edit)) throw FolderFormat.Invalid("splice edit");
                            int offset = (int)FolderFormat.Number(FolderFormat.Get(edit, "offset"), bytes.Length);
                            int remove = (int)FolderFormat.Number(FolderFormat.Get(edit, "remove"), bytes.Length - offset);
                            var insert = FolderFormat.Utf8.GetBytes(FolderFormat.Text(edit, "insert") ?? throw FolderFormat.Invalid("splice insertion"));
                            if (offset < cursor || output.Length + offset - cursor + insert.Length > FolderFormat.MaxFile) throw FolderFormat.Invalid("splice range");
                            output.Write(bytes, cursor, offset - cursor); output.Write(insert, 0, insert.Length); cursor = offset + remove;
                        }
                        if (output.Length + bytes.Length - cursor > FolderFormat.MaxFile) throw FolderFormat.Invalid("splice size");
                        output.Write(bytes, cursor, bytes.Length - cursor); return output.ToArray();
                    }
            }
        }
        static Map First(byte[] bytes) { using (var f = new MemoryStream(bytes, false)) return FolderFormat.Header(f); }
        void Membership(Descriptor d, Dictionary<string, byte[]> desired, IReadOnlyDictionary<string, string> nativeCopyHashes)
        {
            var oldBytes = disk.Read(Manifest);
            if (oldBytes != null && (!FolderFormat.IsManifest(First(oldBytes)) || FolderFormat.Text(First(oldBytes), "id") != d.ProjectId))
                throw new FolderConflict(Manifest);
            var beforeTables = new HashSet<string>(StringComparer.Ordinal);
            var before = Members(oldBytes, tableOwners: beforeTables);
            var manifestChanged = desired.TryGetValue(Manifest, out var afterBytes);
            if (manifestChanged && (afterBytes == null || !FolderFormat.IsManifest(First(afterBytes)) || FolderFormat.Text(First(afterBytes), "id") != d.ProjectId))
                throw FolderFormat.Invalid("manifest identity");
            if (oldBytes == null && !manifestChanged) throw FolderFormat.Invalid("missing manifest");
            var afterTables = manifestChanged ? new HashSet<string>(StringComparer.Ordinal) : beforeTables;
            var after = manifestChanged ? Members(afterBytes, tableOwners: afterTables) : before;
            foreach (var p in d.Plan)
            {
                if (p.Path == Manifest) continue;
                if (Auxiliary(p.Path))
                {
                    if (p.Path == ".waffle/.gitignore") CheckIgnore(disk.Read(p.Path, 1024 * 1024), desired[p.Path]);
                    continue;
                }
                if (p.Expected != null && !before.ContainsKey(p.Path)) throw FolderFormat.Invalid("unlisted base");
                if (nativeCopyHashes != null && nativeCopyHashes.TryGetValue(p.Path, out var copyHash))
                {
                    if (!manifestChanged) throw FolderFormat.Invalid("exact native copy bytes or membership");
                    if (p.Desired == null)
                    {
                        using (var old = disk.Open(p.Path))
                        {
                            var original = old == null ? null : FolderFormat.Header(old);
                            if (p.Expected != copyHash || !before.TryGetValue(p.Path, out var originalId) ||
                                FolderFormat.Text(original, "id") != originalId ||
                                FolderFormat.Text(original, "kind") != FolderFormat.MemberKind(p.Path))
                                throw FolderFormat.Invalid("exact native copy bytes or membership");
                        }
                    }
                    else if (p.Desired != copyHash || before.Keys.Any(path => path.Equals(p.Path, StringComparison.OrdinalIgnoreCase)))
                        throw FolderFormat.Invalid("exact native copy bytes or membership");
                }
                if (p.Desired == null) { if (after.ContainsKey(p.Path)) throw FolderFormat.Invalid("removed member"); continue; }
                var header = First(desired[p.Path]) ?? new Map();
                if (!after.TryGetValue(p.Path, out var memberId) || FolderFormat.Text(header, "id") != memberId ||
                    FolderFormat.Text(header, "kind") != FolderFormat.MemberKind(p.Path) || !FolderFormat.IsVersion2(header) ||
                    FolderAdditive.TableProfile(header) != afterTables.Contains(p.Path))
                    throw FolderFormat.Invalid("member identity");
            }
            if (manifestChanged)
            {
                var afterById = after.ToDictionary(p => p.Value, p => p.Key, StringComparer.Ordinal);
                foreach (var prior in before)
                {
                    if (after.ContainsKey(prior.Key)) continue;
                    if (!desired.ContainsKey(prior.Key)) throw FolderFormat.Invalid("missing removal");
                    if (afterById.TryGetValue(prior.Value, out var nextPath))
                    {
                        int removed = d.Plan.FindIndex(e => e.Path == prior.Key), created = d.Plan.FindIndex(e => e.Path == nextPath);
                        bool alias = prior.Key.Equals(nextPath, StringComparison.OrdinalIgnoreCase);
                        if (created < 0 || (alias ? removed >= created : created >= removed)) throw FolderFormat.Invalid("rename order");
                    }
                }
                foreach (var next in after)
                {
                    if ((before.TryGetValue(next.Key, out var oldId) && oldId == next.Value &&
                        beforeTables.Contains(next.Key) == afterTables.Contains(next.Key)) || desired.ContainsKey(next.Key)) continue;
                    if (Auxiliary(next.Key)) continue;
                    using (var file = disk.Open(next.Key))
                    {
                        var header = file == null ? null : FolderFormat.Header(file);
                        if (header == null || FolderFormat.Text(header, "id") != next.Value || FolderFormat.Text(header, "kind") != FolderFormat.MemberKind(next.Key) ||
                            FolderAdditive.TableProfile(header) != afterTables.Contains(next.Key))
                            throw FolderFormat.Invalid("missing or different member");
                    }
                }
            }
        }
        void Preflight(Descriptor d)
        {
            foreach (var p in d.Plan)
            {
                var actualName = disk.Spelling(p.Path);
                if (actualName != null && actualName != FolderStorage.Name(p.Path))
                {
                    if (p.Expected == null && d.Plan.TakeWhile(e => e != p).Any(e => e.Desired == null && e.Path.Equals(p.Path, StringComparison.OrdinalIgnoreCase) &&
                        FolderStorage.Name(e.Path) == actualName)) continue;
                    throw new FolderConflict(p.Path);
                }
                string hash = disk.Hash(p.Path, out var length);
                if (p.Expected == null && hash != null)
                {
                    if (FolderFormat.ImmutableDigest(p.Path) != null && hash == p.Desired && length == p.Length) continue;
                    throw new FolderConflict(p.Path);
                }
                if (hash != p.Expected) throw new FolderConflict(p.Path);
            }
        }
        internal object Commit(Map request, out Action apply, Map readSet = null, IReadOnlyDictionary<string, string> nativeCopyHashes = null)
        {
            apply = null;
            lock (gate)
            {
                CheckOpen();
                if (applying || leases.Count != 0) throw new HostError("A project read or save is still in progress.");
                if (FolderFormat.Text(request, "manifest") != Manifest || !(FolderFormat.Get(request, "plan") is List<object> plan) ||
                    plan.Count < 1 || plan.Count > FolderFormat.MaxEntries) throw FolderFormat.Invalid("write plan");
                var d = new Descriptor { ProjectId = FolderFormat.Id(FolderFormat.Text(request, "projectId")), Transaction = Guid.NewGuid().ToString("D") };
                if (projectId != null && projectId != d.ProjectId) throw FolderFormat.Invalid("project identity");
                using (var reader = disk.Barrier(false))
                {
                    if (disk.Spelling(disk.Active) == null && CheckWriteCompatibility(d.ProjectId, plan, nativeCopyHashes).Minor > 0)
                        VerifyReadSet(readSet);
                }
                var writer = disk.Barrier(true); bool published = false;
                try
                {
                    ReplayActive();
                    var scope = CheckWriteCompatibility(d.ProjectId, plan, nativeCopyHashes);
                    VerifyReadSet(readSet);
                    checkpoint("before-stage");
                    var bytes = new Dictionary<string, byte[]>(StringComparer.Ordinal);
                    var streams = new Dictionary<string, Stream>(StringComparer.Ordinal);
                    long total = 0;
                    foreach (var item in plan)
                    {
                        if (!(item is Map row)) throw FolderFormat.Invalid("write entry");
                        var e = new Entry { Path = FolderFormat.Text(row, "path"), Expected = FolderFormat.Text(row, "expected") };
                        if (!FolderFormat.Authored(e.Path, Manifest) || !row.ContainsKey("expected") || (row["expected"] != null && !FolderFormat.IsDigest(e.Expected))) throw FolderFormat.Invalid("target or base");
                        byte[] b = null;
                        if (row.ContainsKey("assetToken"))
                        {
                            if (new[] { "data", "text", "splice", "remove" }.Any(row.ContainsKey)) throw FolderFormat.Invalid("attachment entry");
                            var staged = StagedAsset(FolderFormat.Text(row, "assetToken"), e.Path);
                            e.Desired = staged.Digest; e.Length = staged.Length;
                            streams.Add(e.Path, staged.Content);
                        }
                        else
                        {
                            b = Desired(row, e);
                            if (b != null) { e.Length = b.LongLength; e.Desired = FolderFormat.Sha(b); }
                        }
                        total += e.Length;
                        if (total > FolderFormat.MaxTotal) throw FolderFormat.Invalid("write size");
                        if (FolderFormat.ImmutableDigest(e.Path) is string pinned && (e.Expected != null || e.Desired != pinned)) throw FolderFormat.Invalid("immutable asset");
                        bytes.Add(e.Path, b); d.Plan.Add(e);
                    }
                    d.CheckNames(Manifest); Preflight(d); Membership(d, bytes, nativeCopyHashes); ValidateAssetOwners(plan, d, bytes);
                    var result = Publish(d, (e, output) =>
                    {
                        if (streams.TryGetValue(e.Path, out var input))
                        {
                            input.Position = 0;
                            input.CopyTo(output);
                        }
                        else
                        {
                            byte[] data = bytes[e.Path];
                            output.Write(data, 0, data.Length);
                        }
                    }, () => { Preflight(d); VerifyScope(scope); VerifyReadSet(readSet); }, false, ref writer, ref published, out apply);
                    SpendAssets(plan);
                    return result;
                }
                catch (Exception e)
                {
                    if (published || disk.Spelling(disk.Active) != null) Failure(e);
                    else { try { disk.Clean(d.Transaction); } catch (IOException) { } if (e is FolderConflict) Failure(e); }
                    throw;
                }
                finally { writer?.Dispose(); }
            }
        }
        object Publish(Descriptor d, Action<Entry, Stream> write, Action recheck, bool replace,
                       ref IDisposable writer, ref bool published, out Action apply, Action afterApply = null)
        {
            apply = null;
            var retained = new HashSet<string>();
            for (int i = 0; i < d.Plan.Count; i++)
            {
                var e = d.Plan[i];
                if (e.Desired == null || !retained.Add(e.Desired)) continue;
                disk.WriteTemp(Payload(d, e), output => write(e, output), true,
                    () => checkpoint("after-stage-write:" + i), () => checkpoint("after-stage-flush:" + i));
            }
            var tmp = disk.Journal + "/" + d.Transaction + "/descriptor";
            var raw = d.Encode();
            if (raw.Length > FolderFormat.MaxDescriptor) throw FolderFormat.Invalid("journal size");
            disk.WriteTemp(tmp, s => s.Write(raw, 0, raw.Length), true,
                () => checkpoint("after-descriptor-write"), () => checkpoint("after-descriptor-flush"));
            disk.SyncParent(tmp); checkpoint("after-stage-dir-sync");
            recheck(); CheckOpen(); checkpoint("before-publish");
            disk.Move(tmp, disk.Active, replace); published = true; checkpoint("after-publish");
            disk.SyncParent(disk.Active); checkpoint("after-commit-sync");
            if (!Digest.Same(raw, disk.Read(disk.Active, FolderFormat.MaxDescriptor))) throw FolderFormat.Invalid("changed committed descriptor");
            projectId = d.ProjectId; state = "applying"; applying = true;
            var transfer = writer; writer = null;
            apply = () =>
            {
                lock (gate)
                {
                    try { Apply(d); afterApply?.Invoke(); }
                    catch (Exception e) { Failure(e); }
                    finally { transfer.Dispose(); applying = false; if (closing) CloseStorage(); }
                }
            };
            return new Map
            {
                ["saved"] = true,
                ["transaction"] = d.Transaction,
                ["hashes"] = d.Plan.ToDictionary(e => e.Path, e => (object)e.Desired, StringComparer.Ordinal)
            };
        }
        void VerifyStaged(Descriptor d, Entry e)
        {
            if (e.Desired == null) return;
            if (disk.Hash(Payload(d, e), out var length) != e.Desired || length != e.Length) throw FolderFormat.Invalid("retained payload");
        }
        string Current(Entry e, Descriptor d)
        {
            var name = disk.Spelling(e.Path);
            if (name != null && name != FolderStorage.Name(e.Path))
            {
                if (e.Desired == null && d.Plan.Any(n => n.Expected == null && n.Desired != null && n.Path.Equals(e.Path, StringComparison.OrdinalIgnoreCase) &&
                    FolderStorage.Name(n.Path) == name)) return null;
                throw new FolderConflict(e.Path);
            }
            return disk.Hash(e.Path, out _);
        }
        void Apply(Descriptor d)
        {
            state = "applying";
            for (int i = 0; i < d.Plan.Count; i++) VerifyStaged(d, d.Plan[i]);
            if (standalone) CheckStandalone(d); else CheckInstallCompatibility(d);
            for (int i = 0; i < d.Plan.Count; i++)
            {
                var e = d.Plan[i]; checkpoint("before-install:" + i);
                var current = Current(e, d);
                if (current != e.Desired)
                {
                    if (current != e.Expected) throw new FolderConflict(e.Path);
                    if (e.Desired == null)
                    {
                        using (disk.Parents(e.Path, false, out _)) { if (Current(e, d) != e.Expected) throw new FolderConflict(e.Path); disk.Delete(e.Path); }
                    }
                    else
                    {
                        var tmp = disk.Journal + "/" + d.Transaction + "/install-" + i;
                        if (disk.Spelling(tmp) != null)
                        {
                            using (var previous = disk.Open(tmp)) if (previous == null) throw FolderFormat.Invalid("install temporary");
                            disk.Delete(tmp);
                        }
                        try
                        {
                            disk.WriteTemp(tmp, s => { using (var source = disk.Open(Payload(d, e))) source.CopyTo(s); }, false,
                                () => checkpoint("after-install-temp-write:" + i), () => checkpoint("after-install-temp-flush:" + i));
                            using (disk.Parents(e.Path, true, out _))
                            {
                                if (disk.Hash(tmp, out var len) != e.Desired || len != e.Length) throw FolderFormat.Invalid("install temporary");
                                if (Current(e, d) != e.Expected) throw new FolderConflict(e.Path);
                                checkpoint("after-target-verify:" + i);
                                if (Current(e, d) != e.Expected) throw new FolderConflict(e.Path);
                                disk.Move(tmp, e.Path, e.Expected != null);
                            }
                        }
                        finally { disk.Delete(tmp); }
                    }
                }
                checkpoint("after-install:" + i); disk.SyncParent(e.Path); checkpoint("after-dir-sync:" + i);
            }
            foreach (var p in d.Plan) if (Current(p, d) != p.Desired) throw new FolderConflict(p.Path);
            checkpoint("before-unlink"); disk.Delete(disk.Active); checkpoint("after-unlink");
            disk.SyncParent(disk.Active); checkpoint("after-unlink-sync");
            try { disk.Clean(d.Transaction); } catch (IOException) { }
            checkpoint("after-cleanup"); conflicts = Array.Empty<string>(); state = "settled";
        }
        internal void BeginClose() { closing = true; }
        public void Dispose()
        {
            closing = true;
            lock (gate)
            {
                foreach (var key in leases.Keys.ToArray()) Release(key);
                if (!applying) CloseStorage();
            }
        }
        void CloseStorage() { CloseAssets(); disk.Dispose(); }
    }
}
