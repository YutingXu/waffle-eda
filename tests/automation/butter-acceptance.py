#!/usr/bin/env python3
"""Check Butter descriptor, command discovery, and real CLI/stdio coverage."""

import argparse
from hashlib import sha256
import json
from pathlib import Path
import queue
import re
import shutil
import subprocess
import sys
import tempfile
from threading import Thread
from time import monotonic

import sys as _test_sys
from pathlib import Path as _TestPath
_test_sys.path.insert(0, str((_TestPath(__file__).resolve().parent / "../support").resolve()))
from native_sample import authored_files, ensure_native_host, make_sample
from butter_commands import feature_paths


ROOT = Path(__file__).resolve().parents[2]
SERVER = ROOT / "mcp/server.py"
FIXTURES = ROOT / "tests/fixtures/butter-acceptance"
FEATURES = ("numericFields", "query", "links", "visualHistory", "ai", "macros", "windows",
            "drop", "motion", "savedViews", "datasheets", "tables", "slides", "odb")
KINDS = {"read", "edit", "state", "output"}
SURFACES = ("editor", "macro", "mcp")
DEADLINE = 30


def expect(actual, expected, label, paths=None):
    assert expected or paths, f"{label}: assert at least one result field"
    assert all(key in actual and actual[key] == value for key, value in expected.items()), (label, actual, expected)
    for path, value in (paths or {}).items():
        found = actual
        for key in path.split("."):
            assert key and isinstance(found, dict) and key in found, (label, path, actual)
            found = found[key]
        assert found == value, (label, path, found, value)


def read_json(path):
    return json.loads(path.read_text(encoding="utf-8"))


def workspace_files(root):
    return {item.relative_to(root).as_posix(): sha256(item.read_bytes()).hexdigest()
            for item in root.rglob("*") if item.is_file()}


def make_project(root, cases):
    if "fixture" not in cases:
        return make_sample(root)
    templates = ROOT / "tests/fixtures"
    source = (ROOT / cases["fixture"]).resolve()
    manifest = Path(cases["manifest"])
    assert source.is_relative_to(templates) and source.is_dir(), source
    assert manifest.name == str(manifest) and manifest.suffix == ".waffle", manifest
    assert (source / manifest).is_file() and not any(item.is_symlink() for item in source.rglob("*")), source
    ensure_native_host()
    shutil.copytree(source, root, dirs_exist_ok=True)
    return root / manifest


def inventory(features):
    app = ROOT / "app"
    bindings = {feature: feature_paths(app, feature) for feature in FEATURES}
    known_paths = {binding[0] for binding in bindings.values() if binding is not None}
    unexpected = set((app / "automation/descriptors").glob("*.json")) - known_paths
    assert not unexpected, f"Unrecognized Butter descriptors: {sorted(unexpected)}"
    html = (ROOT / "app/index.html").read_text(encoding="utf-8")
    eager = set(re.findall(r'<script\b[^>]*\bsrc=["\']([^"\']+)["\']', html, re.I))
    commands = {}
    for feature in features:
        binding = bindings[feature]
        if binding is None or not binding[0].is_file():
            continue
        path, handler = binding
        source = read_json(path)
        assert source["feature"] == feature and source["title"], path
        assert handler.is_file(), f"Missing JS implementation for {path.name}: {handler}"
        assert not any(Path(file).name == handler.name for file in eager), f"Eager feature module: {handler}"
        entries = {}
        for spec in source["commands"]:
            local = spec["id"]
            assert local and local.lower() == local and all(c in "abcdefghijklmnopqrstuvwxyz0123456789-" for c in local), spec
            assert local not in entries and spec["title"] and spec["kind"] in KINDS, spec
            assert set(spec["required"]) <= set(spec["properties"]), spec
            assert set(spec.get("surfaces", SURFACES)) <= set(SURFACES), spec
            entries[local] = spec
        assert entries, path
        commands[feature] = entries
    return commands


