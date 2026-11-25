"""Exercise folder Git reads against real Git trees and the public format 2.0 golden records."""
import base64
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import unittest


ROOT = Path(__file__).resolve().parents[2]
SERVER = Path(os.environ.get("WAFFLE_MCP_SERVER", ROOT / "mcp/server.py")).resolve()
sys.path.insert(0, str(ROOT / "native"))
from git_head import BaselineError, ProjectHistory, query


def git(root, *args):
    return subprocess.run(["git", "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid",
                           "-c", "commit.gpgSign=false", "-c", "core.hooksPath=" + os.devnull, "-C", str(root), *args],
                          check=True, capture_output=True, text=True).stdout.strip()


def create_fixture(root):
    project = root / "Design"
    shutil.copytree(ROOT / "tests/fixtures/format-2/golden", project)
    manifest, power = project / "Sensor Board.waffle", project / "Power.wsch"
    manifest.write_bytes(manifest.read_bytes() +
                         b'{"kind":"document","id":"s2","docKind":"schematic","name":"Reserve","path":"Reserve.wsch"}\n')
    (project / "Reserve.wsch").write_bytes(b'{"kind":"schematic","formatVersion":"2.0","id":"s2"}\n'
                                      b'{"kind":"netlabel","id":"n2","at":[2540000,2540000],"text":"AUX"}\n')
    (root / "Unrelated.wsch").write_bytes(b'Unrelated repository file that the project must never read.\n')
    git(root, "init", "-b", "main")
    git(root, "add", ".")
    git(root, "commit", "-m", "Add both sheets")
    base = git(root, "rev-parse", "HEAD")
    git(root, "switch", "-c", "labels")
    power.write_bytes(power.read_bytes().replace(b'"SENSE"', b'"SIGNAL"'))
    git(root, "commit", "-am", "Edit label without changing manifest")
    labels = git(root, "rev-parse", "HEAD")
    git(root, "switch", "main")
    git(root, "mv", "Design/Reserve.wsch", "Design/Support.wsch")
    manifest.write_bytes(manifest.read_bytes().replace(b'"Reserve"', b'"Support"').replace(b'"Reserve.wsch"', b'"Support.wsch"'))
    git(root, "commit", "-am", "Rename a sheet and keep its ID")
    renamed = git(root, "rev-parse", "HEAD")
    git(root, "merge", "--no-ff", "-m", "Merge label edit", "labels")
    merge = git(root, "rev-parse", "HEAD")
    git(root, "switch", "-c", "opaque")
    manifest.write_bytes(manifest.read_bytes().replace(b'"2.0"', b'"2.2"') +
                         b'{"kind":"document","id":"z1","docKind":"waveform","name":"Signal View","path":"Signal View.wwave"}\n')
    future = b'{"kind":"waveform","formatVersion":"2.1","id":"z1"}\n{"kind":"trace","id":"z2","samples":[1,2]}\n'
    (project / "Signal View.wwave").write_bytes(future)
    git(root, "add", ".")
    git(root, "commit", "-m", "Preserve an opaque document")
    opaque = git(root, "rev-parse", "HEAD")
    git(root, "switch", "-c", "unsupported")
    manifest.write_bytes(manifest.read_bytes().replace(b'"2.2"', b'"3.0"'))
    git(root, "commit", "-am", "Require a newer incompatible format")
    unsupported = git(root, "rev-parse", "HEAD")
    git(root, "switch", "main")
    git(root, "switch", "-c", "incomplete")
    git(root, "rm", "Design/Power.wsch")
    git(root, "commit", "-m", "Remove a required sheet without editing the manifest")
    incomplete = git(root, "rev-parse", "HEAD")
    git(root, "switch", "main")
    power.write_bytes(power.read_bytes().replace(b'"SIGNAL"', b'"WORKING"'))
    private = project / ".waffle/local"
    private.mkdir(parents=True)
    (private / "probe").write_bytes(b"untracked private editor state")
    return dict(manifest=str(manifest), base=base, labels=labels, renamed=renamed, merge=merge, opaque=opaque,
                unsupported=unsupported, incomplete=incomplete, future=base64.b64encode(future).decode("ascii"))


def snapshot(root):
    return {item.relative_to(root).as_posix(): hashlib.sha256(item.read_bytes()).hexdigest()
            for item in root.rglob("*") if item.is_file()}


