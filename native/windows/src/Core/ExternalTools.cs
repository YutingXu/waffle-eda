// run:external for connector extensions (app/native-bridge/external-tools.js) on Windows. The contract is the one in
// native/external_tools.py (the Linux host, with its tests) and native/macos/ExternalTools.swift.
// NOT YET TESTED ON WINDOWS: written to the same contract, it has not been built or run here.
//
// The user chooses each program (an open dialog, or a detected path confirmed in a dialog); the page names
// a tool id, never a path. Approval (ApprovalNeeded / RecordApproval, as native/external_tools.py): kept
// for one extension version (id@sha256 of its bundle), one tool and one program path (the full path;
// symlinks are followed where the runtime can, .NET 6 and later), for runs within the extension's declared
// argument template (its own input file names, plain names matching its output patterns, and
// contributes.externalTools[].args entries, literal or with one {input} / {output}). The first run shows
// the full command; a run with any other argument shows it and asks for that exact command. A new version
// or another program file asks again. A run starts the executable directly (UseShellExecute = false, arguments quoted for
// CommandLineToArgvW, no cmd.exe) in a new temporary folder holding the extension's input files, with
// stdin closed, a minimal environment, a timeout, caps on stdout, stderr and returned files, and
// cancellation (the process tree is killed). The folder is deleted afterwards.
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Security.Cryptography;
using System.Text;
using System.Text.RegularExpressions;
using System.Threading;

namespace Waffle.Windows
{
    /// The window's dialogs for run:external (answered on the UI thread).
    public interface IExternalUi
    {
        void Confirm(string message, string detail, string accept, Action<bool> done);
        void PickProgram(string title, Action<string> done);
    }

    public sealed class ExternalTools
    {
        public static readonly Regex ToolId = new Regex("^[a-z0-9][a-z0-9_.-]{0,63}$");
        static readonly Regex FileName = new Regex("^[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}$");
        static readonly Regex OutputPattern = new Regex("^[A-Za-z0-9_*?][A-Za-z0-9_.*?-]{0,127}$");
        static readonly Regex RunId = new Regex(@"^[\w.:-]{1,200}$");
        static readonly Regex ExtensionId = new Regex(@"^[A-Za-z0-9][\w.-]{0,119}$");
        static readonly Regex ExtensionHash = new Regex("^sha256:[0-9a-f]{64}$");
        static readonly string[] Placeholders = { "{input}", "{output}" };
        const int MaxArgs = 256, MaxArgChars = 4096, MaxFiles = 64, MaxFileBytes = 64000000, MaxOutputs = 64, MaxOutputBytes = 64000000, Concurrent = 8;

        public sealed class Run
        {
            public string Tool, ToolName, Extension, ExtensionName, RunId, ExtensionHash;
            public List<string> Args = new List<string>(), Outputs = new List<string>(), Template = new List<string>();
            public string ExtensionKey => Extension + "@" + ExtensionHash;
            public List<KeyValuePair<string, byte[]>> Files = new List<KeyValuePair<string, byte[]>>();
            public int TimeoutMs, Cap;
        }

        readonly IHostFs fs;
        readonly string storePath;
        readonly object gate = new object();
        public sealed class Ticket
        {
            internal string Key;
            internal Process Child;
            internal volatile bool Cancelled;
        }
        readonly Dictionary<string, Ticket> running = new Dictionary<string, Ticket>();

        public ExternalTools(string supportFolder, IHostFs fs) { this.fs = fs; storePath = Path.Combine(supportFolder, "external-tools.json"); }

        // ------------------------------------------------------------------ store
        Dictionary<string, object> Read()
        {
            try { return Json.Parse(File.ReadAllText(storePath, Encoding.UTF8)) as Dictionary<string, object> ?? new Dictionary<string, object>(); }
            catch (Exception) { return new Dictionary<string, object>(); }
        }
        static Dictionary<string, object> Tools(Dictionary<string, object> s) => s.TryGetValue("tools", out var t) && t is Dictionary<string, object> d ? d : new Dictionary<string, object>();
        static List<object> Approvals(Dictionary<string, object> s) => s.TryGetValue("approvals", out var a) && a is List<object> l ? l : new List<object>();
        void Write(Dictionary<string, object> s)
        {
            Directory.CreateDirectory(Path.GetDirectoryName(storePath));
            var tmp = storePath + ".tmp";
            File.WriteAllText(tmp, Json.Write(s), Encoding.UTF8);
            if (File.Exists(storePath)) File.Replace(tmp, storePath, null); else File.Move(tmp, storePath);
        }

