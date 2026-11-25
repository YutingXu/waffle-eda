"""ECAD-MCAD through the MCP server (mcp/mcad.py, docs/mcad.md):

- mcad_status is read-only, and with an enclosure STEP inside the project folder reports the
  component that collides with the enclosure boss;
- export_idx writes only into <project>-outputs/mcad/ and records the baseline as a proposal;
  with --allow-write and mode write, the project file gets the baseline;
- import_mcad_changes returns an MCAD edit's proposals; accepting finishes as a proposal or a write;
- files outside the project folder, unsupported files and XML with a DOCTYPE are refused.

Usage: python3 tests/formats/mcad-mcp.py [-v]
"""
import importlib.util
from pathlib import Path
import re
import shutil
import sys
import tempfile
import unittest
import sys as _test_sys
from pathlib import Path as _TestPath
_test_sys.path.insert(0, str((_TestPath(__file__).resolve().parent / "../support").resolve()))
from native_sample import authored_files, ensure_native_host, read_design

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "tests"))
_spec = importlib.util.spec_from_file_location("mcp_authoring", ROOT / "tests/automation/mcp-authoring.py")
_mod = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(_mod)
Server = _mod.Server
FIX = ROOT / "tests" / "fixtures" / "mcad"


class MCADTools(unittest.TestCase):
    def setUp(self):
        self.dir = Path(tempfile.mkdtemp(prefix="atrium-mcad-")).resolve()
        ensure_native_host()
        shutil.copytree(FIX / "native", self.dir, dirs_exist_ok=True)
        self.path = self.dir / "Board.waffle"
        shutil.copy(FIX / "tray.step", self.dir / "tray.step")
        self.server = Server(self, self.path, True)

    def tearDown(self):
        self.server.stop()
        shutil.rmtree(self.dir, ignore_errors=True)

    def call(self, name, args):
        return self.server.tool(name, args)

    def test_status_and_enclosure(self):
        before = authored_files(self.dir)
        s = self.call("mcad_status", {})
        self.assertIsNone(s["baseline"])
        self.assertEqual(s["board"]["parts"], 3)
        c = self.call("mcad_status", {"enclosure": "tray.step", "gap": 0.5, "derive": {"mode": "face", "z": 5, "up": False}})
        self.assertEqual(c["clearance"]["untrusted_design_text"]["designators"], ["J1"])
        self.assertEqual(c["clearance"]["findings"][0]["kind"], "collision")
        self.assertEqual([p["kind"] for p in c["derived"]["proposals"]], ["keepout-add"])
        self.assertEqual(authored_files(self.dir), before, "mcad_status changes nothing")
        self.assertFalse(list(self.dir.glob("*.waffle-ai")))

    def test_export_import_round_trip(self):
        out = self.call("export_idx", {"kind": "baseline", "date": "2026-11-19T12:00:00"})
        idx = Path(out["files"][0]["path"])
        self.assertEqual(idx.parent, self.dir / "Board-outputs" / "mcad")
        self.assertEqual(out["problems"], [])
        self.assertEqual(idx.read_text(), (FIX / "baseline.idx").read_text(), "the same baseline as the golden")
        self.assertTrue(out["proposal_file"].endswith(".waffle-ai"), out)
        # Write the baseline into the project, then simulate an MCAD move of R1.
        out = self.call("export_idx", {"kind": "baseline", "date": "2026-11-19T12:00:00", "mode": "write"})
        self.assertEqual(read_design(self.path)["documents"][0]["mcad"]["baseline"]["seq"], 1)
        text = idx.read_text()
        m = re.search(r'<foundation:Item id="IT_\d+" geometryType="COMPONENT">\s*<foundation:Name>R1</foundation:Name>[\s\S]*?</foundation:Item>', text)
        edited = text.replace(m.group(0), re.sub(r"(<pdm:tx>\s*<property:Value>)10<", r"\g<1>13<", m.group(0)))
        (self.dir / "from-mcad.idx").write_text(edited)
        r = self.call("import_mcad_changes", {"path": "from-mcad.idx"})
        self.assertEqual([p["kind"] for p in r["proposals"]], ["place"])
        self.assertEqual(r["proposals"][0]["after"]["x"], 13)
        self.assertEqual(r["untrusted_design_text"]["labels"], ["R1 moved"])
        self.assertTrue(r["proposal_file"].endswith(".waffle-ai"))
        r = self.call("import_mcad_changes", {"path": "from-mcad.idx", "accept": "all", "mode": "write"})
        self.assertEqual(r["accepted"], [r["proposals"][0]["id"]])
        saved = read_design(self.path)
        self.assertEqual(next(i for i in saved["documents"][0]["items"] if i["id"] == "pR1")["x"], 13)
        self.assertEqual(self.call("mcad_status", {})["inbox"]["accepted"], 1)
        resp = self.call("export_idx", {"kind": "response", "date": "2026-11-19T12:00:00"})
        self.assertEqual((resp["stats"]["accepted"], resp["stats"]["rejected"]), (1, 0))
        self.assertNotIn("proposal_file", resp, "a response records nothing in the project")
        idf = self.call("export_idx", {"kind": "idf", "date": "2026-11-19T12:00:00"})
        self.assertEqual(sorted(Path(f["path"]).suffix for f in idf["files"]), [".emn", ".emp"])

    def test_refusals(self):
        (self.dir / "bad.idx").write_text('<?xml version="1.0"?><!DOCTYPE x [<!ENTITY e SYSTEM "file:///etc/passwd">]><x>&e;</x>')
        for args, pattern in [({"path": "../outside.idx"}, "inside"), ({"path": "/etc/hosts"}, "inside"), ({"path": "tray.txt"}, "Unsupported"),
                              ({"path": "bad.idx"}, "document type declaration"), ({}, "path")]:
            text = self.server.tool("import_mcad_changes", args, error=True)
            self.assertIn(pattern, text)
        self.server.tool("export_idx", {"kind": "baseline", "output_dir": "../x"}, error=True)


if __name__ == "__main__":
    unittest.main()
