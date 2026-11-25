#!/usr/bin/env python3
"""Open a native regular document through the installed GTK host and verify its MIME type."""
import argparse
from hashlib import sha256
import importlib.util
import json
import os
from pathlib import Path
import shutil
import sys
import tempfile
import threading
import traceback

from package import GLib, Probe, wait_for
from gi.repository import Gio

TYPES = {
    ".wpcb": ("pcb", "board"), ".wsch": ("schematic", "schematic"), ".wlib": ("library", "library"),
    ".wdraw": ("drawing", "drawing"), ".wpanel": ("panel", "panel"),
}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("file", type=Path)
    parser.add_argument("--indexed", action="store_true")
    args = parser.parse_args()
    source = args.file.absolute()
    assert source.is_file() and not source.is_symlink()
    kind, mime_suffix = TYPES[source.suffix]
    mime = "application/x-waffle-" + mime_suffix
    original = source.read_bytes()
    header = json.loads(original.splitlines()[0])
    assert header["kind"] == kind
    launcher = Path(shutil.which("waffle"))
    installed = launcher.resolve()
    assert installed.is_relative_to("/usr/share") and installed.suffix == ".py", "expected installed Waffle"
    spec = importlib.util.spec_from_file_location("installed_waffle", installed)
    host = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(host)

    with tempfile.TemporaryDirectory(prefix="waffle-gtk-durable-") as work:
        profile = Path(work)
        for key in ("HOME", "XDG_DATA_HOME", "XDG_CONFIG_HOME", "XDG_CACHE_HOME"):
            path = profile / key.lower()
            path.mkdir()
            os.environ[key] = str(path)
        assert Gio.content_type_guess(str(source), None)[0] == mime
        apps = Gio.AppInfo.get_all_for_type(mime)
        assert any(app.get_id() == "org.waffle.editor.desktop" and app.supports_uris() for app in apps)
        probe = Probe(profile, host)

        def run():
            try:
                window = wait_for("installed editor", lambda: probe.on_gtk(lambda: next(iter(probe.editors()), None)))
                wanted = json.dumps(header["id"])
                if args.indexed:
                    condition = ("folder && !folder.standalone && (h.doc()?.id === " + wanted +
                                 " || (h.doc()?.kind === 'library'))")
                else:
                    condition = "folder?.standalone?.id === " + wanted + " && !folder.standalone.readOnly"
                loaded = wait_for("native document editor", lambda: probe.js(window,
                    "const h=globalThis.AtriumNavHost,folder=h?.folderProject?.();"
                    "return (" + condition + ") ? {kind:folder.standalone?.kind || h.doc()?.kind,"
                    "grant:folder.standalone?.nativeGrant || folder.grant} : false;"))
                assert loaded["grant"], loaded
                if not args.indexed:
                    assert loaded["kind"] == kind, loaded
                assert sha256(source.read_bytes()).digest() == sha256(original).digest()
                if not args.indexed:
                    assert not (source.parent / ".waffle").exists(), "opening a loose document created journal metadata"
                print(f"PASS installed GTK opened regular {source.suffix} as {kind} ({mime}), unchanged SHA-256")
                probe.ok = True
            except Exception:
                traceback.print_exc()
            finally:
                GLib.idle_add(probe.finish)

        driver = threading.Thread(target=run, daemon=True)
        GLib.idle_add(lambda: driver.start() or False)
        sys.excepthook = probe.callback_failed
        sys.argv = [str(launcher), Gio.File.new_for_path(str(source)).get_uri()]
        result = host.main()
        driver.join(8)
        return 0 if result == 0 and probe.ok and not probe.callback_errors else 1


if __name__ == "__main__":
    sys.exit(main())
