// Tests for the Windows host's shared core. No test framework: `dotnet run` exits non-zero on failure.
using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Text;

namespace Waffle.Windows.Tests
{
    sealed class FakeUi : IHostUi, INotebookClipboard, IImportSaveUi, IFolderUi
    {
        public readonly List<Dictionary<string, object>> Posts = new List<Dictionary<string, object>>();
        internal Func<NotebookClipboardItem> NotebookClipboard;
        public NotebookClipboardItem ReadNotebookClipboard() => NotebookClipboard?.Invoke();
        public Queue<IList<string>> Opens = new Queue<IList<string>>();
        public Queue<string> Saves = new Queue<string>();
        internal string ImportAnswer="cancel", OfferedExport, OfferedDetail;
        internal int ImportPrompts;
        public void ChooseImportSave(string title,string detail,string save,string export,string cancel,Action<string> done)
        {ImportPrompts++; OfferedExport=export; OfferedDetail=detail; done(ImportAnswer);}
        public void CancelImportChoice(){}
        public void PickImportFiles(IList<string> types,Func<bool> current,Action<IList<string>> done)
        {if(current())PickOpen(new OpenRequest{Extensions=types,Multiple=true},done);else done(null);}
        public void PickImportDestination(string name,bool single,string title,Func<bool> current,Action<string> done)
        {if(!current())done(null);else if(single)PickSave(new SaveRequest{FileName=name,Title=title},done);else PickFolder(true,done);}
        public void PickFolder(bool create,Action<string> done)=>done(Saves.Count>0?Saves.Dequeue():null);
        public OpenRequest LastOpen;
        public SaveRequest LastSave;
        public string ClipCustom, ClipText;
        public bool Dirty;
        public List<string> ShellRecent = new List<string>();
        public List<IList<string>> OpenWindows = new List<IList<string>>();

        public void PickOpen(OpenRequest request, Action<IList<string>> done) { LastOpen = request; done(Opens.Count > 0 ? Opens.Dequeue() : null); }
        public void OpenProjectWindow(IList<string> paths) => OpenWindows.Add(paths);
        public void PickSave(SaveRequest request, Action<string> done) { LastSave = request; done(Saves.Count > 0 ? Saves.Dequeue() : null); }
        public void Post(string json) { lock (Posts) Posts.Add((Dictionary<string, object>)Json.Parse(json)); }
        public void SetDirty(bool dirty) => Dirty = dirty;
        public bool WriteClipboard(string custom, string text) { ClipCustom = custom; ClipText = text; return true; }
        public void ReadClipboard(out string custom, out string text) { custom = ClipCustom; text = ClipText; }
        internal Action<Action> ScheduleBackground;
        public void Background(Action work) { if (ScheduleBackground == null) work(); else ScheduleBackground(work); }
        public void Main(Action work) => work();
        public void NoteShellRecent(string path) => ShellRecent.Add(path);

        public Dictionary<string, object> Last => Posts[Posts.Count - 1];
    }

    sealed class FakeGit : IGitRunner, IArchiveRunner
    {
        public object Archive(string action,Dictionary<string,object> args)=>PortableArchive.Run(new PortableFs(),action,args);
        public IList<string> Arguments;
        public GitResult Result = new GitResult { ExitCode = 0, Output = Encoding.UTF8.GetBytes("{\"commits\":[]}"), Errors = "" };
        public GitResult Run(IList<string> arguments) { Arguments = arguments; return Result; }
    }

    static partial class Program
    {
        static int passed, failed;
        static string group = "";
        static readonly TranslatorFiles testTranslators = TranslatorFiles.Parse(@"[
            {""id"":""legacy"",""import"":true,""extensions"":["".waffle"","".atrium""]},
            {""id"":""altium"",""import"":true,""extensions"":["".prjpcb"","".schdoc"","".pcbdoc"","".schlib"","".pcblib""],""libraryExtensions"":["".schlib"","".pcblib""]},
            {""id"":""kicad"",""import"":true,""extensions"":["".kicad_pro"","".kicad_sch"","".kicad_pcb"","".kicad_sym"","".kicad_mod""],""libraryExtensions"":["".kicad_sym"","".kicad_mod""]},
            {""id"":""gerber"",""import"":false,""export"":true,""extensions"":["".gbr""]}
        ]");

        static string OpenFolder(Host host, FakeUi ui, string path)
        {
            File.WriteAllText(path, SheetManifest()); File.WriteAllText(Path.Combine(Path.GetDirectoryName(path),SheetName), Head("schematic", SheetId));
            host.OpenAtStartup(path);
            host.Receive(Policy.PageUri, Msg("id",101,"action","open"));
            var selected = (Dictionary<string, object>)((List<object>)ui.Last["result"]).Single();
            var grant = (string)((Dictionary<string, object>)selected["folderProject"])["grant"];
            host.Receive(Policy.PageUri, Msg("id",102,"action","folderAdopt","grant",grant));
            return grant;
        }

        static void Check(bool ok, string what)
        {
            if (ok) passed++;
            else { failed++; Console.WriteLine("FAIL " + group + ": " + what); }
        }

        static void Throws(Action act, string fragment, string what)
        {
            try { act(); Check(false, what + " (no error)"); }
            catch (Exception e) { Check(e.Message.Contains(fragment), what + " (" + e.Message + ")"); }
        }

        static int Main(string[] args)
        {
            if (args.Length == 2 && args[0] == "--project-header-corpus")
            {
                var support = Directory.CreateDirectory(Path.Combine(Path.GetTempPath(),"waffle-corpus-" + Guid.NewGuid().ToString("N")));
                try
                {
                    int count = 0;
                    foreach (var file in Directory.EnumerateFiles(args[1]))
                    {
                        var ui = new FakeUi();
                        var host = new Host(new PortableFs(),ui,new FakeGit(),support.FullName,testTranslators);
                        host.OpenAtStartup(file);
                        host.Receive(Policy.PageUri,Msg("id",1,"action","open"));
                        if (!Equals(ui.Last["error"],Policy.PreReleaseMessage) || host.DesignPath != null) return 1;
                        host.Closing();
                        count++;
                    }
                    Console.WriteLine("PASS {0} retired project selections",count);
                    return count >= 33 ? 0 : 1;
                }
                finally { support.Delete(true); }
            }
            if (args.Length == 1 && args[0] == "--folder-draft-check") return DraftCheckWorker();
            if (args.Length == 2 && args[0] == "--folder-mcp") return FolderMcp.Run(new PortableFs(),args[1],Console.In,Console.Out);
            if (args.Length == 4 && args[0] == "--folder-worker") return FolderWorker.Run(args);
            if (args.Length == 1 && args[0] == "--native-member-check") return StandaloneMemberCheck();
            if (args.Length == 3 && args[0] == "--lan-relay") return LanRelayDriver(args[1], args[2]);
            if (args.Length == 1 && args[0] == "--workspace-routing")
            {
                WorkspaceRoutingTests();
                Console.WriteLine("{0} Windows workspace router checks passed, {1} failed",passed,failed);
                return failed == 0 ? 0 : 1;
            }
            var scratch = Path.Combine(Path.GetTempPath(), "atrium-win-tests-" + Guid.NewGuid().ToString("N").Substring(0, 8));
            Directory.CreateDirectory(scratch);
            scratch = new PortableFs().Canonical(scratch);
            try
            {
                if (args.Length == 1 && args[0] == "--native-document-open")
                {
                    DocumentOpenTests(scratch);
                    Console.WriteLine("{0} native document checks passed, {1} failed", passed, failed);
                    return failed == 0 ? 0 : 1;
                }
                JsonTests();
                PolicyTests();
                NativeSupportPathTests(scratch);
                SupportArchitectureTests(scratch);
                PowerSavingTests();
                PromisedDropTests();
                WinPathTests();
                WindowedInputControllerTests();
                WindowTests();
                WorkspaceRoutingTests();
                FolderTests(scratch);
                StandaloneMemberTests(scratch);
                DocumentOpenTests(scratch);
                FolderDraftTests(scratch);
                ImportSaveTests(scratch);
                NotebookClipboardTests(scratch);
                GitQueryParityTests();
                HostStateTests(scratch);
                CopySourceTests(scratch);
                BridgeTests(scratch);
                RendererFailureTests(scratch);
                GitTests();
                CollabLockTests(scratch);
                LanTests(scratch);
                ExternalApprovalTests(scratch);
            }
            catch (Exception e) { failed++; Console.WriteLine("FAIL " + group + ": unexpected " + e); }
            finally { try { Directory.Delete(scratch, true); } catch (Exception) { } }
            Console.WriteLine((failed == 0 ? "PASS" : "FAILED") + ": " + passed + " checks passed, " + failed + " failed.");
            return failed == 0 ? 0 : 1;
        }

