// Runs native/git_head.py with an isolated Python (-I -B), as the macOS host does.
// Python is looked up by absolute path only (never the working directory), preferring the
// py.exe launcher, and skipping the Microsoft Store "python.exe" alias that opens the Store.
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Text;
using System.Threading.Tasks;

namespace Waffle.Windows
{
    sealed class GitRunner : IGitRunner, IArchiveRunner
    {
        readonly string script;
        readonly string workingFolder;

        public GitRunner(string root)
        {
            script = Path.Combine(root, "native", "git_head.py");
            workingFolder = root;
        }

        static string FindPython(out bool launcher)
        {
            launcher = false;
            var windows = Environment.GetFolderPath(Environment.SpecialFolder.Windows);
            var store = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "Microsoft", "WindowsApps");
            var candidates = new List<string>();
            if (!string.IsNullOrEmpty(windows)) candidates.Add(Path.Combine(windows, "py.exe"));
            foreach (var folder in (Environment.GetEnvironmentVariable("PATH") ?? "").Split(';'))
            {
                var dir = folder.Trim().Trim('"');
                if (dir.Length < 3 || !Path.IsPathRooted(dir) || dir.StartsWith(store, StringComparison.OrdinalIgnoreCase)) continue;
                candidates.Add(Path.Combine(dir, "py.exe"));
                candidates.Add(Path.Combine(dir, "python.exe"));
                candidates.Add(Path.Combine(dir, "python3.exe"));
            }
            foreach (var c in candidates)
                if (File.Exists(c)) { launcher = Path.GetFileName(c).Equals("py.exe", StringComparison.OrdinalIgnoreCase); return c; }
            return null;
        }

        static string Quote(string argument)
        {
            // CommandLineToArgvW rules: quote, double the backslashes before a quote, escape quotes.
            if (argument.Length > 0 && argument.IndexOfAny(new[] { ' ', '\t', '"' }) < 0) return argument;
            var b = new StringBuilder("\"");
            int slashes = 0;
            foreach (char c in argument)
            {
                if (c == '\\') { slashes++; continue; }
                if (c == '"') { b.Append('\\', slashes * 2 + 1); b.Append('"'); slashes = 0; continue; }
                b.Append('\\', slashes); slashes = 0; b.Append(c);
            }
            b.Append('\\', slashes * 2).Append('"');
            return b.ToString();
        }

        public GitResult Run(IList<string> arguments) => Execute(script,arguments,null);
        public object Archive(string action, Dictionary<string,object> request)
        {
            if(ImportExportStore.Handles(action)||FindPython(out _)==null)return PortableArchive.Run(new WinFs(),action,request);
            var result=Execute(Path.Combine(workingFolder,"native","project_archive.py"),new[]{action},Json.Write(request));
            if(result.ExitCode!=0)throw new HostError(result.Errors.Trim());
            return Json.Parse(new UTF8Encoding(false,true).GetString(result.Output));
        }
        GitResult Execute(string program,IList<string> arguments,string input)
        {
            bool launcher;
            var python = FindPython(out launcher);
            if (python == null) throw new HostError("Revision review needs Python 3 and Git. Install Python from python.org, then try again.");
            var all = new List<string>();
            if (launcher) all.Add("-3");
            all.AddRange(new[] { "-I", "-B", program });
            all.AddRange(arguments);
            var parts = new List<string>();
            foreach (var a in all) parts.Add(Quote(a));
            var info = new ProcessStartInfo(python, string.Join(" ", parts))
            {
                UseShellExecute = false, CreateNoWindow = true, WorkingDirectory = workingFolder,
                RedirectStandardOutput = true, RedirectStandardError = true, RedirectStandardInput = true,
                StandardErrorEncoding = Encoding.UTF8,
            };
            using (var child = Process.Start(info))
            {
                if(input!=null){
                    var bytes=new UTF8Encoding(false,true).GetBytes(input);
                    child.StandardInput.BaseStream.Write(bytes,0,bytes.Length);
                }
                child.StandardInput.Close();
                var errors = child.StandardError.ReadToEndAsync();
                byte[] output;
                using (var memory = new MemoryStream())
                {
                    child.StandardOutput.BaseStream.CopyTo(memory);
                    output = memory.ToArray();
                }
                child.WaitForExit();
                return new GitResult { ExitCode = child.ExitCode, Output = output, Errors = errors.Result };
            }
        }
    }
}
