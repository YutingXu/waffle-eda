#!/usr/bin/env python3
"""Verify recordings and safe failure through the actual native stdio command broker."""

import json
from copy import deepcopy
from pathlib import Path
import runpy
import subprocess
import tempfile

import sys as _test_sys
from pathlib import Path as _TestPath
_test_sys.path.insert(0, str((_TestPath(__file__).resolve().parent / "../support").resolve()))
from native_sample import authored_files, read_design


HERE = Path(__file__).resolve().parents[1]
support = runpy.run_path(str(HERE / "automation/butter-acceptance.py"))
Stdio, server, sample = (support[key] for key in ("Stdio", "server", "make_sample"))
workspace_files = support["workspace_files"]
case_file = HERE / "fixtures/butter-acceptance/macros.json"
cases = json.loads(case_file.read_text())["cases"]
arguments = json.loads((HERE / "fixtures/butter-command-arguments.json").read_text())


def call(client, action, args, mode=None, *, denied=False):
    request = {"command": "butter.macros." + action, "args": args}
    if mode:
        request["mode"] = mode
    return client.check_tool("run_command", request, denied=denied)


with tempfile.TemporaryDirectory(prefix="waffle-macro-native-") as out:
    project = sample(Path(out).resolve())
    before = workspace_files(project.parent)
    flags = ("--allow-write", "--enable-butter", "macros", "--enable-butter", "query", "--enable-butter", "numericFields")
    flags += ("--enable-butter", "visualHistory")
    with Stdio(server(project, *flags)) as client:
        for case in arguments:
            command, raw, expected = (case[key] for key in ("command", "args", "outcome"))
            request = {"command":command, "args":json.loads(raw), "mode":"plan"}
            denied = expected != "accepted"
            response = client.check_tool("run_command", request, denied=denied)
            assert (response["code"] if denied else "accepted") == expected, (case, response)
            if not denied:
                assert response["complete"] and len(response["untrusted_design_text"]["rows"]) == 1, response
            cli_args = '{"command":' + json.dumps(command) + ',"mode":"plan","args":' + raw + '}'
            cli = subprocess.run([*server(project, *flags), "--cli", "run_command", "--args", cli_args],
                                 capture_output=True, text=True, timeout=30)
            assert cli.returncode == int(denied), (case, cli.stdout, cli.stderr)
            if not denied:
                assert json.loads(cli.stdout)["complete"], cli.stdout
        assert workspace_files(project.parent) == before
        assert client.check_tool("run_command", {"command":"butter.macros.unknown"}, denied=True)["code"] == "unsupported_command"
        assert client.check_tool("run_command", {"command":"butter.ai.ask"}, denied=True)["code"] == "butter_disabled"
        assert call(client, "record-stop", {}, "write", denied=True)["code"] == "not_recording"
        call(client, "record-start", {}, "write")
        assert call(client, "record-start", {}, "write", denied=True)["code"] == "already_recording"
        rule_args = cases["check-design-rules"]["args"]
        call(client, "check-design-rules", rule_args, "plan")
        assert call(client, "record-status", {})["count"] == 0
        call(client, "check-design-rules", rule_args)
        result = call(client, "record-stop", {}, "write")["untrusted_design_text"]
        assert result["status"] == "stopped" and len(result["steps"]) == 1
        recorded, = result["steps"]
        assert recorded["command"] == "butter.macros.check-design-rules" and recorded["args"] == rule_args

        recipe = cases["run"]["args"]
        steps = recipe["macro"]["steps"]
        steps[0]["when"] = {"source": "track where width > 100 mm"}
        steps[1]["when"] = {"source": "track where width < 100 mm"}
        preview = call(client, "run", recipe, "plan")["untrusted_design_text"]
        assert preview["status"] == "ready"
        assert [step["status"] for step in preview["steps"]] == ["skipped", "ready"]
        selected = deepcopy(recipe)
        selected["selection"] = []
        selected["macro"]["selectionOnly"] = False
        selected["macro"]["steps"][0].pop("when")
        selected["macro"]["steps"][0].update(command="butter.query.search",
            args={"source":"track where width = 0.48 mm", "documentId":"pcb", "limit":200}, select=True)
        queried = call(client, "run", selected, "plan")["untrusted_design_text"]
        assert queried["status"] == "ready" and recipe["selection"][0] in queried["selection"], queried
        steps[0].pop("when")
        steps[1].update(command="butter.macros.place-power-port", args={"pin":"1"})
        steps[1].pop("when")
        failed = call(client, "run", recipe, "write")
        assert failed["changes"] == 0 and failed["applied"] == 0 and failed["stoppedAt"] == 1
        assert failed["untrusted_design_text"]["steps"][-1]["code"] == "wrong_document"
        assert workspace_files(project.parent) == before

        steps[1].update(command="butter.numericFields.set", args={
            "target":{"scope":"item", "documentId":"pcb", "itemId":recipe["selection"][0], "path":["width"]},
            "source":"invalid("
        })
        failed = call(client, "run", recipe, "write")
        assert failed["changes"] == 0 and failed["applied"] == 0 and failed["stoppedAt"] == 1, failed
        diagnostic = failed["untrusted_design_text"]["steps"][-1]
        assert diagnostic["code"] and diagnostic["status"] == "failed", failed
        invocation = {"command":"butter.macros.run", "mode":"write", "args":recipe}
        cli = subprocess.run([*server(project, *flags), "--cli", "run_command", "--args", json.dumps(invocation)],
                             check=True, capture_output=True, text=True, timeout=30)
        reply = json.loads(cli.stdout)
        assert reply["changes"] == 0 and reply["stoppedAt"] == 1, reply
        assert reply["untrusted_design_text"]["steps"][-1] == diagnostic, reply
        assert workspace_files(project.parent) == before

        steps[1].update(command="butter.macros.export", args={})
        denied = call(client, "run", recipe, "write", denied=True)
        assert denied["code"] == "invalid_arguments"
        assert workspace_files(project.parent) == before
        steps[1].update(command="butter.visualHistory.session-restore", args={})
        nested_state = call(client, "run", recipe, "write")
        assert nested_state["untrusted_design_text"]["steps"][-1]["code"] == "unsupported_surface"
        assert workspace_files(project.parent) == before

        empty = deepcopy(selected)
        empty["macro"]["selectionOnly"] = True
        empty["selection"] = recipe["selection"]
        empty["macro"]["steps"][0]["args"]["source"] = "track where width > 100 mm"
        empty["macro"]["steps"][1].update(command="butter.macros.check-design-rules", args=rule_args)
        atomic = call(client, "run", empty, "plan")["untrusted_design_text"]
        assert atomic["status"] == "ready" and atomic["selection"] == []
        first = call(client, "run-step", {**empty, "index":0}, "plan")["untrusted_design_text"]
        second = call(client, "run-step", {**empty, "index":1, "selection":first["selection"]}, "plan")["untrusted_design_text"]
        assert second["status"] == "ready" and second["selection"] == atomic["selection"]
        assert workspace_files(project.parent) == before

        invalid = deepcopy(cases["save"]["args"])
        del invalid["macro"]["alias"]
        assert call(client, "save", invalid, "write", denied=True)["code"] == "invalid_arguments"

        call(client, "record-start", {}, "write")
        write = cases["set-track-width"]["args"]
        assert call(client, "set-track-width", write, "write")["changes"] == 1
        recorded, = call(client, "record-stop", {}, "write")["untrusted_design_text"]["steps"]
        assert recorded["command"] == "butter.macros.set-track-width" and recorded["args"] == write

        model = read_design(project)
        board = next(document for document in model["documents"] if document["kind"] == "pcb")
        track = next(item for item in board["items"] if item["id"] == write["ids"][0])
        authored = authored_files(project.parent)
        composed = deepcopy(cases["run"]["args"])
        composed["macro"]["steps"] = [
            {"id":steps[0]["id"], "command":"butter.macros.set-track-width",
             "args":{"documentId":board["id"], "width":0.4, "ids":[track["id"]]}},
            {"id":steps[1]["id"], "command":"butter.macros.set-track-width",
             "args":{"documentId":board["id"], "width":{"$parameter":"width"}, "ids":[track["id"]]}},
        ]
        composed["parameters"] = {"width":track["width"]}
        no_edit = call(client, "run", composed, "write")
        assert no_edit["untrusted_design_text"]["status"] == "ready" and no_edit["changes"] == 0, no_edit
        assert authored_files(project.parent) == authored

        composed["parameters"] = {"width":0.39}
        exact = call(client, "run", composed, "proposal")
        exact_file = Path(exact["proposal_file"])
        proposal = json.loads(exact_file.read_text())
        expected = {"op":"set", "target":"item", "document":board["id"], "id":track["id"], "path":["width"],
                    "before":track["width"], "after":0.39}
        assert exact["changes"] == 1 and proposal["ops"] == [expected], exact
        assert authored_files(project.parent) == authored
        exact_file.unlink()

        composed["macro"]["steps"].append({"id":"01952010-a000-7000-8000-000000000413",
            "command":"butter.macros.place-power-port", "args":cases["place-power-port"]["args"]})
        mixed = call(client, "run", composed, "proposal")
        assert mixed["changes"] == 2 and authored_files(project.parent) == authored, mixed
        proposal_file = Path(mixed["proposal_file"])
        proposal = json.loads(proposal_file.read_text())
        item_ops = {op["document"]:op for op in proposal["ops"]}
        assert item_ops[board["id"]] == expected
        sch = cases["place-power-port"]["args"]["documentId"]
        power = item_ops[sch]
        assert power["op"] == "add" and power["value"]["kind"] == "power", power
        inspected = client.check_tool("apply_proposal", {"file":proposal_file.name})
        approved = {"file":proposal_file.name, "mode":"write", "proposal_sha256":inspected["proposal_sha256"],
                    "source_sha256":inspected["source_sha256"]}
        client.check_tool("apply_proposal", approved)
        final = read_design(project)
        updated = next(item for document in final["documents"] for item in document["items"] if item["id"] == track["id"])
        assert updated["width"] == 0.39
        assert any(item["id"] == power["value"]["id"] for document in final["documents"] for item in document["items"])

print("PASS CLI/stdio argument parity, durable record, item composition, mixed native proposal and complete rollback on late failure")
