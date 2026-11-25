// WebView capabilities for folder projects. Only a native chooser or an OS Open event can
// establish a directory grant or a selected attachment handle.
using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Threading;

namespace Waffle.Windows
{
    using Map = Dictionary<string, object>;

    public interface IFolderUi { void PickFolder(bool create, Action<string> done); }

    internal sealed class FolderWatch : IDisposable
    {
        readonly FileSystemWatcher watcher;
        readonly Timer timer;
        readonly string root, manifest;
        readonly Action<long, string[], bool> notify;
        readonly object gate = new object();
        readonly HashSet<string> paths = new HashSet<string>(StringComparer.Ordinal);
        bool overflow, closed; long sequence;
        internal FolderWatch(string root, string manifest, Action<long, string[], bool> notify)
        {
            this.root = root.TrimEnd(Path.DirectorySeparatorChar) + Path.DirectorySeparatorChar; this.manifest = manifest; this.notify = notify;
            timer = new Timer(_ => Publish(), null, Timeout.Infinite, Timeout.Infinite);
            watcher = new FileSystemWatcher(root) { IncludeSubdirectories = true, NotifyFilter = NotifyFilters.FileName | NotifyFilters.DirectoryName | NotifyFilters.LastWrite | NotifyFilters.Size };
            watcher.Changed += (s, e) => Changed(e.FullPath); watcher.Created += (s, e) => Changed(e.FullPath);
            watcher.Deleted += (s, e) => Changed(e.FullPath); watcher.Renamed += (s, e) => { Changed(e.OldFullPath); Changed(e.FullPath); };
            watcher.Error += (s, e) => Changed(null);
            try { watcher.EnableRaisingEvents = true; } catch { Dispose(); throw; }
        }
        void Changed(string full)
        {
            lock (gate)
            {
                if (closed) return;
                if (full == null || !full.StartsWith(root, StringComparison.OrdinalIgnoreCase)) overflow = true;
                else
                {
                    var p = full.Substring(root.Length).Replace(Path.DirectorySeparatorChar, '/');
                    if (p.Split('/').Any(n => n.StartsWith(".waffle-install-", StringComparison.Ordinal))) return;
                    if (p == ".waffle" || (p.StartsWith(".waffle/", StringComparison.OrdinalIgnoreCase) &&
                        !p.StartsWith(".waffle/imports/", StringComparison.Ordinal) && p != ".waffle/.gitignore")) return;
                    try
                    {
                        if (FolderFormat.Authored(p, manifest))
                        {
                            if (paths.Count < 512) paths.Add(p); else overflow = true;
                        }
                        else if (!Path.HasExtension(p) && !p.Split('/').Any(n => n.StartsWith(".", StringComparison.Ordinal))) overflow = true;
                        else return;
                    }
                    catch (HostError) { return; }
                }
                timer.Change(100, Timeout.Infinite);
            }
        }
        void Publish()
        {
            string[] changed; bool lost; long seq;
            lock (gate) { if (closed) return; changed = paths.OrderBy(s => s, StringComparer.Ordinal).ToArray(); lost = overflow; overflow = false; paths.Clear(); seq = ++sequence; }
            notify(seq, changed, lost);
        }
        public void Dispose() { lock (gate) { closed = true; } watcher.Dispose(); timer.Dispose(); }
    }