        static void SupportArchitectureTests(string scratch)
        {
            group = "Windows support architecture";
            Check(Native.SupportArchitectureName(0x8664) == "x64", "the AMD64 native machine is x64");
            Check(Native.SupportArchitectureName(0xAA64) == "arm64", "the ARM64 native machine is arm64");
            Check(Native.SupportArchitectureName(0) == "unknown" && Native.SupportArchitectureName(0x014C) == "unknown",
                "other machine codes stay unknown");

            var ui = new FakeUi();
            int probes = 0;
            string architecture = null;
            var host = new Host(new PortableFs(), ui, new FakeGit(), Path.Combine(scratch, "support-architecture"), testTranslators,
                supportArchitecture: () => { probes++; return architecture; });
            Check(probes == 0, "creating a host does not probe the machine");
            foreach (var name in new[] { "x64", "arm64", "synthetic private machine name", null })
            {
                architecture = name;
                host.Receive(Policy.PageUri, Msg("id", probes + 1, "action", "supportDiagnostics"));
                var facts = (Dictionary<string, object>)ui.Last["result"];
                Check((string)facts["architecture"] == (name == "x64" || name == "arm64" ? name : "unknown"),
                    "the report returns only an allowed architecture label");
            }
            Check(probes == 4, "the machine is queried only for each requested support report");
            host.Closing();
            if (OperatingSystem.IsWindows() && IntPtr.Size == 8)
            {
                string native = Native.SupportArchitecture();
                Check(native == "x64" || native == "arm64", "the native query reports a supported 64-bit host");
            }
        }

        // As tests/core/power.cjs: Automatic follows energy saver / battery saver, never the battery alone.
        static void PowerSavingTests()
        {
            group = "Windows power saving";
            var p = new PowerSaving();
            Check(!p.LowPower && p.State() == "{\"lowPower\":false}", "nothing reported: not saving power");
            var first = p.Script(false);
            Check(first != null && first.Contains("globalThis.__atriumPowerState={\"lowPower\":false}") &&
                  first.Contains("new CustomEvent('atrium-power',{detail:{\"lowPower\":false}})"), "the page hears the first state: " + first);
            Check(p.Script(false) == null, "no script when nothing changed");
            Check(p.Script(true) != null, "a navigation sends the state again");
            p.StatusFlag(0);
            Check(!p.LowPower && p.Script(false) == null, "on battery with battery saver off is not low power");
            p.StatusFlag(1);
            Check(p.LowPower && p.Script(false).Contains("{\"lowPower\":true}"), "SystemStatusFlag 1: battery saver on");
            p.StatusFlag(0);
            Check(!p.LowPower, "battery saver off again");
            Check(p.Setting(PowerSaving.PowerSavingStatus, 1) && p.LowPower, "GUID_POWER_SAVING_STATUS 1");
            Check(p.Setting(PowerSaving.PowerSavingStatus, 0) && !p.LowPower, "GUID_POWER_SAVING_STATUS 0");
            Check(p.Setting(PowerSaving.EnergySaverStatus, 2) && p.LowPower, "energy saver high savings");
            Check(p.Setting(PowerSaving.EnergySaverStatus, 1) && p.LowPower, "energy saver standard");
            Check(p.Setting(PowerSaving.EnergySaverStatus, 0) && !p.LowPower, "energy saver off");
            Check(!p.Setting(Guid.NewGuid(), 1) && !p.LowPower, "another power setting is ignored");
            Check(System.Runtime.InteropServices.Marshal.SizeOf<Native.SYSTEM_POWER_STATUS>() == 12, "SYSTEM_POWER_STATUS is 12 bytes");
            Check(System.Runtime.InteropServices.Marshal.SizeOf<Native.POWERBROADCAST_SETTING>() == Native.PowerSettingData,
                "POWERBROADCAST_SETTING's value follows its 20-byte head");
            if (OperatingSystem.IsWindows())
                Check(Native.GetSystemPowerStatus(out var status) && status.SystemStatusFlag <= 1, "GetSystemPowerStatus answers on Windows");
        }

        static void NativeSupportPathTests(string scratch)
        {
            group = "Windows qualification support path";
            string local = Path.Combine(scratch, "Local AppData");
            Check(NativeSupportPath.Resolve(local, null, false) == Path.Combine(local, "Waffle"), "ordinary launches keep the user profile");
            var runA = Directory.CreateDirectory(Path.Combine(scratch, "waffle-preview-" + Guid.NewGuid().ToString("N")));
            var runB = Directory.CreateDirectory(Path.Combine(scratch, "waffle-preview-" + Guid.NewGuid().ToString("N")));
            var a = NativeSupportPath.Resolve(local, runA.FullName, true);
            var b = NativeSupportPath.Resolve(local, runB.FullName, true);
            Check(a == Path.Combine(runA.FullName, "waffle-native-profile") && !Directory.Exists(a), "qualification resolves before creating state");
            Check(a != b && b == Path.Combine(runB.FullName, "waffle-native-profile"), "separate runs cannot share a profile");
            foreach (var path in new[] { scratch, runA.Name })
            {
                try { NativeSupportPath.Resolve(local, path, true); Check(false, "unsafe test directory rejected"); }
                catch (ArgumentException) { Check(true, "unsafe test directory rejected"); }
            }
            Directory.CreateDirectory(a);
            try { NativeSupportPath.Resolve(local, runA.FullName, true); Check(false, "existing test profile rejected"); }
            catch (ArgumentException) { Check(true, "existing test profile rejected"); }
        }

        // ------------------------------------------------------------------ run:external approval
        // As native/tests/external_tools.py: one extension version (id@sha256), tool and program, within the
        // declared argument template; any other argument asks for that exact command.
        static void ExternalApprovalTests(string scratch)
        {
            group = "run:external approval";
            var tools = new ExternalTools(Path.Combine(scratch, "external-support"), new PortableFs());
            var prog = Path.Combine(scratch, "ngspice_con.exe");
            File.WriteAllText(prog, "MZ");
            string v1 = "sha256:" + new string('1', 64), v2 = "sha256:" + new string('2', 64);
            ExternalTools.Run Req(object[] args, string hash = null, string ext = "ext.a", object template = null) =>
                ExternalTools.Check(new Dictionary<string, object> {
                    { "tool", "ngspice" }, { "toolName", "ngspice" }, { "extension", ext }, { "extensionName", "Sim" }, { "extensionHash", hash ?? v1 },
                    { "argTemplate", template ?? new List<object> { "-b", "-r", "--out={output}" } }, { "args", new List<object>(args) },
                    { "files", new List<object> { new Dictionary<string, object> { { "name", "deck.cir" }, { "data", "KiBkZWNrCg==" } } } },
                    { "outputs", new List<object> { "*.raw" } } });
            var first = Req(new object[] { "-b", "-r", "out.raw", "deck.cir" });
            first.RunId = "approval-test";
            var ticket = tools.Reserve(first);
            tools.Cancel(first.RunId);
            Check(ticket.Cancelled && (bool)tools.Execute("unconfigured", first, ticket)["cancelled"], "cancelling during approval prevents a process launch");
            var nextTicket = tools.Reserve(first);
            Check(!nextTicket.Cancelled, "a later run obtains a fresh ticket");
            tools.Release(nextTicket);
            var need = tools.ApprovalNeeded(first, prog);
            Check(need != null && need.Program && !need.Command, "the first run asks for the program");
            Check(need != null && need.Detail.Contains(ExternalTools.CommandLine(prog, first.Args)) && need.Detail.Contains("-b -r --out={output}"), "it shows the full command and the declared arguments");
            tools.RecordApproval(first, need);
            Check(tools.ApprovalNeeded(first, prog) == null, "then it runs");
            foreach (var args in new[] { new object[] { "deck.cir" }, new object[] { "-r", "tran.raw", "-b", "deck.cir" }, new object[] { "--out=x.raw" } })
                Check(tools.ApprovalNeeded(Req(args), prog) == null, "within the template: " + string.Join(" ", args));
            foreach (var args in new[] { new object[] { "-c", "deck.cir" }, new object[] { "-b", "C:\\Windows\\win.ini" }, new object[] { "--out=x.cir" }, new object[] { "--out=..\\x.raw" } })
            {
                var n = tools.ApprovalNeeded(Req(args), prog);
                Check(n != null && !n.Program && n.Command && n.Detail.Contains("does not declare"), "outside the template asks: " + string.Join(" ", args));
            }
            var odd = Req(new object[] { "-c", "deck.cir" });
            tools.RecordApproval(odd, tools.ApprovalNeeded(odd, prog));
            Check(tools.ApprovalNeeded(odd, prog) == null, "that exact command is remembered");
            Check(tools.ApprovalNeeded(Req(new object[] { "-c", "deck.cir", "x" }), prog) != null, "another one asks again");
            Check(tools.ApprovalNeeded(Req(new object[] { "-b" }, v2), prog)?.Program == true, "a new extension version asks again");
            Check(tools.ApprovalNeeded(Req(new object[] { "-b" }, null, "ext.b"), prog)?.Program == true, "another extension asks");
            tools.Approve("ext.a", "ngspice", ExternalTools.Resolved(prog));
            Check(tools.ApprovalNeeded(Req(new object[] { "-b" }, null, "ext.z"), prog)?.Program == true, "an approval without the version does not count");
            Throws(() => Req(new object[0], "sha256:xyz"), "version", "a request without a valid version is refused");
            Throws(() => Req(new object[0], null, ""), "version", "and without the extension");
            Throws(() => Req(new object[0], null, "ext.a", new List<object> { "{input}{output}" }), "template", "a template entry with two placeholders is refused");
            tools.Forget("ngspice");
            Check(tools.ApprovalNeeded(first, prog)?.Program == true, "forgetting the tool drops its approvals");
        }

