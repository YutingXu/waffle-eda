#!/usr/bin/env python3
"""Routing feel budgets in real time (stage 3 of scripts/perf-canvas.sh).

Drives the real editor over the Chrome DevTools protocol (python3, no packages) on the 25,600-object
board of tests/pcb/dense-board.js: starts a route above a Top-layer track in push mode and moves the
mouse back and forth across it with real Input.dispatchMouseEvent events at about 60 Hz, on the
real clock (no virtual time, no rAF queue). Every animation frame that renders while routing is
timed (rAF callback, then getImageData to force the raster), including the router move, the shove
animation (route-feel.js) and the board-layer reuse.

  routeFrame   p50/p95 ms of the routing frames                      budget: p95 <= 8 ms
  latency      input event timestamp -> end of the first frame that   budget: p95 <= 25 ms
               started after it (input-to-paint inside the renderer;  (one 60 Hz frame + 8 ms)
               the compositor's present is not included)
  pushFrames   frames whose preview shoves copper                     must be >= 20
  animFrames   frames with a shove still easing (route-feel.js)       must be > 0
  easeGap      median time between two easing frames                  <= 1.5x the display's frame time

Usage: scripts/perf-route.py [--json]       (perf-canvas.sh runs it; ROUTEFEEL=0 skips it there)
Env:   CHROME  APP=/path/to/app  ROUTE_SCALES="12 40" (px per mm)  BUDGET_ROUTE_P95=8  BUDGET_ROUTE_LATENCY=25
"""
import sys, os, json, socket, subprocess, time, urllib.request, tempfile, shutil, signal

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(ROOT, "scripts", "ci"))
import chrome_cdp
APP = os.environ.get("APP") or os.path.join(ROOT, "app")
asjson = "--json" in sys.argv
chrome = os.environ.get("CHROME") or next((c for c in ["/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", "/Applications/Chromium.app/Contents/MacOS/Chromium",
    shutil.which("google-chrome") or "", shutil.which("chromium") or "", shutil.which("chromium-browser") or ""] if c and os.access(c, os.X_OK)), None)
if not chrome: print("Chrome or Chromium not found; set CHROME=/path/to/chrome", file=sys.stderr); sys.exit(2)


class Page:
    def __init__(self, url, tmp):
        s0 = socket.socket(); s0.bind(("127.0.0.1", 0)); port = s0.getsockname()[1]; s0.close()
        self.proc = subprocess.Popen([chrome, "--headless=new", "--disable-gpu", "--disable-accelerated-2d-canvas", "--no-first-run", "--allow-file-access-from-files",
            "--user-data-dir=" + tmp + "/prof-route", "--remote-debugging-port=%d" % port, "--window-size=1440,900", "--force-device-scale-factor=1", url],
            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, start_new_session=True)
        tab = None
        for _ in range(150):
            try: tab = [t for t in json.load(urllib.request.urlopen("http://127.0.0.1:%d/json" % port)) if t["type"] == "page"][0]; break
            except Exception: time.sleep(.1)
        self.wire = chrome_cdp.connect(tab["webSocketDebuggerUrl"])
        self.sock = self.wire.sock
        self.n = 0

    def call(self, method, **params):
        self.n += 1
        return chrome_cdp.checked_result(method, self.wire.raw_reply(method, params, self.n))

    def eval(self, expr):
        r = self.call("Runtime.evaluate", expression=expr, awaitPromise=True, returnByValue=True)
        if "exceptionDetails" in r: raise RuntimeError(json.dumps(r["exceptionDetails"])[:800])
        return r.get("result", {}).get("value")

    def mouse(self, kind, x, y, button="none", buttons=0, clicks=0):
        self.call("Input.dispatchMouseEvent", type=kind, x=x, y=y, button=button, buttons=buttons, clickCount=clicks)

    # On macOS the launcher exits and the browser re-parents to launchd, so kill() alone leaks it:
    # ask the browser to close, then kill the whole process group.
    def close(self):
        try: self.sock.settimeout(3); self.call("Browser.close")
        except Exception: pass
        try: os.killpg(self.proc.pid, signal.SIGKILL)
        except Exception: pass
        try: self.proc.wait(5)
        except Exception: pass


