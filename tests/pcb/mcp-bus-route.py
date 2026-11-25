#!/usr/bin/env python3
"""MCP route_bus (Interactive Bus Routing's engine, app/pcb/bus-route.js) on the DDR4-style fixture.

The native fixture uses the synthetic footprints from tests/pcb/ddr-board.js: a BGA-like
controller U1 and two x8 DRAMs. The byte lane DQ0-7, DQS0 pair and DM0 is routed by net class from U1 to U2 with two
staggered via arrays, pin swaps on U2's DQ bits and group tuning, then DRC must be 0 (clearance, shorts, widths, vias,
matched lengths). A proposal is the default; without --allow-write, write is refused.
"""
import importlib.util
from pathlib import Path
import shutil
import tempfile
import unittest
import sys as _test_sys
from pathlib import Path as _TestPath
_test_sys.path.insert(0, str((_TestPath(__file__).resolve().parent / "../support").resolve()))
from native_sample import authored_files, ensure_native_host, read_design

ROOT = Path(__file__).resolve().parents[2]
FIXTURE = ROOT / "tests" / "fixtures" / "bus" / "ddr4-byte-lane"
_spec = importlib.util.spec_from_file_location("mcp_authoring", ROOT / "tests/automation/mcp-authoring.py")
MA = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(MA)
BYTE = ["DQ0", "DQ1", "DQ2", "DQ3", "DQS0_P", "DQS0_N", "DM0", "DQ4", "DQ5", "DQ6", "DQ7"]


class BusRoute(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        ensure_native_host()
        self.path = shutil.copytree(FIXTURE, Path(self.temp.name) / "ddr") / "Ddr.waffle"

    def server(self, allow_write=True):
        s = MA.Server(self, self.path, allow_write)
        self.addCleanup(s.stop)
        return s

    def test_route_bus_byte_lane_drc_zero(self):
        t = self.server().tool
        listed = {x["name"] for x in self.server().request("tools/list", {})["tools"]}
        self.assertIn("route_bus", listed)
        args = {"net_class": "DDR_BYTE0", "from": [18, 25], "layer": "Top", "conflict": "push", "waypoints": [[22.5, 24.6], [34.5, 24.6]],
                "layer_changes": [{"after": 0, "layer": "Bottom", "pattern": "staggered"}, {"after": 1, "layer": "Top", "pattern": "staggered"}],
                "to": [43, 25], "tune": True, "require_finish": True, "mode": "write"}
        r = t("route_bus", args, timeout=300)
        self.assertTrue(r["done"], r)
        self.assertEqual(r["vias"], 22, r)
        self.assertEqual(len(r["swaps"]), 4, r)
        self.assertTrue(r["tune"]["ok"], r["tune"])
        self.assertEqual(sorted(r["untrusted_design_text"]["nets"]), sorted(BYTE))  # class members are a set (signal model tags)
        drc = t("run_drc", {}, timeout=300)
        self.assertIn("items", drc)
        bad = [v for v in drc["items"] if v["type"] != "unrouted" or any("Net " + n + " " in v.get("title", "") for n in BYTE)]
        self.assertEqual(bad, [], bad[:3])
        self.assertTrue(any(v["type"] == "unrouted" for v in drc["items"]), "other nets stay unrouted, so the filter is live")
        board = next(d for d in read_design(self.path)["documents"] if d["kind"] == "pcb")
        self.assertEqual(sum(1 for i in board["items"] if i["kind"] == "via"), 22)

    def test_route_bus_fly_by(self):
        t = self.server().tool
        r = t("route_bus", {"net_class": "DDR_ADDR", "from": [15, 19], "layer": "Top", "waypoints": [[15, 16], [15, 12], [40, 12], [45, 31], [58, 31]],
                            "layer_changes": [{"after": 0, "layer": "Bottom"}], "visits": [{"after": 2, "to": [45, 20]}], "to": [60, 20], "tune": True,
                            "require_finish": True, "mode": "write"}, timeout=300)
        self.assertEqual(r["loads"], ["U2", "U3"], r)
        self.assertEqual(r["hops"], 2)
        self.assertTrue(r["tune"]["ok"], r["tune"])
        drc = t("run_drc", {}, timeout=300)
        bad = [v for v in drc["items"] if v["type"] != "unrouted" or any("Net " + n + " " in v.get("title", "") for n in ("A0", "A1", "A2", "A3", "BA0", "BA1"))]
        self.assertEqual(bad, [], bad[:3])

    def test_proposal_by_default_and_errors(self):
        before = authored_files(self.path.parent)
        t = self.server(allow_write=False).tool
        r = t("route_bus", {"nets": BYTE, "from": [18, 25], "waypoints": [[30, 24.6]]})
        self.assertEqual(r.get("mode", "proposal"), "proposal")
        self.assertEqual(authored_files(self.path.parent), before)
        self.assertIn("No net class", t("route_bus", {"net_class": "NOPE", "from": [18, 25], "waypoints": [[30, 25]]}, error=True))


if __name__ == "__main__":
    unittest.main()
