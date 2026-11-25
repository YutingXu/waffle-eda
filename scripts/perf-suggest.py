#!/usr/bin/env python3
"""Route Suggestions budgets in real time (stage 6 of scripts/perf-canvas.sh).

Drives the real editor over the Chrome DevTools protocol (python3, no packages) with real
Input.dispatchMouseEvent hovers on the real clock, with the Route tool on:
  - the 25,600-object board of tests/pcb/dense-board.js, with 60 two-pin nets between nearby resistors
    (connections of 3-12 mm through the dense copper; pads the generator overlaps with other copper
    are skipped, since no legal route exists there), and
  - the PiDP-11 I/O expander (tests/fixtures/altium/pidp11-io-expander, BSD-2-Clause)
    with each two-pin net's copper ripped up, so its human-routed connections are unrouted.
The pointer moves onto each connection line in turn and waits for the ghost.

  firstGhost   pointer reaching a new connection -> first frame that paints its ghost   budget: p95 <= 50 ms
  frame        rAF frames while hovering (render + route-feel + ghost)                   budget: p95 <= 8.3 ms
  mainTask     main-thread work of a suggestion (hit test, window, post; never the search) budget: max <= 8.3 ms
  worker       the search ran in the worker (not on the main thread)                     must be true
  found        connections that got a ghost                                              must be >= 90 %

Usage: scripts/perf-suggest.py [--json] [--shots DIR]   (perf-canvas.sh runs it; SUGGEST=0 skips it there)
  --shots DIR  also saves real-clock frames of ghost -> Tab accept -> next suggestion on the PiDP-11
Env:   CHROME  APP=/path/to/app  BUDGET_SUGGEST_P95=50  BUDGET_SUGGEST_FRAME=8.3  BUDGET_SUGGEST_MAIN=8.3
"""
import subprocess
import base64, importlib.util, json, os, shutil, sys, tempfile, time

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
APP = os.environ.get("APP") or os.path.join(ROOT, "app")
spec = importlib.util.spec_from_file_location("perf_route", os.path.join(ROOT, "scripts", "perf-route.py"))
asjson = "--json" in sys.argv
shots = sys.argv[sys.argv.index("--shots") + 1] if "--shots" in sys.argv else None
# perf-route.py runs its benchmark at import; take only its Page class.
src = open(os.path.join(ROOT, "scripts", "perf-route.py")).read()
ns = {"__name__": "perf_route_lib", "__file__": os.path.join(ROOT, "scripts", "perf-route.py")}
exec(compile(src[:src.index("SETUP = ")], "perf-route.py", "exec"), ns)
Page = ns["Page"]

SETUP_DENSE = r"""(async()=>{
for(const d of document.querySelectorAll('dialog[open]'))d.close();
const H=AtriumNavHost;await AtriumLazy.need(["AtriumRouter","AtriumRouteSuggest"]);
const {d,defs}=makeAtriumBenchmarkBoard(),R=AtriumRouter,ru=R.core.rulesFor(d);
// 60 two-pin nets between resistors 3-12 mm apart whose pads are clear of other copper (the
// generator overlaps some pads with other-net tracks; those connections have no legal route).
const padAt=(part,num)=>{const fp=defs.get(part.def).footprint.pads.find(p=>String(p.number)===num);return Atrium.world([fp.x,fp.y],part);};
const clear=(W,p,net)=>R.check(W,ru,{layer:"Top",width:.25,net,points:[p,[p[0]+.01,p[1]]]}).slack>=0;
const rs=d.items.filter(i=>i.kind==="part"&&i.def==="std-r");let n=0;const used=new Set(),pairs=[];
for(const a of rs){if(pairs.length>=120)break;if(used.has(a.id)||a.x<20||a.y<20)continue;
  const b=rs.find(r=>!used.has(r.id)&&r!==a&&Math.hypot(r.x-a.x,r.y-a.y)>3&&Math.hypot(r.x-a.x,r.y-a.y)<12&&(r.x>a.x+2));
  if(!b)continue;used.add(a.id);used.add(b.id);a.pinNets={"1":"S"+n};b.pinNets={"2":"S"+n};pairs.push([a,b,"S"+n]);n++;}
const W=R.world(d,defs);let k=0;
for(const [a,b,net] of pairs){if(k<60&&clear(W,padAt(a,"1"),net)&&clear(W,padAt(b,"2"),net))k++;else{a.pinNets={};b.pinNets={};}}
H.edit(()=>{H.project().documents.push(d);});H.selectDocument(d.id);
await new Promise(r=>setTimeout(r,600));
return JSON.stringify({nets:k});})()"""

