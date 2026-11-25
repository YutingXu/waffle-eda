#!/bin/zsh
# Live repour budgets on the 25,600-object board (tests/pcb/dense-board.js with nets and ten poured
# polygons), headless Chrome with CPU raster and a real clock (tests/pcb/perf-pour.js over the DevTools
# protocol; python3, no packages). Budgets (ms; override with BUDGET_<NAME>=ms):
#   editToScreen p95  <= 50   a single-object edit to its correct copper painted on the active canvas
#   dragLongTasks     == 0    main-thread long tasks over 50 ms while a part is dragged
#   dragFrame p95     <= 34   rAF interval while dragging (two 60 Hz frames; the display rate is reported)
# Reported, not gated: tileRepour (the worker's affected-tile repour), editToExact (to the exact commit
# Gerber reads), dragPatch, dropToScreen, dropToExact, repourAll, tileInit.
# Each metric is the median over RUNS fresh browser launches (default 3), as in perf-canvas.sh.
# Usage: scripts/perf-pour.sh [--json] [--measure-only]
# Env: CHROME=/path/to/chrome  APP=/path/to/app  DRAG=always|live|drop  RUNS=3  TILES=0 (the exact path only, for comparison)
#      PROBE_UNCHANGED_REPOUR=1 to exercise the no-change display control
root=${0:A:h:h}
json=0; measure=0
for arg in "$@"; do
  case $arg in
    --json) json=1;; --measure-only) measure=1;;
    *) print -u2 "unknown argument $arg"; exit 2;;
  esac
done
chrome=${CHROME:-}
for c in "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" "/Applications/Chromium.app/Contents/MacOS/Chromium" ${commands[google-chrome]:-} ${commands[chromium]:-} ${commands[chromium-browser]:-}; do
  [[ -n $c && -z $chrome && -x $c ]] && chrome=$c
