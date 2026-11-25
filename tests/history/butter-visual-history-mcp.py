#!/usr/bin/env python3
"""Qualify Visual History on a real bound stdio connection and an isolated Git repository."""
import json
from pathlib import Path
import runpy
import subprocess
import sys
import tempfile
from time import monotonic
from unittest import TestCase

ROOT = Path(__file__).resolve().parents[2]
PREFIX = "butter.visualHistory."
DESCRIPTOR = json.loads((ROOT / "app/automation/descriptors/visual-history.json").read_text(encoding="utf8"))
SPECS = {c["id"]: c for c in DESCRIPTOR["commands"]}
SESSION_ONLY_READS = frozenset({"session-list", "session-preview", "session-compare", "session-thumbnail",
                               "clipboard-list", "clipboard-preview"})
Client = runpy.run_path(str(ROOT / "tests/automation/mcp.py"))["Client"]
fixture = runpy.run_path(str(ROOT / "tests/history/project-history.py"))
git, make_history, authored_files = (fixture[name] for name in ("git", "make_history", "authored_files"))


def server(project, *flags):
    return [sys.executable, "-B", str(ROOT / "mcp/server.py"), "--project", str(project), *flags]


class Stdio(Client, TestCase):
    def __init__(self, command):
        super().__init__()
        self.command = command
        self.seq = 0

    def __enter__(self):
        self.proc = subprocess.Popen(self.command, stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                                     stderr=subprocess.PIPE, text=True)
        try:
            self.initialize()
        except BaseException:
            self.stop_server()
            raise
        return self

    def __exit__(self, *_):
        self.stop_server()

    def check_tool(self, name, args, *, denied=False):
        response = self.request("tools/call", {"name": name, "arguments": args}, timeout=30)["result"]
        assert response["isError"] == denied, (name, args, response)
        return response["structuredContent"]["error"] if denied else json.loads(response["content"][0]["text"])


def listed(client):
    return {row["command"] for row in client.check_tool("list_commands", {})["commands"]
            if row["command"].startswith(PREFIX)}


def command(client, id, args=None, *, mode=None, denied=False):
    payload = {"command": PREFIX + id, "args": args or {}}
    if mode:
        payload["mode"] = mode
    result = client.check_tool("run_command", payload, denied=denied)
    return {**result, **(result.get("untrusted_design_text") or {})}


def cli_command(project, id, args, mode):
    payload = json.dumps({"command": PREFIX + id, "args": args or {}, "mode": mode})
    run = subprocess.run([*server(project, "--enable-butter", "visualHistory"),
                          "--cli", "run_command", "--args", payload],
                         capture_output=True, text=True, timeout=30)
    if id in SESSION_ONLY_READS:
        assert run.returncode == 1 and not run.stdout.strip(), (id, run)
        assert "Open an MCP history session on the bound design first." in run.stderr, (id, run.stderr)
        return "cliNoSession"
    assert run.returncode == 0, (id, run.stderr)
    result = json.loads(run.stdout)
    assert result["command"] == PREFIX + id and result["changes"] == 0, (id, result)
    if mode == "plan":
        assert result.get("requiresWrite", result.get("untrusted_design_text", {}).get("requiresWrite")) is True, (id, result)
        return "cliPlan"
    return "cliRead"


def branch_state(folder):
    return (git(folder, "symbolic-ref", "HEAD", capture_output=True).stdout,
            git(folder, "rev-parse", "HEAD", capture_output=True).stdout,
            (folder / ".git/index").read_bytes(), (folder / ".git/config").read_bytes())


