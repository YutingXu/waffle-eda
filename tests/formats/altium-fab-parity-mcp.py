"""Altium fabrication parity through the MCP server (the path an AI client takes).

Copies the real Altium fixture (tests/fixtures/altium/pidp11-io-expander, BSD-2-Clause, see its
NOTICE) into a scratch folder, imports it with `import_design` (source_rules "use") and writes
Gerber and drill files with `generate_fabrication`, both through `mcp/server.py --cli`. Then
tests/formats/altium-fab-parity.cjs --mcp-dir checks that every file equals, byte for byte apart from the
creation date, what the app's Fabrication Outputs writes for the same import; that file's main
run compares those outputs with Altium Designer's own Gerbers and drill file.

Run: python3 tests/formats/altium-fab-parity-mcp.py
"""
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
from native_sample import write_design

ROOT = Path(__file__).resolve().parents[2]
SERVER = ROOT / "mcp" / "server.py"
FIXTURE = ROOT / "tests" / "fixtures" / "altium" / "pidp11-io-expander"
NAMES = ["PCB-PiDP11IOExpander.PrjPcb", "PiDP11IOExpander.SchDoc", "PiDP11IOExpander.PcbDoc"]
JSC = Path("/System/Library/Frameworks/JavaScriptCore.framework/Versions/Current/Helpers/jsc")
# Two empty native documents bind the server to a separate project before import.
SEED = {"name": "Seed", "library": [], "documents": [
    {"id": "s", "kind": "schematic", "name": "Schematic", "grid": 1.27, "items": [], "outline": [], "notes": []},
    {"id": "b", "kind": "pcb", "name": "Board layout", "grid": 0.25, "items": [], "outline": [], "notes": []}]}


def js(script, *args):
    """Runs a test script under JavaScriptCore (macOS) or Node."""
    if JSC.exists():
        cmd = [str(ROOT / "scripts/test-jsc.sh"), str(script.relative_to(ROOT)), "--", *args]
    elif shutil.which("node"):
        cmd = ["node", str(script), *args]
    else:
        raise unittest.SkipTest("neither JavaScriptCore nor Node is available")
    return subprocess.run(cmd, capture_output=True, text=True, timeout=120)


class AltiumFabParityMCP(unittest.TestCase):
    def cli(self, project, tool, args):
        result = subprocess.run([sys.executable, "-B", str(SERVER), "--project", str(project), "--cli", tool, "--args", json.dumps(args)],
                                capture_output=True, text=True, timeout=120)
        self.assertEqual(result.returncode, 0, result.stderr)
        return json.loads(result.stdout)

    def test_mcp_outputs_equal_the_app_outputs(self):
        with tempfile.TemporaryDirectory() as tmp:
            folder = Path(tmp)
            for name in NAMES:
                shutil.copyfile(FIXTURE / name, folder / name)
            seed = write_design(folder / "Seed.waffle", SEED)
            imported = self.cli(seed, "import_design", {"paths": NAMES, "name": "PiDP", "source_rules": "use", "target_format": "2.0"})
            self.assertEqual(imported["format"], "2.0")
            self.assertTrue(imported["source_rules"][0]["applied"], imported.get("source_rules"))
            fab = self.cli(Path(imported["path"]), "generate_fabrication", {"date": "2026-06-15T12:00:00Z", "include": ["gerber", "drill"], "output_dir": "fab"})
            paths = [Path(f["path"]) for f in fab["files"]]
            self.assertEqual(sorted(p.suffix for p in paths), sorted([".GBL", ".GBO", ".GBS", ".GM1", ".GTL", ".GTO", ".GTP", ".GTS", ".TXT", ".TXT"]))
            result = js(ROOT / "tests/formats/altium-fab-parity.cjs", "--mcp-dir=" + str(paths[0].parent), "--mcp-stem=PiDP")
            out = result.stdout + result.stderr
            self.assertEqual(result.returncode, 0, out[-3000:])
            self.assertIn("equal the app's Fabrication Outputs", out, out[-3000:])
            self.assertNotIn("SHIM-FAIL", out, out[-3000:])


if __name__ == "__main__":
    unittest.main()
