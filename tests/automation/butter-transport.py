"""Exercise the common Butter bridge over genuine MCP stdio and native folder writes."""
import json
import os
from pathlib import Path
import select
import subprocess
import sys
import tempfile
import unittest

import sys as _test_sys
from pathlib import Path as _TestPath
_test_sys.path.insert(0, str((_TestPath(__file__).resolve().parent / "../support").resolve()))
from native_sample import ROOT, authored_files, make_sample
from butter_commands import descriptor

FEATURE = """AtriumButter.register("probe", {
  async inspect(_, {project, sourceRevision}) {
    await Promise.resolve();
    return {x:project.documents.find(d=>d.kind==="pcb").items.find(i=>i.kind==="part").x, sourceRevision};
  },
  move({delta}, {project}) {
    const document=project.documents.find(d=>d.kind==="pcb");
    const part=document.items.find(i=>i.kind==="part");
    return {result:{x:part.x+delta}, ops:[{op:"set",target:"item",document:document.id,id:part.id,
      path:["x"],before:part.x,after:part.x+delta}]};
  },
  rename({name}, {project}) {
    return {result:{}, ops:[{op:"set",target:"project",path:["name"],before:project.name,after:name}]};
  },
  state({value}, {services, mode}) {
    const before=services.state.get("value") ?? 0;
    if (mode==="write") services.state.set("value",value);
    return {before};
  },
  artifact(_, {mode}) {
    return {result:{count:4}, file:mode==="write" && {name:"probe.bin",binary:true,data:Uint8Array.of(0,255,128,10)}};
  },
  async compose({target}, {services}) {
    const external=target==="companion";
    const result=await services.commands.plan(external?"butter.companion.inspect":"butter.probe."+target,external?{}:{delta:.5});
    return {result:result.result,ops:result.ops??[]};
  },
  forbidden(_, {project}) {project.documents[0].name="Changed";},
  desktop() {throw Error("MCP should never reach the desktop handler.");}
});"""


def write_fixture(folder):
    commands = [
        ("inspect", "read", {}),
        ("move", "edit", {"delta": {"type": "number", "minimum": -100, "maximum": 100}}),
        ("state", "state", {"value": {"type": "integer"}}),
        ("artifact", "output", {}),
        ("forbidden", "read", {}),
        ("desktop", "read", {}),
        ("compose", "edit", {"target": {"type": "string", "enum": ["move", "state", "desktop", "compose", "companion"]}}),
        ("rename", "edit", {"name": {"type": "string", "minLength": 1, "maxLength": 100}}),
    ]
    specs = [dict(id=name, title=name.title(), kind=kind, properties=props, required=list(props))
             for name, kind, props in commands]
    specs[3]["outputKind"] = "butter-probe"
    specs[5]["surfaces"] = ["editor"]
    specs[6]["invokesCommands"] = True
    editor_actions = [dict(id="open-view", title="Open view", module="AtriumProbeView")]
    (folder / "butter-probe.json").write_text(json.dumps(dict(
        feature="probe", title="Test probe", commands=specs, editorActions=editor_actions)))
    (folder / "butter-probe.js").write_text(FEATURE)
    (folder / "butter.js").symlink_to(ROOT / "app/automation/command-broker.js")
    for feature in ("companion", "spare"):
        spec = dict(id="inspect", title="Inspect", kind="read", properties={}, required=[])
        (folder / f"butter-{feature}.json").write_text(json.dumps(dict(feature=feature, title=feature, commands=[spec])))
    (folder / "butter-companion.js").write_text('AtriumButter.register("companion",{inspect:()=>({loaded:true})});')
    (folder / "butter-spare.js").write_text('throw Error("An unrelated Butter feature was loaded.");')