        public Dictionary<string, object> Listing()
        {
            lock (gate)
            {
                var tools = new Dictionary<string, object>();
                foreach (var kv in Tools(Read()))
                    if (ToolId.IsMatch(kv.Key) && kv.Value is Dictionary<string, object> row && row.TryGetValue("path", out var p) && p is string)
                        tools[kv.Key] = row;
                return new Dictionary<string, object> { { "platform", "windows" }, { "tools", tools } };
            }
        }
        public string PathOf(string id)
        {
            lock (gate) return Tools(Read()).TryGetValue(id, out var row) && row is Dictionary<string, object> r && r.TryGetValue("path", out var p) ? p as string : null;
        }
        public static bool Executable(string path) =>
            path != null && path.Length < 4096 && Path.IsPathRooted(path) && path.EndsWith(".exe", StringComparison.OrdinalIgnoreCase) && File.Exists(path);
        public List<object> Probe(object paths)
        {
            var found = new List<object>();
            if (paths is List<object> list) for (int i = 0; i < list.Count && i < 16; i++) if (list[i] is string p && Executable(p)) found.Add(p);
            return found;
        }
        public Dictionary<string, object> Choose(string id, string name, string path)
        {
            if (id == null || !ToolId.IsMatch(id) || !Executable(path)) throw new HostError("Choose a program file that can be run.");
            lock (gate)
            {
                var s = Read(); var tools = Tools(s);
                tools[id] = new Dictionary<string, object> { { "path", path }, { "name", string.IsNullOrEmpty(name) ? id : (name.Length > 80 ? name.Substring(0, 80) : name) } };
                s["tools"] = tools; Write(s);
            }
            return new Dictionary<string, object> { { "path", path } };
        }
        public void Forget(string id)
        {
            lock (gate)
            {
                var s = Read(); var tools = Tools(s); tools.Remove(id ?? "");
                s["tools"] = tools;
                s["approvals"] = Approvals(s).FindAll(a => !(a is string k) || k.Split('\n').Length < 2 || k.Split('\n')[1] != id);
                Write(s);
            }
        }
        /// ext: "id@sha256:..." (one version); path: the resolved program; args: one exact command's arguments.
        public static string ApprovalKey(string ext, string tool, string path, IList<string> args = null)
        {
            var key = ext + "\n" + tool + "\n" + path;
            if (args == null) return key;
            using (var sha = SHA256.Create())
            {
                var digest = sha.ComputeHash(Encoding.UTF8.GetBytes(Json.Write(new List<object>(args))));
                return key + "\nargv:" + BitConverter.ToString(digest).Replace("-", "").ToLowerInvariant();
            }
        }
        public bool Approved(string ext, string tool, string path, IList<string> args = null) { lock (gate) return Approvals(Read()).Contains(ApprovalKey(ext, tool, path, args)); }
        public void Approve(string ext, string tool, string path, IList<string> args = null)
        {
            lock (gate)
            {
                var s = Read(); var list = Approvals(s); var key = ApprovalKey(ext, tool, path, args);
                if (!list.Contains(key)) { list.Add(key); if (list.Count > 2000) list.RemoveRange(0, list.Count - 2000); s["approvals"] = list; Write(s); }
            }
        }
        /// The program file an approval names: the full path, with symlinks followed on .NET 6 and later.
        public static string Resolved(string path)
        {
            var full = Path.GetFullPath(path);
#if NET6_0_OR_GREATER
            try { var target = new FileInfo(full).ResolveLinkTarget(true); if (target != null) return target.FullName; } catch (Exception) { }
#endif
            return full;
        }
        /// The arguments a run passes that its extension does not declare (native/external_tools.py outside_template).
        public static List<string> OutsideTemplate(IList<string> args, IList<string> template, ICollection<string> inputs, IList<string> outputs)
        {
            bool Output(string name)
            {
                if (!FileName.IsMatch(name) || name.Contains("..")) return false;
                foreach (var p in outputs) if (Glob(p, name)) return true;
                return false;
            }
            bool Fits(string arg, string entry)
            {
                foreach (var placeholder in Placeholders)
                {
                    int i = entry.IndexOf(placeholder, StringComparison.Ordinal);
                    if (i < 0) continue;
                    string pre = entry.Substring(0, i), post = entry.Substring(i + placeholder.Length);
                    if (arg.Length <= pre.Length + post.Length || !arg.StartsWith(pre, StringComparison.Ordinal) || !arg.EndsWith(post, StringComparison.Ordinal)) return false;
                    var middle = arg.Substring(pre.Length, arg.Length - pre.Length - post.Length);
                    return placeholder == "{input}" ? inputs.Contains(middle) : Output(middle);
                }
                return arg == entry;
            }
            var outside = new List<string>();
            foreach (var a in args)
            {
                if (inputs.Contains(a) || Output(a)) continue;
                bool declared = false;
                foreach (var e in template) if (Fits(a, e)) { declared = true; break; }
                if (!declared) outside.Add(a);
            }
            return outside;
        }
        /// What to ask before a run (null: it may start): approve the program for this extension version
        /// and/or this exact command (outside the template).
        public sealed class Approval { public string Title, Detail, Path; public bool Program, Command; }
        public Approval ApprovalNeeded(Run req, string path)
        {
            var real = Resolved(path);
            var inputs = new HashSet<string>(); foreach (var f in req.Files) inputs.Add(f.Key);
            var outside = OutsideTemplate(req.Args, req.Template, inputs, req.Outputs);
            bool program = !Approved(req.ExtensionKey, req.Tool, real);
            bool command = outside.Count > 0 && !Approved(req.ExtensionKey, req.Tool, real, req.Args);
            if (!program && !command) return null;
            var who = req.ExtensionName.Length > 0 ? req.ExtensionName : req.Extension;
            var version = req.Extension + ", " + req.ExtensionHash.Substring(0, 19) + "\u2026";
            var shown = CommandLine(path, req.Args);
            const string place = "It runs in a new temporary folder with the files the extension supplies.";
            var quoted = new List<string>(); foreach (var a in outside) quoted.Add(Quote(a));
            var extra = string.Join(" ", quoted);
            string detail;
            if (program)
            {
                var declared = req.Template.Count == 0 ? "only its own input and output file names" : "its declared arguments (" + string.Join(" ", req.Template) + ") and its own file names";
                detail = who + " (" + version + ") wants to run:\n\n" + shown + "\n\n" + place + " Allow this program for this version of the extension? Later runs that use " +
                    declared + " run without asking; any other argument, a new version or another program asks again.";
                if (outside.Count > 0) detail += "\n\nThis command also passes arguments the extension does not declare (" + extra + "); allowing it allows this exact command too.";
            }
            else detail = who + " (" + version + ") wants to run " + req.ToolName + " with arguments it does not declare (" + extra + "):\n\n" + shown + "\n\n" + place + " Allow this exact command?";
            return new Approval { Title = "Allow " + who + " to run " + req.ToolName + "?", Detail = detail, Program = program, Command = outside.Count > 0, Path = real };
        }
        public void RecordApproval(Run req, Approval need)
        {
            if (need.Program) Approve(req.ExtensionKey, req.Tool, need.Path);
            if (need.Command) Approve(req.ExtensionKey, req.Tool, need.Path, req.Args);
        }

