#!/usr/bin/env python3
"""Every worker starts on every host, and a release made in the output worker is byte-identical
across engines.

Runs tests/workers/worker-start-probe.js, which starts each worker the app has the way the app starts it
(the file-script workers through AtriumWorkerPool.script(), the Blob workers from their in-page
source) and makes the "Generic fab + assembly" and "Everything" releases of the sample board with
the Release page's worker pool, in:
  chrome   headless Chrome loading app/index.html from file:// (as the other browser tests)
  webkit   the macOS harness: the real Desktop class and WKWebView, the page from file:// (macOS only)
  gtk      WebKitGTK 4.1 with the Linux host's settings, the page from file:// (Linux only; $DISPLAY,
           else xvfb-run, else broadwayd)
Each release is also made with the same translators on the page (no output worker). Fails when
a worker does not answer, an output expected from the worker runs on the page, a release
reports an error, the worker's files differ from the page's, or two engines' files differ.
The full schematic PDF uses the host's font metrics. A second Everything release with a real
PCB-only PDF gives a complete byte comparison including the PDF, manifests, and archive.

Usage: tests/workers/worker-start.py [chrome] [webkit] [gtk] [--json] [--save=FILE] [--compare=FILE]
       (default: chrome, plus webkit on macOS; --save writes this run's results, --compare adds the
       engines another machine saved, e.g. gtk from the Linux runner, to the byte-identity check)
       tests/workers/worker-start.py chrome --fault=worker-import|release-artifact
       (deliberately break a Blob dependency or change a generated Gerber; each run should fail)
Env:   CHROME=/path/to/chrome   APP=/path/to/app
       HARNESS_INSTALL  where the macOS harness app goes (default native/tests/macos-harness/target/worker-start,
                        deleted afterwards; it must be a real path outside /tmp and /var)
Exit status 0 when every check passes, 1 on a failure, 2 when no engine could run."""
from itertools import combinations
import json, os, platform, re, shutil, signal, socket, subprocess, sys, tempfile, time, urllib.request

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "../.."))
sys.path.insert(0, os.path.join(ROOT, "scripts", "ci"))
import chrome_cdp
APP = os.environ.get("APP") or os.path.join(ROOT, "app")
PROBE = os.path.join(ROOT, "tests/workers/worker-start-probe.js")
MAC = os.path.join(ROOT, "native", "tests", "macos-harness")
# Kinds release.js makes in its worker (release.js WORKER_KINDS).
WORKER_KINDS = {"gerber", "ipc2581", "step", "kicad", "pnp", "assembly"}


def find_chrome():
    return os.environ.get("CHROME") or next((c for c in ["/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", "/Applications/Chromium.app/Contents/MacOS/Chromium",
        shutil.which("google-chrome") or "", shutil.which("chromium") or "", shutil.which("chromium-browser") or ""] if c and os.access(c, os.X_OK)), None)


class Page:
    """A headless Chrome page over the DevTools protocol (no packages; as scripts/perf-route.py)."""
    def __init__(self, chrome, url, tmp):
        s0 = socket.socket(); s0.bind(("127.0.0.1", 0)); port = s0.getsockname()[1]; s0.close()
        self.proc = subprocess.Popen([chrome, "--headless=new", "--disable-gpu", "--no-first-run", "--allow-file-access-from-files",
            "--user-data-dir=" + tmp + "/profile", "--remote-debugging-port=%d" % port, "--window-size=1380,860", url],
            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, start_new_session=True)
        tab = None
        for _ in range(150):
            try: tab = [t for t in json.load(urllib.request.urlopen("http://127.0.0.1:%d/json" % port)) if t["type"] == "page"][0]; break
            except Exception: time.sleep(.1)
        if not tab: raise ConnectionError("Chrome did not open a page")
        self.wire = chrome_cdp.connect(tab["webSocketDebuggerUrl"], timeout=600)
        self.sock = self.wire.sock
        self.n = 0

    def call(self, method, **params):
        self.n += 1
        return chrome_cdp.checked_result(method, self.wire.raw_reply(method, params, self.n))

    def eval(self, expr):
        r = self.call("Runtime.evaluate", expression=expr, awaitPromise=True, returnByValue=True)
        if "exceptionDetails" in r: raise RuntimeError(json.dumps(r["exceptionDetails"])[:800])
        return r.get("result", {}).get("value")

    def close(self):
        try: self.sock.settimeout(3); self.call("Browser.close")
        except Exception: pass
        try: os.killpg(self.proc.pid, signal.SIGKILL)
        except Exception: pass
        try: self.proc.wait(5)
        except Exception: pass


