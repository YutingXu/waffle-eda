// The bridge protocol (native/bridge.js) on the host side, independent of WebView2 and Win32.
// It follows native/macos/main.swift action by action. The window supplies IHostUi (dialogs,
// clipboard, threads, posting to the page) and IGitRunner (python3 native/git_head.py).
using System;
using System.Linq;
using System.Collections.Generic;
using System.Text;
using System.Text.RegularExpressions;

namespace Waffle.Windows
{
    public sealed class OpenRequest
    {
        public bool Multiple;
        public string Title;
        public IList<string> Extensions; // lower case, no dot; File › Open uses the bundled registry
    }

    public sealed class SaveRequest
    {
        public string Title;
        public string FileName;
        public string Extension; // lower case, no dot
    }

    /// The close prompt's answer (Dialogs.AskToSave).
    public enum CloseChoice { Save, DontSave, Cancel }

    public interface IHostUi
    {
        /// Shows an open dialog; done(null) on cancel. Called and answered on the UI thread.
        void PickOpen(OpenRequest request, Action<IList<string>> done);
        void OpenProjectWindow(IList<string> paths);
        /// Shows a save dialog (with overwrite confirmation); done(null) on cancel.
        void PickSave(SaveRequest request, Action<string> done);
        /// Posts a JSON message to the editor page.
        void Post(string json);
        void SetDirty(bool dirty);
        bool WriteClipboard(string custom, string text);
        void ReadClipboard(out string custom, out string text);
        void Background(Action work);
        void Main(Action work);
        /// The shell's own recent documents (Explorer's Recent list); optional.
        void NoteShellRecent(string path);
    }

    public sealed class GitResult
    {
        public int ExitCode;
        public byte[] Output;
        public string Errors;
    }

    public interface IGitRunner
    {
        /// Runs native/git_head.py with these arguments; throws HostError when Python is missing.
        GitResult Run(IList<string> arguments);
    }

    public interface IAICredentialUi
    {
        object ProviderCredential(string operation, string provider);
    }

    public sealed partial class Host
    {
        readonly IHostFs fs;
        readonly IHostUi ui;
        readonly IGitRunner git;
        readonly TranslatorFiles translators;
        readonly string supportFolder;
        // Lock and presence sidecars (CollabLocks): their own queue, so a slow share never delays a save.
        readonly SerialQueue collab = new SerialQueue();
        readonly CollabLocks locks;
        public readonly RecentProjects Recent;
        readonly LibraryReads libraryReads;
        // run:external (ExternalTools.cs): the window's dialogs; null means programs cannot be run here.
        public IExternalUi ExternalUi;
        readonly ExternalTools external;
        int pageGeneration;
        KeyValuePair<string, string>? pickedHistory, gitSource;
        AltiumCopySource selectedSource;
        List<string> incoming = new List<string>();
        bool hasProject, openingProject;
        string importingProject;
        bool ready;
        bool discardApproved;
        string foreignImportId, foreignCloseRequested;
        // Save chosen on the close prompt: runs once the page reports that save finished, clean.
        Action closeAfterSave;
        bool editorFailed;
        const string CrashLog = "renderer-crashes.json";
        const int CrashLimit = 32;

        public bool Dirty { get; private set; }
        /// The page's project name (its "dirty" reports); null with no project open.
        public string ProjectName { get; private set; }
        public string DesignPath => AdoptedPath;
        public CollabLocks Locks => locks;
        public void WaitForCollab() => collab.Wait();

        readonly Func<string> supportArchitecture;

        public Host(IHostFs fs, IHostUi ui, IGitRunner git, string supportFolder, TranslatorFiles translators,
                    RecentProjects recent = null, Func<string> supportArchitecture = null)
        {
            this.fs = fs;
            this.ui = ui;
            this.git = git;
            this.translators = translators;
            this.supportArchitecture = supportArchitecture;
            this.supportFolder = supportFolder;
            Recent = recent ?? new RecentProjects(fs, supportFolder);
            libraryReads = new LibraryReads(fs, supportFolder);
            locks = new CollabLocks(fs, supportFolder);
            external = new ExternalTools(supportFolder, fs);
        }

        string SupportArchitecture()
        {
            var architecture = supportArchitecture?.Invoke();
            return architecture == "x64" || architecture == "arm64" ? architecture : "unknown";
        }

        // ------------------------------------------------------------------ window events

        /// A project named on the command line (or chosen in Open Recent) opens through the
        /// page's own "open" command, exactly like a file opened from Finder on macOS.
        public void OpenAtStartup(string path) => OpenAtStartup(new[] { path });
        public void OpenAtStartup(IList<string> paths)
        {
            var accepted = new List<string>(paths).FindAll(path => fs.IsAbsolute(path) && (Policy.NativeDocumentName(path) ? Policy.NativeDocument(path) && fs.Kind(path, out _) == EntryKind.File :
                Policy.ProjectName(path) || translators.Accepts(path) || (fs is IFolderPlatform && System.IO.Directory.Exists(path))));
            if (accepted.Count == 0) return;
            incoming = accepted;
            if (ready) Command("open");
        }

        public void PageReady() { if (editorFailed) return; ready = true; if (incoming.Count > 0) Command("open"); }

        public void PageGone()
        {
            ready = false; pageGeneration++; ButterDropEnabled=false; typedDrop=null; ResetImportedSave(); pendingImportTokens.Clear(); ClearFolders(); ClearNativeDocuments(); pickedHistory = gitSource = null;
            closeAfterSave = null; foreignCloseRequested = foreignImportId = null;
        }

