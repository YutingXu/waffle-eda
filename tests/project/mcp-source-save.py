"""Exercise first Save As and foreign export through the public CLI and MCP transport."""
import hashlib
import json
import os
from pathlib import Path
import shutil
import signal
import subprocess
import sys
import tempfile
import time
import unittest
from xml.etree import ElementTree

import sys as _test_sys
from pathlib import Path as _TestPath
_test_sys.path.insert(0, str((_TestPath(__file__).resolve().parent / "../support").resolve()))
from native_sample import ROOT, ensure_native_host
from git_spy import GitSpy, git_tree

SERVER = ROOT / "mcp/server.py"
FIXTURES = ROOT / "tests/fixtures"
DESIGNS = [
    ("altium", "altium/signals-ascii/Signals.PcbDoc", ".pcbdoc"),
    ("kicad", "import/demo.kicad_pcb", ".kicad_pcb"),
    ("eagle", "import/demo-eagle.brd", ".brd"),
    ("easyeda", "import/demo-easyeda-pcb.json", ".json"),
    ("easyeda", "import/demo-easyeda.epro", ".epro"),
]


def digest(data):
    return hashlib.sha256(data).hexdigest()


def rpc(method, params, seq=None):
    message = {"jsonrpc": "2.0", "method": method, "params": params}
    if seq is not None:
        message["id"] = seq
    return json.dumps(message) + "\n"


