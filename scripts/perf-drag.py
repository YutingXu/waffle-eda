#!/usr/bin/env python3
"""Dynamic re-route on component drag in real time (stage 5 of scripts/perf-canvas.sh).

Drives the real editor over the Chrome DevTools protocol (python3, no packages; the Page class of
scripts/perf-route.py) on the 25,600-object board of tests/pcb/dense-board.js with nets. A QFN-48 sits in a
cleared pocket mid-board with 48 routed escapes (pad, 0.6 mm stub, 45° fan, via). The part is selected,
pressed and dragged with real Input.dispatchMouseEvent events at about 120 Hz on the real clock for
~2 s, then dropped. Live re-route is on at its default cap (32), so 16 connections ride as connection
lines and are routed on the drop.

Main-thread work is attributed to frames: every pointer handler (window capture to window bubble),
every re-route slice (AtriumDragReroute.probe) and every animation-frame callback (the render plus a
getImageData raster flush) is timed, and each piece is charged to the frame that follows it.

  busy        p50/p95/max ms of main-thread work per frame while dragging     budget: p95 <= 8.3 (one 120 Hz frame)
  frame       p50/p95 ms of the rAF callback + raster                          budget: p95 <= 8.3
  slice       p95 ms of a single re-route slice (between frames)               reported
  drop        pointerup handler: final route of all 48, gloss, one edit         budget: <= 250 ms
  live        connections re-routed live in the last frame                     must be 32 (the cap)
  undo        one undo after the drop restores the board exactly               must be true
  esc         Esc during a second drag leaves the board exactly as it was     must be true

Usage: scripts/perf-drag.py [--json] [--shots DIR]   (perf-canvas.sh runs it; DRAGFEEL=0 skips it there)
Env:   CHROME  APP=/path/to/app  DRAG_SCALE=24 (px per mm)  BUDGET_DRAG_BUSY=8.3  BUDGET_DRAG_FRAME=8.3  BUDGET_DRAG_DROP=250
"""
import base64, importlib.util, json, math, os, shutil, sys, tempfile, time

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
APP = os.environ.get("APP") or os.path.join(ROOT, "app")
asjson = "--json" in sys.argv
shots = sys.argv[sys.argv.index("--shots") + 1] if "--shots" in sys.argv else None
_argv, sys.argv = sys.argv, [sys.argv[0], "--import-only"]
_spec = importlib.util.spec_from_file_location("perf_route_page", os.path.join(ROOT, "scripts", "perf-route.py"))
_src = open(os.path.join(ROOT, "scripts", "perf-route.py")).read()
_ns = {"__name__": "perf_route_page", "__file__": _spec.origin}
exec(compile(_src.split('SETUP = r"""')[0], _spec.origin, "exec"), _ns)
sys.argv = _argv
Page = _ns["Page"]

