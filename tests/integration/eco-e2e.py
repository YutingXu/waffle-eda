"""End to end through MCP, headless: an empty project becomes a routed, DRC-clean board with outputs.

Builds a small sensor input stage (input header, RC low-pass, series resistor, decoupling and an
output header) with place_part, add_wire, add_net_label and add_power_port; runs update_pcb (ECO v2),
set_board_outline, move_component, autoroute, run_drc and run_output_job; and requires
0 unrouted connections and 0 DRC violations. The server runs with --allow-write and each editing
call asks for mode "write", so it applies directly.

Usage: python3 tests/integration/eco-e2e.py [-v]
"""
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

import sys as _test_sys
from pathlib import Path as _TestPath
_test_sys.path.insert(0, str((_TestPath(__file__).resolve().parent / "../support").resolve()))
from native_sample import authored_files, read_design, write_design
from mcp_stdio import Client, close_stdio

ROOT = Path(__file__).resolve().parents[2]
SERVER = ROOT / "mcp" / "server.py"


class EndToEnd(Client, unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.dir = Path(self.temp.name)
        self.path = self.dir / "Buffer.waffle"
        empty = {"format": "atrium", "version": 1, "name": "Buffer", "library": [], "documents": [
            {"id": "sch", "kind": "schematic", "name": "Input stage", "grid": 1.27, "items": [], "outline": [], "notes": []},
            {"id": "pcb", "kind": "pcb", "name": "Buffer board", "grid": 0.25, "items": [], "outline": [], "notes": []}]}
        write_design(self.path, empty)
        self.proc = subprocess.Popen([sys.executable, "-B", str(SERVER), "--project", str(self.path), "--allow-write"],
                                     stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, bufsize=1)
        self.addCleanup(self.stop)
        self.seq = 0
        self.request("initialize", {"protocolVersion": "2025-06-18", "clientInfo": {"name": "AtriumE2E", "version": "1"}, "capabilities": {}})
        self.send({"jsonrpc": "2.0", "method": "notifications/initialized"})

    def stop(self):
        close_stdio(self, 5)

    def request(self, method, params, timeout=120):
        return super().request(method, params, timeout)["result"]

    def tool(self, name, args=None, timeout=120):
        result = self.request("tools/call", {"name": name, "arguments": args or {}}, timeout)
        self.assertFalse(result["isError"], name + ": " + result["content"][0]["text"])
        return json.loads(result["content"][0]["text"])

    def failure(self, name, args=None):
        """A failed call: isError, the message as text and the structured {code, message, retryable}."""
        result = self.request("tools/call", {"name": name, "arguments": args or {}})
        self.assertTrue(result["isError"], name)
        error = result["structuredContent"]["error"]
        self.assertEqual(set(error), {"code", "message", "retryable"})
        self.assertEqual(error["message"], result["content"][0]["text"])
        return error

    def sensor_schematic(self):
        """J1 (+5V, SIG, GND) -> R1/C1 low-pass -> R2 -> J2 (+5V, OUT, GND), C2 decoupling."""
        t = self.tool
        for d, x, y, ref in [("std-j3", 0, 0, "J1"), ("std-r", 20.32, 0, "R1"), ("std-c", 35.56, 7.62, "C1"),
                             ("std-r", 55.88, 0, "R2"), ("std-c", 55.88, 20.32, "C2"), ("std-j3", 81.28, 0, "J2")]:
            t("place_part", {"def": d, "x": x, "y": y, "designator": ref, "mode": "write"})
        t("add_wire", {"from": {"designator": "J1", "pin": "2"}, "to": {"designator": "R1", "pin": "1"}, "mode": "write"})
        for ref, pin, net in [("R1", "2", "FILT"), ("C1", "1", "FILT"), ("R2", "1", "FILT"), ("R2", "2", "OUT"), ("J2", "2", "OUT")]:
            t("add_net_label", {"text": net, "at": {"designator": ref, "pin": pin}, "mode": "write"})
        for ref, pin, net in [("J1", "1", "+5V"), ("J2", "1", "+5V"), ("C2", "1", "+5V"),
                              ("J1", "3", "GND"), ("C1", "2", "GND"), ("C2", "2", "GND"), ("J2", "3", "GND")]:
            t("add_power_port", {"net": net, "at": {"designator": ref, "pin": pin}, "mode": "write"})

    def test_empty_project_to_routed_clean_board(self):
        t = self.tool
        # Schematic: J1 (+5V, SIG, GND) -> R1/C1 low-pass -> R2 -> J2 (+5V, OUT, GND), C2 decoupling.
        # (The starter op-amp's SOT-23-5 has a pin-1 silk dot 0.05 mm from its pad mask, which fails DRC.)
        parts = [("std-j3", 0, 0, "J1"), ("std-r", 20.32, 0, "R1"), ("std-c", 35.56, 7.62, "C1"),
                 ("std-r", 55.88, 0, "R2"), ("std-c", 55.88, 20.32, "C2"), ("std-j3", 81.28, 0, "J2")]
        for d, x, y, ref in parts:
            placed = t("place_part", {"def": d, "x": x, "y": y, "designator": ref, "mode": "write"})
            self.assertEqual(placed["untrusted_design_text"]["ref"], ref)
        t("set_board_outline", {"rect": [0, 0, 40, 30], "mode": "write"})
        wire = t("add_wire", {"from": {"designator": "J1", "pin": "2"}, "to": {"designator": "R1", "pin": "1"}, "mode": "write"})
        self.assertGreaterEqual(len(wire["points"]), 2)
        for ref, pin, net in [("R1", "2", "FILT"), ("C1", "1", "FILT"), ("R2", "1", "FILT"), ("R2", "2", "OUT"), ("J2", "2", "OUT")]:
            t("add_net_label", {"text": net, "at": {"designator": ref, "pin": pin}, "mode": "write"})
        for ref, pin, net in [("J1", "1", "+5V"), ("J2", "1", "+5V"), ("C2", "1", "+5V"),
                              ("J1", "3", "GND"), ("C1", "2", "GND"), ("C2", "2", "GND"), ("J2", "3", "GND")]:
            t("add_power_port", {"net": net, "at": {"designator": ref, "pin": pin}, "mode": "write"})
        erc = t("run_erc", {"classes": ["Fatal", "Error"]})
        self.assertEqual(erc["counts"].get("Error", 0) + erc["counts"].get("Fatal", 0), 0, erc)

        # ECO v2: dry run first, then execute. Six footprints, five nets.
        dry = t("update_pcb", {"dry_run": True})
        self.assertTrue(dry["valid"], dry)
        self.assertEqual(dry["groups"]["Add Components"]["total"], 6)
        eco = t("update_pcb", {"mode": "write"})
        self.assertEqual((eco["failed"], eco["groups"]["Add Components"]["done"]), (0, 6), eco)
        self.assertEqual(sorted(r["untrusted_design_text"]["object"] for r in eco["items"] if r["action"] == "addNet"), ["+5V", "FILT", "GND", "Net-J1-2", "OUT"])
        for r in eco["items"]:
            if r["action"] == "addComponent":
                self.assertGreater(r["at"][0], 40, "new footprints wait beside the board edge")
        self.assertEqual(t("update_pcb", {"dry_run": True})["changes"], 0, "schematic and board are in sync")

        # Place the footprints on the board, then route.
        for ref, x, y, rot in [("J1", 5, 15, 0), ("R1", 14, 10, 0), ("C1", 14, 20, 90), ("R2", 24, 12, 0), ("C2", 24, 23, 0), ("J2", 35, 15, 0)]:
            t("move_component", {"component": ref, "x": x, "y": y, "rotation": rot, "mode": "write"})
        routed = t("autoroute", {"mode": "write", "time_limit_ms": 30000}, timeout=180)
        self.assertEqual(routed["unrouted"], 0, routed)
        drc = t("run_drc", {"max_per_rule": 50})
        self.assertEqual(drc["total"], 0, json.dumps(drc["items"][:10], indent=1))

        # Outputs: an inline job set with Gerber/drill, BOM, pick and place, a DRC gate and a README.
        job = {"name": "E2E", "folder": "{board}", "outputs": [{"kind": "gerber"}, {"kind": "bom"}, {"kind": "pnp"},
                                                               {"kind": "drc", "options": {"failOver": 0}}, {"kind": "readme"}]}
        jobs = t("run_output_job", {"definition": job, "date": "2026-01-01T00:00:00Z"}, timeout=180)
        self.assertTrue(jobs["ok"], json.dumps(jobs["report"], indent=1)[:2000])
        self.assertTrue(any(f["name"].endswith(".zip") or f["name"].lower().endswith((".gtl", ".gbr")) for f in jobs["files"]), jobs["files"])
        saved = read_design(self.path)
        board = next(d for d in saved["documents"] if d["kind"] == "pcb")
        self.assertEqual(sum(i["kind"] == "part" for i in board["items"]), 6)
        self.assertGreater(sum(i["kind"] == "track" for i in board["items"]), 0)
        print("\nE2E: %d tracks, %d vias, DRC %d, unrouted %d, %d output files" % (
            sum(i["kind"] == "track" for i in board["items"]), sum(i["kind"] == "via" for i in board["items"]), drc["total"], routed["unrouted"], len(jobs["files"])))

    def test_ai_workflow_signals_impedance_route_one_net_check_outputs(self):
        """What an AI assistant does: build, sync, plan impedance, route one net, check, waive, output."""
        t = self.tool
        # Consistent errors: every failure has a code an agent can act on.
        self.assertEqual(self.failure("no_such_tool")["code"], "unknown_tool")
        self.assertEqual(self.failure("run_drc", {"bogus": 1})["code"], "invalid_arguments")
        stale = self.failure("pour_polygons", {"source_sha256": "0" * 64})
        self.assertEqual((stale["code"], stale["retryable"]), ("stale_source", True))
        self.assertEqual(self.failure("impedance_plan", {"spec": "fast please"})["code"], "tool_failed")

        self.sensor_schematic()
        t("stackup_propose", {"preset": "4", "mode": "write"})
        t("set_board_outline", {"rect": [0, 0, 40, 30], "mode": "write"})
        # Signals: declare the filtered input as a signal and tag it.
        t("signals", {"action": "declare", "name": "SENSE", "nets": ["FILT"], "mode": "write"})
        listed = t("signals", {"action": "list", "kind": "single"})
        self.assertIn("SENSE", json.dumps(listed))
        eco = t("update_pcb", {"mode": "write"})
        self.assertEqual(eco["failed"], 0, eco)
        for ref, x, y, rot in [("J1", 5, 15, 0), ("R1", 14, 10, 0), ("C1", 14, 20, 90), ("R2", 24, 12, 0), ("C2", 24, 23, 0), ("J2", 35, 15, 0)]:
            t("move_component", {"component": ref, "x": x, "y": y, "rotation": rot, "mode": "write"})
        # Impedance plan on the 4-layer stack: read-only, a layer-by-layer answer with suggestions.
        before = authored_files(self.dir)
        plan = t("impedance_plan", {"spec": "50 se \u00b110%"})
        self.assertEqual(authored_files(self.dir), before, "impedance_plan changes no authored project file")
        self.assertEqual(plan["spec"]["target"], 50)
        self.assertTrue(plan["layers"] and all({"layer", "structure", "width", "z", "reachable", "reason"} <= set(r) for r in plan["layers"]))
        self.assertTrue(plan["reachable"], plan)
        self.assertEqual(plan["suggestions"][0]["action"], "use_layer")
        unreachable = t("impedance_plan", {"spec": {"target": 500}})
        self.assertFalse(unreachable["reachable"])
        self.assertTrue(all(r["reason"] for r in unreachable["layers"]))
        # Route one net with the interactive router, then the rest.
        before_route = authored_files(self.dir)
        one = t("route_connection", {"net": "OUT", "from": {"component": "R2", "pad": "2"}, "to": {"component": "J2", "pad": "2"}, "mode": "write"})
        self.assertGreater(one.get("added", one.get("tracks", 1)), 0, one)
        after_route = authored_files(self.dir)
        self.assertEqual({path for path in before_route.keys() | after_route.keys()
                          if before_route.get(path) != after_route.get(path)}, {"Buffer board.wpcb"})
        saved = read_design(self.path)
        board = next(d for d in saved["documents"] if d["kind"] == "pcb")
        self.assertTrue(any(i["kind"] == "track" and i.get("net") == "OUT" for i in board["items"]), "OUT is routed")
        routed = t("autoroute", {"mode": "write", "time_limit_ms": 30000}, timeout=180)
        self.assertEqual(routed["unrouted"], 0, routed)
        # One check list across schematic and layout; waive one warning if there is any, by its key.
        checked = t("check", {"limit": 200})
        problems = checked.get("items", checked.get("problems", []))
        self.assertFalse([p for p in problems if p.get("severity") in ("fatal", "error")], json.dumps(problems[:5], indent=1))
        warning = next((p for p in problems if p.get("severity") == "warning" and p.get("key")), None)
        if warning:
            t("waive", {"violation_key": warning["key"], "note": "Reviewed in the AI workflow test", "mode": "write"})
            again = t("check", {"limit": 200})
            self.assertNotIn(warning["key"], [p.get("key") for p in again.get("items", again.get("problems", []))])
        # Outputs.
        fab = t("generate_fabrication", {"date": "2026-01-01T00:00:00Z", "zip": True}, timeout=180)
        self.assertTrue(fab["zip"]["path"].endswith(".zip"), fab)
        bom = t("generate_bom", {"formats": ["csv"]}, timeout=120)
        self.assertTrue(any(str(f.get("name", f.get("path", ""))).endswith(".csv") for f in bom.get("files", [])), bom)
        print("\nAI workflow: impedance on %d layers, %d check problems, waived %s" % (len(plan["layers"]), len(problems), warning["key"] if warning else "none"))


if __name__ == "__main__":
    unittest.main()
