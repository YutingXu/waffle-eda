#!/usr/bin/env python3
"""WebKitGTK UI probes: the Linux counterpart of native/tests/macos-harness/ui.sh. Test-only.

Runs the same page-side probes (native/tests/macos-harness/ui-probes.js and css-audit.js) in a
WebKitGTK 4.1 WebView, and answers their "harness" messages the way ui-probes.swift does on macOS:
  mouse, key   real X input through xdotool (XTEST), so WebKitGTK itself turns them into DOM
               events (isTrusted, Ctrl/Alt modifiers, right-click and contextmenu as a user gets them)
  nativeMenus  WebKitGTK's own context menu (the "context-menu" signal), recorded and suppressed
  shot, pixels snapshots of the web view (PNG files, pixel statistics of a page rectangle)
  ink-raster   glyph masks from the same WebKit snapshot, used by the shared field text probes
  cssSources, save, focusWindow, log, note
The editor page runs as the browser edition (no native/bridge.js): the probes cover the engine's
input, menus, CSS and rendering, not the Linux host's file bridge.

Run under an X server whose screen matches the window, with no window manager, so the window sits
at (0, 0) and page coordinates equal screen coordinates:
  xvfb-run -a -s "-screen 0 1380x860x24" python3 native/tests/linux-harness/ui.py WORK_FOLDER
Env: UI_ONLY=menus,context,highlight,...  (probe names as in ui-probes.js run())
     UI_ONLY=field-text runs the shared painted field text suite. Set GDK_SCALE and the
       X screen dimensions together to use a non-default backing scale.
     UI_TIMEOUT seconds (default 900)
     UI_APP_DIR path to an installed Waffle app directory (default: the source tree's app directory)
Prints PASS/FAIL/NOTE lines and "RESULT ok" or "RESULT <n> failed"; exit 1 on any failure,
2 when WebKitGTK 4.1, cairo or xdotool is missing."""
import json
import math
import os
import shutil
import subprocess
import sys
import threading
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]
MAC = ROOT / "native" / "tests" / "macos-harness"
APP = Path(os.environ.get("UI_APP_DIR", ROOT / "app")).resolve()
W, H = 1380, 860

try:
    import gi
    gi.require_version("Gtk", "3.0")
    gi.require_version("Gdk", "3.0")
    gi.require_version("GdkX11", "3.0")
    gi.require_version("WebKit2", "4.1")
    gi.require_version("JavaScriptCore", "4.1")
    from gi.repository import Gdk, GdkX11, GLib, Gtk, JavaScriptCore, WebKit2  # noqa: F401 (GdkX11 registers the X11 window type)
    import cairo
except (ImportError, ValueError) as error:
    print("SKIP  WebKitGTK UI probes: " + str(error))
    sys.exit(2)
if not shutil.which("xdotool"):
    print("SKIP  WebKitGTK UI probes: xdotool is not installed")
    sys.exit(2)

# ui-probes.js key names -> X keysyms; modifier names -> xdotool modifiers.
KEYS = {"ArrowRight": "Right", "ArrowLeft": "Left", "ArrowDown": "Down", "ArrowUp": "Up", "Enter": "Return",
        "Escape": "Escape", "Tab": "Tab", " ": "space", "F10": "F10", "Home": "Home", "End": "End"}
MODS = {"ctrl": "ctrl", "alt": "alt", "option": "alt", "shift": "shift", "cmd": "super", "meta": "super"}


