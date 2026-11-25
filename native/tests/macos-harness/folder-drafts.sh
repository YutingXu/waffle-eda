#!/bin/zsh
# Actual signed app, system WebKit and a persistent website store scoped to this temporary fixture.
set -eu
H=${0:A:h}
scratch=$(mktemp -d -t waffle-folder-drafts)
scratch=${scratch:A}
export HARNESS_OUT="$scratch/build" HARNESS_INSTALL="$scratch/install"
export HARNESS_SUITE=folder-drafts HARNESS_TOUR_PUBLIC_WEB_DATA=1
export HARNESS_DRAFT_PROBE="$H/folder-drafts.js" HARNESS_EARLY_PROBE="$scratch/empty.js"
touch "$HARNESS_EARLY_PROBE"
"$H/build.sh" > "$scratch/build.log" 2>&1
app="$HARNESS_INSTALL/WaffleHarness.app"
codesign --verify --strict "$app"
run() {
    local phase=$1 output="$HARNESS_WORK.$1.log"
    HARNESS_DRAFT_PHASE="$phase" "$app/Contents/MacOS/Waffle" > "$output" 2>&1 || [[ "$phase" = edit ]]
    cat "$output" | rg '^(PASS|FAIL|NOTE|RESULT)' || true
if [[ "$phase" = edit ]]; then rg -q '^RESULT killed after durable private draft' "$output"
    else rg -q '^RESULT ok' "$output"; fi
    if rg -q '^FAIL' "$output"; then return 1; fi
}
if [[ ${1:-} = --preferences ]]; then
    export HARNESS_WORK="$scratch/preferences"
    run preferences
    run preferences-reopen
    run preferences-save
    print "Evidence $scratch"
    exit 0
fi
export HARNESS_WORK="$scratch/matches"
run edit
run keep
run save
run saved
export HARNESS_WORK="$scratch/changed"
run edit
python3 - "$HARNESS_WORK/proj/Power.wsch" <<'PY'
from pathlib import Path
import sys
p = Path(sys.argv[1])
p.write_bytes(p.read_bytes().replace(b"SENSE", b"INDEPENDENT"))
p.with_name("Unrelated.wsch").unlink()
PY
run separate
run discard
print "Evidence $scratch"
