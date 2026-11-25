// A process opened for one explicitly named project. EOF releases every read lease.
// No app window, alternate project path, Git handle or general filesystem operation is exposed.
using System;
using System.Collections.Generic;
using System.IO;
using System.Text;

namespace Waffle.Windows
{
    using Map = Dictionary<string, object>;

    internal static class FolderMcp
    {
        static void Reply(TextWriter output, object packet)
        {
            output.WriteLine(Json.Write(packet)); output.Flush();
        }
        static string Line(TextReader input)
        {
            var line = new StringBuilder();
            for (int c; (c = input.Read()) >= 0;)
            {
                if (c == '\n') return line.ToString();
                if (line.Length >= 400 * 1024 * 1024) throw FolderFormat.Invalid("request size");
                line.Append((char)c);
            }
            return line.Length == 0 ? null : line.ToString();
        }
        internal static int Run(IFolderPlatform fs, string selection, TextReader input, TextWriter output)
        {
            FolderProject p = null;
            try
            {
                string path = Path.GetFullPath(selection);
                bool directory = Directory.Exists(path);
                string name = directory ? FolderProject.SelectedManifest(fs, path) : Path.GetFileName(path);
                p = new FolderProject(fs, directory ? path : Path.GetDirectoryName(path), name);
                if (!p.Detect() && !directory) throw FolderFormat.Invalid("selected manifest");
                Reply(output, new Map { ["manifest"] = name });
                for (string line; (line = Line(input)) != null;)
                {
                    try
                    {
                        if (!(Json.Parse(line) is Map r)) throw FolderFormat.Invalid("request");
                        string lease = FolderFormat.Text(r, "lease");
                        object result;
                        switch (FolderFormat.Text(r, "op"))
                        {
                            case "acquire": result = p.AcquireLease(); break;
                            case "read": result = p.Read(lease, FolderFormat.Get(r, "paths") as List<object>); break;
                            case "verify": result = p.VerifyLease(lease, FolderFormat.Get(r, "readSet") as Map); break;
                            case "release": result = p.Release(lease); break;
                            case "recover": p.Recover(); result = p.Status(); break;
                            case "commit":
                                if (!(FolderFormat.Get(r, "request") is Map request)) throw FolderFormat.Invalid("commit request");
                                if (r.ContainsKey("readSet") && !(r["readSet"] is Map)) throw FolderFormat.Invalid("read set");
                                result = p.Commit(request, out var apply, FolderFormat.Get(r, "readSet") as Map);
                                // The receipt precedes apply. The next command waits for installation.
                                Reply(output, new Map { ["result"] = result }); apply(); continue;
                            default: throw FolderFormat.Invalid("MCP operation");
                        }
                        Reply(output, new Map { ["result"] = result });
                    }
                    catch (Exception ex) { Error(p, ex, output); }
                }
                return 0;
            }
            catch (Exception e) { Error(p, e, output); return 1; }
            finally { p?.Dispose(); }
        }
        static void Error(FolderProject project, Exception e, TextWriter output)
        {
            var status = project?.Status() as Map ?? new Map { ["state"] = "recoveryPending", ["paths"] = Array.Empty<string>() };
            if (e is FolderConflict c) { status["state"] = "conflict"; status["paths"] = new[] { c.Target }; }
            status["message"] = e is HostError || e is IOException || e is JsonException ? e.Message : "The project operation failed.";
            Reply(output, new Map { ["error"] = status });
        }
    }
}
