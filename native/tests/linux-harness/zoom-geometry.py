#!/usr/bin/env python3
"""Verify a packaged GTK editor under Xvfb. Exit 0 pass, 1 gate, 2 unavailable."""
import argparse
import base64
import importlib.util
import io
import json
import math
import os
from pathlib import Path
import shutil
import sys
import tempfile
import threading
import time
import traceback

try:
    import cairo
    import gi

    from package import GLib, Gtk, Probe, WebKit2, wait_for, xdo

    gi.require_version("JavaScriptCore", "4.1")
    from gi.repository import JavaScriptCore
except (ImportError, ValueError) as error:
    print(f"SKIP GTK zoom geometry: {error}", file=sys.stderr)
    sys.exit(2)

ROOT = Path(__file__).resolve().parents[3]
OBSERVE_WHEEL = """
  globalThis.__gtkZoomWheel = [];
  addEventListener("wheel", event => {
    const canvas = globalThis.AtriumNavHost?.canvas();
    if (event.isTrusted && canvas && event.composedPath().includes(canvas))
      __gtkZoomWheel.push({ctrl:event.ctrlKey, shift:event.shiftKey, x:event.deltaX, y:event.deltaY});
  }, {capture:true, passive:true});
"""


class Geometry(Probe):
    def focus_board(self, window):
        wait_for("PCB document loaded by the native host", lambda: self.js(window, """
          const H = globalThis.AtriumNavHost;
          return !window.__atriumOpeningProject && H?.project()?.documents.some(d => d.kind === 'pcb' && d.items.length > 10);
        """))
        assert self.js(window, """
          const H = AtriumNavHost, board = H.project().documents.find(d => d.kind === 'pcb');
          for (const report of document.querySelectorAll('.import-report[data-view]'))
            document.querySelector('.view-tab[data-view="' + CSS.escape(report.dataset.view) + '"] .view-tab-close')?.click();
          const tab = document.querySelector('[data-tab="' + CSS.escape(board.id) + '"]');
          if (!tab) return false;
          tab.click();
          return true;
        """), "The imported PCB has no document tab."

        def hit():
            return self.js(window, """
              const canvas = AtriumNavHost.canvas(), r = canvas.getBoundingClientRect();
              const x = r.left + r.width * .48, y = r.top + r.height * .46;
              return document.elementFromPoint(x,y) === canvas ? [x,y,devicePixelRatio] : null;
            """)

        return wait_for("active PCB receives pointer input", hit)

    def trusted_wheel(self, window, point):
        x, y, scale = point
        self.focus(window)
        view = window.get_child()
        self.on_gtk(view.grab_focus)
        offset = self.on_gtk(lambda: view.translate_coordinates(window, 0, 0))
        _, origin_x, origin_y = self.on_gtk(lambda: window.get_window().get_origin())
        xdo("mousemove", round((x + offset[0] + origin_x) * scale),
            round((y + offset[1] + origin_y) * scale))
        self.js(window, """
          dispatchEvent(new CustomEvent('atrium-command', {detail:'fit'}));
          window.__gtkZoomWheel.length = 0;
          return true;
        """)

        def state():
            return self.js(window, "return {camera:AtriumNavHost.view().camera(), wheel:window.__gtkZoomWheel};")

        def gesture(button, key, count, accepted):
            xdo("keydown", key)
            try:
                xdo("click", "--repeat", 3, "--delay", 45, button)
            finally:
                xdo("keyup", key)

            try:
                return steady_camera(count, accepted)
            except AssertionError as error:
                raise AssertionError(f"Starting camera {start}: {error}") from error

        def steady_camera(count, accepted):
            last = None
            steady_since = time.monotonic()

            def ready():
                nonlocal last, steady_since
                sample = state()
                current = sample["camera"]
                if current != last:
                    last, steady_since = current, time.monotonic()
                if len(sample["wheel"]) == count and accepted(current) and time.monotonic() - steady_since >= .4:
                    return current

            try:
                return wait_for("the expected camera to settle", ready, timeout=8)
            except AssertionError as error:
                raise AssertionError(f"{error}. Expected {count} trusted wheels, observed {state()}") from error

        start = steady_camera(0, lambda c: c["scale"] > 0)

        def residual(camera):
            return math.hypot(camera["cx"] - start["cx"], camera["cy"] - start["cy"]) * start["scale"]

        zoom = gesture(4, "Control_L", 3, lambda c: c["scale"] > start["scale"] * 1.5)
        back = gesture(5, "Control_L", 6, lambda c: residual(c) <= 1.5 and
                       math.isclose(c["scale"], start["scale"], rel_tol=1e-5))
        pan = gesture(4, "Shift_L", 9, lambda c: residual(c) > 10)
        end = gesture(5, "Shift_L", 12, lambda c: residual(c) <= 1.5)
        received = state()["wheel"]
        assert all(event["ctrl"] and not event["shift"] for event in received[:6]), received
        assert all(event["shift"] and not event["ctrl"] for event in received[6:]), received
        assert all(event["y"] < 0 for event in received[:3]) and all(event["y"] > 0 for event in received[3:6]), received
        assert all((event["x"] or event["y"]) < 0 for event in received[6:9]), received
        assert all((event["x"] or event["y"]) > 0 for event in received[9:]), received
        assert math.isclose(end["scale"], start["scale"], rel_tol=1e-5), end
        print(f"PASS trusted zoom and pan reversal ({residual(pan):.2f} px pan, {residual(end):.2f} px remaining)")
        return {"fit":start, "zoom":zoom, "zoomBack":back, "pan":pan, "panBack":end, "wheel":received}

    def add_snapshot_api(self, window):
        view = window.get_child()
        manager = view.get_user_content_manager()
        assert manager.register_script_message_handler_with_reply("zoomGeometry", None)

        def capture(_manager, value, reply):
            clip = json.loads(value.to_json(0))

            def completed(view, task, _):
                try:
                    paint = view.get_snapshot_finish(task)
                    scale = view.get_scale_factor()
                    width, height = clip["width"], clip["height"]
                    if (paint.get_width(), paint.get_height()) != (
                        view.get_allocated_width() * scale, view.get_allocated_height() * scale
                    ):
                        raise RuntimeError("WebKit snapshot does not match the window backing scale.")
                    paint.set_device_scale(scale, scale)
                    tile = cairo.ImageSurface(cairo.FORMAT_ARGB32, width * scale, height * scale)
                    tile.set_device_scale(scale, scale)
                    context = cairo.Context(tile)
                    context.set_source_surface(paint, -clip["x"], -clip["y"])
                    context.paint()
                    output = io.BytesIO()
                    tile.write_to_png(output)
                    data = {"source":"webkitgtk-snapshot", "png":base64.b64encode(output.getvalue()).decode()}
                    reply.return_value(JavaScriptCore.Value.new_from_json(value.get_context(), json.dumps(data)))
                except Exception as error:
                    reply.return_error_message(str(error))

            view.get_snapshot(WebKit2.SnapshotRegion.VISIBLE, WebKit2.SnapshotOptions.NONE, None, completed, None)
            return True

        manager.connect("script-message-with-reply-received::zoomGeometry", capture)

    def select_renderer(self, window, use_software):
        self.begin(window, """(async forced => {
          await AtriumLazy.need(['AtriumPrefs', 'AtriumCanvasGPUPref', 'AtriumCanvasGPU']);
          if (forced) AtriumPrefs.set(AtriumCanvasGPUPref.key, "gpu");
          AtriumCanvasGPU.enable(null);
          AtriumNavHost.redraw(true);
          await new Promise(resolve => setTimeout(resolve, 450));
          return AtriumCanvasGPUPref.decision();
        })(""" + json.dumps(use_software) + ")")
        reply = self.result(window, "editor renderer preference")
        if "error" in reply:
            raise RuntimeError(reply["error"])
        choice = reply["value"]
        assert choice["mode"] == ("gpu" if use_software else "auto"), choice
        if use_software and not choice["use"]:
            raise RuntimeError("The WebKitGTK guest does not expose software WebGL2.")
        return choice

    def probe_geometry(self, window, args, choice):
        renderers = ["gpu"] if args.software_webgl else ["gpu", "2d"] if choice["use"] else ["2d"]
        if args.one_frame and "gpu" not in renderers:
            raise RuntimeError("The established omission control needs WebGL2. Try --software-webgl.")
        if args.presented:
            self.on_gtk(lambda: self.add_snapshot_api(window))
        script = (ROOT / "tests/canvas/zoom-geometry-probe.js").read_text()
        self.js(window, script + "\nreturn true;")
        options = {"renderers":renderers, "warmGPU":True, "presentationOnly":args.presented}
        if args.one_frame:
            options.update(cases=["all"], mutations=["one-frame"])
        else:
            options["nativeBoard"] = args.board.name
        self.begin(window, """(async options => {
          const h = window.webkit?.messageHandlers?.zoomGeometry;
          return atriumZoomGeometry({...options, screen:h ? clip => h.postMessage(clip) : undefined});
        })(""" + json.dumps(options) + ")")
        reply = self.result(window, "shared PCB geometry", timeout=220)
        if "error" in reply:
            raise RuntimeError(reply["error"])
        backend = "Mesa software WebGL2 requested" if args.software_webgl else "Automatic"
        return {"result":reply["value"], "rendererPreference":choice, "requestedRenderers":renderers,
                "backend":backend, "hardwareVerified":False,
                "webkitgtk":[WebKit2.get_major_version(), WebKit2.get_minor_version(), WebKit2.get_micro_version()]}


