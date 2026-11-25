#!/usr/bin/env python3
"""Reject a new tracked top-level app or test file outside the approved map."""

from pathlib import Path, PurePosixPath
import subprocess
import sys

ROOT = Path(__file__).resolve().parents[1]
RETAINED = {
    'app/VERSION',
    'app/index.html',
    'app/lazy.js',
    'app/style.css',
    'app/translators.json',
    'tests/altium-fidelity.json',
    'tests/crypto-shim.cjs',
    'tests/integration-browser.cjs',
    'tests/jsc-runner.py',
    'tests/jsc-shim.js',
    'tests/known-failures.txt',
    'tests/run.cjs',
}


def main():
    result = subprocess.run(["git", "-C", str(ROOT), "ls-files", "-z"], capture_output=True)
    if result.returncode:
        print(result.stderr.decode("utf-8", "replace").strip(), file=sys.stderr)
        return result.returncode
    paths = result.stdout.decode("utf-8").split("\0")
    unexpected = []
    for path in paths:
        parts = PurePosixPath(path).parts
        if len(parts) == 2 and parts[0] in ("app", "tests") and path not in RETAINED:
            unexpected.append(path)
    for path in sorted(set(unexpected)):
        print("Unlisted top-level source: " + path, file=sys.stderr)
    return int(bool(unexpected))


if __name__ == "__main__":
    sys.exit(main())
