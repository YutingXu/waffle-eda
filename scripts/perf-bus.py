#!/usr/bin/env python3
"""Bus routing feel in real time (stage 4 of scripts/perf-canvas.sh).

Drives the real editor over the Chrome DevTools protocol (python3, no packages; the Page class of
scripts/perf-route.py) on the 25,600-object board of tests/pcb/dense-board.js. An 11-net bus (a DDR byte
lane's worth: eleven pads at 0.8 mm) is placed in a cleared pocket, Interactive Bus Routing starts on it
in push mode, and the mouse sweeps the ribbon head back and forth across the board's tracks with real
Input.dispatchMouseEvent events at about 60 Hz, on the real clock. Every animation frame that renders
while the bus is live is timed (rAF callback, then getImageData to force the raster): the ribbon move
(gather, spine, walkaround or group shove, exact checks of every member), the shove animation
(route-feel.js), the length-band overlay and the board-layer reuse.

  busFrame     p50/p95 ms of the bus frames                         budget: p95 <= 8 ms (as single-track routing)
  latency      input timestamp -> end of the first frame after it   budget: p95 <= 25 ms
  pushFrames   frames whose ribbon shoves copper (two dips into the pocket;  must be >= 20
               every frame tries the group shove first)
  members      tracks in the live ribbon                             must be 11

Usage: scripts/perf-bus.py [--json]        (perf-canvas.sh runs it; BUSFEEL=0 skips it there)
Env:   CHROME  APP=/path/to/app  BUS_SCALES="12 40" (px per mm)  BUDGET_BUS_P95=8  BUDGET_BUS_LATENCY=25
"""
import importlib.util, json, os, shutil, sys, tempfile, time

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
APP = os.environ.get("APP") or os.path.join(ROOT, "app")
asjson = "--json" in sys.argv
_argv, sys.argv = sys.argv, [sys.argv[0], "--import-only"]
_spec = importlib.util.spec_from_file_location("perf_route_page", os.path.join(ROOT, "scripts", "perf-route.py"))
_src = open(os.path.join(ROOT, "scripts", "perf-route.py")).read()
# Only the Page class (perf-route.py runs its measurement at import): exec up to the SETUP script.
_ns = {"__name__": "perf_route_page", "__file__": _spec.origin}
exec(compile(_src.split('SETUP = r"""')[0], _spec.origin, "exec"), _ns)
sys.argv = _argv
Page = _ns["Page"]

SETUP = r"""(async()=>{
for(const d of document.querySelectorAll('dialog[open]'))d.close();
const H=AtriumNavHost;const {d}=makeAtriumBenchmarkBoard();
// A pocket for the bus start: eleven Top pads at 0.8 mm, nets B0..B10, in a cleared 6.5 x 13 mm pocket mid-board.
const x0=180,y0=130,inBox=p=>p[0]>x0-3.5&&p[0]<x0+3&&p[1]>y0-2.5&&p[1]<y0+10.5,gone=new Set(d.items.filter(i=>(i.points||[[i.x,i.y]]).some(inBox)||inBox([i.x-1.5,i.y])||inBox([i.x+1.5,i.y])).map(i=>i.id));
d.items=d.items.filter(i=>!gone.has(i.id));
for(let k=0;k<11;k++)d.items.push({id:"bus"+k,kind:"pad",x:x0,y:y0+k*.8,w:.4,h:.4,shape:"round",layer:"Top",net:"B"+k});
// Two other-net tracks dipping into the pocket from above and below: the ribbon shoves them as it sweeps.
d.items.push({id:"dipA",kind:"track",net:"PA",layer:"Top",width:.15,points:[[x0+1.9,y0-2.2],[x0+2.4,y0+2.2],[x0+2.9,y0-2.2]]},
  {id:"dipB",kind:"track",net:"PB",layer:"Top",width:.15,points:[[x0+1.9,y0+10.2],[x0+2.4,y0+5.8],[x0+2.9,y0+10.2]]});
H.edit(()=>{H.project().documents.push(d);});H.selectDocument(d.id);
await AtriumLazy.need("AtriumMultiRoute");await new Promise(r=>setTimeout(r,300));
const nets=[...Array(11).keys()].map(k=>"B"+k),members=AtriumBusRoute.membersNear(d,H.defs(),nets,[x0,y0+4]);
const s=AtriumBusRoute.begin(d,H.defs(),{members,layer:"Top",mode:"push",project:H.project(),revision:H.revision()});
H.startRoute(s);
const c=H.canvas(),ctx=c.getContext("2d"),raf=window.requestAnimationFrame.bind(window),v=H.view(),r0=v.render;let rendered=false;
v.render=function(...a){rendered=true;return r0.apply(this,a);};
window.__f=[];window.__ev=[];
window.requestAnimationFrame=cb=>raf(ts=>{rendered=false;const t0=performance.now();cb(ts);if(!rendered)return;ctx.getImageData(0,0,1,1);const t1=performance.now();
  const lr=H.liveRoute();if(lr?.preview?.bus)__f.push([t0,t1-t0,t1,lr.preview.pushed?.length||0,lr.preview.preview.filter(p=>p.head).length,lr.preview.ms||0,lr.preview.status]);});
c.addEventListener("pointermove",e=>__ev.push(e.timeStamp),true);
return JSON.stringify({start:[x0+1.2,y0+4],end:[x0+9,y0+4]});})()"""