SETUP_PROJECT = r"""(async()=>{
for(const d of document.querySelectorAll('dialog[open]'))d.close();
const H=AtriumNavHost,p=JSON.parse(__PROJECT__);
const d=p.documents.find(x=>x.kind==="pcb"),defs=new Map(p.library.map(x=>[x.id,x]));
// Rip every two-pin net's tracks and vias: the human-routed connections become unrouted.
const pads=new Map();for(const it of d.items)if(it.kind==="part")for(const n of Object.values(it.pinNets||{}))if(n)pads.set(n,(pads.get(n)||0)+1);
const two=new Set([...pads].filter(([n,c])=>c===2).map(([n])=>n));
d.items=d.items.filter(i=>!((i.kind==="track"||i.kind==="via")&&two.has(i.net)));
await H.replaceProject(p,{force:true});
await AtriumLazy.need(["AtriumRouter","AtriumRouteSuggest"]);await new Promise(r=>setTimeout(r,600));
return JSON.stringify({nets:two.size});})()"""

INSTRUMENT = r"""(()=>{const H=AtriumNavHost,c=H.canvas(),ctx=c.getContext("2d"),raf=window.requestAnimationFrame.bind(window),v=H.view(),r0=v.render;let rendered=false;
if(!window.__wrapped){window.__wrapped=1;v.render=function(...a){rendered=true;return r0.apply(this,a);};
window.requestAnimationFrame=cb=>raf(ts=>{rendered=false;const t0=performance.now();cb(ts);if(!rendered)return;ctx.getImageData(0,0,1,1);__f.push(performance.now()-t0);});
new PerformanceObserver(l=>{for(const e of l.getEntries())__long.push(e.duration);}).observe({entryTypes:["longtask"]});}
window.__f=[];window.__long=[];AtriumRouteSuggest._state.lat.length=0;AtriumRouteSuggest._state.mainMs.length=0;
H.setTool("route");H.redraw();
const aw=(H.connections()?.airwires||[]).filter(w=>Math.hypot(w.to[0]-w.from[0],w.to[1]-w.from[1])>2);
return JSON.stringify(aw.slice(0,40).map(w=>({net:w.net,from:w.from,to:w.to})));})()"""

RESULT = r"""(()=>{const q=(a,p)=>{const s=a.slice().sort((x,y)=>x-y);return s.length?+s[Math.min(s.length-1,Math.floor(p*(s.length-1)))].toFixed(2):null;};
const D=AtriumRouteSuggest.debug(),main=AtriumRouteSuggest._state.mainMs;const byKind={};for(const [k,v] of main){byKind[k]=Math.max(byKind[k]||0,v);}
return JSON.stringify({firstGhost:D.latency,frame:{n:__f.length,p50:q(__f,.5),p95:q(__f,.95),max:q(__f,1)},mainMax:byKind,mainTaskMax:+Math.max(0,...main.filter(m=>m[0]!=="index"&&m[0]!=="conventions").map(m=>m[1])).toFixed(2),
  oncePerEdit:{index:byKind.index||0,conventions:byKind.conventions||0},longTasks:__long.length,worker:D.worker,errors:__errs});})()"""


def scr(p, w):
    return json.loads(p.eval("(()=>{const H=AtriumNavHost,b=H.canvas().getBoundingClientRect(),s=H.view().worldToScreen(%s);return JSON.stringify([s[0]+b.left,s[1]+b.top]);})()" % json.dumps(w)))


