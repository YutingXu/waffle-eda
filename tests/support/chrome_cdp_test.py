#!/usr/bin/env python3
"""In-memory witness for the shared Chrome DevTools transport.

Frames bytes independently of scripts/ci/chrome_cdp.py. Checks the 125/126/65535/65536
boundaries, events between replies, a continued reply, a coalesced upgrade prefix,
EOF, and schematic binding marks. A non-final fragment treated as a whole message
must fail the continuation check.
"""
import ast
import json
import runpy
import socket
import sys
import threading
import time
import types
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "scripts" / "ci"))
import chrome_cdp

FINAL = "if b0 & 0x80:  # final fragment"
CALLERS = (
    "scripts/perf-route.py",
    "scripts/perf-canvas.sh",
    "scripts/perf-pour.sh",
    "scripts/perf-ui.sh",
    "scripts/perf-sch.sh",
    "scripts/perf-gpu.sh",
    "scripts/gpu-pixels.sh",
    "tests/workers/worker-start.py",
    "scripts/collab-demo.py",
    "scripts/click-through-real.py",
)


class Chunks:
    def __init__(self, data):
        self.remaining = data
        self.sent = []
        self.deliveries = 0

    def recv(self, limit):
        self.deliveries += 1
        size = min(limit, 13 if self.deliveries < 4 else 65536)
        chunk, self.remaining = self.remaining[:size], self.remaining[size:]
        return chunk

    def sendall(self, data):
        self.sent.append(data)


def frame(payload, *, last=True, opcode=1):
    size = len(payload)
    first = bytes([opcode | (0x80 if last else 0)])
    if size < 126:
        return first + bytes([size]) + payload
    if size < 65536:
        return first + bytes([126]) + size.to_bytes(2, "big") + payload
    return first + bytes([127]) + size.to_bytes(8, "big") + payload


def request_from_wire(blob):
    assert blob[0] == 0x81 and blob[1] & 0x80
    size, start = blob[1] & 0x7F, 2
    if size > 125:
        start += 2 if size == 126 else 8
        size = int.from_bytes(blob[2:start], "big")
    mask, payload = blob[start:start + 4], blob[start + 4:]
    assert size == len(payload)
    return json.loads(bytes(value ^ mask[index % 4] for index, value in enumerate(payload)))


def checked_call(wire, method, **params):
    checked_call.n += 1
    return chrome_cdp.checked_result(method, wire.raw_reply(method, params, checked_call.n))


def boundaries():
    empty = b'{"id":1,"result":{"token":""}}'
    event = frame(b'{"method":"Runtime.bindingCalled","params":{"payload":"keep"}}')
    for size in (125, 126, 65535, 65536):
        token = b"x" * (size - len(empty))
        response = empty[:-3] + token + empty[-3:]
        assert len(response) == size, size
        whole = event + frame(response)
        checked_call.n = 0
        wire = chrome_cdp.Wire(Chunks(whole[5:]), whole[:5])
        assert checked_call(wire, "Runtime.test", value=42) == {"token": token.decode()}, size
        assert request_from_wire(wire.sock.sent[0]) == {"id": 1, "method": "Runtime.test", "params": {"value": 42}}
        assert wire.sock.deliveries >= 1


def continuation(module):
    expected = {"id": 1, "result": {"token": "continued"}}
    body = json.dumps(expected).encode()
    sock = Chunks(frame(body[:14], last=False) + frame(body[14:], opcode=0))
    wire = module.Wire(sock, b"")
    return module.checked_result("Runtime.test", wire.raw_reply("Runtime.test", {}, 1))


def mutant_module():
    source = (ROOT / "scripts" / "ci" / "chrome_cdp.py").read_text()
    assert source.count(FINAL) == 1
    namespace = {"__name__": "chrome_cdp_mutant"}
    exec(compile(source.replace(FINAL, "if True:  # final fragment", 1), "chrome_cdp_mutant", "exec"), namespace)
    return types.SimpleNamespace(**namespace)


def run_mutant():
    try:
        continuation(mutant_module())
    except json.JSONDecodeError as error:
        raise AssertionError("Continuation must assemble before decoding") from error
    raise AssertionError("non-final fragment was accepted as a whole message")


def eof_and_policy():
    wire = chrome_cdp.Wire(Chunks(b""), b"")
    try:
        wire.raw_reply("Runtime.test", {}, 1)
    except EOFError as error:
        assert str(error) == "DevTools connection closed"
    else:
        raise AssertionError("EOF must surface to caller")
    closed = chrome_cdp.Wire(Chunks(b""), b"", eof=lambda: EOFError())
    try:
        closed.recv(1)
    except EOFError as error:
        assert error.args == ()
    else:
        raise AssertionError("collab EOF must stay empty")
    named = chrome_cdp.Wire(Chunks(b""), b"", eof=lambda: SystemExit("perf-sch: the browser closed the connection"))
    try:
        named.read_message()
    except SystemExit as error:
        assert str(error) == "perf-sch: the browser closed the connection"
    else:
        raise AssertionError("schematic close must stay a SystemExit")
    bad = frame(json.dumps({"id": 1, "error": {"code": -32000, "message": "no"}}).encode())
    wire = chrome_cdp.Wire(Chunks(bad), b"")
    reply = wire.raw_reply("Runtime.test", {}, 1)
    assert reply["error"] == {"code": -32000, "message": "no"}
    try:
        chrome_cdp.checked_result("Runtime.test", reply)
    except RuntimeError as error:
        assert str(error) == 'Runtime.test: {"code": -32000, "message": "no"}'
    else:
        raise AssertionError("checked Page.call must raise")


