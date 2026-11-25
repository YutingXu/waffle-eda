#!/bin/zsh
# Hardware-accelerated board renderer (app/canvas/canvas-gpu.js; docs/design/gpu-renderer.md) in WKWebView:
# the 2D canvas against WebGL2 on the 25.6k-object board with nets and ten pours, through the real Desktop
# class (tests/canvas/perf-gpu.js; the Chrome run is scripts/perf-gpu.sh). Prints the JSON; nothing is budgeted.
# Usage: native/tests/macos-harness/gpu.sh [work-folder]   (numbers: <work-folder>/gpu-bench.json)
# Env: HARNESS_INSTALL as for frame.sh (a real path outside /tmp; native/tests/macos-harness/target/ is a
#      safe in-repo choice, deleted afterwards). GPU_TIMEOUT (default 900 s).
H=${0:A:h}; ROOT=${H:h:h:h}; W=${1:-${TMPDIR:-/tmp}/atrium-gpu}; W=${W:A}
I=${HARNESS_INSTALL:-$HOME/Library/Caches/atrium-harness-gpu}
mkdir -p $W/run
HARNESS_OUT=$W/build HARNESS_INSTALL=$I $H/build.sh >/dev/null || exit 2
log=$W/gpu.log
HARNESS_SUITE=ui HARNESS_EPHEMERAL=1 HARNESS_PROBES=$ROOT/tests/pcb/dense-board.js:$ROOT/tests/canvas/perf-gpu.js:$H/gpu-probes.js HARNESS_WORK=$W/run \
  timeout ${GPU_TIMEOUT:-900} $I/WaffleHarness.app/Contents/MacOS/Waffle 2>&1 | grep --line-buffered -E "^(PASS|FAIL|NOTE|RESULT)" > $log
grep -E "^(FAIL|RESULT)|WebKit.framework|60fps" $log
python3 - "$log" "$W/gpu-bench.json" <<'PY'
import sys, json, re
m = re.search(r'GPUBENCH (\{.*\})', open(sys.argv[1]).read())
if not m: print("FAIL  GPU bench produced numbers"); sys.exit(1)
r = json.loads(m.group(1)); open(sys.argv[2], "w").write(json.dumps(r, indent=1)); print(json.dumps(r, indent=1))
PY
