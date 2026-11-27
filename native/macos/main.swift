import Cocoa
import CoreText
import WebKit
import PDFKit
import UniformTypeIdentifiers

private let translators = TranslatorFiles(Bundle.main.resourceURL?.appendingPathComponent("app/translators.json"))

/// The editor paints the whole window. Its empty caption space hands hit testing back to
/// AppKit, which handles system dragging, double-click, and native window controls.
private final class EditorWindowContent: NSView {
    var captionDragArea = NSRect.zero // WebKit coordinates, measured from the top left.

    override func hitTest(_ point: NSPoint) -> NSView? {
        if let window = window, window.attachedSheet == nil, !window.styleMask.contains(.fullScreen) {
            let location = convert(point, from: superview)
            let pagePoint = NSPoint(x: location.x, y: bounds.maxY - location.y)
            if bounds.contains(location), captionDragArea.contains(pagePoint),
               convert(location, to: nil).y >= window.contentLayoutRect.maxY { return nil }
        }
        return super.hitTest(point)
    }
}

/// Direct touches from a touch display (macOS 27) or a Sidecar iPad: AppKit delivers them only to gesture
/// recognizers. Forwards each contact to the page (EditorWebView.sendTouch); the page takes a stream whose
/// first contact starts on a design canvas. Taken: the recognizer begins, so AppKit drops the emulated mouse
/// events it delayed. Declined: it fails and AppKit delivers them to WebKit. Pointer input never enters.
final class DirectTouchRecognizer: NSGestureRecognizer, NSGestureRecognizerDelegate {
    private enum Route { case deciding, page, system }
    private var route: Route?
    private var ids: [Int: Int] = [:], next = 1 // NSTouch identity hash -> page contact (0 is the mouse stream's)
    private var ownedUntil = -Double.infinity
    /// Fingers are with the page or waiting for its answer, or were a moment ago: an emulated mouse event
    /// now is their duplicate and is dropped. A declined stream's delayed mouse events still reach WebKit.
    var owning: Bool { route == .page || route == .deciding || ProcessInfo.processInfo.systemUptime < ownedUntil }
    /// For the harness, which cannot run AppKit's recognition: "idle", "deciding", "page" or "declined".
    var decision: String { switch route { case nil: return "idle"; case .deciding?: return "deciding"; case .page?: return "page"; case .system?: return "declined" } }

    init() {
        super.init(target: nil, action: nil)
        delegate = self
        allowedTouchTypes = .direct
        // Hold one-finger emulated mouse events until the page has decided, only while a touch display is
        // attached (a Mac without one never delays a click).
        screensChanged()
        NotificationCenter.default.addObserver(self, selector: #selector(screensChanged), name: NSApplication.didChangeScreenParametersNotification, object: nil)
    }
    @objc private func screensChanged() {
        guard #available(macOS 27, *) else { return }
        delaysPrimaryMouseButtonEvents = NSScreen.screens.contains { !$0.touchCapabilities.isEmpty }
    }
    required init?(coder: NSCoder) { nil }

    func gestureRecognizer(_ gestureRecognizer: NSGestureRecognizer, shouldAttemptToRecognizeWith event: NSEvent) -> Bool { false }
    // WebKit (macOS 27) runs its own direct-touch recognizers on the web view (WKAppKitGestureController:
    // WKMouseTrackingGesture*, WKSingleClickGesture, WKPanGesture, WKMagnificationGesture, ...). They turn a
    // finger into DOM mouse and gesture events without passing through mouseDown(with:). Each waits for this
    // recognizer to fail, so a contact the page takes never reaches them; a declined one (chrome) does.
    private func webKitTouch(_ other: NSGestureRecognizer) -> Bool {
        other !== self && other.view === view && other.allowedTouchTypes.contains(.direct)
    }
    func gestureRecognizer(_ gestureRecognizer: NSGestureRecognizer, shouldRecognizeSimultaneouslyWith other: NSGestureRecognizer) -> Bool { !webKitTouch(other) }
    func gestureRecognizer(_ gestureRecognizer: NSGestureRecognizer, shouldBeRequiredToFailBy other: NSGestureRecognizer) -> Bool { webKitTouch(other) }
    /// WebKit's touch recognizers that are tracking now.
    private func webKitActive() -> [NSGestureRecognizer] {
        (view?.gestureRecognizers ?? []).filter { webKitTouch($0) && ($0.state == .began || $0.state == .changed) }
    }

    private var web: EditorWebView? { view as? EditorWebView }
    private func contacts(_ event: NSEvent, _ phase: NSTouch.Phase, add: Bool) -> [(Int, NSPoint)] {
        guard let web = web else { return [] }
        var out: [(Int, NSPoint)] = []
        for touch in event.touches(matching: phase, in: web) where touch.type == .direct {
            let key = touch.identity.hash
            if ids[key] == nil, add { ids[key] = next; next += 1 }
            guard let id = ids[key] else { continue }
            out.append((id, touch.location(in: web)))
            if phase == .ended || phase == .cancelled { ids[key] = nil }
        }
        return out
    }
    override func touchesBegan(with event: NSEvent) {
        super.touchesBegan(with: event)
        // A new stream after every finger lifted starts fresh, even if AppKit has not reset this recognizer yet.
        if ids.isEmpty, route == .page || route == .system { route = nil; next = 1 }
        let started = contacts(event, .began, add: true)
        guard !started.isEmpty, let web = web else { return }
        web.inputLog.touches("began", route == nil || route == .deciding ? "deciding" : route == .page ? "touch scheme" : "WebKit")
        switch route {
        case nil:
            route = .deciding
            web.sendTouch("start", started) { [weak self] taken in self?.decide(taken) }
        case .system?: break
        default: web.sendTouch("start", started)
        }
    }
    override func touchesMoved(with event: NSEvent) {
        super.touchesMoved(with: event)
        guard route != .system, let web = web else { return }
        let moved = contacts(event, .moved, add: false)
        guard !moved.isEmpty else { return }
        web.inputLog.touches("moved", route == .page ? "touch scheme" : "deciding")
        web.sendTouch("move", moved)
        if route == .page { ownedUntil = ProcessInfo.processInfo.systemUptime + 0.5; if state == .began || state == .changed { state = .changed } }
    }
    override func touchesEnded(with event: NSEvent) { super.touchesEnded(with: event); lift(event, .ended) }
    override func touchesCancelled(with event: NSEvent) { super.touchesCancelled(with: event); lift(event, .cancelled) }
    private func lift(_ event: NSEvent, _ phase: NSTouch.Phase) {
        let ended = contacts(event, phase, add: false)
        if !ended.isEmpty, route != .system, let web = web {
            web.inputLog.touches(phase == .cancelled ? "cancelled" : "ended", route == .page ? "touch scheme" : "deciding")
            web.sendTouch(phase == .cancelled ? "cancel" : "end", ended)
        }
        if route == .page { ownedUntil = ProcessInfo.processInfo.systemUptime + 0.5 }
        guard ids.isEmpty, route == .page else { return }
        state = phase == .cancelled ? .cancelled : .ended
    }
    private func decide(_ taken: Bool) {
        guard route == .deciding else { return }
        web?.inputLog.decided(taken)
        if taken {
            route = .page; ownedUntil = ProcessInfo.processInfo.systemUptime + 0.5
            state = ids.isEmpty ? .ended : .began
            // Should one of WebKit's recognizers have started anyway, cancel it (the page also drops its
            // mouse duplicates, canvas-input.js hostDuplicate).
            let active = webKitActive()
            for other in active { other.isEnabled = false; other.isEnabled = true }
            web?.inputLog.note("WebKit touch recognizers")
        } else {
            route = .system; state = .failed
        }
    }
    override func reset() {
        super.reset()
        route = nil; ids = [:]; next = 1
    }
}

/// The local Input Diagnostics panel enables a bounded event log for its own editor view.
/// Closing the panel or losing the page clears these in-memory categories.
final class InputLog {
    private struct Row {
        var kind: String, source: String, route: String, count: Int
    }
    private var rows: [Row] = []
    private var active = false
    private func add(_ kind: String, _ source: String, _ route: String) {
        guard active else { return }
        if var last = rows.last, last.kind == kind, last.source == source, last.route == route {
            last.count = min(last.count + 1, 1000); rows[rows.count - 1] = last; return
        }
        rows.append(Row(kind: kind, source: source, route: route, count: 1))
        if rows.count > 20 { rows.removeFirst(rows.count - 20) }
    }
    private func type(_ event: NSEvent) -> String {
        switch event.type {
        case .leftMouseDown: return "leftMouseDown"
        case .leftMouseDragged: return "leftMouseDragged"
        case .leftMouseUp: return "leftMouseUp"
        case .mouseMoved: return "mouseMoved"
        case .rightMouseDown: return "rightMouseDown"
        case .otherMouseDown: return "otherMouseDown"
        default: return "other"
        }
    }
    func mouse(_ event: NSEvent, _ touch: String?, _ route: String) {
        guard active else { return }
        let source = touch ?? (event.subtype == .tabletPoint ? "pen or tablet" : "mouse or trackpad")
        add(type(event), source, route)
    }
    func scroll(_ event: NSEvent) {
        guard active else { return }
        let trackpad = event.hasPreciseScrollingDeltas && !(event.phase.isEmpty && event.momentumPhase.isEmpty)
        add(event.momentumPhase.isEmpty ? "scrollWheel" : "scrollWheel momentum", trackpad ? "trackpad or Magic Mouse" : event.hasPreciseScrollingDeltas ? "precise wheel" : "mouse wheel",
            "WebKit wheel")
    }
    func gesture(_ kind: String) { add(kind, "trackpad", "WebKit gesture") }
    func proximity() { add("tabletProximity", "pen or tablet", "WebKit") }
    func note(_ kind: String) { add(kind, "host", "-") }
    func touches(_ phase: String, _ route: String) {
        guard active else { return }
        add("NSTouch " + phase, "touch (direct)", route)
    }
    /// The page answered for the stream that was waiting: its rows say where it went.
    func decided(_ taken: Bool) {
        guard active else { return }
        for i in rows.indices where rows[i].route == "deciding" { rows[i].route = taken ? "touch scheme" : "WebKit (not on a canvas)" }
    }
    func stop() { active = false; rows.removeAll() }
    func inspect(_ operation: String) -> [String: Any]? {
        switch operation {
        case "start": active = true
        case "read": break
        case "stop": stop()
        default: return nil
        }
        return ["rows": rows.map { ["event": $0.kind, "source": $0.source, "route": $0.route, "count": $0.count] }]
    }
}

/// The page opens its own context menus and suppresses the web view's everywhere else (workbench.js).
/// Text fields and selected text keep WebKit's editing menu; this strips the page-navigation and
/// new-window entries that menu can still carry (Reload, Back, Open Link in New Window…), and shows
/// nothing when only those were left.
final class EditorWebView: WKWebView {
    let inputLog = InputLog()
    var openDroppedFiles: (([URL]) -> Void)?
    typealias DropLoader = (Operation, @escaping (Result<[String:Any],Error>) -> Void) -> Void
    struct DropSource {
        let file: [String:Any]
        let load: DropLoader
    }
    var butterDropEnabled = false
    var offerTypedDrop: ((Double, Double, DropSource, [URL]) -> Void)?
    private let promiseQueue: OperationQueue = {
        let queue = OperationQueue()
        queue.name = "org.waffle.file-promise"
        queue.maxConcurrentOperationCount = 1
        return queue
    }()
    private static let mediaByExtension = [
        "png":"image/png", "jpg":"image/jpeg", "jpeg":"image/jpeg", "heif":"image/heif", "heic":"image/heic",
        "webp":"image/webp", "svg":"image/svg+xml", "pdf":"application/pdf", "step":"model/step", "stp":"model/step",
        "csv":"text/csv", "wlib":"application/octet-stream", "atrlib":"application/octet-stream",
        "schlib":"application/octet-stream", "pcblib":"application/octet-stream",
        "kicad_sym":"application/octet-stream", "kicad_mod":"application/octet-stream"
    ]

    // WebKit reports both a 40-pixel trackpad update and one physical detent as 40/120.
    // Remember the AppKit detents before WebKit dispatches its trusted DOM event. A busy WebContent
    // process may get one wheel event for several consecutive AppKit detents, stamped at the last one.
    private var wheelSerial = 0
    static let wheelNotchScript = """
        (() => {
          let pending = [];
          const classified = new WeakMap(), windowMs = 250, tolerance = 4;
          window.__waffleMarkWheelNotch = (time, delta, serial, flags, x, y) => {
            pending = pending.filter(mark => mark.time >= time - windowMs).slice(-31);
            pending.push({time, delta, serial, flags, x, y});
          };
          function notches(event) {
            if (!event.isTrusted) return null;
            if (classified.has(event)) return classified.get(event);
            if (!pending.length || event.deltaMode !== 0 || event.deltaX || !Number.isFinite(event.deltaY)) return null;
            const time = performance.timeOrigin + event.timeStamp;
            const flags = +event.shiftKey | (+event.ctrlKey << 1) | (+event.altKey << 2) | (+event.metaKey << 3);
            let matchedStart = -1, matchedEnd = -1, distance = Infinity;
            for (let i = 0; i < pending.length; i++) {
              const tail = pending[i], gap = Math.abs(tail.time - time);
              if (tail.flags !== flags || gap > tolerance || gap > distance) continue;
              let start = -1, sum = 0;
              for (let j = i; j >= 0; j--) {
                const mark = pending[j];
                if (tail.serial - mark.serial !== i - j || tail.time - mark.time > windowMs ||
                    mark.flags !== flags || mark.x !== tail.x || mark.y !== tail.y) break;
                sum += mark.delta;
                if (Math.abs(sum - event.deltaY) < .1) start = j;
              }
              if (start < 0) continue;
              matchedEnd = gap === distance ? -1 : i;
              matchedStart = start;
              distance = gap;
            }
            if (matchedEnd < 0) return null;
            const endTime = pending[matchedEnd].time;
            const matched = pending.splice(0, matchedEnd + 1).slice(matchedStart).map(mark => ({
              deltaY:mark.delta, timeStamp:event.timeStamp + (mark.time - endTime)
            }));
            classified.set(event, matched);
            return matched;
          }
          window.__waffleWheelNotches = notches;
          window.__waffleIsWheelNotch = event => !!notches(event);
          // Keep raw markers aligned even when the wheel is over chrome instead of the board.
          window.addEventListener("wheel", notches, {capture:true, passive:true});
        })();
        """

    override func scrollWheel(with event: NSEvent) {
        inputLog.scroll(event)
        wheelSerial &+= 1
        // Continuous scrolling (including trackpad momentum) stays on the direct WebKit path.
        guard !event.hasPreciseScrollingDeltas, event.phase.isEmpty, event.momentumPhase.isEmpty,
              event.deltaX == 0, event.deltaY != 0 else { return super.scrollWheel(with: event) }
        let time = (Date().timeIntervalSince1970 + event.timestamp - ProcessInfo.processInfo.systemUptime) * 1000
        // WebKit's Scrollbar::pixelsPerLineStep converts non-precise AppKit wheel steps to pixels.
        let delta = -event.deltaY * 40
        let mods = event.modifierFlags
        let flags = (mods.contains(.shift) ? 1 : 0) | (mods.contains(.control) ? 2 : 0) |
                    (mods.contains(.option) ? 4 : 0) | (mods.contains(.command) ? 8 : 0)
        let point = event.cgEvent?.location ?? event.locationInWindow
        evaluateJavaScript("window.__waffleMarkWheelNotch?.(\(time),\(delta),\(wheelSerial),\(flags),\(point.x),\(point.y))") { [weak self] _, _ in
            self?.forwardScrollWheel(event)
        }
    }

    private func forwardScrollWheel(_ event: NSEvent) { super.scrollWheel(with: event) }

    // Touch input. On a Mac with a touch display (macOS 27) AppKit gives direct touches only to gesture
    // recognizers and emulates a mouse from one finger, so WebKit would report pointerType "mouse" and drag a
    // selection rectangle. `fingers` (DirectTouchRecognizer) takes the direct touches and the page decides
    // whether the first contact starts on a design canvas (editor.js __waffleDirectTouch). If it does, the
    // contacts go to the page as touch pointers and AppKit's emulated mouse events are dropped. Otherwise the
    // recognizer fails and AppKit delivers the emulated mouse events to WebKit, so chrome stays tappable.
    // A digitiser that only sends a mouse stream (NSEvent subtype .touch, or a touch-display mouse stream with
    // no physical button down) takes the same route as contact 0. A real mouse, trackpad or pen never does.
    private enum TouchRoute { case deciding([NSEvent]), page, system }
    private var touchRoute: TouchRoute?
    private var swallowing = false // an emulated mouse stream for fingers the page already owns
    let fingers = DirectTouchRecognizer()
    /// Harness only: treat this Mac's screens as touch displays.
    static var assumeTouchDisplay = false
    /// Harness only: hand mouse events straight to WebKit, as macOS 27 WebKit's own touch recognizers do.
    static var harnessMouseThrough = false

    func sendTouch(_ phase: String, _ contacts: [(Int, NSPoint)], decided: ((Bool) -> Void)? = nil) {
        let rows = contacts.map { id, p in "[\(id),\(Double(p.x)),\(Double(isFlipped ? p.y : bounds.height - p.y))]" }
        evaluateJavaScript("window.__waffleDirectTouch?.('\(phase)',[\(rows.joined(separator: ","))]) === true") { result, _ in
            decided?((result as? Bool) == true)
        }
    }
    private func local(_ event: NSEvent) -> NSPoint { convert(event.locationInWindow, from: nil) }
    var touchDisplay: Bool {
        if Self.assumeTouchDisplay { return true }
        guard #available(macOS 27, *) else { return false }
        return !(window?.screen?.touchCapabilities ?? []).isEmpty
    }
    /// Where a left-button mouse event came from: "touch" when a finger made it, nil for a mouse, trackpad or pen.
    private func touchOrigin(_ event: NSEvent) -> String? {
        if event.subtype == .touch { return "touch (mouse subtype)" }
        // A touch never registers in pressedMouseButtons; a quick real click whose mouse-up is already
        // queued stays a mouse.
        guard event.type == .leftMouseDown, event.subtype == .mouseEvent, touchDisplay, NSEvent.pressedMouseButtons & 1 == 0,
              window?.nextEvent(matching: .leftMouseUp, until: .distantPast, inMode: .default, dequeue: false) == nil else { return nil }
        return "touch (emulated mouse)"
    }
    private var streamRoute: String {
        switch touchRoute { case .page?: return "touch scheme"; case .deciding?: return "deciding"; default: return "WebKit" }
    }
    private func systemMouse(_ event: NSEvent) {
        switch event.type {
        case .leftMouseDown: super.mouseDown(with: event)
        case .leftMouseDragged: super.mouseDragged(with: event)
        case .leftMouseUp: super.mouseUp(with: event)
        default: break
        }
    }
    private func touchMouse(_ event: NSEvent) {
        switch touchRoute {
        case .deciding(let queued)?: touchRoute = .deciding(queued + [event])
        case .system?:
            systemMouse(event)
            if event.type == .leftMouseUp { touchRoute = nil }
        case .page?:
            sendTouch(event.type == .leftMouseUp ? "end" : "move", [(0, local(event))])
            if event.type == .leftMouseUp { touchRoute = nil }
        case nil:
            guard event.type == .leftMouseDown else { return }
            touchRoute = .deciding([])
            sendTouch("start", [(0, local(event))]) { [weak self] taken in self?.decide(taken, event) }
        }
    }
    private func decide(_ taken: Bool, _ down: NSEvent) {
        guard case .deciding(let queued)? = touchRoute else { return }
        touchRoute = taken ? .page : .system
        inputLog.decided(taken)
        // A finger on chrome stays a mouse stream for WebKit; mark it so no :hover fill sticks (shell.js).
        if !taken { evaluateJavaScript("document.documentElement.dataset.pointer='touch'", completionHandler: nil); systemMouse(down) }
        for event in queued { touchMouse(event) }
    }
    override func mouseDown(with event: NSEvent) {
        if Self.harnessMouseThrough { return super.mouseDown(with: event) }
        swallowing = false
        if fingers.owning, event.subtype != .tabletPoint, NSEvent.pressedMouseButtons & 1 == 0 {
            swallowing = true; inputLog.mouse(event, "touch (emulated mouse)", "dropped: fingers already on the canvas"); return
        }
        let origin = touchRoute == nil ? touchOrigin(event) : "touch"
        inputLog.mouse(event, origin, origin == nil ? "WebKit" : "deciding")
        origin == nil ? super.mouseDown(with: event) : touchMouse(event)
    }
    override func mouseDragged(with event: NSEvent) {
        if Self.harnessMouseThrough { return super.mouseDragged(with: event) }
        if swallowing { return }
        inputLog.mouse(event, touchRoute == nil ? nil : "touch", streamRoute)
        touchRoute == nil ? super.mouseDragged(with: event) : touchMouse(event)
    }
    override func mouseUp(with event: NSEvent) {
        if Self.harnessMouseThrough { return super.mouseUp(with: event) }
        if swallowing { swallowing = false; return }
        inputLog.mouse(event, touchRoute == nil ? nil : "touch", streamRoute)
        touchRoute == nil ? super.mouseUp(with: event) : touchMouse(event)
    }
    // A finger never hovers: a touchscreen move without a press would show hover cards and outlines.
    override func mouseMoved(with event: NSEvent) {
        let finger = event.subtype == .touch
        inputLog.mouse(event, finger ? "touch (mouse subtype)" : nil, finger ? "dropped: a finger never hovers" : "WebKit")
        if !finger { super.mouseMoved(with: event) }
    }
    override func rightMouseDown(with event: NSEvent) { inputLog.mouse(event, nil, "WebKit"); super.rightMouseDown(with: event) }
    override func otherMouseDown(with event: NSEvent) { inputLog.mouse(event, nil, "WebKit"); super.otherMouseDown(with: event) }
    override func magnify(with event: NSEvent) { inputLog.gesture("pinch"); super.magnify(with: event) }
    override func rotate(with event: NSEvent) { inputLog.gesture("rotate"); super.rotate(with: event) }
    override func tabletProximity(with event: NSEvent) { inputLog.proximity(); super.tabletProximity(with: event) }

    private func fileDrop(_ sender: NSDraggingInfo) -> [URL]? {
        let options: [NSPasteboard.ReadingOptionKey: Any] = [.urlReadingFileURLsOnly: true]
        guard let urls = sender.draggingPasteboard.readObjects(forClasses: [NSURL.self], options: options) as? [URL], !urls.isEmpty else { return nil }
        return urls.filter {
            if ProjectFileType.documentName($0) { return (try? ProjectFileType.checkSelection($0)) != nil }
            return translators.accepts($0) || ProjectFileType.projectName($0)
        }
    }

