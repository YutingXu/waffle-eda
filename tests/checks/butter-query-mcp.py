#!/usr/bin/env python3
"""Real guarded MCP command writes from a 2.0 design and command-result states."""
import json
from math import isclose
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
from unittest import TestCase

import sys as _test_sys
from pathlib import Path as _TestPath
_test_sys.path.insert(0, str((_TestPath(__file__).resolve().parent / "../support").resolve()))
from native_sample import authored_files, ensure_native_host, evaluate, read_design, write_design
import sys as _test_sys
from pathlib import Path as _TestPath
_test_sys.path.insert(0, str((_TestPath(__file__).resolve().parent / "../automation").resolve()))
from mcp import Client


HERE = Path(__file__).resolve().parents[1]
SERVER = HERE.parent / "mcp/server.py"
FIXTURE = HERE / "fixtures/design-query/query-proof"


def server(path):
    return [sys.executable, "-B", str(SERVER), "--project", str(path), "--enable-butter", "query", "--allow-write"]


def unwrap(result):
    return {**result, **result.get("untrusted_design_text", {})}


def command(path, name, args=None, **call):
    options = server(path) + ["--cli", "run_command", "--args",
                             json.dumps(dict(command="butter.query." + name, args=args or {}, **call))]
    completed = subprocess.run(options, check=True, capture_output=True, text=True, timeout=20)
    return unwrap(json.loads(completed.stdout))


class QuerySession(Client, TestCase):
    def __init__(self, path):
        super().__init__()
        self.path = path

    def __enter__(self):
        self.proc = subprocess.Popen(server(self.path), stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                                     stderr=subprocess.PIPE, text=True)
        self.seq = 0
        try:
            self.initialize()
        except BaseException:
            self.stop_server()
            raise
        return self

    def __exit__(self, *_):
        self.stop_server()

    def command(self, name, args):
        return unwrap(self.tool("run_command", dict(command="butter.query." + name, args=args), timeout=20))


def native_parity(path, target):
    project = read_design(path)
    docs = {doc["id"]: doc for doc in project["documents"]}
    analog, monitor = docs["analog"], docs["monitor"]
    monitor["items"].append(dict(id="repeat", kind="sheetsymbol", sheet="power", name="Repeat(CH,1,2)",
                                 x=10, y=10, w=20, h=10, entries=[]))
    project["parameters"] = {"Pitch": {"value": 12, "unit": "mil"}}
    analog["stackup"] = json.loads(evaluate("""JSON.stringify((() => {
      const S=AtriumStackup, stack=S.preset("4");
      const copper=stack.layers.map((l,i)=>S.isCopper(l)?i:null).filter(i=>i!=null);
      const prepreg=stack.layers.slice(copper[0]+1,copper[1]);
      for (const l of prepreg) l.thickness=.05/prepreg.length;
      return stack;
    })())"""))
    analog["items"] += [
        dict(id="z-a", kind="track", net="Z1", layer="Top", width=.2, points=[[21,10],[29,10]]),
        dict(id="z-b", kind="track", net="Z2", layer="Inner 1", width=.2, points=[[25,8],[25,12]]),
        dict(id="via-a", kind="via", x=50, y=45, diameter=.4, drill=.2, net="Via1"),
        dict(id="via-b", kind="via", x=50, y=45.3, diameter=.4, drill=.2, net="Via2"),
    ]
    rules = project["rules"]["list"]
    scoped = next(r for r in rules if r["id"] == "low-ohms")
    low_id, fallback_id, z_id, holes_id = (f"01960000-0000-7000-8000-00000000000{i}" for i in range(1,5))
    scoped["id"] = low_id
    scoped["priority"] = 2
    rules += [
        dict(id=fallback_id, type=scoped["type"], name="All disconnects", enabled=True, priority=1, where="schematic",
             severity="warning", scope=dict(languageVersion=1, source="object")),
        dict(id=z_id, type="zClearance", name="Z gap", enabled=True, priority=1, gap=.1, adjacentOnly=True,
             scope=dict(languageVersion=1, source="track")),
        dict(id=holes_id, type="holeToHole", name="Hole gap", enabled=True, priority=1, gap=.2,
             scope=dict(languageVersion=1, source="via")),
    ]
    write_design(target, project)
    original = authored_files(target.parent)
    with QuerySession(target) as mcp:
        for rule_id, kind, pair in [(z_id, "zClearance", {"z-a", "z-b"}), (holes_id, "holeToHole", {"via-a", "via-b"})]:
            args = dict(id=rule_id, documentId="analog")
            cold = command(target, "rule-applicability", args)
            first = mcp.command("rule-applicability", args)
            assert cold == first and cold["complete"], (cold, first)
            full = mcp.tool("run_drc", dict(document_id="analog", rules=[kind]), timeout=20)
            warm = mcp.command("rule-applicability", args)
            assert warm == cold, (warm, cold)
            assert pair in [{row["id"] for row in peers} for peers in cold["pairs"]["rows"]], cold
            full = [item for item in full["items"] if item["rule_id"] == rule_id]
            assert len(cold["violations"]) == len(full) > 0, (cold, full)
            for found, expected in zip(cold["violations"], full):
                assert (found["id"], found["otherId"], found["type"]) == (expected["id"], expected["other_id"], expected["type"])
                assert isclose(found["actual"], expected["actual"], abs_tol=1e-6)
                assert isclose(found["required"], expected["required"], abs_tol=1e-6)

        erc = dict(id=low_id, documentId="power")
        cold = command(target, "rule-applicability", erc)
        first = mcp.command("rule-applicability", erc)
        full = mcp.tool("run_erc", dict(checks=["unconnectedPins"]), timeout=20)["classes"]
        assert any(i["check"] == "unconnectedPins" for i in full["Warning"]["items"]), full
        assert cold == first == mcp.command("rule-applicability", erc), (cold, first)
        assert [i["id"] for i in cold["violations"]] == [i["object_id"] for i in full["Fatal"]["items"] if i["document_id"] == "power"]
        assert len(cold["violations"]) == 2 and all(i["severity"] == "Fatal" for i in cold["violations"]), cold

        base = dict(documentId="power", fields=["designator", "value", "Pitch"])
        for number in (1, 2):
            instance_id = f"monitor/repeat#{number - 1}"
            args = dict(base, instanceId=instance_id, source=f'part where designator = "R1_CH{number}"')
            cold = command(target, "search", args)
            first = mcp.command("search", args)
            warm = mcp.command("search", args)
            assert cold["rows"] == first["rows"] == warm["rows"] and cold["count"] == warm["count"] == 1, (cold, first, warm)
            item = cold["rows"][0]
            assert item["instanceId"] == instance_id and item["fields"]["designator"] == f"R1_CH{number}", item
            assert item["fields"]["value"]["unit"] == "Ω" and item["fields"]["value"]["magnitude"] == 470, item
            assert item["fields"]["Pitch"]["unit"] == "mil" and isclose(item["fields"]["Pitch"]["magnitude"], 12), item
        cap = mcp.command("search", dict(base, source='part where designator = "C1_CH1"', instanceId="monitor/repeat#0"))
        value = cap["rows"][0]["fields"]["value"]
        assert value["unit"] == "F" and isclose(value["magnitude"], 470e-9), cap
    assert authored_files(target.parent) == original