    public sealed partial class Host
    {
        sealed class FolderGrant
        {
            internal FolderProject Project;
            internal FolderWatch Watch;
            internal NotebookDropOffer Drop;
            internal string DropOwner;
            internal long DropEpoch;
            internal long Sequence;
            internal readonly CancellationTokenSource Cancellation = new CancellationTokenSource();
            internal readonly Dictionary<string, Stream> Selected = new Dictionary<string, Stream>();
        }
        readonly Dictionary<string, FolderGrant> folders = new Dictionary<string, FolderGrant>();
        volatile string adoptedFolder;
        readonly HashSet<string> collaborationWriters = new HashSet<string>(StringComparer.Ordinal);
        CancellationTokenSource mediaPage = new CancellationTokenSource();
        readonly SemaphoreSlim mediaWork = new SemaphoreSlim(2);
        void DecodeNotebook(int id, Map request)
        {
            int generation = pageGeneration;
            var cancellation = mediaPage.Token;
            var renderer = fs as INotebookMedia ?? throw new HostError("This Windows media decoder is unavailable.");
            if (!mediaWork.Wait(0)) throw new HostError("Another notebook image is decoding. Retry shortly.");
            ui.Background(() =>
            {
                try
                {
                    var image = renderer.Decode(request, NotebookInput.Bytes(request), cancellation);
                    ui.Main(() => { if (pageGeneration == generation) Reply(id, image); });
                }
                catch (Exception ex) { ui.Main(() => { if (pageGeneration == generation) Reply(id, null, Message(ex)); }); }
                finally { mediaWork.Release(); }
            });
        }
        internal FolderProject FolderService(string grant) =>
            grant != null && folders.TryGetValue(grant, out var selected) ? selected.Project : throw new HostError("Open a folder project first.");

        string AdoptedPath => adoptedFolder != null && folders.TryGetValue(adoptedFolder, out var g) ?
            Path.Combine(g.Project.Root, g.Project.Manifest) : null;

        internal string AdoptedProjectIdentity => adoptedFolder is string grant && folders.TryGetValue(grant, out var folder) ?
            folder.Project.WorkspaceIdentity : null;

        public bool IsWorkspaceFolder(string project, string grant) => project != null && grant != null && grant == adoptedFolder &&
            folders.TryGetValue(grant, out var folder) && folder.Project.WorkspaceIdentity == project;

        void ReleaseFolderLocks(string grant)
        {
            if (grant == null || !collaborationWriters.Remove(grant) || !folders.TryGetValue(grant, out var selected)) return;
            var path = Path.Combine(selected.Project.Root, selected.Project.Manifest);
            collab.Post(() => locks.RemoveOwn(path));
        }

        void Retire(FolderGrant grant)
        {
            CancelNotebookDrop(grant); grant.Cancellation.Cancel(); grant.Watch?.Dispose();
            foreach (var s in grant.Selected.Values) s.Dispose(); grant.Selected.Clear();
            grant.Project.BeginClose(); ui.Background(grant.Project.Dispose);
        }
        void ClearFolders()
        {
            mediaPage.Cancel(); mediaPage = new CancellationTokenSource();
            ReleaseFolderLocks(adoptedFolder);
            foreach (var g in folders.Values) Retire(g);
            folders.Clear(); adoptedFolder = null;
        }
        void Register(FolderProject project, int generation)
        {
            if (folders.Count >= 8) throw new HostError("Close an open folder project first.");
            var grant = new FolderGrant { Project = project };
            grant.Watch = new FolderWatch(project.Root, project.Manifest, (seq, paths, overflow) => ui.Main(() =>
            {
                if (generation != pageGeneration || !folders.ContainsKey(project.Grant)) return;
                ui.Post(Json.Write(new Map { ["type"] = "folderChanged", ["grant"] = project.Grant, ["seq"] = ++grant.Sequence, ["paths"] = paths, ["overflow"] = overflow }));
            }));
            folders.Add(project.Grant, grant);
        }
        void CheckProjectSelection(string selection)
        {
            string path = selection;
            if (Policy.NativeDocumentName(path) && (!Policy.NativeDocument(path) || fs.Kind(path, out _) != EntryKind.File))
                throw new HostError("Choose a regular Waffle document file.");
            if (Directory.Exists(path))
            {
                var names = Directory.EnumerateFiles(path).Where(p => !Path.GetFileName(p).StartsWith(".",StringComparison.Ordinal) && Policy.IsProjectExtension(Policy.Extension(p))).Take(2).ToList();
                if (names.Count != 1) return;
                path = names[0];
            }
            if (!Policy.ProjectName(path)) return;
            if (Policy.Extension(path) == "atrium") throw new HostError(Policy.PreReleaseMessage);
            if (!File.Exists(path)) return;
            using (var stream = fs is IFolderPlatform native ? native.OpenRegular(path) : File.OpenRead(path))
            {
                var bytes = new byte[65536]; int used = 0, n;
                while (used < bytes.Length && (n = stream.Read(bytes,used,bytes.Length-used)) > 0) used += n;
                if (Policy.ObsoleteProject(bytes,used)) throw new HostError(Policy.PreReleaseMessage);
                stream.Position = 0;
                if (!FolderFormat.IsManifest(FolderFormat.Header(stream))) throw new HostError("Choose a Waffle folder-format project manifest.");
            }
        }

