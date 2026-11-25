"""Exercise the real CLI and MCP stdio server against native saved projects."""
import base64
from concurrent.futures import ThreadPoolExecutor
import gzip
import hashlib
import json
import os
from pathlib import Path
import shutil
import struct
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch
import zipfile
import zlib


ROOT = Path(__file__).resolve().parents[2]
SERVER = Path(os.environ.get("WAFFLE_MCP_SERVER", ROOT / "mcp/server.py")).resolve()
SOURCE = Path(os.environ.get("WAFFLE_MCP_SAMPLE", ROOT / "mcp/examples/sensor-interface/Board.waffle")).resolve()
PACKAGE = SERVER.parents[1]


def digest(data):
    return hashlib.sha256(data).hexdigest()


def saved_tree_state(root):
    # File reads may update atime. Changes to identity, permissions, size or
    # write-related timestamps still detect replacement or a write of the same bytes.
    state = {}
    for path in (root, *root.rglob("*")):
        details = path.stat()
        state[path.relative_to(root).as_posix()] = (
            details.st_ino, details.st_mode, details.st_size, details.st_mtime_ns, details.st_ctime_ns,
            digest(path.read_bytes()) if path.is_file() else None,
        )
    return state


def command(project, access):
    return [sys.executable, str(SERVER), "--project", str(project), *([access] if access else [])]


def node_preload(*modules):
    # Use the same module graph for either the source server or WAFFLE_MCP_SERVER.
    with patch.object(sys, "path", [str(SERVER.parent), *sys.path]):
        from board_runner import resolve
    return "\n".join(f"require({json.dumps(str(path))});" for _, path in resolve(modules))


