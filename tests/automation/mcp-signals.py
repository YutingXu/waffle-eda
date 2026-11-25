#!/usr/bin/env python3
"""MCP signals tool (app/editor/signals-panel.js headless) on a native signal project.

Read actions (list, get, suggest, legacy) and edits (declare by nets and by legs, update, flip, tag, split, merge,
remove, accept, decline) through the server, written with --allow-write; the rules tool's set_net_class and the
xsignals tool keep working on a board with a signals store (their writes are folded back into it). The add_net_label
signal directive acts on the board at once.
"""
import importlib.util
from pathlib import Path
import shutil
import tempfile
import unittest
import sys as _test_sys
from pathlib import Path as _TestPath
_test_sys.path.insert(0, str((_TestPath(__file__).resolve().parent / "../support").resolve()))
from native_sample import ensure_native_host, read_design

ROOT = Path(__file__).resolve().parents[2]
FIXTURE = ROOT / "tests" / "fixtures" / "signals" / "signal-board"
_spec = importlib.util.spec_from_file_location("mcp_authoring", ROOT / "tests/automation/mcp-authoring.py")
MA = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(MA)


class Signals(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        ensure_native_host()
        self.path = shutil.copytree(FIXTURE, Path(self.temp.name) / "signals") / "Signals.waffle"
        self.s = MA.Server(self, self.path, True)
        self.addCleanup(self.s.stop)

    def t(self, args, error=False):
        return self.s.tool("signals", dict(args, mode="write") if args.get("action") not in ("list", "get", "suggest", "legacy", "conventions", "complete") else args, error=error)

    def saved(self):
        return read_design(self.path)

    def test_read_and_edit(self):
        listed = {x["name"] for x in self.s.request("tools/list", {})["tools"]}
        self.assertIn("signals", listed)
        rows = self.t({"action": "list", "kind": "diff"})["items"]
        self.assertEqual([r["name"] for r in rows], ["LINK"])
        self.assertEqual([l["parts"] for l in rows[0]["legs"]], [["C3"], ["C4"]])
        link = self.t({"action": "get", "name": "LINK"})
        self.assertEqual([s["name"] for s in link["stages"]], ["LINK", "LINK_C"])
        legacy = self.t({"action": "legacy"})
        self.assertEqual(legacy["netClasses"]["Analog"], ["BUF", "VOUT"])
        # Edits: flip, tag, update, declare by legs, merge-free remove.
        self.t({"action": "flip", "name": "LINK"})
        self.t({"action": "tag", "name": "LINK", "tag": "PCIe"})
        self.t({"action": "update", "name": "OUT", "new_name": "BUFFERED", "add_tags": ["Slow"], "exclude": ["R2"]})
        self.t({"action": "declare", "name": "SUPPLY_SENSE", "legs": [{"nets": ["FILTER"]}]})
        p = self.saved()
        sigs = {s["name"]: s for s in p["signals"]["signals"]}
        self.assertEqual([l["polarity"] for l in sigs["LINK"]["legs"]], [-1, 1])
        self.assertIn("PCIe", sigs["LINK"]["tags"])
        self.assertIn("BUFFERED", sigs)
        self.assertTrue(sigs["BUFFERED"]["exclude"])
        board = next(d for d in p["documents"] if d["kind"] == "pcb")
        self.assertNotIn("rules", board, "classes and pairs are the signal model's, never board rules")
        listed = {r["name"]: r for r in self.t({"action": "list"})["items"] if r["type"] == "signal"}
        self.assertEqual(sorted(listed["LINK"]["nets"]), ["TX_N", "TX_N_C", "TX_P", "TX_P_C"], "the span crosses the series parts")
        self.assertEqual(listed["BUFFERED"]["nets"], ["BUF"], "excluding R2 stops the span at BUF")
        self.t({"action": "remove", "name": "SUPPLY_SENSE"})
        self.assertNotIn("SUPPLY_SENSE", {s["name"] for s in self.saved()["signals"]["signals"]})
        self.assertIn("No signal is named", self.t({"action": "flip", "name": "NOPE"}, error=True))

    def test_suggestions_conventions_completion(self):
        # Suggestions carry their kind, basis and key; declining by key remembers it.
        sug = self.t({"action": "suggest"})["suggestions"]
        self.assertTrue(sug, "the corpus file has rails and grounds to suggest")
        self.assertTrue({g["kind"] for g in sug} <= {"diff", "bus", "rail", "ground"})
        self.assertTrue(all(g["key"] and g["basis"] for g in sug))
        first = sug[0]
        self.t({"action": "decline", "key": first["key"]})
        self.assertNotIn(first["key"], {g["key"] for g in self.t({"action": "suggest"})["suggestions"]})
        self.assertIn(first["key"], self.saved()["signals"]["declined"])
        conv = self.t({"action": "conventions"})
        self.assertEqual({c["id"] for c in conv["learned"]}, {"rail", "activeLow", "pair", "bus", "case"})
        self.assertEqual(conv["lone_n"], "activeLow")
        done = self.t({"action": "complete", "name": "TX_P", "name_kind": "netlabel"})
        self.assertEqual(done["kind"], "netlabel")
        self.assertTrue(all(c["name"].upper().startswith("TX_P") for c in done["completions"]), done)

    def test_legacy_tools_on_a_store(self):
        # The rules tool writes net classes the old way; the signals model folds the write in.
        self.s.tool("propose_rule_change", {"changes": [{"action": "set_net_class", "name": "Clocks", "nets": ["BUF"]}], "mode": "write"})
        self.assertEqual(self.t({"action": "legacy"})["netClasses"]["Clocks"], ["BUF"])
        tags = {r["name"] for r in self.t({"action": "list", "kind": "tags"})["items"]}
        self.assertIn("Clocks", tags)

    def test_directive_is_live(self):
        sch = next(d for d in self.saved()["documents"] if d["kind"] == "schematic")
        self.s.tool("add_net_label", {"sheet": sch["id"], "text": "FILTER", "x": 10, "y": 10, "signal": "FILT", "tags": ["Analog"], "mode": "write"})
        rows = {r["name"]: r for r in self.t({"action": "list", "kind": "single"})["items"]}
        self.assertTrue(rows["FILT"]["derived"])
        self.assertIn("schematic directive", self.t({"action": "flip", "name": "FILT"}, error=True))


if __name__ == "__main__":
    unittest.main()
