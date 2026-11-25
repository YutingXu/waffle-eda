#!/bin/zsh
# Native WebKit dense-board soak. A default run measures one edit hour plus five idle minutes.
# Usage: native/tests/macos-harness/memory.sh <fresh output directory>
# Quick check: HARNESS_MEMORY_SECONDS=15 HARNESS_MEMORY_IDLE_SECONDS=10 memory.sh <output directory>
# Shorten either phase for a smoke run. Use a logged-in macOS session and a quiet machine.
set -eu
if [[ $# != 1 || -z $1 ]]; then
    print -u2 "Usage: $0 <output directory>"
    exit 2
fi
H=${0:A:h}; ROOT=${H:h:h:h}; W=${1:A}
active=${HARNESS_MEMORY_SECONDS:-3605}
idle=${HARNESS_MEMORY_IDLE_SECONDS:-300}
if [[ $active != <1-3605> || $idle != <0-300> ]]; then
    print -u2 "Use whole seconds: HARNESS_MEMORY_SECONDS from 1 to 3605 and HARNESS_MEMORY_IDLE_SECONDS from 0 to 300."
    exit 2
fi
gate=--require-complete
if (( active == 3605 && idle == 300 )); then gate=--require-hour; fi

revision=$(git -C "$ROOT" rev-parse HEAD 2>/dev/null) || revision=unknown
if [[ $revision != unknown ]] && ! git -C "$ROOT" diff --quiet HEAD --; then revision+=" (modified)"; fi
mkdir -p "$W"
print "Building native harness. See $W/build.log."
HARNESS_OUT="$W/build" HARNESS_INSTALL="$W/install" "$H/build.sh" > "$W/build.log" 2>&1
bundle="$W/install/WaffleHarness.app"
codesign --verify --deep --strict "$bundle"

print "Running native memory probe. See $W/native.log."
HARNESS_SUITE=memory HARNESS_EPHEMERAL=1 HARNESS_BACKGROUND=1 HARNESS_WORK="$W/run" \
  HARNESS_MEMORY_SECONDS="$active" HARNESS_MEMORY_IDLE_SECONDS="$idle" HARNESS_MEMORY_REV="$revision" \
  HARNESS_PROBES="$ROOT/tests/pcb/dense-board.js:$H/memory-probes.js" HARNESS_MEMORY_INSPECTOR_SCRIPT="$H/memory-inspector.js" \
  caffeinate -di timeout "$((active + idle + 120))" "$bundle/Contents/MacOS/Waffle" > "$W/native.log" 2>&1
python3 -B "$H/memory-summary.py" "$W/native.log" "$gate" --out "$W/summary.json" --series "$W/series.json"
print "Memory summary and series written to $W."
