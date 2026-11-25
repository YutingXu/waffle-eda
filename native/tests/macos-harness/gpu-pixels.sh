#!/bin/zsh
# GPU board renderer pixel test in WKWebView (tests/canvas/gpu-pixels.js; docs/design/gpu-renderer.md): the composited
# WebGL2 frame against the 2D renderer's exact frame through the real Desktop class, on the same boards, views
# and cases as scripts/gpu-pixels.sh (Chrome). Fails when a case is over budget; the images of failing cases
# (all of them with IMAGES=1) are written to <work-folder>/images.
# Usage: native/tests/macos-harness/gpu-pixels.sh [work-folder]   (numbers: <work-folder>/gpu-pixels.json)
# Env: HARNESS_INSTALL as for frame.sh (a real path outside /tmp; native/tests/macos-harness/target/ is a safe
#      in-repo choice, deleted afterwards). GPU_TIMEOUT (default 900 s). IMAGES=1 every case's images.
#      DPR=1 pins the calibrated backing scale. DPR=2 or DPR=native uses the general limits.
#      GPU_FIXTURE=/path/to/a/board adds a read-only fixture from outside the repository.
#      BOARDS, CASES, VIEWS, BUDGETS=none, CALIBRATE=1, CAPTURE_RASTER, FAULTS=all as for scripts/gpu-pixels.sh
#      (budgets: the "webkit" entries of tests/canvas/gpu-pixels-budgets.json).
#      ROBUSTNESS=powerVisibility,contextLost,... (select lifecycle checks, with all other robustness checks off)
H=${0:A:h}; ROOT=${H:h:h:h}; W=${1:-${TMPDIR:-/tmp}/atrium-gpu-pixels-wk}; W=${W:A}
I=${HARNESS_INSTALL:-$HOME/Library/Caches/atrium-harness-gpu}
# FAULTS=all|holes,...: one app run per injected fault (app/canvas/canvas-gpu.js fault()); each must fail the suite.
if [[ -n ${FAULTS:-} ]]; then
  list=(${(s:,:)FAULTS}); [[ $FAULTS == all ]] && list=(holes offset order padText netColor smallVias selection trackWidth pourPatch planning wireGeometry wireTintOrder)
  missed=0; print "Fault injection in WKWebView: each fault must fail the pixel test"
  for f in $list; do
    case $f in
      wireGeometry) board_case=single;;
      wireTintOrder) board_case=netColors;;
      *) board_case="";;
    esac
    if [[ -n $board_case ]]; then
      res=$(FAULTS= FAULT=$f BOARDS=dense VIEWS=fit CASES=$board_case zsh $0 $W/fault-$f 2>&1); rc=$?
      n=$(print -r -- "$res" | grep -c "^FAIL  dense fit\.$board_case: .*raster residual")
    else
      res=$(FAULTS= FAULT=$f zsh $0 $W/fault-$f 2>&1); rc=$?
      n=$(print -r -- "$res" | grep -c '^FAIL  [^GW]')
    fi
    if (( rc == 1 && n > 0 )); then print "  $f: caught, $n case(s) over budget: $(print -r -- "$res" | grep -m3 '^FAIL  [^GW]' | cut -c7-90 | tr '\n' ';')"
    else print "  $f: MISSED (exit $rc)"; missed=$((missed+1)); fi
  done
  print "$( (( missed )) && print FAIL || print PASS)  fault injection (WKWebView): $missed fault(s) missed"; exit $(( missed ? 1 : 0 ))
fi
rm -rf $W/run $W/images; mkdir -p $W/run
python3 - "$ROOT" "$W/fixtures.js" "${IMAGES:-}" "${DPR:-1}" <<'PY' || exit 2
import sys, os, json, base64
root, out, images, requested_dpr = sys.argv[1:5]
if requested_dpr == "native":
    dpr = requested_dpr
else:
    try:
        dpr = float(requested_dpr)
    except ValueError:
        dpr = 0
    if not 1 <= dpr <= 4:
        sys.exit("DPR must be a canvas backing scale between 1 and 4 or native")
