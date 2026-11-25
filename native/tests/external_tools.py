"""native/external_tools.py: the run:external host core (choices, approvals, the sandboxed run).
On macOS, native/macos/ExternalTools.swift is compiled with a small driver and must make the same
approval decisions, with the same dialog text, for the same sequence of runs.

Run: python3 native/tests/external_tools.py
"""
import base64
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import threading
import time
import unittest

sys.dont_write_bytecode = True
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import external_tools as X  # noqa: E402

PROGRAM = "#!" + sys.executable + r"""
import os, sys, time
args = sys.argv[1:]
if args[:1] == ["sleep"]:
    time.sleep(float(args[1]))
if args[:1] == ["flood"]:
    sys.stdout.write("x" * 200000)
print("cwd", os.getcwd())
print("args", args)
print("env", sorted(os.environ))
print("deck", open("deck.cir").read() if os.path.exists("deck.cir") else None)
open("out.raw", "w").write("Values\n")
open("big.raw", "w").write("y" * 5000)
os.symlink("/etc/hosts", "link.raw")
sys.stderr.write("warn\n")
sys.exit(3)
"""


V1, V2 = "sha256:" + "1" * 64, "sha256:" + "2" * 64


SWIFT_DRIVER = r'''
import Foundation
let a = CommandLine.arguments
HostFiles.supportDirectory = URL(fileURLWithPath: a[1], isDirectory: true)
let cases = try! JSONSerialization.jsonObject(with: Data(contentsOf: URL(fileURLWithPath: a[2]))) as! [[String: Any]]
// A cancelled ticket is visible to the approval handler and never starts a process.
let req = try! ExternalTools.check(cases[0]["request"])
let ticket = try! ExternalTools.shared.reserve(req)
ExternalTools.shared.cancel(ticket)
precondition(ExternalTools.shared.isCancelled(ticket))
let finished = DispatchSemaphore(value: 0)
ExternalTools.shared.run("/unconfigured", req, reservation: ticket) { result in
    guard case .success(let value) = result, value["cancelled"] as? Bool == true else { fatalError("Cancelled program started") }
    finished.signal()
}
precondition(finished.wait(timeout: .now() + 5) == .success)
var out: [Any] = []
for c in cases {
    do {
        let req = try ExternalTools.check(c["request"])
        if let need = ExternalTools.shared.approvalNeeded(req, c["path"] as! String) {
            out.append(["program": need.program, "command": need.command, "detail": need.detail, "title": need.title])
            if c["allow"] as? Bool == true { ExternalTools.shared.recordApproval(req, need) }
        } else { out.append(NSNull()) }
    } catch { out.append(["error": error.localizedDescription]) }
}
print(String(data: try! JSONSerialization.data(withJSONObject: out), encoding: .utf8)!)
'''


def b64(text):
    return base64.b64encode(text.encode()).decode()


