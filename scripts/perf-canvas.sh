#!/bin/zsh
# Canvas frame budget on the 25,600-object board (tests/pcb/dense-board.js), headless Chrome with CPU raster.
# Prints first render (cold), fit-view exact redraw, fit-view pan and zoom (gesture frames), zoomed-in pan
# and edit-to-repaint, as p50/p95 in ms with a forced raster flush (getImageData), and fails when a p50 is
# over budget. Each metric is the median over RUNS fresh browser launches.
#   editRepaint  the canvas repaint after an edit (sync of the edited item, chunk rebuild, draw)
#   editCall     the editor's own edit() (undo snapshot, change()), reported but not budgeted
#
# Stage 2 (interactions, tests/editor/perf-interact.js) drives the real editor on the same board with
# nets and ten poured polygons, over the Chrome DevTools protocol (python3, no packages), and
# budgets the p50 input-to-pixels latency of each interaction (event dispatch, handler, render and
# raster; p95/p99 are reported), the live-pour slices and the after-edit work. Continuous
# interactions are held to one 120 Hz frame (8.3 ms); the display's refresh rate is reported.
# Frames that reuse the board layer must match a full repaint byte for byte. Budgets (ms) are
# based on an M-series Mac with CPU raster plus headroom.
# Override any budget with BUDGET_<NAME>=ms (upper-case metric name).
# Usage: scripts/perf-canvas.sh [--json]
# Env: CHROME=/path/to/chrome   APP=/path/to/app   RUNS=3   INTERACT=0 (skip stage 2)  RUNS2=1
#      BUDGET_FIRST=100 BUDGET_FITPAN=8 BUDGET_ZOOMPAN=4 BUDGET_EDIT=16
# Stage 3 (scripts/perf-route.py, ROUTEFEEL=0 skips): routing in real time with push on the same board, routing
#      frame p95 <= 8 ms and input-to-paint p95 <= 25 ms (BUDGET_ROUTE_P95, BUDGET_ROUTE_LATENCY).
# Stage 4 (scripts/perf-bus.py, BUSFEEL=0 skips): an 11-net bus routed in real time with group push on the same board,
#      bus frame p95 <= 8 ms and input-to-paint p95 <= 25 ms (BUDGET_BUS_P95, BUDGET_BUS_LATENCY).
# Stage 5 (scripts/perf-drag.py, DRAGFEEL=0 skips): a QFN-48 with 48 routed tracks dragged in real time with live re-route
#      (cap 32), main-thread work per frame p95 <= 8.3 ms, frame p95 <= 8.3 ms, drop <= 250 ms (BUDGET_DRAG_*).
# Stage 6 (scripts/perf-suggest.py, SUGGEST=0 skips): Route Suggestions hovering 40 connections on the same board and the
#      PiDP-11, first ghost p95 <= 50 ms, frames p95 <= 8.3 ms, main-thread suggestion work <= 8.3 ms.
root=${0:A:h:h}
json=0; [[ $1 == --json ]] && json=1
chrome=${CHROME:-}
for c in "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" "/Applications/Chromium.app/Contents/MacOS/Chromium" ${commands[google-chrome]:-} ${commands[chromium]:-} ${commands[chromium-browser]:-}; do
  [[ -n $c && -z $chrome && -x $c ]] && chrome=$c
