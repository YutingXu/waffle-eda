"""Check the public CLI/MCP diagnostic and native source/revision boundaries."""
import hashlib
import json
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import unittest
import zipfile

import sys as _test_sys
from pathlib import Path as _TestPath
_test_sys.path.insert(0, str((_TestPath(__file__).resolve().parent / "../support").resolve()))
from native_sample import ROOT, SAMPLE, authored_files, ensure_native_host, make_sample

SERVER = ROOT / "mcp/server.py"
CORPUS = ROOT / "tests/fixtures/compat"
NOTE = "This file is from a pre-release Waffle build; re-import the design from its source EDA"
CODE = "pre-release-format"


def cli(path, tool, args=None):
    return subprocess.run([sys.executable, "-B", str(SERVER), "--project", str(path), "--allow-write",
                           "--cli", tool, "--args", json.dumps(args or {})], capture_output=True, text=True, timeout=90)


def calls(path, tools):
    request = lambda id, method, params: {"jsonrpc": "2.0", "id": id, "method": method, "params": params}
    lines = [request(0, "initialize", {"protocolVersion": "2025-06-18"})]
    lines.extend(request(i, "tools/call", {"name": name, "arguments": args}) for i, (name, args) in enumerate(tools, 1))
    proc = subprocess.run([sys.executable, "-B", str(SERVER), "--allow-write", "--project", str(path)],
                          input="".join(json.dumps(row) + "\n" for row in lines), text=True, capture_output=True, timeout=90)
    assert proc.returncode == 0, proc.stderr
    replies = [json.loads(line) for line in proc.stdout.splitlines()]
    assert [row["id"] for row in replies] == list(range(len(lines))), replies
    return [row["result"] for row in replies[1:]]


def git(root, *args):
    return subprocess.run(["git", "-c", "user.name=Test", "-c", "user.email=test@example.invalid", *args],
                          cwd=root, capture_output=True, text=True, check=True).stdout.strip()


class Compatibility(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        ensure_native_host()

    def assert_refused(self, reply):
        self.assertTrue(reply["isError"], reply)
        self.assertEqual(reply["content"][0]["text"], NOTE)
        self.assertEqual(reply["structuredContent"]["error"], {"code": CODE, "message": NOTE, "retryable": False})

    def test_all_saved_previews_are_immutable_negative_inputs(self):
        entries = json.loads((CORPUS / "index.json").read_text())["projects"]
        hashes = json.loads((CORPUS / "guard.json").read_text())["files"]
        for entry in entries:
            with self.subTest(case=entry["file"]), tempfile.TemporaryDirectory() as tmp:
                root = Path(tmp)
                old = root / entry["file"]
                shutil.copyfile(CORPUS / "projects" / old.name, old)
                self.assertEqual(entry["expect"], CODE)
                self.assertEqual(hashlib.sha256(old.read_bytes()).hexdigest(), hashes[old.name])
                for suffix in (".journal", "~"):
                    old.with_name(old.name + suffix).write_bytes(b"ATRIUM-JOURNAL 1\nold saved bytes")
                before = authored_files(root)
                result = cli(old, "project_summary")
                self.assertNotEqual(result.returncode, 0)
                self.assertEqual(result.stderr.rstrip("\n"), NOTE)
                for reply in calls(old, [("list_documents", {}), ("move_component", {"component": "R1", "mode": "write"}),
                                         ("import_design", {"paths": [old.name]}), ("project_history", {})]):
                    self.assert_refused(reply)
                self.assertEqual(authored_files(root), before)

    def test_saved_proposals_and_sources_respect_the_bound_project(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            native = make_sample(root)
            old = root / "Previous.waffle"
            old.write_bytes((CORPUS / "projects/v1.4-schematic-canvas.waffle").read_bytes())
            proposal = root / "Previous.waffle-ai"
            proposal.write_text(json.dumps({"format": "atrium-ai", "version": 2, "ops": []}))
            before = authored_files(root)
            tools = [("apply_proposal", {"file": proposal.name}), ("apply_proposal", {"file": proposal.name, "mode": "write"}),
                     ("import_design", {"paths": [old.name]}), ("import_design", {"paths": [old.name], "target_format": "1.x"}),
                     ("export_design", {"translator": "legacy"}), ("diff_designs", {"before": old.name, "after": "saved"})]
            for reply in calls(native, tools):
                self.assert_refused(reply)
            catalog = json.loads(cli(native, "list_translators").stdout)
            self.assertNotIn("legacy", {entry["id"] for entry in catalog["translators"]})
            self.assertEqual(authored_files(root), before)
            self.assertEqual(list(root.glob("*-outputs")), [])

    def test_zip_with_obsolete_design_and_adjacent_journal(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            native = make_sample(root)
            old = (CORPUS / "projects/v1.4-schematic-canvas.waffle").read_bytes()
            zipped = root / "Old.zip"
            with zipfile.ZipFile(zipped, "w", zipfile.ZIP_DEFLATED) as archive:
                archive.writestr("Fixture/Old.waffle", old)
                archive.writestr("Fixture/Old.waffle.journal", b"ATRIUM-JOURNAL 1\nobsolete")
            before = authored_files(root)
            self.assertEqual(cli(zipped, "project_summary").stderr.rstrip("\n"), NOTE)
            self.assert_refused(calls(native, [("import_design", {"paths": [zipped.name]})])[0])
            self.assertEqual(authored_files(root), before)
            self.assertFalse((root / "Fixture").exists())

    def test_git_history_and_positional_comparison(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            native = root / "Board.waffle"
            git(root, "init", "-q")
            old = (CORPUS / "projects/v1.4-schematic-canvas.waffle").read_bytes()
            native.write_bytes(old)
            git(root, "add", native.name)
            git(root, "commit", "-qm", "Pre-release design")
            rejected = git(root, "rev-parse", "HEAD")
            make_sample(root)
            git(root, "add", ".")
            git(root, "commit", "-qm", "Native project")
            before = authored_files(root)
            saved = calls(native, [("compare_git_head", {}), ("diff_designs", {"before": "HEAD", "after": "saved"}),
                                   ("diff_designs", {"before": rejected}), ("project_history", {"limit": 8})])
            for reply in saved[:2]:
                self.assertFalse(reply["isError"], reply)
            self.assert_refused(saved[2])
            log = json.loads(saved[3]["content"][0]["text"])["commits"]
            self.assertTrue(any(row.get("error_code") == CODE and row["untrusted_design_text"]["summary_error"] == NOTE for row in log), log)
            cmd = [sys.executable, str(ROOT / "bin/waffle-diff"), str(native)]
            other = str(SAMPLE)
            result = subprocess.run(cmd + [other], capture_output=True, text=True, timeout=60)
            self.assertEqual(result.returncode, 0, result.stderr)
            with tempfile.TemporaryDirectory() as olddir:
                prior = Path(olddir) / native.name
                prior.write_bytes(old)
                result = subprocess.run(cmd + [str(prior)], capture_output=True, text=True, timeout=60)
                self.assertEqual((result.returncode, result.stderr.rstrip("\n")), (2, NOTE))
            self.assertEqual(authored_files(root), before)
            self.assertEqual(git(root, "status", "--porcelain"), "")


if __name__ == "__main__":
    unittest.main()