class SourceSave(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        ensure_native_host()

    def setUp(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.root = Path(tmp.name).resolve()

    def source(self, relative):
        path = self.root / Path(relative).name
        shutil.copyfile(FIXTURES / relative, path)
        return path

    def command(self, source, flags=()):
        return [sys.executable, "-B", str(SERVER), "--project", str(source), *flags]

    def call(self, transport, source, args, *, flags=(), tool="import_design", error=False, cancel=False, env=None):
        command = self.command(source, flags)
        if transport == "cli":
            p = subprocess.run([*command, "--cli", tool, "--args", json.dumps(args)], capture_output=True,
                               text=True, timeout=90, stdin=subprocess.DEVNULL, env=env)
            if error:
                self.assertNotEqual(p.returncode, 0, p.stdout[:200])
                return p.stderr
            self.assertEqual(p.returncode, 0, p.stderr)
            return json.loads(p.stdout)
        wire = rpc("initialize", {"protocolVersion": "2025-11-25"}, 1)
        wire += rpc("tools/call", {"name": tool, "arguments": args}, 2)
        if cancel:
            wire += rpc("notifications/cancelled", {"requestId": 2, "reason": "Discard selection"})
        p = subprocess.run(command, input=wire, capture_output=True, text=True, timeout=90, env=env)
        self.assertEqual(p.returncode, 0, p.stderr)
        reply = json.loads(p.stdout.splitlines()[-1])["result"]
        self.assertEqual(reply["isError"], error, reply["content"][0]["text"][:300])
        if error:
            return reply["structuredContent"]["error"]
        return json.loads(reply["content"][0]["text"])

    def test_native_save_and_actual_foreign_writers(self):
        for vendor, fixture, suffix in DESIGNS:
            source = self.source(fixture)
            original = source.read_bytes()
            for transport in ("cli", "mcp"):
                with self.subTest(input=source.name, transport=transport):
                    prefix = source.name + "-" + transport
                    view = self.call(transport, source, {"mode": "preview"}, flags=["--read-only"])
                    self.assertIsNone(view["path"])
                    self.assertEqual(view["report"]["translator"], vendor)
                    self.assertNotIn("folder_provenance", view)
                    native = self.call(transport, source, {"target_format": "2.0", "destination": prefix + "-native"})
                    manifest = Path(native["path"])
                    self.assertEqual(manifest.parent, self.root / (prefix + "-native"))
                    self.assertEqual(native["retained_inputs"], 1)
                    self.assertEqual((manifest.parent / ".waffle/imports" / digest(original) / "source").read_bytes(), original)
                    summary = self.call(transport, manifest, {}, tool="project_summary", flags=["--read-only"])
                    self.assertEqual(summary["file_revision"], native["sha256"])
                    exchange = self.call(transport, source, {"mode": "export", "destination": prefix + "-exchange"})
                    self.assertEqual((exchange["format"], exchange["report"]["direction"]), (vendor, "export"))
                    self.assertEqual(set(exchange["summary"]), {"kept", "converted", "lost"})
                    self.assertTrue(any(exchange["summary"].values()))
                    self.assertEqual(exchange["import_report"]["translator"], vendor)
                    self.assertTrue(any(f["name"].lower().endswith(suffix) for f in exchange["files"]), exchange["files"])
                    if vendor == "easyeda":
                        expected = "pro" if suffix == ".epro" else "standard"
                        self.assertEqual(exchange["details"]["edition"], expected)
                        reopened = self.call(transport, manifest, {"translator": "easyeda", "options": {"scope": "project"},
                                             "output_dir": "Exchange"}, tool="export_design")
                        self.assertEqual(reopened["details"]["edition"], expected)
                    if len(exchange["files"]) == 1:
                        selected = prefix + "-named" + suffix
                        named = self.call(transport, source, {"destination": selected}, tool="export_design")
                        self.assertEqual(Path(named["path"]), self.root / selected)
                        self.assertTrue(Path(named["path"]).is_file())
                        self.assertEqual(named["files"][0]["name"], selected)
                        self.assertEqual(digest(Path(named["path"]).read_bytes()), named["files"][0]["sha256"])
                    for f in exchange["files"]:
                        output = self.root / (prefix + "-exchange") / f["name"]
                        self.assertEqual(Path(f["path"]), output)
                        self.assertEqual(digest(output.read_bytes()), f["sha256"])
                    self.assertEqual(source.read_bytes(), original)

    def test_choice_authority_collisions_and_cancellation(self):
        source = self.source("import/demo.kicad_pcb")
        neighbor = self.source("import/child.kicad_sch")
        picked = self.root / "Existing"
        picked.mkdir()
        (picked / "keep").write_bytes(b"existing")
        alias = self.root / "Alias"
        try:
            alias.symlink_to(picked, target_is_directory=True)
        except OSError:
            if os.name != "nt": raise
        alias_file = self.root / "Other.kicad_pcb"
        os.link(source, alias_file)
        original = {p.name: p.read_bytes() for p in (source, neighbor)}
        initial = set(self.root.iterdir())
        for transport in ("cli", "mcp"):
            failures = [({}, "Choose mode"), ({"mode": "export"}, "destination"),
                        ({"mode": "preview", "destination": "discard"}, "Preview"),
                        ({"mode": "export", "target_format": "2.0", "destination": "discard"}, "different actions"),
                        ({"mode": "export", "destination": "Existing"}, "exists"),
                        ({"mode": "save-as", "destination": "Existing"}, "exists"),
                        ({"mode": "export", "destination": source.name}, "separate"),
                        ({"mode": "export", "destination": alias_file.name}, "separate"),
                        ({"mode": "export", "destination": "../Outside"}, "path"),
                        ({"mode": "preview", "paths": [source.name, neighbor.name]}, "--source-file")]
            if alias.is_symlink():
                failures.append(({"mode": "export", "destination": "Alias/Outside"}, "link"))
            for args, match in failures:
                with self.subTest(transport=transport, args=args):
                    failure = self.call(transport, source, args, error=True)
                    self.assertIn(match, failure if isinstance(failure, str) else failure["message"])
            for mode in ("save-as", "export"):
                self.call(transport, source, {"mode": mode, "destination": "Discarded"}, flags=["--read-only"], error=True)
            self.call(transport, source, {"mode": "write"}, tool="run_command", error=True)
        cancelled = self.call("mcp", source, {"mode": "save-as", "destination": "Cancelled"}, error=True, cancel=True)
        self.assertEqual(cancelled["code"], "cancelled")
        self.assertIn("without --allow-write", self.call("cli", source, {"mode": "preview"}, flags=["--allow-write"], error=True))
        self.assertEqual(initial, set(self.root.iterdir()))
        self.assertEqual((picked / "keep").read_bytes(), b"existing")
        self.assertEqual(original, {p.name: p.read_bytes() for p in (source, neighbor)})
        view = self.call("mcp", source, {"mode": "preview", "paths": [neighbor.name, source.name]}, flags=["--source-file", neighbor.name])
        self.assertEqual({f["name"] for f in view["provenance"]["files"]}, {source.name, neighbor.name})
        self.assertEqual(view["report"]["translator"], "kicad")
        self.call("cli", source, {"mode": "preview", "translator": "eagle"}, error=True)
        a = self.call("mcp", source, {"mode": "save-as"})
        b = self.call("cli", source, {"target_format": "2.0"})
        self.assertEqual(Path(b["path"]).parent.name, Path(a["path"]).parent.name + " (2)")
        for transport in ("cli", "mcp"):
            exchange = self.call(transport, source, {"translator": "altium", "destination": "Explicit Altium " + transport}, tool="export_design")
            self.assertEqual(exchange["report"]["translator"], "altium")
            self.call(transport, source, {}, tool="export_design", error=True)

    @unittest.skipIf(os.name == "nt", "The Git process spy uses a POSIX executable script.")
    def test_tracked_input_save_and_native_write_never_access_git(self):
        source = self.source("import/child.kicad_sch")
        repo = self.root / "repo"
        repo.mkdir()
        chosen = source.rename(repo / source.name)
        spy = GitSpy(self.root)
        spy.initialize(repo)
        # Git contains a different committed version. Save As uses the selected bytes.
        selected = chosen.read_bytes().replace(b'"IN"', b'"EDITED_SOURCE"')
        self.assertIn(b'"EDITED_SOURCE"', selected)
        chosen.write_bytes(selected)
        metadata = git_tree(repo)
        spy.phase("save")
        for transport in ("cli", "mcp"):
            with self.subTest(transport=transport):
                native = self.call(transport, chosen, {"mode": "save-as", "destination": transport + "-native"}, env=spy.child_env)
                project = Path(native["path"])
                copied = project.parent / ".waffle/imports" / digest(selected) / "source"
                self.assertEqual(copied.read_bytes(), selected)
                sheet = [d["id"] for d in native["documents"] if d["kind"] == "schematic"][0]
                write = self.call(transport, project, {"sheet": sheet, "text": "GIT_INDEPENDENT", "x": 50,
                                   "y": 55, "mode": "write"}, tool="add_net_label", flags=["--allow-write"], env=spy.child_env)
                self.assertEqual(len(write["files"]), 1, write)
                owner, = write["files"]
                self.assertTrue(owner.endswith(".wsch"), owner)
                self.assertIn(b'"GIT_INDEPENDENT"', (project.parent / owner).read_bytes())
                self.assertEqual(chosen.read_bytes(), selected)
                self.assertEqual(git_tree(repo), metadata)
                self.assertEqual(spy.calls("save"), [])

    def test_original_dependent_eagle_output_uses_verified_bytes(self):
        source = self.source("import/demo-eagle.brd")
        markup = b"<board><description>Connector &amp; field wiring</description>"
        original = source.read_bytes().replace(b"<board>", markup, 1)
        self.assertIn(markup, original)
        for transport in ("cli", "mcp"):
            source.write_bytes(original)
            if transport == "mcp":
                subprocess.run(["git", "init", "-q", str(self.root)], check=True)
                git = ["git", "-C", str(self.root), "-c", "user.name=Test", "-c", "user.email=test@example.invalid", "-c", "commit.gpgsign=false"]
                subprocess.run([*git, "add", "--", source.name], check=True)
                subprocess.run([*git, "commit", "-qm", "Verified EAGLE source"], check=True)
            fresh = self.call(transport, source, {"destination": transport + ".brd"}, tool="export_design")
            native = self.call(transport, source, {"mode": "save-as", "destination": transport + "-native"})
            local_copy = Path(native["path"]).parent / ".waffle/imports" / digest(original) / "source"
            self.assertEqual(local_copy.read_bytes(), original)
            source.write_bytes(original.replace(b"Connector", b"CHANGED"))
            board = next(d["id"] for d in native["documents"] if d["kind"] == "pcb")
            reopened = self.call(transport, Path(native["path"]), {"translator": "eagle", "document_id": board,
                                 "options": {"scope": "document"}, "output_dir": "Exchange"}, tool="export_design")
            for result in (fresh, reopened):
                output = next(f for f in result["files"] if f["name"].endswith(".brd"))
                root = ElementTree.parse(output["path"])
                self.assertEqual(root.findtext("./drawing/board/description"), "Connector & field wiring")
                row = next(r for r in result["report"]["kinds"] if r["kind"] == "Original EAGLE description")
                self.assertEqual(row["kept"], 1)
            self.assertIn(b"CHANGED", source.read_bytes())

    def test_schematic_image_requires_explicit_matching_companion(self):
        assets = FIXTURES / "format-2/notebook/assets"
        image = next(p.read_bytes() for p in assets.iterdir() if p.read_bytes().startswith(b"\x89PNG\r\n"))
        companion = self.root / ("notebook-" + digest(image) + ".png")
        companion.write_bytes(image)
        sheet = self.root / "Images.SchDoc"
        sheet.write_text("|HEADER=Protel for Windows - Schematic Capture Ascii File Version 5.0\n|RECORD=31\n"
                         "|RECORD=30|LOCATION.X=0|LOCATION.Y=0|CORNER.X=60|CORNER.Y=40|FILENAME=" + companion.name + "\n")
        view = self.call("mcp", sheet, {"mode": "preview"}, flags=["--source-file", companion.name])
        row = next(row for row in view["report"]["kinds"] if row["kind"] == "Schematic PNG companion")
        self.assertEqual(row["kept"], 1)
        companion.write_bytes(image + b"changed")
        message = self.call("cli", sheet, {"mode": "save-as"}, flags=["--source-file", companion.name], error=True)
        self.assertIn("does not match its name", message)
        self.assertEqual(set(self.root.iterdir()), {sheet, companion})

    def test_cancellable_worker_finishes_a_slow_input_transfer(self):
        from board_runner import _run_child
        from threading import Event
        body = b"x" * (2 << 20)
        reader = "import json,sys,time; time.sleep(.35); print(json.dumps({'received':len(sys.stdin.buffer.read())}))"
        out = _run_child([sys.executable, "-c", reader], (body,), 2, task="translation", cancel_event=Event())
        self.assertEqual(json.loads(out)["received"], 12 + len(body))

    def test_mixed_easyeda_editions_require_a_choice(self):
        standard = self.source("import/demo-easyeda-pcb.json")
        pro = self.source("import/demo-easyeda.epro")
        flags = ["--source-file", pro.name]
        args = {"mode": "export", "destination": "Transfer"}
        error = self.call("mcp", standard, args, flags=flags, error=True)
        self.assertIn("Standard or Pro", error["message"])
        self.assertEqual(set(self.root.iterdir()), {standard, pro})
        for transport, edition in (("cli", "standard"), ("mcp", "pro")):
            result = self.call(transport, standard, dict(args, edition=edition, destination=edition), flags=flags)
            self.assertEqual(result["details"]["edition"], edition)

    @unittest.skipUnless(os.name == "posix", "SIGINT child-process test uses POSIX process inspection")
    def test_interrupt_during_real_translation(self):
        source = self.root / "Large.kicad_pcb"
        track = '(segment (start 1 2) (end 7 2) (width 0.2) (layer "F.Cu") (net 0))\n'
        source.write_text("(kicad_pcb (version 20240108) (generator pcbnew)\n" + track * 15000 + ")")
        original = source.read_bytes()
        for transport in ("cli", "mcp"):
            command = self.command(source)
            if transport == "cli":
                command += ["--cli", "import_design", "--args", '{"mode":"save-as"}']
            p = subprocess.Popen(command, text=True, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
            try:
                if transport == "mcp":
                    p.stdin.write(rpc("initialize", {"protocolVersion": "2025-11-25"}, 1))
                    p.stdin.flush()
                    self.assertEqual(json.loads(p.stdout.readline())["id"], 1)
                    p.stdin.write(rpc("tools/call", {"name": "import_design", "arguments": {"mode": "save-as"}}, 2))
                    p.stdin.flush()
                deadline = time.monotonic() + 10
                while time.monotonic() < deadline and p.poll() is None:
                    children = Path(f"/proc/{p.pid}/task/{p.pid}/children")
                    spawned = bool(children.read_text().strip()) if children.exists() else subprocess.run(
                        ["pgrep", "-P", str(p.pid)], stdout=subprocess.DEVNULL).returncode == 0
                    if spawned:
                        break
                    time.sleep(0.02)
                else:
                    self.fail("Did not observe the real translation worker")
                if transport == "cli":
                    p.send_signal(signal.SIGINT)
                    p.communicate(timeout=10)
                    self.assertEqual(p.returncode, 130)
                else:
                    out, err = p.communicate(rpc("notifications/cancelled", {"requestId": 2}), timeout=10)
                    self.assertEqual(p.returncode, 0, err)
                    self.assertEqual(json.loads(out)["result"]["structuredContent"]["error"]["code"], "cancelled")
            finally:
                if p.poll() is None:
                    p.kill()
                    p.communicate()
        self.assertEqual(set(self.root.iterdir()), {source})
        self.assertEqual(source.read_bytes(), original)


if __name__ == "__main__":
    unittest.main()