class Stdio:
    def __init__(self, manifest, fixtures, *options):
        # Only discover descriptors and their feature handlers under fixtures. The entire server,
        # folder writer, command broker and Node/JavaScriptCore backend are production modules.
        entry = ("from pathlib import Path; import os,runpy,butter_commands;"
                 "butter_commands.APP=Path(os.environ['WAFFLE_BUTTER_TEST_CATALOG']);"
                 "import board_runner,functools;"
                 "board_runner.BoardRunner=functools.partial(board_runner.BoardRunner,backend='node') "
                 "if os.environ.get('WAFFLE_BUTTER_TEST_NODE') else board_runner.BoardRunner;"
                 "runpy.run_module('server',run_name='__main__')")
        env = dict(os.environ, PYTHONPATH=str(ROOT / "mcp"), WAFFLE_BUTTER_TEST_CATALOG=str(fixtures))
        self.p = subprocess.Popen([sys.executable, "-B", "-c", entry, "--project", str(manifest), *options],
                                  env=env, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        self.seq = 0

    def __enter__(self):
        self.send("initialize", {"protocolVersion": "2025-11-25"})
        return self

    def __exit__(self, *_):
        self.p.stdin.close()
        try:
            self.p.wait(timeout=10)
        except subprocess.TimeoutExpired:
            self.p.kill()
            self.p.wait()
        self.p.stdout.close()
        self.p.stderr.close()

    def send(self, method, params):
        self.seq += 1
        req = dict(jsonrpc="2.0", id=self.seq, method=method, params=params)
        self.p.stdin.write((json.dumps(req) + "\n").encode())
        self.p.stdin.flush()
        if not select.select([self.p.stdout], [], [], 15)[0]:
            raise AssertionError("MCP timed out: " + method)
        line = self.p.stdout.readline()
        if not line and self.p.poll() is not None:
            raise AssertionError(self.p.stderr.read().decode(errors="replace"))
        reply = json.loads(line)
        assert reply["id"] == self.seq, reply
        return reply["result"]

    def tool(self, name, args=None, error=None):
        reply = self.send("tools/call", dict(name=name, arguments=args or {}))
        if error:
            assert reply["isError"] and reply["structuredContent"]["error"]["code"] == error, reply
            return reply["structuredContent"]["error"]
        assert not reply["isError"], reply
        return json.loads(reply["content"][0]["text"])

    def command(self, id, args=None, *, error=None, **options):
        return self.tool("run_command", dict(command="butter.probe." + id, args=args or {}, **options), error=error)


class ButterTransport(unittest.TestCase):
    def test_editor_actions_share_the_feature_namespace(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            write_fixture(root)
            path = root / "butter-probe.json"
            data = json.loads(path.read_text())
            action = data["editorActions"][0]
            self.assertEqual(descriptor(path)["editorActions"], [action])
            for other in (dict(action), dict(action, id="inspect"), dict(action, id="extra", module="")):
                with self.subTest(other=other):
                    path.write_text(json.dumps(dict(data, editorActions=[action, other])))
                    with self.assertRaisesRegex(ValueError, "Butter editor action"):
                        descriptor(path)

    def test_permissions_and_publication(self):
        with tempfile.TemporaryDirectory(prefix="waffle-butter-transport-") as folder:
            root = Path(folder).resolve()
            fixtures = root / "fixtures"
            fixtures.mkdir()
            write_fixture(fixtures)
            manifest = make_sample(root / "project")
            before = authored_files(manifest.parent)
            with Stdio(manifest, fixtures) as mcp:
                self.assertFalse(any("butter.probe." in row["command"] for row in mcp.tool("list_commands")["commands"]))
                mcp.command("inspect", error="butter_disabled")
            with Stdio(manifest, fixtures, "--enable-butter", "probe", "--enable-butter", "companion", "--enable-butter", "spare") as mcp:
                visible = [row["command"] for row in mcp.tool("list_commands")["commands"] if row["command"].startswith("butter.")]
                self.assertEqual(len(visible), 9)
                self.assertNotIn("butter.probe.open-view", visible)
                mcp.command("open-view", error="unsupported_command")
                mcp.command("desktop", error="unsupported_surface")
                mcp.command("inspect", {"unexpected": True}, error="invalid_arguments")
                mcp.command("forbidden", error="read_only")
                first = mcp.command("inspect")
                self.assertEqual(first["file_revision"], first["untrusted_design_text"]["sourceRevision"])
                self.assertEqual(mcp.command("inspect", mode="plan")["x"], first["x"])
                self.assertEqual(mcp.command("move", {"delta": .25}, mode="plan")["changes"], 1)
                self.assertEqual(mcp.command("compose", {"target": "move"}, mode="plan")["changes"], 1)
                self.assertTrue(mcp.command("compose", {"target": "companion"}, mode="plan")["loaded"])
                for denied in ("state", "desktop", "compose"):
                    mcp.command("compose", {"target": denied}, mode="plan", error="unsupported_surface")
                self.assertEqual(mcp.command("state", {"value": 2})["before"], 0)
                self.assertEqual(mcp.command("artifact")["count"], 4)
                mcp.command("move", {"delta": .25}, mode="write", error="write_not_allowed")
                mcp.command("state", {"value": 2}, mode="write", error="write_not_allowed")
                mcp.command("artifact", mode="write", error="write_not_allowed")
                self.assertEqual(mcp.command("inspect")["x"], first["x"])
                self.assertFalse(list(manifest.parent.glob("*.waffle-ai")))
            self.assertEqual(before, authored_files(manifest.parent))
            with Stdio(manifest, fixtures, "--enable-butter", "probe", "--allow-write") as mcp:
                mcp.command("move", {"delta": .25}, mode="write", source_sha256="0" * 64, error="stale_source")
                self.assertEqual(mcp.command("move", {"delta": .25})["changes"], 1)
                self.assertTrue(list(manifest.parent.glob("*.waffle-ai")))
                self.assertEqual(mcp.command("state", {"value": 17}, mode="write")["before"], 0)
                self.assertEqual(mcp.command("state", {"value": 19})["before"], 17)
                self.assertEqual(mcp.command("state", {"value": 20})["before"], 17)
                exported = mcp.command("artifact", mode="write")
                output = Path(exported["path"])
                self.assertTrue(output.is_relative_to(root))
                self.assertEqual(output.read_bytes(), bytes([0, 255, 128, 10]))
                write = mcp.command("move", {"delta": .25}, mode="write")
                self.assertEqual(write["changes"], 1)
                self.assertEqual(len(write["files"]), 1)
                read = mcp.command("inspect")
                self.assertEqual(read["x"], first["x"] + .25)
                self.assertEqual(read["file_revision"], write["file_revision"])
                renamed = mcp.command("rename", {"name": "Butter transport proof"}, mode="write")
                self.assertEqual(renamed["changes"], 1)
                self.assertEqual(list(renamed["files"]), [manifest.name])
            with Stdio(manifest, fixtures, "--enable-butter", "probe", "--read-only") as mcp:
                self.assertEqual(mcp.command("state", {"value": 99})["before"], 0)
                read = mcp.command("inspect")
                self.assertEqual(read["x"], first["x"] + .25)
                self.assertEqual(read["file_revision"], renamed["file_revision"])
                mcp.command("move", {"delta": .25}, error="read_only")


if __name__ == "__main__":
    unittest.main()
