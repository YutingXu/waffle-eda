using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;

namespace Waffle.Windows
{
    using Map = Dictionary<string, object>;

    internal interface INativeDocumentClipboard
    {
        IList<string> ReadDocumentPaths();
    }

    public sealed partial class Host
    {
        sealed class DocumentOwner
        {
            internal string Manifest, MemberPath;
        }

        readonly Dictionary<string, (string Path, NativeMember Member)> documentGrants =
            new Dictionary<string, (string, NativeMember)>();
        sealed class DocumentCopyReceipt
        {
            internal string Scope, Sha;
            internal readonly HashSet<string> Installed = new HashSet<string>(StringComparer.Ordinal);
        }

        readonly Dictionary<string, DocumentCopyReceipt> documentCopyReceipts = new Dictionary<string, DocumentCopyReceipt>();

        void GrantDocumentCopy(Map row, string sha, string target)
        {
            if (target == null || target != adoptedFolder) return;
            if (documentCopyReceipts.Count >= 512)
            {
                var expired = documentCopyReceipts.FirstOrDefault(entry => entry.Value.Installed.Count == 0).Key;
                if (expired == null) return;
                documentCopyReceipts.Remove(expired);
            }
            string token = Guid.NewGuid().ToString("D");
            documentCopyReceipts.Add(token, new DocumentCopyReceipt { Scope = target, Sha = sha });
            row["nativeCopy"] = new Map { ["grant"] = token, ["sha256"] = sha };
        }

        Dictionary<string, string> AuthorisedDocumentCopies(Map request, string target,
            out List<(DocumentCopyReceipt Receipt, string Path, bool Remove)> changes)
        {
            changes = new List<(DocumentCopyReceipt, string, bool)>();
            var verified = new Dictionary<string, string>(StringComparer.Ordinal);
            if (FolderFormat.Get(request, "plan") is List<object> plan) foreach (var entry in plan.OfType<Map>())
            {
                if (!entry.TryGetValue("nativeCopy", out var value)) continue;
                var proof = value as Map;
                string token = proof == null ? null : Str(proof, "grant"), path = Str(entry, "path");
                bool remove = Equals(FolderFormat.Get(entry, "remove"), true);
                if (target != adoptedFolder || token == null || path == null || verified.ContainsKey(path) ||
                    !documentCopyReceipts.TryGetValue(token, out var receipt) || receipt.Scope != target ||
                    receipt.Sha != Str(proof, "sha256") ||
                    (remove && (!receipt.Installed.Contains(path) || receipt.Sha != Str(entry, "expected"))))
                    throw new HostError("Choose the original Waffle document again.");
                verified.Add(path, receipt.Sha);
                changes.Add((receipt, path, remove));
            }
            return verified;
        }

        void NoteDocumentCopies(List<(DocumentCopyReceipt Receipt, string Path, bool Remove)> changes)
        {
            foreach (var change in changes)
                if (change.Remove) change.Receipt.Installed.Remove(change.Path);
                else change.Receipt.Installed.Add(change.Path);
        }

        static bool MatchingMember(IFolderPlatform platform, string directory, string manifest, string member, string kind)
        {
            using (var disk = new FolderStorage(platform, directory, manifest))
            using (disk.Barrier(false))
            {
                if (!FolderFormat.Authored(member, manifest)) return false;
                byte[] raw = disk.Read(manifest);
                if (raw == null || raw.Length == 0 || raw[raw.Length - 1] != 10) return false;
                using (var input = new MemoryStream(raw))
                    if (!FolderFormat.IsManifest(FolderFormat.Header(input))) return false;
                var indexed = FolderFormat.Members(raw).Where(r => FolderFormat.Text(r, "path") == member).ToArray();
                if (indexed.Length != 1) return false;
                var row = indexed[0];
                string role = kind == "library" ? "library" : "document";
                if (FolderFormat.Text(row, "kind") != role ||
                    (role == "document" && FolderFormat.Text(row, "docKind") != kind)) return false;
                using (var input = disk.Open(member))
                {
                    var header = input == null ? null : FolderFormat.Header(input);
                    return FolderFormat.IsVersion2(header) && FolderFormat.Text(header, "kind") == kind &&
                           FolderFormat.Id(FolderFormat.Text(row, "id")) == FolderFormat.Text(header, "id");
                }
            }
        }

