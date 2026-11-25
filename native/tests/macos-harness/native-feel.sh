#!/bin/zsh
# Native macOS gesture benchmark. The source is an AppKit-synthesized scroll or
# magnification event delivered directly to the shipping EditorWebView class.
# Usage: native-feel.sh <output directory> [configuration.json]
# HARNESS_INSTALL selects a signed existing test app. Set NATIVE_FEEL_BUILD=1 to rebuild it.
# Default configuration is signed Control notches on the dense board's GPU renderer.
set -eu
H=${0:A:h}; ROOT=${H:h:h:h}; W=${1:A}
I=${HARNESS_INSTALL:-$HOME/Library/Caches/waffle-native-feel}
mkdir -p "$W/run"
if [[ ${NATIVE_FEEL_BUILD:-0} == 1 ]]; then
  HARNESS_OUT="$W/build" HARNESS_INSTALL="$I" "$H/build.sh" > "$W/build.log" 2>&1
fi
[[ -x "$I/WaffleHarness.app/Contents/MacOS/Waffle" ]]
if [[ -n ${2:-} ]]; then
  cp "$2" "$W/config.json"
else
  print -r -- '{"kind":"ctrl-line","renderer":"gpu","proof":true}' > "$W/config.json"
fi
HARNESS_INPUT_STDIN=1 HARNESS_SUITE=ui HARNESS_EPHEMERAL=1 HARNESS_EARLY_PROBE="$H/pan-early.js" \
  HARNESS_PROBES="$ROOT/tests/pcb/dense-board.js:$H/native-feel.js" HARNESS_WORK="$W/run" \
  caffeinate -d timeout "${NATIVE_FEEL_TIMEOUT:-45}" "$I/WaffleHarness.app/Contents/MacOS/Waffle" < "$W/config.json" > "$W/run.log" 2>&1
python3 - "$W" <<'PY'
from pathlib import Path
import json
import sys

directory = Path(sys.argv[1])
log = directory.joinpath("run.log").read_text()
row = next((line.split("FEEL ", 1)[1] for line in log.splitlines() if line.startswith("NOTE  probe summary: FEEL ")), None)
if not row or "RESULT ok" not in log:
    sys.exit(log[-3000:])
result = json.loads(row)
directory.joinpath("result.json").write_text(json.dumps(result, indent=2) + "\n")
print(json.dumps({key: value for key, value in result.items() if key not in ("samples", "isolated")}, indent=2))
PY
