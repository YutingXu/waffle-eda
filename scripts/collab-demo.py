#!/usr/bin/env python3
"""Two-window collaboration demos in headless Chrome.

Two editor windows ("Alice" and "Bob", separate origins so their preferences differ) sit side by
side in one page. A stand-in for the native host runs in this script: the lock and presence
sidecars use the Linux host's own CollabLocks code (native/linux/waffle.py) on a real folder,
and the project file is a real file in that folder. The live-session demo goes through the real
relay (collab/relay/waffle_relay.py) on 127.0.0.1.

    python3 scripts/collab-demo.py [--out docs/images] [--only lock|live]

Checks what each window shows and writes screenshots: collab-lock-*.png, collab-live-*.png.
Exit status 0 when every check passes. Standard library only; needs Chrome or Chromium.
"""
import argparse
import asyncio
import base64
import hashlib
import http.server
import importlib.util
import json
import os
from pathlib import Path
import shutil
import socket
import subprocess
import sys
import tempfile
import threading
import time
import urllib.request

ROOT = Path(__file__).resolve().parents[1]
APP = ROOT / "app"
sys.path.insert(0, str(ROOT / "scripts" / "ci"))
import chrome_cdp

FAKE_HOST = r"""
(() => {
  "use strict";
  const q = new URLSearchParams(location.search), name = q.get("name") || "Someone";
  try { localStorage.setItem("atrium.prefs", JSON.stringify({format: "atrium-prefs", version: 1, values: {"general.startPage": "never", "collab.displayName": name, "collab.realtime": true}})); } catch {}
  const session = name + "-" + Math.random().toString(36).slice(2, 8);
  const api = (path, body) => fetch("/fs/" + path, {method: "POST", body: JSON.stringify({session, ...body})}).then(r => r.json()).then(r => { if (r && r.error) throw Error(r.error); return r; });
  let projectPath = null;
  const PATH = "/shared/Sensor.waffle";
  window.AtriumHost = {
    get projectPath() { return projectPath; }, get baseToken() { return null; }, get savedToken() { return null; },
    acceptProject() { projectPath = PATH; dispatchEvent(new CustomEvent("atrium-host-project", {detail: {path: PATH}})); },
    clearProjectPath() { projectPath = null; },
    async save(n, text) { await api("save", {text}); projectPath = PATH; return true; },
    async saveInPlace(p) { if (typeof p?.text !== "string") throw Error("The save base is out of date."); await api("save", {text: p.text}); return {saved: true, token: null, compacted: true}; },
    async compactProject() { return {compacted: false}; }, async openedProjectText() { return null; },
    setDirty() {}, recentFiles() { return []; }, async refreshRecentFiles() { return []; },
    async openRecent() { const r = await api("read", {}); const f = new File([r.text], "Sensor.waffle"); return [f]; },
    async writeRecovery() { return false; }, async pendingRecovery() { return null; }, async discardRecovery() { return true; },
    collabLocks: () => projectPath ? api("list", {}) : Promise.resolve(null),
    collabLockWrite: (key, data, mode) => api("write", {key, data: JSON.stringify(data), mode}),
    collabLockRemove: (key, force) => api("remove", {key, force: !!force})
  };
  window.__errors = [];
  addEventListener("error", e => window.__errors.push(String(e.message)));
  addEventListener("message", async e => {
    if (!e.data || typeof e.data.run !== "string") return;
    let r;
    try { r = await (0, eval)("(async () => {" + e.data.run + "\n})()"); } catch (err) { r = "ERR " + err.message; }
    parent.postMessage({id: e.data.id, result: JSON.stringify(r === undefined ? null : r)}, "*");
  });
})();
"""

TOP = """<!doctype html><meta charset="utf-8"><title>Waffle collaboration demo</title>
<style>html,body{margin:0;height:100%;background:#111}body{display:grid;grid-template-columns:1fr 1fr;gap:4px}
iframe{width:100%;height:100%;border:0;background:#222}</style>
<iframe src="http://127.0.0.1:PORT_A/index.html?name=Alice" title="Alice"></iframe>
<iframe src="http://127.0.0.1:PORT_B/index.html?name=Bob" title="Bob"></iframe>
<script>
const pending = {};
addEventListener("message", e => { const p = pending[e.data?.id]; if (p) { delete pending[e.data.id]; p(e.data.result); } });
window.run = (i, code) => new Promise(res => { const id = Math.random().toString(36); pending[id] = res; frames[i].postMessage({id, run: code}, "*"); setTimeout(() => { if (pending[id]) { delete pending[id]; res(JSON.stringify("TIMEOUT")); } }, 20000); });
</script>"""