def checks(receipt, args):
    result = receipt["result"]
    if result["dpr"] != 2:
        raise RuntimeError(f"Expected 2× WebKit backing, observed {result['dpr']}.")
    statuses = [board["renders"] for board in result["boards"].values()]
    assert statuses, "No board was measured."
    if args.one_frame:
        rows = result["boards"]["synthetic"]["renders"]["gpu"]
        hit = [frame for row in rows for frame in row["frames"] if frame.get("mutated")]
        if len(hit) != 1 or not hit[0]["moving"] or not hit[0]["loss"]["track"]["loss"]:
            raise RuntimeError(f"The deliberate omission did not damage one moving track frame: {hit}")
        if {failure[3] for failure in result["failures"]} != {hit[0]["n"]} or result["rendererErrors"]:
            raise RuntimeError("The omission control produced unrelated failures.")
        print("PASS deliberate moving-frame omission detected")
        return 1
    for name in (args.board.name, "synthetic"):
        modes = result["boards"][name]["renders"]
        for renderer in receipt["requestedRenderers"]:
            rows = modes[renderer]
            assert isinstance(rows, list), f"{name}/{renderer}: {rows}"
            frames = [frame for row in rows for frame in row["screens" if args.presented else "frames"]]
            assert any(frame["moving"] for frame in frames), f"No moving {name}/{renderer} sample."
    assert not result["rendererErrors"] and not result["failures"], result["failures"] + result["rendererErrors"]
    print("PASS presented PCB geometry" if args.presented else "PASS moving PCB geometry")
    return 0