        List<Dictionary<string, object>> CrashHistory()
        {
            var log = HostLists.Load(fs, supportFolder, CrashLog, 16 * 1024);
            if (log.Count > CrashLimit) log.RemoveRange(0, log.Count - CrashLimit);
            return log;
        }

        static string CrashCounter(string reason)
        {
            return reason switch { "exited" => "exited", "unresponsive" => "unresponsive", "browser-exited" => "browserExited", _ => null };
        }

        Dictionary<string, object> CrashCounts()
        {
            var counts = new Dictionary<string, object> { { "exited", 0 }, { "unresponsive", 0 }, { "browserExited", 0 } };
            foreach (var row in CrashHistory())
            {
                if (Str(row, "kind") != "renderer" || Str(row, "type") != "Windows") continue;
                var key = CrashCounter(Str(row, "reason"));
                if (key != null) counts[key] = (int)counts[key] + 1;
            }
            return counts;
        }

        public void RecordProcessFailure(string reason)
        {
            if (CrashCounter(reason) == null) return;
            var log = CrashHistory();
            if (log.Count == CrashLimit) log.RemoveAt(0);
            log.Add(new Dictionary<string, object> {
                { "at", DateTimeOffset.UtcNow.ToUnixTimeMilliseconds() }, { "kind", "renderer" }, { "type", "Windows" }, { "reason", reason }
            });
            HostLists.Store(fs, supportFolder, CrashLog, log);
        }

        public void EditorFailed() { PageGone(); editorFailed = true; }

        public void Command(string action)
        {
            if (!ready) return;
            ui.Post(Json.Write(new Dictionary<string, object> { { "command", action } }));
        }

        public void PauseExtensions() => Command("pause-extensions");

        public bool OpenRecent(string path)
        {
            try { incoming = new List<string> { Recent.Allowed(path) }; }
            catch (HostError) { return false; }
            Command("open");
            return true;
        }

        public void ClearRecent() => Recent.Clear();

        /// "Do you want to save changes to NAME?", the Windows close prompt's question.
        public static string SavePrompt(string projectName)
        {
            var name = (projectName ?? "").Trim();
            if (name.Length > 160) name = name.Substring(0, 160);
            return "Do you want to save changes to " + (name.Length == 0 ? "Untitled" : name) + "?";
        }

        /// Close: true when the window may close now. ask shows the close prompt (Save, Don't Save,
        /// Cancel). Don't Save closes, keeping the recovery sidecar for draft recovery. Save runs the
        /// page's own Save (in place, or its save dialog) and keeps the window for now: closeAfterSave
        /// runs once the page reports that save finished with the project clean. A cancelled dialog or
        /// a failed save keeps the window and its changes, and a later ordinary save never closes it.
        /// A failed editor page is never asked to save.
        public bool OkayToClose(Func<CloseChoice> ask, Action closeAfterSave)
        {
            if (!Dirty || discardApproved || editorFailed) return true;
            if (this.closeAfterSave != null) return false;   // a save for closing is still running
            if (foreignImportId != null)
            {
                if (!ready) return false;
                foreignCloseRequested = foreignImportId;
                this.closeAfterSave = closeAfterSave;
                ui.Post(Json.Write(new Dictionary<string, object> { { "command", "review-foreign-close" }, { "importId", foreignImportId } }));
                return false;
            }
            switch (ask())
            {
                case CloseChoice.DontSave:
                    discardApproved = true;
                    return true;
                case CloseChoice.Save:
                    if (!ready) return false;
                    this.closeAfterSave = closeAfterSave;
                    Command("save-for-close");
                    return false;
                default:
                    return false;
            }
        }

        public void Closing()
        {
            PageGone();
            collab.Wait();
        }

        // ------------------------------------------------------------------ replies

        void Reply(int id, object value = null, string error = null)
        {
            var message = new Dictionary<string, object> { { "id", id }, { "result", value }, { "error", error } };
            if (error == Policy.PreReleaseMessage) message["code"] = "pre-release-format";
            ui.Post(Json.Write(message));
        }

        void ReplyLater(int id, object value = null, string error = null) => ui.Main(() => Reply(id, value, error));

        static string Message(Exception e) =>
            e is HostError || e is JsonException ? e.Message
            : e is UnauthorizedAccessException ? "Waffle does not have permission to use that file."
            : e is System.IO.IOException ? (e.Message.Length > 0 ? e.Message : "The file could not be read or written.")
            : "The file could not be read or written.";

        // run:external: the user picks the program or confirms a detected path, and approves each
        // program per extension version before its first run (any undeclared argument asks again).
        void ChooseExternal(int id, Dictionary<string, object> request)
        {
            var tool = Str(request, "toolId"); var name = Str(request, "name") ?? ""; var path = Str(request, "path");
            if (ExternalUi == null) throw new HostError("External tools are not available in this build.");
            if (tool == null || !ExternalTools.ToolId.IsMatch(tool)) throw new HostError("Invalid external tool.");
            var label = name.Length > 0 ? name : tool;
            Action<string> store = chosen => { try { Reply(id, chosen == null ? null : external.Choose(tool, name, chosen)); } catch (Exception e) { Reply(id, null, Message(e)); } };
            if (path != null)
            {
                if (!ExternalTools.Executable(path)) throw new HostError("That program was not found.");
                ExternalUi.Confirm("Use this program for " + label + "?", path, "Use", ok => store(ok ? path : null));
            }
            else ExternalUi.PickProgram("Choose the " + label + " program", store);
        }

