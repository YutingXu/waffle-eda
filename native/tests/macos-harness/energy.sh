#!/bin/zsh
# Energy probes: the real Desktop class and WKWebView, window occlusion detection on, scenarios of
# energy-probes.js (idle focused, background, occluded, minimised, hidden, with a selection, an armed
# tool, online DRC, live pours, the 3D view and the BOM; time to idle after an edit, a pan and a
# route) on the starter project and the big board.
# Usage: native/tests/macos-harness/energy.sh [work-folder]   (numbers: <work-folder>/energy.json)
# Env: HARNESS_INSTALL (as for ui.sh: a real path outside /tmp and /var; native/tests/macos-harness/
#      target/<name> is a safe in-repo choice, deleted afterwards), ENERGY_ONLY=name,name (scenario
#      names as printed), ENERGY_SCALE (multiplies the idle windows; 0.25 for a quick run).
# Keep the machine otherwise quiet: other apps' load shows up in the GPU and window server numbers.
H=${0:A:h}; ROOT=${H:h:h:h}; W=${1:-${TMPDIR:-/tmp}/atrium-energy}; W=${W:A}
I=${HARNESS_INSTALL:-$HOME/Library/Caches/atrium-harness-energy}
mkdir -p $W
HARNESS_OUT=$W/build HARNESS_INSTALL=$I $H/build.sh >/dev/null || exit 2
print "globalThis.__energyScale = ${ENERGY_SCALE:-1};" > $W/scale.js
log=$W/energy.log
UI_ONLY=${ENERGY_ONLY:-} HARNESS_SUITE=ui HARNESS_EPHEMERAL=1 HARNESS_PROBES=$ROOT/tests/pcb/dense-board.js:$W/scale.js:$H/energy-probes.js HARNESS_WORK=$W/run \
  timeout ${ENERGY_TIMEOUT:-1500} $I/WaffleHarness.app/Contents/MacOS/Waffle 2>&1 | grep --line-buffered -E "^(PASS|FAIL|NOTE|RESULT)" | tee $log | grep -E "^(FAIL|RESULT|NOTE  (small|big))"
python3 - "$log" "$W/energy.json" <<'PY'
import sys, json, re
text = open(sys.argv[1]).read()
m = re.search(r'ENERGY (\{.*\})', text)
if not m: print("FAIL  energy probe produced numbers"); sys.exit(1)
r = json.loads(m.group(1)); open(sys.argv[2], "w").write(json.dumps(r, indent=1))
print("power:", r.get("power"), "live pours:", r.get("liveMode"), "online DRC:", r.get("drcOnline"))
print("%-26s %8s %8s %8s %8s %8s   %s" % ("scenario", "cpu %", "idleW/s", "intW/s", "mW", "top pw", "web/gpu/app cpu %"))
for k, v in r["scenarios"].items():
    if "total" in v:
        t = v["total"]; part = "/".join("%.2f" % v.get(p, {}).get("cpu", 0) for p in ("web", "gpu", "app"))
        print("%-26s %8.2f %8.1f %8.1f %8.0f %8.1f   %s" % (k, t["cpu"], t["idleW"], t["intW"], t["mW"], v.get("topPower", 0), part))
    else:
        print("%-26s time to idle %s ms after %s ms of interaction  trail %s" % (k, v.get("timeToIdleMs"), v.get("interaction"), " ".join(map(str, v.get("trail", [])))))
PY