RESULT = r"""(()=>{const f=__f,d=f.map(x=>x[1]).sort((a,b)=>a-b),q=(a,p)=>a.length?+a[Math.min(a.length-1,Math.floor(p*(a.length-1)))].toFixed(2):null;
const fr=f.slice().sort((a,b)=>a[0]-b[0]),lat=[];let j=0;for(const e of __ev){while(j<fr.length&&fr[j][0]<e)j++;if(j<fr.length)lat.push(fr[j][2]-e);}lat.sort((a,b)=>a-b);
const mv=f.map(x=>x[5]).sort((a,b)=>a-b);
return JSON.stringify({frames:d.length,busFrame:{p50:q(d,.5),p95:q(d,.95),max:q(d,1)},move:{p50:q(mv,.5),p95:q(mv,.95)},latency:{p50:q(lat,.5),p95:q(lat,.95)},
  pushFrames:f.filter(x=>x[3]>0).length,status:f.reduce((o,x)=>(o[x[6]]=(o[x[6]]||0)+1,o),{}),members:Math.max(0,...f.map(x=>x[4])),events:__ev.length,errors:__errs});})()"""


def run(scale, tmp):
    h = open(APP + "/index.html").read()
    h = h.replace("<head>", '<head><base href="file://%s/"><script>window.__errs=[];addEventListener("error",e=>__errs.push(e.message+" @"+(e.filename||"").split("/").pop()+":"+e.lineno));</script>' % APP, 1)
    h = h.replace("</body>", '<script src="file://%s/tests/pcb/dense-board.js"></script></body>' % ROOT)
    open(tmp + "/bus.html", "w").write(h)
    shutil.rmtree(tmp + "/prof-route", ignore_errors=True)
    p = Page("file://" + tmp + "/bus.html", tmp)
    try:
        for _ in range(100):
            if p.eval("!!globalThis.AtriumNavHost&&typeof makeAtriumBenchmarkBoard==='function'"): break
            time.sleep(.1)
        time.sleep(1.5)
        site = json.loads(p.eval(SETUP))
        cx, cy = (site["start"][0] + site["end"][0]) / 2, site["start"][1]
        p.eval("(()=>{const H=AtriumNavHost,v=H.view();v.restoreCamera({...v.camera(),cx:%f,cy:%f,scale:%f});H.redraw();return 1;})()" % (cx, cy, scale))
        time.sleep(.5)
        scr = lambda w: json.loads(p.eval("(()=>{const H=AtriumNavHost,b=H.canvas().getBoundingClientRect(),s=H.view().worldToScreen(%s);return JSON.stringify([s[0]+b.left,s[1]+b.top]);})()" % json.dumps(w)))
        S = scr(site["start"])
        p.mouse("mouseMoved", S[0], S[1]); time.sleep(.2)
        p.eval("__f.length=0;__ev.length=0;0")
        pts = [S]
        for k in range(14):
            pts.append(scr([site["start"][0] + 2.2 + (k % 4) * 0.5, site["start"][1] + (1.3 if k % 2 else -1.3)]))
        for (x0, y0), (x1, y1) in zip(pts, pts[1:]):
            for k in range(1, 13):
                p.mouse("mouseMoved", x0 + (x1 - x0) * k / 12, y0 + (y1 - y0) * k / 12); time.sleep(1 / 60)
        time.sleep(.3)
        return json.loads(p.eval(RESULT))
    finally:
        p.close()


tmp = tempfile.mkdtemp(prefix="atrium-bus.")
try:
    res = {("scale%g" % s): run(s, tmp) for s in [float(x) for x in os.environ.get("BUS_SCALES", "12 40").split()]}
finally:
    shutil.rmtree(tmp, ignore_errors=True)
B = {"busFrameP95": float(os.environ.get("BUDGET_BUS_P95", 8)), "latencyP95": float(os.environ.get("BUDGET_BUS_LATENCY", 25))}
fail = []
for k, r in res.items():
    if r["busFrame"]["p95"] is None or r["busFrame"]["p95"] > B["busFrameP95"]: fail.append("%s: bus frame p95 %s ms > %g ms" % (k, r["busFrame"]["p95"], B["busFrameP95"]))
    if r["latency"]["p95"] is None or r["latency"]["p95"] > B["latencyP95"]: fail.append("%s: input-to-paint p95 %s ms > %g ms" % (k, r["latency"]["p95"], B["latencyP95"]))
    if r["pushFrames"] < 20: fail.append("%s: only %d frames shoved copper" % (k, r["pushFrames"]))
    if r["members"] != 11: fail.append("%s: %d members in the ribbon head" % (k, r["members"]))
    if r["errors"]: fail.append("%s: page errors %s" % (k, r["errors"]))
if asjson: print(json.dumps({"bus": res, "budgets": B, "failed": fail}, indent=2))
else:
    print("Bus routing in real time on the 25.6k board, 11 nets, push mode, CPU raster (ms)")
    for k, r in res.items():
        print("  %-9s busFrame p50 %.2f  p95 %.2f  max %.2f   move p95 %.2f   latency p50 %.2f  p95 %.2f   frames %d, shoving %d   (budget p95 %g / %g)" % (
            k, r["busFrame"]["p50"] or 0, r["busFrame"]["p95"] or 0, r["busFrame"]["max"] or 0, r["move"]["p95"] or 0, r["latency"]["p50"] or 0, r["latency"]["p95"] or 0,
            r["frames"], r["pushFrames"], B["busFrameP95"], B["latencyP95"]))
    print("FAIL: " + "; ".join(fail) if fail else "PASS bus routing budgets")
sys.exit(1 if fail else 0)