        void RunExternal(int id, object value)
        {
            if (ExternalUi == null) throw new HostError("External tools are not available in this build.");
            var req = ExternalTools.Check(value);
            var path = external.PathOf(req.Tool);
            if (path == null) throw new HostError(req.ToolName + " is not set up. Choose it in Preferences \u203a External Tools.");
            if (!ExternalTools.Executable(path)) throw new HostError(req.ToolName + " was not found at " + path + ". Choose it again in Preferences \u203a External Tools.");
            path = fs.Canonical(path);
            var need = external.ApprovalNeeded(req, path);
            var ticket = external.Reserve(req);
            Action start = () => ui.Background(() =>
            {
                try { var result = external.Execute(path, req, ticket); ReplyLater(id, result); }
                catch (Exception e) { ReplyLater(id, null, e is HostError ? e.Message : "The program could not be run."); }
            });
            // Approval per extension version (id@sha256), tool and program, within the extension's declared
            // argument template; any other argument asks for the exact command (ExternalTools.cs).
            if (need == null) { start(); return; }
            ExternalUi.Confirm(need.Title, need.Detail, "Allow",
                ok =>
                {
                    if (ticket.Cancelled || !ok)
                    {
                        external.Release(ticket);
                        Reply(id, new Dictionary<string, object> { { ticket.Cancelled ? "cancelled" : "denied", true } });
                        return;
                    }
                    try { external.RecordApproval(req, need); start(); }
                    catch (Exception) { external.Release(ticket); Reply(id, error: "The external tool approval could not be saved."); }
                });
        }

        void NoteRecent(string path) { Recent.Note(path); try { ui.NoteShellRecent(fs.Canonical(path)); } catch (Exception) { } }

        // ------------------------------------------------------------------ messages

        static string Str(Dictionary<string, object> r, string key) { object v; return r.TryGetValue(key, out v) ? v as string : null; }
        static bool True(Dictionary<string, object> r, string key) => r.TryGetValue(key, out var value) && value is bool flag && flag;

        /// One message from the page. source is the sender's URL; only the editor page is heard.
        public void Receive(string source, string body)
        {
            if (editorFailed || !Policy.TrustedSource(source) || body == null || body.Length > 400 * 1024 * 1024) return;
            Dictionary<string, object> request;
            try { request = Json.Parse(body) as Dictionary<string, object>; }
            catch (JsonException) { return; }
            if (request == null) return;
            var action = Str(request, "action");
            if (action == null) return;
            switch (action)
            {
                case "butterDropEnabled":
                    ButterDropEnabled = True(request,"enabled");
                    if (!ButterDropEnabled) CancelTypedDrop();
                    return;
                case "butterDropCancel":
                    if (Str(request,"token") is string dropToken) CancelTypedDrop(dropToken);
                    return;
                case "butterDropFinish":
                    if (Str(request,"token") is string finishedDrop) CancelTypedDrop(finishedDrop,!True(request,"handled"));
                    return;
                case "finishedOpening":
                    if (importingProject != null && True(request, "success")) NoteRecent(importingProject);
                    importingProject = null; openingProject = false;
                    return;
                case "dirty":
                    reportedImportId=Str(request,"importId");
                    object d;
                    Dirty = request.TryGetValue("dirty", out d) && d is bool && (bool)d;
                    hasProject = request.ContainsKey("projectName") ? Str(request, "projectName") != null : Dirty || AdoptedPath != null;
                    ProjectName = Str(request, "projectName");
                    var importId = Str(request, "importId");
                    foreignImportId = !String.IsNullOrEmpty(importId) && importId.Length <= 160 ? importId : null;
                    discardApproved = false;
                    ui.SetDirty(Dirty);
                    return;
                case "foreignCloseReviewed":
                {
                    var expected = foreignCloseRequested;
                    if (expected == null || Str(request, "importId") != expected) return;
                    var close = closeAfterSave;
                    foreignCloseRequested = null; closeAfterSave = null;
                    if (close != null && True(request, "approved") && (foreignImportId == expected || foreignImportId == null && !Dirty))
                    { discardApproved = true; close(); }
                    return;
                }
                case "saveForClose":
                {
                    if (foreignCloseRequested != null) return;
                    // The page's "dirty" report comes first: close only a project left clean.
                    var close = closeAfterSave;
                    closeAfterSave = null;
                    if (close != null && True(request, "saved") && !Dirty) close();
                    return;
                }
                case "acceptHistorySource":
                    if (pickedHistory.HasValue && Str(request, "token") == pickedHistory.Value.Key)
                    { gitSource = pickedHistory; pickedHistory = null; }
                    return;
                case "bindRestoredImportSave": BindRestoredChoice(request); return;
                case "bindImportSave": BindImportedSave(request); return;
                case "cancelImportSave": CancelImported(Str(request,"operation")); return;
                case "clearGitProject":
                    ResetImportedSave();
                    gitSource = null;
                    ReleaseFolderLocks(adoptedFolder);
                    if (adoptedFolder != null && folders.TryGetValue(adoptedFolder, out var previous))
                    {
                        folders.Remove(adoptedFolder);
                        Retire(previous);
                    }
                    adoptedFolder = null;
                    return;
                case "externalCancel":
                    external.Cancel(Str(request, "runId"));
                    return;
            }
            object rawId;
            if (!request.TryGetValue("id", out rawId) || !(rawId is double)) return;
            double idValue = (double)rawId;
            if (idValue < 1 || idValue > int.MaxValue || idValue != Math.Floor(idValue)) return;
            int id = (int)idValue;
            try { Dispatch(id, action, request); }
            catch (Exception e) { Reply(id, null, Message(e)); }
        }

        partial void ArchiveAction(int id,string action,Dictionary<string,object> request,ref bool handled);

        public Action<Dictionary<string,object>,Action<object,string>> WorkspaceMessage { get; set; }

