// Normal desktop dispatch and byte-level invariants specific to the folder capability.
using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Text;
using System.Threading;

namespace Waffle.Windows.Tests
{
    using Map = Dictionary<string, object>;

    static partial class Program
    {
        static string Line(Map m) => Json.Write(m) + "\n";
        static string Head(string kind, string id) => Line(new Map { ["kind"] = kind, ["formatVersion"] = "2.0", ["id"] = id });
        static string SheetId = "sheet1", ManifestName = "Sensor.waffle", SheetName = "Power.wsch";
        static string SheetManifest() => Head("project", "p1") + Line(new Map { ["kind"] = "document", ["docKind"] = "schematic", ["id"] = SheetId, ["name"] = "Power", ["path"] = SheetName });
        static void PortableCopies(string scratch)
        {
            group = "portable project without Python";
            var root = Path.Combine(scratch, "offline-zip");
            Directory.CreateDirectory(root);
            var fs = new PortableFs();
            // Frame a manifest and its document independently to check the portable installer's digest.
            Map Request(string manifest, string member, byte[] project, byte[] document)
            {
                using var stream = new MemoryStream();
                void Write(byte[] bytes) => stream.Write(bytes, 0, bytes.Length);
                void Number(long value, int length)
                {
                    for (int i = length - 1; i >= 0; i--) stream.WriteByte((byte)(value >> (i * 8)));
                }

                Write(Encoding.ASCII.GetBytes("WAFFLE-PROJECT-V1\0"));
                Number(project.Length, 8);
                Write(project);
                Number(1, 8);
                var pathBytes = Encoding.UTF8.GetBytes(member);
                Number(pathBytes.Length, 4);
                Write(pathBytes);
                Write(Digest.Of(document));

                Map Row(string path, byte[] bytes) => new Map { ["path"] = path, ["data"] = Convert.ToBase64String(bytes) };
                return new Map
                {
                    ["parent"] = root, ["manifest"] = manifest, ["version"] = FolderFormat.Sha(stream.ToArray()),
                    ["files"] = new List<object> { Row(manifest, project), Row(member, document),
                        Row(".waffle/.gitignore", Encoding.UTF8.GetBytes("/cache/\n")) }
                };
            }

            var data = Encoding.UTF8.GetBytes(SheetManifest());
            var sheet = Encoding.UTF8.GetBytes(Head("schematic", SheetId));
            var request = Request(ManifestName, SheetName, data, sheet);
            Directory.CreateDirectory(Path.Combine(root, "SENSOR"));
            var result = (Map)PortableArchive.Run(fs, "install", request);
            string installed = (string)result["manifest"];
            Check(Path.GetFileName(Path.GetDirectoryName(installed)) == "Sensor (2)" &&
                File.ReadAllBytes(installed).SequenceEqual(data), "stock Windows extracts a verified ZIP as a new sibling");
            request["version"] = new string('0', 64);
            Throws(() => PortableArchive.Run(fs, "install", request), "version", "failed ZIP verification publishes no folder");
            Check(!Directory.Exists(Path.Combine(root, "Sensor (3)")), "failed ZIP installation preserves existing directories");

            const string futureManifest = "Future.waffle", trace = "Trace.wwave";
            var header = Head("project", "future");
            var row = Line(new Map { ["kind"] = "document", ["docKind"] = "waveform", ["id"] = "trace", ["name"] = "Trace", ["path"] = trace });
            var wave = Encoding.UTF8.GetBytes(Head("waveform", "trace").Replace("2.0", "2.1"));
            var future = Request(futureManifest, trace, Encoding.UTF8.GetBytes(header.Replace("2.0", "2.1") + row), wave);
            var futureResult = (Map)PortableArchive.Run(fs, "install", future);
            var tracePath = Path.Combine(Path.GetDirectoryName((string)futureResult["manifest"]), trace);
            Check(File.ReadAllBytes(tracePath).SequenceEqual(wave), "a declared newer minor waveform is preserved byte for byte");

            var undeclared = Request(futureManifest, trace, Encoding.UTF8.GetBytes(header + row), wave);
            Throws(() => PortableArchive.Run(fs, "install", undeclared), "member", "an unfamiliar extension needs the newer minor declaration");
        }