SETUP = r"""(async()=>{
for(const d of document.querySelectorAll('dialog[open]'))d.close();
const H=AtriumNavHost;
await AtriumLazy.need("AtriumRules");await AtriumLazy.need("AtriumRouter");
// QFN-48 at 0.5 mm pitch (12 a side), escapes: pad -> 0.6 mm stub -> 45° fan -> via.
const n=12,pitch=.5,half=(n-1)*pitch/2,edge=half+1,pads=[];let k=1;
const side=(s,f)=>{for(let i=0;i<n;i++){const [x,y,w,h]=f(i);pads.push({number:String(k++),x,y,w,h,shape:"rect",layer:"Top",side:s});}};
side("W",i=>[-edge,-half+i*pitch,.8,.25]);side("S",i=>[-half+i*pitch,edge,.25,.8]);side("E",i=>[edge,half-i*pitch,.8,.25]);side("N",i=>[half-i*pitch,-edge,.25,.8]);
const def={id:"perf-qfn48",name:"QFN-48",prefix:"U",pins:pads.map(p=>({number:p.number,name:"P"+p.number})),footprint:{pads:pads.map(({side,...p})=>p),shapes:[{kind:"line",layer:"Top Overlay",points:[[-3.6,-3.6],[3.6,-3.6],[3.6,3.6],[-3.6,3.6],[-3.6,-3.6]],width:.15}]}};
const p=Atrium.project("Drag",[...AtriumParts.catalogue,def]),old=p.documents.find(x=>x.kind==="pcb");
const {d}=makeAtriumBenchmarkBoard();p.documents=p.documents.map(x=>x===old?d:x);
let q=0;for(const i of d.items){if(i.kind==="part")i.pinNets={"1":"N"+(q%64),"2":"N"+((q+1)%64)};else if(i.kind!=="track")i.net="N"+(q%64);q++;}
const cx=184,cy=137,inP=pt=>Math.abs(pt[0]-cx)<10.5&&Math.abs(pt[1]-cy)<10.5;
d.items=d.items.filter(i=>!(i.points||[[i.x,i.y]]).some(inP));
const pinNets={};
for(const pd of pads){
  const net="Q"+pd.number;pinNets[pd.number]=net;
  const out={W:[-1,0],S:[0,1],E:[1,0],N:[0,-1]}[pd.side],al={W:[0,1],S:[1,0],E:[0,-1],N:[-1,0]}[pd.side];
  const c=[cx+pd.x,cy+pd.y],e=[c[0]+out[0]*.6,c[1]+out[1]*.6],fan=((+pd.number-1)%n-(n-1)/2)*.5;
  const b=[e[0]+out[0]*Math.abs(fan)+al[0]*fan,e[1]+out[1]*Math.abs(fan)+al[1]*fan],v=[b[0]+out[0]*1.6,b[1]+out[1]*1.6];
  d.items.push({id:"qt"+pd.number,kind:"track",net,layer:"Top",width:.15,points:[c,e,b,v].filter((r,i,a)=>!i||Math.hypot(r[0]-a[i-1][0],r[1]-a[i-1][1])>1e-9)});
  d.items.push({id:"qv"+pd.number,kind:"via",net,x:v[0],y:v[1],diameter:.45,drill:.2,layer:"Multi"});
}
d.items.push({id:"QFN",kind:"part",def:def.id,x:cx,y:cy,angle:0,ref:"U99",pinNets});
await H.replaceProject(p,{force:true});H.selectDocument(d.id);await new Promise(r=>setTimeout(r,400));
await AtriumLazy.need("AtriumRouter");
const c=H.canvas(),ctx=c.getContext("2d"),raf=window.requestAnimationFrame.bind(window);
window.__ev=[];window.__f=[];window.__sl=[];window.__live=[];
addEventListener("pointermove",e=>{window.__h0=performance.now();},true);
addEventListener("pointermove",e=>{if(window.__h0!=null)__ev.push([__h0,performance.now()-__h0]);window.__h0=null;});
AtriumDragReroute.probe=(t0,ms)=>__sl.push([t0,ms]);
window.requestAnimationFrame=cb=>raf(ts=>{const t0=performance.now();cb(ts);ctx.getImageData(0,0,1,1);const t1=performance.now();__f.push([t0,t1-t0,ts]);
  const dr=H.drag?.();const pv=dr?.reroute?.preview?.();if(pv)__live.push([pv.routed,pv.rubber,pv.stale]);});
return JSON.stringify({at:[cx,cy],tracks:48});})()"""

RESULT = r"""(()=>{const q=(a,p)=>a.length?+a.slice().sort((x,y)=>x-y)[Math.min(a.length-1,Math.floor(p*(a.length-1)))].toFixed(2):null;
// One frame per vsync: the callbacks that share a rAF timestamp.
const G=new Map();for(const f of __f){const g=G.get(f[2]);if(g){g[1]+=f[1];g[0]=Math.min(g[0],f[0]);}else G.set(f[2],[f[0],f[1]]);}
const F=[...G.values()].sort((a,b)=>a[0]-b[0]),busy=F.map(f=>f[1]);
// Charge each handler and slice to the first frame that starts after it begins.
const charge=list=>{for(const [t,ms] of list){let lo=0,hi=F.length;while(lo<hi){const m=(lo+hi)>>1;if(F[m][0]<t)lo=m+1;else hi=m;}if(lo<F.length)busy[lo]+=ms;}};
charge(__ev);charge(__sl);
const lv=__live.at(-1)||[0,0,0];
return JSON.stringify({frames:F.length,events:__ev.length,slices:__sl.length,busy:{p50:q(busy,.5),p95:q(busy,.95),max:q(busy,1)},frame:{p50:q(F.map(f=>f[1]),.5),p95:q(F.map(f=>f[1]),.95)},
  handler:{p50:q(__ev.map(e=>e[1]),.5),p95:q(__ev.map(e=>e[1]),.95)},slice:{p95:q(__sl.map(s=>s[1]),.95),max:q(__sl.map(s=>s[1]),1)},live:lv,errors:__errs});})()"""