class Probes:
    def __init__(self, work):
        self.work, self.shots = work, work / "shots"
        self.shots.mkdir(parents=True, exist_ok=True)
        self.failures, self.native_menus, self.done = 0, [], False
        manager = WebKit2.UserContentManager()
        manager.register_script_message_handler_with_reply("harness", None)
        manager.connect("script-message-with-reply-received::harness", self.on_message)
        self.view = WebKit2.WebView.new_with_user_content_manager(manager)
        self.view.get_settings().set_allow_file_access_from_file_urls(True)
        self.view.connect("context-menu", self.on_context_menu)
        self.view.connect("load-changed", self.on_load)
        self.window = Gtk.Window()
        self.window.set_decorated(False)
        self.window.set_default_size(W, H)
        self.window.move(0, 0)
        self.window.add(self.view)
        self.window.connect("destroy", Gtk.main_quit)
        self.window.show_all()
        self.xid, self.scale = None, 1

    # -------------------------------------------------------------- output (same format as harness.swift)
    @staticmethod
    def only_cmd_click(detail):
        """True when the net-highlight probe failed only for its ⌘+click cases. Linux has no ⌘:
        WebKitGTK reports metaKey only for GDK_META_MASK, and Super under X is not Meta, so that case
        cannot pass here; Ctrl+click and Alt+click (the Linux gestures) must still pass."""
        try:
            cases = json.loads(detail)
        except (TypeError, ValueError):
            return False
        bad = [k for k, v in cases.items() if isinstance(v, dict) and not v.get("ok")] if isinstance(cases, dict) else ["?"]
        return bool(bad) and all("cmd+click" in k for k in bad)

    def log(self, ok, name, detail=None):
        if not ok and name.startswith("Ctrl/\u2318+click") and self.only_cmd_click(detail):
            print("NOTE  known on Linux, not counted: " + name + " failed only for \u2318+click (no \u2318 key)", flush=True)
            ok = True
        text = "" if detail is None else "  — " + str(detail).replace("\n", " ")[:400]
        print(("PASS  " if ok else "FAIL  ") + name + text, flush=True)
        if not ok:
            self.failures += 1

    def note(self, text):
        print("NOTE  " + text, flush=True)

    # -------------------------------------------------------------- page lifecycle
    def on_load(self, view, event):
        if event != WebKit2.LoadEvent.FINISHED or self.xid:
            return
        self.xid = GdkX11.X11Window.get_xid(self.window.get_window())
        self.scale = self.view.get_scale_factor()
        self.xdo("windowfocus", "--sync", str(self.xid))
        self.note("WebKitGTK %d.%d.%d, GTK %d.%d" % (WebKit2.get_major_version(), WebKit2.get_minor_version(), WebKit2.get_micro_version(),
                                                    Gtk.get_major_version(), Gtk.get_minor_version()))
        only = os.environ.get("UI_ONLY", "")
        sources = ["field-text.js"] if only == "field-text" else ["css-audit.js", "ui-probes.js"]
        scripts = "\n;\n".join((MAC / name).read_text(encoding="utf-8") for name in sources)
        probe = "globalThis.__uiProbes.run(" + json.dumps(only) + ")"
        if only == "field-text":
            expected = os.environ.get("GDK_SCALE", str(self.scale))
            if expected != str(self.scale):
                self.log(False, "GTK uses the requested backing scale", f"expected {expected}, got {self.scale}")
                self.finish()
                return
            probe = (f"Promise.resolve().then(() => {{if (devicePixelRatio !== {self.scale}) "
                     "throw Error('WebKit backing scale differs from GTK'); "
                     f"return {probe};}})")
        run = (scripts + "\n;" + probe + ".then("
               "r=>webkit.messageHandlers.harness.postMessage({op:'done',result:r}),"
               "e=>webkit.messageHandlers.harness.postMessage({op:'done',error:String(e&&e.stack||e)}));true;")  # a Promise is not a valid result
        view.run_javascript(run, None, self.on_ran)

    def on_ran(self, view, task):
        try:
            view.run_javascript_finish(task)
        except GLib.Error as error:
            self.log(False, "probe script loads", error.message)
            self.finish()

    def finish(self):
        self.done = True
        print("RESULT " + ("ok" if self.failures == 0 else "%d failed" % self.failures), flush=True)
        Gtk.main_quit()

    # -------------------------------------------------------------- the "harness" message handler
    def on_message(self, manager, value, reply):
        try:
            args = json.loads(value.to_json(0) or "{}")
        except (TypeError, ValueError):
            args = {}
        ctx = value.get_context()

        def answer(result):
            reply.return_value(JavaScriptCore.Value.new_from_json(ctx, json.dumps(result)))
            return False

        op = args.get("op", "")
        if op in ("mouse", "key"):
            # xdotool blocks; run it off the GTK thread so WebKit keeps processing the events.
            def work():
                try:
                    self.mouse(args) if op == "mouse" else self.key(args)
                except subprocess.SubprocessError as error:
                    GLib.idle_add(self.log, False, "dispatch X input", str(error))
                    GLib.idle_add(answer, False)
                else:
                    GLib.idle_add(answer, True)
            threading.Thread(target=work, daemon=True).start()
        elif op in ("shot", "pixels", "ink-raster"):
            self.view.get_snapshot(WebKit2.SnapshotRegion.VISIBLE, WebKit2.SnapshotOptions.NONE, None,
                                   lambda view, task: answer(self.snapshot_done(op, args, view, task)))
        else:
            answer(self.handle(op, args))
        return True

    def handle(self, op, a):
        if op == "log":
            self.log(a.get("ok") is True, a.get("name", "?"), a.get("detail"))
        elif op == "note":
            self.note(a.get("text", ""))
        elif op == "nativeMenus":
            menus, self.native_menus = self.native_menus, []
            return menus
        elif op == "save":
            (self.work / Path(a.get("name", "out.txt")).name).write_text(a.get("text", ""), encoding="utf-8")
        elif op == "ink-raster-scale":
            # GTK sets the backing scale before the window is created. The two
            # fixed scale runs use matching Xvfb dimensions and GDK_SCALE.
            return a.get("scale") in (0, self.scale)
        elif op == "cssSources":
            sys.path.insert(0, str(ROOT / "scripts"))
            from asset_files import app_source_files
            return {p.relative_to(APP).as_posix(): p.read_text(encoding="utf-8")
                    for p in app_source_files(APP, "*.css")}
        elif op == "focusWindow":
            self.window.present()
            self.xdo("windowfocus", "--sync", str(self.xid))
            return {"key": self.window.is_active(), "active": self.window.has_toplevel_focus(), "visible": self.window.is_visible()}
        elif op == "done":
            if a.get("error"):
                self.log(False, "probe script ran to the end", a["error"])
            else:
                self.note("probe summary: " + json.dumps(a.get("result")))
            GLib.idle_add(self.finish)
        else:
            return "unknown op " + op
        return True

    def on_context_menu(self, view, menu, *rest):
        # The page did not call preventDefault: WebKitGTK would open its own menu. Record, suppress.
        titles = [item.get_action().get_label() if item.get_action() else "" for item in menu.get_items()]
        self.native_menus.append("|".join(t for t in titles if t)[:200] or "(menu)")
        return True

    # -------------------------------------------------------------- input through XTEST
    @staticmethod
    def xdo(*args):
        subprocess.run(["xdotool", *args], check=True, timeout=10)

    def mods(self, a):
        return [MODS[m] for m in a.get("mods") or [] if m in MODS]

    def mouse(self, a):
        x, y = (str(round(a.get(axis, 0) * self.scale)) for axis in ("x", "y"))
        button = "3" if a.get("button") == "right" else "1"
        kind, clicks, mods = a.get("kind", "click"), max(1, int(a.get("clicks") or 1)), self.mods(a)
        if kind in ("move", "click", "down"):
            # X does not emit motion when the pointer is already at the click location.
            self.xdo("mousemove", x, y); time.sleep(0.06)
        if mods:
            self.xdo("keydown", *mods)
        if kind == "click":
            self.xdo("click", "--repeat", str(clicks), "--delay", "40", button)
        elif kind == "down":
            self.xdo("mousedown", button)
        elif kind == "drag":
            self.xdo("mousemove", x, y)
        elif kind == "up":
            self.xdo("mouseup", button)
        time.sleep(0.05)
        if mods:
            self.xdo("keyup", *mods)
        time.sleep(0.08)

    def key(self, a):
        name = a.get("key", "")
        sym = KEYS.get(name) or (name if len(name) == 1 and name.isalnum() else None)
        if not sym:
            GLib.idle_add(self.note, "no key code for " + name)
            return
        # The probe owns this X display. Clearing modifiers would also release a held mouse button.
        self.xdo("key", "+".join(self.mods(a) + [sym]))
        time.sleep(0.13)

    # -------------------------------------------------------------- snapshots
    def snapshot_done(self, op, a, view, task):
        try:
            surface = view.get_snapshot_finish(task)
        except GLib.Error as error:
            return {"error": error.message}
        if op == "ink-raster":
            return ink_raster(surface, a.get("regions", []), a.get("scale"),
                              (self.view.get_allocated_width(), self.view.get_allocated_height()))
        if op == "shot":
            surface.write_to_png(str(self.shots / (Path(a.get("name", "shot")).name + ".png")))
            return True
        return self.pixels(surface, *(round(a.get(k, 0)) for k in ("x", "y", "w", "h")))

    @staticmethod
    def pixels(surface, x, y, w, h):
        # Same statistic as ui-probes.swift: share of pixels differing from the corner (background)
        # pixel, and the number of distinct colours (5 bits per channel).
        image = cairo.ImageSurface(cairo.FORMAT_ARGB32, max(w, 1), max(h, 1))
        cr = cairo.Context(image)
        cr.set_source_surface(surface, -x, -y)
        cr.paint()
        image.flush()
        data, stride = image.get_data(), image.get_stride()
        if w <= 0 or h <= 0:
            return {"error": "empty"}

        def rgb(px, py):
            o = py * stride + px * 4
            return data[o + 2] / 255, data[o + 1] / 255, data[o] / 255  # BGRA in memory (little-endian)
        bg, differ, colours = rgb(0, 0), 0, set()
        for py in range(h):
            for px in range(w):
                c = rgb(px, py)
                if sum(abs(c[i] - bg[i]) for i in range(3)) > 0.12:
                    differ += 1
                colours.add(int(c[0] * 31) << 10 | int(c[1] * 31) << 5 | int(c[2] * 31))
        return {"share": differ / (w * h), "colours": len(colours), "w": w, "h": h}


