"""Headless parity: every editor menu/key action has a headless path, and every run_command works.

1. The inventory (scripts/headless-inventory.py) maps every action to run_command, an MCP
   tool, or an explicit interactive-only justification; docs/headless-parity.* are current.
2. Every mapped command and tool exists; command schemas are strict.
3. A smoke run of every run_command (and alias) over the sample project through the CLI.

Run: python3 tests/automation/headless-parity.py
"""
import importlib.util
import json
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch
import zipfile

import sys as _test_sys
from pathlib import Path as _TestPath
_test_sys.path.insert(0, str((_TestPath(__file__).resolve().parent / "../support").resolve()))
from native_sample import authored_files, ensure_native_host, read_design, revision, write_design

sys.dont_write_bytecode = True
ROOT = Path(__file__).resolve().parents[2]
SERVER = ROOT / "mcp" / "server.py"
sys.path.insert(0, str(ROOT / "mcp"))
import commands as C  # noqa: E402
from board_runner import JavaScriptCore, MODULES, load_jsc, resolve, safe_which


def load(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


INVENTORY = load("headless_inventory", ROOT / "scripts" / "headless-inventory.py")


def worker_contract():
    script = """
        (() => {
            const worker = globalThis.AtriumCommandsHeadless;
            // These arguments select the edit path of both conditional commands.
            const editArgs = {replacement:"", action:"remove"};
            return JSON.stringify({
                kinds: Object.fromEntries(worker.names().map(name => [name, worker.kind(name, editArgs)])),
                unknown: ["constructor", "insert-palette"].map(name => worker.kind(name, {})),
                inspections: [worker.kind("find_replace", {}), worker.kind("via_fence", {action:"status"})],
                revision: globalThis.AtriumLegacyCommandContract.allowsLockedRevision
            });
        })()
    """
    modules = ("commands-headless",)
    lib = load_jsc()
    if lib:
        js = JavaScriptCore(lib, modules)
        try:
            raw = js.value_text(js.evaluate(script))
        finally:
            js.close()
    else:
        node = safe_which("node")
        if not node:
            raise RuntimeError("JavaScriptCore or Node is required to inspect headless commands.")
        imports = "\n".join(f"require({json.dumps(str(file))});" for _, file in resolve(modules))
        raw = subprocess.check_output([node, "-"], input=imports + f"\nprocess.stdout.write({script});",
                                      encoding="utf-8", timeout=10)
    return json.loads(raw)


class Inventory(unittest.TestCase):
    def test_every_action_is_mapped_and_docs_are_current(self):
        rows = INVENTORY.inventory()
        missing = [r["action"] for r in rows if r["status"] == "missing"]
        self.assertEqual(missing, [], "Map these actions in mcp/commands.py COVERAGE (headless path or interactive-only reason).")
        self.assertGreater(len(rows), 200)
        for r in rows:
            if r["status"] == "interactive":
                self.assertGreater(len(r["reason"]), 20, r["action"])
        run = subprocess.run([sys.executable, "-B", str(ROOT / "scripts" / "headless-inventory.py"), "--check"], capture_output=True, text=True)
        self.assertEqual(run.returncode, 0, run.stdout + run.stderr)

    def test_menu_actions_from_index_html_are_all_found(self):
        html = (ROOT / "app" / "index.html").read_text(encoding="utf-8")
        import re
        actions = set(re.findall(r'data-action="([^"]+)"', html)) - {"close-dialog"}
        found = {r["action"] for r in INVENTORY.inventory()}
        self.assertLessEqual(actions, found)

    def test_named_menu_slots_are_in_the_inventory(self):
        html = (ROOT / "app" / "index.html").read_text(encoding="utf-8")
        import re
        menubar = re.search(r'<nav class="menubar"[^>]*>(.*?)</nav>', html, re.S).group(1)
        actions = set(re.findall(r'data-slot="([^"]+)"', menubar))
        self.assertTrue(actions)
        rows = {r["action"]: r for r in INVENTORY.inventory()}
        self.assertEqual(actions - rows.keys(), set())
        self.assertIn("No ERC on Unused Pins", rows["sch-noerc-unused"]["labels"])
        self.assertIn("place", rows["sch-noerc-unused"]["menus"])

    def test_lazy_collaboration_menu_is_discovered(self):
        rows = {r["action"]: r for r in INVENTORY.inventory()}
        for action, label in (("collab-status", "Collaboration…"),
                              ("collab-ask", "Ask to Edit Document"),
                              ("collab-release", "Release Document Lock")):
            with self.subTest(action=action):
                self.assertTrue(action in rows, f"{action} is absent from the action inventory")
                self.assertIn(label, rows[action]["labels"])
                self.assertIn("project", rows[action]["menus"])
                self.assertEqual(rows[action]["status"], "interactive")

    def test_nested_registration_uses_first_party_source_paths(self):
        with tempfile.TemporaryDirectory() as folder:
            app = Path(folder)
            for relative, action in (("design/checks/menu.js", "nested-menu"),
                                     ("extensions/host/menu.js", "extension-host-action"),
                                     ("vendor/tool.js", "vendor-action"),
                                     ("extensions/bundled.js", "bundled-action"),
                                     ("extensions/packages/example/tool.js", "extension-action"),
                                     ("design/checks/commands-headless.js", "headless-action"),
                                     ("design/checks/lint-worker-source.js", "worker-action")):
                file = app / relative
                file.parent.mkdir(parents=True, exist_ok=True)
                file.write_text(f'nav.menuItem("tools", "{action}", "A menu item");', encoding="utf-8")
            rows = {}
            with patch.object(INVENTORY, "APP", app):
                INVENTORY.scan_js(rows)
            self.assertEqual(set(rows), {"nested-menu", "extension-host-action"})
            self.assertEqual(rows["nested-menu"]["sources"], ["design/checks/menu.js menuItem"])

    def test_targets_exist_and_schemas_are_strict(self):
        for name, spec in C.COMMANDS.items():
            for m in spec["modules"]:
                self.assertIn(m, MODULES, name)
            for key in spec["required"]:
                self.assertIn(key, spec["props"], name)
        for action, (status, target) in ((a, v) for a, v in C.COVERAGE.items() if v[0] != "interactive"):
            if status == "command":
                self.assertIn(target, C.COMMANDS, action)
        self.assertFalse(set(C.COMMANDS) & set(C.ALIASES))

    def test_loaded_worker_contract_matches_python_handlers_and_policy(self):
        worker = worker_contract()
        self.assertEqual(worker["kinds"], {name: spec["kind"] for name, spec in C.COMMANDS.items()})
        self.assertEqual(worker["unknown"], [None, None])
        self.assertEqual(worker["inspections"], ["read", "read"])
        exceptions = {"new_revision", "release_revision", "set_revision_status", "set_variant"}
        self.assertEqual(set(worker["revision"]), exceptions)
        self.assertEqual({name for name in C.COMMANDS if C.allows_locked_revision(name)}, exceptions)

    def test_editor_session_actions_are_interactive(self):
        for action in ("collab-live", "show-problems", "components-panel", "input-diagnostics", "frame-monitor"):
            self.assertEqual(C.coverage(action)["status"], "interactive", action)


def sample_project():
    return load("mcp_tests", ROOT / "tests/automation/mcp.py").sample_project()


class Smoke(unittest.TestCase):
    """Every run_command over the sample project through the CLI."""
    @classmethod
    def setUpClass(cls):
        ensure_native_host()
        design = json.loads(sample_project())
        # A child sheet with a port and a sheet symbol for it, so sync_sheet_entries has work.
        sheet = next(d for d in design["documents"] if d["kind"] == "schematic")
        design["documents"].append({"id": "smoke-child", "kind": "schematic", "name": "Child", "grid": 1.27, "outline": [], "notes": [],
                                    "items": [{"id": "smoke-port", "kind": "port", "text": "SDA", "io": "input", "x": 10, "y": 10}]})
        sheet["items"].append({"id": "smoke-sheet", "kind": "sheetsymbol", "x": 20, "y": 20, "w": 20, "h": 15, "name": "Child", "sheet": "smoke-child", "entries": []})
        template = tempfile.TemporaryDirectory(prefix="waffle-headless-parity-")
        cls.addClassCleanup(template.cleanup)
        cls.template = Path(template.name)
        manifest = write_design(cls.template / "Sensor.waffle", design)
        cls.fixture = authored_files(cls.template)
        cls.source = revision(manifest)
        cls.pcb = next(d["id"] for d in design["documents"] if d["kind"] == "pcb")
        cls.sch = next(d["id"] for d in design["documents"] if d["kind"] == "schematic")
        cls.tracks = [i["id"] for d in design["documents"] if d["kind"] == "pcb" for i in d["items"] if i["kind"] == "track"]

    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.dir = Path(self.temp.name)
        shutil.copytree(self.template, self.dir, dirs_exist_ok=True)
        self.path = self.dir / "Sensor.waffle"

    def cli(self, tool, args, *flags):
        r = subprocess.run([sys.executable, "-B", str(SERVER), "--project", str(self.path), *flags, "--cli", tool, "--args", json.dumps(args)],
                           capture_output=True, text=True, timeout=120)
        self.assertNotIn("Traceback", r.stderr)
        return r

    def test_cli_omits_editor_session_actions(self):
        listing = self.cli("list_commands", {})
        self.assertEqual(listing.returncode, 0, listing.stderr)
        editor_actions = {"collab-live", "collab-ask", "collab-release", "collab-status", "show-problems",
                          "components-panel", "input-diagnostics", "frame-monitor"}
        editor_commands = editor_actions | {action.replace("-", "_") for action in editor_actions}
        for command in json.loads(listing.stdout)["commands"]:
            self.assertNotIn(command["command"], editor_commands)
            self.assertTrue(editor_actions.isdisjoint(command["actions"]))

    def cases(self):
        P, S, T = self.pcb, self.sch, self.tracks
        three = {"document_id": P, "designators": ["R1", "C1", "U1"]}
        # (command, args, mode or None, must succeed on the sample)
        return [
            ("select", {"document_id": P, "kinds": ["track"], "net": "GND"}, None, True),
            ("select", {"document_id": P, "kinds": ["parts"], "within": [0, 0, 40, 30], "limit": 5}, None, True),
            ("find_similar", {"document_id": P, "id": "b-R1", "criteria": {"footprint": "same"}}, None, True),
            ("find_replace", {"query": "Input"}, None, True),
            ("find_replace", {"query": "Input", "replacement": "Signal in", "scope": "document", "document_id": S}, "plan", True),
            ("align", dict(three, mode="left"), "plan", True),
            ("distribute", dict(three, axis="x"), "plan", True),
            ("align_to_grid", {"document_id": P, "designators": ["R1"], "grid": 1}, "plan", True),
            ("make_array", {"document_id": P, "designators": ["R1", "R2"], "axis": "x", "pitch": 5}, "plan", True),
            ("rotate", {"document_id": P, "designators": ["R1"]}, "proposal", True),
            ("mirror", {"document_id": S, "designators": ["R2"], "axis": "x"}, "plan", True),
            ("flip_side", {"document_id": P, "designators": ["C2"]}, "plan", True),
            ("set_locked", {"document_id": P, "designators": ["R1"], "locked": True}, "plan", True),
            ("union", {"document_id": P, "designators": ["R1", "C1"], "op": "create"}, "plan", True),
            ("duplicate", {"document_id": P, "designators": ["R1"], "dx": 5}, "plan", True),
            ("add_items", {"document_id": P, "items": [{"kind": "via", "x": 20, "y": 15, "diameter": 0.6, "drill": 0.3, "net": "GND", "layer": "Multi"}]}, "plan", True),
            ("sync_sheet_entries", {"document_id": S, "id": "smoke-sheet"}, "plan", True),
            ("query", {"document_id": P, "expression": "IsComponent Or InNet('GND')"}, None, True),
            ("set_grid", {"document_id": P, "grid": 0.5}, "plan", True),
            ("set_units", {"units": "mil"}, "plan", True),
            ("set_hop_overs", {"document_id": S, "on": True}, "plan", True),
            ("add_document", {"kind": "schematic", "name": "Power"}, "plan", True),
            ("rename_document", {"document_id": P, "name": "Main board"}, "plan", True),
            ("list_variants", {}, None, True),
            ("set_variant", {"variant": None}, "plan", True),
            ("activate_rule_set", {"document_id": P, "name": "JLC 2-layer"}, "plan", True),
            ("teardrops", {"document_id": P, "action": "add"}, "plan", True),
            ("teardrops", {"document_id": P, "action": "remove"}, "plan", True),
            ("via_fence", {"document_id": P, "action": "status"}, None, True),
            ("via_fence", {"document_id": P, "action": "place", "kind": "edge", "net": "GND"}, "plan", True),
            ("via_fence", {"document_id": P, "action": "remove"}, "plan", True),
            ("place_designators", {"document_id": P}, "plan", True),
            ("length_tune", {"document_id": P, "phase": True}, "plan", True),
            ("diffpair_gloss", {"document_id": P, "ids": T[:1]}, "plan", False),  # no differential pairs in the sample
            ("diffpair_retrace", {"document_id": P, "ids": T[:1]}, "plan", False),
            ("route_tabs", {"document_id": P, "ids": T[:1]}, "plan", False),
            ("rooms_fit", {"document_id": P}, "plan", True),
            ("rooms_lock", {"document_id": P, "locked": True}, "plan", False),  # no rooms in the sample
            ("swap_components", {"document_id": P, "designators": ["R1", "R2"]}, "plan", True),
            ("swap_footprint", {"document_id": P, "designators": ["R1"]}, "plan", True),
            ("export_dxf", {"document_id": P, "layers": ["Silk"]}, None, True),
            ("list_component_classes", {"document_id": P}, None, True),
            ("component_classes", {"document_id": P, "op": "set", "name": "Passives", "designators": ["R1", "R2"]}, "plan", True),
            ("list_dynamic_connectors", {}, None, True),
            ("dynamic_symbol", {"document_id": S, "op": "place", "x": 50, "y": 50}, "plan", True),
            ("hdi_report", {"document_id": P}, None, True),  # hdi-mcp
            ("panel_report", {"document_id": P}, None, True),  # panelisation v2
            ("panel_setup", {"document_id": P, "preset": "frame-mousebite", "params": {"rows": 2, "cols": 2, "spacing_y": 3}}, "plan", True),
            ("hdi_setup", {"document_id": P, "build_up": "none"}, "plan", True),
            ("hdi_setup", {"document_id": P, "build_up": "2"}, "plan", False),  # the two-layer sample has no room for a build-up
            ("list_revisions", {}, None, True), ("variant_bom", {"variant": None}, None, True),
            ("compare_revisions", {"before": "A"}, None, False),  # the sample has no frozen revision
            ("new_revision", {}, "plan", True), ("set_revision_status", {"revision": "A", "status": "obsolete"}, "plan", False),
            ("release_revision", {"notes": "smoke", "overrides": [{"check": c, "reason": "smoke test"} for c in ("drc", "erc", "bom", "variants", "outputs")]}, "plan", True),
            ("variant_edit", {"op": "create", "name": "Lite"}, "plan", True),
            ("board_rule_sets", {"document_id": P, "op": "create", "name": "Fab"}, "plan", True),  # parity-coming-soon
            ("related_components", {"op": "hardware", "document_id": P}, None, True),
            # aliases of existing tools
            ("repour", {}, "proposal", True), ("annotate", {"action": "update"}, "plan", True), ("drc", {"rules": ["width"]}, None, True),
            ("erc", {"limit": 5}, None, True), ("bom", {"formats": ["csv"], "output_dir": "smoke"}, None, True),
            ("via_stubs", {}, None, True), ("delete", {"designators": ["R2"], "document_id": S}, "proposal", True),
        ]

    def test_every_command_runs_through_the_cli(self):
        cases = self.cases()
        covered = {c[0] for c in cases}
        self.assertLessEqual(set(C.COMMANDS), covered, "add a smoke case for every command")
        failures = []
        for name, args, mode, must in cases:
            request = {"command": name, "args": args}
            if mode:
                request["mode"] = mode
            r = self.cli("run_command", request)
            if r.returncode == 0:
                out = json.loads(r.stdout)
                if mode == "plan" and name in C.COMMANDS and C.COMMANDS[name]["kind"] == "edit":
                    self.assertEqual(out.get("mode"), "plan", name)
            elif must or not r.stderr.startswith("waffle: "):
                failures.append("%s %s: %s" % (name, json.dumps(args)[:80], r.stderr.strip()[:300]))
        self.assertEqual(failures, [])
        self.assertEqual(authored_files(self.dir), self.fixture, "authored project files stay unchanged without --allow-write")
        outputs = self.dir / "Sensor-outputs"
        self.assertTrue((outputs / "dxf").is_dir())
        for path in self.dir.rglob("*"):
            if path.is_file():
                name = path.relative_to(self.dir)
                self.assertTrue(name.as_posix() in self.fixture or name.parts[0] == outputs.name
                                or name.parts[:2] == (".waffle", "local")
                                or len(name.parts) == 1 and name.suffix == ".waffle-ai", name)

    def test_plans_change_nothing_and_proposals_apply(self):
        r = self.cli("run_command", {"command": "align", "mode": "plan", "args": {"document_id": self.pcb, "designators": ["R1", "C1", "U1"], "mode": "top"}})
        self.assertEqual(r.returncode, 0, r.stderr)
        plan = json.loads(r.stdout)
        self.assertGreater(plan["changes"], 0)
        self.assertEqual(list(self.dir.glob("*.waffle-ai")), [])
        r = self.cli("run_command", {"command": "align", "args": {"document_id": self.pcb, "designators": ["R1", "C1", "U1"], "mode": "top"}})
        self.assertEqual(r.returncode, 0, r.stderr)
        out = json.loads(r.stdout)
        proposal = json.loads(Path(out["proposal_file"]).read_text())
        self.assertEqual(proposal["source_sha256"], self.source)
        self.assertEqual(out["changes"], plan["changes"])
        self.assertEqual(authored_files(self.dir), self.fixture)

    def test_cold_duplicate_prepares_a_guarded_copy(self):
        request = {"command": "duplicate", "mode": "proposal",
                   "args": {"document_id": self.pcb, "designators": ["R1"], "dx": 5}}
        run = self.cli("run_command", request)
        self.assertEqual(run.returncode, 0, run.stderr)
        receipt = json.loads(run.stdout)
        proposal = json.loads(Path(receipt["proposal_file"]).read_text())
        self.assertEqual(proposal["source_sha256"], self.source)
        self.assertEqual(receipt["changes"], 1)
        op, = proposal["ops"]
        self.assertEqual((op["op"], op["target"], op["document"]), ("add", "item", self.pcb))
        board = next(doc for doc in read_design(self.path)["documents"] if doc["id"] == self.pcb)
        original = next(item for item in board["items"] if item.get("ref") == "R1")
        result = op["value"]
        self.assertEqual(result["def"], original["def"])
        self.assertAlmostEqual(result["x"], original["x"] + 5)
        self.assertEqual(result["y"], original["y"])
        self.assertNotIn(result["ref"], {item.get("ref") for item in board["items"]})
        self.assertNotIn(result["id"], {item["id"] for item in board["items"]})
        self.assertEqual(authored_files(self.dir), self.fixture)

    def test_write_needs_allow_write_and_is_atomic(self):
        args = {"command": "set_grid", "mode": "write", "args": {"document_id": self.pcb, "grid": 0.5}}
        r = self.cli("run_command", args)
        self.assertEqual(r.returncode, 1)
        self.assertIn("allow-write", r.stderr)
        self.assertEqual(authored_files(self.dir), self.fixture)
        r = self.cli("run_command", args, "--allow-write")
        self.assertEqual(r.returncode, 0, r.stderr)
        receipt = json.loads(r.stdout)
        saved = read_design(self.path)
        self.assertEqual(next(d for d in saved["documents"] if d["id"] == self.pcb)["grid"], 0.5)
        updated = authored_files(self.dir)
        changed = [name for name, raw in self.fixture.items() if updated.get(name) != raw]
        self.assertEqual(set(updated), set(self.fixture))
        self.assertEqual(len(changed), 1)
        self.assertTrue(changed[0].endswith(".wpcb"), changed)
        backup = Path(receipt["backup"])
        self.assertEqual(backup.parent.resolve(), self.dir.resolve() / ".waffle" / "local" / "mcp")
        with zipfile.ZipFile(backup) as archive:
            self.assertEqual(json.loads(archive.read("backup.json"))["source_sha256"], self.source)
            self.assertEqual(set(archive.namelist()), {"backup.json", "previous/" + changed[0]})
            self.assertEqual(archive.read("previous/" + changed[0]), self.fixture[changed[0]])

    def test_cli_and_mcp_commit_only_explicit_staged_project_paths(self):
        def git(*args):
            return subprocess.check_output(["git", "-C", str(self.dir), *args], text=True)

        def mcp(name, arguments, *flags):
            messages = [
                {"jsonrpc": "2.0", "id": 1, "method": "initialize", "params": {"protocolVersion": "2025-06-18"}},
                {"jsonrpc": "2.0", "id": 2, "method": "tools/call", "params": {"name": name, "arguments": arguments}},
            ]
            command = [sys.executable, "-B", str(SERVER), "--project", str(self.path), *flags]
            result = subprocess.run(command, input="".join(json.dumps(row) + "\n" for row in messages),
                                    text=True, capture_output=True, timeout=120)
            self.assertEqual(result.returncode, 0, result.stderr)
            response = next(row["result"] for row in map(json.loads, result.stdout.splitlines()) if row["id"] == 2)
            self.assertFalse(response["isError"], response)
            return json.loads(response["content"][0]["text"])

        git("init", "-q", "-b", "main")
        git("config", "user.name", "Test")
        git("config", "user.email", "test@example.invalid")
        git("add", "--", *self.fixture)
        git("commit", "-qm", "Saved project")
        index = self.dir / ".git" / "index"
        board = next(name for name in self.fixture if name.endswith(".wpcb"))

        for transport, grid in (("cli", 0.5), ("mcp", 0.75)):
            with self.subTest(transport=transport):
                base, original_index = git("rev-parse", "HEAD"), index.read_bytes()
                request = {"command": "set_grid", "mode": "write", "args": {"document_id": self.pcb, "grid": grid}}
                saved = self.cli("run_command", request, "--allow-write")
                self.assertEqual(saved.returncode, 0, saved.stderr)
                self.assertEqual((git("rev-parse", "HEAD"), index.read_bytes()), (base, original_index))
                (self.dir / "unrelated.txt").write_text(transport, encoding="utf-8")
                git("add", "--", board, "unrelated.txt")
                staged_index = index.read_bytes()
                preview = self.cli("git_commit_plan", {})
                self.assertEqual(preview.returncode, 0, preview.stderr)
                plan = json.loads(preview.stdout)
                self.assertEqual(plan["paths"], [{"path": board, "change": "modified"}])
                self.assertEqual(plan["head"], base.strip())
                if transport == "mcp":
                    self.assertEqual(mcp("git_commit_plan", {}), plan)
                self.assertEqual((git("rev-parse", "HEAD"), index.read_bytes()), (base, staged_index))

                args = {"mode": "write", "plan": plan["plan"], "paths": [board], "message": "Publish selected PCB change"}
                denied = self.cli("git_commit", args)
                self.assertEqual(denied.returncode, 1)
                self.assertIn("allow-write", denied.stderr)
                self.assertEqual((git("rev-parse", "HEAD"), index.read_bytes()), (base, staged_index))

                if transport == "cli":
                    committed = self.cli("git_commit", args, "--allow-write")
                    self.assertEqual(committed.returncode, 0, committed.stderr)
                    result = json.loads(committed.stdout)
                else:
                    result = mcp("git_commit", args, "--allow-write")
                self.assertEqual(result["commit"], git("rev-parse", "HEAD").strip())
                self.assertEqual(git("rev-parse", "HEAD^"), base)
                self.assertEqual(git("diff", "--cached", "--name-only"), "unrelated.txt\n")
                self.assertEqual(git("diff", "--name-only", "HEAD^", "HEAD"), board + "\n")
                self.assertEqual(index.read_bytes(), staged_index)

    def test_strict_arguments_and_confinement(self):
        for request, text in [
            ({"command": "align", "args": {"mode": "left", "bogus": 1}}, "unknown field"),
            ({"command": "align", "args": {"mode": "diagonal"}}, "must be one of"),
            ({"command": "nope", "args": {}}, "must be one of"),
            ({"command": "set_grid", "args": {"grid": -1}}, "out of range"),
            ({"command": "align", "args": {"mode": "left", "designators": ["R1", "ZZ9"], "document_id": self.pcb}}, "no component ZZ9"),
            ({"command": "export_dxf", "args": {"output_dir": "../escape"}}, "inside"),
            ({"command": "export_dxf", "args": {"output_dir": "/tmp/x"}}, "inside"),
            ({"command": "repour", "args": {"mode": "write"}}, "on run_command"),
            ({"command": "find_replace", "args": {"query": "(a+)+$" * 40, "regex": True}}, "200 characters"),
        ]:
            r = self.cli("run_command", request)
            self.assertEqual(r.returncode, 1, request)
            self.assertIn(text, r.stderr, request)
        listing = json.loads(self.cli("list_commands", {"command": "teardrops"}).stdout)
        schema = listing["commands"][0]["schema"]
        self.assertFalse(schema["additionalProperties"])
        self.assertIn("teardrops", listing["commands"][0]["actions"])


if __name__ == "__main__":
    unittest.main()