def run(tmp):
    h = open(APP + "/index.html").read()
    h = h.replace("<head>", '<head><base href="file://%s/"><script>window.__errs=[];addEventListener("error",e=>__errs.push(e.message+" @"+(e.filename||"").split("/").pop()+":"+e.lineno));</script>' % APP, 1)
    h = h.replace("</body>", '<script src="file://%s/tests/pcb/dense-board.js"></script></body>' % ROOT)
    open(tmp + "/drag.html", "w").write(h)
    p = Page("file://" + tmp + "/drag.html", tmp)
    try:
        for _ in range(100):
            if p.eval("!!globalThis.AtriumNavHost&&typeof makeAtriumBenchmarkBoard==='function'"): break
            time.sleep(.1)
        time.sleep(1.5)
        site = json.loads(p.eval(SETUP))
        scale = float(os.environ.get("DRAG_SCALE", 24))
        p.eval("(()=>{const H=AtriumNavHost,v=H.view();v.restoreCamera({...v.camera(),cx:%f,cy:%f,scale:%f});H.select(['QFN']);H.redraw();return 1;})()" % (site["at"][0], site["at"][1], scale))
        time.sleep(1.2)   # idle: the routing world is warmed for the selection
        scr = lambda w: json.loads(p.eval("(()=>{const H=AtriumNavHost,b=H.canvas().getBoundingClientRect(),s=H.view().worldToScreen(%s);return JSON.stringify([s[0]+b.left,s[1]+b.top]);})()" % json.dumps(w)))
        before = p.eval("JSON.stringify(AtriumNavHost.doc().items)")
        # Press where the part itself is hit (its body, a pad or the outline), not a track over it.
        grab = json.loads(p.eval("(()=>{const H=AtriumNavHost,[cx,cy]=%s;for(const [dx,dy] of [[0,0],[0,-3.6],[3.6,0],[-3.25,0],[0,3.25],[2,-3.6]]){const q=[cx+dx,cy+dy],h=H.hitAt(q);if(h?.id==='QFN')return JSON.stringify(q);}return JSON.stringify([cx,cy]);})()" % json.dumps(site["at"])))
        site["at"] = grab
        S = scr(site["at"])
        p.mouse("mouseMoved", S[0], S[1]); time.sleep(.1)
        p.mouse("mousePressed", S[0], S[1], button="left", buttons=1, clicks=1); time.sleep(.05)
        p.eval("__ev.length=0;__f.length=0;__sl.length=0;__live.length=0;0")
        shot = []
        N = 240
        for k in range(1, N + 1):
            t = k / N
            dx, dy = 2.6 * math.sin(t * math.pi * 2) + 1.2 * t, 1.4 * math.sin(t * math.pi * 3)
            x, y = scr([site["at"][0] + dx, site["at"][1] + dy])
            p.mouse("mouseMoved", x, y, button="left", buttons=1)
            if shots and k in (60, 140, 230):
                shot.append(p.call("Page.captureScreenshot", format="png")["data"])
            time.sleep(1 / 120)
        time.sleep(.3)
        res = json.loads(p.eval(RESULT))
        t0 = time.time()
        p.eval("window.__dropT=null;addEventListener('pointerup',()=>{window.__dropT=performance.now();},{capture:true,once:true});addEventListener('pointerup',()=>{window.__dropMs=performance.now()-window.__dropT;},{once:true});0")
        p.mouse("mouseReleased", x, y, button="left", buttons=0, clicks=1)
        time.sleep(.6)
        res["drop"] = p.eval("+(window.__dropMs||-1).toFixed(1)")
        res["dropStatus"] = p.eval("document.getElementById('status')?.textContent||''")
        after = p.eval("JSON.stringify(AtriumNavHost.doc().items)")
        res["changed"] = after != before
        if shots:
            shot.append(p.call("Page.captureScreenshot", format="png")["data"])
            os.makedirs(shots, exist_ok=True)
            for i, b in enumerate(shot): open(os.path.join(shots, "dense-drag-%d.png" % i), "wb").write(base64.b64decode(b))
        p.eval("window.dispatchEvent(new CustomEvent('atrium-command',{detail:'undo'}));0"); time.sleep(.5)
        res["undo"] = p.eval("JSON.stringify(AtriumNavHost.doc().items)") == before
        # Esc during a second drag: exactly as before.
        p.eval("AtriumNavHost.select(['QFN']);0"); time.sleep(.3)
        p.mouse("mouseMoved", S[0], S[1]); p.mouse("mousePressed", S[0], S[1], button="left", buttons=1, clicks=1)
        for k in range(1, 40):
            x, y = scr([site["at"][0] + k * .05, site["at"][1] + k * .03]); p.mouse("mouseMoved", x, y, button="left", buttons=1); time.sleep(1 / 120)
        p.call("Input.dispatchKeyEvent", type="keyDown", key="Escape", code="Escape", windowsVirtualKeyCode=27)
        p.call("Input.dispatchKeyEvent", type="keyUp", key="Escape", code="Escape", windowsVirtualKeyCode=27)
        time.sleep(.2); p.mouse("mouseReleased", x, y, button="left", buttons=0, clicks=1); time.sleep(.3)
        res["esc"] = p.eval("JSON.stringify(AtriumNavHost.doc().items)") == before
        res["errors"] = p.eval("__errs")
        return res
    finally:
        p.close()


