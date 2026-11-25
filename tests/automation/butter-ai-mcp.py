#!/usr/bin/env python3
"""Exercise real MCP query receipts, project grants, refusals and revocation."""
from pathlib import Path
import runpy
import tempfile
from time import monotonic

import sys as _test_sys
from pathlib import Path as _TestPath
_test_sys.path.insert(0, str((_TestPath(__file__).resolve().parent / "../support").resolve()))
from native_sample import authored_files, write_design


HERE = Path(__file__).resolve().parents[1]
helpers = runpy.run_path(str(HERE / "automation/butter-acceptance.py"))
Stdio, server, make_project = (helpers[name] for name in ("Stdio", "server", "make_project"))
FIXTURE = {"fixture": "tests/fixtures/format-2/butter-query", "manifest": "Saved Query.waffle"}
PROJECT = "01900000-0000-7000-8000-000000000001"
DOCUMENT = "01900000-0000-7000-8000-000000000002"


def command(client, name, args=None, *, mode=None, denied=False):
    arguments = {"command": f"butter.ai.{name}", "args": args or {}}
    if mode:
        arguments["mode"] = mode
    result = client.check_tool("run_command", arguments, denied=denied)
    return {**result, **result.get("untrusted_design_text", {})}


def erc_paging(root):
    target = "erc-target"

    def sheet(document, labels):
        return {
            "kind": "schematic", "id": document, "name": document, "grid": 1.27,
            "items": [{"kind": "netlabel", "id": f"{document}-{i}", "text": f"OPEN{i}", "x": i * 20, "y": 0}
                      for i in range(labels)],
        }

    manifest = write_design(root / "Scoped ERC.waffle", {
        "name": "Scoped ERC", "id": "erc-project",
        "documents": [sheet("erc-first", 20), sheet(target, 18)],
    })
    original = authored_files(root)
    with Stdio(server(manifest, "--enable-butter", "ai", "--allow-write")) as client:
        unscoped = client.check_tool("run_erc", {"limit": 16})
        assert all(row["document_id"] == "erc-first" for row in unscoped["classes"]["Warning"]["items"])
        scoped = client.check_tool("run_erc", {"document_id": target, "limit": 16})
        assert scoped["classes"]["Warning"]["total"] == 18, scoped
        assert command(client, "set-policy", {"allowed": True, "tools": ["run_erc"]}, mode="write")["allowed"]
        reply = command(client, "ask", {
            "provider": "waffle.stub", "prompt": "Check this sheet.", "documentId": target, "read": {"tool": "run_erc"},
        }, mode="write")
        assert reply["text"] == "Verified 16 of 18 tool rows." and len(reply["citations"]) == 16, reply
        first = reply["citations"][0]
        assert first["evidence"]["tool"] == "run_erc" and first["evidence"]["row"]["document_id"] == target, first
    assert authored_files(root) == original


def main():
    with tempfile.TemporaryDirectory(prefix="waffle-ai-mcp-") as temporary:
        root = Path(temporary)
        study = make_project(root / "study", FIXTURE)
        unrelated = make_project(root / "unrelated", FIXTURE)
        original = authored_files(study.parent)
        query = {"tool": "query", "args": {"scope": "track where width < 0.2 mm"}}
        ask = {"provider": "waffle.stub", "prompt": "password: private-fixture-sentinel",
               "documentId": DOCUMENT, "read": query}
        flags = ("--enable-butter", "ai", "--enable-butter", "query", "--allow-write")
        with Stdio(server(study, *flags)) as client:
            denied = command(client, "ask", ask, mode="write", denied=True)
            assert denied["code"] == "permission_denied", denied
            assert command(client, "set-policy", {"allowed": True, "tools": ["query"]}, mode="write")["allowed"]
            for unsafe in (dict(ask, provider="unknown.remote"),
                           dict(ask, documentId="unapproved-document"),
                           dict(ask, read={"tool": "project_history"}),
                           dict(ask, read={"tool": "query", "args": {"scope": "track", "component_id": "wrong-grant"}})):
                failure = command(client, "ask", unsafe, mode="write", denied=True)
                assert failure["code"] in {"permission_denied", "invalid_arguments"}, failure
            start = monotonic()
            reply = command(client, "ask", ask, mode="write")
            latency_ms = (monotonic() - start) * 1000
            assert reply["status"] == "answered" and reply["tools"] == 1, reply
            assert reply["text"] == "Verified 1 tool rows." and len(reply["citations"]) == 1, reply
            assert reply["citations"][0]["url"].startswith(f"waffle://{PROJECT}/"), reply
            assert reply["citations"][0]["documentId"] == DOCUMENT, reply
            [entry] = command(client, "activity")["requests"]
            assert entry["promptExcerpt"] == "[redacted]" and entry["result"] == "answered", entry
            assert entry["readTools"][0]["tool"] == "query" and entry["readTools"][0]["rows"] == 1, entry
            restricted = command(client, "ask", dict(ask, read={"tool": "query", "args": {"scope": "net"}}), mode="write")
            assert restricted["status"] == "failed" and restricted["code"] == "permission_denied" and "citations" not in restricted, restricted
            with Stdio(server(unrelated, *flags)) as second:
                assert command(second, "policy")["allowed"] is False
                assert command(second, "ask", ask, mode="write", denied=True)["code"] == "permission_denied"
            assert command(client, "set-policy", {"allowed": False}, mode="write")["allowed"] is False
            assert command(client, "ask", ask, mode="write", denied=True)["code"] == "permission_denied"
            assert len(command(client, "activity")["requests"]) == 2
            assert command(client, "clear-activity", {}, mode="write")["status"] == "cleared"
            assert command(client, "activity")["requests"] == []
        assert authored_files(study.parent) == original
        assert authored_files(unrelated.parent) == original
        erc_paging(root / "erc")
    print("AI MCP local query, cited result, independent project consent, revocation and document-first ERC paging passed.")
    print(f"One verified local MCP query round trip: {latency_ms:.1f} ms.")


if __name__ == "__main__":
    main()
