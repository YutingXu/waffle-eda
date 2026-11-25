// Invoked only by the format 2 transaction conformance harness. Fault controls are never linked into Waffle.exe.
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Threading;

namespace Waffle.Windows.Tests
{
    using Map = Dictionary<string, object>;

    static class FolderWorker
    {
        static string Option(string key) => Environment.GetEnvironmentVariable("WAFFLE_FOLDER_" + key);
        static void Event(string name)
        {
            if (Option("TRACE") == "1") { Console.Error.WriteLine(name); Console.Error.Flush(); }
            if (Option("PAUSE") == name)
            {
                var gate = Option("GATE");
                File.WriteAllText(gate + ".ready", name);
                for (int i = 0; !File.Exists(gate + ".resume"); i++)
                {
                    if (i > 3000) throw new IOException("The test gate timed out."); Thread.Sleep(10);
                }
            }
            if (Option("FAIL") == name) throw new IOException("Injected filesystem failure " + (Option("ERRNO") ?? "5") + " at " + name);
            if (Option("KILL") == name) { Process.GetCurrentProcess().Kill(); Thread.Sleep(Timeout.Infinite); }
        }
        static void Output(object value) { Console.WriteLine(Json.Write(value)); Console.Out.Flush(); }
        static void StageForSave(FolderProject project, Map request)
        {
            var bytes = Convert.FromBase64String(FolderFormat.Text(request, "attachment"));
            using (var selected = new MemoryStream(bytes, false))
            {
                var result = (Map)project.StageAsset(FolderFormat.Text(request, "ownerId"),
                    FolderFormat.Text(request, "mediaType"), selected);
                foreach (Map row in (List<object>)request["plan"])
                    if (Equals(FolderFormat.Text(row, "assetToken"), "test-token")) row["assetToken"] = result["assetToken"];
            }
        }
        internal static int Run(string[] args)
        {
            var fs = new PortableFs();
            using (var project = new FolderProject(fs, args[1], args[2], Event))
            {
                try
                {
                    var request = Json.Parse(Console.In.ReadToEnd()) as Map ?? throw FolderFormat.Invalid("request");
                    project.Detect();
                    switch (args[3])
                    {
                        case "read":
                            var lease = (string)((Map)project.AcquireLease())["lease"];
                            try { Output(project.Read(lease, FolderFormat.Get(request, "paths") as List<object>)); }
                            finally { project.Release(lease); }
                            break;
                        case "recover": project.Recover(); Output(project.Status()); break;
                        case "stage-save":
                            StageForSave(project, request);
                            goto case "commit";
                        case "commit":
                            var result = project.Commit(request, out var apply); Output(result); Event("acknowledged"); apply();
                            var status = (Map)project.Status(); Output(status); if ((string)status["state"] != "settled") return 2;
                            break;
                        default: throw FolderFormat.Invalid("operation");
                    }
                    return 0;
                }
                catch (Exception e) { var s = (Map)project.Status(); s["error"] = e.Message; Output(s); return 1; }
            }
        }
    }
}
