"""Read-only CLI checks for saved native calculations, query counts and assertion scopes."""
from pathlib import Path
import json
import shutil
import tempfile
import unittest

import sys as _test_sys
from pathlib import Path as _TestPath
_test_sys.path.insert(0, str((_TestPath(__file__).resolve().parent / "../support").resolve()))
from native_sample import ROOT, authored_files, ensure_native_host, read_design, write_design
from board_runner import BoardRunner
from server import Server, ToolError


class CalculationQueryCLI(unittest.TestCase):
    def test_saved_assertion_scope_in_erc_response(self):
        ensure_native_host()
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            shutil.copytree(ROOT / "tests/fixtures/cad-native/calculation", root, dirs_exist_ok=True)
            manifest = root / "Project.waffle"
            model = read_design(manifest)
            sheet = model["documents"][0]
            block = next(item for item in sheet["items"] if item["id"] == "corner")
            block["calculation"]["assertions"] = [{"id": "limit", "source": "assert 1 < 2", "bindings": []}]
            rule = {"id": "corner-limit", "type": "ercCalculationAssertion", "name": "Corner limit",
                    "enabled": True, "priority": 1, "severity": "warning", "where": "schematic", "sheets": [sheet["id"]],
                    "origin": {"kind": "calculation", "sheet": sheet["id"], "object": block["id"], "assertion": "limit"},
                    "scope": {"languageVersion": 1, "source": "object"}}
            model["rules"] = {"format": "atrium-rules", "version": 3, "units": "mm", "list": [rule]}
            write_design(manifest, model)
            source = "object when future"
            for version in (1, 2):
                if version == 2:
                    # A later writer stored a scope that this reader must preserve.
                    rows = [json.loads(line) for line in manifest.read_text().splitlines()]
                    row = next(row for row in rows if row["id"] == rule["id"])
                    row["value"]["scope"] = {"languageVersion": version, "source": source}
                    manifest.write_text("".join(json.dumps(row, ensure_ascii=False, separators=(",", ":")) + "\n" for row in rows))
                before = authored_files(root)
                for backend in (None, "node"):
                    with self.subTest(version=version, backend=backend):
                        server = Server(manifest, read_only=True)
                        try:
                            server.board_runner = BoardRunner(backend=backend)
                            report = server.call("run_erc", {"limit": 1, "checks": ["calculationAssertion"]})
                            if version == 1:
                                self.assertTrue(report["passed"])
                                self.assertNotIn("complete", report)
                                self.assertNotIn("diagnostics", report)
                                self.assertFalse(report["classes"])
                            else:
                                self.assertFalse(report["passed"])
                                self.assertIs(report["complete"], False)
                                issue, = report["diagnostics"]
                                self.assertEqual((issue["code"], issue["ruleId"], issue["side"], issue["span"]),
                                                 ("language-version", rule["id"], "scope", [0, len(source)]))
                                self.assertEqual(issue["documentId"], sheet["id"])
                                finding, = report["classes"]["Error"]["items"]
                                self.assertEqual((finding["document_id"], finding["object_id"], finding["at"]),
                                                 (sheet["id"], block["id"], [block["x"], block["y"]]))
                                hidden = server.call("run_erc", {"classes": ["Info"], "limit": 1})
                                self.assertFalse(hidden["passed"])
                                self.assertIs(hidden["complete"], False)
                                self.assertEqual(hidden["diagnostics"], [issue])
                                checks = server.call("check", {"domains": ["schematic"], "merge": False})
                                target = next(row for row in checks["items"] if row.get("rule_id") == rule["id"])
                                with self.assertRaises(ToolError) as denied:
                                    server.call("waive", {"violation_key": target["key"], "note": "Reviewed"})
                                self.assertEqual(denied.exception.code, "read_only")
                        finally:
                            server.close()
                self.assertEqual(authored_files(root), before)

    def test_first_read_on_saved_and_ad_hoc_calculations(self):
        ensure_native_host()
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            shutil.copytree(ROOT / "tests/fixtures/cad-native/calculation", root, dirs_exist_ok=True)
            manifest = root / "Project.waffle"
            model = read_design(manifest)
            rows = model["documents"][0]["items"]
            block = next(row for row in rows if row["id"] == "corner")
            block["text"] = "count(resistor) * 20 mA"
            block["calculation"] = {"languageVersion": 1, "bindings": [], "assertions": []}
            rows.append({**block, "id": "missing", "text": "R404 * 2"})
            capacitor = next(row for row in rows if row["id"] == "c3")
            for i in range(2048):
                rows.append({**capacitor, "id": "cap-" + str(i), "ref": "C" + str(i + 1000)})
            write_design(manifest, model)
            before = authored_files(root)
            for backend in (None, "node"):
                with self.subTest(backend=backend):
                    server = Server(root / "Project.waffle", read_only=True)
                    try:
                        server.board_runner = BoardRunner(backend=backend)
                        def call(**options):
                            return server.call("calculate", {"document_id": "timing", **options})

                        saved = call(block_id="corner")
                        self.assertEqual(saved["records"][0]["result"]["display"], "20 mA")
                        self.assertEqual(call(expression="count(part)")["result"]["display"], "2050 ea")
                        self.assertEqual(call(expression="assert count(resistor) = 1 pcs")["result"]["assertion"]["status"], "pass")
                        invalid = call(expression="count(track where width < 20 mA)")["result"]
                        self.assertEqual(invalid["diagnostic"]["span"], [26,31])
                        broken = call(block_id="missing")["records"][0]["result"]
                        self.assertEqual((broken["diagnostic"]["code"], broken["diagnostic"]["span"]), ("unbound", [0,4]))
                        self.assertEqual(call(expression="R5 * 2")["result"]["display"], "20 kΩ")
                        self.assertEqual(server.digest, saved["file_revision"])
                    finally:
                        server.close()
            self.assertEqual(authored_files(root), before)


if __name__ == "__main__":
    unittest.main()