def commands_and_marks():
    wrong = frame(json.dumps({"id": 9, "result": {"token": "no"}}).encode())
    event = frame(b'{"method":"Runtime.bindingCalled","params":{"payload":"keep"}}')
    first = frame(json.dumps({"id": 1, "result": {"n": 1}}).encode())
    second = frame(json.dumps({"id": 1, "result": {"n": 2}}).encode())
    wire = chrome_cdp.Wire(Chunks(wrong + event + first + second), b"")
    assert wire.raw_reply("Runtime.evaluate", {}, 1)["result"] == {"n": 1}
    assert wire.raw_reply("Runtime.evaluate", {}, 1)["result"] == {"n": 2}
    marks = []

    def accept(message):
        if message.get("method") == "Runtime.bindingCalled":
            marks.append(message["params"]["payload"])

    later = frame(b'{"method":"Runtime.bindingCalled","params":{"payload":"done"}}')
    reply = frame(json.dumps({"id": 4, "result": {"value": 7}}).encode())
    wire = chrome_cdp.Wire(Chunks(event + reply + later), b"")
    assert wire.raw_reply("Runtime.evaluate", {"expression": "1"}, 4, on_event=accept)["result"] == {"value": 7}
    message = wire.read_message()
    if message.get("method") == "Runtime.bindingCalled":
        marks.append(message["params"]["payload"])
    assert marks == ["keep", "done"]


def cold_output_handoff():
    capture = runpy.run_path(str(ROOT / "scripts" / "click-through-real.py"))["cold_result"]
    url = "file:///fixture-root/probe.html"
    target = {"id": "main", "loaderId": "file", "url": url}
    marks = [
        {"id": 1, "result": {}}, {"id": 2, "result": {}},
        {"method": "Runtime.executionContextCreated", "params": {
            "context": {"uniqueId": "blank", "auxData": {"frameId": "main", "isDefault": True}}}},
        {"id": 3, "result": {}}, {"id": 4, "result": {}},
        {"id": 5, "result": {"frameId": "main", "loaderId": "file"}},
        {"method": "Page.lifecycleEvent", "params": {"name": "load", "frameId": "main", "loaderId": "old"}},
        {"method": "Runtime.executionContextsCleared"},
        {"method": "Page.lifecycleEvent", "params": {"name": "load", "frameId": "child", "loaderId": "file"}},
        {"method": "Runtime.executionContextCreated", "params": {
            "context": {"uniqueId": "committed", "auxData": {"frameId": "main", "isDefault": True}}}},
        {"method": "Page.lifecycleEvent", "params": {"name": "load", "frameId": "main", "loaderId": "file"}},
    ]
    result = json.dumps({"results": [{"a": "save", "ok": False}]})
    success = {"result": {"result": {"type": "string", "value": result}}}
    destroyed = {"error": {"code": -32000, "message": "Execution context was destroyed."}}
    tree = lambda message_id, frame: {"id": message_id, "result": {"frameTree": {"frame": frame}}}
    reloaded = {**target, "loaderId": "reload"}
    for before, during, after, failure, count in (
        (target, success, target, None, 1),
        (reloaded, success, target, "navigated away", 0),
        (target, success, reloaded, "navigated away", 1),
        (target, destroyed, target, "Execution context was destroyed", 1),
        (target, {"method": "Inspector.targetCrashed"}, target, "target crashed", 1),
    ):
        reply = {"id": 7, **during} if "method" not in during else during
        messages = marks + [tree(6, before), reply, tree(8, after)]
        sock = Chunks(b"".join(frame(json.dumps(message).encode()) for message in messages))
        sock.settimeout = lambda seconds: None
        try:
            assert capture(chrome_cdp.Wire(sock), url, time.monotonic() + 1, 2) == result
        except RuntimeError as error:
            assert failure and failure in str(error), error
        else:
            assert failure is None
        requests = [request_from_wire(payload) for payload in sock.sent]
        assert [row["params"] for row in requests if row["method"] == "Page.navigate"] == [{"url": url}]
        runs = [row for row in requests if row["method"] == "Runtime.evaluate"]
        assert len(runs) == count
        if runs:
            assert runs[0]["params"]["uniqueContextId"] == "committed"
            assert runs[0]["params"]["expression"] == "runCold()"



