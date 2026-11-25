"""MCP authoring v2, netlists and multi-routing, end to end and security, over stdio.

1. An AI-style script builds an LED, resistor and connector schematic purely through MCP: parts found by
   query and match (the starter library), pins put on nets with connect, IDs passed between pipeline steps
   with $ref. Then Update PCB, a board outline, automatic placement, autorouting and DRC: 0 violations,
   0 unrouted. The netlist is exported (KiCad, Protel, CSV) and imported into an empty project, whose
   board gets the same nets.
2. multi_route routes a bus of four nets together.
3. Security: no write without --allow-write, outputs and netlist inputs stay inside their folders, bad
   $refs are refused before anything runs, and a failed pipeline proposes nothing.

Usage: python3 tests/automation/mcp-authoring.py [-v]
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
from native_sample import read_design, revision, write_design
from mcp_stdio import Client, close_stdio

ROOT = Path(__file__).resolve().parents[2]
SERVER = ROOT / "mcp" / "server.py"


def empty_project(path, name="Blinky", board=True):
    docs = [{"id": "sch", "kind": "schematic", "name": "Main", "grid": 1.27, "items": [], "outline": [], "notes": []}]
    if board:
        docs.append({"id": "pcb", "kind": "pcb", "name": "Board", "grid": 0.25, "items": [], "outline": [], "notes": []})
    return write_design(path, {"name": name, "library": [], "documents": docs})


class Server(Client):
    def __init__(self, test, path, allow_write):
        self.test, self.seq = test, 0
        self.proc = subprocess.Popen([sys.executable, "-B", str(SERVER), "--project", str(path)] + (["--allow-write"] if allow_write else []),
                                     stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, bufsize=1)
        self.request("initialize", {"protocolVersion": "2025-06-18", "clientInfo": {"name": "AuthoringTest", "version": "1"}, "capabilities": {}})
        self.send({"jsonrpc": "2.0", "method": "notifications/initialized"})

    def stop(self):
        close_stdio(self, 5)

    def assertEqual(self, first, second, msg=None):
        self.test.assertEqual(first, second, msg)

    def assertIsNotNone(self, obj, msg=None):
        self.test.assertIsNotNone(obj, msg)

    def fail(self, msg=None):
        self.test.fail(msg)

    def request(self, method, params, timeout=120):
        return super().request(method, params, timeout)["result"]

    def tool(self, name, args=None, timeout=120, error=False):
        result = self.request("tools/call", {"name": name, "arguments": args or {}}, timeout)
        text = result["content"][0]["text"]
        self.test.assertEqual(result["isError"], error, name + ": " + text[:2000])
        return text if error else json.loads(text)


class Authoring(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.dir = Path(self.temp.name)

    def server(self, path, allow_write=True):
        s = Server(self, path, allow_write)
        self.addCleanup(s.stop)
        return s

    def test_ai_builds_led_board_through_mcp(self):
        path = self.dir / "Blinky.waffle"
        empty_project(path)
        t = self.server(path).tool
        listed = {x["name"] for x in self.server(path).request("tools/list", {})["tools"]}
        self.assertTrue({"find_parts", "place_part", "connect", "export_netlist", "import_netlist", "multi_route"} <= listed)

        # The assistant looks for parts first. Generic parts carry no part numbers.
        found = t("find_parts", {"query": "led", "match": {"footprint": "0603"}})
        self.assertEqual(found["items"][0]["def_id"], "starter-led-0603")
        self.assertEqual(found["items"][0]["untrusted_design_text"]["part_numbers"], [])
        self.assertIn("never invents", found["note"])
        refused = t("place_part", {"match": {"mpn": "NE555DR"}, "x": 0, "y": 0}, error=True)
        self.assertIn("never invents part numbers", refused)

        # One pipeline, one write: three parts by query/match, nets by name, IDs passed on with $ref.
        steps = [
            {"id": "j1", "tool": "place_part", "args": {"query": "pin header 1×2", "x": 0, "y": 0, "designator": "J1"}},
            {"id": "r1", "tool": "place_part", "args": {"query": "resistor", "match": {"footprint": "0603"}, "value": "330 Ω", "x": 25.4, "y": 0}},
            {"id": "d1", "tool": "place_part", "args": {"query": "LED 0603", "x": 50.8, "y": 0, "value": "Red"}},
            {"tool": "connect", "args": {"net": "+5V", "pins": [{"designator": {"$ref": "j1.result.untrusted_design_text.ref"}, "pin": "1"},
                                                                 {"designator": {"$ref": "r1.result.untrusted_design_text.ref"}, "pin": "1"}], "stub": 2.54}},
            {"tool": "connect", "args": {"net": "LED_A", "style": "wire", "pins": [{"designator": {"$ref": "step2.result.untrusted_design_text.ref"}, "pin": "2"},
                                                                                    {"designator": {"$ref": "step3.result.untrusted_design_text.ref"}, "pin": "A"}]}},
            {"tool": "connect", "args": {"net": "GND", "pins": [{"designator": "D1", "pin": "K"}, {"designator": "J1", "pin": "2"}], "stub": 2.54}},
            {"tool": "run_erc", "args": {"classes": ["Fatal", "Error"]}},
        ]
        built = t("pipeline", {"steps": steps, "mode": "write"})
        self.assertTrue(built["written"], built)
        results = {s.get("id") or "step%d" % (i + 1): s["result"] for i, s in enumerate(built["steps"])}
        self.assertEqual([results[k]["matched"]["def_id"] for k in ("j1", "r1", "d1")], ["starter-hdr-1x2", "starter-r-0603", "starter-led-0603"])
        self.assertEqual(results["r1"]["untrusted_design_text"]["value"], "330 Ω")
        self.assertEqual(results["step4"]["style"], "power")
        self.assertEqual(results["step5"]["untrusted_design_text"]["conflicts"], [])
        erc = results["step7"]
        self.assertEqual(erc["counts"].get("Error", 0) + erc["counts"].get("Fatal", 0), 0, erc)
        saved = read_design(path)
        self.assertEqual(sorted(d["id"] for d in saved["library"]), ["starter-hdr-1x2", "starter-led-0603", "starter-r-0603"])
        for d in saved["library"]:
            for k, v in (d.get("parameters") or {}).items():
                if "LCSC" in k or "MPN" in k.upper():
                    self.assertEqual(v, "", "no invented part numbers")

        # Board: Update PCB, outline, automatic placement, routing, DRC.
        eco = t("update_pcb", {"mode": "write"})
        self.assertEqual((eco["failed"], eco["groups"]["Add Components"]["done"]), (0, 3), eco)
        self.assertEqual(sorted(r["untrusted_design_text"]["object"] for r in eco["items"] if r["action"] == "addNet"), ["+5V", "GND", "LED_A"])
        t("set_board_outline", {"rect": [0, 0, 30, 20], "mode": "write"})
        placed = t("propose_placement", {"mode": "write", "seed": 1}, timeout=180)
        self.assertTrue(placed.get("written"), json.dumps(placed)[:1500])
        routed = t("autoroute", {"mode": "write", "time_limit_ms": 30000}, timeout=180)
        self.assertEqual(routed["unrouted"], 0, routed)
        drc = t("run_drc", {"max_per_rule": 50})
        self.assertEqual(drc["total"], 0, json.dumps(drc["items"][:10], indent=1))

        # Netlists out, and back into an empty project's board through import_netlist.
        files = {f: t("export_netlist", {"format": f, "source": s}) for f, s in (("kicad", "schematic"), ("protel", "pcb"), ("csv", "auto"))}
        for f, r in files.items():
            self.assertEqual((r["components"], r["nets"]), (3, 3), (f, r))
            self.assertTrue(Path(r["path"]).is_file())
            self.assertIn("Blinky-outputs", r["path"])
        self.assertTrue(Path(files["kicad"]["path"]).read_text().startswith("(export (version \"E\")"))
        other = self.dir / "imported" / "Imported.waffle"
        empty_project(other, "Imported", board=False)
        (other.parent / "blinky.net").write_text(Path(files["kicad"]["path"]).read_text())
        imported = self.server(other).tool("import_netlist", {"path": "blinky.net", "mode": "write"})
        self.assertEqual((imported["components"], imported["nets"], imported["board_added"]), (3, 3, True), imported)
        self.assertEqual(imported["eco"]["failed"], 0, imported)
        board = next(d for d in read_design(other)["documents"] if d["kind"] == "pcb")
        nets = sorted({n for i in board["items"] if i["kind"] == "part" for n in i.get("pinNets", {}).values() if n})
        self.assertEqual(nets, ["+5V", "GND", "LED_A"])
        again = self.server(other).tool("export_netlist", {"format": "kicad", "source": "pcb"})
        self.assertEqual((again["components"], again["nets"], again["connections"]), (3, 3, 6))
        print("\nAuthoring E2E: DRC %d, unrouted %d, %d tracks" % (drc["total"], routed["unrouted"], routed.get("tracks", 0)))

    def test_multi_route_bus(self):
        path = self.dir / "Bus.waffle"
        pads = [{"id": "s%d" % i, "kind": "pad", "x": 2, "y": 10 + i, "w": 0.6, "h": 0.6, "shape": "round", "drill": 0, "layer": "Top", "net": "D%d" % i} for i in range(4)]
        pads.append({"id": "block", "kind": "pad", "x": 15, "y": 11.5, "w": 3, "h": 3, "shape": "round", "drill": 0, "layer": "Top", "net": "GND"})
        project = {"name": "Bus", "library": [], "documents": [
            {"id": "pcb", "kind": "pcb", "name": "Board", "grid": 0.25, "items": pads, "outline": [[0, 0], [40, 0], [40, 30], [0, 30]], "notes": []}]}
        write_design(path, project)
        t = self.server(path).tool
        starts = [{"x": 2, "y": 10 + i} for i in range(4)]
        r = t("multi_route", {"starts": starts, "nets": ["D0", "D1", "D2", "D3"], "to": [30, 11.5], "width": 0.2, "mode": "write"})
        self.assertEqual((r["routed"], r["total"], r["strategy"], r["tracks"]), (4, 4, "trunk", 4), r)
        self.assertGreater(r["gap"], 0)
        drc = t("run_drc", {"rules": ["clearance"]})
        self.assertEqual(drc["total"], 0, drc)
        self.assertIn("same net", t("multi_route", {"starts": starts[:2], "nets": ["D0", "D0"], "to": [30, 11]}, error=True).replace("its own net", "same net"))

    def test_security(self):
        path = self.dir / "Safe.waffle"
        empty_project(path)
        before = revision(path)
        s = self.server(path, allow_write=False)
        t = s.tool
        # No write without --allow-write: the mode is absent from the schema and refused when given.
        for name in ("place_part", "connect", "import_netlist", "multi_route", "pipeline"):
            schema = next(x for x in s.request("tools/list", {})["tools"] if x["name"] == name)["inputSchema"]
            self.assertEqual(schema["properties"]["mode"]["enum"], ["proposal"], name)
        self.assertIn("--allow-write", t("place_part", {"def": "std-r", "x": 0, "y": 0, "mode": "write"}, error=True))
        self.assertIn("--allow-write", t("pipeline", {"steps": [{"tool": "place_part", "args": {"def": "std-r", "x": 0, "y": 0}}], "mode": "write"}, error=True))
        self.assertIn("--allow-write", t("import_netlist", {"text": "[\nR1\n0603\n1k\n]\n", "mode": "write"}, error=True))
        self.assertEqual(revision(path), before)
        # A proposal is the default and leaves the project untouched.
        proposed = t("place_part", {"query": "resistor 0805", "x": 0, "y": 0})
        self.assertTrue(Path(proposed["proposal_file"]).is_file())
        self.assertEqual(revision(path), before)
        # Outputs stay inside <project>-outputs/; netlists are read only from the project folder.
        for bad in ("../escape", "/tmp/escape", "a/../../escape", ".hidden"):
            self.assertTrue(t("export_netlist", {"output_dir": bad}, error=True))
        self.assertFalse((self.dir.parent / "escape").exists())
        outside = Path(tempfile.mkdtemp())
        self.addCleanup(lambda: [p.unlink() for p in outside.iterdir()] and None or outside.rmdir())
        (outside / "x.net").write_text("[\nR1\n0603\n1k\n]\n")
        for bad in (str(outside / "x.net"), "../" + outside.name + "/x.net", "Safe.waffle", "missing.net"):
            self.assertTrue(t("import_netlist", {"path": bad}, error=True), bad)
        (self.dir / "link.net").symlink_to(outside / "x.net")
        self.assertIn("inside", t("import_netlist", {"path": "link.net"}, error=True))
        # Bad $refs are refused before anything runs, and nothing is proposed.
        proposals = set(self.dir.glob("*.waffle-ai"))
        place = {"tool": "place_part", "id": "a", "args": {"def": "std-r", "x": 0, "y": 0}}
        bad_refs = [
            ([place, {"tool": "connect", "args": {"net": "N", "pins": [{"designator": {"$ref": "step3.result.id"}, "pin": "1"}]}}], "earlier step"),
            ([{"tool": "connect", "args": {"net": "N", "pins": [{"designator": {"$ref": "step1.result.id"}, "pin": "1"}]}}], "earlier step"),
            ([place, {"tool": "connect", "args": {"net": "N", "pins": [{"designator": {"$ref": "nope.result.id"}, "pin": "1"}]}}], "no earlier step"),
            ([place, {"tool": "connect", "args": {"net": "N", "pins": [{"designator": {"$ref": "a.result.missing"}, "pin": "1"}]}}], "has no field missing"),
            ([place, {"tool": "connect", "args": {"net": "N", "pins": [{"designator": {"$ref": "a.result.pins[9]"}, "pin": "1"}]}}], "has no entry [9]"),
            ([place, {"tool": "connect", "args": {"net": "N", "pins": [{"designator": {"$ref": "a.result.pins"}, "pin": "1"}]}}], "must be string"),
            ([place, {"tool": "connect", "args": {"net": "N", "pins": [{"designator": {"$ref": "a.result.id", "x": 1}, "pin": "1"}]}}], "exactly"),
            ([place, {"tool": "connect", "args": {"net": "N", "pins": [{"designator": {"$ref": "a.result.__class__"}, "pin": "1"}]}}], "has no field"),
            ([place, {"tool": "connect", "args": {"net": "N", "pins": [{"designator": {"$ref": "a.result..id"}, "pin": "1"}]}}], "bad $ref"),
            ([place, {"tool": "place_part", "args": {"$ref": "a.result"}}], "cannot be a reference"),
            ([place, dict(place)], "already used"),
        ]
        for steps, message in bad_refs:
            text = t("pipeline", {"steps": steps}, error=True)
            self.assertIn(message, text, steps)
        self.assertEqual(set(self.dir.glob("*.waffle-ai")), proposals, "a refused pipeline proposes nothing")
        self.assertEqual(revision(path), before)
        # A reference cannot smuggle in mode: the resolved value is a plain argument and validated.
        smuggle = [{"tool": "find_parts", "id": "f", "args": {"query": "resistor"}},
                   {"tool": "place_part", "args": {"def": {"$ref": "f.result.items[0].def_id"}, "x": 0, "y": 0, "value": {"$ref": "f.result.note"}}}]
        ok = t("pipeline", {"steps": smuggle})
        self.assertEqual(ok["steps"][1]["result"]["matched"]["def_id"], ok["steps"][0]["result"]["items"][0]["def_id"])
        # Design text in results is marked untrusted.
        self.assertIn("untrusted_design_text", ok["steps"][1]["result"])


if __name__ == "__main__":
    unittest.main()
