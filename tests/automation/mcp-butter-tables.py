"""Run every Butter table command through the native-folder MCP stdio transport."""
from contextlib import ExitStack
import hashlib
import json
import os
from pathlib import Path
from runpy import run_path
import subprocess
import sys
import tempfile
import unittest

from mcp import Client
import sys as _test_sys
from pathlib import Path as _TestPath
_test_sys.path.insert(0, str((_TestPath(__file__).resolve().parent / "../support").resolve()))
from native_sample import ensure_native_host
from folder_files import FolderError, FolderFiles

ROOT = Path(__file__).resolve().parents[2]
COMMANDS = {c["id"]:c for c in json.loads((ROOT / "app/automation/descriptors/tables.json").read_text())["commands"]}
COMMAND_KINDS = {name: spec["kind"] for name, spec in COMMANDS.items()}


class TablesMCP(Client, unittest.TestCase):
    acceptance = False

    @classmethod
    def setUpClass(cls):
        ensure_native_host()

    def setUp(self):
        tmp = tempfile.TemporaryDirectory(prefix="waffle-mcp-tables-")
        self.addCleanup(tmp.cleanup)
        self.directory = Path(tmp.name).resolve()
        self.manifest = self.directory / "Tables.waffle"
        self.env = os.environ.copy()
        fixture = subprocess.check_output(["node", str(ROOT / "tests/notebook/butter-tables-commands.cjs"),
                                           "--fixture", str(self.directory)], text=True)
        info = json.loads(fixture)
        self.doc, self.part = info["documentId"], info["partId"]
        self.sheet = self.directory / info["member"]
        self.table = {"documentId":self.doc, "itemId":info["itemId"]}
        self.seen = set()
        self.coverage = {}
        if self.acceptance:
            self.shared = run_path(str(ROOT / "tests/automation/butter-acceptance.py"))
            Stdio, server = self.shared["Stdio"], self.shared["server"]
            stack = ExitStack()
            self.addCleanup(stack.close)
            self.disabled = stack.enter_context(Stdio(server(self.manifest, "--allow-write")))
            self.enabled = stack.enter_context(Stdio(server(self.manifest, "--enable-butter", "tables")))
            self.shared["verify_off"](self.disabled)
            self.shared["verify_listing"](self.enabled, self.shared["public_commands"]("tables", COMMANDS))

    def qualify_command(self, name, request, mode):
        """Exercise each real command against the state produced by the preceding edits."""
        command = request["command"]
        files = self.shared["workspace_files"]
        before = files(self.directory)

        def cli(edit_mode=None):
            call = dict(request)
            if edit_mode is not None:
                call["mode"] = edit_mode
            server = self.shared["server"](self.manifest, "--enable-butter", "tables")
            result = subprocess.run([*server,"--cli","run_command","--args",json.dumps(call)], check=True,
                                    cwd=ROOT,env=self.env,text=True,capture_output=True,timeout=25)
            receipt = json.loads(result.stdout)
            self.assertEqual(receipt["command"], command)
            return receipt

        self.shared["verify_disabled"](self.disabled, request)
        if COMMAND_KINDS[name]=="read":
            self.assertEqual(self.enabled.check_tool("run_command",request),cli())
            self.assertEqual(files(self.directory),before)
            self.coverage[name] = ["off","cliRead","read"]
        else:
            self.assertEqual(mode,"write")
            plan = self.enabled.check_tool("run_command",{**request,"mode":"plan"})
            self.assertEqual(plan["mode"],"plan")
            self.assertEqual(cli("plan")["changes"],plan["changes"])
            self.shared["verify_denial"](self.enabled,{**request,"mode":"write"},"write_not_allowed")
            self.assertEqual(files(self.directory),before)
            proposal = self.tool("run_command",{**request,"mode":"proposal"},timeout=25)
            self.assertGreater(proposal["changes"],0,proposal)
            drafted = Path(proposal["proposal_file"]).resolve()
            self.assertEqual(drafted.parent,self.directory)
            self.assertEqual(drafted.suffix,".waffle-ai")
            payload = drafted.read_bytes()
            self.assertEqual(hashlib.sha256(payload).hexdigest(),proposal["sha256"])
            self.assertEqual(json.loads(payload)["version"],2)
            self.assertEqual(files(self.directory), {**before, drafted.name:proposal["sha256"]})
            self.coverage[name] = ["off","plan","cliPlan","denied","proposal","write"]

    def test_native_feature_declaration_and_exact_undo(self):
        fixture = json.loads(subprocess.check_output(["node", str(ROOT / "tests/notebook/butter-tables-commands.cjs"),
                                                      "--storage-fixture", str(self.directory)], text=True))
        paths = (fixture["member"], "Tables.waffle")
        states = {step: {path:(self.directory / step / path).read_bytes() for path in paths}
                  for step in ("baseline","upgrade","edit","undo")}
        self.assertEqual(states["baseline"], states["undo"])
        root = self.directory / "baseline"
        project = FolderFiles(root / paths[1])
        self.addCleanup(project.close)

        def stage(before, after, selection=paths):
            return [{"path":path,"expected":hashlib.sha256(before[path]).hexdigest(),
                     "text":after[path].decode()} for path in selection]

        def commit(rows):
            receipt = project.commit(fixture["projectId"], rows, {})
            self.assertTrue(receipt["saved"])
            project.recover()

        def refuses(rows, expected):
            with self.assertRaises(FolderError):
                commit(rows)
            self.assertFalse((root / ".waffle/journal/active").exists())
            self.assertEqual({path:(root / path).read_bytes() for path in paths}, expected)

        start, upgrade = states["baseline"], states["upgrade"]
        refuses(stage(start,upgrade,paths[:1]), start)
        refuses(stage(start,upgrade,paths[1:]), start)
        for changed in (b'"formatVersion":"2.2"', b'"formatVersion":"2.1","compatibleWith":"2.0"'):
            unsupported = {**upgrade, paths[0]:upgrade[paths[0]].replace(b'"formatVersion":"2.1"',changed,1)}
            refuses(stage(start,unsupported), start)
        commit(stage(start,upgrade))
        refuses(stage(upgrade,start,paths[:1]), upgrade)
        refuses(stage(upgrade,start,paths[1:]), upgrade)
        edit = states["edit"]
        commit(stage(upgrade,edit,paths[:1]))
        self.assertEqual({path:(root / path).read_bytes() for path in paths}, edit)
        commit(stage(edit,states["undo"]))
        self.assertEqual({path:(root / path).read_bytes() for path in paths}, start)

    def start(self, enabled=True, writable=True, query=False, macros=False):
        cfg = ["--enable-butter", "tables"] if enabled else []
        if query:
            cfg.extend(["--enable-butter", "query"])
        if macros:
            cfg.extend(["--enable-butter", "macros"])
        if writable:
            cfg.append("--allow-write")
        self.proc = subprocess.Popen([sys.executable, "-B", str(ROOT / "mcp/server.py"),
                                      "--project", str(self.manifest), *cfg], env=self.env,
                                     stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                                     text=True, bufsize=1)
        self.seq = 0
        self.addCleanup(self.stop_server)
        self.initialize()

    def command(self, name, arguments, mode=None, error=False):
        self.seen.add(name)
        args = {"command":"butter.tables." + name, "args":arguments}
        if mode:
            args["mode"] = mode
        if self.acceptance and not error and name not in self.coverage and mode not in ("plan","proposal"):
            self.qualify_command(name,args,mode)
        response = self.tool("run_command", args, error, timeout=25)
        if isinstance(response, dict):
            return {**response, **response.get("untrusted_design_text", {})}
        return response

    @unittest.skipUnless((ROOT / "app/checks/query-service.js").is_file(),"Build with the shared saved query service.")
    def test_existing_saved_query_and_full_table_share_the_native_project(self):
        self.start(query=True)

        def save_query(**values):
            response = self.tool("run_command", {"command":"butter.query.save-query","mode":"write","args":values}, timeout=25)
            return response["untrusted_design_text"]["record"]

        def query_line():
            return next(raw for raw in self.manifest.read_bytes().splitlines() if json.loads(raw)["kind"]=="savedQuery")

        saved = save_query(name="Resistors", source='part where designator like "R*"', scope={"documentId":self.doc})
        query_id = saved["id"]
        first_query = query_line()
        self.assertEqual(json.loads(self.manifest.read_bytes().splitlines()[0])["formatVersion"],"2.1")
        self.command("upgrade",self.table,"write")
        self.assertEqual(query_line(),first_query)
        table = self.command("describe",self.table)
        column = table["columns"][0]["id"]
        args = {**self.table,"queryDocumentId":self.doc,"savedQueryId":query_id,
                "fields":[{"field":"designator","columnId":column}]}
        self.assertEqual(self.command("bind-query",args,"write")["count"],1)
        state = self.command("describe",self.table)
        row = next(r for r in state["rows"] if r.get("object"))
        self.assertEqual(row["object"]["itemId"],self.part)
        self.assertEqual(state["query"]["scope"],{"savedQueryId":query_id})
        self.assertEqual(query_line(),first_query)
        save_query(id=query_id,source='part where designator like "U*"')
        self.assertNotEqual(query_line(),first_query)
        self.assertEqual(self.command("refresh-query",self.table,"write")["removed"],1)
        renamed = self.command("describe",self.table)
        self.assertTrue(next(r for r in renamed["rows"] if r["id"]==row["id"])["removed"])
        self.command("clear-removed",self.table,"write")
        self.assertNotIn(row["id"],{r["id"] for r in self.command("describe",self.table)["rows"]})

    def test_configure_preserves_guarded_operation_identity(self):
        self.start(macros=True)
        self.command("upgrade", self.table, "write")
        before = (self.manifest.read_bytes(), self.sheet.read_bytes())
        args = {**self.table, "headerRows":1, "banded":True}
        plan = self.command("configure", args, "plan")
        stdio = self.command("configure", args, "proposal")
        request = {"command":"butter.tables.configure", "args":args, "mode":"proposal"}
        raw = subprocess.check_output([sys.executable, "-B", str(ROOT / "mcp/server.py"), "--project",
                                       str(self.manifest), "--enable-butter", "tables", "--cli", "run_command",
                                       "--args", json.dumps(request)], text=True, timeout=25)
        cli = json.loads(raw)
        self.assertEqual([result["changes"] for result in (plan, stdio, cli)], [1, 1, 1])
        stdio_file = Path(stdio["proposal_file"])
        from_stdio, from_cli = (json.loads(Path(result["proposal_file"]).read_bytes()) for result in (stdio, cli))
        self.assertEqual(from_stdio["ops"], from_cli["ops"])
        operation, = from_stdio["ops"]
        self.assertEqual((operation["target"], operation["id"], operation["path"]),
                         ("item", self.table["itemId"], ["widget", "state"]))
        self.assertEqual((operation["before"]["headerRows"], operation["after"]["headerRows"]), (0, 1))
        self.assertIs(operation["before"]["banded"], False)
        self.assertIs(operation["after"]["banded"], True)
        self.assertEqual((self.manifest.read_bytes(), self.sheet.read_bytes()), before)

        written = self.command("configure", args, "write")
        self.assertEqual(set(written["files"]), {self.sheet.name})
        self.assertEqual(self.manifest.read_bytes(), before[0])
        self.assertNotEqual(self.sheet.read_bytes(), before[1])
        refused = self.tool("apply_proposal", {"file":stdio_file.name,
                            "proposal_sha256":stdio["sha256"], "source_sha256":stdio["source_sha256"],
                            "mode":"write"}, error=True)
        self.assertIn("changed", refused)

        current = self.command("describe", self.table)
        target = {**self.table, "rowId":current["rows"][0]["id"], "columnId":current["columns"][0]["id"]}
        step = {"id":"01952010-a000-7000-8000-000000000511", "command":"butter.tables.import"}
        recipe = {"format":"waffle-macro", "version":1, "id":"01952010-a000-7000-8000-000000000510",
                  "name":"Import table cells", "alias":"import-table-cells", "steps":[step]}
        for format, data in (("csv", "value"), ("html", "<table><tr><td>value</td></tr></table>")):
            step["args"] = {**target, "format":format, "data":data}
            replay = self.tool("run_command", {"command":"butter.macros.run", "args":{"macro":recipe}, "mode":"plan"})
            status = replay["untrusted_design_text"]
            if format == "csv":
                self.assertEqual((status["status"], replay["changes"]), ("ready", 1))
            else:
                self.assertEqual((status["status"], replay["changes"]), ("failed", 0))
                self.assertEqual(status["steps"][-1]["code"], "unsupported_surface")

    def test_all_through_an_actual_native_folder(self):
        self.start(enabled=False)
        self.assertNotIn("butter.tables.", json.dumps(self.tool("list_commands")))
        self.assertIn("disabled", self.command("list", {"documentId":self.doc}, error=True))
        self.stop_server()

        self.start(writable=False)
        self.assertIn("butter.tables.", json.dumps(self.tool("list_commands")))
        self.assertIn("allow-write", self.command("upgrade", self.table, "write", True))
        self.stop_server()

        self.start()
        manifest, sheet = self.manifest.read_bytes(), self.sheet.read_bytes()
        self.assertFalse(self.command("list", {"documentId":self.doc})["tables"][0]["full"])
        planned = self.command("upgrade", self.table, "plan")
        self.assertEqual(planned["changes"], 1)
        self.assertEqual(self.manifest.read_bytes(), manifest)
        self.assertEqual(self.sheet.read_bytes(), sheet)
        self.command("upgrade", self.table, "proposal")
        self.assertEqual(self.manifest.read_bytes(), manifest)
        self.assertEqual(self.sheet.read_bytes(), sheet)
        self.command("upgrade", self.table, "write")
        for file in (self.manifest,self.sheet):
            header = json.loads(file.read_bytes().splitlines()[0])
            self.assertEqual(header["formatVersion"], "2.1")
            self.assertEqual(header["requires"], ["notebook.table.v1"])
            self.assertNotIn("compatibleWith", header)

        item_id = self.command("create", {"documentId":self.doc,"x":5,"y":6,"rows":2,"columns":3}, "write")["itemId"]
        target = {"documentId":self.doc,"itemId":item_id}
        state = self.command("describe", target)
        r1,r2 = (r["id"] for r in state["rows"])
        a,b,c = (col["id"] for col in state["columns"])
        def at(row_id,column_id):
            return {"rowId":row_id,"columnId":column_id}
        def cell(row_id,column_id,kind,**values):
            return {**at(row_id,column_id),"content":{"kind":kind,**values}}
        self.command("edit-cells", {**target,"cells":[cell(r1,a,"literal",text="2"),cell(r1,b,"literal",text="3"),
            cell(r2,a,"literal",text="4"),cell(r2,b,"literal",text="5"),cell(r1,c,"formula",source="=A1*B1")]}, "write")
        self.command("fill", {**target,**at(r1,c),"endRowId":r2}, "write")
        result = self.command("evaluate", {**target,**at(r1,c),"endRowId":r2})
        self.assertEqual([row["value"]["value"] for row in result["cells"]], [6,20])
        before, old_manifest = self.sheet.read_bytes().splitlines(), self.manifest.read_bytes()
        self.command("edit-cells", {**target,"cells":[cell(r1,a,"literal",text="8")]}, "write")
        after = self.sheet.read_bytes().splitlines()
        self.assertEqual(len(before),len(after))
        changes = [json.loads(b) for a,b in zip(before,after) if a != b]
        self.assertEqual(len(changes),1)
        self.assertEqual(changes[0]["kind"],"tableCell")
        self.assertEqual(self.manifest.read_bytes(),old_manifest)
        self.assertEqual(self.command("evaluate", {**target,**at(r1,c)})["cells"][0]["value"]["value"],24)

        self.command("edit-axis", {**target,"axis":"columns","axisId":a,"action":"configure",
                                   "attributes":{"widthNm":9500000,"filter":"","sortDirection":"desc"}}, "write")
        self.command("configure", {**target,"headerRows":1,"banded":True}, "write")
        self.command("merge", {**target,**at(r1,a),"endColumnId":b,"action":"merge"}, "write")
        self.command("merge", {**target,**at(r1,a),"action":"split"}, "write")
        data = ('<style>th.xl53{background-color:#eab402;vertical-align:middle;white-space:normal}</style>'
                '<table><tr><th class="xl53" colspan="2">Label</th><td data-formula="=1+2">3</td></tr>'
                '<tr><td>A&amp;B<br>next</td><td>Value</td><td>9</td></tr></table>')
        self.command("import", {**target,**at(r1,a),"format":"html","data":data}, "write")
        state = self.command("describe", target)
        imported = {row["columnId"]:row for row in state["cells"] if row["rowId"]==r1}
        self.assertEqual(imported[a]["style"]["fill"],"#eab402")
        self.assertEqual(imported[c]["content"],{"kind":"literal","text":"3"})
        self.assertIn("A&amp;B<br>next",self.command("export",{**target,"format":"html"})["data"])
        self.assertIn('"A&B\nnext"',self.command("export",{**target,"format":"csv"})["data"])
        self.assertIn('"A&B\nnext"',self.command("export",{**target,"format":"tsv"})["data"])
        self.assertGreater(self.command("compare",{**target,"otherDocumentId":self.doc,"otherItemId":self.table["itemId"]})["total"],0)

        query = {"queryDocumentId":self.doc,"source":'part where designator like "R*"',
                 "fields":[{"field":"designator","columnId":c}]}
        self.assertEqual(self.command("bind-query",{**target,**query},"write")["count"],1)
        # Change the source through the native transaction API so refresh sees a real removed row.
        saved = self.sheet.read_bytes()
        replacement = saved.replace(b'"ref":"R5"',b'"ref":"U5"',1)
        self.assertNotEqual(replacement,saved)
        project = FolderFiles(self.manifest)
        try:
            project_id = json.loads(self.manifest.read_bytes().splitlines()[0])["id"]
            changed = [{"path":self.sheet.name,"expected":hashlib.sha256(saved).hexdigest(),"text":replacement.decode()}]
            self.assertTrue(project.commit(project_id,changed,{})["saved"])
            project.recover()
        finally:
            project.close()
        self.assertEqual(self.command("refresh-query",target,"write")["removed"],1)
        self.command("clear-removed",target,"write")
        self.command("unbind-query",target,"write")
        self.assertIsNone(self.command("describe",target)["query"])
        self.assertEqual(self.seen,set(COMMAND_KINDS))


if __name__ == "__main__":
    unittest.main()
