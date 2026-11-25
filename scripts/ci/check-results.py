#!/usr/bin/env python3
"""Compare a suite-runner log against tests/known-failures.txt.

Usage: check-results.py RUNNER LOG    (RUNNER is jsc or node; LOG holds "ok    name",
"SKIP  name: reason" and "FAIL  name: reason" lines from either suite runner).
Exits 1 when a suite fails that is not listed for RUNNER, or when the log has no results."""
import re
import sys
from pathlib import Path

KNOWN = Path(__file__).resolve().parents[2] / "tests" / "known-failures.txt"


def known(runner):
    names = set()
    for line in KNOWN.read_text(encoding="utf-8").splitlines():
        fields = line.split("#", 1)[0].split()
        if len(fields) == 2 and fields[0] == runner:
            names.add(fields[1])
    return names


def main():
    if len(sys.argv) != 3:
        raise SystemExit(__doc__)
    runner, log = sys.argv[1], Path(sys.argv[2]).read_text(encoding="utf-8", errors="replace")
    allowed = known(runner)
    passed = set(re.findall(r"^ok[ \t]+(\S+)", log, re.M))
    failed = dict(re.findall(r"^FAIL[ \t]+([^\s:]+):?[ \t]*(.*)$", log, re.M))
    skipped = dict(re.findall(r"^SKIP[ \t]+([^\s:]+):[ \t]*(.+)$", log, re.M))
    if not passed and not failed and not skipped:
        print("no suite results in the log")
        return 1
    unexpected = sorted(set(failed) - allowed)
    print(f"{runner}: {len(passed)} passed, {len(skipped)} skipped, {len(failed)} failed ({len(failed) - len(unexpected)} known)")
    for name in sorted(allowed & passed):
        print(f"  now passes (remove from tests/known-failures.txt): {name}")
    for name in unexpected:
        print(f"  UNEXPECTED FAIL {name}: {failed[name] or 'no diagnostic recorded'}")
    return 1 if unexpected else 0


if __name__ == "__main__":
    sys.exit(main())