        void Dispatch(int id, string action, Dictionary<string, object> request)
        {
            switch (action)
            {
                case "reselectImportSave": case "importSaveChoice": case "writeImportExport": case "rememberImportExport": case "recalledImportExport": case "forgetImportExport":
                    ImportedSaveAction(id,action,request); return;
                case "folderReadImportSource": case "installProjectArchive": case "folderConvertSibling":
                    bool handled=false; ArchiveAction(id,action,request,ref handled);
                    if(!handled) Reply(id,null,"Project source and archive integration is unavailable.");
                    return;
                case "butterDropTake": TakeTypedDrop(id,request); return;
                case "workspaceWindow":
                    if (!ready || WorkspaceMessage == null) throw new HostError("Project windows need a ready native editor.");
                    var page = pageGeneration;
                    WorkspaceMessage(request, (value,error) => { if (page == pageGeneration) Reply(id,value,error); });
                    return;
                case "notebookMedia": DecodeNotebook(id,request); return;
                case "notebookTransfer": case "notebookClip": case "notebookDerivative": case "notebookPaste":
                case "notebookDropTarget": case "notebookDropAccept": case "notebookDropCancel": case "notebookDrop":
                case "chooseProjectFolder": case "folderReadLease": case "folderRead": case "folderRelease":
                case "folderCommit": case "folderStatus": case "folderClose": case "folderLocalState":
                case "folderStageAsset": case "folderDropAsset": case "folderReadAsset": case "folderPickAsset":
                case "folderDraftAssetProof": case "folderRestoreDraftAsset":
                case "folderConflict": case "folderConflictRead": case "folderResolve": case "folderAdopt":
                    FolderAction(id, action, request); return;
                case "crashHistory": Reply(id, CrashHistory()); return;
                case "supportDiagnostics": Reply(id, new Dictionary<string, object> {
                    { "platform", "windows" }, { "architecture", SupportArchitecture() }, { "rendererTerminations", CrashCounts() }
                }); return;
                case "aiCredential":
                    var provider = Str(request, "provider");
                    var operation = Str(request, "operation");
                    if (string.IsNullOrEmpty(provider) || provider.Length > 192 || !Regex.IsMatch(provider, @"\A[A-Za-z0-9_.-]+:[a-z][a-z0-9-]{0,39}:[a-f0-9]{64}\z") ||
                        !(operation == "status" || operation == "configure" || operation == "forget" || operation == "load"))
                        throw new HostError("Invalid provider credential request.");
                    if (!(ui is IAICredentialUi keychain)) throw new HostError("The system credential manager is unavailable.");
                    Reply(id, keychain.ProviderCredential(operation, provider)); return;
                case "externalToolList": Reply(id, external.Listing()); return;
                case "externalToolProbe": Reply(id, external.Probe(request.TryGetValue("paths", out var externalPaths) ? externalPaths : null)); return;
                case "externalToolForget": external.Forget(Str(request, "toolId")); Reply(id, true); return;
                case "externalToolChoose": ChooseExternal(id, request); return;
                case "externalRun": RunExternal(id, request.TryGetValue("run", out var externalRequest) ? externalRequest : null); return;
                case "writeSelection":
                {
                    var data = Str(request, "data");
                    var summary = Str(request, "summary");
                    if (data == null || Policy.Utf8Length(data) > Policy.SelectionCap || summary == null || summary.Length >= Policy.SummaryCap)
                    { Reply(id, null, "Invalid clipboard selection."); return; }
                    // The typed text fallback survives clipboard managers and works across platforms.
                    Reply(id, ui.WriteClipboard(data, summary + Policy.SelectionMarker + data));
                    return;
                }
                case "readSelection":
                {
                    string custom, text;
                    ui.ReadClipboard(out custom, out text);
                    if (custom != null && Policy.Utf8Length(custom) <= Policy.SelectionCap)
                        Reply(id, new Dictionary<string, object> { { "data", custom } });
                    else if (text != null && text.StartsWith("Waffle ", StringComparison.Ordinal) &&
                             Policy.Utf8Length(text) <= Policy.SelectionCap + 512 && text.Contains(Policy.SelectionMarker))
                        Reply(id, new Dictionary<string, object> { { "text", text } });
                    else ReadClipboardDocuments(id);
                    return;
                }
                case "gitHistory": case "gitHead": case "gitRevision":
                    ReadGit(id, action, Str(request, "token"), Str(request, "revision"));
                    return;
                case "gitQuery":
                {
                    object args;
                    request.TryGetValue("args", out args);
                    QueryGit(id, Str(request, "token"), Str(request, "op"), args);
                    return;
                }
                case "nativeMemberCommit":
                case "nativeMemberExportCopy":
                case "nativeMemberClose": NativeDocumentAction(action, id, request); return;
                case "open": case "pick":
                    Open(id, action, request);
                    return;
                case "exportBinaryCopy":
                    ExportBinaryCopy(id, request);
                    return;
                case "printPDF":
                    // WebView2 prints the mounted pages in-page (bridge.js calls window.print()).
                    Reply(id, null, "Printing is unavailable.");
                    return;
                case "export":
                    Export(id, request);
                    return;
                case "collabLocks": case "collabLockWrite": case "collabLockRemove":
                {
                    var grant = Str(request, "grant");
                    var project = AdoptedPath;
                    if (project == null || grant == null || grant != adoptedFolder)
                    { Reply(id, null, "The active Waffle project changed."); return; }
                    var folder = FolderService(grant);
                    var generation = pageGeneration;
                    object key, data, mode;
                    request.TryGetValue("key", out key); request.TryGetValue("data", out data); request.TryGetValue("mode", out mode);
                    if (action == "collabLockWrite") collaborationWriters.Add(grant);
                    collab.Post(() =>
                    {
                        try
                        {
                            if (grant != adoptedFolder) throw new HostError("The active Waffle project changed.");
                            object result = folder.WithCollaboration(() => action == "collabLocks" ? locks.Listing(project)
                                : action == "collabLockWrite" ? locks.Write(project, key, data, mode)
                                : locks.Remove(project, key, false));
                            ui.Main(() =>
                            {
                                if (generation != pageGeneration) return;
                                if (grant == adoptedFolder) Reply(id, result);
                                else Reply(id, null, "The active Waffle project changed.");
                            });
                        }
                        catch (Exception e) { ui.Main(() => { if (generation == pageGeneration) Reply(id, null, Message(e)); }); }
                    });
                    return;
                }
                case "recoverySession": Reply(id, null); return;
                case "recentFiles":
                    Reply(id, Recent.Listing(checkAvailability: !True(request, "metadataOnly")));
                    return;
                case "linkRecentProjects":
                {
                    var projectId = request.TryGetValue("projectId", out var entryId) ? entryId as string : null;
                    if (!WaffleLink.ValidIdentity(projectId)) throw new HostError("Choose a valid Waffle project identity.");
                    var entries = Recent.Listing().OfType<Dictionary<string, object>>().ToArray();
                    ui.Background(() =>
                    {
                        var matches = new List<object>();
                        if (fs is IFolderPlatform platform)
                        {
                            foreach (var entry in entries)
                            {
                                var path = entry["path"] as string;
                                if (path == null || !path.EndsWith(".waffle", StringComparison.OrdinalIgnoreCase)) continue;
                                try
                                {
                                    using (var file = platform.OpenRegular(path))
                                    {
                                        var header = FolderFormat.Header(file);
                                        if (FolderFormat.IsManifest(header) && FolderFormat.Text(header, "id") == projectId)
                                            matches.Add(entry);
                                    }
                                }
                                catch (Exception) { /* The remembered manifest is no longer readable. */ }
                            }
                        }
                        ReplyLater(id, matches);
                    });
                    return;
                }
                case "openRecent":
                    var allowed = new List<string> { Recent.Allowed(request.ContainsKey("path") ? request["path"] : null) };
                    if (True(request, "activate")) OpenDesignFiles(allowed, id); else ReadFiles(allowed, id, false, false);
                    return;
                case "readFile":
                {
                    var path = request.ContainsKey("path") ? request["path"] : null;
                    ui.Background(() =>
                    {
                        try { var file = libraryReads.Read(path); ReplyLater(id, file); }
                        catch (Exception e) { ReplyLater(id, null, Message(e)); }
                    });
                    return;
                }
                default:
                    Reply(id, null, "Unknown file action.");
                    return;
            }
        }