SETUP = r"""(async()=>{
for(const d of document.querySelectorAll('dialog[open]'))d.close();
const H=AtriumNavHost;const {d}=makeAtriumBenchmarkBoard();H.edit(()=>{H.project().documents.push(d);});H.selectDocument(d.id);
await AtriumLazy.need("AtriumRouter");await new Promise(r=>setTimeout(r,300));
// A Top track whose vertical crossing makes the router shove it.
let site=null;
for(const tr of d.items.filter(i=>i.kind==="track"&&i.layer==="Top").slice(4000,4600)){
  const p1=tr.points[1],p2=tr.points[2],mx=(p1[0]+p2[0])/2,y=p1[1];
  const s=AtriumRouter.begin(d,H.defs(),{net:"",layer:"Top",start:[mx,y-.9],mode:"push"});const r=s.move([mx,y+.1]);s.cancel();
  if(r.status==="pushed"){site={s:[mx,y-.9],e:[mx,y+.1]};break;}
}
if(!site)throw Error("no push site on the benchmark board");
const c=H.canvas(),ctx=c.getContext("2d"),raf=window.requestAnimationFrame.bind(window),v=H.view(),r0=v.render;let rendered=false;
v.render=function(...a){rendered=true;return r0.apply(this,a);};
window.__f=[];window.__ev=[];
window.requestAnimationFrame=cb=>raf(ts=>{rendered=false;const t0=performance.now();cb(ts);if(!rendered)return;ctx.getImageData(0,0,1,1);const t1=performance.now();
  const lr=H.liveRoute();if(lr)__f.push([t0,t1-t0,t1,lr.preview?.pushed?.length||0,globalThis.AtriumRouteFeel?.debug?.().anims||0]);});
c.addEventListener("pointermove",e=>__ev.push(e.timeStamp),true);
window.__vsync=await new Promise(done=>{const t=[];const tick=ts=>{t.push(ts);if(t.length<31)raf(tick);else{const g=t.slice(1).map((v,i)=>v-t[i]).sort((a,b)=>a-b);done(+g[g.length>>1].toFixed(2));}};raf(tick);});
window.__site=site;return JSON.stringify(site);})()"""

RESULT = r"""(()=>{const f=__f,d=f.map(x=>x[1]).sort((a,b)=>a-b),q=(a,p)=>a.length?+a[Math.min(a.length-1,Math.floor(p*(a.length-1)))].toFixed(2):null;
const fr=f.slice().sort((a,b)=>a[0]-b[0]),lat=[];let j=0;for(const e of __ev){while(j<fr.length&&fr[j][0]<e)j++;if(j<fr.length)lat.push(fr[j][2]-e);}lat.sort((a,b)=>a-b);
const gaps=[];for(let k=1;k<fr.length;k++)if(fr[k][4]>0&&fr[k-1][4]>0)gaps.push(fr[k][0]-fr[k-1][0]);gaps.sort((a,b)=>a-b);
return JSON.stringify({frames:d.length,easeGap:q(gaps,.5),vsync:window.__vsync,routeFrame:{p50:q(d,.5),p95:q(d,.95),max:q(d,1)},latency:{p50:q(lat,.5),p95:q(lat,.95)},pushFrames:f.filter(x=>x[3]>0).length,
  animFrames:f.filter(x=>x[4]>0).length,events:__ev.length,mode:AtriumNavHost.routeTool?.()?.state?.().mode||null,errors:__errs});})()"""