done
[[ -x $chrome ]] || { print -u2 "Chrome or Chromium not found; set CHROME=/path/to/chrome"; exit 2; }
tmp=$(mktemp -d "${TMPDIR:-/tmp}/atrium-perf.XXXXXX"); trap 'rm -rf $tmp' EXIT
python3 - "${APP:-$root/app}" "$tmp/page.html" <<'PY'
import sys
app,out=sys.argv[1:3]
h=open(app+"/index.html").read()
h=h.replace("<head>",'<head><base href="file://%s/"><script>window.__errs=[];addEventListener("error",e=>__errs.push(e.message+" @"+(e.filename||"").split("/").pop()+":"+e.lineno));</script>'%app,1)
probe=r'''
function probe(){
  const H=AtriumNavHost,out={};
  const pct=(a,p)=>{const s=[...a].sort((x,y)=>x-y);return +s[Math.min(s.length-1,Math.floor(p*(s.length-1)))].toFixed(2);};
  const stat=a=>({p50:pct(a,.5),p95:pct(a,.95)});
  const {d}=makeAtriumBenchmarkBoard();out.items=d.items.length;
  H.edit(()=>{H.project().documents.push(d);});H.selectDocument(d.id);
  window.dispatchEvent(new CustomEvent("atrium-command",{detail:"fit"}));
  const v=H.view(),c=H.canvas?H.canvas():document.getElementById("canvas"),ctx=c.getContext("2d");
  const RO={hidden:new Set(),selectedIds:new Set(),layer:"Top",layerMode:"all",grid:true,highlight:"",showUnrouted:true};
  // getImageData forces the recorded drawing to raster, so each sample includes pixel work.
  const flush=()=>ctx.getImageData(0,0,1,1);
  const T=f=>{const t=performance.now();f();flush();return performance.now()-t;};
  const RD=()=>v.render(H.doc(),H.defs(),RO);
  v.invalidate();out.firstRender=+T(RD).toFixed(2);
  const fit=[];for(let i=0;i<20;i++)fit.push(T(RD));out.fitRedraw=stat(fit);
  const gesture=()=>{v.moving?.();RD();};
  const pan=[];for(let i=0;i<60;i++)pan.push(T(()=>{v.pan(5,3);gesture();}));out.fitPan=stat(pan);
  const zoomG=[];for(let i=0;i<20;i++)zoomG.push(T(()=>{v.zoom(i%2?1/1.05:1.05,[400,300]);gesture();}));out.fitZoomGesture=stat(zoomG);
  RD();
  for(let i=0;i<6;i++)window.dispatchEvent(new CustomEvent("atrium-command",{detail:"zoom-in"}));
  const zr=[];for(let i=0;i<20;i++)zr.push(T(()=>{v.pan(8,4);RD();}));out.zoomedPanExact=stat(zr);
  const zp=[];for(let i=0;i<60;i++)zp.push(T(()=>{v.pan(8,4);gesture();}));out.zoomedPan=stat(zp);
  window.dispatchEvent(new CustomEvent("atrium-command",{detail:"fit"}));RD();
  const item=H.doc().items.find(i=>i.kind==="track"),edits=[],calls=[];
  for(let i=0;i<12;i++){
    calls.push(T(()=>H.edit(()=>{item.points=item.points.map(p=>[p[0]+.01,p[1]]);})));
    edits.push(T(RD));
  }
  out.editRepaint=stat(edits);out.editCall=stat(calls);
  return out;
}
'''
h=h.replace("</body>",'<script src="canvas/canvas-board-batches.js"></script><script src="../tests/pcb/dense-board.js"></script><script>%s\nlet r;try{r=JSON.stringify(probe())}catch(e){r="ERR "+e.message+" "+e.stack}const p=document.createElement("pre");p.id="MEASURE";p.textContent=r+"\\n"+JSON.stringify(__errs);document.body.append(p)</script></body>'%probe)
open(out,"w").write(h)
PY
for n in {1..${RUNS:-3}}; do
  rm -rf $tmp/prof
  "$chrome" --headless=new --disable-gpu --disable-accelerated-2d-canvas --no-first-run --allow-file-access-from-files \
    --user-data-dir=$tmp/prof --window-size=1440,900 --dump-dom "file://$tmp/page.html" 2>/dev/null > $tmp/run$n.html
done
python3 - "$json" $tmp/run*.html <<'PY'
import sys,re,html,json,os,statistics
asjson=sys.argv[1]=="1";runs=[];errs="[]"
for f in sys.argv[2:]:
  m=re.search(r'<pre id="MEASURE">(.*?)</pre>',open(f).read(),re.S)
  if not m: print("no result from the browser"); sys.exit(2)
  body,errs=html.unescape(m.group(1)).split("\n",1)
  if body.startswith("ERR"): print(body); sys.exit(2)
  runs.append(json.loads(body))
med=lambda xs:round(statistics.median(xs),2)
r={k:(med([x[k] for x in runs]) if isinstance(v,(int,float)) else {q:med([x[k][q] for x in runs]) for q in v}) for k,v in runs[0].items()}
B=lambda k,d:float(os.environ.get(k,d))
budgets={"firstRender":B("BUDGET_FIRST",100),"fitPan":B("BUDGET_FITPAN",8),"zoomedPan":B("BUDGET_ZOOMPAN",4),"editRepaint":B("BUDGET_EDIT",16)}
fail=[]
for k,lim in budgets.items():
  v=r[k] if isinstance(r[k],(int,float)) else r[k]["p50"]
  if v>lim: fail.append("%s %.2f ms > %g ms"%(k,v,lim))
