// A physical drop belongs to the folder, sheet and editor epoch displayed at the gesture.
// Only the native window supplies a path. The page acknowledges that target before any file IO.
using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Threading;

namespace Waffle.Windows
{
    using Map = Dictionary<string, object>;

    public sealed partial class Host
    {
        sealed class NotebookDropOffer
        {
            internal readonly string Token = Guid.NewGuid().ToString("D");
            internal readonly CancellationTokenSource Cancellation = new CancellationTokenSource();
            internal string Path, Owner, Media;
            internal long Epoch;
            internal int Generation;
            internal int? AcceptRequest;
            internal bool Accepted;
            internal Stream Input;
        }

        sealed class TypedDropOffer
        {
            internal string Token, Path, Name, Mime, Grant;
            internal DateTime Created;
            internal int Generation;
            internal long? Size;
            internal int? Request;
            internal bool Taken;
            internal readonly CancellationTokenSource Cancellation = new CancellationTokenSource();
            internal Func<CancellationToken, byte[]> Load;
            internal Action Fallback;
        }

        TypedDropOffer typedDrop;
        internal bool ButterDropEnabled { get; private set; }
        internal string TypedDropMime(string path)
        {
            if (!ButterDropEnabled || !fs.IsAbsolute(path)) return null;
            switch (Path.GetExtension(path).ToLowerInvariant())
            {
                case ".step": case ".stp": return "model/step";
                case ".csv": return "text/csv";
                case ".wlib": case ".atrlib": case ".schlib": case ".pcblib":
                case ".kicad_sym": case ".kicad_mod": return "application/octet-stream";
                default: return PromisedDrop.Media(Path.GetFileName(path));
            }
        }

        internal bool OfferTypedDrop(string path, Func<CancellationToken, byte[]> load, double x, double y,
                                    string promisedName=null, long? size=null, Action fallback=null)
        {
            if (!ButterDropEnabled || !notebookWindowActive) return false;
            var name = path == null ? promisedName ?? "Dropped.pdf" : Path.GetFileName(path);
            var mime = path == null ? PromisedDrop.Media(name) : TypedDropMime(path);
            if (mime == null || path == null && load == null) return false;
            if (path != null)
            {
                if (!fs.IsFile(path)) return false;
                size = new FileInfo(path).Length;
            }
            CancelTypedDrop();
            var offer = new TypedDropOffer { Token=Guid.NewGuid().ToString("D"), Path=path, Load=load, Mime=mime,
                Name=name, Size=size, Grant=adoptedFolder, Fallback=fallback, Created=DateTime.UtcNow, Generation=pageGeneration };
            typedDrop = offer;
            ui.Post(Json.Write(new Map { ["type"]="butterDropOffer", ["token"]=offer.Token, ["x"]=x, ["y"]=y,
                ["file"]=new Map { ["name"]=name, ["mime"]=mime, ["size"]=size } }));
            return true;
        }

        void CancelTypedDrop(string token=null, bool fallback=false)
        {
            var offer = typedDrop;
            if (offer == null || token != null && offer.Token != token) return;
            typedDrop = null;
            offer.Cancellation.Cancel(); offer.Cancellation.Dispose();
            if (offer.Generation != pageGeneration) return;
            if (offer.Request is int pending) Reply(pending,null);
            if (fallback && !offer.Taken && adoptedFolder == offer.Grant &&
                DateTime.UtcNow - offer.Created <= TimeSpan.FromSeconds(10)) offer.Fallback?.Invoke();
        }

