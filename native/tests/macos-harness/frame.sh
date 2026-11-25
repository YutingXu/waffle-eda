#!/bin/zsh
# WebKit frame budgets: the real Desktop class and WKWebView (the macOS app's engine) on the 25.6k-object
# board of tests/pcb/dense-board.js, driven in real time by frame-probes.js (pan, wheel and pinch zoom,
# right-drag pan, hover, box marquee, move-drag and routing; click select and layer toggles; DRC markers
# with 1,000 violations). No pixel readback while timing; see
# Usage: native/tests/macos-harness/frame.sh [work-folder]   (numbers: <work-folder>/frame-probes.json)
# Env: HARNESS_INSTALL  where the app bundle goes (default ~/Library/Caches/atrium-harness-frame). It must be
#      a real path outside /tmp and /var (see ui.sh); native/tests/macos-harness/target/ is a safe in-repo
#      choice, deleted afterwards. FRAME_TIMEOUT (default 900 s; a run takes about 3 minutes).
#      FRAME_RENDERER=2d|gpu|auto sets Preferences › Display › Renderer for the run.
#      FRAME_BUDGET_<NAME>=ms overrides one budget (name as printed, "." as "_": FRAME_BUDGET_ZOOMED_PAN=10).
# Budgets: main-thread work p50 of each continuous interaction within one 120 Hz frame (8.3 ms), at most
# 10 % dropped frames (interval over 1.5 refresh intervals) for pan, wheel zoom, drag-pan, box and move
# drags, and routing; one-shots by name below. At rest the canvas must equal a full repaint (clickRestDiff 0).
H=${0:A:h}; ROOT=${H:h:h:h}; W=${1:-${TMPDIR:-/tmp}/atrium-frame}; W=${W:A}
I=${HARNESS_INSTALL:-$HOME/Library/Caches/atrium-harness-frame}
mkdir -p $W/run
HARNESS_OUT=$W/build HARNESS_INSTALL=$I $H/build.sh >/dev/null || exit 2
log=$W/frame.log
# FRAME_RENDERER=2d|gpu|auto: Preferences › Display › Renderer for the run (default: the app's default).
pre=""
if [[ -n ${FRAME_RENDERER:-} ]]; then
  print -r -- "globalThis.AtriumLazy.need('AtriumPrefs').then(P=>P.set('display.renderer','$FRAME_RENDERER'),()=>{});" > $W/renderer.js; pre=$W/renderer.js:
fi
HARNESS_SUITE=ui HARNESS_EPHEMERAL=1 HARNESS_PROBES=$pre$ROOT/tests/pcb/dense-board.js:$H/frame-probes.js HARNESS_WORK=$W/run \
  timeout ${FRAME_TIMEOUT:-900} $I/WaffleHarness.app/Contents/MacOS/Waffle 2>&1 | grep --line-buffered -E "^(PASS|FAIL|NOTE|RESULT)" > $log
grep -E "^(FAIL|RESULT)|WebKit.framework|60fps" $log
python3 - "$log" "$W/frame-probes.json" <<'PY'
import sys, json, re, os
text = open(sys.argv[1]).read()
m = re.search(r'FRAME (\{.*\})', text)
if not m: print("FAIL  frame probe produced numbers"); sys.exit(1)
r = json.loads(m.group(1)); open(sys.argv[2], "w").write(json.dumps(r, indent=1))
M = r["metrics"]; bad = 0
def budget(name, default):
    return float(os.environ.get("FRAME_BUDGET_" + name.upper().replace(".", "_"), default))
print("WKWebView frames on the 25.6k board, refresh %s Hz (frame %s ms): dt rAF-to-rAF, work = render's main-thread ms, lat = input to paint" % (r["refreshHz"], r["intervalMs"]))
continuous = ["pan", "zoomWheel", "pinch", "dragPan", "boxDrag", "moveDrag", "route", "drcPan"]
smooth = {"pan", "zoomWheel", "dragPan", "boxDrag", "moveDrag", "route", "drcPan"}
oneshot = {"click": 25, "layerToggle": 45, "drcExact": 60, "drcHover": 45, "undo": 45, "redo": 45}
for k, v in M.items():
    if not isinstance(v, dict): continue
    kind = k.split(".", 1)[1]
    line = "  %-20s" % k + "  ".join("%s %s" % (f, v.get(f)) for f in ["dt50", "dt95", "slow", "frames", "work50", "work95", "lat50", "lat95"] if f in v)
    verdict = ""
    if kind in continuous and v.get("work50") is not None:
        b = budget(k, 8.3); ok = v["work50"] <= b
        if kind in smooth and v.get("frames"): ok = ok and v["slow"] <= .1 * v["frames"]
        verdict = ("PASS" if ok else "FAIL") + " (work p50 <= %g%s)" % (b, ", dropped <= 10 %" if kind in smooth else ""); bad += not ok
    elif kind in oneshot and v.get("work50") is not None:
        b = budget(k, oneshot[kind]); ok = v["work50"] <= b
        verdict = ("PASS" if ok else "FAIL") + " (work p50 <= %g)" % b; bad += not ok
    print(line + ("   " + verdict if verdict else ""))
for k, v in M.items():
    if k.endswith("RestDiff"):
        ok = v == 0; bad += not ok; print("%s  %s = %s (at rest the canvas equals a full repaint)" % ("PASS" if ok else "FAIL", k, v))
    elif k.endswith("DirtyBytes"): print("NOTE  %s = %s (the selection frame before its exact frame on idle)" % (k, v))
print("%s  WebKit frame budgets" % ("FAIL" if bad else "PASS"))
sys.exit(1 if bad else 0)
PY
rc=$?
grep -q "^RESULT ok" $log || rc=1
exit $rc
