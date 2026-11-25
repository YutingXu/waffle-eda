"""Shared MCP stdio client and reusable headless sample fixture.

Callers keep their own process launch, client name, timeout, and cleanup.
JSON-RPC framing, notification skipping, response ids, timeout, and EOF live here.
"""
import json
from pathlib import Path
from queue import Empty, SimpleQueue
import subprocess
import sys
import tempfile
from threading import Thread
import time
import unittest

from native_sample import authored_files, ensure_native_host, make_sample, read_design, revision

SERVER = Path(__file__).resolve().parents[2] / "mcp" / "server.py"


class Client:
    """JSON-RPC helpers for a server subprocess in self.proc."""
    def _reply_lines(self):
        output = getattr(self, "_output", None)
        if output is None or output[0] is not self.proc:
            proc = self.proc
            replies = SimpleQueue()

            def receive():
                try:
                    for line in proc.stdout:
                        replies.put(line)
                finally:
                    replies.put(None)

            # Windows select() works on sockets, so read the pipe on its own thread.
            reader = Thread(target=receive, daemon=True)
            self._output = output = (proc, replies, reader)
            reader.start()
        return output[1]

    def stop_server(self):
        if self.proc.stdin.closed:
            return
        self.proc.stdin.close()
        if self.proc.poll() is None:
            try:
                self.proc.wait(timeout=3)
            except subprocess.TimeoutExpired:
                self.proc.kill()
                self.proc.wait()
        output = getattr(self, "_output", None)
        if output is not None and output[0] is self.proc:
            output[2].join()
            self._output = None
        stderr = self.proc.stderr.read()
        self.proc.stdout.close()
        self.proc.stderr.close()
        self.assertEqual(self.proc.returncode, 0, stderr)

    def send(self, message):
        self.proc.stdin.write(json.dumps(message) + "\n")
        self.proc.stdin.flush()

    def request(self, method, params, timeout=4):
        self.seq += 1
        replies = self._reply_lines()
        self.send({"jsonrpc": "2.0", "id": self.seq, "method": method, "params": params})
        deadline = time.monotonic() + timeout
        while True:
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                self.fail(method + " timed out")
            try:
                line = replies.get(timeout=remaining)
            except Empty:
                self.fail(method + " timed out")
            self.assertIsNotNone(line, method + " ended before a reply (stdout closed)")
            response = json.loads(line)
            self.assertEqual(response["jsonrpc"], "2.0")
            if "id" not in response and "method" in response:
                continue
            self.assertEqual(response["id"], self.seq)
            return response

    def initialize(self):
        result = self.request("initialize", {"protocolVersion": "2025-06-18",
                              "clientInfo": {"name": "AtriumTests", "version": "1"},
                              "capabilities": {}})["result"]
        self.assertEqual(result["protocolVersion"], "2025-06-18")
        self.assertIn("tools", result["capabilities"])
        self.assertEqual(result["serverInfo"]["name"], "waffle-eda")
        self.assertEqual(result["serverInfo"]["title"], "Waffle EDA")
        self.send({"jsonrpc": "2.0", "method": "notifications/initialized"})

    def tool(self, name, args=None, error=False, timeout=4):
        result = self.request("tools/call", {"name": name, "arguments": args or {}}, timeout)["result"]
        self.assertEqual(result["isError"], error, result["content"])
        return result["content"][0]["text"] if error else json.loads(result["content"][0]["text"])


