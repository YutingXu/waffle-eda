// Review and explicitly supersede a committed intent. Both sides and the original descriptor
// remain available in the ignored conflict archive after the replacement becomes durable.
using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;

namespace Waffle.Windows
{
    using Map = Dictionary<string, object>;
    using Descriptor = FolderFormat.Descriptor;
    using Entry = FolderFormat.Entry;

    internal sealed partial class FolderProject
    {
        Descriptor Pending(string transaction, out byte[] raw)
        {
            raw = disk.Read(disk.Active, FolderFormat.MaxDescriptor);
            if (raw == null) throw new HostError("There is no pending project conflict.");
            var d = Descriptor.Decode(raw, Manifest);
            if ((transaction != null && d.Transaction != transaction) || (projectId != null && projectId != d.ProjectId))
                throw new HostError("The pending project transaction changed. Refresh the conflict review.");
            foreach (var e in d.Plan) VerifyStaged(d, e);
            return d;
        }

        internal object Conflict()
        {
            lock (gate)
            {
                CheckOpen();
                using (var reader = disk.Barrier(false))
                {
                    var d = Pending(null, out _);
                    var paths = new List<string>(); var plan = new List<Map>();
                    foreach (var e in d.Plan)
                    {
                        var actual = Current(e, d);
                        if (actual != e.Desired && actual != e.Expected) paths.Add(e.Path);
                        var row = e.Wire(); row["current"] = actual; plan.Add(row);
                    }
                    return new Map
                    {
                        ["state"] = paths.Count == 0 ? "recoveryPending" : "conflict",
                        ["paths"] = paths,
                        ["transaction"] = d.Transaction,
                        ["plan"] = plan
                    };
                }
            }
        }

        internal object ConflictRead(Map request)
        {
            lock (gate)
            {
                CheckOpen();
                using (var reader = disk.Barrier(false))
                {
                    string tx = FolderFormat.Text(request, "transaction") ?? throw FolderFormat.Invalid("review transaction");
                    var d = Pending(tx, out _);
                    var path = FolderFormat.Text(request, "path");
                    var entry = d.Plan.SingleOrDefault(e => e.Path == path) ?? throw FolderFormat.Invalid("review target");
                    var side = FolderFormat.Text(request, "side");
                    string hash, source;
                    if (side == "external") { hash = Current(entry, d); source = path; }
                    else if (side == "staged") { hash = entry.Desired; source = Payload(d, entry); }
                    else throw FolderFormat.Invalid("review side");
                    if (hash == null) throw new HostError("That side of the conflict has no file.");
                    using (var f = disk.Open(source))
                    using (var sha = System.Security.Cryptography.SHA256.Create())
                    {
                        if (f == null || FolderFormat.Hex(sha.ComputeHash(f)) != hash) throw new FolderConflict(path);
                        var offset = FolderFormat.Number(FolderFormat.Get(request, "offset"), f.Length);
                        var size = (int)FolderFormat.Number(FolderFormat.Get(request, "length"), ChunkLimit);
                        if (size == 0) throw FolderFormat.Invalid("review length");
                        var data = Chunk(f, offset, size); data["sha256"] = hash; return data;
                    }
                }
            }
        }

        void Preserve(string archive, string hash, byte[] bytes)
        {
            if (bytes == null) return;
            if (FolderFormat.Sha(bytes) != hash) throw FolderFormat.Invalid("conflict contents");
            var file = archive + "/" + hash;
            var existing = disk.Hash(file, out var length);
            if (existing != null)
            {
                if (existing != hash || length != bytes.Length) throw FolderFormat.Invalid("conflict archive");
                return;
            }
            disk.WriteTemp(file, s => s.Write(bytes, 0, bytes.Length), true, null, null);
            disk.SyncParent(file);
        }