def main():
    ensure_native_host()
    with tempfile.TemporaryDirectory(prefix="waffle-query-first-save-") as temporary:
        folder = Path(temporary)
        shutil.copytree(FIXTURE, folder, dirs_exist_ok=True)
        original = authored_files(folder)
        manifest = "Query proof.waffle"
        path = folder / manifest

        def invoke(name, args=None, **call):
            return command(path, name, args, **call)

        assert json.loads(path.read_bytes().splitlines()[0])["formatVersion"] == "2.0"
        proof = json.loads((FIXTURE.parent / "butter-search.json").read_text())
        spec, ordered = proof["args"], proof["orderedIds"]
        expression = spec["source"]
        first = invoke("search", spec)
        assert first["rows"][0]["id"] == ordered[0] and first["count"] == len(ordered), first
        width = first["rows"][0]["fields"]["width"]
        assert width["value"] == .0002 and width["magnitude"] == .2 and width["unit"] == "mm", width
        assert first["snapshotId"] == first["file_revision"], first
        page = invoke("search", dict(spec, cursor=first["cursor"]))
        assert page["rows"][0]["id"] == ordered[1] and page["count"] == len(ordered), page
        empty = invoke("count", dict(source="via", documentId="analog"))
        assert empty["complete"] and empty["count"] == 0, empty
        invalid = invoke("plan", dict(source="track where width < 1 V", documentId="analog"))
        assert invalid["status"] == "error" and invalid["diagnostic"]["code"] == "dimension", invalid
        partial = invoke("search", dict(source="track where width < rule(MinWidth)", documentId="analog"))
        assert partial["status"] == "partial" and partial["lowerBound"] == 2 and "count" not in partial, partial
        erc = invoke("rule-applicability", dict(id="low-ohms", documentId="power"))
        assert erc["domain"] == "erc" and erc["winners"]["rows"][0]["id"] == "r-small", erc
        paired = invoke("rule-applicability", dict(id="two-nets", documentId="analog"))
        assert paired["domain"] == "drc" and paired["pairs"]["count"] == 1, paired
        assert authored_files(folder) == original
        saved = invoke("save-query", {"source": expression, "name": "Thin Rails",
                        "scope": {"documentId": "analog"}, "columns": ["width"]}, mode="write")
        assert saved["changes"] == 1, saved
        stored = authored_files(folder)
        assert {name for name in original if original[name] != stored[name]} == {manifest}
        assert json.loads(stored[manifest].splitlines()[0])["formatVersion"] == "2.1"
        authored = json.loads(next(line for line in stored[manifest].splitlines() if b'"kind":"savedQuery"' in line))
        identity = authored["id"]
        assert invoke("get-saved", {"id": identity})["record"]["id"] == identity
        assert invoke("search", dict(spec, fields=["width"], cursor=first["cursor"]))["status"] == "stale"
        assert invoke("search", {"savedQueryId": identity})["count"] == 2
        conflict = invoke("search", {"savedQueryId": identity, "documentId": "power"})
        assert conflict["status"] == "error" and conflict["diagnostic"]["code"] == "scope", conflict
        removed = invoke("delete-saved", {"id": identity}, mode="write")
        assert removed["changes"] == 1, removed
        assert invoke("list-saved")["count"] == 0
        after = authored_files(folder)
        # Deleting the last optional row retains the published header version.
        assert after[manifest].replace(b'"2.1"', b'"2.0"', 1) == original[manifest]
        assert {name: body for name, body in after.items() if name != manifest} == {
            name: body for name, body in original.items() if name != manifest
        }
        native_parity(path, folder / "parity" / "Query parity.waffle")
    print("Butter query MCP first use, save/delete, qualified quantities and occurrences, and cold/warm/full checker parity passed")


if __name__ == "__main__":
    main()
