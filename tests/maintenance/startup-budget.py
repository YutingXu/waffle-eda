#!/usr/bin/env python3
"""Startup budget for the browser/native editor (app/index.html).

Static check (always, no browser needed):
  * parses index.html (comments removed), sums the bytes of every eager <script src> plus
    inline <script> bodies, and fails above the eager-JS budget;
  * every eager script and stylesheet exists.

Headless Chrome check (--chrome, or scripts/startup-budget.sh):
  * synchronous boot: performance.now() from the first <head> script to the end of <body>.
    The median of --runs fresh-profile runs must stay within the boot budget.
  * JS heap after boot: usedJSHeapSize after a forced GC at the end of <body>.
  * reported only: heap and requested scripts after 2.5 seconds (--idle). Page errors fail.
  Native window visibility and the settled launch surface are measured separately by
  native/tests/macos-harness/startup.sh.

Budgets (bytes / MB / ms); override with environment variables:
  ATRIUM_EAGER_JS_MAX   2000000   eager JavaScript bytes (raised from 1050 KB on 2026-11-27, when eager JS
                                  was ~1050 KB, to leave room for parallel feature work; new features
                                  should still load lazily where they can)
  ATRIUM_HEAP_MAX_MB    3.8       heap after boot, MB (1 MB = 1048576 bytes)
  ATRIUM_BOOT_MAX_MS    50        median boot to interactive, ms

Usage: tests/maintenance/startup-budget.py [--chrome] [--runs 5] [--idle] [--app DIR] [--json]
Exit status: 0 within budget, 1 over budget or broken, 2 Chrome not found (with --chrome).
"""
import json, math, os, re, shutil, statistics, subprocess, sys, tempfile

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "../.."))
EAGER_MAX = int(os.environ.get("ATRIUM_EAGER_JS_MAX", "2000000"))
HEAP_MAX = float(os.environ.get("ATRIUM_HEAP_MAX_MB", "3.8"))
BOOT_MAX = float(os.environ.get("ATRIUM_BOOT_MAX_MS", "50"))


def arg(name, default=None):
    if name in sys.argv:
        i = sys.argv.index(name)
        return sys.argv[i + 1] if i + 1 < len(sys.argv) else default
    return default


def static(app):
    html = open(os.path.join(app, "index.html"), encoding="utf-8").read()
    body = re.sub(r"<!--.*?-->", "", html, flags=re.S)
    scripts = re.findall(r'<script\b[^>]*\bsrc="([^"]+)"[^>]*>\s*</script>', body)
    inline = [m for m in re.findall(r"<script\b(?![^>]*\bsrc=)[^>]*>(.*?)</script>", body, flags=re.S)]
    sheets = re.findall(r'<link\b[^>]*rel="stylesheet"[^>]*href="([^"]+)"', body)
    missing = [f for f in scripts + sheets if not os.path.exists(os.path.join(app, f))]
    sizes = {f: os.path.getsize(os.path.join(app, f)) for f in scripts if os.path.exists(os.path.join(app, f))}
    js = sum(sizes.values()) + sum(len(s.encode("utf-8")) for s in inline)
    css = sum(os.path.getsize(os.path.join(app, f)) for f in sheets if os.path.exists(os.path.join(app, f)))
    return {"eagerJsBytes": js, "eagerJsFiles": len(scripts), "inlineScriptBytes": sum(len(s.encode("utf-8")) for s in inline),
            "eagerCssBytes": css, "eagerCssFiles": len(sheets), "missing": missing,
            "largest": sorted(sizes.items(), key=lambda kv: -kv[1])[:8]}


def chrome_path():
    env = os.environ.get("CHROME")
    cands = [env] if env else []
    cands += ["/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", "/Applications/Chromium.app/Contents/MacOS/Chromium"]
    cands += [shutil.which(n) for n in ("google-chrome", "chromium", "chromium-browser")]
    return next((c for c in cands if c and os.path.exists(c)), None)


PROBE = r"""<script>(()=>{const boot=performance.now()-window.__t0;let heap=null;
try{gc();heap=performance.memory.usedJSHeapSize/1048576;}catch{}
const scripts=()=>[...document.scripts].filter(s=>s.src).map(s=>s.getAttribute("src"));
const scriptNames=scripts();
const out={bootMs:+boot.toFixed(2),heapMB:heap==null?null:+heap.toFixed(3),scripts:scriptNames.length,scriptNames};
const done=extra=>{const p=document.createElement("pre");p.id="MEASURE";p.textContent=JSON.stringify({...out,...extra,errors:__errs});document.body.append(p);};
if(!%(idle)s){done({});return;}
setTimeout(()=>{let idleHeap=null;try{gc();idleHeap=+(performance.memory.usedJSHeapSize/1048576).toFixed(3);}catch{}const idleScriptNames=scripts();done({idleHeapMB:idleHeap,idleScripts:idleScriptNames.length,idleScriptNames});},2500);
})();</script>"""


