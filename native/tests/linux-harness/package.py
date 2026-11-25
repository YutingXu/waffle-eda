#!/usr/bin/env python3
"""Drive the installed Debian package's WebKitGTK editor and native dialogs.

Run as an unprivileged user on a network-isolated X display with xdotool:
    xvfb-run -a -s '-screen 0 1380x860x24' python3 native/tests/linux-harness/package.py

The runner uses the installed launcher and package assets. It observes the WebKit and GTK
widgets in process and uses XTEST for canvas editing, Save and dialog buttons.
The second window opts into the packaged relay's existing loopback-only test mode.
"""

from concurrent.futures import Future
from functools import partial
import gc
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
import traceback
from unittest.mock import patch

import gi

gi.require_version("Gtk", "3.0")
gi.require_version("Gdk", "3.0")
gi.require_version("GdkX11", "3.0")
gi.require_version("WebKit2", "4.1")
from gi.repository import Gdk, GdkX11, GLib, Gtk, WebKit2  # noqa: E402


def wait_for(label, check, timeout=20):
    end = time.monotonic() + timeout
    while time.monotonic() < end:
        value = check()
        if value:
            return value
        time.sleep(0.08)
    raise AssertionError("Timed out waiting for " + label)


def xdo(*args):
    subprocess.run(["xdotool", *map(str, args)], check=True, timeout=10)


def listening(port):
    with socket.socket() as client:
        client.settimeout(0.5)
        return client.connect_ex(("127.0.0.1", port)) == 0


def fixture(path, name):
    path.parent.mkdir(parents=True,exist_ok=True)
    def rows(*records):
        return "".join(json.dumps(row,separators=(",",":")) + "\n" for row in records)
    path.write_text(rows({"kind":"project","formatVersion":"2.0","id":path.stem,"name":name},
                         {"kind":"document","id":"sheet","docKind":"schematic","name":"Schematic","path":"Power.wsch"}))
    sheet = path.with_name("Power.wsch")
    sheet.write_text(rows({"kind":"schematic","formatVersion":"2.0","id":"sheet"},
                          {"kind":"wire","id":"wire-a","points":[[20320000,20320000],[40640000,20320000]]},
                          {"kind":"wire","id":"wire-b","points":[[20320000,40640000],[40640000,40640000]]}))
    return sheet