class Stdio:
    def __init__(self, command):
        self.command = command
        self.replies = queue.Queue()
        self.sequence = 0

    def __enter__(self):
        self.process = subprocess.Popen(self.command, stdin=subprocess.PIPE, stdout=subprocess.PIPE, text=True)

        def receive():
            for line in self.process.stdout:
                self.replies.put(line)
            self.replies.put(None)

        self.reader = Thread(target=receive, daemon=True)
        self.reader.start()
        try:
            self.request("initialize", {"protocolVersion": "2025-11-25"})
        except BaseException:
            self.__exit__()
            raise
        return self

    def __exit__(self, *_):
        self.process.stdin.close()
        try:
            self.process.wait(timeout=2)
        except subprocess.TimeoutExpired:
            self.process.kill()
            self.process.wait(timeout=2)
        self.reader.join(timeout=2)
        self.process.stdout.close()

    def request(self, method, params):
        self.sequence += 1
        payload = {"jsonrpc": "2.0", "id": self.sequence, "method": method, "params": params}
        self.process.stdin.write(json.dumps(payload) + "\n")
        self.process.stdin.flush()
        response = self.replies.get(timeout=DEADLINE)
        assert response is not None, f"MCP exited during {payload}"
        reply = json.loads(response)
        assert reply["id"] == self.sequence and "result" in reply, reply
        return reply["result"]

    def check_tool(self, name, args, *, denied=False):
        result = self.request("tools/call", {"name": name, "arguments": args})
        assert result["isError"] == denied, (name, args, result)
        if denied:
            return result["structuredContent"]["error"]
        return json.loads(result["content"][0]["text"])


def server(project, *flags):
    return [sys.executable, "-B", str(SERVER), "--project", str(project), *flags]


def public_schema(spec):
    return {"type": "object", "properties": spec["properties"], "required": spec["required"],
            "additionalProperties": False, "maxProperties": 64}


def public_commands(feature, specs):
    return {f"butter.{feature}.{local}": spec for local, spec in specs.items()
            if "mcp" in spec.get("surfaces", SURFACES)}


def graduated_features():
    """Features out of beta: on in every workspace. The MCP list must match the editor's (prefs.js)."""
    sys.path.insert(0, str(ROOT / "mcp"))
    from server import GRADUATED_BUTTER
    prefs = (ROOT / "app/editor/prefs.js").read_text(encoding="utf-8")
    listed = re.search(r"const GRADUATED = Object\.freeze\(\[([^\]]*)\]\);", prefs)
    assert listed, "app/editor/prefs.js declares GRADUATED"
    editor = {name for name in re.findall(r'"([a-z][A-Za-z0-9]*)"', listed[1])}
    assert editor == set(GRADUATED_BUTTER), ("editor and MCP graduated features differ", sorted(editor), sorted(GRADUATED_BUTTER))
    assert editor <= set(FEATURES), editor
    return tuple(sorted(editor))


GRADUATED = graduated_features()


def default_commands():
    """The Butter commands every MCP workspace lists without --enable-butter."""
    return {name: spec for feature, specs in inventory(GRADUATED).items() for name, spec in public_commands(feature, specs).items()}


def verify_listing(client, current):
    current = {**default_commands(), **current}
    discovered = client.check_tool("list_commands", {})
    rows = {row["command"]: row for row in discovered["commands"] if row["command"].startswith("butter.")}
    assert set(rows) == set(current), (sorted(rows), sorted(current))
    for name, spec in current.items():
        assert rows[name]["kind"] == spec["kind"], (name, rows[name])
        assert rows[name]["schema"] == public_schema(spec), (name, rows[name])
    tools = client.request("tools/list", {})["tools"]
    for tool in ("list_commands", "run_command"):
        row = next(row for row in tools if row["name"] == tool)
        commands = row["inputSchema"]["properties"]["command"]["enum"]
        assert {name for name in commands if name.startswith("butter.")} == set(current), (tool, current)


def verify_off(client):
    verify_listing(client, {})
    summary = client.check_tool("project_summary", {})
    assert re.fullmatch(r"[0-9a-f]{64}", summary["file_revision"]), summary


def verify_denial(client, call, code):
    denial = client.check_tool("run_command", call, denied=True)
    assert denial["code"] == code and denial["retryable"] is False, (call, denial)


def verify_disabled(client, call):
    for mode in ("plan", "write"):
        verify_denial(client, dict(call, mode=mode), "butter_disabled")


def verify_host_cases(feature, cases):
    for name, case in cases.items():
        assert case["platform"] == sys.platform, f"{feature}.{name}: run actual host proof on {case['platform']}"
        path = (ROOT / case["test"]).resolve()
        assert path.is_file() and path.is_relative_to(ROOT / "native/tests"), f"{feature}.{name}: missing native regression"
        launcher = {".py": sys.executable, ".sh": "/bin/zsh"}.get(path.suffix)
        assert launcher and case["marker"], (feature, name, case)
        result = subprocess.run([launcher, str(path), *case.get("args", [])], cwd=ROOT, text=True,
                                capture_output=True, check=True, timeout=DEADLINE)
        assert case["marker"] in result.stdout.splitlines(), (feature, name, result.stdout)
        print(f"PASS {feature}.{name} native · {sys.platform}")