        static DocumentOwner FindDocumentOwner(IFolderPlatform native, string selected)
        {
            DocumentOwner found = null;
            string member = Path.GetFileName(selected);
            string kind = Policy.NativeDocumentKinds[Policy.Extension(member)];
            for (string directory = Path.GetDirectoryName(selected); directory != null; directory = Path.GetDirectoryName(directory))
            {
                var parts = member.Split('/');
                if (parts.Length == 1 || parts[0] == "documents" || parts[0] == "libraries")
                {
                    string[] manifests;
                    try
                    {
                        manifests = Directory.EnumerateFiles(directory)
                            .Where(path => !Path.GetFileName(path).StartsWith(".", StringComparison.Ordinal) &&
                                           Policy.IsProjectExtension(Policy.Extension(path))).Take(65).ToArray();
                    }
                    catch (Exception e) when (e is IOException || e is UnauthorizedAccessException)
                    { manifests = Array.Empty<string>(); }
                    if (manifests.Length <= 64)
                    {
                        foreach (var manifest in manifests)
                        {
                            bool match;
                            try { match = MatchingMember(native, directory, Path.GetFileName(manifest), member, kind); }
                            catch (Exception e) when (e is IOException || e is UnauthorizedAccessException || e is HostError ||
                                                      e is JsonException || e is System.Text.DecoderFallbackException)
                            { continue; }
                            if (!match) continue;
                            if (found != null)
                                throw new HostError("More than one Waffle project owns this document. Choose the project manifest.");
                            found = new DocumentOwner { Manifest = manifest, MemberPath = member };
                        }
                    }
                }
                member = Path.GetFileName(directory) + "/" + member;
            }
            return found;
        }

        bool TryOfferNativeDocument(string path, int id, int generation)
        {
            if (!(fs is IFolderPlatform native)) return false;
            var owner = FindDocumentOwner(native, path);
            if (owner != null)
            {
                OfferFolder(owner.Manifest, id, true, null, generation, path, owner.MemberPath);
                return true;
            }
            var candidate = new NativeMember(native, path);
            Map read;
            try { read = candidate.Read(); }
            catch { candidate.Dispose(); throw; }
            ui.Main(() =>
            {
                if (generation != pageGeneration) { candidate.Dispose(); return; }
                if (documentGrants.Count >= 8)
                {
                    candidate.Dispose();
                    openingProject = false;
                    Reply(id, null, "Close an open Waffle document first.");
                    return;
                }
                string grant = Guid.NewGuid().ToString("D"), name = fs.Name(path);
                documentGrants.Add(grant, (path, candidate));
                Reply(id, new List<object> { new Map
                {
                    ["name"] = name, ["memberPath"] = name, ["data"] = Convert.ToBase64String((byte[])read["data"]),
                    ["standaloneMember"] = new Map { ["grant"] = grant, ["sha256"] = read["sha256"], ["readOnly"] = read["readOnly"] }
                } });
            });
            return true;
        }

        void ClearNativeDocuments()
        {
            var closed = documentGrants.Values.ToArray();
            documentGrants.Clear();
            documentCopyReceipts.Clear();
            foreach (var grant in closed) ui.Background(grant.Member.Dispose);
        }

        void NativeDocumentAction(string action, int id, Map request)
        {
            var grant = Str(request, "grant");
            if (grant == null || !documentGrants.TryGetValue(grant, out var selection))
            {
                Reply(id, null, "Open the Waffle document again.");
                return;
            }
            if (action == "nativeMemberClose")
            {
                documentGrants.Remove(grant);
                ui.Background(selection.Member.Dispose);
                Reply(id, true);
                return;
            }
            var data = Str(request, "data");
            if (data == null || data.Length > (Policy.ProjectReadCap + 2) / 3 * 4)
            {
                Reply(id, null, "The Waffle document exceeds its size limit.");
                return;
            }
            if (action == "nativeMemberExportCopy")
            {
                ExportNativeDocumentCopy(selection.Path, id, request, data);
                return;
            }
            var expected = Str(request, "expected");
            int generation = pageGeneration;
            ui.Background(() =>
            {
                Map answer;
                try
                {
                    if (FindDocumentOwner((IFolderPlatform)fs, selection.Path) != null)
                        throw new HostError("A Waffle project now owns this document. Reopen it before saving.");
                    answer = selection.Member.Commit(expected, Convert.FromBase64String(data));
                }
                catch (Exception error)
                {
                    ui.Main(() => { if (generation == pageGeneration) Reply(id, null, Message(error)); });
                    return;
                }
                ui.Main(() => { if (generation == pageGeneration) Reply(id, answer); });
            });
        }

