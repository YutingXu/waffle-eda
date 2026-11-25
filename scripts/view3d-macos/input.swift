import Cocoa
import Metal
import WebKit

/// Feed only the benchmark's WKWebView. No global input is posted or mouse cursor moved.
@MainActor enum ViewerInput {
    static func displayID(_ screen: NSScreen) -> CGDirectDisplayID {
        (screen.deviceDescription[NSDeviceDescriptionKey("NSScreenNumber")] as? NSNumber)?.uint32Value ?? CGMainDisplayID()
    }

    static func position(window: NSWindow, requested: UInt32?, foreground: Bool) throws {
        if let requested {
            guard let screen = NSScreen.screens.first(where: { displayID($0) == requested }) else {
                throw NSError(domain: "Requested viewer display unavailable", code: 1)
            }
            let room = screen.visibleFrame
            window.setFrameOrigin(NSPoint(x: room.midX - window.frame.width / 2, y: room.midY - window.frame.height / 2))
            guard window.screen.map(displayID) == requested else {
                throw NSError(domain: "Viewer window did not land on requested display", code: 1)
            }
        }
        if foreground {
            window.makeKeyAndOrderFront(nil)
            NSApp.activate(ignoringOtherApps: true)
        }
    }

    static func handle(_ args: [String: Any], web: WKWebView, window: NSWindow) async throws -> [String: Any] {
        let op = args["op"] as? String
        if op == "gpu" {
            let sel = NSSelectorFromString("_gpuProcessIdentifier")
            typealias GetPid = @convention(c) (AnyObject, Selector) -> Int32
            let pid = web.responds(to: sel) ? unsafeBitCast(web.method(for: sel), to: GetPid.self)(web, sel) : 0
            let screen = window.screen ?? NSScreen.main
            let id = screen.map(displayID) ?? CGMainDisplayID()
            let session = CGSessionCopyCurrentDictionary() as? [String: Any]
            let mode = CGDisplayCopyDisplayMode(id)
            return ["metalDevices": MTLCopyAllDevices().map { $0.name }, "separateGPUProcess": pid > 0 && pid != getpid(),
                    "active": NSApp.isActive, "keyWindow": window.isKeyWindow, "windowOcclusionVisible": window.occlusionState.contains(.visible),
                    "windowOrdered": window.isVisible, "windowAlpha": window.alphaValue, "windowBackingScale": window.backingScaleFactor,
                    "displayID": id, "displayName": screen?.localizedName ?? "", "displayHz": mode?.refreshRate ?? 0,
                    "displayPixelsWide": mode?.pixelWidth ?? 0, "displayPixelsHigh": mode?.pixelHeight ?? 0,
                    "displayBuiltin": CGDisplayIsBuiltin(id) != 0, "displayOnline": CGDisplayIsOnline(id) != 0,
                    "screenLocked": session?["CGSSessionScreenIsLocked"] ?? NSNull()]
        }
        guard NSApp.isActive == window.isKeyWindow, web.window === window, window.isVisible else {
            throw NSError(domain: "ViewerInput", code: 1)
        }
        if op == "key" {
            let key = args["key"] as? String
            let codes: [String: UInt16] = ["0":29, "2":19, "3":20]
            guard let key, let code = codes[key] else { throw NSError(domain: "Unsupported viewer shortcut", code: 1) }
            let time = ProcessInfo.processInfo.systemUptime
            for type in [NSEvent.EventType.keyDown, .keyUp] {
                guard let event = NSEvent.keyEvent(with: type, location: .zero, modifierFlags: [], timestamp: time,
                    windowNumber: window.windowNumber, context: nil, characters: key,
                    charactersIgnoringModifiers: key, isARepeat: false, keyCode: code) else {
                    throw NSError(domain: "Cannot create viewer shortcut", code: 1)
                }
                if type == .keyDown { web.keyDown(with: event) } else { web.keyUp(with: event) }
            }
            return ["sent": true]
        }
        let mode = args["mode"] as? String ?? "", count = args["count"] as? Int ?? 1
        let x = args["x"] as? Double ?? 0, y = args["y"] as? Double ?? 0
        let directions = args["directions"] as? [Int] ?? []
        let dx = args["dx"] as? Double ?? 0, dy = args["dy"] as? Double ?? 0
        let hz = args["hz"] as? Int ?? 120
        guard ["orbit", "pan", "zoom", "precision", "calibrate"].contains(mode), (1...600).contains(count),
              (1...240).contains(hz), directions.isEmpty || directions.count == count && directions.allSatisfy({ abs($0) == 1 }) else {
            throw NSError(domain: "ViewerInput", code: 1)
        }
        let flags: NSEvent.ModifierFlags = mode == "pan" ? [.shift] : []
        func at(_ a: Double, _ b: Double) -> NSPoint {
            web.convert(NSPoint(x: a, y: web.isFlipped ? b : web.bounds.height - b), to: nil)
        }
        func mouse(_ type: NSEvent.EventType, _ a: Double, _ b: Double, _ index: Int) {
            guard let event = NSEvent.mouseEvent(with: type, location: at(a, b), modifierFlags: flags,
                timestamp: ProcessInfo.processInfo.systemUptime, windowNumber: window.windowNumber, context: nil,
                eventNumber: index + 1, clickCount: 1, pressure: type == .leftMouseUp || type == .mouseMoved ? 0 : 1) else { return }
            switch type {
            case .leftMouseDown: web.mouseDown(with: event)
            case .leftMouseDragged: web.mouseDragged(with: event)
            case .mouseMoved: web.mouseMoved(with: event)
            default: web.mouseUp(with: event)
            }
        }
        let responsive = args["responsive"] as? Bool == true
        func wheel(_ delta: Int32, precision: Bool) -> Bool {
            guard let cg = CGEvent(scrollWheelEvent2Source: nil, units: precision ? .pixel : .line,
                                   wheelCount: 1, wheel1: delta, wheel2: 0, wheel3: 0),
                  let screen = window.screen else { return false }
            let point = at(x, y), native = window.convertPoint(toScreen: point)
            if !responsive {
                cg.location = CGPoint(x: native.x, y: (NSScreen.screens.first?.frame.height ?? 0) - native.y)
                guard let event = NSEvent(cgEvent: cg) else { return false }
                web.scrollWheel(with: event)
                return true
            }
            let quartz = CGDisplayBounds(displayID(screen))
            cg.location = CGPoint(x: quartz.minX + native.x - screen.frame.minX, y: quartz.minY + screen.frame.maxY - native.y)
            cg.timestamp = DispatchTime.now().uptimeNanoseconds
            let bind = NSSelectorFromString("_eventRelativeToWindow:")
            guard let raw = NSEvent(cgEvent: cg), raw.responds(to: bind),
                  let event = raw.perform(bind, with: window)?.takeUnretainedValue() as? NSEvent,
                  event.window === window, event.cgEvent?.location == cg.location,
                  abs(event.locationInWindow.x - point.x) <= 1, abs(event.locationInWindow.y - point.y) <= 1 else { return false }
            web.scrollWheel(with: event)
            return true
        }
        let wheelMode = mode != "orbit" && mode != "pan"
        var px = x, py = y, sent = 0
        if wheelMode {
            if responsive { mouse(.mouseMoved, x, y, 0) }
        } else { mouse(.leftMouseDown, x, y, 0) }
        let t0 = DispatchTime.now().uptimeNanoseconds
        var offsets = [Double]()
        for i in 1...count {
            let due = t0 + UInt64(i) * (1_000_000_000 / UInt64(hz)), now = DispatchTime.now().uptimeNanoseconds
            if due > now { try await Task.sleep(nanoseconds: due - now) }
            offsets.append(Double(DispatchTime.now().uptimeNanoseconds - t0) / 1e6)
            if wheelMode {
                let direction = directions.isEmpty ? (mode == "zoom" && i % 36 >= 20 ? -1 : 1) : directions[i - 1]
                if wheel(Int32(direction * (mode == "precision" ? 3 : 1)), precision: mode == "precision") { sent += 1 }
            } else {
                let t = Double(i) / Double(count)
                if responsive {
                    px = x + dx * t
                    py = y + dy * t
                } else {
                    px = x + 42 * sin(t * 4 * .pi) + 18 * t
                    py = y + 17 * sin(t * 2 * .pi) + 12 * t
                }
                mouse(.leftMouseDragged, px, py, i)
                sent += 1
            }
        }
        if !wheelMode { mouse(.leftMouseUp, px, py, count + 1) }
        return ["sent": sent, "elapsedMs": Double(DispatchTime.now().uptimeNanoseconds - t0) / 1e6, "offsetsMs": offsets]
    }
}
