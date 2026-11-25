#!/usr/bin/env python3
"""Test-only ROOT MANIFEST COMMAND driver for the actual Linux folder backend."""

import errno
import json
import os
from pathlib import Path
import signal
import sys
import time


module = os.environ.get("WAFFLE_NATIVE_MODULE") or str(Path(__file__).resolve().parents[2] / "linux")
sys.path.insert(0, module)
from folder_project import RootFolder  # noqa: E402


def checkpoint(name):
    if os.environ.get("WAFFLE_FOLDER_TRACE"):
        print(name, file=sys.stderr, flush=True)
    if os.environ.get("WAFFLE_FOLDER_KILL") == name:
        os.kill(os.getpid(), signal.SIGKILL)
    if os.environ.get("WAFFLE_FOLDER_FAIL") == name:
        code = int(os.environ.get("WAFFLE_FOLDER_ERRNO", str(errno.ENOSPC)))
        raise OSError(code, os.strerror(code))
    if os.environ.get("WAFFLE_FOLDER_PAUSE") == name:
        gate = Path(os.environ["WAFFLE_FOLDER_GATE"])
        gate.with_suffix(".ready").touch()
        deadline = time.monotonic() + 14
        while not gate.with_suffix(".resume").exists():
            if deadline < time.monotonic():
                raise OSError("The test gate was not released.")
            time.sleep(0.01)


def reply(value):
    print(json.dumps(value), flush=True)


def acknowledge(value):
    reply(value)
    checkpoint("acknowledged")


def main():
    directory, manifest, command = sys.argv[1:]
    request = json.load(sys.stdin)
    root = None
    try:
        root = RootFolder(Path(directory).resolve(), manifest, create=not (Path(directory) / manifest).exists(),
                          checkpoint=checkpoint)
        if command == "commit":
            root.commit(request.get("projectId"), request.get("manifest"), request.get("plan"), acknowledge)
            state = root.status()
            reply(state)
            return 0 if state["state"] == "settled" else 1
        if command == "recover":
            root.recover()
            reply(root.status())
            return 0
        if command == "status":
            reply(root.status())
            return 0
        if command == "conflict":
            reply(root.conflict())
            return 0
        if command == "conflictRead":
            reply(root.conflict_read(request))
            return 0
        if command == "resolve":
            root.resolve(request, acknowledge)
            state = root.status()
            reply(state)
            return 0 if state["state"] == "settled" else 1
        if command == "read":
            token = root.acquire(recover=False)
            reply(root.read(token, request["paths"]))
            root.release(token)
            return 0
        raise ValueError("Unknown test operation.")
    except (OSError, ValueError) as error:
        reply({"state": getattr(error, "state", "recoveryPending"), "paths": getattr(error, "paths", ()), "error": str(error)})
        return 1
    finally:
        if root is not None:
            root.close()


if __name__ == "__main__":
    sys.exit(main())
