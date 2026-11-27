#!/bin/zsh
# Schematic and whole-project performance (headless Chrome): open, first paint, sheet switch, pan /
# zoom / right-drag / hover frames, part and wire drags, wire drawing, one-edit deferred work,
# select-all and move-all, net highlight, compile (ERC), annotate, cross-probe, search, save
# (incremental serialisation), heap, and idle wake-ups and CPU (energy). The probe is
# tests/integration/perf-sch.js; the synthetic hierarchical projects come from tests/sch-bench-project.js.
#
# Frames are timed synchronously (input -> handler -> render -> raster; no vsync wait), as in
# scripts/perf-canvas.sh stage 2. Idle and post-edit CPU come from the browser's own counters
# (DevTools Performance.getMetrics TaskDuration) between marks the probe sets.
#
# Usage: scripts/perf-sch.sh [--sheets 30|100] [--project path/to/Project.PrjPcb] [--board] [--json] [--out file.json]
#                            [--skip-if-no-browser] [--no-budget]
#   --board measures idle energy on the 25,600-object PCB benchmark board (tests/pcb/dense-board.js)
#   instead: time and CPU until quiet after open and after one small edit, and 10 s windows that must
#   be quiet (they span the 8 s Efficiency-mode heavy insights delay). EFFICIENCY=always (default),
#   off or auto sets Preferences > Energy for the run.
#   --project opens a real project read-only through File › Open (the folder's top-level Altium or
#   KiCad files); nothing is written next to it.
# Env: CHROME=/path/to/chrome  APP=/path/to/app  RUNS=1 (median of RUNS launches)  ONLY=camera,switch,...
#      BUDGET_<METRIC>=ms overrides one p95 budget (metric upper-cased: BUDGET_PANFIT=12).
# Budgets are generous (CI machines vary); the targets on an M-series Mac are interaction frames
# <= 8 ms p95 on the 30-sheet project, sheet switch <= 50 ms, idle wake-ups ~0.
# Exit status: 0 within budget, 1 over budget, 2 no browser or the probe failed.
root=${0:A:h:h}
json=0; skip=0; sheets=30; project=""; out=""; nobudget=0; board=0
while (( $# )); do
  case $1 in
    --json) json=1;; --skip-if-no-browser) skip=1;; --no-budget) nobudget=1;; --board) board=1;;
    --sheets) shift; sheets=$1;; --project) shift; project=${1:A};; --out) shift; out=$1;;
    *) print -u2 "unknown argument $1"; exit 2;;
  esac; shift
done
chrome=${CHROME:-}
for c in "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" "/Applications/Chromium.app/Contents/MacOS/Chromium" ${commands[google-chrome]:-} ${commands[chromium]:-} ${commands[chromium-browser]:-}; do
  [[ -n $c && -z $chrome && -x $c ]] && chrome=$c
done
if [[ ! -x $chrome ]]; then
  print -u2 "perf-sch: Chrome or Chromium not found; set CHROME=/path/to/chrome"
  (( skip )) && { print "perf-sch: SKIPPED (no browser)"; exit 0; }
  exit 2
fi
tmp=$(mktemp -d "${TMPDIR:-/tmp}/atrium-perf-sch.XXXXXX"); trap 'rm -rf $tmp' EXIT
python3 - "$chrome" "${APP:-$root/app}" "$root" "$tmp" "$json" "${RUNS:-1}" "$sheets" "$project" "$out" "$nobudget" "$board" <<'PY'
import sys, os, json, socket, subprocess, time, urllib.request, urllib.parse, statistics
chrome, app, root, tmp, asjson, runs, sheets, project, outpath, nobudget, board = sys.argv[1:12]
board = board == "1"
sys.path.insert(0, os.path.join(root, "scripts", "ci"))
import chrome_cdp
asjson, runs, sheets, nobudget = asjson == "1", int(runs), int(sheets), nobudget == "1"
files = []
if project:
    folder = os.path.dirname(project) if os.path.isfile(project) else project
    exts = (".prjpcb", ".schdoc", ".pcbdoc", ".schlib", ".pcblib", ".kicad_pro", ".kicad_sch", ".kicad_pcb")
    for n in sorted(os.listdir(folder)):
        if n.lower().endswith(exts) and os.path.isfile(os.path.join(folder, n)):
            files.append({"name": n, "url": "file://" + urllib.parse.quote(os.path.join(folder, n))})
    if not files: print("perf-sch: no project files in", folder); sys.exit(2)
h = open(app + "/index.html").read()
h = h.replace("<head>", '<head><base href="file://%s/"><script>window.__errs=[];addEventListener("error",e=>__errs.push(e.message+" @"+(e.filename||"").split("/").pop()+":"+e.lineno));'
    'addEventListener("unhandledrejection",e=>__errs.push("rejection: "+(e.reason&&e.reason.message||e.reason)));</script>' % app, 1)
