#!/bin/zsh
# Regenerates the fabrication-output goldens (tests/goldens/fab/) after a deliberate change to
# Gerber, drill, pick-and-place, assembly or readme output. Review `git diff tests/goldens` before
# committing: every changed line there is a change a fabricator will see.
# Usage: scripts/update-goldens.sh   (macOS JavaScriptCore, or Node when installed)
set -e
root=${0:A:h:h}
jsc=/System/Library/Frameworks/JavaScriptCore.framework/Versions/Current/Helpers/jsc
if [[ -x $jsc ]]; then out=$($jsc $root/tests/jsc-shim.js -- $root/tests/formats/fab-golden.cjs --emit)
elif command -v node >/dev/null; then out=$(node $root/tests/formats/fab-golden.cjs --emit)
else print -u2 "Neither JavaScriptCore nor Node was found."; exit 2; fi
print -r -- "$out" | grep -q '^SHIM-FAIL' && { print -u2 -r -- "$out" | grep -A5 '^SHIM-FAIL'; exit 1; }
print -r -- "$out" | python3 -I -c '
import sys, pathlib, shutil
root = pathlib.Path(sys.argv[1]) / "tests" / "goldens" / "fab"
sample = root / "sample"
if sample.exists(): shutil.rmtree(sample)
name, buf, n = None, [], 0
for line in sys.stdin.read().split("\n"):
    if name is None:
        if line.startswith("@@@FILE "): name, buf = line[8:], []
        continue
    if line == "@@@END":
        p = (root / name).resolve()
        assert root.resolve() in p.parents, name
        p.parent.mkdir(parents=True, exist_ok=True)
        with open(p, "w", encoding="utf-8", newline="") as fh: fh.write("\n".join(buf))
        name, n = None, n + 1
    else: buf.append(line)
print("Wrote %d golden files to %s" % (n, root))
' $root