def ink_raster(surface, regions, scale, viewport):
    """Read actual backing pixels in GTK's BGRA image, with the shared mask reply contract."""
    if scale not in (1, 2) or len(regions) != 2:
        return {"error": "expected two masks at 1× or 2×"}
    expected = [edge * scale for edge in viewport]
    actual = [surface.get_width(), surface.get_height()]
    if actual != expected:
        return {"error": "wrong backing size", "actual": actual, "expected": expected}
    surface.flush()
    data, stride = surface.get_data(), surface.get_stride()
    has_alpha = surface.get_format() != cairo.FORMAT_RGB24

    def luminance(r, g, b):
        return .2126 * r + .7152 * g + .0722 * b

    masks = []
    for region in regions:
        x, y, width, height = region["rect"]
        if not (x >= 0 and y >= 0 and width > 0 and height > 0
                and x + width <= viewport[0] and y + height <= viewport[1]):
            return {"error": "invalid or offscreen text mask"}
        left, right = math.floor(x * scale), math.ceil((x + width) * scale)
        top, bottom = math.floor(y * scale), math.ceil((y + height) * scale)
        histogram = [0] * 256
        pixels = []
        for row in range(top, bottom):
            for col in range(left, right):
                offset = row * stride + col * 4
                b, g, r, a = data[offset:offset + 4]
                if has_alpha and a < 250:
                    continue
                value = luminance(r, g, b)
                histogram[round(value)] += 1
                pixels.append((row, value))
        ink = luminance(*region["ink"])
        background = max(range(256), key=histogram.__getitem__)
        contrast = abs(ink - background)
        direction = 1 if ink > background else -1
        rows = [row for row, value in pixels if (value - background) * direction > contrast / 4]
        masks.append({"first": min(rows, default=-1), "last": max(rows, default=-1),
                      "count": len(rows), "contrast": contrast})
    return {"scale": scale, "masks": masks}


def main():
    work = Path(sys.argv[1] if len(sys.argv) > 1 else os.environ.get("TMPDIR", "/tmp") + "/atrium-ui-gtk").resolve()
    work.mkdir(parents=True, exist_ok=True)
    probes = Probes(work)

    def timeout():
        probes.log(False, "probes finished within UI_TIMEOUT")
        probes.finish()
    GLib.timeout_add_seconds(int(os.environ.get("UI_TIMEOUT", "900")), timeout)
    probes.view.load_uri((APP / "index.html").as_uri())
    Gtk.main()
    if not probes.done:
        print("RESULT window closed before the probes finished", flush=True)
        return 1
    return 0 if probes.failures == 0 else 1


if __name__ == "__main__":
    sys.exit(main())