    private func dropSource(_ sender: NSDraggingInfo) -> DropSource? {
        guard butterDropEnabled, sender.draggingSourceOperationMask.contains(.copy) else { return nil }
        let board = sender.draggingPasteboard
        let options: [NSPasteboard.ReadingOptionKey: Any] = [.urlReadingFileURLsOnly: true]
        if let urls = board.readObjects(forClasses: [NSURL.self], options: options) as? [URL], urls.count == 1,
           let url = urls.first, let mime = Self.mediaByExtension[url.pathExtension.lowercased()],
           let info = try? url.resourceValues(forKeys:[.isRegularFileKey,.fileSizeKey]), info.isRegularFile == true,
           let size = info.fileSize {
            return DropSource(file:["name":url.lastPathComponent,"mime":mime,"size":size]) { cancellation, done in
                DispatchQueue.global(qos:.userInitiated).async {
                    done(Result { try Self.typedDropBytes(url, cancellation:cancellation) })
                }
            }
        }
        if let receivers = board.readObjects(forClasses:[NSFilePromiseReceiver.self], options:nil) as? [NSFilePromiseReceiver],
           receivers.count == 1, let promise = receivers.first, promise.fileTypes.count == 1,
           let kind = promise.fileTypes.first.flatMap({ UTType($0) }),
           kind.conforms(to:.pdf) || kind.conforms(to:.image) {
            let names = promise.fileNames
            let name = names.first ?? kind.preferredFilenameExtension.map { "Dropped." + $0 }
            guard names.count <= 1, let name,
                  let mime = Self.mediaByExtension[URL(fileURLWithPath:name).pathExtension.lowercased()] else { return nil }
            return DropSource(file:["name":name,"mime":mime,"virtual":names.isEmpty]) { [promiseQueue] cancellation, done in
                guard !cancellation.isCancelled else { done(.failure(CocoaError(.userCancelled))); return }
                let stage = FileManager.default.temporaryDirectory.appendingPathComponent("waffle-drop-"+UUID().uuidString,isDirectory:true)
                do { try FileManager.default.createDirectory(at:stage,withIntermediateDirectories:false,
                         attributes:[.posixPermissions:0o700]) }
                catch { done(.failure(error)); return }
                // Retain the directory itself as authority. A promised name may
                // not resolve through a replaced directory or symbolic link.
                let fd = Darwin.open(stage.path,O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC)
                guard fd >= 0 else {
                    try? FileManager.default.removeItem(at:stage)
                    done(.failure(HostFiles.failure("The promised destination could not be opened.")))
                    return
                }
                let root = FileHandle(fileDescriptor:fd,closeOnDealloc:true)
                promise.receivePromisedFiles(atDestination:stage, options:[:], operationQueue:promiseQueue) { url,error in
                    defer { try? FileManager.default.removeItem(at:stage) }
                    if let error = error { done(.failure(error)); return }
                    done(Result {
                        guard url.standardizedFileURL.deletingLastPathComponent() == stage.standardizedFileURL else {
                            throw HostFiles.failure("The promised file is outside its temporary destination.")
                        }
                        return try Self.typedDropBytes(url, cancellation:cancellation, promisedRoot:root)
                    })
                }
            }
        }
        if board.types?.contains(.pdf) == true {
            return DropSource(file:["name":"Dropped.pdf","mime":"application/pdf"]) { cancellation, done in
                guard !cancellation.isCancelled else { done(.failure(CocoaError(.userCancelled))); return }
                guard let data = board.data(forType:.pdf), !data.isEmpty, data.count <= 128<<20,
                      FolderTransactions.isPDF(data) else {
                    done(.failure(HostFiles.failure("The dropped data is not a supported PDF."))); return
                }
                DispatchQueue.global(qos:.userInitiated).async {
                    guard !cancellation.isCancelled else { done(.failure(CocoaError(.userCancelled))); return }
                    done(.success(["name":"Dropped.pdf","mime":"application/pdf","data":data.base64EncodedString()]))
                }
            }
        }
        return nil
    }

    private static func typedDropBytes(_ url:URL, cancellation:Operation, promisedRoot:FileHandle? = nil) throws -> [String:Any] {
        func check() throws { if cancellation.isCancelled { throw CocoaError(.userCancelled) } }
        try check()
        let name = url.lastPathComponent
        guard name.utf8.count <= 255, name.rangeOfCharacter(from:.controlCharacters) == nil,
              let mime = mediaByExtension[url.pathExtension.lowercased()],
              promisedRoot == nil || mime == "application/pdf" || mime.hasPrefix("image/") else {
            throw HostFiles.failure("The selected drop is not a supported file.")
        }
        let cap = mime == "model/step" ? 32<<20 : mime == "text/csv" ? 65536 :
            mime == "application/octet-stream" ? 16<<20 : 128<<20
        let data: Data
        if let root = promisedRoot {
            let fd = Darwin.openat(root.fileDescriptor,name,O_RDONLY | O_NOFOLLOW | O_CLOEXEC | O_NONBLOCK)
            guard fd >= 0 else { throw HostFiles.failure("The promised file could not be opened.") }
            let file = FileHandle(fileDescriptor:fd,closeOnDealloc:true)
            var info = stat()
            guard fstat(fd,&info) == 0, (info.st_mode & S_IFMT) == S_IFREG, info.st_nlink == 1,
                  info.st_size > 0, info.st_size <= cap else { throw HostFiles.failure("The promised file has an invalid type or size.") }
            var bytes = Data()
            while bytes.count < info.st_size {
                try check()
                guard let chunk = try file.read(upToCount:min(Int(info.st_size)-bytes.count,1<<20)),
                      !chunk.isEmpty else { break }
                bytes.append(chunk)
            }
            data = bytes
            guard data.count == info.st_size, try file.read(upToCount:1)?.isEmpty != false else {
                throw HostFiles.failure("The promised file changed while reading.")
            }
        } else {
            (data,_) = try HostFiles.readRegular(url,cap:cap,check:check)
        }
        try check()
        guard !data.isEmpty, mime != "application/pdf" || FolderTransactions.isPDF(data) else {
            throw HostFiles.failure("The dropped file does not match its type.")
        }
        return ["name":name, "mime":mime, "data":data.base64EncodedString()]
    }

    override func draggingEntered(_ sender: NSDraggingInfo) -> NSDragOperation {
        if dropSource(sender) != nil { return .copy }
        guard let urls = fileDrop(sender) else { return super.draggingEntered(sender) }
        return !urls.isEmpty && sender.draggingSourceOperationMask.contains(.copy) ? .copy : []
    }

    override func draggingUpdated(_ sender: NSDraggingInfo) -> NSDragOperation {
        if dropSource(sender) != nil { return .copy }
        guard let urls = fileDrop(sender) else { return super.draggingUpdated(sender) }
        return !urls.isEmpty && sender.draggingSourceOperationMask.contains(.copy) ? .copy : []
    }

    override func prepareForDragOperation(_ sender: NSDraggingInfo) -> Bool {
        if dropSource(sender) != nil { return true }
        guard let urls = fileDrop(sender) else { return super.prepareForDragOperation(sender) }
        return !urls.isEmpty && sender.draggingSourceOperationMask.contains(.copy)
    }

    override func performDragOperation(_ sender: NSDraggingInfo) -> Bool {
        if let source = dropSource(sender), let offer = offerTypedDrop {
            let point = convert(sender.draggingLocation,from:nil)
            offer(point.x/max(1,bounds.width),(bounds.maxY-point.y)/max(1,bounds.height),source,fileDrop(sender) ?? [])
            return true
        }
        guard let urls = fileDrop(sender) else { return super.performDragOperation(sender) }
        guard !urls.isEmpty, let open = openDroppedFiles else { return false }
        open(urls)
        return true
    }

    static let hidden: Set<String> = ["WKMenuItemIdentifierReload", "WKMenuItemIdentifierGoBack", "WKMenuItemIdentifierGoForward",
        "WKMenuItemIdentifierOpenLinkInNewWindow", "WKMenuItemIdentifierDownloadLinkedFile", "WKMenuItemIdentifierOpenImageInNewWindow",
        "WKMenuItemIdentifierDownloadImage", "WKMenuItemIdentifierOpenFrameInNewWindow", "WKMenuItemIdentifierOpenMediaInNewWindow",
        "WKMenuItemIdentifierDownloadMedia"]
    static func prune(_ menu: NSMenu) {
        for item in menu.items where hidden.contains(item.identifier?.rawValue ?? "") { menu.removeItem(item) }
        while let first = menu.items.first, first.isSeparatorItem { menu.removeItem(first) }
        while let last = menu.items.last, last.isSeparatorItem { menu.removeItem(last) }
    }
    override func willOpenMenu(_ menu: NSMenu, with event: NSEvent) {
        Self.prune(menu)
        super.willOpenMenu(menu, with: event)
    }

    // Force click and three-finger tap would open WebKit's Look Up popover or a link preview over
    // the chrome, which no native control does. The page's own menus carry the actions instead.
    override func quickLook(with event: NSEvent) {}
    override func viewDidMoveToWindow() {
        super.viewDidMoveToWindow()
        guard let immediate = NSClassFromString("NSImmediateActionGestureRecognizer") else { return }
        for recognizer in gestureRecognizers where recognizer.isKind(of: immediate) { removeGestureRecognizer(recognizer) }
    }
}

/// Render menu-style key hints on request using the installed AppKit art and menu font.
private enum MacShortcutGlyphs {
    private static let symbols: [Character: String] = [
        "⌃": "control", "⌥": "option", "⇧": "shift", "⌘": "command", "⏎": "return",
        "⎋": "escape", "⇥": "arrow.right.to.line", "⌫": "delete.left", "⌦": "delete.right",
        "↑": "arrow.up", "↓": "arrow.down", "←": "arrow.left", "→": "arrow.right",
        "↖": "arrow.up.left", "↘": "arrow.down.right", "⇞": "arrow.up.to.line", "⇟": "arrow.down.to.line"
    ]
    private static let pointSize: CGFloat = 12

    static func render(_ labels: [String]) -> [String: [String: Any]] {
        let font = NSFont.menuFont(ofSize: pointSize)
        let configuration = NSImage.SymbolConfiguration(pointSize: font.pointSize, weight: .regular, scale: .medium)
        var images: [Character: NSImage] = [:]
        var result: [String: [String: Any]] = [:]
        for label in labels.prefix(32) where result[label] == nil && (1...64).contains(label.utf8.count) {
            if let rendered = draw(label, font: font, configuration: configuration, images: &images) {
                result[label] = rendered
            }
        }
        return result
    }

    private static func draw(_ label: String, font: NSFont, configuration: NSImage.SymbolConfiguration,
                             images: inout [Character: NSImage]) -> [String: Any]? {
        var parts: [(width: CGFloat, draw: (CGContext, CGFloat, CGFloat) -> Void)] = []
        var text = ""
        var ascent = font.ascender
        var descent = -font.descender
        func flushText() {
            guard !text.isEmpty else { return }
            let line = CTLineCreateWithAttributedString(NSAttributedString(string: text, attributes: [
                .font: font, .foregroundColor: NSColor.black
            ]))
            parts.append((CGFloat(CTLineGetTypographicBounds(line, nil, nil, nil)), { context, x, baseline in
                context.textPosition = CGPoint(x: x, y: baseline)
                CTLineDraw(line, context)
            }))
            text = ""
        }
        for character in label {
            if let name = symbols[character] {
                flushText()
                if images[character] == nil {
                    images[character] = NSImage(systemSymbolName: name, accessibilityDescription: nil)?
                        .withSymbolConfiguration(configuration)
                }
                guard let image = images[character] else { return nil }
                let alignment = image.alignmentRect
                let size = image.size
                ascent = max(ascent, size.height - alignment.minY)
                descent = max(descent, alignment.minY)
                parts.append((size.width, { _, x, baseline in
                    image.draw(in: NSRect(x: x, y: baseline - alignment.minY, width: size.width, height: size.height))
                }))
            } else {
                guard let scalar = character.asciiValue, (32...126).contains(scalar) else { return nil }
                text.append(character)
            }
        }
        flushText()

        let width = ceil(parts.reduce(CGFloat.zero) { $0 + $1.width })
        let baseline = ceil(descent)
        let height = ceil(ascent) + baseline
        // Oversample the same menu-font layout for Retina displays and editor zoom.
        let scale: CGFloat = 3
        guard width > 0, width <= 256,
              let context = CGContext(data: nil, width: Int(width * scale), height: Int(height * scale),
                                      bitsPerComponent: 8, bytesPerRow: 0, space: CGColorSpaceCreateDeviceRGB(),
                                      bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue) else { return nil }
        context.scaleBy(x: scale, y: scale)
        context.textMatrix = .identity
        NSGraphicsContext.saveGraphicsState()
        NSGraphicsContext.current = NSGraphicsContext(cgContext: context, flipped: false)
        var x: CGFloat = 0
        for part in parts {
            part.draw(context, x, baseline)
            x += part.width
        }
        NSGraphicsContext.restoreGraphicsState()
        guard let rendered = context.makeImage(),
              let bytes = NSBitmapImageRep(cgImage: rendered).representation(using: .png, properties: [:]) else { return nil }
        return ["png": bytes.base64EncodedString(), "width": width / pointSize,
                "height": height / pointSize, "descent": baseline / pointSize]
    }
}

final class Desktop: NSObject, NSApplicationDelegate, NSWindowDelegate, WKScriptMessageHandler, WKUIDelegate, WKNavigationDelegate, NSMenuDelegate {
    // ProMotion: WebKit paces page rendering updates (requestAnimationFrame, canvas frames) near 60 fps
    // by default ("Prefer Page Rendering Updates near 60fps", on in Safari and WKWebView alike), so a
    // 120 Hz display would get 60 editor frames a second. Turning it off lets frames follow the display.
    // The switch is WebKit SPI (the feature list Safari's Feature Flags use), looked up at run time: a
    // WebKit without it keeps its default.
    static func unpinFrameRate(_ prefs: WKPreferences) {
        let list = NSSelectorFromString("_features"), set = NSSelectorFromString("_setEnabled:forFeature:")
        let type: AnyObject = WKPreferences.self
        guard type.responds(to: list), prefs.responds(to: set),
              let features = type.perform(list)?.takeUnretainedValue() as? [NSObject],
              let near60 = features.first(where: { ($0.value(forKey: "key") as? String) == "PreferPageRenderingUpdatesNear60FPSEnabled" }) else { return }
        typealias SetFeature = @convention(c) (AnyObject, Selector, Bool, AnyObject) -> Void
        unsafeBitCast(prefs.method(for: set), to: SetFeature.self)(prefs, set, false, near60)
    }
    private var window: NSWindow!
    private var web: WKWebView!
    private struct CaptionInsets: Equatable {
        var left = 0
        var right = 0
        var height = 0
    }
    private var lastCaptionInsets = CaptionInsets()
    private var captionLayoutObserver: NSKeyValueObservation?
    private var page: URL!
    private var incoming: [URL] = []
    private var incomingLinks: [String] = []
    private var visibleProjectIdentity: String?
    private final class WorkspaceGroup {
        let project: String
        let manifest: URL
        weak var writer: Desktop?
        init(project: String, manifest: URL, writer: Desktop) {
            self.project = project
            self.manifest = manifest
            self.writer = writer
        }
    }
    private var workspaceGroup: WorkspaceGroup?
    private var isWorkspacePeer: Bool { workspaceGroup.map { $0.writer !== self } ?? false }
    private var workspaceWindow: String?
    private var workspaceTab: String?
    private static var editors: [Desktop] = []
    private static weak var documentFitMenuItem: NSMenuItem?
    private static var frontEditor: Desktop? {
        editors.first { $0.window === NSApp.keyWindow || $0.window === NSApp.mainWindow } ?? editors.last
    }
    private var hasProject = false
    private var openingProject = false
    private var openingProjectPath: URL?
    private var powerObservers: [NSObjectProtocol] = []
    private var initialPageReady = false
    private var bridgeSource = ""
    private var webProcessAvailable = false
    private var restartedRenderer = false
    // The window stays transparent until the page has painted what launch settles on (launchSettleScript),
    // so its first visible frame is the start page or the reopened project, never the bare window or the
    // empty workbench before them. The timer shows an ordinary launch or a detached-window failure if needed.
    private var revealTimer: Timer?
    // Responsiveness watchdog (probeResponsive): a ping is outstanding, the "not responding" sheet,
    // and a restart the user asked for from it (the termination then restarts without asking again).
    private var probeOutstanding = false
    private var hangAlert: NSAlert?
    private var restartRequested = false
    private static var inputMonitor: Any?
    private var editorSession: String?
    private var crashedFolder: URL?
    private static let requestPageSize = 1 << 32
    private var requestBase: Int { restartedRenderer ? Self.requestPageSize : 0 }
    private var discardApproved = false
    let folderQueue = DispatchQueue(label: "org.waffle.folder-transactions", qos: .userInitiated)
    private var folders: [String: FolderTransactions] = [:]       // folderQueue only
    private var nativeMembers: [String: NativeMemberFile] = [:]   // folderQueue only
    private var selectedDocumentCopies: [String:String] = [:]
    private var installedDocumentCopies: [String:String] = [:]
    private var folderWatches: [String: FolderWatch] = [:]
    private var folderSources: [String: (grant: String, owner: String, type: String, handle: FileHandle)] = [:]
    // Only an accepted import can reuse its native export target. The page sees opaque tokens.
    private var reportedImportID: String?
    private var restoredImport: (session:String,draft:String,key:String,format:String)?
    private var pendingImportTokens = Set<String>()
    private var boundImport: (session:String,token:String,key:String,paths:[String])?
    private var importTargets: [String:[String:Any]] = [:]
    private var importOperations: [String:()->Void] = [:]
    private var retainedInputs: [String:(URL,String,Int)] = [:] // folderQueue, selected files only
    private var folderEventSequence = 0
    private var applyingFolders = Set<String>()                 // main thread until the install result arrives
    private var pendingFolderRequests = 0
    private var visibleFolder: (grant: String, manifest: URL)?

    private var pickedHistory: (token: String, path: URL)?
    private var gitSource: (token: String, path: URL)?
    private static let historyTypes: Set<String> = ["prjpcb", "schdoc", "pcbdoc", "kicad_pro", "kicad_sch", "kicad_pcb"]
    private static let sourceQueries: Set<String> = ["projectLog", "projectBlobs", "sourceRevision", "sourceLog"]
    private var selectedSource: AltiumCopySource?
    private static let sharedRecent = RecentProjects()
    private var recent: RecentProjects { Self.sharedRecent }
    private var pendingManifest: URL?
    private let libraryReads = LibraryReads()
    // Lock and presence sidecars (CollabLocks, HostState.swift): their own queue, so a slow share never delays a save.
    private let locks = CollabLocks()
    private let lan = LanRelay()   // same-network sessions (LanRelay.swift): listens only while shared
    private let collabQueue = DispatchQueue(label: "org.waffle.collab")
    private var openRecentMenu: NSMenu?
    private let sourceTypes = Set(["schdoc", "pcbdoc"])
    // Files page code may ask the user to pick (read-only, through an open panel).
    private let exchangeInputs = Set(["waffle-block", "waffle-rules", "waffle-eco", "waffle-ai", "atrgroup", "rul", "waffle", "schdoc", "pcbdoc",
                                      "atrlib", "json", "waffle-keys", "waffle-fab", "csv", "dxf",
                                      "png", "jpg", "jpeg", "svg", "webp", "bmp", "gif"])
    // Exchange files plus manufacturing outputs: reports, drawings, archives, Gerber
    // layers (Altium extensions, G1-G30 for inner layers) and Excellon drill files.
    private let exchangeOutputs: Set<String> = {
        var types = Set(["waffle-block", "waffle-rules", "waffle-eco", "waffle-ai", "atrgroup", "rul", "kicad_pcb", "kicad_sch", "csv",
                         "txt", "drl", "svg", "html", "zip", "xlsx", "pdf", "step", "stp", "glb",
                         "gtl", "gbl", "gto", "gbo", "gts", "gbs", "gtp", "gbp", "gm1", "gko"])
        for layer in 1...30 { types.insert("g\(layer)") }
        return types
    }()

    func applicationDidFinishLaunching(_ notification: Notification) {
        // Match the native editor's text-entry rules before the first WKWebView is created.
        // Explicit user defaults take precedence over these registered values.
        UserDefaults.standard.register(defaults: [
            "WebAutomaticQuoteSubstitutionEnabled": false, "WebAutomaticDashSubstitutionEnabled": false,
            "WebAutomaticTextReplacementEnabled": false, "WebAutomaticLinkDetectionEnabled": false,
            "WebGrammarCheckingEnabled": false
        ])
        createEditorWindow()
    }

    private func createEditorWindow() {
        guard let resources = Bundle.main.resourceURL else { NSApp.terminate(nil); return }
        page = resources.appendingPathComponent("app/index.html").standardizedFileURL
        guard let source = try? String(contentsOf: resources.appendingPathComponent("bridge.js"), encoding: .utf8),
              FileManager.default.fileExists(atPath: page.path) else {
            let alert = NSAlert()
            alert.messageText = "Waffle could not find its editor files."
            alert.runModal()
            NSApp.terminate(nil)
            return
        }
        bridgeSource = source
        let screenSize = NSScreen.main?.visibleFrame.size ?? NSSize(width: 1350, height: 850)
        let size = NSSize(width: min(1380, screenSize.width * 0.94), height: min(870, screenSize.height * 0.91))
        window = NSWindow(contentRect: NSRect(origin: .zero, size: size),
                          styleMask: [.titled, .closable, .miniaturizable, .resizable, .fullSizeContentView],
                          backing: .buffered, defer: false)
        window.delegate = self
        window.title = "Waffle"
        window.titleVisibility = .hidden
        window.titlebarAppearsTransparent = true
        window.titlebarSeparatorStyle = .none
        window.minSize = NSSize(width: 770, height: 500)
        window.backgroundColor = Self.appBackground
        window.isReleasedWhenClosed = false
        window.center()
        window.setFrameAutosaveName("Waffle editor")
        if let previous = Self.frontEditor?.window {
            window.cascadeTopLeft(from: NSPoint(x: previous.frame.minX, y: previous.frame.maxY))
        } else { buildMenu() }
        Self.editors.append(self)
        Self.watchInput()
        window.alphaValue = 0
        let detached = isWorkspacePeer
        let reveal = Timer(timeInterval: detached ? 15 : 2, repeats: false) { [weak self] _ in
            if detached { self?.workspaceLaunchFailed() }
            else { self?.revealWindow() }
        }
        RunLoop.main.add(reveal, forMode: .common)
        revealTimer = reveal
        web = makeWebView()
        attachEditorWebView()
        captionLayoutObserver = window.observe(\.contentLayoutRect) { [weak self] _, _ in self?.updateCaptionInsets() }
        loadEditor()
        window.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
        watchPower()
    }

    private func revealWindow() {
        guard let timer = revealTimer else { return }
        timer.invalidate()
        revealTimer = nil
        window.alphaValue = 1
    }

    private func workspaceLaunchFailed() {
        guard revealTimer != nil, isWorkspacePeer else { return }
        // The placeholder editor remains hidden even when a snapshot never arrives.
        initialPageReady = false
        webProcessAvailable = false
        web.isHidden = true
        web.stopLoading()
        revealWindow()
        let alert = NSAlert()
        alert.messageText = "The detached window couldn’t open."
        alert.informativeText = "Try opening the tab again from the project’s main window."
        alert.addButton(withTitle: "Close Window")
        alert.beginSheetModal(for: window) { [weak self] _ in
            if let self, self.web != nil { self.window.close() }
        }
    }

    /// Launch settled in the page: show the window once WebKit has presented that frame to the window server.
    private func revealAfterPresentation() {
        let selector = NSSelectorFromString("_doAfterNextPresentationUpdate:")
        guard revealTimer != nil, let web = web, web.responds(to: selector) else { revealWindow(); return }
        let done: @convention(block) () -> Void = { [weak self] in self?.revealWindow() }
        web.perform(selector, with: done)
    }

