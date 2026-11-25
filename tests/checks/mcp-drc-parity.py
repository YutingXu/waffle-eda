#!/usr/bin/env python3
"""Exercise the shared batch DRC through the native CLI and MCP stdio."""

import json
from pathlib import Path
import runpy
import subprocess
import tempfile
import unittest

import sys as _test_sys
from pathlib import Path as _TestPath
_test_sys.path.insert(0, str((_TestPath(__file__).resolve().parent / "../support").resolve()))
from native_sample import evaluate, write_design

HERE = Path(__file__).resolve().parents[1]
SUPPORT = runpy.run_path(str(HERE / "automation/butter-acceptance.py"))
Stdio, server = SUPPORT["Stdio"], SUPPORT["server"]
FLAGS = ("--enable-butter", "macros")
POUR_CHECK = {"domains": ["layout"], "checks": ["layout.pourClearance"], "hints": False, "merge": False}


def fixture(body):
    return json.loads(evaluate("""JSON.stringify((() => {
      const p = Atrium.project("Batch DRC parity"), d = p.documents[1];
      d.outline = [[0, 0], [30, 0], [30, 20], [0, 20]];
      """ + body + """
      return p;
    })())"""))


class BatchDRC(unittest.TestCase):
    def tool(self, client, manifest, name, args, *, flags=()):
        result = client.check_tool(name, args)
        cli = subprocess.run([*server(manifest, *flags), "--cli", name, "--args", json.dumps(args)], check=True,
                             text=True, capture_output=True, timeout=30)
        cold = json.loads(cli.stdout)
        for out in (result, cold):
            out.pop("ms", None)
            if "stats" in out:
                out["stats"].pop("ms")
        self.assertEqual(result, cold)
        return result

    def test_native_antenna_warning_is_available_in_both_tools(self):
        with tempfile.TemporaryDirectory() as out:
            model = fixture("""
              const track = (id, points, width = .25) => ({kind:"track", id, net:"A", points, width, layer:"Top"});
              const pad = (id, x) => ({kind:"pad", id, net:"A", x, y:5, w:1, h:1, shape:"rect", layer:"Top"});
              d.items = [
                pad("start", 1), pad("finish", 15), track("main", [[1, 5], [15, 5]]),
                track("arm", [[6, 5], [6, 8]]), track("tip", [[6, 8], [8, 10]], .01),
                track("viaArm", [[12, 5], [12, 8]]),
                {kind:"via", id:"viaEnd", net:"A", x:12, y:8, diameter:.6, drill:.3, layer:"Multi"}
              ];
            """)
            manifest = write_design(Path(out) / "Board.waffle", model)
            with Stdio(server(manifest, "--allow-write")) as client:
                def drc(**args):
                    return self.tool(client, manifest, "run_drc", args)

                self.assertNotIn("netAntennae", {row["type"] for row in drc()["items"]})
                warning = drc(rules=["netAntennae"])
                self.assertEqual(warning["total"], 1)
                self.assertEqual(warning["items"], [
                    {"type": "netAntennae", "rule": "Net Antennae", "rule_id": "atrium-netAntennae",
                     "id": "tip", "title": "Track (Top Layer) A", "detail": "Unconnected track end (stub)",
                     "severity": "warning", "at": [8, 10]}
                ])
                for alias in ("Net Antennae", "atrium-netAntennae"):
                    self.assertEqual(drc(rules=[alias])["items"], warning["items"])
                for rules in (
                    ["width", "netAntennae", "netAntennae"],
                    ["Net Antennae", "WIDTH", "atrium-netAntennae"],
                ):
                    self.assertEqual(drc(rules=rules)["items"], drc(rules=["width"])["items"] + warning["items"])

                args = {"domains": ["layout"], "checks": ["layout.netAntennae"], "hints": False, "merge": False}
                unified = self.tool(client, manifest, "check", args)
                self.assertEqual(unified["by_check"], {"layout.netAntennae": 1})
                self.assertEqual(unified["counts"]["warning"], 1)
                item = unified["items"][0]
                self.assertEqual(
                    [item["check"], item["severity"], item["objects"], item["at"], item["rule_id"], item["detail"]],
                    ["layout.netAntennae", "warning", ["tip"], [[8, 10]], "atrium-netAntennae",
                     "Unconnected track end (stub)"],
                )
                self.assertEqual(self.tool(client, manifest, "check", dict(args, severity=["error"]))["total"], 0)
                width = self.tool(client, manifest, "check", dict(args, checks=["layout.width"]))
                self.assertEqual(width["by_check"], {"layout.width": 1})

                waiver = client.check_tool("waive", {"violation_key": item["key"], "mode": "write", "note": "Review"})
                self.assertTrue(waiver["waived"])
                self.assertEqual(self.tool(client, manifest, "check", args)["total"], 0)
                waived = self.tool(client, manifest, "check", dict(args, include_waived=True))["items"][0]
                self.assertEqual(waived["waiver"]["state"], "holds")

    def test_source_selection_and_explicit_opt_in_follow_the_board(self):
        with tempfile.TemporaryDirectory() as out:
            model = fixture("""
              d.items = [{id:Atrium.id(), kind:"track", net:"SIG", layer:"Top", width:.1, points:[[8, 10], [22, 10]]}];
              d.ruleCheckSelection = {batch:["width"], online:[]};
              const second = Atrium.sheet("pcb", "Second board");
              second.items = d.items.map(i=>({...i,id:Atrium.id()}));
              p.documents.push(second);
            """)
            manifest = write_design(Path(out) / "Board.waffle", model)
            first, second = (d["id"] for d in model["documents"] if d["kind"] == "pcb")
            with Stdio(server(manifest)) as client:
                def drc(doc, **args):
                    return self.tool(client, manifest, "run_drc", {"document_id": doc, **args})

                self.assertEqual(drc(first)["total"], 0)
                self.assertEqual(drc(second)["total"], 1)
                for options in ({"all_checks": True}, {"rules": ["width"]}, {"rules": ["Width"]}):
                    result = drc(first, **options)
                    self.assertEqual((result["total"], result["items"][0]["type"]), (1, "width"))
                self.assertEqual(drc(first)["total"], 0)
                check = self.tool(client, manifest, "check", {
                    "domains": ["layout"], "documents": [first], "checks": ["layout.width"], "hints": False})
                self.assertEqual(check["by_check"], {"layout.width": 1})

    def test_filled_pour_type_name_rule_set_cap_paging_and_waiver(self):
        with tempfile.TemporaryDirectory() as out:
            model = fixture("""
              d.items = [
                AtriumPolygonPour.make([[2, 2], [28, 2], [28, 18], [2, 18]], {
                  net:"GND", layer:"Top", pourIndex:0, removeDeadCopper:false, clearance:.1}),
                {id:Atrium.id(), kind:"track", net:"SIG", layer:"Top", width:.1, points:[[8, 10], [22, 10]]}
              ];
              AtriumPolygonPour.apply(d, new Map(), {project:p});
              const shop = AtriumRules.migrate();
              shop.list.find(r => r.type === "clearance").gap = .3;
              p.ruleSets = {version:1, sets:[{name:"Shop", rules:shop}]};
            """)
            manifest = write_design(Path(out) / "Board.waffle", model)
            with Stdio(server(manifest, "--allow-write")) as client:
                def drc(**args):
                    return self.tool(client, manifest, "run_drc", args)

                full = drc()
                self.assertEqual(full["total"], 3)
                kinds = ["Polygon clearance", "Pour clearance"]
                filtered = drc(rules=["clearance"])
                self.assertEqual([row["what"] for row in filtered["items"]], kinds)
                self.assertEqual(filtered["items"], [row for row in full["items"] if row["type"] == "pourClearance"])
                clearance_rule = [{"id": "clearance-1", "name": "Clearance", "type": "clearance", "count": 2}]
                self.assertEqual(filtered["rules"], clearance_rule)
                for rule in ("CLEARANCE", "clearance-1"):
                    self.assertEqual(drc(rules=[rule])["items"], filtered["items"])
                selected = drc(rule_set="Shop", rules=["clearance"])
                self.assertEqual((selected["rules_source"], selected["rule_set"]), ("rule_set", "Shop"))
                self.assertEqual([row["required"] for row in selected["items"]], [.3, .3])
                empty = drc(rules=["Unknown"])
                self.assertEqual((empty["total"], empty["items"], empty["next_offset"]), (0, [], None))
                for offset, next_offset in [(0, 1), (1, None), (2, None)]:
                    page = drc(rules=["clearance"], limit=1, offset=offset)
                    self.assertEqual(page["total"], 2)
                    self.assertEqual(page["next_offset"], next_offset)
                    self.assertEqual(page["items"], filtered["items"][offset:offset + 1])
                capped = drc(rules=["clearance"], max_per_rule=1)
                self.assertEqual((capped["total"], capped["items"], capped["rules"]), (1, filtered["items"][:1], clearance_rule))
                with Stdio(server(manifest, *FLAGS)) as labs:
                    macro = self.tool(labs, manifest, "run_command", {
                        "command": "butter.macros.check-design-rules", "args": {"rules": ["clearance"]}}, flags=FLAGS)
                self.assertEqual((macro["total"], macro["complete"]), (2, True))
                self.assertEqual(macro["untrusted_design_text"]["rules"], [{"id": "clearance-1", "count": 2}])
                unified = self.tool(client, manifest, "check", POUR_CHECK)
                self.assertEqual(unified["by_check"], {"layout.pourClearance": 2})

                script = self.tool(client, manifest, "run_script", {"code": """
                  const clearance = {types:["clearance"]};
                  const full = await api.drc(clearance);
                  const capped = await api.drc({...clearance, limit:1});
                  const width = await api.drc({types:["width"]});
                  const override = await api.drc({...clearance, rules:args.rules});
                  return {total:full.total, rows:full.violations.map(v => [v.type,v.what,v.required]),
                    capped:[capped.total,capped.violations.length], width:width.violations.map(v => v.type),
                    override:override.violations.map(v => v.required)};
                """, "args": {"rules": model["ruleSets"]["sets"][0]["rules"]}})
                self.assertIsNone(script["error"])
                self.assertEqual((script["transactions"], script["changes"]), (0, 0))
                self.assertEqual(script["result"], {
                    "total": 2, "rows": [["pourClearance", kind, .2] for kind in kinds],
                    "capped": [2, 1], "width": ["width"], "override": [.3, .3]})
                self.assertIsNone(script["proposal_file"])
                self.assertEqual(self.tool(client, manifest, "run_drc", {"rules":["clearance"]}), filtered)

                key = next(row["key"] for row in unified["items"] if len(row["objects"]) == 1)
                changed = client.check_tool("waive", {"violation_key":key, "mode":"write", "note":"Accepted setting"})
                self.assertTrue(changed["waived"])
                waived = drc(rules=["clearance"])
                self.assertEqual((waived["total"], waived["waived"], waived["matching"]), (1, 1, 2))
                self.assertEqual(waived["rules"], [dict(clearance_rule[0], count=1, waived=1)])
                self.assertTrue(waived["items"][0]["waived"])
                self.assertEqual(waived["items"][0]["waiver_note"], "Accepted setting")
                self.assertEqual(self.tool(client, manifest, "check", POUR_CHECK)["total"], 1)
                visible = self.tool(client, manifest, "check", dict(POUR_CHECK, include_waived=True))
                self.assertEqual((visible["total"], visible["waived"]), (2, 1))

    def test_empty_and_incomplete(self):
        with tempfile.TemporaryDirectory() as out:
            folder = Path(out)
            empty = write_design(folder / "empty" / "Board.waffle", fixture(""))
            with Stdio(server(empty)) as client:
                result = self.tool(client, empty, "run_drc", {})
                self.assertEqual((result["total"], result["items"], result["notes"]), (0, [], []))
                self.assertNotIn("complete", result)
                self.assertEqual(self.tool(client, empty, "check", POUR_CHECK)["total"], 0)

            model = fixture("""
              p.rules = JSON.parse(JSON.stringify(AtriumProjectRules.book(p)));
              p.rules.list.find(r => r.type === "width").scope = {languageVersion:1, source:"track where width >"};
            """)
            incomplete = write_design(folder / "incomplete" / "Board.waffle", model)
            with Stdio(server(incomplete)) as client:
                for args in ({}, {"rules": ["width"]}, {"rules": ["WIDTH"]}):
                    result = self.tool(client, incomplete, "run_drc", args)
                    self.assertIs(result["complete"], False)
                    issue, = result["diagnostics"]
                    self.assertEqual((issue["type"], issue["code"]), ("width", "syntax"))
                check = self.tool(client, incomplete, "check", dict(POUR_CHECK, checks=["layout.width"]))
                self.assertIs(check["complete"], False)
                self.assertEqual(check["diagnostics"], [dict(issue, document_id=result["document_id"])])
                for rule in ("clearance", "CLEARANCE", "clearance-1"):
                    self.assertNotIn("complete", self.tool(client, incomplete, "run_drc", {"rules": [rule]}))
                self.assertNotIn("complete", self.tool(client, incomplete, "check", POUR_CHECK))


if __name__ == "__main__":
    unittest.main()
