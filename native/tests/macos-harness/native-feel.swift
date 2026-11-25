import Cocoa
import CoreGraphics
import WebKit

// Harness-only scroll and pinch driver. No events are posted to the desktop.
@MainActor final class NativeFeel {
    unowned let probes: UIProbes
    private var latestInput: UInt64?
    private var positioned = false
    private let bindWheelEvent = NSSelectorFromString("_eventRelativeToWindow:")

    init(_ probes: UIProbes) { self.probes = probes }

    func state() -> [String: Any] {
        let w = probes.window
        if !positioned, let raw = ProcessInfo.processInfo.environment["NATIVE_FEEL_DISPLAY_ID"],
           let id = UInt32(raw),
           let target = NSScreen.screens.first(where: { screenID($0) == id }) {
            positioned = true
            let room = target.visibleFrame
            w.setFrameOrigin(NSPoint(x: room.midX - w.frame.width / 2, y: room.midY - w.frame.height / 2))
        }
        let screen = w.screen ?? NSScreen.main
        let displayID = screen.map(screenID) ?? CGMainDisplayID()
        let requested = ProcessInfo.processInfo.environment["NATIVE_FEEL_DISPLAY_ID"]
        let testCGEvent = CGEvent(scrollWheelEvent2Source: nil, units: .line, wheelCount: 1,
                                  wheel1: 1, wheel2: 0, wheel3: 0)
        let testEvent = testCGEvent.flatMap { NSEvent(cgEvent: $0) }
        let mode = CGDisplayCopyDisplayMode(displayID)
        let session = CGSessionCopyCurrentDictionary() as? [String: Any]
        return ["appActive": NSApp.isActive, "windowKey": w.isKeyWindow,
                "windowVisible": w.occlusionState.contains(.visible), "orderedOnScreen": w.isVisible,
                "displayID": displayID, "displayHz": mode?.refreshRate ?? 0,
                "backingScale": w.backingScaleFactor,
                "wheelEventBindingSupported": testEvent?.responds(to: bindWheelEvent) ?? false,
                "requestedDisplayMatched": requested == nil || requested.flatMap(UInt32.init) == displayID,
                "screenLocked": session?["CGSSessionScreenIsLocked"] ?? NSNull(),
                "presentationAcknowledgementSupported": probes.web.responds(to: NSSelectorFromString("_doAfterNextPresentationUpdate:"))]
    }

    private func screenID(_ screen: NSScreen) -> UInt32 {
        (screen.deviceDescription[NSDeviceDescriptionKey("NSScreenNumber")] as? NSNumber)?.uint32Value ?? CGMainDisplayID()
    }

    private func quartzPoint(_ x: Double, _ y: Double) -> CGPoint {
        guard let monitor = probes.window.screen else { return probes.screenPoint(x, y) }
        let inAppKit = probes.window.convertPoint(toScreen: probes.point(x, y))
        let quartz = CGDisplayBounds(screenID(monitor))
        return CGPoint(x: quartz.minX + inAppKit.x - monitor.frame.minX,
                       y: quartz.minY + monitor.frame.maxY - inAppKit.y)
    }