        void ExportNativeDocumentCopy(string original, int id, Map request, string data)
        {
            var name = Str(request, "name");
            var extension = Policy.Extension(original);
            if (name == null || name != Policy.BaseName(name) || Policy.Extension(name) != extension)
                throw new HostError("Choose a matching Waffle document filename.");
            int generation = pageGeneration;
            ui.PickSave(new SaveRequest { Title = "Save a Waffle document copy", FileName = name, Extension = extension }, path =>
            {
                if (generation != pageGeneration) return;
                if (path == null) { Reply(id, false); return; }
                try
                {
                    if (!fs.IsAbsolute(path) || Policy.Extension(path) != extension ||
                        fs.PathComparer.Equals(fs.Canonical(path), fs.Canonical(original)))
                        throw new HostError("Choose a separate file for the Waffle document copy.");
                    var kind = fs.Kind(path, out _);
                    if (kind != EntryKind.None && (kind != EntryKind.File || fs.Identity(original) == fs.Identity(path)))
                        throw new HostError("Choose a separate regular file for the Waffle document copy.");
                    fs.AtomicWrite(path, Convert.FromBase64String(data), false);
                    Reply(id, true);
                }
                catch (Exception error) { Reply(id, null, Message(error)); }
            });
        }

        void NativeDocumentCopyRows(IList<string> paths, int? clipboardId = null)
        {
            var generation = pageGeneration;
            var target = adoptedFolder;
            ui.Background(() =>
            {
                var copies = new List<(Map File, string Sha)>();
                long remaining = Policy.ProjectReadCap;
                string error = null;
                try
                {
                    foreach (var path in paths)
                    {
                        var bytes = fs.ReadRegular(path, remaining).Bytes;
                        remaining -= bytes.Length;
                        var name = fs.Name(path);
                        var file = new Map { ["name"] = name, ["memberPath"] = name, ["data"] = Convert.ToBase64String(bytes) };
                        copies.Add((file, target == null ? null : FolderFormat.Sha(bytes)));
                    }
                }
                catch (Exception failure) { error = Message(failure); }
                ui.Main(() =>
                {
                    if (generation != pageGeneration) return;
                    if (target != adoptedFolder || (!hasProject && target == null))
                    {
                        if (clipboardId.HasValue) Reply(clipboardId.Value, new Map());
                        return;
                    }
                    if (error != null)
                    {
                        if (clipboardId.HasValue) Reply(clipboardId.Value, null, error);
                        else ui.Post(Json.Write(new Map { ["type"] = "copyNativeDocuments", ["error"] = error }));
                        return;
                    }
                    foreach (var entry in copies) GrantDocumentCopy(entry.File, entry.Sha, target);
                    var result = new Map { ["files"] = copies.Select(entry => (object)entry.File).ToList() };
                    if (clipboardId.HasValue) Reply(clipboardId.Value, result);
                    else
                    {
                        result["type"] = "copyNativeDocuments";
                        ui.Post(Json.Write(result));
                    }
                });
            });
        }

        internal void DropDesignFiles(IList<string> paths)
        {
            var documents = paths.Where(Policy.NativeDocument).ToArray();
            if (!ready || (!hasProject && AdoptedPath == null) || documents.Length == 0)
            {
                OpenAtStartup(paths);
                return;
            }
            NativeDocumentCopyRows(documents);
            var other = paths.Where(path => !Policy.NativeDocument(path)).ToArray();
            if (other.Length > 0) OpenAtStartup(other);
        }

        void ReadClipboardDocuments(int id)
        {
            var paths = (ui as INativeDocumentClipboard)?.ReadDocumentPaths();
            var documents = paths?.Where(path => Policy.NativeDocument(path) && translators.AcceptsExisting(fs, path)).Take(32).ToArray();
            if (documents == null || documents.Length == 0) Reply(id, new Map());
            else NativeDocumentCopyRows(documents, id);
        }
    }
}