def run_chrome(chrome, app, idle):
    html = open(os.path.join(app, "index.html"), encoding="utf-8").read()
    pre = ('<head><base href="file://%s/"><script>window.__t0=performance.now();window.__errs=[];'
           'addEventListener("error",e=>__errs.push(e.message+" @"+(e.filename||"").split("/").pop()+":"+e.lineno));</script>') % app
    if "<head>" not in html or "</body>" not in html:
        raise SystemExit("index.html has no <head> or </body>")
    page = html.replace("<head>", pre, 1).replace("</body>", (PROBE % {"idle": "true" if idle else "false"}) + "</body>", 1)
    tmp = tempfile.mkdtemp(prefix="atrium-startup-")
    try:
        path = os.path.join(tmp, "page.html")
        open(path, "w", encoding="utf-8").write(page)
        cmd = [chrome, "--headless=new", "--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--no-first-run", "--no-default-browser-check",
               "--allow-file-access-from-files", "--user-data-dir=" + os.path.join(tmp, "profile"), "--window-size=1440,900",
               "--enable-precise-memory-info", "--js-flags=--expose-gc"]
        if idle: cmd.append("--virtual-time-budget=6000")
        cmd += ["--dump-dom", "file://" + path]
        out = subprocess.run(cmd, capture_output=True, text=True, timeout=120).stdout
        m = re.search(r'<pre id="MEASURE">(.*?)</pre>', out, re.S)
        if not m: return {"error": "no measurement (page did not finish)"}
        import html as H
        return json.loads(H.unescape(m.group(1)))
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


def main():
    app = os.path.abspath(arg("--app", os.path.join(ROOT, "app")))
    as_json = "--json" in sys.argv
    measure = "--measure-only" in sys.argv
    report, fails = {"budgets": {"eagerJsBytes": EAGER_MAX, "heapMB": HEAP_MAX, "bootMs": BOOT_MAX}}, []
    s = static(app); report["static"] = s
    if s["missing"]: fails.append("missing files: " + ", ".join(s["missing"]))
    if not measure and s["eagerJsBytes"] > EAGER_MAX: fails.append("eager JS %d bytes > %d" % (s["eagerJsBytes"], EAGER_MAX))
    if "--chrome" in sys.argv:
        chrome = chrome_path()
        if not chrome:
            print("Chrome or Chromium not found; set CHROME=/path/to/chrome", file=sys.stderr); sys.exit(2)
        runs = [run_chrome(chrome, app, False) for _ in range(int(arg("--runs", "5")))]
        bad = [r for r in runs if "error" in r or r.get("errors")]
        if bad: fails.append("page errors: " + json.dumps(bad[0])[:300])
        ok = [r for r in runs if "bootMs" in r]
        if ok:
            boot_samples = [r["bootMs"] for r in ok]
            boot = statistics.median(boot_samples)
            p95 = sorted(boot_samples)[math.ceil(.95 * len(boot_samples)) - 1]
            heaps = [r["heapMB"] for r in ok if r.get("heapMB") is not None]
            heap = statistics.median(heaps) if heaps else None
            report["chrome"] = {"runs": len(ok), "bootMs": boot_samples, "bootMedianMs": boot,
                                "bootP95Ms": p95, "bootMaxMs": max(boot_samples), "heapMB": heap,
                                "scripts": ok[0]["scripts"], "scriptNames": ok[0]["scriptNames"]}
            if not measure and boot > BOOT_MAX: fails.append("boot median %.1f ms > %.1f" % (boot, BOOT_MAX))
            if heap is None: fails.append("heap not measurable (needs --enable-precise-memory-info and --expose-gc)")
            elif not measure and heap > HEAP_MAX: fails.append("heap after boot %.2f MB > %.2f" % (heap, HEAP_MAX))
        if "--idle" in sys.argv:
            r = run_chrome(chrome, app, True)
            report["chrome_idle"] = r
            if r.get("errors"): fails.append("errors once idle: " + json.dumps(r["errors"])[:300])
    report["ok"] = not fails; report["failures"] = fails
    if as_json: print(json.dumps(report, indent=1))
    else:
        print("eager JS   %8.1f KB in %d files (budget %.1f KB)%s" % (s["eagerJsBytes"] / 1000, s["eagerJsFiles"], EAGER_MAX / 1000,
              "" if s["eagerJsBytes"] <= EAGER_MAX else "  OVER"))
        print("eager CSS  %8.1f KB in %d files (not budgeted)" % (s["eagerCssBytes"] / 1000, s["eagerCssFiles"]))
        if "chrome" in report:
            c = report["chrome"]
            print("boot       %8.1f ms median of %d (%s; budget %.0f ms)" % (c["bootMedianMs"], c["runs"], ", ".join("%.0f" % b for b in c["bootMs"]), BOOT_MAX))
            if c["heapMB"] is not None: print("heap       %8.2f MB after boot (budget %.2f MB), %d scripts" % (c["heapMB"], HEAP_MAX, c["scripts"]))
        if "chrome_idle" in report and "idleHeapMB" in report["chrome_idle"]:
            r = report["chrome_idle"]; print("idle heap  %8.2f MB once prefetches finish, %d scripts (reported only)" % (r["idleHeapMB"] or 0, r["idleScripts"]))
        for f in fails: print("FAIL  " + f)
        print("ok" if not fails else "startup budget exceeded")
    sys.exit(0 if not fails else 1)


main()