        // ------------------------------------------------------------------ JSON

        static void JsonTests()
        {
            group = "json";
            var value = (Dictionary<string, object>)Json.Parse("{\"id\":3,\"action\":\"save\",\"text\":\"a\\n\\u00e9\\\"\",\"list\":[true,false,null,-1.5e2],\"o\":{}}");
            Check((double)value["id"] == 3, "integer id");
            Check((string)value["text"] == "a\n\u00e9\"", "escapes");
            var list = (List<object>)value["list"];
            Check((bool)list[0] && !(bool)list[1] && list[2] == null && (double)list[3] == -150, "array values");
            var written = Json.Write(new Dictionary<string, object> { { "b", "x\u2028y</script>" }, { "a", new List<object> { 1, 2.5, null, true } } });
            Check(written == "{\"a\":[1,2.5,null,true],\"b\":\"x\\u2028y</script>\"}", "written: " + written);
            Check(((Dictionary<string, object>)Json.Parse(written))["b"] as string == "x\u2028y</script>", "round trip");
            foreach (var bad in new[] { "", "{", "{\"a\":}", "[1,]", "01", "1.", "\"\u0001\"", "{\"a\":1} x", "nul", "\"\\x\"", "1e999" })
                Throws(() => Json.Parse(bad), "", "rejects " + bad);
            Throws(() => Json.Parse(new string('[', 70) + new string(']', 70)), "deeply", "depth limit");
            var big = new string('x', 2_000_000);
            Check((string)Json.Parse(Json.Write(big)) == big, "large string");
        }

        // ------------------------------------------------------------------ navigation and types

        static void PolicyTests()
        {
            group = "navigation";
            Check(Policy.AllowMainFrame("https://app.waffle.example/index.html"), "editor page");
            foreach (var uri in new[] { "https://app.waffle.example/index.html?x=1", "https://app.waffle.example/other.html", "https://APP.waffle.example/index.html",
                                        "http://app.waffle.example/index.html", "https://example.com/", "file:///C:/Waffle/app/index.html", "about:blank",
                                        "about:srcdoc", "javascript:alert(1)", "data:text/html,x", "blob:https://app.waffle.example/1", "", null })
                Check(!Policy.AllowMainFrame(uri), "main frame refuses " + uri);
            Check(Policy.AllowSubframe("about:srcdoc") && Policy.AllowSubframe("about:blank"), "inline subframes");
            foreach (var uri in new[] { "https://app.waffle.example/index.html", "about:blank#x", "about:srcdoc?x", "https://evil.example/", "data:text/html,x", "javascript:1", null })
                Check(!Policy.AllowSubframe(uri), "subframe refuses " + uri);
            Check(Policy.TrustedSource(Policy.PageUri) && !Policy.TrustedSource("about:srcdoc"), "message sources");

            group = "types";
            Check(Policy.Extension("C:\\a\\B.SchDoc") == "schdoc" && Policy.Extension("x/y.waffle") == "waffle" && Policy.Extension(".hidden") == "" && Policy.Extension("a.") == "", "extensions");
            Check(Policy.BaseName("C:\\x\\..\\evil.waffle") == "evil.waffle" && Policy.BaseName("a/b.csv") == "b.csv", "base names");
            Check(string.Join(",", Policy.Extensions(new List<object> { ".SchDoc", "atrium" })) == "schdoc,atrium", "normalised extension list");
            Check(Policy.Extensions(new List<object> { 3 }) == null && Policy.Extensions("x") == null, "malformed extension lists");
            Check(Policy.ExchangeOutputs.Contains("g30") && !Policy.ExchangeOutputs.Contains("g31") && !Policy.ExchangeOutputs.Contains("atrium") && !Policy.ExchangeOutputs.Contains("exe"), "outputs");
            Check(!Policy.ExchangeInputs.Contains("exe") && Policy.ExchangeInputs.Contains("atrlib"), "inputs");
            Check(Policy.IsFullCommit(new string('a', 40)) && Policy.IsFullCommit(new string('0', 64)) && !Policy.IsFullCommit("HEAD") && !Policy.IsFullCommit(new string('A', 40)), "commits");
        }

        static void WinPathTests()
        {
            group = "windows paths";
            foreach (var ok in new[] { "C:\\Users\\me\\Board.waffle", "d:\\x.atrlib", "\\\\server\\share\\lib\\parts.atrlib", "C:\\a b\\c.d\\Design v2.waffle", "C:\\Con.d\\x.json".Replace("Con.d", "Contoso") })
                Check(WinPath.Acceptable(ok), "accepts " + ok);
            foreach (var bad in new object[] {
                null, 5, "", "Board.waffle", "..\\Board.waffle", "C:Board.waffle", "C:/Users/me/Board.waffle", "/Users/me/Board.waffle",
                "C:\\Users\\..\\Windows\\x.json", "C:\\Users\\.\\x.json", "C:\\Users\\\\x.json", "C:\\x.atrium:stream", "C:\\x.atrium\\",
                "\\\\?\\C:\\x.json", "\\\\.\\PhysicalDrive0", "\\\\server", "\\\\server\\share", "C:\\x\\CON", "C:\\x\\nul.json", "C:\\x\\com1.waffle",
                "C:\\x\\LPT\u00b9.json", "C:\\x\\name.", "C:\\x\\name ", "C:\\x\\a*.json", "C:\\x\\a?.json", "C:\\x\\a\u0001.json", "C:\\x\\a|b.json",
                "C:\\" + new string('a', 4100) })
                Check(!WinPath.Acceptable(bad), "refuses " + (bad as string ?? "(non-string)").Replace("\u0001", "^A"));
            Check(WinPath.FromFinalPath("\\\\?\\C:\\a\\b") == "C:\\a\\b", "drive final path");
            Check(WinPath.FromFinalPath("\\\\?\\UNC\\srv\\share\\a") == "\\\\srv\\share\\a", "UNC final path");
        }

        static void WindowTests()
        {
            group = "window state";
            var primary = new Rect(0, 0, 1920, 1040);
            var areas = new List<Rect> { primary, new Rect(1920, 0, 2560, 1400) };
            var def = WindowFrame.Default(primary, 1.0);
            Check(def.Width == 1380 && def.Height == 870 && def.X == 270, "default frame " + def);
            var small = WindowFrame.Default(new Rect(0, 0, 1280, 720), 1.5);
            Check(small.Width == (int)(1280 * 0.94) && small.Height == (int)(720 * 0.91), "default fits the screen " + small);
            var saved = new WindowFrame { Bounds = new Rect(2000, 100, 1200, 800), Maximized = true };
            var parsed = WindowFrame.Parse(saved.Serialize());
            Check(parsed.Maximized && parsed.Bounds.X == 2000 && parsed.Bounds.Width == 1200, "round trip");
            Check(WindowFrame.Restore(parsed, areas, primary, 1, 770, 500).X == 2000, "second monitor kept");
            var gone = new WindowFrame { Bounds = new Rect(5000, 100, 1200, 800) };
            Check(WindowFrame.Restore(gone, areas, primary, 1, 770, 500).X == def.X, "disconnected monitor falls back");
            var tiny = new WindowFrame { Bounds = new Rect(10, 10, 100, 50) };
            var r = WindowFrame.Restore(tiny, areas, primary, 1, 770, 500);
            Check(r.Width == 770 && r.Height == 500, "minimum size");
            Check(WindowFrame.Parse("{\"x\":1}") == null && WindowFrame.Parse("garbage") == null && WindowFrame.Parse("{\"x\":1e9,\"y\":0,\"width\":1,\"height\":1}") == null, "bad frames");
        }

