#!/usr/bin/env python3
"""Live-session smoke test against a relay (deploy/collab-server/README.md).

Two headless Chromium editors join a room through RELAY with the real transport, exchange edits and
report which path each mode used (WebRTC direct, WebRTC through TURN, relay only) and the edit round
trip. It runs scripts/collab-smoke.cjs with Node and Playwright, found in PATH or in the pinned CI
toolchain under ~/.cache/atrium-ci (scripts/ci/install-node.sh).

    python3 scripts/collab-smoke.py ws://127.0.0.1:8765          # python3 collab/relay/waffle_relay.py --dev
    python3 scripts/collab-smoke.py wss://collab.example.org      # your server
    python3 scripts/collab-smoke.py wss://collab.example.org --modes relay --rounds 50 --json
"""
import glob
import os
from pathlib import Path
import shutil
import subprocess
import sys

ROOT = Path(__file__).resolve().parents[1]


def main(argv):
    if not argv or argv[0] in ("-h", "--help"):
        print(__doc__)
        return 0 if argv else 2
    cache = Path.home() / ".cache" / "atrium-ci"
    node = shutil.which("node") or next(iter(sorted(glob.glob(str(cache / "node-v*" / "bin" / "node")), reverse=True)), None)
    if not node:
        print("collab-smoke: Node.js not found (install it, or run scripts/ci/install-node.sh)", file=sys.stderr)
        return 2
    env = dict(os.environ)
    paths = [p for p in env.get("NODE_PATH", "").split(os.pathsep) if p]
    paths += sorted(glob.glob(str(cache / "ci-node-*" / "node_modules")), reverse=True)
    env["NODE_PATH"] = os.pathsep.join(paths)
    return subprocess.call([node, str(ROOT / "scripts" / "collab-smoke.cjs"), *argv], env=env)


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
