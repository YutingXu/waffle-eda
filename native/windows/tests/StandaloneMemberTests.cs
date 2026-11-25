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
        static int StandaloneMemberCheck()
        {
            string root = Directory.CreateDirectory(Path.Combine(Path.GetTempPath(), "waffle-member-" + Guid.NewGuid().ToString("N"))).FullName;
            try
            {
                StandaloneMemberTests(new PortableFs().Canonical(root));
                Console.WriteLine("Standalone member: " + passed + " passed, " + failed + " failed.");
                return failed == 0 ? 0 : 1;
            }
            finally { Directory.Delete(root, true); }
        }

        static void StandaloneMemberTests(string scratch)
        {
            group = "standalone member transactions";
            var fs = new PortableFs();
            var vector = (Map)Json.Parse(File.ReadAllText(Path.Combine(AppContext.BaseDirectory, "fixtures", "standalone.json")));
            string name = (string)vector["filename"];
            var before = Encoding.UTF8.GetBytes((string)vector["before"]);
            var next = Encoding.UTF8.GetBytes((string)vector["after"]);
            string beforeHash = FolderFormat.Sha(before), nextHash = FolderFormat.Sha(next);
            string CreateCase(string suffix)
            {
                var parent = Directory.CreateDirectory(Path.Combine(scratch, "standalone-" + suffix)).FullName;
                string path = Path.Combine(parent, name);
                File.WriteAllBytes(path, before);
                return path;
            }
            string Journal(string path) => Path.Combine(Path.GetDirectoryName(path), (string)vector["journal"]);
            string Active(string path) => Path.Combine(Journal(path), "active");

            string normal = CreateCase("normal");
            using (var member = new NativeMember(fs, normal))
            {
                var read = member.Read();
                Check(Equals(read["sha256"], beforeHash) && Equals(read["readOnly"], false), "read returns the selected file's physical digest");
                Check(!Directory.Exists(Path.Combine(Path.GetDirectoryName(normal), ".waffle")), "read alone writes no private state");
                Throws(() => member.Commit(nextHash, next), "changed", "stale digest is refused");
                Check(File.ReadAllBytes(normal).SequenceEqual(before), "stale save preserves the selected file");
                var reply = member.Commit(beforeHash, next);
                Check(Equals(reply["saved"], true) && Equals(reply["hash"], nextHash) && reply["transaction"] is string,
                    "save returns the durable transaction and physical digest");
                Check(!File.Exists(Active(normal)) && File.ReadAllBytes(normal).SequenceEqual(next), "apply completes before retiring the descriptor");
                Check(member.Commit(nextHash, next)["transaction"] == null, "an unchanged retry creates no transaction");
            }

            foreach (string point in new[] { "before-publish", "after-commit-sync", "before-install:0" })
            {
                string selected = CreateCase(point.Replace(":", "-"));
                bool committed = point != "before-publish";
                using (var interrupted = new NativeMember(fs, selected, nameAt => {
                    if (nameAt == point) throw new IOException("test interruption");
                }))
                {
                    if (point == "before-install:0")
                        Check(Equals(interrupted.Commit(beforeHash, next)["saved"], true), "late install failure retains the committed receipt");
                    else Throws(() => interrupted.Commit(beforeHash, next), "test interruption", "fault is reported before any receipt");
                }
                Check(File.ReadAllBytes(selected).SequenceEqual(before), "working file remains old at the interrupted checkpoint");
                Check(File.Exists(Active(selected)) == committed, "only committed staging owns an active descriptor");
                using (var reopened = new NativeMember(fs, selected))
                {
                    byte[] expected = committed ? next : before;
                    Check(((byte[])reopened.Read()["data"]).SequenceEqual(expected), "reopen reconciles the selected file");
                    Check(((byte[])reopened.Read()["data"]).SequenceEqual(expected) && !File.Exists(Active(selected)), "recovery is idempotent");
                    if (!committed) Check(Equals(reopened.Commit(beforeHash, next)["hash"], nextHash), "save can retry after rollback");
                }
            }

            string crossHost = CreateCase("portable");
            string stage = Directory.CreateDirectory(Path.Combine(Journal(crossHost), (string)vector["transaction"])).FullName;
            File.WriteAllBytes(Path.Combine(stage, nextHash), next);
            File.WriteAllBytes(Active(crossHost), Encoding.UTF8.GetBytes((string)vector["active"]));
            File.WriteAllBytes(Path.Combine(Journal(crossHost), "lock"), Array.Empty<byte>());
            using (var reopened = new NativeMember(fs, crossHost))
                Check(((byte[])reopened.Read()["data"]).SequenceEqual(next) && !File.Exists(Active(crossHost)), "shared Unicode-named descriptor replays");

            string deepRoot = Directory.CreateDirectory(Path.Combine(scratch, new string('a', 140), new string('b', 140))).FullName;
            string longPath = Path.Combine(deepRoot, name);
            Check(longPath.Length >= 260, "standalone fixture exceeds the legacy Windows path limit");
            File.WriteAllBytes(longPath, before);
            using (var interrupted = new NativeMember(fs, longPath, point => {
                if (point == "after-commit-sync") throw new IOException("test interruption");
            }))
                Throws(() => interrupted.Commit(beforeHash, next), "test interruption", "a long-path save can publish a durable descriptor");
            Check(File.ReadAllBytes(longPath).SequenceEqual(before) && File.Exists(Active(longPath)),
                "an interrupted long-path save preserves the selected file and journal");
            using (var reopened = new NativeMember(fs, longPath))
                Check(((byte[])reopened.Read()["data"]).SequenceEqual(next), "a long-path save replays the verified staged payload");
            Check(Directory.EnumerateFileSystemEntries(Journal(longPath)).Select(Path.GetFileName).SequenceEqual(new[] { "lock" }),
                "long-path recovery retires the descriptor and removes staging");

            string future = CreateCase("readonly");
            byte[] unknown = Encoding.UTF8.GetBytes(((string)vector["before"]).Replace("\"id\":\"owner-scope\"}", "\"id\":\"owner-scope\",\"requires\":[\"future-feature\"]}"));
            File.WriteAllBytes(future, unknown);
            using (var readonlyMember = new NativeMember(fs, future))
            {
                Check(Equals(readonlyMember.Read()["readOnly"], true), "unknown mandatory features allow a read-only open");
                Throws(() => readonlyMember.Commit(FolderFormat.Sha(unknown), next), "identity or format", "an unknown mandatory feature blocks save");
                Check(File.ReadAllBytes(future).SequenceEqual(unknown) && !Directory.Exists(Journal(future)), "refusal leaves physical bytes and private state untouched");
            }
        }
    }
}