def run_dynamic_feature(feature, specs, fixture):
    """Use a feature's real fixture when the caller needs per-run native authority."""
    root = ROOT / "tests"
    suite = (ROOT / fixture["dynamicSuite"]).resolve()
    assert suite.is_relative_to(root) and suite.name.startswith("butter-") and suite.suffix == ".py" and suite.is_file(), suite
    assert "cases" not in fixture, f"{feature}: use a static fixture or one owned dynamic suite"
    public = public_commands(feature, specs)
    names = {name.rsplit(".", 1)[1]: spec for name, spec in public.items()}
    session_cli = fixture.get("sessionOnlyCli", [])
    assert isinstance(session_cli, list) and set(session_cli) <= names.keys() and len(set(session_cli)) == len(session_cli)
    host_cases = fixture.get("hostCases", {})
    assert set(host_cases) == set(specs) - names.keys(), f"{feature}: account for host-only commands"
    result = subprocess.run([sys.executable, "-B", str(suite)], cwd=ROOT, text=True, capture_output=True, timeout=120)
    assert result.returncode == 0, (feature, result.stdout, result.stderr)
    prefix = "BUTTER_COMMAND_COVERAGE "
    rows = [line[len(prefix):] for line in result.stdout.splitlines() if line.startswith(prefix)]
    assert len(rows) == 1, (feature, "Expected one command coverage receipt", result.stdout)
    coverage = json.loads(rows[0])
    assert set(coverage) == set(names), (feature, "Dynamic command receipt mismatch", sorted(set(coverage) ^ set(names)))
    for name, spec in names.items():
        required = {"off", "read", "cliRead"} if spec["kind"] == "read" else {"off", "plan", "cliPlan", "denied", "write"}
        if spec["kind"] == "edit":
            required.add("proposal")
        if name in session_cli:
            required.remove("cliRead" if spec["kind"] == "read" else "cliPlan")
            required.add("cliNoSession")
        outcomes = coverage[name]
        assert isinstance(outcomes, list) and set(outcomes) == required and len(outcomes) == len(required), (feature, name, sorted(required), outcomes)
    verify_host_cases(feature, host_cases)
    print(f"PASS {feature} · {len(names)} commands on CLI and real stdio with dynamic fixture authority")


