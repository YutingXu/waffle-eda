#!/usr/bin/env python3
"""Exercise ODB++ through the production CLI and a disposable native project."""
import hashlib
import io
import json
from pathlib import Path
import subprocess
import sys
import tarfile
import tempfile
import unittest

import sys as _test_sys
from pathlib import Path as _TestPath
_test_sys.path.insert(0, str((_TestPath(__file__).resolve().parent / "../support").resolve()))
from native_sample import ROOT, authored_files, make_sample, write_design


DATE = "2026-01-02T03:04:05Z"
COMMAND = "butter.odb.export"
PRESET = "ODB++ fabrication"


def cli(project, tool, args, *, enabled=False, write=False):
    options = (["--enable-butter", "odb"] if enabled else []) + (["--allow-write"] if write else [])
    return subprocess.run([sys.executable, "-B", str(ROOT / "mcp/server.py"), "--project", str(project),
                           *options, "--cli", tool, "--args", json.dumps(args)], cwd=ROOT,
                          text=True, capture_output=True, timeout=30)


def receipt(project, tool, args, **opts):
    result = cli(project, tool, args, **opts)
    if result.returncode:
        raise AssertionError(result.stderr + result.stdout)
    return json.loads(result.stdout)


def archive(data):
    with tarfile.open(fileobj=io.BytesIO(data), mode="r:gz") as bundle:
        members = [member for member in bundle if member.isfile()]
        roots = {member.name.split("/")[0] for member in members}
        if len(roots) != 1:
            raise AssertionError(roots)
        return {member.name.split("/", 1)[1]: bundle.extractfile(member).read() for member in members}


