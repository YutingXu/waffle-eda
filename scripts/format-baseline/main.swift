import Cocoa
import WebKit

// This test executable links the production Desktop and ProjectWrites. Its handler opens one
// scratch project, observes a presentation and checks Save. The optional 3D driver targets its own view.
private final class PeakRSS {
    let queue = DispatchQueue(label: "org.waffle.format-benchmark.rss")
    var peak: UInt64 = 0, samples = 0
    var timer: DispatchSourceTimer?
    let ids: [Int32]

    init(web: WKWebView) throws {
        let selector = NSSelectorFromString("_webProcessIdentifier")
        guard web.responds(to: selector) else { throw Failure("Cannot identify WebContent") }
        typealias GetPid = @convention(c) (AnyObject, Selector) -> Int32
        let webPID = unsafeBitCast(web.method(for: selector), to: GetPid.self)(web, selector)
        guard webPID > 0 && webPID != getpid() else { throw Failure("No separate WebContent process") }
        ids = [getpid(), webPID]
    }

    func sample() {
        var total: UInt64 = 0
        for id in ids {
            var usage = rusage_info_v4()
            let rc = withUnsafeMutablePointer(to: &usage) { pointer in
                pointer.withMemoryRebound(to: rusage_info_t?.self, capacity: 1) { proc_pid_rusage(id, RUSAGE_INFO_V4, $0) }
            }
            guard rc == 0 else { return }
            total += usage.ri_resident_size
        }
        peak = max(peak, total)
        samples += 1
    }

    func start() {
        queue.sync { sample() }
        let source = DispatchSource.makeTimerSource(queue: queue)
        source.schedule(deadline: .now(), repeating: .milliseconds(5), leeway: .milliseconds(1))
        source.setEventHandler { [weak self] in self?.sample() }
        timer = source
        source.resume()
    }

    func finish() -> [String: Any] {
        timer?.cancel()
        return snapshot()
    }

    func snapshot() -> [String: Any] {
        return queue.sync {
            sample()
            return ["peakRSSBytes": peak, "samples": samples]
        }
    }
}

#if FORMAT2_QA
private let trialDirectoryURL: URL = {
    let args = CommandLine.arguments
    let location = ProcessInfo.processInfo.environment["WAFFLE_FORMAT_TRIAL"] ?? (args.count > 1 ? args[1] : "")
    precondition(!location.isEmpty)
    return URL(fileURLWithPath: location, isDirectory: true)
}()
#endif

private struct Failure: LocalizedError {
    let errorDescription: String?
    init(_ text: String) { errorDescription = text }
}

@MainActor private final class Probe: NSObject, WKScriptMessageHandlerWithReply {
    let desktop: Desktop
    #if FORMAT2_QA
    let dir = trialDirectoryURL
    #else
    let dir = URL(fileURLWithPath: CommandLine.arguments[1], isDirectory: true)
    #endif
    var project: URL {
        #if FORMAT2_QA
        return dir.appendingPathComponent("design").appendingPathComponent(Format2Audit.manifest)
        #elseif VIEW3D_INPUT
        if let manifest = viewerManifest { return dir.appendingPathComponent("design").appendingPathComponent(manifest) }
        return dir.appendingPathComponent("project.waffle")
        #else
        return dir.appendingPathComponent("project.waffle")
        #endif
    }
    #if VIEW3D_INPUT
    var viewerManifest: String?
    var viewerForeignFiles: [URL] = []
    #endif
    var peak: PeakRSS?
    #if FORMAT2_QA
    var editPeak: PeakRSS?
    #endif
    init(_ desktop: Desktop) { self.desktop = desktop }

    func js(_ source: String, _ args: [String: Any] = [:]) async throws -> Any? {
        try await withCheckedThrowingContinuation { continuation in
            desktop.web.callAsyncJavaScript(source, arguments: args, in: nil, in: .page) { result in
                switch result {
                case .success(let value): continuation.resume(returning: value)
                case .failure(let error): continuation.resume(throwing: error)
                }
            }
        }
    }