def test(project):
    folder = project.parent
    original = authored_files(folder)
    state = branch_state(folder)
    covered = {id: set() for id in SPECS}
    current = {PREFIX + id for id in SPECS}
    with Stdio(server(project, "--allow-write")) as disabled:
        assert listed(disabled) == set()
        for id in SPECS:
            for mode in ("plan", "write"):
                error = command(disabled, id, mode=mode, denied=True)
                assert error["code"] == "butter_disabled", (id, mode, error)
            covered[id].add("off")
    with Stdio(server(project, "--enable-butter", "visualHistory")) as read_only:
        assert listed(read_only) == current
        assert command(read_only, "session-open", mode="plan")["requiresWrite"]
        assert command(read_only, "session-open", mode="write", denied=True)["code"] == "write_not_allowed"
        assert command(read_only, "git-list", {"limit": 1})["repository"]
    assert authored_files(folder) == original
    assert branch_state(folder) == state

    with Stdio(server(project, "--enable-butter", "visualHistory")) as read_only, \
            Stdio(server(project, "--enable-butter", "visualHistory", "--allow-write")) as client:
        assert listed(client) == current

        def call(id, args=None, denied=False):
            kind = SPECS[id]["kind"]
            mode = "write" if kind == "state" else "read"
            outcomes = covered[id]
            if not denied and mode not in outcomes:
                assert kind in ("read", "state"), (id, kind)
                if kind == "state":
                    assert command(read_only, id, args, mode="plan")["requiresWrite"], id
                    assert command(read_only, id, args, mode="write", denied=True)["code"] == "write_not_allowed", id
                    outcomes.update(("plan", "denied"))
                outcomes.add(cli_command(project, id, args, "read" if kind == "read" else "plan"))
            result = command(client, id, args, mode=mode, denied=denied)
            if not denied:
                outcomes.add(mode)
            return result

        assert call("session-open")["state"] == "open"
        docs = call("session-preview")["documents"]
        did = next(doc["id"] for doc in docs if doc["kind"] == "schematic")

        def preview(step=None):
            args = {"documentId": did}
            if step:
                args["step"] = step
            return call("session-preview", args)

        start = preview()
        part = next(item for item in start["document"]["items"] if item["kind"] == "part")

        def value(step=None):
            return next(item["value"] for item in preview(step)["document"]["items"] if item["id"] == part["id"])

        def edit(old, new, denied=False):
            return call("record-edit", {"label": "Set component value", "ops": [
                {"op": "set", "target": "item", "document": did, "id": part["id"],
                 "path": ["value"], "before": old, "after": new}]}, denied)

        assert edit(part["value"], "One")["applied"] == 1
        assert edit("One", "Two")["applied"] == 1
        assert edit("One", "Reject stale value", True)
        assert value() == "Two"
        call("undo")
        assert value() == "One"
        call("redo")
        assert value() == "Two"
        call("undo")
        assert edit("One", "Three")["applied"] == 1
        line = call("session-list", {"limit": 2})
        assert line["total"] == 3 and line["nextOffset"] == 2 and len(line["branches"]) == 1
        alternate = line["branches"][0]["tip"]
        assert value(alternate) == "Two" and value() == "Three"
        assert call("session-compare", {"step": alternate})["total"] == 1
        scene = call("session-thumbnail", {"step": alternate, "documentId": did})["scene"]
        assert len(scene["bounds"]) == 4 and scene["after"][0]["value"] == "Two"
        reviewed = preview(alternate)
        assert call("session-fork", {"receipt": reviewed["receipt"]})["fork"]
        assert value() == "Two" and len(call("session-list")["branches"]) == 2
        call("undo")
        assert value() == "Three"
        saved = preview(line["items"][0]["id"])
        assert call("session-restore", {"receipt": saved["receipt"]})["applied"] == 1
        assert value() == part["value"]
        call("undo")
        assert value() == "Three"

        copied = call("clipboard-copy", {"documentId": did, "itemIds": [part["id"]]})["id"]
        text = call("clipboard-text", {"text": "V = I × R", "math": True, "kind": "schematic"})["id"]
        assert call("clipboard-preview", {"entry": copied})["items"][0]["value"] == "Three"
        assert call("clipboard-list", {"query": "math v = i"})["items"][0]["id"] == text
        assert call("clipboard-pin", {"entry": copied, "on": True})["pinned"]
        assert call("clipboard-rename", {"entry": copied, "name": "Warm sensor"})["name"] == "Warm sensor"
        assert call("clipboard-list", {"query": "SENSOR", "pinned": True})["items"][0]["id"] == copied
        added = call("clipboard-paste", {"entry": text, "documentId": did, "x": 18, "y": 8})["ids"]
        assert any(row["id"] in added and row.get("math") for row in preview()["document"]["items"])
        call("undo")
        assert not any(row["id"] in added for row in preview()["document"]["items"])
        assert call("clipboard-clear")["state"] == "cleared"
        assert [item["id"] for item in call("clipboard-list")["items"]] == [copied]
        assert call("clipboard-remove", {"entry": copied})["removed"]

        commits = call("git-list", {"limit": 8})
        known = next(row["revision"] for row in commits["commits"] if row["subject"] == "Add sensor interface")
        absent = next(row["revision"] for row in commits["commits"] if row["subject"] == "Remove design")
        assert call("git-preview", {"revision": known, "documentId": did})["document"]["items"]
        assert call("git-compare", {"revision": known})["total"] > 0
        assert not call("git-preview", {"revision": absent})["exists"]
        away = call("git-compare", {"revision": absent})
        assert not away["beforeExists"] and away["total"] > 0
        args = {"revision": known, "name": "fixture-visual", "confirm": False}
        assert command(client, "git-branch", args, mode="plan")["requiresWrite"]
        assert call("git-branch", args, denied=True)
        assert all(b"fixture-visual" not in row
                   for row in git(folder, "branch", "--list", capture_output=True).stdout.splitlines())
        assert call("git-branch", {**args, "confirm": True})["branch"] == "fixture-visual"
        assert git(folder, "rev-parse", "refs/heads/fixture-visual", capture_output=True).stdout.strip().decode() == known
        assert call("git-branch", {**args, "confirm": True}, denied=True)

        with Stdio(server(project, "--enable-butter", "visualHistory", "--allow-write")) as second:
            assert command(second, "session-list", denied=True)
            command(second, "session-open", mode="write")
            assert command(second, "clipboard-list")["total"] == 0
            assert command(second, "session-list")["total"] == 1
        assert call("session-close")["state"] == "closed"
        assert call("session-preview", denied=True)
    assert all("read" in outcomes or "write" in outcomes for outcomes in covered.values()), covered
    assert branch_state(folder) == state, "branch creation leaves the checkout, index and Git config intact"
    assert authored_files(folder) == original, "scratch history and clipboard leave native project bytes intact"
    return {id: sorted(outcomes) for id, outcomes in covered.items()}


if __name__ == "__main__":
    started = monotonic()
    with tempfile.TemporaryDirectory(prefix="waffle-butter-history-") as scratch:
        coverage = test(make_history(Path(scratch).resolve()))
    print("BUTTER_COMMAND_COVERAGE " + json.dumps(coverage, sort_keys=True))
    print(f"PASS Visual History · {len(SPECS)} real MCP commands, opt-in, explicit writes, private sessions, project bytes and Git isolation · {monotonic() - started:.2f}s")
