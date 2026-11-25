#!/bin/zsh
# UI-shell smoothness budgets (headless Chrome): menus, context menu, command palette and quick open,
# Properties (single selection and 5,000 objects), Messages with 5,000 DRC rows, project tree and
# Navigator, dialogs (Preferences open / page switch / search, Library), document tab switching,
# dock sash drags and theme switching, on the 25.6k-object stress board (tests/pcb/dense-board.js) in a
# 62-document project. The probe is tests/editor/perf-ui.js; scripts/perf-canvas.sh owns the canvas loop.
#
# Each interaction is timed from input to the next painted frame (rAF, then the next task), and
# reported as p50 / p95 / p99 with the synchronous handler time and the long tasks (over 50 ms,
# PerformanceObserver "longtask" and "long-animation-frame") that start within the interaction.
# Chrome runs with the frame-rate limit and vsync off, so nothing is capped at 60 Hz and a sample is
# the work, not the wait for vsync. The run fails when a p95 exceeds its budget (ms, below) or an
# interaction that must not block has a long task. Override a budget with BUDGET_<NAME>=ms, with the
# name upper-cased and "-" as "_" (BUDGET_MENU_OPEN=20).
#
# Usage: scripts/perf-ui.sh [--json] [--skip-if-no-browser]
# Env: CHROME=/path/to/chrome  APP=/path/to/app  RUNS=1 (median of RUNS browser launches)  REPS=1
# Exit status: 0 within budget, 1 over budget, 2 no browser or the probe failed (0 with --skip-if-no-browser
# when no browser is found).
root=${0:A:h:h}
json=0; skip=0
for a in "$@"; do case $a in --json) json=1;; --skip-if-no-browser) skip=1;; *) print -u2 "unknown argument $a"; exit 2;; esac; done
chrome=${CHROME:-}
for c in "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" "/Applications/Chromium.app/Contents/MacOS/Chromium" ${commands[google-chrome]:-} ${commands[chromium]:-} ${commands[chromium-browser]:-}; do
  [[ -n $c && -z $chrome && -x $c ]] && chrome=$c
done
if [[ ! -x $chrome ]]; then
  print -u2 "perf-ui: Chrome or Chromium not found; set CHROME=/path/to/chrome"
  (( skip )) && { print "perf-ui: SKIPPED (no browser)"; exit 0; }
  exit 2
fi
tmp=$(mktemp -d "${TMPDIR:-/tmp}/atrium-perf-ui.XXXXXX"); trap 'rm -rf $tmp' EXIT
python3 - "$chrome" "${APP:-$root/app}" "$root" "$tmp" "$json" "${RUNS:-1}" "${REPS:-1}" <<'PY'
import sys, os, json, socket, subprocess, time, urllib.request, statistics
chrome, app, root, tmp, asjson, runs, reps = sys.argv[1], sys.argv[2], sys.argv[3], sys.argv[4], sys.argv[5] == "1", int(sys.argv[6]), int(sys.argv[7])
sys.path.insert(0, os.path.join(root, "scripts", "ci"))
import chrome_cdp
h = open(app + "/index.html").read()
h = h.replace("<head>", '<head><base href="file://%s/"><script>window.__errs=[];addEventListener("error",e=>__errs.push(e.message+" @"+(e.filename||"").split("/").pop()+":"+e.lineno));'
    'addEventListener("unhandledrejection",e=>__errs.push("rejection: "+(e.reason&&e.reason.message||e.reason)));</script>' % app, 1)
h = h.replace("</body>", '<script src="file://%s/tests/pcb/dense-board.js"></script><script src="file://%s/tests/editor/perf-ui.js"></script></body>' % (root, root))
open(tmp + "/ui.html", "w").write(h)