        // ------------------------------------------------------------------ recent, libraries, recovery

        static void HostStateTests(string scratch)
        {
            group = "recent projects";
            var fs = new PortableFs();
            var support = Path.Combine(scratch, "support");
            var work = Directory.CreateDirectory(Path.Combine(scratch, "state")).FullName;
            var project = Path.Combine(work, "Board.waffle");
            File.WriteAllText(project, "{\"documents\":[]}");
            var recent = new RecentProjects(fs, support);
            recent.Note(project, new DateTime(1970, 1, 1, 0, 16, 40, DateTimeKind.Utc));
            var listing = recent.Listing();
            Check(listing.Count == 1 && (double)((Dictionary<string, object>)listing[0])["openedAt"] == 1000000, "noted with its time");
            Check(recent.Allowed(project) == fs.Canonical(project), "allowed");
            foreach (var bad in new object[] { null, 3, "Board.waffle", project + "x", Path.Combine(work, "..", "state", "Board.waffle") })
                Throws(() => recent.Allowed(bad), "not in the recent", "refuses " + bad);
            for (int i = 0; i < 20; i++) { var p = Path.Combine(work, "p" + i + ".waffle"); File.WriteAllText(p, "{}"); recent.Note(p); }
            Check(recent.Entries.Count == Policy.RecentLimit, "limit");
            var again = new RecentProjects(fs, support);
            Check(again.Entries.Select(e => e.Key).SequenceEqual(recent.Entries.Select(e => e.Key)) && again.Entries[0].Key.EndsWith("p19.waffle"), "persisted in order");
            recent.Note(Path.Combine(work, "notes.txt"));
            Check(!recent.Entries.Any(e => e.Key.EndsWith(".txt")), "only projects are noted");
            File.Delete(Path.Combine(work, "p19.waffle"));
            Check(!recent.Listing().Cast<Dictionary<string, object>>().Any(e => ((string)e["path"]).EndsWith("p19.waffle")), "missing files are not listed");
            Check(recent.Listing(checkAvailability:false).Cast<Dictionary<string, object>>().Any(e => ((string)e["path"]).EndsWith("p19.waffle")),
                  "Welcome reads cached metadata before checking absolute paths");
            Throws(() => recent.Allowed(Path.Combine(work, "p19.waffle")), "no longer available", "cached display never bypasses opening validation");
            File.WriteAllText(Path.Combine(support, "recent-projects.json"), "[{\"path\":\"relative.waffle\"},{\"path\":\"" + project.Replace("\\", "\\\\") + "\"},{\"path\":\"/etc/passwd\"},7]");
            Check(new RecentProjects(fs, support).Entries.Count == 1, "tampered list entries are dropped");
            File.WriteAllText(Path.Combine(support, "recent-projects.json"), "not json");
            Check(new RecentProjects(fs, support).Entries.Count == 0, "a damaged list is empty");
            if (!OperatingSystem.IsWindows())
                Check(File.GetUnixFileMode(Path.Combine(support, "recent-projects.json")) == (UnixFileMode.UserRead | UnixFileMode.UserWrite), "private list");
            recent.Clear();
            Check(new RecentProjects(fs, support).Entries.Count == 0, "cleared");

            group = "library reads";
            var library = Path.Combine(work, "parts.atrlib");
            File.WriteAllText(library, "{\"format\":\"atrium-library\",\"defs\":[]}");
            var reads = new LibraryReads(fs, support);
            Throws(() => reads.Read(library), "Open this library file again", "unknown files are refused");
            reads.Remember(library);
            Check(((string)reads.Read(library)["text"]).StartsWith("{\"format\""), "remembered file reads");
            Check((string)new LibraryReads(fs, support).Read(library)["name"] == "parts.atrlib", "persisted");
            reads.Remember(Path.Combine(work, "Board.waffle"));
            Throws(() => reads.Read(project), "Open this library", "non-library files are never remembered");
            File.WriteAllText(library, "[1,2]");
            Throws(() => reads.Read(library), "not a JSON library", "arrays are refused");
            File.WriteAllBytes(library, new byte[] { 0xff, 0xfe, 0x7b });
            Throws(() => reads.Read(library), "not a JSON library", "invalid UTF-8 is refused");
            File.WriteAllText(library, "\uFEFF{\"defs\":[]}");
            Check(reads.Read(library) != null, "a BOM is accepted");
            if (!OperatingSystem.IsWindows())
            {
                var real = Path.Combine(work, "real.json");
                File.WriteAllText(real, "{}");
                var linked = Path.Combine(work, "linked.json");
                reads.Remember(real);
                File.Move(real, Path.Combine(work, "moved.json"));
                File.CreateSymbolicLink(real, Path.Combine(work, "moved.json"));
                Throws(() => reads.Read(real), "Open this library", "a path that became a link no longer matches");
                _ = linked;
            }

        }

        static void CopySourceTests(string scratch)
        {
            group = "altium copy source";
            var fs = new PortableFs();
            var work = Directory.CreateDirectory(Path.Combine(scratch, "copies")).FullName;
            var original = Path.Combine(work, "design.SchDoc");
            File.WriteAllBytes(original, new byte[] { 1, 2, 3 });
            using (var source = new AltiumCopySource(fs, original))
            {
                Check(source.Read().SequenceEqual(new byte[] { 1, 2, 3 }), "read");
                Throws(() => source.SaveCopy(new byte[] { 9 }, original), "original Altium source", "the source itself");
                Throws(() => source.SaveCopy(new byte[] { 9 }, Path.Combine(work, "copy.PcbDoc")), "same extension", "another extension");
                if (!OperatingSystem.IsWindows())
                {
                    var alias = Path.Combine(work, "alias.SchDoc");
                    File.CreateSymbolicLink(alias, original);
                    Throws(() => source.SaveCopy(new byte[] { 9 }, alias), "original Altium source", "a link to the source");
                }
                source.SaveCopy(new byte[] { 7 }, Path.Combine(work, "edited.SchDoc"));
                Check(File.ReadAllBytes(Path.Combine(work, "edited.SchDoc"))[0] == 7 && File.ReadAllBytes(original)[0] == 1, "copy written, source kept");
            }
        }

        // ------------------------------------------------------------------ bridge protocol

        static string Msg(params object[] pairs)
        {
            var d = new Dictionary<string, object>();
            for (int i = 0; i < pairs.Length; i += 2) d[(string)pairs[i]] = pairs[i + 1];
            return Json.Write(d);
        }