tmp = tempfile.mkdtemp(prefix="atrium-drag.")
try:
    r = run(tmp)
finally:
    shutil.rmtree(tmp, ignore_errors=True)
B = {"busyP95": float(os.environ.get("BUDGET_DRAG_BUSY", 8.3)), "frameP95": float(os.environ.get("BUDGET_DRAG_FRAME", 8.3)), "drop": float(os.environ.get("BUDGET_DRAG_DROP", 250))}
fail = []
if r["busy"]["p95"] is None or r["busy"]["p95"] > B["busyP95"]: fail.append("main-thread work per frame p95 %s ms > %g ms" % (r["busy"]["p95"], B["busyP95"]))
if r["frame"]["p95"] is None or r["frame"]["p95"] > B["frameP95"]: fail.append("frame p95 %s ms > %g ms" % (r["frame"]["p95"], B["frameP95"]))
if not (0 <= r["drop"] <= B["drop"]): fail.append("drop %s ms > %g ms" % (r["drop"], B["drop"]))
if r["live"][0] + r["live"][2] != 32: fail.append("live re-routes %s, want the cap (32)" % r["live"])
if not r["changed"]: fail.append("the drop changed nothing")
if not r["undo"]: fail.append("one undo did not restore the board")
if not r["esc"]: fail.append("Esc did not restore the board")
if r["errors"]: fail.append("page errors %s" % r["errors"])
if asjson: print(json.dumps({"drag": r, "budgets": B, "failed": fail}, indent=2))
else:
    print("Drag re-route in real time on the 25.6k board, QFN-48 with 48 tracks, cap 32, ~120 Hz input, CPU raster (ms)")
    print("  busy/frame p50 %.2f  p95 %.2f  max %.2f   frame p50 %.2f  p95 %.2f   handler p95 %.2f   slice p95 %s max %s   (budget p95 %g / %g)" % (
        r["busy"]["p50"] or 0, r["busy"]["p95"] or 0, r["busy"]["max"] or 0, r["frame"]["p50"] or 0, r["frame"]["p95"] or 0, r["handler"]["p95"] or 0, r["slice"]["p95"], r["slice"]["max"], B["busyP95"], B["frameP95"]))
    print("  frames %d, events %d, slices %d, live [routed, lines, updating] %s   drop %.1f ms (budget %g)   undo %s   esc %s" % (r["frames"], r["events"], r["slices"], r["live"], r["drop"], B["drop"], r["undo"], r["esc"]))
    print("  status after drop: " + r["dropStatus"][:160])
    print("FAIL: " + "; ".join(fail) if fail else "PASS drag re-route budgets")
sys.exit(1 if fail else 0)
