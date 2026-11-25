#!/usr/bin/env python3
"""Exercise the installed native Git driver's treatment of independent and overlapping rule edits."""
import json
from pathlib import Path
import subprocess
import sys
import tempfile


ROOT = Path(__file__).resolve().parents[2]
SOURCE = ROOT / "tests/fixtures/signals/signal-board/Signals.waffle"
DRIVER = ROOT / "native/git_head.py"


def scope_edit(original, rule, side, source):
    lines = original.splitlines(keepends=True)
    for index, line in enumerate(lines):
        row = json.loads(line)
        if row.get("kind") == "rule" and row["id"] == rule:
            current = f'"{side}":{{"languageVersion":1,"source":"object"}}'.encode()
            assert current in line
            replacement = f'"{side}":{{"languageVersion":1,"source":{json.dumps(source)}}}'.encode()
            lines[index] = line.replace(current, replacement, 1)
            return b"".join(lines)
    raise AssertionError(rule)


with tempfile.TemporaryDirectory() as directory:
    base, ours, theirs = (Path(directory) / part for part in ("base", "ours", "theirs"))
    original = SOURCE.read_bytes()
    base.write_bytes(original)
    command = [sys.executable, "-I", "-B", str(DRIVER), "--merge-driver", str(base), str(ours), str(theirs), "--", "Signals.waffle"]
    left = scope_edit(original, "clearance-1", "scope", "track")
    ours.write_bytes(left)
    theirs.write_bytes(scope_edit(original, "width-1", "scope", "via"))
    subprocess.run(command, check=True, capture_output=True)
    assert ours.read_bytes() == scope_edit(left, "width-1", "scope", "via")

    ours.write_bytes(left)
    right = scope_edit(original, "clearance-1", "scope2", "pad")
    theirs.write_bytes(right)
    result = subprocess.run(command, capture_output=True)
    assert result.returncode == 1, result
    assert ours.read_bytes() == left and theirs.read_bytes() == right and base.read_bytes() == original
    print("Native Git merged independent rule rows and retained all three versions of the two-sided conflict.")