        static void BridgeTests(string scratch)
        {
            group = "bridge";
            var fs = new PortableFs();
            var work = Directory.CreateDirectory(Path.Combine(scratch, "bridge")).FullName;
            var support = Path.Combine(scratch, "bridge-support");
            var project = Path.Combine(work, "A.waffle");
            File.WriteAllText(project, "{\"documents\":[]}");
            var ui = new FakeUi();
            var git = new FakeGit();
            var host = new Host(fs, ui, git, support, testTranslators);
            string page = Policy.PageUri;

            host.Receive("about:srcdoc", Msg("id", 1, "action", "recentFiles"));
            host.Receive("https://evil.example/", Msg("id", 1, "action", "recentFiles"));
            host.Receive(page, "not json");
            host.Receive(page, "[1]");
            host.Receive(page, Msg("id", 1.5, "action", "recentFiles"));
            host.Receive(page, Msg("id", -1, "action", "recentFiles"));
            host.Receive(page, Msg("id", "1", "action", "recentFiles"));
            Check(ui.Posts.Count == 0, "untrusted or malformed messages get no reply");
            host.Receive(page, Msg("id", 2, "action", "launchMissiles"));
            Check((string)ui.Last["error"] == "Unknown file action." && (double)ui.Last["id"] == 2, "unknown action");

            // Commands reach the page only once it has loaded.
            host.Command("open");
            Check(ui.Posts.Count == 1, "no command before the page is ready");
            host.OpenAtStartup(project);
            host.PageReady();
            Check((string)ui.Last["command"] == "open", "startup project asks the page to open");
            host.Receive(page, Msg("id", 3, "action", "open"));
            Check(Equals(ui.Last["error"], Policy.PreReleaseMessage) && Equals(ui.Last["code"],"pre-release-format") && ui.Last["result"] == null,
                "a pre-release command-line .waffle is rejected without minting any file grant");
            string originalText = File.ReadAllText(project);
            foreach (var old in new[] {project,Path.Combine(work,"Pre-release.ATRIUM")})
            {
                File.WriteAllText(old, originalText);
                File.WriteAllText(old + ".journal","old saved edit"); File.WriteAllText(old + "~","old private draft");
                var selected = new Host(fs,ui,git,support,testTranslators);
                selected.OpenAtStartup(old); selected.Receive(page,Msg("id",21,"action","open"));
                Check(Equals(ui.Last["error"],Policy.PreReleaseMessage) && ui.Last["result"] == null && selected.DesignPath == null,"explicit pre-release selection receives the precise rejection");
                ui.Opens.Enqueue(new[] {old}); selected.Receive(page,Msg("id",22,"action","open"));
                Check(Equals(ui.Last["error"],Policy.PreReleaseMessage) && !ui.LastOpen.Extensions.Contains("atrium"),"a bypassed picker refuses the old extension and never offers it");
                foreach (var action in new[]{"save","saveInPlace","compactProject","writeRecovery","pendingRecovery","discardRecovery","backupProject"})
                {
                    selected.Receive(page,Msg("id",23,"action",action,"text","{}")); Check(Equals(ui.Last["error"],"Unknown file action."),"pre-release operation retired: "+action);
                }
                selected.Closing();
                Check(File.ReadAllText(old)==originalText && File.ReadAllText(old+".journal")=="old saved edit" && File.ReadAllText(old+"~")=="old private draft","closing changes none of the pre-release data or companions");
            }
            var grant = OpenFolder(host,ui,Path.Combine(work,"Current.waffle"));
            Check(host.DesignPath.EndsWith("Current.waffle"),"an accepted current folder binds its manifest");

            // A single project in the normal picker expands only its declared design files.
            string fixtures = Directory.CreateDirectory(Path.Combine(work, "Altium")).FullName;
            string sub = Directory.CreateDirectory(Path.Combine(fixtures, "Sheets")).FullName;
            File.WriteAllText(Path.Combine(sub, "A.SchDoc"), "sheet");
            File.WriteAllText(Path.Combine(fixtures, "Parts.PcbLib"), "library");
            File.WriteAllText(Path.Combine(fixtures, "Old.SchDoc"), "old");
            File.WriteAllText(Path.Combine(work, "Outside.SchDoc"), "other project");
            string manifest = Path.Combine(fixtures, "Control.PrjPcb");
            File.WriteAllText(manifest, "[Document1]\r\nDocumentPath=Sheets\\A.SchDoc\r\n[Document2]\r\nDocumentPath=Parts.PcbLib\r\n" +
                "[Document3]\r\nDocumentPath=..\\Outside.SchDoc\r\n[GeneratedDocument1]\r\nDocumentPath=Old.SchDoc\r\n", Encoding.Unicode);
            ui.Opens.Enqueue(new List<string> {manifest});
            host.Receive(page, Msg("id", 31, "action", "open"));
            Check(((List<object>)ui.Last["result"]).Count == 0 && ui.OpenWindows.Single().Single() == fs.Canonical(manifest) &&
                host.DesignPath == fs.Canonical(Path.Combine(work,"Current.waffle")), "open from an active design leaves it bound in its window");
            var importUi = new FakeUi();
            var importHost = new Host(fs, importUi, git, Path.Combine(support, "other"), testTranslators);
            importHost.OpenAtStartup(manifest);
            importHost.PageReady();
            importHost.Receive(page, Msg("id", 1, "action", "open"));
            var members = (List<object>)importUi.Last["result"];
            Check(members.Count == 3 && (string)((Dictionary<string, object>)members[1])["altiumPath"] == "Sheets/A.SchDoc" &&
                (string)((Dictionary<string, object>)members[2])["name"] == "Parts.PcbLib", "open a single Altium project");
            importHost.Receive(page, Msg("action", "finishedOpening", "success", false));
            Check(importHost.Recent.Entries.Count == 0, "a cancelled import creates no recent entry");
            importUi.Opens.Enqueue(new List<string> {manifest});
            importHost.Receive(page, Msg("id", 2, "action", "open"));
            importHost.Receive(page, Msg("action", "dirty", "dirty", true, "projectName", "Control"));
            importHost.Receive(page, Msg("action", "finishedOpening", "success", true));
            Check(importHost.DesignPath == null && importHost.Recent.Allowed(fs.Canonical(manifest)) == fs.Canonical(manifest),
                "a successfully imported native manifest is recent without becoming a save target");
            importHost.Receive(page, Msg("id", 3, "action", "openRecent", "path", fs.Canonical(manifest)));
            Check(((List<object>)importUi.Last["result"]).Count == 3 && importUi.OpenWindows.Count == 0, "a recent read returns the files");
            importHost.Receive(page, Msg("id", 4, "action", "openRecent", "path", fs.Canonical(manifest), "activate", true));
            Check(((List<object>)importUi.Last["result"]).Count == 0 && importUi.OpenWindows.Single().Single() == fs.Canonical(manifest),
                "activating a recent project opens a separate window from an imported design");
            importHost.Receive(page, Msg("id", 5, "action", "openRecent", "path", project, "activate", true));
            Check(importUi.OpenWindows.Count == 1 && ((string)importUi.Last["error"]).Contains("not in the recent"),
                "a page cannot create windows for paths it supplies");
            var sheet = Path.Combine(sub, "A.SchDoc");
            var parts = Path.Combine(fixtures, "Parts.PcbLib");
            importUi.Opens.Enqueue(new[] { sheet, parts });
            importHost.Receive(page, Msg("id", 6, "action", "open"));
            Check(importUi.OpenWindows.Last().SequenceEqual(new[] { fs.Canonical(sheet), fs.Canonical(parts) }) &&
                ((List<object>)importUi.Last["result"]).Count == 0, "a sheet and its library open together in a new window");
            importUi.Opens.Enqueue(new[] { parts });
            importHost.Receive(page, Msg("id", 7, "action", "open"));
            Check(importUi.OpenWindows.Count == 2 && ((List<object>)importUi.Last["result"]).Count == 1, "a library joins the active project");

            // Exports: listed manufacturing types only, text or base64.
            var csv = Path.Combine(work, "bom.csv");
            ui.Saves.Enqueue(csv);
            host.Receive(page, Msg("id", 12, "action", "export", "name", "bom.csv", "text", "A,B"));
            Check((bool)ui.Last["result"] && File.ReadAllText(csv) == "A,B", "text export");
            var zip = Path.Combine(work, "gerbers.zip");
            ui.Saves.Enqueue(zip);
            host.Receive(page, Msg("id", 13, "action", "export", "name", "gerbers.zip", "data", Convert.ToBase64String(new byte[] { 80, 75, 0, 255 })));
            Check(File.ReadAllBytes(zip).SequenceEqual(new byte[] { 80, 75, 0, 255 }), "binary export");
            var report = Path.Combine(work, "waffle-diagnostics.json");
            var preview = "{\"format\":\"waffle-diagnostics\",\"schemaVersion\":1}\n";
            ui.Saves.Enqueue(report);
            host.Receive(page, Msg("id", 13, "action", "export", "name", "waffle-diagnostics.json", "text", preview));
            Check((bool)ui.Last["result"] && File.ReadAllText(report) == preview, "named support report exports the preview");
            host.RecordProcessFailure("browser-exited");
            host.RecordProcessFailure("unresponsive");
            host.RecordProcessFailure("gpu-or-private");
            host.Receive(page, Msg("id", 13, "action", "supportDiagnostics"));
            var facts = (Dictionary<string, object>)ui.Last["result"];
            var failureCounts = (Dictionary<string, object>)facts["rendererTerminations"];
            Check(facts.Count == 3 && (string)facts["platform"] == "windows" && failureCounts.Count == 3 &&
                Equals(failureCounts["browserExited"], 1d) && Equals(failureCounts["unresponsive"], 1d) &&
                Equals(failureCounts["exited"], 0d), "only coarse Windows host facts and supported failure counters");
            foreach (var name in new[] { "x.exe", "x.atrium", "x.bat", "x.lnk", "x.json", "x" })
            {
                host.Receive(page, Msg("id", 14, "action", "export", "name", name, "text", ""));
                Check((string)ui.Last["error"] == "Unrecognised save type.", "export refuses " + name);
            }
            host.Receive(page, Msg("id", 15, "action", "export", "name", "x.csv", "data", "!!notbase64"));
            Check((string)ui.Last["error"] == "Project data is missing.", "bad base64");

            Check(Policy.ExchangeInputs.Contains("atrgroup") && Policy.ExchangeOutputs.Contains("atrgroup") && !Policy.LibraryTypes.Contains("atrgroup"),
                "group bundles are chosen in a dialog and do not grant subsequent path access");

            // Pick: listed exchange types only; the chosen file must match.
            host.Receive(page, Msg("id", 16, "action", "pick", "extensions", new List<object> { ".exe" }));
            Check((string)ui.Last["error"] == "Unrecognised exchange file type.", "pick refuses unknown types");
            host.Receive(page, Msg("id", 17, "action", "pick", "extensions", new List<object>()));
            Check((string)ui.Last["error"] == "Unrecognised exchange file type.", "pick needs a type");
            var lib = Path.Combine(work, "parts.atrlib");
            File.WriteAllText(lib, "{\"defs\":[]}");
            ui.Opens.Enqueue(new[] { lib });
            host.Receive(page, Msg("id", 18, "action", "pick", "extensions", new List<object> { ".atrlib", ".json" }));
            var picked = (Dictionary<string, object>)((List<object>)ui.Last["result"])[0];
            Check((string)picked["path"] == fs.Canonical(lib) && !picked.ContainsKey("revisionToken"), "library pick carries its path");
            Check(!ui.LastOpen.Multiple && ui.LastOpen.Extensions.SequenceEqual(new[] { "atrlib", "json" }), "pick dialog request");
            host.Receive(page, Msg("id", 19, "action", "readFile", "path", fs.Canonical(lib)));
            Check((string)((Dictionary<string, object>)ui.Last["result"])["text"] == "{\"defs\":[]}", "library reload");
            host.Receive(page, Msg("id", 20, "action", "readFile", "path", project));
            Check(((string)ui.Last["error"]).Contains("Open this library"), "other files are not readable");
            ui.Opens.Enqueue(new[] { project });
            host.Receive(page, Msg("id", 21, "action", "pick", "extensions", new List<object> { ".csv" }));
            Check(((string)ui.Last["error"]).Contains("requested document types"), "a mismatched pick is refused");

            // Altium copy export: only to the picked source's extension, never over the source.
            var sch = Path.Combine(work, "design.SchDoc");
            File.WriteAllBytes(sch, new byte[] { 1 });
            ui.Opens.Enqueue(new[] { sch });
            host.Receive(page, Msg("id", 22, "action", "pick", "extensions", new List<object> { ".schdoc" }));
            var token = (string)((Dictionary<string, object>)((List<object>)ui.Last["result"])[0])["sourceToken"];
            host.Receive(page, Msg("id", 23, "action", "exportBinaryCopy", "name", "x.SchDoc", "data", "AQ==", "sourceToken", "forged"));
            Check(((string)ui.Last["error"]).Contains("original Altium"), "forged source token");
            host.Receive(page, Msg("id", 24, "action", "exportBinaryCopy", "name", "x.PcbDoc", "data", "AQ==", "sourceToken", token));
            Check(((string)ui.Last["error"]).Contains("same document extension"), "extension must match");
            ui.Saves.Enqueue(sch);
            host.Receive(page, Msg("id", 25, "action", "exportBinaryCopy", "name", "x.SchDoc", "data", "Ag==", "sourceToken", token));
            Check(((string)ui.Last["error"]).Contains("original Altium") && File.ReadAllBytes(sch)[0] == 1, "never over the source");
            ui.Saves.Enqueue(Path.Combine(work, "x.SchDoc"));
            host.Receive(page, Msg("id", 26, "action", "exportBinaryCopy", "name", "x.SchDoc", "data", "Ag==", "sourceToken", token));
            Check(ui.Last["result"] is bool && (bool)ui.Last["result"], "copy exported");

            // Clipboard packets.
            host.Receive(page, Msg("id", 27, "action", "writeSelection", "data", "{\"format\":\"atrium-selection\"}", "summary", "Waffle PCB · 1 object"));
            Check((bool)ui.Last["result"] && ui.ClipText == "Waffle PCB · 1 object\nWaffle-Selection/1\n{\"format\":\"atrium-selection\"}", "selection written");
            host.Receive(page, Msg("id", 28, "action", "readSelection"));
            Check((string)((Dictionary<string, object>)ui.Last["result"])["data"] == "{\"format\":\"atrium-selection\"}", "custom format read");
            ui.ClipCustom = null;
            host.Receive(page, Msg("id", 29, "action", "readSelection"));
            Check(((string)((Dictionary<string, object>)ui.Last["result"])["text"]).StartsWith("Waffle PCB"), "text fallback read");
            ui.ClipText = "hello";
            host.Receive(page, Msg("id", 30, "action", "readSelection"));
            Check(((Dictionary<string, object>)ui.Last["result"]).Count == 0, "other text ignored");
            host.Receive(page, Msg("id", 31, "action", "writeSelection", "data", "x", "summary", new string('s', 600)));
            Check((string)ui.Last["error"] == "Invalid clipboard selection.", "summary cap");
            host.Receive(page, Msg("id", 32, "action", "writeSelection", "data", 5, "summary", "x"));
            Check((string)ui.Last["error"] == "Invalid clipboard selection.", "data type");

            host.Receive(page, Msg("id",33,"action","recentFiles"));
            Check(((List<object>)ui.Last["result"]).OfType<Dictionary<string,object>>().Any(e=>Equals(e["path"],host.DesignPath)),"an adopted current manifest appears in Recent");
            host.Receive(page, Msg("id",37,"action","gitHead","token","forged"));
            Check(ui.Last["error"] is string,"Git requires the selected folder grant");
            host.Receive(page, Msg("id",38,"action","gitQuery","token",grant,"op","projectLog"));
            Check(ui.Last["result"] != null && git.Arguments.Contains(host.DesignPath),"a folder Git query remains bound to the selected manifest");

            // Closing: a dirty window asks Save / Don't Save / Cancel; a clean close removes the sidecar.
            int asked = 0, closed = 0;
            Action close = () => closed++;
            Check(Host.SavePrompt("Board") == "Do you want to save changes to Board?" && Host.SavePrompt(" ") == "Do you want to save changes to Untitled?"
                  && Host.SavePrompt(null) == "Do you want to save changes to Untitled?", "the close prompt names the project, or Untitled");
            host.Receive(page, Msg("action", "dirty", "dirty", true, "projectName", "Board"));
            Check(host.ProjectName == "Board", "the close prompt's name comes from the page");
            Check(!host.OkayToClose(() => { asked++; return CloseChoice.Cancel; }, close) && asked == 1 && closed == 0, "Cancel keeps the window");
            // Save: the page's own save runs; the window stays until the page reports it saved and clean.
            int posts = ui.Posts.Count;
            Check(!host.OkayToClose(() => { asked++; return CloseChoice.Save; }, close) && asked == 2 && closed == 0
                  && ui.Posts.Count == posts + 1 && (string)ui.Last["command"] == "save-for-close", "Save asks the page to save and keeps the window");
            Check(!host.OkayToClose(() => { asked++; return CloseChoice.DontSave; }, close) && asked == 2, "no second prompt while that save runs");
            host.Receive(page, Msg("action", "saveForClose", "saved", false));
            Check(closed == 0 && host.Dirty, "a cancelled save dialog or a failed save keeps the window, unsaved");
            host.Receive(page, Msg("action", "dirty", "dirty", false, "projectName", "Board"));
            host.Receive(page, Msg("action", "saveForClose", "saved", true));
            Check(closed == 0, "a later ordinary save never closes the window");
            host.Receive(page, Msg("action", "dirty", "dirty", true, "projectName", "Board"));
            Check(!host.OkayToClose(() => { asked++; return CloseChoice.Save; }, close) && asked == 3, "Save again");
            host.Receive(page, Msg("action", "saveForClose", "saved", true));
            Check(closed == 0, "a save that leaves edits unsaved keeps the window");
            Check(!host.OkayToClose(() => { asked++; return CloseChoice.Save; }, close) && asked == 4, "Save once more");
            host.Receive(page, Msg("action", "dirty", "dirty", false, "projectName", "Board"));
            host.Receive(page, Msg("action", "saveForClose", "saved", true));
            Check(closed == 1, "the window closes once the page reports the save done and the project clean");
            host.Receive(page, Msg("action", "dirty", "dirty", true, "projectName", "Board"));
            Check(host.OkayToClose(() => { asked++; return CloseChoice.DontSave; }, close) && asked == 5, "Don't Save closes");
            Check(host.OkayToClose(() => { asked++; return CloseChoice.Cancel; }, close) && asked == 5, "approval remembered");
            host.Receive(page, Msg("action", "dirty", "dirty", false));
            Check(host.OkayToClose(() => { asked++; return CloseChoice.Cancel; }, close) && asked == 5 && host.ProjectName == null, "clean window closes");
            host.Receive(page, Msg("action","dirty","dirty",true,"projectName","One","importId","foreign-one"));
            Check(!host.OkayToClose(() => { throw new Exception("ordinary close picker called for import"); },close) &&
                  Equals(ui.Last["command"],"review-foreign-close") && Equals(ui.Last["importId"],"foreign-one"),"foreign review targets only its own project");
            host.Receive(page,Msg("action","foreignCloseReviewed","importId","wrong","approved",true));
            Check(closed==1,"another project's close reply cannot close this window");
            host.Receive(page,Msg("action","foreignCloseReviewed","importId","foreign-one","approved",false));
            Check(!host.OkayToClose(()=>CloseChoice.Cancel,close),"cancelled import review remains available");
            host.Receive(page,Msg("action","foreignCloseReviewed","importId","foreign-one","approved",true));
            Check(closed==2 && host.OkayToClose(()=>CloseChoice.Cancel,close),"explicit verified Keep permits the dirty import to close");
            host.Closing();
        }