def run_chrome(tmp, fault=None):
    chrome = find_chrome()
    if not chrome: return None, "Chrome or Chromium not found; set CHROME=/path/to/chrome"
    h = open(os.path.join(APP, "index.html"), encoding="utf-8").read()
    h = h.replace("<head>", '<head><base href="file://%s/">' % APP, 1)
    h = h.replace("</body>", '<script src="file://%s"></script></body>' % PROBE, 1)
    page_path = os.path.join(tmp, "workers.html")
    open(page_path, "w", encoding="utf-8").write(h)
    page = Page(chrome, "file://" + page_path, tmp)
    try:
        for _ in range(300):
            if page.eval("typeof atriumWorkerProbe==='function'&&!!globalThis.AtriumNavHost&&!!globalThis.AtriumLazy"): break
            time.sleep(.1)
        page.eval("for(const d of document.querySelectorAll('dialog[open]'))d.close();true")
        return json.loads(page.eval("atriumWorkerProbe(" + json.dumps({"fault": fault}) + ").then(r=>JSON.stringify(r))")), None
    finally: page.close()


def parse_notes(text):
    parts = {}
    for m in re.finditer(r"^NOTE  WORKERS (\d+) (.*)$", text, re.M): parts[int(m.group(1))] = m.group(2)
    if not parts or "NOTE  WORKERS end" not in text: return None
    return json.loads("".join(parts[k] for k in sorted(parts)))


def run_webkit(tmp):
    if platform.system() != "Darwin": return None, "the macOS harness needs macOS"
    install = os.environ.get("HARNESS_INSTALL") or os.path.join(MAC, "target", "worker-start")
    own = not os.environ.get("HARNESS_INSTALL")
    env = dict(os.environ, HARNESS_OUT=os.path.join(tmp, "build"), HARNESS_INSTALL=install)
    try:
        if subprocess.run([os.path.join(MAC, "build.sh")], env=env, stdout=subprocess.DEVNULL).returncode: return None, "the macOS harness did not build"
        env.update(HARNESS_SUITE="ui", HARNESS_EPHEMERAL="1", HARNESS_WORK=os.path.join(tmp, "run"),
                   HARNESS_PROBES=":".join([os.path.join(MAC, "css-audit.js"), os.path.join(MAC, "ui-probes.js"), PROBE, os.path.join(MAC, "worker-probes.js")]))
        try: out = subprocess.run([os.path.join(install, "WaffleHarness.app", "Contents", "MacOS", "Waffle")], env=env, capture_output=True, text=True, timeout=900).stdout
        except subprocess.TimeoutExpired as e: out = (e.stdout or b"").decode("utf-8", "replace") if isinstance(e.stdout, bytes) else (e.stdout or "")
        r = parse_notes(out)
        return (r, None) if r else (None, "the harness printed no worker results:\n" + "\n".join(l for l in out.splitlines() if l.startswith(("FAIL", "RESULT")))[:2000])
    finally:
        if own: shutil.rmtree(install, ignore_errors=True)


GTK_CHILD = r"""
import json, sys
import gi
gi.require_version("Gtk", "3.0"); gi.require_version("WebKit2", "4.1")
from gi.repository import GLib, Gtk, WebKit2
page, probe, out = sys.argv[1:4]
# The Linux host's settings (native/linux/waffle.py leaves WebKitSettings at their defaults: no
# file access from file URLs), so the page gets the same file:// origin rules as the real app.
manager = WebKit2.UserContentManager()
manager.register_script_message_handler("probe")
view = WebKit2.WebView.new_with_user_content_manager(manager)
def got(_m, value):
    open(out, "w").write(value.get_js_value().to_string()); Gtk.main_quit()
manager.connect("script-message-received::probe", got)
def loaded(v, event):
    if event != WebKit2.LoadEvent.FINISHED: return
    js = open(probe).read() + (";(async()=>{for(let i=0;i<300&&!(globalThis.AtriumNavHost&&globalThis.AtriumLazy);i++)await new Promise(r=>setTimeout(r,100));"
          "for(const d of document.querySelectorAll('dialog[open]'))d.close();"
          "let r;try{r=JSON.stringify(await atriumWorkerProbe())}catch(e){r=JSON.stringify({fatal:String(e&&e.stack||e)})}"
          "webkit.messageHandlers.probe.postMessage(r)})();true;")
    v.run_javascript(js, None, None)
view.connect("load-changed", loaded)
w = Gtk.Window(); w.set_default_size(1380, 860); w.add(view); w.show_all()
GLib.timeout_add_seconds(600, Gtk.main_quit)
view.load_uri("file://" + page)
Gtk.main()
"""