        void Open(int id, string action, Dictionary<string, object> request)
        {
            bool picking = action == "pick", detached = !picking && True(request, "into");
            if (!picking && !detached && incoming.Count > 0)
            {
                var files = incoming;
                incoming = new List<string>();
                OpenDesignFiles(files, id);
                return;
            }
            request.TryGetValue("extensions", out var requested);
            var types = picking ? Policy.Extensions(requested) : translators.OpenTypes(requested);
            if (picking && (types == null || types.Count == 0 || !types.TrueForAll(Policy.ExchangeInputs.Contains)))
            { Reply(id, null, "Unrecognised exchange file type."); return; }
            if (types.Count == 0) { Reply(id, null, "The import formats could not be loaded."); return; }
            // Library sources (.atrlib, .json) are remembered so they can be reloaded later.
            bool library = picking && types.Contains("atrlib") && types.TrueForAll(Policy.LibraryTypes.Contains);
            ui.PickOpen(new OpenRequest { Multiple = !picking, Title = "Open in Waffle", Extensions = types }, paths =>
            {
                if (paths == null || paths.Count == 0) { Reply(id, new List<object>()); return; }
                foreach (var p in paths)
                    if (Policy.Extension(p) == "atrium") { Reply(id, null, Policy.PreReleaseMessage); return; }
                    else if (!types.Contains(Policy.Extension(p))) { Reply(id, null, "Choose one of the requested document types."); return; }
                if (picking || detached) ReadFiles(paths, id, picking, library, detached: detached);
                else OpenDesignFiles(paths, id);
            });
        }

        void OpenDesignFiles(IList<string> paths, int id)
        {
            try { foreach (var path in paths) CheckProjectSelection(path); } catch (Exception e) { Reply(id,null,Message(e)); return; }
            if (fs is IFolderPlatform && paths.Count==1 && System.IO.Directory.Exists(paths[0])) {
                if(hasProject || openingProject || AdoptedPath!=null) { ui.OpenProjectWindow(paths); Reply(id,new List<object>()); return; }
                openingProject=true; OfferFolder(paths[0],id,true); return;
            }
            if (paths.Any(path => Policy.Extension(path) == "atrium")) { Reply(id, null, Policy.PreReleaseMessage); return; }
            if (paths.Any(path => !translators.Accepts(path))) { Reply(id, null, "Choose a file in a supported import format."); return; }
            bool independent = false;
            string manifest = null;
            int manifestCount = 0;
            foreach (var path in paths) {
                var ext = Policy.Extension(path);
                if (!translators.Library(ext)) independent = true;
                if (ext == "prjpcb") { manifest = path; manifestCount++; }
            }
            if (independent) {
                if (hasProject || openingProject || AdoptedPath != null) {
                    ui.OpenProjectWindow(paths);
                    Reply(id, new List<object>());
                    return;
                }
                openingProject = true;
                importingProject = manifestCount == 1 ? fs.Canonical(manifest) : null;
            }
            ReadFiles(paths, id, false, false, independent);
        }