    func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage,
                               replyHandler: @escaping @MainActor @Sendable (Any?, String?) -> Void) {
        do {
            let args = message.body as? [String: Any] ?? [:]
            if ProcessInfo.processInfo.environment["WAFFLE_FORMAT_TRACE"] == "1" { fputs("event \(args["op"] ?? "?")\n", stderr) }
            switch args["op"] as? String {
            case "open":
                #if FORMAT2_QA
                Format2Audit.reset()
                #endif
                peak = try PeakRSS(web: desktop.web)
                peak?.start()
                #if VIEW3D_INPUT
                let files = viewerForeignFiles.isEmpty ? [project.path] : viewerForeignFiles.map(\.path)
                desktop.application(NSApp, openFiles: files)
                #else
                desktop.application(NSApp, openFiles: [project.path])
                #endif
                replyHandler(true, nil)
            #if VIEW3D_INPUT
            case "input", "gpu", "key":
                Task { @MainActor in
                    do { replyHandler(try await ViewerInput.handle(args, web: desktop.web, window: desktop.window), nil) }
                    catch { replyHandler(nil, error.localizedDescription) }
                }
            #endif
            case "present":
                let selector = NSSelectorFromString("_doAfterNextPresentationUpdate:")
                let web = desktop.web!
                guard web.responds(to: selector) else { throw Failure("No WebKit presentation acknowledgement") }
                let done: @convention(block) () -> Void = {
                    #if FORMAT2_QA
                    let reads = Format2Audit.frontier()
                    let memory = self.peak?.snapshot() ?? [:]
                    replyHandler(["reads": reads, "physical": Format2Audit.physicalFrontier(), "memory": memory], nil)
                    #else
                    replyHandler(true, nil)
                    #endif
                }
                _ = web.perform(selector, with: done)
            #if FORMAT2_QA
            case "formatClock":
                replyHandler(Double(DispatchTime.now().uptimeNanoseconds)/1_000_000, nil)
            case "formatSaveKey":
                let web = desktop.web!
                let window = desktop.window!
                guard web.window === window,
                      let down = NSEvent.keyEvent(with: .keyDown, location: .zero,
                        modifierFlags: .command, timestamp: ProcessInfo.processInfo.systemUptime,
                        windowNumber: window.windowNumber, context: nil, characters: "s",
                        charactersIgnoringModifiers: "s", isARepeat: false, keyCode: 1)
                else { throw Failure("Cannot create the native Command-S event") }
                let started = Double(DispatchTime.now().uptimeNanoseconds)/1_000_000
                if args["delivery"] as? String == "menu" {
                    guard let menu = NSApp.mainMenu,
                          let save = menu.items.compactMap(\.submenu).flatMap(\.items).first(where: {
                              $0.representedObject as? String == "save"
                          }), save.keyEquivalent == "s", save.keyEquivalentModifierMask == .command,
                          menu.performKeyEquivalent(with: down)
                    else { throw Failure("AppKit did not handle the native File menu's Command-S equivalent") }
                } else {
                    web.keyDown(with: down)
                    if let up = NSEvent.keyEvent(with: .keyUp, location: .zero, modifierFlags: .command,
                        timestamp: ProcessInfo.processInfo.systemUptime, windowNumber: window.windowNumber, context: nil,
                        characters: "s", charactersIgnoringModifiers: "s", isARepeat: false, keyCode: 1) {
                        web.keyUp(with: up)
                    }
                }
                replyHandler(started, nil)
            case "formatArm":
                Format2Audit.arm("after-stage-flush:0")
                replyHandler(true, nil)
            case "formatWait":
                DispatchQueue.global(qos: .userInitiated).async {
                    let answer = Format2Audit.reached()
                    DispatchQueue.main.async { replyHandler(answer, nil) }
                }
            case "formatResume":
                Format2Audit.resume(); replyHandler(true, nil)
            case "formatIdleRSS":
                let sampler = try PeakRSS(web: desktop.web)
                replyHandler(sampler.snapshot()["peakRSSBytes"], nil)
            case "formatBeginSaveRSS":
                let sampler = try PeakRSS(web: desktop.web)
                editPeak = sampler
                let baseline = sampler.snapshot()
                sampler.start()
                replyHandler(baseline["peakRSSBytes"], nil)
            case "formatEndSaveRSS":
                guard let sampler = editPeak else { throw Failure("Save memory sampling did not start") }
                editPeak = nil
                replyHandler(sampler.finish(), nil)
            case "formatReadCounts":
                replyHandler(Format2Audit.frontier(), nil)
            case "formatSaveOps":
                replyHandler(Format2Audit.receipt(), nil)
            case "formatObserve":
                // All measured clocks have stopped before Python inspects/commits the applied bytes.
                var record = ["checkpoint": args["checkpoint"] ?? ""]
                if let observation = args["observation"] as? [String:Any] { record["observation"] = observation }
                let note = try JSONSerialization.data(withJSONObject: record)
                FileHandle.standardOutput.write(note + Data([10]))
                DispatchQueue.global(qos: .userInitiated).async {
                    let acknowledged = readLine() == "continue"
                    DispatchQueue.main.async { replyHandler(acknowledged, acknowledged ? nil : "The physical save observer stopped") }
                }
            case "formatWindow":
                Format2Audit.forceVisible = args["visible"] as? Bool == true
                if Format2Audit.forceVisible { desktop.window.orderFrontRegardless() }
                else { desktop.window.orderOut(nil) }
                desktop.pushPower(force:true)
                replyHandler(true, nil)
            #endif
            case "finishOpen":
                guard let sampler = peak else { throw Failure("Open memory timer was absent") }
                replyHandler(sampler.finish(), nil)
                peak = nil
            case "verify":
                let data = try Data(contentsOf: project)
                let diskHash = ProjectWrites.hex(ProjectWrites.digest(data))
                guard let expected = args["expected"] as? String, diskHash == expected else {
                    throw Failure("The saved file differs from the expected on-disk checksum")
                }
                replyHandler(["journalBytes":0], nil)
            default: throw Failure("Unknown benchmark operation")
            }
        } catch { replyHandler(nil, error.localizedDescription) }
    }

    func run() async {
        do {
            // The hidden test window still participates in the WebKit rendering loop, just as in the UI harness.
            let web = desktop.web!, occlusion = NSSelectorFromString("_setWindowOcclusionDetectionEnabled:")
            guard web.responds(to: occlusion) else { throw Failure("No offscreen rendering switch") }
            typealias SetBool = @convention(c) (AnyObject, Selector, Bool) -> Void
            unsafeBitCast(web.method(for: occlusion), to: SetBool.self)(web, occlusion, false)
            desktop.window.orderOut(nil)
            try await Task.sleep(nanoseconds: 100_000_000)
            desktop.window.orderFrontRegardless()
            desktop.window.makeFirstResponder(web)
            try await Task.sleep(nanoseconds: 160_000_000)
            web.configuration.userContentController.addScriptMessageHandler(self, contentWorld: .page, name: "formatBenchmark")
            for _ in 0..<800 {
                if (try? await js("return document.readyState === 'complete' && !!globalThis.AtriumNavHost")) as? Bool == true { break }
                try await Task.sleep(nanoseconds: 25_000_000)
            }
            let input = try JSONSerialization.jsonObject(with: Data(contentsOf: dir.appendingPathComponent("trial.json")))
            #if FORMAT2_QA
            guard let options = input as? [String:Any], let name = options["manifest"] as? String,
                  name == (name as NSString).lastPathComponent else { throw Failure("Invalid trial manifest") }
            Format2Audit.manifest = name
            #elseif VIEW3D_INPUT
            if let options = input as? [String: Any] {
                if let manifest = options["manifest"] as? String {
                    guard !manifest.isEmpty, manifest.hasSuffix(".waffle"),
                          manifest == (manifest as NSString).lastPathComponent else { throw Failure("Invalid viewer manifest") }
                    viewerManifest = manifest
                }
                if let files = options["foreignFiles"] as? [String], !files.isEmpty {
                    guard files.count <= 32, files.allSatisfy({ !$0.isEmpty && $0 == ($0 as NSString).lastPathComponent }) else {
                        throw Failure("Invalid source file selection")
                    }
                    let source = dir.appendingPathComponent("foreign")
                    viewerForeignFiles = files.map { source.appendingPathComponent($0) }
                }
                try ViewerInput.position(window: desktop.window, requested: options["displayID"] as? UInt32,
                                         foreground: options["foreground"] as? Bool == true)
            }
            #endif
            let resources = Bundle.main.resourceURL!
            let edits = try String(contentsOf: resources.appendingPathComponent("edits.js"))
            let probe = edits + "\n" + (try String(contentsOf: resources.appendingPathComponent("probe.js")))
            if ProcessInfo.processInfo.environment["WAFFLE_FORMAT_TRACE"] == "1" { fputs("editor ready\n", stderr) }
            guard let result = try await js(probe, ["trial": input]) as? [String: Any] else { throw Failure("No numeric result") }
            let output = try JSONSerialization.data(withJSONObject: result, options: [.sortedKeys])
            print(String(decoding: output, as: UTF8.self))
            fflush(stdout)
            exit(0)
        } catch {
            // The error report never records source names, paths, objects or tracebacks for an approved input.
            if ProcessInfo.processInfo.environment["WAFFLE_FORMAT_PRIVATE"] == "1" {
                fputs("Native measurement failed\n", stderr)
            } else {
                let message = (error as NSError).userInfo["WKJavaScriptExceptionMessage"] as? String ?? error.localizedDescription
                fputs("view attached \(desktop.web.window === desktop.window), viewRect \(desktop.web.visibleRect), hidden \(desktop.web.isHiddenOrHasHiddenAncestor)\n", stderr)
                fputs("Native measurement failed: \(message), ordered \(desktop.window.isVisible), appHidden \(NSApp.isHidden), windowRect \(desktop.window.frame), occlusion \(desktop.window.occlusionState.rawValue)\n", stderr)
            }
            exit(1)
        }
    }
}