        bool TryOpenFolder(string path, int id, int generation)
        {
            if (!(fs is IFolderPlatform native) || !path.EndsWith(".waffle", StringComparison.OrdinalIgnoreCase)) return false;
            CheckProjectSelection(path);
            OfferFolder(path, id, true, null, generation);
            return true;
        }

        // Only native OS selection and a successfully published archive may call this entry point.
        internal void OfferFolder(string selection, int id, bool asFile = false, string newManifest = null, int? expectedGeneration = null, string selectedDocument = null, string memberPath = null)
        {
            var native = fs as IFolderPlatform ?? throw new HostError("Folder projects are unavailable here.");
            int generation = expectedGeneration ?? pageGeneration;
            var cancellation = mediaPage.Token;
            ui.Background(() =>
            {
                FolderProject project = null;
                try
                {
                    if (newManifest == null) CheckProjectSelection(selection);
                    bool directory = Directory.Exists(selection);
                    string root = directory ? selection : Path.GetDirectoryName(selection);
                    string name = newManifest ?? (directory ? FolderProject.SelectedManifest(native, root) : Path.GetFileName(selection));
                    if (selectedDocument != null)
                    {
                        var owner = FindDocumentOwner(native, selectedDocument);
                        if (owner == null || owner.Manifest != selection || owner.MemberPath != memberPath)
                            throw new HostError("The selected document's project changed. Reopen it.");
                    }
                    project = new FolderProject(native, root, name);
                    if (newManifest != null)
                    {
                        if (Directory.EnumerateFileSystemEntries(root).Any()) throw new HostError("Choose an empty folder for the new project.");
                    }
                    else
                    {
                        bool detected = project.Detect();
                        if (!detected && File.Exists(Path.Combine(root, name))) throw new HostError("Choose a Waffle folder-format project manifest.");
                        if (selectedDocument == null)
                        {
                            try { project.Recover(); }
                            catch (FolderConflict) { /* The grant also serves the explicit conflict review. */ }
                        }
                        if (!detected && !project.Detect()) throw new HostError("Select a folder containing a format 2 project.");
                    }
                    var opened = project;
                    var pending = cancellation.Register(() => { opened.BeginClose(); ui.Background(opened.Dispose); });
                    ui.Main(() =>
                    {
                        pending.Dispose();
                        if (cancellation.IsCancellationRequested || generation != pageGeneration) { opened.Dispose(); return; }
                        try
                        {
                            Register(opened, generation);
                            var file = new Map { ["name"] = selectedDocument == null ? opened.Manifest : Path.GetFileName(selectedDocument),
                                                 ["folderProject"] = opened.Info };
                            if (memberPath != null) file["memberPath"] = memberPath;
                            Reply(id, asFile ? (object)new List<object> { file } : opened.Info);
                        }
                        catch (Exception e) { opened.Dispose(); openingProject = false; Reply(id, null, Message(e)); }
                    });
                }
                catch (Exception e)
                {
                    project?.Dispose();
                    ui.Main(() => { if (generation == pageGeneration) { if (asFile) openingProject = false; Reply(id, null, Message(e)); } });
                }
            });
        }