    private func attachEditorWebView() {
        let content = EditorWindowContent(frame: NSRect(origin: .zero, size: window.frame.size))
        web.frame = content.bounds
        web.autoresizingMask = [.width, .height]
        content.addSubview(web)
        window.contentView = content
    }

    private func captionInsets() -> CaptionInsets {
        guard !window.styleMask.contains(.fullScreen), let content = window.contentView else { return CaptionInsets() }
        let top = content.convert(content.bounds, to: nil).maxY
        var insets = CaptionInsets(height: Int(ceil(max(0, top - window.contentLayoutRect.maxY))))
        let buttons: [NSWindow.ButtonType] = [.closeButton, .miniaturizeButton, .zoomButton]
        let controls = buttons.compactMap { kind -> NSRect? in
            guard let button = window.standardWindowButton(kind), !button.isHiddenOrHasHiddenAncestor else { return nil }
            return content.convert(button.convert(button.bounds, to: nil), from: nil)
        }.reduce(NSRect.null) { $0.union($1) }
        if !controls.isEmpty {
            if controls.midX < content.bounds.midX { insets.left = Int(ceil(controls.maxX - content.bounds.minX)) + 10 }
            else { insets.right = Int(ceil(content.bounds.maxX - controls.minX)) + 10 }
        }
        return insets
    }

    private func updateCaptionInsets() {
        guard initialPageReady, webProcessAvailable else { return }
        let insets = captionInsets()
        guard lastCaptionInsets != insets else { return }
        lastCaptionInsets = insets
        web.evaluateJavaScript("window.__atriumSetCaptionInsets(\(insets.left), \(insets.right), \(insets.height))", completionHandler: nil)
    }

    func windowDidEnterFullScreen(_ notification: Notification) { updateCaptionInsets() }
    func windowDidExitFullScreen(_ notification: Notification) { updateCaptionInsets() }

    private func installCaptionScript(_ insets: CaptionInsets) -> String {
        """
        (() => {
          let captionHeight = 0, updateArea;
          const setInsets = (left, right, height) => {
            const root = document.documentElement;
            root.dataset.atriumNativeTitlebar = 'macos';
            root.style.setProperty('--macos-caption-inset', left + 'px');
            root.style.setProperty('--macos-caption-right-inset', right + 'px');
            root.style.setProperty('--macos-caption-height', height + 'px');
            captionHeight = height;
            updateArea?.();
          };
          window.__atriumSetCaptionInsets = setInsets;
          setInsets(\(insets.left), \(insets.right), \(insets.height));
          document.addEventListener('DOMContentLoaded', () => {
            const drag = document.querySelector('.appbar-leading > [data-caption-drag]');
            if (!drag) return;
            let previous = '';
            // A full-window surface (.ui-fullwindow) covers the app bar and its blank caption too.
            const overlays = 'dialog[open], .appbar details[open] .menu-items, .nav-menu, .ui-fullwindow';
            const publish = () => {
              const rect = drag.getBoundingClientRect();
              const bottom = Math.min(rect.bottom, captionHeight);
              const covered = rect.width > 0 && bottom > rect.top && [...document.querySelectorAll(overlays)].some(overlay => {
                const box = overlay.getBoundingClientRect();
                return box.width > 0 && box.height > 0 && box.left < rect.right && box.right > rect.left &&
                  box.top < bottom && box.bottom > rect.top && getComputedStyle(overlay).visibility === 'visible';
              });
              const area = !covered && rect.width > 0 && bottom > rect.top ? [rect.left, rect.top, rect.width, bottom - rect.top] : [];
              const key = area.join(',');
              if (key === previous) return;
              previous = key;
              window.webkit.messageHandlers.atriumHost.postMessage(JSON.stringify({action: 'captionDragArea', area}));
            };
            let pending = false;
            updateArea = () => {
              if (pending) return;
              pending = true;
              requestAnimationFrame(() => { pending = false; publish(); });
            };
            const layout = new ResizeObserver(publish);
            layout.observe(drag.parentElement);
            for (const child of drag.parentElement.children) layout.observe(child);
            // Root popovers attach to the body. Submenus can fit upwards into the caption.
            const disclosure = 'dialog, .appbar details, .appbar .submenu-trigger, .nav-menu [aria-haspopup=menu]';
            const overlayChanges = new MutationObserver(records => {
              if (records.some(record => record.type === 'attributes' ? record.target.matches(disclosure) :
                [...record.addedNodes, ...record.removedNodes].some(node => node.matches?.('dialog, .nav-menu, .ui-fullwindow')))) updateArea();
            });
            overlayChanges.observe(document.documentElement, {subtree: true, attributeFilter: ['open', 'aria-expanded']});
            overlayChanges.observe(document.body, {childList: true});
            publish();
          }, {once: true});
        })()
        """
    }

    private func systemAccent() -> String {
        guard let color = NSColor.controlAccentColor.usingColorSpace(.sRGB) else { return "null" }
        return String(format: "\"#%02x%02x%02x\"", Int((color.redComponent * 255).rounded()),
                      Int((color.greenComponent * 255).rounded()), Int((color.blueComponent * 255).rounded()))
    }

    /// Tells the host once launch has settled and that frame is on screen: a dialog is open (the start page, a
    /// recovery prompt), a project is showing, or the start page is off. A transparent window is occluded, so the
    /// page is hidden and gets no animation frames: a timer checks every 16 ms, for at most 2 s.
    static let launchSettleScript = """
        (() => {
          let checks = 0;
          let recovery;
          let recovered = false;
          const noStartPage = () => {
            if (document.readyState !== 'complete' || globalThis.__atriumOpeningProject ||
                globalThis.AtriumPref?.get('general.startPage') !== 'never') return false;
            // Recovery can still reopen a project even when Welcome is disabled.
            recovery ??= Promise.resolve(globalThis.AtriumAutosave?.boot?.()).catch(() => {}).then(() => { recovered = true; check(); });
            return recovered;
          };
          let done = false;
          const check = () => {
            if (done || document.readyState === 'loading') return false;
            const editor = globalThis.AtriumNavHost, dialog = document.querySelector('dialog[open]');
            if (!dialog && editor?.isStarter?.() !== false && !noStartPage()) return false;
            done = true; dialogs.disconnect();
            window.removeEventListener('atrium-recovery-restored', checkRestored);
            const post = () => {
              // The host waits for WebKit to present the settled frame before revealing the window.
              window.webkit.messageHandlers.atriumHost.postMessage('{"action":"launchReady"}');
            };
            if (dialog?.matches('.sp-dialog.sp-launch') || !editor?.prepareLaunch) post();
            else Promise.resolve(editor.prepareLaunch()).then(post, error => {editor.info?.(error.message); post();});
            return true;
          };
          const checkRestored = () => {
            // The always-show preference still waits for Welcome itself.
            if (globalThis.AtriumPref?.get('general.startPage') !== 'always') check();
          };
          window.addEventListener('atrium-recovery-restored', checkRestored, {once: true});
          // The fallback also covers projects opened by the native file picker or Finder.
          const dialogs = new MutationObserver(check);
          dialogs.observe(document, {subtree: true, attributeFilter: ['open']});
          const tick = () => check() || done || ++checks < 125 && setTimeout(tick, 16);
          tick();
        })()
        """

    /// The editor's --app colour (style.css, theme.css) for the system appearance, shown until the page paints.
    static let appBackground = NSColor(name: nil) { appearance in
        appearance.bestMatch(from: [.darkAqua, .aqua]) == .darkAqua
            ? NSColor(srgbRed: 0x1d / 255, green: 0x1d / 255, blue: 0x1d / 255, alpha: 1)
            : NSColor(srgbRed: 0xe6 / 255, green: 0xe6 / 255, blue: 0xe6 / 255, alpha: 1)
    }

    private func makeWebView(recoveringSession: String? = nil, dataStore: WKWebsiteDataStore? = nil) -> WKWebView {
        let config = WKWebViewConfiguration()
        if let dataStore = dataStore { config.websiteDataStore = dataStore }
        Desktop.unpinFrameRate(config.preferences)
        config.userContentController.add(self, name: "atriumHost")
        func inject(_ source: String) {
            config.userContentController.addUserScript(WKUserScript(source: source, injectionTime: .atDocumentStart, forMainFrameOnly: true))
        }
        lastCaptionInsets = captionInsets()
        inject(installCaptionScript(lastCaptionInsets))
        if !incoming.isEmpty || isWorkspacePeer { inject("window.__atriumOpeningProject = true") }
        if revealTimer != nil {
            if isWorkspacePeer {
                inject("window.__waffleLaunchSettle = true; window.__waffleWorkspaceLaunch = true")
            } else { inject(Self.launchSettleScript) }
        }
        if restartedRenderer {
            // The session is checked before it is recorded. Only this failed window is offered on restart.
            var context: [String:String] = [:]
            context["session"] = recoveringSession
            let encoded = (try? JSONEncoder().encode(context)).map { String(decoding: $0, as: UTF8.self) } ?? "{}"
            inject("window.__atriumRendererRestart = \(encoded); window.__atriumBridgeRequestBase = \(requestBase)")
        }
        inject("window.__atriumHostAccent = \(systemAccent())")
        inject(EditorWebView.wheelNotchScript)
        inject(bridgeSource)
        let view = EditorWebView(frame: .zero, configuration: config)
        let promises = NSFilePromiseReceiver.readableDraggedTypes.map { NSPasteboard.PasteboardType($0) }
        view.registerForDraggedTypes(Array(Set(view.registeredDraggedTypes + [.fileURL,.pdf] + promises)))
        view.offerTypedDrop = { [weak self] in self?.offerTypedDrop($0,$1,source:$2,fallback:$3) }
        view.openDroppedFiles = { [weak self] in self?.queueDrop($0) }
        view.uiDelegate = self
        view.navigationDelegate = self
        view.allowsMagnification = false
        view.addGestureRecognizer(view.fingers) // touch-display fingers, forwarded to the page as touch pointers
        view.allowsBackForwardNavigationGestures = false
        view.allowsLinkPreview = false
        // No white page before the first paint: the window's own background shows through.
        view.setValue(false, forKey: "drawsBackground")
        view.underPageBackgroundColor = Self.appBackground
        return view
    }

    private func loadEditor() {
        webProcessAvailable = true
        web.loadFileURL(page, allowingReadAccessTo: page.deletingLastPathComponent())
    }

    private func currentRequest(_ id: Int) -> Bool {
        webProcessAvailable && id > requestBase && id <= requestBase + Self.requestPageSize
    }

    // Energy: what the page cannot see itself. Window occlusion and Low Power Mode go to AtriumPower
    // (app/core/power.js) as the "atrium-power" event. Automatic Efficiency mode follows Low Power Mode
    // only, so the power source (battery or mains) is not watched. A change in the project's folder
    // (someone's lock or presence file, a save, a Git checkout) goes as "waffle-project-folder",
    // so collaboration polling backs off instead of listing the folder every few seconds. All of it is
    // notification-driven: no timers, no polling, no activity assertions (App Nap applies when hidden).
    private var lastPower: [String: Bool] = [:]
    private var folderWatch: DispatchSourceFileSystemObject?
    private var watchedFolder: URL?
    private var folderEventPending = false
    private var ownLockWrite = Date.distantPast
    private var collaborationWriters = Set<String>()

    private func watchPower() {
        let center = NotificationCenter.default
        powerObservers.append(center.addObserver(forName: NSWindow.didChangeOcclusionStateNotification, object: window, queue: .main) { [weak self] _ in self?.pushPower() })
        powerObservers.append(center.addObserver(forName: .NSProcessInfoPowerStateDidChange, object: nil, queue: .main) { [weak self] _ in self?.pushPower() })
        powerObservers.append(center.addObserver(forName: NSColor.systemColorsDidChangeNotification, object: nil, queue: .main) { [weak self] _ in
            guard let self = self, self.initialPageReady else { return }
            self.web.evaluateJavaScript("window.__waffleSystemAccent?.(\(self.systemAccent()))", completionHandler: nil)
        })
    }

    /// Sends the power state to the page when it changed (force: always; the harness uses it after it overrides the page's view).
    func pushPower(force: Bool = false) {
        guard initialPageReady, let web = web, let window = window else { return }
        let state = ["occluded": !window.occlusionState.contains(.visible), "lowPower": ProcessInfo.processInfo.isLowPowerModeEnabled]
        if !force && state == lastPower { return }
        lastPower = state
        web.callAsyncJavaScript("globalThis.__atriumPowerState = state; window.dispatchEvent(new CustomEvent('atrium-power', {detail: state}))",
                                arguments: ["state": state], in: nil, in: .page, completionHandler: nil)
    }

    /// Watches the folder of the project the collaboration sidecars sit beside (nil stops watching).
    private func watchFolder(of project: URL?) {
        let folder = project?.deletingLastPathComponent()
        if folder == watchedFolder { return }
        folderWatch?.cancel(); folderWatch = nil; watchedFolder = folder
        guard let folder = folder else { return }
        let fd = open(folder.path, O_EVTONLY)
        guard fd >= 0 else { return }
        let source = DispatchSource.makeFileSystemObjectSource(fileDescriptor: fd, eventMask: [.write, .rename, .delete], queue: .main)
        source.setEventHandler { [weak self] in
            // This window's own lock writes are not news; a burst of events is one notice.
            guard let self = self, Date().timeIntervalSince(self.ownLockWrite) > 1, !self.folderEventPending else { return }
            self.folderEventPending = true
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.25) {
                self.folderEventPending = false
                self.web?.evaluateJavaScript("window.dispatchEvent(new Event('waffle-project-folder')); void 0", completionHandler: nil)
            }
        }
        source.setCancelHandler { close(fd) }
        source.resume()
        folderWatch = source
    }

    private func brandMenuImage() -> NSImage? {
        let size = NSSize(width: 16, height: 16)
        let image = NSImage(size: size)
        for name in ["WaffleTemplate", "WaffleTemplate@2x"] {
            guard let url = Bundle.main.url(forResource: name, withExtension: "png"),
                  let bytes = try? Data(contentsOf: url),
                  let representation = NSBitmapImageRep(data: bytes) else { continue }
            representation.size = size
            image.addRepresentation(representation)
        }
        guard !image.representations.isEmpty else { return nil }
        image.isTemplate = true
        return image
    }

