#!/usr/bin/env python3
"""Verify the production GTK host router without requiring a display server."""

from pathlib import Path
import sys
import uuid

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "native/linux"))
from waffle import HostError, WorkspaceWindows


def check():
    scope = (Path("checked/native.waffle"), "project", "grant")
    replies, events, closed = [], [], []

    def member(key):
        return {"id": key, "tab": None, "scope": lambda: scope,
                "reply": lambda number, payload=None, error=None: replies.append((key, number, payload, error)),
                "send": lambda event: events.append((key, event)), "present": lambda: None,
                "capture": lambda: {}, "bounds": lambda _: None, "close": lambda: closed.append(key),
                "visible": lambda: True}

    def spawn(group, key, _tab):
        group.members[key] = member(key)

    author, mirror = str(uuid.uuid4()), str(uuid.uuid4())
    owner = member(author)
    g = WorkspaceWindows(scope[1], scope, owner, spawn)
    capture = {"id": 1, "operation": "apply-layout", "windows": [
        {"id": author, "active": "board"}, {"id": mirror, "active": "schematic"}], "focused": mirror}
    g.request(owner, capture)
    child = g.members[mirror]
    assert child["tab"] == "schematic"
    g.request(child, {"id": 2, "operation": "snapshot", "value": {"document": "schematic"}})
    key, event = events[-1]
    assert key == author and event["packet"]["from"] == mirror
    try:
        g.request(child, {"id": 3, "operation": "deliver", "token": event["token"], "value": "forged"})
        raise AssertionError("Detached views must never resolve a writer request")
    except HostError:
        assert len(g.pending) == 1
    g.request(owner, {"id": 4, "operation": "deliver", "token": event["token"], "value": {"verified": True}})
    assert (mirror, 2, {"verified": True}, None) in replies and not g.pending
    assert g.keep_writer(owner) and not g.keep_writer(child)
    for number in range(10, 42):
        g.request(child, {"id": number, "operation": "snapshot", "value": {"document": "schematic"}})
    assert len(g.pending) == 32
    _, retired = events[-1]
    g.request(owner, {"id": 42, "operation": "apply-layout", "windows": [capture["windows"][0]], "focused": author})
    assert not g.pending and (mirror, 41, None, "The project window closed.") in replies
    g.request(owner, {"id": 43, "operation": "deliver", "token": retired["token"], "value": "late"})
    assert (mirror, 41, "late", None) not in replies
    g.request(owner, capture)
    child = g.members[mirror]
    g.request(child, {"id": 44, "operation": "command", "value": {"kind": "save"}})
    _, retired = events[-1]
    scope = (*scope[:2], "replacement-grant")
    g.adopt_scope(scope)
    assert not g.pending and (mirror, 44, None, "The project window writer was replaced.") in replies
    g.request(owner, {"id": 45, "operation": "deliver", "token": retired["token"], "value": "late"})
    assert (mirror, 44, "late", None) not in replies
    g.request(child, {"id": 5, "operation": "command", "value": {"kind": "save"}})
    g.close(owner)
    assert (mirror, {"type": "writer-unavailable"}) in events
    assert (mirror, 5, None, "The project window writer closed.") in replies and not g.pending

    g = WorkspaceWindows(scope[1], scope, owner, spawn)
    g.request(owner, capture)
    child = g.members[mirror]
    g.request(child, {"id": 50, "operation": "command", "value": {"kind": "save"}})
    _, saving = events[-1]
    g.request(owner, {"id": 51, "operation": "deliver", "token": saving["token"], "value": False})
    assert (mirror, 50, False, None) in replies and not g.pending
    g.request(child, {"id": 52, "operation": "command", "value": {"kind": "undo"}})
    g.renderer_failed(child)
    assert (mirror, 52, None, "The project window renderer is unavailable.") in replies and not g.pending
    g.close(child)
    g.request(owner, capture)
    child = g.members[mirror]
    g.request(child, {"id": 53, "operation": "command", "value": {"kind": "edit"}})
    g.request(child, {"id": 54, "operation": "command", "value": {"kind": "save"}})
    closes = len(closed)
    peer_losses = events.count((mirror, {"type": "writer-unavailable"}))
    g.renderer_failed(owner)
    assert not g.pending and len(closed) == closes
    assert (mirror, 53, None, "The project window writer is unavailable.") in replies
    assert (mirror, 54, None, "The project window writer is unavailable.") in replies
    try:
        g.request(child, {"id": 55, "operation": "command", "value": {"kind": "undo"}})
        raise AssertionError("A failed writer must refuse commands before the crash dialog closes")
    except HostError as error:
        assert "writer is unavailable" in str(error)
    g.close(owner)
    assert events.count((mirror, {"type": "writer-unavailable"})) == peer_losses + 1
    assert len(closed) == closes + 1
    print("GTK workspace router passed editor-grant scope, cancellation, pending retirement, lease replacement, and renderer loss")


if __name__ == "__main__":
    check()
