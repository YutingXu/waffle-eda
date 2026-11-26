"""Test the shared offline geometry runner in its source and packaged layouts."""
import json
from pathlib import Path
import os
import shutil
import subprocess
import sys
import tempfile
import time
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0,str(ROOT / "mcp"))
sys.dont_write_bytecode = True
from board_runner import BoardRunner, ToolLimit, jsc_cli_path, load_jsc, resolve
from server import Server
import sys as _test_sys
from pathlib import Path as _TestPath
_test_sys.path.insert(0, str((_TestPath(__file__).resolve().parent / "../support").resolve()))
from native_sample import authored_files, ensure_native_host, make_sample, read_design, write_design


class BoardRunnerTests(unittest.TestCase):
    def setUp(self):
        self.doc = {"id":"pcb", "kind":"pcb", "name":"Board", "grid":0.25,"outline":[],"notes":[],
                    "items":[{"id":"a","kind":"pad","number":"1","shape":"rect","w":1,"h":2,"x":0,"y":0,"angle":37,"net":"USB+"},
                             {"id":"b","kind":"pad","number":"2","shape":"round","w":1,"h":1,"x":4,"y":0,"net":"USB+"},
                             {"id":"t","kind":"track","layer":"Top","width":0.08,"points":[[0,0],[0,2]],"net":"USB-"}]}
        self.doc["sourceRules"]=["RULEKIND=Clearance|NAME=Separation|ENABLED=TRUE|SCOPE1EXPRESSION=All|SCOPE2EXPRESSION=All|NETSCOPE=DifferentNets|LAYERKIND=SameLayer|GAP=6mil|PRIORITY=1"]
        self.tools = ("board_connectivity","check_board_rules","list_source_rules")

    @unittest.skipUnless(load_jsc(), "JavaScriptCore is required")
    def test_output_job_worker_loads_only_selected_translators(self):
        with tempfile.TemporaryDirectory() as temp:
            path = make_sample(temp)
            before = authored_files(temp)
            cases = [
                (False, [{"kind": "gerber", "options": {"profileOnly": True}}, {"kind": "ipc2581"},
                         {"kind": "step", "options": {"format": "glb"}}, {"kind": "kicad", "enabled": False},
                         {"kind": "odb"}, {"kind": "bom"}, {"kind": "pdf"}, {"kind": "readme"}],
                 ["fabrication", "ipc2581", "glb"], {".GM1", ".xml", ".glb", ".csv", ".pdf"}),
                (True, [{"kind": "odb"}, {"kind": "pnp"}, {"kind": "assembly"}, {"kind": "kicad"},
                        {"kind": "step", "options": {"format": "step"}}],
                 ["odb", "fabrication", "kicad", "step"], {".tgz", ".csv", ".svg", ".kicad_pcb", ".step"}),
                (False, [{"kind": "bom"}, {"kind": "readme"}], [], {".csv", ".txt"}),
            ]
            for index, (odb_enabled, outputs, ids, suffixes) in enumerate(cases):
                with self.subTest(translators=ids):
                    server = Server(path, allow_write=True, butter_enabled=("odb",) if odb_enabled else ())
                    runner = server.board_runner = BoardRunner("jsc")
                    try:
                        request = {"definition": {"name": "Loader", "folder": "", "outputs": outputs},
                                   "date": "2026-01-02T03:04:05Z"}
                        headless = runner.headless

                        def legacy_plan(op, *args, **kwargs):
                            result, payload = headless(op, *args, **kwargs)
                            if op == "notebook_output_modules":
                                result.pop("translators", None)
                            return result, payload

                        with patch.object(runner, "_translate", wraps=runner._translate) as translate, \
                             patch.object(runner, "translated_job", wraps=runner.translated_job) as worker:
                            scoped = server.call("run_output_job", dict(request, output_dir=f"scoped-{index}"))
                            self.assertEqual(worker.call_args.kwargs["translator_ids"], ids)
                            scoped_modules = {name for name, _ in resolve(translate.call_args.args[1])}
                            with patch.object(runner, "headless", side_effect=legacy_plan):
                                broad = server.call("run_output_job", dict(request, output_dir=f"broad-{index}"))
                            self.assertIsNone(worker.call_args.kwargs["translator_ids"])
                            broad_modules = {name for name, _ in resolve(translate.call_args.args[1])}
                        self.assertTrue(scoped["ok"], scoped["report"])
                        self.assertTrue(broad["ok"], broad["report"])
                        self.assertTrue(scoped_modules < broad_modules)
                        self.assertNotIn("export-eagle", scoped_modules)
                        self.assertEqual("odb" in scoped_modules, odb_enabled)
                        self.assertTrue(suffixes <= {Path(row["name"]).suffix for row in scoped["files"]})
                        self.assertEqual({row["name"]: Path(row["path"]).read_bytes() for row in scoped["files"]},
                                         {row["name"]: Path(row["path"]).read_bytes() for row in broad["files"]})
                        self.assertEqual([(row["status"], row["warnings"]) for row in scoped["report"]["outputs"]],
                                         [(row["status"], row["warnings"]) for row in broad["report"]["outputs"]])
                        if index == 0:
                            self.assertEqual(next(row for row in scoped["report"]["outputs"] if row["kind"] == "odb")["status"], "skipped")
                    finally:
                        server.close()
            self.assertEqual(authored_files(temp), before)

    @unittest.skipUnless(load_jsc(), "JavaScriptCore is required")
    def test_in_process_performance_ignores_wall_clock_changes(self):
        for native_clock in (True, False):
            with self.subTest(native_clock=native_clock):
                runner = BoardRunner("jsc")
                try:
                    context = runner.jsc
                    context.ensure(("headless",))
                    context.evaluate("globalThis.wallTime = 10000; Date.now = () => wallTime;")
                    # Advance the real JSC host clock's input deterministically; leave the JS wall
                    # clock independent. If the C API cannot bind a clock, only counts are valid.
                    tick = 100_000_000
                    symbol = getattr(context.lib, "JSObjectMakeFunctionWithCallback", None) if native_clock else None
                    with patch.object(context.lib, "JSObjectMakeFunctionWithCallback", symbol, create=True), \
                         patch("board_runner.time.monotonic_ns", side_effect=lambda: tick):
                        runner.performance_control("start")
                        runner.performance_control("begin")
                        context.evaluate("wallTime += 5000;")
                        tick += 12_000_000
                        runner.performance_control("end", "completed")
                        source_time = context.value_text(context.evaluate("String(performance.now())"))
                        self.assertEqual(source_time, "15000")
                        row, = runner.performance_control("snapshot", projection="exact")["rows"]
                        self.assertEqual(row["counts"]["completed"], 1)
                        self.assertEqual(row["runP95"], 12 if symbol else None)
                        self.assertEqual(row["endToEndP95"], 12 if symbol else None)
                        runner.performance_control("begin")
                        context.evaluate("wallTime -= 9000;")
                        tick += 20_000_000
                        runner.performance_control("end", "completed")
                        row, = runner.performance_control("snapshot", projection="exact")["rows"]
                        self.assertEqual(row["counts"]["completed"], 2)
                        self.assertEqual(row["runP95"], 20 if symbol else None)
                        row, = runner.performance_control("stop")["rows"]
                        self.assertEqual(row["counts"]["completed"], "1-to-4")
                        self.assertEqual(row["runP95"], "16-to-33ms" if symbol else "not-measured")
                finally:
                    runner.close()

    def test_javascriptcore_and_node_report_identically(self):
        if not load_jsc() or not shutil.which("node"):
            self.skipTest("both JS runtimes are required for parity comparison")
        engines = [BoardRunner("jsc"), BoardRunner("node")]
        for runner in engines:self.addCleanup(runner.close)
        for tool in self.tools:
            a,b=[r.report(tool,self.doc,[]) for r in engines]
            self.assertEqual(a,b)
        project = {"name":"Test","format":"atrium","version":1,"library":[],"documents":[self.doc]}
        base = json.dumps(project)
        self.doc["items"][-1]["width"] = 0.125
        fields = {"section":"changes", "offset":0, "limit":1}
        for runner in engines:
            runner.load_comparison(base, json.dumps(project).encode())
        a,b = [r.revision_page(fields) for r in engines]
        self.assertEqual(a, b)
        self.assertEqual(a["items"][0]["locate_id"], "t")
        fields.update(section="fields", key=a["items"][0]["key"])
        a,b = [r.revision_page(fields) for r in engines]
        self.assertEqual(a, b)
        self.assertEqual(a["items"], [{"label":"Width", "before":"0.08 mm", "after":"0.125 mm"}])
        self.doc["outline"] = [[i,0] for i in range(999)]
        base = json.dumps(project)
        self.doc["outline"] = [[i,2] for i in range(999)]
        for runner in engines:
            runner.load_comparison(base, json.dumps(project).encode("utf-16"))
            key = runner.revision_page({"section":"changes","offset":0,"limit":1})["items"][0]["key"]
            for offset in [0,50,100,993,30,50,1500]:
                result = runner.revision_page({"section":"fields","key":key,"offset":offset,"limit":50})
                self.assertEqual(result["total"],999)
                self.assertEqual(result["items"], [{"label":"Outline · Vertex "+str(i+1), "before":f"({i}, 0) mm",
                    "after":f"({i}, 2) mm"} for i in range(offset, min(offset+50,999))])
            runner.clear_comparison()
            self.assertFalse(runner.has_comparison())
            self.assertRaisesRegex(ValueError,"Reload", runner.revision_page, fields)
        self.assertEqual(engines[0].report("board_connectivity",self.doc,[])["shorts"][0]["nets"],["USB+","USB-"])
        self.assertRaises(ValueError,engines[0].report,"unknown",self.doc,[])

    def test_first_nearby_query_uses_real_copper_on_both_runtimes(self):
        backends = []
        if load_jsc():
            backends.append("jsc")
        if jsc_cli_path():
            backends.append("jsc-cli")
        if shutil.which("node"):
            backends.append("node")
        if not backends:
            self.skipTest("The headless query needs JavaScriptCore or Node")

        def pad(x, y, through=False):
            return {"number":"1", "shape":"rect", "x":x, "y":y, "w":0.8, "h":0.8,
                    **({"drill":0.25, "layer":"Multi"} if through else {"layer":"Top"})}

        definitions = [
            {"id":"anchor", "name":"Offset courtyard", "footprint":{"shapes":[], "pads":[pad(-15, 0)], "courtyard":[2,-1,4,1]}},
            {"id":"edge", "name":"Two lands with one pin number", "footprint":{"shapes":[], "pads":[pad(0, 10, True), pad(0, 5, True)]}},
            {"id":"origin", "name":"Origin probe", "footprint":{"shapes":[], "pads":[pad(0.4, 0)]}},
        ]
        board = {**self.doc, "items":[
            {"id":"u3", "kind":"part", "def":"anchor", "ref":"U3", "value":"", "x":0, "y":0, "angle":90, "layer":"Top"},
            {"id":"probe-edge", "kind":"part", "def":"edge", "ref":"TP1", "value":"", "x":0, "y":0, "angle":0, "layer":"Top"},
            {"id":"probe-origin", "kind":"part", "def":"origin", "ref":"TP2", "value":"", "x":0, "y":0, "angle":0, "layer":"Top"},
            {"id":"via-stack", "kind":"via", "layer":"Multi", "x":0, "y":5.55, "diameter":0.4, "drill":0.25,
             "stackMode":"tmb", "padStack":{"Bottom":{"diameter":1.3}}},
        ]}
        project = {"name":"Nearby", "format":"atrium", "version":1, "library":definitions, "documents":[board]}
        with tempfile.TemporaryDirectory() as temp:
            path = write_design(Path(temp)/"Nearby.waffle", project)
            before = authored_files(temp)
            for backend in backends:
                with self.subTest(backend=backend):
                    server = Server(path)
                    runner = server.board_runner = BoardRunner(backend)
                    try:
                        with patch.object(runner, "call", wraps=runner.call) as call:
                            self.assertEqual(server.call("run_command", {"command":"select", "args":{"document_id":"pcb"}})["total"], 4)
                            loaded = {name for request in call.call_args_list for name, _ in resolve(request.args[1])}
                            self.assertNotIn("dfa", loaded)
                            self.assertNotIn("viastack", loaded)

                        def query(expression):
                            result = server.call("run_command", {"command":"query", "args":{"document_id":"pcb", "expression":expression}})
                            self.assertEqual(result["changes"], 0)
                            self.assertEqual(result["unknown"], 0)
                            return result

                        for source, expected in [
                            ("pad on layer Top near U3 within 1 mm", "probe-edge/1/1"),
                            ("pad on layer Bottom near U3 within 1 mm", "probe-edge/1/1"),
                            ("pad near origin of U3 within 1 mm", "probe-origin/1"),
                        ]:
                            result = query(source)
                            self.assertEqual(result["count"], 1, result)
                            self.assertEqual([row["id"] for row in result["untrusted_design_text"]["pins"]], [expected])
                        self.assertEqual(query("via near U3 within 1 mm")["ids"], ["via-stack"])
                        self.assertEqual(query("via on layer Top near U3 within 1 mm")["ids"], [])
                        self.assertEqual(query("via on layer Top near U3 within 2 mm")["ids"], ["via-stack"])
                        self.assertEqual(query("via on layer Bottom near U3 within 1 mm")["ids"], ["via-stack"])
                        with self.assertRaisesRegex(ValueError, "nearby anchor is unavailable"):
                            query("pad near Missing within 1 mm")
                    finally:
                        server.close()
                    self.assertEqual(authored_files(temp), before)

    def test_packaged_mcp_resolves_sibling_app_scripts(self):
        ensure_native_host()
        with tempfile.TemporaryDirectory() as temp:
            resources=Path(temp)/"Waffle.app"/"Contents"/"Resources"
            (resources/"app").mkdir(parents=True)
            (resources/"mcp").mkdir()
            # Keep the actual module graph and native helper at their bundled locations.
            shutil.copytree(ROOT/"app",resources/"app",dirs_exist_ok=True,ignore=shutil.ignore_patterns("*.png","*.jpg","fonts"))
            for path in (ROOT/"native").rglob("*.py"):
                relative = path.relative_to(ROOT/"native")
                if relative.parts[0] == "tests":
                    continue
                target = resources/"native"/relative
                target.parent.mkdir(parents=True, exist_ok=True)
                shutil.copy2(path, target)
            for path in (ROOT/"mcp").iterdir():
                if path.suffix in (".py",".js"):
                    shutil.copy(path,resources/"mcp"/path.name)
            env = os.environ.copy()
            if sys.platform == "darwin":
                host = resources.parent/"MacOS"/"Waffle"
                host.parent.mkdir()
                shutil.copy2(env.pop("WAFFLE_FOLDER_MCP_HOST"), host)
            project=Path(temp)/"design"/"Folder with spaces.waffle"
            write_design(project, {"name":"Test","format":"atrium","version":1,"library":[],"documents":[self.doc]})
            for args in (["init","--quiet"], ["add","--","."], ["commit","--quiet","-m","Saved project"]):
                subprocess.run(["git","-C",str(project.parent),"-c","user.name=Test","-c","user.email=test@example.invalid",
                                "-c","commit.gpgSign=false",*args],check=True)
            lines=[{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-11-25"}},
                   {"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"board_connectivity","arguments":{"document_id":"pcb","section":"shorts"}}},
                   {"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"compare_git_head","arguments":{}}},
                   {"jsonrpc":"2.0","id":4,"method":"tools/call",
                    "params":{"name":"run_command","arguments":{"command":"select","args":{"document_id":"pcb"}}}},
                   {"jsonrpc":"2.0","id":5,"method":"tools/call",
                    "params":{"name":"run_command","arguments":{"command":"set_grid","mode":"plan",
                                                              "args":{"document_id":"pcb","grid":0.5}}}}]
            result=subprocess.run([sys.executable,str(resources/"mcp"/"server.py"),"--project",str(project)],
                                  input="\n".join(map(json.dumps,lines))+"\n",text=True,capture_output=True,cwd=temp,env=env,timeout=120)
            self.assertEqual(result.returncode,0,result.stderr[-2000:])
            report=json.loads(result.stdout.splitlines()[1])["result"]
            self.assertFalse(report["isError"],report)
            self.assertEqual(json.loads(report["content"][0]["text"])["items"][0]["nets"],["USB+","USB-"])
            revision=json.loads(result.stdout.splitlines()[2])["result"]
            self.assertFalse(revision["isError"],revision)
            self.assertEqual(json.loads(revision["content"][0]["text"])["total"],0)
            selected, plan = [json.loads(line)["result"] for line in result.stdout.splitlines()[3:5]]
            self.assertFalse(selected["isError"], selected)
            self.assertEqual(json.loads(selected["content"][0]["text"])["total"], 3)
            self.assertFalse(plan["isError"], plan)
            edits = json.loads(plan["content"][0]["text"])
            self.assertEqual((edits["mode"], edits["changes"]), ("plan", 1))
            self.assertFalse((resources/"mcp"/"__pycache__").exists())
            self.assertFalse((resources/"native"/"__pycache__").exists())

    @unittest.skipUnless(shutil.which("node"), "Node is required for worker stdio")
    def test_node_stdio_does_not_require_selectable_pipes(self):
        runner = BoardRunner("node")
        self.addCleanup(runner.close)
        with patch("select.select", side_effect=OSError("Pipes are not selectable")):
            report = runner.report("board_connectivity", self.doc, [])
            self.assertEqual(report["shorts"][0]["nets"], ["USB+", "USB-"])
            worker = runner.worker
            self.assertEqual(runner.report("board_connectivity", self.doc, []), report)
        self.assertIs(runner.worker, worker)

    @unittest.skipUnless(shutil.which("node"), "Node is required for worker recovery")
    def test_node_stdio_deadline_covers_partial_reply(self):
        runner = BoardRunner("node")
        self.addCleanup(runner.close)
        # The child sends the beginning of a response, then takes too long to finish the line.
        code = ('import sys, time; sys.stdin.buffer.read(13); '
                'sys.stdout.write(\'{"text":\'); sys.stdout.flush(); '
                'time.sleep(2); print(\'"late"}\')')
        worker = runner.worker = subprocess.Popen([sys.executable, "-c", code],
                                                  stdin=subprocess.PIPE, stdout=subprocess.PIPE)
        with self.assertRaisesRegex(ToolLimit, "time limit"):
            runner._exchange(worker, (b"x",), timeout=0.5)
        self.assertIsNone(runner.worker)
        self.assertIsNotNone(worker.poll())
        self.assertTrue(worker.stdin.closed and worker.stdout.closed)
        self.assertEqual(runner.report("board_connectivity", self.doc, [])["shorts"][0]["nets"], ["USB+", "USB-"])

    @unittest.skipUnless(shutil.which("node"), "Node is required for worker recovery")
    def test_node_stdio_keeps_empty_first_history_snapshot(self):
        runner = BoardRunner("node")
        self.addCleanup(runner.close)
        project = {"format": "atrium", "version": 1, "name": "First saved board",
                   "documents": [self.doc], "library": []}
        result = json.loads(runner.call(
            "AtriumProjectHistoryReport", ("project-history-summary",),
            {"before": None, "after": "first", "nativeFolder": True},
            b"", json.dumps(project).encode("utf-8"), timeout=5, retry=True))
        self.assertGreater(result["total"], 0)
        self.assertIn("Board", result["text"])

    @unittest.skipUnless(shutil.which("node"), "Node is required for worker recovery")
    def test_node_crash_reloads_comparison_on_same_request(self):
        with tempfile.TemporaryDirectory() as temp:
            path = Path(temp) / "Board.waffle"
            project = {"name":"Test", "format":"atrium", "version":1, "library":[], "documents":[self.doc]}
            write_design(path, project)
            project["id"] = read_design(path)["id"]
            for args in (["init","--quiet"], ["add","--","."], ["commit","--quiet","-m","Saved project"]):
                subprocess.run(["git","-C",temp,"-c","user.name=Test","-c","user.email=test@example.invalid",
                                "-c","commit.gpgSign=false",*args],check=True)
            self.doc["items"][-1]["width"] = 0.15
            write_design(path, project)
            server = Server(path)
            worker = server.board_runner = BoardRunner("node")
            self.addCleanup(server.close)
            first = server.call("compare_git_head", {})
            self.assertIn("t", [item.get("locate_id") for item in first["items"]])
            initial_pid = worker.worker.pid
            original = worker.revision_page
            def crash_once(options):
                if worker.worker.pid == initial_pid:
                    worker.worker.kill()
                    worker.worker.wait()
                return original(options)
            with patch.object(worker, "revision_page", crash_once):
                self.assertEqual(server.call("compare_git_head", {}), first)
            self.assertNotEqual(worker.worker.pid, initial_pid)

class ScriptSandboxTests(unittest.TestCase):
    """MCP run_script: filesystem, process and network access must stay confined."""
    def setUp(self):
        sys.path.insert(0, str(ROOT / "mcp"))
        from automation import SCRIPT_MODULES
        self.modules = SCRIPT_MODULES
        self.project = json.dumps({"name":"Test","format":"atrium","version":1,"library":[],
                                   "documents":[{"id":"pcb","kind":"pcb","name":"Board","grid":0.25,"outline":[],"notes":[],"items":[]}]}).encode()

    def run_script(self, runner, code, timeout=1.0):
        started = time.monotonic()
        try:
            head, _ = runner.sandbox(self.modules, {"code": code, "timeoutMs": int(timeout * 1000), "args": None}, self.project, timeout)
            error = head["error"]
        except ValueError as e:
            error = str(e)
        return error, time.monotonic() - started

    @unittest.skipUnless(load_jsc(), "JavaScriptCore is required")
    def test_jsc_scripts_cannot_hang_or_exhaust_the_server(self):
        runner = BoardRunner("jsc")
        self.addCleanup(runner.close)
        for code in ("await null; for (;;) {}", "await api.items.count(); while (true) {}", "for (;;) {}"):
            error, elapsed = self.run_script(runner, code)
            self.assertIn("time limit", error, code)
            self.assertLess(elapsed, 1 + 2.5, code)
        error, elapsed = self.run_script(runner, "const spin = () => Promise.resolve().then(spin); spin(); return 1;")
        self.assertRegex(error, "time limit|memory")
        self.assertLess(elapsed, 1 + 2.5)
        error, _ = self.run_script(runner, "const a = []; for (;;) a.push(new Array(1e6).fill(1.5));", timeout=20)
        self.assertRegex(error, "memory|time limit")
        error, _ = self.run_script(runner, 'return Function("return this")().constructor.constructor("return process")()')
        self.assertIn("process", error)
        head, body = runner.sandbox(self.modules, {"code": "return 6 * 7", "timeoutMs": 1000, "args": None}, self.project, 1.0)
        self.assertEqual((head["error"], head["result"]), (None, 42))

    def test_unchanged_script_omits_only_the_transactional_return_snapshot(self):
        backends = [name for name, available in (("jsc", load_jsc()), ("node", shutil.which("node"))) if available]
        if not backends:
            self.skipTest("No script backend is available")
        for backend in backends:
            with self.subTest(backend=backend), patch.dict(os.environ, {"ATRIUM_ALLOW_NODE_SCRIPTS": "1"}):
                runner = BoardRunner(backend)
                try:
                    def run(code, *, omit=True, modules=self.modules):
                        return runner.sandbox(modules, {"code": code, "timeoutMs": 2000, "omitUnchanged": omit},
                                              self.project, 2)
                    read, body = run("return api.items.count();")
                    self.assertEqual(read, {"log": [], "error": None, "result": 0, "transactions": 0, "unchanged": True})
                    self.assertIsNone(body)
                    retained, body = run("return api.items.count();", omit=False)
                    self.assertNotIn("unchanged", retained)
                    self.assertEqual(json.loads(body)["name"], "Test")

                    edit = "await api.transaction('Rename', tx => tx.setDocument('pcb', {name:'Renamed'}));"
                    changed, body = run(edit + "return {unchanged: true, transactions: 0};")
                    self.assertNotIn("unchanged", changed)
                    self.assertEqual(changed["transactions"], 1)
                    self.assertEqual(changed["result"], {"unchanged": True, "transactions": 0})
                    self.assertEqual(json.loads(body)["documents"][0]["name"], "Renamed")
                    failed, body = run(edit + "throw Error('discard');")
                    self.assertEqual((failed["error"], failed["transactions"], body), ("discard", 1, None))
                    self.assertNotIn("unchanged", failed)

                    fallback, body = run("project.name = 'Legacy edit'; return 1;",
                                         modules=tuple(name for name in self.modules if name != "scripting"))
                    self.assertNotIn("unchanged", fallback)
                    self.assertNotIn("transactions", fallback)
                    self.assertEqual(json.loads(body)["name"], "Legacy edit")
                finally:
                    runner.close()

    @unittest.skipUnless(load_jsc(), "JavaScriptCore is required")
    def test_in_process_calls_have_time_and_memory_limits(self):
        """Every in-process call runs under the watchdog."""
        from board_runner import JavaScriptCore, ToolLimit
        context = JavaScriptCore(load_jsc(), ())
        self.addCleanup(context.close)
        context.evaluate("globalThis.Spin = function () { for (;;) {} };"
                         "globalThis.Grow = function () { const a = []; for (;;) a.push(new Array(1e5).fill(1)); };"
                         "globalThis.Ok = function (x) { return x + '!'; };")
        started = time.monotonic()
        self.assertRaisesRegex(ToolLimit, "time limit", context.run, (b"x",), "Spin", 1)
        self.assertLess(time.monotonic() - started, 3)
        self.assertRaisesRegex(ToolLimit, "memory limit", context.run, (b"x",), "Grow", 30, 200 << 20)
        self.assertEqual(context.run((b"x",), "Ok", 5, 1 << 30), "x!")

    def test_child_processes_are_killed_at_the_deadline(self):
        from board_runner import _run_child
        started = time.monotonic()
        with self.assertRaisesRegex(ValueError, "time limit"):
            _run_child([sys.executable, "-c", "import time; time.sleep(60)"], (b"{}",), 0.2)
        self.assertLess(time.monotonic() - started, 0.2 + 3)

    @unittest.skipUnless(shutil.which("node"), "Node is required")
    def test_node_scripts_need_opt_in_and_cannot_escape(self):
        runner = BoardRunner("node")
        self.addCleanup(runner.close)
        with patch.dict(os.environ, {"ATRIUM_ALLOW_NODE_SCRIPTS": ""}):
            self.assertRaisesRegex(ValueError, "disabled under Node", runner.sandbox, self.modules, {"code": "return 1"}, self.project, 1)
        with tempfile.TemporaryDirectory() as temp, patch.dict(os.environ, {"ATRIUM_ALLOW_NODE_SCRIPTS": "1"}):
            target = Path(temp) / "pwned.txt"
            escape = ('const g = api.constructor.constructor("return this")(); const P = g.constructor.constructor("return process")();'
                      'return P.getBuiltinModule("child_process").execSync("echo PWNED > ' + str(target) + '").toString();')
            error, _ = self.run_script(runner, escape)
            self.assertFalse(target.exists(), "the vm escape must not run commands")
            self.assertTrue(error)
            error, elapsed = self.run_script(runner, "await null; for (;;) {}")
            self.assertIn("time limit", error)
            self.assertLess(elapsed, 1 + 2.5)


if __name__ == "__main__":
    unittest.main()