        static void RendererFailureTests(string scratch)
        {
            group = "renderer failure";
            var fs = new PortableFs();
            var ui = new FakeUi();
            var support = Path.Combine(scratch, "crash-support");
            var path = Path.Combine(scratch, "saved.waffle");
            var host = new Host(fs, ui, new FakeGit(), support, testTranslators);
            string grant=OpenFolder(host,ui,path); string before=File.ReadAllText(path);
            host.PageReady(); host.EditorFailed(); host.Closing();
            var fresh=new Host(fs,ui,new FakeGit(),support,testTranslators);
            fresh.Receive(Policy.PageUri,Msg("id",3,"action","folderReadLease","grant",grant));
            Check(ui.Last["error"] is string && File.ReadAllText(path)==before,"renderer death revokes the grant and preserves the saved folder");

            for (int i = 0; i < 33; i++) host.RecordProcessFailure("exited");
            host.RecordProcessFailure(path);
            var next = new Host(fs, ui, new FakeGit(), support, testTranslators);
            next.Receive(Policy.PageUri, Msg("id", 4, "action", "crashHistory"));
            var history = ((List<object>)ui.Last["result"]).Cast<Dictionary<string, object>>().ToList();
            Check(history.Count == 32 && history.All(row => row.Count == 4 && (string)row["reason"] == "exited"
                  && (string)row["kind"] == "renderer" && (string)row["type"] == "Windows" && row.ContainsKey("at")),
                  "the next editor sees only bounded, local renderer codes and timestamps");
        }