        // ------------------------------------------------------------------ requests
        public static Run Check(object value)
        {
            var r = value as Dictionary<string, object>;
            string Str(string k) => r != null && r.TryGetValue(k, out var v) ? v as string : null;
            var run = new Run { Tool = Str("tool") };
            if (run.Tool == null || !ToolId.IsMatch(run.Tool)) throw new HostError("Invalid external tool request.");
            run.ToolName = Str("toolName") ?? run.Tool; run.Extension = Str("extension"); run.ExtensionName = Str("extensionName") ?? ""; run.ExtensionHash = Str("extensionHash");
            if (run.Extension == null || !ExtensionId.IsMatch(run.Extension) || run.ExtensionHash == null || !ExtensionHash.IsMatch(run.ExtensionHash))
                throw new HostError("Invalid external tool request: the extension and its version are required.");
            if (r.TryGetValue("argTemplate", out var tt) && tt != null)
            {
                if (!(tt is List<object> template) || template.Count > 64) throw new HostError("Invalid argument template.");
                foreach (var x in template)
                {
                    if (!(x is string e) || e.Length == 0 || e.Length > 200 || e.IndexOf('\0') >= 0) throw new HostError("Invalid argument template.");
                    int marks = 0; foreach (var ph in Placeholders) for (int i = e.IndexOf(ph, StringComparison.Ordinal); i >= 0; i = e.IndexOf(ph, i + 1, StringComparison.Ordinal)) marks++;
                    if (marks > 1) throw new HostError("Invalid argument template.");
                    run.Template.Add(e);
                }
            }
            if (r.TryGetValue("args", out var a) && a != null)
            {
                if (!(a is List<object> args) || args.Count > MaxArgs) throw new HostError("Invalid program arguments.");
                foreach (var x in args) { if (!(x is string s) || s.Length > MaxArgChars || s.IndexOf('\0') >= 0) throw new HostError("Invalid program arguments."); run.Args.Add(s); }
            }
            long total = 0;
            if (r.TryGetValue("files", out var f) && f != null)
            {
                if (!(f is List<object> files) || files.Count > MaxFiles) throw new HostError("Invalid input files.");
                foreach (var x in files)
                {
                    if (!(x is Dictionary<string, object> row) || !(row.TryGetValue("name", out var n) && n is string name) || !FileName.IsMatch(name) || name.Contains("..")
                        || !(row.TryGetValue("data", out var d) && d is string data)) throw new HostError("Invalid input files.");
                    var bytes = Convert.FromBase64String(data);
                    if ((total += bytes.Length) > MaxFileBytes) throw new HostError("The input files are too large.");
                    run.Files.Add(new KeyValuePair<string, byte[]>(name, bytes));
                }
            }
            if (r.TryGetValue("outputs", out var o) && o != null)
            {
                if (!(o is List<object> outs) || outs.Count > MaxOutputs) throw new HostError("Invalid output patterns.");
                foreach (var x in outs) { if (!(x is string p) || !OutputPattern.IsMatch(p) || p.Contains("..")) throw new HostError("Invalid output patterns."); run.Outputs.Add(p); }
            }
            double timeout = r.TryGetValue("timeoutMs", out var t) && t is double td ? td : 60000, cap = r.TryGetValue("maxOutputBytes", out var c) && c is double cd ? cd : 16000000;
            if (timeout < 100 || timeout > 600000) throw new HostError("Invalid timeout.");
            if (cap < 1024 || cap > MaxOutputBytes) throw new HostError("Invalid output limit.");
            run.TimeoutMs = (int)timeout; run.Cap = (int)cap;
            run.RunId = Str("runId");
            if (run.RunId != null && !RunId.IsMatch(run.RunId)) throw new HostError("Invalid run id.");
            return run;
        }