        void ChooseFolder(int id, Map request)
        {
            if (!(ui is IFolderUi dialogs) || !(fs is IFolderPlatform native)) throw new HostError("Folder projects are unavailable here.");
            string mode = Str(request, "mode"); if (mode != "open" && mode != "create") throw FolderFormat.Invalid("chooser mode");
            string hint = Str(request, "name");
            if (hint != null) FolderFormat.PathName(hint);
            int generation = pageGeneration;
            dialogs.PickFolder(mode == "create", root =>
            {
                if (generation != pageGeneration) return;
                if (root == null) { Reply(id, false); return; }
                string suggested = hint ?? new DirectoryInfo(root).Name;
                if (!suggested.EndsWith(".waffle", StringComparison.OrdinalIgnoreCase)) suggested += ".waffle";
                OfferFolder(root, id, false, mode == "create" ? suggested : null);
            });
        }
        void FolderAction(int id, string action, Map r)
        {
            if (action == "chooseProjectFolder") { ChooseFolder(id, r); return; }
            var key = Str(r, "grant");
            if (key == null || !folders.TryGetValue(key, out var g)) throw new HostError("Open a folder project first.");
            int generation = pageGeneration;
            bool Current() => generation == pageGeneration && folders.ContainsKey(key);
            if (action.StartsWith("notebookDrop", StringComparison.Ordinal)) { NotebookDropAction(id, action, key, g, r); return; }
            if (action == "folderClose")
            {
                ReleaseFolderLocks(key);
                folders.Remove(key);
                if (adoptedFolder == key) adoptedFolder = null;
                foreach (var ticket in documentCopyReceipts.Where(entry => entry.Value.Scope == key).Select(entry => entry.Key).ToArray())
                    documentCopyReceipts.Remove(ticket);
                Retire(g);
                Reply(id, true);
                return;
            }
            if (action == "folderStatus") { Reply(id, g.Project.Status()); return; }
            if (action == "folderAdopt")
            {
                if (adoptedFolder != key) ReleaseFolderLocks(adoptedFolder);
                if (adoptedFolder != null && folders.TryGetValue(adoptedFolder, out var previous))
                { CancelNotebookDrop(previous); previous.DropOwner = null; }
                ResetImportedSave(); pendingImportTokens.Clear();
                gitSource = pickedHistory = null; adoptedFolder = key; hasProject = true;
                NoteRecent(AdoptedPath); Reply(id, true); return;
            }
            if (action == "folderPickAsset")
            {
                var owner = FolderFormat.Id(Str(r, "ownerId"));
                var types = r.ContainsKey("mediaTypes") ? (FolderFormat.Get(r, "mediaTypes") as List<object>)?.Select(v => v as string).ToArray() : FolderProject.Types;
                if (types == null || types.Length == 0 || types.Length > FolderProject.Types.Length) throw FolderFormat.Invalid("attachment types");
                var extensions = types.SelectMany(FolderProject.AssetExtensions).Distinct().ToArray();
                ui.PickOpen(new OpenRequest { Multiple = false, Title = "Choose an attachment", Extensions = extensions }, paths =>
                {
                    if (!Current()) return;
                    if (paths == null || paths.Count != 1) { Reply(id, false); return; }
                    var selectedPath = paths[0];
                    ui.Background(() =>
                    {
                        Stream input = null;
                        try
                        {
                            input = ((IFolderPlatform)fs).OpenRegular(selectedPath);
                            string media = FolderProject.MediaOf(input);
                            if (!types.Contains(media)) throw FolderFormat.Invalid("selected media type");
                            var held = input;
                            var pending = g.Cancellation.Token.Register(held.Dispose);
                            ui.Main(() =>
                            {
                                pending.Dispose();
                                if (!Current()) { held.Dispose(); return; }
                                if (g.Selected.Count >= 64) { held.Dispose(); Reply(id, null, "Finish or cancel a pending attachment."); return; }
                                string token = Guid.NewGuid().ToString("D");
                                g.Selected.Add(owner + "\n" + media + "\n" + token, held);
                                Reply(id, new Map { ["sourceToken"] = token, ["name"] = Path.GetFileName(selectedPath), ["mediaType"] = media });
                            });
                        }
                        catch (Exception e) { input?.Dispose(); ui.Main(() => { if (Current()) Reply(id, null, Message(e)); }); }
                    });
                }); return;
            }
            if (action == "folderDropAsset" && Str(r, "sourceToken") is string drop)
            {
                var selected = g.Selected.Keys.FirstOrDefault(p => p.EndsWith("\n" + drop, StringComparison.Ordinal));
                if (selected != null) { g.Selected[selected].Dispose(); g.Selected.Remove(selected); }
            }
            NotebookClipboardItem paste = null;
            string clipboardOwner = null;
            if (action == "notebookPaste")
            {
                if (adoptedFolder != key) throw new HostError("Open this folder in the editor first.");
                clipboardOwner = FolderFormat.Id(Str(r, "ownerId"));
                paste = (ui as INotebookClipboard)?.ReadNotebookClipboard();
                if (paste == null) { Reply(id, false); return; }
            }
            Stream selection = null;
            if (action == "folderStageAsset")
            {
                string selected = Str(r, "ownerId") + "\n" + Str(r, "mediaType") + "\n" + Str(r, "sourceToken");
                if (!g.Selected.TryGetValue(selected, out selection)) throw new HostError("Choose the attachment again.");
                g.Selected.Remove(selected);
            }
            List<(DocumentCopyReceipt Receipt, string Path, bool Remove)> copied = null;
            var copies = action == "folderCommit" ? AuthorisedDocumentCopies(r, key, out copied) : null;
            ui.Background(() =>
            {
                Action apply = null;
                try
                {
                    object result;
                    switch (action)
                    {
                        case "folderReadLease": result = g.Project.AcquireLease(); break;
                        case "folderRead": result = g.Project.Read(Str(r, "lease"), FolderFormat.Get(r, "paths") as List<object>); break;
                        case "folderRelease": result = g.Project.Release(Str(r, "lease")); break;
                        case "folderCommit": result = g.Project.Commit(r, out apply, nativeCopyHashes: copies); break;
                        case "folderConflict": result = g.Project.Conflict(); break;
                        case "folderConflictRead": result = g.Project.ConflictRead(r); break;
                        case "folderResolve": result = g.Project.Resolve(r, out apply); break;
                        case "notebookPaste": result = g.Project.PasteNotebook(clipboardOwner, paste); break;
                        case "notebookDerivative": result = g.Project.Derivative(r); break;
                        case "notebookTransfer": result = g.Project.Transfer(r); break;
                        case "notebookClip":
                            var renderer = fs as INotebookMedia ?? throw new HostError("This Windows PDF decoder is unavailable.");
                            if (!mediaWork.Wait(0)) throw new HostError("Another notebook image is decoding. Retry shortly.");
                            try { result = g.Project.Clip(renderer, r, g.Cancellation.Token); } finally { mediaWork.Release(); }
                            break;
                        case "folderDraftAssetProof": case "folderRestoreDraftAsset":
                            result = g.Project.DraftAsset(r, action == "folderRestoreDraftAsset", supportFolder); break;
                        case "folderStageAsset": result = g.Project.StageAsset(Str(r, "ownerId"), Str(r, "mediaType"), selection); break;
                        case "folderDropAsset": result = g.Project.DropAsset(Str(r, "assetToken")); break;
                        case "folderReadAsset": result = g.Project.ReadAsset(r); break;
                        case "folderLocalState": result = g.Project.LocalState(r); break;
                        default: throw new HostError("Unknown folder action.");
                    }
                    ui.Main(() =>
                    {
                        if (!Current()) return;
                        if (copied != null && result is Map committed && Equals(FolderFormat.Get(committed, "saved"), true))
                            NoteDocumentCopies(copied);
                        Reply(id, result);
                    });
                }
                catch (Exception e) { ui.Main(() => { if (Current()) Reply(id, null, Message(e)); }); }
                finally
                {
                    selection?.Dispose();
                    if (apply != null) ui.Background(() =>
                    {
                        apply(); var status = (Map)g.Project.Status();
                        ui.Main(() =>
                        {
                            if (Current()) ui.Post(Json.Write(new Map
                            {
                                ["type"] = "folderChanged",
                                ["grant"] = key,
                                ["seq"] = ++g.Sequence,
                                ["paths"] = status["paths"],
                                ["overflow"] = false,
                                ["status"] = status
                            }));
                        });
                    });
                }
            });
        }
    }
}