        // Document lock and presence sidecars (CollabLocks, docs/collaboration.md).
        static void CollabLockTests(string scratch)
        {
            group = "collab-locks";
            var fs = new PortableFs();
            var work = fs.Canonical(Directory.CreateDirectory(Path.Combine(scratch, "collab")).FullName);
            var project = Path.Combine(work, "Board.waffle");
            File.WriteAllText(project, "{}");
            var owner = Path.Combine(work, "Layout.wpcb");
            File.WriteAllText(owner, "unchanged native owner\n");
            var ownerTime = File.GetLastWriteTimeUtc(owner);
            var projectTime = File.GetLastWriteTimeUtc(project);
            var oldStage = Path.Combine(work, ".waffle.pending-crashed.waffle-lock");
            File.WriteAllText(oldStage, "{\"atrium-lock\":1,\"session\":\"other\"}");
            var a = new CollabLocks(fs, Path.Combine(scratch, "collab-support-a"));
            var b = new CollabLocks(fs, Path.Combine(scratch, "collab-support-b"));
            int staged = 0;
            fs.ObserveLockStaging = (temporary, final) => {
                staged++;
                Check(Path.GetDirectoryName(temporary) == Path.GetDirectoryName(final) &&
                      Path.GetFileName(temporary).StartsWith(".waffle.pending-") && temporary.EndsWith(".waffle-lock") &&
                      File.ReadAllText(temporary).Contains("\"atrium-lock\":1"), "pending file stays inside the reserved lock scope");
                Check(((List<object>)b.Listing(project)["locks"]).Count == 1,"the public list excludes both pending records");
            };
            Check(CollabLocks.ValidKey("d-1f2e_x") == "d-1f2e_x" && CollabLocks.ValidKey("../x") == null && CollabLocks.ValidKey("-x") == null &&
                  CollabLocks.ValidKey(new string('a', 65)) == null && CollabLocks.ValidKey("a b") == null && CollabLocks.ValidKey(5) == null &&
                  CollabLocks.ValidKey("a\\b") == null && CollabLocks.ValidKey("") == null, "lock keys");
            var w = a.Write(project, "d-board", "{\"kind\":\"edit\",\"doc\":\"board\",\"name\":\"Alice\"}", "create");
            Check((bool)w["written"] && File.Exists(Path.Combine(work, "Board.waffle.d-board.waffle-lock")), "exclusive create writes the sidecar");
            var again = b.Write(project, "d-board", "{\"kind\":\"edit\"}", "create");
            Check(!(bool)again["written"] && (bool)again["exists"], "a second create fails");
            var steal = b.Write(project, "d-board", "{}", "replace");
            Check(!(bool)steal["written"] && steal.ContainsKey("owner"), "replace refuses another session's lock");
            Check((bool)a.Write(project, "d-board", "{\"beat\":1}", "replace")["written"], "the owner's heartbeat");
            var list = b.Listing(project);
            var locks = (List<object>)list["locks"];
            var rec = (Dictionary<string, object>)Json.Parse((string)((Dictionary<string, object>)locks[0])["text"]);
            Check(locks.Count == 1 && (string)rec["session"] == a.Session && (string)rec["machine"] == a.Machine && rec.ContainsKey("pid") &&
                  rec.ContainsKey("written") && ((Dictionary<string, object>)rec["data"]).ContainsKey("beat"), "listing carries the host fields");
            Check(list.ContainsKey("project") && (string)list["session"] == b.Session && list.ContainsKey("now"), "project stat and this session");
            Check(!(bool)b.Remove(project, "d-board", false)["removed"], "remove refuses another session's lock");
            Check((bool)b.Write(project, "d-board", "{}", "takeover")["written"], "explicit take-over");
            Check(staged == 2 && Directory.GetFiles(work, ".waffle.pending-*.waffle-lock").SequenceEqual(new[] { oldStage }),
                  "publish removes its temporary without touching an unrelated pending file");
            Check(File.ReadAllText(project) == "{}" && File.GetLastWriteTimeUtc(project) == projectTime &&
                  File.ReadAllText(owner) == "unchanged native owner\n" && File.GetLastWriteTimeUtc(owner) == ownerTime,
                  "the collaboration writer preserves the authored manifest and owner");
            Check(!(bool)a.Write(project, "d-board", "{}", "replace")["written"], "the old owner learns it lost the lock");
            Throws(() => a.Write(project, "../../evil", "{}", "create"), "Invalid lock name", "path-like keys refused");
            Throws(() => a.Write(project, "d-x", "[1]", "create"), "small JSON object", "data must be an object");
            Throws(() => a.Write(project, "d-x", "{\"a\":\"" + new string('x', 9000) + "\"}", "create"), "small JSON object", "data size cap");
            Throws(() => a.Write(Path.Combine(work, "notes.txt"), "d-x", "{}", "create"), "No project file", "only beside a project");
            Throws(() => a.Write(project, "d-x", "{}", "overwrite"), "Unknown lock mode", "modes");
            // Other projects' sidecars and badly named files are never listed.
            File.WriteAllText(Path.Combine(work, "Other.waffle.d-x.waffle-lock"), "{}");
            File.WriteAllText(Path.Combine(work, "Board.waffle.bad name.waffle-lock"), "{}");
            Check(((List<object>)a.Listing(project)["locks"]).Count == 1, "only this project's well-named sidecars");
            // Create never writes through a link at the lock name.
            var target = Path.Combine(work, "target.txt");
            File.WriteAllText(target, "keep");
            try
            {
                File.CreateSymbolicLink(Path.Combine(work, "Board.waffle.d-link.waffle-lock"), target);
                Check(!(bool)a.Write(project, "d-link", "{}", "create")["written"] && File.ReadAllText(target) == "keep", "create never follows a link");
            }
            catch (UnauthorizedAccessException) { }
            catch (IOException) { }
            a.Write(project, "s-a", "{\"kind\":\"presence\"}", "create");
            b.RemoveOwn(project);
            Check(!File.Exists(Path.Combine(work, "Board.waffle.d-board.waffle-lock")) && File.Exists(Path.Combine(work, "Board.waffle.s-a.waffle-lock")),
                  "closing removes only this session's sidecars");
            Check(a.Machine == new CollabLocks(fs, Path.Combine(scratch, "collab-support-a")).Machine && a.Machine != b.Machine && a.Session != b.Session,
                  "the machine id persists; sessions differ");

            // Through the bridge: only beside the project the page accepted.
            var ui = new FakeUi();
            var host = new Host(fs, ui, new FakeGit(), Path.Combine(scratch, "collab-host"), testTranslators);
            string page = Policy.PageUri;
            host.Receive(page, Msg("id", 1, "action", "collabLocks"));
            Check((string)ui.Last["error"] == "The active Waffle project changed.", "no grant, no locks");
            var grant = OpenFolder(host, ui, project);
            host.Receive(page, Msg("id", 2, "action", "collabLockWrite", "grant", "other", "key", "d-other", "data", "{}", "mode", "create"));
            Check((string)ui.Last["error"] == "The active Waffle project changed." && !File.Exists(Path.Combine(work, "Board.waffle.d-other.waffle-lock")), "another grant cannot write a lock");
            host.Receive(page, Msg("id", 3, "action", "collabLockWrite", "grant", grant, "key", "d-sheet", "data", "{\"kind\":\"edit\",\"doc\":\"sheet\"}", "mode", "create"));
            host.WaitForCollab();
            Check((double)ui.Last["id"] == 3 && (bool)((Dictionary<string, object>)ui.Last["result"])["written"], "write through the bridge");
            host.Receive(page, Msg("id", 4, "action", "collabLockWrite", "grant", grant, "key", "../x", "data", "{}", "mode", "create"));
            host.WaitForCollab();
            Check((double)ui.Last["id"] == 4 && (string)ui.Last["error"] == "Invalid lock name.", "bad key through the bridge");
            host.Receive(page, Msg("id", 5, "action", "collabLocks", "grant", grant));
            host.WaitForCollab();
            Check(((List<object>)((Dictionary<string, object>)ui.Last["result"])["locks"]).Count == 2, "listing through the bridge");
            host.Receive(page, Msg("id", 6, "action", "folderClose", "grant", grant));
            host.WaitForCollab();
            Check(!File.Exists(Path.Combine(work, "Board.waffle.d-sheet.waffle-lock")) && File.Exists(Path.Combine(work, "Board.waffle.s-a.waffle-lock")), "closing the grant removes only its own locks");
            host.Receive(page, Msg("id", 7, "action", "collabLocks", "grant", grant));
            Check((string)ui.Last["error"] == "The active Waffle project changed.", "closed grant cannot list locks");
            host.Closing();
            Check(GitQuery.FolderOps.Contains("lfsStatus") && GitQuery.Arguments("lfsStatus", null) == "{}" && GitQuery.Arguments("lfsLock", new Dictionary<string, object> { { "confirm", true } }) != null &&
                  GitQuery.Arguments("lfsLock", new Dictionary<string, object> { { "path", "x" } }) == null, "Git LFS lock queries");
        }

