"""Run every Task 50 command through the project-bound MCP stdio transport."""
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import unittest

import sys as _test_sys
from pathlib import Path as _TestPath
_test_sys.path.insert(0, str((_TestPath(__file__).resolve().parent / "../automation").resolve()))
from mcp import Client, SERVER
import sys as _test_sys
from pathlib import Path as _TestPath
_test_sys.path.insert(0, str((_TestPath(__file__).resolve().parent / "../support").resolve()))
from native_sample import authored_files, ensure_native_host


class MotionCommands(Client, unittest.TestCase):
    def setUp(self):
        ensure_native_host()
        temp = tempfile.TemporaryDirectory(prefix="waffle-butter-motion-")
        self.addCleanup(temp.cleanup)
        self.root = Path(temp.name) / "Workshop"
        shutil.copytree(SERVER.parent.parent / "tests/fixtures/format-2/workshop", self.root)

    def start(self, *args):
        self.proc = subprocess.Popen(
            [sys.executable, str(SERVER), "--project", str(self.root / "Reference.waffle"), *args],
            stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, bufsize=1,
        )
        self.addCleanup(self.stop_server)
        self.seq = 0
        self.initialize()

    def run_motion(self, local, args=None, *, mode=None, error=False):
        payload = {"command": "butter.motion." + local, "args": args or {}}
        if mode is not None:
            payload["mode"] = mode
        return self.tool("run_command", payload, error=error, timeout=12)

    def test_disabled(self):
        self.start()
        self.assertFalse(any(c["command"].startswith("butter.motion.") for c in self.tool("list_commands")["commands"]))
        self.assertIn("disabled", self.run_motion("policy", error=True))

    def test_enabled_read_only(self):
        before = authored_files(self.root)
        self.start("--enable-butter", "motion", "--allow-write")
        commands = {c["command"].rsplit(".", 1)[-1]: c for c in self.tool("list_commands")["commands"]
                    if c["command"].startswith("butter.motion.")}
        self.assertEqual(set(commands), {"plan", "policy", "retarget", "sample"})
        for command in commands.values():
            self.assertEqual(command["kind"], "read")
            self.assertIs(command["schema"]["additionalProperties"], False)

        policy = self.run_motion("policy", {"requested": "full", "osReduced": True, "visibility": "occluded", "pointerHover": True})
        self.assertEqual(policy["untrusted_design_text"]["level"], "reduced")
        self.assertTrue(policy["opacity"])
        self.assertTrue(policy["suspended"])
        self.assertFalse(policy["travel"])
        self.assertFalse(policy["hover"])
        timing = self.run_motion("plan", {"kind": "camera", "duration": "slow", "visibility": "hidden"}, mode="plan")
        self.assertEqual(timing["mode"], "plan")
        self.assertEqual(timing["durationMs"], 320)
        self.assertEqual(timing["untrusted_design_text"]["disposition"], "paused")
        args = {"from": 0, "to": 80, "elapsedMs": 50, "durationMs": 200, "curve": "linear"}
        sample = self.run_motion("sample", args)
        self.assertEqual((sample["value"], sample["progress"], sample["finished"]), (20, 0.25, False))
        redirected = self.run_motion("retarget", dict(args, previousTarget=80, to=-40, nextDurationMs=140))
        self.assertEqual((redirected["from"], redirected["to"], redirected["durationMs"]), (20, -40, 140))
        self.assertEqual(redirected["untrusted_design_text"]["previous"]["value"], sample["value"])
        self.assertTrue(all(r["changes"] == 0 for r in (policy, timing, sample, redirected)))
        self.assertIn("durationMs", self.run_motion("sample", dict(args, durationMs=-1), error=True))
        self.assertIn("unknown", self.run_motion("policy", {"displayClock": True}, error=True).lower())
        self.assertIn("mode", self.run_motion("sample", args, mode="write", error=True))
        self.assertEqual(authored_files(self.root), before)
        self.assertFalse(list(self.root.rglob("*.waffle-ai")))


if __name__ == "__main__":
    unittest.main()