class Probe:
    def __init__(self, work, host):
        self.work = work
        self.host = host
        self.callback_errors = []
        self.ok = False

    def callback_failed(self, kind, error, trace):
        self.callback_errors.append(error)
        sys.__excepthook__(kind, error, trace)

    @staticmethod
    def on_gtk(action):
        result = Future()

        def call():
            try:
                result.set_result(action())
            except Exception as error:
                result.set_exception(error)
            return False

        GLib.idle_add(call)
        return result.result(8)

    def js(self, window, script):
        result = Future()

        def finished(view, task, _):
            try:
                value = view.evaluate_javascript_finish(task)
                result.set_result(json.loads(value.to_string()))
            except Exception as error:
                result.set_exception(error)

        self.on_gtk(lambda: window.get_child().evaluate_javascript(
            "JSON.stringify((() => {" + script + "})())", -1, None, None, None, finished, None))
        return result.result(8)

    def begin(self, window, expression):
        self.js(window, "window.__packageResult = null; Promise.resolve().then(() => (" + expression +
                ")).then(value => { window.__packageResult = {value: value ?? null}; },"
                "error => { window.__packageResult = {error: error.message}; }); return true;")

    def result(self, window, label="bridge response", timeout=12):
        return wait_for(label, lambda: self.js(window, "return window.__packageResult;"), timeout)

    @staticmethod
    def editors():
        return [w for w in Gtk.Window.list_toplevels() if isinstance(w.get_child(), WebKit2.WebView)]

    def dialog(self, parent, kind):
        return wait_for(kind.__name__, lambda: self.on_gtk(lambda: next(
            (w for w in Gtk.Window.list_toplevels() if isinstance(w, kind) and
             w.get_visible() and w.get_transient_for() == parent), None)))

    def focus(self, window):
        xid = self.on_gtk(lambda: GdkX11.X11Window.get_xid(window.get_window()))
        xdo("windowraise", xid, "windowfocus", "--sync", xid)
        return xid

    def choose_file(self, window, path):
        dialog = self.dialog(window, Gtk.FileChooserDialog)
        assert self.on_gtk(lambda: dialog.set_filename(str(path)))
        accept = Gtk.ResponseType.ACCEPT
        wait_for("selected file in native chooser", lambda: self.on_gtk(
            lambda: dialog.get_filename() == str(path) and dialog.get_widget_for_response(accept).get_sensitive()))
        self.click(dialog, lambda: dialog.get_widget_for_response(accept))
        wait_for("file chooser to close", lambda: self.on_gtk(lambda: not dialog.get_visible()))

    def choose_destination(self, window, path, *, confirm_overwrite=True):
        dialog = self.dialog(window, Gtk.FileChooserDialog)
        def enter_path():
            dialog.set_current_folder(str(path.parent))
            dialog.set_current_name(path.name)
            dialog.set_do_overwrite_confirmation(confirm_overwrite)
        self.on_gtk(enter_path)
        accept = Gtk.ResponseType.ACCEPT
        wait_for("new destination in Save As", lambda: self.on_gtk(lambda: dialog.get_filename() == str(path)))
        self.click(dialog, lambda: dialog.get_widget_for_response(accept))

    def click(self, window, widget, x=None, y=None):
        def coordinates():
            w = widget()
            if x is None:
                size = w.get_allocation()
                return w.translate_coordinates(window, size.width // 2, size.height // 2)
            return w.translate_coordinates(window, round(x), round(y))

        xy = self.on_gtk(coordinates)
        assert xy is not None
        xdo("mousemove", "--window", self.focus(window), *xy, "click", 1)

    def answer(self, dialog, response, label):
        button = self.on_gtk(lambda: dialog.get_widget_for_response(response))
        assert button and self.on_gtk(lambda: button.get_label().replace("_", "")) == label
        self.click(dialog, lambda: button)
        wait_for(label + " dialog to close", lambda: self.on_gtk(lambda: not dialog.get_visible()))

    def click_page(self, window, selector):
        previous = None

        def point():
            nonlocal previous
            current = self.js(window, f"""
                const element = {selector};
                if (!element || !element.getClientRects().length) return null;
                element.scrollIntoView({{block: "nearest"}});
                const box = element.getBoundingClientRect();
                const x = Math.round(box.left + box.width / 2), y = Math.round(box.top + box.height / 2);
                return element.contains(document.elementFromPoint(x, y)) ? [x, y] : null;
            """)
            stable = current == previous
            previous = current
            return current if stable else None
        xy = wait_for("visible editor control", point)
        self.click(window, window.get_child, *xy)

    def page_button(self, window, label):
        self.click_page(window, "[...document.querySelectorAll('dialog[open] button')]"
                        ".find(b => b.textContent.trim() === " + json.dumps(label) + ")")

    def opened_source(self, file, name):
        binding = "return !!globalThis.AtriumHost?.folderGitGrant && " \
                  "globalThis.AtriumNavHost?.project().name === " + json.dumps(name) + ";"

        def with_project():
            return next((w for w in self.on_gtk(self.editors)
                         if self.on_gtk(lambda: not w.get_child().is_loading()) and self.js(w, binding)), None)

        opened = wait_for("saved folder and its declared sheet to open", with_project)
        self.click_page(opened, "[...document.querySelectorAll('#document-tabs [data-tab]')]"
                        ".find(tab => tab.dataset.tab === AtriumNavHost.currentId())")
        return opened

    def open(self, window, file, name):
        self.focus(window)
        xdo("key", "--clearmodifiers", "ctrl+o")
        self.choose_file(window, file)
        return self.opened_source(file, name)

    def drop(self, window, file, name):
        def create_drag_source():
            source = Gtk.Window(title="File drop test")
            source.set_default_size(110, 70)
            source.move(1260, 100)
            target = Gtk.EventBox()
            target.add(Gtk.Label(label=file.name))
            target.drag_source_set(Gdk.ModifierType.BUTTON1_MASK,
                                   [Gtk.TargetEntry.new("text/uri-list", 0, 0)], Gdk.DragAction.COPY)
            target.connect("drag-data-get", lambda _widget, _context, data, _info, _time: data.set_uris([file.as_uri()]))
            source.add(target)
            source.show_all()
            return source
        source = self.on_gtk(create_drag_source)
        try:
            xid = self.focus(source)
            target = self.on_gtk(lambda: GdkX11.X11Window.get_xid(window.get_window()))
            xdo("mousemove", "--window", xid, 30, 30, "mousedown", 1, "sleep", "0.15",
                "mousemove", "--window", xid, 65, 40, "sleep", "0.15",
                "mousemove", "--window", target, 150, 150, "sleep", "0.35", "mouseup", 1)
            return self.opened_source(file, name)
        finally:
            self.on_gtk(source.destroy)

    def detached_open(self, window):
        binding = self.js(window,"return AtriumHost.folderGitGrant;")
        sheet = self.work / "Detached.KICAD_SCH"
        sheet.write_text("(kicad_sch)\n")
        self.begin(window, 'AtriumHost.open([".kicad_sch"], {into:true}).then(async files =>' +
                   ' ({files: await Promise.all(files.map(async f => [f.name, await f.text()])), grant: AtriumHost.folderGitGrant}))')
        self.choose_file(window, sheet)
        assert self.result(window)["value"] == {"files": [[sheet.name, sheet.read_text()]], "grant": binding}
        assert self.on_gtk(lambda: len(self.editors()) == 1)
        self.begin(window, 'AtriumHost.open([".gbr"])')
        assert self.result(window)["error"] == "Unrecognised import file type."
        print("PASS native registry accepts a KiCad document into the active window and refuses the export-only filter", flush=True)

    def remove_wire(self, window, wire):
        xy = self.js(window, f"""
            const h = AtriumNavHost, item = h.doc().items.find(i => i.id === {json.dumps(wire)});
            const [a, b] = item.points, point = a.map((n, i) => (n + b[i]) / 2);
            const position = h.view().worldToScreen(point), canvas = h.canvas();
            const box = canvas.getBoundingClientRect(), x = box.left + position[0], y = box.top + position[1];
            return h.hit(canvas, x, y)?.item?.id === item.id ? [x, y] : null;
        """)
        assert xy, "the wire must be visible and hit-testable"
        self.click(window, window.get_child, *xy)
        wait_for("wire selection", lambda: self.js(
            window, "return AtriumNavHost.selection().includes(" + json.dumps(wire) + ");"))
        xdo("key", "--clearmodifiers", "Delete")
        wait_for("dirty editor and deleted wire", lambda: self.js(
            window, "return AtriumNavHost.isDirty() && !AtriumNavHost.doc().items.some(i => i.id === " +
            json.dumps(wire) + ");"))
        wait_for("unsaved mark on GTK window", lambda: self.on_gtk(lambda: "•" in window.get_title()))

    def close_prompt(self, window, name):
        GLib.idle_add(window.close)
        dialog = self.dialog(window, Gtk.MessageDialog)
        assert self.on_gtk(lambda: dialog.get_property("text")) == f"Save changes to “{name}” before closing?"
        assert self.on_gtk(lambda: {dialog.get_widget_for_response(code).get_label().replace("_", "") for code in
                                  (Gtk.ResponseType.REJECT, Gtk.ResponseType.CANCEL, Gtk.ResponseType.ACCEPT)}) == {
                                      "Close Without Saving", "Cancel", "Save"}
        return dialog

    def schedule_late_lock_request(self, window):
        # Replay a real, authenticated request immediately after this window's destroy handler.
        # Another window keeps the GTK event loop alive long enough to observe any callback exception.
        manager = self.on_gtk(lambda: window.get_child().get_user_content_manager())
        received = threading.Event()
        replayed = threading.Event()
        message = {}

        def record(_, result):
            if '"action":"folderStatus"' in result.get_js_value().to_string() and not received.is_set():
                message["result"] = result.copy()
                received.set()

        signal = "script-message-received::atriumHost"
        token = self.on_gtk(lambda: manager.connect(signal, record))
        try:
            self.begin(window, "AtriumHost.folderStatus({grant:AtriumHost.folderGitGrant})")
            assert "value" in self.result(window, "live window's folder status")
            assert received.wait(8), "the authenticated request was not observed"
        finally:
            self.on_gtk(lambda: manager.disconnect(token))

        def replay(_window):
            # WebKit's boxed result holds a JavaScript context. Release it on the GTK thread.
            manager.emit(signal, message.pop("result"))
            replayed.set()

        self.on_gtk(lambda: window.connect("destroy", replay))
        return replayed

    def external_tool(self, window):
        tool = self.work / "test-ngspice"
        tool.write_text("#!/bin/sh\nset -eu\ntest \"$1\" = -b\ncat \"$2\" > result.raw\nprintf '%s\\n' simulated\n")
        tool.chmod(0o700)
        self.begin(window, 'AtriumHost.externalToolChoose({id:"ngspice", name:"ngspice"})')
        self.choose_file(window, tool)
        assert self.result(window)["value"]["path"] == str(tool)
        self.begin(window, """(async () => {
            await AtriumLazy.need("AtriumExtensions");
            return AtriumExternalTools.run({tool: "ngspice", toolName: "ngspice", extension: "test.simulator",
                extensionName: "Test Simulator", extensionHash: "sha256:" + "a".repeat(64),
                argTemplate: ["-b"], args: ["-b", "deck.cir"], files: {"deck.cir": "Synthetic deck\\n"},
                outputs: ["*.raw"], timeoutMs: 5000, maxOutputBytes: 4096, runKey: "test.simulator:1"});
        })()""")
        prompt = self.dialog(window, Gtk.MessageDialog)
        assert self.on_gtk(lambda: prompt.get_property("text")) == "Allow Test Simulator to run ngspice?"
        assert self.on_gtk(lambda: "-b deck.cir" in prompt.get_property("secondary-text"))
        assert self.js(window, "return window.__packageResult;") is None, "no success reply before approval"
        self.answer(prompt, Gtk.ResponseType.YES, "Allow")
        out = self.result(window, "asynchronous external-run reply", timeout=10)["value"]
        assert out["exitCode"] == 0 and out["stdout"] == "simulated\n"
        assert out["files"] == [{"name": "result.raw", "size": 15, "text": "Synthetic deck\n"}]
        assert not self.callback_errors, "a GTK callback failed during the external run"
        print("PASS native program chooser, command approval and external tool output", flush=True)

    def share_dialog(self, window):
        if self.js(window, "return !!document.querySelector('#collab-share');"):
            self.click_page(window, "document.querySelector('#collab-share')")
        else:
            # The usual window command permits live sessions even before the editor saves a copy.
            self.js(window, "return window.dispatchEvent(new CustomEvent('atrium-command',{detail:'collab-live'}));")
        state = wait_for("Live Session dialog", lambda: self.js(window, """
            const d = document.querySelector('dialog[open].collab-dialog');
            if (!d) return null;
            return d.querySelector('#collab-visible') ? 'ready' : 'enable';
        """))
        if state == "enable":
            self.page_button(window, "Turn On Live Sessions")

    def start_lan(self, window):
        self.share_dialog(window)
        self.click_page(window, "document.querySelector('dialog[open] #collab-visible')")
        wait_for("local-network checkbox selected", lambda: self.js(window,
            "return !!document.querySelector('dialog[open] #collab-visible')?.checked;"))
        self.page_button(window, "Start Session")

    def relay(self, owner, guest, name):
        self.start_lan(owner)
        code = wait_for("host session code", lambda: self.js(
            owner, "return document.querySelector('dialog[open] .collab-code')?.textContent ?? null;"))
        port = int(self.js(owner, """
            const link = document.querySelector('dialog[open] .collab-invite input');
            return new URL(link.value).port;
        """))
        self.share_dialog(guest)
        wait_for("guest invitation field", lambda: self.js(
            guest, "return !!document.querySelector('dialog[open].collab-dialog textarea');"))
        self.js(guest, f"""
            const dialog = document.querySelector('dialog[open].collab-dialog');
            const invite = dialog.querySelector("textarea");
            invite.value = "127.0.0.1:{port}";
            invite.dispatchEvent(new Event("input", {{bubbles: true}}));
            const code = dialog.querySelector('input[placeholder="ABCD-EFGH-JKMN-PQRS"]');
            code.value = {json.dumps(code)};
            return true;
        """)
        self.page_button(guest, "Join Session")
        wait_for("guest project snapshot over the relay", lambda: self.js(
            guest, "return AtriumNavHost.project().name === " + json.dumps(name) +
            " && AtriumNavHost.doc().items.map(i => i.id).join(',') === 'wire-b';"))
        assert listening(port)
        self.page_button(owner, "Leave Session")
        wait_for("relay to stop listening", lambda: not listening(port))
        print("PASS Share starts a native loopback session, a second WebKitGTK window joins and receives the project, and Leave stops listening", flush=True)

    def library_write(self, window):
        root = self.work / "library-write"
        component = root / "components" / "part.json"
        component.parent.mkdir(parents=True)
        original, updated = b'{"id":"original"}', '{"id":"updated"}'
        component.write_bytes(original)
        replace = os.replace

        def write(grant):
            self.begin(window, "AtriumHost.libraryFolderWrite(" + json.dumps(grant) +
                       ", 'components/part.json', " + json.dumps(updated) + ")")
            return self.result(window, "native library write")

        def interrupt(source, target, **options):
            if target == component.name and source.startswith(".atrium-"):
                raise OSError("Interrupted before publication")
            return replace(source, target, **options)

        for purpose in ("read", "write"):
            self.begin(window, "AtriumHost.chooseLibraryFolder(" + json.dumps(purpose) + ")")
            self.choose_file(window, root)
            grant = self.result(window, "native library grant")["value"]["grant"]
            if purpose == "read":
                assert "Choose a library folder to save to" in write(grant)["error"]
            else:
                with patch.object(os, "replace", interrupt):
                    assert write(grant)["error"] == "Interrupted before publication"
            assert component.read_bytes() == original and list(component.parent.iterdir()) == [component]
        assert write(grant) == {"value": True} and component.read_text() == updated
        print("PASS native library writer preserves original bytes after denied access and interrupted rename", flush=True)

    def run(self):
        from lan_relay import LanRelay, lan_networks

        first = self.work / "first" / "First.waffle"
        second = self.work / "second" / "Second.waffle"
        third = self.work / "guest" / "Guest.waffle"
        first_sheet = fixture(first, "Synthetic schematic")
        second_sheet = fixture(second, "Second schematic")
        fixture(third, "Guest schematic")
        original = {p:p.read_bytes() for p in (first,second,third)}
        def wire_ids(file):
            return [r["id"] for r in map(json.loads,file.read_text().splitlines()) if r["kind"]=="wire"]
        try:
            assert not lan_networks()["addresses"], "run this probe with no physical LAN access"
            window = wait_for("packaged WebKitGTK window", lambda: self.on_gtk(
                lambda: next((w for w in self.editors() if w.get_child().get_uri() and
                              not w.get_child().is_loading()), None)))
            wait_for("editor to initialise", lambda: self.js(window, "return !!globalThis.AtriumNavHost;"))
            self.js(window, "globalThis.AtriumStartPage?.close(); return true;")
            self.library_write(window)
            assert self.drop(window, first, "Synthetic schematic") == window
            self.remove_wire(window, "wire-a")
            self.focus(window)
            xdo("key", "--clearmodifiers", "ctrl+s")
            wait_for("ordinary Save to persist the selected sheet and mark it clean", lambda:
                     wire_ids(first_sheet) == ["wire-b"] and self.js(window,"return !AtriumNavHost.isDirty();"))
            assert first.read_bytes() == original[first]
            print("PASS native drop adopts a folder and Ctrl+S writes only its changed sheet",flush=True)
            self.detached_open(window)

            self.start_lan(window)
            wait_for("no physical LAN explanation", lambda: self.js(window,
                "return document.querySelector('dialog[open] [role=alert]')?.textContent.includes('not on a local network') ?? false;"))
            self.page_button(window, "Close")
            print("PASS an isolated container cannot advertise on a physical network", flush=True)
            self.external_tool(window)

            self.remove_wire(window, "wire-b")
            persisted = first_sheet.read_bytes()
            prompt = self.close_prompt(window, "Synthetic schematic")
            self.answer(prompt, Gtk.ResponseType.CANCEL, "Cancel")
            assert first_sheet.read_bytes() == persisted and self.js(window, "return AtriumNavHost.isDirty();")
            print("PASS native close Cancel retains the window and edit without writing the file", flush=True)

            with patch("lan_relay.LanRelay", partial(LanRelay, addresses=[], advertise=False)):
                other = self.open(window,second,"Second schematic")
            assert other != window
            replayed = self.schedule_late_lock_request(other)
            self.remove_wire(other, "wire-a")
            self.answer(self.close_prompt(other, "Second schematic"), Gtk.ResponseType.ACCEPT, "Save")
            assert replayed.wait(8), "the after-destroy message was not exercised"
            wait_for("second window to close after Save", lambda: self.on_gtk(lambda: other not in self.editors()))
            assert wire_ids(second_sheet) == ["wire-b"]
            print("PASS native close Save commits the edit before the window closes", flush=True)
            # Force collection off GTK's thread while another window and its bridge are active.
            gc.collect()
            self.begin(window, "AtriumHost.collabLocks()")
            assert "value" in self.result(window, "remaining window's collaboration reply")
            assert not self.callback_errors, "a GTK callback failed during window teardown"
            print("PASS late bridge message is ignored and worker collection leaves the remaining window active", flush=True)

            with patch("lan_relay.LanRelay", partial(LanRelay, addresses=[], advertise=False)):
                owner = self.open(window,second,"Second schematic")
            guest = self.open(owner, third, "Guest schematic")
            self.relay(owner, guest, "Second schematic")
            self.answer(self.close_prompt(window, "Synthetic schematic"),
                        Gtk.ResponseType.REJECT, "Close Without Saving")
            wait_for("first window to close after Close Without Saving",
                     lambda: self.on_gtk(lambda: window not in self.editors()))
            assert first_sheet.read_bytes() == persisted
            assert all(p.read_bytes() == data for p,data in original.items())
            print("PASS native close Close Without Saving closes the window and preserves the saved bytes", flush=True)
            self.ok = True
        except Exception:
            traceback.print_exc()
        finally:
            GLib.idle_add(self.dismiss_dialogs)

    def dismiss_dialogs(self):
        for dialog in Gtk.Window.list_toplevels():
            if isinstance(dialog, Gtk.Dialog) and dialog.get_visible():
                dialog.response(Gtk.ResponseType.CANCEL)
        GLib.idle_add(self.finish)
        return False

    def finish(self):
        for window in self.editors():
            window.destroy()
        if Gtk.main_level():
            Gtk.main_quit()
        return False


def main():
    if os.getuid() == 0 or not os.environ.get("DISPLAY") or not shutil.which("xdotool"):
        raise SystemExit("Run as an unprivileged user with an X display and xdotool.")
    command = shutil.which("waffle-eda") or shutil.which("waffle")
    if not command:
        raise SystemExit("Install the Waffle EDA Debian package before running this probe.")
    launcher = Path(command)
    source = launcher.resolve(strict=True)
    assert source.is_relative_to("/usr/share") and source.suffix == ".py", "expected an installed Debian launcher"
    spec = importlib.util.spec_from_file_location("installed_waffle", source)
    host = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(host)
    sys.path.insert(0, str(source.parent))
    with tempfile.TemporaryDirectory(prefix="waffle-package-probe-") as folder:
        work = Path(folder)
        for key in ("HOME", "XDG_DATA_HOME", "XDG_CONFIG_HOME", "XDG_CACHE_HOME"):
            path = work / key.lower()
            path.mkdir()
            os.environ[key] = str(path)
        probe = Probe(work, host)
        sys.excepthook = probe.callback_failed
        driver = threading.Thread(target=probe.run, daemon=True)
        GLib.idle_add(lambda: driver.start() or False)
        sys.argv = [str(launcher)]
        app_exit = host.main()
        driver.join(10)
    return 0 if app_exit == 0 and probe.ok and not probe.callback_errors else 1


if __name__ == "__main__":
    sys.exit(main())
