"""Black-box JSON-RPC tests for the project-bound MCP stdio server."""
import base64
import hashlib
import json
import os
import re
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import time
import unittest
import uuid
import zipfile
import sys as _test_sys
from pathlib import Path as _TestPath
_test_sys.path.insert(0, str((_TestPath(__file__).resolve().parent / "../support").resolve()))
from native_sample import authored_files, evaluate, make_sample, read_design, revision, write_design
from board_runner import resolve
from mcp_stdio import Client, HeadlessFixture, SERVER

PRE_RELEASE = "This file is from a pre-release Waffle build; re-import the design from its source EDA"
HEADLESS_TOOLS = {"create_footprint", "create_symbol", "validate_library_def", "update_parts_from_library", "run_output_job", "run_erc", "run_drc", "list_rules", "get_rule", "propose_rule_change", "generate_fabrication", "generate_bom",
                  "annotate", "stackup_get", "stackup_propose", "net_lengths", "matched_length_report", "pour_polygons",
                  "route_connection", "autoroute", "fanout", "replicate_layout", "run_script", "export_kicad", "export_step", "render", "export_pdf", "pipeline", "optimise_bom",
                  "place_part", "add_wire", "add_net_label", "add_power_port", "set_board_outline", "update_pcb", "move_component", "delete_items"}

HEADLESS_TOOLS |= {"via_stub_report", "list_rule_sets", "apply_proposal"}

HEADLESS_TOOLS |= {"list_translators", "import_design", "export_design"}
HEADLESS_TOOLS |= {"calculate"}
HEADLESS_TOOLS |= {"panelize"}  # panelization
HEADLESS_TOOLS |= {"edit_drawing", "export_drawing"}  # draftsman drawings
HEADLESS_TOOLS |= {"run_command", "list_commands"}  # headless-parity

HEADLESS_TOOLS |= {"via_stub_report", "list_rule_sets"}
HEADLESS_TOOLS |= {"constraints"}
HEADLESS_TOOLS |= {"mcad_status", "import_mcad_changes", "export_idx"}  # ECAD-MCAD (mcp/mcad.py; tests/formats/mcad-mcp.py)
HEADLESS_TOOLS |= {"si_analysis", "stress_check"}  # SI-lite, component stress
HEADLESS_TOOLS |= {"pdn_analyze"}  # PDN Analyzer
HEADLESS_TOOLS |= {"thermal_map", "current_capacity_check"}  # thermal: temperature rise map, IPC-2152
HEADLESS_TOOLS |= {"si_simulate"}  # Signal Integrity extension engine (extensions/si)
HEADLESS_TOOLS |= {"xsignals", "topology", "field_solve"}  # high-speed suite
HEADLESS_TOOLS |= {"signals"}  # signals and tags (signals-panel.js)
HEADLESS_TOOLS |= {"suggest_route"}  # Route Suggestions (read-only)
HEADLESS_TOOLS |= {"propose_placement", "propose_routing", "propose_planes"}  # AI placement
HEADLESS_TOOLS |= {"place_support_components"}  # schematic <-> PCB sync, support placement
HEADLESS_TOOLS |= {"drc_waivers"}  # DRC waivers saved with the board
HEADLESS_TOOLS |= {"impedance_plan"}  # impedance-directives §10 (read-only)
HEADLESS_TOOLS |= {"export_altium"}  # Altium ASCII project export (preview)
HEADLESS_TOOLS |= {"find_parts", "connect", "read_netlist", "validate_netlist", "export_netlist", "import_netlist", "multi_route", "route_bus"}  # authoring v2, netlists, multi-route
HEADLESS_TOOLS |= {"list_comments", "add_comment", "resolve_comment"}  # design review comments (mcp/review.py)
HEADLESS_TOOLS |= {"diff_designs"}  # design diff (mcp/diff_designs.py)
HEADLESS_TOOLS |= {"create_symbol_from_table"}  # Symbol Wizard
HEADLESS_TOOLS |= {"list_fab_presets", "apply_fab_preset", "dfm_check"}  # fab-presets
HEADLESS_TOOLS |= {"place_generic_part", "edit_generic_part", "list_generic_parts"}  # generic parts
HEADLESS_TOOLS |= {"release", "list_releases"}  # output-jobs-v2: Release page
HEADLESS_TOOLS |= {"list_insights"}  # Design Insights (read-only advice)
HEADLESS_TOOLS |= {"footprint_wizard"}  # footprint wizard: list / describe / generate / batch (read-only)
HEADLESS_TOOLS |= {"library_sources", "library_import"}  # folder libraries and KiCad/Altium library import (mcp/library_sources.py)
HEADLESS_TOOLS |= {"check", "waive", "waivers"}  # unified checks (app/checks/checks.js); run_drc ... drc_waivers stay as aliases