        void TakeTypedDrop(int id, Map request)
        {
            var offer = typedDrop;
            if (offer == null || offer.Taken || offer.Token != Str(request,"token")) { Reply(id,null); return; }
            bool Current() => typedDrop == offer && ButterDropEnabled && notebookWindowActive &&
                pageGeneration == offer.Generation && adoptedFolder == offer.Grant;
            if (!Current() || DateTime.UtcNow - offer.Created > TimeSpan.FromSeconds(10)) { Reply(id,null); return; }
            offer.Taken = true; offer.Request = id;
            var cancellation = offer.Cancellation.Token;
            ui.Background(() =>
            {
                void Complete(Map packet,string error=null)
                {
                    ui.Main(() =>
                    {
                        if (typedDrop != offer || pageGeneration != offer.Generation) return;
                        offer.Request = null;
                        Reply(id,Current() ? packet : null,Current() ? error : null);
                    });
                }
                try
                {
                    cancellation.ThrowIfCancellationRequested();
                    int cap = offer.Mime == "model/step" ? 32 << 20 : offer.Mime == "text/csv" ? 65536 :
                        offer.Mime == "application/octet-stream" ? 16 << 20 : NotebookInput.MaxBytes;
                    var bytes = offer.Load?.Invoke(cancellation);
                    if (bytes == null)
                    {
                        if (offer.Path == null) throw new HostError("The selected file promise could not be read.");
                        using (var stream = ((IFolderPlatform)fs).OpenRegular(offer.Path))
                        {
                            using (cancellation.Register(stream.Dispose))
                            {
                                if (stream.Length < 1 || stream.Length > cap) throw new HostError("The selected drop exceeds the file size limit.");
                                bytes = new byte[checked((int)stream.Length)];
                                for (int offset=0; offset<bytes.Length;)
                                {
                                    cancellation.ThrowIfCancellationRequested();
                                    int count=stream.Read(bytes,offset,Math.Min(bytes.Length-offset,65536));
                                    if (count == 0) throw new HostError("The dropped file changed while reading.");
                                    offset += count;
                                }
                                if (stream.ReadByte() != -1) throw new HostError("The dropped file changed while reading.");
                            }
                        }
                    }
                    cancellation.ThrowIfCancellationRequested();
                    if (bytes.Length < 1 || bytes.Length > cap || offer.Size.HasValue && offer.Size.Value != bytes.Length ||
                        offer.Mime == "application/pdf" && !FolderProject.IsPdf(bytes))
                        throw new HostError("The dropped file does not match its declared type or size.");
                    var body = Convert.ToBase64String(bytes);
                    Complete(new Map { ["name"]=offer.Name, ["mime"]=offer.Mime, ["data"]=body });
                }
                catch (Exception e) { Complete(null,Message(e)); }
            });
        }

        const long MaxDropEpoch = 9007199254740991; // JavaScript Number.MAX_SAFE_INTEGER
        bool notebookWindowActive = true;

        internal void SetNotebookWindowActive(bool active)
        {
            notebookWindowActive = active;
            if (!active) CancelTypedDrop();
            if (!active && adoptedFolder != null && folders.TryGetValue(adoptedFolder, out var g)) CancelNotebookDrop(g);
        }

        void CancelNotebookDrop(FolderGrant g, bool notify = true)
        {
            var offer = g.Drop;
            if (offer == null) return;
            g.Drop = null;
            offer.Cancellation.Cancel(); offer.Cancellation.Dispose();
            offer.Input?.Dispose(); offer.Input = null;
            if (offer.Generation != pageGeneration) return;
            if (offer.AcceptRequest is int pending) Reply(pending, false);
            if (notify) ui.Post(Json.Write(new Map { ["type"] = "notebookDropCancelled", ["grant"] = g.Project.Grant, ["dropToken"] = offer.Token }));
        }

        internal bool AcceptsNotebookDrop(string path) =>
            adoptedFolder != null && fs.IsAbsolute(path) && FolderProject.Types.SelectMany(FolderProject.AssetExtensions)
                .Contains(Path.GetExtension(path).TrimStart('.'), StringComparer.OrdinalIgnoreCase);

        internal bool OfferNotebookDrop(string path, double x, double y)
        {
            if (!notebookWindowActive || !AcceptsNotebookDrop(path) || !folders.TryGetValue(adoptedFolder, out var g) || g.DropOwner == null) return false;
            CancelNotebookDrop(g);
            var offer = g.Drop = new NotebookDropOffer { Path = path, Owner = g.DropOwner, Epoch = g.DropEpoch, Generation = pageGeneration };
            ui.Post(Json.Write(new Map { ["type"] = "notebookDropOffer", ["grant"] = adoptedFolder, ["dropToken"] = offer.Token,
                ["ownerId"] = offer.Owner, ["epoch"] = offer.Epoch, ["x"] = x, ["y"] = y }));
            return true;
        }

