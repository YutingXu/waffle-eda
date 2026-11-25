#!/bin/zsh
# WebKit schematic budgets: the real Desktop class and WKWebView (the macOS app's engine) on the synthetic
# hierarchical projects of tests/schematic/sch-bench-project.js, driven by tests/integration/perf-sch.js (the probe
# scripts/perf-sch.sh runs in headless Chrome): open, sheet switch, camera, drags, wire drawing, edits,
# select-all, highlight, ERC, annotate, search, save and idle wake-ups. Frames are timed synchronously
# (input -> handler -> render -> 1-pixel readback); WebKit's performance.now has 1 ms resolution and has
# no heap or CPU counters here, so those rows are absent.
# Usage: native/tests/macos-harness/sch.sh [work-folder]   (numbers: <work-folder>/sch-probes.json)
# Env: SCH_SHEETS=30|100 (default 30)  SCH_APP (another app folder, for A/B runs)  HARNESS_INSTALL (default ~/Library/Caches/atrium-harness-sch; a real
#      path outside /tmp and /var)  SCH_TIMEOUT (default 900 s)  ONLY=camera,switch,... (probe sections)
H=${0:A:h}; ROOT=${H:h:h:h}; W=${1:-${TMPDIR:-/tmp}/atrium-sch}; W=${W:A}
I=${HARNESS_INSTALL:-$HOME/Library/Caches/atrium-harness-sch}
mkdir -p $W/run
HARNESS_OUT=$W/build HARNESS_INSTALL=$I $H/build.sh >/dev/null || exit 2
# SCH_APP=/path/to/app runs another app folder (an A/B baseline) in the same harness build.
if [[ -n ${SCH_APP:-} ]]; then rm -rf $I/WaffleHarness.app/Contents/Resources/app; cp -R ${SCH_APP:A} $I/WaffleHarness.app/Contents/Resources/app; fi
only=${ONLY:+$(print -r -- "${(j:",":)${(s:,:)ONLY}}")}
print -r -- "globalThis.__uiProbes = {run: async () => { try { return 'SCH ' + JSON.stringify(await atriumSchProbe({sheets: ${SCH_SHEETS:-30}${ONLY:+, only: [\"$only\"]}})); } catch (e) { return 'JSERROR ' + e.message + ' ' + e.stack; } }};" > $W/sch-run.js
log=$W/sch.log
HARNESS_SUITE=ui HARNESS_EPHEMERAL=1 HARNESS_PROBES=$ROOT/tests/schematic/sch-bench-project.js:$ROOT/tests/integration/perf-sch.js:$W/sch-run.js HARNESS_WORK=$W/run \
  timeout ${SCH_TIMEOUT:-900} $I/WaffleHarness.app/Contents/MacOS/Waffle 2>&1 | grep --line-buffered -E "^(PASS|FAIL|NOTE|RESULT)" > $log
python3 - "$log" "$W/sch-probes.json" <<'PY'
import sys, json, re
text = open(sys.argv[1]).read()
m = re.search(r'SCH (\{.*\})', text)
if not m: print("FAIL  schematic probe produced numbers"); print(text[-3000:]); sys.exit(1)
r = json.loads(m.group(1)); open(sys.argv[2], "w").write(json.dumps(r, indent=1))
c = r["checks"].get("project", {})
print("WKWebView schematic probe: %s sheets, %s items (densest %s); ms (frames: input -> render -> 1-px readback)" % (c.get("sheets"), c.get("items"), c.get("denseItems")))
for k, v in r["metrics"].items():
    if isinstance(v, dict): print("  %-24s n %3d  p50 %7.1f  p95 %7.1f  max %7.1f" % (k, v["n"], v["p50"], v["p95"], v["max"]))
    elif v is not None: print("  %-24s %8s" % (k, v))
print("  idle wake-ups:", r["checks"].get("idleWakeups"))
errors = r["checks"].get("errors") or []
print(("FAIL  %d page errors: %s" % (len(errors), errors[:5])) if errors else "PASS  WebKit schematic probe")
sys.exit(1 if errors else 0)
PY
rc=$?
grep -q "^RESULT ok" $log || rc=1
exit $rc