def hover_all(p, wires, scale):
    found = 0
    for w in wires:
        mid = [(w["from"][0] * 0.7 + w["to"][0] * 0.3), (w["from"][1] * 0.7 + w["to"][1] * 0.3)]
        p.eval("(()=>{const H=AtriumNavHost,v=H.view();v.restoreCamera({...v.camera(),cx:%f,cy:%f,scale:%f});H.redraw();return 1;})()" % (mid[0], mid[1], scale))
        time.sleep(0.05)
        a = scr(p, [mid[0] + 1.5, mid[1] + 1.5]); b = scr(p, mid)
        before = json.loads(p.eval("JSON.stringify(AtriumRouteSuggest.debug().latency.n)"))
        for k in range(1, 7):     # approach the line at ~60 Hz
            p.mouse("mouseMoved", a[0] + (b[0] - a[0]) * k / 6, a[1] + (b[1] - a[1]) * k / 6); time.sleep(1 / 60)
        t_end = time.time() + 0.6
        while time.time() < t_end:
            if json.loads(p.eval("JSON.stringify(AtriumRouteSuggest.debug().latency.n)")) > before: found += 1; break
            time.sleep(0.01)
        p.mouse("mouseMoved", a[0] + 40, a[1] + 40); time.sleep(0.05)
    return found


def run(kind, tmp):
    h = open(APP + "/index.html").read()
    h = h.replace("<head>", '<head><base href="file://%s/"><script>window.__errs=[];addEventListener("error",e=>__errs.push(e.message+" @"+(e.filename||"").split("/").pop()+":"+e.lineno));</script>' % APP, 1)
    h = h.replace("</body>", '<script src="file://%s/tests/pcb/dense-board.js"></script></body>' % ROOT)
    open(tmp + "/suggest.html", "w").write(h)
    shutil.rmtree(tmp + "/prof-route", ignore_errors=True)
    p = Page("file://" + tmp + "/suggest.html", tmp)
    try:
        for _ in range(100):
            if p.eval("!!globalThis.AtriumNavHost&&typeof makeAtriumBenchmarkBoard==='function'"): break
            time.sleep(.1)
        time.sleep(1.5)
        if kind == "dense":
            info = json.loads(p.eval(SETUP_DENSE)); scale = 14
        else:
            proj = subprocess.check_output(
                ["node", "-e", "process.stdout.write(JSON.stringify(require('./tests/support/public-pidp.cjs').publicPiDP()))"],
                cwd=ROOT, text=True)
            info = json.loads(p.eval(SETUP_PROJECT.replace("__PROJECT__", json.dumps(proj)))); scale = 18
        wires = json.loads(p.eval(INSTRUMENT))
        time.sleep(0.8)   # the worker starts and loads its scripts on idle
        found = hover_all(p, wires, scale)
        time.sleep(0.2)
        r = json.loads(p.eval(RESULT)); r.update(info); r["connections"] = len(wires); r["found"] = found
        if shots and kind == "pidp11": r["shots"] = screenshots(p, wires, scale)
        return r
    finally:
        p.close()


def save(p, path):
    data = p.call("Page.captureScreenshot", format="png")["data"]
    open(path, "wb").write(base64.b64decode(data))
    return path