class ButterODB(unittest.TestCase):
    def test_isolated_inner_land_choice_reaches_all_output_routes(self):
        with tempfile.TemporaryDirectory(prefix="waffle-odb-inner-land-") as scratch:
            option = {"origin": "absolute", "omitUnconnectedMidLayerPads": True}
            jobs = {"name": "Inner lands", "outputs": [
                {"id": "odb", "kind": "odb", "options": option},
                {"id": "gerber", "kind": "gerber", "options": option},
            ]}
            board = {"id": "pcb", "kind": "pcb", "name": "Board", "grid": .25, "notes": [],
                     "outline": [[0, 0], [12, 0], [12, 10], [0, 10]], "items": [
                         {"id": "v", "kind": "via", "layer": "Multi", "x": 3, "y": 4, "diameter": .6, "drill": .3},
                         {"id": "t", "kind": "track", "layer": "Inner 1", "width": .2, "points": [[8, 4], [9, 4]]},
                     ]}
            project = write_design(Path(scratch) / "Board.waffle", {"name": "Board", "documents": [board], "outputJobs": [jobs]})
            project_files = authored_files(project.parent)

            def delivered(result, suffix):
                return next(Path(f["path"]).read_bytes() for f in result["files"] if f["name"].endswith(suffix))

            settings = {"date": DATE, **option}
            default = receipt(project, "export_design", {"translator": "odb", "options": {"date": DATE, "origin": "absolute"}}, enabled=True)
            kept = archive(delivered(default, ".tgz"))
            selected = receipt(project, "export_design", {"translator": "odb", "options": settings}, enabled=True)
            shrunk = delivered(selected, ".tgz")
            plotted = archive(shrunk)
            inner = "steps/pcb/layers/inner_1/features"
            self.assertIn(b"\nP 3 -4 ", kept[inner])
            self.assertNotIn(b"\nP 3 -4 ", plotted[inner])
            for name in ("top", "bottom", "drill_plated"):
                layer = f"steps/pcb/layers/{name}/features"
                self.assertEqual(kept[layer], plotted[layer])

            command = receipt(project, "run_command", {"command": COMMAND, "args": settings, "mode": "write"}, enabled=True, write=True)
            self.assertEqual(Path(command["path"]).read_bytes(), shrunk)
            gerber = receipt(project, "export_design", {"translator": "gerber", "options": settings})
            self.assertNotIn(b"D03*", delivered(gerber, ".G1"))
            job = receipt(project, "run_output_job", {"job": "Inner lands", "date": DATE}, enabled=True)
            self.assertTrue(job["ok"])
            self.assertEqual(delivered(job, ".tgz"), shrunk)
            self.assertEqual(delivered(job, ".G1"), delivered(gerber, ".G1"))
            self.assertEqual(authored_files(project.parent), project_files)

    def test_disabled_plan_write_and_confined_outputs(self):
        with tempfile.TemporaryDirectory(prefix="waffle-odb-native-") as scratch:
            project = make_sample(Path(scratch).resolve() / "Project")
            project_files = authored_files(project.parent)
            command = {"command": COMMAND, "args": {"date": DATE}}
            off = cli(project, "export_design", {"translator": "odb"})
            self.assertNotEqual(off.returncode, 0)
            self.assertIn("--enable-butter odb", off.stderr)
            listed = receipt(project, "run_output_job", {"list": True})
            self.assertNotIn("odb", listed["kinds"])
            plans = receipt(project, "run_command", {**command, "mode": "plan"}, enabled=True)
            self.assertEqual(plans["untrusted_design_text"]["target"], "Sensor board")
            self.assertEqual(plans["untrusted_design_text"]["format"], "ODB++ Design 8.1")
            self.assertIsNone(plans.get("path"))
            refused = cli(project, "run_command", {**command, "mode": "write"}, enabled=True)
            self.assertNotEqual(refused.returncode, 0)
            self.assertIn("--allow-write", refused.stderr)
            self.assertFalse(list(project.parent.rglob("*.tgz")))

            published = receipt(project, "run_command", {**command, "mode": "write"}, enabled=True, write=True)
            target = Path(published["path"])
            self.assertTrue(target.is_relative_to(project.parent))
            data = target.read_bytes()
            entries = archive(data)
            self.assertTrue(entries["matrix/matrix"].startswith(b"STEP {"))
            self.assertEqual(entries["steps/pcb/netlists/cadnet/netlist"].splitlines()[:2], [b"UNITS=MM", b"H optimize n"])
            self.assertIn(b"ODB_VERSION_MINOR=1", entries["misc/info"])
            self.assertIn(b"CMP ", entries["steps/pcb/layers/comp_+_top/components"])
            self.assertIn(b"SNT TOP", entries["steps/pcb/eda/data"])
            self.assertEqual(published["sha256"], hashlib.sha256(data).hexdigest())

            translated = receipt(project, "export_design", {"translator": "odb", "options": {"date": DATE}}, enabled=True)
            translated_path = next(Path(f["path"]) for f in translated["files"] if f["name"].endswith(".tgz"))
            self.assertEqual(translated_path.read_bytes(), data)
            command_result = published["untrusted_design_text"]
            self.assertEqual(command_result["report"], translated["report"])
            self.assertEqual(command_result["stats"], translated["details"]["stats"])
            self.assertNotIn("publication", command_result)

            job = receipt(project, "run_output_job", {"job": PRESET, "date": DATE}, enabled=True)
            job_file = next(Path(f["path"]) for f in job["files"] if f["name"].endswith(".tgz"))
            self.assertEqual(job_file.read_bytes(), data)
            self.assertTrue(job["ok"])

            # The shipped sample contains deliberate DRC/ERC findings. Record the
            # explicit fixture-only overrides through the real release gate.
            release = receipt(project, "release", {"job": PRESET, "date": DATE, "mode": "write",
                              "overrides": [{"check": gate, "reason": "Expected fixture findings."} for gate in ("drc", "erc")]},
                              enabled=True, write=True)
            final = next(Path(f["path"]) for f in release["files"] if f["name"].endswith(".tgz"))
            self.assertEqual(final.read_bytes(), data)
            self.assertEqual(authored_files(project.parent), project_files)


if __name__ == "__main__":
    unittest.main()
