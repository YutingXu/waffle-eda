#!/usr/bin/env python3
"""Exercise format-2 publication, stale writes and recovery through the native worker processes."""
import importlib.util
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile

ROOT = Path(__file__).resolve().parents[2]
NATIVE = ROOT / "native"
FIXTURES = NATIVE / "tests/folder-transaction"
spec = importlib.util.spec_from_file_location("crash_oracle", ROOT / "scripts/format-2-qa/crash.py")
oracle = importlib.util.module_from_spec(spec)
spec.loader.exec_module(oracle)
sys.path.insert(0, str(NATIVE))
from obsolete_project import NOTE


def workers(build):
    drivers = {}
    if sys.platform.startswith("linux"):
        drivers["Linux"] = oracle.Driver([sys.executable, "-B", str(FIXTURES / "linux.py")])
    if sys.platform == "darwin":
        binary = build / "mac-folder"
        subprocess.run(["xcrun", "swiftc", "-swift-version", "5", str(NATIVE / "macos/FolderTransactions.swift"),
                        str(FIXTURES / "main.swift"), "-o", str(binary)], check=True)
        drivers["macOS"] = oracle.Driver([str(binary)])
    dotnet = os.environ.get("DOTNET") or shutil.which("dotnet")
    if dotnet:
        project = NATIVE / "windows/tests/Waffle.Windows.Tests.csproj"
        subprocess.run([dotnet, "build", str(project), "-c", "Release", "-p:NuGetAudit=false", "-v:q"],
                       check=True)
        binary = project.parent / "bin/Release/net8.0/Waffle.Windows.Tests.dll"
        corpus = build / "windows-historical-projects"
        shutil.copytree(ROOT / "tests/fixtures/compat/projects",corpus)
        subprocess.run([dotnet,str(binary),"--project-header-corpus",str(corpus)],check=True)
        drivers["Windows core"] = oracle.Driver([dotnet, str(binary), "--folder-worker"])
    if not drivers:
        raise RuntimeError("Install a native folder worker to exercise publication and recovery.")
    return drivers


def check_pair(publisher, reader, root):
    case = oracle.case("edit")
    oracle.seed(root, case.before)
    code, rows, error = publisher.call(root, "commit", case.request, {"WAFFLE_FOLDER_KILL": "after-commit-sync"})
    assert code != 0 and not any(r.get("saved") for r in rows), (code, rows, error)
    published = oracle.descriptor(root)
    assert published is not None and published["projectId"] == case.request["projectId"], (code,rows,error)
    oracle.check_namespace(root,case.before)
    for _ in range(2):
        reader.recover(root)
        oracle.check_namespace(root,case.after)
        oracle.verify_reader(reader,root,case.after)
    assert oracle.descriptor(root) is None
    # The winning save is idempotent. A stale editor requesting other bytes must fail.
    change = case.request["plan"][0]
    stale = {**case.request,"plan":[{"path":change["path"],"expected":change["expected"],
                                    "text":case.after[change["path"]].decode().replace("SENSE","DIFFERENT")}]}
    code, rows, _ = publisher.call(root,"commit",stale)
    assert code != 0 and rows and not rows[0].get("saved"), (code,rows)
    oracle.check_namespace(root,case.after)


def check_delete_attachment(publisher, reader, root, checkpoint):
    case = oracle.case("delete-asset")
    oracle.seed(root, case.before)
    code, rows, error = publisher.call(root, "commit", case.request, {"WAFFLE_FOLDER_KILL": checkpoint})
    assert code != 0, (code, rows, error)
    committed = checkpoint != "before-publish"
    active = oracle.descriptor(root)
    assert bool(active) == committed
    assert sum(r.get("saved") is True for r in rows) == int(committed), (checkpoint, rows)
    if committed:
        assert [e["path"] for e in active["plan"]] == [e["path"] for e in case.request["plan"]]
        assert next(e for e in active["plan"] if e["path"] == "Child.wsch")["desired"] is None
        read_code, reads, _ = reader.call(root, "read", {"paths": [oracle.PROJECT]})
        assert read_code and not any("files" in row for row in reads)
    else:
        oracle.check_case(root, case, False)
    for _ in range(2):
        reader.recover(root)
        oracle.check_case(root, case, committed)
        oracle.verify_reader(reader, root, case.after if committed else case.before)
    assert oracle.descriptor(root) is None
    if not committed:
        code, rows, error = publisher.call(root, "commit", case.request)
        assert code == 0 and sum(r.get("saved") is True for r in rows) == 1, (code, rows, error)
        oracle.check_case(root, case, True)


def check_retired(root):
    root.mkdir()
    for ext in ("waffle","ATRIUM"):
        file = root / ("Old." + ext)
        file.write_bytes(b'{"format":"atrium","version":1,"documents":[],"library":[]}')
        (root / (file.name + ".journal")).write_bytes(b"ATRIUM-JOURNAL 1\nprivate saved edit")
        (root / (file.name + "~")).write_bytes(b"private draft")
        before = {p.name:(p.read_bytes(),p.stat().st_mtime_ns) for p in root.iterdir()}
        command = [sys.executable, "-B", str(NATIVE / "linux/waffle.py"), "--browser", str(file)]
        refused = subprocess.run(command,capture_output=True,text=True,check=False)
        assert refused.returncode == 1 and refused.stdout == "" and refused.stderr.strip() == NOTE, refused
        after = {p.name:(p.read_bytes(),p.stat().st_mtime_ns) for p in root.iterdir()}
        assert before == after and not (root / ".waffle").exists()


def main():
    with tempfile.TemporaryDirectory(prefix="waffle-native-formats-") as directory:
        root = Path(directory).resolve()
        check_retired(root / "retired")
        if sys.platform.startswith("linux"):
            subprocess.run([sys.executable, "-B", str(FIXTURES / "linux-standalone.py")], check=True)
        engines = workers(root)
        typed_directory_cases = [
            "typed-directory-looks like a file.wsch",
            "typed-directory-looks like a file.wpcb",
            "typed-directory-looks like a file.wdraw",
            "typed-directory-looks like a file.wpanel",
            "typed-directory-looks like a file.wlib",
            "typed-directory-.wpcb",
            "case-folded-file-and-directory",
        ]
        for i,(name,publisher) in enumerate(engines.items()):
            checked = oracle.typed_directories(publisher, root)
            assert checked == typed_directory_cases, (name, checked)
            print("PASS %s rejected all seven typed directory and case-folding collisions" % name)
            for j,(label,reader) in enumerate(engines.items()):
                folder = root / ("pair-%d-%d" % (i,j))
                folder.mkdir()
                check_pair(publisher,reader,folder)
                for point in ("before-publish", "acknowledged", "after-install:2"):
                    member_set = root / ("members-%d-%d-%s" % (i,j,point.replace(":", "-")))
                    member_set.mkdir()
                    check_delete_attachment(publisher, reader, member_set, point)
                print("PASS %s to %s: rollback, durable recovery, attachment and deletion, retry and external-write protection" % (name,label))
        print("PASS pre-release desktop launch preserved both original files, saved journals and private drafts")


if __name__ == "__main__":
    main()