if os.environ.get("CALIBRATE") and dpr != 1:
    sys.exit("Set DPR=1 for the stored WKWebView budgets")
fx = {}
for f in ["tests/fixtures/import/demo.kicad_pcb", "tests/fixtures/altium/pidp11-io-expander/PiDP11IOExpander.PcbDoc"]:
    p = os.path.join(root, f)
    if os.path.exists(p): fx[os.path.basename(p)] = base64.b64encode(open(p, "rb").read()).decode()
if extra := os.environ.get("GPU_FIXTURE"):
    name = os.path.basename(extra)
    if name in fx:
        sys.exit("GPU_FIXTURE must have a distinct file name")
    with open(extra, "rb") as fixture:
        fx[name] = base64.b64encode(fixture.read()).decode()
sel = {k: os.environ[e].split(",") for e, k in (("BOARDS", "boards"), ("CASES", "cases"), ("VIEWS", "views"),
    ("ROBUSTNESS", "robustness")) if os.environ.get(e)}
sel["dpr"] = dpr
bf = os.path.join(root, "tests", "canvas", "gpu-pixels-budgets.json")
if dpr == 1 and os.environ.get("BUDGETS") != "none" and os.path.exists(bf):
    thresholds = json.load(open(bf))
    sel.update(budgets=thresholds.get("webkit", {}), raster=thresholds.get("_raster", {}).get("webkit", {}))
if os.environ.get("CAPTURE_RASTER"): sel["captureRaster"] = os.environ["CAPTURE_RASTER"].split(",")
if os.environ.get("FAULT"): sel.update(fault=os.environ["FAULT"], robust=False, images=False)
open(out, "w").write("globalThis.__gpuFixtures=" + json.dumps(fx) + ";globalThis.__gpuSelect=" + json.dumps(sel) + ";" + ("globalThis.__gpuImages=true;" if images else ""))
PY
HARNESS_OUT=$W/build HARNESS_INSTALL=$I $H/build.sh >/dev/null || exit 2
log=$W/gpu-pixels.log
HARNESS_SUITE=ui HARNESS_EPHEMERAL=1 HARNESS_PROBES=$ROOT/tests/pcb/dense-board.js:$W/fixtures.js:$ROOT/tests/canvas/gpu-pixels.js:$H/gpu-pixels-probes.js HARNESS_WORK=$W/run \
  timeout ${GPU_TIMEOUT:-900} $I/WaffleHarness.app/Contents/MacOS/Waffle 2>&1 | grep --line-buffered -E "^(PASS|FAIL|NOTE|RESULT)" > $log
grep -E "^(FAIL|RESULT)|WebKit.framework" $log
python3 - "$log" "$W" "$ROOT" <<'PY'
import sys, json, re, os, base64
log, w, root = sys.argv[1:4]
m = re.search(r'GPUPIXELS (\{.*\})', open(log).read())
if not m: print("FAIL  GPU pixel test produced numbers"); sys.exit(1)
o = json.loads(m.group(1))
imgs = os.path.join(w, "images")
for n in o.pop("imageFiles", []):
    p = os.path.join(w, "run", n)
    if os.path.exists(p):
        os.makedirs(imgs, exist_ok=True)
        open(os.path.join(imgs, n[:-4]), "wb").write(base64.b64decode(open(p).read()))
sys.path.insert(0, os.path.join(root, "scripts"))
from importlib.machinery import SourceFileLoader
rep = SourceFileLoader("gpu_pixels_report", os.path.join(root, "scripts", "gpu-pixels-report.py")).load_module()
if os.environ.get("CALIBRATE"): rep.calibrate(o, root, "webkit")
rc = rep.report(o, os.path.join(w, "gpu-pixels.json"), imgs if os.path.isdir(imgs) else "", "WKWebView", skip_ok=False)
sys.exit(rc)
PY
rc=$?
grep -q "^RESULT ok" $log || rc=1
exit $rc