class HeadlessFixture(Client, unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        ensure_native_host()

    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.dir = Path(self.temp.name)
        self.path = make_sample(self.dir, "Sensor.waffle")
        self.fixture = authored_files(self.dir)
        self.digest = revision(self.path)
        self.design = read_design(self.path)
        self.pcb = next(d["id"] for d in self.design["documents"] if d["kind"] == "pcb")
        self.seq = 0
        self.proc = None

    def start(self, *flags):
        if self.proc:
            self.stop_server()
        self.proc = subprocess.Popen([sys.executable, "-B", str(SERVER), "--project", str(self.path), *flags],
                                     stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, bufsize=1)
        self.addCleanup(lambda proc=self.proc: proc.poll() is not None or self.stop_server())
        self.initialize()


def close_stdio(owner, timeout):
    """Close a caller-owned session without requiring return code 0."""
    proc = owner.proc
    if proc.poll() is None and proc.stdin and not proc.stdin.closed:
        try:
            proc.stdin.close()
        except OSError:
            pass
        try:
            proc.wait(timeout=timeout)
        except subprocess.TimeoutExpired:
            proc.kill()
            proc.wait()
    output = getattr(owner, "_output", None)
    if output is not None and output[0] is proc:
        output[2].join()
        owner._output = None
    for stream in (proc.stdin, proc.stdout, proc.stderr):
        if stream and not stream.closed:
            try:
                stream.close()
            except OSError:
                pass



def _spawn(script, *args):
    return subprocess.Popen(
        [sys.executable, "-I", "-B", "-c", script, *map(str, args)],
        stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, bufsize=1,
    )


def _shutdown(proc, client):
    try:
        if proc.stdin and not proc.stdin.closed:
            proc.stdin.close()
    except OSError:
        pass
    if proc.poll() is None:
        try:
            proc.wait(timeout=0.5)
        except subprocess.TimeoutExpired:
            proc.kill()
            proc.wait(timeout=2)
    output = getattr(client, "_output", None)
    if output is not None and output[0] is proc and output[2].is_alive():
        output[2].join(timeout=2)
        if output[2].is_alive():
            raise AssertionError("stdio reader thread did not finish")
    for stream in (proc.stdout, proc.stderr):
        try:
            if stream and not stream.closed:
                stream.close()
        except OSError:
            pass


def _session(proc):
    class Session(Client, unittest.TestCase):
        def runTest(self):
            return None

    client = Session()
    client.proc = proc
    client.seq = 0
    return client


_INIT = r"""
import json, sys
name, dest = sys.argv[1], sys.argv[2]
messages = []
try:
    while True:
        line = sys.stdin.readline()
        if not line:
            break
        message = json.loads(line)
        messages.append(message)
        if "id" not in message:
            continue
        if message.get("method") != "initialize":
            sys.exit(3)
        result = {"protocolVersion": "2025-06-18", "capabilities": {"tools": {}},
                  "serverInfo": {"name": name, "title": "Waffle EDA"}}
        sys.stdout.write(json.dumps({"jsonrpc": "2.0", "id": message["id"], "result": result}) + "\n")
        sys.stdout.flush()
finally:
    with open(dest, "w", encoding="utf-8") as handle:
        json.dump(messages, handle)
"""

_TOOL = r"""
import json, sys
message = json.loads(sys.stdin.readline())
text = json.dumps({"sibling": "positive"})
result = {"isError": False, "content": [{"type": "text", "text": text}]}
sys.stdout.write(json.dumps({"jsonrpc": "2.0", "id": message["id"], "result": result}) + "\n")
sys.stdout.flush()
sys.stdin.read()
"""

_NOTIFY = r"""
import json, sys
message = json.loads(sys.stdin.readline())
sys.stdout.write(json.dumps({"jsonrpc": "2.0", "method": "notifications/progress", "params": {"unrelated": True}}) + "\n")
sys.stdout.flush()
sys.stdout.write(json.dumps({"jsonrpc": "2.0", "id": message["id"], "result": {"after": "notification"}}) + "\n")
sys.stdout.flush()
sys.stdin.read()
"""

_MISMATCH = r"""
import json, sys
message = json.loads(sys.stdin.readline())
sys.stdout.write(json.dumps({"jsonrpc": "2.0", "id": 999, "result": {"unrelated": True}}) + "\n")
sys.stdout.flush()
sys.stdout.write(json.dumps({"jsonrpc": "2.0", "id": message["id"], "result": {"after": "mismatch"}}) + "\n")
sys.stdout.flush()
sys.stdin.read()
"""

_TIMEOUT = r"""
import sys, time
sys.stdin.readline()
time.sleep(30)
"""

_EOF = r"""
import sys
sys.stdout.close()
sys.stdin.readline()
"""


def _load(name, path):
    import importlib.util
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class StdioReaderTests(unittest.TestCase):
    def test_initialize_records_protocol_and_notification(self):
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        dest = Path(directory.name) / "messages.json"
        proc = _spawn(_INIT, "waffle-eda", dest)
        client = _session(proc)
        try:
            client.initialize()
            client.stop_server()
            messages = json.loads(dest.read_text())
        finally:
            _shutdown(proc, client)
        self.assertEqual(messages, [
            {"jsonrpc": "2.0", "id": 1, "method": "initialize", "params": {
                "protocolVersion": "2025-06-18",
                "clientInfo": {"name": "AtriumTests", "version": "1"},
                "capabilities": {}}},
            {"jsonrpc": "2.0", "method": "notifications/initialized"},
        ])

    def test_initialize_rejects_a_foreign_server_name(self):
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        proc = _spawn(_INIT, "other", Path(directory.name) / "messages.json")
        client = _session(proc)
        try:
            with self.assertRaises(AssertionError) as caught:
                client.initialize()
            self.assertIn("waffle-eda", str(caught.exception))
        finally:
            _shutdown(proc, client)

    def test_positive_sibling_tool_call(self):
        proc = _spawn(_TOOL)
        client = _session(proc)
        try:
            self.assertEqual(client.tool("synthetic", {"n": 1}), {"sibling": "positive"})
            client.stop_server()
        finally:
            _shutdown(proc, client)

    def test_notification_is_not_the_reply(self):
        proc = _spawn(_NOTIFY)
        client = _session(proc)
        try:
            reply = client.request("ping", {}, timeout=2)
            client.stop_server()
        finally:
            _shutdown(proc, client)
        self.assertEqual(reply["id"], 1)
        self.assertEqual(reply["result"], {"after": "notification"})

    def test_mismatched_response_id_is_rejected(self):
        proc = _spawn(_MISMATCH)
        client = _session(proc)
        try:
            with self.assertRaises(AssertionError) as caught:
                client.request("ping", {}, timeout=2)
            self.assertIn("999 != 1", str(caught.exception))
        finally:
            _shutdown(proc, client)

    def test_timeout_fails_without_a_reply(self):
        proc = _spawn(_TIMEOUT)
        client = _session(proc)
        try:
            with self.assertRaises(AssertionError) as caught:
                client.request("ping", {}, timeout=0.4)
            self.assertEqual(str(caught.exception), "ping timed out")
        finally:
            _shutdown(proc, client)

    def test_eof_fails_when_stdout_closes(self):
        proc = _spawn(_EOF)
        client = _session(proc)
        try:
            with self.assertRaises(AssertionError) as caught:
                client.request("ping", {}, timeout=2)
            self.assertIn("ended before a reply (stdout closed)", str(caught.exception))
        finally:
            _shutdown(proc, client)

    def test_duplicate_clients_delegate_and_keep_caller_contracts(self):
        import inspect
        root = Path(__file__).resolve().parents[2]
        authoring = _load("qa05_authoring", root / "tests/automation/mcp-authoring.py")
        eco = _load("qa05_eco", root / "tests/integration/eco-e2e.py")
        automation = _load("qa05_automation_mcp", root / "tests/automation/mcp.py")
        generic = _load("qa05_generic", root / "tests/library/mcp-generic-parts.py")
        wizard = _load("qa05_wizard", root / "tests/library/mcp-symbol-wizard.py")
        self.assertTrue(issubclass(authoring.Server, authoring.Client))
        self.assertTrue(issubclass(eco.EndToEnd, eco.Client))
        self.assertEqual(str(inspect.signature(authoring.Server.request)), "(self, method, params, timeout=120)")
        self.assertEqual(str(inspect.signature(authoring.Server.tool)), "(self, name, args=None, timeout=120, error=False)")
        self.assertEqual(str(inspect.signature(eco.EndToEnd.request)), "(self, method, params, timeout=120)")
        self.assertEqual(str(inspect.signature(eco.EndToEnd.tool)), "(self, name, args=None, timeout=120)")
        self.assertEqual(str(inspect.signature(Client.tool)), "(self, name, args=None, error=False, timeout=4)")
        self.assertIs(automation.HeadlessToolTests.start, automation.HeadlessFixture.start)
        self.assertIs(automation.HeadlessToolTests.setUp, automation.HeadlessFixture.setUp)
        self.assertIs(automation.HeadlessToolTests.setUpClass.__func__, automation.HeadlessFixture.setUpClass.__func__)
        self.assertIn(automation.Client, automation.MCPTests.__mro__)
        self.assertIs(generic.GenericPartsMCP.start, generic.HeadlessFixture.start)
        self.assertIs(generic.GenericPartsMCP.setUp, generic.HeadlessFixture.setUp)
        self.assertIs(wizard.SymbolWizardMCP.start, wizard.HeadlessFixture.start)
        self.assertIs(wizard.SymbolWizardMCP.setUp, wizard.HeadlessFixture.setUp)
        for label, owner in (("authoring", authoring.Server), ("e2e", eco.EndToEnd)):
            proc = _spawn(_NOTIFY)
            if owner is authoring.Server:
                client = owner.__new__(owner)
                client.test = self
            else:
                client = owner("runTest")
            client.proc = proc
            client.seq = 0
            try:
                self.assertEqual(client.request("ping", {}, timeout=2), {"after": "notification"})
            finally:
                client.stop()
            proc = _spawn(_MISMATCH)
            if owner is authoring.Server:
                client = owner.__new__(owner)
                client.test = self
            else:
                client = owner("runTest")
            client.proc = proc
            client.seq = 0
            try:
                with self.assertRaises(AssertionError) as caught:
                    client.request("ping", {}, timeout=2)
                self.assertIn("999 != 1", str(caught.exception), label)
            finally:
                client.stop()
            proc = _spawn(_EOF)
            if owner is authoring.Server:
                client = owner.__new__(owner)
                client.test = self
            else:
                client = owner("runTest")
            client.proc = proc
            client.seq = 0
            try:
                with self.assertRaises(AssertionError) as caught:
                    client.request("ping", {}, timeout=2)
                self.assertIn("stdout closed", str(caught.exception), label)
            finally:
                client.stop()


def load_tests(loader, tests, pattern):
    return loader.loadTestsFromTestCase(StdioReaderTests)


if __name__ == "__main__":
    unittest.main()
