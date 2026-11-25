#!/usr/bin/env python3
"""Use a real GTK application/pdf drag source and the production WebKitGTK receiver."""
import hashlib
import importlib.util
import os
from pathlib import Path
import sys
import subprocess
import tempfile
import threading
import time
import traceback

from package import Gdk, GdkX11, GLib, Gtk, Probe, wait_for, xdo


def producer(pdf):
    raw = pdf.read_bytes()
    window = Gtk.Window()
    window.set_title("PDF drag source")
    window.set_default_size(110, 72)
    window.move(10, 12)
    label = Gtk.EventBox()
    label.add(Gtk.Label(label="Source PDF"))
    label.drag_source_set(Gdk.ModifierType.BUTTON1_MASK,
        [Gtk.TargetEntry.new("application/pdf", 0, 0)], Gdk.DragAction.COPY)

    def supply(_widget, _context, selection, _info, _time):
        print(selection.get_target().name(), flush=True)
        selection.set(selection.get_target(), 8, raw)

    label.connect("drag-data-get", supply)
    label.connect("drag-begin",lambda *_: print("begin",flush=True))
    label.connect("drag-failed",lambda _w,_c,r: print("failed:"+str(r.value_nick),flush=True) or False)
    label.connect("drag-end",lambda *_: print("end",flush=True))
    window.add(label)
    window.show_all()
    print(GdkX11.X11Window.get_xid(window.get_window()),flush=True)
    Gtk.main()


def main():
    root = Path(__file__).resolve().parents[3]
    path = root / "native/linux/waffle.py"
    project, pdf = (Path(value).resolve() for value in sys.argv[1:])
    raw = pdf.read_bytes()
    assert raw.startswith(b"%PDF-") and len(raw) < 65536
    digest = hashlib.sha256(raw).hexdigest()
    source_original = project.read_bytes()
    spec = importlib.util.spec_from_file_location("butter_drop_host", path)
    host = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(host)
    with tempfile.TemporaryDirectory(prefix="waffle-gtk-drop-") as scratch:
        profile = Path(scratch)
        for key in ("HOME", "XDG_DATA_HOME", "XDG_CONFIG_HOME", "XDG_CACHE_HOME"):
            setting = profile / key.lower()
            setting.mkdir()
            os.environ[key] = str(setting)
        probe = Probe(profile, host)

        def driver():
            source = editor = None
            source_log = profile / "xdnd.log"
            try:
                editor = wait_for("WebKit editor", lambda: probe.on_gtk(lambda: next(iter(probe.editors()), None)))
                wait_for("native project open", lambda: probe.js(editor, """
                    const h=globalThis.AtriumNavHost;
                    return h?.project()?.name==="Drop Board" && h.folderProject?.()?.grant;
                """))
                probe.begin(editor, """(async()=>{
                  const h=AtriumNavHost;
                  AtriumPrefs.set("labs.notebook",true);
                  await h.selectDocument(h.project().documents.find(doc=>doc.kind==="schematic").id);
                  AtriumPrefs.set("butter.drop",true);
                  AtriumPrefs.set("butter.datasheets",true);
                  await AtriumLazy.need(["AtriumButterEditor","AtriumDropEditor"]);
                  return true;
                })()""")
                assert probe.result(editor) == {"value": True}

                point = probe.js(editor, """
                  const c=AtriumNavHost.canvas(), b=c.getBoundingClientRect();
                  const x=Math.round(b.left+b.width/2),y=Math.round(b.top+b.height/2);
                  return document.elementFromPoint(x,y)===c ? [x,y] : null;
                """)
                assert point, "canvas not available for a real drag"
                xid = probe.focus(editor)
                with source_log.open("w") as log:
                    source = subprocess.Popen([sys.executable, __file__, "--source", str(pdf)], stdout=log, text=True)
                source_line = wait_for("independent GTK drag source", lambda: source_log.read_text().splitlines())
                source_xid = int(source_line[0])
                xdo("windowraise", source_xid, "windowfocus", "--sync", source_xid)
                xdo("mousemove", "--window", source_xid, 47, 37, "mousedown", 1)
                xdo("mousemove", "--window", source_xid, 77, 40)
                time.sleep(.12)
                xdo("mousemove", "--window", xid, point[0]-14, point[1])
                time.sleep(.12)
                xdo("mousemove", "--window", xid, *point)
                time.sleep(.12)
                xdo("mouseup", 1)

                value = wait_for("approved PDF reference from a native MIME drag", lambda: probe.js(editor, """
                  const refs=AtriumNavHost.project().datasheets || [];
                  return refs.length && refs;
                """), timeout=8)
                assert source_log.read_text().splitlines().count("application/pdf") == 1
                assert len(value) == 1 and value[0]["sha256"] == digest
                assert value[0]["byteLength"] == len(raw)
                assert "asset" not in value[0]
                assert project.read_bytes() == source_original
                print("PASS live GTK application/pdf drop produced a scoped unsaved datasheet reference", flush=True)
                probe.ok = True
            except Exception:
                traceback.print_exc()
                print("Native drag diagnostic", source_log.read_text() if source_log.exists() else "", flush=True)
                if editor is not None:
                    print(probe.js(editor, """return {
                      status: document.getElementById('status')?.textContent,
                      drop: AtriumPrefs.get('butter.drop'), datasheets: AtriumPrefs.get('butter.datasheets'),
                      document: AtriumNavHost.doc().kind
                    };"""), flush=True)
            finally:
                if source is not None:
                    source.terminate()
                    source.wait(timeout=5)
                GLib.idle_add(probe.finish)

        worker = threading.Thread(target=driver, daemon=True)
        GLib.idle_add(lambda: worker.start() or False)
        sys.excepthook = probe.callback_failed
        sys.argv = [str(path), str(project)]
        result = host.main()
        worker.join(8)
        return 0 if result == 0 and probe.ok and not probe.callback_errors else 1


if __name__ == "__main__":
    if len(sys.argv) == 3 and sys.argv[1] == "--source":
        producer(Path(sys.argv[2]))
    else:
        raise SystemExit(main())
