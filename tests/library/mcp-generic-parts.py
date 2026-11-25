"""MCP place_generic_part, edit_generic_part and list_generic_parts (app/library/generic-parts.js) through the stdio server.

Proposals by default; mode write only with --allow-write; design text under untrusted_design_text;
binding needs a library part with an MPN (never a made-up number). Run: python3 tests/library/mcp-generic-parts.py
"""
import json
from pathlib import Path
import unittest
import sys as _test_sys
from pathlib import Path as _TestPath
_test_sys.path.insert(0, str((_TestPath(__file__).resolve().parent / "../support").resolve()))
from native_sample import authored_files, read_design
from mcp_stdio import HeadlessFixture


class GenericPartsMCP(HeadlessFixture):

    def test_generic_parts(self):
        before = authored_files(self.path.parent)
        self.start()
        tools = {t["name"]: t for t in self.request("tools/list", {})["result"]["tools"]}
        for name in ("place_generic_part", "edit_generic_part", "list_generic_parts"):
            self.assertFalse(tools[name]["inputSchema"]["additionalProperties"], name)
        self.assertNotIn("write", tools["place_generic_part"]["inputSchema"]["properties"]["mode"]["enum"])
        made = self.tool("place_generic_part", {"family": "resistor", "value": "4k7", "package": "0603", "x": 200, "y": 200}, timeout=60)
        self.assertEqual((made["family"], made["package"], made["footprint"]), ("resistor", "0603", "RESC1608X55N"))
        self.assertEqual(made["untrusted_design_text"]["value"], "4.7 kΩ")
        proposal = json.loads(Path(made["proposal_file"]).read_text())
        self.assertTrue(proposal["ops"])
        self.assertEqual(authored_files(self.path.parent), before, "a proposal leaves the project alone")
        hdr = self.tool("place_generic_part", {"family": "connector", "type": "header", "rows": 2, "cols": 5, "x": 220, "y": 200}, timeout=60)
        self.assertEqual((hdr["pins"], hdr["rows"], hdr["cols"]), (10, 2, 5))
        # Refusals: unknown family, bad package, bad value, unknown fields, writing without --allow-write.
        self.assertIn("must be one of", self.tool("place_generic_part", {"family": "connector", "type": "nope"}, error=True))
        self.assertIn("row", self.tool("place_generic_part", {"family": "connector", "type": "box", "rows": 3}, error=True))
        self.assertIn("has no package", self.tool("place_generic_part", {"family": "resistor", "package": "9999"}, error=True))
        self.assertIn("Can't read the value", self.tool("place_generic_part", {"family": "capacitor", "value": "lots"}, error=True))
        self.tool("place_generic_part", {"family": "resistor", "bogus": 1}, error=True)
        self.assertIn("allow-write", self.tool("place_generic_part", {"family": "resistor", "mode": "write"}, error=True))
        self.tool("edit_generic_part", {"value": "1k"}, error=True)
        listed = self.tool("list_generic_parts", {"family": "diode"}, timeout=60)
        self.assertIn("SOD-123", listed["packages"])
        # With --allow-write: place, edit, bind to nothing (refused) and list.
        self.start("--allow-write")
        w = self.tool("place_generic_part", {"family": "capacitor", "value": "100n", "designator": "C90", "mode": "write"}, timeout=60)
        self.assertTrue(w["written"])
        e = self.tool("edit_generic_part", {"designator": "C90", "value": "2u2", "package": "0805", "parameters": {"Dielectric": "X5R"}, "mode": "write"}, timeout=60)
        self.assertTrue(e["regenerated"])
        saved = read_design(self.path)
        c90 = next(i for d in saved["documents"] for i in d["items"] if i.get("ref") == "C90")
        self.assertEqual((c90["value"], c90["parameters"]["Dielectric"]), ("2.2 µF", "X5R"))
        gen = next(d for d in saved["library"] if d["id"] == c90["def"])
        self.assertEqual((gen["generic"]["family"], gen["generic"]["package"]), ("capacitor", "0805"))
        self.assertIn("not a match", self.tool("edit_generic_part", {"designator": "C90", "bind_def_id": "invented-part", "mode": "write"}, error=True))
        one = self.tool("list_generic_parts", {"designator": "C90", "candidates": True}, timeout=60)
        self.assertEqual(one["part"]["candidates"], [])
        self.assertEqual(one["part"]["untrusted_design_text"]["value"], "2.2 µF")
        # Placeholders: function-tagged pins, provisional footprint, no MPN; resolving to an invented id is refused.
        ph = self.tool("place_generic_part", {"family": "opamp", "params": {"units": 2}, "package": "SOIC-8", "designator": "U90", "mode": "write"}, timeout=60)
        self.assertEqual((ph["role"], ph["gates"], ph["provisional"]), ("placeholder", 2, True))
        saved = read_design(self.path)
        u90 = next(i for d in saved["documents"] for i in d["items"] if i.get("ref") == "U90")
        self.assertFalse(any("mpn" in k.lower() for k in (u90.get("parameters") or {})))
        pdef = next(d for d in saved["library"] if d["id"] == u90["def"])
        self.assertEqual(sorted({p.get("fn") for p in pdef["symbol"]["pins"] if p.get("fn")}), ["IN+", "IN-", "OUT", "V+", "V-"])
        listed = self.tool("list_generic_parts", {"designator": "U90", "candidates": True}, timeout=60)
        self.assertIsInstance(listed["part"]["resolve_candidates"], list)
        self.assertIn("not a candidate", self.tool("edit_generic_part", {"designator": "U90", "resolve_def_id": "invented-part", "mode": "write"}, error=True))


if __name__ == "__main__":
    unittest.main(defaultTest="GenericPartsMCP")
