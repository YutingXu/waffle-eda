#!/usr/bin/env python3
"""Drive the installed GTK folder editor on its normal Open and Ctrl+S paths."""

import base64
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import shutil
import sys
import tempfile
import threading
import time
import traceback

from package import GLib, Probe, wait_for, xdo


PNG = base64.b64decode("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jZFcAAAAASUVORK5CYII=")


def lines(*rows):
    def record(row):
        order = ["kind", "formatVersion", "id"]
        keys = [k for k in order if k in row] + sorted(set(row) - set(order))
        return json.dumps({key: row[key] for key in keys}, ensure_ascii=False, separators=(",", ":")) + "\n"
    return "".join(map(record, rows)).encode("utf-8")


class FolderProbe(Probe):
    def open_folder(self, window, path):
        self.js(window, "return window.dispatchEvent(new CustomEvent('atrium-command',{detail:'open'}));")
        self.choose_file(window, path)
        return wait_for("folder editor to load the active sheet", lambda: next(
            (w for w in self.on_gtk(self.editors)
             if self.js(w, "return globalThis.AtriumNavHost?.folderProject?.()?.manifestPath === 'Sensor.waffle';")), None))

    def save(self, window, condition):
        self.focus(window)
        self.on_gtk(lambda: window.get_child().grab_focus())
        wait_for("keyboard focus in the editor", lambda: self.on_gtk(lambda: window.get_child().has_focus()))
        center = wait_for("displayed canvas", lambda: self.js(window,
            "const r=AtriumNavHost.canvas().getBoundingClientRect();"
            "return r.width&&r.height?[r.left+r.width/2,r.top+r.height/2]:null;"))
        self.click(window, window.get_child, *center)
        wait_for("the rendered canvas to accept keyboard focus", lambda: self.js(window,
            "const canvas=AtriumNavHost.canvas(); canvas.focus(); return document.activeElement===canvas;"))
        previous = self.js(window, "return window.saveKeys;")
        xdo("key", "--clearmodifiers", "ctrl+s")
        wait_for("Ctrl+S key in the editor", lambda: self.js(window, "return window.saveKeys;") == previous + 1)
        wait_for("the committed working files", condition)
        wait_for("the saved editor acknowledgement", lambda: self.js(window, "return !AtriumNavHost.isDirty();"))

    def run(self):
        root = self.work / "Sensor"
        root.mkdir()
        sheets = root / "Sheets"
        sheets.mkdir()
        manifest, active, cold = root / "Sensor.waffle", sheets / "Power.wsch", root / "Board.wpcb"
        manifest.write_bytes(lines(
            {"kind": "project", "formatVersion": "2.0", "id": "p1", "name": "Sensor", "entryDocument": "s1"},
            {"kind": "document", "id": "b1", "docKind": "pcb", "name": "Board", "path": "Board.wpcb"},
            {"kind": "document", "id": "s1", "docKind": "schematic", "name": "Power", "path": "Sheets/Power.wsch"}))
        active.write_bytes(lines(
            {"kind": "schematic", "id": "s1", "formatVersion": "2.0"},
            {"kind": "netlabel", "id": "n1", "at": [1270000, 2540000], "text": "SENSE"}))
        cold.write_bytes(lines({"kind": "pcb", "id": "b1", "formatVersion": "2.0"}))
        # A real valid image is picked from a private folder using the shipping native action.
        picture = self.work / "photo.png"
        picture.write_bytes(PNG)
        digest = hashlib.sha256(PNG).hexdigest()
        installed = root / "assets" / digest
        try:
            window = wait_for("installed editor", lambda: self.on_gtk(lambda: next(
                (w for w in self.editors() if w.get_child().get_uri() and not w.get_child().is_loading()), None)))
            wait_for("editor ready", lambda: self.js(window, "return !!globalThis.AtriumNavHost;"))
            self.js(window, "globalThis.AtriumStartPage?.close(); return true;")
            window = self.open_folder(window, manifest)
            self.js(window, "window.folderEvents=[]; window.addEventListener('folderChanged',"
                            "e=>window.folderEvents.push(e.detail)); window.saveKeys=0;"
                            "window.addEventListener('keydown',e=>{if(e.ctrlKey && e.key.toLowerCase()==='s')++window.saveKeys;},true);"
                            "return true;")
            initial = self.js(window, "return {id:AtriumNavHost.currentId(), text:AtriumNavHost.doc().items[0].text, "
                                     "trace:AtriumNavHost.folderProject().metrics().reads};")
            assert initial["id"] == "s1" and initial["text"] == "SENSE"
            assert all(row["path"] != cold.name for row in initial["trace"] if row["beforePresentation"])
            print("PASS normal GTK Open presents the selected schematic before reading the inactive PCB", flush=True)
            unchanged = (manifest.read_bytes(), cold.read_bytes())
            self.js(window, "AtriumNavHost.edit(()=>AtriumNavHost.doc().items[0].text='LOCAL'); return true;")
            self.save(window, lambda: b'"LOCAL"' in active.read_bytes())
            assert unchanged == (manifest.read_bytes(), cold.read_bytes())
            wait_for("settled journal", lambda: not (root / ".waffle/journal/active").exists())
            print("PASS Ctrl+S durably changes only the active document", flush=True)

            active.write_bytes(active.read_bytes().replace(b'"LOCAL"', b'"EXT01"'))
            wait_for("clean external reload", lambda: self.js(window, "return AtriumNavHost.doc().items[0].text === 'EXT01';"))
            assert self.js(window, "return folderEvents.some(e=>e.paths.includes('Sheets/Power.wsch'));")
            print("PASS a kernel notification reloads a clean external edit within its containing directory", flush=True)

            self.begin(window, """(async ()=>{
                const read=await AtriumNavHost.folderProject().readLease();
                const grant=read.grant; await read.release();
                window.folderGrant=grant;
                return AtriumHost.folderPickAsset({grant,ownerId:'s1',mediaTypes:['image/png']});
            })()""")
            self.choose_file(window, picture)
            raw = self.result(window)
            assert "value" in raw, raw
            picked = raw["value"]
            assert "sourceToken" in picked and "path" not in picked
            self.begin(window, "AtriumHost.folderStageAsset({..."+json.dumps(picked)+",grant:window.folderGrant,ownerId:'s1'})")
            raw = self.result(window)
            assert "value" in raw, raw
            payload = raw["value"]
            assert payload["assetRef"]["sha256"] == digest and not installed.exists()
            self.js(window, """
                const req = """+json.dumps(payload)+""";
                const session=AtriumNavHost.folderProject(), h=AtriumNavHost;
                const asset=session.stageAttachment(req);
                h.edit(()=>h.doc().items.push({kind:'image',id:'image1',asset,x:5,y:5,w:4,h:4,
                    caption:'Synthetic attachment',pixelWidth:1,pixelHeight:1,name:'photo.png'}));
                return true;
            """)
            self.save(window, lambda: installed.is_file() and digest.encode("ascii") in active.read_bytes())
            assert installed.read_bytes() == PNG and unchanged == (manifest.read_bytes(), cold.read_bytes())
            print("PASS first attachment Ctrl+S installs exact picked bytes and its owner without rewriting the manifest", flush=True)

            self.js(window, "AtriumNavHost.edit(()=>AtriumNavHost.doc().items.find(o=>o.id==='n1').text='DRAFT'); return true;")
            active.write_bytes(active.read_bytes().replace(b'"EXT01"', b'"EXT02"'))
            wait_for("external conflict while the owner is dirty", lambda: self.js(window,
                "return AtriumNavHost.folderProject().conflicts.size > 0;"))
            assert self.js(window, "return AtriumNavHost.doc().items.find(o=>o.id==='n1').text === 'DRAFT';")
            assert b'"EXT02"' in active.read_bytes()
            print("PASS dirty external conflict preserves the local draft and outside changes", flush=True)

            self.begin(window, "AtriumNavHost.folderProject().close().then(()=>true)")
            assert self.result(window)["value"] is True
            assert self.watch_closed.wait(timeout=3), "The native folder watcher did not close."
            events = self.js(window, "return folderEvents.length;")
            active.write_bytes(active.read_bytes().replace(b'"EXT02"', b'"EXT03"'))
            time.sleep(0.3)  # Exceeds the one-shot native debounce in this test only.
            assert self.js(window, "return folderEvents.length;") == events
            print("PASS closing a grant releases its kernel watcher", flush=True)
            self.ok = True
        except Exception:
            traceback.print_exc()
            if "window" in locals():
                try:
                    print("GTK folder state:", self.js(window, "return {events:globalThis.folderEvents, "
                          "status:document.getElementById('status')?.textContent, "
                          "dirty:AtriumNavHost?.isDirty(), items:AtriumNavHost?.doc()?.items.map(i=>[i.id,i.text]), "
                          "metrics:AtriumNavHost?.folderProject()?.metrics(), focus:document.activeElement?.outerHTML.slice(0,120), "
                          "dialogs:[...document.querySelectorAll('dialog[open]')].map(d=>d.innerText.slice(0,170))};"), flush=True)
                except Exception:
                    pass
        finally:
            GLib.idle_add(self.dismiss_dialogs)