def run_gtk(tmp):
    """WebKitGTK 4.1 with the Linux host's settings. Uses $DISPLAY, else xvfb-run, else broadwayd."""
    if platform.system() != "Linux": return None, "WebKitGTK needs Linux"
    child, out = os.path.join(tmp, "gtk-child.py"), os.path.join(tmp, "gtk.json")
    open(child, "w").write(GTK_CHILD)
    env, cmd, daemon = dict(os.environ), [sys.executable, child, os.path.join(APP, "index.html"), PROBE, out], None
    if not env.get("DISPLAY") and not env.get("WAYLAND_DISPLAY"):
        if shutil.which("xvfb-run"): cmd = ["xvfb-run", "-a", "-s", "-screen 0 1380x860x24"] + cmd
        elif shutil.which("broadwayd"):
            display = ":%d" % (40 + os.getpid() % 50)
            daemon = subprocess.Popen(["broadwayd", display], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL); time.sleep(1)
            env.update(GDK_BACKEND="broadway", BROADWAY_DISPLAY=display)
        else: return None, "no display: set DISPLAY, or install xvfb-run or broadwayd"
    try:
        p = subprocess.run(cmd, env=env, capture_output=True, text=True, timeout=700)
        if not os.path.exists(out): return None, "WebKitGTK printed no worker results: " + (p.stderr or p.stdout)[-1500:]
        r = json.load(open(out))
        return (None, r["fatal"]) if "fatal" in r else (r, None)
    except subprocess.TimeoutExpired: return None, "WebKitGTK did not finish"
    finally:
        if daemon: daemon.kill()