class MCPTests(Client, unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.path = Path(self.temp.name) / "Board.waffle"
        records = [
            {"kind": "part", "id": f"c{i}", "ref": f"R{i}", "value": "10k",
             "x": i, "y": 0, "angle": 0, "def": "r",
             "pinNets": {"1": "GND", "2": "SIG"}}
            for i in range(1, 5)
        ]
        records.append({"kind": "track", "id": "t", "net": "GND"})
        self.design = {
            "format": "atrium", "version": 1, "id": "mcp-test-board", "name": "Board",
            "documents": [{"id": "board", "kind": "pcb", "name": "Top", "items": records}],
            "library": [{"id": "r", "name": "Resistor", "footprint": {"name": "0603"}},
                        {"id": "cap", "name": "Capacitor", "symbol": {"pins": []}}]
        }
        write_design(self.path, self.design)
        self.original = authored_files(self.path.parent)
        self.digest = revision(self.path)
        self.open_project(self.path)

    def open_project(self, path, *flags):
        if hasattr(self, "proc"):
            self.stop_server()
        self.path = path
        self.proc = subprocess.Popen(
            [sys.executable, str(SERVER), "--project", str(self.path), *flags],
            stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
            text=True, bufsize=1,
        )
        self.addCleanup(self.stop_server)
        self.seq = 0

    def test_lifecycle_and_paginated_readers(self):
        self.assertEqual(self.request("tools/list", {})["error"]["code"], -32002)
        self.initialize()
        tools = {tool["name"]: tool for tool in self.request("tools/list", {})["result"]["tools"]}
        self.assertEqual(set(tools), {"list_documents", "project_summary", "list_components", "list_library", "list_nets",
                                     "inspect_component", "propose_component_edits", "board_connectivity", "check_board_rules",
                                     "list_source_rules", "compare_git_head", "project_history", "list_notebook", "git_commit_plan"} | HEADLESS_TOOLS)
        self.assertNotIn("git_commit", tools, "a connection without write permission only sees the plan")
        self.assertEqual(tools["git_commit_plan"]["inputSchema"], {
            "type": "object", "properties": {}, "required": [], "additionalProperties": False,
        })
        self.assertEqual(tools["git_commit_plan"]["annotations"], {
            "readOnlyHint": True, "destructiveHint": False, "openWorldHint": False,
        })
        editor_only = {"collab-live", "collab_live", "show-problems", "show_problems"}
        self.assertTrue(editor_only.isdisjoint(tools))
        for name in ("list_commands", "run_command"):
            self.assertTrue(editor_only.isdisjoint(tools[name]["inputSchema"]["properties"]["command"]["enum"]))
        self.assertTrue(tools["compare_git_head"]["annotations"]["readOnlyHint"])
        for name in ("read_netlist", "validate_netlist", "list_notebook"):
            self.assertTrue(tools[name]["annotations"]["readOnlyHint"])
            self.assertFalse(tools[name]["annotations"]["destructiveHint"])

        summary = self.tool("project_summary")
        self.assertEqual(summary["file_revision"], self.digest)
        self.assertEqual(summary["documents"][0]["counts"], {"part": 4, "track": 1})
        args = {"document_id": "board", "limit": 2}
        first = self.tool("list_components", args)
        second = self.tool("list_components", dict(args, offset=first["next_offset"]))
        self.assertEqual([i["id"] for i in first["items"] + second["items"]], ["c1", "c2", "c3", "c4"])
        self.assertIsNone(second["next_offset"])
        self.assertEqual(self.tool("list_components", dict(args, offset=99))["items"], [])
        self.assertEqual(self.tool("list_components", dict(args, query="r2"))["items"][0]["id"], "c2")
        self.assertEqual(self.tool("inspect_component", {"component_id": "c1"})["definition"]["id"], "r")
        self.assertEqual(self.tool("list_library", {"query": "CAP", "limit": 1})["items"][0]["id"], "cap")
        nets = self.tool("list_nets", {"document_id": "board", "limit": 1})
        self.assertEqual(nets["items"], [{"name": "GND", "objects": 1, "pad_assignments": 4}])
        self.assertEqual(self.tool("list_nets", {"document_id": "board", "offset": nets["next_offset"]})["items"][0]["name"], "SIG")
        for options in [{"limit": 201}, {"offset": -2}, {"limit": True}]:
            self.tool("list_library", options, error=True)
        self.tool("project_summary", {"path": "../other.waffle"}, error=True)
        self.tool("inspect_component", {"component_id": "missing"}, error=True)
        self.tool("undefined_tool", error=True)
        self.assertEqual(self.request("unknown", {})["error"]["code"], -32601)
        self.assertEqual(authored_files(self.path.parent), self.original)

    def test_headless_performance_session_uses_the_shared_snapshot(self):
        self.open_project(make_sample(Path(self.temp.name) / "performance", "Sensor.waffle"),
                          "--read-only", "--enable-butter", "motion")
        original = authored_files(self.path.parent)
        project = read_design(self.path)
        pcb = next(doc["id"] for doc in project["documents"] if doc["kind"] == "pcb")
        method = "waffle/diagnostics/performance"
        self.assertEqual(self.request(method, {"action": "start"})["error"]["code"], -32002)
        init = self.request("initialize", {"protocolVersion": "2025-06-18"})["result"]
        capability = init["capabilities"]["experimental"][method]
        self.assertEqual(capability["actions"], ["start", "snapshot", "stop"])
        self.assertEqual(capability["projections"], ["shareable", "exact"])
        for bad in ({"action": "begin"}, {"action": "start", "projection": "exact"},
                    {"action": "snapshot", "projection": "private"}):
            self.assertEqual(self.request(method, bad)["error"]["code"], -32602)

        def capture(action, **options):
            return self.request(method, {"action": action, **options})["result"]

        secret = "PERFORMANCE_PRIVATE_COMPONENT_FILTER"
        args = {"document_id": pcb, "query": secret}
        self.assertEqual(self.tool("list_components", args)["total"], 0)
        self.assertEqual(capture("snapshot"), {"version": 1, "recording": False, "rows": []})
        self.assertEqual(capture("start"), {"version": 1, "recording": True, "rows": []})
        self.assertEqual(self.tool("list_components", args)["total"], 0)
        self.assertEqual(self.tool("run_drc", {"rules": ["width"]}, timeout=30)["total"], 1)
        command = "butter.motion.policy"
        self.assertEqual(self.tool("run_command", {"command": command, "args": {"requested": "full", "osReduced": True}})
                         ["untrusted_design_text"]["level"], "reduced")
        self.assertIn("read-only", self.tool("propose_component_edits", {"changes": []}, error=True))
        snapshot = capture("snapshot")
        self.assertEqual(snapshot["version"], 1)
        self.assertTrue(snapshot["recording"])
        by_key = {(row["component"], row["operation"]): row for row in snapshot["rows"]}
        automation = by_key["automation", "request"]
        self.assertEqual(automation["counts"]["completed"], "1-to-4")
        self.assertEqual(automation["counts"]["failed"], "1-to-4")
        self.assertIsNotNone(automation["runP95"])
        self.assertEqual(by_key["automation", "command"]["counts"]["completed"], "1-to-4")
        self.assertEqual(by_key["drc", "check"]["counts"]["completed"], "1-to-4")
        exact = capture("snapshot", projection="exact")
        self.assertEqual(set(exact), set(snapshot))
        self.assertEqual(exact["version"], snapshot["version"])
        exact_rows = {(row["component"], row["operation"]): row for row in exact["rows"]}
        self.assertEqual(exact_rows.keys(), by_key.keys())
        self.assertEqual(exact_rows["automation", "request"]["counts"]["completed"], 3)
        self.assertEqual(exact_rows["automation", "request"]["counts"]["failed"], 1)
        self.assertEqual(exact_rows["automation", "command"]["counts"]["completed"], 1)
        self.assertEqual(exact_rows["drc", "check"]["counts"]["completed"], 1)
        self.assertIsInstance(automation["runP95"], str)
        self.assertIsInstance(exact_rows["automation", "request"]["runP95"], (int, float))
        for projection in (snapshot, exact):
            encoded = json.dumps(projection)
            for value in (secret, "list_components", "run_drc", command, project["id"], pcb, str(self.path), revision(self.path)):
                self.assertNotIn(value, encoded)
        stopped = capture("stop", projection="exact")
        self.assertEqual(stopped, {**exact, "recording": False})
        self.tool("list_components", args)
        self.assertEqual(capture("snapshot"), {**snapshot, "recording": False})
        self.assertEqual(capture("start")["rows"], [])
        self.assertEqual(capture("stop")["rows"], [])
        self.assertEqual(authored_files(self.path.parent), original)

    def test_compare_git_head_reads_committed_to_saved_changes(self):
        def git(*args):
            return subprocess.check_output(["git", "-C", str(self.path.parent), "-c", "user.name=Test",
                "-c", "user.email=test@example.invalid", "-c", "commit.gpgSign=false", *args], text=True).strip()

        def track(i, net):
            return {"kind":"track", "id":i, "width":0.2, "layer":"Top", "points":[[0,0],[2,0]], "net":net}

        board = {"name":"Main", "id":"b", "kind":"pcb", "grid":0.25, "outline":[], "notes":[],
                 "items":[track("t", "VIN"), track("old", "RET")]}
        project = {"id":"test-power", "name":"Power", "format":"atrium", "version":1, "documents":[board], "library":[]}
        write_design(self.path, project)
        self.initialize()
        self.assertIn("worktree", self.tool("compare_git_head", error=True))
        self.assertFalse(self.tool("project_history")["repository"])
        git("init", "--quiet")
        git("add", "--", self.path.name, "Main.wpcb")
        git("commit", "--quiet", "-m", "First saved board")
        head = git("rev-parse", "HEAD")
        self.assertEqual(self.tool("compare_git_head")["items"], [])
        history = self.tool("project_history", {"limit": 1})
        first_commit = history["commits"][0]
        self.assertEqual(first_commit["revision"], head)
        self.assertEqual(first_commit["parents"], [])
        self.assertIsNone(first_commit["before_blob"])
        self.assertEqual(first_commit["untrusted_design_text"]["subject"], "First saved board")
        self.assertIn("Main", first_commit["untrusted_design_text"]["summary"])

        board["items"][0]["width"] = 0.4
        write_design(self.path, project)
        git("add", "--", self.path.name, "Main.wpcb")
        index = self.path.parent / ".git" / "index"
        staged = index.read_bytes()
        board["items"] = [dict(board["items"][0], width=0.6, net="VOUT"), track("new", "SENSE")]
        project["name"] = "Power supply"
        write_design(self.path, project)
        current = authored_files(self.path.parent)
        saved_revision = revision(self.path)
        changes = self.tool("compare_git_head", {"limit":2})
        self.assertEqual((changes["commit"], changes["file_revision"], changes["path"]),
                         (head, saved_revision, self.path.name))
        self.assertEqual((changes["total"], changes["next_offset"]), (4,2))
        rest = self.tool("compare_git_head", {"offset":changes["next_offset"]})
        self.assertEqual(len(rest["items"]), 2)
        self.assertIsNone(rest["next_offset"])

        first = self.tool("compare_git_head", {"section":"categories", "limit":1})
        self.assertEqual(first["items"], [{"area":"PCB","Added":1,"Changed":1,"Removed":1}])
        self.assertEqual(self.tool("compare_git_head", {"section":"categories", "offset":first["next_offset"]})["items"],
                         [{"area":"Project","Added":0,"Changed":1,"Removed":0}])
        match = self.tool("compare_git_head", {"area":"PCB","status":"Changed","query":"0.2 mm"})
        self.assertEqual(match["total"], 1)
        row = match["items"][0]
        self.assertEqual((row["document_id"],row["locate_id"],row["status"]), ("b","t","Changed"))
        fields = {"section":"fields", "key":row["key"], "limit":1}
        values = self.tool("compare_git_head", fields)
        self.assertEqual(values["items"], [{"label":"Net","before":"VIN","after":"VOUT"}])
        self.assertEqual(self.tool("compare_git_head",dict(fields,offset=values["next_offset"]))["items"],
                         [{"label":"Width","before":"0.2 mm","after":"0.6 mm"}])
        self.assertIsNone(self.tool("compare_git_head", {"status":"Removed"})["items"][0]["locate_id"])
        for invalid in ({"limit":201},{"section":"fields"},{"key":row["key"]},{"area":"bad"},{"query":True},
                        {"section":"fields","key":"bad"},{"path":"another.waffle"},{"revision":"HEAD~1"}):
            self.tool("compare_git_head", invalid, error=True)
        self.assertEqual(index.read_bytes(), staged)
        self.assertEqual(git("rev-parse", "HEAD"), head)
        self.assertEqual(authored_files(self.path.parent), current)

        git("commit", "--quiet", "-m", "Staged track width")
        moved = self.tool("compare_git_head", dict(fields,offset=1))
        self.assertEqual(moved["file_revision"], saved_revision)
        self.assertNotEqual(moved["commit"], head)
        self.assertEqual(moved["commit"], git("rev-parse", "HEAD"))
        self.assertEqual(moved["items"][0]["before"], "0.4 mm")
        board["items"][0]["width"] = 0.75
        write_design(self.path, project)
        saved = self.tool("compare_git_head", dict(fields,offset=1))
        self.assertEqual(saved["commit"], moved["commit"])
        self.assertNotEqual(saved["file_revision"], moved["file_revision"])
        self.assertEqual(saved["items"], [{"label":"Width","before":"0.4 mm","after":"0.75 mm"}])
        self.assertEqual(self.tool("project_summary")["file_revision"], saved["file_revision"])

    def test_board_geometry_and_rules_are_paged_and_read_only(self):
        tracks = [
            {"id":"a","kind":"track","width":0.2,"points":[[0,0],[2,0]],"layer":"Top","net":"VIN"},
            {"id":"b","kind":"track","width":0.2,"points":[[4,0],[6,0]],"layer":"Top","net":"VIN"},
            {"id":"c","kind":"track","width":0.2,"points":[[1,-1],[1,1]],"layer":"Top","net":"GND"},
        ]
        board = {"id":"board","kind":"pcb","grid":0.25,"outline":[],"notes":["Omitted polygons6 (1)."],
                 "name":"Top","items":tracks}
        sch = {"id":"sch","name":"Schematic","kind":"schematic","grid":1.27,"outline":[],"notes":[],"items":[]}
        p={"format":"atrium","version":1,"id":self.design["id"],"name":"Geometry","library":[],"documents":[board,sch],"rules":rules_book(0.3)}
        write_design(self.path, p)
        snapshot=authored_files(self.path.parent)
        saved_revision=revision(self.path)
        self.initialize()
        args={"document_id":"board","limit":1}
        report=self.tool("board_connectivity", args)
        self.assertEqual(report["total"],2)
        self.assertEqual(report["section"],"nets")
        self.assertEqual(report["totals"],{"nets":2,"airwires":1,"shorts":1,"source_notes":1})
        self.assertIsNone(report["file_revision"])
        self.assertTrue(report["version_pending"])
        self.assertEqual(report["document_sha256"],hashlib.sha256(snapshot["Top.wpcb"]).hexdigest())
        self.assertEqual(self.tool("project_summary")["file_revision"],saved_revision)
        self.assertEqual(report["items"][0]["name"],"GND")
        second=self.tool("board_connectivity",dict(args,offset=report["next_offset"]))
        self.assertEqual(second["items"][0]["name"],"VIN");self.assertIsNone(second["next_offset"])
        self.assertEqual(self.tool("board_connectivity",dict(args,section="shorts"))["items"][0]["nets"],["GND","VIN"])
        self.assertEqual(self.tool("board_connectivity",dict(args,section="airwires"))["items"][0]["distance"],2)
        self.assertEqual(self.tool("board_connectivity",dict(args,section="source_notes"))["items"],board["notes"])
        rr=self.tool("check_board_rules",args)
        self.assertEqual(rr["rules_source"],"project");self.assertEqual(rr["total"],4)
        self.assertEqual(len(rr["items"]),1);self.assertEqual(rr["next_offset"],1)
        for tool in ("board_connectivity","check_board_rules"):
            for bad in ({"document_id":"sch"},{"document_id":"board","limit":201},{"document_id":"board","offset":-1}):
                self.tool(tool,bad,error=True)
        self.tool("board_connectivity",dict(args,section="bad"),error=True)
        self.assertEqual(authored_files(self.path.parent),snapshot)
        p["rules"]=rules_book(0.1);tracks[1]["points"]=[[2,0],[4,0]]
        write_design(self.path, p);new_report=self.tool("board_connectivity",args)
        self.assertNotEqual(report["document_sha256"],new_report["document_sha256"])
        self.assertEqual(self.tool("project_summary")["file_revision"],revision(self.path))
        self.assertEqual(new_report["totals"]["airwires"],0)
        updated=self.tool("check_board_rules",args)
        self.assertEqual(updated["rules_source"],"project");self.assertEqual(updated["total"],1)
        del p["rules"];write_design(self.path, p)
        self.assertEqual(self.tool("check_board_rules",args)["rules_source"],"defaults")

    def test_altium_source_rules_explain_without_changing_effective_rules(self):
        base = "|SCOPE2EXPRESSION=All|NETSCOPE=AnyNet|LAYERKIND=SameLayer|PRIORITY=3"
        records = [
            "RULEKIND=Width|NAME=Fine USB|ENABLED=TRUE|SCOPE1EXPRESSION=InNet('USB+')|MINLIMIT=8mil|VENDOR_FLAG=yes"+base,
            "RULEKIND=Width|NAME=Complex USB|ENABLED=TRUE|SCOPE1EXPRESSION=InNetClass('USB bus')|MINLIMIT=8mil"+base,
            "RULEKIND=RoutingVias|NAME=Drills|ENABLED=FALSE|SCOPE1EXPRESSION=All|MINHOLEWIDTH=12mil"+base.replace("PRIORITY=3","PRIORITY=2")
        ]
        source = self.path.parent / "USB.PcbDoc"
        outline = "|RECORD=Board|VX0=0mm|VY0=0mm|VX1=10mm|VY1=0mm|VX2=10mm|VY2=10mm|VX3=0mm|VY3=10mm"
        track = "|RECORD=Track|LAYER=TOP|X1=1mm|Y1=1mm|X2=9mm|Y2=1mm|WIDTH=8mil"
        source.write_text("\n".join([outline, track, *("|RECORD=DXPRule|" + row for row in records)]) + "\n",
                          encoding="utf-8")
        self.initialize()
        imported = self.tool("import_design", {"paths": [source.name], "mode": "save-as"}, timeout=30)
        self.open_project(Path(imported["path"]))
        snapshot = authored_files(self.path.parent)
        self.initialize()
        summary=next(d for d in self.tool("project_summary")["documents"] if d["kind"] == "pcb")
        self.assertEqual(summary["source_rule_count"],3)
        self.assertEqual(summary["rules_source"],"defaults")
        args={"document_id":summary["id"],"query":"usb","priority":3,"limit":1}
        report=self.tool("list_source_rules",args);self.assertEqual(report["source_rule_count"],3)
        self.assertEqual(report["total"],2);self.assertEqual(report["minimum_units"],"mm")
        first=report["items"][0];self.assertEqual(first["source_index"],0);self.assertEqual(first["fields"]["VENDOR_FLAG"],"yes")
        self.assertEqual(first["candidate"],{"key":"trackWidth","label":"Track width","value":0.2032,"net":"USB+","sourceField":"MINLIMIT"})
        self.assertEqual(first["priority"],"3");self.assertTrue(first["enabled"])
        other=self.tool("list_source_rules",dict(args,offset=report["next_offset"]))["items"][0]
        self.assertIsNone(other["candidate"]);self.assertEqual(other["first"],"InNetClass('USB bus')")
        row=self.tool("list_source_rules",dict(document_id=summary["id"],query="routingvias",priority="2"))["items"][0]
        self.assertFalse(row["enabled"]);self.assertIsNone(row["candidate"])
        self.assertEqual(self.tool("list_source_rules",dict(args,query="irrelevant"))["items"],[])
        self.tool("list_source_rules",dict(args,priority=False),error=True)
        self.tool("list_source_rules",dict(args,query=None),error=True)
        self.assertEqual(authored_files(self.path.parent),snapshot)
        editable = read_design(self.path)
        editable["rules"] = rules_book(0.15)
        clean = self.path.parent.parent / "Authored" / self.path.name
        self.open_project(write_design(clean, editable))
        self.initialize()
        changed=next(d for d in self.tool("project_summary")["documents"] if d["kind"] == "pcb")
        self.assertEqual(changed["rules_source"],"project")
        self.assertEqual(changed["source_rule_count"],0)
        self.assertEqual(self.tool("list_source_rules",args)["items"],[])

    def test_proposal_never_writes_bound_project_and_reloads_new_revision(self):
        self.initialize()
        change = {"component_id": "c1", "field": "value", "value": "22k"}
        for changes in [[], [change, change], [dict(change, field="unsupported")],
                        [dict(change, component_id="bad")], [dict(change, field="x", value=False)],
                        [dict(change, value="10k")]]:
            self.tool("propose_component_edits", {"changes": changes}, error=True)
        self.assertEqual(list(self.path.parent.glob("*.waffle-ai")), [])
        result = self.tool("propose_component_edits", {"changes": [change, dict(change, field="x", value=2)]})
        proposal_path = Path(result["proposal_file"])
        self.assertEqual(proposal_path.parent.resolve(), self.path.parent.resolve())
        self.assertEqual(proposal_path.suffix, ".waffle-ai")
        proposal = json.loads(proposal_path.read_text())
        self.assertEqual(proposal["source_sha256"], self.digest)
        self.assertEqual(proposal["project"], "Board")
        self.assertEqual(proposal["changes"][0]["before"], "10k")
        self.assertEqual(proposal["changes"][1]["after"], 2)
        self.assertEqual(authored_files(self.path.parent), self.original)
        self.design["documents"][0]["items"][0]["value"] = "different"
        write_design(self.path, self.design)
        latest = authored_files(self.path.parent)
        self.assertEqual(self.tool("project_summary")["file_revision"], revision(self.path))
        self.assertEqual(self.tool("inspect_component", {"component_id": "c1"})["component"]["value"], "different")
        self.assertEqual(authored_files(self.path.parent), latest)


ROOT = Path(__file__).resolve().parents[2]


def rules_book(track_width, clearance=0.2):
    """A project rule book holding the rules these tests check."""
    all_scope = {"languageVersion": 1, "source": "object"}

    def rule(rid, kind, name, **fields):
        return dict(id=rid, type=kind, name=name, comment="", enabled=True, priority=1, scope=dict(all_scope), **fields)

    return {"format": "atrium-rules", "version": 3, "units": "mm", "list": [
        rule("clearance-1", "clearance", "Clearance", scope2=dict(all_scope), gap=clearance),
        rule("short-1", "short", "ShortCircuit", scope2=dict(all_scope), allowed=False),
        rule("unrouted-1", "unrouted", "UnRoutedNet"),
        rule("width-1", "width", "Width", min=track_width, preferred=None, max=None)]}


def sample_project():
    """Read the sample as a live engine model through a disposable native folder."""
    with tempfile.TemporaryDirectory(prefix="waffle-sample-") as directory:
        return json.dumps(read_design(make_sample(directory))).encode()


def apply_proposal(model, proposal):
    """Review the operation with the editor's engine and read its native projection."""
    script = "(() => { const p = %s; AtriumProposal.apply(p, %s); Atrium.validate(p); return JSON.stringify(p); })()" % (
        json.dumps(model), json.dumps(proposal))
    from board_runner import JavaScriptCore, load_jsc, resolve
    lib = load_jsc()
    if lib:
        js = JavaScriptCore(lib, ("core", "eco"))
        try:
            changed = json.loads(js.value_text(js.evaluate(script)))
        finally:
            js.close()
    else:
        modules = "".join("require(%s);" % json.dumps(str(p)) for _, p in resolve(("core", "eco")))
        changed = json.loads(subprocess.check_output(["node", "-e", modules + "process.stdout.write(" + script + ")"]))
    with tempfile.TemporaryDirectory(prefix="waffle-proposal-") as directory:
        return read_design(write_design(Path(directory) / "Board.waffle", changed))


def retained_provenance(manifest):
    from server import Server
    server = Server(manifest, read_only=True)
    try:
        server.saved_bytes(require=True)
        head, body = server.folder.run("export_provenance")
        if head["source_sha256"] != server.digest:
            raise AssertionError("Import provenance came from a different saved closure.")
        return json.loads(body)
    finally:
        server.close()


class HeadlessToolTests(HeadlessFixture):
    def proposals(self):
        return sorted(self.dir.glob("*.waffle-ai"))

    def test_tool_schemas_are_tight_and_writing_is_opt_in(self):
        self.start()
        tools = {t["name"]: t for t in self.request("tools/list", {})["result"]["tools"]}
        self.assertLessEqual(HEADLESS_TOOLS, set(tools))
        for name in HEADLESS_TOOLS:
            schema = tools[name]["inputSchema"]
            self.assertFalse(schema["additionalProperties"], name)
            if "mode" in schema["properties"]:
                self.assertNotIn("write", schema["properties"]["mode"]["enum"])
                self.assertFalse(tools[name]["annotations"]["readOnlyHint"])
        self.assertTrue(tools["run_drc"]["annotations"]["readOnlyHint"])
        self.assertIn("allow-write", self.tool("pour_polygons", {"mode": "write"}, error=True))
        for name, args in [("run_drc", {"bogus": 1}), ("run_drc", {"limit": 0}), ("run_erc", {"classes": ["Severe"]}),
                           ("generate_fabrication", {"units": "cm"}), ("generate_fabrication", {"output_dir": "../escape"}),
                           ("annotate", {"order": "random"}), ("pipeline", {"steps": []}),
                           ("pipeline", {"steps": [{"tool": "pipeline"}]}), ("run_script", {"code": ""}),
                           ("pour_polygons", {"source_sha256": "0" * 64}), ("generate_bom", {"columns": ["nope"]})]:
            self.tool(name, args, error=True)
        self.assertEqual(self.proposals(), [])
        self.assertEqual(revision(self.path), self.digest)
        self.stop_server()
        self.start("--allow-write")
        tools = {t["name"]: t for t in self.request("tools/list", {})["result"]["tools"]}
        self.assertEqual(tools["pour_polygons"]["inputSchema"]["properties"]["mode"]["enum"], ["proposal", "write"])
        self.assertTrue(tools["pour_polygons"]["annotations"]["destructiveHint"])

    def test_ai_placement_routing_and_planes(self):
        self.start()
        plan = self.tool("propose_placement", {"scope": "all", "constraints": {"rip_up": True}, "mode": "plan", "seed": 3}, timeout=60)
        self.assertEqual(plan["mode"], "plan")
        self.assertGreaterEqual(len(plan["alternatives"]), 1)
        self.assertIn("wirelength_mm", plan["alternatives"][0]["score"])
        self.assertIn("designators", plan["untrusted_design_text"])
        self.assertEqual(self.proposals(), [])
        again = self.tool("propose_placement", {"scope": "all", "constraints": {"rip_up": True}, "mode": "plan", "seed": 3}, timeout=60)
        self.assertEqual(again["moves"], plan["moves"], "deterministic for a seed")
        placed = self.tool("propose_placement", {"scope": "all", "constraints": {"rip_up": True}, "seed": 3}, timeout=60)
        self.assertEqual(bool(placed["moved"]), bool(placed["proposal_file"]))
        routing = self.tool("propose_routing", {"mode": "plan", "time_limit_ms": 5000}, timeout=60)
        self.assertEqual(routing["routed"] + routing["unrouted_count"], routing["connections"])
        planes = self.tool("propose_planes", {"mode": "plan"}, timeout=60)
        self.assertTrue(planes["copper"] and "untrusted_design_text" in planes)
        self.assertIn("allow-write", self.tool("propose_planes", {"mode": "write"}, error=True))
        self.assertIn("unknown field", self.tool("propose_placement", {"constraints": {"magic": 1}}, error=True))
        support = self.tool("place_support_components", {"mode": "plan", "scope": "all"}, timeout=60)  # sync-placement
        self.assertEqual((support["mode"], support["moved"]), ("plan", 0))
        self.assertTrue(all("ref" in m["untrusted_design_text"] for m in support["moves"]))
        self.assertIn("allow-write", self.tool("place_support_components", {"mode": "write"}, error=True))
        self.assertIn("unknown field", self.tool("place_support_components", {"magic": 1}, error=True))
        self.assertEqual(revision(self.path), self.digest)

    def test_library_sources_and_import(self):
        import shutil
        fixtures = Path(__file__).resolve().parents[1] / "fixtures" / "kicad"
        shutil.copytree(fixtures, self.dir / "lib")
        cache = self.dir / "cache"
        old = {k: os.environ.get(k) for k in ("ATRIUM_LIBRARY_CACHE", "ATRIUM_LIBRARY_FOLDERS")}
        os.environ["ATRIUM_LIBRARY_CACHE"] = str(cache)
        os.environ.pop("ATRIUM_LIBRARY_FOLDERS", None)
        self.addCleanup(lambda: [os.environ.pop(k, None) if v is None else os.environ.__setitem__(k, v) for k, v in old.items()])
        self.start()
        first = self.tool("library_sources", {"folders": ["lib"], "query": "OPA"}, timeout=60)
        folder = first["folders"][0]
        self.assertEqual((folder["components"], folder["paired"], folder["symbol_only"], folder["footprint_only"]), (7, 5, 1, 1))
        self.assertEqual(folder["scan"]["read"], 8)
        self.assertEqual(sorted(m["name"] for m in folder["untrusted_design_text"]["matches"]), ["OPA_DUAL", "OPA_DUAL_DFN"])
        self.assertTrue(list(cache.glob("*.json")), "the index is cached outside the folder")
        self.assertFalse(any(p.name.startswith(".waffle") for p in (self.dir / "lib").rglob("*")), "nothing is written into the folder")
        # An older search projection is rebuilt even if the listed file stamps still match.
        cached = next(cache.glob("*.json"))
        index = json.loads(cached.read_text())
        for legacy in (1, 2):
            cached.write_text(json.dumps(dict(index, version=legacy)))
            self.assertEqual(self.tool("library_sources", {"folders": ["lib"]}, timeout=60)["folders"][0]["scan"]["read"], 8)
        future = json.dumps(dict(index, version=index["version"] + 1))
        cached.write_text(future)
        self.assertIn("newer version", self.tool("library_sources", {"folders": ["lib"]}, error=True))
        self.assertEqual(cached.read_text(), future)
        cached.write_text(json.dumps(index))
        # A second listing reads nothing; an edit to one file reads that file only.
        self.assertEqual(self.tool("library_sources", {"folders": ["lib"]}, timeout=60)["folders"][0]["scan"]["read"], 0)
        mod = self.dir / "lib" / "Lab_Package.pretty" / "TestPad_Test.kicad_mod"
        mod.write_text(mod.read_text().replace("(size 1 1)", "(size 1.2 1.2)"))
        os.utime(mod, (time.time() + 5, time.time() + 5))
        self.assertEqual(self.tool("library_sources", {"folders": ["lib"]}, timeout=60)["folders"][0]["scan"]["read"], 1)
        self.assertIn("relative", self.tool("library_sources", {"folders": ["/etc"]}, error=True))
        # Import: KiCad symbols paired with the footprints in the given files, as drafts, in a proposal.
        r = self.tool("library_import", {"paths": ["lib/Lab_Amp.kicad_sym", "lib/Lab_Package.pretty"], "components": ["OPA_DUAL", "LDO_Test"]}, timeout=60)
        self.assertEqual(r["added"], 2)
        self.assertEqual(r["pin_pad_mismatches"], 1)
        self.assertEqual(sorted(c["name"] for c in r["untrusted_design_text"]["components"]), ["LDO_Test", "OPA_DUAL"])
        self.assertEqual(len(self.proposals()), 1)
        self.assertEqual(revision(self.path), self.digest)
        self.assertIn("inside the project folder", self.tool("library_import", {"paths": ["/etc/hosts"]}, error=True))

    def test_calculate(self):
        self.start()
        names = [c["id"] for c in self.tool("calculate", {"calculator": "list"})["calculators"]]
        self.assertIn("track_width", names)
        r = self.tool("calculate", {"calculator": "track_width", "inputs": {"current": 1, "rise": 10, "copper": 1}})
        self.assertAlmostEqual(r["values"]["width_ipc2221"], 0.304, delta=0.006)
        self.assertTrue(r["formula"] and r["assumptions"] and r["sources"])
        imp = self.tool("calculate", {"calculator": "impedance", "inputs": {"width": 0.3}})
        self.assertEqual(imp["values"]["layer"], "Top")
        self.assertGreater(imp["values"]["impedance"], 20)
        self.assertEqual(self.tool("calculate", {"calculator": "eseries", "inputs": {"value": 5000}})["values"]["nearest"], 5100)
        self.assertEqual(self.tool("calculate", {"calculator": "eseries", "inputs": {"value": "4k7"}})["values"]["nearest"], 4700)
        derating = self.tool("calculate", {"calculator": "derating", "inputs": {"rated": 32, "knee": 64, "tmax": 128, "ambient": 80}})
        self.assertEqual(derating["values"]["allowed"], 24)
        self.assertIn("Unknown input", self.tool("calculate", {"calculator": "ohm", "inputs": {"x": 1}}, error=True))
        self.assertEqual(revision(self.path), self.digest)

    def test_rule_sets_and_via_stubs(self):
        self.start()
        sets = self.tool("list_rule_sets")
        self.assertEqual([s["name"] for s in sets["items"]], ["JLC 2-layer", "JLC 4-layer", "PCBWay standard"])
        self.assertTrue(all(s["approximate"] and s["builtin"] for s in sets["items"]))
        self.assertIsNone(sets["active"])
        drc = self.tool("run_drc", {"rule_set": "JLC 2-layer", "rules": ["clearance"]})
        self.assertEqual(drc["rule_set"], "JLC 2-layer")
        self.assertEqual(drc["rules_source"], "rule_set")
        self.assertIsNone(self.tool("run_drc", {"rules": ["width"]})["rule_set"])
        self.assertIn("No rule set", self.tool("run_drc", {"rule_set": "Nope"}, error=True))
        stubs = self.tool("via_stub_report")
        self.assertEqual(stubs["counts"]["vias"], stubs["total"])
        self.assertGreater(stubs["total"], 0)
        self.assertTrue(all(v["status"] == "ok" and v["used_layers"] == ["Top", "Bottom"] for v in stubs["items"]))
        self.assertEqual(self.tool("via_stub_report", {"only_flagged": True})["total"], 0)
        self.assertEqual(revision(self.path), self.digest)

    def test_constraint_manager(self):
        self.start()
        nets = self.tool("constraints", {"action": "list", "tab": "nets", "limit": 200})
        by = {r["name"]: r for r in nets["items"]}
        self.assertIn("VDD", by)
        self.assertGreater(by["VDD"]["length"], 0)
        self.assertTrue(any(c["key"] == "widthMin" and c["editable"] for c in nets["columns"]))
        set_ = self.tool("constraints", {"action": "set", "tab": "nets", "name": "VDD", "key": "widthMin", "value": 0.6})
        self.assertTrue(set_["proposal_file"])
        self.assertIn("Width_VDD", set_["applied"][0])
        tpl = self.tool("constraints", {"action": "apply_template", "template": "Power", "create_from": {"net": "VDD"}, "members": ["GND"]})
        self.assertEqual(len(tpl["applied"]), 2)
        dfa = self.tool("constraints", {"action": "list", "tab": "dfa"})
        self.assertIsNone(dfa["rule"])
        self.assertTrue(any(t["type"] == "0603" for t in dfa["package_types"]))
        self.assertEqual(revision(self.path), self.digest)

    def test_suggest_route(self):
        if "route-suggest" not in dict(resolve(("route-suggest",))):
            self.skipTest("Route suggestions are unavailable in this build")
        self.start()
        r = self.tool("suggest_route", {"from": {"component": "R1", "pad": "2"}, "to": {"component": "C1", "pad": "1"}}, timeout=30)
        self.assertTrue(r["read_only"])
        self.assertEqual(r["net"], "FILTER")
        self.assertGreaterEqual(len(r["alternatives"]), 1)
        best = r["alternatives"][0]
        self.assertTrue(best["proposal"]["add"] and all(i["net"] == "FILTER" for i in best["proposal"]["add"]))
        self.assertGreater(best["length"], 0)
        self.assertEqual(revision(self.path), self.digest)  # read-only

    def test_si_simulate(self):
        self.start()
        with self.assertRaises(Exception) as missing:
            self.tool("si_simulate", {"net": "NO_SUCH_NET"})
        self.assertIn("no routed tracks", str(missing.exception))
        routed = [i["net"] for d in self.design["documents"] if d["kind"] == "pcb" for i in d["items"] if i["kind"] == "track" and i.get("net") and i["net"] != "GND"]
        if routed:
            r = self.tool("si_simulate", {"net": routed[0], "corners": ["typ"], "crosstalk": False})
            self.assertEqual(r["net"], routed[0])
            self.assertTrue(r["metrics"])
        self.assertEqual(revision(self.path), self.digest)

    def test_high_speed_tools(self):
        self.start()
        fs = self.tool("field_solve", {"geometry": {"structure": "microstrip", "w": 0.3, "h": 0.2, "t": 0.035, "er": 4.2}, "quality": "fast"})
        self.assertTrue(fs["result"]["ok"])
        self.assertLess(abs(fs["result"]["z"] - fs["closed_form"]["z"]) / fs["closed_form"]["z"], 0.05)
        plan = self.tool("impedance_plan", {"spec": {"target": 50, "kind": "se"}})
        self.assertTrue(plan["read_only"])
        self.assertEqual([r["key"] for r in plan["layers"]], ["Top", "Bottom"])
        self.assertTrue(all(r["reachable"] and r["width"] > 0 for r in plan["layers"]))
        far = self.tool("impedance_plan", {"spec": {"target": 200, "kind": "se", "layers": ["Top"]}})
        self.assertFalse(far["reachable"])
        row = far["layers"][0]
        self.assertEqual(row["reason"], "width")
        kinds = [x["kind"] for x in row["suggestions"]]
        self.assertEqual(kinds[-1], "target")
        self.assertEqual([x["rank"] for x in row["suggestions"]], list(range(1, len(kinds) + 1)))
        self.assertLess(row["suggestions"][-1]["target"], 200)
        self.assertIn("spec or a profile", self.tool("impedance_plan", {}, error=True))
        self.assertIn("No impedance profile", self.tool("impedance_plan", {"profile": "nope"}, error=True))
        xs = self.tool("xsignals", {"action": "list"})
        self.assertEqual(xs["classes"], {})
        topo = self.tool("topology", {"net": "VDD", "topology": "starburst"})
        self.assertEqual(topo["nets"][0]["net"], "VDD")
        self.assertIn(topo["nets"][0]["shape"], ("chain", "star", "T", "tree", "partial", "unrouted", "point"))
        add = self.tool("xsignals", {"action": "add", "xsignals": [{"name": "X1", "from": {"ref": "U1", "pin": "1"}, "to": {"ref": "C1", "pin": "1"}}], "class": "TEST"})
        self.assertTrue(add["proposal_file"])
        self.assertEqual(revision(self.path), self.digest)

    def test_unified_check_waive_and_pinned_aliases(self):
        """check lists every engine's findings in one shape; waive/waivers write proposals; the old tools' output is pinned."""
        self.start()
        everything = self.tool("check", {"limit": 500})
        self.assertEqual(everything["file_revision"], self.digest)
        self.assertEqual(everything["total"], sum(everything["counts"].values()))
        domains = {v["domain"] for v in everything["items"]}
        self.assertEqual(domains, {"schematic", "layout"})
        for v in everything["items"]:
            self.assertTrue(v["key"].startswith(v["check"] + ":") or v["check"].startswith("layout.") or v["check"].startswith("schematic."), v)
            self.assertIn(v["severity"], ("fatal", "error", "warning", "hint"))
        # The old tools are aliases of the same engines: their findings appear in check.
        drc = self.tool("run_drc", {"limit": 200})
        erc = self.tool("run_erc", {"limit": 200})
        layout = self.tool("check", {"domains": ["layout"], "hints": False, "merge": False, "limit": 500})
        board = [v for v in layout["items"] if not v["check"].startswith("layout.fab.")]
        antennae = [v for v in board if v["check"] == "layout.netAntennae"]
        self.assertEqual(len(board) - len(antennae), drc["total"])
        # The unified check includes the native warning. Legacy callers opt in to its rows.
        requested = self.tool("run_drc", {"rules": ["netAntennae"], "limit": 200})
        self.assertEqual(requested["total"], 1)
        self.assertCountEqual(
            [(v["objects"], v["at"], v["rule_id"], v["severity"]) for v in antennae],
            [([v["id"]], [v["at"]], v["rule_id"], v["severity"]) for v in requested["items"]],
        )
        schematic = self.tool("check", {"domains": ["schematic"], "hints": False, "limit": 500})
        self.assertEqual(schematic["total"], erc["counts"]["Fatal"] + erc["counts"]["Error"] + erc["counts"]["Warning"])
        only = self.tool("check", {"checks": ["schematic.unannotated"]})
        self.assertTrue(only["items"] and all(v["check"] == "schematic.unannotated" for v in only["items"]))
        # Pinned: the alias tools' output is what it was before the unified engine (tests/goldens/mcp-aliases.json).
        golden = json.loads((Path(__file__).parents[1] / "goldens" / "mcp-aliases.json").read_text())
        ids = {d["id"]: "<" + d["kind"] + str(i) + ">" for i, d in enumerate(self.design["documents"])}
        ids.update({it["id"]: "<" + d["kind"] + str(i) + ":" + str(k) + ">" for i, d in enumerate(self.design["documents"]) for k, it in enumerate(d["items"]) if it.get("id")})

        def normalize_ids(value, field=None):
            if isinstance(value, dict):
                return {key: normalize_ids(item, key) for key, item in value.items()}
            if isinstance(value, list):
                return [normalize_ids(item, field) for item in value]
            if isinstance(value, str) and field in {"id", "object_id", "other_id", "document_id", "objects"}:
                return ids.get(value, value)
            if isinstance(value, str) and field == "key":
                return re.sub(r"^(\w+):[0-9a-f]{16}$", r"\1:<hash>", value)
            return value

        def strip(d):
            # Map owner and object IDs to the positions used by the existing golden.
            out = normalize_ids({k: v for k, v in d.items() if k not in ("file_revision", "ms", "stats")})
            for item in out.get("items", []):
                if isinstance(item, dict) and isinstance(item.get("objects"), list):
                    item["objects"] = sorted(item["objects"], key=str)
            return out
        self.assertEqual(strip(drc), golden["run_drc"])
        self.assertEqual(strip(erc), golden["run_erc"])
        self.assertEqual(strip(self.tool("drc_waivers")), golden["drc_waivers"])
        self.assertEqual(strip(self.tool("dfm_check")), golden["dfm_check"])
        self.assertEqual(strip(self.tool("list_insights", {"limit": 200})), golden["list_insights"])
        # waive: a proposal (the file is unchanged); the waiver holds in the proposed project.
        target = next(v for v in everything["items"] if v["domain"] == "layout" and v["objects"] and v["severity"] != "hint")
        waived = self.tool("waive", {"violation_key": target["key"], "note": "checked with the fab"})
        self.assertTrue(waived["waived"]); self.assertTrue(waived["proposal_file"])
        self.assertEqual(revision(self.path), self.digest)
        self.assertIn("No problem with key", self.tool("waive", {"violation_key": "layout.clearance:0"}, error=True))
        listed = self.tool("waivers")
        self.assertEqual((listed["total"], listed["stale"]), (0, 0), "the saved file has no waivers yet")

    def test_checks_rules_and_lengths(self):
        self.start()
        erc = self.tool("run_erc")
        self.assertFalse(erc["passed"])
        self.assertEqual(erc["file_revision"], self.digest)
        self.assertGreaterEqual(erc["counts"]["Error"] + erc["counts"]["Warning"], 1)
        self.assertIn("unannotated", erc["by_check"])
        listed = [m for group in erc["classes"].values() for m in group["items"]]
        self.assertTrue(any(m["check"] == "unannotated" and m["object_id"] for m in listed))
        self.assertEqual(set(self.tool("run_erc", {"classes": ["Info"]})["classes"]) - {"Info"}, set())
        drc = self.tool("run_drc", {"rules": ["width"]})
        thin = [v for v in drc["items"] if v["id"] == "thin"]
        self.assertEqual(len(thin), 1)
        self.assertEqual((thin[0]["actual"], thin[0]["required"], thin[0]["limit"]), (0.05, 0.15, "min"))
        self.assertEqual(len(thin[0]["at"]), 2)
        self.assertEqual(drc["rules"], [{"id": "width-1", "name": "Width", "type": "width", "count": 1}])
        everything = self.tool("run_drc", {"limit": 1})
        self.assertGreaterEqual(everything["total"], drc["total"])
        if everything["total"] > 1:
            self.assertEqual(everything["next_offset"], 1)
        self.assertEqual(self.tool("run_drc", {"rules": ["Width"]})["matching"], 1)
        self.tool("run_drc", {"document_id": next(d["id"] for d in self.design["documents"] if d["kind"] == "schematic")}, error=True)
        rules = self.tool("list_rules", {"type": "width"})
        self.assertEqual(rules["rules_source"], "defaults")
        self.assertEqual(rules["items"][0]["id"], "width-1")
        rule = self.tool("get_rule", {"rule_id": "width-1"})
        self.assertEqual(rule["rule"]["min"], 0.15)
        self.assertIn("min", [f["key"] for f in rule["type"]["fields"]])
        self.assertEqual(self.tool("get_rule")["net_classes"], {})
        self.tool("get_rule", {"rule_id": "missing"}, error=True)
        lengths = self.tool("net_lengths", {"nets": ["GND"]})
        self.assertEqual(lengths["items"][0]["net"], "GND")
        self.assertGreater(lengths["items"][0]["length"], 0)
        self.assertGreater(self.tool("net_lengths")["total"], 1)
        self.assertEqual(self.tool("matched_length_report")["groups"], 0)
        stack = self.tool("stackup_get")
        self.assertEqual(stack["copper_layers"], ["Top", "Bottom"])
        self.assertTrue(stack["derived"])
        self.assertEqual(self.proposals(), [])
        self.assertEqual(revision(self.path), self.digest)

    def test_render_resolves_board_text_from_the_open_project(self):
        board = next(d for d in self.design["documents"] if d["id"] == self.pcb)
        label = {"id": "test-title", "kind": "label", "layer": "Silk", "size": 1.5,
                 "x": 2, "y": 5, "text": ".ProjectTitle"}
        board["items"] = [label]
        self.design["parameters"] = {"ProjectTitle": "Sensor Rev A"}

        def render():
            write_design(self.path, self.design)
            self.start()
            result = self.tool("render", {"document_id": self.pcb, "region": [0, 0, 36, 22], "airwires": False})
            return Path(result["path"]).read_bytes()

        from_parameter = render()
        label["text"] = "Sensor Rev A"
        self.assertEqual(render(), from_parameter)
        label["text"] = ".ProjectTitle"
        self.design["parameters"]["ProjectTitle"] = "B"
        self.assertNotEqual(render(), from_parameter)

    def test_fabrication_reopens_and_checks_inherited_pour_rules(self):
        board = next(d for d in self.design["documents"] if d["id"] == self.pcb)
        zone = next(i for i in board["items"] if i["id"] == "gndpour")
        zone.update(layer="Top", points=[[1, 1], [30, 1], [30, 30], [1, 30]], removeDeadCopper=False)
        via = {"id": "other", "kind": "via", "layer": "Multi", "net": "B", "x": 7, "y": 7, "diameter": .8, "drill": .3}
        board = {"id": self.pcb, "kind": "pcb", "name": "Guard", "grid": .25, "notes": [],
                 "outline": [[0, 0], [50, 0], [50, 40], [0, 40]], "items": [zone, via]}
        project = {"format": "atrium", "version": 1, "name": "Guard",
                   "library": [], "documents": [board], "rules": rules_book(.15)}
        write_design(self.path, project)

        def repour(selected=False):
            self.start("--allow-write")
            args = {"mode": "write", "source_sha256": revision(self.path)}
            if selected:
                args["polygon_ids"] = [zone["id"]]
            self.tool("pour_polygons", args)

        def plot(folder):
            # A fresh server must recognise stale copper without an earlier command loading the solver.
            self.start()
            result = self.tool("generate_fabrication", {"include": ["gerber"], "output_dir": folder,
                               "date": "2026-01-02T03:04:05Z"})
            top = next(Path(f["path"]) for f in result["files"] if f["path"].endswith(".GTL"))
            return top.read_bytes(), result["warnings"]

        repour()
        original = authored_files(self.dir)
        initial, warnings = plot("initial")
        self.assertFalse(warnings)
        self.assertIn(b"G36*", initial)
        edited = read_design(self.path)
        next(r for r in edited["rules"]["list"] if r["type"] == "clearance")["gap"] = 1.4
        write_design(self.path, edited)
        edited_files = authored_files(self.dir)
        # Stale copper is never plotted or left out: the outputs carry the exact fill, the file is not changed.
        stale, warnings = plot("stale")
        self.assertIn(b"G36*", stale)
        self.assertTrue(any("filled again for these outputs" in w for w in warnings), warnings)
        # An output job on the same stale file (a fresh server) plots the same copper and reports the same note.
        self.start("--allow-write")
        job = self.tool("run_output_job", {"definition": {"name": "Fab", "folder": "job", "outputs": [{"kind": "gerber", "options": {"readme": False}}]},
                                           "date": "2026-01-02T03:04:05Z", "output_dir": "stale-job"})
        self.assertEqual(Path(next(f["path"] for f in job["files"] if f["path"].endswith(".GTL"))).read_bytes(), stale)
        self.assertTrue(any("filled again for these outputs" in w for w in job["report"]["warnings"]), job["report"]["warnings"])
        self.assertEqual(authored_files(self.dir), edited_files)
        repour(selected=True)
        fresh, warnings = plot("reopened-selected")
        self.assertFalse(warnings)
        self.assertIn(b"G36*", fresh)
        self.assertNotEqual(fresh, initial)
        self.assertEqual(stale, fresh)
        self.restore_authored_files(edited_files)
        repour()
        self.assertEqual(plot("reopened-all"), (fresh, []))
        self.restore_authored_files(original)
        self.assertEqual(plot("restored"), (initial, []))

    def test_fabrication_nc_origin_and_atomic_range_check(self):
        board = next(d for d in self.design["documents"] if d["id"] == self.pcb)
        board.update(origin=[10, 30], outline=[[0, 0], [40, 0], [40, 40], [0, 40]],
                     items=[{"id": "via", "kind": "via", "layer": "Multi", "x": 12, "y": 23,
                             "diameter": 0.8, "drill": 0.4, "net": "GND"}])
        self.design["documents"].append({
            "id": "remote", "kind": "pcb", "name": "Remote", "grid": 0.25, "notes": [], "origin": [3000, 3000],
            "outline": [[3000, 2990], [3010, 2990], [3010, 3000], [3000, 3000]],
            "items": [{"id": "via-remote", "kind": "via", "layer": "Multi", "x": 3003, "y": 2995,
                       "diameter": 0.8, "drill": 0.4, "net": "GND"}],
        })
        write_design(self.path, self.design)
        saved = revision(self.path)
        self.start()
        args = {"document_id": self.pcb, "date": "2026-01-02T00:00:00Z", "include": ["gerber", "drill", "pnp"]}

        def generated(options):
            result = self.tool("generate_fabrication", {**args, **options})
            return result["options"], {Path(f["path"]).name: Path(f["path"]).read_text() for f in result["files"]}

        common, before = generated({"output_dir": "shared-nc"})
        separate, after = generated({"output_dir": "absolute-nc", "drill_origin": "absolute"})
        self.assertEqual((common["drillOrigin"], separate["drillOrigin"]), ("shared", "absolute"))
        self.assertEqual(before.keys(), after.keys())
        drill, = [name for name in before if name.endswith("-Plated.TXT")]
        self.assertIn("\nX2.0Y7.0\n", before[drill])
        self.assertIn("\nX12.0Y-23.0\n", after[drill])
        self.assertIn("\nT01C0.400\n", after[drill])
        self.assertEqual({k: v for k, v in before.items() if k != drill}, {k: v for k, v in after.items() if k != drill})

        profile_options, profiled = generated({"output_dir": "profile-width", "profile_width": 0.0254})
        profile, = [name for name in before if name.endswith(".GM1")]
        self.assertEqual(profile_options["profileWidth"], 0.0254)
        self.assertEqual(profiled[profile], before[profile].replace("C,0.1*%", "C,0.0254*%"))
        self.assertEqual({k: v for k, v in before.items() if k != profile}, {k: v for k, v in profiled.items() if k != profile})
        invalid_pen = self.tool("generate_fabrication", {**args, "units": "in", "profile_width": 1e-9, "output_dir": "invalid-pen"}, error=True)
        self.assertIn("profile stroke width", invalid_pen)
        self.assertFalse((self.dir / "Sensor-outputs" / "invalid-pen").exists())

        wide = {**args, "document_id": "remote", "drill_units": "in", "drill_format": "2:4"}
        legal = self.tool("generate_fabrication", {**wide, "output_dir": "remote-shared"})
        self.assertTrue(any(f["kind"] == "drill" for f in legal["files"]))
        invalid = self.tool("generate_fabrication", {**wide, "output_dir": "remote-failed", "drill_origin": "absolute"}, error=True)
        self.assertIn("exceeds the 2:4 format", invalid)
        self.assertFalse((self.dir / "Sensor-outputs" / "remote-failed").exists(), "format failure published no partial set")
        self.assertEqual(revision(self.path), saved)

    def test_outputs_are_written_beside_the_project(self):
        self.start()
        fab = self.tool("generate_fabrication", {"date": "2026-01-02T03:04:05Z", "units": "in", "include": ["gerber", "drill", "pnp"]})
        names = [Path(f["path"]).name for f in fab["files"]]
        self.assertTrue(any(n.endswith(".GTL") for n in names) and any(n.endswith(".TXT") for n in names) and any(n.endswith(".csv") for n in names))
        self.assertFalse(any(n.endswith(".svg") for n in names))
        # Named like File › Fabrication Outputs: the project name slugified ("Sensor interface" -> "Sensor-interface").
        self.assertIn("Sensor-interface.GTL", names)
        self.assertIn("Board.GTL", [Path(f["path"]).name for f in self.tool("generate_fabrication", {"include": ["gerber"], "file_stem": "Board", "output_dir": "stem"})["files"]])
        for f in fab["files"]:
            data = Path(f["path"]).read_bytes()
            self.assertEqual((len(data), hashlib.sha256(data).hexdigest()), (f["bytes"], f["sha256"]))
            self.assertEqual(Path(f["path"]).parent, self.dir.resolve() / "Sensor-outputs" / "fabrication")
        top = next(Path(f["path"]) for f in fab["files"] if f["path"].endswith(".GTL")).read_text()
        self.assertIn("%MOIN*%", top)
        packed = self.tool("generate_fabrication", {"zip": True, "output_dir": "release", "date": "2026-01-02T03:04:05Z", "units": "in",
                                                    "include": ["gerber", "drill", "pnp"]})
        import zipfile
        with zipfile.ZipFile(packed["zip"]["path"]) as archive:
            self.assertEqual(sorted(archive.namelist()), sorted(names))
            for entry in packed["zip"]["files"]:
                self.assertEqual(hashlib.sha256(archive.read(entry["name"])).hexdigest(), entry["sha256"])
        self.assertEqual({e["sha256"] for e in packed["zip"]["files"]}, {f["sha256"] for f in fab["files"]})
        self.assertEqual(Path(packed["zip"]["path"]).parent, self.dir.resolve() / "Sensor-outputs" / "release")
        self.assertEqual(Path(packed["zip"]["path"]).name, "Sensor-interface-Fabrication.zip")
        bom = self.tool("generate_bom", {"formats": ["csv", "xlsx", "html"], "group_by": ["comment"], "preview": 2,
                                         "columns": ["designator", "comment", "quantity"]})
        self.assertEqual(bom["columns"], ["designator", "comment", "quantity"])
        self.assertEqual(len(bom["preview"]), 2)
        files = {f["format"]: Path(f["path"]) for f in bom["files"]}
        self.assertIn("Designator", files["csv"].read_text(encoding="utf-8-sig"))
        with zipfile.ZipFile(files["xlsx"]) as archive:
            self.assertIn("xl/worksheets/sheet1.xml", archive.namelist())
        self.assertIn("<table>", files["html"].read_text())
        kicad = self.tool("export_kicad")
        self.assertEqual(sorted(Path(f["path"]).suffix for f in kicad["files"] if not f.get("companion")), [".kicad_pcb", ".kicad_sch"])
        self.assertIn(".kicad_pro", [Path(f["path"]).suffix for f in kicad["files"] if f.get("companion")])
        altium = self.tool("export_altium")
        self.assertEqual(sorted(Path(f["path"]).suffix for f in altium["files"]), [".PcbDoc", ".PrjPcb", ".SchDoc"])
        self.assertTrue(altium["preview"] and Path(altium["files"][1]["path"]).read_bytes().startswith(b"|"))
        self.assertTrue(Path(kicad["files"][0]["path"]).read_text().startswith("(kicad_"))
        view = self.tool("render", {"width": 800})
        drawing = Path(view["path"]).read_text()
        self.assertTrue(drawing.startswith("<svg") and drawing.rstrip().endswith("</svg>"))
        self.assertEqual((view["kind"], view["width"]), ("pcb", 800))
        self.assertGreater(view["elements"], 50)
        region = self.tool("render", {"region": [0, 0, 10, 10], "width": 400, "airwires": False})
        self.assertLess(region["elements"], view["elements"])
        sheet = next(d["id"] for d in self.design["documents"] if d["kind"] == "schematic")
        sheet_view = self.tool("render", {"document_id": sheet})
        self.assertEqual(sheet_view["kind"], "schematic")
        self.assertIn(">R?<", Path(sheet_view["path"]).read_text())
        assembly = self.tool("render", {"style": "assembly", "side": "Top"})
        self.assertIn("<svg", Path(assembly["path"]).read_text())
        pdf = self.tool("export_pdf", {"layer_sets": ["top", "bottom", "drill"], "date": "2026-11-18T00:00:00Z"}, timeout=30)
        data = Path(pdf["path"]).read_bytes()
        self.assertTrue(data.startswith(b"%PDF-1.4") and data.endswith(b"%%EOF\n"))
        self.assertEqual([p["kind"] for p in pdf["pages"]], ["schematic", "pcb", "pcb", "drill"])
        self.assertGreater(pdf["links"], 0)
        self.assertEqual(pdf["sha256"], self.tool("export_pdf", {"layer_sets": ["top", "bottom", "drill"], "date": "2026-11-18T00:00:00Z"}, timeout=30)["sha256"])
        self.assertEqual(self.proposals(), [])
        self.assertEqual(revision(self.path), self.digest)

    def test_edit_tools_write_reviewable_proposals(self):
        self.start()
        plan = self.tool("annotate", {"action": "update"})
        self.assertEqual(plan["schematic_changes"], 1)
        self.assertEqual(plan["items"][0]["current"], "R?")
        self.assertEqual(self.proposals(), [])
        annotated = self.tool("annotate", {"mode": "proposal", "action": "update"})
        proposal = json.loads(Path(annotated["proposal_file"]).read_text())
        self.assertEqual((proposal["format"], proposal["version"], proposal["source_sha256"]), ("atrium-ai", 1, self.digest))
        self.assertEqual(proposal["changes"][0]["field"], "ref")
        self.assertEqual(proposal["changes"][0]["before"], "R?")
        name = Path(annotated["proposal_file"]).name
        review = self.tool("apply_proposal", {"file": name})
        self.assertEqual((review["total"], review["source_sha256"], review["proposal_sha256"]),
                         (1, self.digest, annotated["sha256"]))
        self.assertIn("--allow-write", self.tool("apply_proposal", {"file": name, "mode": "write"}, error=True))
        self.assertEqual(authored_files(self.dir), self.fixture)

        poured = self.tool("pour_polygons", {"source_sha256": self.digest}, timeout=20)
        self.assertGreater(poured["regions"], 0)
        proposal = json.loads(Path(poured["proposal_file"]).read_text())
        self.assertEqual((proposal["version"], proposal["tool"], proposal["source_sha256"]), (2, "pour_polygons", self.digest))
        self.assertTrue(any(op["op"] == "set" and op["target"] == "document" and op["path"][0] == "pcbDrawing" for op in proposal["ops"]))
        self.assertEqual(apply_proposal(read_design(self.path), proposal), self.applied_by_write("pour_polygons", {}))
        # The Pours panel's settings and actions (pour-manager.js): list, Remove Necks, shelve.
        listed = self.tool("pour_polygons", {"action": "list"}, timeout=20)
        pid = listed["pours"][0]["id"]
        self.assertIn(listed["pours"][0]["state"], ("current", "stale", "unpoured"))
        self.assertIn("dead_islands", listed["pours"][0])
        necked = self.tool("pour_polygons", {"polygon_ids": [pid], "settings": {"neck_width": 0.3, "remove_dead_copper": False}, "source_sha256": self.digest}, timeout=30)
        row = next(r for r in necked["pours"] if r["id"] == pid)
        self.assertEqual((row["neck_width"], row["remove_dead_copper"], row["state"]), (0.3, False, "current"))
        shelved = self.tool("pour_polygons", {"polygon_ids": [pid], "action": "shelve", "source_sha256": self.digest}, timeout=20)
        self.assertEqual(shelved["shelved"], [pid])
        self.assertEqual(next(r for r in shelved["pours"] if r["id"] == pid)["state"], "shelved")
        self.tool("pour_polygons", {"settings": {"neck_width": 9}}, error=True)
        self.tool("pour_polygons", {"settings": {"fill": "outline"}}, error=True)

        change = self.tool("propose_rule_change", {"changes": [
            {"action": "update", "rule_id": "width-1", "set": {"min": 0.04}},
            {"action": "add", "type": "matchedLengths", "name": "Analog", "set": {"tolerance": 1, "scope": {"kind": "netclass", "value": "Analog"}}},
            {"action": "set_net_class", "name": "Analog", "nets": ["BUF", "FILTER"]}]})
        self.assertEqual(change["target"], "board")
        proposal = json.loads(Path(change["proposal_file"]).read_text())
        rules = next(op for op in proposal["ops"] if op["path"] == ["rules"])["after"]
        width = next(r for r in rules["list"] if r.get("origin") == {"kind":"default", "key":"width-1"})
        self.assertEqual((uuid.UUID(width["id"]).version, width["min"]), (7, 0.04))
        self.assertEqual([r["min"] for r in rules["list"] if (r["type"], r["name"]) == ("width", "Width")], [0.04])
        self.tool("propose_rule_change", {"changes": [{"action": "update", "rule_id": "width-1", "set": {"min": -1}}]}, error=True)
        self.tool("propose_rule_change", {"changes": [{"action": "update", "rule_id": "width-1", "set": {"gap": 1}}]}, error=True)

        stack = self.tool("stackup_propose", {"preset": "4"})
        self.assertEqual(stack["copper_layers"], ["Top", "Inner 1", "Inner 2", "Bottom"])
        self.assertEqual(json.loads(Path(stack["proposal_file"]).read_text())["ops"][0]["path"], ["stackup"])
        self.assertEqual(self.tool("stackup_propose", {"preset": "6", "mode": "plan"})["copper_layers"], 6)
        self.tool("stackup_propose", {"preset": "4", "layers": [{"type": "Signal"}] * 3}, error=True)

        if "scripting" in dict(resolve(("scripting",))):
            code = ("const parts = await api.items.list({kind: 'part', fields: ['id', 'ref', 'value']});\n"
                    "const c1 = parts.find(p => p.ref === 'C1'); console.log('was', c1.value);\n"
                    "await api.transaction('Value', tx => tx.update(c1.id, {value: args.value})); return c1.id;")
            count = "return (await api.items.list({kind: 'part'})).length > 0;"
        else:
            code = ("const c1 = project.documents.flatMap(d => d.items).find(i => i.kind === 'part' && i.ref === 'C1');\n"
                    "console.log('was', c1.value); c1.value = args.value; return c1.id;")
            count = "return project.documents.length > 0;"
        scripted = self.tool("run_script", {"code": code, "args": {"value": "47 nF"}})
        self.assertEqual(scripted["log"][0], "was 10 nF")
        self.assertIsNone(scripted["error"])
        proposal = json.loads(Path(scripted["proposal_file"]).read_text())
        self.assertEqual((proposal["tool"], proposal["source_sha256"]), ("run_script", self.digest))
        changed = proposal["changes"] if proposal["version"] == 1 else [dict(op, after=op["after"]) for op in proposal["ops"]]
        self.assertEqual([c["after"] for c in changed], ["47 nF"])
        failed = self.tool("run_script", {"code": "console.log('start'); throw Error('stop here');"})
        self.assertEqual((failed["error"], failed["log"][:1], failed["changes"]), ("stop here", ["start"], 0))
        unchanged = self.tool("run_script", {"code": count})
        self.assertEqual((unchanged["result"], unchanged["changes"]), (True, 0))
        if sys.platform == "darwin":
            looped = self.tool("run_script", {"code": "for (;;) {}", "timeout_ms": 200})
            self.assertIn("time limit", looped["error"])
            self.assertEqual(self.tool("run_erc", {"limit": 0})["passed"], False)  # The main engine still works.
        self.assertEqual(revision(self.path), self.digest)

    def test_library_tools_create_validate_and_update(self):
        self.start()
        made = self.tool("create_footprint", {"family": "gullwing", "preset": "SOIC-8", "density": "B", "value": "LM358"})
        self.assertEqual(made["ipc_name"], "SOIC127P600X175-8N")
        self.assertEqual((made["Z"], made["G"], made["X"]), (6.9, 3, 0.6))
        self.assertEqual((made["pads"], made["courtyard"], made["height"]), (8, [-3.7, -2.75, 3.7, 2.75], 1.75))
        proposal = json.loads(Path(made["proposal_file"]).read_text())
        self.assertTrue(any(op["op"] == "add" and op["target"] == "library" for op in proposal["ops"]))
        self.assertEqual(revision(self.path), self.digest)
        chip = self.tool("create_footprint", {"family": "chip", "preset": "0603", "dims": {"kind": "CAP"}})
        self.assertEqual((chip["ipc_name"], chip["Z"], chip["G"], chip["X"], chip["prefix"]), ("CAPC1608X55N", 2.45, 0.85, 0.95, "C"))
        pins = [{"number": "1", "name": "OUTA", "type": "output", "part": 1}, {"number": "2", "name": "-INA", "type": "input", "part": 1},
                {"number": "3", "name": "+INA", "type": "input", "part": 1}, {"number": "7", "name": "OUTB", "type": "output", "part": 2},
                {"number": "6", "name": "-INB", "type": "input", "part": 2}, {"number": "5", "name": "+INB", "type": "input", "part": 2},
                {"number": 8, "name": "V+", "type": "power", "part": 0}, {"number": 4, "name": "V-", "type": "power", "part": 0}]
        sym = self.tool("create_symbol", {"name": "Dual op amp", "prefix": "U", "gates": 2, "pins": pins})
        self.assertEqual((sym["gates"], sym["pins"]), (2, 8))
        self.assertEqual({p["number"]: p["gate"] for p in sym["pin_list"]}["8"], 0)
        text = self.tool("create_symbol", {"name": "LDO", "pins": "1\tVIN\tpower\n2\tGND\tpower\n3\tVOUT\toutput"})
        self.assertEqual({p["name"]: p["side"] for p in text["pin_list"]}, {"VIN": "up", "GND": "down", "VOUT": "right"})
        bad = self.tool("validate_library_def", {"def": {"id": "x", "name": "Bad", "footprint": {"pads": [
            {"number": "1", "x": 0, "y": 0, "w": 1, "h": 1}, {"number": "1", "x": 3, "y": 0, "w": 1, "h": 1}], "shapes": []}}})
        self.assertTrue(bad["ok"])
        self.assertIn("duplicate", [c["code"] for c in bad["footprint_checks"]])
        self.assertIn("courtyard", [c["code"] for c in bad["footprint_checks"]])
        worse = self.tool("validate_library_def", {"def": {"id": "y", "name": "", "symbol": {"pins": [], "shapes": []}}})
        self.assertFalse(worse["ok"])
        resistor = self.design["library"][0]["id"]
        self.assertTrue(self.tool("validate_library_def", {"def_id": resistor})["ok"])
        synced = self.tool("update_parts_from_library", {"def_id": resistor, "include_copies": True})
        self.assertGreaterEqual(synced["parts"], 1)
        for name, args in [("create_footprint", {"density": "D", "family": "chip"}), ("create_footprint", {}),
                           ("create_footprint", {"family": "chip", "footprint": {}}), ("create_symbol", {"pins": []}),
                           ("validate_library_def", {}), ("update_parts_from_library", {"def_id": "nope"})]:
            self.tool(name, args, error=True)
        # Footprint wizard (read-only): every family and preset, a generated land without touching the file, a CSV batch.
        listed = self.tool("footprint_wizard", {"action": "list"})["families"]
        schema = {t["name"]: t for t in self.request("tools/list", {})["result"]["tools"]}["create_footprint"]["inputSchema"]
        self.assertEqual([f["id"] for f in listed], schema["properties"]["family"]["enum"], "FP_FAMILIES matches the wizard")
        self.assertEqual({f["group"] for f in listed}, {"SMD", "THT", "Mechanical"})
        so16 = self.tool("footprint_wizard", {"action": "generate", "family": "sop", "preset": "SOIC-16"})
        self.assertEqual((so16["ipc_name"], so16["Z"], so16["G"], so16["X"], so16["pad_count"]), ("SOIC127P600X175-16N", 6.9, 3, 0.6, 16))
        self.assertEqual([i for i in so16["issues"] if i["level"] == "error"], [])
        hdr = self.tool("footprint_wizard", {"action": "generate", "family": "connector", "preset": "IDC box header 2×5 2.54"})
        self.assertEqual(hdr["pad_count"], 10)
        self.assertIn("pull-back", self.tool("footprint_wizard", {"action": "describe", "family": "qfn"})["title"].lower())
        checked = self.tool("footprint_wizard", {"action": "batch", "csv": "family,preset,density\nqfp,LQFP-32 7×7 0.8,B\nnope,,B\n"})
        self.assertEqual((checked["ok"], checked["failed"]), (1, 1))
        self.tool("footprint_wizard", {"action": "generate"}, error=True)
        # Round-off: KiCad's convention reproduces KiCad's R_0402_1005Metric land (0.54 × 0.64 at ±0.51).
        r0402 = self.tool("footprint_wizard", {"action": "generate", "family": "chip", "preset": "0402", "round_off": "kicad"})
        self.assertEqual((r0402["round_off"], r0402["land"]["length"], r0402["land"]["centre"], r0402["X"]), ("kicad", 0.54, 0.51, 0.64))
        fine = self.tool("create_footprint", {"family": "sop", "preset": "TSSOP-16", "round_off": 0.01})
        self.assertEqual(fine["round_off"], 0.01)
        self.tool("footprint_wizard", {"action": "generate", "family": "chip", "round_off": 0.2}, error=True)
        self.assertEqual(revision(self.path), self.digest)
        batch = self.tool("create_footprint", {"batch": "family,preset,density,pins\nsop,TSSOP-16,B,\ndpak,TO-252-2 (DPAK),B,\nsop,SOIC-16,B,7\n"})
        self.assertEqual((batch["added"], batch["failed"]), (2, 1))
        self.assertTrue(json.loads(Path(batch["proposal_file"]).read_text())["ops"])
        self.tool("create_footprint", {"batch": "x", "family": "chip"}, error=True)
        piped = self.tool("pipeline", {"steps": [{"tool": "create_footprint", "args": {"family": "nolead", "preset": "QFN-32 5×5"}},
                                                 {"tool": "create_symbol", "args": {"name": "QFN part", "pins": "1\tA\n2\tB"}}]})
        self.assertEqual(json.loads(Path(piped["proposal_file"]).read_text())["summary"]["edits"], ["create_footprint", "create_symbol"])
        self.assertEqual(revision(self.path), self.digest)

    def test_routing_tools_propose_new_copper(self):
        self.start()
        args = {"from": {"component": "R1", "pad": "2"}, "to": {"component": "C1", "pad": "1"}}
        unrouted = self.tool("run_drc", {"rules": ["unrouted"]})["total"]
        tools = (("route_connection", "router", args), ("autoroute", "autorouter", {"nets": ["FILTER"]}),
                 ("fanout", "fanout", {}))
        available = dict(resolve(module for _, module, _ in tools))
        for name, module, call in tools:
            if module not in available:
                self.assertIn("not available", self.tool(name, call, error=True))
                continue
            result = self.tool(name, call, timeout=30)
            if name == "fanout":  # The sample has no fine-pitch or BGA parts to fan out.
                self.assertEqual((result["changes"], result["proposal_file"], result["report"]["fanned"]), (0, None, 0))
                continue
            self.assertGreater(result["tracks"], 0, result)
            proposal = json.loads(Path(result["proposal_file"]).read_text())
            added = [op["value"] for op in proposal["ops"] if op["op"] == "add"]
            self.assertTrue(added and all(op["target"] == "item" and op["document"] == self.pcb for op in proposal["ops"]))
            self.assertTrue(all(i["kind"] in ("track", "via") and i["net"] == "FILTER" for i in added))
            applied = apply_proposal(read_design(self.path), proposal)
            board = next(d for d in applied["documents"] if d["id"] == self.pcb)
            self.assertLessEqual({i["id"] for i in added}, {i["id"] for i in board["items"]})
        if "router" in available:
            self.assertEqual(self.tool("route_connection", args)["net"], "FILTER")
            self.assertIn("different nets", self.tool("route_connection", {"from": args["from"], "to": {"component": "J1", "pad": "3"}}, error=True))
            self.assertIn("no pad", self.tool("route_connection", {"from": args["from"], "to": {"component": "C1", "pad": "9"}}, error=True))
            # Routed in one pipeline, the connection no longer counts as unrouted.
            routed = self.tool("pipeline", {"steps": [{"tool": "route_connection", "args": args}, {"tool": "run_drc", "args": {"rules": ["unrouted"]}}]})
            self.assertEqual(routed["steps"][1]["result"]["total"], unrouted - 1)
        self.assertEqual(revision(self.path), self.digest)

    def applied_by_write(self, tool, args):
        """Save the same edit in place in a scratch copy and reopen its authored model."""
        copy = self.dir / "copy"
        target = copy / self.path.name
        self.restore_authored_files(self.fixture, copy)
        result = subprocess.run([sys.executable, "-B", str(SERVER), "--project", str(target), "--allow-write", "--cli", tool,
                                 "--args", json.dumps(dict(args, mode="write"))], capture_output=True, text=True, timeout=60)
        self.assertEqual(result.returncode, 0, result.stderr)
        return read_design(target)

    def restore_authored_files(self, files, directory=None):
        root = directory or self.dir
        for name, data in files.items():
            target = root / name
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_bytes(data)

    def backups(self):
        return {path.resolve() for path in (self.dir / ".waffle" / "local" / "mcp").glob("backup-*.zip")}

    def assert_backup(self, receipt, before, source):
        backup = Path(receipt["backup"])
        self.assertEqual(backup.parent.resolve(), (self.dir / ".waffle" / "local" / "mcp").resolve())
        with zipfile.ZipFile(backup) as archive:
            meta = json.loads(archive.read("backup.json"))
            self.assertEqual(meta["source_sha256"], source)
            saved = {row["path"]: row["sha256"] for row in meta["targets"]}
            self.assertEqual(set(saved), set(receipt["files"]))
            self.assertEqual(set(archive.namelist()), {"backup.json"} |
                             {"previous/" + name for name in saved if name in before})
            for name, digest in saved.items():
                if name in before:
                    self.assertEqual(archive.read("previous/" + name), before[name])
                    self.assertEqual(digest, hashlib.sha256(before[name]).hexdigest())
                else:
                    self.assertIsNone(digest)

    def test_pipeline_runs_steps_on_one_copy(self):
        self.start()
        steps = [{"tool": "annotate", "args": {"action": "update"}}, {"tool": "run_drc", "args": {"rules": ["width"]}},
                 {"tool": "propose_rule_change", "args": {"changes": [{"action": "update", "rule_id": "width-1", "set": {"min": 0.04}}]}},
                 {"tool": "run_drc", "args": {"rules": ["width"]}}, {"tool": "pour_polygons"}, {"tool": "run_erc", "args": {"limit": 0}},
                 {"tool": "generate_fabrication", "args": {"include": ["gerber"], "date": "2026-01-01T00:00:00Z"}}]
        result = self.tool("pipeline", {"steps": steps, "source_sha256": self.digest}, timeout=30)
        self.assertEqual([s["tool"] for s in result["steps"]], [s["tool"] for s in steps])
        self.assertEqual(result["steps"][1]["result"]["total"], 1)
        self.assertEqual(result["steps"][3]["result"]["total"], 0)
        self.assertNotIn("unannotated", result["steps"][5]["result"]["by_check"])
        proposal = json.loads(Path(result["proposal_file"]).read_text())
        self.assertEqual((proposal["version"], proposal["tool"]), (2, "pipeline"))
        self.assertEqual(proposal["summary"]["edits"], ["annotate", "propose_rule_change", "pour_polygons"])
        self.assertEqual(len(self.proposals()), 1)
        fab = [Path(f["path"]).read_text() for f in result["steps"][6]["result"]["files"]]
        self.assertTrue(any("G36*" in text for text in fab))  # Poured copper regions are plotted from the edited copy.
        # Nothing persists between calls: the saved project still needs annotation.
        self.assertIn("unannotated", self.tool("run_erc", {"limit": 0})["by_check"])
        message = self.tool("pipeline", {"steps": [{"tool": "pour_polygons"}, {"tool": "get_rule", "args": {"rule_id": "missing"}}]},
                            error=True, timeout=30)
        self.assertIn("Step 2 (get_rule) failed", message)
        self.tool("pipeline", {"steps": [{"tool": "run_drc", "args": {"mode": "proposal"}}]}, error=True)
        self.assertEqual(len(self.proposals()), 1)
        self.assertEqual(revision(self.path), self.digest)

    def test_annotation_uses_the_prepared_board_changes(self):
        model = json.loads(evaluate("""JSON.stringify((()=>{
          const p = AtriumParts.example(), board = p.documents.find(d => d.kind === "pcb");
          const locked = {...board, id:Atrium.id(), name:"Board with a locked designator",
            items:board.items.map(i => ({...i, id:Atrium.id(), ...(i.ref === "C2" ? {designatorLocked:true} : {})}))};
          p.documents.push(locked);
          return p;
        })())"""))
        self.dir = self.dir / "annotation"
        self.path = write_design(self.dir / "Board.waffle", model)
        source = revision(self.path)
        original = authored_files(self.dir)
        args = {"order": "across-down", "action": "annotate"}
        self.start()
        plan = self.tool("annotate", args)
        expected = [("C2", "C1"), ("C1", "C2")]
        self.assertEqual([(r["current"], r["proposed"]) for r in plan["items"]], expected)
        self.assertEqual([(r["before"], r["after"]) for r in plan["board"]], expected)
        self.assertTrue(any("C2 is locked" in issue for issue in plan["issues"]))
        self.assertTrue(any("would duplicate designator C2" in issue for issue in plan["issues"]))
        self.assertEqual((plan["schematic_changes"], plan["board_changes"]), (2, 2))
        cli = subprocess.run([sys.executable, "-B", str(SERVER), "--project", str(self.path), "--cli", "run_command",
                              "--args", json.dumps({"command": "annotate", "mode": "plan", "args": args})],
                             check=True, text=True, capture_output=True, timeout=20)
        self.assertEqual(json.loads(cli.stdout), dict(plan, command="annotate", tool="annotate"))
        schematic_only = self.tool("annotate", dict(args, back_annotate=False))
        self.assertEqual(schematic_only["items"], plan["items"])
        self.assertEqual((schematic_only["board"], schematic_only["board_changes"], schematic_only["issues"]), ([], 0, []))
        self.assertIn("allow-write", self.tool("annotate", dict(args, mode="write", source_sha256=source), error=True))
        self.assertEqual(authored_files(self.dir), original)
        self.assertEqual(self.proposals(), [])

        changes = {(r["sheet"], r["id"]): (r["current"], r["proposed"]) for r in plan["items"]}
        changes.update({(r["board"], r["id"]): (r["before"], r["after"]) for r in plan["board"]})

        def proposed_edits(receipt):
            proposal = json.loads(Path(receipt["proposal_file"]).read_text())
            self.assertEqual(proposal["source_sha256"], source)
            self.assertTrue(all(row["field"] == "ref" for row in proposal["changes"]))
            return {(r["document"], r["id"]): (r["before"], r["after"]) for r in proposal["changes"]}

        proposed = self.tool("annotate", dict(args, mode="proposal", limit=1, offset=1))
        self.assertEqual(proposed["items"], plan["items"][1:])
        self.assertEqual(proposed["board"], plan["board"])
        self.assertEqual(proposed["issues"], plan["issues"])
        self.assertEqual(proposed_edits(proposed), changes)
        scripted = self.tool("run_script", {
            "code": "return api.annotate.apply({action:'annotate', order:'across-down', boards:'*'});",
        }, timeout=20)
        self.assertIsNone(scripted["error"])
        self.assertEqual(scripted["transactions"], 1)
        self.assertEqual(proposed_edits(scripted), changes)
        self.assertEqual(revision(self.path), source)

        self.start("--allow-write")
        self.assertIn("changed since", self.tool("annotate", dict(args, mode="write", source_sha256="f"*64), error=True))
        self.assertEqual(revision(self.path), source)
        written = self.tool("annotate", dict(args, mode="write", source_sha256=source))
        for k in ("items", "board", "issues", "schematic_changes", "board_changes"):
            self.assertEqual(written[k], plan[k])
        saved = {(d["id"], i["id"]): i["ref"] for d in read_design(self.path)["documents"] for i in d["items"] if i["kind"] == "part"}
        self.assertEqual({k: saved[k] for k in changes}, {k: after for k, (_, after) in changes.items()})
        self.assertIn("changed since", self.tool("annotate", dict(args, mode="write", source_sha256=source), error=True))
        self.assertEqual(revision(self.path), written["file_revision"])

    def test_script_no_changes_preserves_native_completion(self):
        self.start("--allow-write")
        code = "return { count:await api.items.count(), unchanged:true };"
        request = {"code": code}
        preview = self.tool("run_script", request)
        self.assertEqual((preview["transactions"], preview["changes"], preview["proposal_file"]), (0, 0, None))
        self.assertNotIn("unchanged", preview)
        self.assertTrue(preview["result"]["unchanged"])
        written = self.tool("run_script", dict(request, mode="write", source_sha256=self.digest))
        self.assertEqual((written["transactions"], written["changes"], written["written"]), (0, 0, None))
        cli = subprocess.run([sys.executable, "-B", str(SERVER), "--project", str(self.path), "--cli", "run_script",
                              "--args", json.dumps(request)], check=True, text=True, capture_output=True, timeout=20)
        cold = json.loads(cli.stdout)
        self.assertEqual({k:v for k,v in cold.items() if k != "ms"}, {k:v for k,v in preview.items() if k != "ms"})
        self.assertIn("changed since", self.tool("run_script", dict(request, source_sha256="f"*64), error=True))
        pipeline = self.tool("pipeline", {"mode":"write", "steps":[{"tool":"run_script", "args":request}]})
        self.assertEqual((pipeline["changes"], pipeline["written"], pipeline["steps"][0]["result"]["transactions"]), (0, None, 0))
        edit = "await api.transaction('Grid', tx => tx.setDocument(args.board, {grid:.375}));"
        edit_args = {"args":{"board":self.pcb}, "mode":"write", "source_sha256":self.digest}
        failed = self.tool("run_script", dict(edit_args, code=edit + "throw Error('stop');"))
        self.assertEqual((failed["error"], failed["transactions"], failed["changes"]), ("stop", 1, 0))
        if sys.platform == "darwin":
            timed_out = self.tool("run_script", dict(edit_args, code=edit + "for (;;) {}", timeout_ms=300))
            self.assertIn("time limit", timed_out["error"])
            self.assertEqual(timed_out["changes"], 0)
        self.assertEqual(authored_files(self.dir), self.fixture)
        self.assertEqual(self.proposals(), [])

        saved = self.tool("run_script", dict(edit_args, code=edit))
        self.assertEqual((saved["changes"], saved["transactions"]), (1, 1))
        board = next(d for d in read_design(self.path)["documents"] if d["id"] == self.pcb)
        self.assertEqual(board["grid"], .375)
        self.assertIn("changed since", self.tool("run_script", dict(edit_args, code=edit), error=True))
        self.start()
        self.assertIn("allow-write", self.tool("run_script", dict(request, mode="write"), error=True))
        self.start("--read-only")
        self.assertIn("read-only", self.tool("run_script", request, error=True))

    def test_public_v1_power_track_workflow(self):
        fixtures = Path(__file__).resolve().parents[1] / "fixtures" / "extension-api-v1"
        project = json.loads((fixtures / "power-tracks.json").read_text())
        example = SERVER.parents[1] / "extensions" / "examples" / "scripts" / "widen-power-tracks.js"
        code = (fixtures / "widen-workflow.js").read_text().replace("/* public-example */", example.read_text())
        root = self.dir / "public-api"
        self.path = write_design(root / "Power.waffle", project)
        original = authored_files(root)
        source = revision(self.path)

        board = project["documents"][0]
        fields = ("id", "net", "width", "points")
        tracks = [{key: track[key] for key in fields} for track in board["items"]]
        design = {
            "apiVersion": 1, "name": project["name"], "units": project["units"],
            "document": {**{key: board[key] for key in ("id", "kind", "name", "grid", "outline")}, "itemCount": len(tracks)},
            "tracks": tracks,
        }
        edited = dict(design, tracks=[dict(track, width=0.5) if track["net"] == "GND" else track for track in tracks])
        result = {"before": design, "edit": {"widened": 1, "applied": 1}, "after": edited}
        request = {"code": code, "source_sha256": source}

        self.start()
        read = self.tool("run_script", dict(request, args={"inspect": True}), timeout=15)
        self.assertEqual(read["result"], {"before": design, "edit": None, "after": design})
        self.assertEqual((read["transactions"], read["changes"], read["proposal_file"]), (0, 0, None))
        self.assertEqual(list(root.glob("*.waffle-ai")), [])
        self.assertEqual(authored_files(root), original)
        preview = self.tool("run_script", request, timeout=15)
        self.assertEqual(preview["result"], result)
        self.assertEqual((preview["transactions"], preview["changes"]), (1, 1))
        proposal_path = Path(preview["proposal_file"])
        self.assertEqual(proposal_path.parent, root.resolve())
        proposal = json.loads(proposal_path.read_text())
        self.assertEqual(proposal["source_sha256"], source)
        self.assertEqual(proposal["ops"], [{
            "op": "set", "target": "item", "document": board["id"], "id": tracks[0]["id"],
            "path": ["width"], "before": 0.2, "after": 0.5,
        }])
        self.assertEqual(authored_files(root), original)
        write = dict(request, mode="write")
        self.assertIn("allow-write", self.tool("run_script", write, error=True))
        self.assertEqual(authored_files(root), original)

        self.start("--allow-write")
        save = self.tool("run_script", write, timeout=15)
        self.assertEqual(save["result"], result)
        self.assertEqual((save["transactions"], save["changes"]), (1, 1))
        after_write = authored_files(root)
        self.assertEqual(set(after_write), set(original))
        changed = [name for name, data in original.items() if after_write[name] != data]
        self.assertEqual(changed, ["Power board.wpcb"])
        saved_board = read_design(self.path)["documents"][0]
        self.assertEqual([{key: track[key] for key in fields} for track in saved_board["items"]], edited["tracks"])
        self.assertIn("changed since", self.tool("run_script", write, error=True))
        self.assertEqual(authored_files(root), after_write)

    def test_script_rejects_malformed_completion(self):
        from server import Server
        from board_runner import BoardRunner
        from unittest.mock import patch

        server = Server(self.path)
        self.addCleanup(server.close)
        head = {"log": [], "error": None, "result": 0, "transactions": 0}
        for result, body in [
            (head, None),
            (dict(head, unchanged=True, transactions=False), None),
            (dict(head, unchanged=True, transactions=1), None),
            (dict(head, unchanged=True, error="failed"), None),
            (dict(head, unchanged=True), "{}"),
            ({"error": None}, "{}"),
        ]:
            with self.subTest(result=result, body=body), patch.object(BoardRunner, "sandbox", return_value=(result.copy(), body)):
                with self.assertRaisesRegex(ValueError, "invalid result"):
                    server.call("run_script", {"code": "return 0"})
        self.assertEqual(authored_files(self.dir), self.fixture)

    def test_inspect_edit_capable_commands_on_released_revision(self):
        find = {"command":"find_replace", "args":{"query":"10 nF"}}
        status = {"command":"via_fence", "args":{"action":"status"}}
        self.start("--allow-write")
        fence = self.tool("run_command", {"command":"via_fence", "mode":"write",
                          "args":{"action":"place", "kind":"edge", "net":"GND"}}, timeout=20)
        self.assertGreater(fence["changes"], 0)
        draft = read_design(self.path)
        draft_find = self.tool("run_command", find)
        self.assertGreater(draft_find["hits"], 0)
        draft_status = self.tool("run_command", status)
        self.assertIsNone(draft_find["proposal_file"])
        self.assertIsNone(draft_status["proposal_file"])
        self.assertGreater(draft_status["untrusted_design_text"]["fences"][0]["vias"], 0)
        deletion = self.tool("run_command", {"command":"find_replace", "args":{"query":"nF", "replacement":""}})
        self.assertGreater(deletion["changes"], 0, "a supplied empty string is still a replacement")
        published = self.tool("pipeline", {"steps":[{"tool":"run_command", "args":find}, {"tool":"run_command", "args":status}]})
        self.assertEqual(published["changes"], 0)

        self.stop_server()
        self.proc = None
        write_design(self.path, {**draft, "revision":{"letter":"A", "status":"released"}})
        released = authored_files(self.dir)
        self.start("--allow-write")
        for request, expected in [(find, draft_find), (status, draft_status)]:
            self.assertEqual(self.tool("run_command", request), expected)
            args = dict(request, mode="plan")
            plan = self.tool("run_command", args)
            self.assertEqual((plan["changes"], plan["mode"], plan["file_revision"]), (0, "plan", revision(self.path)))
            cli = subprocess.run([sys.executable, "-B", str(SERVER), "--project", str(self.path), "--cli", "run_command",
                                  "--args", json.dumps(args)], check=True, capture_output=True, text=True, timeout=20)
            self.assertEqual(json.loads(cli.stdout), plan)
            written = self.tool("run_command", dict(request, mode="write"))
            self.assertEqual((written["changes"], written["written"]), (0, None))
        self.assertIn("read-only", self.tool("run_command", dict(find, args=dict(find["args"], replacement="")), error=True))
        self.assertIn("read-only", self.tool("run_command", dict(status, args={"action":"remove"}), error=True))
        self.assertIn("read-only", self.tool("run_script", {"code":"return api.items.count()"}, error=True))
        self.assertEqual(authored_files(self.dir), released)

    def test_allow_write_saves_atomically_with_conflict_detection(self):
        self.start("--allow-write")
        stale = "f" * 64
        self.assertIn("changed since", self.tool("pour_polygons", {"mode": "write", "source_sha256": stale}, error=True))
        self.assertEqual(revision(self.path), self.digest)
        written = self.tool("annotate", {"mode": "write", "action": "update", "source_sha256": self.digest})
        self.assertEqual(written["file_revision"], revision(self.path))
        self.assertEqual(written["source_sha256"], self.digest)
        self.assert_backup(written, self.fixture, self.digest)
        record = json.loads(Path(written["log"]).read_text().splitlines()[-1])
        self.assertEqual((record["tool"], record["source_sha256"], record["transaction"], record["targets"]),
                         ("annotate", self.digest, written["transaction"], written["files"]))
        project = read_design(self.path)
        refs = [i["ref"] for d in project["documents"] for i in d["items"] if i["kind"] == "part"]
        self.assertNotIn("R?", refs)
        self.assertEqual(self.tool("project_summary")["file_revision"], written["file_revision"])
        self.assertNotIn("unannotated", self.tool("run_erc")["by_check"])
        self.assertEqual(self.proposals(), [])
        self.assertEqual(list(self.dir.glob(".*.tmp")) + list(self.dir.glob("*.tmp")), [])
        # The editor saved the project meanwhile: a write against the earlier revision is refused.
        self.tool("pour_polygons", {"mode": "write", "source_sha256": written["file_revision"]}, timeout=20)
        newest = authored_files(self.dir)
        self.assertIn("changed since", self.tool("pour_polygons", {"mode": "write", "source_sha256": written["file_revision"]}, error=True))
        self.assertEqual(authored_files(self.dir), newest)

    def test_signals_create_from_nets_plan_proposal_and_write(self):
        board = next(d for d in self.design["documents"] if d["id"] == self.pcb)
        for i, name in enumerate(["USB_DP", "USB_DM", "DATA0", "DATA1", "DATA2"]):
            board["items"].append(dict(id="signals-net-" + str(i), kind="track", net=name, layer="Top",
                                       width=0.2, points=[[4, 4 + i], [6, 4 + i]]))
        write_design(self.path, self.design)
        base = authored_files(self.dir)
        sha = revision(self.path)
        args = dict(action="create_from_nets", document_id=self.pcb, source_sha256=sha)
        pair = dict(args, kind="diff", nets=["USB_DM", "USB_DP"], name="USB pair")
        self.start()
        preview = self.tool("signals", dict(pair, mode="plan"))
        self.assertEqual(preview["file_revision"], sha)
        self.assertTrue(preview["untrusted_design_text"])
        self.assertEqual([(g["positive"], g["negative"]) for g in preview["plan"]], [("USB_DP", "USB_DM")])
        bus = self.tool("signals", dict(args, kind="bus", nets=["DATA2", "DATA0", "DATA1"], mode="plan"))
        self.assertEqual(bus["plan"][0]["nets"], ["DATA0", "DATA1", "DATA2"])
        self.assertIn("not found", self.tool("signals", dict(pair, nets=["USB_DP", "MISSING"]), error=True))
        self.assertIn("allow-write", self.tool("signals", dict(pair, mode="write"), error=True))
        self.assertEqual(self.proposals(), [])
        proposal = self.tool("signals", pair)
        self.assertEqual(len(self.proposals()), 1)
        ops = json.loads(Path(proposal["proposal_file"]).read_text())["ops"]
        stored = next(o["after"] for o in ops if o["target"] == "project" and o["path"] == ["signals"])
        created = next(s for s in stored["signals"] if s["name"] == "USB pair")
        self.assertEqual(created["legs"], [{"polarity": 1, "nets": ["USB_DP"]}, {"polarity": -1, "nets": ["USB_DM"]}])
        self.assertEqual(authored_files(self.dir), base)
        self.start("--allow-write")
        written = self.tool("signals", dict(args, kind="tag", nets=["DATA2", "DATA1"], tag="Parallel bus", mode="write"))
        saved = read_design(self.path)
        self.assertEqual(saved["signals"]["nets"]["DATA1"]["tags"], ["Parallel bus"])
        self.assertEqual(saved["signals"]["nets"]["DATA2"]["tags"], ["Parallel bus"])
        self.assert_backup(written, base, sha)
        self.assertEqual(json.loads(Path(written["log"]).read_text().splitlines()[-1])["tool"], "signals")
        self.assertIn("changed since", self.tool("signals", dict(pair, mode="write"), error=True))

    def test_denied_change_log_leaves_project_and_backup_untouched(self):
        from server import Server
        server = Server(self.path, allow_write=True)
        self.addCleanup(server.close)
        log = self.dir / ".waffle" / "local" / "mcp" / "changes.jsonl"
        log.parent.mkdir(parents=True)
        log.write_text("previous record\n")
        os.link(log, log.with_name("earlier-records.jsonl"))
        with self.assertRaisesRegex(ValueError, "change log"):
            server.call("annotate", {"mode": "write", "action": "update"})
        self.assertEqual(authored_files(self.dir), self.fixture)
        self.assertEqual(self.backups(), set())
        self.assertEqual(log.read_text(), "previous record\n")

    def test_failed_output_publication_keeps_ownership_and_user_files(self):
        from unittest.mock import patch
        sys.path.insert(0, str(ROOT / "mcp"))
        import confined_files
        from server import Server
        server = Server(self.path)
        self.addCleanup(server.close)
        dest = server.automation.output_dir({}, "review")
        replace = confined_files.Directory.replace

        def refuse_manifest(folder, temp, name):
            if name == server.automation.OUTPUT_MANIFEST:
                raise PermissionError("The output folder became read-only.")
            return replace(folder, temp, name)

        with patch.object(confined_files.Directory, "replace", refuse_manifest):
            with self.assertRaises(PermissionError):
                server.automation.save_file(dest, "parts.csv", b"Part,Value")
        self.assertEqual(list(dest.iterdir()), [])
        (dest / "parts.csv").write_text("Independent content")
        with self.assertRaisesRegex(ValueError, "did not create"):
            server.automation.save_file(dest, "parts.csv", b"Part,Value")
        self.assertEqual((dest / "parts.csv").read_text(), "Independent content")

    def test_import_denies_input_above_remaining_budget(self):
        from unittest.mock import patch
        sys.path.insert(0, str(ROOT / "mcp"))
        import confined_files
        from server import Server
        server = Server(self.path)
        self.addCleanup(server.close)
        part = self.path.parent / "Bench.kicad_sch"
        part.write_bytes(b"(kicad_sch)")
        with patch.object(confined_files.Directory, "read", autospec=True, side_effect=confined_files.Directory.read) as read, \
                patch.object(server.automation, "IMPORT_BYTES", 4):
            with self.assertRaisesRegex(ValueError, "size limit"):
                server.call("import_design", {"paths": [part.name]})
            ((directory, name, cap), _) = read.call_args
            self.assertEqual(read.call_count, 1)
            self.assertEqual((directory.path / name, cap), (part.resolve(), 4))
        self.assertFalse(server.automation.output_base().exists())

    def test_saved_proposal_review_is_bound_to_file_and_source(self):
        from server import Server
        server = Server(self.path, allow_write=True)
        self.addCleanup(server.close)
        draft = server.call("annotate", {"action":"update", "mode":"proposal"})
        path = Path(draft["proposal_file"])
        name = path.name
        packet = json.loads(path.read_bytes())
        self.assertEqual(packet["format2_base"], server.folder.proposal_base())
        self.assertEqual(packet["version"], 1)
        [change] = packet["changes"]
        preview = server.call("apply_proposal", {"file":name, "limit":1})
        self.assertEqual(preview["total"], 1)
        self.assertEqual(preview["proposal_sha256"], draft["sha256"])
        self.assertEqual(preview["source_sha256"], self.digest)
        with self.assertRaisesRegex(ValueError, "requires"):
            server.call("apply_proposal", {"file":name, "mode":"write"})
        args = {"file":name, "mode":"write", "source_sha256":preview["source_sha256"], "proposal_sha256":preview["proposal_sha256"]}
        with self.assertRaisesRegex(ValueError, "proposal file changed"):
            server.call("apply_proposal", dict(args, proposal_sha256="0"*64))
        self.assertEqual(self.backups(), set())
        self.assertEqual(authored_files(self.dir), self.fixture)
        saved = server.call("apply_proposal", args)
        self.assertEqual(saved["changes"], 1)
        [changed_file] = saved["files"]
        self.assertTrue(changed_file.endswith(".wsch"))
        stored = authored_files(self.dir)
        self.assertEqual(set(stored), set(self.fixture))
        self.assertEqual({name for name in stored if self.fixture[name] != stored[name]}, {changed_file})
        self.assertEqual(revision(self.path), saved["file_revision"])
        sheet = next(doc for doc in read_design(self.path)["documents"] if doc["id"] == change["document"])
        self.assertEqual(next(part for part in sheet["items"] if part["id"] == change["id"])["ref"], change["after"])
        self.assert_backup(saved, self.fixture, self.digest)
        [record] = Path(saved["log"]).read_text().splitlines()
        logged = json.loads(record)
        self.assertEqual(logged["result"]["proposal_sha256"], draft["sha256"])
        with self.assertRaisesRegex(ValueError, "changed since"):
            server.call("apply_proposal", args)
        self.assertEqual(self.backups(), {Path(saved["backup"]).resolve()})
        self.assertEqual(authored_files(self.dir), stored)

    def test_expected_source_follows_engine_snapshot_in_calls_and_pipelines(self):
        from unittest.mock import patch
        from server import Server
        current = dict(read_design(self.path), name="Sensor interface (edited while selecting)")
        for name, args in [("annotate", {"action":"update", "mode":"proposal"}),
                           ("pipeline", {"steps":[{"tool":"annotate", "args":{"action":"update"}}]})]:
            self.restore_authored_files(self.fixture)
            server = Server(self.path)
            try:
                sync = server.automation.sync
                def saved_while_selecting(**scope):
                    write_design(self.path, current)
                    return sync(**scope)
                with patch.object(server.automation, "sync", side_effect=saved_while_selecting), \
                        patch.object(server.automation, "js", wraps=server.automation.js) as execute:
                    with self.assertRaisesRegex(ValueError, "changed since"):
                        server.call(name, dict(args, source_sha256=self.digest))
                    execute.assert_not_called()
                self.assertEqual(self.proposals(), [])
            finally:
                server.close()

    def test_read_only_profile_advertises_and_enforces_inspection(self):
        from server import Server
        server = Server(self.path, read_only=True)
        self.addCleanup(server.close)
        names = {t["name"] for t in server.tool_list()}
        self.assertIn("project_summary", names)
        self.assertIn("run_drc", names)
        self.assertIn("list_translators", names)
        preview = next(t for t in server.tool_list() if t["name"] == "import_design")
        self.assertTrue(preview["annotations"]["readOnlyHint"])
        self.assertEqual(preview["inputSchema"]["properties"]["mode"]["enum"], ["preview"])
        with self.assertRaisesRegex(ValueError, "read-only"):
            server.call("import_design", {"paths":[self.path.name], "mode":"save-as"})
        for name, args in [("apply_proposal", {"file":"review.waffle-ai"}), ("propose_component_edits", {}),
                           ("run_command", {"command":"set_locked"}), ("generate_bom", {}),
                           ("export_design", {"translator":"excellon"})]:
            self.assertNotIn(name, names)
            with self.assertRaisesRegex(ValueError, "read-only"):
                server.call(name, args)
        self.assertEqual(self.proposals(), [])

    def test_write_refuses_a_file_changed_after_it_was_read(self):
        sys.path.insert(0, str(ROOT / "mcp"))
        from server import Server
        from automation import Automation
        server = Server(self.path, allow_write=True)
        self.addCleanup(server.close)
        original = Automation.write_folder
        edited = read_design(self.path)
        sheet = next(d for d in edited["documents"] if d["kind"] == "schematic")
        part = next(p for p in sheet["items"] if p["id"] == "s-R1")
        part["value"] = "edited concurrently"

        def edited_meanwhile(automation, tool, summary):
            write_design(self.path, edited)
            return original(automation, tool, summary)
        from unittest.mock import patch
        with patch.object(Automation, "write_folder", edited_meanwhile):
            with self.assertRaisesRegex(ValueError, "changed") as conflict:
                server.call("annotate", {"mode": "write", "action": "update"})
        self.assertEqual(conflict.exception.code, "stale_source")
        newest = authored_files(self.dir)
        self.assertEqual(self.backups(), set())
        current = revision(self.path)
        self.assertNotEqual(current, self.digest)
        # The next call reloads the edited revision and writes on top of it.
        result = server.call("annotate", {"mode": "write", "action": "update"})
        self.assertEqual(result["changes"], 1)
        saved = read_design(self.path)
        part = next(p for d in saved["documents"] for p in d["items"] if p["id"] == "s-R1")
        self.assertEqual(part["value"], "edited concurrently")
        self.assertEqual(part["ref"], "R1")
        self.assert_backup(result, newest, current)

    def test_editor_save_journal_is_read_and_never_overwritten(self):
        # Replay the portable transaction envelope at the point where the editor
        # has published its save but the native folders have yet to install it.
        from folder_files import FolderError
        from server import Server
        sheet, = [name for name in self.fixture if name.endswith(".wsch")]
        before = self.fixture[sheet]
        desired = before.replace('"value":"10 kΩ"'.encode(), b'"value":"edited in editor"', 1)
        self.assertNotEqual(desired, before)
        expected = hashlib.sha256(before).hexdigest()
        digest = hashlib.sha256(desired).hexdigest()
        project_id = json.loads(self.fixture[self.path.name].splitlines()[0])["id"]
        transaction = str(uuid.uuid4())
        payload = json.dumps({"projectId": project_id, "transaction": transaction, "plan": [
            {"path": sheet, "expected": expected, "desired": {"sha256": digest, "length": len(desired)}}
        ]}, sort_keys=True, separators=(",", ":")).encode() + b"\n"
        journal = self.dir / ".waffle" / "journal"
        stage = journal / transaction
        journal.mkdir(mode=0o700, parents=True)
        stage.mkdir(mode=0o700)
        (journal / "lock").touch(mode=0o600)
        active = journal / "active"
        envelope = b"WAFFLE-TXN 1\n" + hashlib.sha256(payload).hexdigest().encode() + b"\n" + payload
        for path, data in ((stage / digest, desired), (active, envelope)):
            path.touch(mode=0o600)
            path.write_bytes(data)
        readonly = Server(self.path, read_only=True)
        self.addCleanup(readonly.close)
        with self.assertRaises(FolderError) as pending:
            readonly.call("project_summary", {})
        self.assertEqual(pending.exception.code, "recovery_pending")
        self.assertEqual(active.read_bytes(), envelope)
        self.assertEqual(authored_files(self.dir), self.fixture)
        self.assertEqual(self.backups(), set())
        server = Server(self.path, allow_write=True)
        self.addCleanup(server.close)
        result = server.call("annotate", {"mode": "write", "action": "update"})
        self.assertEqual(result["changes"], 1)
        self.assertFalse(active.exists())
        written = authored_files(self.dir)
        self.assertEqual({name for name, data in written.items() if self.fixture[name] != data}, {sheet})
        part = next(p for d in read_design(self.path)["documents"] for p in d["items"] if p["id"] == "s-R1")
        self.assertEqual((part["value"], part["ref"]), ("edited in editor", "R1"))
        self.assert_backup(result, dict(self.fixture, **{sheet: desired}), result["source_sha256"])
        # The editor's next save against its previous sheet fails the native compare-and-swap.
        row = {"path": sheet, "expected": digest, "data": base64.b64encode(desired).decode("ascii")}
        with self.assertRaises(FolderError) as conflict:
            server.folder_files.commit(project_id, [row], {sheet: digest})
        self.assertEqual(conflict.exception.code, "stale_source")
        self.assertEqual(authored_files(self.dir), written)

    def test_cli_runs_one_tool_for_ci(self):
        args = json.dumps({"zip": True, "date": "2026-01-01T00:00:00Z", "output_dir": "ci"})
        result = subprocess.run([sys.executable, "-B", str(SERVER), "--project", str(self.path), "--cli", "generate_fabrication", "--args", args],
                                capture_output=True, text=True, timeout=60)
        self.assertEqual(result.returncode, 0, result.stderr)
        first = json.loads(result.stdout)["zip"]
        again = subprocess.run([sys.executable, "-B", str(SERVER), "--project", str(self.path), "--cli", "generate_fabrication", "--args", args],
                               capture_output=True, text=True, timeout=60)
        self.assertEqual(json.loads(again.stdout)["zip"]["sha256"], first["sha256"])  # Reproducible with a fixed date.
        (self.dir / "args.json").write_text(json.dumps({"rules": ["width"]}))
        drc = subprocess.run([sys.executable, "-B", str(SERVER), "--project", str(self.path), "--cli", "run_drc", "--args", "@" + str(self.dir / "args.json")],
                             capture_output=True, text=True, timeout=60)
        self.assertEqual(json.loads(drc.stdout)["total"], 1)
        self.assertEqual(drc.stderr, "")
        traced = subprocess.run([sys.executable, "-B", str(SERVER), "--project", str(self.path), "--performance", "--cli",
                                 "run_drc", "--args", "@" + str(self.dir / "args.json")],
                                capture_output=True, text=True, timeout=60)
        self.assertEqual(traced.returncode, drc.returncode)
        self.assertEqual(json.loads(traced.stdout)["total"], json.loads(drc.stdout)["total"])
        snapshot = json.loads(traced.stderr)
        self.assertEqual(snapshot["version"], 1)
        self.assertFalse(snapshot["recording"])
        self.assertEqual(next(row["counts"]["completed"] for row in snapshot["rows"]
                              if (row["component"], row["operation"]) == ("automation", "request")), "1-to-4")
        exact_result = subprocess.run([sys.executable, "-B", str(SERVER), "--project", str(self.path), "--performance-exact",
                                       "--cli", "run_drc", "--args", "@" + str(self.dir / "args.json")],
                                      capture_output=True, text=True, timeout=60)
        self.assertEqual(exact_result.returncode, drc.returncode)
        self.assertEqual(json.loads(exact_result.stdout)["total"], json.loads(drc.stdout)["total"])
        exact = json.loads(exact_result.stderr)
        exact_row = next(row for row in exact["rows"] if (row["component"], row["operation"]) == ("automation", "request"))
        self.assertEqual(exact["version"], snapshot["version"])
        self.assertFalse(exact["recording"])
        self.assertEqual(exact_row["counts"]["completed"], 1)
        self.assertIsInstance(exact_row["runP95"], (int, float))
        self.assertNotIn("run_drc", exact_result.stderr)
        self.assertNotIn(str(self.path), exact_result.stderr)
        bad = subprocess.run([sys.executable, "-B", str(SERVER), "--project", str(self.path), "--cli", "run_drc", "--args", '{"limit": 999}'],
                             capture_output=True, text=True, timeout=60)
        self.assertEqual((bad.returncode, bad.stdout), (1, ""))
        self.assertIn("out of range", bad.stderr)
        listing = subprocess.run([sys.executable, "-B", str(SERVER), "--project", str(self.path), "--cli", "list"], capture_output=True, text=True, timeout=60)
        self.assertIn("generate_fabrication\t", listing.stdout)

    def test_update_pcb_requires_component_review(self):
        def part(item_id, ref, x):
            return {"id": item_id, "kind": "part", "def": "std-r", "ref": ref, "value": "10k",
                    "link": "copied-link", "x": x, "y": 10, "angle": 0, "pinNets": {"1": "A", "2": "B"}}
        for doc in self.design["documents"]:
            doc["items"] = [part("symbol", "R12", 20)] if doc["kind"] == "schematic" else [part("first", "R1", 3), part("second", "R2", 5)]
        write_design(self.path, self.design)
        self.start("--allow-write")
        dry = self.tool("update_pcb", {"dry_run": True})
        self.assertFalse(dry["valid"])
        review = dry["untrusted_design_text"]["component_review"]
        row, = review["sources"]
        targets = {t["target"]: t for t in review["targets"]}
        decisions = [{"source": row["source"], "target": "second", "stamp": row["stamp"], "targetStamp": targets["second"]["stamp"]}]
        partial = self.tool("update_pcb", {"dry_run": True, "match_decisions": decisions})
        self.assertFalse(partial["valid"])
        decisions.append({"target": "first", "stamp": targets["first"]["stamp"], "action": "keep"})
        done = self.tool("update_pcb", {"mode": "write", "match_decisions": decisions})
        self.assertTrue(done["valid"])
        saved = read_design(self.path)
        board = next(d for d in saved["documents"] if d["kind"] == "pcb")
        self.assertEqual([(p["id"], p["ref"], p["x"]) for p in board["items"]], [("first", "R1", 3), ("second", "R12", 5)])

    def test_design_authoring_tools(self):
        self.start()
        board = self.pcb
        bad = [("place_part", {"def": "std-r", "x": 0}), ("place_part", {"def": "std-r", "x": 0, "y": 0, "rotation": 45}),
               ("add_wire", {"points": [[0, 0]]}), ("add_wire", {}), ("set_board_outline", {"rect": [0, 0, 1]}),
               ("set_board_outline", {"rect": [0, 0, 10, 10], "points": [[0, 0], [1, 0], [1, 1]]}), ("update_pcb", {"direction": "up"}),
               ("delete_items", {}), ("move_component", {"component": "NOPE", "x": 1, "y": 1, "document_id": board}), ("place_part", {"def": "nope", "x": 0, "y": 0})]
        for name, args in bad:
            self.tool(name, args, error=True)
        self.assertEqual(self.proposals(), [])
        steps = [{"tool": "place_part", "args": {"def": "std-r", "x": 60, "y": 60, "designator": "R50"}},
                 {"tool": "place_part", "args": {"def": "std-c", "x": 80, "y": 60, "designator": "C50"}},
                 {"tool": "add_wire", "args": {"from": {"designator": "R50", "pin": 2}, "to": {"designator": "C50", "pin": "1"}}},
                 {"tool": "add_net_label", "args": {"text": "TAP", "at": {"designator": "R50", "pin": "2"}, "net_class": "Analog"}},
                 {"tool": "add_power_port", "args": {"net": "GND", "at": {"designator": "C50", "pin": "2"}}},
                 {"tool": "update_pcb", "args": {"dry_run": True}},
                 {"tool": "update_pcb", "args": {"document_id": board}}]
        out = self.tool("pipeline", {"steps": steps}, timeout=30)
        placed = out["steps"][0]["result"]
        self.assertEqual(placed["untrusted_design_text"]["ref"], "R50")
        self.assertEqual(len(placed["pins"]), 2)
        dry, eco = out["steps"][5]["result"], out["steps"][6]["result"]
        self.assertTrue(dry["dry_run"])
        self.assertEqual(dry["groups"]["Add Components"]["total"], 2)
        self.assertEqual(eco["failed"], 0)
        self.assertEqual(eco["groups"]["Add Components"]["done"], 2)
        # Net class directives act on the board live (signals.js); update_pcb copies no classes.
        self.assertNotIn("Net Classes", eco["groups"])
        proposal = json.loads(Path(out["proposal_file"]).read_text())
        added = [o["value"] for o in proposal["ops"] if o["op"] == "add" and o["target"] == "item" and o["document"] == board]
        self.assertEqual(sorted(i["ref"] for i in added if i["kind"] == "part"), ["C50", "R50"])
        self.assertEqual(revision(self.path), self.digest)
        # With --allow-write they still propose by default. Explicit writes save scoped backups.
        self.stop_server()
        self.start("--allow-write")
        proposed = self.tool("place_part", {"def": "std-r", "x": 60, "y": 60, "designator": "R60"})
        self.assertTrue(proposed["proposal_file"])
        self.assertEqual(revision(self.path), self.digest)
        placed = self.tool("place_part", {"def": "std-r", "x": 60, "y": 60, "designator": "R60", "mode": "write"})
        saved = read_design(self.path)
        self.assertTrue(any(i["id"] == placed["id"] for d in saved["documents"] for i in d["items"]))
        self.assertEqual(placed["file_revision"], revision(self.path))
        self.assert_backup(placed, self.fixture, self.digest)
        original_backups = self.backups()
        self.assertEqual(len(original_backups), 1)
        outline = self.tool("set_board_outline", {"rect": [0, 0, 50, 40], "mode": "write"})
        self.assertEqual(outline["width"], 50)
        self.assertIn("is not a change ID", self.tool("update_pcb", {"only": ["bogus"], "dry_run": True}, error=True))
        eco = self.tool("update_pcb", {"only": ["addComponent", "padNet", "addNet", "link"], "mode": "write"})
        self.assertEqual(eco["failed"], 0)
        moved = self.tool("move_component", {"component": "R60", "x": 10, "y": 10, "mode": "write"})
        self.assertEqual(moved["at"], [10, 10])
        self.assertIn("Name the document", self.tool("delete_items", {"designators": ["R60"], "mode": "write"}, error=True))
        removed = self.tool("delete_items", {"designators": ["R60"], "all_documents": True, "mode": "write"})
        self.assertEqual(len(removed["removed"]), 2)
        self.assertIn("Not found", self.tool("delete_items", {"designators": ["R60"], "all_documents": True, "mode": "write"}, error=True))
        self.assertEqual(len(self.backups()), 5)
        self.assertEqual(self.backups(), {Path(result["backup"]).resolve() for result in (placed, outline, eco, moved, removed)})
        self.assert_backup(placed, self.fixture, self.digest)

    def test_panelize(self):
        import zipfile
        self.start()
        plan = self.tool("panelize", {"rows": 2, "cols": 3, "date": "2026-01-02T03:04:05Z", "generate": True, "output_dir": "panel"})
        self.assertEqual(plan["boards"], 6)
        self.assertGreater(plan["mouse_bites"], 0)
        self.assertTrue(plan["approximate"])
        self.assertEqual(self.proposals(), [])
        with zipfile.ZipFile(plan["zip"]["path"]) as archive:
            names = archive.namelist()
        self.assertTrue(any(n.endswith("-NonPlated.TXT") for n in names), names)
        self.assertTrue(any(n.endswith(".GTL") for n in names), names)
        self.assertTrue(any(n.endswith("-Panel.txt") for n in names), names)
        # The fixture board has chamfered corners: V-score is reported and refused (review H2).
        vs = self.tool("panelize", {"rows": 2, "cols": 2, "separation": "vscore"})
        self.assertGreater(vs["vscore_lines"], 0)
        self.assertIn("vscore-shape", [i["code"] for i in vs["check"]])
        self.assertIn("not rectangular", self.tool("panelize", {"rows": 2, "cols": 2, "separation": "vscore", "generate": True, "output_dir": "vpanel"}, error=True))
        proposed = self.tool("panelize", {"rows": 2, "cols": 2, "mode": "proposal"})
        self.assertEqual(len(self.proposals()), 1)
        self.assertTrue(proposed["panel_id"])

    def test_drawings(self):
        import re
        import zlib
        self.start("--allow-write")
        T = 60
        self.assertIn("no drawing", self.tool("export_drawing", {}, error=True, timeout=T))
        # plan: a full drawing (fabrication + assembly sheets), nothing written.
        plan = self.tool("edit_drawing", {"create": {"name": "Fab drawing", "preset": "full", "size": "A3"}, "date": "2026-11-19T00:00:00Z"}, timeout=T)
        self.assertTrue(plan["created"])
        self.assertEqual(len(plan["sheets"]), 2)
        types = [v["type"] for s in plan["sheets"] for v in s["views"]]
        for t in ("board", "drill-table", "layer-stack", "notes", "revisions", "assembly", "bom"):
            self.assertIn(t, types)
        dims = plan["sheets"][0]["dimensions"]
        self.assertEqual([d["type"] for d in dims][:2], ["linear", "linear"])
        self.assertTrue(all(d["resolved"] for d in dims))
        self.assertEqual(plan["problems"], [])
        self.assertEqual(plan["untrusted_design_text"]["name"], "Fab drawing")
        self.assertEqual(self.proposals(), [])
        err = self.tool("edit_drawing", {"create": {"name": "Bad"}, "ops": [{"op": "add_view", "type": "linear"}]}, error=True, timeout=T)
        self.assertIn("Unknown view type", err)
        # A proposal adds the drawing for review in the editor.
        proposed = self.tool("edit_drawing", {"create": {"name": "Fab drawing", "preset": "fabrication"}, "mode": "proposal", "date": "2026-11-19T00:00:00Z"}, timeout=T)
        self.assertGreater(proposed["changes"], 0)
        self.assertEqual(len(self.proposals()), 1)
        # Write it, then edit it by ID: a note, its callout and an ordinate dimension resolve live.
        made = self.tool("edit_drawing", {"create": {"name": "Fab drawing", "preset": "fabrication"}, "mode": "write", "date": "2026-11-19T00:00:00Z"}, timeout=T)
        view = next(v["id"] for v in made["sheets"][0]["views"] if v["type"] == "board")
        edited = self.tool("edit_drawing", {"drawing_id": made["drawing_id"], "mode": "write", "ops": [
            {"op": "add_note", "text": "Gold fingers: 30° bevel."},
            {"op": "add_callout", "note": 5, "view": view, "at": "corner:bl", "x": 20, "y": 200},
            {"op": "add_dimension", "view": view, "type": "ordinate", "a": "corner:bl", "points": ["corner:br", "corner:tr"], "axis": "x"},
            {"op": "set_parameters", "parameters": {"DocumentNumber": "FAB-001", "DrawnBy": "AI"}}]}, timeout=T)
        self.assertEqual(edited["notes"], 5)
        ordinate = edited["sheets"][0]["dimensions"][-1]
        self.assertEqual(ordinate["type"], "ordinate")
        self.assertEqual(ordinate["value"][0], 0)
        self.assertGreater(ordinate["value"][1], 0)
        # Export: one A3 page, vector content, embedded Unicode font with ToUnicode, deterministic.
        pdf = self.tool("export_drawing", {"date": "2026-11-19T00:00:00Z"}, timeout=T)
        self.assertTrue(pdf["fonts_embedded"])
        self.assertEqual([(p["width_mm"], p["height_mm"]) for p in pdf["pages"]], [(420.0, 297.0)])
        self.assertGreater(pdf["pages"][0]["paths"], 40, pdf["pages"])
        self.assertGreater(pdf["pages"][0]["text"], 40)
        data = Path(pdf["path"]).read_bytes()
        self.assertTrue(data.startswith(b"%PDF-1.4") and data.endswith(b"%%EOF\n"))
        self.assertIn(b"/Subtype /Type0", data)
        self.assertIn(b"/FontFile2", data)
        self.assertIn(b"/ToUnicode", data)
        self.assertNotIn(b"/BaseFont /Helvetica", data)
        self.assertIn(b"/MediaBox [0 0 1190.55 841.89]", data)
        streams = [zlib.decompress(m.group(1)) for m in re.finditer(rb"stream\n(.*?)\nendstream", data, re.S) if m.group(1)[:1] == b"x"]
        page = next(x for x in streams if b" Tf " in x and b" Tm " in x)
        self.assertGreater(len(re.findall(rb" l\n", page)), 100, "vector line work")
        self.assertIn(b"/U 1 Tf", page)
        self.assertEqual(pdf["sha256"], self.tool("export_drawing", {"date": "2026-11-19T00:00:00Z"}, timeout=T)["sha256"])
        tiled = self.tool("export_drawing", {"paper": "A4", "date": "2026-11-19T00:00:00Z", "output_dir": "tiles"}, timeout=T)
        self.assertGreater(len(tiled["pages"]), 1)
        self.assertTrue(all(p["tile"] for p in tiled["pages"]))
        # Smart PDF includes the drawing's sheets too.
        smart = self.tool("export_pdf", {"layer_sets": ["top"], "date": "2026-11-19T00:00:00Z"}, timeout=T)
        self.assertIn("drawing", [p["kind"] for p in smart["pages"]])

    def test_fab_presets(self):
        """fab-presets: list_fab_presets, apply_fab_preset (plan, proposal by default, idempotent), dfm_check."""
        self.start()
        presets = self.tool("list_fab_presets")["presets"]
        ids = [p["id"] for p in presets]
        for pid in ("jlcpcb-2l", "jlcpcb-4l", "jlcpcb-6l"):
            self.assertIn(pid, ids)
        self.assertTrue(all(p["retrieved"] and p["hash"] for p in presets))
        full = self.tool("list_fab_presets", {"id": "jlcpcb-4l"})["presets"][0]
        self.assertEqual(full["limits"]["track"], 0.09)
        self.assertTrue(full["unverified"])
        before = revision(self.path)
        plan = self.tool("apply_fab_preset", {"preset": "jlcpcb-4l", "mode": "plan"})
        self.assertFalse(plan["noop"])
        self.assertTrue(plan["stackup"]["changes"])
        prop = self.tool("apply_fab_preset", {"preset": "jlcpcb-2l"})
        self.assertTrue(prop["proposal_file"], prop)
        self.assertEqual(revision(self.path), before, "a proposal leaves the saved project alone")
        dfm = self.tool("dfm_check", {"preset": "jlcpcb-2l"})
        self.assertEqual(dfm["preset"], "jlcpcb-2l")
        self.assertIn("issues", dfm)
        self.assertEqual(self.tool("dfm_check", {"preset": "jlcpcb-2l", "checks": ["minHole"]})["errors"], 0)

    def test_list_insights(self):
        """Design Insights: read-only advice with keys, checks, severities and locations; never a write."""
        self.start()
        before = revision(self.path)
        out = self.tool("list_insights")
        self.assertIn("items", out)
        self.assertIn("checks", out)
        self.assertTrue({"neck", "returnPlane", "netTypo"} <= {c["id"] for c in out["checks"]})
        for x in out["items"]:
            self.assertTrue(x["key"].startswith(x["check"] + ":"))
            self.assertIn(x["severity"], ("tip", "advice"))
            self.assertEqual(len(x["at"]), 2)
        self.assertRegex(out["note"], "never violations")
        one = self.tool("list_insights", {"check": "neck", "limit": 5})
        self.assertTrue(all(x["check"] == "neck" for x in one["items"]))
        self.assertEqual(revision(self.path), before, "read-only")

    def test_release_packages(self):
        """output-jobs-v2: release is a plan by default and writes only with mode write + --allow-write."""
        self.start()
        plan = self.tool("release", {"job": "JLCPCB order", "date": "2026-11-19T12:00:00Z"})
        self.assertFalse(plan["written"])
        self.assertEqual([c["id"] for c in plan["checks"]], ["drc", "erc", "bom", "variants", "placeholders", "git", "dfm", "outputs"])  # fab-presets: DFM for the JLCPCB bundle
        self.assertEqual(plan["packages"][0]["name"], "Sensor interface-1-2026-11-19/")
        self.assertFalse((self.dir / "Sensor-outputs" / "releases").exists(), "a plan writes nothing")
        self.assertIn("allow-write", self.tool("release", {"job": "JLCPCB order", "mode": "write"}, error=True))
        self.assertEqual(self.tool("list_releases")["on_disk"], [])

    def test_kicad_exports_preserve_placed_board_text(self):
        board = next(d for d in self.design["documents"] if d["id"] == self.pcb)
        parts = {item["ref"]: item for item in board["items"] if item["kind"] == "part"}
        parts["R1"]["boardLabels"] = [
            {"at": [1.25, 2], "angle": 0, "field": "ref", "layer": "Bottom silk",
             "size": 1, "width": 0.2, "mirrored": True,
             "sourceTextBox": {"mode": "ink", "text": "R1", "size": 1, "width": 2.5, "height": 1.1,
                               "font": "stroke", "strokeWidth": 0.2, "strokeFont": "default"}}]
        parts["R2"]["designator"] = {"x": 1, "y": 2, "height": 1, "angle": 0}
        write_design(self.path, self.design)

        self.start("--allow-write")
        direct = self.tool("export_kicad", {"document_id": self.pcb})
        data = next(Path(f["path"]).read_bytes() for f in direct["files"] if f["path"].endswith(".kicad_pcb"))
        self.assertRegex(data, rb'\(fp_line \(start [^\n]+ \(layer "B\.SilkS"\)')
        for ref in (b"R1", b"R2"):
            self.assertRegex(data, rb'\(fp_text reference "' + ref + rb'"[^\n]* hide ')
        release = self.tool("release", {"definition": {"name": "KiCad", "outputs": [{"kind": "kicad", "options": {"sheets": False}}]},
                                       "package": "folder", "date": "2026-11-19T12:00:00Z", "mode": "write",
                                       "overrides": [{"check": c, "reason": "test fixture"} for c in ("drc", "erc", "bom", "git")]})
        packaged = next(Path(f["path"]).read_bytes() for f in release["files"] if f["path"].endswith(".kicad_pcb"))
        self.assertEqual(packaged, data)

    def test_release_write(self):
        self.start("--allow-write")
        before = revision(self.path)
        args = {"job": "Generic fab + assembly", "package": "folder", "date": "2026-11-19T12:00:00Z", "mode": "write", "notes": "CI build",
                "overrides": [{"check": c, "reason": "accepted for the test board"} for c in ("drc", "erc", "bom", "git", "outputs")]}
        out = self.tool("release", args, timeout=240)
        self.assertTrue(out["written"])
        root = self.dir.resolve() / "Sensor-outputs" / "releases" / "Sensor interface-1-2026-11-19"
        manifest = json.loads((root / "release.json").read_text())
        self.assertEqual(manifest["format"], "atrium-release")
        self.assertEqual(manifest["notes"], "CI build")
        self.assertTrue(all(o["reason"] for o in manifest["overrides"]))
        for f in manifest["files"]:
            data = (root / f["path"]).read_bytes()
            self.assertEqual(hashlib.sha256(data).hexdigest(), f["sha256"], f["path"])
        self.assertIn("# Sensor interface-1-2026-11-19", (root / "RELEASE.md").read_text())
        listed = self.tool("list_releases")
        self.assertEqual([r["name"] for r in listed["on_disk"]], ["Sensor interface-1-2026-11-19"])
        self.assertEqual(revision(self.path), before, "a release never edits the project")

    def test_output_job_sets(self):
        self.start("--allow-write")
        listed = self.tool("run_output_job", {"list": True})
        self.assertEqual([p["name"] for p in listed["presets"]], ["JLCPCB order", "PCBWay order", "Generic fab + assembly", "Release (placeholders resolved)", "Documentation only", "Everything"])
        self.assertEqual([p["name"] for p in listed["legacy_presets"]], ["Full release", "Review pack"])
        self.assertIn("ipc2581", listed["kinds"])
        job = {"name": "CI", "folder": "{board}-{rev}", "outputs": [{"kind": "gerber", "options": {"pack": "{board}-Gerber.zip"}},
               {"kind": "ipc2581"}, {"kind": "drc", "options": {"failOver": 0}}, {"kind": "readme"}]}
        run = self.tool("run_output_job", {"definition": job, "revision": "C", "date": "2026-01-02T03:04:05Z", "output_dir": "jobs"})
        self.assertFalse(run["ok"])  # The sample board has a DRC violation; the gate fails the run.
        # The fixture's GND pour was never poured: Gerber and IPC-2581 plot its fill (made for the outputs) and say so.
        self.assertEqual([o["status"] for o in run["report"]["outputs"]], ["warning", "warning", "failed", "ok"])
        self.assertTrue(all(any("never poured in the design were filled for these outputs: GND pour" in w for w in o["warnings"])
                            for o in run["report"]["outputs"][:2]), run["report"]["outputs"][:2])
        root = self.dir.resolve() / "Sensor-outputs" / "jobs"
        for f in run["files"]:
            data = Path(f["path"]).read_bytes()
            self.assertEqual((len(data), hashlib.sha256(data).hexdigest()), (f["bytes"], f["sha256"]))
            self.assertIn(root, Path(f["path"]).parents)
        folder = Path(run["files"][0]["path"]).parents[1]
        self.assertEqual(folder.name, "Sensor board-C")
        for line in (folder / "SHA256SUMS").read_text().splitlines():
            digest, name = line.split("  ", 1)
            self.assertEqual(hashlib.sha256((folder / name).read_bytes()).hexdigest(), digest)
        self.assertIn('<IPC-2581 revision="B"', (folder / "IPC-2581" / "Sensor board.ipc2581.xml").read_text())
        args = json.dumps({"job": "JLCPCB order", "date": "2026-01-02T03:04:05Z", "output_dir": "cli"})
        cli = subprocess.run([sys.executable, "-B", str(SERVER), "--project", str(self.path), "--cli", "run_output_job", "--args", args],
                             capture_output=True, text=True, timeout=120)
        self.assertEqual(cli.returncode, 0, cli.stderr)
        names = [f["name"] for f in json.loads(cli.stdout)["files"]]
        # Vendor layouts name fab files with the fab dialog's stem (project name slugified), not the board name.
        self.assertTrue(any(n.endswith("/CPL-Sensor-interface.csv") for n in names) and any(n.endswith("/Sensor-interface-Gerber.zip") for n in names), names)


    def test_drc_waivers_are_listed_and_marked(self):
        # A waiver made in the editor (drc-waivers.js) on the thin track's Width violation.
        sys.path.insert(0, str(ROOT / "mcp"))
        from board_runner import JavaScriptCore, load_jsc
        lib = load_jsc()
        if not lib:
            raise unittest.SkipTest("JavaScriptCore is required")
        js = JavaScriptCore(lib, ("drc-waivers",))
        try:
            script = ("(() => { const p = %s; const d = p.documents.find(x => x.kind === 'pcb');"
                      " AtriumDRCWaivers.add(d, {type: 'width', ruleName: 'Width', id: 'thin', title: 'Track (Top) GND'}, {note: 'checked with the fab'});"
                      " return JSON.stringify(p); })()") % json.dumps(self.design)
            write_design(self.path, json.loads(js.value_text(js.evaluate(script))))
        finally:
            js.close()
        self.start()
        listed = self.tool("drc_waivers", {})
        self.assertEqual((listed["total"], listed["current"]), (1, 1))
        self.assertEqual((listed["items"][0]["type"], listed["items"][0]["objects"]), ("width", ["thin"]))
        self.assertEqual(listed["untrusted_design_text"]["waivers"][0]["note"], "checked with the fab")
        drc = self.tool("run_drc", {"rules": ["width"]})
        thin = next(v for v in drc["items"] if v["id"] == "thin")
        self.assertTrue(thin["waived"])
        self.assertEqual(drc["waived"], 1)
        self.assertEqual(drc["total"], len(drc["items"]) - 1)
        self.assertEqual(drc["rules"], [{"id": "width-1", "name": "Width", "type": "width", "count": 0, "waived": 1}])

    def test_import_design_converts_altium_project(self):
        # Real Altium Designer project (tests/fixtures/altium/pidp11-io-expander, BSD-2-Clause; see its NOTICE).
        fixtures = Path(__file__).resolve().parents[1] / "fixtures" / "altium" / "pidp11-io-expander"
        names = ["PCB-PiDP11IOExpander.PrjPcb", "PiDP11IOExpander.SchDoc", "PiDP11IOExpander.PcbDoc"]
        for name in names:
            (self.dir / name).write_bytes((fixtures / name).read_bytes())
        self.start()
        out = self.tool("import_design", {"paths": names, "name": "PiDP", "mode": "save-as"}, timeout=60)
        docs = {d["kind"]: d for d in out["documents"]}
        self.assertEqual((docs["schematic"]["parts"], docs["pcb"]["parts"], docs["pcb"]["tracks"], docs["pcb"]["vias"]), (23, 23, 194, 59))
        self.assertTrue(any("stored polygon fill" in n for n in out["notes"]))
        self.assertEqual(docs["pcb"]["pours"], 2)  # Altium pours import as editable polygon pours
        saved = read_design(Path(out["path"]))
        provenance, = retained_provenance(Path(out["path"]))
        self.assertEqual(sorted(row["values"]["sourceName"] for row in provenance["fields"]
                                if row["type"] == "document" and "sourceName" in row["values"]),
                         ["PiDP11IOExpander.PcbDoc", "PiDP11IOExpander.SchDoc"])
        # The board's 41 Altium rules stay source records unless source_rules is "use" (import-rules.js).
        board = next(d for d in saved["documents"] if d["kind"] == "pcb")
        self.assertNotIn("rules", board)
        self.assertEqual([(r["document_id"], r["count"], r["applied"]) for r in out["source_rules"]], [(docs["pcb"]["id"], 41, False)])
        used = self.tool("import_design", {"paths": names, "name": "PiDP", "source_rules": "use", "mode": "save-as"}, timeout=60)
        self.assertNotEqual(Path(used["path"]).parent, Path(out["path"]).parent)
        rules = used["source_rules"][0]
        # Altium's stored fill was poured under these rules: kept, not repoured (import-rules.js).
        self.assertTrue(rules["applied"] and 0 < rules["converted"] <= 41 and rules["kept_pours"] == 2 and rules["repoured_regions"] == 0, rules)
        book = read_design(Path(used["path"]))["rules"]
        self.assertEqual(book["version"], 3)
        self.assertTrue(any(r["type"] == "clearance" and abs(r["gap"] - 0.1524) < 1e-6 and r.get("origin", {}).get("kind") == "import" for r in book["list"]))
        self.assertIn("together with", self.tool("import_design", {"paths": names[:1]}, error=True))

    def test_translators_share_discovery_reports_and_output_permissions(self):
        self.start()
        root = SERVER.parents[1]
        expected = json.loads((root / "app" / "translators.json").read_text(encoding="utf-8"))
        catalog = self.tool("list_translators")
        self.assertEqual([(x["id"], x["import"], x["export"]) for x in catalog["translators"]],
                         [(x["id"], x["import"], x["export"]) for x in expected if x["id"] != "odb"])
        exports = self.tool("list_translators", {"direction": "export"})["translators"]
        self.assertNotIn("odb", {x["id"] for x in exports})
        disabled = self.request("tools/call", {"name": "export_design", "arguments": {"translator": "odb"}})["result"]
        self.assertTrue(disabled["isError"])
        self.assertEqual(disabled["structuredContent"]["error"]["code"], "butter_disabled")

        source = self.dir / "demo.kicad_pcb"
        source.write_bytes((root / "tests" / "fixtures" / "import" / source.name).read_bytes())
        imported = self.tool("import_design", {"paths": [source.name], "translator": "kicad", "mode": "save-as"})
        self.assertEqual(imported["provenance"]["files"][0]["sha256"], hashlib.sha256(source.read_bytes()).hexdigest())
        self.assertEqual((imported["report"]["translator"], imported["report"]["direction"]), ("kicad", "import"))
        self.assertTrue(imported["documents"] and imported["report"]["kinds"] and imported["untrusted_design_text"])
        manifest = Path(imported["path"])
        self.assertEqual(imported["format"], "2.0")
        self.assertEqual(revision(manifest), imported["sha256"])
        self.assertIn("pcb", {doc["kind"] for doc in read_design(manifest)["documents"]})

        obsolete = self.dir / "Legacy.atrium"
        obsolete.write_bytes((root / "tests" / "fixtures" / "compat" / "projects" / "v1.4-sample.atrium").read_bytes())
        for tool, options in (("import_design", {"paths": [obsolete.name]}),
                              ("export_design", {"translator": "legacy"})):
            reply = self.request("tools/call", {"name": tool, "arguments": options})["result"]
            self.assertTrue(reply["isError"])
            self.assertEqual(reply["structuredContent"]["error"], {
                "code": "pre-release-format", "message": PRE_RELEASE, "retryable": False})

        args = {"translator": "excellon", "source_sha256": self.digest, "options": {"date": "2026-01-02T00:00:00Z"}}
        self.assertIn("saved project changed", self.tool("export_design", dict(args, source_sha256="0" * 64), error=True).lower())
        exported = self.tool("export_design", args)
        self.assertEqual((exported["report"]["translator"], exported["report"]["direction"]), ("excellon", "export"))
        self.assertTrue(any(row["references"] for row in exported["report"]["kinds"]))
        self.assertTrue(any(b"M48" in Path(f["path"]).read_bytes() for f in exported["files"]))
        cli = subprocess.run([sys.executable, "-B", str(SERVER), "--project", str(self.path), "--cli", "export_design",
                              "--args", json.dumps(dict(args, output_dir="cli-excellon"))], capture_output=True, text=True, timeout=30)
        self.assertEqual(cli.returncode, 0, cli.stderr)
        cli_out = json.loads(cli.stdout)
        self.assertEqual([f["sha256"] for f in cli_out["files"]], [f["sha256"] for f in exported["files"]])
        self.assertEqual(cli_out["report"], exported["report"])
        again = self.tool("export_design", args)
        self.assertEqual([(f["path"], f["sha256"]) for f in again["files"]],
                         [(f["path"], f["sha256"]) for f in exported["files"]])
        self.assertEqual(revision(self.path), self.digest)

    @unittest.skipUnless(shutil.which("node"), "Node is required to check the shared reference decoder")
    def test_translator_reports_retain_later_object_references(self):
        self.start()
        source = self.dir / "Provenance.kicad_pcb"
        tracks = [
            f'(segment (start 1 {i}) (end 9 {i}) (width 0.2) (layer "F.Cu") (net 1) (tstamp 10000000-0000-4000-8000-{i:012d}))'
            for i in range(320)
        ]
        source.write_text("\n".join([
            '(kicad_pcb (version 20240108) (generator pcbnew)',
            '(general (thickness 1.6))', '(layers (0 "F.Cu" signal) (31 "B.Cu" signal))',
            '(net 0 "")', '(net 1 "SUPPLY")', *tracks, ')',
        ]), encoding="utf-8")
        args = {"paths": [source.name], "translator": "kicad", "mode": "save-as"}
        imported = self.tool("import_design", args)
        cli = subprocess.run([sys.executable, "-B", str(SERVER), "--project", str(self.path), "--cli", "import_design",
                              "--args", json.dumps(args)], capture_output=True, text=True, timeout=30)
        self.assertEqual(cli.returncode, 0, cli.stderr)
        cli_import = json.loads(cli.stdout)
        track = next(row for row in imported["report"]["kinds"] if row["kind"] == "track")
        self.assertGreater(track["referenceCount"], 256)
        imports = "\n".join(f"require({json.dumps(str(path))});" for _, path in resolve(("translator-registry",)))
        parser = imports + '''
const report = JSON.parse(require("node:fs").readFileSync(0, "utf8"));
let match, targetId;
for (const kind of [...report.kinds, ...report.modelObjects]) {
  kind.references = Array.from(AtriumTranslatorRegistry.references(kind), ({id, ...reference}) => {
    if (reference.source.object === process.argv[1]) {
      if (reference.status === "kept") match = reference;
      if (id != null) targetId = id;
    }
    return reference;
  });
}
process.stdout.write(JSON.stringify({report, match, targetId}));
'''
        expected = "segment 10000000-0000-4000-8000-000000000319 #326"

        def reference_report(result):
            decoded = subprocess.run([shutil.which("node"), "-e", parser, expected], input=json.dumps(result["report"]),
                                     capture_output=True, text=True, timeout=30)
            self.assertEqual(decoded.returncode, 0, decoded.stderr)
            decoded = json.loads(decoded.stdout)
            ref = decoded["match"]
            self.assertEqual(ref["status"], "kept")
            self.assertEqual(ref["source"], {"file": source.name, "object": expected})
            manifest = Path(result["path"])
            provenance, = retained_provenance(manifest)
            row, = [row for row in provenance["fields"] if row["type"] == "item" and
                    row["values"].get("kicadSourceId") == "10000000-0000-4000-8000-000000000319"]
            self.assertEqual(decoded["targetId"], row["id"])
            project = read_design(manifest)
            item = next(i for d in project["documents"] for i in d["items"] if i["id"] == row["id"])
            self.assertEqual((item["kind"], item["width"], item["points"]), ("track", 0.2, [[1, 319], [9, 319]]))
            return decoded["report"]

        self.assertEqual(reference_report(cli_import), reference_report(imported))

    def test_import_design_pairs_schlib_and_pcblib(self):
        # SchLib + PcbLib together: complete components (app/library/library-import-altium.js), drafts with provenance.
        fixtures = Path(__file__).resolve().parents[1] / "fixtures" / "library"
        names = ["Lab.SchLib", "Lab.PcbLib"]
        for name in names:
            (self.dir / name).write_bytes((fixtures / name).read_bytes())
        self.start()
        out = self.tool("import_design", {"paths": names, "name": "Lab", "mode": "save-as"}, timeout=60)
        self.assertEqual(out["library_pairing"], {"components": 5, "paired": 3, "symbol_only": 1, "footprint_only": 1, "ambiguous": 0, "unmatched": 1, "pin_pad_mismatches": 1})
        saved = read_design(Path(out["path"]))
        opamp = next(d for d in saved["library"] if d["name"] == "LMV321")
        self.assertEqual((opamp["footprint"]["name"], opamp["state"]), ("SOT23-5", "draft"))
        provenance, = retained_provenance(Path(out["path"]))
        origin = next(row["values"]["source"] for row in provenance["fields"]
                      if row["type"] == "library" and row["id"] == opamp["id"])
        self.assertEqual(origin["footprint"]["file"], "Lab.PcbLib")
        self.assertEqual(revision(self.path), self.digest)

    def test_import_design_saves_selected_altium_profile_job(self):
        corners = [(15, 20), (45, 20), (45, 32), (15, 32)]
        board = "|RECORD=Board" + "".join(f"|VX{i}={x}mm|VY{i}={y}mm" for i, (x, y) in enumerate(corners))
        tracks = [f"|RECORD=Track|LAYER=KEEPOUT|X1={x}mm|Y1={y}mm|X2={u}mm|Y2={v}mm|WIDTH=10mil"
                  for (x, y), (u, v) in zip(corners, corners[1:] + corners[:1])]
        (self.dir / "Edge.PcbDoc").write_text("\n".join([board, *tracks]), encoding="utf-8")
        (self.dir / "Edge.PrjPcb").write_text(
            "[Document1]\nDocumentPath=Edge.PcbDoc\n[OutputGroup1]\n"
            "Configuration1_Item1=Record=GerberView|GerberUnit=Metric|NumberOfDecimals=4|OriginPosition=Absolute|Plot.Set=16973837~1\n",
            encoding="utf-8")
        self.start()
        result = self.tool("import_design", {"paths": ["Edge.PrjPcb", "Edge.PcbDoc"], "mode": "save-as"})
        p = Path(result["path"])
        snapshot = authored_files(p.parent)
        job, = read_design(p)["outputJobs"]
        self.assertEqual(job["name"], "Altium board profile")
        args = json.dumps({"job": job["name"], "date": "2026-01-02T03:04:05Z"})
        cli = subprocess.run([sys.executable, "-B", str(SERVER), "--project", str(p), "--cli", "run_output_job", "--args", args],
                             capture_output=True, text=True, timeout=60)
        self.assertEqual(cli.returncode, 0, cli.stderr)
        exported = json.loads(cli.stdout)
        profile, = exported["files"]
        translation, = exported["report"]["outputs"][0]["translationReports"]
        self.assertEqual((translation["translator"], translation["direction"]), ("fabrication", "export"))
        self.assertTrue(any(row["kept"] for row in translation["kinds"]))
        self.assertTrue(profile["name"].endswith(".GKO"))
        content = Path(profile["path"]).read_text()
        self.assertIn("%ADD10C,0.254*%", content)
        self.assertIn("X150000Y200000D02*", content)
        self.assertEqual(authored_files(p.parent), snapshot)

    def test_import_design_converts_kicad_eagle_and_easyeda(self):
        fixtures = Path(__file__).resolve().parents[1] / "fixtures" / "import"
        names = ["demo.kicad_pro", "root.kicad_sch", "child.kicad_sch", "demo.kicad_pcb", "demo-eagle.sch", "demo-eagle.brd", "demo-easyeda-pcb.json", "demo-easyeda.epro"]
        for name in names:
            (self.dir / name).write_bytes((fixtures / name).read_bytes())
        self.start()
        kicad = self.tool("import_design", {"paths": names[:4], "name": "Demo", "mode": "save-as"}, timeout=20)
        self.assertEqual(sorted(d["kind"] for d in kicad["documents"]), ["pcb", "schematic", "schematic"])
        saved = read_design(Path(kicad["path"]))
        self.assertEqual((saved["format"], saved["name"], Path(kicad["path"]).name), ("atrium", "Demo", "Demo.waffle"))
        again = self.tool("import_design", {"paths": names[:4], "name": "Demo", "mode": "save-as"}, timeout=20)
        self.assertEqual(Path(again["path"]).parent.name, "Demo (2)")
        self.assertEqual(revision(Path(kicad["path"])), kicad["sha256"])
        # Amplified geometry fails cleanly in the sandboxed child.
        wires = "".join('<wire x1="%d" y1="0" x2="%d" y2="1" width="0.1" layer="21" curve="359.9"/>' % (i, i) for i in range(20000))
        (self.dir / "amplify.brd").write_text('<?xml version="1.0"?><eagle><drawing><board><plain>' + wires + '</plain></board></drawing></eagle>')
        self.assertIn("more geometry", self.tool("import_design", {"paths": ["amplify.brd"], "time_limit_s": 30}, error=True, timeout=40))
        (self.dir / "x.eprj").write_bytes(b"SQLite format 3\x00" + bytes(100))
        self.assertIn("not supported", self.tool("import_design", {"paths": ["x.eprj"]}, error=True))
        board = next(d for d in saved["documents"] if d["kind"] == "pcb")
        self.assertEqual(next(d for d in kicad["documents"] if d["kind"] == "pcb")["pours"], 1)
        self.assertNotIn("rules", board)
        ground_scope = {"languageVersion": 1, "source": 'object where net.name = "GND"'}
        self.assertTrue(any(r["type"] == "width" and r["scope"] == ground_scope and r["min"] == 0.5
                            for r in saved["rules"]["list"]))
        provenance, = retained_provenance(Path(kicad["path"]))
        document_by_source = {row["values"]["sourceName"]: row["id"] for row in provenance["fields"]
                              if row["type"] == "document" and "sourceName" in row["values"]}
        sheet = next(d for d in saved["documents"] if d["id"] == document_by_source["root.kicad_sch"])
        child = next(d for d in saved["documents"] if d["id"] == document_by_source["child.kicad_sch"])
        self.assertEqual(next(i for i in sheet["items"] if i["kind"] == "sheetsymbol")["sheet"], child["id"])
        eagle = self.tool("import_design", {"paths": names[4:6], "mode": "preview"}, timeout=20)
        self.assertEqual(sorted(d["kind"] for d in eagle["documents"]), ["pcb", "schematic", "schematic"])
        easy = self.tool("import_design", {"paths": names[6:], "name": "Easy", "mode": "preview"}, timeout=20)
        self.assertEqual(sum(d["parts"] for d in easy["documents"] if d["kind"] == "pcb"), 4)
        self.assertTrue(easy["notes"])
        with tempfile.TemporaryDirectory(dir=self.dir.parent) as outside:
            (Path(outside) / "outside.kicad_pcb").write_text("(kicad_pcb)", encoding="utf-8")
            relative = "../" + Path(outside).name + "/outside.kicad_pcb"
            self.assertIn("inside", self.tool("import_design", {"paths": [relative]}, error=True))
        self.assertIn("not found", self.tool("import_design", {"paths": ["missing.kicad_pcb"]}, error=True))
        self.assertIn("together with", self.tool("import_design", {"paths": ["demo.kicad_pro"]}, error=True))
        self.assertEqual(revision(self.path), self.digest)

    def test_outputs_cannot_overwrite_the_project_or_git(self):
        """Output jobs cannot overwrite Design.waffle or .git/HEAD."""
        git = self.dir / ".git"
        git.mkdir(exist_ok=True)
        (git / "HEAD").write_text("ref: refs/heads/main\n")
        (self.dir / "notes.txt").write_text("mine")
        project, head = authored_files(self.dir), (git / "HEAD").read_bytes()
        attack = {"output_dir": ".", "definition": {"name": "x", "folder": "", "outputs": [
            {"kind": "gerber", "folder": "", "options": {"pack": self.path.name, "readme": False}},
            {"kind": "gerber", "folder": ".git", "options": {"pack": "HEAD", "readme": False}}]}}
        self.start()
        self.assertIn("--allow-write", self.tool("run_output_job", attack, error=True))
        self.start("--allow-write")
        self.tool("run_output_job", attack, error=True)
        for bad in ({"output_dir": ".git"}, {"output_dir": "x/.ssh"}, {"output_dir": "../escape"}, {"output_dir": "/tmp"}):
            self.tool("generate_bom", bad, error=True)
        self.assertEqual((authored_files(self.dir), (git / "HEAD").read_bytes()), (project, head))
        self.assertEqual((self.dir / "notes.txt").read_text(), "mine")
        # Outputs land in <project>-outputs/; a foreign file there is never replaced, a symlink never followed.
        base = self.dir.resolve() / "Sensor-outputs" / "bom"
        first = self.tool("generate_bom", {"formats": ["csv"]})["files"][0]
        self.assertEqual(Path(first["path"]).parent, base)
        again = self.tool("generate_bom", {"formats": ["csv"]})["files"][0]
        self.assertEqual(again["path"], first["path"])  # Waffle's own earlier output may be replaced.
        Path(first["path"]).unlink()
        Path(first["path"]).write_text("user file")
        (base / ".waffle-outputs.json").unlink()
        self.assertIn("did not create", self.tool("generate_bom", {"formats": ["csv"]}, error=True))
        self.assertEqual(Path(first["path"]).read_text(), "user file")
        os.symlink(self.dir, self.dir.resolve() / "Sensor-outputs" / "link")
        self.assertIn("symbolic link", self.tool("generate_bom", {"output_dir": "link"}, error=True))
        self.assertEqual(authored_files(self.dir), project)

    def test_hostile_designs_cannot_hang_the_server(self):
        """Bound via-fence fan-out and regex work, and mark untrusted design text."""
        design = read_design(self.path)
        pcb = next(d for d in design["documents"] if d["kind"] == "pcb")
        pcb["outline"] = [[0, 0], [1e5, 0], [1e5, 1e5], [0, 1e5]]
        label = next((i for d in design["documents"] for i in d["items"] if i.get("kind") == "netlabel"), None)
        if label:
            label["text"] = "a" * 60 + "b"
        write_design(self.path, design)
        self.start()
        started = time.monotonic()
        error = self.tool("run_command", {"command": "via_fence", "mode": "plan", "args": {"document_id": pcb["id"], "action": "place", "kind": "area",
                                                                                         "source": {"outline": True}}}, error=True)
        self.assertIn("limit 200,000", error)
        self.assertIn("could take very long", self.tool("run_command", {"command": "find_replace", "args": {"query": "^(a|aa)+$", "regex": True}}, error=True))
        self.assertLess(time.monotonic() - started, 5)
        selected = self.tool("run_command", {"command": "select", "args": {"document_id": pcb["id"], "kinds": ["part"]}})
        self.assertTrue(selected["ids"] and "untrusted_design_text" in selected)
        self.assertFalse({"items", "rows"} & set(selected), "design rows sit under untrusted_design_text")

    def test_output_gates_and_checksums(self):
        """Exercise the DRC gate and checksum the exact UTF-8 bytes generated for BOM output."""
        self.start("--allow-write")
        gate = lambda value: {"definition": {"name": "Gate", "folder": "g", "outputs": [{"kind": "drc", "options": {"failOver": value}}, {"kind": "readme"}]}}
        for value in (0, "0", " 0 "):
            run = self.tool("run_output_job", dict(gate(value), output_dir="gate"))
            self.assertFalse(run["ok"], value)
        self.assertIn("whole number", self.tool("run_output_job", gate("zero"), error=True))
        self.assertTrue(self.tool("run_output_job", dict(gate(""), output_dir="gate"))["ok"], "empty means report only")
        design = read_design(self.path)
        part = next(i for d in design["documents"] for i in d["items"] if i.get("kind") == "part")
        before = authored_files(self.dir)
        part["value"] = "10k\ud800X"
        with self.assertRaises((ValueError, subprocess.CalledProcessError)) as rejected:
            write_design(self.path, design)
        error = rejected.exception
        message = error.stderr if isinstance(error, subprocess.CalledProcessError) else str(error)
        self.assertIn("Unpaired Unicode surrogate", message)
        self.assertEqual(authored_files(self.dir), before)
        part["value"] = "10k Ω\N{REPLACEMENT CHARACTER}X"
        write_design(self.path, design)
        self.start("--allow-write")
        run = self.tool("run_output_job", {"definition": {"name": "S", "folder": "s", "outputs": [{"kind": "bom"}, {"kind": "readme"}]}, "output_dir": "sur"})
        folder = Path(run["files"][0]["path"]).parent
        while not (folder / "SHA256SUMS").exists():
            folder = folder.parent
        for line in (folder / "SHA256SUMS").read_text().splitlines():
            digest, name = line.split("  ", 1)
            self.assertEqual(hashlib.sha256((folder / name).read_bytes()).hexdigest(), digest, name)
        self.assertTrue(any(part["value"].encode("utf-8") in Path(f["path"]).read_bytes() for f in run["files"]))
        written = {f["sha256"] for f in run["files"]}
        self.assertTrue(all(f["sha256"] in written for r in run["report"]["outputs"] for f in r["files"]))


class ProposalPublishTests(unittest.TestCase):
    """v1 Server.propose and v2 Automation.finish publish through one confined writer."""

    def test_failed_write_keeps_original_and_drops_staging(self):
        from types import SimpleNamespace
        from unittest.mock import patch
        import automation
        import server

        class Folder:
            def require_editable_format(self, owners=None):
                return None

            def proposal_base(self):
                return {"documents": ["doc-1"]}

        class Halt(BaseException):
            pass

        v1 = {
            "format": "atrium-ai", "version": 1, "project": "Board", "source_sha256": "a" * 64,
            "document_ids": ["doc-1"],
            "changes": [{"document": "doc-1", "id": "item-1", "ref": "R1", "field": "value", "before": "10k", "after": "4.7k"}],
            "format2_base": {"documents": ["doc-1"]},
        }
        v2_body = {
            "format": "atrium-ai", "version": 2, "tool": "review_v2", "note": "µ",
            "ops": [{"op": "set", "target": "review"}],
        }
        v2_proposal = json.loads(json.dumps(v2_body, ensure_ascii=False))
        v2_proposal["format2_base"] = {"documents": ["doc-1"]}
        reviews = {
            "v1": ("board-v1.json", b"ORIGINAL-V1-REVIEW\n", "board-v1-",
                   (json.dumps(v1, ensure_ascii=False, indent=2, allow_nan=False) + "\n").encode("utf-8")),
            "v2": ("board-v2.json", b"ORIGINAL-V2-REVIEW\n", "board-v2-review-v2-",
                   (json.dumps(v2_proposal, ensure_ascii=False, indent=2, allow_nan=False) + "\n").encode("utf-8")),
        }

        def publish(label, project):
            folder = Folder()
            if label == "v1":
                stub = SimpleNamespace(
                    path=project, folder=folder, project={"name": "Board"}, digest="a" * 64, documents={"doc-1"},
                    parts={"R1": ({"id": "doc-1"}, {"id": "item-1", "ref": "R1", "value": "10k"})})
                return server.Server.propose(stub, [{"component_id": "R1", "field": "value", "value": "4.7k"}])
            body = json.dumps(v2_body, ensure_ascii=False)

            def revision_gate(tool, args):
                return None

            def js(name, arguments):
                self.assertEqual((name, arguments["tool"]), ("proposal", "review_v2"))
                return {"ops": 1, "version": 2, "owners": ["doc-1"], "summary": ["review_v2"]}, body

            stub = SimpleNamespace(
                server=SimpleNamespace(path=project, folder=folder), loaded=("b" * 64,),
                revision_gate=revision_gate, js=js)
            return automation.Automation.finish(stub, "review_v2", {}, {"review": label})

        def staged(root, filename):
            return [path for path in root.iterdir() if path.name != filename]

        def check(label, fail=None):
            filename, original, prefix, proposal = reviews[label]
            with tempfile.TemporaryDirectory() as directory:
                root = Path(directory)
                project = root / filename
                project.write_bytes(original)
                if fail is None:
                    result = publish(label, project)
                    files = staged(root, filename)
                    self.assertEqual(project.read_bytes(), original)
                    if label == "v1":
                        proposal = proposal.replace(b"\n", server.linesep.encode())
                    self.assertEqual([path.read_bytes() for path in files], [proposal])
                    self.assertTrue(files[0].name.startswith(prefix) and files[0].name.endswith(".waffle-ai"), files[0].name)
                    self.assertEqual(Path(result["proposal_file"]).read_bytes(), proposal)
                    if label == "v2":
                        self.assertEqual((result["bytes"], result["sha256"], result["proposal_version"]),
                                         (len(proposal), hashlib.sha256(proposal).hexdigest(), 2))
                        self.assertIn("µ".encode(), proposal)
                    return
                with self.assertRaises(type(fail)) as caught:
                    publish(label, project)
                self.assertEqual(str(caught.exception), "proposal write failed")
                self.assertEqual(project.read_bytes(), original)
                self.assertEqual(staged(root, filename), [])

        check("v1")
        check("v2")
        with patch.object(server, "linesep", "\r\n"):
            check("v1")

        with tempfile.TemporaryDirectory() as directory:
            project = Path(directory) / (("b" * 220) + ".json")
            project.write_bytes(b"original")
            prefix = project.stem + "-"
            occupied = project.parent / (prefix + "occupied.waffle-ai")
            occupied.write_bytes(b"older proposal")
            with patch.object(server, "proposal_v1_token", side_effect=["occupied", "nextname"]):
                result = publish("v1", project)
            self.assertEqual(Path(result["proposal_file"]).name, prefix + "nextname.waffle-ai")
            self.assertEqual(occupied.read_bytes(), b"older proposal")
            self.assertEqual(project.read_bytes(), b"original")

        saved = automation.Automation.__dict__["write_fd"]

        def fail(fd, data, mode=None, error=RuntimeError("proposal write failed")):
            try:
                os.write(fd, data[:max(1, len(data) // 2)])
            finally:
                os.close(fd)
            raise error

        try:
            for label, error in (("v1", RuntimeError("proposal write failed")), ("v2", RuntimeError("proposal write failed")), ("v1", Halt("proposal write failed"))):
                with self.subTest(review=label, write=type(error).__name__):
                    automation.Automation.write_fd = staticmethod(lambda fd, data, mode=None, error=error: fail(fd, data, mode, error))
                    check(label, error)
        finally:
            automation.Automation.write_fd = saved



if __name__ == "__main__":
    unittest.main()
