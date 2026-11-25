#!/bin/zsh
# Hardware-accelerated board renderer (app/canvas/canvas-gpu.js): the 2D canvas
# against WebGL2 on the 25.6k-object board with 64 nets and ten pours, in the real editor in headless Chrome
# WITH the GPU (Metal through ANGLE; unlike scripts/perf-canvas.sh, which uses CPU raster). Runs
# tests/canvas/perf-gpu.js over the DevTools protocol and prints its JSON. Nothing is budgeted: it is a measurement.
# Usage: scripts/perf-gpu.sh [out.json]
# Env: CHROME=/path/to/chrome  APP=/path/to/app  IMAGES=<dir> (writes the 2D and GPU frames as PNG)
#      MODE=prints|journal (how edits find the changed objects)  DPR=1 (device scale factor)  ONLY=2d|gpu (one renderer)  PIXELS_ONLY=1
root=${0:A:h:h}
chrome=${CHROME:-}
for c in "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" "/Applications/Chromium.app/Contents/MacOS/Chromium" ${commands[google-chrome]:-} ${commands[chromium]:-}; do
  [[ -n $c && -z $chrome && -x $c ]] && chrome=$c
done
[[ -x $chrome ]] || { print -u2 "Chrome or Chromium not found; set CHROME=/path/to/chrome"; exit 2; }
tmp=$(mktemp -d "${TMPDIR:-/tmp}/atrium-gpu.XXXXXX"); trap 'rm -rf $tmp' EXIT
python3 - "$chrome" "${APP:-$root/app}" "$root" "$tmp" "${1:-}" "${IMAGES:-}" "${MODE:-}" "${DPR:-1}" <<'PY'
import sys, os, json, socket, base64, subprocess, time, urllib.request
chrome, app, root, tmp, outp, images, mode, dpr = sys.argv[1:9]
sys.path.insert(0, os.path.join(root, "scripts", "ci"))
import chrome_cdp
h = open(app + "/index.html").read()
h = h.replace("<head>", '<head><base href="file://%s/"><script>window.__errs=[];addEventListener("error",e=>__errs.push(e.message+" @"+(e.filename||"").split("/").pop()+":"+e.lineno));</script>' % app, 1)
h = h.replace("</body>", '<script src="file://%s/tests/pcb/dense-board.js"></script><script src="file://%s/tests/canvas/perf-gpu.js"></script></body>' % (root, root))
open(tmp + "/gpu.html", "w").write(h)
s0 = socket.socket(); s0.bind(("127.0.0.1", 0)); port = s0.getsockname()[1]; s0.close()
proc = subprocess.Popen([chrome, "--headless=new", "--no-first-run", "--allow-file-access-from-files", "--enable-precise-memory-info", "--js-flags=--expose-gc",
    "--user-data-dir=" + tmp + "/prof", "--remote-debugging-port=%d" % port, "--window-size=1440,900", "--force-device-scale-factor=" + dpr,
    "file://" + tmp + "/gpu.html"], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
try:
    tab = None
    for _ in range(150):
        try: tab = [t for t in json.load(urllib.request.urlopen("http://127.0.0.1:%d/json" % port)) if t["type"] == "page"][0]; break
        except Exception: time.sleep(.1)
    wire = chrome_cdp.connect(tab["webSocketDebuggerUrl"], timeout=900, eof=lambda: ConnectionError("closed"))
    def call(method, **params):
        return wire.raw_reply(method, params, 1)
    for _ in range(100):
        r = call("Runtime.evaluate", expression="typeof atriumGpuBench==='function'&&!!globalThis.AtriumNavHost", returnByValue=True)
        if r.get("result", {}).get("result", {}).get("value"): break
        time.sleep(.1)
    time.sleep(1.5)
    opts = {"images": bool(images)}
    if mode: opts["mode"] = mode
    if os.environ.get("PIXELS_ONLY"): opts["pixelsOnly"] = True
    if os.environ.get("ONLY"): opts["modes"] = [os.environ["ONLY"]]; opts["pixels"] = False
    r = call("Runtime.evaluate", expression="atriumGpuBench(%s).then(o=>JSON.stringify(o)).catch(e=>'ERR '+e.message+' '+e.stack)" % json.dumps(opts), awaitPromise=True, returnByValue=True)
    v = r.get("result", {}).get("result", {}).get("value")
    errs = call("Runtime.evaluate", expression="JSON.stringify(window.__errs)", returnByValue=True)["result"]["result"]["value"]
    if not v or v.startswith("ERR"): print("probe failed:", v or r); sys.exit(2)
    o = json.loads(v); o["errors"] = json.loads(errs)
    if images:
        os.makedirs(images, exist_ok=True)
        for k, url in (o.pop("images", None) or {}).items():
            if url: open(os.path.join(images, k + ".png"), "wb").write(base64.b64decode(url.split(",", 1)[1]))
    text = json.dumps(o, indent=1)
    if outp: open(outp, "w").write(text)
    print(text)
finally: proc.kill()
PY