        static void GitTests()
        {
            group = "git stream";
            var text = "{\"documents\":[]}";
            var payload = Encoding.UTF8.GetBytes(text);
            var header = Encoding.UTF8.GetBytes("{\"size\":" + payload.Length + ",\"revision\":\"" + new string('a', 40) + "\",\"path\":\"design/A.waffle\"}\n");
            var parsed = Host.ParseGitStream(header.Concat(payload).ToArray());
            Check((string)parsed["text"] == text && (string)parsed["path"] == "design/A.waffle", "stream parsed");
            Throws(() => Host.ParseGitStream(header.Concat(payload).Concat(new byte[] { 32 }).ToArray()), "incomplete", "size mismatch");
            Throws(() => Host.ParseGitStream(Encoding.UTF8.GetBytes("no newline")), "incomplete", "no header");
            var bad = Encoding.UTF8.GetBytes("{\"size\":2,\"revision\":\"a\",\"path\":\"p\"}\n").Concat(new byte[] { 0xc3, 0x28 }).ToArray();
            Throws(() => Host.ParseGitStream(bad), "invalid UTF-8", "invalid UTF-8");
            var bom = Encoding.UTF8.GetBytes("{\"size\":5,\"revision\":\"a\",\"path\":\"p\"}\n").Concat(new byte[] { 0xef, 0xbb, 0xbf, 0x7b, 0x7d }).ToArray();
            Check((string)Host.ParseGitStream(bom)["text"] == "{}", "BOM stripped");
            Check(Host.GitArguments("gitRevision", "C:\\p.waffle", new string('b', 40)).Last() == "--revision=" + new string('b', 40), "revision argument");
            Check(Host.GitArguments("gitRevision", "C:\\p.waffle", "--upload-pack=x") == null, "option injection refused");
            Check(Host.GitArguments("gitHead", "C:\\p.waffle", null).SequenceEqual(new[] { "--project", "C:\\p.waffle", "--desktop-stream" }), "head");
            var blobHeader = Encoding.UTF8.GetBytes("{\"size\":2,\"revision\":\"worktree\",\"path\":\"p\",\"blob\":\"" + new string('c', 40) + "\"}\n");
            Check((string)Host.ParseGitStream(blobHeader.Concat(Encoding.UTF8.GetBytes("{}")).ToArray())["blob"] == new string('c', 40), "blob passes through");

            group = "git query";
            var log = GitQuery.CommandLine("log", Json.Parse("{\"limit\":50,\"search\":\"Ana \u00e9\",\"refs\":[\"refs/heads/main\"]}"), "C:\\p.waffle");
            Check(log != null && log[2] == "--query" && log[3] == "log" && log[4].StartsWith("--args={") && !log.Contains("--desktop-stream"), "log query");
            Check(((Dictionary<string, object>)Json.Parse(log[4].Substring(7)))["limit"] is double, "numbers stay numbers");
            Check(GitQuery.CommandLine("read", Json.Parse("{\"revision\":\"worktree\"}"), "C:\\p.waffle").Last() == "--desktop-stream", "read streams");
            Check(GitQuery.CommandLine("push", null, "C:\\p.waffle") == null, "unknown operation refused");
            Check(GitQuery.CommandLine("log", Json.Parse("{\"exec\":\"x\"}"), "C:\\p.waffle") == null, "unknown key refused");
            Check(GitQuery.CommandLine("log", Json.Parse("{\"limit\":-1}"), "C:\\p.waffle") == null, "negative number refused");
            Check(GitQuery.CommandLine("log", Json.Parse("{\"limit\":1.5}"), "C:\\p.waffle") == null, "fraction refused");
            Check(GitQuery.CommandLine("log", Json.Parse("{\"search\":\"a\\nb\"}"), "C:\\p.waffle") == null, "control characters refused");
            Check(GitQuery.CommandLine("log", Json.Parse("{\"search\":{\"x\":1}}"), "C:\\p.waffle") == null, "objects refused");
            Check(GitQuery.CommandLine("patches", Json.Parse("{\"revisions\":[\"HEAD\"]}"), "C:\\p.waffle") == null, "revisions are full commits");
            Check(GitQuery.CommandLine("patches", Json.Parse("{\"revisions\":[\"" + new string('d', 40) + "\"]}"), "C:\\p.waffle") != null, "full commit accepted");
            Check(GitQuery.CommandLine("installMergeDriver", Json.Parse("{\"confirm\":\"yes\"}"), "C:\\p.waffle") == null, "confirm is a boolean");
            Check(GitQuery.CommandLine("mergeDriverPlan", null, "C:\\p.waffle") != null, "merge driver plan");
            Check(GitQuery.CommandLine("installMergeDriver", Json.Parse("{\"confirm\":true,\"plan\":\"" + new string('e', 32) + "\"}"), "C:\\p.waffle") != null, "install takes the plan token");
            Check(GitQuery.CommandLine("refs", Json.Parse("[]"), "C:\\p.waffle") == null, "arguments are an object");
        }
    }
}