h = h.replace("</body>", '<script src="file://%s/tests/schematic/sch-bench-project.js"></script>%s<script src="file://%s/tests/integration/perf-sch.js"></script></body>' % (root,
    '<script src="file://%s/tests/pcb/dense-board.js"></script>' % root if board else "", root))
open(tmp + "/sch.html", "w").write(h)

def run_once():
    s0 = socket.socket(); s0.bind(("127.0.0.1", 0)); port = s0.getsockname()[1]; s0.close()
    prof = tmp + "/prof"; subprocess.run(["rm", "-rf", prof])
    proc = subprocess.Popen([chrome, "--headless=new", "--no-first-run", "--allow-file-access-from-files", "--disable-gpu", "--enable-precise-memory-info",
        "--disable-background-timer-throttling", "--disable-renderer-backgrounding", "--js-flags=--expose-gc",
        "--user-data-dir=" + prof, "--remote-debugging-port=%d" % port, "--window-size=1440,900", "--force-device-scale-factor=1",
        "file://" + tmp + "/sch.html"], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    try:
        tab = None
        for _ in range(150):
            try: tab = [t for t in json.load(urllib.request.urlopen("http://127.0.0.1:%d/json" % port)) if t["type"] == "page"][0]; break
            except Exception: time.sleep(.1)
        if not tab: print("perf-sch: the browser did not start"); sys.exit(2)
        wire = chrome_cdp.connect(tab["webSocketDebuggerUrl"],
            eof=lambda: SystemExit("perf-sch: the browser closed the connection"))
        sock = wire.sock
        marks = []
        def readmsg():
            return wire.read_message()
        seq = [0]
        def accept(message):
            if message.get("method") == "Runtime.bindingCalled": marks.append(message["params"]["payload"])
        def call(method, **params):
            seq[0] += 1
            return wire.raw_reply(method, params, seq[0], on_event=accept)
        def cpu():
            ms = {m["name"]: m["value"] for m in call("Performance.getMetrics")["result"]["metrics"]}
            return {"task": ms.get("TaskDuration", 0), "script": ms.get("ScriptDuration", 0), "t": ms.get("Timestamp", time.time())}
        call("Performance.enable"); call("Runtime.enable"); call("Runtime.addBinding", name="__schMark")
        for _ in range(150):
            r = call("Runtime.evaluate", expression="typeof atriumSchProbe==='function'&&!!globalThis.AtriumNavHost&&document.readyState==='complete'", returnByValue=True)
            if r.get("result", {}).get("result", {}).get("value"): break
            time.sleep(.1)
        time.sleep(1.0)
        opts = {"sheets": sheets}
        if files: opts["files"] = files
        if board: opts["board"] = True; opts["efficiency"] = os.environ.get("EFFICIENCY", "always")
        if os.environ.get("ONLY"): opts["only"] = os.environ["ONLY"].split(",")
        call("Runtime.evaluate", expression="window.__schOut=null;atriumSchProbe(Object.assign(%s,{mark:t=>__schMark(t)})).then(o=>__schOut=JSON.stringify(o)).catch(e=>__schOut='ERR '+e.message+' '+e.stack).finally(()=>__schMark('done'))" % json.dumps(opts))
        # Block on DevTools events (no polling, so the idle window is not disturbed); the probe marks
        # phase edges through the binding and "done" at the end.
        t0, v, cpuAt, windows, done = time.time(), None, {}, {}, False
        sock.settimeout(float(os.environ.get("PROBE_TIMEOUT", "600")))
        while not done:
            while not marks:
                try: r = readmsg()
                except socket.timeout: print("perf-sch: probe timed out"); sys.exit(2)
                if r.get("method") == "Runtime.bindingCalled": marks.append(r["params"]["payload"])
            tag = marks.pop(0)
            if tag == "done": done = True; continue
            c = cpu(); kind, edge = tag.rsplit("-", 1)
            if edge == "start": cpuAt[kind] = c
            elif kind in cpuAt:
                a = cpuAt.pop(kind); wall = max(1e-6, c["t"] - a["t"])
                windows.setdefault(kind, []).append({"wallS": round(wall, 3), "cpuMs": round((c["task"] - a["task"]) * 1000, 1), "cpuPct": round(100 * (c["task"] - a["task"]) / wall, 2)})
        v = call("Runtime.evaluate", expression="window.__schOut", returnByValue=True)["result"]["result"].get("value")
        if not v: print("perf-sch: probe timed out"); sys.exit(2)
        errs = call("Runtime.evaluate", expression="JSON.stringify(window.__errs)", returnByValue=True)["result"]["result"]["value"]
        if v.startswith("ERR"): print("perf-sch: probe failed:", v); sys.exit(2)
        out = json.loads(v); out["pageErrors"] = json.loads(errs)
        if "idle" in windows: out["metrics"]["idleCpuPct"] = windows["idle"][0]["cpuPct"]
        if "settle" in windows: out["metrics"]["openSettleCpuMs"] = windows["settle"][0]["cpuMs"]
        if "edit" in windows: out["metrics"]["editWindowCpuMs"] = max(w["cpuMs"] for w in windows["edit"])
        out["cpuWindows"] = windows
        return out
    finally: proc.kill()

results = [run_once() for _ in range(runs)]
def med(vals):
    if isinstance(vals[0], dict): return {q: med([x[q] for x in vals if x and q in x]) for q in vals[0]}
    return round(statistics.median(vals), 2)
metrics = {k: med([r["metrics"][k] for r in results if r["metrics"].get(k) is not None]) for k in results[0]["metrics"] if results[0]["metrics"][k] is not None}
# Budgets: p95 (or the single value) in ms; generous so that shared CI machines pass. Targets are tighter (see the header).
B = {"panFit": 16, "panZoomed": 16, "zoomWheel": 25, "rightDragPan": 16, "hover": 8, "partDrag": 16, "wireDrag": 16, "wireDrawMove": 16,
     "sheetSwitchWarm": 60, "sheetSwitchCold": 120, "editFrame": 33, "nudgeOne": 33, "selectAll": 50, "moveAllDrag": 50, "undo": 50, "redo": 50,
     "netHighlight": 50, "panHighlighted": 16, "editHighlighted": 50, "selectOne": 33, "searchQuery": 30, "editAfterLongMax": 100,
     "idleWakeupsPerSec": 1, "idleWakeupsAfterPerSec": 1, "idleCpuPct": 2, "openQuietAfterMs": 20000, "lastEditQuietAfterMs": 20000,
     "editWindowCpuMs": 200, "autosavePassOneEdit": 30, "heapEndMB": 400}
if sheets >= 100 or files: B = {k: v * 2 for k, v in B.items()}
# The board (--board): nothing may run once the editor is quiet. See the measurements and reasons in
# docs/design/unified-rules-and-checks.md (Idle).
if board: B = {"idleWakeupsPerSec": 0.2, "idleWakeupsAfterPerSec": 0.2, "idleCpuPct": 2, "openQuietAfterMs": 10000, "lastEditQuietAfterMs": 12000,
               "openSettleCpuMs": 1500, "editWindowCpuMs": 400, "editFrame": 100}
B = {k: float(os.environ.get("BUDGET_" + k.upper(), v)) for k, v in B.items()}
fail = []
if not nobudget:
    for k, lim in B.items():
        m = metrics.get(k)
        if m is None: continue
        val = m["p95"] if isinstance(m, dict) else m
        if val is not None and val > lim: fail.append("%s %.2f > %g" % (k, val, lim))
errors = results[-1]["checks"].get("errors", []) + results[-1]["pageErrors"]
if errors: fail.append("%d page error(s)" % len(errors))
report = {"workload": ("PCB benchmark board, Efficiency " + os.environ.get("EFFICIENCY", "always")) if board else ("project " + project) if project else "synthetic %d sheets" % sheets, "metrics": metrics, "checks": results[-1]["checks"],
          "cpuWindows": results[-1]["cpuWindows"], "budgets": B, "failed": fail, "errors": errors, "env": results[-1]["env"], "runs": runs}
if outpath: open(outpath, "w").write(json.dumps(report, indent=1))
if asjson: print(json.dumps(report, indent=1))
else:
    c = results[-1]["checks"].get("project", {})
    print("Schematic performance, %s: %s sheets, %s items, %s parts (densest sheet %s items); headless Chrome, CPU raster, ms" % (report["workload"], c.get("sheets"), c.get("items"), c.get("parts"), c.get("denseItems")))
    for k, m in metrics.items():
        if isinstance(m, dict): print("  %-24s n %3d  p50 %8.2f  p95 %8.2f  max %8.2f   %s" % (k, m["n"], m["p50"], m["p95"], m["max"], ("budget p95 %g" % B[k]) if k in B else ""))
        else: print("  %-24s %10s   %s" % (k, m, ("budget %g" % B[k]) if k in B else ""))
    print("  idle wake-ups:", results[-1]["checks"].get("idleWakeups"))
    if errors: print("  page errors:", errors[:10])
    print("FAIL: " + "; ".join(fail) if fail else "PASS schematic budgets")
sys.exit(1 if fail else 0)
PY