def run_feature(feature, specs, project, original, source):
    started = monotonic()
    flags = ("--enable-butter", feature)
    root = project.parent
    public = public_commands(feature, specs)
    cases = {f"butter.{feature}.{local}": case for local, case in source["cases"].items()}
    host_cases = source.get("hostCases", {})
    host_only = set(specs) - {name.rsplit(".", 1)[1] for name in public}
    assert set(host_cases) == host_only, f"{feature}: identify each host-only command and its real-host evidence"
    assert set(cases) == set(public), (feature, "MCP cases must cover exactly the descriptor", sorted(set(cases) ^ set(public)))
    initial_files = workspace_files(root)
    with Stdio(server(project, "--allow-write")) as disabled:
        verify_off(disabled)
        if feature not in GRADUATED:
            for name, case in cases.items():
                verify_disabled(disabled, {"command": name, "args": case["args"]})
        assert workspace_files(root) == initial_files, f"{feature}: default or disabled calls changed workspace bytes"
    if feature in GRADUATED:
        # On by default: the cases below run without a flag, and the old flag is still accepted.
        with Stdio(server(project, *flags)) as flagged:
            verify_listing(flagged, public)
        flags = ()
    with Stdio(server(project, *flags)) as enabled:
        verify_listing(enabled, public)
        for name, case in cases.items():
            spec = public[name]
            call = {"command": name, "args": case["args"], "mode": "plan"}
            if spec["kind"] == "read":
                call.pop("mode")
            prior = workspace_files(root)
            expect(enabled.check_tool("run_command", call), case.get("expect", {}), name, case.get("expectPaths"))
            cli = subprocess.run([*server(project, *flags), "--cli", "run_command", "--args", json.dumps(call)],
                                 check=True, capture_output=True, text=True, timeout=DEADLINE)
            expect(json.loads(cli.stdout), case.get("expectCLI", case.get("expect", {})), name + " CLI",
                   case.get("expectCLIPaths", case.get("expectPaths")))
            assert workspace_files(root) == prior, f"{name}: planned or read command changed workspace bytes"
            if spec["kind"] == "read":
                continue
            verify_denial(enabled, dict(call, mode="write"), "write_not_allowed")
            assert workspace_files(root) == prior, f"{name}: denied write changed workspace bytes"
            if spec["kind"] == "edit":
                result = enabled.check_tool("run_command", dict(call, mode="proposal"))
                proposal = Path(result["proposal_file"]).resolve()
                assert proposal.is_relative_to(root) and proposal.suffix == ".waffle-ai", (name, result)
                assert sha256(proposal.read_bytes()).hexdigest() == result["sha256"], (name, result)
                assert workspace_files(root) == prior | {proposal.relative_to(root).as_posix(): result["sha256"]}, name
            assert authored_files(root) == original, f"{name}: plan or proposal changed authored bytes"
        assert authored_files(root) == original, f"{feature}: read-only feature calls changed project bytes"
    with Stdio(server(project, *flags, "--allow-write")) as authorized:
        for name, case in cases.items():
            kind = public[name]["kind"]
            if kind == "read":
                continue
            prior = authored_files(root)
            result = authorized.check_tool("run_command", {"command": name, "args": case["args"], "mode": "write"})
            expect(result, case.get("expectWrite", {}), name + " write", case.get("expectWritePaths"))
            after = authored_files(root)
            changed = {path for path in prior.keys() | after.keys() if prior.get(path) != after.get(path)}
            required = set(case.get("changedMembers", []))
            assert (kind == "edit") == bool(required) and changed == required, (name, changed, required)
            if kind == "output":
                output = (root / case["outputFile"]).resolve()
                assert output.is_relative_to(root) and output.is_file() and output.stat().st_size > 0, (name, output)
            if "afterWrite" in case:
                probe = case["afterWrite"]
                result = authorized.check_tool("run_command", {"command": f"butter.{feature}.{probe['id']}",
                                                                "args": probe["args"]})
                expect(result, probe.get("expect", {}), name + " readback", probe.get("expectPaths"))
    verify_host_cases(feature, host_cases)
    print(f"PASS {feature} · {len(cases)} commands on CLI and real stdio in {monotonic() - started:.2f}s")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--feature", choices=FEATURES, action="append", help="Exercise a bounded feature set")
    mode = parser.add_mutually_exclusive_group()
    mode.add_argument("--inventory", action="store_true", help="Inspect progress without issuing acceptance")
    mode.add_argument("--smoke", action="store_true", help="Check an unchanged native read with every beta flag off")
    args = parser.parse_args()
    if args.smoke:
        with tempfile.TemporaryDirectory(prefix="waffle-butter-smoke-") as scratch:
            project = make_sample(Path(scratch).resolve())
            initial = workspace_files(project.parent)
            with Stdio(server(project)) as client:
                verify_off(client)
            assert initial == workspace_files(project.parent), "Default commands changed workspace bytes"
        print(f"PASS native stdio smoke with every beta flag off ({', '.join(GRADUATED)} on by default) and workspace unchanged")
        return
    features = tuple(dict.fromkeys(args.feature or FEATURES))
    commands = inventory(features)
    for feature in features:
        if feature in commands:
            print(f"{feature}: {len(commands[feature])} descriptor commands")
        else:
            print(f"{feature}: pending descriptor")
    if args.inventory:
        return
    missing = [feature for feature in features if feature not in commands or not (FIXTURES / f"{feature}.json").is_file()]
    if missing:
        sys.exit("Missing descriptor or acceptance fixture: " + ", ".join(missing))
    if not args.feature:
        subprocess.run([str(ROOT / "scripts/startup-budget.sh"), "--static"], cwd=ROOT, check=True)
    if len(features) > 1:
        selected = tuple(arg for feature in features for arg in ("--enable-butter", feature))
        public = {name: spec for feature in features for name, spec in public_commands(feature, commands[feature]).items()}
        with tempfile.TemporaryDirectory(prefix="waffle-butter-discovery-") as scratch:
            project = make_sample(Path(scratch).resolve())
            with Stdio(server(project, *selected)) as client:
                verify_listing(client, public)
        print(f"PASS combined discovery · {len(public)} commands across {len(features)} features")
    for feature in features:
        cases = read_json(FIXTURES / f"{feature}.json")
        if "dynamicSuite" in cases:
            run_dynamic_feature(feature, commands[feature], cases)
            continue
        with tempfile.TemporaryDirectory(prefix="waffle-butter-acceptance-") as scratch:
            project = make_project(Path(scratch).resolve(), cases)
            run_feature(feature, commands[feature], project, authored_files(project.parent), cases)


if __name__ == "__main__":
    main()
