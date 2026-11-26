import Cocoa
import WebKit

// AppKit has no public factory for magnification NSEvents. WebKit receives these
// through its NSResponder and produces the same trusted DOM GestureEvents.
final class ProbeMagnification: NSEvent {
    var step: NSEvent.Phase = []
    var amount: CGFloat = 0
    var position: NSPoint = .zero
    weak var target: NSWindow?
    override var type: NSEvent.EventType { .magnify }
    override var phase: NSEvent.Phase { step }
    override var magnification: CGFloat { amount }
    override var locationInWindow: NSPoint { position }
    override var window: NSWindow? { target }
    override var windowNumber: Int { target?.windowNumber ?? 0 }
    override var timestamp: Double { ProcessInfo.processInfo.systemUptime }
    override var modifierFlags: NSEvent.ModifierFlags { [] }
}

// Direct touches from a touch display reach AppKit only as NSTouch objects handed to gesture recognizers;
// AppKit has no public factory for them. These carry what DirectTouchRecognizer reads.
private final class ProbeTouch: NSTouch {
    let key: NSString, step: NSTouch.Phase, at: NSPoint
    init(_ key: NSString, _ step: NSTouch.Phase, _ at: NSPoint) { self.key = key; self.step = step; self.at = at; super.init() }
    override var identity: NSCopying & NSObjectProtocol { key }
    override var phase: NSTouch.Phase { step }
    override var type: NSTouch.TouchType { .direct }
    override func location(in view: NSView?) -> NSPoint { view?.convert(at, from: nil) ?? at }
}
private final class ProbeTouchEvent: NSEvent {
    var touchSet: Set<NSTouch> = []
    weak var target: NSWindow?
    override var type: NSEvent.EventType { .directTouch }
    override var window: NSWindow? { target }
    override var timestamp: Double { ProcessInfo.processInfo.systemUptime }
    override func touches(matching phase: NSTouch.Phase, in view: NSView?) -> Set<NSTouch> { touchSet.filter { phase.contains($0.phase) } }
    override func allTouches() -> Set<NSTouch> { touchSet }
}

// WebKit UI probes (HARNESS_SUITE=ui, run by ui.sh). The probe script ui-probes.js runs in the page
// and asks this side, through a harness-only message handler, for what page code cannot do itself:
// real AppKit mouse and key events (so WebKit's own event pipeline produces the DOM events, with
// isTrusted, modifiers, ctrl-click and contextmenu as a user would get them), snapshots, pixel
// statistics of a page rectangle, and a check that no native WebKit context menu opened.
// Test-only: the handler is added by the harness process; the shipping app never has it.
@MainActor final class UIProbes: NSObject, WKScriptMessageHandlerWithReply {
    let h: Harness
    var eventNumber = 1
    var nativeMenus: [String] = []
    var privateTour = false
    var observer: NSObjectProtocol?
    init(_ h: Harness) { self.h = h }
    lazy var energy = EnergyProbes(h)
    lazy var feel = NativeFeel(self)
    private lazy var gpuProcessRestart = GPUProcessRestart(self)
    func setOcclusionDetection(_ on: Bool) {
        let occlusion = NSSelectorFromString("_setWindowOcclusionDetectionEnabled:")
        if web.responds(to: occlusion) {
            typealias SetBool = @convention(c) (AnyObject, Selector, Bool) -> Void
            unsafeBitCast(web.method(for: occlusion), to: SetBool.self)(web, occlusion, on)
        }
    }
    var web: WKWebView { h.d.web }
    var window: NSWindow { h.d.window }
    var shots: URL { work.appendingPathComponent("shots") }