def upgrade():
    server = socket.socket()
    server.bind(("127.0.0.1", 0))
    server.listen(1)
    server.settimeout(5)
    port = server.getsockname()[1]
    payload = {"id": 1, "result": {"token": "up"}}
    framed = frame(json.dumps(payload).encode())
    errors = []
    held = []

    def serve():
        try:
            conn, _ = server.accept()
            held.append(conn)
            conn.settimeout(5)
            data = b""
            while b"\r\n\r\n" not in data:
                chunk = conn.recv(4096)
                if not chunk:
                    break
                data += chunk
            if b"GET /devtools/page/abc HTTP/1.1\r\n" not in data or b"Sec-WebSocket-Version: 13\r\n" not in data:
                errors.append(data)
            conn.sendall(b"HTTP/1.1 101 Switching Protocols\r\n\r\n" + framed[:5])
            conn.sendall(framed[5:])
        except Exception as error:
            errors.append(repr(error))

    thread = threading.Thread(target=serve)
    thread.start()
    wire = chrome_cdp.connect("ws://127.0.0.1:%d/devtools/page/abc" % port, timeout=5)
    assert wire.sock.gettimeout() == 5
    assert wire.read_message() == payload
    wire.sock.settimeout(0.2)
    try:
        wire.sock.recv(1)
    except socket.timeout:
        pass
    else:
        raise AssertionError("caller timeout did not fire")
    thread.join(5)
    for conn in held:
        conn.close()
    server.close()
    assert not errors, errors

    refused = socket.socket()
    refused.bind(("127.0.0.1", 0))
    refused.listen(1)
    refused.settimeout(5)
    refused_port = refused.getsockname()[1]

    def refuse():
        conn, _ = refused.accept()
        data = b""
        while b"\r\n\r\n" not in data:
            chunk = conn.recv(4096)
            if not chunk:
                break
            data += chunk
        conn.close()

    thread = threading.Thread(target=refuse)
    thread.start()
    try:
        chrome_cdp.connect(
            "ws://127.0.0.1:%d/devtools/page/abc" % refused_port,
            timeout=5,
            refused=lambda: ConnectionError("the browser refused the DevTools websocket"),
        )
    except ConnectionError as error:
        assert str(error) == "the browser refused the DevTools websocket"
    else:
        raise AssertionError("refused upgrade must surface")
    thread.join(5)
    refused.close()


def embedded_python(text):
    bodies = []
    rest = text
    token = "<<'PY'\n"
    while token in rest:
        rest = rest.split(token, 1)[1]
        if "\nPY\n" in rest:
            body, rest = rest.split("\nPY\n", 1)
        elif rest.endswith("\nPY"):
            body, rest = rest[:-3], ""
        else:
            raise AssertionError("unterminated Python heredoc")
        bodies.append(body + "\n")
    return bodies


def callers():
    for relative in CALLERS:
        text = (ROOT / relative).read_text()
        if relative.endswith(".py"):
            ast.parse(text)
        else:
            bodies = embedded_python(text)
            assert bodies, relative
            for body in bodies:
                ast.parse(body)
    route = (ROOT / "scripts" / "perf-route.py").read_text()
    worker = (ROOT / "tests" / "workers" / "worker-start.py").read_text()
    collab = (ROOT / "scripts" / "collab-demo.py").read_text()
    sch = (ROOT / "scripts" / "perf-sch.sh").read_text()
    assert "chrome_cdp.checked_result" in route and "chrome_cdp.checked_result" in worker
    assert 'self.sock.settimeout(3); self.call("Browser.close")' in route
    assert 'self.sock.settimeout(3); self.call("Browser.close")' in worker
    assert "os.killpg" in route and "os.killpg" in worker
    assert 'raise RuntimeError(reply["error"])' in collab and "proc.terminate()" in collab
    assert "eof=lambda: EOFError()" in collab
    assert "def readmsg()" in sch and "on_event=accept" in sch and "sock.settimeout" in sch
    assert "timeout=420" in (ROOT / "scripts" / "perf-canvas.sh").read_text()
    assert "timeout=320" in (ROOT / "scripts" / "perf-pour.sh").read_text()
    assert 'SystemExit("perf-ui: the browser closed the connection")' in (ROOT / "scripts" / "perf-ui.sh").read_text()
    assert 'SystemExit("perf-sch: the browser closed the connection")' in sch
    assert "timeout=900" in (ROOT / "scripts" / "perf-gpu.sh").read_text()
    assert "timeout=1800" in (ROOT / "scripts" / "gpu-pixels.sh").read_text()
    assert "timeout=600" in worker
    assert "proc.kill()" in (ROOT / "scripts" / "perf-canvas.sh").read_text()


def main():
    if "--mutant" in sys.argv:
        run_mutant()
        return
    boundaries()
    assert continuation(chrome_cdp) == {"token": "continued"}
    eof_and_policy()
    commands_and_marks()
    cold_output_handoff()
    upgrade()
    callers()
    try:
        run_mutant()
    except AssertionError as error:
        if str(error) != "Continuation must assemble before decoding":
            raise
    else:
        raise AssertionError("non-final fragment was accepted as a whole message")
    print("Four frame-length boundaries, buffered upgrade, continuation, EOF and cold action document handoff")


if __name__ == "__main__":
    main()
