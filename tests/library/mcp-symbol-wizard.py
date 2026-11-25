"""MCP create_symbol_from_table (Symbol Wizard, app/library/symbol-wizard.js) through the stdio server.

A proposal by default; mode write only with --allow-write; the pin table is untrusted text and
its names come back under untrusted_design_text. Run: python3 tests/library/mcp-symbol-wizard.py
"""
import json
from pathlib import Path
import unittest
import sys as _test_sys
from pathlib import Path as _TestPath
_test_sys.path.insert(0, str((_TestPath(__file__).resolve().parent / "../support").resolve()))
from native_sample import authored_files, read_design
from mcp_stdio import HeadlessFixture

MCU = "\n".join(["Pin name Pin Type", "VDD 1 S", "PA0 / ADC_IN0 2 I/O", "PA1 / ADC_IN1 3 I/O", "NRST 4 I", "VSS 5 S", "NC 6 -"])
OPAMP = "Pin\tName\tType\n1\tOUTA\tO\n2\t-INA\tI\n3\t+INA\tI\n4\tV-\tP\n5\t+INB\tI\n6\t-INB\tI\n7\tOUTB\tO\n8\tV+\tP"


class SymbolWizardMCP(HeadlessFixture):

    def test_create_symbol_from_table(self):
        before = authored_files(self.path.parent)
        self.start()
        tools = {t["name"]: t for t in self.request("tools/list", {})["result"]["tools"]}
        schema = tools["create_symbol_from_table"]["inputSchema"]
        self.assertFalse(schema["additionalProperties"])
        self.assertNotIn("write", schema["properties"]["mode"]["enum"])
        made = self.tool("create_symbol_from_table", {"table": MCU, "name": "Tiny MCU"}, timeout=30)
        self.assertEqual((made["pins"], made["gates"], made["added"]), (6, 1, True))
        self.assertEqual(made["detected"]["mode"], "space")
        self.assertEqual((made["counts"]["no_connect"], made["counts"]["active_low"]), (1, 1))
        untrusted = made["untrusted_design_text"]
        self.assertEqual(untrusted["name"], "Tiny MCU")
        self.assertEqual({p["number"]: p["side"] for p in untrusted["pin_list"]}["1"], "up")
        self.assertEqual({p["number"]: p.get("alternates") for p in untrusted["pin_list"]}["2"], ["ADC_IN0"])
        self.assertNotIn("pin_list", made)
        proposal = json.loads(Path(made["proposal_file"]).read_text())
        self.assertTrue(any(op["op"] == "add" and op["target"] == "library" for op in proposal["ops"]))
        self.assertEqual(authored_files(self.path.parent), before)
        gates = self.tool("create_symbol_from_table", {"table": OPAMP, "layout": "gates", "power_pins": "separate"}, timeout=30)
        self.assertEqual(gates["gates"], 3)
        # Refusals: duplicate numbers, bad roles, unknown fields, writing without --allow-write.
        self.assertIn("appears 2 times", self.tool("create_symbol_from_table", {"table": "1 A\n1 B"}, error=True))
        self.tool("create_symbol_from_table", {"table": "1 A", "columns": {"evil": 0}}, error=True)
        self.tool("create_symbol_from_table", {"table": "1 A", "bogus": True}, error=True)
        self.tool("create_symbol_from_table", {"table": ""}, error=True)
        self.assertIn("allow-write", self.tool("create_symbol_from_table", {"table": MCU, "mode": "write"}, error=True))
        piped = self.tool("pipeline", {"steps": [{"tool": "create_symbol_from_table", "args": {"table": OPAMP, "layout": "gates"}}]}, timeout=30)
        self.assertEqual(json.loads(Path(piped["proposal_file"]).read_text())["summary"]["edits"], ["create_symbol_from_table"])
        self.assertEqual(authored_files(self.path.parent), before)
        # With --allow-write, mode write saves the project.
        self.start("--allow-write")
        written = self.tool("create_symbol_from_table", {"table": OPAMP, "name": "Dual amp", "mode": "write"}, timeout=30)
        self.assertTrue(written["written"])
        saved = read_design(self.path)
        amp = next(d for d in saved["library"] if d["name"] == "Dual amp")
        self.assertEqual(len(amp["symbol"]["pins"]), 8)


if __name__ == "__main__":
    unittest.main(defaultTest="SymbolWizardMCP")