        void NotebookDropAction(int id, string action, string key, FolderGrant g, Map r)
        {
            var offer = g.Drop;
            if (action == "notebookDropTarget")
            {
                long epoch = FolderFormat.Number(FolderFormat.Get(r, "epoch"), MaxDropEpoch);
                if (adoptedFolder != key || epoch <= g.DropEpoch) { Reply(id, false); return; }
                string owner = Str(r, "ownerId");
                g.DropOwner = owner == null ? null : FolderFormat.Id(owner);
                g.DropEpoch = epoch;
                CancelNotebookDrop(g);
                Reply(id, true); return;
            }
            bool matches = offer != null && offer.Token == Str(r, "dropToken") && adoptedFolder == key;
            if (action == "notebookDropCancel")
            {
                if (matches) CancelNotebookDrop(g, false);
                Reply(id, matches); return;
            }
            matches = matches && notebookWindowActive && offer.Owner == Str(r, "ownerId") && offer.Epoch == g.DropEpoch;
            if (action == "notebookDropAccept")
            {
                if (!matches || offer.Accepted || FolderFormat.Number(FolderFormat.Get(r, "epoch"), MaxDropEpoch) != offer.Epoch)
                { Reply(id, false); return; }
                offer.Accepted = true; offer.AcceptRequest = id;
                InspectNotebookDrop(id, g, offer); return;
            }
            if (!matches || offer.Input == null) throw new HostError("Drop the selected notebook attachment again.");
            var input = offer.Input;
            offer.Input = null; // Exactly one caller may stage these selected bytes.
            var cancellation = offer.Cancellation.Token;
            var reading = cancellation.Register(input.Dispose);
            ui.Background(() =>
            {
                try
                {
                    cancellation.ThrowIfCancellationRequested();
                    var staged = (Map)g.Project.StageAsset(offer.Owner, offer.Media, input);
                    staged["name"] = Path.GetFileName(offer.Path);
                    ui.Main(() =>
                    {
                        if (g.Drop != offer) ui.Background(() => g.Project.DropAsset(FolderFormat.Text(staged, "assetToken")));
                        if (offer.Generation == pageGeneration) Reply(id, g.Drop == offer ? staged : null);
                    });
                }
                catch (Exception e) { ui.Main(() => { if (offer.Generation == pageGeneration) Reply(id, null, g.Drop == offer ? Message(e) : null); }); }
                finally { reading.Dispose(); input.Dispose(); }
            });
        }

        void InspectNotebookDrop(int id, FolderGrant g, NotebookDropOffer offer)
        {
            var cancellation = offer.Cancellation.Token;
            ui.Background(() =>
            {
                Stream input = null;
                CancellationTokenRegistration pending = default;
                try
                {
                    cancellation.ThrowIfCancellationRequested();
                    // A project directory can itself have an image-like suffix. Keep its normal open behavior.
                    if (Directory.Exists(offer.Path))
                    {
                        ui.Main(() => { if (g.Drop == offer) { CancelNotebookDrop(g); OpenAtStartup(offer.Path); } });
                        return;
                    }
                    input = ((IFolderPlatform)fs).OpenRegular(offer.Path);
                    var held = input;
                    pending = cancellation.Register(held.Dispose);
                    cancellation.ThrowIfCancellationRequested();
                    if (input.Length < 1 || input.Length > NotebookInput.MaxBytes) throw FolderFormat.Invalid("dropped media size");
                    string media = FolderProject.MediaOf(input);
                    ui.Main(() =>
                    {
                        pending.Dispose();
                        if (g.Drop != offer) { held.Dispose(); return; }
                        offer.Input = held; offer.Media = media; offer.AcceptRequest = null;
                        Reply(id, true);
                    });
                    input = null;
                }
                catch (Exception e)
                {
                    ui.Main(() =>
                    {
                        if (g.Drop != offer) return;
                        offer.AcceptRequest = null;
                        CancelNotebookDrop(g, false); Reply(id, null, Message(e));
                    });
                }
                finally { if (input != null) { pending.Dispose(); input.Dispose(); } }
            });
        }
    }
}