def linux_locks():
    spec = importlib.util.spec_from_file_location("atrium_linux", ROOT / "native" / "linux" / "waffle.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class Shared:
    """The shared folder: the project file and one CollabLocks (the Linux host's code) per window."""
    def __init__(self, folder):
        self.app = linux_locks()
        self.folder = folder
        self.project = folder / "Sensor.waffle"
        self.windows = {}
        self.lock = threading.Lock()

    def locks(self, session):
        if session not in self.windows:
            self.windows[session] = self.app.CollabLocks(self.folder / ("support-" + session.split("-")[0]))
        return self.windows[session]

    def handle(self, op, body):
        with self.lock:
            locks = self.locks(str(body.get("session")))
            if op == "list":
                return locks.listing(self.project) if self.project.exists() else {"session": locks.session, "machine": locks.machine, "now": 0, "locks": []}
            if op == "write":
                return locks.write(self.project, body.get("key"), body.get("data"), body.get("mode"))
            if op == "remove":
                return locks.remove(self.project, body.get("key"), body.get("force") is True)
            if op == "save":
                self.project.write_text(body["text"])
                return {"saved": True}
            if op == "read":
                return {"text": self.project.read_text()}
        raise ValueError("unknown")


def serve(shared, port):
    index = (APP / "index.html").read_text().replace("<head>", "<head><script src=\"/fakehost.js\"></script>", 1)

    class Handler(http.server.SimpleHTTPRequestHandler):
        def __init__(self, *a, **k):
            super().__init__(*a, directory=str(APP), **k)

        def log_message(self, *a):
            pass

        def send(self, body, kind):
            data = body.encode()
            self.send_response(200)
            self.send_header("Content-Type", kind)
            self.send_header("Content-Length", str(len(data)))
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
            self.wfile.write(data)

        def do_GET(self):
            path = self.path.split("?")[0]
            if path in ("/", "/index.html"):
                return self.send(index, "text/html; charset=utf-8")
            if path == "/fakehost.js":
                return self.send(FAKE_HOST, "text/javascript")
            if path == "/demo.html":
                return self.send(TOP.replace("PORT_A", str(shared.ports[0])).replace("PORT_B", str(shared.ports[1])), "text/html; charset=utf-8")
            return super().do_GET()

        def do_POST(self):
            body = json.loads(self.rfile.read(int(self.headers.get("Content-Length", 0))) or b"{}")
            try:
                result = shared.handle(self.path.split("/")[-1], body)
            except ValueError as error:
                result = {"error": str(error)}
            self.send(json.dumps(result), "application/json")

    class Server(http.server.ThreadingHTTPServer):
        request_queue_size = 256   # Chrome opens many connections at once
        daemon_threads = True

        def handle_error(self, request, address):
            pass                        # a page that navigated away mid-download
    server = Server(("127.0.0.1", port), Handler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    return server


def free_port():
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


# ---------------------------------------------------------------------- a minimal CDP client
class CDP:
    def __init__(self, ws_url):
        self.wire = chrome_cdp.connect(ws_url, eof=lambda: EOFError())
        self.next = 0

    @property
    def sock(self):
        return self.wire.sock

    def call(self, method, **params):
        self.next += 1
        reply = self.wire.raw_reply(method, params, self.next)
        if "error" in reply:
            raise RuntimeError(reply["error"])
        return reply.get("result", {})

    def eval(self, expression, timeout=30):
        r = self.call("Runtime.evaluate", expression=expression, awaitPromise=True, returnByValue=True, timeout=timeout * 1000)
        if "exceptionDetails" in r:
            raise RuntimeError(r["exceptionDetails"].get("text", "") + json.dumps(r["exceptionDetails"])[:400])
        return r["result"].get("value")

    def run(self, frame, code):
        text = self.eval("run(%d, %s)" % (frame, json.dumps(code)))
        value = json.loads(text)
        if isinstance(value, str) and value.startswith(("ERR", "TIMEOUT")):
            raise RuntimeError("frame %d: %s" % (frame, value))
        return value

    def shot(self, path):
        data = self.call("Page.captureScreenshot", format="png")["data"]
        Path(path).write_bytes(base64.b64decode(data))
        print("  screenshot", path)


def chrome():
    for c in [os.environ.get("CHROME"), "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", "/Applications/Chromium.app/Contents/MacOS/Chromium",
              shutil.which("google-chrome") or "", shutil.which("chromium") or ""]:
        if c and os.path.exists(c):
            return c
    sys.exit("Chrome or Chromium not found; set CHROME=/path/to/chrome")


def wait(cdp, frame, condition, what, timeout=20):
    end = time.time() + timeout
    last = None
    while time.time() < end:
        try:
            last = cdp.run(frame, "return !!(" + condition + ");")
            if last:
                return
        except RuntimeError as error:
            last = str(error)
        time.sleep(.25)
    raise AssertionError("timed out waiting for " + what + " (" + str(last) + ")")


CHECKS = []


def check(ok, what):
    CHECKS.append((bool(ok), what))
    print(("  ok    " if ok else "  FAIL  ") + what)


BAR = "(() => { const b = document.querySelector('.collab-bar'); return b && !b.hidden ? b.textContent : ''; })()"


def lock_demo(cdp, out):
    print("Document locking and presence (shared folder)")
    for i in (0, 1):
        wait(cdp, i, "globalThis.AtriumNavHost && globalThis.AtriumLazy", "editor %d" % i)
        cdp.run(i, "await AtriumLazy.need('AtriumCollabLock'); await AtriumLazy.need('AtriumCollabPresence'); return true;")
    # This demo needs the named sensor board that the participants visit in the screenshots.
    cdp.run(0, "if (!globalThis.AtriumParts) await AtriumLazy.need('AtriumParts'); await AtriumNavHost.replaceProject(AtriumParts.example(), {force: true, copy: true, dirty: false}); globalThis.AtriumStartPage?.close?.(); return true;")
    # Alice saves the project into the shared folder; Bob opens it.
    cdp.run(0, "const ok = await AtriumIO.save(AtriumNavHost.project(), {as: true}); return ok;")
    wait(cdp, 0, "AtriumCollabLock.manager() && AtriumCollabLock.manager().held().length", "Alice's lock")
    board = cdp.run(0, "const h = AtriumNavHost, b = h.project().documents.find(d => d.kind === 'pcb'); h.selectDocument(b.id); await AtriumCollabLock.take(b.id); return b.id;")
    cdp.run(1, "const f = await AtriumHost.openRecent(); await AtriumNavHost.openFiles(f); return true;")
    wait(cdp, 1, "AtriumCollabLock.manager()", "Bob's manager")
    cdp.run(1, "AtriumNavHost.selectDocument(%s); await AtriumCollabLock.take(%s); await AtriumCollabLock.manager().tick(); return true;" % (json.dumps(board), json.dumps(board)))
    try:
        wait(cdp, 1, BAR + ".includes('Alice is editing')", "Bob's read-only bar")
    except AssertionError:
        print(cdp.run(1, "const M = AtriumCollabLock.manager(); return {bar: " + BAR + ", cur: AtriumNavHost.currentId(), board: %s, state: M && M.docState(%s), recs: M && M.records().map(r => [r.key, r.name, r.session]), me: M && M.session(), err: window.__errors};" % (json.dumps(board), json.dumps(board))))
        cdp.shot(out / "debug.png")
        raise
    check("read-only" in cdp.run(1, "return " + BAR), "Bob sees “Alice is editing … read-only”")
    check(cdp.run(1, "return AtriumCollabLock.manager().blocked(%s);" % json.dumps(board)), "Bob is read-only on the board")
    # Bob tries to edit: refused, nothing changes.
    before = cdp.run(1, "return JSON.stringify(AtriumNavHost.doc().items.length);")
    cdp.run(1, "AtriumNavHost.edit(() => AtriumNavHost.doc().items.push({id: 'x1', kind: 'via', x: 1, y: 1, diameter: .6})); return true;")
    check(cdp.run(1, "return JSON.stringify(AtriumNavHost.doc().items.length);") == before, "an edit on the locked board is refused")
    # Presence badges on tabs and the tree, both ways.
    cdp.run(0, "await AtriumCollabLock.manager().beat(); await AtriumCollabLock.manager().tick(); AtriumCollabPresence.paintBadges(); return true;")
    cdp.run(1, "await AtriumCollabLock.manager().beat(); await AtriumCollabLock.manager().tick(); AtriumCollabPresence.paintBadges(); return true;")
    wait(cdp, 0, "document.querySelector('#document-tabs .collab-badge.is-viewing, #documents .collab-badge.is-viewing')", "Alice sees Bob viewing")
    wait(cdp, 1, "document.querySelector('#documents .collab-badge.is-editing')", "Bob sees Alice's lock badge")
    check(True, "presence badges on both windows' tabs and Projects tree")
    wait(cdp, 0, "document.querySelector('#collab-faces .collab-person-tip')?.textContent.includes('Viewing Sensor board')", "Bob's open shared-folder document")
    check(cdp.run(0, "return document.querySelector('#collab-faces button').getAttribute('aria-label') === 'Bob';"), "the toolbar shows the other shared-folder editor")
    # Per-document: Bob takes the schematic while Alice keeps the board.
    sch = cdp.run(1, "const s = AtriumNavHost.project().documents.find(d => d.kind === 'schematic'); const r = await AtriumCollabLock.take(s.id); AtriumNavHost.selectDocument(%s); return [s.id, r.state];" % json.dumps(board))
    check(sch[1] == "held", "Bob locks the schematic while Alice holds the board")
    time.sleep(.6)
    cdp.shot(out / "collab-lock-readonly.png")
    # Alice saves a board change; Bob's read-only board reloads.
    cdp.run(0, "const d = AtriumNavHost.doc(); AtriumNavHost.edit(() => d.items.push({id: 'via-from-alice', kind: 'via', x: 4, y: 4, diameter: .6})); await AtriumIO.save(AtriumNavHost.project(), {}); return true;")
    cdp.run(1, "await AtriumCollabLock.manager().tick(); return true;")
    wait(cdp, 1, "AtriumNavHost.project().documents.some(d => d.items.some(i => i.id === 'via-from-alice'))", "Bob's live reload")
    check(True, "Bob's read-only copy reloads when Alice saves")
    # Bob edits and saves his schematic; Alice's save afterwards merges it (no overwrite).
    cdp.run(1, "const s = AtriumNavHost.project().documents.find(d => d.id === %s); AtriumNavHost.selectDocument(s.id); AtriumNavHost.edit(() => s.items.push({id: 'label-from-bob', kind: 'netlabel', text: 'BOB', x: 10, y: 10})); return await AtriumIO.save(AtriumNavHost.project(), {});" % json.dumps(sch[0]))
    cdp.run(0, "const d = AtriumNavHost.project().documents.find(d => d.kind === 'pcb'); AtriumNavHost.edit(() => d.items.push({id: 'via-2', kind: 'via', x: 6, y: 4, diameter: .6})); return await AtriumIO.save(AtriumNavHost.project(), {});")
    disk = json.loads(cdp.run(1, "const f = await AtriumHost.openRecent(); return await f[0].text();"))
    ids = {i["id"] for d in disk["documents"] for i in d["items"]}
    check({"label-from-bob", "via-2", "via-from-alice"} <= ids, "per-document merge on save: both people's saved work is in the file")
    if not {"label-from-bob", "via-2", "via-from-alice"} <= ids:
        print(sorted(i for i in ids if "-" in i and len(i) < 20), cdp.run(0, "return " + BAR), cdp.run(1, "return " + BAR))
    # Ask to edit, then hand over.
    cdp.run(1, "AtriumNavHost.selectDocument(%s); await AtriumCollabLock.ask(%s); return true;" % (json.dumps(board), json.dumps(board)))
    cdp.run(0, "await AtriumCollabLock.manager().tick(); AtriumCollabPresence.paintBar(); return true;")
    wait(cdp, 0, BAR + ".includes('asks to edit')", "Alice sees Bob's request")
    check(True, "Alice sees “Bob asks to edit Board”")
    cdp.shot(out / "collab-lock-ask.png")
    cdp.run(0, "[...document.querySelectorAll('.collab-bar button')].find(b => b.textContent === 'Hand Over').click(); return true;")
    wait(cdp, 0, "!AtriumCollabLock.manager().held().includes(%s)" % json.dumps(board), "Alice releases")
    cdp.run(1, "await AtriumCollabLock.manager().tick(); return true;")
    wait(cdp, 1, "AtriumCollabLock.manager().held().includes(%s)" % json.dumps(board), "Bob receives the board")
    check(True, "hand-over: Bob holds the board lock")
    time.sleep(.5)
    cdp.shot(out / "collab-lock-handover.png")
    errors = [cdp.run(i, "return window.__errors;") for i in (0, 1)]
    check(not any(errors), "no page errors (%s)" % errors)


def simultaneous_drag(cdp):
    # Hold just the two outgoing claims until both windows have really begun the same drag.
    for i in (0, 1):
        cdp.run(i, "AtriumNavHost.select([], null); return true;")
    for i in (0, 1):
        wait(cdp, i, "!AtriumCollabLive.peers().some(p => p.lock?.length)", "previous drag released")
    ids = []
    for i in (0, 1):
        ids.append(cdp.run(i, """
          const h=AtriumNavHost, s=AtriumCollabLive.session(), send=s.t.send.bind(s.t);
          let claim;
          s.t.send=(kind,body)=>{ if(kind==='cursor' && body.lock.length){claim=body;return Promise.resolve();}return send(kind,body); };
          window.releaseClaim=()=>{s.t.send=send;return send('cursor',claim);};
          const v=h.doc().items.find(x=>x.id==='live-via');
          h.beginStickyMove(v,[v.x,v.y]); h.select([v.id],v.id);
          if(!claim?.lock.includes(v.id)) throw Error("drag did not claim the via");
          return s.me;"""))
    for i in (0, 1):
        cdp.run(i, "await releaseClaim(); return true;")
    for i in (0, 1):
        wait(cdp, i, "AtriumCollabLive.peers().some(p => p.lock?.includes('live-via'))", "crossed claims delivered")
    winner = ids.index(min(ids))
    edit = "const v=AtriumNavHost.doc().items.find(x=>x.id==='live-via'); AtriumNavHost.edit(()=>{v.x=%d;}); return true;"
    x = "AtriumNavHost.doc().items.find(x=>x.id==='live-via').x"
    cdp.run(1-winner, edit % 19)
    wait(cdp, 1-winner, x + " === 13", "losing drag reverted")
    cdp.run(winner, edit % 14)
    wait(cdp, 1-winner, x + " === 14", "winning drag converged")
    check(cdp.run(winner, "return " + x + " === 14;"), "simultaneous claims allow one drag and converge on the same position")
    for i in (0, 1):
        cdp.run(i, "AtriumNavHost.act('select'); AtriumNavHost.select([],null); return true;")


def badge_offset(cdp, selector):
    # Measure the painted glyph in a screenshot of the real control, in CSS pixels.
    box = cdp.run(0, r"""
      const el = document.querySelector(%s), r = el.getBoundingClientRect(), c = getComputedStyle(el).color;
      return {x:r.x,y:r.y,width:r.width,height:r.height,colour:c.match(/[\d.]+/g).slice(0,3).map(Number)};
    """ % json.dumps(selector))
    colour = box.pop("colour")
    box["scale"] = 3
    png = cdp.call("Page.captureScreenshot", format="png", clip=box)["data"]
    return cdp.run(0, """
      const im=new Image(); im.src="data:image/png;base64,"+%s; await im.decode();
      const c=document.createElement('canvas'); c.width=im.width; c.height=im.height;
      const ctx=c.getContext('2d'); ctx.drawImage(im,0,0);
      const {width:w,height:h,data}=ctx.getImageData(0,0,c.width,c.height);
      const at=(x,y)=>data.slice((y*w+x)*4,(y*w+x)*4+3);
      const fg=%s, bg=at(Math.floor(w/2),Math.round(h*.18));
      const dist=(p,q)=>p.reduce((s,v,i)=>s+(v-q[i])**2,0);
      let left=w,right=-1,top=h,bottom=-1;
      for(let y=0;y<h;y++) for(let x=0;x<w;x++) {
        if(Math.hypot((x+.5-w/2)/(w/2),(y+.5-h/2)/(h/2))>.84) continue;
        const p=at(x,y); if(dist(p,fg)>=dist(p,bg)) continue;
        left=Math.min(left,x);right=Math.max(right,x);top=Math.min(top,y);bottom=Math.max(bottom,y);
      }
      if(right<0) throw Error("No visible glyph");
      return [(left+right+1-w)/6,(top+bottom+1-h)/6];
    """ % (json.dumps(png), json.dumps(colour)))


def waypoint_demo(cdp):
    # Drive normal pointer events through the editor. Count presence messages at the
    # transport boundary, then check the last world position in the other live editor.
    cdp.run(0, "AtriumNavHost.act('select'); AtriumNavHost.select([], null); return true;")
    sample = cdp.run(0, """
      const h = AtriumNavHost, canvas = h.canvas(), box = canvas.getBoundingClientRect();
      const session = AtriumCollabLive.session(), transport = session.t, send = transport.send;
      const frames = [], events = 181;
      transport.send = function(kind, body) {
        if (kind === 'cursor') frames.push(body);
        return send.call(this, kind, body);
      };
      try {
        const start = performance.now();
        let x, y;
        for (let i = 0; i < events; i++) {
          x = Math.round(box.width * (.15 + .45 * Math.min(i / 90, 1)));
          y = Math.round(box.height * (.25 + .40 * Math.max(i / 90 - 1, 0)));
          canvas.dispatchEvent(new PointerEvent('pointermove', {bubbles: true, pointerType: 'mouse',
            clientX: box.left + x, clientY: box.top + y}));
          await new Promise(r => setTimeout(r, 8));
        }
        const duration = performance.now() - start, expected = h.view().screenToWorld([x,y]);
        await new Promise(r => setTimeout(r, 300));
        return {events, elapsed: Math.round(duration), total: frames.length,
          compact: frames.filter(p => p.posOnly && !p.sel && !p.lock && !p.cam).length,
          ended: frames.some(p => p.end && p.at?.every((v, i) => Math.abs(v - expected[i]) < 1e-6)),
          id: session.me, expected};
      } finally { transport.send = send; }
    """)
    check(sample["ended"] and 1 < sample["compact"] <= sample["total"] < sample["events"] / 4,
          "%d canvas moves over %.2f s sent %d cursor messages (%d position-only), including the exact stop" %
          (sample["events"], sample["elapsed"] / 1000, sample["total"], sample["compact"]))
    position = "AtriumCollabLive.peers().find(p => p.id === %s)?.at" % json.dumps(sample["id"])
    expected = json.dumps(sample["expected"])
    wait(cdp, 1, "%s?.every((v,i)=>Math.abs(v-%s[i])<1e-6)" % (position, expected), "guest cursor at the final design point")
    check(True, "a guest receives the exact final waypoint over the encrypted relay")


def overlapping_placements(cdp):
    for i in (0, 1):
        wait(cdp, i, "AtriumCollabLive.peers().length === 1", "two regular participants")
        cdp.run(i, "const h = AtriumNavHost; h.selectDocument(h.project().documents.find(d => d.kind === 'pcb').id); return true;")
    # Make an ordinary guest edit just as the incoming host edit finishes decryption,
    # before the guest's normal local-commit timer can fire.
    cdp.run(1, """
      const sub = crypto.subtle, decrypt = sub.decrypt.bind(sub);
      sub.decrypt = async (...args) => {
        const plain = await decrypt(...args), frame = JSON.parse(new TextDecoder().decode(plain));
        if (frame.t === 'ops' && frame.b.ops.some(op => op.o === 'overlap-host-via')) {
          delete sub.decrypt;
          const h = AtriumNavHost;
          h.edit(() => h.doc().items.push({id:'overlap-guest-via', kind:'via', x:10, y:9, diameter:.8}));
        }
        return plain;
      };
      return true;
    """)
    try:
        cdp.run(0, "const h = AtriumNavHost; h.edit(() => h.doc().items.push({id:'overlap-host-via', kind:'via', x:8, y:9, diameter:.8})); return true;")
        both = "['overlap-host-via','overlap-guest-via'].every(id => AtriumNavHost.doc().items.some(i => i.id === id))"
        for i in (0, 1):
            wait(cdp, i, both, "both overlapping placements")
        menu = "document.querySelector('.work-menu[data-menu=edit]')"
        def choose(action):
            return cdp.run(1, f"""const m = {menu}, b = m.querySelector('[data-action={action}]');
              if (!m.open) m.querySelector('summary').click();
              if (b.disabled || !b.getClientRects().length) return false;
              b.click(); return true;""")
        assert choose("undo"), "Undo is available in the Edit menu"
        for i in (0, 1):
            wait(cdp, i, "!AtriumNavHost.doc().items.some(i => i.id === 'overlap-guest-via')", "personal undo of overlapping placement")
        check(all(cdp.run(i, "return AtriumNavHost.doc().items.some(i => i.id === 'overlap-host-via');") for i in (0, 1)),
              "overlapping placements survive and guest Undo preserves the host's placement")
        assert choose("redo"), "Redo is available in the Edit menu"
        for i in (0, 1):
            wait(cdp, i, both, "personal redo from the Edit menu")
        check(True, "Edit › Redo restores the guest's placement on both editors")
    finally:
        cdp.run(1, "delete crypto.subtle.decrypt; return true;")


def people_demo(cdp, out, url, key):
    # Alice sees Bob move between documents even while she stays on the board.
    select = "const d = AtriumNavHost.project().documents.find(d => d.kind === %s); AtriumNavHost.selectDocument(d.id); return d.name;"
    schematic = cdp.run(1, select % "'schematic'")
    bob = "document.querySelector('#collab-faces button[aria-label=\"Bob\"]')"
    card = bob + ".nextElementSibling"
    wait(cdp, 0, card + ".textContent.includes(" + json.dumps(schematic) + ")", "Bob's schematic in the toolbar")
    cdp.run(0, bob + ".focus(); return true;")
    board = cdp.run(1, select % "'pcb'")
    wait(cdp, 0, card + ".textContent.includes(" + json.dumps(board) + ")", "Bob's document change")
    check(cdp.run(0, "return document.activeElement === " + bob + " && " + card + ".getClientRects().length > 0;"), "the focused avatar updates its document without losing focus")

    # Three additional encrypted clients exercise the overflow and same-name case on the relay.
    extra = cdp.run(0, "return AtriumCollabLive.session().url === " + json.dumps(url) + ";")
    def add_people(names):
        cdp.run(1, """
          window.demoGuests ||= [];
          for (const name of %s) {
            const t = await AtriumCollabTransport.connect({url: %s, roomKey: %s, salt: AtriumCollabLive.session()?.salt});
            demoGuests.push(t);
            await t.send('hello', {name, has: true});
            await t.send('cursor', {doc: AtriumNavHost.currentId()});
          }
          return true;""" % (json.dumps(names), json.dumps(url), json.dumps(key)))
    if extra:
        add_people(['Casey Lee', 'Morgan Park', 'Morgan Park'])
        wait(cdp, 0, "document.querySelector('#collab-more').textContent === '+1'", "crowded toolbar")
        cdp.run(0, "document.querySelector('#collab-more').click(); return true;")
        check(cdp.run(0, "return document.querySelectorAll('.collab-roster li').length === 4;"), "overflow lists every participant, including two with the same name")
        cdp.run(0, "document.querySelector('dialog.collab-dialog[open]').close(); return true;")
    else:
        cdp.run(0, bob + ".click(); return true;")
        check(cdp.run(0, "return document.querySelector('.collab-roster')?.textContent.includes(" + json.dumps(board) + ");"), "tapping the avatar opens the people list")
        cdp.run(0, "document.querySelector('dialog.collab-dialog[open]').close(); return true;")

    cdp.run(1, select % "'schematic'")
    wait(cdp, 0, card + ".textContent.includes(" + json.dumps(schematic) + ")", "Bob's open schematic")
    origin = cdp.eval("(() => { const r=document.querySelector('iframe').getBoundingClientRect(); return [r.x,r.y,r.right]; })()")
    target = cdp.run(0, "document.activeElement.blur(); const r=" + bob + ".getBoundingClientRect(); return [r.x+r.width/2,r.y+r.height/2];")
    cdp.call("Input.dispatchMouseEvent", type="mouseMoved", x=origin[0] + target[0], y=origin[1] + target[1])
    wait(cdp, 0, bob + ".matches(':hover')", "pointer over the avatar")
    time.sleep(.3)
    check(cdp.run(0, "return " + card + ".getClientRects().length === 0;"), "hovering an avatar shows no pop-up")
    cdp.run(0, bob + ".focus(); return true;")
    wait(cdp, 0, card + ".getClientRects().length > 0", "avatar card on focus")
    check(True, "keyboard focus shows the participant's current document")
    for theme in ("dark", "light"):
        cdp.run(0, "AtriumTheme.set({preset:%s}, {persist:false}); return true;" % json.dumps(theme))
        time.sleep(.3)
        clip = dict(x=origin[2] - 405, y=origin[1], width=405, height=108, scale=1.5)
        shot = cdp.call("Page.captureScreenshot", format="png", clip=clip)
        (out / ("collab-people-" + theme + ".png")).write_bytes(base64.b64decode(shot["data"]))
        if extra:
            offsets = [badge_offset(cdp, s) for s in ['#collab-faces button[aria-label="Bob"]',
                       '#collab-faces button[aria-label="Casey Lee"]', '#collab-more', '#documents .collab-badge.is-live']]
            check(all(abs(value) <= .75 for pair in offsets for value in pair), "%s theme centres initials and +1 %s" % (theme, offsets))
    cdp.run(0, "AtriumTheme.set({preset:'dark'},{persist:false}); return true;")
    if extra:
        add_people(["Visitor " + str(n) for n in range(9)])
        wait(cdp, 0, "document.querySelector('#collab-more').textContent === '+10'", "double-digit overflow")
        offset = badge_offset(cdp, "#collab-more")
        check(max(map(abs, offset)) <= .75, "double-digit count is centred %s" % offset)
        prior = cdp.run(0, "const {fontSize,density}=AtriumTheme.get();return {fontSize,density};")
        for font, density in ((12, 'default'), (14, 'comfortable')):
            cdp.run(0, "AtriumTheme.set({fontSize:%d,density:%s},{persist:false});return true;" % (font, json.dumps(density)))
            fits = []
            for width in (770, 950, 951, 1024):
                cdp.eval("document.querySelector('iframe').style.width='%dpx'" % width)
                wait(cdp, 0, "innerWidth === %d" % width, "desktop width %d" % width)
                fits.append(cdp.run(0, """const b=document.querySelector('#collab-share'), r=b.getBoundingClientRect();
                  return r.left>=0 && r.right<=innerWidth && document.elementFromPoint(r.right-2,r.top+r.height/2)?.closest('button')===b;"""))
            check(all(fits), "Share stays fully visible and clickable with a crowded toolbar and %dpx %s text" % (font, density))
        cdp.run(0, "AtriumTheme.set(%s,{persist:false});return true;" % json.dumps(prior))
        cdp.eval("document.querySelector('iframe').style.removeProperty('width')")
        cdp.run(1, "await Promise.all(demoGuests.map(t=>t.send('bye',{}))); return true;")
        wait(cdp, 0, "document.querySelector('#collab-more').hidden", "overflow disappears as people leave")
        cdp.run(1, "for (const t of demoGuests) t.close(); return true;")


def snapshot_requests(cdp, url, key):
    # Older editors broadcast duplicate discovery messages. Two seeded replicas must
    # choose one responder. A later connection of the same requester must still sync.
    counts = cdp.run(0, """
      const T = AtriumCollabTransport, roomKey = %s, url = %s, owner = AtriumCollabLive.session().me;
      const counts = {legacy: 0, first: 0, rejoin: 0};
      let opened, received, timer, phase = 'legacy';
      const ready = new Promise(r => opened = r);
      const t = await T.connect({url, roomKey, salt: AtriumCollabLive.session().salt, peer: 'joining-editor',
        onState(s) { if (s === 'open') opened(); },
        onMessage(kind, body) {
          if (kind === 'snapshot') { counts[phase]++; received?.(); }
        }});
      async function request(send) {
        const first = new Promise(r => received = r);
        const timeout = new Promise((_, reject) => timer = setTimeout(() => reject(Error('snapshot timed out')), 4000));
        try { await send(); await Promise.race([first, timeout]); await new Promise(r => setTimeout(r, 150)); }
        finally { clearTimeout(timer); received = null; }
      }
      try {
        await ready;
        await request(async () => {
          const hello = {has: false, name: 'Older editor', vv: {}};
          await t.send('hello', hello); await t.send('hello', hello); await t.send('want', {});
        });
        await t.send('hello', {has: true, name: 'Older editor', vv: AtriumCollabLive.session().r.vv()});
        for (const [name, joinRound] of [['first', 1], ['rejoin', 2]]) {
          phase = name;
          await request(async () => {
            const want = {to: owner, joinRound};
            await t.send('want', want); await t.send('want', want);
          });
        }
        await t.send('bye', {});
        return counts;
      } finally { t.close(); }
    """ % (json.dumps(key), json.dumps(url)))
    check(counts == {"legacy": 1, "first": 1, "rejoin": 1}, "one snapshot per legacy join or connection generation across two replicas")


def remote_object_demo(cdp):
    # Compare pixels on the receiving editor with hit-testing against the actual project.
    cdp.run(1, """
      const h=AtriumNavHost, view=h.view(), canvas=h.canvas(), id='remote-motion-via', y=70;
      const a=80, b=88, prior=view.camera(), motion=AtriumTheme.get().motion;
      AtriumTheme.set({motion:'full'},{persist:false});
      view.restoreCamera({...prior,cx:(a+b)/2,cy:y,scale:12,flipped:false});h.redraw();
      const next=()=>new Promise(requestAnimationFrame);await next();await next();
      const scale=canvas.width/canvas.clientWidth, at=x=>view.worldToScreen([x,y]).map(v=>Math.round(v*scale));
      const [ax,ay]=at(a), [bx]=at(b), pad=Math.ceil(16*scale);
      const left=Math.min(ax,bx)-pad, top=ay-pad, w=Math.abs(ax-bx)+pad*2+1, height=pad*2+1;
      const tile=document.createElement('canvas');tile.width=w;tile.height=height;
      const g=tile.getContext('2d',{willReadFrequently:true});
      function pixels(source) {
        g.clearRect(0,0,w,height);g.drawImage(source,left,top,w,height,0,0,w,height);
        return g.getImageData(0,0,w,height).data;
      }
      pixels(canvas);await next();pixels(canvas);
      function baseInk(data,x) {
        // Both points are on empty grid outside the example board. Sample the same frame's
        // background so a delayed high-resolution board repaint cannot change the reference.
        let count=0;
        for(let j=0;j<height;j++) for(let i=x-left-pad;i<=x-left+pad;i++) {
          const k=(j*w+i)*4;
          if(Math.abs(data[k]-data[0])+Math.abs(data[k+1]-data[1])+Math.abs(data[k+2]-data[2])>110) count++;
        }
        return count;
      }
      function arm(expected,interact) {
        const samples=[];let received,hit,clicked=false,ghostAfterEdit=0,destinationClear=false,canvasInteractive=true,transparentStart=false;
        const timeout=performance.now()+5000;
        window.testMotionFrames=(async()=>{
          while(performance.now()<timeout) {
            const time=await next(), item=h.doc().items.find(v=>v.id===id);
            if(received===undefined && (expected===null ? !!item : item?.x!==expected)) continue;
            if(received===undefined) {received=time;hit=h.hitAt([expected??b,y])?.id===id;}
            const surface=canvas.parentElement.querySelector('.collab-object-motion');
            if(surface) {
              const box=canvas.getBoundingClientRect(), [px,py]=view.worldToScreen([expected??b,y]);
              if(document.elementFromPoint(box.left+px,box.top+py)!==canvas)canvasInteractive=false;
              const data=pixels(surface);let ink=0,centroid=0;
              for(let k=3;k<data.length;k+=4) {
                const alpha=data[k];ink+=alpha;centroid+=alpha*((k-3)/4%w+left);
              }
              if(ink) {
                const progress=(centroid/ink-ax)/(bx-ax);
                const ringAlpha=data[(pad*w+Math.round(centroid/ink-left+5*scale))*4+3];
                samples.push({ink:Math.round(ink/255),ringAlpha,progress,at:Math.round(time-received)});
                if(expected===b && progress>.04 && progress<.94 && baseInk(pixels(canvas),bx)===0)destinationClear=true;
                if(clicked)ghostAfterEdit++;
              } else if(!samples.length)transparentStart=true;
              if(interact&&!clicked) {
                const target=h.hitAt([b,y]);
                if(target?.id===id){clicked=true;h.edit(()=>{target.x=b+4;});}
              }
            }
            if(time-received>300 && !surface) {
              const base=pixels(canvas);
              return {hit,samples,a:baseInk(base,ax),b:baseInk(base,bx),clicked,ghostAfterEdit,destinationClear,canvasInteractive,transparentStart};
            }
          }
          throw Error('The remote edit did not arrive and settle.');
        })();
      }
      window.testRemoteMotion={arm,restore(){view.restoreCamera(prior);h.redraw();AtriumTheme.set({motion},{persist:false});}};
      return true;""")

    def paint(action, target, interact=False):
        cdp.run(1, "testRemoteMotion.arm(%s,%s);return true;" % (json.dumps(target), json.dumps(interact)))
        cdp.run(0, """const h=AtriumNavHost, board=h.project().documents.find(d=>d.kind==='pcb'), id='remote-motion-via';
          h.edit(()=>{%s});return true;""" % action)
        return cdp.run(1, "return await testMotionFrames;")

    add = "board.items.push({id,kind:'via',x:80,y:70,diameter:1.6});"
    move = "board.items.find(i=>i.id===id).x=88;"
    remove = "board.items=board.items.filter(i=>i.id!==id);"
    try:
        added = paint(add, 80)
        faded_in = added["transparentStart"] or any(0<s["ringAlpha"]<255 for s in added["samples"])
        check(added["hit"] and added["a"] > 0 and bool(added["samples"]) and faded_in,
              "a remote addition fades in and is selectable at its real position")
        moved = paint(move, 88)
        progress = [s["progress"] for s in moved["samples"]]
        check(moved["hit"] and moved["canvasInteractive"] and moved["a"] == 0 and moved["b"] > 0 and moved["destinationClear"] and
              any(.06 < p < .94 for p in progress) and max(progress,default=0)-min(progress,default=0)>.2 and
              all(after >= before-.002 for before, after in zip(progress, progress[1:])),
              "moving geometry travels between positions while hit-testing uses the committed destination")
        deleted = paint(remove, None)
        ink = [s["ink"] for s in deleted["samples"]]
        check(not deleted["hit"] and deleted["b"] == 0 and len(ink) >= 2 and ink[-1] < max(ink),
              "a remote deletion leaves a fading, non-selectable image that clears")
        cdp.run(1, "AtriumTheme.set({motion:'reduce'},{persist:false});return true;")
        reduced_add = paint(add, 80)
        reduced_move = paint(move, 88)
        check(bool(reduced_add["samples"]) and all(abs(s["progress"])<.08 for s in reduced_add["samples"]) and
              not reduced_move["samples"] and reduced_move["hit"] and reduced_move["b"] > 0,
              "reduced motion retains the appearance cue and moves the object immediately")
        paint(remove, None)
        cdp.run(1, "AtriumTheme.set({motion:'off'},{persist:false});return true;")
        off_add = paint(add, 80)
        check(not off_add["samples"] and off_add["a"] > 0, "turning motion off paints incoming edits immediately")
        cdp.run(1, "AtriumTheme.set({motion:'full'},{persist:false});return true;")
        edited = paint(move, 88, interact=True)
        if edited["clicked"]:
            wait(cdp, 0, "AtriumNavHost.project().documents.some(d=>d.items.some(i=>i.id==='remote-motion-via'&&i.x===92))", "local revision during a remote glide")
        check(edited["clicked"] and not edited["ghostAfterEdit"], "editing the moving object locally clears its remote animation")
        paint(remove, None)
    finally:
        cdp.run(1, "testRemoteMotion.restore();return true;")


def live_demo(cdp, out, relay_port):
    print("Real-time co-editing through a local relay")
    for i in (0, 1):
        wait(cdp, i, "globalThis.AtriumNavHost && globalThis.AtriumLazy", "editor %d" % i)
        cdp.run(i, "await AtriumLazy.need('AtriumCollabLock'); await AtriumLazy.need(['AtriumCollabPresence', 'AtriumCollabCRDT', 'AtriumCollabTransport']); return true;")
    # Exercise delivery order with real Web Crypto. Delay the first decrypt in this idle editor.
    check(cdp.run(0, """
      const T=AtriumCollabTransport, roomKey=T.newRoomKey(), seen=[];
      let start, release, finish, ready, timer, decrypts=0;
      const first=new Promise(r=>start=r), hold=new Promise(r=>release=r), done=new Promise(r=>finish=r), bound=new Promise(r=>ready=r);
      const sub=crypto.subtle, decrypt=sub.decrypt.bind(sub);
      const t=await T.connect({url:'local',roomKey,onMessage(k){if(k==='hello'){ready();return;}seen.push(k);if(k==='cursor')finish();}});
      const editor=await T.connect({url:'local',roomKey});
      const timeout=new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('ordered frames timed out')),3000);});
      try {
        // Once the viewer has verified the editor's identity, delay its next decrypt.
        await new Promise(r=>setTimeout(r,50)); editor.send('hello',{}); await Promise.race([bound,timeout]);
        await new Promise(r=>setTimeout(r,50));
        sub.decrypt=async(...args)=>{if(++decrypts===1){start();await hold;}return decrypt(...args);};
        editor.send('ops',{}); await Promise.race([first,timeout]); editor.send('cursor',{});
        await new Promise(r=>setTimeout(r,30)); const queued=decrypts===1;
        release(); await Promise.race([done,timeout]); return queued && seen.join(',')==='ops,cursor';
      } finally { clearTimeout(timer); release(); delete sub.decrypt; editor.close(); t.close(); }
    """), "a cursor arriving during a slow edit cannot skip the edit")
    check(cdp.run(0, """
      const T = AtriumCollabTransport, roomKey = T.newRoomKey(), seen = [];
      let done, timer;
      const delivered = new Promise(r => done = r);
      const viewer = await T.connect({url: 'local', roomKey, onMessage(kind, body) {
        seen.push(kind === 'ops' ? 'edit' : body.at[0]); if (body.at?.[0] === 7) done();
      }});
      const editor = await T.connect({url: 'local', roomKey});
      const point = (x, flags) => editor.send('cursor', {doc: 'board', posOnly: true, at: [x,0], ...flags});
      try {
        await Promise.all([point(1), point(2), point(3, {turn:true}), point(4, {end:true}),
          editor.send('ops', {}), point(6), point(7, {end:true})]);
        await Promise.race([delivered, new Promise(r => timer = setTimeout(r, 3000))]);
        return seen.join(',') === '3,4,edit,7';
      } finally { clearTimeout(timer); editor.close(); viewer.close(); }
    """), "busy senders coalesce intermediate positions and keep turns, stops and edits in order")
    check(cdp.run(0, """
      const T = AtriumCollabTransport, roomKey = T.newRoomKey();
      let entered, release, calls = 0, delivered = 0, timer;
      const first = new Promise(r => entered = r), hold = new Promise(r => release = r);
      const viewer = await T.connect({url:'local', roomKey, onMessage() { delivered++; }});
      const editor = await T.connect({url:'local', roomKey});
      const sub = crypto.subtle, decrypt = sub.decrypt.bind(sub);
      sub.decrypt = async (...args) => { calls++; entered(); await hold; return decrypt(...args); };
      try {
        await Promise.all([editor.send('ops', {}), editor.send('ops', {})]);
        await Promise.race([first, new Promise(r => timer = setTimeout(r, 3000))]);
        await new Promise(r => setTimeout(r, 20));
        viewer.close(); release(); await new Promise(r => setTimeout(r, 30));
        return calls >= 1 && delivered === 0;
      } finally { clearTimeout(timer); release(); delete sub.decrypt; editor.close(); viewer.close(); }
    """), "leaving cancels pending reads and discards the frame already being decrypted")
    key = cdp.run(0, "return AtriumCollabTransport.newRoomKey();")
    url = "ws://127.0.0.1:%d" % relay_port
    check(cdp.run(0, "const b = document.querySelector('#collab-share'); b.click(); const d = document.querySelector('dialog.collab-dialog[open]'); d.close(); return b.textContent.trim() === 'Share' && !AtriumCollabLive.active();"), "Share opens the session controls without starting a session")
    host = cdp.run(0, "const b = AtriumNavHost.project().documents.find(d => d.kind === 'pcb'); AtriumNavHost.selectDocument(b.id); const s = await AtriumCollabLive.start(%s, %s); return {host: s.host, salt: s.salt};" % (json.dumps(url), json.dumps(key)))
    wait(cdp, 0, "document.querySelector('#collab-share').textContent.trim() === 'Sharing'", "host's sharing indicator")
    check(cdp.run(0, "return !document.querySelector('#collab-faces button');"), "Sharing is visible before the first guest arrives")
    cdp.run(0, """
      const t = AtriumCollabLive.session().t, send = t.send;
      let count = 0;
      t.send = (kind, body) => { if (kind === 'snapshot') count++; return send(kind, body); };
      window.finishSnapshotCount = () => { t.send = send; return count; };
      return true;
    """)
    cdp.run(1, """
      window.initialEditLayers=0;
      window.initialEditObserver=new MutationObserver(records=>{
        for(const r of records) for(const n of r.addedNodes) if(n.matches?.('.collab-object-motion'))initialEditLayers++;
      });
      initialEditObserver.observe(document.getElementById('editor-panes'),{childList:true,subtree:true});
      return !!await AtriumCollabLive.join(%s, %s, %s);""" % (json.dumps(url), json.dumps(key), json.dumps(host)))  # {host, salt}
    wait(cdp, 1, "AtriumCollabLive.session()?.r && AtriumNavHost.project().documents.some(d => d.kind === 'pcb')", "Bob receives the project", 30)
    same = cdp.run(1, "return AtriumNavHost.project().documents.map(d => d.id).join();") == cdp.run(0, "return AtriumNavHost.project().documents.map(d => d.id).join();")
    check(same, "Bob joined with Alice's project (snapshot over the relay, end-to-end encrypted)")
    check(cdp.run(1, "await new Promise(requestAnimationFrame);initialEditObserver.disconnect();return initialEditLayers===0;"),
          "opening the initial shared project paints it immediately")
    remote_object_demo(cdp)
    # Alice places a via; Bob sees it.
    cdp.run(0, "const d = AtriumNavHost.doc(); AtriumNavHost.edit(() => d.items.push({id: 'live-via', kind: 'via', x: 12, y: 8, diameter: .8})); return true;")
    wait(cdp, 1, "AtriumNavHost.project().documents.some(d => d.items.some(i => i.id === 'live-via'))", "Alice's via on Bob's side")
    check(True, "an edit reaches the other window live")
    check(cdp.run(0, "return finishSnapshotCount();") == 1, "the first guest receives one project snapshot and subsequent edits")
    snapshot_requests(cdp, url, key)
    # Bob moves to the board and edits a different object; concurrent edits converge.
    cdp.run(1, "const b = AtriumNavHost.project().documents.find(d => d.kind === 'pcb'); AtriumNavHost.selectDocument(b.id); AtriumNavHost.edit(() => b.items.push({id: 'bob-via', kind: 'via', x: 16, y: 8, diameter: .8})); return true;")
    cdp.run(0, "const d = AtriumNavHost.doc(); const v = d.items.find(i => i.id === 'live-via'); AtriumNavHost.edit(() => { v.x = 13; }); return true;")
    wait(cdp, 0, "AtriumNavHost.project().documents.some(d => d.items.some(i => i.id === 'bob-via'))", "Bob's via on Alice's side")
    wait(cdp, 1, "AtriumNavHost.project().documents.some(d => d.items.some(i => i.id === 'live-via' && i.x === 13))", "Alice's move on Bob's side")
    canon = "return AtriumCollabCRDT.canon(AtriumCollabLive.session().r.project());"
    time.sleep(.5)
    check(cdp.run(0, canon) == cdp.run(1, canon), "both replicas converge")
    # Per-user undo: Bob's undo removes Bob's via only.
    cdp.run(1, "AtriumNavHost.act('undo'); return true;")
    wait(cdp, 0, "!AtriumNavHost.project().documents.some(d => d.items.some(i => i.id === 'bob-via'))", "Bob's undo on Alice's side")
    check(cdp.run(0, "return AtriumNavHost.project().documents.some(d => d.items.some(i => i.id === 'live-via' && i.x === 13));"), "per-user undo: Bob's undo leaves Alice's work")
    # Alice selects the via and drags it: Bob sees her cursor, selection and activity, and a soft lock.
    cdp.run(0, """
      const h = AtriumNavHost, v = h.doc().items.find(i => i.id === 'live-via');
      h.centerOn([v.x, v.y]);
      h.beginStickyMove(v, [v.x, v.y]); h.select([v.id], v.id);
      const canvas = h.canvas(), box = canvas.getBoundingClientRect(), [x,y] = h.view().worldToScreen([v.x + 1.5, v.y + 1]);
      canvas.dispatchEvent(new PointerEvent('pointermove', {bubbles: true, clientX: box.left + x, clientY: box.top + y}));
      return true;""")
    wait(cdp, 1, "AtriumCollabLive.peers().some(p => p.at && p.act.startsWith('moving') && p.lock?.includes('live-via'))", "Bob sees Alice's activity")
    check(True, "Bob sees Alice's cursor, selection and “moving” activity")
    cdp.run(1, "const v = AtriumNavHost.project().documents.flatMap(d => d.items).find(i => i.id === 'live-via'); AtriumNavHost.edit(() => { v.x = 30; }); AtriumCollabLive.session(); return true;")
    time.sleep(.3)
    check(cdp.run(1, "return AtriumNavHost.project().documents.flatMap(d => d.items).find(i => i.id === 'live-via').x;") == 13, "soft lock: Bob's change to the object Alice is dragging is undone")
    cdp.run(1, "const v = AtriumNavHost.project().documents.flatMap(d => d.items).find(i => i.id === 'live-via'); AtriumNavHost.centerOn([v.x, v.y]); AtriumNavHost.redraw(); return true;")
    cdp.run(0, "AtriumNavHost.redraw(); return true;")
    time.sleep(.8)
    cdp.shot(out / "collab-live.png")
    cdp.run(0, "AtriumNavHost.act('select'); AtriumNavHost.select([],null); return true;")
    simultaneous_drag(cdp)
    people_demo(cdp, out, url, key)
    waypoint_demo(cdp)
    overlapping_placements(cdp)
    # Save once, then make the next change entirely on the guest. The normal Save action
    # must still write that edit in the host's existing file.
    assert cdp.run(0, "const h=AtriumNavHost; await h.saveProject({as:true}); return !h.isDirty() && !!AtriumHost.projectPath;")
    cdp.run(1, """const h=AtriumNavHost; h.edit(()=>h.doc().items.push({id:'guest-disk-via',kind:'via',x:3,y:4,diameter:.8})); return true;""")
    wait(cdp, 0, "AtriumNavHost.isDirty() && AtriumNavHost.doc().items.some(v=>v.id==='guest-disk-via')", "a guest edit marks the host file as unsaved")
    check(cdp.run(0, """await AtriumNavHost.saveProject(); const files=await AtriumHost.openRecent();
      const saved=JSON.parse(await files[0].text());
      return !AtriumNavHost.isDirty() && saved.documents.some(d=>d.items.some(v=>v.id==='guest-disk-via'));"""),
          "Save writes an edit made entirely by the guest into the host's existing file")
    # Follow mode.
    cdp.run(1, "AtriumCollabLive.follow(AtriumCollabLive.peers()[0].id); return true;")
    check(cdp.run(1, "return AtriumCollabLive.session().followed !== null;"), "follow mode")
    errors = [cdp.run(i, "return window.__errors;") for i in (0, 1)]
    check(not any(errors), "no page errors (%s)" % errors)
    for i in (0, 1):
        cdp.run(i, "await AtriumCollabLive.leave(); return true;")
    wait(cdp, 0, "document.querySelector('#collab-share').textContent.trim() === 'Share' && !document.querySelector('#collab-faces button, .collab-cursors')", "session cleanup")
    check(True, "leaving clears live avatars, cursors and sharing status")
    session_boundaries(cdp, url)
    shared_versions(cdp, url)


def shared_versions(cdp, url):
    prepare_editors(cdp)
    cdp.run(0, """const h=AtriumNavHost; window.testForeign=await (await AtriumLazy.need('AtriumHistoryPanel')).checkpoint();
      await h.replaceProject(structuredClone(h.project()),{force:true,copy:true,dirty:false});return true;""")
    args = json.dumps(url) + ", " + json.dumps(cdp.run(0, "return AtriumCollabTransport.newRoomKey();"))
    host = cdp.run(0, "const s = await AtriumCollabLive.start(" + args + "); return {host: s.host, salt: s.salt};")
    cdp.run(1, "return !!await AtriumCollabLive.join(" + args + ", " + json.dumps(host) + ");")
    wait(cdp, 1, "AtriumCollabLive.session()?.r", "guest receives versioned design")
    cdp.run(1, "testAddVia('retained-guest-object');return true;")
    wait(cdp, 0, "testHasVia('retained-guest-object')", "guest-created object in checkpoint")
    check(cdp.run(0, """try {await AtriumCollabLive.prepareRestore({id:testForeign.id,snapshot:testForeign});return false;}
      catch(e){return /another project/.test(e.message);}"""), "a private project with matching document IDs cannot be restored into the session")
    for i in (0, 1):
        cdp.run(i, """document.querySelector('#collab-share').click();
          testClick(document.querySelector('dialog.collab-dialog[open]'),'Version history');return true;""")
        wait(cdp, i, "document.querySelector('.hist-timeline button')", "session version history")
        cdp.run(i, "testClick(document.querySelector('.hist-timeline'),'Save checkpoint');return true;")
        wait(cdp, i, "AtriumHistoryPanel.timeline()?.some(e=>e.snapshot?.reason==='checkpoint')", "local checkpoint")
        cdp.run(i, """window.testVersion=AtriumHistoryPanel.timeline().find(e=>e.snapshot?.reason==='checkpoint');
          window.testVersionRow=()=>[...document.querySelectorAll('.hist-time')].find(row=>row.querySelector('.hist-label')?.textContent==='Checkpoint');return true;""")
    check(cdp.run(1, """try {await AtriumCollabLive.prepareRestore(testVersion);return false;} catch {}
        return testVersionRow().textContent.includes('Restore copy') && !testVersionRow().textContent.includes('Review restore');"""),
          "guests can restore a private copy and cannot publish a shared restore")
    cdp.run(0, "window.testStaleReview=await AtriumCollabLive.prepareRestore(testVersion);return true;")
    cdp.run(1, "testAddVia('guest-after-checkpoint');return true;")
    wait(cdp, 0, "testHasVia('guest-after-checkpoint')", "guest edit after the host's checkpoint")
    check(cdp.run(0, """try {await testStaleReview.apply();return false;} catch(e) {return /changed/.test(e.message) && testHasVia('guest-after-checkpoint');}"""),
          "a collaborator's edit invalidates an older restore review")
    cdp.run(1, """const h=AtriumNavHost,v=h.doc().items.find(i=>i.id==='guest-after-checkpoint');
      h.beginStickyMove(v,[v.x,v.y]);return true;""")
    check(cdp.run(0, """try {const review=await AtriumCollabLive.prepareRestore(testVersion);await review.apply();return false;}
      catch(e){return /editing/.test(e.message) && testHasVia('guest-after-checkpoint');}"""), "a guest's unfinished drag stops the restore")
    cdp.run(1, "AtriumNavHost.act('select');return true;")
    cdp.run(0, "testClick(testVersionRow(),'Review restore…');return true;")
    wait(cdp, 0, "globalThis.AtriumDiffView?.session()?.reviewButton?.disabled===false", "completed visual comparison")
    check(cdp.run(0, """const {a,b}=AtriumDiffView.session(), has=side=>side.project.documents.some(d=>d.items.some(i=>i.id==='guest-after-checkpoint'));
        return has(b) && !has(a);"""), "Review Changes compares the shared project to the exact proposed version")
    confirm = """document.querySelector('dialog[aria-label="Restore for everyone?"][open]')"""
    cdp.run(0, "AtriumDiffView.session().reviewButton.click();testClick(" + confirm + ",'Cancel');return true;")
    check(cdp.run(1, "return testHasVia('guest-after-checkpoint');"), "canceling the restore keeps the guest's work")
    cdp.run(0, "AtriumDiffView.session().reviewButton.click();testClick(" + confirm + ",'Restore for everyone');return true;")
    wait(cdp, 1, "!testHasVia('guest-after-checkpoint') && !document.querySelector('dialog[aria-label=\"Restoring shared version\"][open]')", "restored shared project")
    wait(cdp, 0, "!AtriumDiffView.session()", "completed host restore")
    check(cdp.run(0, """const m=(await AtriumAutosave.list()).find(m=>m.reason==='before-restore');
          const p=JSON.parse((await AtriumAutosave.read(m.id)).text);
          return AtriumNavHost.isDirty() && p.documents.some(d=>d.items.some(i=>i.id==='guest-after-checkpoint')) &&
            (await AtriumAutosave.read(testVersion.id)).meta.reason==='checkpoint';"""),
          "shared rollback keeps both the target and a readable checkpoint containing the guest's work")
    check(cdp.run(1, """const s=AtriumCollabLive.session();AtriumNavHost.act('undo');AtriumNavHost.act('undo');AtriumNavHost.act('redo');
      return !s.r.canUndo() && !s.r.canRedo() && testHasVia('retained-guest-object') && !testHasVia('guest-after-checkpoint');"""),
          "pre-restore personal Undo and Redo cannot remove a guest-created object kept by the host")
    shared_large_reconnect(cdp)
    cdp.run(1, "testClick(testVersionRow(),'Restore copy');return true;")
    confirm_copy = """[...document.querySelectorAll('dialog[open]')].find(d=>/^(Replace current project\\?|Save changes to .* before closing\\?)$/.test(d.querySelector('h2')?.textContent))"""
    wait(cdp, 1, confirm_copy, "confirm leaving the room to open a private copy")
    cdp.run(1, "testClick(" + confirm_copy + ",['Replace project','Don\u2019t Save']);return true;")
    wait(cdp, 1, "!AtriumCollabLive.active() && AtriumNavHost.project().name.endsWith(' (recovered)')", "private copy")
    check(cdp.run(0, "return AtriumCollabLive.active() && !AtriumNavHost.project().name.endsWith(' (recovered)');"),
          "opening a private copy leaves the host's shared project intact")
    for i in (0, 1):
        cdp.run(i, "AtriumHistoryPanel.toggle(false);AtriumCollabLive.leave();return true;")


def shared_large_reconnect(cdp):
    # Nine 1 MB project fields force several ordinary operation batches and transport pages.
    cdp.run(0, """const h=AtriumNavHost,hp=h.project();h.edit(()=>{for(let i=0;i<9;i++)hp['historyTest'+i]='x'.repeat(1000000);});
      AtriumCollabLive.flush();window.testLargeVersion=await (await AtriumLazy.need('AtriumHistoryPanel')).checkpoint();return true;""")
    wait(cdp, 1, "AtriumNavHost.project().historyTest8?.length===1000000", "large shared version", 45)
    cdp.run(0, """const h=AtriumNavHost;h.edit(()=>{for(let i=0;i<9;i++)delete h.project()['historyTest'+i];});AtriumCollabLive.flush();return true;""")
    wait(cdp, 1, "AtriumNavHost.project().historyTest0===undefined", "large fields removed")
    cdp.run(0, """const s=AtriumCollabLive.session(), send=s.t.send;
      window.testResumeVersion=()=>{s.t.send=send;};window.testDroppedPages=0;
      s.t.send=(kind,b)=>{if(kind==='ops'&&b.page>0){testDroppedPages++;return Promise.resolve();}
        return send(kind,b);};
      const review=await AtriumCollabLive.prepareRestore({id:testLargeVersion.id,snapshot:testLargeVersion});
      await review.apply();return true;""")
    wait(cdp, 1, "AtriumCollabLive.session()?.incomingVersions?.size && !AtriumCollabLive.session().restoreHold", "interrupted restore transfer", 40)
    check(cdp.run(0, "return testDroppedPages>0;") and cdp.run(1, """return !Object.keys(AtriumNavHost.project()).some(k=>k.startsWith('historyTest')) &&
         !Object.keys(AtriumCollabLive.session().r.project()).some(k=>k.startsWith('historyTest'));"""),
          "losing later pages of a large restore never partially applies the shared design")
    cdp.run(1, "testAddVia('local-after-transfer-loss');AtriumCollabLive.flush();return true;")
    # Advance the operation log beyond its retention window, forcing full snapshot recovery.
    cdp.run(0, """const s=AtriumCollabLive.session(),h=AtriumNavHost,base=s.r.stats().clock;
      const ops=Array.from({length:4200},(_,i)=>({t:'meta',k:'historyCounter',v:i,ts:{r:'sync-test',c:base+i+1},n:i+1}));
      const {touched}=s.r.receive({ops});s.applying=true;try{h.derive(()=>s.r.patch(h.project(),touched));}finally{s.applying=false;}
      s.r.trim();testResumeVersion();return true;""")
    cdp.run(1, """const s=AtriumCollabLive.session();await s.t.send('hello',{name:'Bob',has:true,vv:s.r.vv(),personalUndo:2,sharedRestore:'guest',joinRound:++s.joinRound});return true;""")
    wait(cdp, 1, "AtriumNavHost.project().historyTest8?.length===1000000 && AtriumNavHost.project().historyCounter===4199", "paged snapshot catch-up", 55)
    check(cdp.run(1, """const p=AtriumNavHost.project();return Array.from({length:9},(_,i)=>p['historyTest'+i]?.length===1000000).every(Boolean) &&
      testHasVia('local-after-transfer-loss') && AtriumCollabLive.session().r.canUndo();"""),
          "snapshot catch-up installs the whole large restore and preserves the guest's newer edit and personal Undo")
    cdp.run(0, """const s=AtriumCollabLive.session(),send=s.t.send;window.testLegacyCatchup=0;
      s.t.send=(kind,b)=>{if(kind==='snapshot'||kind==='ops')testLegacyCatchup++;return send(kind,b);};return true;""")
    cdp.run(1, "const s=AtriumCollabLive.session();await s.t.send('hello',{name:'Bob',has:true,vv:{}});return true;")
    wait(cdp, 0, "AtriumCollabLive.peers().some(p=>p.rejoinNotice)", "older participant needs to rejoin")
    check(cdp.run(0, "return testLegacyCatchup===0;"), "an older editor gets a rejoin notice when its history is too far behind")


def prepare_editors(cdp):
    for i in (0, 1):
        wait(cdp, i, "globalThis.AtriumNavHost && globalThis.AtriumLazy", "editor %d" % i)
        cdp.run(i, """
          await AtriumLazy.need(['AtriumCollabPresence','AtriumCollabCRDT','AtriumCollabTransport']);
          await AtriumNavHost.replaceProject(AtriumParts.example(), {force:true, copy:true, dirty:false});
          window.testClick = (d, label) => [...d.querySelectorAll('button')].find(b => [].concat(label).includes(b.textContent)).click();
          window.testAddVia = id => { const h=AtriumNavHost, b=h.project().documents.find(d=>d.kind==='pcb');
            h.edit(()=>b.items.push({id,kind:'via',x:8,y:12,diameter:.8})); };
          window.testHasVia = id => AtriumNavHost.project().documents.some(d=>d.items.some(i=>i.id===id));
          return true;""")


def session_boundaries(cdp, url):
    """Use two editors to check when an existing local design can enter or leave a room."""
    prepare_editors(cdp)
    key = cdp.run(0, "return AtriumCollabTransport.newRoomKey();")
    # A room key typed by hand on both sides (Share › Use a room key instead): no session salt.
    args = json.dumps(url) + ", " + json.dumps(key) + ", " + json.dumps({"manual": True})
    cdp.run(1, "return !!await AtriumCollabLive.join(" + args + ");")
    wait(cdp, 1, "document.querySelector('#collab-share').textContent.trim()==='Waiting…'", "guest waits for the shared project")
    check(cdp.run(1, "return !document.querySelector('#collab-share').classList.contains('is-sharing') && !AtriumCollabLive.session().r;"),
          "joining an empty room keeps the local project private")
    cdp.run(1, "testAddVia('private-while-waiting'); return true;")
    cdp.run(0, "return !!await AtriumCollabLive.start(" + args + ");")
    wait(cdp, 1, "!AtriumCollabLive.active()", "late edits cancel project adoption")
    check(cdp.run(1, "return testHasVia('private-while-waiting') && AtriumNavHost.isDirty();") and
          not cdp.run(0, "return testHasVia('private-while-waiting');"), "a guest keeps edits made while waiting")

    def join_dialog():
        cdp.run(1, """
          document.querySelector('#collab-share').click();
          const d=document.querySelector('dialog.collab-dialog[open]');
          d.querySelector('input[type=url]').value=%s;
          d.querySelector('input[placeholder="Room key"]').value=%s;
          testClick(d,'Join with This Key');return true;""" % (json.dumps(url), json.dumps(key)))
    save_dialog = r"[...document.querySelectorAll('dialog[open]')].find(d=>/^Save changes to .+ before joining\?$/.test(d.querySelector('h2')?.textContent))"
    join_dialog()
    wait(cdp, 1, save_dialog, "offer to save the dirty guest project")
    cdp.run(1, "testClick(" + save_dialog + ",'Cancel');return true;")
    wait(cdp, 1, "!document.querySelector('dialog.collab-dialog[open]')", "return to editing")
    check(cdp.run(1, "return !AtriumCollabLive.active() && testHasVia('private-while-waiting');"), "declining to save keeps the guest's project")
    join_dialog()
    cdp.run(1, "testClick(" + save_dialog + ",'Save and Join');return true;")
    wait(cdp, 1, "AtriumCollabLive.session()?.r", "saved guest joins")
    check(cdp.run(1, """const [f]=await AtriumHost.openRecent();const p=JSON.parse(await f.text());
          return p.documents.some(d=>d.items.some(i=>i.id==='private-while-waiting')) && !testHasVia('private-while-waiting');"""),
          "Save and Join preserves the local file before opening the shared copy")
    cdp.run(0, "testAddVia('same-project-undo');return true;")
    wait(cdp, 1, "testHasVia('same-project-undo')", "ordinary shared edit")
    cdp.run(0, "AtriumNavHost.act('undo');return true;")
    wait(cdp, 1, "!testHasVia('same-project-undo') && AtriumCollabLive.active()", "same-project undo stays in the session")
    check(True, "same-project edits and undo remain collaborative")

    # File > Open uses a deliberate copy with identical document IDs.
    open_file = """
      const p=structuredClone(AtriumNavHost.project());p.name='Private file';
      const dt=new DataTransfer();dt.items.add(new File([JSON.stringify(p)],'private.waffle'));
      const input=document.querySelector('#file-input');input.files=dt.files;input.dispatchEvent(new Event('change'));return true;"""
    cdp.run(0, open_file)
    replace_dialog = "document.querySelector('dialog[open]:not(.collab-dialog)')"
    wait(cdp, 0, replace_dialog, "unsaved host can cancel opening the file")
    cdp.run(0, "testClick(" + replace_dialog + ",'Cancel');return true;")
    wait(cdp, 0, "!document.querySelector('.import-cancel')", "cancelled file open finishes")
    check(cdp.run(0, "return AtriumCollabLive.active();"), "canceling File > Open preserves the original session")
    cdp.run(0, open_file)
    wait(cdp, 0, replace_dialog, "unsaved host can replace its file")
    cdp.run(0, "testClick(" + replace_dialog + ",['Replace project','Don\u2019t Save']);return true;")
    wait(cdp, 0, "AtriumNavHost.project().name==='Private file' && !AtriumCollabLive.active()", "opening a file ends hosting")
    wait(cdp, 1, "AtriumCollabLive.peers().length===0", "guest observes host leave")
    check(cdp.run(1, "return AtriumNavHost.project().name!=='Private file';"), "a different file with the same document IDs stays private")

    cdp.run(1, """testAddVia('unsaved-guest-work');AtriumNavHost.act('new');
      const d=[...document.querySelectorAll('dialog[open]')].find(d=>d.querySelector('h2')?.textContent==='New project');
      d.querySelector('input').value='Guest private project';
      d.querySelector('form').requestSubmit();return true;""")
    confirm_new = "[...document.querySelectorAll('dialog[open]')].find(d=>/^(Replace current project\\?|Save changes to .* before closing\\?)$/.test(d.querySelector('h2')?.textContent))"
    wait(cdp, 1, confirm_new, "unsaved guest can choose whether to create a new project")
    check(cdp.run(1, "return AtriumCollabLive.active() && testHasVia('unsaved-guest-work');"),
          "File > New keeps the guest's session and local edits until confirmation")
    cdp.run(1, "testClick(" + confirm_new + ",['Replace project','Don\u2019t Save']);return true;")
    wait(cdp, 1, "AtriumNavHost.project().name==='Guest private project' && !AtriumCollabLive.active()", "guest leaves when creating a new project")
    check(True, "File > New disconnects a guest before replacing its shared copy")
    cdp.run(0, "return !!await AtriumCollabLive.start(" + args + ");")
    cdp.run(0, "const p=AtriumParts.example(); return await AtriumNavHost.replaceProject(p,{force:true,copy:true,dirty:true});")
    check(cdp.run(0, "return !AtriumCollabLive.active() && AtriumNavHost.isDirty();"), "restoring an independent copy ends its predecessor's session")

    # A drag may have moved the on-screen item before creating an undo step or marking the file dirty.
    cdp.run(1, """const p=AtriumParts.example(), b=p.documents.find(d=>d.kind==='pcb');
      b.items.push({id:'waiting-drag',kind:'via',x:8,y:8,diameter:.8});
      return await AtriumNavHost.replaceProject(p,{force:true,copy:true,dirty:false});""")
    cdp.run(1, "return !!await AtriumCollabLive.join(" + args + ");")
    wait(cdp, 1, "AtriumCollabLive.session()?.connection==='open'", "guest ready to start dragging")
    cdp.run(1, "const h=AtriumNavHost,item=h.doc().items.find(i=>i.id==='waiting-drag');h.beginStickyMove(item,[item.x,item.y]);return true;")
    cdp.run(0, "return !!await AtriumCollabLive.start(" + args + ");")
    wait(cdp, 1, "!AtriumCollabLive.active()", "keep the guest's active tool")
    check(cdp.run(1, "return !!AtriumNavHost.drag()?.sticky && !AtriumNavHost.isDirty() && testHasVia('waiting-drag');"), "an uncommitted drag survives late project delivery")
    cdp.run(0, "AtriumCollabLive.leave();return true;")

    # Restore an older private file from a history branch, even though both files share document IDs.
    cdp.run(0, """const h=AtriumNavHost, p=structuredClone(h.project());p.name='Private history file';
      await h.replaceProject(p,{force:true,copy:true,dirty:false});h.act('undo');testAddVia('public-history-edit');
      window.testPrivateTip=AtriumUndoStore.branches().at(-1).trees.at(-1);
      return true;""")
    host = cdp.run(0, "const s = await AtriumCollabLive.start(" + args + "); return {host: s.host, salt: s.salt};")
    cdp.run(1, "await AtriumNavHost.replaceProject(AtriumParts.example(),{force:true,copy:true,dirty:false});return !!await AtriumCollabLive.join(" + json.dumps(url) + ", " + json.dumps(key) + ", " + json.dumps(host) + ");")
    wait(cdp, 1, "AtriumCollabLive.session()?.r && testHasVia('public-history-edit')", "guest sees only the shared branch")
    cdp.run(0, "AtriumNavHost.historyGo(1,testPrivateTip);return true;")
    wait(cdp, 0, "AtriumNavHost.project().name==='Private history file' && !AtriumCollabLive.active()", "history switched away from the shared scope")
    wait(cdp, 1, "AtriumCollabLive.peers().length===0", "history switch disconnects")
    check(cdp.run(1, "return AtriumNavHost.project().name!=='Private history file' && testHasVia('public-history-edit');"), "a private history branch never reaches the guest")
    cdp.run(1, "AtriumPrefs.open('collaboration');return true;")
    wait(cdp, 1, "document.getElementById('prf-collab-realtime')", "live preference")
    cdp.run(1, "const box=document.getElementById('prf-collab-realtime');box.click();box.closest('dialog').close();return true;")
    check(cdp.run(1, "return !AtriumCollabLive.active() && AtriumPref.get('collab.realtime')===false;"), "disabling live sessions in Preferences immediately leaves")
    cdp.run(1, "AtriumPref.set('collab.realtime',false);return true;")

def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--out", default=str(ROOT / "docs" / "images"))
    parser.add_argument("--only", choices=["lock", "live", "history"])
    args = parser.parse_args()
    out = Path(args.out)
    out.mkdir(parents=True, exist_ok=True)
    sys.path.insert(0, str(ROOT / "collab" / "relay"))
    import waffle_relay
    with tempfile.TemporaryDirectory() as tmp:
        tmp = Path(tmp)
        relay_port = free_port()
        threading.Thread(target=lambda: asyncio.run(waffle_relay.run("127.0.0.1", relay_port, quiet=True)), daemon=True).start()
        for demo in (["lock", "live"] if not args.only else [args.only]):
            folder = tmp / demo
            folder.mkdir()
            shared = Shared(folder)
            shared.ports = [free_port(), free_port()]
            servers = [serve(shared, p) for p in shared.ports]
            profile = tmp / ("profile-" + demo)
            proc = subprocess.Popen([chrome(), "--headless=new", "--no-first-run", "--no-default-browser-check", "--remote-debugging-port=0",
                                     "--user-data-dir=" + str(profile), "--window-size=2560,900", "--hide-scrollbars", "--force-device-scale-factor=1",
                                     "--use-angle=swiftshader", "--enable-unsafe-swiftshader", "about:blank"], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
            try:
                port_file = profile / "DevToolsActivePort"
                for _ in range(100):
                    if port_file.exists() and port_file.read_text().strip():
                        break
                    time.sleep(.1)
                port = int(port_file.read_text().split()[0])
                pages = json.loads(urllib.request.urlopen("http://127.0.0.1:%d/json/list" % port).read())
                cdp = CDP([p for p in pages if p["type"] == "page"][0]["webSocketDebuggerUrl"])
                cdp.call("Page.enable")
                cdp.call("Page.navigate", url="http://127.0.0.1:%d/demo.html" % shared.ports[0])
                time.sleep(2.5)
                if demo == "history":
                    shared_versions(cdp, "ws://127.0.0.1:%d" % relay_port)
                elif demo == "lock":
                    lock_demo(cdp, out)
                else:
                    live_demo(cdp, out, relay_port)
            finally:
                proc.terminate()
                proc.wait(timeout=10)
                for s in servers:
                    s.shutdown()
    failed = [w for ok, w in CHECKS if not ok]
    print("collab-demo: %d checks, %d failed" % (len(CHECKS), len(failed)))
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
