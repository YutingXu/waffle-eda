"""Exercise notebook fields and assertion checks through the production MCP dispatcher."""
from pathlib import Path
import sys
import tempfile
import sys as _test_sys
from pathlib import Path as _TestPath
_test_sys.path.insert(0, str((_TestPath(__file__).resolve().parent / "../support").resolve()))
from native_sample import authored_files, write_design

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "mcp"))
from board_runner import BoardRunner
from server import Server

note = {"id": "memo", "kind": "textframe", "x": 0, "y": 0, "w": 40, "h": 18, "text": "Owner {sheet.Owner}",
        "richText": {"font": "serif", "blocks": [{"style": "paragraph", "runs": [
            {"type": "text", "text": "Owner "},
            {"type": "field", "expression": "sheet.Owner", "binding": {"scope": "sheet", "docId": "bench", "field": "owner"}}]}]}}
project = {"name": "Review", "library": [],
           "documents": [{"id": "bench", "kind": "schematic", "name": "Bench", "grid": 2.54, "outline": [], "notes": [],
                          "parameters": {"Owner": "Analogue team"}, "items": [note]}]}
origin = {"kind": "calculation", "sheet": "bench", "object": "calculation", "assertion": "limit"}
calculation = {"id": "calculation", "kind": "textframe", "x": 0, "y": 20, "w": 50, "h": 18, "text": "3.4 V",
               "calculation": {"languageVersion": 1, "bindings": [], "assertions": [
                   {"id": "limit", "source": "assert 3.4 V <= 3.3 V", "bindings": []}]}}
assertions = {**project, "documents": [{**project["documents"][0], "items": [calculation]}],
              "rules": {"format": "atrium-rules", "version": 3, "units": "mm", "list": [
                  {"type": "ercCalculationAssertion", "id": "limit-rule", "name": "Voltage limit", "where": "schematic",
                   "sheets": ["bench"], "origin": origin, "severity": "error", "enabled": True,
                   "priority": 1, "scope": {"kind": "all"}}]}}

with tempfile.TemporaryDirectory() as directory:
    path = write_design(Path(directory) / "fields" / "Review.waffle", project)
    assertion_path = write_design(Path(directory) / "assertions" / "Assertions.waffle", assertions)
    initial = authored_files(directory)
    backends = sys.argv[1:] or ["node", "jsc"]
    passed = 0
    for backend in backends:
        try:
            runner = BoardRunner(backend=backend)
        except ValueError:
            if len(backends) == 1:
                raise
            continue
        server = Server(path)
        server.board_runner = runner
        try:
            result = server.automation.call("list_notebook", {"document_id": "bench", "item_id": "memo"})
            row = result["rows"][0]
            assert result["total"] == 1 and row["itemId"] == "memo" and row["text"] == "Owner Analogue team"
            assert row["fields"][0]["broken"] is False
            assert authored_files(directory) == initial
            print("PASS read-only notebook fields through", runner.backend)
            passed += 1
        finally:
            server.close()
        runner = BoardRunner(backend=backend)
        server = Server(assertion_path)
        server.board_runner = runner
        try:
            assert server.automation.call("waivers", {})["total"] == 0  # The engine is cold on this first call.
            checked = server.automation.call("check", {"domains": ["schematic"], "hints": False})
            finding, = checked["items"]
            assert finding["rule_id"] == "limit-rule" and finding["origin"] == origin
            assert finding["assertion"]["status"] == "fail"
            erc = server.automation.call("run_erc", {})
            assert erc["by_check"] == {"calculationAssertion": 1}
            assert authored_files(directory) == initial
            print("PASS cold waiver list and shared assertion finding through", runner.backend)
        finally:
            server.close()
    assert passed