class Tools(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.dir = Path(self.tmp.name)
        self.prog = self.dir / "fake-ngspice"
        self.prog.write_text(PROGRAM)
        self.prog.chmod(0o755)
        self.store = X.Store(self.dir / "support")

    def tearDown(self):
        self.tmp.cleanup()

    def request(self, **extra):
        r = {"tool": "ngspice", "args": ["-b", "deck.cir"], "files": [{"name": "deck.cir", "data": b64("* deck\n")}],
             "outputs": ["*.raw"], "timeoutMs": 10000, "maxOutputBytes": 4096, "runId": "ext.a:run1", "extension": "ext.a",
             "extensionHash": V1, "extensionName": "Sim", "toolName": "ngspice", "argTemplate": ["-b", "-r", "--out={output}"]}
        r.update(extra)
        return X.check_run(r)

    def test_output_uses_the_open_handle_budget_and_ignores_multiple_links(self):
        from types import SimpleNamespace
        from unittest.mock import patch
        out = self.dir / "normal.raw"
        out.write_bytes(b"sample")
        self.assertEqual(X.output_file(out, 6), b"sample")
        observed = out.stat()
        for links, expected in [(1, OverflowError), (2, None)]:
            # Model an output whose reported size changes before reading, or a shared inode.
            sampled = SimpleNamespace(st_mode=observed.st_mode, st_nlink=links, st_size=1)
            with patch.object(X.os, "fstat", return_value=sampled):
                if expected:
                    with self.assertRaises(expected):
                        X.output_file(out, 2)
                else:
                    self.assertIsNone(X.output_file(out, 6))

    def test_cancel_while_waiting_for_approval_prevents_launch(self):
        from unittest.mock import patch
        runner, req = X.Runner(), self.request()
        reservation = runner.reserve(req)
        self.assertTrue(runner.cancel(reservation[0]))
        with patch.object(X.subprocess, "Popen") as launch:
            self.assertTrue(runner.run(str(self.prog), req, reservation)["cancelled"])
            launch.assert_not_called()
        self.assertEqual(runner.running, {})

    def test_reserved_run_is_released_when_preparing_inputs_fails(self):
        from unittest.mock import patch
        runner = X.Runner()
        with patch.object(X.tempfile, "mkdtemp", side_effect=OSError("unavailable")):
            with self.assertRaises(OSError):
                runner.run(str(self.prog), self.request())
        self.assertEqual(runner.running, {})

    def test_approval_is_per_version_program_and_argument_template(self):
        self.store.choose("ngspice", "ngspice", str(self.prog))
        req = self.request(args=["-b", "-r", "out.raw", "deck.cir"])
        need = X.approval_needed(self.store, req, str(self.prog))
        self.assertTrue(need and need["program"] and not need["command"], need)
        self.assertIn(X.command_line(str(self.prog), req["args"]), need["detail"], "the first run shows the full command")
        self.assertIn("ext.a, " + V1[:19], need["detail"], "and the extension version")
        self.assertIn("-b -r --out={output}", need["detail"], "and the declared arguments it approves")
        X.record_approval(self.store, req, need)
        self.assertIsNone(X.approval_needed(self.store, req, str(self.prog)))
        # Within the template: declared flags, the run's own input names, names matching its outputs.
        for args in (["deck.cir"], ["-b", "deck.cir"], ["-r", "tran.raw", "-b", "deck.cir"], ["--out=x.raw", "deck.cir"], []):
            self.assertIsNone(X.approval_needed(self.store, self.request(args=args), str(self.prog)), args)
        # Anything else asks again, with the full command, for that exact command only.
        for args in (["-c", "deck.cir"], ["-b", "/etc/passwd"], ["--out=../x.raw"], ["--out=x.cir"], ["other.cir"], ["-b", "deck.cir", "-i"]):
            n = X.approval_needed(self.store, self.request(args=args), str(self.prog))
            self.assertTrue(n and not n["program"] and n["command"], args)
            self.assertIn(X.command_line(str(self.prog), args), n["detail"])
            self.assertIn("does not declare", n["detail"])
        odd = self.request(args=["-c", "deck.cir"])
        X.record_approval(self.store, odd, X.approval_needed(self.store, odd, str(self.prog)))
        self.assertIsNone(X.approval_needed(self.store, odd, str(self.prog)), "that exact command is remembered")
        self.assertIsNotNone(X.approval_needed(self.store, self.request(args=["-c", "deck.cir", "x"]), str(self.prog)), "another one asks again")
        # A new extension version (its content hash changed) asks again, even with the same arguments.
        v2 = self.request(args=["-b", "deck.cir"], extensionHash=V2)
        self.assertTrue(X.approval_needed(self.store, v2, str(self.prog))["program"], "a new version asks again")
        self.assertTrue(X.approval_needed(self.store, self.request(extension="ext.b"), str(self.prog))["program"], "another extension asks")
        # The resolved program: a symlink whose target changes asks again.
        link, other = self.dir / "ngspice-link", self.dir / "other-ngspice"
        other.write_text(PROGRAM); other.chmod(0o755)
        os.symlink(self.prog, link)
        self.assertIsNone(X.approval_needed(self.store, req, str(link)), "the same program through a symlink")
        link.unlink(); os.symlink(other, link)
        self.assertTrue(X.approval_needed(self.store, req, str(link))["program"], "the symlink now names another program")
        # A first run outside the template approves the program and that command.
        fresh = self.request(args=["-q", "deck.cir"], extension="ext.c")
        n = X.approval_needed(self.store, fresh, str(self.prog))
        self.assertTrue(n["program"] and n["command"] and "does not declare (-q)" in n["detail"], n)
        X.record_approval(self.store, fresh, n)
        self.assertIsNone(X.approval_needed(self.store, fresh, str(self.prog)))
        self.assertIsNone(X.approval_needed(self.store, self.request(args=["-b"], extension="ext.c"), str(self.prog)))
        # An old approval (extension id only, before versions) no longer counts.
        self.store.forget("ngspice")
        self.store.choose("ngspice", "ngspice", str(self.prog))
        self.store.approve("ext.a", "ngspice", str(self.prog))
        self.assertTrue(X.approval_needed(self.store, req, str(self.prog))["program"], "an approval without the version is not this version's")

    def approval_sequence(self, link):
        """(request overrides, program path, allow) in order; each step's decision depends on the earlier ones."""
        p = str(self.prog)
        return [({"args": ["-b", "-r", "out.raw", "deck.cir"]}, p, True), ({"args": ["-b", "-r", "out.raw", "deck.cir"]}, p, False),
                ({"args": ["-r", "tran.raw", "-b", "deck.cir"]}, p, False), ({"args": ["--out=x.raw", "deck.cir"]}, p, False),
                ({"args": ["-c", "my deck.cir"]}, p, True), ({"args": ["-c", "my deck.cir"]}, p, False), ({"args": ["-b", "/etc/passwd"]}, p, False),
                ({"args": ["--out=x.cir"]}, p, False), ({"args": ["-b", "deck.cir"], "extensionHash": V2}, p, False),
                ({"extensionHash": "sha256:xyz"}, p, False), ({"argTemplate": ["{input}{output}"]}, p, False), ({"extension": ""}, p, False),
                ({"args": ["-b", "deck.cir"]}, str(link), False), ({"args": ["-q", "deck.cir"], "extension": "ext.c"}, p, True),
                ({"args": ["-b"], "extension": "ext.c"}, p, False), ({"args": ["-b", "deck.cir"], "extension": "ext.c", "argTemplate": []}, p, False)]

    def raw_request(self, extra):
        r = {"tool": "ngspice", "args": ["-b", "deck.cir"], "files": [{"name": "deck.cir", "data": b64("* deck\n")}],
             "outputs": ["*.raw"], "timeoutMs": 10000, "maxOutputBytes": 4096, "runId": "ext.a:run1", "extension": "ext.a",
             "extensionHash": V1, "extensionName": "Sim", "toolName": "ngspice", "argTemplate": ["-b", "-r", "--out={output}"]}
        r.update(extra)
        return r

    def test_macos_host_makes_the_same_decisions(self):
        if sys.platform != "darwin" or not shutil.which("xcrun"):
            self.skipTest("not macOS")
        link = self.dir / "ngspice-link"
        os.symlink(self.prog, link)
        steps = self.approval_sequence(link)
        expected = []
        for extra, path, allow in steps:
            try:
                req = X.check_run(self.raw_request(extra))
            except X.ToolError as e:
                expected.append({"error": str(e)})
                continue
            need = X.approval_needed(self.store, req, path)
            expected.append(None if need is None else {"program": need["program"], "command": need["command"], "detail": need["detail"], "title": need["title"]})
            if need and allow:
                X.record_approval(self.store, req, need)
        native = Path(__file__).resolve().parents[1]
        build = self.dir / "swift"
        build.mkdir()
        (build / "main.swift").write_text(SWIFT_DRIVER)
        (build / "cases.json").write_text(json.dumps([{"request": self.raw_request(e), "path": p, "allow": a} for e, p, a in steps]))
        subprocess.run(["xcrun", "swiftc", "-swift-version", "5", "-module-cache-path", str(build / "cache"), str(native / "macos" / "ProjectWrites.swift"),
                        str(native / "macos" / "HostState.swift"), str(native / "macos" / "ExternalTools.swift"), str(build / "main.swift"),
                        "-o", str(build / "external-tools")], check=True)
        out = subprocess.run([str(build / "external-tools"), str(self.dir / "swift-support"), str(build / "cases.json")], capture_output=True, text=True, timeout=120)
        self.assertEqual(out.returncode, 0, out.stderr)
        got = json.loads(out.stdout)
        self.assertEqual([e and sorted(e) for e in got], [e and sorted(e) for e in expected])
        for i, (g, e) in enumerate(zip(got, expected)):
            self.assertEqual(g, e, "step %d: %r" % (i, steps[i][0]))
        self.assertEqual([None if e is None else "error" if "error" in e else (e["program"], e["command"]) for e in expected],
                         [(True, False), None, None, None, (False, True), None, (False, True), (False, True), (True, False),
                          "error", "error", "error", None, (True, True), None, (False, True)])

    def test_requests_name_the_extension_version_and_a_valid_template(self):
        for bad in [{"extensionHash": None}, {"extensionHash": "sha256:xyz"}, {"extension": ""}, {"extension": "a\nb"},
                    {"argTemplate": "x"}, {"argTemplate": [""]}, {"argTemplate": ["{input}{output}"]}, {"argTemplate": ["a\0"]}]:
            with self.assertRaises(X.ToolError, msg=str(bad)):
                self.request(**bad)
        self.assertEqual(self.request()["extension_key"], "ext.a@" + V1)

    def test_choices_and_approvals(self):
        self.assertEqual(self.store.listing(), {"tools": {}})
        with self.assertRaises(X.ToolError):
            self.store.choose("ngspice", "ngspice", str(self.dir))  # a folder is not a program
        with self.assertRaises(X.ToolError):
            self.store.choose("Bad Id", "x", str(self.prog))
        self.store.choose("ngspice", "ngspice", str(self.prog))
        self.assertEqual(self.store.listing()["tools"]["ngspice"]["path"], str(self.prog))
        self.assertFalse(self.store.approved("ext.a", "ngspice", str(self.prog)))
        self.store.approve("ext.a", "ngspice", str(self.prog))
        self.assertTrue(self.store.approved("ext.a", "ngspice", str(self.prog)))
        self.assertFalse(self.store.approved("ext.b", "ngspice", str(self.prog)), "approval is per extension")
        self.assertFalse(self.store.approved("ext.a", "ngspice", "/other"), "and per program path")
        self.assertEqual(oct(os.stat(self.store.path).st_mode & 0o777), "0o600")
        self.store.forget("ngspice")
        self.assertEqual(self.store.listing(), {"tools": {}})
        self.assertFalse(self.store.approved("ext.a", "ngspice", str(self.prog)), "forgetting a tool drops its approvals")

    def test_probe_only_reports_existing_programs(self):
        self.assertEqual(X.probe([str(self.prog), str(self.dir), "/nonexistent/x", 5, "relative"]), [str(self.prog)])

    def test_requests_are_checked(self):
        for bad in [{"args": ["a\0b"]}, {"args": "x"}, {"files": [{"name": "../x", "data": ""}]}, {"files": [{"name": "a/b", "data": ""}]},
                    {"outputs": ["../*"]}, {"outputs": ["/etc/*"]}, {"timeoutMs": 10**9}, {"maxOutputBytes": 1}, {"tool": "../x"}, {"runId": "a b"}]:
            with self.assertRaises((X.ToolError, ValueError), msg=str(bad)):
                self.request(**bad)

    def test_output_entry_limit(self):
        from unittest.mock import patch
        with patch.dict(X.LIMITS, output_entries=2):
            result = X.Runner().run(str(self.prog), self.request())
        self.assertTrue(result["truncated"])
        self.assertEqual(result["files"], [])

    def test_run(self):
        work_before = set(Path(tempfile.gettempdir()).glob("atrium-run-*"))
        out = X.Runner().run(str(self.prog), self.request(args=["-b", "deck.cir", "$(touch pwned)", "*"]))
        stdout = base64.b64decode(out["stdout"]).decode()
        self.assertEqual(out["exitCode"], 3)
        self.assertIn("args ['-b', 'deck.cir', '$(touch pwned)', '*']", stdout, "arguments reach the program as a list, unexpanded")
        self.assertIn("deck * deck", stdout)
        self.assertIn("atrium-run-", stdout, "it runs in a temporary folder")
        env = eval(next(l for l in stdout.splitlines() if l.startswith("env "))[4:])
        self.assertLessEqual(set(env) - {"PATH", "TMPDIR", "LANG", "HOME", "USER", "LOGNAME", "DISPLAY", "WAYLAND_DISPLAY", "XDG_RUNTIME_DIR", "WINEPREFIX", "LC_CTYPE", "__CF_USER_TEXT_ENCODING"}, set())
        self.assertEqual(base64.b64decode(out["stderr"]), b"warn\n")
        names = [f["name"] for f in out["files"]]
        self.assertEqual(names, ["out.raw"], "matching regular files under the cap; no symlinks; the oversize file is left out")
        self.assertTrue(out["truncated"])
        self.assertEqual(set(Path(tempfile.gettempdir()).glob("atrium-run-*")) - work_before, set(), "the temporary folder is deleted")
        self.assertFalse((self.dir / "pwned").exists())

    def test_output_cap(self):
        out = X.Runner().run(str(self.prog), self.request(args=["flood"], maxOutputBytes=1024))
        self.assertEqual(len(base64.b64decode(out["stdout"])), 1024)
        self.assertTrue(out["truncated"])

    def test_timeout_and_cancel(self):
        t = time.monotonic()
        out = X.Runner().run(str(self.prog), self.request(args=["sleep", "30"], timeoutMs=300))
        self.assertTrue(out["timedOut"])
        self.assertLess(time.monotonic() - t, 10)
        runner, result = X.Runner(), {}
        th = threading.Thread(target=lambda: result.update(runner.run(str(self.prog), self.request(args=["sleep", "30"], runId="ext.a:slow"))))
        th.start()
        for _ in range(100):
            if runner.cancel("ext.a:slow"):
                break
            time.sleep(0.05)
        th.join(10)
        self.assertTrue(result.get("cancelled"))
        self.assertFalse(runner.cancel("ext.a:slow"))

    def test_command_line_is_quoted_for_display(self):
        self.assertEqual(X.command_line("/usr/bin/ngspice", ["-b", "my deck.cir", "a'b"]), "/usr/bin/ngspice -b 'my deck.cir' 'a'\\''b'")


if __name__ == "__main__":
    unittest.main()