        internal object Resolve(Map request, out Action apply)
        {
            apply = null;
            lock (gate)
            {
                CheckOpen();
                if (applying || leases.Count != 0) throw new HostError("A project read or save is still in progress.");
                using (var reader = disk.Barrier(false))
                    if (disk.Spelling(disk.Active) == null) throw new HostError("There is no pending project conflict.");
                var writer = disk.Barrier(true); bool published = false;
                var replacement = new Descriptor { Transaction = Guid.NewGuid().ToString("D") };
                try
                {
                    string transaction = FolderFormat.Text(request, "transaction") ?? throw FolderFormat.Invalid("review transaction");
                    var prior = Pending(transaction, out var original);
                    replacement.ProjectId = prior.ProjectId;
                    var scope = Scope(prior.ProjectId);
                    if (!(FolderFormat.Get(request, "choices") is List<object> choices) || choices.Count == 0 || choices.Count > prior.Plan.Count)
                        throw FolderFormat.Invalid("review choices");
                    var options = new Dictionary<string, Map>(StringComparer.Ordinal);
                    foreach (var v in choices)
                    {
                        if (!(v is Map row)) throw FolderFormat.Invalid("review choice");
                        var p = FolderFormat.Text(row, "path");
                        if (!prior.Plan.Any(e => e.Path == p) || options.ContainsKey(p)) throw FolderFormat.Invalid("review target");
                        options.Add(p, row);
                    }
                    string archive = ".waffle/local/conflicts/" + prior.Transaction;
                    var current = new Dictionary<string, string>(StringComparer.Ordinal);
                    var desired = new Dictionary<string, byte[]>(StringComparer.Ordinal);
                    bool found = false; long total = 0;
                    foreach (var e in prior.Plan)
                    {
                        var hash = Current(e, prior); current.Add(e.Path, hash);
                        var external = hash == null ? null : disk.Read(e.Path);
                        var staged = e.Desired == null ? null : disk.Read(Payload(prior, e));
                        bool changed = hash != e.Expected && hash != e.Desired; found |= changed;
                        var data = staged;
                        if (options.TryGetValue(e.Path, out var row))
                        {
                            if (!row.ContainsKey("current") || (row["current"] != null && !FolderFormat.IsDigest(FolderFormat.Text(row, "current"))) ||
                                FolderFormat.Text(row, "current") != hash) throw new FolderConflict(e.Path);
                            switch (FolderFormat.Text(row, "use"))
                            {
                                case "external": data = external; break;
                                case "staged": break;
                                case "merged":
                                    if (row.ContainsKey("text") == row.ContainsKey("data")) throw FolderFormat.Invalid("merged content");
                                    data = Desired(row, new Entry { Path = e.Path, Expected = hash }); break;
                                default: throw FolderFormat.Invalid("review decision");
                            }
                        }
                        else if (changed) throw new FolderConflict(e.Path);
                        if (e.Path == Manifest && scope.Minor <= 1 && data != null && FolderFormat.Minor(First(data)) == 1)
                            FolderAdditive.VerifyProjectWrite(external, data, prior.ProjectId, Manifest);
                        else if (scope.Minor > 0) VerifyOwner(scope, prior.ProjectId, e, external, data);
                        else if (!Auxiliary(e.Path) && (e.Path == Manifest || FolderFormat.MemberKind(e.Path) != null))
                        {
                            if (external != null) FolderAdditive.RequireWritable(First(external), e.Path);
                            if (data != null)
                            {
                                var header = First(data);
                                FolderAdditive.RequireWritable(header, e.Path);
                                if (!FolderAdditive.RegularVersion(header)) throw FolderAdditive.Refused();
                            }
                        }
                        if (hash == null && data == null) continue;
                        var next = new Entry { Path = e.Path, Expected = hash, Desired = data == null ? null : FolderFormat.Sha(data), Length = data?.LongLength ?? 0 };
                        if (FolderFormat.ImmutableDigest(e.Path) is string pinned && next.Desired != pinned) throw FolderFormat.Invalid("resolved immutable asset");
                        total += next.Length; if (total > FolderFormat.MaxTotal) throw FolderFormat.Invalid("resolution size");
                        replacement.Plan.Add(next); desired.Add(e.Path, data);
                    }
                    if (!found) throw new HostError("The competing versions changed. Refresh the conflict review.");
                    if (replacement.Plan.Count == 0)
                    {
                        byte[] manifest = disk.Read(Manifest) ?? throw FolderFormat.Invalid("resolution manifest");
                        string hash = FolderFormat.Sha(manifest);
                        replacement.Plan.Add(new Entry { Path = Manifest, Expected = hash, Desired = hash, Length = manifest.Length });
                        desired.Add(Manifest, manifest);
                    }
                    replacement.CheckNames(Manifest);
                    Preserve(archive, FolderFormat.Sha(original), original);
                    foreach (var e in prior.Plan)
                    {
                        if (current[e.Path] != null) Preserve(archive, current[e.Path], disk.Read(e.Path));
                        if (e.Desired != null) Preserve(archive, e.Desired, disk.Read(Payload(prior, e)));
                    }
                    checkpoint("before-stage");
                    Action verify = () =>
                    {
                        VerifyScope(scope);
                        foreach (var e in prior.Plan) if (Current(e, prior) != current[e.Path]) throw new FolderConflict(e.Path);
                        if (!Digest.Same(original, disk.Read(disk.Active, FolderFormat.MaxDescriptor))) throw FolderFormat.Invalid("changed recovery descriptor");
                    };
                    return Publish(replacement, (e, s) => { var b = desired[e.Path]; s.Write(b, 0, b.Length); }, verify, true,
                        ref writer, ref published, out apply, () =>
                        {
                            try { disk.Clean(prior.Transaction); } catch (IOException) { }
                        });
                }
                catch (Exception e)
                {
                    Failure(e);
                    if (!published) { try { disk.Clean(replacement.Transaction); } catch (IOException) { } }
                    throw;
                }
                finally { writer?.Dispose(); }
            }
        }
    }
}
