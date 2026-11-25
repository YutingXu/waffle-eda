#!/bin/zsh
# A dedicated signed bundle and fresh private store. All GPU exits go through WebKit's
# test SPI after it verifies the process associated with the harness's own view.
# Usage: gpu-restart.sh <output directory>
set -eu
H=${0:A:h}
ROOT=${H:h:h:h}
W=${1:A}
install=$(mktemp -d "$HOME/Library/Caches/waffle-gpu-recovery.XXXXXXXX")
trap 'python3 -c "import shutil,sys; shutil.rmtree(sys.argv[1])" "$install"' EXIT
mkdir -p "$W"
HARNESS_GPU_RESTART_BUILD=1 HARNESS_OUT="$W/build" HARNESS_INSTALL="$install" "$H/build.sh" > "$W/build.log" 2>&1
bundle="$install/WaffleHarness.app"
codesign --verify --strict "$bundle"
for renderer in gpu 2d; do
  print -r -- "{\"renderer\":\"$renderer\"}" > "$W/$renderer.json"
  result=0
  HARNESS_SUITE=gpu-process-recovery HARNESS_INPUT_STDIN=1 HARNESS_EPHEMERAL=1 \
    HARNESS_EARLY_PROBE="$H/pan-early.js" \
    HARNESS_WORK="$W/$renderer" HARNESS_PROBES="$ROOT/tests/pcb/dense-board.js:$H/gpu-restart.js" \
    caffeinate -d timeout "${GPU_RESTART_TIMEOUT:-100}" "$bundle/Contents/MacOS/Waffle" \
    < "$W/$renderer.json" > "$W/$renderer.log" 2>&1 || result=$?
  if (( result )); then cat "$W/$renderer.log"; exit "$result"; fi
  python3 - "$W" "$renderer" <<'PY'
import json
from pathlib import Path
import sys

work, renderer = Path(sys.argv[1]), sys.argv[2]
log = (work / f"{renderer}.log").read_text()
prefix = "NOTE  probe summary: RECOVERY "
row = next((line.removeprefix(prefix) for line in log.splitlines() if line.startswith(prefix)), None)
if not row or "RESULT ok" not in log or any(line.startswith("FAIL") for line in log.splitlines()):
    sys.exit(log[-5000:])
data = json.loads(row)
(work / f"{renderer}-result.json").write_text(json.dumps(data, indent=2) + "\n")
if data.get("skip"):
    detail = data.get("state", {}).get("reason") or data.get("status", {}).get("reason")
    print(f"SKIP  WebKit GPU process recovery ({renderer}): {data['skip']}" + (f" ({detail})" if detail else ""))
else:
    pids = [data["initial"]["gpuPID"], *(run["newPID"] for run in data["runs"])]
    if len(set(pids)) != 3 or len(data["runs"]) != 2:
        sys.exit(f"Expected two distinct private WebKit GPU process restarts, observed {pids}")
    print(f"PASS  WebKit GPU process recovery ({renderer}): {pids}, {data['itemCount']} unchanged items")
PY
done