def screenshots(p, wires, scale):
    os.makedirs(shots, exist_ok=True)
    out = []
    w = max(wires[:12], key=lambda w: abs(w["to"][0] - w["from"][0]) + abs(w["to"][1] - w["from"][1]))
    cx, cy = (w["from"][0] + w["to"][0]) / 2, (w["from"][1] + w["to"][1]) / 2
    span = max(abs(w["to"][0] - w["from"][0]), abs(w["to"][1] - w["from"][1]), 8)
    p.eval("(()=>{const H=AtriumNavHost,v=H.view();v.restoreCamera({...v.camera(),cx:%f,cy:%f,scale:%f});H.redraw();return 1;})()" % (cx, cy, min(40, 900 / span)))
    time.sleep(0.2)
    mid = [(w["from"][0] * 0.75 + w["to"][0] * 0.25), (w["from"][1] * 0.75 + w["to"][1] * 0.25)]
    a, b = scr(p, [mid[0] + 1, mid[1] + 1]), scr(p, mid)
    for k in range(1, 7): p.mouse("mouseMoved", a[0] + (b[0] - a[0]) * k / 6, a[1] + (b[1] - a[1]) * k / 6); time.sleep(1 / 60)
    time.sleep(0.25)
    out.append(save(p, os.path.join(shots, "suggest-1-ghost.png")))
    key = lambda k, code, kc, mods=0: [p.call("Input.dispatchKeyEvent", type=t, key=k, code=code, windowsVirtualKeyCode=kc, modifiers=mods) for t in ("rawKeyDown", "keyUp")]
    p.eval("AtriumNavHost.canvas().focus(),1")
    key("Tab", "Tab", 9, 8); time.sleep(0.12)   # Shift+Tab: next alternative
    out.append(save(p, os.path.join(shots, "suggest-2-alternative.png")))
    key("Tab", "Tab", 9, 8); key("Tab", "Tab", 9, 8); time.sleep(0.12)   # back round to the first (3 alternatives) or onward
    key("Tab", "Tab", 9); time.sleep(0.06)        # Tab: accept, mid settle animation
    out.append(save(p, os.path.join(shots, "suggest-3-accept-settle.png")))
    time.sleep(0.5)                                # the next connection nearby is suggested
    out.append(save(p, os.path.join(shots, "suggest-4-next.png")))
    state = json.loads(p.eval("JSON.stringify({undo:AtriumNavHost.undoSteps().history.length,visible:AtriumRouteSuggest.visible(),status:document.getElementById('status')?.textContent||''})"))
    out.append(state)
    return out


tmp = tempfile.mkdtemp(prefix="atrium-suggest.")
try:
    res = {"dense25k": run("dense", tmp), "pidp11": run("pidp11", tmp)}
finally:
    shutil.rmtree(tmp, ignore_errors=True)
B = {"firstGhostP95": float(os.environ.get("BUDGET_SUGGEST_P95", 50)), "frameP95": float(os.environ.get("BUDGET_SUGGEST_FRAME", 8.3)), "mainTask": float(os.environ.get("BUDGET_SUGGEST_MAIN", 8.3))}
fail = []
for k, r in res.items():
    if r["firstGhost"]["p95"] is None or r["firstGhost"]["p95"] > B["firstGhostP95"]: fail.append("%s: first ghost p95 %s ms > %g ms" % (k, r["firstGhost"]["p95"], B["firstGhostP95"]))
    if r["frame"]["p95"] is not None and r["frame"]["p95"] > B["frameP95"]: fail.append("%s: frame p95 %s ms > %g ms" % (k, r["frame"]["p95"], B["frameP95"]))
    if r["mainTaskMax"] > B["mainTask"]: fail.append("%s: main-thread suggestion task %s ms > %g ms" % (k, r["mainTaskMax"], B["mainTask"]))
    if r["worker"] != "ready": fail.append("%s: the search did not run in a worker (%s)" % (k, r["worker"]))
    if r["connections"] and r["found"] < 0.9 * r["connections"]: fail.append("%s: ghosts for %d of %d connections" % (k, r["found"], r["connections"]))
    if r["errors"]: fail.append("%s: page errors %s" % (k, r["errors"]))
if asjson: print(json.dumps({"suggest": res, "budgets": B, "failed": fail}, indent=2))
else:
    print("Route Suggestions in real time (worker search; ms)")
    for k, r in res.items():
        print("  %-9s firstGhost p50 %s  p95 %s  max %s (n %d of %d)   frame p50 %s  p95 %s   main task max %s   once per edit: index %.1f, conventions %.1f   long tasks %d   worker %s" % (
            k, r["firstGhost"]["p50"], r["firstGhost"]["p95"], r["firstGhost"]["max"], r["found"], r["connections"], r["frame"]["p50"], r["frame"]["p95"], r["mainTaskMax"],
            r["oncePerEdit"]["index"], r["oncePerEdit"]["conventions"], r["longTasks"], r["worker"]))
        if r.get("shots"): print("  shots:", r["shots"])
    print("FAIL: " + "; ".join(fail) if fail else "PASS route suggestion budgets")
sys.exit(1 if fail else 0)
