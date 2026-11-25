#!/bin/zsh
# Runs one attached native PCB Undo/Redo regression on a disposable Workshop folder.
set -eu
H=${0:A:h}; ROOT=${H:h:h:h}
W=${1:-$(mktemp -d "${TMPDIR:-/tmp}/waffle-component-undo.XXXXXX")}
mkdir -p "$W"
W=${W:A}
fixture=$(mktemp -d "$W/workshop.XXXXXX")
cp -R "$ROOT/tests/fixtures/format-2/workshop/." "$fixture/"
I=${HARNESS_INSTALL:-$(mktemp -d "$HOME/Library/Caches/waffle-component-undo.XXXXXX")}
HARNESS_OUT="$W/build" HARNESS_INSTALL="$I" "$H/build.sh" > "$W/build.log"
export HARNESS_SUITE=ui HARNESS_EPHEMERAL=1
export HARNESS_PROBES="$H/component-undo.js" HARNESS_OPEN_PROJECT="$fixture/Reference.waffle" HARNESS_WORK="$W/run"
python3 - "$I/WaffleHarness.app/Contents/MacOS/Waffle" "$W/component-undo.log" <<'PY'
import pathlib
import subprocess
import sys

application, output = sys.argv[1:]
with pathlib.Path(output).open("w") as log:
    result = subprocess.run([application], stdout=log, stderr=subprocess.STDOUT, timeout=75)
text = pathlib.Path(output).read_text()
print(text, end="")
if result.returncode or "RESULT ok" not in text.splitlines() or any(line.startswith("FAIL") for line in text.splitlines()):
    sys.exit(1)
PY