let application = NSApplication.shared
#if VIEW3D_INPUT
// The measured viewer uses the normal persistent WebKit store. Each cold process must
// start before any earlier disposable trial's IndexedDB recovery prompt can be restored.
if ProcessInfo.processInfo.environment["WAFFLE_VIEW3D_STORE"] == "default" {
    precondition(Bundle.main.bundleIdentifier == "org.waffle.viewer-benchmark")
    var cleared = false
    WKWebsiteDataStore.default().removeData(ofTypes: WKWebsiteDataStore.allWebsiteDataTypes(), modifiedSince: .distantPast) { cleared = true }
    let limit = Date().addingTimeInterval(15)
    while !cleared && Date() < limit { RunLoop.current.run(until: Date().addingTimeInterval(0.02)) }
    guard cleared else { fputs("Cannot clear the benchmark app's isolated WebKit profile\n", stderr); exit(1) }
}
#endif
#if FORMAT2_QA
if #available(macOS 14.0,*), let token = ProcessInfo.processInfo.environment["WAFFLE_FORMAT_REMOVE_DRAFT_PROFILE"],
   let id = UUID(uuidString:token) {
    let config = WKWebViewConfiguration()
    config.websiteDataStore = .nonPersistent()
    let bootstrap = WKWebView(frame:.zero,configuration:config)
    var removed: Bool?
    WKWebsiteDataStore.remove(forIdentifier:id) { error in removed = error == nil }
    let end = Date().addingTimeInterval(12)
    withExtendedLifetime(bootstrap) {
        while removed == nil && Date() < end { RunLoop.main.run(until:Date().addingTimeInterval(0.02)) }
    }
    exit(removed == true ? 0 : 1)
}
#endif
let desktop = Desktop()
#if FORMAT2_QA
HostFiles.supportDirectory = trialDirectoryURL.appendingPathComponent("support")
#else
HostFiles.supportDirectory = URL(fileURLWithPath: CommandLine.arguments[1], isDirectory: true).appendingPathComponent("support")
#endif
application.delegate = desktop
application.setActivationPolicy(.accessory)
DispatchQueue.main.asyncAfter(deadline: .now() + 0.3) { Task { @MainActor in await Probe(desktop).run() } }
application.run()