        const int AltiumFileLimit = 1024, AltiumManifestCap = 8 * 1024 * 1024;
        static readonly HashSet<string> AltiumTypes = new HashSet<string> { "prjpcb", "schdoc", "pcbdoc", "schlib", "pcblib", "step", "stp" };
        void IncludeAltiumMembers(string manifest, byte[] bytes, IList<string> paths, List<object> files, long remaining, Dictionary<string,OriginalGrant> origins)
        {
            string text;
            if (bytes.Length >= 2 && bytes[0] == 0xff && bytes[1] == 0xfe) text = Encoding.Unicode.GetString(bytes);
            else if (bytes.Length >= 2 && bytes[0] == 0xfe && bytes[1] == 0xff) text = Encoding.BigEndianUnicode.GetString(bytes);
            else try { text = new UTF8Encoding(false, true).GetString(bytes); }
                catch (DecoderFallbackException) { text = Encoding.GetEncoding(1252).GetString(bytes); }
            string root = fs.Canonical(fs.Parent(manifest));
            var selected = new Dictionary<string, int>(fs.PathComparer);
            for (int i = 0; i < paths.Count; i++) selected[fs.Canonical(paths[i])] = i;
            var seen = new HashSet<string>(fs.PathComparer);
            bool documentSection = true;
            foreach (var line in text.TrimStart('\ufeff').Split('\r', '\n'))
            {
                string s = line.Trim();
                if (s.StartsWith("[")) { documentSection = Regex.IsMatch(s, @"^\[Document[0-9]+\]$", RegexOptions.IgnoreCase); continue; }
                int equals = s.IndexOf('=');
                if (!documentSection || equals < 0 || !s.Substring(0, equals).Trim().Equals("DocumentPath", StringComparison.OrdinalIgnoreCase)) continue;
                string relative = s.Substring(equals + 1).Trim();
                if (relative.Length >= 2 && relative[0] == '"' && relative[relative.Length - 1] == '"') relative = relative.Substring(1, relative.Length - 2);
                relative = relative.Replace('\\', '/');
                if (relative.Length > 4096 || relative.StartsWith("/") || relative.IndexOf(':') >= 0 ||
                    !Regex.IsMatch(relative, @"\.(SchDoc|PcbDoc|SchLib|PcbLib|step|stp)$", RegexOptions.IgnoreCase)) continue;
                string member;
                try { member = fs.CheckedPath(System.IO.Path.GetFullPath(fs.Join(root, relative))); } catch { continue; }
                if (member == null) continue;
                var parent = fs.Parent(member);
                while (parent != null && !fs.PathComparer.Equals(parent, root)) parent = fs.Parent(parent);
                if (parent == null || !seen.Add(member)) continue;
                int index;
                if (selected.TryGetValue(member, out index)) { ((Dictionary<string, object>)files[index])["altiumPath"] = relative; continue; }
                long size;
                if (fs.Kind(member, out size) != EntryKind.File) continue;
                if (files.Count >= AltiumFileLimit) throw new HostError("The Altium project has too many referenced documents.");
                if (size > remaining) throw new HostError("The referenced Altium documents exceed the desktop import size limit.");
                byte[] data;
                try { data = fs.ReadRegular(member, remaining).Bytes; } catch (Exception) { continue; }
                remaining -= data.Length;
                files.Add(new Dictionary<string, object> { { "name", fs.Name(member) }, { "altiumPath", relative }, { "retainedInputToken", RetainInput(origins,member,data) }, { "data", Convert.ToBase64String(data) } });
            }
        }