        /// One argument quoted so CommandLineToArgvW (and the C runtime) reads it back unchanged.
        public static string Quote(string arg)
        {
            if (arg.Length > 0 && arg.IndexOfAny(new[] { ' ', '\t', '\n', '\v', '"' }) < 0) return arg;
            var b = new StringBuilder("\"");
            for (int i = 0; i < arg.Length; i++)
            {
                int slashes = 0;
                while (i < arg.Length && arg[i] == '\\') { slashes++; i++; }
                if (i == arg.Length) { b.Append('\\', slashes * 2); break; }
                if (arg[i] == '"') b.Append('\\', slashes * 2 + 1).Append('"');
                else b.Append('\\', slashes).Append(arg[i]);
            }
            return b.Append('"').ToString();
        }
        public static string CommandLine(string path, IList<string> args)
        {
            var parts = new List<string> { Quote(path) };
            foreach (var a in args) parts.Add(Quote(a));
            return string.Join(" ", parts);
        }

        // ------------------------------------------------------------------ running
        public Ticket Reserve(Run req)
        {
            var ticket = new Ticket { Key = req.RunId ?? Guid.NewGuid().ToString() };
            lock (gate)
            {
                if (running.Count >= Concurrent || running.ContainsKey(ticket.Key)) throw new HostError("Too many external programs are running.");
                running[ticket.Key] = ticket;
            }
            return ticket;
        }
        public void Release(Ticket ticket) { lock (gate) running.Remove(ticket.Key); }
        public void Cancel(string runId)
        {
            Process process;
            lock (gate)
            {
                if (runId == null || !running.TryGetValue(runId, out var ticket)) return;
                ticket.Cancelled = true;
                process = ticket.Child;
            }
            if (process != null) Kill(process);
        }
        static void Kill(Process p)
        {
            try { if (!p.HasExited) Process.Start(new ProcessStartInfo("taskkill.exe", "/T /F /PID " + p.Id) { UseShellExecute = false, CreateNoWindow = true })?.WaitForExit(5000); } catch (Exception) { }
            try { if (!p.HasExited) p.Kill(); } catch (Exception) { }
        }

