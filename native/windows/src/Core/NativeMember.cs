// A standalone member owns a single regular file. Reuse the collection writer's
// stage, publication, install and recovery code with a journal bound to that leaf.
using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Text.RegularExpressions;
using static Waffle.Windows.FolderFormat;

namespace Waffle.Windows
{
    using Map = Dictionary<string, object>;

    internal sealed class NativeMember : IDisposable
    {
        readonly FolderProject document;
        internal NativeMember(IFolderPlatform platform, string selectedPath, Action<string> checkpoint = null)
        {
            if (selectedPath == null || !Path.IsPathRooted(selectedPath) ||
                platform is IHostFs files && !files.IsAbsolute(selectedPath)) throw Invalid("selected document path");
            document = new FolderProject(platform, Path.GetDirectoryName(selectedPath), Path.GetFileName(selectedPath), checkpoint, standalone: true);
        }
        internal Map Read() => document.ReadStandalone();
        internal Map Commit(string expected, byte[] desired) => document.CommitStandalone(expected, desired);
        public void Dispose() => document.Dispose();
    }

    internal sealed partial class FolderProject
    {
        static readonly Regex StandaloneVersion = new Regex(@"^([2-9]|[1-9][0-9]{1,3})\.(0|[1-9][0-9]{0,3})\z");

        (string id, bool readOnly) StandaloneHeader(Map header)
        {
            if (header == null || Text(header, "kind") != StandaloneKind(Manifest)) throw Invalid("document kind");
            string version = Text(header, "formatVersion") ?? "";
            var parsed = StandaloneVersion.Match(version);
            if (!parsed.Success || (parsed.Groups[1].Value != "2" && Text(header, "compatibleWith") != "2.0"))
                throw Invalid("document format version");
            bool readOnly = version != "2.0";
            if (header.TryGetValue("requires", out object raw))
            {
                if (!(raw is List<object> required) || required.Any(r => !(r is string s) || s.Length == 0) ||
                    required.Distinct().Count() != required.Count) throw Invalid("document required features");
                readOnly |= required.Count != 0;
            }
            return (Id(Text(header, "id")), readOnly);
        }

        void CheckStandalone(Descriptor descriptor)
        {
            if (descriptor.Plan.Count != 1 || descriptor.Plan[0].Path != Manifest || descriptor.Plan[0].Expected == null ||
                descriptor.Plan[0].Desired == null) throw Invalid("standalone document scope");
            var entry = descriptor.Plan[0];
            using (var current = disk.Open(Manifest))
            using (var staged = disk.Open(Payload(descriptor, entry)))
            {
                if (current == null || staged == null) throw new FolderConflict(Manifest);
                var old = StandaloneHeader(Header(current));
                var next = StandaloneHeader(Header(staged));
                if (old.readOnly || next.readOnly || old.id != descriptor.ProjectId || next.id != descriptor.ProjectId)
                    throw Invalid("standalone document journal identity or format");
            }
        }

        internal Map ReadStandalone()
        {
            lock (gate)
            {
                CheckOpen();
                if (!standalone) throw Invalid("standalone document grant");
                Recover();
                using (var reader = disk.Barrier(false))
                {
                    if (disk.Spelling(disk.Active) != null) throw new HostError("A committed native document save needs recovery.");
                    if (disk.Spelling(Manifest) != Manifest) throw new FolderConflict(Manifest);
                    var data = disk.Read(Manifest) ?? throw new FolderConflict(Manifest);
                    var header = StandaloneHeader(First(data));
                    if (projectId != null && header.id != projectId) throw new FolderConflict(Manifest);
                    projectId = header.id;
                    return new Map { ["data"] = data, ["sha256"] = Sha(data), ["readOnly"] = header.readOnly };
                }
            }
        }

        internal Map CommitStandalone(string expected, byte[] desired)
        {
            lock (gate)
            {
                CheckOpen();
                if (!standalone || !IsDigest(expected) || desired == null || desired.LongLength > MaxFile ||
                    desired.Length == 0 || desired[desired.Length - 1] != 10) throw Invalid("standalone save payload");
                var saved = ReadStandalone();
                if (Text(saved, "sha256") != expected) throw new FolderConflict(Manifest);
                var header = StandaloneHeader(First(desired));
                if (Equals(Get(saved, "readOnly"), true) || header.readOnly || header.id != projectId)
                    throw Invalid("standalone save identity or format");
                string sha = Sha(desired);
                if (sha == expected) return new Map { ["saved"] = true, ["hash"] = sha, ["transaction"] = null };
                var entry = new Entry { Path = Manifest, Expected = expected, Desired = sha, Length = desired.LongLength };
                var d = new Descriptor { ProjectId = header.id, Transaction = Guid.NewGuid().ToString("D"), Plan = new List<Entry> { entry } };
                var writer = disk.Barrier(true);
                bool published = false;
                try
                {
                    ReplayActive();
                    Preflight(d);
                    checkpoint("before-stage");
                    Publish(d, (_, output) => output.Write(desired, 0, desired.Length), () => Preflight(d),
                        false, ref writer, ref published, out var apply);
                    apply();
                    return new Map { ["saved"] = true, ["hash"] = sha, ["transaction"] = d.Transaction };
                }
                catch (Exception e)
                {
                    if (published || disk.Spelling(disk.Active) != null) Failure(e);
                    else { try { disk.Clean(d.Transaction); } catch (IOException) { } }
                    throw;
                }
                finally { writer?.Dispose(); }
            }
        }
    }
}