    func run() async {
        // A native NSMenu that begins tracking while the probes run is WebKit's own context menu
        // (the page did not call preventDefault). Record it and dismiss it so the run continues.
        observer = NotificationCenter.default.addObserver(forName: NSMenu.didBeginTrackingNotification, object: nil, queue: .main) { [weak self] n in
            guard let menu = n.object as? NSMenu else { return }
            MainActor.assumeIsolated {
                guard let self = self, menu !== NSApp.mainMenu, menu.supermenu == nil || menu.supermenu !== NSApp.mainMenu else { return }
                self.nativeMenus.append(menu.items.map { $0.title }.filter { !$0.isEmpty }.prefix(6).joined(separator: "|"))
                menu.cancelTrackingWithoutAnimation()
            }
        }
        web.configuration.userContentController.addScriptMessageHandler(self, contentWorld: .page, name: "harness")
        window.setContentSize(NSSize(width: 1380, height: 860))
        // The terminal that runs the harness stays the active app, so this window may sit behind
        // it. WebKit throttles painting and animation frames in an occluded window; its testing
        // switch keeps the page rendering (canvas, snapshots) as in a visible window.
        setOcclusionDetection(false)
        if ProcessInfo.processInfo.environment["HARNESS_BACKGROUND"] == "1" {
            window.orderFrontRegardless()
        } else {
            window.orderOut(nil)
            window.orderFrontRegardless()
            window.makeKeyAndOrderFront(nil)
            NSApp.activate(ignoringOtherApps: true)
        }
        window.makeFirstResponder(web)
        // Match the page's editor gate to the test window's WebKit occlusion override.
        _ = await h.js("globalThis.AtriumPower?.host({occluded: false}); return true")
        if let path = ProcessInfo.processInfo.environment["HARNESS_OPEN_PROJECT"] {
            let project = URL(fileURLWithPath: path)
            h.d.application(NSApp, openFiles: [project.path])
            guard await h.until(25, { await self.h.truthy("return AtriumHost.projectPath === path || AtriumHost.historyPath === name || AtriumNavHost.folderProject?.()?.manifestPath === name", ["path": canon(project), "name": project.lastPathComponent]) }) else {
                h.log(false, "the scratch project opened through the desktop host"); return
            }
        }
        let webkit = Bundle(for: WKWebView.self)
        h.note("WebKit.framework \(webkit.infoDictionary?["CFBundleVersion"] as? String ?? "?") (\(webkit.infoDictionary?["CFBundleShortVersionString"] as? String ?? "?")), macOS \(ProcessInfo.processInfo.operatingSystemVersionString)")
        // The 60 fps pacing preference the app turns off (Desktop.unpinFrameRate): its state in this web view.
        do {
            let list = NSSelectorFromString("_features"), get = NSSelectorFromString("_isEnabledForFeature:"), prefs = web.configuration.preferences
            let type: AnyObject = WKPreferences.self
            if type.responds(to: list), prefs.responds(to: get), let features = type.perform(list)?.takeUnretainedValue() as? [NSObject],
               let f = features.first(where: { ($0.value(forKey: "key") as? String) == "PreferPageRenderingUpdatesNear60FPSEnabled" }) {
                typealias GetFeature = @convention(c) (AnyObject, Selector, AnyObject) -> Bool
                h.note("Prefer Page Rendering Updates near 60fps: \(unsafeBitCast(prefs.method(for: get), to: GetFeature.self)(prefs, get, f) ? "on (rAF paced near 60 Hz)" : "off (rAF follows the display)")")
            } else { h.note("Prefer Page Rendering Updates near 60fps: not found in this WebKit") }
        }
        var scripts: [String] = []
        for path in (ProcessInfo.processInfo.environment["HARNESS_PROBES"] ?? "").split(separator: ":") {
            guard let text = try? String(contentsOfFile: String(path), encoding: .utf8) else { h.log(false, "probe script readable", path); return }
            scripts.append(text)
        }
        if scripts.isEmpty { h.log(false, "HARNESS_PROBES names the probe scripts"); return }
        // UI_ONLY=menus,dialogs runs only those probes (names as in ui-probes.js run()).
        var arguments: [String: Any] = ["only": ProcessInfo.processInfo.environment["UI_ONLY"] ?? "", "input": NSNull()]
        if ProcessInfo.processInfo.environment["HARNESS_INPUT_STDIN"] != nil {
            // Revision bytes arrive over an anonymous pipe. A private tour never creates a source or output file.
            guard let input = try? JSONSerialization.jsonObject(with: FileHandle.standardInput.readDataToEndOfFile()) as? [String: Any] else {
                h.log(false, "tour input is valid JSON"); return
            }
            privateTour = input["private"] as? Bool == true
            if privateTour {
                guard !web.configuration.websiteDataStore.isPersistent else { h.log(false, "private tour requires an ephemeral website store"); return }
                window.isRestorable = false; window.sharingType = .none
            }
            arguments["input"] = input
        }
        let result = await h.js(scripts.joined(separator: "\n;\n") + "\nreturn await globalThis.__uiProbes.run(only, input);", arguments)
        if let s = result as? String, s.hasPrefix("JSERROR") { h.log(false, "probe script ran to the end", s) }
        else { h.note("probe summary: \(result ?? "nil")") }
        if let o = observer { NotificationCenter.default.removeObserver(o) }
        // The probes edited the project (a placed power port, undone): close without the unsaved-changes alert.
        _ = await h.js("globalThis.AtriumHost?.setDirty?.(false); return true")
        window.isDocumentEdited = false
    }

    func userContentController(_ ucc: WKUserContentController, didReceive message: WKScriptMessage,
                               replyHandler: @escaping @MainActor @Sendable (Any?, String?) -> Void) {
        let args = message.body as? [String: Any] ?? [:]
        let op = args["op"] as? String ?? ""
        Task { @MainActor in
            if op.hasPrefix("gpu-process-") && !self.gpuProcessRestart.accepts(message) {
                replyHandler(nil, "The GPU recovery operation is confined to the dedicated local harness.")
                return
            }
            let reply = await self.handle(op, args)
            replyHandler(reply, nil)
        }
    }