def run(scale, tmp):
    h = open(APP + "/index.html").read()
    h = h.replace("<head>", '<head><base href="file://%s/"><script>window.__errs=[];addEventListener("error",e=>__errs.push(e.message+" @"+(e.filename||"").split("/").pop()+":"+e.lineno));</script>' % APP, 1)
    h = h.replace("</body>", '<script src="file://%s/tests/pcb/dense-board.js"></script></body>' % ROOT)
    open(tmp + "/route.html", "w").write(h)
    shutil.rmtree(tmp + "/prof-route", ignore_errors=True)
    p = Page("file://" + tmp + "/route.html", tmp)
    try:
        for _ in range(100):
            if p.eval("!!globalThis.AtriumNavHost&&typeof makeAtriumBenchmarkBoard==='function'"): break
            time.sleep(.1)
        time.sleep(1.5)
        site = json.loads(p.eval(SETUP))
        cx, cy = site["s"][0], (site["s"][1] + site["e"][1]) / 2
        p.eval("(()=>{const H=AtriumNavHost,v=H.view();v.restoreCamera({...v.camera(),cx:%f,cy:%f,scale:%f});H.redraw();H.act('route');H.canvas().focus();})()" % (cx, cy, scale))
        for _ in range(100):
            if p.eval("AtriumNavHost.tool()==='route'"): break
            time.sleep(.05)
        else: raise RuntimeError("The editor did not arm interactive routing.")
        # In a fresh profile, Shift+R before the first anchor selects Push.
        for kind in ("rawKeyDown", "keyUp"):
            p.call("Input.dispatchKeyEvent", type=kind, key="R", code="KeyR", modifiers=8, windowsVirtualKeyCode=82)
        scr = lambda w: json.loads(p.eval("(()=>{const H=AtriumNavHost,b=H.canvas().getBoundingClientRect(),s=H.view().worldToScreen(%s);return JSON.stringify([s[0]+b.left,s[1]+b.top]);})()" % json.dumps(w)))
        S, D = scr(site["s"]), scr(site["e"])
        p.mouse("mouseMoved", S[0], S[1]); time.sleep(.1)
        p.mouse("mousePressed", S[0], S[1], "left", 1, 1); p.mouse("mouseReleased", S[0], S[1], "left", 0, 1); time.sleep(.3)
        mode = p.eval("AtriumNavHost.routeTool?.()?.state().mode || 'no live route'")
        if mode != "push": raise RuntimeError("The first routing anchor did not start in Push mode (%s)." % mode)
        p.eval("__f.length=0;__ev.length=0;0")
        pts = [S]
        for k in range(16): pts.append(D if k % 2 == 0 else scr([site["s"][0] + (k % 4 - 1) * .3, site["s"][1] + .15]))
        for (x0, y0), (x1, y1) in zip(pts, pts[1:]):
            for k in range(1, 13):
                p.mouse("mouseMoved", x0 + (x1 - x0) * k / 12, y0 + (y1 - y0) * k / 12); time.sleep(1 / 60)
        time.sleep(.3)
        return json.loads(p.eval(RESULT))
    finally:
        p.close()


tmp = tempfile.mkdtemp(prefix="atrium-route.")
try:
    scales = [float(s) for s in os.environ.get("ROUTE_SCALES", "12 40").split()]
    res = {("scale%g" % s): run(s, tmp) for s in scales}
finally:
    shutil.rmtree(tmp, ignore_errors=True)
B = {"routeFrameP95": float(os.environ.get("BUDGET_ROUTE_P95", 8)), "latencyP95": float(os.environ.get("BUDGET_ROUTE_LATENCY", 25))}
fail = []
for k, r in res.items():
    if r["mode"] != "push": fail.append("%s: router not in push mode (%s)" % (k, r["mode"]))
    if r["routeFrame"]["p95"] is None or r["routeFrame"]["p95"] > B["routeFrameP95"]: fail.append("%s: routing frame p95 %s ms > %g ms" % (k, r["routeFrame"]["p95"], B["routeFrameP95"]))
    if r["latency"]["p95"] is None or r["latency"]["p95"] > B["latencyP95"]: fail.append("%s: input-to-paint p95 %s ms > %g ms" % (k, r["latency"]["p95"], B["latencyP95"]))
    if r["pushFrames"] < 20: fail.append("%s: only %d frames shoved copper" % (k, r["pushFrames"]))
    if r["animFrames"] < 1: fail.append("%s: no shove animation frames" % k)
    if r.get("easeGap") and r.get("vsync") and r["easeGap"] > 1.5 * r["vsync"]: fail.append("%s: animation frames every %.1f ms, display every %.1f ms (half rate?)" % (k, r["easeGap"], r["vsync"]))
    if r["errors"]: fail.append("%s: page errors %s" % (k, r["errors"]))
if asjson: print(json.dumps({"routing": res, "budgets": B, "failed": fail}, indent=2))
else:
    print("Routing in real time on the 25.6k board, push mode, CPU raster (route-feel; ms)")
    for k, r in res.items():
        print("  %-9s routeFrame p50 %.2f  p95 %.2f  max %.2f   latency p50 %.2f  p95 %.2f   frames %d, shoving %d, easing %d, easing cadence %s ms (display %s ms)   (budget p95 %g / %g)" % (
            k, r["routeFrame"]["p50"], r["routeFrame"]["p95"], r["routeFrame"]["max"], r["latency"]["p50"], r["latency"]["p95"], r["frames"], r["pushFrames"], r["animFrames"],
            r.get("easeGap"), r.get("vsync"), B["routeFrameP95"], B["latencyP95"]))
    print("FAIL: " + "; ".join(fail) if fail else "PASS routing budgets")
sys.exit(1 if fail else 0)