def run(args, probe):
    def mapped():
        return probe.on_gtk(lambda: next((w for w in probe.editors() if w.get_mapped()), None))

    window = wait_for("packaged GTK editor", mapped, timeout=45)
    if args.one_frame:
        wait_for("Start Page", lambda: probe.js(window, 'return !!document.querySelector("dialog.sp-dialog[open]");'))
        probe.js(window, 'document.querySelector("[data-start-action=demo]").click(); return true;')
        wait_for("starter PCB", lambda: probe.js(window, 'return AtriumNavHost.doc()?.kind === "pcb";'))
        point = None
    else:
        point = probe.focus_board(window)
    choice = probe.select_renderer(window, args.software_webgl)
    trusted = probe.trusted_wheel(window, point) if point else None
    receipt = probe.probe_geometry(window, args, choice)
    receipt["trustedInput"] = trusted
    args.report.write_text(json.dumps(receipt, indent=2) + "\n")
    return checks(receipt, args)


def main():
    cli = argparse.ArgumentParser(description=__doc__)
    cli.add_argument("package", type=Path, help="installed or extracted usr/share/waffle")
    cli.add_argument("report", type=Path)
    cli.add_argument("--board", type=Path, default=ROOT / "tests/fixtures/import/demo.kicad_pcb")
    cli.add_argument("--software-webgl", action="store_true", help="use normal GPU preference and Mesa llvmpipe")
    mode = cli.add_mutually_exclusive_group()
    mode.add_argument("--presented", action="store_true", help="verify the compositor in a separate lightweight replay")
    mode.add_argument("--one-frame", action="store_true", help="expect one synthetic moving WebGL2 frame to be rejected")
    args = cli.parse_args()
    if os.getuid() == 0 or not os.environ.get("DISPLAY") or not shutil.which("xdotool"):
        cli.error("Run as an unprivileged user with an X display and xdotool.")
    source = args.package.resolve() / "native/linux/waffle.py"
    if not source.is_file():
        cli.error("The package needs its installed native Linux launcher.")
    if not args.one_frame and not args.board.is_file():
        cli.error("The public board does not exist.")
    if args.software_webgl:
        os.environ.update(LIBGL_ALWAYS_SOFTWARE="1", GALLIUM_DRIVER="llvmpipe")
    args.report.parent.mkdir(parents=True, exist_ok=True)
    spec = importlib.util.spec_from_file_location("packaged_waffle", source)
    host = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(host)
    create = host.create_editor_window

    def observe(*values, **named):
        app = values[8]

        def window_added(_app, window):
            def child_added(_window, child):
                if isinstance(child, WebKit2.WebView):
                    child.get_user_content_manager().add_script(WebKit2.UserScript.new(
                        OBSERVE_WHEEL, WebKit2.UserContentInjectedFrames.TOP_FRAME,
                        WebKit2.UserScriptInjectionTime.START, None, None))
            window.connect("add", child_added)

        handler = app.connect("window-added", window_added)
        try:
            return create(*values, **named)
        finally:
            app.disconnect(handler)

    host.create_editor_window = observe
    with tempfile.TemporaryDirectory(prefix="waffle-gtk-zoom-") as temp:
        work = Path(temp)
        for key in ("HOME", "XDG_DATA_HOME", "XDG_CONFIG_HOME", "XDG_CACHE_HOME"):
            folder = work / key.lower()
            folder.mkdir()
            os.environ[key] = str(folder)
        probe = Geometry(work, host)
        result = []

        def stop():
            for window in probe.editors():
                window.destroy()
            return False

        def exercise():
            try:
                result.append(run(args, probe))
            except AssertionError:
                traceback.print_exc()
                result.append(1)
            except Exception:
                traceback.print_exc()
                result.append(2)
            finally:
                GLib.idle_add(stop)

        thread = threading.Thread(target=exercise, daemon=True)
        thread.start()
        sys.argv = [str(source)]
        if not args.one_frame:
            sys.argv.append(str(args.board.resolve()))
        status = host.main()
        thread.join(timeout=5)
        return result[0] if status == 0 and result else 2


if __name__ == "__main__":
    sys.exit(main())
