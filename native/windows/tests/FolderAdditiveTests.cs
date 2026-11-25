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
        static void FolderAdditiveTests(PortableFs fs, string scratch)
        {
            group = "additive folder versions";
            var fixture = (Map)Json.Parse(File.ReadAllText(Path.Combine(AppContext.BaseDirectory, "fixtures", "additive.json")));
            var golden = (Map)fixture["files"]; var edit = (Map)fixture["edit"]; var policy = (Map)fixture["policy"];
            string manifest = (string)fixture["manifest"], member = (string)fixture["member"], opaque = (string)fixture["opaque"];
            string source = (string)golden[member], project = (string)golden[manifest], wave = (string)golden[opaque];
            string changed = source.Replace((string)edit["from"], (string)edit["to"]);
            string Hash(string text) => FolderFormat.Sha(Encoding.UTF8.GetBytes(text));
            foreach (var set in new Dictionary<string, HashSet<string>>
            {
                ["documentRecords"] = FolderAdditive.DocumentRows,
                ["libraryRecords"] = FolderAdditive.LibraryRows,
                ["blockRecords"] = FolderAdditive.BlockRows,
                ["scalarFields"] = FolderAdditive.ScalarFields,
                ["coordinateFields"] = FolderAdditive.CoordinateFields
            })
                Check(set.Value.SetEquals(((List<object>)policy[set.Key]).Cast<string>()), "same " + set.Key + " as the shared fixture");

            int serial = 0;
            string Seed(string savedProject, string savedOwner, string savedWave = null)
            {
                string root = Directory.CreateDirectory(Path.Combine(scratch, "additive-" + (++serial))).FullName;
                File.WriteAllText(Path.Combine(root, manifest), savedProject);
                File.WriteAllText(Path.Combine(root, member), savedOwner);
                File.WriteAllText(Path.Combine(root, opaque), savedWave ?? wave);
                return root;
            }
            Map Splice(string path, string from, string to)
            {
                int start = 0, left = from.Length, right = to.Length;
                while (start < left && start < right && from[start] == to[start]) start++;
                while (left > start && right > start && from[left - 1] == to[right - 1]) { left--; right--; }
                var op = new Map
                {
                    ["offset"] = Encoding.UTF8.GetByteCount(from.Substring(0, start)),
                    ["remove"] = Encoding.UTF8.GetByteCount(from.Substring(start, left - start)),
                    ["insert"] = to.Substring(start, right - start)
                };
                return new Map
                {
                    ["path"] = path,
                    ["expected"] = Hash(from),
                    ["splice"] =
                    new Map { ["base"] = Hash(from), ["edits"] = new List<object> { op } }
                };
            }
            Map Request(Map row) => new Map { ["manifest"] = manifest, ["projectId"] = fixture["projectId"], ["plan"] = new List<object> { row } };
            bool Untouched(string root, string savedProject, string savedOwner) =>
                Directory.GetFileSystemEntries(root).Length == 3 && File.ReadAllText(Path.Combine(root, manifest)) == savedProject &&
                File.ReadAllText(Path.Combine(root, member)) == savedOwner && File.ReadAllText(Path.Combine(root, opaque)) == wave;
            void Refuses(string root, Map row, string savedProject, string savedOwner, string reason)
            {
                using (var p = new FolderProject(fs, root, manifest))
                {
                    bool declined = false;
                    try { p.Commit(Request(row), out _); } catch (HostError) { declined = true; }
                    Check(declined && Untouched(root, savedProject, savedOwner), reason + " refuses without creating any files");
                }
            }
            void Saves(string from, string to, string label)
            {
                var root = Seed(project, from);
                using (var p = new FolderProject(fs, root, manifest))
                {
                    var packet = (Map)p.Commit(Request(Splice(member, from, to)), out var apply); apply(); p.Recover();
                    Check((bool)packet["saved"] && (string)((Map)packet["hashes"])[member] == Hash(to) &&
                        File.ReadAllText(Path.Combine(root, member)) == to && File.ReadAllText(Path.Combine(root, manifest)) == project &&
                        File.ReadAllText(Path.Combine(root, opaque)) == wave, label);
                }
            }

            Check(Hash(source) == (string)fixture["expected"] && Hash(changed) == (string)fixture["desired"], "golden owner raw hashes");
            string currentProject = string.Join("\n", project.Split('\n').Where(row => !row.Contains(opaque))).Replace("2.1", "2.0");
            string currentOwner = source.Replace("2.1", "2.0");
            string WithRequirement(string text)
            {
                int headEnd = text.IndexOf('\n');
                return text.Insert(headEnd - 1, ",\"readerRequires\":{\"future-constraint\":\"2.8\"},\"requires\":[\"future-constraint\"]");
            }
            {
                const string selected = "Selected.wsch", selectedId = "f1234567-89ab-7cde-8f01-23456789abcd";
                string raw = WithRequirement(currentOwner).Replace("\"d1\"", "\"" + selectedId + "\"");
                raw = raw.Insert(raw.IndexOf('\n') - 1, ",\"x-header\": {\"\\ud800\":\"\\udfff\",\"mass\":1e400}");
                raw = raw.Insert(raw.IndexOf('\n'), "\r");
                string finalManifest = currentProject + Line(new Map
                {
                    ["kind"] = "document", ["id"] = selectedId, ["docKind"] = "schematic", ["name"] = "Selected", ["path"] = selected
                });
                Map Copy(string payload, string witness, bool undo = false)
                {
                    string hash = Hash(witness);
                    var row = new Map
                    {
                        ["path"] = selected, ["expected"] = undo ? hash : null,
                        ["nativeCopy"] = new Map { ["grant"] = "selected-fixture", ["sha256"] = hash }
                    };
                    if (undo) row["remove"] = true;
                    else row["data"] = Convert.ToBase64String(Encoding.UTF8.GetBytes(payload));
                    var request = Request(row);
                    ((List<object>)request["plan"]).Add(new Map
                    {
                        ["path"] = manifest, ["expected"] = Hash(undo ? finalManifest : currentProject),
                        ["text"] = undo ? currentProject : finalManifest
                    });
                    return request;
                }
                var witnessed = new Dictionary<string, string>(StringComparer.Ordinal) { [selected] = Hash(raw) };
                var wrongSource = Seed(currentProject, currentOwner);
                using (var folder = new FolderProject(fs, wrongSource, manifest))
                {
                    Throws(() => folder.Commit(Copy(raw, raw), out _), "exact native copy grant", "unwitnessed marker cannot authorize raw Add");
                    Throws(() => folder.Commit(Copy(raw.Replace("SENSE","NEW"), raw), out _, nativeCopyHashes: witnessed),
                        "exact native copy bytes or membership", "different bytes cannot use selected-file evidence");
                    string reserved = raw.Replace("[\"future-constraint\"]", "[\"future-constraint\",\"continuation-parts-v1\"]");
                    Throws(() => folder.Commit(Copy(reserved, reserved), out _,
                        nativeCopyHashes: new Dictionary<string, string> { [selected] = Hash(reserved) }),
                        "continuation-parts-v1", "future parts are never copied");
                }
                Check(!File.Exists(Path.Combine(wrongSource, selected)) &&
                    !File.Exists(Path.Combine(wrongSource, ".waffle", "journal", "active")) &&
                    File.ReadAllText(Path.Combine(wrongSource, manifest)) == currentProject, "declined native copies publish no descriptor");
                string copyingRoot = Seed(currentProject, currentOwner);
                using (var folder = new FolderProject(fs, copyingRoot, manifest, point =>
                {
                    if (point == "after-commit-sync") throw new IOException("stopped after selected copy became durable");
                }))
                    Throws(() => folder.Commit(Copy(raw, raw), out _, nativeCopyHashes: witnessed),
                        "stopped after selected copy became durable", "authorized native copy is published before installation");
                using (var folder = new FolderProject(fs, copyingRoot, manifest))
                {
                    folder.Recover(); folder.Recover();
                    Check(File.ReadAllText(Path.Combine(copyingRoot, selected)) == raw &&
                        File.ReadAllText(Path.Combine(copyingRoot, manifest)) == finalManifest,
                        "native copy rolls forward twice without a volatile grant and preserves mixed delimiters");
                    Throws(() => folder.Commit(Request(Splice(selected, raw, raw.Replace("SENSE","NEW"))), out _),
                        "future-constraint", "the successfully added owner stays read-only");
                    Throws(() => folder.Commit(Copy(null, raw, undo: true), out _),
                        "exact native copy grant", "raw Undo requires the native receipt");
                    File.WriteAllText(Path.Combine(copyingRoot, selected), raw.Replace("SENSE", "EXTERNAL"));
                    Throws(() => folder.Commit(Copy(null, raw, undo: true), out _, nativeCopyHashes: witnessed),
                        "changed on disk", "raw Undo cannot delete externally modified content");
                    Check(File.ReadAllText(Path.Combine(copyingRoot, selected)) == raw.Replace("SENSE", "EXTERNAL"),
                        "raw Undo preserves the external change");
                    File.WriteAllText(Path.Combine(copyingRoot, selected), raw);
                }
                using (var folder = new FolderProject(fs, copyingRoot, manifest, point =>
                {
                    if (point == "after-commit-sync") throw new IOException("stopped after raw Undo became durable");
                }))
                    Throws(() => folder.Commit(Copy(null, raw, undo: true), out _, nativeCopyHashes: witnessed),
                        "stopped after raw Undo became durable", "authorized Undo is published before deletion");
                using (var folder = new FolderProject(fs, copyingRoot, manifest))
                {
                    folder.Recover(); folder.Recover();
                    Check(!File.Exists(Path.Combine(copyingRoot, selected)) &&
                        File.ReadAllText(Path.Combine(copyingRoot, manifest)) == currentProject,
                        "raw Undo rolls forward to exact prior membership");
                    folder.Commit(Copy(raw, raw), out var redo, nativeCopyHashes: witnessed);
                    redo();
                    Check(File.ReadAllText(Path.Combine(copyingRoot, selected)) == raw &&
                        File.ReadAllText(Path.Combine(copyingRoot, manifest)) == finalManifest,
                        "Redo exclusively restores the original exact copy");
                }
            }
            foreach (string mode in new[] { "manifest", "owner", "proposed" })
            {
                string savedProject = mode == "manifest" ? WithRequirement(currentProject) : currentProject;
                string savedOwner = mode == "owner" ? WithRequirement(currentOwner) : currentOwner;
                string proposed = savedOwner.Replace("SENSE", "NEW");
                if (mode == "proposed") proposed = WithRequirement(proposed);
                string root = Seed(savedProject, savedOwner);
                using (var folder = new FolderProject(fs, root, manifest))
                {
                    string diagnostic = "";
                    try { folder.Commit(Request(Splice(member, savedOwner, proposed)), out _); } catch (HostError error) { diagnostic = error.Message; }
                    Check(diagnostic.Contains("future-constraint") && diagnostic.Contains("native format 2.8") &&
                        Untouched(root, savedProject, savedOwner), "required 2.0 " + mode + " refuses without publication and names the required reader");
                }
            }
            {
                var lines = currentOwner.Split('\n');
                string raw = lines[0] + "\r\n" + lines[1] + "\n{ \"kind\":\"futureTrace\", \"id\":\"n2\", \"future\": {\"q\":1.20e2,\"\\u0061\":1e400} }\r\n";
                string edited = raw.Replace("SENSE", "NEW"), root = Seed(currentProject, raw);
                using (var folder = new FolderProject(fs, root, manifest))
                {
                    var packet = (Map)folder.Commit(Request(Splice(member, raw, edited)), out var install); install();
                    Check((string)((Map)packet["hashes"])[member] == Hash(edited) && File.ReadAllText(Path.Combine(root, member)) == edited &&
                        File.ReadAllText(Path.Combine(root, manifest)) == currentProject, "current owner preserves opaque JSON and mixed delimiters through a native splice");
                }
            }
            Saves(source, changed, "newer owner edits text and position and preserves the exact opaque data");
            Saves(source.Replace("2.1", "2.0"), changed.Replace("2.1", "2.0"), "known older member in a newer manifest");
            string added = "{\"kind\":\"wire\",\"id\":\"n3\",\"points\":[[2,3,4],[5,6,7]]}\n";
            Saves(source, changed + added, "an inserted known row uses safe integer coordinate vectors");
            Saves(source + added, changed, "a removed known row contains only recognised fields");
            foreach (bool block in new[] { false, true })
            {
                string kind = block ? "block" : "library", path = block ? "libraries/Parts.wblock" : "libraries/Parts.wlib";
                string savedProject = project + Line(new Map { ["kind"] = block ? "layoutBlock" : "library", ["id"] = "l1", ["path"] = path });
                string owner = source.Replace("schematic", kind).Replace("d1", "l1").Replace("netlabel", block ? "wire" : "pin");
                string result = owner.Replace("SENSE", "DRIVE"), root = Seed(savedProject, source);
                Directory.CreateDirectory(Path.Combine(root, "libraries"));
                File.WriteAllText(Path.Combine(root, path), owner);
                using (var p = new FolderProject(fs, root, manifest))
                {
                    p.Commit(Request(Splice(path, owner, result)), out var apply); apply();
                    Check(File.ReadAllText(Path.Combine(root, path)) == result && File.ReadAllText(Path.Combine(root, member)) == source &&
                        File.ReadAllText(Path.Combine(root, opaque)) == wave, "scoped " + kind + " update preserves extension data and unrelated owners");
                }
            }
            foreach (Map v in ((List<object>)fixture["refuse"]).Cast<Map>())
            {
                string owner = source, manifestText = project;
                string destination = changed, find = (string)v["find"], replacement = (string)v["replace"];
                switch ((string)v["file"])
                {
                    case "owner": owner = source.Replace(find, replacement); destination = owner.Replace((string)edit["from"], (string)edit["to"]); break;
                    case "project": manifestText = project.Replace(find, replacement); break;
                    default: destination = destination.Replace(find, replacement); break;
                }
                Refuses(Seed(manifestText, owner), Splice(member, owner, destination), manifestText, owner, (string)v["name"]);
            }
            foreach (var row in new[] {
                Splice(opaque, wave, wave.Replace("2,4", "2,5")), Splice(manifest, project, project.Replace("sensor", "board")),
                new Map { ["path"] = member, ["expected"] = Hash(source), ["remove"] = true },
                new Map { ["path"] = "New.wsch", ["expected"] = null, ["text"] = source },
                new Map { ["path"] = member, ["expected"] = Hash(source), ["text"] = changed.Replace("measurement", "unrelated") },
                Splice(member, source, changed.Replace("1100", "1100.5")),
                Splice(member, source, changed.Replace("1100", "9007199254740992")),
                Splice(member, source, changed + added + added)
            }) Refuses(Seed(project, source), row, project, source, "unscoped or lossy edit");

            var readRoot = Seed(project, source);
            using (var p = new FolderProject(fs, readRoot, manifest))
            {
                p.Detect();
                string lease = (string)((Map)p.AcquireLease())["lease"];
                Throws(() => p.Read(lease, new List<object> { member }), "unlisted", "known newer owner needs its selected manifest on this lease");
                Throws(() => p.Read(lease, new List<object> { opaque }), "unlisted", "opaque read needs explicit manifest on this lease");
                Throws(() => p.VerifyLease(lease, new Map { [opaque] = Hash(wave) }), "unlisted", "opaque checksum needs explicit manifest on this lease");
                p.Read(lease, new List<object> { manifest });
                var output = (Map)((List<object>)((Map)p.Read(lease, new List<object> { opaque }))["files"]).Single();
                Check((string)output["sha256"] == Hash(wave) && Encoding.UTF8.GetString(Convert.FromBase64String((string)output["data"])) == wave &&
                    p.VerifyLease(lease, new Map { [opaque] = Hash(wave) }), "declared future owner yields its exact bytes on the manifest lease");
                Throws(() => p.Read(lease, new List<object> { "Other.wwave" }), "unlisted", "unlisted future member refused");
                p.Release(lease); Check(Untouched(readRoot, project, source), "inspection creates no workspace state");
            }
            foreach (string badWave in new[] { wave.Replace("f1", "other"), wave.Replace("waveform", "schematic"), wave.Replace("2.1", "2.2") })
            {
                var root = Seed(project, source, badWave);
                using (var p = new FolderProject(fs, root, manifest))
                {
                    p.Detect(); string lease = (string)((Map)p.AcquireLease())["lease"];
                    p.Read(lease, new List<object> { manifest });
                    Throws(() => p.Read(lease, new List<object> { opaque }), "future member identity or version", "opaque bytes must match the declaration");
                    p.Release(lease);
                }
            }
            var staleRoot = Seed(project, source);
            using (var p = new FolderProject(fs, staleRoot, manifest))
            {
                var reads = new Map { [manifest] = Hash("earlier manifest") };
                Throws(() => p.Commit(Request(Splice(member, source, changed)), out _, reads), "changed on disk", "earlier project closure cannot be written");
                Check(Untouched(staleRoot, project, source), "a stale dependency declines before bootstrap");
            }
            string unavailable = Seed(project, source); File.Delete(Path.Combine(unavailable, opaque));
            using (var p = new FolderProject(fs, unavailable, manifest))
            {
                p.Commit(Request(Splice(member, source, changed)), out var apply); apply();
                Check(File.ReadAllText(Path.Combine(unavailable, member)) == changed && !File.Exists(Path.Combine(unavailable, opaque)),
                    "an independent known-owner save never opens or recreates an opaque sibling");
            }
            var recoveryRoot = Seed(project, source);
            using (var p = new FolderProject(fs, recoveryRoot, manifest, point => { if (point == "after-commit-sync") throw new IOException("stopped after commit"); }))
                Throws(() => p.Commit(Request(Splice(member, source, changed)), out _), "stopped after commit", "prior writer stopped before first install");
            using (var p = new FolderProject(fs, recoveryRoot, manifest))
            {
                p.Recover(); p.Recover();
                Check(File.ReadAllText(Path.Combine(recoveryRoot, member)) == changed && File.ReadAllText(Path.Combine(recoveryRoot, opaque)) == wave,
                    "a previously published compatible descriptor replays once");
            }
            RequiredTableTransactions(fs, scratch);
        }

        static void RequiredTableTransactions(PortableFs fs, string scratch)
        {
            group = "required table folder versions";
            const string manifest = "Tables.waffle", member = "Table.wsch";
            const string root2 = "{\"kind\":\"project\",\"formatVersion\":\"2.0\",\"id\":\"table-root\",\"name\":\"Tables\"}\n";
            const string ref2 = "{\"kind\":\"document\",\"id\":\"table-sheet\",\"docKind\":\"schematic\",\"name\":\"Table\",\"path\":\"Table.wsch\"}\n";
            const string owner2 = "{\"kind\":\"schematic\",\"formatVersion\":\"2.0\",\"id\":\"table-sheet\",\"requires\":[]}\n";
            string requirement = ",\"requires\":[\"notebook.table.v1\"]";
            string root21 = root2.Replace("\"2.0\"", "\"2.1\"").Insert(root2.Length - 2, requirement) + ref2.Insert(ref2.Length - 2, requirement);
            string baseRoot = root2 + ref2;
            string owner21 = owner2.Replace("\"2.0\"", "\"2.1\"").Replace(",\"requires\":[]", requirement) +
                "{\"kind\":\"notebookTable\",\"id\":\"table\"}\n";
            string edit21 = owner21 + "{\"kind\":\"tableCell\",\"id\":\"table/table/cell/one\",\"localId\":\"one\",\"tableId\":\"table\"}\n";
            var dir = Directory.CreateDirectory(Path.Combine(scratch, "required-tables")).FullName;
            File.WriteAllText(Path.Combine(dir, manifest), baseRoot);
            File.WriteAllText(Path.Combine(dir, member), owner2);
            Map Change(string path, string before, string after) => new Map
            {
                ["path"] = path, ["expected"] = FolderFormat.Sha(Encoding.UTF8.GetBytes(before)), ["text"] = after
            };
            Map Request(params object[] entries) => new Map
            {
                ["manifest"] = manifest, ["projectId"] = "table-root", ["plan"] = entries.ToList()
            };
            bool Same(string root, string owner) => File.ReadAllText(Path.Combine(dir, manifest)) == root &&
                File.ReadAllText(Path.Combine(dir, member)) == owner;
            var first = Request(Change(member, owner2, owner21), Change(manifest, baseRoot, root21));
            using (var p = new FolderProject(fs, dir, manifest, point =>
                { if (point == "after-commit-sync") throw new IOException("stopped before installing table"); }))
            {
                Throws(() => p.Commit(Request(Change(member, owner2, owner21)), out _), "member identity", "table cannot become required without its manifest");
                Throws(() => p.Commit(Request(Change(manifest, baseRoot, root21)), out _), "missing or different member", "table manifest cannot advance alone");
                Check(Same(baseRoot, owner2), "refused upgrades retain the 2.0 bytes");
                Throws(() => p.Commit(first, out _), "stopped before installing table", "durable joint upgrade can be interrupted after publish");
            }
            using (var p = new FolderProject(fs, dir, manifest))
            {
                p.Recover(); p.Recover();
                Check(Same(root21, owner21), "recovery replays the whole guarded upgrade");
                var receipt = (Map)p.Commit(Request(Change(member, owner21, edit21)), out var install); install(); p.Recover();
                Check((bool)receipt["saved"] && Same(root21, edit21), "ordinary table edit keeps manifest unchanged");
                p.Commit(Request(Change(member, edit21, owner2), Change(manifest, root21, baseRoot)), out var undo); undo(); p.Recover();
                Check(Same(baseRoot, owner2), "last table Undo restores the original byte pairs");
                string optional = "{\"kind\":\"savedQuery\",\"id\":\"02b37782-abcd-7abc-89ab-0123456789ab\",\"value\":{\"name\":\"Pinned query\"}}\n";
                string optionalRoot = baseRoot.Replace("\"2.0\"", "\"2.1\"");
                // The stable query ID sorts before the schematic reference.
                optionalRoot = optionalRoot.Insert(optionalRoot.IndexOf('\n')+1,optional);
                var mixed = root21.Insert(root21.IndexOf('\n')-1,",\"tableBaseVersion\":\"2.1\"");
                var mixedWithQuery = mixed.Insert(mixed.IndexOf('\n')+1,optional);
                p.Commit(Request(Change(manifest,baseRoot,optionalRoot)),out var saveQuery); saveQuery(); p.Recover();
                Throws(() => p.Commit(Request(Change(member,owner2,owner21),
                    Change(manifest,optionalRoot,mixedWithQuery.Replace("Pinned query","Altered query"))),out _),
                    "newer Waffle writer","promotion cannot change a saved query");
                p.Commit(Request(Change(member,owner2,owner21),Change(manifest,optionalRoot,mixedWithQuery)),out var promote); promote(); p.Recover();
                Check(Same(mixedWithQuery,owner21),"promotion retains the exact optional row");
                p.Commit(Request(Change(manifest,mixedWithQuery,mixed)),out var deleteQuery); deleteQuery(); p.Recover();
                Throws(() => p.Commit(Request(Change(member,owner21,owner2),Change(manifest,mixed,baseRoot)),out _),
                    "newer Waffle writer","a former optional 2.1 root cannot be silently demoted");
                p.Commit(Request(Change(member,owner21,owner2),Change(manifest,mixed,baseRoot.Replace("\"2.0\"","\"2.1\""))),out var removeTable);
                removeTable(); p.Recover();
                Check(Same(baseRoot.Replace("\"2.0\"","\"2.1\""),owner2),"last-table Undo retains the empty optional 2.1 stamp");
            }
        }
    }
}
