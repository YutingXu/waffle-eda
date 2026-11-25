#!/usr/bin/env python3
"""Create a real saved binding before running the shared four-command gate."""

import json
from pathlib import Path
import runpy
import shutil
import tempfile

import sys as _test_sys
from pathlib import Path as _TestPath
_test_sys.path.insert(0, str((_TestPath(__file__).resolve().parent / "../support").resolve()))
from native_sample import ROOT, authored_files, ensure_native_host


FEATURE = "numericFields"
TARGET = {"scope":"item", "documentId":"timing", "itemId":"r5", "path":["value"]}
CASES = {
    "evaluate": {
        "args": {"source":"10mil + 0.1mm", "unit":"mm"},
        "expect": {"ok":True, "changes":0, "value":0.354},
    },
    "inspect": {
        "args": {"target":TARGET},
        "expect": {"ok":True, "changes":0},
        "expectPaths": {"untrusted_design_text.value":"20000"},
    },
    "set": {
        "args": {"target":TARGET, "source":"= 22 kΩ"},
        "expect": {"ok":True, "changes":2, "value":22000},
        "expectWrite": {"ok":True, "changes":2, "value":22000},
        "changedMembers": ["Project.waffle", "Timing.wsch"],
        "afterWrite": {"id":"inspect", "args":{"target":TARGET},
                       "expectPaths":{"untrusted_design_text.binding.source":" 22 kΩ"}},
    },
    "clear": {
        "args": {"target":TARGET},
        "expect": {"ok":True, "changes":1},
        "expectWrite": {"ok":True, "changes":1},
        "changedMembers": ["Project.waffle"],
        "afterWrite": {"id":"inspect", "args":{"target":TARGET},
                       "expectPaths":{"untrusted_design_text.value":"22000"}},
    },
}


def main():
    gate = runpy.run_path(str(ROOT / "tests/automation/butter-acceptance.py"))
    specs = gate["inventory"]([FEATURE])[FEATURE]
    ensure_native_host()
    with tempfile.TemporaryDirectory(prefix="waffle-numeric-acceptance-") as directory:
        folder = Path(directory).resolve() / "design"
        shutil.copytree(ROOT / "tests/fixtures/cad-native/calculation", folder)
        project = folder / "Project.waffle"
        flags = ("--enable-butter", FEATURE)
        with gate["Stdio"](gate["server"](project, *flags, "--allow-write")) as writer:
            seed = writer.check_tool("run_command", {"command":"butter.numericFields.set", "mode":"write",
                                                        "args":{"target":TARGET, "source":"= 20 kΩ"}})
            assert seed["ok"] and seed["value"] == 20000, seed
        gate["run_feature"](FEATURE, specs, project, authored_files(folder), {"cases":CASES})
        with gate["Stdio"](gate["server"](project, *flags)) as reader:
            receipt = reader.check_tool("run_command", {"command":"butter.numericFields.inspect", "args":{"target":TARGET}})
            result = {**receipt, **receipt.get("untrusted_design_text", {})}
            assert result["value"] == "22000" and result["binding"] is None, receipt
    coverage = {name: (["off", "read", "cliRead"] if spec["kind"] == "read" else
                       ["off", "plan", "cliPlan", "denied", "proposal", "write"]) for name, spec in specs.items()}
    print("BUTTER_COMMAND_COVERAGE " + json.dumps(coverage, sort_keys=True))


if __name__ == "__main__":
    main()