def run_once():
    s0 = socket.socket(); s0.bind(("127.0.0.1", 0)); port = s0.getsockname()[1]; s0.close()
    prof = tmp + "/prof"; subprocess.run(["rm", "-rf", prof])
    proc = subprocess.Popen([chrome, "--headless=new", "--no-first-run", "--allow-file-access-from-files", "--disable-gpu",
        *(os.environ.get("CHROME_FLAGS", "--disable-frame-rate-limit --disable-gpu-vsync").split()), "--disable-background-timer-throttling", "--disable-renderer-backgrounding",
        "--user-data-dir=" + prof, "--remote-debugging-port=%d" % port, "--window-size=1440,900", "--force-device-scale-factor=1",
        "file://" + tmp + "/ui.html"], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    try:
        tab = None
        for _ in range(150):
            try: tab = [t for t in json.load(urllib.request.urlopen("http://127.0.0.1:%d/json" % port)) if t["type"] == "page"][0]; break
            except Exception: time.sleep(.1)
        if not tab: print("perf-ui: the browser did not start"); sys.exit(2)
        if os.environ.get("VERBOSE"): print("  .. tab", tab.get("url"), file=sys.stderr)
        wire = chrome_cdp.connect(tab["webSocketDebuggerUrl"],
            eof=lambda: SystemExit("perf-ui: the browser closed the connection"))
        def call(method, **params):
            return wire.raw_reply(method, params, 1)
        for _ in range(150):
            r = call("Runtime.evaluate", expression="typeof atriumUiProbe==='function'&&!!globalThis.AtriumNavHost&&document.readyState==='complete'", returnByValue=True)
            if r.get("result", {}).get("result", {}).get("value"): break
            time.sleep(.1)
        if os.environ.get("VERBOSE"): print("  .. page ready", file=sys.stderr)
        time.sleep(1.0)
        # The probe runs detached; poll its progress so a stuck interaction is named, not a silent hang.
        call("Runtime.evaluate", expression="window.__uiOut=null;atriumUiProbe({reps:%d,markers:%s}).then(o=>__uiOut=JSON.stringify(o)).catch(e=>__uiOut='ERR '+e.message+' '+e.stack)" % (reps, "true" if os.environ.get("MARKERS") == "1" else "false"))
        t0, v, last = time.time(), None, None
        while time.time() - t0 < float(os.environ.get("PROBE_TIMEOUT", "420")):
            time.sleep(.5)
            st = call("Runtime.evaluate", expression="JSON.stringify([window.__uiOut,window.__uiStep||''])", returnByValue=True)["result"]["result"]["value"]
            v, step = json.loads(st)
            if v: break
            if os.environ.get("VERBOSE") and step != last: print("  ..", step, "%.0fs" % (time.time() - t0), file=sys.stderr); last = step
        if not v: print("perf-ui: probe timed out at step:", step); sys.exit(2)
        errs = call("Runtime.evaluate", expression="JSON.stringify(window.__errs)", returnByValue=True)["result"]["result"]["value"]
        if not v or v.startswith("ERR"): print("perf-ui: probe failed:", v or r); sys.exit(2)
        out = json.loads(v); out["pageErrors"] = json.loads(errs); return out
    finally: proc.kill()

results = [run_once() for _ in range(runs)]
med = lambda xs: round(statistics.median(xs), 2)
metrics = {}
for k in results[0]["metrics"]:
    rs = [r["metrics"][k] for r in results if k in r["metrics"]]
    metrics[k] = {q: med([x[q] for x in rs]) for q in rs[0]}
# p95 budgets (ms, input to next paint) on an M-series Mac, headless Chrome, CPU raster. Interactions that
# redraw the 25.6k board in the same frame (selection, tab switch, theme, sash) carry that frame's cost.
B = {"menu-open": 16, "menu-close": 16, "context-menu": 50, "palette-open": 33, "palette-type-command": 16, "palette-close": 16,
     "quick-open-type": 16, "props-single": 50, "props-5k": 80, "props-clear": 50, "messages-show-5k": 33, "messages-close": 16,
     "messages-scroll": 16, "messages-arrow": 16, "messages-filter": 16, "messages-sort": 33, "tree-switch-sheet": 33,
     "navigator-toggle": 33, "navigator-filter": 16, "prefs-open": 33, "prefs-page": 16, "prefs-search": 16, "dialog-close": 33,
     "library-open": 33, "tab-to-schematic": 33, "tab-to-pcb": 120, "sash-drag": 16, "sash-release": 60, "theme-switch": 100}
B = {k: float(os.environ.get("BUDGET_" + k.upper().replace("-", "_"), v)) for k, v in B.items()}
# Interactions that must not produce a long task at all (they are on the typing / scrolling path).
NO_LONG = {"menu-open", "menu-close", "palette-type-command", "quick-open-type", "messages-scroll", "messages-arrow", "messages-filter",
           "navigator-filter", "prefs-page", "sash-drag"}
fail = []
for k, lim in B.items():
    m = metrics.get(k)
    if not m: fail.append("%s: no measurement" % k); continue
    if m["p95"] is not None and m["p95"] > lim: fail.append("%s p95 %.2f ms > %g ms" % (k, m["p95"], lim))
    if k in NO_LONG and m["longTasks"] > 0 and os.environ.get("ALLOW_LONG") != "1": fail.append("%s: %d long task(s), longest %d ms" % (k, m["longTasks"], m["longMaxMs"]))
checks = results[-1]["checks"]; errors = results[-1]["errors"] + results[-1]["pageErrors"]
if errors: fail.append("%d page error(s)" % len(errors))
if checks.get("startPageClosed") is False: fail.append("a dialog stayed open after setup")
if checks.get("messagesRowsInDom") and checks["messagesRowsInDom"] > 400: fail.append("Messages renders %d rows for 5,000 messages (not virtualised)" % checks["messagesRowsInDom"])
if asjson: print(json.dumps({"interactions": metrics, "checks": checks, "budgets": B, "failed": fail, "errors": errors, "env": results[-1]["env"]}, indent=2))
else:
    print("UI-shell interactions, 25.6k board + %d documents, headless Chrome, frame limit off; ms input -> next paint (median of %d run%s)"
          % (checks.get("documents", 0), runs, "" if runs == 1 else "s"))
    print("  %-22s %4s %8s %8s %8s %8s %7s %6s   %s" % ("interaction", "n", "p50", "p95", "p99", "sync95", "long", "loaf", "budget p95"))
    for k, m in metrics.items():
        print("  %-22s %4d %8.2f %8.2f %8.2f %8.2f %7s %6d   %s" % (k, m["n"], m["p50"], m["p95"], m["p99"], m["sync95"],
              "%d/%d" % (m["longTasks"], m["longMaxMs"]), m["loafs"], ("%g" % B[k]) if k in B else "-"))
    print("  checks: " + ", ".join("%s=%s" % kv for kv in checks.items()))
    if errors: print("  page errors:", errors[:10])
    print("FAIL: " + "; ".join(fail) if fail else "PASS all UI budgets")
sys.exit(1 if fail else 0)
PY