        void ReadFiles(IList<string> paths, int id, bool picking, bool library, bool opening = false, bool detached = false, string expectedKey = null, string operation = null)
        {
            int generation = pageGeneration;
            var copyTarget = detached ? adoptedFolder : null;
            ui.Background(() =>
            {
                var nativeCopies = new List<(Dictionary<string, object> File, string Sha)>();
                var origins = new Dictionary<string, OriginalGrant>();
                AltiumCopySource picked = null;
                KeyValuePair<string, string>? history = null;
                try
                {
                    if (paths.Count == 1 && Policy.IsProjectExtension(Policy.Extension(paths[0])) && TryOpenFolder(paths[0], id, generation)) return;
                    if (opening && !detached && paths.Count == 1 && Policy.NativeDocument(paths[0]) &&
                        TryOfferNativeDocument(paths[0], id, generation)) return;
                    foreach (var path in paths) CheckProjectSelection(path);
                    if (paths.Any(Policy.ProjectName)) throw new HostError("Open one Waffle project folder at a time.");
                    var result = new List<object>();
                    string manifest = null;
                    byte[] manifestBytes = null;
                    int manifestCount = 0, altiumCount = 0;
                    long remaining = Policy.ProjectReadCap;
                    if (!picking) foreach (var path in paths) if (AltiumTypes.Contains(Policy.Extension(path)) && ++altiumCount > AltiumFileLimit)
                        throw new HostError("Too many Altium documents were selected.");
                    foreach (var path in paths)
                    {
                        byte[] bytes;
                        var ext = Policy.Extension(path);
                        var canonical = fs.Canonical(path);
                        if (picking && Policy.SourceTypes.Contains(ext))
                        {
                            picked?.Dispose();
                            picked = new AltiumCopySource(fs, path);
                            bytes = picked.Read();
                        }
                        else if (Policy.NativeDocument(path)) bytes = fs.ReadRegular(path, remaining).Bytes;
                        else bytes = fs.ReadFile(path, !picking && ext == "prjpcb" ? Math.Min(remaining, AltiumManifestCap) : remaining);
                        if (bytes.Length > remaining) throw new HostError("The selected files exceed the import size limit.");
                        remaining -= bytes.Length;
                        var file = new Dictionary<string, object> { { "name", fs.Name(path) }, { "data", Convert.ToBase64String(bytes) } };
                        if (Policy.NativeDocument(path))
                        {
                            file["memberPath"] = fs.Name(path);
                            if (copyTarget != null) nativeCopies.Add((file, FolderFormat.Sha(bytes)));
                        }
                        else if (!detached && ext!="zip") file["retainedInputToken"]=RetainInput(origins,path,bytes);
                        if (!picking && ext == "prjpcb") {
                            manifest = path; manifestBytes = bytes; manifestCount++;
                            file["altiumPath"] = fs.Name(path);
                        }
                        if (picked != null && Policy.SourceTypes.Contains(ext)) file["sourceToken"] = picked.Token;
                        if (library && Policy.LibraryTypes.Contains(ext)) file["path"] = fs.Canonical(path);
                        if (opening && Policy.HistoryTypes.Contains(ext) && (paths.Count == 1 ||
                            ((ext == "prjpcb" || ext == "kicad_pro") && paths.Count(p => Policy.Extension(p) == "prjpcb" || Policy.Extension(p) == "kicad_pro") == 1)))
                        {
                            var token = Guid.NewGuid().ToString();
                            file["historyToken"] = token;
                            history = new KeyValuePair<string, string>(token, fs.Canonical(path));
                        }
                        result.Add(file);
                    }
                    if (manifestCount == 1) IncludeAltiumMembers(manifest, manifestBytes, paths, result, remaining, origins);
                    foreach (var item in result.Cast<Dictionary<string,object>>())
                        if (Str(item,"retainedInputToken") is string t) item["importSaveKey"]=ImportKey(origins[t]);
                    if (expectedKey != null) {
                        int primary=result.FindIndex(x=>Str((Dictionary<string,object>)x,"importSaveKey")==expectedKey);
                        if(primary>=0){var row=result[primary];result.RemoveAt(primary);result.Insert(0,row);}
                        else {ui.Main(()=>{CancelImported(operation);Reply(id,null);});return;}
                    }
                    var source = picked;
                    ui.Main(() =>
                    {
                        if (generation != pageGeneration) { source?.Dispose(); return; }
                        if(operation!=null && !importOperations.Remove(operation)){source?.Dispose();Reply(id,null);return;}
                        if(!picking && !detached && origins.Count>0) pendingImportTokens=new HashSet<string>(origins.Keys);
                        if (retainedInputs.Count+origins.Count>4096)retainedInputs.Clear();
                        foreach(var item in origins)retainedInputs[item.Key]=item.Value;
                        if (opening) pickedHistory = history;
                        if (source != null) { selectedSource?.Dispose(); selectedSource = source; }
                        if (library) foreach (var p in paths) libraryReads.Remember(p);
                        foreach (var entry in nativeCopies) GrantDocumentCopy(entry.File, entry.Sha, copyTarget);
                        Reply(id, result);
                    });
                }
                catch (Exception e)
                {
                    picked?.Dispose();
                    ui.Main(() => {
                        if (generation != pageGeneration) return;
                        if (opening) { openingProject = false; importingProject = null; }
                        Reply(id, null, Message(e));
                    });
                }
            });
        }

        void ExportBinaryCopy(int id, Dictionary<string, object> request)
        {
            var source = selectedSource;
            var name = Str(request, "name");
            var encoded = Str(request, "data");
            if (source == null || Str(request, "sourceToken") != source.Token || name == null || encoded == null)
            { Reply(id, null, "Select the original Altium document again."); return; }
            var filename = Policy.BaseName(name);
            var ext = Policy.Extension(filename);
            if (!Policy.SourceTypes.Contains(ext) || ext != source.ExtensionOf)
            { Reply(id, null, "Use the same document extension as the source."); return; }
            ui.PickSave(new SaveRequest { Title = "Export Altium Copy", FileName = filename, Extension = ext }, path =>
            {
                if (path == null) { Reply(id, false); return; }
                    ui.Background(() =>
                {
                    try
                    {
                        byte[] bytes;
                        try { bytes = Convert.FromBase64String(encoded); }
                        catch (FormatException) { ReplyLater(id, null, "Invalid binary export data."); return; }
                        source.SaveCopy(bytes, path);
                        ReplyLater(id, true);
                    }
                    catch (Exception e) { ReplyLater(id, null, Message(e)); }
                });
            });
        }

        void Export(int id, Dictionary<string, object> request)
        {
            var filename = Policy.BaseName(Str(request, "name") ?? "");
            var ext = Policy.Extension(filename);
            if (!Policy.ExchangeOutputs.Contains(ext) && filename != "waffle-diagnostics.json") { Reply(id, null, "Unrecognised save type."); return; }
            byte[] payload;
            var text = Str(request, "text");
            var data = Str(request, "data");
            if (text != null) payload = Encoding.UTF8.GetBytes(text);
            else if (data != null)
            {
                try { payload = Convert.FromBase64String(data); }
                catch (FormatException) { Reply(id, null, "Project data is missing."); return; }
            }
            else { Reply(id, null, "Project data is missing."); return; }
            ui.PickSave(new SaveRequest { Title = "Export", FileName = filename, Extension = ext }, path =>
            {
                if (path == null) { Reply(id, false); return; }
                if (Policy.Extension(path) != ext) { Reply(id, null, "Choose a filename ending in ." + ext + "."); return; }
                    ui.Background(() =>
                {
                    try
                    {
                        fs.AtomicWrite(fs.Canonical(path), payload, false);
                        ReplyLater(id, true);
                    }
                    catch (Exception e) { ReplyLater(id, null, Message(e)); }
                });
            });
        }

