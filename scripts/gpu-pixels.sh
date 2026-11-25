#!/bin/zsh
# GPU board renderer pixel test in headless Chrome WITH the GPU (tests/canvas/gpu-pixels.js):
# the composited WebGL2 frame against the 2D renderer's exact frame on the dense board, the starter board and two
# imported boards (KiCad demo, PiDP-11 Altium), at fit, zoomed and close, in every layer mode, with a selection,
# a highlighted net, net colours, the light theme, opacity below 1 and a flipped board. The WKWebView run of the
# same test is native/tests/macos-harness/gpu-pixels.sh.
# Usage: scripts/gpu-pixels.sh [out.json] [--skip-if-no-webgl]
# Env: CHROME=/path/to/chrome  APP=/path/to/app  IMAGES=<dir> (every case's 2D, GPU and diff PNGs; without it,
#      only failing cases' images go to $TMPDIR/atrium-gpu-pixels)  BOARDS=dense,starter,...  CASES=base,dim,...
#      VIEWS=fit,zoomed,close  DPR=1  BUDGET='{"interiorPx":50}' (overrides every case; see tests/canvas/gpu-pixels.js)
#      BUDGETS=none (diagnosis: ignore the per-case budgets and raster residual baselines)
#      CAPTURE_RASTER=board.view.case,... (include these cases' tile fingerprints in the result JSON)
#      ROBUSTNESS=powerVisibility,contextLost,... (select lifecycle checks, with all other robustness checks off)
#      FAULTS=all|holes,offset,... the fault-injection matrix instead: every fault must fail the suite.
#      CALIBRATE=1 (with BUDGETS=none) writes this run's per-case budgets to tests/canvas/gpu-pixels-budgets.json.
# Exit: 0 every case within budget (or skipped: no WebGL2 with --skip-if-no-webgl), 1 a case over budget, 2 no run.
root=${0:A:h:h}
out=""; skip=0
for a in "$@"; do case $a in --skip-if-no-webgl) skip=1;; *) out=$a;; esac; done
chrome=${CHROME:-}
for c in "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" "/Applications/Chromium.app/Contents/MacOS/Chromium" ${commands[google-chrome]:-} ${commands[chromium]:-} ${commands[chromium-browser]:-}; do
  [[ -n $c && -z $chrome && -x $c ]] && chrome=$c
done
if [[ ! -x $chrome ]]; then
  (( skip )) && { print "SKIP  gpu-pixels: Chrome or Chromium not found"; exit 0; }
  print -u2 "Chrome or Chromium not found; set CHROME=/path/to/chrome"; exit 2
fi
# FAULTS: one fresh page per injected fault (app/canvas/canvas-gpu.js fault()); each must fail the suite.
if [[ -n ${FAULTS:-} ]]; then
  list=(${(s:,:)FAULTS}); [[ $FAULTS == all ]] && list=(holes offset order padText netColor smallVias selection trackWidth pourPatch planning wireGeometry wireTintOrder)
  missed=0; print "Fault injection in Chrome: each fault must fail the pixel test"
  for f in $list; do
    case $f in
      wireGeometry) board_case=single;;
      wireTintOrder) board_case=netColors;;
      *) board_case="";;
    esac
    if [[ -n $board_case ]]; then
      res=$(FAULTS= FAULT=$f BOARDS=dense VIEWS=fit CASES=$board_case zsh $0 2>&1); rc=$?
      n=$(print -r -- "$res" | grep -c "^FAIL  dense fit\.$board_case: .*raster residual")
    else
      res=$(FAULTS= FAULT=$f zsh $0 2>&1); rc=$?
      n=$(print -r -- "$res" | grep -c '^FAIL  [^GW]')
    fi
    if (( rc == 1 && n > 0 )); then print "  $f: caught, $n case(s) over budget: $(print -r -- "$res" | grep -m3 '^FAIL  [^G]' | cut -c7-90 | tr '\n' ';')"
    else print "  $f: MISSED (exit $rc)"; missed=$((missed+1)); fi
  done
  print "$( (( missed )) && print FAIL || print PASS)  fault injection (Chrome): $missed fault(s) missed"; exit $(( missed ? 1 : 0 ))
fi
tmp=$(mktemp -d "${TMPDIR:-/tmp}/atrium-gpu-px.XXXXXX"); trap 'rm -rf $tmp' EXIT
python3 - "$chrome" "${APP:-$root/app}" "$root" "$tmp" "$out" "${IMAGES:-}" "${DPR:-1}" "$skip" <<'PY'
import sys, os, json, socket, base64, subprocess, time, urllib.request
chrome, app, root, tmp, outp, images, dpr, skip = sys.argv[1:9]
sys.path.insert(0, os.path.join(root, "scripts", "ci"))
import chrome_cdp
fx = {}
for f in ["tests/fixtures/import/demo.kicad_pcb", "tests/fixtures/altium/pidp11-io-expander/PiDP11IOExpander.PcbDoc"]:
    p = os.path.join(root, f)
    if os.path.exists(p): fx[os.path.basename(p)] = base64.b64encode(open(p, "rb").read()).decode()