    private func buildMenu() {
        let bar = NSMenu()
        func section(_ name: String) -> NSMenu {
            let item = NSMenuItem()
            let menu = NSMenu(title: name)
            bar.addItem(item)
            item.submenu = menu
            return menu
        }
        let app = section("Waffle")
        command(app, "About Waffle", "", "about").image = brandMenuImage()
        app.addItem(.separator())
        app.addItem(withTitle: "Hide Waffle", action: #selector(NSApplication.hide(_:)), keyEquivalent: "h")
        app.addItem(withTitle: "Quit Waffle", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")
        @discardableResult
        func command(_ menu: NSMenu, _ title: String, _ key: String, _ action: String, shift: Bool = false) -> NSMenuItem {
            let item = menu.addItem(withTitle: title, action: #selector(menuCommand(_:)), keyEquivalent: key)
            item.target = self
            item.representedObject = action
            if shift { item.keyEquivalentModifierMask = [.command, .shift] }
            return item
        }
        let file = section("File")
        command(file, "New Project…", "n", "new")
        command(file, "Open…", "o", "open")
        let recentItem = file.addItem(withTitle: "Open Recent", action: nil, keyEquivalent: "")
        let recentMenu = NSMenu(title: "Open Recent")
        recentMenu.delegate = self
        recentItem.submenu = recentMenu
        openRecentMenu = recentMenu
        menuNeedsUpdate(recentMenu)
        command(file, "Save Project…", "s", "save")
        command(file, "Save Project As…", "", "save-as")
        command(file, "Recover…", "", "recover")
        command(file, "Close Project", "", "close-project")
        file.addItem(.separator())
        let close = file.addItem(withTitle: "Close Window", action: #selector(closeWindow(_:)), keyEquivalent: "w")
        close.target = self
        let edit = section("Edit")
        command(edit, "Undo", "z", "undo")
        command(edit, "Redo", "z", "redo", shift: true)
        edit.addItem(.separator())
        for (title, action, key) in [("Cut","cut","x"), ("Copy","copy","c"), ("Paste","paste","v"), ("Select All","select-all","a")] {
            command(edit, title, key, action)
        }
        let view = section("View")
        let documentFit = command(view, "", "", "")
        documentFit.isHidden = true
        Self.documentFitMenuItem = documentFit
        view.addItem(withTitle: "Enter Full Screen", action: #selector(NSWindow.toggleFullScreen(_:)), keyEquivalent: "f").keyEquivalentModifierMask = [.control, .command]
        let extensions = section("Extensions")
        let pause = extensions.addItem(withTitle: "Pause All Extensions", action: #selector(pauseExtensions(_:)), keyEquivalent: "\u{1b}")
        pause.keyEquivalentModifierMask = [.command, .shift]
        pause.target = self
        NSApp.windowsMenu = section("Window")
        let help = section("Help")
        let troubleshooting = NSMenu(title: "Troubleshooting")
        help.addItem(withTitle: "Troubleshooting", action: nil, keyEquivalent: "").submenu = troubleshooting
        command(troubleshooting, "Crash Diagnostics…", "", "crash-diagnostics")
        command(troubleshooting, "Input Diagnostics…", "", "input-diagnostics")
        command(troubleshooting, "Frame Monitor", "", "frame-monitor")
        command(troubleshooting, "UI Gallery", "", "ui-gallery")
        NSApp.helpMenu = help
        NSApp.mainMenu = bar
    }

    // File › Open Recent lists the remembered projects each time it opens.
    func menuNeedsUpdate(_ menu: NSMenu) {
        guard menu === openRecentMenu else { return }
        menu.removeAllItems()
        let entries = recent.listing()
        for entry in entries {
            guard let path = entry["path"] as? String else { continue }
            let item = menu.addItem(withTitle: entry["name"] as? String ?? path, action: #selector(openRecentProject(_:)), keyEquivalent: "")
            item.target = self
            item.representedObject = path
            item.toolTip = path
        }
        if !entries.isEmpty { menu.addItem(.separator()) }
        let clear = menu.addItem(withTitle: "Clear Menu", action: entries.isEmpty ? nil : #selector(clearRecentProjects(_:)), keyEquivalent: "")
        clear.target = self
    }

    @objc private func openRecentProject(_ sender: NSMenuItem) {
        guard let url = try? recent.allowed(sender.representedObject) else {
            NSSound.beep(); return
        }
        // The same route as a file opened from Finder: the page asks for "open" and gets this file.
        let editor = Self.frontEditor ?? self
        editor.queueOpen([url])
    }

    @objc private func clearRecentProjects(_ sender: NSMenuItem) {
        recent.clear()
        NSDocumentController.shared.clearRecentDocuments(nil)
    }

    private func noteRecent(_ url: URL) {
        recent.note(url)
        NSDocumentController.shared.noteNewRecentDocumentURL(ProjectWrites.canonical(url))
    }

    private func finishWindowWrites() {
        collabQueue.sync {}
    }

    func windowWillClose(_ notification: Notification) {
        (web as? EditorWebView)?.inputLog.stop()
        revealTimer?.invalidate()
        revealTimer = nil
        if webProcessAvailable { notifyWorkspaceWriterUnavailable() }
        if let group = workspaceGroup {
            workspaceGroup = nil
            if group.writer === self {
                for editor in Self.editors.filter({ $0 !== self && $0.workspaceGroup === group }) {
                    editor.workspaceGroup = nil
                    editor.window.close()
                }
            } else if let writer = group.writer, let member = workspaceWindow {
                writer.sendWorkspaceEvent(["type":"closed", "window":member])
            }
        }
        lan.stop()
        webProcessAvailable = false
        abandonCloseSave()
        captionLayoutObserver = nil
        closeAllFolders()
        finishWindowWrites()
        watchFolder(of: nil)
        powerObservers.forEach(NotificationCenter.default.removeObserver)
        powerObservers.removeAll()
        web.configuration.userContentController.removeScriptMessageHandler(forName: "atriumHost")
        initialPageReady = false
        web.stopLoading()
        web.navigationDelegate = nil
        web.uiDelegate = nil
        window.contentView = nil
        web = nil
        Self.editors.removeAll { $0 === self }
    }

    @objc private func pauseExtensions(_ sender: NSMenuItem) {
        guard let editor = Self.frontEditor, editor.initialPageReady else { return }
        editor.web.evaluateJavaScript("globalThis.AtriumExtensions?.pauseAll?.(); void 0", completionHandler: nil)
    }

    // A keyboard equivalent follows the active keymap. Clicking a menu item still runs the action on its label.
    private func webKeyboardEquivalent(_ sender: NSMenuItem, unhandled: @escaping () -> Void) -> Bool {
        let modifiers: NSEvent.ModifierFlags = [.command, .control, .option, .shift]
        let equivalent = sender.keyEquivalent.lowercased()
        guard initialPageReady, window.attachedSheet == nil, NSApp.keyWindow === window,
              !equivalent.isEmpty, let event = NSApp.currentEvent, event.type == .keyDown,
              event.charactersIgnoringModifiers?.lowercased() == equivalent,
              event.modifierFlags.intersection(modifiers) == sender.keyEquivalentModifierMask.intersection(modifiers)
        else { return false }
        let flags = event.modifierFlags
        let key = flags.contains(.shift) ? equivalent.uppercased() : equivalent
        let code = (equivalent.first?.isNumber == true ? "Digit" : "Key") + key.uppercased()
        let script = """
        const target = document.activeElement || document.body;
        const event = new KeyboardEvent('keydown', {key, code, metaKey, ctrlKey, altKey, shiftKey, repeat,
          bubbles:true, cancelable:true});
        return !target.dispatchEvent(event);
        """
        web.callAsyncJavaScript(script, arguments: ["key":key, "code":code, "metaKey":flags.contains(.command),
            "ctrlKey":flags.contains(.control), "altKey":flags.contains(.option), "shiftKey":flags.contains(.shift),
            "repeat":event.isARepeat], in: nil, in: .page) { result in
            if case .success(let value) = result, (value as? Bool) == true { return }
            unhandled()
        }
        return true
    }

    @objc private func closeWindow(_ sender: NSMenuItem) {
        if let editor = Self.frontEditor, editor !== self { editor.closeWindow(sender); return }
        if webKeyboardEquivalent(sender, unhandled: { [weak self] in self?.window.performClose(sender) }) { return }
        window.performClose(sender)
    }

    @objc private func menuCommand(_ sender: NSMenuItem) {
        if let editor = Self.frontEditor, editor !== self { editor.menuCommand(sender); return }
        guard let action = sender.representedObject as? String else { return }
        let editing = ["cut":"cut:", "copy":"copy:", "paste":"paste:", "select-all":"selectAll:", "undo":"undo:", "redo":"redo:"]
        func normalEditing() { if let nativeAction = editing[action] { NSApp.sendAction(NSSelectorFromString(nativeAction), to: nil, from: sender) } }
        if webKeyboardEquivalent(sender, unhandled: normalEditing) { return }
        guard editing[action] != nil else { issue(action); return }
        guard NSApp.keyWindow === window, window.attachedSheet == nil, initialPageReady else { normalEditing(); return }
        let script = """
        const el=document.activeElement;
        if(document.querySelector('dialog[open]') || el?.isContentEditable ||
            el?.closest('input,textarea,select,[role=textbox]') || window.getSelection()?.toString())return false;
        window.dispatchEvent(new CustomEvent('atrium-command',{detail:action}));
        return true;
        """
        web.callAsyncJavaScript(script, arguments: ["action":action], in: nil, in: .page) { result in
            if case .success(let value) = result, (value as? Bool) == true { return }
            normalEditing()
        }
    }

    private func issue(_ action: String) {
        guard initialPageReady else { return }
        let script = """
        if (openingFile) globalThis.__atriumOpeningProject = true;
        if (['undo','redo'].includes(action) && document.activeElement?.matches('input, textarea, [contenteditable=true]')) {
          document.execCommand(action);
        } else {
          window.dispatchEvent(new CustomEvent('atrium-command',{detail:action}));
        }
        """
        web.callAsyncJavaScript(script, arguments: ["action":action, "openingFile":action == "open" && !incoming.isEmpty], in: nil, in: .page, completionHandler: nil)
    }

    func application(_ sender: NSApplication, openFiles filenames: [String]) {
        let editor = Self.frontEditor ?? self
        editor.queueOpen(filenames.map { URL(fileURLWithPath: $0) })
        sender.reply(toOpenOrPrint: .success)
    }

    private static let linkID = #"[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}"#
    private static func recordIdentity(_ value: String) -> Bool {
        value.utf8.count == 36 && value.range(of:"^" + linkID + "$", options:.regularExpression) != nil
    }

    func application(_ sender: NSApplication, open urls: [URL]) {
        for url in urls where url.scheme == "waffle" {
            let text = url.absoluteString
            guard text.utf8.count <= 114,
                  text.range(of:"^waffle://" + Self.linkID + "/" + Self.linkID + "(#datasheet:page=[1-9][0-9]{0,15})?$",
                             options:.regularExpression) == text.startIndex..<text.endIndex else { continue }
            let projectId = String(text.dropFirst("waffle://".count).prefix(36))
            let matching = Self.editors.filter { $0.visibleProjectIdentity == projectId }
            let editor = matching.count == 1 ? matching[0] : Self.frontEditor ?? self
            guard editor.incomingLinks.count < 8 else { continue }
            editor.incomingLinks.append(text)
            editor.window?.makeKeyAndOrderFront(nil)
            editor.deliverLinks()
        }
        let files = urls.filter(\.isFileURL)
        if !files.isEmpty { (Self.frontEditor ?? self).queueOpen(files) }
    }

    private func deliverLinks() {
        guard initialPageReady, let web = web else { return }
        let urls = incomingLinks
        incomingLinks.removeAll()
        for url in urls {
            web.callAsyncJavaScript("return window.__waffleOpenLink(url);", arguments:["url":url],
                                    in:nil, in:.page, completionHandler:nil)
        }
    }

    private func queueOpen(_ urls: [URL]) {
        let urls = urls.compactMap { url -> URL? in
            if Self.isFolder(url) {
                // AppKit can deliver a launch directory as a Finder open. Only a
                // verified project folder can consume a pending editor Open command.
                do { try ProjectFileType.checkSelection(url) } catch { return url }
                guard let name = try? FolderTransactions.selectedManifest(in:url) else { return nil }
                return url.appendingPathComponent(name)
            }
            return translators.accepts(url) || ProjectFileType.projectName(url) ? url : nil
        }
        guard !urls.isEmpty else { return }
        // Finder and Open Recent already supplied a selection. A busy editor cannot handle
        // another JavaScript open command until its import finishes.
        // An ordinary document may belong to an already-open folder. Resolve
        // exact indexed ownership on the file queue before choosing a window.
        if window != nil, !urls.contains(where:ProjectFileType.documentName),
           (try? urls.forEach(ProjectFileType.checkSelection)) != nil, activateProjectWindow(for: urls) { return }
        incoming.append(contentsOf: urls)
        if !openingProject { issue("open") }
    }

    private struct SelectedDocumentCopy {
        let name: String
        let base64: String
        let sha256: String
    }

    private static func copyDocumentRows(_ urls: [URL]) throws -> [SelectedDocumentCopy] {
        guard !urls.isEmpty, urls.count <= 128 else { throw HostFiles.failure("Choose up to 128 Waffle document files.") }
        var remaining = HostFiles.projectReadCap
        return try urls.map { url in
            guard ProjectFileType.documentName(url) else { throw HostFiles.failure("Choose regular Waffle document files.") }
            try ProjectFileType.checkSelection(url)
            return try ProjectFileType.accessSelection(url) {
                let (bytes, _) = try HostFiles.readRegular(url,cap:remaining,singleLink:true)
                remaining -= bytes.count
                return SelectedDocumentCopy(name:url.lastPathComponent,base64:bytes.base64EncodedString(),
                                            sha256:ProjectWrites.hex(ProjectWrites.digest(bytes)))
            }
        }
    }

    // Proof authorizes only copying the approved bytes into the active project.
    // Ordinary standalone opens carry their own separate, path-bound capability.
    private func copyDocumentPackets(_ files: [SelectedDocumentCopy], grant: String?) -> [[String:Any]] {
        return files.map { file in
            var row: [String:Any] = ["name":file.name,"memberPath":file.name,"data":file.base64]
            if let grant = grant, visibleFolder?.grant == grant {
                if let known = selectedDocumentCopies.first(where: { $0.value == file.sha256 }) {
                    row["nativeCopy"] = ["grant":known.key,"sha256":file.sha256]
                } else if selectedDocumentCopies.count < 512 {
                    let token = UUID().uuidString.lowercased()
                    selectedDocumentCopies[token] = file.sha256
                    row["nativeCopy"] = ["grant":token,"sha256":file.sha256]
                }
            }
            return row
        }
    }

    private struct ApprovedDocumentCopy {
        let token: String
        let sha256: String
        let removing: Bool
    }

    private func approvedDocumentCopies(_ request: [String:Any], grant: String) throws -> [String:ApprovedDocumentCopy] {
        let entries = (request["plan"] as? [[String:Any]] ?? []).filter { $0["nativeCopy"] != nil }
        guard !entries.isEmpty else { return [:] }
        guard visibleFolder?.grant == grant, entries.count <= selectedDocumentCopies.count else {
            throw FolderFailure("Choose the Waffle document to copy again.")
        }
        var approved: [String:ApprovedDocumentCopy] = [:]
        for entry in entries {
            guard let path = entry["path"] as? String, approved[path] == nil,
                  let ticket = entry["nativeCopy"] as? [String:String], ticket.count == 2,
                  let token = ticket["grant"], let sha = ticket["sha256"], selectedDocumentCopies[token] == sha else {
                throw FolderFailure("Choose the Waffle document to copy again.")
            }
            let removing = entry["remove"] as? Bool == true
            if removing {
                guard installedDocumentCopies[path] == token, entry["expected"] as? String == sha else {
                    throw FolderFailure("Only a copy added to this project in this window can be undone.")
                }
            } else if !(entry["expected"] is NSNull) {
                throw FolderFailure("An exact Waffle document copy needs a new destination.")
            }
            approved[path] = ApprovedDocumentCopy(token:token,sha256:sha,removing:removing)
        }
        return approved
    }

    private func trackDocumentCopies(_ approved: [String:ApprovedDocumentCopy], receipt: [String:Any]) {
        guard receipt["saved"] as? Bool == true, receipt["transaction"] is String,
              let hashes = receipt["hashes"] as? [String:Any] else { return }
        for (path, copy) in approved {
            if copy.removing {
                if hashes[path] is NSNull { installedDocumentCopies.removeValue(forKey:path) }
            } else if hashes[path] as? String == copy.sha256 {
                installedDocumentCopies[path] = copy.token
            }
        }
    }

    private var pendingTypedDrop: (token:String, grant:String?, source:EditorWebView.DropSource, cancellation:Operation, request:Int?)?

    private func cancelTypedDrop(_ token:String? = nil) {
        guard let pending = pendingTypedDrop, token == nil || pending.token == token else { return }
        pendingTypedDrop = nil
        pending.cancellation.cancel()
        if let id = pending.request, id >= 0, currentRequest(id) { reply(id) }
    }

    private func offerTypedDrop(_ x:Double,_ y:Double,source:EditorWebView.DropSource,fallback:[URL]) {
        guard initialPageReady, let target = web as? EditorWebView, target.butterDropEnabled else {
            if !fallback.isEmpty { queueDrop(fallback) }
            return
        }
        cancelTypedDrop()
        let token = UUID().uuidString
        pendingTypedDrop = (token,visibleFolder?.grant,source,Operation(),nil)
        target.callAsyncJavaScript("return await window.__waffleNativeDropOffer?.(token,x,y,file);",
            arguments:["token":token,"x":x,"y":y,"file":source.file],in:nil,in:.page) { [weak self] result in
            guard let self = self, let pending = self.pendingTypedDrop, pending.token == token else { return }
            self.cancelTypedDrop(token)
            if case .success(let handled) = result, handled as? Bool == false, pending.request == nil,
               pending.grant == self.visibleFolder?.grant, !fallback.isEmpty {
                self.queueDrop(fallback)
            }
        }
    }

    private func takeTypedDrop(_ id:Int, _ request:[String:Any]) {
        guard let target = web as? EditorWebView, target.butterDropEnabled,
              let pending = pendingTypedDrop, pending.token == request["token"] as? String,
              pending.grant == visibleFolder?.grant, pending.request == nil else { reply(id); return }
        pendingTypedDrop?.request = id
        pending.source.load(pending.cancellation) { [weak self] result in DispatchQueue.main.async {
            guard let self=self,self.web===target,self.currentRequest(id),
                  self.pendingTypedDrop?.token == pending.token else { return }
            // Keep the cancelled/accepted scope until the renderer reports its decision. This
            // sentinel prevents replay while distinguishing an offer that was never taken.
            self.pendingTypedDrop?.request = -1
            guard target.butterDropEnabled, self.visibleFolder?.grant == pending.grant else { self.reply(id); return }
            switch result {
            case .success(let packet): self.reply(id,packet)
            case .failure(let error): self.reply(id,error:error.localizedDescription)
            }
        }}
    }

    func queueDrop(_ urls: [URL]) {
        guard hasProject, initialPageReady, !urls.isEmpty, urls.allSatisfy(ProjectFileType.documentName) else {
            queueOpen(urls)
            return
        }
        let target = web, grant = visibleFolder?.grant
        target?.callAsyncJavaScript("return window.AtriumNavHost?.project()?.id;",
                                    arguments:[:],in:nil,in:.page) { [weak self] initial in
            guard case .success(let id) = initial, let project = id as? String else { return }
            DispatchQueue.global(qos:.userInitiated).async {
                let rows = Result { try Self.copyDocumentRows(urls) }
                DispatchQueue.main.async {
                    guard let self = self, self.web === target, self.initialPageReady,
                          self.visibleFolder?.grant == grant else { return }
                    switch rows {
                    case .success(let files):
                        let script = """
                        const host = window.AtriumNavHost;
                        if (!host || host.isStarter() || host.project()?.id !== project) return false;
                        return await window.__waffleCopyNativeDocuments(files);
                        """
                        let copies = self.copyDocumentPackets(files,grant:grant)
                        target?.callAsyncJavaScript(script,arguments:["files":copies,"project":project],in:nil,in:.page,completionHandler:nil)
                    case .failure(let error):
                        target?.callAsyncJavaScript("window.AtriumNavHost?.info(error);",
                                                    arguments:["error":error.localizedDescription],in:nil,in:.page,completionHandler:nil)
                    }
                }
            }
        }
    }

    func webView(_ webView: WKWebView, didStartProvisionalNavigation navigation: WKNavigation!) {
        if web === webView { (webView as? EditorWebView)?.inputLog.stop() }
    }

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        guard web === webView, webProcessAvailable else { return }
        initialPageReady = true
        if let item = Self.documentFitMenuItem, item.isHidden {
            webView.evaluateJavaScript("window.AtriumKeymap.documentFitRegistration()") { result, _ in
                guard let command = result as? [String: String],
                      let title = command["title"], let key = command["key"], let action = command["action"] else { return }
                item.title = title
                item.keyEquivalent = key
                item.representedObject = action
                item.isHidden = false
            }
        }
        if let group = workspaceGroup, group.writer !== self, let tab = workspaceTab {
            sendWorkspaceEvent(["type":"arrival", "tab":tab])
        }
        webView.evaluateJavaScript("window.__waffleSystemAccent?.(\(systemAccent()))", completionHandler: nil)
        updateCaptionInsets()
        pushPower(force: true)
        if !incoming.isEmpty { issue("open") }
        deliverLinks()
    }

    func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
        guard web === webView, webProcessAvailable else { return }
        (webView as? EditorWebView)?.inputLog.stop()
        let pendingDetachedLaunch = isWorkspacePeer && revealTimer != nil
        if !pendingDetachedLaunch { revealWindow() }
        lan.stop()
        webProcessAvailable = false
        initialPageReady = false
        probeOutstanding = false
        notifyWorkspaceWriterUnavailable()
        if let alert = hangAlert { hangAlert = nil; window.endSheet(alert.window) }
        abandonCloseSave()
        let requested = restartRequested
        restartRequested = false
        CrashHistory.noteTermination(reason: requested ? "unresponsive" : "terminated")
        crashedFolder = visibleFolder?.manifest
        gitSource = nil
        pickedHistory = nil
        closeAllFolders()
        watchFolder(of: nil)
        selectedSource = nil
        pendingManifest = nil
        window.representedURL = nil
        openingProject = false
        openingProjectPath = nil
        hasProject = false
        if let sheet = window.attachedSheet { window.endSheet(sheet, returnCode: .cancel) }
        if workspaceGroup != nil, !restartedRenderer {
            restartEditor(after:webView)
            return
        }
        if pendingDetachedLaunch { workspaceLaunchFailed(); return }
        // The user chose Restart Editor on the "not responding" sheet: restart without a second question.
        if requested { restartEditor(after: webView); return }

        let alert = NSAlert()
        alert.messageText = restartedRenderer ? "The editor closed unexpectedly again." : "The editor closed unexpectedly."
        alert.informativeText = restartedRenderer
            ? "Open Waffle again and choose File › Recover to see autosaved work. Help › Crash Diagnostics shows the failure history."
            : "Restart the editor to review your autosaved work."
        if !restartedRenderer { alert.addButton(withTitle: "Restart Editor") }
        alert.addButton(withTitle: "Close Window")
        alert.beginSheetModal(for: window) { [weak self] response in
            guard let self = self, self.web === webView else { return }
            guard !self.restartedRenderer, response == .alertFirstButtonReturn else { self.window.close(); return }
            self.restartEditor(after: webView)
        }
    }

    /// A fresh web view in place of a terminated one. Its page offers this window's autosaved work
    /// (recovery prompt); nothing is restored or written without the user's choice.
    private func restartEditor(after webView: WKWebView) {
        let dataStore = webView.configuration.websiteDataStore
        webView.configuration.userContentController.removeScriptMessageHandler(forName: "atriumHost")
        webView.navigationDelegate = nil
        webView.uiDelegate = nil
        restartedRenderer = true
        // Reopen through the normal native chooser envelope. The new renderer receives a fresh
        // grant and its private draft is offered only after the saved folder has been adopted.
        // An explicit Finder/drop selection queued while the old renderer failed has priority.
        if incoming.isEmpty, let previous = crashedFolder { incoming = [previous] }
        crashedFolder = nil
        web = makeWebView(recoveringSession: editorSession, dataStore: dataStore)
        editorSession = nil
        attachEditorWebView()
        window.title = "Waffle"
        window.isDocumentEdited = false
        projectName = nil
        foreignImportID = nil
        discardApproved = false
        loadEditor()
    }

    // ---- responsiveness watchdog -----------------------------------------------------------------
    // A key press or click in an editor window pings its page. A page that has not answered after
    // hangSeconds (an endless loop, a stuck task on the main thread) gets a sheet: Wait, or Restart
    // Editor, which ends the web content process and loads a fresh page that offers the autosaved
    // work. The ping costs nothing while idle (no timer), and the sheet goes away if the page answers.
    static var hangSeconds = 10.0
    private static func watchInput() {
        guard inputMonitor == nil else { return }
        inputMonitor = NSEvent.addLocalMonitorForEvents(matching: [.keyDown, .leftMouseDown, .rightMouseDown, .otherMouseDown]) { event in
            if let window = event.window, let editor = editors.first(where: { $0.window === window }) { editor.probeResponsive() }
            return event
        }
    }

    func probeResponsive() {
        guard webProcessAvailable, initialPageReady, !probeOutstanding, let view = web else { return }
        probeOutstanding = true
        view.evaluateJavaScript("0") { [weak self] _, _ in
            guard let self = self, self.web === view else { return }
            self.probeOutstanding = false
            if let alert = self.hangAlert { self.hangAlert = nil; self.window.endSheet(alert.window, returnCode: .cancel) }
        }
        awaitProbe(view, after: Self.hangSeconds)
    }
    /// While a mouse button is held (a tab or panel drag, a sash), WebKit's drag session can hold the
    /// ping's reply until the button comes up: that is not a hang, so check again a moment later.
    private func awaitProbe(_ view: WKWebView, after seconds: Double) {
        DispatchQueue.main.asyncAfter(deadline: .now() + seconds) { [weak self] in
            guard let self = self, self.web === view, self.probeOutstanding, self.webProcessAvailable else { return }
            if NSEvent.pressedMouseButtons != 0 { self.awaitProbe(view, after: 2); return }
            self.showNotResponding(view)
        }
    }

    private func showNotResponding(_ view: WKWebView) {
        guard hangAlert == nil, window.attachedSheet == nil else { return }
        let alert = NSAlert()
        alert.messageText = "The editor is not responding."
        alert.informativeText = "It may be busy with a long task. Wait for it, or restart the editor: Waffle then offers your autosaved work, and nothing is written to your files without asking."
        alert.addButton(withTitle: "Wait")
        alert.addButton(withTitle: "Restart Editor")
        hangAlert = alert
        alert.beginSheetModal(for: window) { [weak self] response in
            guard let self = self, self.hangAlert === alert else { return }
            self.hangAlert = nil
            guard self.web === view, self.webProcessAvailable else { return }
            guard response == .alertSecondButtonReturn else {
                // Wait: ask again later if the page still has not answered.
                DispatchQueue.main.asyncAfter(deadline: .now() + 3 * Self.hangSeconds) { [weak self] in
                    guard let self = self, self.web === view, self.probeOutstanding, self.webProcessAvailable else { return }
                    self.showNotResponding(view)
                }
                return
            }
            self.restartRequested = true
            if !Self.endContentProcess(view) { self.restartRequested = false }
        }
    }

    /// Ends a web view's content process by its process id (WebKit SPI, looked up at run time), so
    /// the termination delegate runs as for a crash; WebKit's own kill SPI can suppress that
    /// delegate. False when this WebKit does not give the process id.
    private static func endContentProcess(_ view: WKWebView) -> Bool {
        let pid = NSSelectorFromString("_webProcessIdentifier")
        guard view.responds(to: pid) else { return false }
        typealias Pid = @convention(c) (AnyObject, Selector) -> Int32
        let id = unsafeBitCast(view.method(for: pid), to: Pid.self)(view, pid)
        return id > 1 && id != getpid() && Darwin.kill(id, SIGKILL) == 0
    }

    func webView(_ webView: WKWebView, decidePolicyFor action: WKNavigationAction,
                 decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        // The main frame only ever shows the editor page. Subframes may load only inline
        // documents: the extension sandbox (about:srcdoc) and print previews (about:blank).
        // Everything else, including new windows (no target frame), is cancelled.
        guard let frame = action.targetFrame, let url = action.request.url else { decisionHandler(.cancel); return }
        if frame.isMainFrame { decisionHandler(url.standardizedFileURL == page ? .allow : .cancel); return }
        decisionHandler(["about:srcdoc", "about:blank"].contains(url.absoluteString) ? .allow : .cancel)
    }

    // ---- closing and quitting with unsaved changes (HIG) --------------------------------------------
    // A sheet on the window (NSAlert): Save (default, Return), Cancel (Esc) and Don't Save (⌘D), which
    // NSAlert sets apart from Save: on the left in a row, or below Save when it stacks the buttons. Save is the
    // page's own Save: in place when the project has a file, otherwise the save panel. The window
    // closes only once that save succeeded and the page reports the project clean; a cancelled panel
    // or a failed save leaves it open and unsaved. Don't Save closes as before: the recovery sidecar
    // stays for draft recovery. A crashed page (webProcessAvailable false) is never asked to save:
    // the crash sheet and draft recovery handle that window.
    var needsSaveReview: Bool { webProcessAvailable && window?.isDocumentEdited == true && !discardApproved }
    private var projectName: String?
    private var foreignImportID: String?
    private var closePrompt: NSAlert?
    // Save chosen on the close prompt: the page's save is running (closeSave), or it succeeded and the
    // page's "dirty" report is still on its way (closeWhenClean). Each answers once, then clears, so a
    // later ordinary save never closes the window.
    private var closeSave: ((Bool) -> Void)?
    private var closeWhenClean: ((Bool) -> Void)?
    private static var reviewingQuit = false

    private var displayName: String {
        let name = projectName?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        return name.isEmpty ? "Untitled" : String(name.prefix(160))
    }

    /// The unsaved-changes sheet. done(true) once the window may close (saved, or Don't Save);
    /// done(false) to keep editing (Cancel, a cancelled save panel, a failed save).
    func askToSave(deferForeignDiscard: Bool = false, _ done: @escaping (Bool) -> Void) {
        guard needsSaveReview else { done(true); return }
        guard closePrompt == nil, closeSave == nil, closeWhenClean == nil, window.attachedSheet == nil else { NSSound.beep(); done(false); return }
        if let id = foreignImportID {
            guard initialPageReady, let view = web else { done(false); return }
            closeSave = done
            view.callAsyncJavaScript("return await window.__atriumReviewForeignClose(id,false,deferDiscard)",
                                     arguments:["id":id,"deferDiscard":deferForeignDiscard], in:nil, in:.page) { [weak self] result in
                guard let self = self, let pending = self.closeSave else { return }
                self.closeSave = nil
                guard self.web === view, case .success(let ok) = result, ok as? Bool == true,
                      self.foreignImportID == id || (self.foreignImportID == nil && !self.window.isDocumentEdited)
                else { pending(false); return }
                self.discardApproved = true
                pending(true)
            }
            return
        }
        let alert = NSAlert()
        alert.messageText = "Do you want to save the changes you made to “\(displayName)”?"
        alert.informativeText = "Your changes will be lost if you don’t save them."
        alert.addButton(withTitle: "Save")
        alert.addButton(withTitle: "Cancel").keyEquivalent = "\u{1b}"
        let dontSave = alert.addButton(withTitle: "Don’t Save")
        dontSave.keyEquivalent = "d"
        dontSave.keyEquivalentModifierMask = .command
        closePrompt = alert
        alert.beginSheetModal(for: window) { [weak self] response in
            guard let self = self else { return }
            self.closePrompt = nil
            switch response {
            case .alertFirstButtonReturn: self.saveForClose(done)
            case .alertThirdButtonReturn: self.discardApproved = true; done(true)
            default: done(false)
            }
        }
    }

    private func saveForClose(_ done: @escaping (Bool) -> Void) {
        guard webProcessAvailable, initialPageReady, let view = web else { done(false); return }
        closeSave = done
        view.callAsyncJavaScript("return typeof window.__atriumSaveForClose === 'function' && await window.__atriumSaveForClose() === true",
                                 arguments: [:], in: nil, in: .page) { [weak self] result in
            guard let self = self, let pending = self.closeSave else { return }
            self.closeSave = nil
            guard self.web === view, case .success(let value) = result, value as? Bool == true else { pending(false); return }
            // The page reports clean ("dirty" false) before its save resolves; wait for it otherwise.
            if self.window.isDocumentEdited { self.closeWhenClean = pending } else { pending(true) }
        }
    }

    /// The page went away (crash, restart, closing): a save for closing cannot finish.
    private func abandonCloseSave() {
        let pending = [closeSave, closeWhenClean].compactMap { $0 }
        closeSave = nil
        closeWhenClean = nil
        pending.forEach { $0(false) }
    }

    func windowShouldClose(_ sender: NSWindow) -> Bool {
        if let group = workspaceGroup, group.writer === self,
           Self.editors.contains(where: { peer in
               peer !== self && peer.workspaceGroup === group && peer.window.isVisible &&
                   peer.window.alphaValue > 0 && peer.web?.isHidden == false
           }) {
            sender.orderOut(nil)
            return false
        }
        guard needsSaveReview else { return true }
        askToSave { [weak self] close in if close { self?.window?.close() } }
        return false
    }

    // Quitting: one unsaved window gets its sheet; several get AppKit's standard question first
    // (NSDocumentController's "You have N documents with unsaved changes": Review Changes…, Cancel,
    // Discard Changes), then each window's sheet in turn, front to back. Termination waits
    // (.terminateLater) for the saves, and is cancelled when a sheet is cancelled or a save fails.
    func applicationShouldTerminate(_ sender: NSApplication) -> NSApplication.TerminateReply {
        if Self.reviewingQuit { return .terminateCancel }
        guard Self.editors.contains(where: { $0.needsSaveReview }) else {
            Self.editors.forEach { $0.finishWindowWrites() }
            return .terminateNow
        }
        Self.reviewingQuit = true
        // A run-loop block, not the main queue: terminate may itself run inside a main-queue block,
        // whose nested run loop would never drain the queue. AppKit waits in the modal panel mode.
        RunLoop.main.perform(inModes: [.common, .modalPanel]) {
            Self.reviewBeforeQuit { quit in
                Self.reviewingQuit = false
                if quit { Self.editors.forEach { $0.finishWindowWrites() } }
                NSApp.reply(toApplicationShouldTerminate: quit)
            }
        }
        return .terminateLater
    }

    /// done(true) when every unsaved window was saved or discarded; on false nothing more is asked
    /// and the windows not yet saved keep their changes (and lose any Don't Save approval).
    static func reviewBeforeQuit(_ done: @escaping (Bool) -> Void) {
        let order = NSApp.orderedWindows
        let unsaved = editors.filter { $0.needsSaveReview }
            .sorted { (order.firstIndex(of: $0.window) ?? .max) < (order.firstIndex(of: $1.window) ?? .max) }
        let finish = { (quit: Bool) in
            if !quit { editors.forEach { $0.discardApproved = false } }
            done(quit)
        }
        guard unsaved.count > 1 else { review(unsaved, finish); return }
        let foreign = unsaved.compactMap { editor in editor.foreignImportID.map { (editor,$0) } }
        if !foreign.isEmpty {
            review(unsaved, deferForeignDiscard:true) { approved in
                finishForeign(foreign, commit:approved) { settled in finish(approved && settled) }
            }
            return
        }
        let alert = NSAlert()
        alert.messageText = "You have \(unsaved.count) documents with unsaved changes. Do you want to review these changes before quitting?"
        alert.informativeText = "If you don’t review your documents, all your changes will be lost."
        alert.addButton(withTitle: "Review Changes…")
        alert.addButton(withTitle: "Cancel").keyEquivalent = "\u{1b}"
        alert.addButton(withTitle: "Discard Changes")
        switch alert.runModal() {
        case .alertFirstButtonReturn: review(unsaved, finish)
        case .alertThirdButtonReturn: unsaved.forEach { $0.discardApproved = true }; finish(true)
        default: finish(false)
        }
    }

    private static func finishForeign(_ rows: [(Desktop,String)], commit: Bool, _ done: @escaping (Bool)->Void) {
        guard let (editor,id) = rows.first else { done(true); return }
        let remaining = Array(rows.dropFirst())
        guard let view=editor.web, editor.webProcessAvailable else {
            finishForeign(remaining,commit:false) { _ in done(false) }; return
        }
        view.callAsyncJavaScript("return await window.__atriumFinishForeignClose(id,commit)",
                                 arguments:["id":id,"commit":commit],in:nil,in:.page) { result in
            let ok: Bool
            if case .success(let value)=result { ok=value as? Bool == true } else { ok=false }
            finishForeign(remaining,commit:commit && ok) { rest in done(ok && rest) }
        }
    }

    private static func review(_ list: [Desktop], deferForeignDiscard: Bool = false, _ done: @escaping (Bool) -> Void) {
        guard let editor = list.first else { done(true); return }
        let rest = Array(list.dropFirst())
        // Saved, closed or crashed while an earlier window was asked.
        guard editors.contains(where: { $0 === editor }), editor.needsSaveReview else { review(rest, deferForeignDiscard:deferForeignDiscard, done); return }
        editor.window.makeKeyAndOrderFront(nil)
        editor.askToSave(deferForeignDiscard:deferForeignDiscard) { ok in ok ? review(rest, deferForeignDiscard:deferForeignDiscard, done) : done(false) }
    }
    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { true }

    private func reply(_ id: Int, _ value: Any = NSNull(), error: String? = nil, verifiedRead: Bool = false) {
        guard currentRequest(id) else { return }
        let receiver = verifiedRead ? "window.__waffleReceiveVerifiedFolderRead(id, value, error)" : "window.__atriumReceive(id, value, error)"
        web?.callAsyncJavaScript(receiver, arguments: [
            "id":id, "value":value, "error":error as Any? ?? NSNull()
        ], in: nil, in: .page, completionHandler: nil)
    }

    static func isFolder(_ url: URL) -> Bool {
        var s = stat()
        return lstat(url.path,&s) == 0 && (s.st_mode & S_IFMT) == S_IFDIR
    }

    // Only the serialized host queue may resolve an opaque, window-scoped grant.
    func folderService(grant: String) throws -> FolderTransactions {
        dispatchPrecondition(condition:.onQueue(folderQueue))
        guard let f = folders[grant] else { throw FolderFailure("The selected project grant has expired.") }
        return f
    }

    func folderAssetSource(grant: String, sourceToken: String, owner: String) throws -> FileHandle {
        dispatchPrecondition(condition:.onQueue(folderQueue))
        guard let source = folderSources[sourceToken], source.grant == grant, source.owner == owner else {
            throw FolderFailure("Choose this sheet's attachment again.")
        }
        return source.handle
    }

    private func revokeFolder(_ grant: String) {
        dispatchPrecondition(condition:.onQueue(folderQueue))
        folderWatches.removeValue(forKey:grant)
        folders.removeValue(forKey:grant)?.close()
        folderSources = folderSources.filter { $0.value.grant != grant }
    }

    private func leaveVisibleFolder(except next: String? = nil) {
        guard let previous = visibleFolder, previous.grant != next else { return }
        releaseFolderLocks(previous)
        visibleFolder = nil
        visibleProjectIdentity = nil
        selectedDocumentCopies.removeAll(); installedDocumentCopies.removeAll()
        folderQueue.async { self.revokeFolder(previous.grant) }
    }

    private func releaseFolderLocks(_ previous: (grant: String, manifest: URL)) {
        if collaborationWriters.remove(previous.grant) != nil {
            collabQueue.async { self.locks.removeOwn(project: previous.manifest) }
        }
    }

    private func performCollaboration(_ action: String, id: Int, grant: String, project: URL, request: [String:Any]) {
        folderQueue.async {
            do { try self.folderService(grant: grant).confirmSelection() }
            catch { DispatchQueue.main.async { self.reply(id, error: error.localizedDescription) }; return }
            DispatchQueue.main.async {
                guard self.currentRequest(id), self.visibleFolder?.grant == grant else {
                    self.reply(id, error: "The active Waffle project changed."); return
                }
                self.watchFolder(of: project)
                if action == "collabLockWrite" { self.collaborationWriters.insert(grant) }
                self.collabQueue.async {
                    do {
                        let result: [String:Any]
                        switch action {
                        case "collabLocks": result = self.locks.listing(project: project)
                        case "collabLockWrite":
                            result = try self.locks.write(project: project, key: request["key"], data: request["data"], mode: request["mode"])
                        default: result = try self.locks.remove(project: project, key: request["key"], force: false)
                        }
                        DispatchQueue.main.async {
                            guard self.visibleFolder?.grant == grant else {
                                self.reply(id, error: "The active Waffle project changed."); return
                            }
                            if action != "collabLocks" { self.ownLockWrite = Date() }
                            self.reply(id, result)
                        }
                    } catch { DispatchQueue.main.async { self.reply(id, error: error.localizedDescription) } }
                }
            }
        }
    }

    private func closeAllFolders() {
        resetImportSave(); pendingImportTokens.removeAll()
        if let previous = visibleFolder { releaseFolderLocks(previous) }
        visibleFolder = nil; visibleProjectIdentity = nil; applyingFolders.removeAll()
        selectedDocumentCopies.removeAll(); installedDocumentCopies.removeAll()
        folderQueue.async {
            self.folderWatches.removeAll()
            self.folders.values.forEach { $0.close() }
            self.folders.removeAll(); self.folderSources.removeAll()
            self.nativeMembers.removeAll()
        }
    }

    private func sendFolderEvent(_ detail: [String:Any]) {
        DispatchQueue.main.async {
            guard self.webProcessAvailable else { return }
            if detail["status"] != nil, let grant = detail["grant"] as? String { self.applyingFolders.remove(grant) }
            self.web?.callAsyncJavaScript("window.dispatchEvent(new CustomEvent('folderChanged',{detail}));",
                                          arguments:["detail":detail],in:nil,in:.page,completionHandler:nil)
        }
    }

    /// Used by File > Open, Finder, archive extraction, and an explicitly selected new folder.
    /// The renderer adopts the grant only after it validates its requested visible document.
    func offerFolder(_ url: URL, id: Int, asFile: Bool, newManifest: String? = nil, memberPath: String? = nil) {
        folderQueue.async { [self] in
            do {
                if newManifest == nil { try ProjectFileType.checkSelection(url) }
                let isFolder = Self.isFolder(url)
                let root = isFolder ? url : url.deletingLastPathComponent()
                let name: String
                if let new = newManifest { name = new }
                else if isFolder { name = try FolderTransactions.selectedManifest(in:root) }
                else { name = url.lastPathComponent }
                let store = try FolderTransactions(root:root,manifest:name)
                var pending: [String:Any]?
                if newManifest == nil {
                    guard try store.isSelectedManifest() else { throw FolderFailure("Choose a Waffle folder-format project manifest.") }
                    do { try store.recover(); try store.confirmSelection() }
                    catch {
                        guard (try? store.hasActive()) == true else { throw error }
                        pending = store.status()
                    }
                }
                guard self.folders.count < 8 else { throw FolderFailure("Close a project before choosing another folder.") }
                let grant = store.grant
                self.folders[grant] = store
                var selected = store.selection
                if let status = pending { selected["status"] = status }
                self.folderWatches[grant] = FolderWatch(url:store.rootURL,queue:self.folderQueue) { [weak self] paths,overflow in
                    guard let self = self, let current = self.folders[grant] else { return }
                    let paths = current.externalChanges(paths)
                    guard overflow || !paths.isEmpty else { return }
                    self.folderEventSequence += 1
                    self.sendFolderEvent(["type":"folderChanged","grant":grant,"seq":self.folderEventSequence,"paths":paths,"overflow":overflow])
                }
                DispatchQueue.main.async {
                    guard self.currentRequest(id) else {
                        self.folderQueue.async { self.folderWatches.removeValue(forKey:grant); self.folders.removeValue(forKey:grant)?.close() }
                        return
                    }
                    if asFile {
                        var file: [String:Any] = ["name":name,"folderProject":selected]
                        if let memberPath = memberPath { file["memberPath"] = memberPath }
                        self.reply(id, [file])
                    } else { self.reply(id, selected) }
                }
            } catch {
                DispatchQueue.main.async {
                    if asFile { self.openingProject = false; self.openingProjectPath = nil }
                    self.reply(id,error:error.localizedDescription)
                }
            }
        }
    }

    private static func archiveHelper(_ op: String, _ arguments: [String:Any]) throws -> [String:Any] {
        guard let resources = Bundle.main.resourceURL else { throw FolderFailure("Waffle resources are unavailable.") }
        let process = Process(), input = Pipe(), output = Pipe(), errors = Pipe()
        let payload = try JSONSerialization.data(withJSONObject:arguments)
        process.executableURL = URL(fileURLWithPath:"/usr/bin/env")
        process.arguments = ["python3","-I","-B",resources.appendingPathComponent("native/project_archive.py").path,op]
        process.standardInput=input; process.standardOutput=output; process.standardError=errors
        try process.run()
        DispatchQueue.global(qos:.utility).async {
            try? input.fileHandleForWriting.write(contentsOf:payload)
            try? input.fileHandleForWriting.close()
        }
        let data=output.fileHandleForReading.readDataToEndOfFile()
        process.waitUntilExit()
        guard process.terminationStatus==0 else {
            let message=String(data:errors.fileHandleForReading.readDataToEndOfFile(),encoding:.utf8)
            throw FolderFailure(message?.trimmingCharacters(in:.whitespacesAndNewlines) ?? "The portable project operation failed.")
        }
        guard let result=try JSONSerialization.jsonObject(with:data) as? [String:Any] else { throw FolderFailure("Invalid project archive response.") }
        return result
    }

    private static func importKey(_ url:URL,_ hash:String) -> String {
        let name=ProjectWrites.canonical(url).path + "\0" + hash
        return ProjectWrites.digest(Data(name.utf8)).map {String(format:"%02x",$0)}.joined()
    }

    private func resetImportSave() {
        let outstanding=Array(importOperations.values)
        importOperations.removeAll()
        boundImport=nil; restoredImport=nil; importTargets.removeAll()
        for cancel in outstanding {cancel()}
    }

    private func bindImportSave(_ request:[String:Any]) {
        resetImportSave()
        guard let session=request["session"] as? String,UUID(uuidString:session) != nil,
              let token=request["sourceToken"] as? String, pendingImportTokens.contains(token),
              let tokens=request["tokens"] as? [String],Set(tokens).isSubset(of:pendingImportTokens) else { return }
        let batch=pendingImportTokens
        pendingImportTokens.removeAll()
        boundImport=folderQueue.sync {
            guard let primary=self.retainedInputs[token] else {return nil}
            let paths=batch.compactMap {self.retainedInputs[$0]?.0.path}
            guard paths.count==batch.count else {return nil}
            return (session,token,Self.importKey(primary.0,primary.1),paths)
        }
    }

    private func importedSaveAction(_ id:Int,_ action:String,_ request:[String:Any]) {
        guard let op=request["operation"] as? String,UUID(uuidString:op) != nil,importOperations[op]==nil else {
            reply(id,error:"Invalid import Save operation.");return
        }
        if action=="reselectImportSave" {
            guard let key=request["sourceKey"] as? String, key.count==64 else {reply(id,NSNull());return}
            let panel=NSOpenPanel();panel.canChooseFiles=true;panel.canChooseDirectories=false;panel.allowsMultipleSelection=true
            panel.message="Choose the original design to reconnect this draft."
            importOperations[op] = { panel.cancel(nil) }
            panel.beginSheetModal(for:window) { response in
                guard response == .OK,!panel.urls.isEmpty,panel.urls.allSatisfy({translators.accepts($0) && !ProjectFileType.projectName($0)}),
                      self.importOperations[op] != nil else {self.importOperations.removeValue(forKey:op);self.reply(id,NSNull());return}
                self.importOperations[op] = {}
                self.readFiles(panel.urls,id:id,expectedKey:key,operation:op)
            }
            return
        }
        let accepted=boundImport.flatMap { b in b.session==request["session"] as? String && b.token==request["sourceToken"] as? String ? b : nil }
        if action=="importSaveChoice" {
            let recovered=restoredImport.map {r in reportedImportID==r.draft && r.session==request["session"] as? String &&
                r.draft==request["draftId"] as? String && r.key==request["sourceKey"] as? String && r.format==request["format"] as? String} ?? false
            guard accepted != nil || recovered else {reply(id,error:"The imported design changed. Open it again.");return}

            guard let labels=request["labels"] as? [String:String],let title=labels["title"],
                  let save=labels["save"],let cancel=labels["cancel"],window.attachedSheet==nil else {reply(id,"cancel");return}
            let alert=NSAlert()
            alert.messageText=String(title.prefix(512))
            if let detail=labels["detail"] {alert.informativeText=String(detail.prefix(1024))}
            let yes=alert.addButton(withTitle:String(save.prefix(120)));yes.keyEquivalent="\r"
            var results=["waffle"]
            if request["canExport"] as? Bool != false,let label=labels["export"],!label.isEmpty {
                alert.addButton(withTitle:String(label.prefix(120)));results.append("export")
            }
            alert.addButton(withTitle:String(cancel.prefix(120))).keyEquivalent="\u{1b}";results.append("cancel")
            importOperations[op] = { [weak self] in self?.window.endSheet(alert.window,returnCode:.abort) }
            alert.beginSheetModal(for:window) {response in
                let index=response.rawValue-NSApplication.ModalResponse.alertFirstButtonReturn.rawValue
                let active=self.importOperations.removeValue(forKey:op) != nil
                self.reply(id,active && results.indices.contains(index) ? results[index] : "cancel")
            }
            return
        }
        guard let bound=accepted else {reply(id,error:"Choose the original source or a separate destination.");return}
        let target=request["destination"] as? String
        let prior=target.flatMap {importTargets[$0]}
        if target != nil && prior==nil || action=="rememberImportExport" && prior==nil {
            reply(id,error:"The export destination grant expired. Choose a new destination.");return
        }
        let single=request["single"] as? Bool == true
        let name=request["name"] as? String ?? ""
        if action=="writeImportExport" && (name.isEmpty || (name as NSString).lastPathComponent != name || name.hasPrefix(".")) {
            reply(id,error:"Choose a visible export name.");return
        }
        func perform(_ selected:URL?) {
            let file=FileManager.default.temporaryDirectory.appendingPathComponent("waffle-export-"+UUID().uuidString)
            do {try Data().write(to:file,options:.withoutOverwriting)} catch {self.reply(id,error:error.localizedDescription);return}
            self.importOperations[op] = {try? FileManager.default.removeItem(at:file)}
            var args:[String:Any]=["key":bound.key,"support":HostFiles.supportDirectory.path,"guardFile":file.path]
            if let prior=prior {args["receipt"]=prior}
            let verb:String
            switch action {
            case "writeImportExport":
                guard let rows=request["files"] as? [[String:String]] else {
                    self.importOperations.removeValue(forKey:op)?();self.reply(id,error:"Invalid project export.");return
                }
                args["files"]=rows;args["single"]=single;args["sources"]=bound.paths
                if let selected=selected {args["selected"]=selected.path}
                verb="writeExport"
            case "rememberImportExport":verb="rememberExport"
            case "recalledImportExport":verb="recallExport"
            default:verb="forgetExport"
            }
            let arguments=args
            self.folderQueue.async {
                do {
                    let result=try Self.archiveHelper(verb,arguments)
                    DispatchQueue.main.async {
                        guard let finish=self.importOperations.removeValue(forKey:op),self.boundImport?.session==bound.session else {
                            self.reply(id,error:"The imported design changed.");return
                        }
                        finish()
                        if verb=="writeExport" || verb=="recallExport" {
                            guard let receipt=result["receipt"] as? [String:Any],let basename=receipt["name"] as? String else {self.reply(id,NSNull());return}
                            let token=target ?? UUID().uuidString
                            self.importTargets[token]=receipt
                            var visible=["destination":token,"name":basename]
                            if let notice=result["preferenceError"] as? String {visible["preferenceError"]=notice}
                            self.reply(id,visible)
                        } else {self.reply(id,true)}
                    }
                } catch {DispatchQueue.main.async {self.importOperations.removeValue(forKey:op)?();self.reply(id,error:error.localizedDescription)}}
            }
        }
        if action != "writeImportExport" || prior != nil {perform(nil);return}
        guard window.attachedSheet==nil else {reply(id,false);return}
        let panel:NSSavePanel
        if single {
            let save=NSSavePanel();save.nameFieldStringValue=name
            if let type=UTType(filenameExtension:(name as NSString).pathExtension) {save.allowedContentTypes=[type]}
            panel=save
        } else {
            let folder=NSOpenPanel();folder.canChooseFiles=false;folder.canChooseDirectories=true;folder.canCreateDirectories=true
            folder.message="Choose the parent folder for the exported design.";panel=folder
        }
        importOperations[op] = {panel.cancel(nil)}
        panel.beginSheetModal(for:window) { result in
            guard self.importOperations.removeValue(forKey:op) != nil,result == .OK,let url=panel.url,
                  self.boundImport?.session==bound.session else {self.reply(id,false);return}
            perform(single ? url : url.appendingPathComponent(name,isDirectory:true))
        }
    }

    private func portableProject(_ id: Int, _ action: String, _ request: [String:Any]) {
        func sourceURL(_ token: String?) -> URL? {
            guard let token=token else {return nil}
            return folderQueue.sync {self.retainedInputs[token]?.0}
        }
        if action == "installProjectArchive" || action == "folderConvertSibling" {
            let converting=action=="folderConvertSibling"
            let source=sourceURL(request["sourceToken"] as? String)
            let binding=boundImport
            if converting && (binding==nil || source==nil || binding?.token != request["sourceToken"] as? String || binding?.session != request["session"] as? String) {
                reply(id,error:"The selected original source grant has expired.");return
            }
            let op=(request["operation"] as? String) ?? UUID().uuidString
            func chooseParent() {
                let panel=NSOpenPanel();panel.canChooseDirectories=true;panel.canChooseFiles=false;panel.canCreateDirectories=true
                panel.message="Choose a parent folder for the new Waffle project."
                self.importOperations[op]={panel.cancel(nil)}
                panel.beginSheetModal(for:self.window) {response in
                    guard self.importOperations.removeValue(forKey:op) != nil,response == .OK,let parent=panel.url else {self.reply(id,false);return}
                    publish(parent,nil)
                }
            }
            // First Save of an import always asks where the project goes. It starts in the folder
            // of the most recent Waffle project, else beside the source project folder, and never
            // inside the source project folder unless the user navigates there.
            func chooseDestination(_ source:URL) {
                let projectFolder=source.deletingLastPathComponent().standardizedFileURL
                let inside={(url:URL) -> Bool in
                    let folder=projectFolder.resolvingSymlinksInPath().path, path=url.resolvingSymlinksInPath().path
                    return path==folder || path.hasPrefix(folder.hasSuffix("/") ? folder : folder+"/")
                }
                let recentParent=self.recent.entries.lazy.filter {($0.path as NSString).pathExtension.lowercased()=="waffle"}
                    .map {URL(fileURLWithPath:$0.path).deletingLastPathComponent().deletingLastPathComponent()}
                    .first {var dir:ObjCBool=false;return FileManager.default.fileExists(atPath:$0.path,isDirectory:&dir) && dir.boolValue}
                let start=recentParent.flatMap {inside($0) ? nil : $0} ?? projectFolder.deletingLastPathComponent()
                // The first-save convention: "Sensor Board", then "Sensor Board (2)" when that name is taken.
                let fallback=((request["manifest"] as? String ?? "Project.waffle") as NSString).deletingPathExtension
                let stem=(((request["folderName"] as? String) ?? fallback) as NSString).lastPathComponent
                let taken=Set(((try? FileManager.default.contentsOfDirectory(atPath:start.path)) ?? []).map {$0.precomposedStringWithCanonicalMapping.lowercased()})
                let suggested=(1...10000).lazy.map {$0==1 ? stem : "\(stem) (\($0))"}
                    .first {!taken.contains($0.precomposedStringWithCanonicalMapping.lowercased())} ?? stem
                let panel=NSSavePanel()
                panel.title="Save Waffle Project Folder";panel.prompt="Create Folder";panel.canCreateDirectories=true
                panel.message="Choose where to create the Waffle project folder. The original files stay unchanged."
                panel.nameFieldStringValue=suggested
                panel.directoryURL=start
                self.importOperations[op]={panel.cancel(nil)}
                panel.beginSheetModal(for:self.window) {response in
                    guard self.importOperations.removeValue(forKey:op) != nil,response == .OK,let url=panel.url else {self.reply(id,false);return}
                    publish(url.deletingLastPathComponent(),url.lastPathComponent)
                }
            }
            func publish(_ parent:URL,_ destination:String?) {
                let marker=FileManager.default.temporaryDirectory.appendingPathComponent("waffle-convert-"+UUID().uuidString)
                do {try Data().write(to:marker,options:.withoutOverwriting)} catch {self.reply(id,error:error.localizedDescription);return}
                self.importOperations[op]={try? FileManager.default.removeItem(at:marker)}
                self.folderQueue.async {
                    do {
                        guard let manifest=request["manifest"] as? String,let version=request["version"] as? String,
                              let files=request["files"] as? [[String:Any]] else {throw FolderFailure("Invalid project request.")}
                        var args:[String:Any]=["parent":parent.path,"manifest":manifest,"version":version,"files":files,"guardFile":marker.path]
                        if let destination=destination {args["destinationName"]=destination}
                        let data=try Self.archiveHelper(converting ? "convert" : "install",args)
                        guard let path=data["manifest"] as? String else {throw FolderFailure("Missing new project.")}
                        DispatchQueue.main.async {
                            guard let done=self.importOperations.removeValue(forKey:op) else {self.reply(id,false);return}
                            done();self.offerFolder(URL(fileURLWithPath:path),id:id,asFile:false)
                        }
                    } catch {DispatchQueue.main.async {
                        guard let done=self.importOperations.removeValue(forKey:op) else {self.reply(id,false);return}
                        done()
                        self.reply(id,error:error.localizedDescription=="WAFFLE-PARENT-READ-ONLY" ?
                                   "Choose a writable project destination." : error.localizedDescription)
                    }}
                }
            }
            if converting,let source=source {chooseDestination(source)} else {chooseParent()}
            return
        }
        folderQueue.async {
            do {
                guard let grant=request["grant"] as? String, let lease=request["lease"] as? String,
                      let binding=request["bindingPath"] as? String, let input=request["inputId"] as? String else {throw FolderFailure("Invalid source request.")}
                let store=try self.folderService(grant:grant)
                _ = try store.read(lease:lease,paths:[])
                let result=try Self.archiveHelper("original",["root":store.rootURL.path,"manifest":store.manifest,"bindingPath":binding,"inputId":input])
                _ = try store.read(lease:lease,paths:[])
                DispatchQueue.main.async { self.reply(id,result) }
            } catch { DispatchQueue.main.async { self.reply(id,error:error.localizedDescription) } }
        }
    }

    private func chooseProjectFolder(_ id: Int, _ request: [String:Any]) {
        if request["mode"] as? String == "open" {
            let panel = NSOpenPanel()
            panel.title = "Open Waffle Project"
            panel.canChooseFiles = true; panel.canChooseDirectories = true
            if let type = UTType(filenameExtension:"waffle") { panel.allowedContentTypes = [type] }
            panel.allowsMultipleSelection = false
            panel.beginSheetModal(for:window) { response in
                guard self.currentRequest(id) else { return }
                guard response == .OK, let url = panel.url else { self.reply(id,false); return }
                self.offerFolder(url,id:id,asFile:false)
            }
            return
        }
        guard request["mode"] as? String == "create" else { reply(id,error:"Unrecognised folder selection."); return }
        let panel = NSSavePanel()
        panel.title = "Save Waffle Project Folder"
        panel.prompt = "Create Folder"
        panel.canCreateDirectories = true
        let suggestion = ((request["name"] as? String ?? "Untitled") as NSString).lastPathComponent
        panel.nameFieldStringValue = suggestion.hasSuffix(".waffle") ? String(suggestion.dropLast(7)) : suggestion
        panel.beginSheetModal(for:window) { response in
            guard self.currentRequest(id) else { return }
            guard response == .OK, let url = panel.url else { self.reply(id,false); return }
            do {
                let name = try FolderTransactions.createRoot(at:url)
                self.offerFolder(url,id:id,asFile:false,newManifest:name)
            } catch { self.reply(id,error:error.localizedDescription) }
        }
    }

    private static let attachmentTypes = ["image/png","image/jpeg","image/heic","image/webp","image/svg+xml","application/pdf"]
    private func pickFolderAsset(_ id: Int, _ request: [String:Any]) {
        guard let grant = request["grant"] as? String, let owner = request["ownerId"] as? String, !owner.isEmpty,
              owner.utf8.count <= 1024 else { reply(id,error:"Choose an editable sheet first."); return }
        let requested = request["mediaTypes"] as? [String] ?? Self.attachmentTypes
        guard !requested.isEmpty, requested.allSatisfy(Self.attachmentTypes.contains) else { reply(id,error:"Unsupported attachment type."); return }
        let panel = NSOpenPanel()
        panel.title = "Choose Project Attachment"; panel.canChooseFiles = true; panel.canChooseDirectories = false
        panel.allowsMultipleSelection = false
        panel.allowedContentTypes = requested.compactMap { UTType(mimeType:$0) }
        panel.beginSheetModal(for:window) { response in
            guard self.currentRequest(id) else { return }
            guard response == .OK, let url = panel.url else { self.reply(id,false); return }
            self.folderQueue.async {
                do {
                    _ = try self.folderService(grant:grant)
                    guard self.folderSources.count < 64 else { throw FolderFailure("Finish or cancel the pending attachments first.") }
                    let fd = Darwin.open(url.path,O_NOFOLLOW | O_RDONLY | O_CLOEXEC | O_NONBLOCK)
                    guard fd >= 0 else { throw FolderFailure("The selected attachment could not be opened.") }
                    let handle = FileHandle(fileDescriptor:fd,closeOnDealloc:true)
                    let type = try FolderTransactions.mediaType(of:handle)
                    guard requested.contains(type) else { throw FolderFailure("The attachment contents do not match a selected media type.") }
                    let token = UUID().uuidString.lowercased()
                    self.folderSources[token] = (grant,owner,type,handle)
                    DispatchQueue.main.async { self.reply(id,["sourceToken":token,"name":url.lastPathComponent,"mediaType":type]) }
                } catch { DispatchQueue.main.async { self.reply(id,error:error.localizedDescription) } }
            }
        }
    }

    private func performFolderAction(_ action: String, id: Int, request: [String:Any]) {
        let verifiedRead = action == "folderReadVerified"
        func refuse(_ message: String) {
            let context: Any
            if verifiedRead, let identity = FolderTransactions.modelReadIdentity(request) {
                context = ["lease":identity.lease,"verificationNonce":identity.nonce]
            } else { context = NSNull() }
            self.reply(id,context,error:message,verifiedRead:verifiedRead)
        }
        guard let grant = request["grant"] as? String else { refuse("Choose a project folder first."); return }
        if action == "folderStatus", applyingFolders.contains(grant) { reply(id,["state":"applying","paths":[]]); return }
        guard pendingFolderRequests < 64 else { refuse("The project is busy. Retry after the current reads and writes finish."); return }
        let approvedCopies: [String:ApprovedDocumentCopy]
        do { approvedCopies = action == "folderCommit" ? try approvedDocumentCopies(request,grant:grant) : [:] }
        catch { refuse(error.localizedDescription); return }
        pendingFolderRequests += 1
        folderQueue.async {
            defer { DispatchQueue.main.async { self.pendingFolderRequests -= 1 } }
            var acknowledged = false
            do {
                let store = try self.folderService(grant:grant)
                let result: Any
                switch action {
                case "folderReadLease": result = try store.desktopReadLease()
                case "folderReadVerified": result = try store.readVerified(request)
                case "folderRead":
                    guard let lease = request["lease"] as? String, let paths = request["paths"] as? [String] else { throw FolderFailure("Invalid saved snapshot read.") }
                    result = ["files": try store.read(lease:lease,paths:paths)]
                case "folderRelease": try store.release(request["lease"] as? String ?? ""); result = true
                case "folderAdopt":
                    try store.confirmSelection()
                    let path = store.rootURL.appendingPathComponent(store.manifest)
                    let identity = store.projectID
                    DispatchQueue.main.async {
                        guard self.currentRequest(id) else { return }
                        self.resetImportSave(); self.pendingImportTokens.removeAll()
                        self.leaveVisibleFolder(except:grant)
                        self.gitSource = nil
                        self.watchFolder(of:nil)
                        self.visibleFolder = (grant,path)
                        self.visibleProjectIdentity = identity
                        self.window?.representedURL = path
                        self.noteRecent(path)
                    }
                    result = true
                case "folderConflict": result = try store.conflict()
                case "folderConflictRead":
                    guard let tx = request["transaction"] as? String, let path = request["path"] as? String, let side = request["side"] as? String,
                          let offset = request["offset"] as? Int, let length = request["length"] as? Int else { throw FolderFailure("Invalid conflict read.") }
                    result = try store.conflictRead(transaction:tx,path:path,side:side,offset:offset,length:length)
                case "folderCommit", "folderResolve":
                    let report: ([String:Any]) -> Void = { receipt in
                        acknowledged = true
                        DispatchQueue.main.async {
                            if self.currentRequest(id) {
                                self.applyingFolders.insert(grant)
                                if self.visibleFolder?.grant == grant { self.trackDocumentCopies(approvedCopies,receipt:receipt) }
                            }
                            self.reply(id,receipt)
                        }
                    }
                    if action == "folderResolve" { try store.resolve(request,acknowledged:report) }
                    else { try store.commit(request,nativeCopyHashes:approvedCopies.mapValues(\.sha256),acknowledged:report) }
                    let status = store.status()
                    self.folderEventSequence += 1
                    self.sendFolderEvent(["type":"folderChanged","grant":grant,"seq":self.folderEventSequence,"paths":[],"overflow":false,"status":status])
                    return
                case "folderStatus": result = store.status()
                case "folderLocalState": result = try store.localState(request["localState"] as? [String:Any])
                case "folderClose":
                    self.revokeFolder(grant)
                    DispatchQueue.main.async {
                        if let previous = self.visibleFolder, previous.grant == grant {
                            self.releaseFolderLocks(previous)
                            self.visibleFolder = nil
                            self.visibleProjectIdentity = nil
                            self.selectedDocumentCopies.removeAll(); self.installedDocumentCopies.removeAll()
                            self.watchFolder(of: nil)
                        }
                    }
                    result = true
                case "folderDraftAssetProof", "folderRestoreDraftAsset":
                    result = try store.draftAsset(request,profile:HostFiles.supportDirectory,restore:action == "folderRestoreDraftAsset")
                case "folderStageAsset":
                    guard let token = request["sourceToken"] as? String, let src = self.folderSources[token],
                          src.grant == grant, src.owner == request["ownerId"] as? String,
                          src.type == request["mediaType"] as? String else { throw FolderFailure("Choose this sheet's attachment again.") }
                    guard try FolderTransactions.mediaType(of:src.handle) == src.type else { throw FolderFailure("The selected attachment changed.") }
                    let staged = try store.stageAsset(source:src.handle,owner:src.owner,mediaType:src.type)
                    if let ref = staged["assetRef"] as? [String:Any], let assetToken = staged["assetToken"] as? String,
                       (request["expectedSha256"] != nil && request["expectedSha256"] as? String != ref["sha256"] as? String ||
                        request["expectedLength"] != nil && request["expectedLength"] as? Int != ref["byteLength"] as? Int) {
                        store.dropAsset(assetToken)
                        throw FolderFailure("The selected attachment changed during validation.")
                    }
                    result = staged
                    self.folderSources.removeValue(forKey:token)
                case "folderDropAsset":
                    if let token = request["assetToken"] as? String { store.dropAsset(token) }
                    if let token = request["sourceToken"] as? String, self.folderSources[token]?.grant == grant { self.folderSources.removeValue(forKey:token) }
                    result = true
                case "folderReadAsset":
                    guard let owner = request["ownerId"] as? String, let purpose = request["purpose"] as? String,
                          let asset = request["assetRef"] as? [String:Any], let offset = request["offset"] as? Int, let length = request["length"] as? Int else {
                        throw FolderFailure("Invalid attachment range.")
                    }
                    result = try store.readAsset(lease:request["lease"] as? String,stagedToken:request["assetToken"] as? String,owner:owner,asset:asset,purpose:purpose,offset:offset,length:length)
                default: throw FolderFailure("Unknown folder operation.")
                }
                DispatchQueue.main.async { self.reply(id,result,verifiedRead:verifiedRead) }
            } catch {
                if acknowledged {
                    self.folderEventSequence += 1
                    let status = self.folders[grant]?.status() ?? ["state":"recoveryPending"]
                    self.sendFolderEvent(["type":"folderChanged","grant":grant,"seq":self.folderEventSequence,"paths":status["paths"] ?? [],"overflow":false,"status":status])
                } else { DispatchQueue.main.async { refuse(error.localizedDescription) } }
            }
        }
    }

    private func sendWorkspaceEvent(_ event: [String:Any]) {
        guard initialPageReady, webProcessAvailable else { return }
        web.callAsyncJavaScript("await globalThis.__waffleWorkspaceEvent?.(event);", arguments:["event":event],
                                in:nil,in:.page,completionHandler:nil)
    }

    private func notifyWorkspaceWriterUnavailable() {
        guard let group = workspaceGroup, group.writer === self else { return }
        for peer in Self.editors where peer !== self && peer.workspaceGroup === group {
            peer.sendWorkspaceEvent(["type":"writer-unavailable"])
        }
    }

    private func performWorkspaceAction(_ id: Int, _ request: [String:Any], byteCount: Int) {
        guard byteCount <= 1 << 20, let operation = request["operation"] as? String else {
            reply(id,error:"Invalid project window operation."); return
        }
        let staleWriter = workspaceGroup.map { $0.writer === self && ($0.manifest != visibleFolder?.manifest || $0.project != visibleProjectIdentity) } ?? false
        if operation == "describe", workspaceGroup == nil || staleWriter {
            guard let active = visibleFolder, let project = visibleProjectIdentity,
                  request["grant"] as? String == active.grant, request["project"] as? String == project else {
                reply(id,error:"Open a native Waffle project to manage its windows."); return
            }
            if let old = workspaceGroup {
                for editor in Self.editors.filter({ $0 !== self && $0.workspaceGroup === old }) {
                    editor.workspaceGroup = nil
                    editor.window.close()
                }
            }
            workspaceGroup = WorkspaceGroup(project:project,manifest:active.manifest,writer:self)
            workspaceWindow = UUID().uuidString.lowercased()
        }
        guard let group = workspaceGroup, let member = workspaceWindow, let writer = group.writer,
              writer.visibleFolder?.manifest == group.manifest, writer.visibleProjectIdentity == group.project else {
            reply(id,error:"The project window writer is unavailable."); return
        }
        switch operation {
        case "describe":
            var value: [String:Any] = ["project":group.project, "window":member, "writer":writer === self]
            if let tab = workspaceTab { value["tab"] = tab }
            if writer === self {
                value["frames"] = Self.editors.filter { $0.workspaceGroup === group }.compactMap { editor -> [String:Any]? in
                    guard let key = editor.workspaceWindow, let window = editor.window else { return nil }
                    let frame = window.frame
                    let display = window.screen?.deviceDescription[NSDeviceDescriptionKey("NSScreenNumber")] as? NSNumber
                    return ["id":key, "bounds":["display":display?.stringValue ?? "", "left":Int(frame.minX), "top":Int(frame.minY),
                                                 "width":Int(frame.width), "height":Int(frame.height)]]
                }
            }
            reply(id,value)
        case "apply-layout":
            guard writer === self, let rows = request["windows"] as? [[String:Any]], !rows.isEmpty,
                  let focused = request["focused"] as? String,
                  rows.allSatisfy({ row in
                      guard let key = row["id"] as? String, UUID(uuidString:key) != nil,
                            let tab = row["active"] as? String, !tab.isEmpty else { return false }
                      return true
                  }) else { reply(id,error:"The project window layout is invalid."); return }
            let keys = rows.compactMap { $0["id"] as? String }
            guard Set(keys).count == rows.count, keys.contains(focused), keys.contains(member) else { reply(id,error:"The project window layout is invalid."); return }
            for row in rows {
                guard let key = row["id"] as? String, let tab = row["active"] as? String else { continue }
                let editor = Self.editors.first { $0.workspaceGroup === group && $0.workspaceWindow == key } ?? Desktop()
                editor.workspaceGroup = group
                editor.workspaceWindow = key
                editor.workspaceTab = tab
                if editor.window == nil { editor.createEditorWindow() }
                if let bounds = row["bounds"] as? [String:Any], let x = bounds["left"] as? Int, let y = bounds["top"] as? Int,
                   let w = bounds["width"] as? Int, let h = bounds["height"] as? Int, w > 0, h > 0 {
                    let frame = NSRect(x:CGFloat(x),y:CGFloat(y),width:CGFloat(w),height:CGFloat(h))
                    if NSScreen.screens.contains(where: { $0.frame.intersects(frame) }) { editor.window.setFrame(frame,display:true) }
                }
                if editor !== writer { editor.sendWorkspaceEvent(["type":"view", "tab":tab]) }
                if key == focused { editor.window.makeKeyAndOrderFront(nil) }
            }
            for editor in Self.editors.filter({ $0.workspaceGroup === group && !keys.contains($0.workspaceWindow ?? "") }) {
                editor.workspaceGroup = nil; editor.window.close()
            }
            reply(id,true)
        case "snapshot", "command":
            guard writer.initialPageReady, writer.webProcessAvailable else { reply(id,error:"The project writer is recovering."); return }
            let packet: [String:Any] = ["operation":operation, "from":member, "value":request["value"] ?? NSNull()]
            writer.web.callAsyncJavaScript("return await globalThis.AtriumProjectWindowClient.serve(packet);",
                arguments:["packet":packet],in:nil,in:.page) { [weak self] result in
                guard let self = self, self.currentRequest(id), self.workspaceGroup === group else { return }
                switch result {
                case .success(let value): self.reply(id,value)
                case .failure(let error): self.reply(id,error:error.localizedDescription)
                }
            }
        case "broadcast":
            guard writer === self, let value = request["value"] as? [String:Any] else { reply(id,error:"Only the project writer can publish a revision."); return }
            for editor in Self.editors where editor !== self && editor.workspaceGroup === group {
                editor.sendWorkspaceEvent(value)
            }
            reply(id,true)
        default: reply(id,error:"Unknown project window operation.")
        }
    }

    private static func nativeProjectPath(_ urls: [URL]) -> URL? {
        guard urls.count == 1, let url = urls.first, ProjectFileType.accepts(url) else { return nil }
        return ProjectWrites.canonical(url)
    }

    private static func opensDesign(_ urls: [URL]) -> Bool {
        urls.contains { !translators.libraries.contains($0.pathExtension.lowercased()) }
    }

    private func activateProjectWindow(for urls: [URL]) -> Bool {
        if let path = Self.nativeProjectPath(urls), let existing = Self.editors.first(where: {
            $0.visibleFolder?.manifest == path || $0.openingProjectPath == path || Self.nativeProjectPath($0.incoming) == path
        }) {
            existing.window.makeKeyAndOrderFront(nil)
            return true
        }
        guard Self.opensDesign(urls), hasProject || openingProject || !incoming.isEmpty else { return false }
        let editor = Desktop()
        editor.incoming = urls
        editor.createEditorWindow()
        return true
    }

    private func openDocument(_ url: URL, kind: String, id: Int) {
        openingProject = true
        folderQueue.async { [self] in
            let owner = Result { try FolderTransactions.indexedDocument(url,kind:kind) }
            DispatchQueue.main.async {
                guard self.currentRequest(id) else { return }
                self.openingProject = false
                switch owner {
                case .failure(let error):
                    self.reply(id,error:error.localizedDescription)
                    if !self.incoming.isEmpty { self.issue("open") }
                case .success(let result):
                    if let result = result, let editor = Self.editors.first(where: {
                        $0.visibleFolder?.manifest == result.manifest
                    }) {
                        editor.window.makeKeyAndOrderFront(nil)
                        editor.web?.callAsyncJavaScript("return window.__waffleFocusNativeMember(path);",
                            arguments:["path":result.path],in:nil,in:.page,completionHandler:nil)
                        self.reply(id, [])
                    } else if self.hasProject {
                        let editor = Desktop()
                        editor.incoming = [url]
                        editor.createEditorWindow()
                        self.reply(id, [])
                    } else {
                        self.openingProject = true
                        if let result = result {
                            self.openingProjectPath = result.manifest
                            self.offerFolder(result.manifest,id:id,asFile:true,memberPath:result.path)
                        } else { self.offerNativeMember(url,kind:kind,id:id) }
                    }
                }
            }
        }
    }

    private func offerNativeMember(_ url: URL, kind: String, id: Int) {
        folderQueue.async { [self] in
            do {
                guard self.nativeMembers.count < 8 else { throw FolderFailure("Close a document before opening another.") }
                let member = try NativeMemberFile(url,kind:kind)
                let file = try member.open(), grant = member.grant
                self.nativeMembers[grant] = member
                DispatchQueue.main.async {
                    guard self.currentRequest(id) else {
                        self.folderQueue.async { self.nativeMembers.removeValue(forKey:grant) }
                        return
                    }
                    self.reply(id,[file])
                }
            } catch {
                DispatchQueue.main.async {
                    guard self.currentRequest(id) else { return }
                    self.openingProject = false
                    self.reply(id,error:error.localizedDescription)
                    if !self.incoming.isEmpty { self.issue("open") }
                }
            }
        }
    }

    private func exportNativeMemberCopy(_ id: Int, _ request: [String:Any]) {
        guard let grant = request["grant"] as? String, let encoded = request["data"] as? String,
              let name = request["name"] as? String, (1...255).contains(name.utf8.count),
              !name.hasPrefix("."), name == (name as NSString).lastPathComponent,
              let type = UTType(filenameExtension:(name as NSString).pathExtension.lowercased()),
              ProjectFileType.documentName(URL(fileURLWithPath:name)) else {
            reply(id,error:"Choose a Waffle document filename for the copy."); return
        }
        folderQueue.async { [self] in
            let result = Result {
                guard let member = self.nativeMembers[grant] else { throw FolderFailure("The selected document is no longer open.") }
                return try member.copyBytes(encoded)
            }
            DispatchQueue.main.async {
                guard self.currentRequest(id) else { return }
                switch result {
                case .failure(let error): self.reply(id,error:error.localizedDescription)
                case .success(let bytes):
                    let panel = NSSavePanel()
                    panel.title = "Save a Waffle Document Copy"
                    panel.nameFieldStringValue = name
                    panel.allowedContentTypes = [type]
                    panel.canCreateDirectories = true
                    panel.beginSheetModal(for:self.window) { response in
                        guard self.currentRequest(id) else { return }
                        guard response == .OK, let destination = panel.url else { self.reply(id,false); return }
                        self.folderQueue.async {
                            let writing = Result {
                                guard let member = self.nativeMembers[grant] else { throw FolderFailure("The selected document is no longer open.") }
                                try member.exportCopy(bytes,to:destination)
                            }
                            DispatchQueue.main.async {
                                switch writing {
                                case .success: self.reply(id,true)
                                case .failure(let error): self.reply(id,error:error.localizedDescription)
                                }
                            }
                        }
                    }
                }
            }
        }
    }

    private func openDesignFiles(_ urls: [URL], id: Int) {
        do { try urls.forEach(ProjectFileType.checkSelection) } catch { reply(id,error:error.localizedDescription); return }
        if urls.count == 1, let url = urls.first, let kind = ProjectFileType.documentKinds[url.pathExtension.lowercased()] {
            openDocument(url,kind:kind,id:id)
            return
        }
        if activateProjectWindow(for: urls) { reply(id, []); return }
        openingProject = Self.opensDesign(urls)
        openingProjectPath = Self.nativeProjectPath(urls)
        readFiles(urls, id: id, opening: true)
    }

    private func readFiles(_ urls: [URL], id: Int, opening: Bool = false, picking: Bool = false, library: Bool = false, detached: Bool = false, expectedKey: String? = nil, operation: String? = nil) {
        do { try urls.forEach(ProjectFileType.checkSelection) } catch { openingProject = false; openingProjectPath = nil; reply(id,error:error.localizedDescription); return }
        if !picking, !urls.isEmpty, urls.allSatisfy(ProjectFileType.documentName) {
            let grant = detached ? visibleFolder?.grant : nil
            DispatchQueue.global(qos:.userInitiated).async {
                let result = Result { try Self.copyDocumentRows(urls) }
                DispatchQueue.main.async {
                    guard self.currentRequest(id) else { return }
                    switch result {
                    case .success(let rows): self.reply(id,self.copyDocumentPackets(rows,grant:grant))
                    case .failure(let error): self.reply(id,error:error.localizedDescription)
                    }
                }
            }
            return
        }
        if !picking, urls.contains(where:ProjectFileType.documentName) {
            reply(id,error:"Open Waffle documents separately from other file formats.")
            return
        }
        if urls.count == 1, let url = urls.first, Self.isFolder(url) || (try? FolderTransactions.isManifest(url)) == true ||
            (url.pathExtension.lowercased() == "waffle" && !FileManager.default.fileExists(atPath:url.path) && (try? FolderTransactions(root:url.deletingLastPathComponent(),manifest:url.lastPathComponent).isSelectedManifest()) == true) {
            offerFolder(url,id:id,asFile:true)
            return
        }
        if urls.contains(where:ProjectFileType.projectName) {
            openingProject = false; openingProjectPath = nil
            reply(id, error:"Open one Waffle project folder at a time."); return
        }
        guard picking || urls.allSatisfy(translators.accepts) else {
            reply(id, error: "Choose a file in a supported import format.")
            return
        }
        DispatchQueue.global(qos: .userInitiated).async {
            do {
                var origins: [String:(URL,String,Int)] = [:]
                func retained(_ url: URL, _ bytes: Data) -> String {
                    let token = UUID().uuidString
                    origins[token] = (url, ProjectWrites.digest(bytes).map { String(format:"%02x",$0) }.joined(),bytes.count)
                    return token
                }
                var pickedSource: AltiumCopySource?
                var history: (token: String, path: URL)?
                var manifest: (URL, Data)?
                var remaining = HostFiles.projectReadCap
                if !picking && urls.filter({ AltiumProjectFiles.types.contains($0.pathExtension.lowercased()) }).count > AltiumProjectFiles.maxFiles {
                    throw HostFiles.failure("Too many Altium documents were selected.")
                }
                var result: [[String: String]] = try urls.map { url in
                    let ext = url.pathExtension.lowercased()
                    let canonical = ProjectWrites.canonical(url)
                    var bytes: Data
                    if picking && self.sourceTypes.contains(ext) {
                        let source = try AltiumCopySource(url)
                        bytes = try source.read()
                        pickedSource = source
                    } else {
                        let cap = !picking && ext == "prjpcb" ? min(remaining, AltiumProjectFiles.manifestCap) : remaining
                        (bytes, _) = try HostFiles.readRegular(canonical, cap: cap)
                    }
                    guard bytes.count <= remaining else { throw HostFiles.failure("The selected files exceed the import size limit.") }
                    remaining -= bytes.count
                    var file = ["name": url.lastPathComponent, "data": bytes.base64EncodedString()]
                    if !detached && ext != "zip" && translators.accepts(url) {
                        file["retainedInputToken"] = retained(url,bytes)
                    }
                    if !picking && url.pathExtension.lowercased() == "prjpcb" {
                        manifest = (url, bytes)
                        file["altiumPath"] = url.lastPathComponent
                    }
                    if let source = pickedSource { file["sourceToken"] = source.token }
                    if library && HostFiles.libraryTypes.contains(url.pathExtension.lowercased()) {
                        file["path"] = ProjectWrites.canonical(url).path
                    }
                    if opening && Desktop.historyTypes.contains(ext) &&
                        (urls.count == 1 || (["prjpcb", "kicad_pro"].contains(ext) && urls.filter { ["prjpcb", "kicad_pro"].contains($0.pathExtension.lowercased()) }.count == 1)) {
                        let token = UUID().uuidString
                        history = (token, ProjectWrites.canonical(url))
                        file["historyToken"] = token
                    }
                    return file
                }
                if let (url, bytes) = manifest, urls.filter({ $0.pathExtension.lowercased() == "prjpcb" }).count == 1 {
                    try AltiumProjectFiles.include(url, bytes: bytes, selected: urls, files: &result, remaining: &remaining, retained:retained)
                }
                let selectedOrigins = origins
                for i in result.indices {
                    if let t=result[i]["retainedInputToken"],let row=origins[t] { result[i]["importSaveKey"]=Self.importKey(row.0,row.1) }
                }
                if let key=expectedKey {
                    guard let first=result.firstIndex(where:{$0["importSaveKey"]==key}) else {
                        DispatchQueue.main.async {self.importOperations.removeValue(forKey:operation ?? "");self.reply(id,NSNull())}
                        return
                    }
                    result.insert(result.remove(at:first),at:0)
                }
                self.folderQueue.sync {
                    self.retainedInputs.merge(selectedOrigins) { _,new in new }
                    if self.retainedInputs.count > 4096 {
                        self.retainedInputs = selectedOrigins
                    }
                }
                let source = pickedSource, opened = result, manifestURL = manifest?.0, sourceHistory = history
                DispatchQueue.main.async {
                    guard self.currentRequest(id) else { return }
                    if let op=operation, self.importOperations.removeValue(forKey:op) == nil { self.reply(id,NSNull());return }
                    if !selectedOrigins.isEmpty && !detached && !picking { self.pendingImportTokens=Set(selectedOrigins.keys) }
                    if opening {
                        self.pendingManifest = manifestURL
                        self.pickedHistory = sourceHistory
                    }
                    if let source = source { self.selectedSource = source }
                    if library { urls.forEach { self.libraryReads.remember($0) } }
                    self.reply(id, opened)
                }
            } catch {
                DispatchQueue.main.async {
                    guard self.currentRequest(id) else { return }
                    if opening {
                        self.openingProject = false
                        self.openingProjectPath = nil
                        if !self.incoming.isEmpty { self.issue("open") }
                    }
                    self.reply(id, error: error.localizedDescription)
                }
            }
        }
    }

    private var historyProject: (token: String, path: URL)? {
        if let folder = visibleFolder { return (folder.grant,folder.manifest) }
        return nil
    }
    private func readGit(id: Int, action: String, token: String?, revision: String?) {
        guard let active = historyProject, token == active.token, let resources = Bundle.main.resourceURL else {
            reply(id, error: "Save or open a Waffle project to compare its Git revision."); return
        }
        let listing = action == "gitHistory"
        var arguments = ["python3","-I","-B",resources.appendingPathComponent("native/git_head.py").path,"--project",active.path.path]
        if listing {
            arguments.append("--history")
        } else {
            arguments.append("--desktop-stream")
            if action == "gitRevision" {
                guard let revision = revision, [40,64].contains(revision.utf8.count),
                      revision.utf8.allSatisfy({ (48...57).contains($0) || (97...102).contains($0) }) else {
                    reply(id, error: "Choose a full commit identifier from the project history."); return
                }
                arguments.append("--revision=" + revision)
            }
        }
        runGitHelper(id: id, active: active, command: arguments, listing: listing)
    }

    /// gitQuery: one Git operation for the revision picker, file history, merge and commit views.
    /// The arguments pass gitQueryArguments (the same rules as the Windows host's
    /// Policy.GitQuery and native/git_head.py validate_query) and travel to git_head.py as JSON.
    private func queryGit(id: Int, token: String?, op: String?, args: Any?, advisory: Bool) {
        let binding = Self.sourceQueries.contains(op ?? "") && token == gitSource?.token ? gitSource : historyProject
        guard let active = binding, token == active.token, let resources = Bundle.main.resourceURL else {
            reply(id, error: "Save or open a Waffle project to compare its Git revision."); return
        }
        guard let op = op, let json = Desktop.gitQueryArguments(op: op, args: args) else {
            reply(id, error: "Waffle does not run that Git query."); return
        }
        if active.token == visibleFolder?.grant && !Self.folderGitQueries.contains(op) {
            reply(id, error: "This Git command is unavailable for a folder project."); return
        }
        var arguments = ["python3","-I","-B",resources.appendingPathComponent("native/git_head.py").path,"--project",active.path.path,
                         "--query",op,"--args=" + json]
        if op == "read" { arguments.append("--desktop-stream") }
        runGitHelper(id:id,active:active,command:arguments,listing:op != "read",advisoryStatus:advisory && op == "status")
    }

    static let folderGitQueries: Set<String> = ["createBranch","refs","status","log","fileLog","projectLog","projectBlobs","folderRevisions","mergeBase",
                                               "lfsStatus","lfsLocks","lfsLock","lfsUnlock","commitPlan","commitStaged"]

    static let gitQueryKeys: [String: Set<String>] = [
        "createBranch": ["name","revision","confirm"], "refs": [], "status": [], "log": ["refs","limit","skip","search"], "fileLog": ["limit","skip"], "projectLog": ["limit","skip","snapshot","firstParent","recordLinks"], "projectBlobs": ["revisions"], "folderRevisions": ["revisions","stage","stages","known"], "sourceRevision": ["revision"], "sourceLog": ["limit","skip"], "read": ["revision"],
        "mergeBase": ["a","b"], "blameLog": ["limit"], "patches": ["head","revisions"], "installMergeDriver": ["confirm","plan"], "mergeDriverPlan": [],
        // Git LFS locks (docs/collaboration.md): status is local; the others contact the LFS server and need confirm.
        "lfsStatus": [], "lfsLocks": ["confirm"], "lfsLock": ["confirm"], "lfsUnlock": ["confirm"],
        "commitPlan": [], "commitStaged": ["confirm","message","paths","plan"]]

    /// Canonical JSON arguments for an allowed query, or nil. Strings are at most 256 printable
    /// characters, integers from 0 to 10,000,000, and bounded, typed lists and flags.
    static func gitQueryArguments(op: String, args: Any?) -> String? {
        guard let keys = gitQueryKeys[op] else { return nil }
        let given: [String: Any]
        if args == nil || args is NSNull { given = [:] } else if let dict = args as? [String: Any] { given = dict } else { return nil }
        func text(_ value: Any) -> String? {
            guard let s = value as? String, s.unicodeScalars.count <= 256, !s.unicodeScalars.contains(where: { $0.value < 0x20 || $0.value == 0x7f }) else { return nil }
            return s
        }
        func commit(_ s: String) -> Bool { [40,64].contains(s.utf8.count) && s.utf8.allSatisfy { (48...57).contains($0) || (97...102).contains($0) } }
        var clean: [String: Any] = [:]
        for (key, value) in given {
            guard keys.contains(key) else { return nil }
            if key == "stages" {
                guard let values = value as? [String], (1...3).contains(values.count),
                      values.allSatisfy({ ["base","ours","theirs"].contains($0) }) else { return nil }
                clean[key] = values; continue
            }
            if key == "paths" {
                guard let paths = value as? [String], (1...256).contains(paths.count),
                      paths.allSatisfy({ text($0) != nil }) else { return nil }
                clean[key] = paths; continue
            }
            let flag = key == "confirm" || key == "firstParent" || key == "recordLinks"
            if let number = value as? NSNumber {
                if CFGetTypeID(number) == CFBooleanGetTypeID() {
                    guard flag else { return nil }
                    clean[key] = number.boolValue; continue
                }
                let d = number.doubleValue
                guard !flag, d >= 0, d <= 10_000_000, d == d.rounded() else { return nil }
                clean[key] = Int(d); continue
            }
            guard !flag else { return nil }
            if let list = value as? [Any] {
                guard key == "refs" || key == "revisions" || key == "known", list.count <= 256 else { return nil }
                var items: [String] = []
                for item in list {
                    guard let s = text(item), key == "refs" || commit(s) else { return nil }
                    items.append(s)
                }
                clean[key] = items; continue
            }
            guard let s = text(value) else { return nil }
            clean[key] = s
        }
        guard let data = try? JSONSerialization.data(withJSONObject: clean, options: [.sortedKeys]) else { return nil }
        return String(data: data, encoding: .utf8)
    }

    private func runGitHelper(id: Int, active: (token: String, path: URL), command: [String], listing: Bool, advisoryStatus: Bool = false) {
        let folder = visibleFolder?.grant == active.token ? active.token : nil
        DispatchQueue.global(qos: .userInitiated).async {
            let child = Process(), output = Pipe(), errors = Pipe()
            child.executableURL = URL(fileURLWithPath: "/usr/bin/env")
            child.arguments = command
            child.standardOutput = output
            child.standardError = errors
            do {
                let lease = try folder.flatMap { grant in
                    try self.folderQueue.sync { () -> AnyObject? in
                        let store = try self.folderService(grant:grant)
                        // The passive Open notice is advisory. Explicit status, comparison,
                        // conflict review and Commit still pin their working-folder snapshot.
                        if advisoryStatus { try store.confirmSelection(); return nil }
                        return try store.holdSnapshot()
                    }
                }
                defer { withExtendedLifetime(lease) {} }
                try child.run()
                let bytes = try output.fileHandleForReading.readToEnd() ?? Data()
                let diagnostic = try errors.fileHandleForReading.readToEnd() ?? Data()
                child.waitUntilExit()
                guard child.terminationStatus == 0 else {
                    let message = String(decoding: diagnostic.prefix(1600), as: UTF8.self).trimmingCharacters(in: .whitespacesAndNewlines)
                    throw NSError(domain: "AtriumGit", code: 1, userInfo: [NSLocalizedDescriptionKey: message.isEmpty ? "Could not read the Git revision." : message])
                }
                let result: Any
                if listing {
                    result = try JSONSerialization.jsonObject(with: bytes)
                } else {
                    let invalid = NSError(domain: "AtriumGit", code: 1, userInfo: [NSLocalizedDescriptionKey:"Git returned an incomplete or invalid UTF-8 project."])
                    guard let separator = bytes.prefix(65536).firstIndex(of: 10),
                          let info = try JSONSerialization.jsonObject(with: bytes.prefix(upTo: separator)) as? [String:Any],
                          let size = info["size"] as? Int, size == bytes.count - separator - 1,
                          let commit = info["revision"] as? String, let path = info["path"] as? String else { throw invalid }
                    let payload = bytes.suffix(size)
                    let utf8 = payload.starts(with: [0xef,0xbb,0xbf]) ? payload.dropFirst(3) : payload
                    guard let text = String(data: utf8, encoding: .utf8) else { throw invalid }
                    var item: [String: Any] = ["revision":commit, "path":path, "text":text]
                    if let blob = info["blob"] as? String { item["blob"] = blob }
                    result = item
                }
                DispatchQueue.main.async {
                    if self.historyProject?.token == active.token || self.gitSource?.token == active.token { self.reply(id, result) }
                    else { self.reply(id, error: "The active project changed. Open revision review again.") }
                }
            } catch {
                DispatchQueue.main.async { self.reply(id, error: error.localizedDescription) }
            }
        }
    }

    func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
        guard webProcessAvailable, userContentController === web.configuration.userContentController,
              message.frameInfo.isMainFrame, message.frameInfo.request.url?.standardizedFileURL == page,
              let text = message.body as? String,
              let data = text.data(using: .utf8),
              let request = (try? JSONSerialization.jsonObject(with: data)) as? [String:Any],
              let action = request["action"] as? String else { return }
        if action == "launchReady" { revealAfterPresentation(); return }
        if action == "workspaceLaunchFailed" { workspaceLaunchFailed(); return }
        if action == "butterDropEnabled" {
            guard let view = web as? EditorWebView else { return }
            view.butterDropEnabled = request["enabled"] as? Bool == true
            if !view.butterDropEnabled { cancelTypedDrop() }
            return
        }
        if action == "butterDropCancel" {
            if let token = request["token"] as? String { cancelTypedDrop(token) }
            return
        }
        if action == "captionDragArea" {
            guard let content = window.contentView as? EditorWindowContent else { return }
            let area = request["area"] as? [Double] ?? []
            if area.count == 4, area.allSatisfy({ $0.isFinite && $0 >= 0 }), area[2] > 0, area[3] > 0 {
                content.captionDragArea = NSRect(x: area[0], y: area[1], width: area[2], height: area[3])
            } else {
                content.captionDragArea = .zero
            }
            return
        }
        if action == "recoverySession" {
            if editorSession == nil, let session = request["session"] as? String, (1...32).contains(session.utf8.count),
               session.utf8.allSatisfy({ (48...57).contains($0) || (97...122).contains($0) }) { editorSession = session }
            return
        }
        if action == "finishedOpening" {
            if request["success"] as? Bool == true, let url = pendingManifest { noteRecent(url) }
            pendingManifest = nil
            openingProject = false
            openingProjectPath = nil
            if !incoming.isEmpty { issue("open") }
            return
        }
        if action == "dirty" {
            reportedImportID=request["importId"] as? String
            let dirty = request["dirty"] as? Bool ?? false
            if window.isDocumentEdited != dirty { window.isDocumentEdited = dirty }
            hasProject = request["projectName"] is String
            projectName = request["projectName"] as? String
            foreignImportID = (request["importId"] as? String).flatMap { !$0.isEmpty && $0.count <= 160 ? $0 : nil }
            let title = (request["projectName"] as? String).map { $0.isEmpty ? "Untitled — Waffle" : String($0.prefix(160)) + " — Waffle" } ?? "Waffle"
            if window.title != title { window.title = title }
            if hasProject { openingProject = false }
            discardApproved = false
            if let pending = closeWhenClean { closeWhenClean = nil; pending(!dirty) }
            return
        }
        if action == "acceptHistorySource" {
            if let chosen = pickedHistory, request["token"] as? String == chosen.token {
                gitSource = chosen
                pickedHistory = nil
            }
            return
        }
        if action == "bindRestoredImportSave" {
            resetImportSave()
            if let draft=request["draftId"] as? String,!draft.isEmpty,draft.count<=160,let key=request["sourceKey"] as? String,
               key.range(of:"^(?:[a-z0-9_-]+:)?[0-9a-f]{64}$",options:.regularExpression) != nil,
               let format=request["format"] as? String,["altium","kicad","eagle","easyeda"].contains(format),
               let session=request["session"] as? String,UUID(uuidString:session) != nil {restoredImport=(session,draft,key,format)}
            return
        }
        if action == "bindImportSave" {
            bindImportSave(request); return
        }
        if action == "cancelImportSave" {
            if let op=request["operation"] as? String { importOperations.removeValue(forKey:op)?() }
            return
        }
        if action == "clearGitProject" {
            resetImportSave()
            gitSource = nil
            leaveVisibleFolder()
            window?.representedURL = nil
            return
        }
        if action == "externalCancel" {
            if let runId = request["runId"] as? String { ExternalTools.shared.cancel(runId) }
            return
        }
        guard let id = request["id"] as? Int, currentRequest(id) else { return }
        switch action {
        case "butterDropTake": takeTypedDrop(id,request)
        case "workspaceWindow": performWorkspaceAction(id,request,byteCount:data.count)
        case "inputDiagnostics":
            let operation = request["operation"] as? String ?? "read"
            guard let report = (web as? EditorWebView)?.inputLog.inspect(operation) else {
                reply(id, error: "Invalid input diagnostics operation."); return
            }
            reply(id, report)
        case "macShortcutGlyphs":
            reply(id, MacShortcutGlyphs.render(request["labels"] as? [String] ?? []))
        case "reselectImportSave", "importSaveChoice", "writeImportExport", "rememberImportExport", "recalledImportExport", "forgetImportExport":
            importedSaveAction(id,action,request)
        case "chooseProjectFolder": chooseProjectFolder(id,request)
        case "folderPickAsset": pickFolderAsset(id,request)
        case "folderResolve":
            let alert = NSAlert()
            alert.messageText = "Apply the reviewed conflict choices?"
            alert.informativeText = "Waffle will preserve both versions and install the changes selected for this project."
            alert.addButton(withTitle:"Apply Choices"); alert.addButton(withTitle:"Cancel")
            alert.beginSheetModal(for:window) { response in
                guard self.currentRequest(id) else { return }
                if response == .alertFirstButtonReturn { self.performFolderAction(action,id:id,request:request) }
                else { self.reply(id,false) }
            }
        case "folderAdopt", "folderReadLease", "folderRead", "folderReadVerified", "folderRelease", "folderStatus", "folderClose", "folderCommit",
             "folderLocalState", "folderStageAsset", "folderDropAsset", "folderReadAsset", "folderDraftAssetProof", "folderRestoreDraftAsset", "folderConflict", "folderConflictRead":
            performFolderAction(action,id:id,request:request)
        case "externalToolList": reply(id, ExternalTools.shared.listing())
        case "aiCredential":
            guard let provider = AICredentials.validProvider(request["provider"]), let operation = request["operation"] as? String else {
                reply(id, error: "Invalid provider credential request."); return
            }
            do {
                if operation == "load" { reply(id, try AICredentials.load(provider) as Any? ?? NSNull()); return }
                if operation == "status" {
                    reply(id, ["available": true, "configured": try AICredentials.load(provider) != nil, "maxBytes": AICredentials.maxBytes])
                    return
                }
                guard operation == "configure" || operation == "forget" else { reply(id, error: "Invalid operation."); return }
                let alert = NSAlert()
                alert.messageText = operation == "configure" ? "Store a provider credential?" : "Remove a provider credential?"
                alert.informativeText = AICredentials.label(provider)
                alert.addButton(withTitle: operation == "configure" ? "Store in Keychain" : "Remove")
                alert.addButton(withTitle: "Cancel")
                let field = NSSecureTextField(frame: NSRect(x: 0, y: 0, width: 260, height: 24))
                if operation == "configure" { alert.accessoryView = field; alert.window.initialFirstResponder = field }
                alert.beginSheetModal(for: window) { response in
                    guard self.currentRequest(id) else { return }
                    guard response == .alertFirstButtonReturn else { self.reply(id, ["cancelled": true]); return }
                    do {
                        if operation == "configure" { try AICredentials.store(field.stringValue, provider) }
                        else { try AICredentials.forget(provider) }
                        self.reply(id, ["configured": operation == "configure"])
                    } catch { self.reply(id, error: error.localizedDescription) }
                }
            } catch { reply(id, error: error.localizedDescription) }
        case "externalToolProbe": reply(id, ExternalTools.shared.probe(request["paths"]))
        case "externalToolForget":
            do { try ExternalTools.shared.forget(request["toolId"] as? String ?? ""); reply(id, true) } catch { reply(id, error: error.localizedDescription) }
        case "externalToolChoose": chooseExternal(id, request)
        case "externalRun": runExternal(id, request["run"])
        case "lanStart":
            lan.start(room: request["room"] as? String ?? "", salt: request["salt"] as? String ?? "", name: request["name"] as? String ?? "") { result in
                DispatchQueue.main.async { switch result { case .success(let v): self.reply(id, v); case .failure(let e): self.reply(id, error: e.localizedDescription) } }
            }
        case "lanHost": reply(id, lan.setHost(request["host"] as? String))
        case "lanStop": reply(id, lan.stop())
        case "lanBrowse": LanRelay.browse { found in self.reply(id, ["sessions": found]) }
        case "crashHistory": reply(id, CrashHistory.listing())
        case "supportDiagnostics":
            reply(id, ["platform": "macos", "architecture": SupportDiagnostics.architecture,
                       "displayCount": SupportDiagnostics.displayCount(NSScreen.screens.count),
                       "rendererTerminations": CrashHistory.counts()])
        case "revealProject":
            // Projects panel › Reveal in Finder: only the file this window opened or saved, never a page-supplied path.
            guard let active = visibleFolder, request["grant"] as? String == active.grant else {
                reply(id, error: "Open the Waffle folder again to reveal it."); return
            }
            folderQueue.async {
                do { try self.folderService(grant: active.grant).confirmSelection() }
                catch { DispatchQueue.main.async { self.reply(id, error: error.localizedDescription) }; return }
                DispatchQueue.main.async {
                    guard self.currentRequest(id), self.visibleFolder?.grant == active.grant else {
                        self.reply(id, error: "The active Waffle project changed."); return
                    }
                    NSWorkspace.shared.activateFileViewerSelecting([active.manifest])
                    self.reply(id, true)
                }
            }
        case "writeSelection":
            guard let data = request["data"] as? String, data.utf8.count <= 16 * 1024 * 1024,
                  let summary = request["summary"] as? String, summary.count < 512 else {
                reply(id, error: "Invalid clipboard selection."); return
            }
            let item = NSPasteboardItem()
            item.setString(data, forType: NSPasteboard.PasteboardType("org.waffle.selection.v1"))
            // The typed text fallback survives clipboard sync and works across platforms.
            item.setString(summary + "\nWaffle-Selection/1\n" + data, forType: .string)
            NSPasteboard.general.clearContents()
            reply(id, NSPasteboard.general.writeObjects([item]))
        case "readSelection":
            let board = NSPasteboard.general
            let custom = NSPasteboard.PasteboardType("org.waffle.selection.v1")
            if let data = board.string(forType: custom), data.utf8.count <= 16 * 1024 * 1024 {
                reply(id, ["data":data])
            } else if let text = board.string(forType: .string), text.hasPrefix("Waffle "),
                      text.utf8.count <= 16 * 1024 * 1024 + 512, text.contains("\nWaffle-Selection/1\n") {
                reply(id, ["text":text])
            } else {
                let options: [NSPasteboard.ReadingOptionKey: Any] = [.urlReadingFileURLsOnly:true]
                let urls = (board.readObjects(forClasses:[NSURL.self],options:options) as? [URL] ?? [])
                    .filter(ProjectFileType.documentName)
                guard !urls.isEmpty else { reply(id, [:] as [String:String]); return }
                let grant = visibleFolder?.grant
                DispatchQueue.global(qos:.userInitiated).async {
                    let result = Result { try Self.copyDocumentRows(urls) }
                    DispatchQueue.main.async {
                        guard self.currentRequest(id) else { return }
                        switch result {
                        case .success(let files): self.reply(id,["files":self.copyDocumentPackets(files,grant:grant)])
                        case .failure(let error): self.reply(id,error:error.localizedDescription)
                        }
                    }
                }
            }
        case "nativeMemberCommit":
            guard let grant = request["grant"] as? String, let expected = request["expected"] as? String else {
                reply(id,error:"Choose a Waffle document before saving."); return
            }
            let data = request["data"] as? String, splice = request["splice"] as? [String:Any]
            folderQueue.async {
                let result = Result {
                    guard let member = self.nativeMembers[grant] else { throw FolderFailure("The selected document is no longer open.") }
                    return try member.commit(expected:expected,encoded:data,splice:splice)
                }
                DispatchQueue.main.async {
                    switch result {
                    case .success(let value): self.reply(id,value)
                    case .failure(let error): self.reply(id,error:error.localizedDescription)
                    }
                }
            }
        case "nativeMemberClose":
            guard let grant = request["grant"] as? String else { reply(id,false); return }
            folderQueue.async {
                self.nativeMembers.removeValue(forKey:grant)
                DispatchQueue.main.async { self.reply(id,true) }
            }
        case "nativeMemberExportCopy":
            exportNativeMemberCopy(id,request)
        case "gitHistory", "gitHead", "gitRevision": readGit(id: id, action: action, token: request["token"] as? String, revision: request["revision"] as? String)
        case "gitQuery":
            queryGit(id:id,token:request["token"] as? String,op:request["op"] as? String,args:request["args"],advisory:request["advisory"] as? Bool == true)
        case "open", "pick":
            let picking = action == "pick"
            let detached = !picking && request["into"] as? Bool == true
            if !picking && !detached && !incoming.isEmpty {
                let files = incoming
                incoming = []
                openDesignFiles(files, id: id)
                return
            }
            let chosen: Set<String>
            if picking {
                chosen = Set((request["extensions"] as? [String] ?? []).map { $0.trimmingCharacters(in: CharacterSet(charactersIn: ".")).lowercased() })
                if chosen.isEmpty || !chosen.isSubset(of: exchangeInputs) {
                    reply(id, error: "Unrecognised exchange file type."); return
                }
            } else {
                do { chosen = try translators.openTypes(request["extensions"]) }
                catch { reply(id, error: error.localizedDescription); return }
            }
            let fileTypes = chosen.sorted().compactMap { UTType(filenameExtension: $0) }
            guard !fileTypes.isEmpty else { reply(id, error: "The import formats could not be loaded."); return }
            let panel = NSOpenPanel()
            panel.allowedContentTypes = fileTypes
            panel.allowsMultipleSelection = !picking
            panel.canChooseDirectories = !picking && !detached
            // Library sources (.atrlib, .json) are remembered so they can be reloaded later.
            let library = picking && chosen.contains("atrlib") && chosen.isSubset(of: HostFiles.libraryTypes)
            panel.beginSheetModal(for: window) { response in
                guard self.currentRequest(id) else { return }
                if response == .OK {
                    if panel.urls.contains(where: { $0.pathExtension.lowercased() == "atrium" }) { self.reply(id,error:ProjectFileType.preReleaseMessage); return }
                    guard panel.urls.allSatisfy({ chosen.contains($0.pathExtension.lowercased()) || (!picking && !detached && panel.urls.count == 1 && Self.isFolder($0)) }) else {
                        self.reply(id, error: "Choose one of the requested document types."); return
                    }
                    if !picking && !detached { self.openDesignFiles(panel.urls, id: id) }
                    else { self.readFiles(panel.urls, id: id, picking: picking, library: library, detached: detached) }
                }
                else { self.reply(id, []) }
            }
        case "notebookPaste":
            let clipboard=NSPasteboard.general
            let flavors:[(String,NSPasteboard.PasteboardType)]=[("image/png",.png),("image/jpeg",NSPasteboard.PasteboardType("public.jpeg")),("image/heic",NSPasteboard.PasteboardType("public.heic")),("image/webp",NSPasteboard.PasteboardType("org.webmproject.webp")),("image/svg+xml",NSPasteboard.PasteboardType("public.svg-image")),("application/pdf",.pdf)]
            guard let (media,flavor)=flavors.first(where:{clipboard.types?.contains($0.1)==true}),let data=clipboard.data(forType:flavor),
                  !data.isEmpty,data.count<=128<<20 else {reply(id,error:"Copy an image or PDF first.");return}
            var args=request;args["origin"]="paste";args["mediaType"]=media;args["data"]=data.base64EncodedString()
            NotebookFolderMedia.run(action:"notebookTransfer",request:args,queue:folderQueue,resolve:{[weak self] grant in
                guard let self=self else {throw NotebookMedia.Failure("This project has closed.")}
                return try self.folderService(grant:grant)
            }) {[weak self] result in DispatchQueue.main.async {
                switch result {
                case .success(var out):out["name"]="Clipboard."+((media=="image/svg+xml") ? "svg":String(media.split(separator:"/").last ?? "png"));self?.reply(id,out)
                case .failure(let error):self?.reply(id,error:error.localizedDescription)
                }
            }}
        case "notebookTransfer", "notebookClip", "notebookDerivative":
            NotebookFolderMedia.run(action:action,request:request,queue:folderQueue,resolve:{[weak self] grant in
                guard let self = self else {throw NotebookMedia.Failure("This project has closed.")}
                return try self.folderService(grant:grant)
            }) {[weak self] result in DispatchQueue.main.async {
                switch result {case .success(let out):self?.reply(id,out);case .failure(let error):self?.reply(id,error:error.localizedDescription)}
            }}
        case "notebookMedia":
            NotebookMedia.queue.async { [weak self] in
                do {
                    let result = try NotebookMedia.perform(request)
                    DispatchQueue.main.async { self?.reply(id, result) }
                } catch {
                    let message = error.localizedDescription
                    DispatchQueue.main.async { self?.reply(id, error: message) }
                }
            }
        case "folderReadImportSource", "installProjectArchive", "folderConvertSibling":
            portableProject(id, action, request)
        case "exportBinaryCopy":
            guard let source = selectedSource, request["sourceToken"] as? String == source.token,
                  let name = request["name"] as? String, let encoded = request["data"] as? String else {
                reply(id, error: "Select the original Altium document again."); return
            }
            let filename = (name as NSString).lastPathComponent
            let ext = (filename as NSString).pathExtension.lowercased()
            guard sourceTypes.contains(ext), ext == source.url.pathExtension.lowercased(),
                  let contentType = UTType(filenameExtension: ext) else {
                reply(id, error: "Use the same document extension as the source."); return
            }
            let panel = NSSavePanel()
            panel.title = "Export Altium Copy"
            panel.allowedContentTypes = [contentType]
            panel.canCreateDirectories = true
            panel.nameFieldStringValue = filename
            panel.beginSheetModal(for: window) { response in
                guard self.currentRequest(id) else { return }
                guard response == .OK, let url = panel.url else { self.reply(id, false); return }
                DispatchQueue.global(qos: .userInitiated).async {
                    guard let bytes = Data(base64Encoded: encoded) else {
                        DispatchQueue.main.async { self.reply(id, error: "Invalid binary export data.") }
                        return
                    }
                    do {
                        try source.saveCopy(bytes, to: url)
                        DispatchQueue.main.async { self.reply(id, true) }
                    } catch {
                        DispatchQueue.main.async { self.reply(id, error: error.localizedDescription) }
                    }
                }
            }
        case "printPDF":
            guard let encoded = request["data"] as? String, let data = Data(base64Encoded: encoded), let pdf = PDFDocument(data: data), pdf.pageCount > 0 else {
                reply(id, error: "The print job could not be read."); return
            }
            let info = (NSPrintInfo.shared.copy() as? NSPrintInfo) ?? NSPrintInfo()
            let first = pdf.page(at: 0)!.bounds(for: .mediaBox)
            info.orientation = first.width > first.height ? .landscape : .portrait
            info.horizontalPagination = .fit; info.verticalPagination = .fit
            guard let operation = pdf.printOperation(for: info, scalingMode: .pageScaleToFit, autoRotate: true) else {
                reply(id, error: "Printing is unavailable."); return
            }
            operation.jobTitle = ((request["name"] as? NSString)?.deletingPathExtension) ?? "Waffle"
            operation.showsPrintPanel = true; operation.showsProgressPanel = true
            operation.runModal(for: window, delegate: nil, didRun: nil, contextInfo: nil)
            reply(id, true)
        case "export":
            let filename = (request["name"] as? NSString)?.lastPathComponent ?? "Project.waffle"
            let ext = (filename as NSString).pathExtension.lowercased()
            let valid = exchangeOutputs
            guard (valid.contains(ext) || filename == "waffle-diagnostics.json"), let contentType = UTType(filenameExtension:ext) else {
                reply(id,error:"Unrecognised save type."); return
            }
            let payload: Data
            if let text = request["text"] as? String { payload = Data(text.utf8) }
            else if let encoded = request["data"] as? String, let decoded = Data(base64Encoded: encoded) { payload = decoded }
            else { reply(id, error: "Project data is missing."); return }
            let panel = NSSavePanel()
            panel.allowedContentTypes = [contentType]
            panel.canCreateDirectories = true
            panel.nameFieldStringValue = filename
            panel.beginSheetModal(for: window) { response in
                guard self.currentRequest(id) else { return }
                guard response == .OK, let url = panel.url else { self.reply(id, false); return }
                guard url.pathExtension.lowercased() == ext else {
                    self.reply(id, error: "Choose a filename ending in ." + ext + ".")
                    return
                }
                do {
                    try payload.write(to: url, options: .atomic)
                    self.reply(id, true)
                } catch { self.reply(id, error: error.localizedDescription) }
            }
        case "collabLocks", "collabLockWrite", "collabLockRemove":
            guard let active = visibleFolder, request["grant"] as? String == active.grant else {
                reply(id, error: "The active Waffle project changed."); return
            }
            performCollaboration(action, id: id, grant: active.grant, project: active.manifest, request: request)
        case "recentFiles":
            reply(id, recent.listing(checkAvailability: request["metadataOnly"] as? Bool != true))
        case "linkRecentProjects":
            guard let projectId = request["projectId"] as? String, Self.recordIdentity(projectId) else {
                reply(id,error:"Choose a valid Waffle project identity."); return
            }
            let candidates = recent.listing().filter { ($0["path"] as? String)?.lowercased().hasSuffix(".waffle") == true }
            folderQueue.async {
                let matches = candidates.filter { entry in
                    guard let path = entry["path"] as? String else { return false }
                    return (try? FolderTransactions.manifestIdentity(URL(fileURLWithPath:path))) == projectId
                }
                DispatchQueue.main.async { if self.currentRequest(id) { self.reply(id,matches) } }
            }
        case "openRecent":
            do {
                let paths = [try recent.allowed(request["path"])]
                if request["activate"] as? Bool == true { openDesignFiles(paths, id: id) }
                else { readFiles(paths, id: id) }
            }
            catch { reply(id, error: error.localizedDescription) }
        case "chooseLibraryFolder":
            guard let purpose = request["purpose"] as? String, LibraryFolders.purposes.contains(purpose) else {
                reply(id, error: "Invalid library folder request."); return
            }
            let panel = NSOpenPanel()
            panel.canChooseDirectories = true; panel.canChooseFiles = false
            panel.prompt = purpose == "write" ? "Save here" : "Choose"
            panel.message = purpose == "models" ? "Choose the KiCad 3D model folder." : "Choose a library folder."
            panel.beginSheetModal(for: window) { response in
                guard self.currentRequest(id) else { return }
                guard response == .OK, let url = panel.url else { self.reply(id); return }
                LibraryFolders.queue.async {
                    do {
                        let value = try LibraryFolders.remember(url, purpose: purpose)
                        DispatchQueue.main.async { self.reply(id, value) }
                    } catch { DispatchQueue.main.async { self.reply(id, error: error.localizedDescription) } }
                }
            }
        case "libraryFolderList", "libraryFolderRead", "libraryFolderWrite", "forgetLibraryFolder":
            let grant = request["grant"], paths = request["paths"], path = request["path"], text = request["text"]
            LibraryFolders.queue.async {
                do {
                    let value: Any
                    switch action {
                    case "libraryFolderList": value = try LibraryFolders.list(grant)
                    case "libraryFolderRead": value = try LibraryFolders.read(grant, paths)
                    case "libraryFolderWrite": try LibraryFolders.write(grant, path, text); value = true
                    default: LibraryFolders.forget(grant); value = true
                    }
                    DispatchQueue.main.async { self.reply(id, value) }
                } catch { DispatchQueue.main.async { self.reply(id, error: error.localizedDescription) } }
            }
        case "openKiCadLicence":
            reply(id, NSWorkspace.shared.open(URL(string: "https://www.kicad.org/libraries/license/")!))
        case "openURL":
            // An external link the user followed (shell.js): http(s) only, never credentials or files.
            guard let text = request["url"] as? String, text.count <= 2048, let url = URL(string: text),
                  ["http", "https"].contains(url.scheme?.lowercased() ?? ""), url.host?.isEmpty == false,
                  url.user == nil, url.password == nil else { reply(id, error: "Enter an HTTP or HTTPS URL."); return }
            reply(id, NSWorkspace.shared.open(url))
        case "readFile":
            let path = request["path"]
            DispatchQueue.global(qos: .userInitiated).async {
                do {
                    let file = try self.libraryReads.read(path)
                    DispatchQueue.main.async { self.reply(id, file) }
                } catch {
                    DispatchQueue.main.async { self.reply(id, error: error.localizedDescription) }
                }
            }
        default:
            reply(id, error: "Unknown file action.")
        }
    }

    // run:external (ExternalTools.swift): the user picks the program or confirms a detected path, and
    // approves it per extension version before its first run (any undeclared argument asks again).
    private func chooseExternal(_ id: Int, _ request: [String: Any]) {
        let tool = request["toolId"] as? String ?? "", name = String((request["name"] as? String ?? "").prefix(80))
        let label = name.isEmpty ? tool : name
        let store = { (path: String) in
            do { self.reply(id, try ExternalTools.shared.choose(tool, name: name, path: path)) } catch { self.reply(id, error: error.localizedDescription) }
        }
        guard ExternalTools.matches(ExternalTools.toolPattern, tool) else { reply(id, error: "Invalid external tool."); return }
        if let path = request["path"] as? String {
            guard ExternalTools.executable(path) != nil else { reply(id, error: "That program was not found."); return }
            let alert = NSAlert()
            alert.messageText = "Use this program for " + label + "?"
            alert.informativeText = path
            alert.addButton(withTitle: "Use")
            alert.addButton(withTitle: "Cancel")
            alert.beginSheetModal(for: window) { $0 == .alertFirstButtonReturn ? store(path) : self.reply(id) }
            return
        }
        let panel = NSOpenPanel()
        panel.message = "Choose the " + label + " program"
        panel.canChooseFiles = true
        panel.canChooseDirectories = false
        panel.treatsFilePackagesAsDirectories = false
        panel.allowsMultipleSelection = false
        panel.beginSheetModal(for: window) { response in
            if response == .OK, let url = panel.url { store(url.path) } else { self.reply(id) }
        }
    }

    private func runExternal(_ id: Int, _ value: Any?) {
        let req: ExternalTools.Run
        do { req = try ExternalTools.check(value) } catch { reply(id, error: error.localizedDescription); return }
        guard let configured = ExternalTools.shared.tool(req.tool)?["path"] else {
            reply(id, error: req.toolName + " is not set up. Choose it in Preferences \u{203A} External Tools."); return
        }
        let path = ExternalTools.resolved(configured)
        guard ExternalTools.executable(path) != nil else {
            reply(id, error: req.toolName + " was not found at " + path + ". Choose it again in Preferences \u{203A} External Tools."); return
        }
        let ticket: String
        do { ticket = try ExternalTools.shared.reserve(req) } catch { reply(id, error: error.localizedDescription); return }
        let start = {
            ExternalTools.shared.run(path, req, reservation: ticket) { result in
                DispatchQueue.main.async {
                    switch result {
                    case .success(let value): self.reply(id, value)
                    case .failure(let error): self.reply(id, error: error.localizedDescription)
                    }
                }
            }
        }
        // Approval per extension version (id@sha256), tool and resolved program, within the extension's
        // declared argument template; any other argument asks for the exact command (ExternalTools.swift).
        guard let need = ExternalTools.shared.approvalNeeded(req, path) else { start(); return }
        let alert = NSAlert()
        alert.messageText = need.title
        alert.informativeText = need.detail
        alert.addButton(withTitle: "Allow")
        alert.addButton(withTitle: "Deny")
        alert.beginSheetModal(for: window) { response in
            if ExternalTools.shared.isCancelled(ticket) {
                ExternalTools.shared.release(ticket); self.reply(id, ["cancelled": true]); return
            }
            guard response == .alertFirstButtonReturn else { ExternalTools.shared.release(ticket); self.reply(id, ["denied": true]); return }
            ExternalTools.shared.recordApproval(req, need)
            start()
        }
    }

    func webView(_ webView: WKWebView, runJavaScriptConfirmPanelWithMessage message: String,
                 initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping (Bool) -> Void) {
        let alert = NSAlert()
        alert.messageText = message
        alert.addButton(withTitle: "Continue")
        alert.addButton(withTitle: "Cancel")
        alert.beginSheetModal(for: window) { completionHandler($0 == .alertFirstButtonReturn) }
    }

    func webView(_ webView: WKWebView, runJavaScriptTextInputPanelWithPrompt prompt: String, defaultText: String?,
                 initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping (String?) -> Void) {
        let alert = NSAlert()
        alert.messageText = prompt
        let input = NSTextField(frame: NSRect(x: 0, y: 0, width: 280, height: 24))
        input.stringValue = defaultText ?? ""
        alert.accessoryView = input
        alert.addButton(withTitle: "OK")
        alert.addButton(withTitle: "Cancel")
        alert.window.initialFirstResponder = input
        alert.beginSheetModal(for: window) { completionHandler($0 == .alertFirstButtonReturn ? input.stringValue : nil) }
    }

    func webView(_ webView: WKWebView, runOpenPanelWith parameters: WKOpenPanelParameters,
                 initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping ([URL]?) -> Void) {
        let panel = NSOpenPanel()
        panel.allowsMultipleSelection = parameters.allowsMultipleSelection
        panel.canChooseDirectories = parameters.allowsDirectories
        panel.beginSheetModal(for: window) { response in completionHandler(response == .OK ? panel.urls : nil) }
    }
}

if CommandLine.arguments.count == 3, CommandLine.arguments[1] == "--folder-mcp" {
    exit(runFolderMCP(CommandLine.arguments[2]))
}

let application = NSApplication.shared
let delegate = Desktop()
application.delegate = delegate
application.setActivationPolicy(.regular)
application.run()