        /// Runs on the calling (background) thread.
        public Dictionary<string, object> Execute(string path, Run req, Ticket ticket = null)
        {
            ticket = ticket ?? Reserve(req);
            var work = Path.Combine(Path.GetTempPath(), "atrium-run-" + Guid.NewGuid().ToString("N"));
            try
            {
                Directory.CreateDirectory(work);
                foreach (var f in req.Files) File.WriteAllBytes(Path.Combine(work, f.Key), f.Value);
                var info = new ProcessStartInfo(path) { UseShellExecute = false, CreateNoWindow = true, WorkingDirectory = work,
                    RedirectStandardInput = true, RedirectStandardOutput = true, RedirectStandardError = true };
                var args = new List<string>(); foreach (var a in req.Args) args.Add(Quote(a));
                info.Arguments = string.Join(" ", args);
                var keep = new HashSet<string>(StringComparer.OrdinalIgnoreCase) { "SystemRoot", "SystemDrive", "windir", "USERPROFILE", "USERNAME", "APPDATA", "LOCALAPPDATA", "ProgramFiles", "ProgramFiles(x86)", "ComSpec", "PATHEXT", "NUMBER_OF_PROCESSORS", "PROCESSOR_ARCHITECTURE" };
                foreach (var k in new List<string>(EnvKeys(info))) if (!keep.Contains(k)) info.EnvironmentVariables.Remove(k);
                info.EnvironmentVariables["TEMP"] = info.EnvironmentVariables["TMP"] = work;
                info.EnvironmentVariables["PATH"] = Environment.GetFolderPath(Environment.SpecialFolder.System);
                var started = DateTime.UtcNow;
                bool truncated = false;
                using (var p = new Process { StartInfo = info })
                {
                    lock (gate)
                    {
                        if (ticket.Cancelled) return new Dictionary<string, object> {
                            { "exitCode", null }, { "signal", null }, { "timedOut", false }, { "cancelled", true },
                            { "truncated", false }, { "durationMs", 0 }, { "stdout", "" }, { "stderr", "" }, { "files", new List<object>() } };
                        p.Start();
                        ticket.Child = p;
                    }
                    p.StandardInput.Close();
                    byte[] stdout = null, stderr = null;
                    var outT = new Thread(() => stdout = Drain(p.StandardOutput.BaseStream, req.Cap, ref truncated));
                    var errT = new Thread(() => stderr = Drain(p.StandardError.BaseStream, req.Cap, ref truncated));
                    outT.Start(); errT.Start();
                    bool timedOut = !p.WaitForExit(req.TimeoutMs);
                    if (timedOut) { Kill(p); p.WaitForExit(5000); }
                    outT.Join(5000); errT.Join(5000);
                    var files = new List<object>(); long budget = req.Cap;
                    if (req.Outputs.Count > 0)
                    {
                        var names = new List<string>();
                        foreach (var entry in Directory.EnumerateFileSystemEntries(work))
                        {
                            if (names.Count >= 4096) { truncated = true; names.Clear(); break; }
                            names.Add(entry);
                        }
                        names.Sort(StringComparer.Ordinal);
                        foreach (var full in names)
                        {
                            var name = Path.GetFileName(full); var fi = new FileInfo(full);
                            if ((fi.Attributes & (FileAttributes.ReparsePoint | FileAttributes.Directory)) != 0 || !req.Outputs.Exists(pat => Glob(pat, name))) continue;
                            try
                            {
                                var bytes = fs.ReadRegular(full, budget, singleLink: true).Bytes;
                                budget -= bytes.Length;
                                files.Add(new Dictionary<string, object> { { "name", name }, { "data", Convert.ToBase64String(bytes) } });
                            }
                            catch (IOException) { truncated = true; }
                            catch (HostError) { truncated = true; }
                        }
                    }
                    return new Dictionary<string, object> {
                        { "exitCode", timedOut || ticket.Cancelled ? null : (object)p.ExitCode }, { "signal", null }, { "timedOut", timedOut }, { "cancelled", ticket.Cancelled },
                        { "truncated", truncated }, { "durationMs", (int)(DateTime.UtcNow - started).TotalMilliseconds },
                        { "stdout", Convert.ToBase64String(stdout ?? new byte[0]) }, { "stderr", Convert.ToBase64String(stderr ?? new byte[0]) }, { "files", files } };
                }
            }
            finally { Release(ticket); try { Directory.Delete(work, true); } catch (Exception) { } }
        }
        static IEnumerable<string> EnvKeys(ProcessStartInfo info) { foreach (string k in info.EnvironmentVariables.Keys) yield return k; }
        static byte[] Drain(Stream s, int cap, ref bool truncated)
        {
            var kept = new MemoryStream(); var buf = new byte[65536]; int n;
            while ((n = s.Read(buf, 0, buf.Length)) > 0)
            {
                int room = cap - (int)kept.Length;
                if (room > 0) kept.Write(buf, 0, Math.Min(room, n));
                if (n > Math.Max(room, 0)) truncated = true;
            }
            return kept.ToArray();
        }
        static bool Glob(string pattern, string name) =>
            Regex.IsMatch(name, "^" + Regex.Escape(pattern).Replace("\\*", ".*").Replace("\\?", ".") + "$", RegexOptions.IgnoreCase);
    }
}
