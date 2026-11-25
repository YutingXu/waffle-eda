#!/bin/zsh
# Regenerates the panel fabrication-output goldens (tests/goldens/panel/) after a deliberate change to
# panel or fabrication output (app/pcb/panel.js, app/formats/fab-outputs.js). Review `git diff tests/goldens/panel`
# before committing: every changed line there is a change a fabricator will see.
# Usage: scripts/update-panel-goldens.sh   (macOS JavaScriptCore, or Node when installed)
set -e
root=${0:A:h:h}
jsc=/System/Library/Frameworks/JavaScriptCore.framework/Versions/Current/Helpers/jsc
if [[ -x $jsc ]]; then out=$($jsc $root/tests/jsc-shim.js -- $root/tests/formats/panel-golden.cjs --emit)
elif command -v node >/dev/null; then out=$(node $root/tests/formats/panel-golden.cjs --emit)
else print -u2 "Neither JavaScriptCore nor Node was found."; exit 2; fi
print -r -- "$out" | grep -q '^SHIM-FAIL' && { print -u2 -r -- "$out" | grep -A5 '^SHIM-FAIL'; exit 1; }
print -r -- "$out" | python3 -I -c '
import sys, pathlib, shutil
root = pathlib.Path(sys.argv[1]) / "tests" / "goldens" / "panel"
if root.exists(): shutil.rmtree(root)
root.mkdir(parents=True)
name, buf, n = None, [], 0
for line in sys.stdin.read().split("\n"):
    if name is None:
        if line.startswith("@@@FILE "): name, buf = line[8:], []
        continue
    if line == "@@@END":
        p = (root / name).resolve()
        assert root.resolve() in p.parents, name
        with open(p, "w", encoding="utf-8", newline="") as fh: fh.write("\n".join(buf))
        name, n = None, n + 1
    else: buf.append(line)
print("Wrote %d golden files to %s" % (n, root))
' $root