    func input(_ args: [String: Any]) async -> [[String: Any]] {
        let value: (String) -> Double = { (args[$0] as? NSNumber)?.doubleValue ?? 0 }
        let kind = args["kind"] as? String ?? "pan"
        let rows = args["steps"] as? [[Double]] ?? []
        let position = probes.point(value("x"), value("y"))
        let screen = quartzPoint(value("x"), value("y"))
        let window = probes.window, web = probes.web, start = DispatchTime.now().uptimeNanoseconds
        if let move = NSEvent.mouseEvent(with: .mouseMoved, location: position, modifierFlags: [],
                                         timestamp: ProcessInfo.processInfo.systemUptime, windowNumber: window.windowNumber,
                                         context: nil, eventNumber: 0, clickCount: 0, pressure: 0) {
            web.mouseMoved(with: move)
        }
        let stepTime = max(1, value("ms")) * 1e6
        var sent: [[String: Any]] = []
        for (index, row) in rows.enumerated() where row.count >= 3 {
            let due = start + UInt64(Double(index) * stepTime), now = DispatchTime.now().uptimeNanoseconds
            if due > now { try? await Task.sleep(nanoseconds: due - now) }
            let dx = row[0], dy = row[1], phase = Int(row[2])
            if phase == 4 { continue }
            let mark = DispatchTime.now().uptimeNanoseconds
            if kind == "pinch" {
                let event = ProbeMagnification()
                event.step = phase == 1 ? .began : phase == 3 ? .ended : .changed
                event.amount = dy; event.position = position; event.target = window
                latestInput = mark
                web.magnify(with: event)
                sent.append(["index": index, "dx": dx, "dy": dy, "phase": phase, "ms": Double(mark - start) / 1e6])
                continue
            }
            let precise = kind == "pan" || kind == "ctrl-pixel"
            guard let cg = CGEvent(scrollWheelEvent2Source: nil, units: precise ? .pixel : .line, wheelCount: 2,
                                   wheel1: Int32(dy.rounded()), wheel2: Int32(dx.rounded()), wheel3: 0) else { continue }
            if kind.hasPrefix("ctrl-") { cg.flags = .maskControl }
            if kind == "pan" {
                cg.setIntegerValueField(.scrollWheelEventIsContinuous, value: 1)
                cg.setDoubleValueField(.scrollWheelEventFixedPtDeltaAxis1, value: dy)
                cg.setDoubleValueField(.scrollWheelEventFixedPtDeltaAxis2, value: dx)
                cg.setIntegerValueField(.scrollWheelEventPointDeltaAxis1, value: Int64(dy.rounded()))
                cg.setIntegerValueField(.scrollWheelEventPointDeltaAxis2, value: Int64(dx.rounded()))
                cg.setIntegerValueField(.scrollWheelEventScrollPhase, value: phase == 3 ? 4 : phase < 3 ? Int64(phase) : 0)
                if phase >= 5 { cg.setIntegerValueField(.scrollWheelEventMomentumPhase, value: Int64(phase - 4)) }
            }
            cg.timestamp = mark; cg.location = screen
            // CGEvent-created NSEvents have no AppKit window binding. Bind the event to the
            // test window before passing it directly to its EditorWebView. Retain global coordinates,
            // modifier bits and the CG monotonic timestamp. Nothing is posted to the desktop.
            guard let injected = NSEvent(cgEvent: cg), injected.responds(to: bindWheelEvent),
                  let event = injected.perform(bindWheelEvent, with: window)?.takeUnretainedValue() as? NSEvent,
                  event.window === window, event.timestamp == injected.timestamp,
                  event.cgEvent?.location == cg.location,
                  abs(event.locationInWindow.x - position.x) <= 1,
                  abs(event.locationInWindow.y - position.y) <= 1 else { continue }
            latestInput = mark
            web.scrollWheel(with: event)
            sent.append(["index": index, "dx": dx, "dy": dy, "phase": phase, "ms": Double(mark - start) / 1e6,
                         "precise": event.hasPreciseScrollingDeltas, "ctrl": event.modifierFlags.contains(.control),
                         "windowNumber": event.windowNumber, "windowPoint": NSStringFromPoint(event.locationInWindow),
                         "quartzPoint": NSStringFromPoint(screen)])
        }
        return sent
    }

    // Called after a matching canvas draw in an isolated single-input trial, never during a paced stream.
    func acknowledgement() async -> [String: Any] {
        let selector = NSSelectorFromString("_doAfterNextPresentationUpdate:"), web = probes.web
        guard let input = latestInput, web.responds(to: selector) else { return ["supported": false] }
        return await withCheckedContinuation { continuation in
            var pending = true
            let finish: (Bool) -> Void = { acknowledged in
                guard pending else { return }
                pending = false
                let ms = Double(DispatchTime.now().uptimeNanoseconds - input) / 1e6
                continuation.resume(returning: ["supported": true, "acknowledged": acknowledged, "ms": ms])
            }
            let done: @convention(block) () -> Void = { finish(true) }
            web.perform(selector, with: done)
            DispatchQueue.main.asyncAfter(deadline: .now() + 1) { finish(false) }
        }
    }
}
