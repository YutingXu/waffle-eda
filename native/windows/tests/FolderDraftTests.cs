// The child runs the real Windows bridge on one selected project. Each invocation starts with
// fresh grants and an empty attachment-token table. Only the private profile survives restart.
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Linq;
using System.Reflection;
using System.Text;

namespace Waffle.Windows.Tests
{
    using Map = Dictionary<string, object>;

    static partial class Program
    {
        static int DraftCheckWorker()
        {
            try
            {
                var input = (Map)Json.Parse(Console.In.ReadToEnd());
                string root = (string)input["root"];
                var ui = new FakeUi(); var host = new Host(new PortableFs(), ui, new FakeGit(), (string)input["profile"], testTranslators);
                int id = 100;
                object Call(string action, Map fields = null)
                {
                    var request = fields ?? new Map();
                    request["action"] = action; request["id"] = ++id;
                    host.Receive(Policy.PageUri, Json.Write(request));
                    Map reply; lock (ui.Posts) reply = ui.Posts.Last(p => Equals(FolderFormat.Get(p, "id"), (double)id));
                    if (reply["error"] != null) throw new HostError((string)reply["error"]);
                    return reply["result"];
                }
                try
                {
                    host.OpenAtStartup(Path.Combine(root, ManifestName));
                    var file = (Map)((List<object>)Call("open")).Single(); var grant = (Map)file["folderProject"];
                    var args = new Map { ["grant"] = grant["grant"], ["ownerId"] = input["owner"] };
                    Call("folderAdopt", new Map(args));
                    var result = new Map { ["scope"] = grant["draftScope"], ["grant"] = grant["grant"] };
                    try
                    {
                        if (Equals(input["op"], "stage"))
                        {
                            ui.Opens.Enqueue(new[] { (string)input["selection"] });
                            var pick = (Map)Call("folderPickAsset", new Map(args) { ["mediaTypes"] = new[] { "image/png" } });
                            var staged = (Map)Call("folderStageAsset", new Map(args) { ["sourceToken"] = pick["sourceToken"], ["mediaType"] = "image/png" });
                            args["assetToken"] = staged["assetToken"]; args["assetRef"] = staged["assetRef"];
                            var proof = (Map)Call("folderDraftAssetProof", new Map(args));
                            result["token"] = staged["assetToken"]; result["ref"] = staged["assetRef"]; result["proof"] = proof["proof"];
                        }
                        else
                        {
                            args["assetRef"] = input["ref"]; args["proof"] = input["proof"]; args["data"] = input["data"];
                            var restored = (Map)Call("folderRestoreDraftAsset", new Map(args));
                            var asset = (Map)Call("folderReadAsset", new Map(args) { ["assetToken"] = restored["assetToken"],
                                ["offset"] = 0, ["length"] = 4096, ["purpose"] = "render" });
                            result["token"] = restored["assetToken"]; result["owner"] = restored["ownerId"];
                            result["ref"] = restored["assetRef"]; result["data"] = asset["data"];
                        }
                    }
                    catch (HostError e) { result["refused"] = e.Message; }
                    Console.WriteLine(Json.Write(result)); return 0;
                }
                finally { host.Closing(); }
            }
            catch (Exception e) { Console.Error.WriteLine(e); return 1; }
        }

        static Map DraftChild(Map input)
        {
            var start = new ProcessStartInfo(Environment.ProcessPath) {
                UseShellExecute = false, RedirectStandardInput = true, RedirectStandardOutput = true, RedirectStandardError = true
            };
            if (string.Equals(Path.GetFileNameWithoutExtension(Environment.ProcessPath), "dotnet", StringComparison.OrdinalIgnoreCase))
                start.ArgumentList.Add(Assembly.GetEntryAssembly().Location);
            start.ArgumentList.Add("--folder-draft-check");
            using (var child = Process.Start(start))
            {
                child.StandardInput.WriteLine(Json.Write(input)); child.StandardInput.Close();
                var stdout = child.StandardOutput.ReadToEndAsync(); var stderr = child.StandardError.ReadToEndAsync();
                if (!child.WaitForExit(15000)) { child.Kill(); throw new IOException("The private recovery fixture timed out."); }
                if (child.ExitCode != 0) throw new IOException("Private draft child: " + stderr.Result);
                return (Map)Json.Parse(stdout.Result);
            }
        }