open(tmp + "/fixtures.js", "w").write("globalThis.__gpuFixtures=" + json.dumps(fx) + ";")
h = open(app + "/index.html").read()
h = h.replace("<head>", '<head><base href="file://%s/"><script>window.__errs=[];addEventListener("error",e=>__errs.push(e.message+" @"+(e.filename||"").split("/").pop()+":"+e.lineno));</script>' % app, 1)
h = h.replace("</body>", '<script src="file://%s/tests/pcb/dense-board.js"></script><script src="file://%s/fixtures.js"></script><script src="file://%s/tests/canvas/gpu-pixels.js"></script></body>' % (root, tmp, root))
open(tmp + "/px.html", "w").write(h)
s0 = socket.socket(); s0.bind(("127.0.0.1", 0)); port = s0.getsockname()[1]; s0.close()
proc = subprocess.Popen([chrome, "--headless=new", "--no-first-run", "--allow-file-access-from-files", "--ignore-gpu-blocklist",
    "--user-data-dir=" + tmp + "/prof", "--remote-debugging-port=%d" % port, "--window-size=1440,900", "--force-device-scale-factor=" + dpr,
    "about:blank"], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
try:
    tab = None
    for _ in range(150):
        try: tab = [t for t in json.load(urllib.request.urlopen("http://127.0.0.1:%d/json" % port)) if t["type"] == "page"][0]; break
        except Exception: time.sleep(.1)
    if not tab: print("FAIL  gpu-pixels: Chrome did not start"); sys.exit(2)
    wire = chrome_cdp.connect(tab["webSocketDebuggerUrl"], timeout=1800, eof=lambda: ConnectionError("closed"))
    def call(method, **params):
        return wire.raw_reply(method, params, 1)

    # The fixed raster was captured at a 1440×813 CSS viewport. Window geometry
    # includes browser chrome and can vary independently of the page viewport.
    metrics = call("Emulation.setDeviceMetricsOverride", width=1440, height=813,
                   deviceScaleFactor=float(dpr), mobile=False)
    if "error" in metrics:
        print("FAIL  gpu-pixels: could not set the calibrated viewport:", metrics["error"]); sys.exit(2)
    navigation = call("Page.navigate", url="file://" + tmp + "/px.html")
    if "error" in navigation or navigation.get("result", {}).get("errorText"):
        print("FAIL  gpu-pixels: could not open the pixel fixture:", navigation); sys.exit(2)
    for _ in range(150):
        r = call("Runtime.evaluate", expression="typeof atriumGpuPixels==='function'&&!!globalThis.AtriumNavHost", returnByValue=True)
        if r.get("result", {}).get("result", {}).get("value"): break
        time.sleep(.1)
    time.sleep(1.5)
    opts = {"images": True if images else None}
    for env, key in (("BOARDS", "boards"), ("CASES", "cases"), ("VIEWS", "views"), ("ROBUSTNESS", "robustness")):
        if os.environ.get(env): opts[key] = os.environ[env].split(",")
    if os.environ.get("BUDGET"): opts["budget"] = json.loads(os.environ["BUDGET"])
    if os.environ.get("BUDGETS") != "none":
        bf = os.path.join(root, "tests", "canvas", "gpu-pixels-budgets.json")
        if os.path.exists(bf):
            thresholds = json.load(open(bf))
            opts["budgets"] = thresholds.get("chrome", {})
            if float(dpr) == 1: opts["raster"] = thresholds.get("_raster", {}).get("chrome", {})
    if os.environ.get("CAPTURE_RASTER"): opts["captureRaster"] = os.environ["CAPTURE_RASTER"].split(",")
    if os.environ.get("FAULT"): opts["fault"] = os.environ["FAULT"]; opts["robust"] = False; opts["images"] = False
    r = call("Runtime.evaluate", expression="atriumGpuPixels(%s).then(o=>JSON.stringify(o)).catch(e=>'ERR '+e.message+' '+e.stack)" % json.dumps(opts), awaitPromise=True, returnByValue=True)
    v = r.get("result", {}).get("result", {}).get("value")
    errs = call("Runtime.evaluate", expression="JSON.stringify(window.__errs)", returnByValue=True)["result"]["result"]["value"]
    if not v or v.startswith("ERR"): print("FAIL  gpu-pixels: probe failed:", (v or str(r))[:2000]); sys.exit(2)
    o = json.loads(v); o["errors"] = json.loads(errs)
    sys.path.insert(0, os.path.join(root, "scripts"))
    from importlib.machinery import SourceFileLoader
    rep = SourceFileLoader("gpu_pixels_report", os.path.join(root, "scripts", "gpu-pixels-report.py")).load_module()
    if os.environ.get("CALIBRATE"): rep.calibrate(o, root, "chrome")
    sys.exit(rep.report(o, outp, images, "Chrome", skip == "1"))
finally: proc.kill()
PY
