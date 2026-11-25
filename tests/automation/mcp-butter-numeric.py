"""Exercise the opt-in numeric command set over MCP stdio using saved Format 2."""
import json
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

import sys as _test_sys
from pathlib import Path as _TestPath
_test_sys.path.insert(0, str((_TestPath(__file__).resolve().parent / "../support").resolve()))
from native_sample import ROOT, authored_files, ensure_native_host


class NumericMCP(unittest.TestCase):
    def setUp(self):
        ensure_native_host()
        scratch = tempfile.TemporaryDirectory(prefix="waffle-numeric-mcp-")
        self.addCleanup(scratch.cleanup)
        self.root = Path(scratch.name) / "design"
        shutil.copytree(ROOT / "tests/fixtures/cad-native/calculation", self.root)

    def open_server(self, access, enable=True, *, manifest=None, extra_features=()):
        features = (("numericFields",) if enable else ()) + tuple(extra_features)
        flags = [arg for feature in features for arg in ("--enable-butter", feature)]
        process = subprocess.Popen([sys.executable, str(ROOT / "mcp/server.py"), "--project",
                                    str(manifest or self.root / "Project.waffle"), access, *flags],
                                   text=True, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE)

        def stop():
            process.stdin.close()
            try:
                process.wait(timeout=10)
            finally:
                if process.poll() is None:
                    process.kill()
                    process.wait()
                process.stdout.close()
                process.stderr.close()

        self.addCleanup(stop)
        seq = 0

        def call(method, params):
            nonlocal seq
            seq += 1
            process.stdin.write(json.dumps({"jsonrpc": "2.0", "id": seq, "method": method, "params": params}) + "\n")
            process.stdin.flush()
            response = json.loads(process.stdout.readline())
            self.assertEqual(response.get("id"), seq, response)
            return response["result"]

        call("initialize", {"protocolVersion": "2025-11-25"})
        return call

    def tool(self, call, name, args=None, error=None):
        response = call("tools/call", {"name": name, "arguments": args or {}})
        result = response["structuredContent"] if "structuredContent" in response else json.loads(response["content"][0]["text"])
        if error:
            self.assertTrue(response["isError"], result)
            self.assertEqual(result["error"]["code"], error, result)
            return result["error"]
        self.assertFalse(response.get("isError"), result)
        return result

    @unittest.skipUnless((ROOT / "app/notebook/table-data.js").is_file(), "Needs the combined Task 42 and 53 sources.")
    def test_numeric_only_session_reads_and_writes_native_table_cell(self):
        folder = self.root / "paired"
        folder.mkdir()
        fixture = subprocess.check_output(["node", str(ROOT / "tests/notebook/butter-tables-commands.cjs"),
                                          "--fixture", str(folder)], text=True)
        info = json.loads(fixture)
        manifest, sheet = folder / "Tables.waffle", folder / info["member"]
        doc = {"documentId": info["documentId"]}
        setup = self.open_server("--allow-write", manifest=manifest, extra_features=("tables",))

        def run(call, feature, identifier, args, mode="read"):
            result = self.tool(call, "run_command", {"command": "butter." + feature + "." + identifier,
                                                   "args": args, "mode": mode})
            return {**result, **result.get("untrusted_design_text", {})}

        run(setup, "tables", "upgrade", {**doc, "itemId": info["itemId"]}, "write")
        table = run(setup, "tables", "create", {**doc, "x": 5, "y": 6, "rows": 2, "columns": 2}, "write")
        owner = {**doc, "itemId": table["itemId"]}
        grid = run(setup, "tables", "describe", owner)
        row, column = grid["rows"][0]["id"], grid["columns"][0]["id"]
        run(setup, "tables", "edit-axis", {**owner, "axis": "columns", "axisId": column,
                                          "action": "configure", "attributes": {"unit": "Ω"}}, "write")
        first = self.open_server("--allow-write", manifest=manifest)
        target = {"scope": "item", **owner, "path": ["cells", row, column, "value"]}
        blank = run(first, "numericFields", "inspect", {"target": target})
        self.assertIsNone(blank["value"])
        self.assertEqual(blank["spec"]["unit"], "Ω")
        old_sheet, old_manifest = sheet.read_bytes(), manifest.read_bytes()
        materialized = run(first, "numericFields", "set", {"target": target, "source": "2000 Ω + 1 kΩ"}, "write")
        self.assertTrue(materialized["ok"])
        self.assertEqual(materialized["value"], 3000)
        self.assertEqual(manifest.read_bytes(), old_manifest)
        self.assertEqual(set(old_sheet.splitlines()) - set(sheet.read_bytes().splitlines()), set())
        added, = set(sheet.read_bytes().splitlines()) - set(old_sheet.splitlines())
        self.assertEqual(json.loads(added)["kind"], "tableCell")
        bound = run(first, "numericFields", "set", {"target": target, "source": "= 5 kΩ"}, "write")
        self.assertTrue(bound["ok"])
        second = self.open_server("--allow-write", manifest=manifest)
        reopened = run(second, "numericFields", "inspect", {"target": target})
        self.assertEqual((reopened["value"], reopened["binding"]["source"]), ("5000", " 5 kΩ"))
        saved_owner = sheet.read_bytes()
        run(second, "numericFields", "clear", {"target": target}, "write")
        self.assertIsNone(run(second, "numericFields", "inspect", {"target": target})["binding"])
        self.assertEqual(sheet.read_bytes(), saved_owner)

    def test_source_edit_updates_bound_native_field_before_save(self):
        write = self.open_server("--allow-write")
        grid = {"scope": "document", "documentId": "timing", "path": ["grid"]}
        value = {"scope": "item", "documentId": "timing", "itemId": "r5", "path": ["value"]}

        def run(call, command, target, source=None):
            args = {"target": target}
            options = {"command": "butter.numericFields." + command, "args": args}
            if source is not None:
                args["source"] = source
            if command == "set":
                options["mode"] = "write"
            result = self.tool(call, "run_command", options)
            return {**result, **result.get("untrusted_design_text", {})}

        self.assertEqual(run(write, "set", grid, "= count(part) * 1 mm")["value"], 2)
        generic = self.open_server("--allow-write", enable=False)
        self.tool(generic, "delete_items", {"document_id": "timing", "ids": ["c3"], "mode": "write"})
        self.assertEqual(run(write, "inspect", grid)["value"], 1)
        expression = "= R5.Value / 1 kΩ * 1 mm"
        self.assertEqual(run(write, "set", grid, expression)["value"], 10)
        self.assertEqual(run(write, "set", value, "22 kΩ")["value"], 22000)
        self.assertEqual(run(write, "inspect", grid)["value"], 22)
        fresh = self.open_server("--read-only")
        self.assertEqual(run(fresh, "inspect", grid)["value"], 22)
        self.assertEqual(run(fresh, "evaluate", grid, expression)["value"], 22)

    def test_flag_unit_diagnostic_scoped_writes_and_reopen(self):
        target = {"scope": "item", "documentId": "timing", "itemId": "r5", "path": ["value"]}
        before = authored_files(self.root)
        none = self.open_server("--read-only", enable=False)

        def command(call, identifier, args, mode=None, error=None):
            options = {"command": "butter.numericFields." + identifier, "args": args}
            if mode:
                options["mode"] = mode
            result = self.tool(call, "run_command", options, error=error)
            return {**result, **result.get("untrusted_design_text", {})}

        command(none, "inspect", {"target": target}, error="butter_disabled")
        self.assertEqual(authored_files(self.root), before)
        read = self.open_server("--read-only")
        catalogue = self.tool(read, "list_commands")
        for name in ("evaluate", "inspect", "set", "clear"):
            self.assertIn("butter.numericFields." + name, json.dumps(catalogue))
        self.assertEqual(command(read, "inspect", {"target": target})["value"], "10k")
        self.assertEqual(command(read, "evaluate", {"source": "10mil + 0.1mm", "unit": "mm"})["value"], .354)
        counted = command(read, "evaluate", {"source": "count(part) * 0.1 mm",
                                              "target": {"scope": "item", "documentId": "timing",
                                                         "itemId": "r5", "path": ["x"]}})
        self.assertEqual(counted["value"], .2)
        invalid = command(read, "evaluate", {"source": "=1 V", "target": target})
        self.assertEqual(invalid["diagnostic"]["span"], [1, 4])
        command(read, "set", {"target": target, "source": "11 kΩ"}, mode="write", error="write_not_allowed")
        self.assertEqual(authored_files(self.root), before)

        write = self.open_server("--allow-write")
        changed = command(write, "set", {"target": target, "source": "= 22 kΩ"}, mode="write")
        self.assertTrue(changed["ok"])
        self.assertEqual(changed["value"], 22000)
        current = command(write, "inspect", {"target": target})
        self.assertEqual(current["value"], "22000")
        self.assertEqual(current["binding"]["source"], " 22 kΩ")
        after = authored_files(self.root)
        self.assertEqual({name for name in before if before[name] != after[name]}, {"Timing.wsch", "Project.waffle"})
        fresh = self.open_server("--allow-write")
        self.assertEqual(command(fresh, "inspect", {"target": target})["binding"], current["binding"])
        cleared = command(fresh, "clear", {"target": target}, mode="write")
        self.assertTrue(cleared["ok"])
        inspected = command(fresh, "inspect", {"target": target})
        self.assertIsNone(inspected["binding"])
        self.assertEqual(inspected["value"], "22000")
        self.assertEqual(authored_files(self.root)["Timing.wsch"], after["Timing.wsch"])


if __name__ == "__main__":
    unittest.main()