class MCP:
    def __init__(self, project, env, access="--read-only", flags=()):
        self.process = subprocess.Popen([*command(project, access), *flags], env=env, text=True,
                                        stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        self.seq = 0

    def __enter__(self):
        self.call("initialize", {"protocolVersion": "2025-11-25"})
        return self

    def __exit__(self, *_):
        self.process.stdin.close()
        self.process.wait(timeout=15)
        self.process.stdout.close()
        self.process.stderr.close()

    def call(self, method, payload):
        self.seq += 1
        self.process.stdin.write(json.dumps({"jsonrpc": "2.0", "id": self.seq, "method": method, "params": payload}) + "\n")
        self.process.stdin.flush()
        reply = json.loads(self.process.stdout.readline())
        assert reply["id"] == self.seq, reply
        return reply["result"]

    def tool(self, tool, args=None, error=None):
        reply = self.call("tools/call", {"name": tool, "arguments": args or {}})
        if error:
            assert reply["isError"] and reply["structuredContent"]["error"]["code"] == error, reply
            return reply["structuredContent"]["error"]
        assert not reply["isError"], reply
        return json.loads(reply["content"][0]["text"])


class FolderTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.scratch = tempfile.TemporaryDirectory(prefix="waffle-format2-mcp-tests-")
        cls.addClassCleanup(cls.scratch.cleanup)
        cls.temp = Path(cls.scratch.name).resolve()
        cls.env = os.environ.copy()
        cls.fault_host = sys.platform == "darwin" and SERVER == ROOT / "mcp/server.py" and "WAFFLE_FOLDER_MCP_HOST" not in cls.env
        if cls.fault_host:
            helper = cls.temp / "Folder MCP Host"
            subprocess.run(["xcrun", "swiftc", "-swift-version", "5", str(ROOT / "native/macos/FolderTransactions.swift"),
                            str(ROOT / "native/tests/folder-transaction/mcp-main.swift"), "-o", str(helper)], check=True)
            cls.env["WAFFLE_FOLDER_MCP_HOST"] = str(helper)
        elif not (PACKAGE / "native/linux/folder_project.py").is_file() and SERVER == ROOT / "mcp/server.py" and "WAFFLE_FOLDER_MCP_HOST" not in cls.env:
            raise unittest.SkipTest("Use the built native folder runtime.")
        cls.reference = shutil.copytree(SOURCE.parent, cls.temp / "native sample")
        cls.manifest = cls.reference / SOURCE.name
        cls.sample_digest = cls.cli(cls.manifest, "project_summary")["file_revision"]
        cls.board = next(cls.reference.glob("*.wpcb")).name
        cls.sheet = next(cls.reference.glob("*.wsch")).name

    @classmethod
    def cli(cls, project, tool, args=None, access=None, env=None, expected=0, output_root=None):
        cmd = command(project, access) + (["--output-root", str(output_root)] if output_root else []) + ["--cli", tool, "--args", json.dumps(args or {})]
        result = subprocess.run(cmd, env=env or cls.env, text=True, capture_output=True, timeout=60)
        assert result.returncode == expected, (tool, result.stdout, result.stderr)
        return result.stderr if expected else json.loads(result.stdout)

    def copy(self):
        target = self.temp / self._testMethodName
        return shutil.copytree(self.reference, target)

    def authored(self, root):
        return {path.relative_to(root).as_posix(): digest(path.read_bytes()) for path in root.rglob("*") if path.is_file() and
                not path.relative_to(root).as_posix().startswith((".waffle/journal/", ".waffle/local/")) and path.suffix != ".waffle-ai"}

    def test_rebind_link_retains_exact_nested_native_extension(self):
        fixtures = ROOT / "tests/fixtures"
        links = fixtures / "butter-acceptance/links"
        table = fixtures / "format-2/butter-table-query"
        opaque = b',"x-opaque":9.1987e65'
        for has_table in (False, True):
            with self.subTest(has_table=has_table):
                folder = shutil.copytree(links, self.temp / f"link-opaque-{has_table}")
                manifest = folder / "Link Board.waffle"
                head, doc, link = manifest.read_bytes().splitlines(keepends=True)
                record = json.loads(link)
                project_id = record["value"]["target"]["projectId"]
                prior, other = record["value"]["target"]["objectId"], record["value"]["source"]["objectId"]
                extra = b""
                if has_table:
                    head = head.replace(b'"requires":[]', b'"requires":["notebook.table.v1"]')
                    extra = (table / "Table and Query.waffle").read_bytes().splitlines(keepends=True)[1]
                    shutil.copyfile(table / "Parts.wsch", folder / "Parts.wsch")
                extended = link.replace(b'"projectId":"' + project_id.encode() + b'"',
                                        b'"projectId":"' + project_id.encode() + b'"' + opaque)
                self.assertIn(opaque, extended)
                manifest.write_bytes(head + doc + extended + extra)
                before = self.authored(folder)
                flags = ("--enable-butter", "links")
                url = f"waffle://{project_id}/{other}"
                request = {"command": "butter.links.rebind", "mode": "write",
                           "args": {"recordId": record["id"], "url": url}}
                with MCP(manifest, self.env, "--allow-write", flags) as transport:
                    if not has_table:
                        reply = transport.call("tools/call", {"name":"run_command", "arguments":request})
                        self.assertTrue(reply["isError"])
                        self.assertIn("compatible Waffle", reply["content"][0]["text"])
                        self.assertEqual(self.authored(folder), before)
                        continue
                    result = transport.tool("run_command", request)
                    self.assertEqual(result["changes"], 1)
                expected = extended.replace(b'"objectId":"' + prior.encode() + b'"', b'"objectId":"' + other.encode() + b'"')
                self.assertEqual(manifest.read_bytes(), head + doc + expected + extra)
                self.assertEqual({name for name, sha in self.authored(folder).items() if sha != before.get(name)}, {manifest.name})
                with MCP(manifest, self.env, flags=flags) as transport:
                    listed = transport.tool("run_command", {"command": "butter.links.list", "args": {}})
                    saved, = listed["untrusted_design_text"]["rows"]
                    self.assertEqual((saved["id"], saved["target"]["objectId"]), (record["id"], other))

    def test_durable_fabrication_preset_rule_read_and_export(self):
        fixture = ROOT / "tests/fixtures/format-2/durable-preset"
        folder = shutil.copytree(fixture, self.temp / self._testMethodName)
        manifest = folder / "Durable Preset.waffle"
        before = saved_tree_state(folder)
        rows = list(map(json.loads, manifest.read_bytes().splitlines()))
        board = next(row for row in rows if row["kind"] == "document")
        clearance = next(row for row in rows if row["kind"] == "rule" and
                         row["value"].get("presetKey") == "fp-jlcpcb-2l-clearance")
        with MCP(manifest, self.env) as connection:
            reply = connection.tool("get_rule", {"document_id": board["id"], "rule_id": clearance["id"]})
            self.assertEqual(reply["rule"]["id"], clearance["id"])
            self.assertEqual(reply["rule"]["presetKey"], clearance["value"]["presetKey"])
        outputs = self.temp / "durable-preset-exports"
        outputs.mkdir()
        report = self.cli(manifest, "export_design", {"translator": "kicad", "document_id": board["id"],
                                                       "options": {"scope": "document"}}, output_root=outputs)
        exported = next(Path(row["path"]) for row in report["files"] if row["path"].endswith(".kicad_pcb"))
        self.assertIn(b"(segment", exported.read_bytes())
        self.assertEqual(saved_tree_state(folder), before)

    def test_current_notebook_assets_and_saved_checks(self):
        fixture = ROOT / "tests/fixtures/format-2/notebook"
        folder = shutil.copytree(fixture, self.temp / "saved notebook")
        before = self.authored(folder)
        owner = folder / "Notebook.wsch"
        rows = list(map(json.loads, owner.read_bytes().splitlines()))
        for row in rows:
            if row["kind"] == "image":
                ref = row["asset"]
                raw = (folder / "assets" / ref["sha256"]).read_bytes()
                self.assertEqual((len(raw), digest(raw)), (ref["byteLength"], ref["sha256"]))
        index = json.loads((fixture.parent / "projects.json").read_bytes())
        locked = next(row for row in index if row["directory"] == fixture.name)
        with MCP(folder, self.env) as connection:
            self.assertEqual(connection.tool("project_summary")["file_revision"], locked["sha256"])
            self.assertTrue(connection.tool("list_notebook")["total"])
            self.assertIn("counts", connection.tool("run_erc", {"limit": 0}))
        self.assertEqual(self.authored(folder), before)

    def test_locked_folder_versions_and_unchanged_refusals(self):
        fixture = ROOT / "tests/fixtures/format-2"
        cases = json.loads((fixture / "projects.json").read_text())
        for case in cases:
            with self.subTest(directory=case["directory"]):
                p = shutil.copytree(fixture / case["directory"], self.temp / ("locked-" + case["directory"]))
                manifest = p / case["manifest"]
                opened = saved_tree_state(p)
                self.assertEqual(self.cli(manifest, "project_summary", access="--read-only")["file_revision"], case["sha256"])
                self.assertEqual(saved_tree_state(p), opened)
                before = self.authored(p)
                with MCP(manifest, self.env) as transport:
                    listed = transport.tool("list_documents")
                    if case["directory"] == "workshop":
                        self.assertEqual([d["kind"] for d in listed["documents"]],
                                         ["schematic", "schematic", "pcb", "drawing", "panel"])
                        self.assertEqual(transport.tool("list_components", {"document_id": "board"})["total"], 1)
                    if case["directory"] == "future":
                        self.assertTrue(any(d["kind"] == "waveform" and d["read_only"] for d in listed["documents"]))
                    self.assertEqual(transport.tool("project_summary")["file_revision"], case["sha256"])
                self.assertEqual(saved_tree_state(p), opened)
                self.assertEqual(self.authored(p), before)
                self.assertFalse((p / ".waffle/journal").exists())
                if case["directory"] == "workshop":
                    self.cli(manifest, "move_component", {"component": "probe", "dx": 0.5, "mode": "write"}, "--allow-write")
                    changed = self.authored(p)
                    self.assertEqual({name for name in changed.keys() | before.keys() if changed.get(name) != before.get(name)}, {"Board.wpcb"})
                if case["directory"] == "future":
                    proposal = "future-label.waffle-ai"
                    shutil.copyfile(fixture / proposal, p / proposal)
                    owner = p / "Logic.wsch"
                    original = owner.read_bytes()
                    metadata = json.loads((p / proposal).read_text())
                    ledger = json.loads((fixture / "apricot-rule-scope-freeze.json").read_bytes())["files"]
                    freeze = ledger[(fixture / case["directory"] / case["manifest"]).relative_to(ROOT).as_posix()]
                    self.assertEqual(metadata["source_sha256"], freeze["beforeClosure"])
                    self.assertEqual(metadata["format2_base"]["manifest_sha256"], freeze["beforeManifest"])
                    with MCP(manifest, self.env, "--allow-write") as transport:
                        transport.tool("apply_proposal", {"file": proposal}, error="stale_source")
                    self.assertEqual(self.authored(p), before)
                    self.assertFalse((p / ".waffle/journal").exists())

                    # Review the same single-record edit against the separately frozen post-change base.
                    self.assertEqual(case["sha256"], freeze["afterClosure"])
                    self.assertEqual(digest(manifest.read_bytes()), freeze["afterManifest"])
                    metadata["source_sha256"] = freeze["afterClosure"]
                    metadata["format2_base"]["manifest_sha256"] = freeze["afterManifest"]
                    proposal = "current-label.waffle-ai"
                    (p / proposal).write_text(json.dumps(metadata))
                    metadata["ops"] = [{"op": "set", "target": "project", "path": ["atriumCompat"], "after": {"newer": "99.0"}}]
                    forged = p / "reader-mode.waffle-ai"
                    forged.write_text(json.dumps(metadata))
                    message = self.cli(manifest, "apply_proposal", {"file": forged.name}, "--allow-write", expected=1)
                    self.assertIn("protected field", message)
                    with MCP(manifest, self.env, "--allow-write") as transport:
                        transport.tool("add_net_label", {"sheet": "fw", "x": 1, "y": 2, "text": "OTHER", "mode": "write"},
                                       error="read_only_revision")
                        self.assertEqual(self.authored(p), before)
                        self.assertFalse((p / ".waffle/journal").exists())
                        review = transport.tool("apply_proposal", {"file": proposal})
                        wrote = transport.tool("apply_proposal", {"file": proposal, "mode": "write",
                            "proposal_sha256": review["proposal_sha256"], "source_sha256": review["source_sha256"]})
                        self.assertEqual(list(wrote["files"]), [owner.name])
                    self.assertEqual(owner.read_bytes(), original.replace(b'"text":"SENSE"', b'"text":"SENSE2"'))
                    changed = self.authored(p)
                    self.assertEqual({name for name in changed.keys() | before.keys() if changed.get(name) != before.get(name)}, {owner.name})
                    self.assertNotEqual(self.cli(manifest, "project_summary")["file_revision"], case["sha256"])
                    # Use a fresh copy for the refusal so generated history from the successful write
                    # cannot obscure a journal or proposal accidentally created by a rejected write.
                    p = shutil.copytree(fixture / case["directory"], self.temp / "locked-refusal")
                    manifest = p / case["manifest"]
                    # The manifest now advertises an unknown mandatory feature. Read and write
                    # requests must fail before journaling, creating a proposal, or touching a source.
                    first, body = manifest.read_bytes().split(b"\n", 1)
                    manifest.write_bytes(first[:-1] + b',"requires":["future-constraint"]}\n' + body)
                    untouched = self.authored(p)
                    args = {"sheet": "fs", "x": 1, "y": 2, "text": "OTHER", "mode": "write"}
                    message = self.cli(manifest, "add_net_label", args, "--allow-write", expected=1)
                    self.assertIn("Unsupported required feature", message)
                    self.assertEqual(self.authored(p), untouched)
                    self.assertFalse((p / ".waffle/local/mcp").exists())
                    self.assertFalse((p / ".waffle/journal").exists())

    def test_format_negotiation_reports_and_preserves_owners(self):
        fixture = ROOT / "tests/fixtures/format-2/golden"
        token = "future-constraint"
        expected = {"token": token, "minimumReaderVersion": "2.4"}
        args = {"sheet": "s1", "x": 1, "y": 2, "text": "EXTRA"}
        for target, kind in (("Sensor Board.waffle", "project"), ("Power.wsch", "schematic")):
            with self.subTest(owner=kind):
                folder = shutil.copytree(fixture, self.temp / ("required-" + kind))
                manifest = folder / "Sensor Board.waffle"
                owner = folder / target
                first, body = owner.read_bytes().split(b"\n", 1)
                header = json.loads(first)
                header.update(requires=[token], readerRequires={token: "2.4"})
                ordered = {key: header[key] for key in ("kind", "formatVersion", "id")}
                ordered.update((key, header[key]) for key in sorted(header.keys() - ordered.keys()))
                owner.write_bytes(json.dumps(ordered, separators=(",", ":")).encode() + b"\n" + body)
                before = saved_tree_state(folder)
                summary = self.cli(manifest, "project_summary", access="--read-only")
                diagnostic, = summary["format_diagnostics"]
                self.assertEqual(diagnostic["owner"]["kind"], kind)
                self.assertEqual(diagnostic["version"], "2.0")
                self.assertEqual(diagnostic["features"], [expected])
                self.assertIn("reader supporting native format 2.4", diagnostic["message"])
                with MCP(manifest, self.env, "--allow-write") as transport:
                    self.assertEqual(transport.tool("project_summary")["format_diagnostics"], [diagnostic])
                    for mode in ({}, {"mode": "write"}):
                        err = transport.tool("add_net_label", {**args, **mode}, error="read_only_format")
                        self.assertEqual(err["message"], diagnostic["message"])
                failure = self.cli(manifest, "add_net_label", {**args, "mode": "write"}, "--allow-write", expected=1)
                self.assertIn(diagnostic["message"], failure)
                self.assertEqual(saved_tree_state(folder), before)

        # A same-version optional record can use syntax outside this reader's
        # authored vocabulary. Preserve its exact bytes and physical delimiter.
        folder = shutil.copytree(fixture, self.temp / "optional-record")
        manifest = folder / "Sensor Board.waffle"
        owner = folder / "Power.wsch"
        optional = b'{"kind":"futureTrace","id":"z-future","data":{"gain":1.23000e-7}}\r\n'
        owner.write_bytes(owner.read_bytes() + optional)
        before = saved_tree_state(folder)
        self.assertNotIn("format_diagnostics", self.cli(manifest, "project_summary", access="--read-only"))
        self.assertEqual(saved_tree_state(folder), before)
        committed = self.cli(manifest, "add_net_label", {**args, "mode": "write"}, "--allow-write")
        self.assertEqual(list(committed["files"]), [owner.name])
        self.assertIn(optional, owner.read_bytes())
        self.assertEqual(manifest.read_bytes(), (fixture / manifest.name).read_bytes())

    def test_embedded_extension_survives_native_label_edit(self):
        fixture = ROOT / "tests/fixtures/format-2/extension"
        p = shutil.copytree(fixture, self.temp / "embedded-extension-edit")
        manifest = p / "Calibration.waffle"
        before = self.authored(p)
        with MCP(manifest, self.env, "--allow-write") as transport:
            self.assertEqual(transport.tool("project_summary")["file_revision"],
                             "0f919442614c2605b8f1302f2c68449801ae968102b73ccacb8bd0949b299870")
            result = transport.tool("add_net_label", {"sheet": "es", "x": 1, "y": 2, "text": "CAL", "mode": "write"})
            self.assertEqual(list(result["files"]), ["Input.wsch"])
        self.assertEqual(manifest.read_bytes(), (fixture / manifest.name).read_bytes())
        changed = self.authored(p)
        self.assertEqual({name for name in changed.keys() | before.keys() if changed.get(name) != before.get(name)}, {"Input.wsch"})
        self.assertIn(b'"text":"CAL"', (p / "Input.wsch").read_bytes())

    def test_mixed_instrument_scoped_native_save_and_precision(self):
        fixture = ROOT / "tests/fixtures/format-2/instrument"
        p = shutil.copytree(fixture, self.temp / "mixed-instrument")
        manifest = p / "Instrument.waffle"
        before = self.authored(p)
        self.assertEqual(len(before), 14)
        # Independent framing oracle over the exact tracked closure.
        body = manifest.read_bytes()
        names = sorted(name for name in before if name not in {manifest.name, ".waffle/.gitignore"})
        framed = hashlib.sha256(b"WAFFLE-PROJECT-V1\0" + struct.pack(">Q", len(body)) + body + struct.pack(">Q", len(names)))
        for name in names:
            encoded = name.encode()
            framed.update(struct.pack(">I", len(encoded)) + encoded + bytes.fromhex(before[name]))
        version = "6079a174015d0392a30cfb55e0dbb8d6f17e33eab740ba5850c5857998febf87"
        self.assertEqual(framed.hexdigest(), version)
        model, = (p / "models").glob("*.step.gz")
        self.assertEqual(gzip.decompress(model.read_bytes()), (ROOT / "tests/fixtures/mcad/tray.step").read_bytes())

        image = p / "assets/b0cd3b437c58b45918073df96986ae75213cef687faa75378cf3e54a3b8aa654"
        png = image.read_bytes()
        self.assertEqual(png[:8], b"\x89PNG\r\n\x1a\n")
        chunks, pos = {}, 8
        while pos < len(png):
            length, kind = struct.unpack_from(">I4s", png, pos)
            content = png[pos+8:pos+8+length]
            self.assertEqual(struct.unpack_from(">I", png, pos+8+length)[0], zlib.crc32(kind+content))
            chunks[kind] = content
            pos += length+12
        self.assertEqual(pos, len(png))
        self.assertEqual(struct.unpack(">IIBBBBB", chunks[b"IHDR"]), (2, 2, 8, 6, 0, 0, 0))
        self.assertEqual(zlib.decompress(chunks[b"IDAT"]), bytes.fromhex("00143e5cff63c7b2ff00e4b564ffffffff00"))
        self.assertEqual(chunks[b"IEND"], b"")

        outputs = self.temp / "mixed-native-exports"
        outputs.mkdir()
        with MCP(manifest, self.env, "--allow-write") as transport:
            docs = {doc["kind"]: doc["id"] for doc in transport.tool("list_documents")["documents"]}
            self.assertEqual(transport.tool("list_components", {"document_id": docs["pcb"]})["total"], 1)
            self.assertEqual(transport.tool("project_summary")["file_revision"], version)
            self.assertEqual(self.authored(p), before)
            self.assertFalse((p / ".waffle/journal").exists())
            written = transport.tool("add_net_label", {"sheet": docs["schematic"], "x": 1, "y": 2,
                                                       "text": "PROBE", "mode": "write"})
            self.assertEqual(list(written["files"]), ["Schematic.wsch"])
        after = self.authored(p)
        self.assertEqual({n for n in before.keys() | after.keys() if before.get(n) != after.get(n)}, {"Schematic.wsch"})
        report = self.cli(manifest, "export_design", {"translator": "kicad", "document_id": docs["pcb"],
                                                       "options": {"scope": "document"}}, output_root=outputs)
        board = next(Path(row["path"]) for row in report["files"] if row["path"].endswith(".kicad_pcb"))
        self.assertIn(b"(at 2.000003 3.000007 12.1234567894)", board.read_bytes())
        self.assertEqual(self.authored(p), after)

    def encoded_step_folder(self):
        sys.path.insert(0, str(SERVER.parent))
        self.addCleanup(sys.path.remove, str(SERVER.parent))
        root = shutil.copytree(ROOT / "tests/fixtures/format-2/instrument", self.temp / self._testMethodName)
        plain = (ROOT / "tests/fixtures/mcad/tray.step").read_bytes()
        vendor = plain.replace(b"Tray.step", b"Plate-\xe9.step")
        utf8 = b"\xef\xbb\xbf" + plain.replace(b"Tray.step", "Plate-µ.step".encode())
        refs = []
        for raw in (vendor, utf8):
            compressor = zlib.compressobj(9, wbits=-15)
            stored = (bytes.fromhex("1f8b08000000000002ff") + compressor.compress(raw) + compressor.flush()
                      + struct.pack("<II", zlib.crc32(raw), len(raw)))
            (root / "models" / (digest(raw) + ".step.gz")).write_bytes(stored)
            refs.append({"byteLength": len(raw), "mediaType": "model/step", "sha256": digest(raw)})

        def rewrite_owner(path, edit):
            rows = [json.loads(line) for line in path.read_bytes().splitlines()]
            for row in rows:
                edit(row)
            path.write_bytes(b"".join(json.dumps(row, separators=(",", ":")).encode() + b"\n" for row in rows))

        def board_models(row):
            if row["kind"] == "modelAlias":
                index = {"tray": 0, "tray-second": 1}.get(row["value"]["id"])
                if index is not None:
                    row["value"]["model"] = refs[index]

        def library_models(row):
            if row["kind"] == "librarySettings":
                row["value"]["model3d"] = {"model": refs[0]}
                footprint = row["value"]["footprint"]
                row["value"]["footprint"] = dict(sorted({**footprint, "model3d": {"model": refs[1]}}.items()))
                row["value"] = dict(sorted(row["value"].items()))

        rewrite_owner(root / "Instrument.wpcb", board_models)
        rewrite_owner(root / "libraries/Precision.wlib", library_models)
        return root, vendor, utf8, refs

    def assert_model_sidecars(self, report, vendor, utf8):
        self.assertEqual([row["code"] for row in report["model_diagnostics"]], ["model-bytes"])
        sidecars = [Path(r["path"]).read_bytes() for r in report["files"] if Path(r["path"]).suffix in (".stp", ".step")]
        self.assertCountEqual(sidecars, [vendor, utf8])

    def test_model_materialization_preserves_exact_step_bytes(self):
        root, vendor, utf8, refs = self.encoded_step_folder()
        manifest = root / "Instrument.waffle"
        from board_runner import BoardRunner
        from server import Server

        before = self.authored(root)
        expected = self.cli(manifest, "project_summary", access="--read-only")["file_revision"]
        with patch.dict(os.environ, self.env):
            engines = []
            for backend in ("jsc", "node"):
                try:
                    runner = BoardRunner(backend=backend)
                except ValueError:
                    continue
                engines.append(backend)
                with self.subTest(engine=backend):
                    server = Server(manifest, read_only=True)
                    server.board_runner = runner
                    try:
                        project = json.loads(server.saved_bytes(require=True, models=True))
                        self.assertEqual(server.digest, expected)
                        aliases = next(d["bodyModels"] for d in project["documents"] if d["kind"] == "pcb")
                        for model in (aliases[0], project["library"][0]["model3d"]):
                            self.assertEqual(zlib.decompress(base64.b64decode(model["zlib"], validate=True)), vendor)
                            self.assertEqual(model["model"], refs[0])
                            self.assertNotIn("stepText", model)
                        for model in (aliases[1], project["library"][0]["footprint"]["model3d"]):
                            self.assertEqual(model["stepText"].encode(), utf8)
                            self.assertEqual(model["model"], refs[1])
                        self.assertEqual([(d["code"], d["path"]) for d in server.folder.last["model_diagnostics"]],
                                         [("model-bytes", "models/" + digest(vendor) + ".step.gz")])
                    finally:
                        server.close()
            self.assertTrue(engines)

        outputs = self.temp / "model outputs"
        outputs.mkdir()
        for tool, args in [("export_altium", {}), ("export_design", {"translator": "altium"})]:
            self.assert_model_sidecars(self.cli(manifest, tool, args, output_root=outputs), vendor, utf8)

        self.assertEqual(self.authored(root), before)
        member = root / "models" / (digest(vendor) + ".step.gz")
        member.write_bytes((root / "models" / (digest(utf8) + ".step.gz")).read_bytes())
        self.assertIn("verification", self.cli(manifest, "project_summary", access="--read-only", expected=1))
        member.write_bytes(member.read_bytes()[:-5])
        self.assertIn("verif", self.cli(manifest, "project_summary", access="--read-only", expected=1))

    def test_pipeline_model_exports_preserve_prior_edits_and_lazy_reads(self):
        root, vendor, utf8, _ = self.encoded_step_folder()
        manifest = root / "Instrument.waffle"
        from folder_design import verified_model
        from server import Server

        before = self.authored(root)
        outputs = self.temp / "pipeline model outputs"
        outputs.mkdir()
        docs = self.cli(manifest, "list_documents", access="--read-only")["documents"]
        sheet = next(doc["id"] for doc in docs if doc["kind"] == "schematic")
        label = {"tool": "add_net_label", "args": {"sheet": sheet, "x": 3, "y": 4, "text": "PIPELINE_LABEL"}}
        choose = {"id": "target", "tool": "add_net_label", "args": {"sheet": sheet, "x": 8, "y": 9, "text": "altium"}}
        computed = {"tool": "export_design", "args": {"translator": {"$ref": "target.result.untrusted_design_text.text"}}}
        for steps in ([label, {"tool": "export_altium"}], [label, choose, computed]):
            ran = self.cli(manifest, "pipeline", {"steps": steps}, output_root=outputs)
            result = ran["steps"][-1]["result"]
            self.assert_model_sidecars(result, vendor, utf8)
            sheet_output = next(Path(row["path"]) for row in result["files"] if row["path"].endswith(".SchDoc"))
            self.assertIn(b"PIPELINE_LABEL", sheet_output.read_bytes())

        with patch.dict(os.environ, self.env), patch("folder_design.verified_model", wraps=verified_model) as verified:
            service = Server(manifest, output_root=outputs)
            try:
                service.folder.list_documents()
                self.assertFalse(verified.called)
                idle_steps = [{"tool": "list_rules"}]
                service.automation.call("pipeline", {"steps": idle_steps})
                choose["args"]["text"] = "kicad"
                service.automation.call("pipeline", {"steps": [choose, computed]})
                missing_def = {"id": "check", "tool": "validate_library_def", "args": {"def": {}}}
                without_models = {"tool": "export_design", "args": {"translator": "step", "options": {
                    "models": {"$ref": "check.result.ok"}}}}
                service.automation.call("pipeline", {"steps": [missing_def, without_models]})
                invalid = {"tool": "export_design", "args": {"translator": "step", "options": "invalid",
                           "document_id": {"$ref": "target.result.untrusted_design_text.text"}}}
                with self.assertRaisesRegex(ValueError, "steps.*args"):
                    service.automation.call("pipeline", {"steps": [choose, invalid]})
                self.assertTrue(verified.called)
                self.assertTrue(all(not call.args[1] for call in verified.call_args_list))
                verified.reset_mock()
                geo = service.automation.call("pipeline", {"steps": [{"tool": "export_step"}]})["steps"][0]["result"]
                self.assertTrue(verified.called)
                self.assertTrue(all(call.args[1] for call in verified.call_args_list))
                self.assertEqual(geo["model_diagnostics"][0]["code"], "model-bytes")
                step = Path(geo["path"]).read_bytes()
                self.assertTrue(step.startswith(b"ISO-10303-21;"))
                self.assertIn(b"PRODUCT('Tray','Tray'", step)
                self.assertEqual(geo["stats"]["parts"], 1)
                standalone = self.cli(manifest, "export_step", output_root=outputs)
                self.assertEqual(Path(standalone["path"]).read_bytes(), step)
                with self.assertRaisesRegex(ValueError, "saved model sources changed"):
                    service.folder.export_models("0" * 64, None)
            finally:
                service.close()
        self.assertEqual(self.authored(root), before)

    def test_malformed_current_sibling_of_additive_manifest(self):
        fixture = ROOT / "tests/fixtures/format-2/future"
        p = shutil.copytree(fixture, self.temp / "locked-malformed")
        current = p / "Assembly.wdraw"
        current.write_bytes(current.read_bytes().replace(b'"formatVersion":"2.1"', b'"formatVersion":"2.0"', 1)
                            .replace(b'"order":"V"', b'"order":"?"', 1))
        before = self.authored(p)
        for tool, args in (("project_summary", {}), ("add_net_label", {"sheet": "fs", "text": "X", "x": 1, "y": 2, "mode": "write"})):
            self.assertIn("Invalid persisted order key", self.cli(p / "Future.waffle", tool, args, "--allow-write", expected=1))
        self.assertEqual(self.authored(p), before)
        self.assertFalse((p / ".waffle/journal").exists())
        self.assertFalse((p / ".waffle/local/mcp").exists())

    def test_manifest_selection_and_missing_sibling(self):
        p = self.copy()
        before = self.authored(p)
        self.assertEqual(self.cli(p / self.manifest.name, "project_summary")["file_revision"], self.sample_digest)
        self.assertEqual(before, self.authored(p))
        self.assertFalse((p / ".waffle/journal").exists())
        (p / self.sheet).unlink()
        with MCP(p, self.env) as transport:
            listed = transport.tool("list_documents")
            self.assertTrue(listed["version_pending"])
            self.assertEqual(len(listed["documents"]), 2)
            bid = next(row["id"] for row in listed["documents"] if row["kind"] == "pcb")
            self.assertGreater(transport.tool("list_components", {"document_id": bid})["total"], 0)
            transport.tool("project_summary", error="incomplete_project")
            transport.tool("move_component", {"component": "b-J1", "dx": 0.25}, error="read_only")

    def test_proposal_review_scope_and_inverse(self):
        p = self.copy()
        prior = self.authored(p)
        board = (p / self.board).read_bytes()
        with MCP(p, self.env, "--allow-write") as transport:
            proposal = transport.tool("move_component", {"component": "b-J1", "dx": 0.75})
            self.assertEqual(self.authored(p), prior)
            path = Path(proposal["proposal_file"])
            self.assertEqual(json.loads(path.read_bytes())["format2_base"]["project_id"],
                             transport.tool("list_documents")["project_id"])
            review = transport.tool("apply_proposal", {"file": path.name})
            args = {"file": path.name, "mode": "write", "proposal_sha256": review["proposal_sha256"],
                    "source_sha256": review["source_sha256"]}
            wrote = transport.tool("apply_proposal", args)
            self.assertEqual(list(wrote["files"]), [self.board])
            self.assertEqual({path for path, sha in self.authored(p).items() if sha != prior[path]}, {self.board})
            with zipfile.ZipFile(wrote["backup"]) as saved:
                self.assertEqual(saved.read("previous/" + self.board), board)
            self.assertEqual(transport.tool("inspect_component", {"component_id": "b-J1"})["component"]["x"], 4.55)
            transport.tool("apply_proposal", args, error="stale_source")
            restored = transport.tool("move_component", {"component": "b-J1", "x": 3.8, "mode": "write"})
            self.assertEqual(restored["file_revision"], self.sample_digest)
            self.assertEqual(self.authored(p), prior)

    def test_foreign_exports_use_only_verified_saved_precision(self):
        input_folder = self.copy()
        source = input_folder / "Measurement.kicad_pcb"
        original = (b'(kicad_pcb (version 20240108) (generator pcbnew) (general (thickness 1.6)) '
                    b'(layers (0 "F.Cu" signal) (31 "B.Cu" signal)) (net 0 "") '
                    b'(footprint "Precision" (layer "F.Cu") (at 2.000003 3.000007 12.1234567894) '
                    b'(fp_text reference "U1" (at 0 1) (layer "F.SilkS")) '
                    b'(fp_text value "Meter" (at 0 -1) (layer "F.Fab")) '
                    b'(pad "1" smd rect (at 0 0 12.1234567894) (size 1 1) (layers "F.Cu" "F.Paste" "F.Mask"))))')
        source.write_bytes(original)
        created = self.cli(input_folder / self.manifest.name, "import_design", {"paths": [source.name], "target_format": "2.0", "name": "Measurement"})
        manifest = Path(created["path"])
        root = manifest.parent
        before = self.authored(root)
        outputs = self.temp / "generated"
        outputs.mkdir()
        index = next((root / ".waffle/imports").rglob("bindings-*.json"))
        metadata = next(row for line in index.read_bytes().splitlines() if (row := json.loads(line)).get("residuals"))
        self.assertNotIn("residuals", metadata.get("binding", {}))
        self.assertTrue(any(row["nativeValue"] == 12123456789 for row in metadata["residuals"]))

        def exported(project, translator, suffix):
            docs = self.cli(project, "list_documents")["documents"]
            document = next(row["id"] for row in docs if row["kind"] == "pcb")
            params = {"translator": translator, "document_id": document, "options": {"scope": "document"}}
            report = self.cli(project, "export_design", params, output_root=outputs)
            out = next(row["path"] for row in report["files"] if row["path"].endswith(suffix))
            return Path(out).read_bytes()

        self.assertIn(b'(at 2.000003 3.000007 12.1234567894)', exported(manifest, "kicad", ".kicad_pcb"))
        self.assertIn(b'|ROTATION=12.1234567894|', exported(manifest, "altium", ".PcbDoc"))
        self.assertEqual(before, self.authored(root))
        self.assertEqual(source.read_bytes(), original)

        detached = self.temp / "Measurement without import data"
        shutil.copytree(root, detached)
        there = detached / manifest.name
        there.write_bytes(b"".join(line for line in there.read_bytes().splitlines(keepends=True) if json.loads(line)["kind"] != "importIndex"))
        self.assertIn(b'(at 2.000003 3.000007 12.123456789)', exported(there, "kicad", ".kicad_pcb"))
        self.assertIn(b'|ROTATION=12.123456789|', exported(there, "altium", ".PcbDoc"))

        corrupt = self.temp / "Measurement with mismatched source"
        shutil.copytree(root, corrupt)
        retained = next((corrupt / ".waffle/imports").rglob("source"))
        retained.write_bytes(bytes([retained.read_bytes()[0] ^ 1]) + original[1:])
        message = self.cli(corrupt / manifest.name, "export_kicad", expected=1)
        self.assertRegex(message, r"(?i)changed|verification|failed")

        message = self.cli(manifest, "export_design", {"translator": "kicad", "options": {"provenance": []}}, expected=1)
        self.assertIn("Export uses the current project's provenance", message)
        self.assertEqual(self.authored(root), before)

        updated = self.temp / "Measurement after saved edit"
        shutil.copytree(root, updated)
        def git(*args):
            subprocess.run(["git", "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "-c", "commit.gpgSign=false",
                            "-c", "core.hooksPath=" + os.devnull, "-C", str(updated), *args], check=True, capture_output=True)
        git("init", "-b", "main")
        git("add", ".")
        git("commit", "-m", "Import precision fixture")
        board = next(updated.glob("*.wpcb"))
        data = board.read_bytes()
        self.assertIn(b'12123456789', data)
        board.write_bytes(data.replace(b'12123456789', b'15123456789', 1))
        saved = updated / manifest.name
        message = self.cli(saved, "export_design", {"translator": "kicad", "source_sha256": created["sha256"]}, expected=1,
                           output_root=outputs)
        self.assertIn("saved project changed", message)
        self.assertIn(b'(at 2.000003 3.000007 15.123456789)', exported(saved, "kicad", ".kicad_pcb"))
        with MCP(saved, self.env, "") as transport:
            revision = transport.tool("compare_git_head")
            self.assertEqual(revision["base_file_revision"], created["sha256"])
            self.assertTrue(transport.tool("project_history")["commits"])
            docs = transport.tool("list_documents")["documents"]
            document = next(row["id"] for row in docs if row["kind"] == "pcb")
            report = transport.tool("export_design", {"translator": "kicad", "document_id": document, "options": {"scope": "document"}})
            self.assertEqual(report["file_revision"], revision["file_revision"])
            board_out = next(Path(row["path"]) for row in report["files"] if row["path"].endswith(".kicad_pcb"))
            self.assertIn(b'(at 2.000003 3.000007 15.123456789)', board_out.read_bytes())

    def test_native_altium_rule_report_and_discard(self):
        folder = self.copy()
        source = folder / "Limits.PcbDoc"
        records = (ROOT / "tests/fixtures/altium/signals-ascii/Signals.PcbDoc").read_bytes().splitlines()
        original = b"\r\n".join([*(line for line in records if b"|RECORD=Rule|" not in line),
            b"|RECORD=Rule|RULEKIND=Width|NAME=Limit probe|ENABLED=TRUE|SCOPE1EXPRESSION=All|MINLIMIT=8mil|PRIORITY=3|"]) + b"\r\n"
        source.write_bytes(original)
        created = self.cli(folder, "import_design", {"paths": [source.name], "mode": "save-as"})
        native = Path(created["path"])
        with MCP(native, self.env) as transport:
            board = next(d for d in transport.tool("project_summary")["documents"] if d["kind"] == "pcb")
            self.assertEqual(board["source_rule_count"], 1)
            rules = transport.tool("list_source_rules", {"document_id": board["id"], "query": "Limit probe"})
            self.assertEqual(rules["source_rule_count"], 1)
            self.assertEqual(rules["total"], 1)
        self.assertNotIn(b"sourceRules", next(native.parent.glob("*.wpcb")).read_bytes())
        native.write_bytes(b"".join(line for line in native.read_bytes().splitlines(keepends=True)
                                    if json.loads(line)["kind"] != "importIndex"))
        self.assertEqual(self.cli(native, "list_source_rules", {"document_id": board["id"]})["total"], 0)
        self.assertEqual(source.read_bytes(), original)

    def test_rejected_and_concurrent_edits_leave_only_committed_backups(self):
        folder = self.copy()
        private = folder / ".waffle/local/mcp"
        private.mkdir(parents=True)
        unrelated = self.temp / "original log"
        unrelated.write_bytes(b"untouched")
        (private / "changes.jsonl").symlink_to(unrelated)
        args = {"component": "b-J1", "dx": 0.25, "mode": "write", "source_sha256": self.sample_digest}
        denied = self.cli(folder, "move_component", args, "--allow-write", expected=1)
        self.assertIn("regular, unlinked", denied)
        self.assertEqual(unrelated.read_bytes(), b"untouched")
        self.assertEqual([p.name for p in private.iterdir()], ["changes.jsonl"])
        (private / "changes.jsonl").unlink()
        original = (folder / self.board).read_bytes()
        request = {"name": "move_component", "arguments": args}
        with MCP(folder, self.env, "--allow-write") as first, MCP(folder, self.env, "--allow-write") as second:
            with ThreadPoolExecutor(max_workers=2) as pool:
                replies = list(pool.map(lambda client: client.call("tools/call", request), (first, second)))
        winner, loser = sorted(replies, key=lambda reply: reply["isError"])
        self.assertEqual([winner["isError"], loser["isError"]], [False, True], replies)
        code = loser["structuredContent"]["error"]["code"]
        self.assertIn(code, ("stale_source", "recovery_pending"), loser)
        written = json.loads(winner["content"][0]["text"])
        self.assertEqual(written["changes"], 1)
        committed, = private.glob("backup-*.zip")
        self.assertEqual(committed, Path(written["backup"]))
        pending = list(private.glob(".pending-*"))
        self.assertLessEqual(len(pending), 1 if code == "recovery_pending" else 0, loser)
        for path in [committed, *pending]:
            self.assertEqual(path.resolve().parent, private)
            self.assertFalse(path.is_symlink())
            self.assertEqual(path.stat().st_nlink, 1)
            with zipfile.ZipFile(path) as archive:
                member = "previous/" + self.board
                self.assertCountEqual(archive.namelist(), [member, "backup.json"])
                self.assertEqual(archive.read(member), original)
                self.assertEqual(json.loads(archive.read("backup.json")), {
                    "source_sha256": self.sample_digest, "targets": [{"path": self.board, "sha256": digest(original)}],
                })
        audit, = map(json.loads, (private / "changes.jsonl").read_bytes().splitlines())
        self.assertEqual((audit["transaction"], audit["targets"]), (written["transaction"], written["files"]))
        saved = self.cli(folder, "inspect_component", {"component_id": "b-J1"})
        self.assertEqual(saved["component"]["x"], 4.05)

    def test_external_sibling_changes_between_stage_and_commit(self):
        if not self.fault_host:
            self.skipTest("This fault variant uses the native macOS checkpoint harness.")
        p = self.copy()
        prior = self.authored(p)
        owner = p / self.sheet
        data = owner.read_bytes()
        # Preserve length so a raw-hash check, rather than file size, must reject the write.
        self.assertIn(b'"VDD"', data)
        changed = data.replace(b'"VDD"', b'"WDD"', 1)
        env = dict(self.env, WAFFLE_TEST_CHANGED_OWNER=str(owner), WAFFLE_TEST_CHANGED_BYTES=base64.b64encode(changed).decode())
        with MCP(p, env, "--allow-write") as transport:
            transport.tool("move_component", {"component": "b-J1", "dx": 0.75, "mode": "write"}, error="stale_source")
        self.assertFalse((p / ".waffle/journal/active").exists())
        self.assertEqual({path for path, sha in self.authored(p).items() if sha != prior[path]}, {self.sheet})
        self.assertEqual(owner.read_bytes(), changed)
        private = p / ".waffle/local/mcp"
        self.assertEqual(list(private.iterdir()), [])

    def test_crash_after_commit_recovers_only_the_selected_owner(self):
        if not self.fault_host:
            self.skipTest("This fault variant uses the native macOS checkpoint harness.")
        p = self.copy()
        prior = self.authored(p)
        env = dict(self.env, WAFFLE_TEST_KILL_FOLDER_AT="after-commit-sync")
        args = {"component": "b-J1", "x": 4.55, "mode": "write"}
        self.cli(p, "move_component", args, "--allow-write", env, expected=1)
        self.assertTrue((p / ".waffle/journal/active").is_file())
        self.assertEqual(self.authored(p), prior)
        with MCP(p, self.env) as transport:
            transport.tool("list_documents", error="recovery_pending")
        self.assertTrue((p / ".waffle/journal/active").is_file())
        self.assertEqual(self.cli(p, "move_component", args, "--allow-write")["changes"], 0)
        self.assertFalse((p / ".waffle/journal/active").exists())
        self.assertEqual({path for path, sha in self.authored(p).items() if sha != prior[path]}, {self.board})

    def test_future_declaration_keeps_exact_bytes_and_complete_digest(self):
        p = self.copy()
        manifest = p / self.manifest.name
        prior = manifest.read_bytes().replace(b'"formatVersion":"2.0"', b'"formatVersion":"2.2"', 1)
        manifest.write_bytes(prior + b'{"kind":"document","id":"zz-trace","docKind":"waveform","name":"Trace","path":"Trace.wwave"}\n')
        future = p / "Trace.wwave"
        future.write_bytes(b'{"kind":"waveform","formatVersion":"2.1","id":"zz-trace"}\n'
                           b'{"kind":"futureNode","id":"trace-graph","value":"preserved"}\n')
        before = self.authored(p)
        script = node_preload("format-2-closure") + """
          const fs = require('fs'), path = require('path');
          const manifest = process.argv[1];
          const root = AtriumFormat2Model.parse(fs.readFileSync(manifest), {kind:'project'});
          AtriumFormat2Closure.verify(root, key => fs.readFileSync(path.join(path.dirname(manifest), key))).then(v => console.log(v.sha256));
        """
        direct = subprocess.check_output(["node", "-e", script, str(manifest)], text=True).strip()
        with MCP(p, self.env, "--allow-write") as transport:
            listed = transport.tool("list_documents")["documents"]
            self.assertTrue(next(row for row in listed if row["id"] == "zz-trace")["read_only"])
            summary = transport.tool("project_summary")
            self.assertEqual(summary["file_revision"], direct)
            self.assertEqual(summary["opaque_documents"][0]["id"], "zz-trace")
            transport.tool("add_net_label", {"sheet": "zz-trace", "text": "UNSUPPORTED", "x": 1, "y": 2, "mode": "write"},
                           error="read_only_revision")
        self.assertEqual(before, self.authored(p))
        self.assertFalse((p / ".waffle/journal").exists())

    def test_additive_proposal_is_one_known_record_splice(self):
        fixture = json.loads((ROOT / "native/tests/folder-transaction/additive.json").read_text())
        p = self.temp / self._testMethodName
        p.mkdir()
        manifest = p / fixture["manifest"]
        owner = p / fixture["member"]
        for name, text in fixture["files"].items():
            (p / name).write_bytes(text.encode())
        before = self.authored(p)

        def proposal(change):
            script = node_preload("format-2-closure", "proposal") + """
              const fs = require('fs'), path = require('path');
              const [manifest, member, change] = process.argv.slice(1);
              const F = AtriumFormat2, M = AtriumFormat2Model;
              const read = name => fs.readFileSync(path.join(path.dirname(manifest), name));
              const root = M.parse(fs.readFileSync(manifest), {kind:'project'});
              const before = {...M.manifest(root).project, documents:[M.document(M.parse(read(member)), {name:'Power'})], library:[]};
              const after = structuredClone(before);
              if (change === 'fields') Object.assign(after.documents[0].items[0], {x:.0011, y:.0022, text:'DRIVE'});
              if (change === 'extension') after.documents[0].items[0].future.nested[1].measurement = 22;
              if (change === 'rename') after.documents[0].name = 'Renamed';
              AtriumFormat2Closure.verify(root, read).then(({sha256, members}) => {
                const packet = AtriumProposal.build(before,after,{source_sha256:sha256,allowV1:false}).proposal;
                packet.format2_base = {project_id:root.header.id,manifest_sha256:F.sha256(F.serialize(root)),members:members.map(({path,sha256}) => [path,sha256])};
                console.log(JSON.stringify(packet));
              });
            """
            result = subprocess.check_output(["node", "-e", script, str(manifest), fixture["member"], change])
            file = p / (change + ".waffle-ai")
            file.write_bytes(result)
            return file.name

        def reviewed(transport, variant):
            file = proposal(variant)
            review = transport.tool("apply_proposal", {"file": file})
            return {"file": file, "mode": "write", "proposal_sha256": review["proposal_sha256"],
                    "source_sha256": review["source_sha256"]}

        with MCP(manifest, self.env, "--allow-write") as transport:
            for variant in ("extension", "rename"):
                transport.tool("apply_proposal", reviewed(transport, variant), error="read_only_revision")
                self.assertFalse((p / ".waffle").exists())
                self.assertEqual(self.authored(p), before)
            args = reviewed(transport, "fields")
            result = transport.tool("apply_proposal", args)
            self.assertEqual(set(result["files"]), {owner.name})
            self.assertEqual(result["files"][owner.name], fixture["desired"])
            self.assertEqual(owner.read_bytes(), fixture["files"][owner.name].replace(fixture["edit"]["from"], fixture["edit"]["to"]).encode())
            self.assertEqual({name for name, sha in self.authored(p).items() if before[name] != sha}, {owner.name})
            transport.tool("apply_proposal", args, error="stale_source")

        cli_root = p.with_name(p.name + "-cli")
        cli_root.mkdir()
        for name, text in fixture["files"].items():
            (cli_root / name).write_bytes(text.encode())
        shutil.copyfile(p / args["file"], cli_root / args["file"])
        cli = self.cli(cli_root / manifest.name, "apply_proposal", args, "--allow-write")
        self.assertEqual(cli["files"], result["files"])
        self.assertEqual(cli["file_revision"], result["file_revision"])

    def test_additive_required_features_and_nonsplice_remain_read_only(self):
        fixture = json.loads((ROOT / "native/tests/folder-transaction/additive.json").read_text())
        for variant in ("requirements", "crlf"):
            p = self.copy() if variant == "crlf" else self.temp / variant
            if variant == "crlf":
                manifest = p / self.manifest.name
                manifest.write_bytes(manifest.read_bytes().replace(b'"formatVersion":"2.0"', b'"formatVersion":"2.1"', 1))
                board = p / self.board
                board.write_bytes(board.read_bytes().replace(b'\n', b'\r\n'))
                args = {"component": "b-J1", "dx": 0.75, "mode": "write"}
                tool = "move_component"
            else:
                p.mkdir()
                for name, text in fixture["files"].items():
                    if name == fixture["manifest"]:
                        text = text.replace('"name":"Forward sensor"', '"name":"Forward sensor","requires":["future"]')
                    (p / name).write_bytes(text.encode())
                manifest = p / fixture["manifest"]
                args = {"sheet": "d1", "text": "OTHER", "x": 1, "y": 2, "mode": "write"}
                tool = "add_net_label"
            before = self.authored(p)
            message = self.cli(manifest, tool, args, "--allow-write", expected=1)
            self.assertIn("Waffle version" if variant == "crlf" else "Unsupported required feature", message)
            self.assertEqual(self.authored(p), before)
            self.assertFalse((p / ".waffle/journal").exists())
            self.assertFalse((p / ".waffle/local/mcp").exists())


if __name__ == "__main__":
    unittest.main(verbosity=2)