class FolderGitTests(unittest.TestCase):
    def setUp(self):
        directory = tempfile.TemporaryDirectory(prefix="waffle-folder-git-")
        self.addCleanup(directory.cleanup)
        self.root = Path(directory.name).resolve()
        self.fixture = create_fixture(self.root)
        self.manifest = Path(self.fixture["manifest"])
        self.original = snapshot(self.root)

    def tearDown(self):
        self.assertEqual(snapshot(self.root), self.original)

    def test_modify_delete_survives_the_merged_manifest_removing_its_link(self):
        with tempfile.TemporaryDirectory(prefix="waffle-git-removed-owner-") as directory:
            root = Path(directory).resolve()
            project = root / "Design"
            project.mkdir()
            manifest = project / "Project.waffle"
            header = b'{"kind":"project","formatVersion":"2.0","id":"project","name":"Project"}\n'
            reference = b'{"kind":"document","id":"sheet","docKind":"schematic","name":"Existing","path":"Existing.wsch"}\n'
            manifest.write_bytes(header + reference)
            sheet = project / "Existing.wsch"
            unrelated = project / "Foreign.wsch"
            base = b'{"kind":"schematic","formatVersion":"2.0","id":"sheet"}\n{"kind":"label","id":"text","text":"BASE"}\n'
            edited = base.replace(b"BASE", b"EDITED")
            sheet.write_bytes(base)
            unrelated.write_bytes(b"other file\n")
            git(root, "init", "-b", "main")
            git(root, "add", ".")
            git(root, "commit", "-m", "Owned schematic and a separate file")
            git(root, "switch", "-c", "edited")
            sheet.write_bytes(edited)
            unrelated.write_bytes(b"separate edit\n")
            git(root, "commit", "-am", "Edit both files")
            git(root, "switch", "main")
            git(root, "rm", str(sheet), str(unrelated))
            manifest.write_bytes(header)
            git(root, "commit", "-am", "Remove both files and the project reference")
            with self.assertRaises(subprocess.CalledProcessError):
                git(root, "merge", "edited")
            before = snapshot(root)
            status = query(manifest, "status")
            self.assertEqual(status["conflicts"], [{"path":"Existing.wsch", "stages":["base", "theirs"]}])
            bundle = query(manifest, "folderRevisions", {"stages":["base", "ours", "theirs"]})
            self.assertEqual(list(bundle["removedOwners"]), ["Existing.wsch"])
            owner = bundle["removedOwners"]["Existing.wsch"]
            self.assertEqual((owner["id"], owner["edit"], owner["reference"]), ("sheet", "theirs", reference.decode()))
            self.assertEqual({side:base64.b64decode(bundle["objects"][oid]) for side, oid in owner["stages"].items()},
                             {"base":base, "theirs":edited})
            self.assertEqual(snapshot(root), before, "status and conflict review leave the index and worktree intact")
            if sys.platform.startswith("linux"):
                plan = [{"path":manifest.name, "expected":hashlib.sha256(header).hexdigest(),
                         "data":base64.b64encode(header + owner["reference"].encode()).decode()}]
                writer = ROOT / "native/tests/folder-transaction/linux.py"
                reply = subprocess.run([sys.executable, "-I", "-B", str(writer), str(project), manifest.name, "commit"],
                                       input=json.dumps({"projectId":"project", "manifest":manifest.name, "plan":plan}),
                                       capture_output=True, text=True)
                self.assertEqual(reply.returncode, 0, reply.stdout + reply.stderr)
                self.assertTrue(json.loads(reply.stdout.splitlines()[0])["saved"])
                self.assertEqual(manifest.read_bytes(), header + reference)
                self.assertEqual(sheet.read_bytes(), edited)
                self.assertEqual(hashlib.sha256((root / ".git/index").read_bytes()).hexdigest(), before[".git/index"])
                self.assertEqual(query(manifest, "status")["conflictVersion"], status["conflictVersion"])

    def test_native_board_conflict_stages_share_one_index_snapshot(self):
        with tempfile.TemporaryDirectory(prefix="waffle-git-board-conflict-") as directory:
            root = Path(directory).resolve()
            project = root / "Design"
            project.mkdir()
            manifest = project / "Board.waffle"
            manifest.write_bytes(b'{"kind":"project","formatVersion":"2.0","id":"test-project","name":"Board"}\n'
                                 b'{"kind":"document","id":"pcb","docKind":"pcb","name":"Sensor board","path":"Sensor board.wpcb"}\n')
            board = project / "Sensor board.wpcb"
            unrelated = project / "Notes.md"

            def authored(end):
                board.write_bytes(
                    b'{"kind":"pcb","formatVersion":"2.0","id":"pcb"}\n'
                    b'{"kind":"track","id":"track","layer":"Top","net":"VCC","points":[[0,0],[' +
                    str(end).encode("ascii") + b',0]],"width":200000}\n')
                unrelated.write_text(str(end) + "\n")

            authored(1000000)
            copy = root / "Copy"
            shutil.copytree(project, copy)
            git(root, "init", "-b", "main")
            git(root, "add", ".")
            git(root, "commit", "-m", "Initial project")
            base = git(root, "rev-parse", "HEAD")
            project_key = query(manifest, "status")["projectKey"]
            self.assertNotEqual(query(copy / manifest.name, "status")["projectKey"], project_key)
            git(root, "switch", "-c", "change-copper")
            authored(3000000)
            git(root, "commit", "-am", "Theirs")
            theirs = git(root, "rev-parse", "HEAD")
            git(root, "switch", "main")
            (root / "README").write_text("Only documentation\n")
            git(root, "add", "README")
            git(root, "commit", "-m", "Documentation")
            notes = git(root, "rev-parse", "HEAD")
            authored(2000000)
            git(root, "commit", "-am", "Ours")
            with self.assertRaises(subprocess.CalledProcessError):
                git(root, "merge", "--no-edit", "change-copper")
            physical = snapshot(root)
            status = query(manifest, "status")
            self.assertEqual(status["projectKey"], project_key)
            self.assertEqual(status["mergeHead"], theirs)
            self.assertEqual(status["indexBlob"], status["headBlob"])
            self.assertEqual(status["worktreeBlob"], status["headBlob"])
            self.assertTrue(status["conflicted"])
            self.assertEqual(status["conflicts"], [{"path":"Sensor board.wpcb", "stages":["base", "ours", "theirs"]}])
            stages = query(manifest, "folderRevisions", {"stages":["base", "ours", "theirs"]})
            self.assertEqual([r["revision"] for r in stages["revisions"]], ["base", "ours", "theirs"])
            for side, end in zip(stages["revisions"], (1000000, 2000000, 3000000)):
                self.assertEqual(set(side["files"]), {manifest.name, board.name})
                raw = base64.b64decode(stages["objects"][side["files"][board.name]])
                self.assertEqual(json.loads(raw.splitlines()[1])["points"][1], [end, 0])
            first_parent = query(manifest, "projectLog", {"firstParent":True, "limit":2})
            self.assertEqual([c["subject"] for c in first_parent["commits"]], ["Ours", "Documentation"])
            earlier = query(manifest, "projectLog", {"firstParent":True, "skip":2, "snapshot":first_parent["snapshot"]})
            self.assertEqual([c["revision"] for c in earlier["commits"]], [base])
            blobs = query(manifest, "projectBlobs", {"revisions":[base, notes]})["blobs"]
            self.assertEqual(blobs[base], blobs[notes])
            with self.assertRaises(BaselineError):
                query(manifest, "folderRevisions", {"stages":["ours", "ours"]})
            self.assertEqual(snapshot(root), physical)

    def test_git_identities_are_lazy_scoped_and_deduplicated(self):
        f = self.fixture
        self.assertEqual(git(self.root, "rev-parse", f["base"] + ":Design/Sensor Board.waffle"),
                         git(self.root, "rev-parse", f["labels"] + ":Design/Sensor Board.waffle"))
        history = ProjectHistory(self.manifest)
        read = history.source_bytes
        reads = []

        def counted(oid, limit):
            reads.append(oid)
            return read(oid, limit)

        history.source_bytes = counted
        result = history.project_blobs({"revisions": [f["base"], f["labels"]]})["blobs"]
        self.assertNotEqual(result[f["base"]], result[f["labels"]])
        self.assertEqual(len(reads), 1, "Git metadata comparison opens only the shared manifest")
        pair = history.folder_revisions({"revisions": [f["base"], f["labels"]]})
        a, b = pair["revisions"]
        self.assertEqual(a["files"]["Reserve.wsch"], b["files"]["Reserve.wsch"])
        self.assertEqual(len(pair["objects"]), 4, "the pair transfers one shared manifest and sibling")
        self.assertEqual(len(reads), len(set(reads)), "the pair reads each shared Git blob once")
        small = query(self.manifest, "folderRevisions", {"revisions": [f["labels"]], "known": list(a["files"].values())})
        self.assertEqual(set(small["objects"]), {b["files"]["Power.wsch"]})
        self.assertTrue(all("Unrelated" not in file for r in pair["revisions"] for file in r["files"]))
        tree = query(self.manifest, "folderRevisions", {"stage": "index"})
        item = tree["revisions"][0]
        self.assertIn(b'"SIGNAL"', base64.b64decode(tree["objects"][item["files"]["Power.wsch"]]))
        unknown = query(self.manifest, "folderRevisions", {"revisions": [f["opaque"]]})
        item = unknown["revisions"][0]
        self.assertEqual(unknown["objects"][item["files"]["Signal View.wwave"]], f["future"])
        with self.assertRaisesRegex(ValueError, "unsupported Waffle"):
            query(self.manifest, "folderRevisions", {"revisions": [f["unsupported"]]})
        with self.assertRaisesRegex(BaselineError, "Missing required project member: Power"):
            query(self.manifest, "folderRevisions", {"revisions": [f["incomplete"]]})
        with self.assertRaisesRegex(BaselineError, "does not run"):
            query(self.manifest, "folderRevisions", {"revisions": [f["labels"]], "paths": ["Unrelated.wsch"]})

    def test_public_cli_compare_and_history(self):
        if sys.platform == "darwin" and SERVER == ROOT / "mcp/server.py":
            import sys as _test_sys
            from pathlib import Path as _TestPath
            _test_sys.path.insert(0, str((_TestPath(__file__).resolve().parent / "../support").resolve()))
            from native_sample import ensure_native_host
            ensure_native_host()
        using_host = "WAFFLE_FOLDER_MCP_HOST" in os.environ or sys.platform.startswith("linux")
        if not using_host:
            self.skipTest("Use the installed native read host with WAFFLE_FOLDER_MCP_HOST.")

        def cli(tool, **args):
            run = subprocess.run([sys.executable, str(SERVER), "--project", str(self.manifest),
                                  "--read-only", "--cli", tool, "--args", json.dumps(args)], capture_output=True,
                                 text=True, check=True, timeout=90)
            return json.loads(run.stdout)

        f = self.fixture
        report = cli("compare_git_head")
        self.assertEqual(report["commit"], f["merge"])
        self.assertNotEqual(report["base_file_revision"], report["file_revision"])
        self.assertTrue(any(row["document_id"] == "s1" and row["status"] == "Changed" for row in report["items"]), report)
        result = cli("project_history", limit=20)
        rows = {r["revision"]: r for r in result["commits"]}
        self.assertEqual(rows[f["merge"]]["parents"], [f["renamed"], f["labels"]])
        self.assertGreater(rows[f["labels"]]["total"], 0)
        self.assertNotEqual(rows[f["labels"]]["before_file_revision"], rows[f["labels"]]["after_file_revision"])
        self.assertNotIn("summary_error", rows[f["renamed"]]["untrusted_design_text"])
        self.assertEqual(rows[f["opaque"]]["total"], 0)
        self.assertNotEqual(rows[f["opaque"]]["before_file_revision"], rows[f["opaque"]]["after_file_revision"])
        self.assertIn("saved files changed", rows[f["opaque"]]["untrusted_design_text"]["summary"].lower())
        self.assertRegex(rows[f["incomplete"]]["untrusted_design_text"]["summary_error"], "Missing required project member")
        self.assertRegex(rows[f["unsupported"]]["untrusted_design_text"]["summary_error"], "unsupported Waffle")
        first = cli("project_history", limit=2)
        second = cli("project_history", limit=20, offset=first["next_offset"], snapshot=first["snapshot"])
        self.assertEqual([r["revision"] for r in result["commits"]],
                         [r["revision"] for r in first["commits"] + second["commits"]])


if __name__ == "__main__":
    if len(sys.argv) == 3 and sys.argv[1] == "--fixture":
        print(json.dumps(create_fixture(Path(sys.argv[2]).resolve())))
    else:
        unittest.main(verbosity=2)
