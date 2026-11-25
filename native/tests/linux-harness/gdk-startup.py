#!/usr/bin/env python3
"""Start the Linux host with its real GI bindings and verify the native editor loads."""

from pathlib import Path
import sys

ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(ROOT / "native/linux"))
import waffle


def main():
    loaded_editor = False
    create_editor = waffle.create_editor_window

    def launch(Gdk, GLib, Gtk, WebKit2, initial_files, open_window, windows, recent, application, *args, **kwargs):
        # Do not import Gdk or Gtk before the launcher selects its versions.
        assert Gdk._version == "3.0" and Gtk._version == "3.0"
        import gi
        assert gi.get_required_version("Gdk") == "3.0"
        create_editor(Gdk, GLib, Gtk, WebKit2, initial_files, open_window, windows, recent, application,
                      *args, **kwargs)
        window, = windows
        view = window.get_child()
        assert isinstance(view, WebKit2.WebView)

        def loaded(view, event):
            nonlocal loaded_editor
            if event == WebKit2.LoadEvent.FINISHED and view.get_uri() == waffle.PAGE.as_uri():
                loaded_editor = True
                application.quit()

        def timeout():
            application.quit()
            return False

        view.connect("load-changed", loaded)
        GLib.timeout_add_seconds(15, timeout)

    def unexpected_browser(_project):
        raise AssertionError("The Linux launcher fell back to the browser instead of opening a GTK3 WebView")

    waffle.create_editor_window = launch
    waffle.browser = unexpected_browser
    assert waffle.main() == 0
    assert loaded_editor, "The native WebView did not finish loading the editor"
    print("PASS GTK3 native editor startup")


if __name__ == "__main__":
    main()