        static void FolderTests(string scratch)
        {
            PortableCopies(scratch);
            group = "format 2 folder";
            var fs = new PortableFs(); var root = Path.Combine(scratch, "folder-test"); Directory.CreateDirectory(root);
            var manifestPath = Path.Combine(root, ManifestName); string sheet = Head("schematic", SheetId);
            File.WriteAllText(manifestPath, SheetManifest()); File.WriteAllText(Path.Combine(root, SheetName), sheet);
            var notes = Path.Combine(root, "Notes.waffle");
            File.WriteAllText(notes, "ordinary notes\n");
            Check(FolderProject.SelectedManifest(fs, root) == ManifestName, "directory discovery counts valid project headers");
            var second = Path.Combine(root, "Second.waffle");
            File.WriteAllText(second, Head("project", "p2"));
            Throws(() => FolderProject.SelectedManifest(fs, root), "Choose the project manifest", "two actual manifests require an explicit selection");
            File.Delete(second); File.Delete(notes);
            var ui = new FakeUi(); var folderGit = new FakeGit(); var shell = new Host(fs, ui, folderGit, scratch, testTranslators);
            int id = 200;
            object Call(string action, Map fields = null)
            {
                var r = fields ?? new Map(); r["action"] = action; r["id"] = ++id;
                shell.Receive(Policy.PageUri, Json.Write(r));
                Map response; lock (ui.Posts) response = ui.Posts.Last(p => Equals(FolderFormat.Get(p, "id"), (double)id));
                if (response["error"] != null) throw new HostError((string)response["error"]);
                return response["result"];
            }
            shell.OpenAtStartup(manifestPath);
            var opened = (Map)((List<object>)Call("open"))[0];
            Check(opened.ContainsKey("folderProject") && !opened.ContainsKey("data"), "normal OS Open binds an opaque folder and exposes no legacy save target");
            var grant = (string)((Map)opened["folderProject"])["grant"];
            Map With(params object[] pairs) { var r = new Map { ["grant"] = grant }; for (int i = 0; i < pairs.Length; i += 2) r[(string)pairs[i]] = pairs[i + 1]; return r; }
            Check((bool)Call("folderAdopt", With()) && shell.DesignPath == manifestPath, "adopting a folder binds the visible folder manifest");
            Map Query(string op, Map args = null) => new Map { ["token"] = grant, ["op"] = op, ["args"] = args };
            Call("gitQuery", Query("folderRevisions", new Map { ["stage"] = "index" }));
            var boundGit = folderGit.Arguments;
            Check(boundGit.Take(4).SequenceEqual(new[] { "--project", manifestPath, "--query", "folderRevisions" }), "folder Git uses the adopted manifest without a legacy write target");
            Throws(() => Call("gitQuery", Query("installMergeDriver", new Map { ["confirm"] = true })), "unavailable", "the folder Git grant does not author Git configuration");
            Check(ReferenceEquals(boundGit, folderGit.Arguments), "a refused folder command never reaches the Git process");
            string lease = (string)((Map)Call("folderReadLease", With()))["lease"];
            Check(!Directory.Exists(Path.Combine(root, ".waffle")), "read-only checkout acquires a lease without creating any workspace files");
            var files = (List<object>)((Map)Call("folderRead", With("lease", lease, "paths", new[] { ManifestName, SheetName })))["files"];
            Check(files.Count == 2 && (string)((Map)files[1])["sha256"] == FolderFormat.Sha(Encoding.UTF8.GetBytes(sheet)), "leased host read returns verified bytes");
            var edit = new Map { ["path"] = SheetName, ["expected"] = FolderFormat.Sha(Encoding.UTF8.GetBytes(sheet)), ["text"] = sheet };
            var request = With("manifest", ManifestName, "projectId", "p1", "plan", new[] { edit });
            Throws(() => Call("folderCommit", request), "still in progress", "held export lease prevents a writer");
            Check((bool)Call("folderRelease", With("lease", lease)), "shared lease released");
            foreach (string invalid in new[] { "../x.wsch", "AUX.wsch", "COM¹.wsch", "folder//x.wsch", "C:/x.wsch", "x:stream", "x. ", "x\\y", "x\u0000y" })
                Throws(() => FolderFormat.PathName(invalid), "path", "nonportable member name rejected");
            Check(!FolderFormat.Authored(".waffle/journal/active", ManifestName) && !FolderFormat.Authored(".git/config", ManifestName), "private bookkeeping is outside the document capability");
            var png = Convert.FromBase64String("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jZFcAAAAASUVORK5CYII=");
            var input = Path.Combine(scratch, "picked-image.png"); File.WriteAllBytes(input, png);
            ui.Opens.Enqueue(new[] { input }); string source = (string)((Map)Call("folderPickAsset", With("ownerId", SheetId, "mediaTypes", new[] { "image/png" })))["sourceToken"];
            var asset = (Map)Call("folderStageAsset", With("ownerId", SheetId, "mediaType", "image/png", "sourceToken", source));
            string token = (string)asset["assetToken"]; var reference = (Map)asset["assetRef"]; string assetPath = "assets/" + reference["sha256"];
            Check((string)reference["sha256"] == FolderFormat.Sha(png) && !Directory.Exists(Path.Combine(root, "assets")), "selected bytes stage privately before Ctrl+S");
            Throws(() => Call("folderStageAsset", With("ownerId", SheetId, "mediaType", "image/png", "sourceToken", source)), "again", "selection token is single use");
            var pre = (Map)Call("folderReadAsset", With("ownerId", SheetId, "assetRef", reference, "assetToken", token, "offset", 2, "length", 10, "purpose", "render"));
            Check(Convert.FromBase64String((string)pre["data"]).SequenceEqual(png.Skip(2).Take(10)), "pending preview can read only its selected asset");
            var newAsset = new Map { ["path"] = assetPath, ["expected"] = null, ["assetToken"] = token };
            request["plan"] = new[] { newAsset, edit };
            Throws(() => Call("folderCommit", request), "attachment owner", "first attachment must include the actual owning sheet");
            Check(!Directory.Exists(Path.Combine(root, "assets")) && !File.Exists(Path.Combine(root, ".waffle", "journal", "active")) &&
                File.ReadAllText(Path.Combine(root, SheetName)) == sheet, "rejecting the attachment leaves the existing sheet and journal unchanged");
            string updated = sheet + Line(new Map { ["kind"] = "image", ["id"] = "i1", ["asset"] = reference }); edit["text"] = updated;
            var saved = (Map)Call("folderCommit", request);
            Check((bool)saved["saved"] && (string)((Map)saved["hashes"])[assetPath] == reference["sha256"].ToString() &&
                File.ReadAllText(manifestPath) == SheetManifest() && File.ReadAllText(Path.Combine(root, SheetName)) == updated &&
                File.ReadAllBytes(Path.Combine(root, assetPath)).SequenceEqual(png), "Ctrl+S commits the attachment and active sheet without a manifest edit");
            lease = (string)((Map)Call("folderReadLease", With()))["lease"];
            var chunk = (Map)Call("folderReadAsset", With("ownerId", SheetId, "assetRef", reference, "lease", lease, "offset", 0, "length", 100, "purpose", "export"));
            Check((bool)chunk["eof"] && Convert.FromBase64String((string)chunk["data"]).SequenceEqual(png), "saved attachment read validates its owner and content");
            Throws(() => Call("folderReadAsset", With("ownerId", "other", "assetRef", reference, "lease", lease, "purpose", "render")), "owner", "a different owner cannot acquire those bytes");
            Call("folderRelease", With("lease", lease));
            Call("folderLocalState", With("localState", new Map { ["activeDocument"] = SheetId })); var local = (Map)Call("folderLocalState", With());
            Check((string)local["activeDocument"] == SheetId, "local workspace data survives independently of tracked bytes");
            int first; lock (ui.Posts) first = ui.Posts.Count;
            File.AppendAllText(Path.Combine(root, SheetName), Line(new Map { ["kind"] = "text", ["id"] = "extra" }));
            bool changed = SpinWait.SpinUntil(() =>
            {
                lock (ui.Posts) return ui.Posts.Skip(first).Any(p => FolderFormat.Text(p, "type") == "folderChanged" && FolderFormat.Text(p, "grant") == grant &&
                FolderFormat.Get(p, "paths") is List<object> paths && paths.Contains(SheetName));
            }, 3000);
            Check(changed, "native directory watcher reports an external document edit for the grant");
            var pdf = Encoding.ASCII.GetBytes("%PDF-1.4\nbytes owned by this selected sheet\n");
            var pickedPdf = (Map)Call("notebookTransfer", With("ownerId", SheetId, "origin", "drop", "mediaType", "application/pdf", "name", "parts.pdf", "data", Convert.ToBase64String(pdf)));
            fs.NotebookDecoder = (options, data) =>
            {
                if (!data.SequenceEqual(pdf) || FolderFormat.Text(options, "op") != "pdfPage") throw new Exception("Wrong PDF sent for rendering.");
                return new Map { ["width"] = 1, ["height"] = 1, ["physical"] = new[] { 300, 200 }, ["png"] = Convert.ToBase64String(png) };
            };
            var clip = With("ownerId", SheetId, "assetRef", pickedPdf["assetRef"], "assetToken", pickedPdf["assetToken"], "page", 1, "region", new[] { 0, 0, 1000000, 1000000 }, "side", 1200);
            var rendered = (Map)Call("notebookClip", clip);
            Check((string)((Map)rendered["assetRef"])["sha256"] == FolderFormat.Sha(png) && (int)(double)rendered["width"] == 1, "PDF clips derive a staged PNG from the selected owner's verified source");
            clip["ownerId"] = "different";
            Throws(() => Call("notebookClip", clip), "read lease", "other owners cannot use the private PDF token");
            Call("folderDropAsset", With("assetToken", pickedPdf["assetToken"])); Call("folderDropAsset", With("assetToken", rendered["assetToken"]));
            Throws(() => Call("notebookMedia", new Map { ["op"] = "pdfPage", ["data"] = Convert.ToBase64String(pdf), ["sha256"] = FolderFormat.Sha(png) }), "digest", "pure media decode verifies supplied physical digest");
            shell.Receive(Policy.PageUri, Msg("action","clearGitProject"));
            Check(shell.DesignPath == null, "detaching the editor removes the native saved-folder binding");
            Throws(() => Call("folderReadLease", With()), "Open a folder", "detached grants cannot read or save");
            Throws(() => Call("gitQuery", Query("projectLog")), "Save or open", "closed folder grants cannot query Git");
            shell.Closing();
            var directoryUi = new FakeUi();
            var directoryHost = new Host(fs, directoryUi, new FakeGit(), scratch, testTranslators);
            directoryHost.OpenAtStartup(root);
            directoryHost.Receive(Policy.PageUri, Msg("id", 701, "action", "open"));
            var directoryResult = (List<object>)directoryUi.Last["result"];
            Check(directoryResult.Count == 1 && ((Map)directoryResult[0]).ContainsKey("folderProject"), "opening a project directory through the OS returns the same folder envelope");
            directoryHost.Closing();
            FolderBootstrapBarriers(scratch);
            FolderConflictTests(fs, scratch);
            FolderFirstSaveRecovery(fs, scratch);
            FolderReadSetTests(fs, scratch);
            FolderAdditiveTests(fs, scratch);
        }
        static void FolderBootstrapBarriers(string scratch)
        {
            string root = Path.Combine(scratch, "folder-bootstrap-barriers"); Directory.CreateDirectory(root);
            var platform = new PortableFs();
            using (var watch = new FolderWatch(root, ManifestName, (_, _, _) => { }))
            using (var first = new FolderStorage(platform, root, ManifestName))
            using (var second = new FolderStorage(new PortableFs(), root, ManifestName))
            {
                void Busy(bool writer, string message) => Throws(() => { using (second.Barrier(writer)) { } }, "still in progress", message);

                using (first.Barrier(false))
                using (second.Barrier(false))
                {
                    Busy(true, "independent first readers prevent a writer from bootstrapping the journal");
                    Check(!Directory.EnumerateFileSystemEntries(root).Any(), "bootstrap readers leave the watched checkout pristine");
                }
                using (var writer = platform.TryBarrier(root, true, true))
                {
                    Check(writer != null && !Directory.EnumerateFileSystemEntries(root).Any(), "the bootstrap writer can enumerate the watched root");
                    Busy(false, "the bootstrap writer excludes a competing reader");
                    Busy(true, "the bootstrap writer excludes a competing writer");
                }
                using (first.Barrier(true))
                {
                    Check(File.Exists(Path.Combine(root, ".waffle", "journal", "lock")), "the writer establishes the durable journal on a watched checkout");
                    Busy(false, "the published journal lock excludes a competing reader");
                    Busy(true, "the published journal lock excludes a competing writer");
                }
                using (second.Barrier(true)) Check(true, "the journal writer is available again after release");
            }
        }
        static void FolderConflictTests(PortableFs fs, string scratch)
        {
            var projectRoot = Path.Combine(scratch, "conflict-test"); Directory.CreateDirectory(projectRoot);
            File.WriteAllText(Path.Combine(projectRoot, ManifestName), SheetManifest());
            string old = Head("schematic", SheetId), changed = old + Line(new Map { ["kind"] = "text", ["id"] = "a" }), external = old + Line(new Map { ["kind"] = "text", ["id"] = "b" });
            string path = Path.Combine(projectRoot, SheetName); File.WriteAllText(path, old);
            string Hash(string value) => FolderFormat.Sha(Encoding.UTF8.GetBytes(value));
            using (var p = new FolderProject(fs, projectRoot, ManifestName))
            {
                p.Detect();
                var e = new Map { ["path"] = SheetName, ["expected"] = Hash(old), ["text"] = changed };
                p.Commit(new Map { ["manifest"] = ManifestName, ["projectId"] = "p1", ["plan"] = new List<object> { e } }, out var apply);
                File.WriteAllText(path, external); apply();
                var detail = (Map)p.Conflict(); string tx = (string)detail["transaction"];
                Check((string)detail["state"] == "conflict" && ((List<string>)detail["paths"]).Single() == SheetName, "review exposes the one competing path");
                foreach (var choice in new[] { "external", "staged" })
                {
                    var bytes = (Map)p.ConflictRead(new Map { ["transaction"] = tx, ["path"] = SheetName, ["side"] = choice, ["offset"] = 0, ["length"] = 4096 });
                    Check(Encoding.UTF8.GetString(Convert.FromBase64String((string)bytes["data"])) == (choice == "external" ? external : changed), "review bytes match " + choice + " version");
                }
                var decision = new Map { ["path"] = SheetName, ["current"] = Hash(old), ["use"] = "merged", ["text"] = changed + Line(new Map { ["kind"] = "text", ["id"] = "b" }) };
                var request = new Map { ["transaction"] = tx, ["choices"] = new List<object> { decision } };
                Throws(() => p.Resolve(request, out _), "changed on disk", "supersession requires the newly observed physical hash");
                decision["current"] = Hash(external); var saved = (Map)p.Resolve(request, out apply);
                Check((bool)saved["saved"] && (string)saved["transaction"] != tx && File.ReadAllText(path) == external, "conflict resolution publishes a separately durable complete transaction");
                apply(); var archive = Path.Combine(projectRoot, ".waffle", "local", "conflicts", tx);
                Check(File.ReadAllText(path) == (string)decision["text"] && File.Exists(Path.Combine(archive, Hash(changed))) && File.Exists(Path.Combine(archive, Hash(external))), "both original sides survive the resolved install");
            }
        }
        static void FolderReadSetTests(PortableFs fs, string scratch)
        {
            var root = Path.Combine(scratch, "read-set-project"); Directory.CreateDirectory(root);
            string diskManifest = Path.Combine(root, ManifestName), diskSheet = Path.Combine(root, SheetName);
            string manifest = SheetManifest(), sheet = Head("schematic", SheetId);
            File.WriteAllText(diskManifest, manifest); File.WriteAllText(diskSheet, sheet);
            using (var p = new FolderProject(fs, root, ManifestName, point =>
            {
                if (point == "after-stage-dir-sync") File.AppendAllText(diskManifest, Line(new Map { ["kind"] = "tag", ["id"] = "external" }));
            }))
            {
                p.Detect();
                string lease = (string)((Map)p.AcquireLease())["lease"];
                p.Read(lease, new List<object> { SheetName });
                if (fs.ReadHandlesPreventChanges)
                {
                    bool busy = false;
                    try { File.AppendAllText(diskSheet, " "); } catch (IOException) { busy = true; }
                    Check(busy && p.VerifyLease(lease), "the Windows saved snapshot holds its observed file against outside writers");
                }
                else
                {
                    File.AppendAllText(diskSheet, " ");
                    Throws(() => p.VerifyLease(lease), "changed on disk", "MCP verify detects an outside edit during its read lease");
                }
                p.Release(lease); File.WriteAllText(diskSheet, sheet);
                var e = new Map { ["path"] = SheetName, ["expected"] = FolderFormat.Sha(Encoding.UTF8.GetBytes(sheet)), ["text"] = sheet + Line(new Map { ["kind"] = "text", ["id"] = "a" }) };
                var request = new Map { ["projectId"] = "p1", ["manifest"] = ManifestName, ["plan"] = new List<object> { e } };
                var set = new Map { [ManifestName] = FolderFormat.Sha(Encoding.UTF8.GetBytes(manifest)) };
                Throws(() => p.Commit(request, out _, set), "changed on disk", "MCP commit rechecks an unchanged dependency immediately before publishing");
                Check(!File.Exists(Path.Combine(root, ".waffle", "journal", "active")) && File.ReadAllText(diskSheet) == sheet, "a failed read-set check leaves the authored edit uncommitted");
            }
        }
        static void FolderFirstSaveRecovery(PortableFs fs, string scratch)
        {
            var root = Path.Combine(scratch, "new-folder-test"); Directory.CreateDirectory(root);
            using (var p = new FolderProject(fs, root, ManifestName, point => { if (point == "after-commit-sync") throw new IOException("test stop"); }))
            {
                var doc = new Map { ["path"] = SheetName, ["expected"] = null, ["text"] = Head("schematic", SheetId) };
                var manifest = new Map { ["path"] = ManifestName, ["expected"] = null, ["text"] = SheetManifest() };
                Throws(() => p.Commit(new Map { ["manifest"] = ManifestName, ["projectId"] = "p1", ["plan"] = new List<object> { doc, manifest } }, out _), "test stop", "first save stopped after its durable descriptor");
            }
            var name = FolderProject.SelectedManifest(fs, root);
            using (var p = new FolderProject(fs, root, name))
            {
                p.Recover();
                Check(name == ManifestName && p.Detect() && File.Exists(Path.Combine(root, SheetName)), "choosing a first-save folder can recover before a manifest is installed");
            }
        }
    }
}
