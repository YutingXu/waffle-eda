#!/usr/bin/env python3
"""Exercise the six workspace commands against a disposable native folder."""

import json
from pathlib import Path
from runpy import run_path
import subprocess
import sys
import tempfile

import sys as _test_sys
from pathlib import Path as _TestPath
_test_sys.path.insert(0, str((_TestPath(__file__).resolve().parent / "../support").resolve()))
from native_sample import ROOT, authored_files, make_sample

SHARED = run_path(str(ROOT / "tests/automation/butter-acceptance.py"))
Stdio, server = SHARED["Stdio"], SHARED["server"]


def call(manifest, action, args=None, *, mode=None, enabled=True, authorized=False, failure=None):
    command = [sys.executable, "-B", str(ROOT / "mcp/server.py"), "--project", str(manifest)]
    if enabled:
        command += ["--enable-butter", "windows"]
    if authorized:
        command.append("--allow-write")
    request = {"command": "butter.windows." + action, "args": args or {}}
    if mode:
        request["mode"] = mode
    result = subprocess.run([*command, "--cli", "run_command", "--args", json.dumps(request)],
                            capture_output=True, text=True, timeout=45)
    if failure:
        assert result.returncode and failure in result.stderr + result.stdout, (result.stdout, result.stderr)
        return None
    assert not result.returncode, (result.stdout, result.stderr)
    value = json.loads(result.stdout)
    assert value["virtual"] and value["command"] == request["command"], value
    return {**value, **value.get("untrusted_design_text", {})}


def check():
    with tempfile.TemporaryDirectory(prefix="waffle-window-workspace-") as scratch:
        root = Path(scratch) / "design"
        manifest = make_sample(root)
        source = authored_files(root)
        local = root / ".waffle/local/project-windows-headless-v1.json"
        call(manifest, "list-windows", enabled=False, failure="feature is disabled")
        initial = call(manifest, "list-windows")["layout"]
        assert len(initial["windows"]) == 1 and len(initial["windows"][0]["tabs"]) > 1
        plan = call(manifest, "move-tab-to-new-window", mode="plan")["layout"]
        assert len(plan["windows"]) == 2 and not local.exists()
        call(manifest, "move-tab-to-new-window", mode="write", failure="--allow-write")
        assert not local.exists()
        split = call(manifest, "move-tab-to-new-window", mode="write", authorized=True)["layout"]
        assert len(split["windows"]) == 2 and local.is_file()
        assert call(manifest, "list-windows")["layout"] == split
        call(manifest, "save-workspace-layout", {"name": "Review"}, mode="write", authorized=True)
        assert call(manifest, "list-workspace-layouts")["layouts"] == ["Review"]
        merged = call(manifest, "merge-all-windows", mode="write", authorized=True)["layout"]
        assert len(merged["windows"]) == 1
        restored = call(manifest, "restore-workspace-layout", {"name": "Review"}, mode="write", authorized=True)["layout"]
        assert restored == split and authored_files(root) == source
        call(manifest, "restore-workspace-layout", {"name": "Other"}, mode="plan", failure="no workspace layout")
        assert call(manifest, "list-windows")["layout"] == split
    print("All six workspace commands reuse the layout engine and protect authored project members")


def coverage():
    descriptor = json.loads((ROOT / "app/automation/descriptors/windows.json").read_text())
    report = {}
    flags = ("--enable-butter", "windows")
    with tempfile.TemporaryDirectory(prefix="waffle-workspace-stdio-") as scratch:
        project = make_sample(Path(scratch) / "design")
        root = project.parent
        authored = authored_files(root)
        local = root / ".waffle/local/project-windows-headless-v1.json"
        specs = {spec["id"]: spec for spec in descriptor["commands"]}
        public = SHARED["public_commands"]("windows", specs)
        files = SHARED["workspace_files"]
        with Stdio(server(project, "--allow-write")) as disabled, Stdio(server(project, *flags)) as enabled, \
                Stdio(server(project, *flags, "--allow-write")) as authorized:
            SHARED["verify_off"](disabled)
            SHARED["verify_listing"](enabled, public)
            for command, spec in public.items():
                action, kind = spec["id"], spec["kind"]
                args = {"name": "Review"} if "name" in spec["required"] else {}
                request = {"command": command, "args": args}
                before = files(root)
                SHARED["verify_disabled"](disabled,request)
                statuses = ["off"]
                result = enabled.check_tool("run_command", request)
                assert result["virtual"] is True and result["mode"] == ("read" if kind == "read" else "plan")
                cli = call(project, action, args)
                assert cli["virtual"] is True and cli["mode"] == result["mode"]
                statuses.extend(["read", "cliRead"] if kind == "read" else ["plan", "cliPlan"])
                if kind == "state":
                    SHARED["verify_denial"](enabled,dict(request, mode="write"),"write_not_allowed")
                    statuses.append("denied")
                assert files(root) == before, request
                if kind == "state":
                    written = authorized.check_tool("run_command", dict(request, mode="write"))
                    assert written["virtual"] is True and written["mode"] == "write" and local.is_file()
                    statuses.append("write")
                assert authored_files(root) == authored
                report[action] = statuses
    print("BUTTER_COMMAND_COVERAGE " + json.dumps(report, sort_keys=True))


if __name__ == "__main__":
    check()
    coverage()
