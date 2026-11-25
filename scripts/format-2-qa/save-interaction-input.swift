import AppKit
import WebKit

// Private benchmark driver. Events go to the measured application window only.
@MainActor enum ViewerInput {
    static func handle(_ args: [String: Any], web: WKWebView, window: NSWindow) async throws -> [String: Any] {
        let mode = args["mode"] as? String ?? ""
        func time() -> Double { Double(DispatchTime.now().uptimeNanoseconds) / 1_000_000 }
        if mode == "presentation" {
            let selector = NSSelectorFromString("_doAfterNextPresentationUpdate:")
            guard web.responds(to: selector) else { throw NSError(domain: "SaveInteractionPresentation", code: 1) }
            let presented = await withCheckedContinuation { (done: CheckedContinuation<Double, Never>) in
                let block: @convention(block) () -> Void = { done.resume(returning: time()) }
                _ = web.perform(selector, with: block)
            }
            return ["at": presented]
        }
        guard ["pointer", "pan", "wheel", "key"].contains(mode), !NSApp.isActive, !window.isKeyWindow,
              let x = args["x"] as? Double, let y = args["y"] as? Double,
              x.isFinite, y.isFinite, x >= 0, y >= 0, x < web.bounds.width - 20, y < web.bounds.height - 20 else {
            throw NSError(domain: "SaveInteractionInput", code: 1)
        }
        func point(_ a: Double, _ b: Double) -> NSPoint {
            web.convert(NSPoint(x: a, y: web.isFlipped ? b : web.bounds.height - b), to: nil)
        }
        func mouse(_ type: NSEvent.EventType, _ a: Double, _ b: Double, _ number: Int) throws -> NSEvent {
            guard let event = NSEvent.mouseEvent(with: type, location: point(a, b), modifierFlags: [],
                timestamp: ProcessInfo.processInfo.systemUptime, windowNumber: window.windowNumber,
                context: nil, eventNumber: number, clickCount: 1, pressure: type == .rightMouseUp || type == .leftMouseUp ? 0 : 1) else {
                throw NSError(domain: "SaveInteractionMouse", code: 1)
            }
            return event
        }
        let dispatched: Double
        switch mode {
        case "pointer":
            let event = try mouse(.leftMouseDown, x, y, 1)
            dispatched = time()
            web.mouseDown(with: event)
            web.mouseUp(with: try mouse(.leftMouseUp, x, y, 2))
        case "pan", "wheel":
            // Continuous horizontal scroll pans, while a legacy wheel notch follows
            // the ordinary vertical wheel preference. Both use native AppKit events.
            let pan = mode == "pan"
            guard let wheel = CGEvent(scrollWheelEvent2Source: nil, units: pan ? .pixel : .line, wheelCount: 2,
                                      wheel1: pan ? 0 : 1, wheel2: pan ? -18 : 0, wheel3: 0) else {
                throw NSError(domain: "SaveInteractionWheel", code: 1)
            }
            let screen = window.convertPoint(toScreen: point(x, y))
            wheel.location = CGPoint(x: screen.x, y: (NSScreen.screens.first?.frame.height ?? 0) - screen.y)
            guard let event = NSEvent(cgEvent: wheel) else { throw NSError(domain: "SaveInteractionWheel", code: 2) }
            dispatched = time()
            web.scrollWheel(with: event)
        default:
            let event = NSEvent.keyEvent(with: .keyDown, location: point(x, y), modifierFlags: [],
                timestamp: ProcessInfo.processInfo.systemUptime, windowNumber: window.windowNumber, context: nil,
                characters: "\u{F70D}", charactersIgnoringModifiers: "\u{F70D}", isARepeat: false, keyCode: 109)
            guard let event else { throw NSError(domain: "SaveInteractionKey", code: 1) }
            dispatched = time()
            web.keyDown(with: event)
            if let release = NSEvent.keyEvent(with: .keyUp, location: point(x, y), modifierFlags: [],
                timestamp: ProcessInfo.processInfo.systemUptime, windowNumber: window.windowNumber, context: nil,
                characters: "\u{F70D}", charactersIgnoringModifiers: "\u{F70D}", isARepeat: false, keyCode: 109) {
                web.keyUp(with: release)
            }
        }
        return ["at": dispatched]
    }
}
