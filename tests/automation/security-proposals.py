#!/usr/bin/env python3
"""Proposal field lists agree between the editor and the MCP server.

app/automation/proposal.js owns the version 1 field list (V1_FIELDS) and the code-bearing fields (CODE_FIELDS).
mcp/server.py mirrors V1_FIELDS as EDIT_FIELDS for propose_component_edits; no other module may
define its own copy. The JS side of the regression tests is tests/automation/security-proposals.cjs.

    python3 -I -B tests/automation/security-proposals.py
"""
import json
from pathlib import Path
import re
import subprocess
import sys
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[2]
sys.dont_write_bytecode = True
sys.path.insert(0, str(ROOT / "mcp"))
sys.path.insert(0, str(ROOT / "tests"))

import sys as _test_sys
from pathlib import Path as _TestPath
_test_sys.path.insert(0, str((_TestPath(__file__).resolve().parent / "../support").resolve()))
from native_sample import authored_files, write_design


def js_list(name):
    src = (ROOT / "app/automation/proposal.js").read_text(encoding="utf-8")
    m = re.search(r"const " + name + r" = (?:Object\.freeze\(|new Set\()(\[[^\]]*\])", src)
    assert m, name + " not found in app/automation/proposal.js"
    return json.loads(m.group(1))


class ProposalFields(unittest.TestCase):
    def test_v1_fields_match(self):
        import server
        self.assertEqual(sorted(server.EDIT_FIELDS), sorted(js_list("V1_FIELDS")))
        schema = next(props for name, _, props, _ in server.TOOLS if name == "propose_component_edits")
        self.assertEqual(schema["changes"]["items"]["properties"]["field"]["enum"], sorted(js_list("V1_FIELDS")))

    def test_one_code_field_list(self):
        self.assertEqual(sorted(js_list("CODE_FIELDS")), ["extensions", "hooks", "macros", "plugins", "scripts"])
        generated = ROOT / "app/worker-source.js"
        copies = [p.relative_to(ROOT).as_posix() for d in ("app", "mcp") for p in (ROOT / d).rglob("*.js")
                  if p != generated and "CODE_FIELDS = " in p.read_text(encoding="utf-8", errors="replace")]
        self.assertEqual(copies, ["app/automation/proposal.js"])
        subprocess.run([sys.executable, str(ROOT / "scripts/bundle-worker.py"), "--check"], cwd=ROOT, check=True)

    def test_server_refuses_other_fields(self):
        import server
        project = {"name": "P", "library": [{"id": "d", "kind": "definition", "name": "R"}],
                   "documents": [{"id": "s", "kind": "schematic", "name": "S", "items": [{"id": "p", "kind": "part", "def": "d", "ref": "R1", "value": "1k", "x": 0, "y": 0}]}]}
        with tempfile.TemporaryDirectory() as tmp:
            path = write_design(Path(tmp) / "P.waffle", project)
            before = authored_files(path.parent)
            s = server.Server(path)
            try:
                s.design()
                for field in ("extensions", "scripts", "def", "net", "__proto__"):
                    with self.assertRaises(ValueError, msg=field):
                        s.propose([{"component_id": "p", "field": field, "value": "x"}])
                self.assertEqual(list(Path(tmp).glob("*.waffle-ai")), [])
                self.assertEqual(authored_files(path.parent), before)
            finally:
                s.close()


if __name__ == "__main__":
    unittest.main()