done
[[ -x $chrome ]] || { print -u2 "Chrome or Chromium not found; set CHROME=/path/to/chrome"; exit 2; }
tmp=$(mktemp -d "${TMPDIR:-/tmp}/atrium-pour.XXXXXX"); trap 'rm -rf $tmp' EXIT
python3 - "$chrome" "${APP:-$root/app}" "$root" "$tmp" "$json" "${DRAG:-always}" "${RUNS:-3}" "${TILES:-1}" "$measure" <<'PY'
import sys, os, json, socket, subprocess, time, urllib.request, statistics
chrome, app, root, tmp, asjson, drag, runs, tiles = sys.argv[1], sys.argv[2], sys.argv[3], sys.argv[4], sys.argv[5] == "1", sys.argv[6], int(sys.argv[7]), sys.argv[8] != "0"
sys.path.insert(0, os.path.join(root, "scripts", "ci"))
import chrome_cdp
measure = sys.argv[9] == "1"
h = open(app + "/index.html").read()
h = h.replace("<head>", '<head><base href="file://%s/"><script>window.__errs=[];addEventListener("error",e=>__errs.push(e.message+" @"+(e.filename||"").split("/").pop()+":"+e.lineno));</script>' % app, 1)
h = h.replace("</body>", '<script src="file://%s/tests/pcb/dense-board.js"></script><script src="file://%s/tests/pcb/perf-pour.js"></script></body>' % (root, root))
open(tmp + "/pour.html", "w").write(h)
def run_once():
    s0 = socket.socket(); s0.bind(("127.0.0.1", 0)); port = s0.getsockname()[1]; s0.close()
    subprocess.run(["rm", "-rf", tmp + "/prof"])
    proc = subprocess.Popen([chrome, "--headless=new", "--disable-gpu", "--disable-accelerated-2d-canvas", "--no-first-run", "--allow-file-access-from-files",
        "--user-data-dir=" + tmp + "/prof", "--remote-debugging-port=%d" % port, "--window-size=1440,900", "--force-device-scale-factor=1", "file://" + tmp + "/pour.html"],
        stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    try:
        tab = None
        for _ in range(150):
            try: tab = [t for t in json.load(urllib.request.urlopen("http://127.0.0.1:%d/json" % port)) if t["type"] == "page"][0]; break
            except Exception: time.sleep(.1)
        wire = chrome_cdp.connect(tab["webSocketDebuggerUrl"], timeout=320,
            eof=lambda: ConnectionError("the browser closed the DevTools connection"),
            refused=lambda: ConnectionError("the browser refused the DevTools websocket"))
        def call(method, **params):
            return wire.raw_reply(method, params, 1)
        for _ in range(100):
            r = call("Runtime.evaluate", expression="typeof atriumPourProbe==='function'&&!!globalThis.AtriumNavHost", returnByValue=True)
            if r.get("result", {}).get("result", {}).get("value"): break
            time.sleep(.1)
        time.sleep(1.5)
        options = {"drag": drag, "tiles": tiles, "noChange": os.environ.get("PROBE_UNCHANGED_REPOUR") == "1"}
        r = call("Runtime.evaluate", expression="atriumPourProbe(%s).then(o=>JSON.stringify(o)).catch(e=>'ERR '+e.message+' '+e.stack)" % json.dumps(options), awaitPromise=True, returnByValue=True)
        v = r.get("result", {}).get("result", {}).get("value")
        errs = call("Runtime.evaluate", expression="JSON.stringify(window.__errs)", returnByValue=True)["result"]["result"]["value"]
    finally: proc.kill()
    if not v or v.startswith("ERR"): print("pour probe failed:", v or r); sys.exit(2)
    out = json.loads(v); out["errors"] = json.loads(errs); return out
try: results = [run_once() for _ in range(runs)]
except (socket.timeout, ConnectionError, OSError) as e: print("pour probe: no answer from the browser (%s)" % e); sys.exit(2)
med = lambda xs: None if any(x is None for x in xs) else round(statistics.median(xs), 2)
m = {}
for k, v in results[0]["metrics"].items():
    if isinstance(v, dict):
        m[k] = ({q: med([r["metrics"][k].get(q) for r in results]) for q in v}
                if all(isinstance(r["metrics"].get(k), dict) for r in results) else None)
    else: m[k] = med([r["metrics"].get(k) for r in results])
c = results[-1]["checks"]; c["runs"] = runs; c["dragLongTasksPerRun"] = [r["metrics"].get("dragLongTasks") for r in results]
errors = [e for r in results for e in r["errors"]]
B = lambda k, d: float(os.environ.get("BUDGET_" + k.upper(), d))
fail = []
p95 = lambda k: (m.get(k) or {}).get("p95")
for key, name in (("editsVisible", "visible copper"), ("editsExact", "exact copper")):
    counts = ["%s/%s" % (r["checks"][key], r["checks"]["editsExpected"]) for r in results]
    if any(count != "24/24" for count in counts): fail.append("incomplete %s measurements (per run %s)" % (name, ", ".join(counts)))
if tiles and not measure and p95("editToScreen") is not None and p95("editToScreen") > B("editToScreen", 50):
    fail.append("editToScreen p95 %s ms > %g ms" % (p95("editToScreen"), B("editToScreen", 50)))
if not all(r["checks"].get("fullCopperMatches") for r in results): fail.append("settled copper differs from a fresh exact repour")
if any((r["checks"].get("unchangedRepour") or {}).get("at") is not None for r in results): fail.append("an unchanged Repour All counted as new visible copper")
if not measure and m.get("dragLongTasks") != 0: fail.append("%s main-thread long task(s) over 50 ms while dragging (per run %s, last run at %s)" % (m.get("dragLongTasks"), c["dragLongTasksPerRun"], c.get("dragLongTaskAt")))
if p95("dragFrame") is None: fail.append("missing drag-frame measurement")
elif not measure and p95("dragFrame") > B("dragFrame", 34): fail.append("dragFrame p95 %s ms > %g ms" % (p95("dragFrame"), B("dragFrame", 34)))
if not all(r["checks"].get("dropMoved") for r in results): fail.append("the drag did not move its part")
stale = max(r["checks"].get("staleAtEnd", 0) for r in results)
if stale: fail.append("%s pour(s) left stale" % stale)
if errors: fail.append("page errors: " + json.dumps(errors))
if asjson: print(json.dumps({"metrics": m, "checks": c, "failed": fail}, indent=2))
else:
    print("Live repour, 25.6k board with 10 pours, headless Chrome (%s Hz), real clock, median of %d runs, ms" % (c.get("refreshHz"), runs))
    for k, x in m.items():
        print("  %-14s %s" % (k, "p50 %(p50)s  p95 %(p95)s  max %(max)s  (n %(n)s)" % x if isinstance(x, dict) else x))
    print("  checks: " + json.dumps(c))
    print("FAIL: " + "; ".join(fail) if fail else "PASS all budgets")
sys.exit(1 if fail else 0)
PY