    func handle(_ op: String, _ a: [String: Any]) async -> Any {
        let num = { (k: String) in (a[k] as? NSNumber)?.doubleValue ?? 0 }
        switch op {
        case "feel-state": return feel.state()
        case "feel-input": return await feel.input(a)
        case "feel-ack": return await feel.acknowledgement()
        case "gpu-process-state": return gpuProcessRestart.state()
        case "gpu-process-exit": return gpuProcessRestart.exitGPU((a["pid"] as? NSNumber)?.int32Value ?? 0)
        case "gpu-process-snapshot": return await gpuProcessRestart.capture(a)
        case "log": h.log(a["ok"] as? Bool == true, a["name"] as? String ?? "?", a["detail"].flatMap { $0 is NSNull ? nil : $0 }); return true
        case "note": h.note(a["text"] as? String ?? ""); return true
        case "mouse":
            await mouse(num("x"), num("y"), button: a["button"] as? String ?? "left", mods: a["mods"] as? [String] ?? [],
                        kind: a["kind"] as? String ?? "click", clicks: Int(num("clicks")) == 0 ? 1 : Int(num("clicks")))
            return true
        case "notebook-fixture-clipboard":
            guard NotebookFixtureClipboard.isEnabled else {return false}
            let png = a["png"] as? String
            guard let text = png ?? (a["pdf"] as? String), text.utf8.count<65536,
                  let data=Data(base64Encoded:text) else {return false}
            if png != nil {
                guard data.starts(with:[137,80,78,71,13,10,26,10]) else {return false}
            } else if !data.starts(with:"%PDF-".utf8) {return false}
            NotebookFixtureClipboard.board.clearContents()
            return NotebookFixtureClipboard.board.setData(data,forType:png == nil ? .pdf : .png)
        case "key": await key(a["key"] as? String ?? "", mods: a["mods"] as? [String] ?? []); return true
        case "other": await other(num("x"), num("y"), button: Int(num("button")) == 0 ? 3 : Int(num("button"))); return true
        case "wheel": await wheel(num("x"), num("y"), dx: Int32(num("dx")), dy: Int32(num("dy")), pixels: a["pixels"] as? Bool == true); return true
        case "magnify":
            let e = ProbeMagnification()
            switch a["phase"] as? String {
            case "begin": e.step = .began
            case "change": e.step = .changed
            case "end": e.step = .ended
            case "cancel": e.step = .cancelled
            default: return false
            }
            e.amount = num("amount"); e.position = point(num("x"), num("y")); e.target = window
            web.magnify(with: e)
            return true
        case "path":
            // A continuous drag at a real input rate: down at the first point, a dragged event every `ms`
            // milliseconds through the rest, up at the last (each optional: down/up false).
            let pts = (a["points"] as? [[NSNumber]] ?? []).map { point($0[0].doubleValue, $0[1].doubleValue) }
            await path(pts, right: a["button"] as? String == "right", ms: num("ms") > 0 ? num("ms") : 8,
                       down: a["down"] as? Bool != false, up: a["up"] as? Bool != false)
            return true
        case "subtypePath":
            // A left drag whose AppKit events carry an NSEvent subtype (0 mouse, 1 tablet point, 3 touch), as a
            // touchscreen digitiser driver delivers them. Built through CGEvent so the subtype is the real field.
            let pts = (a["points"] as? [[NSNumber]] ?? []).map { point($0[0].doubleValue, $0[1].doubleValue) }
            // touchDisplay: as on a Mac with a touch display, where a finger's emulated mouse has no button down.
            EditorWebView.assumeTouchDisplay = a["touchDisplay"] as? Bool == true
            await subtypePath(pts, subtype: Int64(num("subtype")), ms: num("ms") > 0 ? num("ms") : 8, hold: num("hold"))
            EditorWebView.assumeTouchDisplay = false
            return true
        case "directTouches":
            // Fingers on a touch display: frames of [[finger, x, y], ...] (page px), each finger beginning in the
            // first frame it appears and ending after the last, delivered to the web view's DirectTouchRecognizer.
            // emulate: also send AppKit's emulated one-finger mouse stream for finger 0 (no button down).
            // webkit: as macOS 27 WebKit does on a touch display (its own WKAppKitGestureController recognizers),
            // also turn the same fingers into DOM mouse events (finger 0) and Safari gesture events (a pinch),
            // at the same time and place, without passing the host's mouse handling. mouseFirst: the mouse
            // reaches the page before the forwarded touch in each frame.
            guard let web = web as? EditorWebView else { return false }
            let frames = (a["frames"] as? [[[NSNumber]]] ?? []).map { $0.map { (Int(truncating: $0[0]), point($0[1].doubleValue, $0[2].doubleValue)) } }
            let emulate = a["emulate"] as? Bool == true, ms = num("ms") > 0 ? num("ms") : 12
            let webkit = a["webkit"] as? Bool == true, mouseFirst = a["mouseFirst"] as? Bool == true
            func webkitMouse(_ t: NSEvent.EventType, _ at: NSPoint) {
                guard webkit, let e = NSEvent.mouseEvent(with: t, location: at, modifierFlags: [], timestamp: ProcessInfo.processInfo.systemUptime, windowNumber: window.windowNumber,
                                                         context: nil, eventNumber: 0, clickCount: 1, pressure: t == .leftMouseUp ? 0 : 1) else { return }
                EditorWebView.harnessMouseThrough = true; deliver(e); EditorWebView.harnessMouseThrough = false
            }
            var pinch: ProbeMagnification? = nil, span0 = 0.0, lastScale = 1.0
            func webkitPinch(_ frame: [(Int, NSPoint)], _ end: Bool) {
                guard webkit else { return }
                let pts = frame.map { $0.1 }
                if end { if let e = pinch { e.step = .ended; e.amount = 0; web.magnify(with: e) }; pinch = nil; return }
                guard pts.count == 2 else { return }
                let span = hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y), mid = NSPoint(x: (pts[0].x + pts[1].x) / 2, y: (pts[0].y + pts[1].y) / 2)
                if pinch == nil { let e = ProbeMagnification(); e.target = window; e.step = .began; e.amount = 0; e.position = mid; pinch = e; span0 = span; lastScale = 1; web.magnify(with: e); return }
                let scale = span / span0, e = pinch!
                e.step = .changed; e.amount = scale - lastScale; e.position = mid; lastScale = scale; web.magnify(with: e)
            }
            var keys: [Int: NSString] = [:], last: [Int: NSPoint] = [:]
            func send(_ touches: [NSTouch], _ deliver: (NSEvent) -> Void) {
                guard !touches.isEmpty else { return }
                let e = ProbeTouchEvent(); e.target = window; e.touchSet = Set(touches); deliver(e)
            }
            // AppKit holds the emulated mouse events while the recognizer may still recognize
            // (delaysPrimaryMouseButtonEvents) and delivers them only if it fails.
            var held: [NSEvent] = []
            func mouse(_ t: NSEvent.EventType, _ at: NSPoint) {
                guard emulate, let e = NSEvent.mouseEvent(with: t, location: at, modifierFlags: [], timestamp: ProcessInfo.processInfo.systemUptime, windowNumber: window.windowNumber,
                                                         context: nil, eventNumber: 0, clickCount: 1, pressure: t == .leftMouseUp ? 0 : 1) else { return }
                held.append(e)
            }
            web.fingers.reset()
            EditorWebView.assumeTouchDisplay = emulate
            for (n, frame) in frames.enumerated() {
                let present = Set(frame.map { $0.0 })
                var began: [NSTouch] = [], moved: [NSTouch] = []
                for (finger, at) in frame {
                    if keys[finger] == nil { keys[finger] = NSString(string: UUID().uuidString); began.append(ProbeTouch(keys[finger]!, .began, at)) }
                    else { moved.append(ProbeTouch(keys[finger]!, .moved, at)) }
                    last[finger] = at
                }
                let ended = keys.keys.filter { !present.contains($0) }.map { f -> NSTouch in let t = ProbeTouch(keys[f]!, .ended, last[f]!); keys[f] = nil; return t }
                let first = frame.first(where: { $0.0 == 0 })?.1
                if mouseFirst, let at = first { webkitMouse(n == 0 ? .leftMouseDown : .leftMouseDragged, at) }
                send(began) { web.fingers.touchesBegan(with: $0) }
                if !mouseFirst, let at = first { webkitMouse(n == 0 ? .leftMouseDown : .leftMouseDragged, at) }
                if let at = first { mouse(n == 0 ? .leftMouseDown : .leftMouseDragged, at) }
                webkitPinch(frame, false)
                send(moved) { web.fingers.touchesMoved(with: $0) }
                send(ended) { web.fingers.touchesEnded(with: $0) }
                await h.pause(ms / 1000)
            }
            let rest = keys.keys.map { f in ProbeTouch(keys[f]!, .ended, last[f]!) }
            webkitPinch([], true)
            if let at = last[0], frames.last?.contains(where: { $0.0 == 0 }) == true { webkitMouse(.leftMouseUp, at) }
            send(rest) { web.fingers.touchesEnded(with: $0) }
            if let at = last[0] { mouse(.leftMouseUp, at) }
            // The recognizer is driven directly here, outside AppKit's recognition, so its decision stands in
            // for the state AppKit would act on: declined (failed) delivers the held mouse events.
            for _ in 0..<50 where web.fingers.decision == "deciding" { await h.pause(0.02) }
            let decision = web.fingers.decision
            if decision == "declined" { for e in held { deliver(e); await h.pause(ms / 1000) } }
            await h.pause(0.05)
            EditorWebView.assumeTouchDisplay = false
            web.fingers.reset()
            return ["decision": decision, "held": held.count]
        case "inputDiagnostics": return (web as? EditorWebView)?.inputLog.inspect(a["operation"] as? String ?? "read") ?? [:]
        case "hitView":
            // The view AppKit would send a mouse event at this page point to (EditorWebView must receive it).
            let v = window.contentView?.superview?.hitTest(point(num("x"), num("y")))
            return v.map { String(describing: type(of: $0)) } ?? "none"
        case "wheels":
            // `count` scroll events every `ms` milliseconds at one point (a trackpad or a spun wheel; ctrl: Control held, a pinch).
            // An NSEvent made from a CGEvent carries no window and WebKit places it off by the window's offset
            // in this offscreen harness: ox/oy (measured by the page from a first event) correct it.
            let at = screenPoint(num("x") + num("ox"), num("y") + num("oy"))
            deliver(NSEvent.mouseEvent(with: .mouseMoved, location: point(num("x"), num("y")), modifierFlags: [], timestamp: ProcessInfo.processInfo.systemUptime, windowNumber: window.windowNumber, context: nil, eventNumber: 0, clickCount: 0, pressure: 0))
            for _ in 0..<max(1, Int(num("count"))) {
                if let cg = CGEvent(scrollWheelEvent2Source: nil, units: a["pixels"] as? Bool == true ? .pixel : .line, wheelCount: 2, wheel1: Int32(num("dy")), wheel2: Int32(num("dx")), wheel3: 0) {
                    if a["ctrl"] as? Bool == true { cg.flags = .maskControl }
                    cg.timestamp = DispatchTime.now().uptimeNanoseconds
                    cg.location = at
                    if let e = NSEvent(cgEvent: cg) { web.scrollWheel(with: e) }
                }
                await h.pause(max(1, num("ms")) / 1000)
            }
            return true
        case "trackpad":
            // A two-finger trackpad scroll as macOS sends it: continuous pixel deltas (fractional, both axes)
            // with the gesture's scroll phase, then its momentum tail. steps: [[dx, dy, phase]], phase 0 a
            // finger event (the first begins, the last ends the touch), 1 momentum or 2 a rest (no event); one event every `ms`
            // milliseconds on a monotonic schedule (a late event does not push the rest back).
            let at = screenPoint(num("x") + num("ox"), num("y") + num("oy"))
            deliver(NSEvent.mouseEvent(with: .mouseMoved, location: point(num("x"), num("y")), modifierFlags: [], timestamp: ProcessInfo.processInfo.systemUptime, windowNumber: window.windowNumber, context: nil, eventNumber: 0, clickCount: 0, pressure: 0))
            let steps = (a["steps"] as? [[NSNumber]] ?? []).map { ($0[0].doubleValue, $0[1].doubleValue, $0.count > 2 ? $0[2].intValue : 0) }
            let ms = max(1, num("ms")), start = DispatchTime.now().uptimeNanoseconds
            for (n, (dx, dy, kind)) in steps.enumerated() {
                let due = start + UInt64(Double(n) * ms * 1e6), now = DispatchTime.now().uptimeNanoseconds
                if due > now { try? await Task.sleep(nanoseconds: due - now) }
                if kind == 2 { continue } // the fingers rest: no event in this slot
                guard let cg = CGEvent(scrollWheelEvent2Source: nil, units: .pixel, wheelCount: 2, wheel1: Int32(dy.rounded()), wheel2: Int32(dx.rounded()), wheel3: 0) else { continue }
                // macOS scroll deltas point the content's way: a pan right (deltaX > 0 in the DOM) is a negative wheel.
                cg.setIntegerValueField(.scrollWheelEventIsContinuous, value: 1)
                cg.setDoubleValueField(.scrollWheelEventFixedPtDeltaAxis1, value: -dy)
                cg.setDoubleValueField(.scrollWheelEventFixedPtDeltaAxis2, value: -dx)
                cg.setIntegerValueField(.scrollWheelEventPointDeltaAxis1, value: Int64(-dy.rounded()))
                cg.setIntegerValueField(.scrollWheelEventPointDeltaAxis2, value: Int64(-dx.rounded()))
                let first = n == 0 || steps[n - 1].2 != kind, last = n == steps.count - 1 || steps[n + 1].2 != kind
                if kind == 0 { cg.setIntegerValueField(.scrollWheelEventScrollPhase, value: first ? 1 : 2) }
                else { cg.setIntegerValueField(.scrollWheelEventMomentumPhase, value: first ? 1 : last ? 3 : 2) }
                cg.timestamp = DispatchTime.now().uptimeNanoseconds
                cg.location = at
                if let e = NSEvent(cgEvent: cg) { web.scrollWheel(with: e) }
                // The fingers lift: a phase-ended event with no delta before the momentum begins.
                if kind == 0 && last, let up = CGEvent(scrollWheelEvent2Source: nil, units: .pixel, wheelCount: 2, wheel1: 0, wheel2: 0, wheel3: 0) {
                    up.setIntegerValueField(.scrollWheelEventIsContinuous, value: 1)
                    up.setIntegerValueField(.scrollWheelEventScrollPhase, value: 4)
                    up.timestamp = DispatchTime.now().uptimeNanoseconds; up.location = at
                    if let e = NSEvent(cgEvent: up) { web.scrollWheel(with: e) }
                }
            }
            return true
        case "consoleEvents":
            let rows = privateTour ? Harness.consoleEvents.map { $0.filter { $0.key != "text" } } : Harness.consoleEvents
            return ["available": Harness.consoleAvailable, "entries": rows] as [String: Any]
        case "nativeMenus": let m = nativeMenus; nativeMenus = []; return m
        case "cancelSavePanel":
            guard let panel = await h.sheet(5) as? NSSavePanel else { return false }
            window.endSheet(panel, returnCode: .cancel)
            return true
        case "shot":
            guard !privateTour else { return false }
            await shot(a["name"] as? String ?? "shot"); return true
        case "snapshot-png":
            guard !privateTour else { return [:] }
            let rect = NSRect(x: num("x"), y: num("y"), width: num("w"), height: num("h"))
            guard !rect.isEmpty, web.bounds.contains(rect) else { return [:] }
            if let image = windowRaster(rect),
               let png = NSBitmapImageRep(cgImage: image).representation(using: .png, properties: [:]) {
                return ["source": "window-server", "png": png.base64EncodedString()]
            }
            guard let image = await snapshot(rect), let tiff = image.tiffRepresentation,
                  let rep = NSBitmapImageRep(data: tiff),
                  let png = rep.representation(using: .png, properties: [:]) else { return [:] }
            return ["source": "webkit-compositor", "png": png.base64EncodedString()]
        case "pixels": return await pixels(NSRect(x: num("x"), y: num("y"), width: num("w"), height: num("h")))
        case "ink-raster-scale":
            return overrideRasterScale(num("scale"))
        case "ink-raster":
            guard !privateTour else { return ["error": "raster probe unavailable"] }
            return await inkRaster(a["regions"] as? [[String: Any]] ?? [], scale: num("scale"))
        case "save":
            let name = a["name"] as? String ?? "out.txt"
            guard !privateTour || ["phase.txt", "tour.json"].contains(name) else { return false }
            let text = a["text"] as? String ?? ""
            if name == "phase.txt" { Harness.consolePhase = text }
            try? text.write(to: work.appendingPathComponent(name), atomically: true, encoding: .utf8)
            return true
        case "cssSources":
            // Every stylesheet the app ships, by file name (the probe parses each one with WebKit).
            let dir = Bundle.main.resourceURL!.appendingPathComponent("app")
            var out: [String: String] = [:]
            let toolkit: Set<String> = ["ui/analysis-panels.css", "ui/components.css", "ui/controls.css", "ui/gallery.css", "ui/history-panels.css", "ui/rule-set-lists.css", "ui/shortcut.css", "ui/spatial-motion.css", "ui/spreadsheet.css", "ui/tooltip.css"]
            let files = FileManager.default.enumerator(at: dir, includingPropertiesForKeys: nil, options: .skipsHiddenFiles)
            while let file = files?.nextObject() as? URL {
                guard file.pathExtension == "css" else { continue }
                let name = String(file.path.dropFirst(dir.path.count + 1))
                guard !toolkit.contains(name), !["vendor/", "locales/", "fab-presets/"].contains(where: name.hasPrefix),
                      !name.hasPrefix("extensions/") || name.hasPrefix("extensions/host/") else { continue }
                out[name] = try? String(contentsOf: file, encoding: .utf8)
            }
            return out
        case "componentHistoryMenu":
            guard let action = a["action"] as? String, ["undo","redo","close-project"].contains(action),
                  let item = NSApp.mainMenu?.items.compactMap(\.submenu).flatMap(\.items)
                    .first(where: { $0.representedObject as? String == action }),
                  let menu = item.menu, let index = menu.items.firstIndex(of:item) else { return false }
            // The global Edit menu belongs to the key window. A locked console
            // uses the actual in-window Edit menu instead.
            if action != "close-project" && (!window.isKeyWindow || !NSApp.isActive) { return false }
            menu.performActionForItem(at:index)
            return true
        case "componentHistoryKey":
            let action = a["action"] as? String
            guard action == "undo" || action == "redo" else { return ["route":"unavailable"] }
            let redo = action == "redo", modifiers: NSEvent.ModifierFlags = redo ? [.command,.shift] : .command
            let isKey = window.isKeyWindow, active = NSApp.isActive, visible = window.occlusionState.contains(.visible)
            if isKey && active && visible {
                h.postKey(redo ? "Z" : "z",code:6,modifiers:modifiers)
            } else {
                // An actual NSEvent into this test window's WK responder delivers
                // its normal trusted keyboard shortcut without changing system focus.
                for type in [NSEvent.EventType.keyDown,.keyUp] {
                    let character = redo ? "Z" : "z"
                    if let event = NSEvent.keyEvent(with:type,location:.zero,modifierFlags:modifiers,
                        timestamp:ProcessInfo.processInfo.systemUptime,windowNumber:window.windowNumber,
                        context:nil,characters:character,charactersIgnoringModifiers:character,isARepeat:false,keyCode:6) {
                        if type == .keyDown { web.keyDown(with:event) } else { web.keyUp(with:event) }
                    }
                }
            }
            return ["route":isKey && active && visible ? "AppKit event queue" : "targeted WKWebView NSEvent",
                    "key":isKey,"active":active,"visible":visible]
        case "componentHistoryReopen":
            guard let path = ProcessInfo.processInfo.environment["HARNESS_OPEN_PROJECT"] else { return false }
            h.d.application(NSApp,openFiles:[path])
            return true
        case "focusWindow":
            window.orderFrontRegardless(); window.makeKeyAndOrderFront(nil); NSApp.activate(ignoringOtherApps: true); window.makeFirstResponder(web)
            return ["key": window.isKeyWindow, "active": NSApp.isActive, "visible": window.occlusionState.contains(.visible)]
        // Energy probes (energy.sh): CPU, wakeups and energy of the app and its WebKit processes over a window.
        case "measure":
            if let boundary = a["boundary"] as? String { return energy.measureBoundary(boundary) }
            return await energy.measure(num("seconds"))
        // Ends WebKit's GPU process as the system does under memory pressure (canvas-context-loss probes):
        // every WebGL and accelerated 2D canvas of the page loses its contents.
        case "killGPUProcess":
            let pid = energy.spi(web, "_gpuProcessIdentifier")
            guard pid > 0 else { return 0 }
            kill(pid, SIGKILL); return Int(pid)
        case "occlusionDetection": setOcclusionDetection(a["on"] as? Bool == true); return true
        case "window": return await energy.window(a["act"] as? String ?? "")
        case "power": return EnergyProbes.powerState()
        case "openFile": return energy.open(a["text"] as? String ?? "{}", name: a["name"] as? String ?? "Energy.waffle")
        default: return "unknown op " + op
        }
    }

    // Page (CSS px, top-left origin) to window coordinates. The page zoom is 1, so a CSS px is a point.
    func point(_ x: Double, _ y: Double) -> NSPoint {
        web.convert(NSPoint(x: x, y: web.isFlipped ? y : web.bounds.height - y), to: nil)
    }
    func flags(_ mods: [String]) -> NSEvent.ModifierFlags {
        var f: NSEvent.ModifierFlags = []
        for m in mods {
            switch m { case "cmd", "meta": f.insert(.command); case "ctrl": f.insert(.control); case "alt", "option": f.insert(.option); case "shift": f.insert(.shift); default: break }
        }
        return f
    }
    func send(_ e: NSEvent?) { if let e = e { NSApp.sendEvent(e) } }
    // Mouse events go to the web view itself: through the window, a left click on a window that is
    // not key only activates it (the terminal that runs the harness usually stays frontmost).
    func deliver(_ e: NSEvent?) {
        guard let e = e else { return }
        switch e.type {
        case .leftMouseDown: web.mouseDown(with: e)
        case .leftMouseUp: web.mouseUp(with: e)
        case .leftMouseDragged: web.mouseDragged(with: e)
        case .rightMouseDown: web.rightMouseDown(with: e)
        case .rightMouseUp: web.rightMouseUp(with: e)
        case .rightMouseDragged: web.rightMouseDragged(with: e)
        case .mouseMoved:
            // WebKit drops plain mouse moves while the window is not key; its testing hook does not.
            let simulate = NSSelectorFromString("_simulateMouseMove:")
            if web.responds(to: simulate) { web.perform(simulate, with: e) } else { web.mouseMoved(with: e) }
        case .flagsChanged: web.flagsChanged(with: e)
        default: NSApp.sendEvent(e)
        }
    }
    func mouse(_ x: Double, _ y: Double, button: String, mods: [String], kind: String, clicks: Int) async {
        let p = point(x, y), f = flags(mods)
        let (down, up, drag): (NSEvent.EventType, NSEvent.EventType, NSEvent.EventType) =
            button == "right" ? (.rightMouseDown, .rightMouseUp, .rightMouseDragged) : (.leftMouseDown, .leftMouseUp, .leftMouseDragged)
        func ev(_ t: NSEvent.EventType, _ at: NSPoint, _ n: Int = clicks) -> NSEvent? {
            eventNumber += 1
            return NSEvent.mouseEvent(with: t, location: at, modifierFlags: f, timestamp: ProcessInfo.processInfo.systemUptime, windowNumber: window.windowNumber,
                                      context: nil, eventNumber: eventNumber, clickCount: n, pressure: t == up || t == .mouseMoved ? 0 : 1)
        }
        if !f.isEmpty { deliver(NSEvent.keyEvent(with: .flagsChanged, location: p, modifierFlags: f, timestamp: ProcessInfo.processInfo.systemUptime, windowNumber: window.windowNumber, context: nil, characters: "", charactersIgnoringModifiers: "", isARepeat: false, keyCode: 0)) }
        if kind == "move" || kind == "click" || kind == "down" { deliver(ev(.mouseMoved, p, 0)); await h.pause(0.06) }
        if kind == "click" || kind == "down" { deliver(ev(down, p)); await h.pause(0.05) }
        if kind == "drag" { deliver(ev(drag, p)); await h.pause(0.05) }
        if kind == "click" || kind == "up" { deliver(ev(up, p)); await h.pause(0.05) }
        if !f.isEmpty { deliver(NSEvent.keyEvent(with: .flagsChanged, location: p, modifierFlags: [], timestamp: ProcessInfo.processInfo.systemUptime, windowNumber: window.windowNumber, context: nil, characters: "", charactersIgnoringModifiers: "", isARepeat: false, keyCode: 0)) }
        await h.pause(0.08)
    }
    func path(_ pts: [NSPoint], right: Bool, ms: Double, down: Bool, up: Bool) async {
        guard let first = pts.first, let last = pts.last else { return }
        func ev(_ t: NSEvent.EventType, _ at: NSPoint) -> NSEvent? {
            eventNumber += 1
            return NSEvent.mouseEvent(with: t, location: at, modifierFlags: [], timestamp: ProcessInfo.processInfo.systemUptime, windowNumber: window.windowNumber,
                                      context: nil, eventNumber: eventNumber, clickCount: 1, pressure: t == .leftMouseUp || t == .rightMouseUp ? 0 : 1)
        }
        if down { deliver(ev(right ? .rightMouseDown : .leftMouseDown, first)); await h.pause(ms / 1000) }
        for p in pts.dropFirst() { deliver(ev(right ? .rightMouseDragged : .leftMouseDragged, p)); await h.pause(ms / 1000) }
        if up { deliver(ev(right ? .rightMouseUp : .leftMouseUp, last)); await h.pause(0.05) }
    }
    func subtypePath(_ pts: [NSPoint], subtype: Int64, ms: Double, hold: Double) async {
        guard let first = pts.first, let last = pts.last else { return }
        func ev(_ t: NSEvent.EventType, _ at: NSPoint) -> NSEvent? {
            eventNumber += 1
            guard let base = NSEvent.mouseEvent(with: t, location: at, modifierFlags: [], timestamp: ProcessInfo.processInfo.systemUptime,
                                                windowNumber: window.windowNumber, context: nil, eventNumber: eventNumber, clickCount: 1,
                                                pressure: t == .leftMouseUp ? 0 : 1), let cg = base.cgEvent?.copy() else { return nil }
            cg.setIntegerValueField(.mouseEventSubtype, value: subtype)
            return NSEvent(cgEvent: cg)
        }
        deliver(ev(.leftMouseDown, first)); await h.pause(max(ms, hold) / 1000)
        for p in pts.dropFirst() { deliver(ev(.leftMouseDragged, p)); await h.pause(ms / 1000) }
        deliver(ev(.leftMouseUp, last)); await h.pause(0.05)
    }
    // Screen point (Quartz: top-left origin) of a page point, for CGEvent-made events.
    func screenPoint(_ x: Double, _ y: Double) -> CGPoint {
        let s = window.convertPoint(toScreen: point(x, y)), h = NSScreen.screens.first?.frame.height ?? 0
        return CGPoint(x: s.x, y: h - s.y)
    }
    // Mouse thumb buttons (3 back, 4 forward): NSEvent cannot set a button number, CGEvent can.
    func other(_ x: Double, _ y: Double, button: Int) async {
        deliver(NSEvent.mouseEvent(with: .mouseMoved, location: point(x, y), modifierFlags: [], timestamp: ProcessInfo.processInfo.systemUptime, windowNumber: window.windowNumber, context: nil, eventNumber: 0, clickCount: 0, pressure: 0))
        await h.pause(0.06)
        for t in [CGEventType.otherMouseDown, .otherMouseUp] {
            guard let cg = CGEvent(mouseEventSource: nil, mouseType: t, mouseCursorPosition: screenPoint(x, y), mouseButton: CGMouseButton(rawValue: UInt32(button)) ?? .center) else { continue }
            cg.setIntegerValueField(.mouseEventClickState, value: 1)
            if let e = NSEvent(cgEvent: cg) { if t == .otherMouseDown { web.otherMouseDown(with: e) } else { web.otherMouseUp(with: e) } }
            await h.pause(0.05)
        }
        await h.pause(0.08)
    }
    // A scroll wheel event: line units (a notched or tilt wheel) or pixels (a trackpad or free-spinning wheel).
    func wheel(_ x: Double, _ y: Double, dx: Int32, dy: Int32, pixels: Bool) async {
        deliver(NSEvent.mouseEvent(with: .mouseMoved, location: point(x, y), modifierFlags: [], timestamp: ProcessInfo.processInfo.systemUptime, windowNumber: window.windowNumber, context: nil, eventNumber: 0, clickCount: 0, pressure: 0))
        await h.pause(0.06)
        if let cg = CGEvent(scrollWheelEvent2Source: nil, units: pixels ? .pixel : .line, wheelCount: 2, wheel1: dy, wheel2: dx, wheel3: 0) {
            cg.location = screenPoint(x, y)
            if let e = NSEvent(cgEvent: cg) { web.scrollWheel(with: e) }
        }
        await h.pause(0.15)
    }
    static let keys: [String: (UInt16, String)] = [
        "ArrowRight": (124, "\u{F703}"), "ArrowLeft": (123, "\u{F702}"), "ArrowDown": (125, "\u{F701}"), "ArrowUp": (126, "\u{F700}"),
        "Enter": (36, "\r"), "Escape": (53, "\u{1b}"), "Tab": (48, "\t"), " ": (49, " "), "F10": (109, "\u{F70D}"), "Home": (115, "\u{F729}"), "End": (119, "\u{F72B}"),
        "a": (0, "a"), "s": (1, "s"), "d": (2, "d"), "f": (3, "f"), "h": (4, "h"), "g": (5, "g"), "z": (6, "z"), "x": (7, "x"), "c": (8, "c"), "v": (9, "v"),
        "b": (11, "b"), "q": (12, "q"), "w": (13, "w"), "e": (14, "e"), "r": (15, "r"), "y": (16, "y"), "t": (17, "t"), "1": (18, "1"), "2": (19, "2"),
        "3": (20, "3"), "4": (21, "4"), "6": (22, "6"), "5": (23, "5"), "9": (25, "9"), "7": (26, "7"), "8": (28, "8"), "0": (29, "0"), "o": (31, "o"),
        "u": (32, "u"), "i": (34, "i"), "p": (35, "p"), "l": (37, "l"), "j": (38, "j"), "k": (40, "k"), "n": (45, "n"), "m": (46, "m")]
    func key(_ name: String, mods: [String]) async {
        guard let (code, chars) = UIProbes.keys[name] ?? UIProbes.keys[name.lowercased()] else { h.note("no key code for " + name); return }
        let f = flags(mods), shown = f.contains(.shift) ? chars.uppercased() : chars
        for t in [NSEvent.EventType.keyDown, .keyUp] {
            let event = NSEvent.keyEvent(with: t, location: .zero, modifierFlags: f, timestamp: ProcessInfo.processInfo.systemUptime, windowNumber: window.windowNumber,
                                         context: nil, characters: shown, charactersIgnoringModifiers: f.contains(.shift) ? chars.uppercased() : chars, isARepeat: false, keyCode: code)
            if ProcessInfo.processInfo.environment["HARNESS_BACKGROUND"] == "1", t == .keyDown, f.contains(.command),
               let event, NSApp.mainMenu?.performKeyEquivalent(with: event) == true { continue }
            send(event)
            await h.pause(0.03)
        }
        await h.pause(0.1)
    }

    // Crop the running app's own window. The window server may decline the
    // capture on some hosts, for example when a virtual display is unavailable.
    func windowRaster(_ rect: NSRect) -> CGImage? {
        let scale = window.backingScaleFactor
        guard scale == 2, let image = StartupFrames.windowImage(CGWindowID(window.windowNumber), bestResolution: true),
              CGFloat(image.width) == window.frame.width * scale, CGFloat(image.height) == window.frame.height * scale else { return nil }
        let local = web.isFlipped ? rect : rect.offsetBy(dx: 0, dy: web.bounds.height - rect.minY - rect.maxY)
        let onScreen = window.convertToScreen(web.convert(local, to: nil))
        let crop = CGRect(x: round((onScreen.minX - window.frame.minX) * scale),
                          y: round((window.frame.maxY - onScreen.maxY) * scale),
                          width: rect.width * scale, height: rect.height * scale)
        return image.cropping(to: crop)
    }

    // What WebKit painted (takeSnapshot renders the page, top-layer dialogs included).
    func snapshot(_ rect: NSRect? = nil) async -> NSImage? {
        let c = WKSnapshotConfiguration()
        if let r = rect { c.rect = r }
        c.afterScreenUpdates = true
        return await withCheckedContinuation { k in web.takeSnapshot(with: c) { img, _ in k.resume(returning: img) } }
    }
    func shot(_ name: String) async {
        if let tiff = await snapshot()?.tiffRepresentation, let rep = NSBitmapImageRep(data: tiff), let png = rep.representation(using: .png, properties: [:]) {
            try? png.write(to: shots.appendingPathComponent(name + ".png"))
        }
    }
    // Pixel statistics of a page rectangle: the share of pixels that differ from the corner pixel
    // (the background) and the number of distinct colours. A masked icon draws a thin glyph; a
    // missing mask draws a solid square (share near 1) and a missing image nothing (share 0).
    func pixels(_ r: NSRect) async -> [String: Any] {
        guard let tiff = await snapshot(r)?.tiffRepresentation, let rep = NSBitmapImageRep(data: tiff) else { return ["error": "no snapshot"] }
        let w = rep.pixelsWide, hgt = rep.pixelsHigh
        guard w > 0, hgt > 0, let bg = rep.colorAt(x: 0, y: 0)?.usingColorSpace(.sRGB) else { return ["error": "empty"] }
        var differ = 0, colours = Set<Int>()
        for y in 0..<hgt { for x in 0..<w {
            guard let c = rep.colorAt(x: x, y: y)?.usingColorSpace(.sRGB) else { continue }
            let d = abs(c.redComponent - bg.redComponent) + abs(c.greenComponent - bg.greenComponent) + abs(c.blueComponent - bg.blueComponent)
            if d > 0.12 { differ += 1 }
            colours.insert(Int(c.redComponent * 31) << 10 | Int(c.greenComponent * 31) << 5 | Int(c.blueComponent * 31))
        } }
        return ["share": Double(differ) / Double(w * hgt), "colours": colours.count, "w": w, "h": hgt]
    }

    // WebKit's test-only override re-renders at the requested device scale. The
    // snapshot verifies the resulting pixel size before using either scale.
    func overrideRasterScale(_ scale: CGFloat) -> Bool {
        let setter = NSSelectorFromString("_setOverrideDeviceScaleFactor:")
        guard [0, 1, 2].contains(scale), web.responds(to: setter) else { return false }
        typealias SetScale = @convention(c) (AnyObject, Selector, CGFloat) -> Void
        unsafeBitCast(web.method(for: setter), to: SetScale.self)(web, setter, scale)
        return true
    }

    func inkRaster(_ entries: [[String: Any]], scale: CGFloat) async -> [String: Any] {
        func luminance(_ r: Double, _ g: Double, _ b: Double) -> Double {
            0.2126 * r + 0.7152 * g + 0.0722 * b
        }
        guard [1, 2].contains(scale), entries.count == 2 else { return ["error": "expected two masks at 1× or 2×"] }
        let regions = entries.compactMap { entry -> (CGRect, Double)? in
            guard let bounds = entry["rect"] as? [NSNumber], bounds.count == 4,
                  let ink = entry["ink"] as? [NSNumber], ink.count == 3 else { return nil }
            let rect = CGRect(x: bounds[0].doubleValue, y: bounds[1].doubleValue,
                              width: bounds[2].doubleValue, height: bounds[3].doubleValue)
            guard rect.width > 0, rect.height > 0, web.bounds.contains(rect) else { return nil }
            return (rect, luminance(ink[0].doubleValue, ink[1].doubleValue, ink[2].doubleValue))
        }
        guard regions.count == entries.count else { return ["error": "invalid or offscreen text mask"] }
        let clip = regions[0].0.union(regions[1].0).integral
        guard let tiff = await snapshot(clip)?.tiffRepresentation, let image = NSBitmapImageRep(data: tiff) else {
            return ["error": "WebKit did not return a raster"]
        }
        guard image.pixelsWide == Int(clip.width * scale), image.pixelsHigh == Int(clip.height * scale) else {
            return ["error": "wrong backing size", "actual": [image.pixelsWide, image.pixelsHigh],
                    "expected": [Int(clip.width * scale), Int(clip.height * scale)]]
        }
        let metrics = regions.map { (rect, ink) in
            let left = Int(floor((rect.minX - clip.minX) * scale)), right = Int(ceil((rect.maxX - clip.minX) * scale))
            let top = Int(floor((rect.minY - clip.minY) * scale)), bottom = Int(ceil((rect.maxY - clip.minY) * scale))
            var pixels: [(Int, Double)] = []
            var histogram = Array(repeating: 0, count: 256)
            for y in top..<bottom {
                for x in left..<right {
                    guard let color = image.colorAt(x: x, y: y)?.usingColorSpace(.sRGB), color.alphaComponent > 0.98 else { continue }
                    let value = 255 * luminance(color.redComponent, color.greenComponent, color.blueComponent)
                    histogram[Int(min(255, max(0, value.rounded())))] += 1
                    pixels.append((y, value))
                }
            }
            let background = Double(histogram.indices.max(by: { histogram[$0] < histogram[$1] }) ?? 0)
            let contrast = abs(ink - background)
            let direction: Double = ink > background ? 1 : -1
            let rows = pixels.compactMap { (y, value) in (value - background) * direction > contrast / 4 ? y : nil }
            return ["first": rows.min() ?? -1, "last": rows.max() ?? -1, "count": rows.count,
                    "contrast": contrast] as [String: Any]
        }
        return ["scale": scale, "masks": metrics]
    }
}