def main():
    args = [a for a in sys.argv[1:] if not a.startswith("--")]
    asjson = "--json" in sys.argv
    opt = lambda k: next((a.split("=", 1)[1] for a in sys.argv[1:] if a.startswith("--" + k + "=")), None)
    engines = args or (["chrome", "webkit"] if platform.system() == "Darwin" else ["chrome"])
    fault = opt("fault")
    if fault is not None and (engines != ["chrome"] or fault not in ("worker-import", "release-artifact")):
        print("Use chrome --fault=worker-import or chrome --fault=release-artifact.")
        return 2
    tmp = tempfile.mkdtemp(prefix="atrium-workers.")
    results, fails, ran = {}, [], 0
    try:
        for e in engines:
            os.makedirs(os.path.join(tmp, e), exist_ok=True)
            try:
                runner = {"chrome": run_chrome, "webkit": run_webkit, "gtk": run_gtk}[e]
                r, why = runner(os.path.join(tmp, e), fault) if fault else runner(os.path.join(tmp, e))
            except Exception as x: r, why = None, "%s: %s" % (type(x).__name__, x)
            if not r:
                print("%s  %s: %s" % ("FAIL" if e in args else "SKIP", e, why))
                if e in args: fails.append("%s: %s" % (e, why))
                continue
            ran += 1; results[e] = r; r["os"] = platform.system()
            for name, w in r["workers"].items():
                print("%s  %-7s worker starts: %s  — %s · %s · %s ms" % ("PASS" if w.get("ok") else "FAIL", e, name, w.get("supply"), w.get("state"), w.get("ms")))
                if not w.get("ok"): fails.append("%s: %s did not start (%s %s)" % (e, name, w.get("state"), w.get("detail") or ""))
            for job, x in r["releases"].items():
                if x.get("error"): fails.append("%s: release %s: %s" % (e, job, x["error"])); print("FAIL  %-7s release %s: %s" % (e, job, x["error"][:300])); continue
                bad = [o for o in x["outputs"] if o["status"] == "error"]
                page_made = x["stats"]["page"] - sum(1 for o in x["outputs"] if o["kind"] not in WORKER_KINDS and o["status"] not in ("skipped",))
                if x.get("page"):
                    correct_lane = x["stats"]["worker"] == 0 and x["stats"]["page"] > 0
                else:
                    correct_lane = x["stats"]["worker"] > 0 and page_made <= 0
                missing_pdf = any(o["kind"] == "pdf" and not o["files"] for o in x["outputs"])
                ok = not bad and correct_lane and not missing_pdf
                print("%s  %-7s release %s: %d outputs, %d files, worker %d, page %d, %d ms%s" % ("PASS" if ok else "FAIL", e, job, len(x["outputs"]), len(x["files"]),
                      x["stats"]["worker"], x["stats"]["page"], x["ms"], "; errors: " + json.dumps(bad) if bad else ""))
                if not ok: fails.append("%s: release %s: worker %d, page %d, errors %s" % (e, job, x["stats"]["worker"], x["stats"]["page"], json.dumps(bad)))
            if r.get("errors"): fails.append("%s: page errors %s" % (e, r["errors"][:5])); print("FAIL  %-7s page errors: %s" % (e, r["errors"][:5]))
        # Results saved on another machine (--save there, --compare=FILE here): the gtk run on Linux
        # against chrome and webkit on macOS. Compared like the engines run here.
        if opt("compare"):
            for e, r in json.load(open(opt("compare"))).items():
                if e not in results: results[e] = r; print("NOTE  compared with %s results from %s" % (e, opt("compare")))
        if opt("save"): json.dump(results, open(opt("save"), "w"))
        # Byte identity: every release file, worker against page in each engine, then engine against engine.
        for e, r in results.items():
            for job, x in r["releases"].items():
                y = r["releases"].get(job + " (page only)")
                if x.get("page") or not y or x.get("files") is None or y.get("files") is None: continue
                if not x.get("design") or x["design"] != y.get("design"):
                    fails.append("%s: release %s: worker and page used different designs" % (e, job))
                    print("FAIL  %s release %s: worker and page used different designs" % (e, job))
                diff = sorted(k for k in set(x["files"]) | set(y["files"]) if x["files"].get(k) != y["files"].get(k))
                print("%s  %-7s release %s: worker and page-only files byte-identical (%d files)%s" % ("FAIL" if diff else "PASS", e, job, len(x["files"]), "; differ: " + ", ".join(diff[:12]) if diff else ""))
                if diff: fails.append("%s: release %s: the worker changed %s" % (e, job, diff[:12]))
        for a, b in combinations(results, 2):
            fixture = results[a].get("fixture")
            if not fixture or fixture != results[b].get("fixture"):
                fails.append("%s and %s used different release fixtures" % (a, b))
                print("FAIL  %s and %s release fixtures differ" % (a, b))
            for job in results[a]["releases"]:
                x, y = results[a]["releases"][job], results[b]["releases"].get(job, {})
                fa, fb = x.get("files"), y.get("files")
                if fa is None or fb is None:
                    fails.append("release %s: %s or %s has no file hashes" % (job, a, b))
                    continue
                diff = sorted(k for k in set(fa) | set(fb) if fa.get(k) != fb.get(k))
                # The full schematic PDF measures text in the host canvas. Cross-OS PDF output has
                # the same limitation. Compare all other files and require matching file lists.
                host_pdf = x.get("crossHost") is False and y.get("crossHost") is False
                kinds = x.get("kinds", {})
                if host_pdf or results[a].get("os") != results[b].get("os"):
                    pdf_differs = any(kinds.get(k) in ("pdf", "drawing") and k in fa and k in fb for k in diff)
                    if pdf_differs:
                        derived = {"pdf", "drawing", "readme", "release"}
                        host_diff = [k for k in diff if k in fa and k in fb
                                     and (kinds.get(k) in derived or k.startswith("package:"))]
                        print("NOTE  release %s: %s and %s differ in host PDF or files that hash it: %s"
                              % (job, a, b, ", ".join(host_diff)))
                        diff = [k for k in diff if k not in host_diff]
                        fa = {k: v for k, v in fa.items() if k not in host_diff}
                print("%s  release %s: %s and %s files byte-identical (%d files)%s" % ("FAIL" if diff else "PASS", job, a, b, len(fa), "; differ: " + ", ".join(diff[:12]) if diff else ""))
                if diff: fails.append("release %s: %s and %s differ in %s" % (job, a, b, diff[:12]))
    finally: shutil.rmtree(tmp, ignore_errors=True)
    if asjson: print(json.dumps({"results": results, "failed": fails}, indent=1))
    if not ran: print("RESULT no engine ran"); return 2
    print("RESULT ok" if not fails else "RESULT %d failed" % len(fails))
    return 1 if fails else 0


if __name__ == "__main__":
    sys.exit(main())
