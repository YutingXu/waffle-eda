using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Text;

namespace Waffle.Windows.Tests
{
    using Map = Dictionary<string, object>;

    static partial class Program
    {
        static void NotebookClipboardTests(string scratch)
        {
            group = "Windows notebook clipboard and previews";
            const string red = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg==";
            const string green = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNg+N/wHwAFAQJ/c3nBSAAAAABJRU5ErkJggg==";
            const string wide = "iVBORw0KGgoAAAANSUhEUgAAAIEAAAABCAYAAAD5EM2IAAAAEUlEQVR4nGNgYFD4P4pHNgYASkOQoEUtsIMAAAAASUVORK5CYII=";
            var original = Convert.FromBase64String(red); var preview = Convert.FromBase64String(green);
            string rawHash = FolderFormat.Sha(original), previewHash = FolderFormat.Sha(preview);
            var root = Directory.CreateDirectory(Path.Combine(scratch, "notebook-clipboard")).FullName;
            string file = Path.Combine(root, ManifestName), ownerPath = Path.Combine(root, SheetName), sheet = Head("schematic", SheetId);
            File.WriteAllText(file, SheetManifest()); File.WriteAllText(ownerPath, sheet);
            var fs = new PortableFs(); var ui = new FakeUi(); Host window = null; int id = 900;
            int Send(string action, Map options)
            {
                var args = new Map(options) { ["action"] = action, ["id"] = ++id };
                window.Receive(Policy.PageUri, Json.Write(args)); return id;
            }
            object Answer(int request)
            {
                Map reply; lock (ui.Posts) reply = ui.Posts.Last(p => Equals(FolderFormat.Get(p, "id"), (double)request));
                if (reply["error"] != null) throw new HostError((string)reply["error"]);
                return reply["result"];
            }
            object Call(string action, Map options = null) => Answer(Send(action, options ?? new Map()));
            string Open()
            {
                window = new Host(fs, ui, new FakeGit(), scratch, testTranslators);
                window.OpenAtStartup(file);
                var opened = (Map)((List<object>)Call("open")).Single();
                string key = (string)((Map)opened["folderProject"])["grant"];
                Call("folderAdopt", new Map { ["grant"] = key }); return key;
            }
            string grant = Open(); int requests = 0;
            var options = new Map { ["grant"] = grant, ["ownerId"] = SheetId };
            ui.NotebookClipboard = () => { requests++; return null; };
            Throws(() => Call("notebookPaste", new Map(options) { ["grant"] = "closed-grant" }), "Open a folder", "a closed grant cannot query the clipboard");
            Check(requests == 0 && !(bool)Call("notebookPaste", new Map(options) { ["data"] = red, ["name"] = "Page.png" }) && requests == 1, "an explicit empty clipboard ignores caller-supplied image bytes");
            ui.NotebookClipboard = () => new NotebookClipboardItem { MediaType = "image/jpeg", Name = "Clipboard.jpg", Bytes = () => original };
            Throws(() => Call("notebookPaste", new Map(options)), "clipboard media type", "the selected clipboard flavour must agree with its actual bytes");
            ui.NotebookClipboard = () => new NotebookClipboardItem { MediaType = "image/png", Name = "Clipboard.png", Bytes = () => original };
            var selected = (Map)Call("notebookPaste", new Map(options)); var reference = (Map)selected["assetRef"]; string token = (string)selected["assetToken"];
            Check((string)selected["name"] == "Clipboard.png" && Equals(selected["ownerId"], SheetId) && Equals(reference["sha256"], rawHash) &&
                !selected.ContainsKey("data") && !Directory.Exists(Path.Combine(root, "assets")), "palette returns one staged typed original for the chosen sheet");
            string droppedFile = Path.Combine(scratch, "actual-notebook-drop.png");
            bool SetTarget(string owner, int epoch) => (bool)Call("notebookDropTarget", new Map { ["grant"] = grant, ["ownerId"] = owner, ["epoch"] = epoch });
            Map Offer()
            {
                Check(window.OfferNotebookDrop(droppedFile, .5, .25), "a native drop is offered to the displayed sheet");
                lock (ui.Posts) return ui.Posts.Last(m => FolderFormat.Text(m, "type") == "notebookDropOffer");
            }
            Map DropRequest(Map offered) => new Map(options) { ["dropToken"] = offered["dropToken"], ["epoch"] = offered["epoch"] };
            Check(!window.OfferNotebookDrop(droppedFile, .5, .25) && SetTarget(SheetId, 1), "the first physical drop requires an editor target");
            var offer = Offer();
            Check(FolderFormat.Text(offer, "grant") == grant && FolderFormat.Text(offer, "ownerId") == SheetId &&
                offer.Count == 7 && !offer.ContainsKey("path"), "the offer identifies its sheet and epoch without exposing the selected path");
            var droppedRequest = DropRequest(offer);
            Throws(() => Call("notebookDrop", droppedRequest), "again", "the preliminary offer cannot stage a file");
            Check(!(bool)Call("notebookDropAccept", new Map(droppedRequest) { ["ownerId"] = "other-sheet" }) &&
                !(bool)Call("notebookDropAccept", new Map(droppedRequest) { ["epoch"] = 2 }), "a different owner or epoch cannot authorize file inspection");
            // The selected file becomes readable only after the offer. No file IO was needed to post it.
            File.WriteAllBytes(droppedFile, original);
            Check((bool)Call("notebookDropAccept", droppedRequest) && !(bool)Call("notebookDropAccept", droppedRequest),
                "the initiating sheet acknowledges and classifies the physical file exactly once");
            Throws(() => Call("notebookDrop", new Map(droppedRequest) { ["ownerId"] = "other-sheet" }), "again", "the inspected bytes stay bound to the acknowledged sheet");
            var fromOsDrop = (Map)Call("notebookDrop", droppedRequest);
            Check(FolderFormat.Text(fromOsDrop, "name") == Path.GetFileName(droppedFile) && Equals(((Map)fromOsDrop["assetRef"])["sha256"], rawHash),
                "the OS drop stages its selected original for the initiating owner");
            Throws(() => Call("notebookDrop", droppedRequest), "again", "a consumed drop cannot be replayed");
            Call("folderDropAsset", new Map(options) { ["assetToken"] = fromOsDrop["assetToken"] });
            var pending = DropRequest(Offer()); var jobs = new Queue<Action>(); ui.ScheduleBackground = jobs.Enqueue;
            int accept = Send("notebookDropAccept", pending);
            Check(jobs.Count == 1 && SetTarget("other-sheet", 2) && SetTarget(SheetId, 3) && !(bool)Answer(accept),
                "switching away and back during classification revokes the original acceptance");
            jobs.Dequeue()(); ui.ScheduleBackground = null;
            Check(!SetTarget("other-sheet", 2) && !(bool)Call("notebookDropAccept", pending), "stale target updates and acknowledgements cannot restore an earlier owner epoch");
            Throws(() => Call("notebookDrop", pending), "again", "no staged asset is available after dispatching a cancelled worker");
            var unfocused = DropRequest(Offer());
            Check((bool)Call("notebookDropAccept", unfocused), "a fresh focused offer can be accepted");
            window.SetNotebookWindowActive(false);
            Check(!window.OfferNotebookDrop(droppedFile, .5, .25), "physical file offers require a foreground window");
            window.SetNotebookWindowActive(true);
            Throws(() => Call("notebookDrop", unfocused), "again", "regaining window focus cannot revive a held attachment");
            var unowned = DropRequest(Offer());
            Check(SetTarget(null, 4) && !(bool)Call("notebookDropAccept", unowned) && !window.OfferNotebookDrop(droppedFile, .5, .25),
                "leaving the editable sheet revokes path selection before inspection");
            var drop = (Map)Call("notebookTransfer", new Map(options) { ["origin"] = "drop", ["mediaType"] = "image/png", ["name"] = "placed.png", ["data"] = red });
            Check(Equals(((Map)drop["assetRef"])["sha256"], rawHash) && !Equals(drop["assetToken"], token), "a browser file drop stages the same immutable bytes independently");
            Call("folderDropAsset", new Map(options) { ["assetToken"] = drop["assetToken"] });
            var derivative = new Map(options) { ["op"] = "read", ["side"] = 128, ["assetRef"] = reference };
            Check(((Map)Call("notebookDerivative", new Map(derivative) { ["assetToken"] = token })).Count == 0 &&
                !Directory.Exists(Path.Combine(root, ".waffle", "cache")), "a scoped cache miss leaves the workspace untouched");
            Throws(() => Call("notebookDerivative", new Map(derivative) { ["assetToken"] = token, ["ownerId"] = "another-sheet" }),
                "attachment owner", "an asset token does not grant a different sheet access");
            var plan = new List<object> {
                new Map { ["path"] = "assets/" + rawHash, ["expected"] = null, ["assetToken"] = token },
                new Map { ["path"] = SheetName, ["expected"] = FolderFormat.Sha(Encoding.UTF8.GetBytes(sheet)), ["text"] = sheet +
                    Line(new Map { ["kind"] = "image", ["id"] = "picture", ["asset"] = reference }) }
            };
            Call("folderCommit", new Map(options) { ["projectId"] = "p1", ["manifest"] = ManifestName, ["plan"] = plan });
            var writer = new Map(derivative) { ["op"] = "write", ["png"] = green };
            string cache = Path.Combine(root, ".waffle", "cache", "images-v1", rawHash, "screen-v1-s128.png");
            var damaged = preview.ToArray(); damaged[damaged.Length - 8] ^= 1;
            Throws(() => Call("notebookDerivative", new Map(writer) { ["png"] = Convert.ToBase64String(damaged) }), "thumbnail PNG", "malformed thumbnail refused");
            Throws(() => Call("notebookDerivative", new Map(writer) { ["png"] = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4AGNg+N/wHwAFAQJ/GqwO1QAAAABJRU5ErkJggg==" }), "thumbnail PNG", "invalid compressed pixels with valid chunk checksums are refused");
            Throws(() => Call("notebookDerivative", new Map(writer) { ["png"] = wide }), "thumbnail PNG", "the source cannot write a thumbnail above its selected pixel tier");
            Throws(() => Call("notebookDerivative", new Map(writer) { ["side"] = 129 }), "thumbnail request", "custom file variants are outside the cache");
            Check(!File.Exists(cache) && (bool)((Map)Call("notebookDerivative", writer))["saved"] && File.ReadAllBytes(cache).SequenceEqual(preview),
                "the cache stores only the validated PNG at its canonical root-bound name");
            foreach (int tier in new[] { 256, 512, 1024, 2048, 4096 })
            {
                var put = (Map)Call("notebookDerivative", new Map(writer) { ["side"] = tier });
                var read = (Map)Call("notebookDerivative", new Map(derivative) { ["side"] = tier });
                Check((bool)put["saved"] && (string)read["sha256"] == previewHash, "canonical thumbnail tier " + tier);
            }
            window.Closing(); string fresh = Open(); derivative["grant"] = fresh;
            var warm = (Map)Call("notebookDerivative", new Map(derivative));
            Check(fresh != grant && (string)warm["png"] == green && (string)warm["sha256"] == previewHash && previewHash != rawHash &&
                !warm.ContainsKey("data"), "reopened owner serves the persistent thumbnail with its own digest");
            Throws(() => Call("notebookDerivative", new Map(derivative) { ["ownerId"] = "foreign" }), "attachment owner", "an unrelated sheet cannot receive cached bytes");
            foreach (var field in new[] { "mediaType", "byteLength" })
            {
                var wrong = new Map(reference) { [field] = field == "byteLength" ? (object)(original.Length + 1) : "image/jpeg" };
                Throws(() => Call("notebookDerivative", new Map(derivative) { ["assetRef"] = wrong }), "attachment owner", "the granted asset must match its " + field);
            }
            string originalPath = Path.Combine(root, "assets", rawHash);
            File.WriteAllBytes(cache, damaged);
            Check(((Map)Call("notebookDerivative", new Map(derivative))).Count == 0, "corrupt cached PNG is a miss");
            File.WriteAllBytes(cache, preview);
            File.WriteAllBytes(originalPath, preview);
            Throws(() => Call("notebookDerivative", new Map(derivative)), "changed on disk", "a stale raw original with a valid thumbnail cannot disclose cached bytes");
            File.WriteAllBytes(originalPath, original);
            string lease = (string)((Map)Call("folderReadLease", new Map { ["grant"] = fresh }))["lease"];
            var saved = (Map)Call("folderReadAsset", new Map(derivative) { ["lease"] = lease, ["offset"] = 0, ["length"] = 100, ["purpose"] = "export" });
            Check((string)saved["data"] == red, "saved export returns the raw original independently of a cached bitmap");
            Call("folderRelease", new Map { ["grant"] = fresh, ["lease"] = lease }); window.Closing();

            var dib = new byte[48];
            void Word(int index, int value) => Buffer.BlockCopy(BitConverter.GetBytes(value), 0, dib, index, 4);
            Word(0, 40); Word(4, 2); Word(8, 1); dib[12] = 1; dib[14] = 24; dib[40] = 255;
            var bmp = NotebookBitmap.FileBytes(dib);
            Check(bmp.Length == 62 && bmp[0] == 'B' && bmp[1] == 'M' && BitConverter.ToInt32(bmp, 10) == 54 && bmp[54] == 255,
                "a 24-bit DIB keeps the original pixels in its bounded BMP stream");
            Word(8, int.MinValue);
            Throws(() => NotebookBitmap.FileBytes(dib), "clipboard bitmap layout", "a bitmap with impossible dimensions is refused before conversion");
        }
    }
}