if asjson: print(json.dumps({"results":r,"budgets":budgets,"failed":fail,"errors":json.loads(errs)},indent=2))
else:
  print("25.6k board (%d objects), CPU raster, median of %d runs, ms"%(r["items"],len(runs)))
  for k,v in r.items():
    if k=="items": continue
    s=("%.2f"%v) if isinstance(v,(int,float)) else "p50 %.2f  p95 %.2f"%(v["p50"],v["p95"])
    print("  %-16s %s%s"%(k,s,"   (budget %g)"%budgets[k] if k in budgets else ""))
  if json.loads(errs)!=[]: print("page errors:",errs)
  print("FAIL: "+"; ".join(fail) if fail else "PASS all budgets")
sys.exit(1 if fail else 0)
PY
rc=$?
[[ ${INTERACT:-1} == 0 ]] && exit $rc
python3 - "$chrome" "${APP:-$root/app}" "$root" "$tmp" "$json" "${RUNS2:-1}" <<'PY'
# Stage 2: interaction budgets over the DevTools protocol (a minimal websocket client).
import sys, os, json, socket, subprocess, time, urllib.request, statistics
chrome, app, root, tmp, asjson, runs = sys.argv[1], sys.argv[2], sys.argv[3], sys.argv[4], sys.argv[5] == "1", int(sys.argv[6])
sys.path.insert(0, os.path.join(root, "scripts", "ci"))
import chrome_cdp
h = open(app + "/index.html").read()
h = h.replace("<head>", '<head><base href="file://%s/"><script>window.__errs=[];addEventListener("error",e=>__errs.push(e.message+" @"+(e.filename||"").split("/").pop()+":"+e.lineno));</script>' % app, 1)
h = h.replace("</body>", '<script src="file://%s/tests/pcb/dense-board.js"></script><script src="file://%s/tests/editor/perf-interact.js"></script></body>' % (root, root))
open(tmp + "/interact.html", "w").write(h)
def run_once():
    s0 = socket.socket(); s0.bind(("127.0.0.1", 0)); port = s0.getsockname()[1]; s0.close()
    prof = tmp + "/prof2"; subprocess.run(["rm", "-rf", prof])
    proc = subprocess.Popen([chrome, "--headless=new", "--disable-gpu", "--disable-accelerated-2d-canvas", "--no-first-run", "--allow-file-access-from-files",
        "--enable-precise-memory-info", "--js-flags=--expose-gc", "--user-data-dir=" + prof, "--remote-debugging-port=%d" % port, "--window-size=1440,900",
        "--force-device-scale-factor=1", "file://" + tmp + "/interact.html"], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    try:
        tab = None
        for _ in range(150):
            try: tab = [t for t in json.load(urllib.request.urlopen("http://127.0.0.1:%d/json" % port)) if t["type"] == "page"][0]; break
            except Exception: time.sleep(.1)
        wire = chrome_cdp.connect(tab["webSocketDebuggerUrl"], timeout=420,
            eof=lambda: ConnectionError("the browser closed the DevTools connection"),
            refused=lambda: ConnectionError("the browser refused the DevTools websocket"))
        def call(method, **params):
            return wire.raw_reply(method, params, 1)
        for _ in range(100):
            r = call("Runtime.evaluate", expression="typeof atriumInteractionProbe==='function'&&!!globalThis.AtriumNavHost", returnByValue=True)
            if r.get("result", {}).get("result", {}).get("value"): break
            time.sleep(.1)
        time.sleep(1.5)
        r = call("Runtime.evaluate", expression="atriumInteractionProbe({markers:false}).then(o=>JSON.stringify(o)).catch(e=>'ERR '+e.message+' '+e.stack)", awaitPromise=True, returnByValue=True)
        v = r.get("result", {}).get("result", {}).get("value")
        errs = call("Runtime.evaluate", expression="JSON.stringify(window.__errs)", returnByValue=True)["result"]["result"]["value"]
        if not v or v.startswith("ERR"): print("interaction probe failed:", v or r); sys.exit(2)
        out = json.loads(v); out["errors"] = json.loads(errs); return out
    finally: proc.kill()
try: results = [run_once() for _ in range(runs)]
except (socket.timeout, ConnectionError, OSError) as e: print("interaction probe: no answer from the browser (%s)" % e); sys.exit(2)
med = lambda xs: round(statistics.median(xs), 2)
metrics = {}
for k, v in results[0]["metrics"].items():
    if isinstance(v, dict): metrics[k] = {q: med([r["metrics"][k][q] for r in results]) for q in v}
    elif v is None: metrics[k] = None
    else: metrics[k] = med([r["metrics"][k] for r in results])
checks = results[-1]["checks"]
# p50 budgets (ms) for frame series, value budgets for single measurements.
# Continuous interactions (one frame per pointer or wheel event) must fit one 120 Hz frame (8.3 ms);
# one-shot actions (a click, a toggle, undo) have the measured p50 plus headroom. p50 is gated.
F = 8.3
B = {"panFit": F, "panZoomed": F, "zoomZoomed": F, "hover": F, "boxDrag": F, "moveDrag": F, "walkaround": F, "push": F,
     "netPan": F, "maskPan": F, "maskPanAllTracks": 16, "exactFit": 60, "exactZoomed": 25, "layerToggle": 40, "click": 45,
     "boxUp": 160, "moveDrop": 100, "editFrame": 90, "liveSliceMax": 30, "liveCommit": 16, "afterEditTaskMax": 200,
     "undo": 60, "redo": 60, "undoRecord": 1, "heapEditGrowthMB": 40, "netClick": 25, "netExact": 25, "maskApply": 50, "maskExact": 25, "maskApplyAllTracks": 60, "navClick": 110}
B = {k: float(os.environ.get("BUDGET_" + k.upper(), v)) for k, v in B.items()}
fail = []
for k, lim in B.items():
    v = metrics.get(k); x = v["p50"] if isinstance(v, dict) else v
    if x is None: fail.append("%s: no measurement" % k)
    elif x > lim: fail.append("%s %.2f ms > %g ms" % (k, x, lim))
for k in ("boxReuseDiff", "walkaroundReuseDiff", "pushReuseDiff"):
    if checks.get(k) != 0: fail.append("%s: board-layer reuse differs from a full repaint (%s bytes)" % (k, checks.get(k)))
if checks.get("liveStale") != 0: fail.append("live pours left %s stale pour(s)" % checks.get("liveStale"))
for mode in ("walkaround", "push"):
    if checks.get(mode + "Mode") != mode: fail.append("router did not enter %s mode" % mode)
if not checks.get("netHighlighted"): fail.append("Ctrl+click highlighted no net")
if asjson: print(json.dumps({"interactions": metrics, "checks": checks, "budgets": B, "failed": fail, "errors": results[-1]["errors"]}, indent=2))
else:
    print("Interactions on the 25.6k board with nets and 10 pours, CPU raster, p50/p95 ms (median of %d run%s)" % (runs, "" if runs == 1 else "s"))
    for k, v in metrics.items():
        s = ("%.2f" % v) if isinstance(v, (int, float)) else "p50 %.2f  p95 %.2f" % (v["p50"], v["p95"]) if v else "-"
        print("  %-20s %s%s" % (k, s, "   (budget %g)" % B[k] if k in B else ""))
    print("  checks: " + ", ".join("%s=%s" % kv for kv in checks.items()))
    if results[-1]["errors"]: print("page errors:", results[-1]["errors"])
    print("FAIL: " + "; ".join(fail) if fail else "PASS all interaction budgets")
sys.exit(1 if fail else 0)
PY
rc2=$?
(( rc2 > rc )) && rc=$rc2
# Stage 3: routing feel in real time (real mouse events, real clock): routing frame p95 and input-to-paint latency.
if [[ ${ROUTEFEEL:-1} != 0 ]]; then
  CHROME=$chrome APP=${APP:-$root/app} python3 $root/scripts/perf-route.py ${${json:#0}:+--json}
  rc3=$?
  (( rc3 > rc )) && rc=$rc3
fi
# Stage 4: bus routing feel in real time (11 nets, group push): bus frame p95 and input-to-paint latency.
if [[ ${BUSFEEL:-1} != 0 ]]; then
  CHROME=$chrome APP=${APP:-$root/app} python3 $root/scripts/perf-bus.py ${${json:#0}:+--json}
  rc4=$?
  (( rc4 > rc )) && rc=$rc4
fi
# Stage 5: dynamic re-route on component drag in real time: per-frame main-thread work, frame time, drop.
if [[ ${DRAGFEEL:-1} != 0 ]]; then
  CHROME=$chrome APP=${APP:-$root/app} python3 $root/scripts/perf-drag.py ${${json:#0}:+--json}
  rc5=$?
  (( rc5 > rc )) && rc=$rc5
fi
# Stage 6: Route Suggestions in real time (worker search): first ghost p95 <= 50 ms, frames p95 <= 8.3 ms,
# main-thread suggestion work <= 8.3 ms (scripts/perf-suggest.py; SUGGEST=0 skips).
if [[ ${SUGGEST:-1} != 0 ]]; then
  CHROME=$chrome APP=${APP:-$root/app} python3 $root/scripts/perf-suggest.py ${${json:#0}:+--json}
  rc5=$?
  (( rc5 > rc )) && rc=$rc5
fi
exit $rc
