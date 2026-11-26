#!/usr/bin/env python3
"""Recent projects, format recognition and library reloads in both hosts, without GTK or a window.

The Linux classes are loaded from native/linux/waffle.py (gi is only imported inside main()).
On macOS the same checks run against native/macos/HostState.swift in a small compiled worker.
"""
import importlib.util
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile

NATIVE = Path(__file__).resolve().parents[1]
CORPUS = NATIVE.parent / "tests/fixtures/compat/projects"


def load_linux():
    spec = importlib.util.spec_from_file_location("atrium_linux_host", NATIVE / "linux" / "waffle.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def expect_error(fn, pattern):
    try:
        fn()
    except ValueError as error:
        assert pattern in str(error), (pattern, str(error))
        return
    raise AssertionError("expected an error containing " + repr(pattern))


def altium_fixture(work, outside):
    (work / "Sheets").mkdir()
    (work / "Sheets" / "A.SchDoc").write_bytes(b"nested sheet")
    (work / "B.PcbDoc").write_bytes(b"board")
    (work / "Parts.SchLib").write_bytes(b"library")
    (work / "Old.SchDoc").write_bytes(b"unreferenced sheet")
    (outside / "Elsewhere.SchDoc").write_bytes(b"separate project")
    (work / "linked").symlink_to(outside, target_is_directory=True)
    refs = ["Sheets\\A.SchDoc", "B.PcbDoc", "Parts.SchLib", "B.PcbDoc", "Missing.SchDoc", "linked\\Elsewhere.SchDoc"]
    manifest = work / "Control.PrjPcb"
    body = "".join(f"[Document{i}]\r\nDocumentPath={ref}\r\n" for i, ref in enumerate(refs, 1))
    manifest.write_text(body + "[GeneratedDocument1]\r\nDocumentPath=Old.SchDoc\r\n", encoding="utf-16")
    return manifest


def translator_fixture(path):
    path.write_text(json.dumps([
        {"id": "legacy", "import": True, "extensions": [".waffle", ".atrium"]},
        {"id": "altium", "import": True, "extensions": [".prjpcb", ".schdoc", ".pcbdoc", ".schlib", ".pcblib"],
         "libraryExtensions": [".schlib", ".pcblib"]},
        {"id": "kicad", "import": True, "extensions": [".kicad_sch", ".kicad_sym"], "libraryExtensions": [".kicad_sym"]},
        {"id": "gerber", "import": False, "export": True, "extensions": [".gbr"]},
    ]))


def pre_release_fixture(work):
    original = work / "Original.ATRIUM"
    base = b'{"format":"atrium","version":1,"formatVersion":"1.4","name":"Before"}'
    original.write_bytes(base)
    (work / "Original.ATRIUM.journal").write_bytes(b"ATRIUM-JOURNAL 1\nnever replay this")
    (work / "Original.ATRIUM~").write_bytes(b"private draft sentinel")
    return original


def linux_tests(tmp):
    app = load_linux()
    app.TRANSLATORS = app.TranslatorFiles(tmp / "translators.json")
    corpus = sorted((tmp / "corpus").iterdir())
    assert len(corpus) >= 33
    for file in corpus:
        expect_error(lambda: app.check_open_selection([file]),app.PRE_RELEASE_MESSAGE)

    capability = "window-test:"
    command = json.dumps({"action": "dirty", "dirty": False})
    assert app.bridge_message(capability + command, capability) == json.loads(command)
    for message in (command, "different-window:" + command, capability + "[]", capability):
        assert app.bridge_message(message, capability) is None
    support, work, outside = tmp / "support", tmp / "work", tmp / "outside"
    for _ in range(33):
        app.record_renderer_termination(support, "exited")
    app.record_renderer_termination(support, str(tmp / "private-project"))
    crash_log = app.crash_history(support)
    assert len(crash_log) == 32 and all(set(row) == {"at", "kind", "type", "reason"} for row in crash_log)
    assert all(row["reason"] == "exited" and row["type"] == "Linux" for row in crash_log)
    app.record_renderer_termination(support, "unresponsive")  # Close Window on the not-responding dialog
    assert app.crash_history(support)[-1]["reason"] == "unresponsive" and len(app.crash_history(support)) == 32
    assert app.renderer_termination_counts(support) == {"exited": 31, "memoryLimit": 0, "terminated": 0, "unresponsive": 1}
    for folder in (work, outside):
        folder.mkdir()
    manifest = altium_fixture(work, outside)
    opened = app.encode_files([manifest, work / "B.PcbDoc"])
    assert [(f["name"], f["altiumPath"]) for f in opened] == [
        ("Control.PrjPcb", "Control.PrjPcb"), ("B.PcbDoc", "B.PcbDoc"),
        ("A.SchDoc", "Sheets/A.SchDoc"), ("Parts.SchLib", "Parts.SchLib")]
    assert app.project_path(str(manifest)) == manifest.resolve()
    assert ".kicad_sym" in app.TRANSLATORS.libraries
    assert app.TRANSLATORS.open_types([".KICAD_SCH"]) == {".kicad_sch"}
    for requested in ([".gbr"], [".waffle", "*.txt"], []):
        expect_error(lambda: app.TRANSLATORS.open_types(requested), "Unrecognised import")
    saved_cap = app.PROJECT_READ_CAP
    app.PROJECT_READ_CAP = manifest.stat().st_size + (work / "B.PcbDoc").stat().st_size
    try:
        expect_error(lambda: app.encode_files([manifest, work / "B.PcbDoc"]), "size limit")
    finally:
        app.PROJECT_READ_CAP = saved_cap
    project = work / "Board.waffle"
    project.write_text('{"kind":"project","formatVersion":"2.0","id":"board","name":"Board"}\n')
    app.check_open_selection([project])
    original = pre_release_fixture(work)
    affected = [original,work / "Original.ATRIUM.journal",work / "Original.ATRIUM~"]
    before = [(path.read_bytes(),path.stat().st_mtime_ns) for path in affected]
    old = work / "Old.waffle"
    old.write_bytes(original.read_bytes())
    assert ".atrium" not in app.TRANSLATORS.open_types(None)
    receipts = {}
    for path in (original,old):
        expect_error(lambda: app.encode_files([path],receipts=receipts),app.PRE_RELEASE_MESSAGE)
        assert not receipts
    assert before == [(path.read_bytes(),path.stat().st_mtime_ns) for path in affected]
    assert not (work / ".waffle").exists()
    secret = outside / "secret.waffle"
    secret.write_text('{"secret":true}')

    # Path checks: relative paths, traversal, NUL bytes, non-strings.
    for bad in ("Board.waffle", str(work) + "/../work/Board.waffle", str(project) + "\0", 5, None, "/" + "a" * 5000):
        assert app.checked_path(bad) is None, bad
    assert app.checked_path(str(project)) == project.resolve()

    # Recent list: only remembered .waffle projects open; it persists and is capped.
    recent = app.RecentProjects(support)
    expect_error(lambda: recent.allowed(str(project)), "not in the recent")
    recent.note(project, when=1000)
    assert recent.listing() == [{"name": "Board.waffle", "path": str(project.resolve()), "openedAt": 1000000.0}]
    assert recent.allowed(str(project)) == project.resolve()
    expect_error(lambda: recent.allowed(str(secret)), "not in the recent")
    recent.note(work / "notes.txt")
    assert len(recent.entries) == 1
    for n in range(20):
        extra = work / ("p%d.waffle" % n)
        extra.write_text("{}")
        recent.note(extra)
    assert len(recent.entries) == app.RECENT_LIMIT
    again = app.RecentProjects(support)
    assert [e["path"] for e in again.entries] == [e["path"] for e in recent.entries]
    assert again.entries[0]["path"].endswith("p19.waffle")
    # A remembered project replaced by a symlink to another file is refused.
    target = recent.entries[0]["path"]
    os.unlink(target)
    os.symlink(str(secret), target)
    expect_error(lambda: again.allowed(target), "not in the recent")  # realpath now names the other file
    assert all(e["path"] != target for e in again.listing()) or os.path.isfile(target)
    # A tampered store with relative or foreign entries loads only valid ones.
    (support / app.RecentProjects.FILE).write_text(json.dumps([{"path": "rel.waffle"}, {"path": "/etc/passwd"}, {"path": str(project), "openedAt": 3}]))
    tampered = app.RecentProjects(support)
    assert [e["path"] for e in tampered.entries] == [str(project)]
    tampered.clear()
    assert tampered.listing() == [] and app.RecentProjects(support).entries == []

    # The picker, CLI and recent menu share routing. Reading a recent file for reload still returns its data.
    windows = []
    opening = app.ProjectOpen(lambda paths, **options: app.encode_files(paths, **options), windows.append, recent.note)
    assert len(opening.open([manifest])) == 4
    assert opening.open([project]) == [] and windows == [[project]]
    opening.finished(False)
    expect_error(lambda: recent.allowed(str(manifest)), "not in the recent")
    assert len(opening.open([manifest])) == 4
    opening.has_project = True
    opening.finished(True)
    assert app.RecentProjects(support).allowed(str(manifest)) == manifest
    assert len(opening.recent(recent, str(manifest), False)) == 4
    assert windows == [[project]]
    assert opening.recent(recent, str(manifest), True) == [] and windows[-1] == [manifest]
    expect_error(lambda: opening.recent(recent, str(secret), True), "not in the recent")
    assert windows == [[project], [manifest]]
    sheet, library = work / "Sheets" / "A.SchDoc", work / "Parts.SchLib"
    assert opening.open([sheet, library]) == [] and windows[-1] == [sheet, library]
    assert opening.open([library])[0]["name"] == library.name and len(windows) == 3

    # The close prompt's Save: the window closes only on a saved, clean report, once per Save.
    closing = app.SaveToClose()
    assert app.SaveToClose.title("Board") == "Save changes to \u201cBoard\u201d before closing?"
    assert app.SaveToClose.title(None) == app.SaveToClose.title("  ") == "Save changes to \u201cUntitled\u201d before closing?"
    assert not closing.finished(True, False), "a report without a Save for closing never closes"
    assert closing.start() and not closing.start(), "one Save for closing at a time"
    assert not closing.finished(False, True) and not closing.pending, "a cancelled save dialog keeps the window"
    assert not closing.finished(True, False), "a later ordinary save does not close the window"
    assert closing.start() and not closing.finished(True, True), "edits left unsaved keep the window"
    assert closing.start() and closing.finished(True, False) and not closing.pending, "a saved, clean project closes"
    assert closing.start()
    closing.abandon()
    assert not closing.pending and not closing.finished(True, False), "a crashed page abandons the save"

    # Library reads: only chosen .atrlib/.json files, regular, capped, JSON objects.
    library = work / "parts.atrlib"
    library.write_text('{"format":"atrium-library","version":1,"defs":[]}')
    reads = app.LibraryReads(support)
    expect_error(lambda: reads.read(str(library)), "Open this library file again")
    reads.remember(library)
    reads.remember(secret)  # wrong extension: never remembered
    assert reads.read(str(library))["text"].startswith('{"format"')
    assert app.LibraryReads(support).read(str(library))["name"] == "parts.atrlib"
    expect_error(lambda: reads.read(str(secret)), "Open this library file again")
    expect_error(lambda: reads.read(str(work) + "/../work/parts.atrlib"), "Open this library file again")
    library.write_text("not json")
    expect_error(lambda: reads.read(str(library)), "not a JSON library")
    library.write_bytes(b"{" + b" " * (app.LIBRARY_READ_CAP + 1) + b"}")
    expect_error(lambda: reads.read(str(library)), "too large")
    library.unlink()
    os.symlink(str(outside / "secret.waffle"), str(library))
    expect_error(lambda: reads.read(str(library)), "Open this library file again")  # canonical path differs now
    library.unlink()
    (outside / "lib.atrlib").write_text("{}")
    os.symlink(str(outside / "lib.atrlib"), str(library))
    expect_error(lambda: reads.read(str(library)), "Open this library file again")
    # The final component swapped for a symlink after the canonical path was remembered.
    real = work / "real.json"
    real.write_text("{}")
    reads.remember(real)
    real.unlink()
    os.symlink(str(outside / "lib.atrlib"), str(real))
    assert app.checked_path(str(real)) != real  # realpath follows it, so the list no longer matches
    expect_error(lambda: reads.read(str(real)), "Open this library file again")
    try:
        app.read_regular(real, 100)
        raise AssertionError("read_regular followed a symlink")
    except app.HostError as error:
        assert "symbolic link" in str(error)

    for path in (old,original):
        held = list(windows)
        expect_error(lambda: opening.open([path]),app.PRE_RELEASE_MESSAGE)
        assert windows == held, "a refused input must not create another editor window"

    # private_atomic_write leaves the old file intact when the write fails.
    keep = work / "keep.json"
    keep.write_text("old")
    try:
        app.private_atomic_write(keep, object())
    except TypeError:
        pass
    assert keep.read_text() == "old" and [p for p in work.iterdir() if p.name.startswith(".keep")] == []
    allowed = work / "Part.kicad_sym"
    allowed.write_text("symbol")
    (outside / "Secret.kicad_sym").write_text("outside")
    target = work / "models"
    target.mkdir()
    (target / "Test.step").write_text("ISO-10303-21;")
    f = app.LibraryFolders(support)
    read_grant = f.remember(work, "read")["grant"]
    f = app.LibraryFolders(support)
    expect_error(lambda: f.list("unchecked"), "Choose this library folder again")
    assert "Part.kicad_sym" in {row["path"] for row in f.list(read_grant)["entries"]}
    assert f.read(read_grant, ["Part.kicad_sym"]) == [{"data": "c3ltYm9s"}]
    for path in ("../outside/Secret.kicad_sym", "linked/Secret.kicad_sym", "models/Test.step"):
        assert "error" in f.read(read_grant, [path])[0], path
    expect_error(lambda: f.write(read_grant, "components/part.json", "{}"), "Choose a library folder to save to")
    grant = f.remember(work, "write")["grant"]
    assert f.write(grant, "components/part.json", '{"id":"test"}')
    assert json.loads((work / "components" / "part.json").read_text())["id"] == "test"
    expect_error(lambda: f.write(grant, "library.json", "{}"), "inside the components folder")
    (work / "components" / "link.json").symlink_to(outside / "Secret.kicad_sym")
    f.write(grant, "components/link.json", "{}")
    assert (outside / "Secret.kicad_sym").read_text() == "outside"
    models = f.remember(target, "models")["grant"]
    assert "data" in f.read(models, ["Test.step"])[0]
    f.forget(read_grant)
    expect_error(lambda: f.list(read_grant), "Choose this library folder again")
    print("linux: selection filters, read-only imports, pre-release rejection, paths, recent list and libraries passed")


SWIFT_WORKER = r"""
import Foundation
func expect(_ ok: Bool, _ what: String) { if !ok { print("FAIL " + what); exit(1) } }
func fails(_ what: String, _ needle: String, _ body: () throws -> Void) {
    do { try body(); print("FAIL no error: " + what); exit(1) }
    catch { expect(error.localizedDescription.contains(needle), what + ": " + error.localizedDescription) }
}
let args = CommandLine.arguments
let work = URL(fileURLWithPath: args[1]), outside = URL(fileURLWithPath: args[2])
HostFiles.supportDirectory = URL(fileURLWithPath: args[3])
let fm = FileManager.default
let translators = TranslatorFiles(URL(fileURLWithPath: args[4]))
let corpus = try! fm.contentsOfDirectory(at:URL(fileURLWithPath:args[5]),includingPropertiesForKeys:nil)
expect(corpus.count >= 33,"complete pre-release corpus")
for file in corpus {
    fails("retired " + file.lastPathComponent,ProjectFileType.preReleaseMessage) { try ProjectFileType.checkSelection(file) }
}
expect(translators.accepts(work.appendingPathComponent("Test.KICAD_SCH")) && translators.libraries.contains("kicad_sym"), "registered design and library")
expect(try! translators.openTypes([".KICAD_SCH"]) == ["kicad_sch"], "narrowed design filter")
fails("read-only Open filters", "Unrecognised import") { _ = try translators.openTypes([".gbr"]) }
fails("malformed Open filters", "Unrecognised import") { _ = try translators.openTypes([".waffle", "*.txt"]) }
let original = work.appendingPathComponent("Original.ATRIUM")
let companions = [original,work.appendingPathComponent("Original.ATRIUM.journal"),work.appendingPathComponent("Original.ATRIUM~")]
let before = try! companions.map { try Data(contentsOf:$0) }
fails("explicit native pre-release file",ProjectFileType.preReleaseMessage) { try ProjectFileType.checkSelection(original) }
let oldWaffle = work.appendingPathComponent("Retired.waffle")
try! before[0].write(to:oldWaffle)
fails("old Waffle suffix",ProjectFileType.preReleaseMessage) { try ProjectFileType.checkSelection(oldWaffle) }
expect(!translators.accepts(original) && translators.accepts(oldWaffle),"only the current project extension appears in File Open")
expect(try! companions.map { try Data(contentsOf:$0) } == before,"authored project and companions untouched")
HostFiles.storeJSON("renderer-crashes.json", (0..<32).map { ["at": $0, "kind": "renderer", "type": "macOS", "reason": "terminated"] })
CrashHistory.noteTermination()
let failures = CrashHistory.listing()
expect(failures.count == 32 && failures.first?["at"] as? Int == 1, "bounded renderer history")
expect(Set(failures.last!.keys) == Set(["at", "kind", "type", "reason"]), "only renderer codes and time are stored")
expect(CrashHistory.counts() == ["terminated":32, "unresponsive":0], "support summary contains only known Mac counters")
HostFiles.storeJSON("renderer-crashes.json", [["kind":"renderer", "type":"macOS", "reason":"unresponsive", "at":7, "path":"Private.waffle"],
                                            ["kind":"renderer", "type":"macOS", "reason":"memory-limit"],
                                            ["kind":"renderer", "type":"Linux", "reason":"terminated"]])
expect(CrashHistory.counts() == ["terminated":0, "unresponsive":1], "support summary discards other host reasons and row details")
expect([0,1,2,3,8].map(SupportDiagnostics.displayCount) == ["unknown","one","two","three-or-more","three-or-more"], "available display count buckets")
#if arch(arm64)
expect(SupportDiagnostics.architecture == "arm64", "Apple silicon host architecture")
#else
expect(["x64", "arm64", "unknown"].contains(SupportDiagnostics.architecture), "coarse architecture on Intel or Rosetta")
#endif
let manifest = work.appendingPathComponent("Control.PrjPcb"), board = work.appendingPathComponent("B.PcbDoc")
let manifestData = try! Data(contentsOf: manifest)
var files = [["name":manifest.lastPathComponent], ["name":board.lastPathComponent]], remaining = 1024
try! AltiumProjectFiles.include(manifest, bytes: manifestData, selected: [manifest,board], files: &files, remaining: &remaining)
expect(files.map { $0["name"]! } == ["Control.PrjPcb","B.PcbDoc","A.SchDoc","Parts.SchLib"], "referenced documents only")
expect(files[1]["altiumPath"] == "B.PcbDoc" && files[2]["altiumPath"] == "Sheets/A.SchDoc", "relative names and explicit file deduplication")
expect(Data(base64Encoded: files[2]["data"]!) == Data("nested sheet".utf8), "nested document bytes")
var low = 0, limited = [["name":manifest.lastPathComponent]]
fails("Altium project budget", "size limit") {
    try AltiumProjectFiles.include(manifest, bytes: manifestData, selected: [manifest], files: &limited, remaining: &low)
}
let project = work.appendingPathComponent("Board.waffle")
try! Data("{\"kind\":\"project\",\"formatVersion\":\"2.0\",\"id\":\"board\"}\n".utf8).write(to:project)
try! ProjectFileType.checkSelection(project)
let secret = outside.appendingPathComponent("secret.waffle")
try! Data("{}".utf8).write(to: secret)

for bad in ["Board.waffle", work.path + "/../x/Board.waffle", project.path + "\0", "/" + String(repeating: "a", count: 5000)] {
    expect(HostFiles.checkedPath(bad) == nil, "checkedPath " + bad.prefix(40))
}
expect(HostFiles.checkedPath(5) == nil, "checkedPath non-string")

let recent = RecentProjects()
fails("unknown recent", "not in the recent") { _ = try recent.allowed(project.path) }
recent.note(project)
expect(try! recent.allowed(project.path) == ProjectWrites.canonical(project), "allowed recent")
fails("other path", "not in the recent") { _ = try recent.allowed(secret.path) }
for n in 0..<20 { let u = work.appendingPathComponent("p\(n).waffle"); try! Data("{}".utf8).write(to: u); recent.note(u) }
expect(recent.entries.count == HostFiles.recentLimit, "recent cap")
expect(RecentProjects().entries.map { $0.path } == recent.entries.map { $0.path }, "recent persisted")
let top = recent.entries[0].path
try! fm.removeItem(atPath: top)
try! fm.createSymbolicLink(atPath: top, withDestinationPath: secret.path)
fails("symlinked recent", "not in the recent") { _ = try recent.allowed(top) }
recent.clear()
expect(RecentProjects().entries.isEmpty, "recent cleared")

let library = work.appendingPathComponent("parts.atrlib")
try! Data("{\"format\":\"atrium-library\"}".utf8).write(to: library)
let reads = LibraryReads()
fails("unchosen library", "Open this library file again") { _ = try reads.read(library.path) }
reads.remember(library)
reads.remember(secret)
expect((try! LibraryReads().read(library.path))["name"] == "parts.atrlib", "library persisted")
fails("not allowlisted", "Open this library file again") { _ = try reads.read(secret.path) }
fails("traversal", "Open this library file again") { _ = try reads.read(work.path + "/../" + work.lastPathComponent + "/parts.atrlib") }
try! Data("nope".utf8).write(to: library)
fails("not json", "not a JSON") { _ = try reads.read(library.path) }
try! Data(count: HostFiles.libraryReadCap + 1).write(to: library)
fails("too large", "too large") { _ = try reads.read(library.path) }
try! fm.removeItem(at: library)
try! fm.createSymbolicLink(atPath: library.path, withDestinationPath: secret.path)
fails("symlink swap", "Open this library file again") { _ = try reads.read(library.path) }
do { _ = try HostFiles.readRegular(library, cap: 100); expect(false, "readRegular followed a link") }
catch { expect(error.localizedDescription.contains("symbolic link"), "readRegular nofollow") }

let allowed = work.appendingPathComponent("Part.kicad_sym")
try! Data("symbol".utf8).write(to: allowed)
try! Data("outside".utf8).write(to: outside.appendingPathComponent("Secret.kicad_sym"))
let modelFolder = work.appendingPathComponent("models")
try! fm.createDirectory(at: modelFolder, withIntermediateDirectories: false)
try! Data("ISO-10303-21;".utf8).write(to: modelFolder.appendingPathComponent("Test.step"))
let readGrant = try! LibraryFolders.remember(work, purpose: "read")["grant"]!
fails("ungranted folder", "Choose this library folder again") { _ = try LibraryFolders.list("unchecked") }
let entries = try! LibraryFolders.list(readGrant)["entries"] as! [[String: Any]]
expect(entries.contains { $0["path"] as? String == "Part.kicad_sym" }, "granted folder lists relative names")
expect((try! LibraryFolders.read(readGrant, ["Part.kicad_sym"])).first?["data"] == "c3ltYm9s", "granted library bytes")
for bad in ["../outside/Secret.kicad_sym", "linked/Secret.kicad_sym", "models/Test.step"] {
    expect((try! LibraryFolders.read(readGrant, [bad])).first?["error"] != nil, "blocked library path " + bad)
}
fails("read-only grant", "Choose a library folder to save to") { try LibraryFolders.write(readGrant, "components/part.json", "{}") }
let grant = try! LibraryFolders.remember(work, purpose: "write")["grant"]!
try! LibraryFolders.write(grant, "components/part.json", "{}")
expect(fm.fileExists(atPath: work.appendingPathComponent("components/part.json").path), "explicit file save")
fails("only component files", "inside the components folder") { try LibraryFolders.write(grant, "library.json", "{}") }
let componentLink = work.appendingPathComponent("components/link.json"), victimSymbol = outside.appendingPathComponent("Secret.kicad_sym")
try! fm.createSymbolicLink(atPath: componentLink.path, withDestinationPath: victimSymbol.path)
try! LibraryFolders.write(grant, "components/link.json", "{}")
expect((try! String(contentsOf: victimSymbol, encoding: .utf8)) == "outside", "symlink target unchanged")
let modelsGrant = try! LibraryFolders.remember(modelFolder, purpose: "models")["grant"]!
expect((try! LibraryFolders.read(modelsGrant, ["Test.step"])).first?["data"] != nil, "STEP from chosen model folder")
LibraryFolders.forget(readGrant)
fails("removed grant", "Choose this library folder again") { _ = try LibraryFolders.list(readGrant) }

print("PASS")
"""


def swift_tests(tmp):
    if sys.platform != "darwin" or not shutil.which("xcrun"):
        print("macos: skipped (no xcrun)")
        return
    build = tmp / "swift"
    build.mkdir()
    (build / "main.swift").write_text(SWIFT_WORKER)
    binary = build / "host-state"
    subprocess.run(["xcrun", "swiftc", "-module-cache-path", str(build / "cache"),
                    str(NATIVE / "macos" / "ProjectWrites.swift"), str(NATIVE / "macos" / "HostState.swift"),
                    str(build / "main.swift"), "-o", str(binary)], check=True)
    for name in ("work", "outside"):
        (tmp / ("s-" + name)).mkdir()
    altium_fixture(tmp / "s-work", tmp / "s-outside")
    pre_release_fixture(tmp / "s-work")
    result = subprocess.run([str(binary), str(tmp / "s-work"), str(tmp / "s-outside"), str(tmp / "s-support"), str(tmp / "translators.json"), str(tmp / "corpus")],
                            capture_output=True, text=True)
    assert result.returncode == 0 and "PASS" in result.stdout, result.stdout + result.stderr
    print("macos: selection filters, read-only imports, pre-release rejection, paths, recent list and libraries passed")


def main():
    with tempfile.TemporaryDirectory() as folder:
        tmp = Path(os.path.realpath(folder))
        shutil.copytree(CORPUS,tmp / "corpus")
        translator_fixture(tmp / "translators.json")
        linux_tests(tmp)
        swift_tests(tmp)


if __name__ == "__main__":
    main()