        static void FolderDraftTests(string scratch)
        {
            group = "private folder draft restart";
            var root = Path.Combine(scratch, "draft-project"); string profile = Path.Combine(scratch, "draft-profile");
            Directory.CreateDirectory(profile); Directory.CreateDirectory(root);
            void Seed(string folder)
            {
                File.WriteAllText(Path.Combine(folder, ManifestName), SheetManifest());
                File.WriteAllText(Path.Combine(folder, SheetName), Head("schematic", SheetId));
            }
            Seed(root);
            const string data = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jZFcAAAAASUVORK5CYII=";
            var png = Convert.FromBase64String(data);
            string selected = Path.Combine(scratch, "draft-source.png"); File.WriteAllBytes(selected, png);
            var issued = DraftChild(new Map { ["op"] = "stage", ["root"] = root, ["profile"] = profile, ["owner"] = SheetId, ["selection"] = selected });
            string scope = (string)issued["scope"], proof = FolderFormat.Text(issued, "proof");
            Check(FolderFormat.IsDigest(scope) && FolderFormat.IsDigest(proof), "a native-selected asset produced a folder scope and authenticated proof");
            var reference = (Map)issued["ref"];
            Check((string)reference["sha256"] == FolderFormat.Sha(png) && (double)reference["byteLength"] == png.Length &&
                File.ReadAllBytes(Path.Combine(profile, "folder-recovery", "provenance-v1")).Length == 32, "the receipt uses the private profile and complete selected bytes");
            string moved = Path.Combine(scratch, "renamed-draft-project"); Directory.Move(root, moved);
            var request = new Map { ["op"] = "restore", ["root"] = moved, ["profile"] = profile, ["owner"] = SheetId, ["proof"] = proof,
                ["ref"] = reference, ["data"] = data };
            var restored = DraftChild(request);
            Check((string)restored["scope"] == scope && !Equals(restored["grant"], issued["grant"]) && !Equals(restored["token"], issued["token"]),
                "a fresh process and a renamed physical directory retain the scope and issue new window and asset tokens");
            Check(Equals(restored["owner"], SheetId) && Equals(restored["data"], data) &&
                (string)((Map)restored["ref"])["sha256"] == FolderFormat.Sha(png), "first authenticated restore yields the original preview bytes and owner");

            var altered = png.ToArray(); altered[altered.Length - 1] ^= 1;
            Directory.CreateDirectory(root); Seed(root);
            var replacement = DraftChild(new Map(request) { ["root"] = root });
            Check(!Equals(replacement["scope"], scope) && FolderFormat.Text(replacement, "refused")?.Contains("attachment receipt") == true && !replacement.ContainsKey("token"),
                "a different physical folder at the original path cannot restore the draft");
            foreach (var pair in new Dictionary<string, object> { ["owner"] = "another-sheet",
                ["proof"] = (proof[0] == '0' ? "1" : "0") + proof.Substring(1), ["data"] = Convert.ToBase64String(altered) })
            {
                var refused = DraftChild(new Map(request) { [pair.Key] = pair.Value });
                string reason = pair.Key == "data" ? "attachment bytes" : "attachment receipt";
                Check(FolderFormat.Text(refused, "refused")?.Contains(reason) == true && !refused.ContainsKey("token"), "a changed " + pair.Key + " declines without a staged attachment");
            }
            Check(Directory.GetFileSystemEntries(root).Length == 2 && Directory.GetFileSystemEntries(moved).Length == 2 &&
                File.ReadAllText(Path.Combine(moved, SheetName)) == Head("schematic", SheetId), "draft proof and restore leave both authored folders untouched");
        }
    }
}
