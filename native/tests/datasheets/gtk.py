"""Run the offline PDF.js proof on GTK WebKit using the packaged classic worker."""
import base64
import json
from pathlib import Path
import shutil
import subprocess
import sys

ROOT = Path(__file__).resolve().parents[3]


def prepare(stage):
    stage.mkdir(parents=True, exist_ok=True)
    for source, name in (
        ('core/sha256.js', 'sha256.js'),
        ('project/source-file.js', 'source-file.js'),
        ('notebook/datasheet-record.js', 'datasheet-record.js'),
        ('notebook/datasheets.js', 'datasheets.js'),
        ('datasheet-worker-source.js', 'datasheet-worker-source.js'),
    ):
        shutil.copyfile(ROOT / "app" / source, stage / name)
    raw = subprocess.check_output(["node", "-e",
        'process.stdout.write(require("./tests/support/datasheet-pdf.cjs").fixture(300))'], cwd=ROOT)
    (stage / "proof.js").write_text((ROOT / "tests/support/datasheet-probe.js").read_text() +
        '\nconst host = window.webkit.messageHandlers.proof;\n' +
        'runDatasheetProbe("' + base64.b64encode(raw).decode() +
        '",{present:()=>host.postMessage({op:"frame"})}).then(data=>host.postMessage(data),' +
        'error=>host.postMessage({error:error.message}));\n')
    (stage / "reader.html").write_text('''<!doctype html><meta charset="utf-8">
<script src="sha256.js"></script><script src="source-file.js"></script><script src="datasheet-record.js"></script>
<script src="datasheet-worker-source.js"></script><script src="datasheets.js"></script>
<script>globalThis.AtriumLazy={need:async name=>window[name]};</script><script src="proof.js"></script>''')


def run(stage):
    import gi
    gi.require_version("Gtk","3.0")
    gi.require_version("WebKit2","4.1")
    gi.require_version("JavaScriptCore","4.1")
    from gi.repository import Gtk, WebKit2, GLib, JavaScriptCore

    manager = WebKit2.UserContentManager()
    manager.register_script_message_handler_with_reply("proof",None)
    window = Gtk.Window(default_width=600,default_height=450)
    view = WebKit2.WebView.new_with_user_content_manager(manager)
    window.add(view)
    window.show_all()
    status = 1

    def receive(_, value, reply):
        nonlocal status
        data = json.loads(value.to_json(0))
        ctx = value.get_context()
        if data.get("op") == "frame":
            def snap(web, task):
                try:
                    surface = web.get_snapshot_finish(task)
                    if surface is None:
                        raise ValueError("WebKitGTK returned no frame.")
                    reply.return_value(JavaScriptCore.Value.new_from_json(ctx,"true"))
                except (GLib.Error,ValueError) as error:
                    reply.return_error_message(str(error))
            view.get_snapshot(WebKit2.SnapshotRegion.VISIBLE,WebKit2.SnapshotOptions.NONE,None,snap)
            return True
        print(json.dumps(data,sort_keys=True),flush=True)
        if not data.get("error"):
            assert data["untouched"] == {"parseRequests":0,"liveReaders":0}
            assert data["pages"] == 300 and data["colored"] and data["cancelled"] == "AbortError"
            assert data["rows"] == [["Pin","Name","Function"],["1","VCC","Power"],["2","GND","Ground"]]
            assert len(data["warmMs"]) == len(data["presentedMs"]) == 10
            assert all(0 < png <= show for png,show in zip(data["warmMs"],data["presentedMs"]))
            assert data["ended"] == {"liveReaders":0,"parseRequests":2}
            status = 0
        reply.return_value(JavaScriptCore.Value.new_from_json(ctx,"true"))
        Gtk.main_quit()
        return True

    def timeout():
        print("WebKitGTK PDF proof exceeded 45 seconds.",file=sys.stderr)
        Gtk.main_quit()
        return False

    manager.connect("script-message-with-reply-received::proof",receive)
    GLib.timeout_add_seconds(45,timeout)
    view.load_uri((stage / "reader.html").resolve().as_uri())
    Gtk.main()
    return status


if __name__ == "__main__":
    if sys.argv[1] == "--prepare":
        prepare(Path(sys.argv[2]))
    else:
        raise SystemExit(run(Path(sys.argv[1])))