        // ------------------------------------------------------------------ Git

        /// Arguments for native/git_head.py (after the script path), or null for a bad revision.
        public static List<string> GitArguments(string action, string project, string revision)
        {
            var args = new List<string> { "--project", project };
            if (action == "gitHistory") { args.Add("--history"); return args; }
            args.Add("--desktop-stream");
            if (action == "gitRevision")
            {
                if (!Policy.IsFullCommit(revision)) return null;
                args.Add("--revision=" + revision);
            }
            return args;
        }

        /// The --desktop-stream output: one JSON header line, then exactly `size` bytes of project.
        public static Dictionary<string, object> ParseGitStream(byte[] bytes)
        {
            const string invalid = "Git returned an incomplete or invalid UTF-8 project.";
            int separator = Array.IndexOf(bytes, (byte)10, 0, Math.Min(bytes.Length, 65536));
            if (separator < 0) throw new HostError(invalid);
            Dictionary<string, object> info;
            try { info = Json.Parse(Encoding.UTF8.GetString(bytes, 0, separator)) as Dictionary<string, object>; }
            catch (JsonException) { throw new HostError(invalid); }
            object size, commit, path;
            if (info == null || !info.TryGetValue("size", out size) || !(size is double) ||
                (double)size != bytes.Length - separator - 1 ||
                !info.TryGetValue("revision", out commit) || !(commit is string) ||
                !info.TryGetValue("path", out path) || !(path is string)) throw new HostError(invalid);
            int start = separator + 1, count = bytes.Length - start;
            if (count >= 3 && bytes[start] == 0xef && bytes[start + 1] == 0xbb && bytes[start + 2] == 0xbf) { start += 3; count -= 3; }
            string text;
            try { text = new UTF8Encoding(false, true).GetString(bytes, start, count); }
            catch (ArgumentException) { throw new HostError(invalid); }
            var parsed = new Dictionary<string, object> { { "revision", commit }, { "path", path }, { "text", text } };
            object blob;
            if (info.TryGetValue("blob", out blob) && blob is string) parsed["blob"] = blob;
            return parsed;
        }

        /// gitQuery: one allowlisted Git operation (Policy.GitQuery), run by git_head.py --query.
        void QueryGit(int id, string token, string op, object args)
        {
            FolderProject folder = token != null && token == adoptedFolder ? FolderService(token) : null;
            if (folder != null && !GitQuery.FolderOps.Contains(op))
            { Reply(id, null, "This Git command is unavailable for a folder project."); return; }
            var active = folder != null ? new KeyValuePair<string, string>(token, System.IO.Path.Combine(folder.Root, folder.Manifest)) :
                op != null && Policy.HistoryQueries.Contains(op) && token == gitSource?.Key ? gitSource : null;
            if (active == null || token != active.Value.Key)
            { Reply(id, null, "Save or open a Waffle project to compare its Git revision."); return; }
            var command = GitQuery.CommandLine(op, args, active.Value.Value);
            if (command == null) { Reply(id, null, "Waffle does not run that Git query."); return; }
            ui.Background(() =>
            {
                string lease = null;
                try
                {
                    if (folder != null) lease = (string)((Dictionary<string, object>)folder.AcquireLease())["lease"];
                    var run = git.Run(command);
                    if (run.ExitCode != 0)
                    {
                        var message = (run.Errors ?? "").Trim();
                        if (message.Length > 1600) message = message.Substring(0, 1600);
                        throw new HostError(message.Length == 0 ? "Could not read the Git repository." : message);
                    }
                    object result = op == "read" ? ParseGitStream(run.Output) : Json.Parse(new UTF8Encoding(false, true).GetString(run.Output));
                    ui.Main(() =>
                    {
                        if (gitSource?.Key == active.Value.Key || adoptedFolder == active.Value.Key) Reply(id, result);
                        else Reply(id, null, "The active project changed. Open revision review again.");
                    });
                }
                catch (Exception e) { ReplyLater(id, null, Message(e)); }
                finally { if (lease != null) folder.Release(lease); }
            });
        }

        void ReadGit(int id, string action, string token, string revision)
        {
            KeyValuePair<string,string>? active = adoptedFolder == null ? (KeyValuePair<string,string>?)null : new KeyValuePair<string,string>(adoptedFolder, AdoptedPath);
            if (active == null || token != active.Value.Key)
            { Reply(id, null, "Save or open a Waffle project to compare its Git revision."); return; }
            var args = GitArguments(action, active.Value.Value, revision);
            if (args == null) { Reply(id, null, "Choose a full commit identifier from the project history."); return; }
            ui.Background(() =>
            {
                try
                {
                    var run = git.Run(args);
                    if (run.ExitCode != 0)
                    {
                        var message = (run.Errors ?? "").Trim();
                        if (message.Length > 1600) message = message.Substring(0, 1600);
                        throw new HostError(message.Length == 0 ? "Could not read the Git revision." : message);
                    }
                    object result = action == "gitHistory" ? Json.Parse(Encoding.UTF8.GetString(run.Output)) : ParseGitStream(run.Output);
                    ui.Main(() =>
                    {
                        if (adoptedFolder == active.Value.Key) Reply(id, result);
                        else Reply(id, null, "The active project changed. Open revision review again.");
                    });
                }
                catch (Exception e) { ReplyLater(id, null, Message(e)); }
            });
        }
    }
}