def main():
    command = shutil.which("waffle-eda") or shutil.which("waffle")
    if os.getuid() == 0 or not os.environ.get("DISPLAY") or not command:
        raise SystemExit("Run as an unprivileged user with the installed Waffle editor and X display.")
    launcher = Path(command)
    spec = importlib.util.spec_from_file_location("installed_waffle", launcher.resolve())
    host = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(host)
    with tempfile.TemporaryDirectory(prefix="waffle-folder-probe-") as directory:
        work = Path(directory)
        for key in ("HOME", "XDG_DATA_HOME", "XDG_CONFIG_HOME", "XDG_CACHE_HOME"):
            path = work / key.lower()
            path.mkdir()
            os.environ[key] = str(path)
        os.environ["MESA_SHADER_CACHE_DISABLE"] = "true"
        probe = FolderProbe(work, host)
        probe.watch_closed = threading.Event()
        close_watch = host.folder_project.FolderWatch.close

        def record_watch_close(watch):
            close_watch(watch)
            if watch.root.directory == work / "Sensor":
                probe.watch_closed.set()

        host.folder_project.FolderWatch.close = record_watch_close
        sys.excepthook = probe.callback_failed
        driver = threading.Thread(target=probe.run, daemon=True)
        GLib.idle_add(lambda: driver.start() or False)
        sys.argv = [str(launcher)]
        result = host.main()
        driver.join(10)
    return 0 if result == 0 and probe.ok and not probe.callback_errors else 1


if __name__ == "__main__":
    sys.exit(main())
