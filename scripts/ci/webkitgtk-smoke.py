#!/usr/bin/env python3
"""WebKitGTK smoke test for the Linux host's web view (run under Xvfb: xvfb-run -a python3 ...).

Loads app/index.html in a WebKit2 4.1 WebView with native/bridge.js injected and the
"atriumHost" message handler registered, as native/linux/waffle.py does, then checks that the
editor booted: the Waffle model global exists, the menus have actions and no page error fired.
Exit 0 on success, 1 on a failed check, 2 when WebKitGTK is not installed."""
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
TIMEOUT_S = 60

try:
    import gi
    gi.require_version("Gtk", "3.0")
    gi.require_version("WebKit2", "4.1")
    from gi.repository import GLib, Gtk, WebKit2
except (ImportError, ValueError) as error:
    print("SKIP webkitgtk: " + str(error))
    sys.exit(2)

ERRORS = """window.__errs=[];addEventListener("error",e=>__errs.push(e.message+" @"+(e.filename||"").split("/").pop()+":"+e.lineno));
addEventListener("unhandledrejection",e=>__errs.push("rejection: "+(e.reason&&e.reason.message||e.reason)));"""
PROBE = """JSON.stringify({model:typeof Atrium==="object",host:typeof AtriumHost==="object",
actions:document.querySelectorAll("[data-action]").length,errors:window.__errs||["no error hook"]})"""

result = {}


def main():
    manager = WebKit2.UserContentManager()
    manager.register_script_message_handler("atriumHost")
    for source in (ERRORS, (ROOT / "native" / "bridge.js").read_text(encoding="utf-8")):
        manager.add_script(WebKit2.UserScript.new(source, WebKit2.UserContentInjectedFrames.TOP_FRAME,
                                                  WebKit2.UserScriptInjectionTime.START, None, None))
    view = WebKit2.WebView.new_with_user_content_manager(manager)
    settings = view.get_settings()
    settings.set_allow_file_access_from_file_urls(True)
    window = Gtk.OffscreenWindow()
    window.set_default_size(1280, 800)
    window.add(view)
    window.show_all()

    def probed(webview, task):
        try:
            value = webview.run_javascript_finish(task).get_js_value().to_string()
            result.update(json.loads(value))
        except GLib.Error as error:
            result["error"] = error.message
        Gtk.main_quit()

    def loaded(webview, event):
        if event == WebKit2.LoadEvent.FINISHED:
            # Give the deferred boot (first frame, idle work) a moment before probing.
            GLib.timeout_add(1500, lambda: webview.run_javascript(PROBE, None, probed) and False)

    def timeout():
        result["error"] = "page did not finish loading in %d s" % TIMEOUT_S
        Gtk.main_quit()

    view.connect("load-changed", loaded)
    GLib.timeout_add_seconds(TIMEOUT_S, timeout)
    view.load_uri((ROOT / "app" / "index.html").as_uri())
    Gtk.main()

    print("webkitgtk " + WebKit2.get_major_version().__str__() + "." + str(WebKit2.get_minor_version()) + ": " + json.dumps(result))
    ok = (not result.get("error") and result.get("model") and result.get("host")
          and result.get("actions", 0) > 50 and result.get("errors") == [])
    print("PASS webkitgtk smoke" if ok else "FAIL webkitgtk smoke")
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
