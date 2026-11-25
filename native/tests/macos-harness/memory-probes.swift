import Cocoa
import WebKit

// Drive the shipped editor in a private WKWebView session and record its allocation timeline.
@MainActor final class NativeMemorySoak {
    let h: Harness
    let epoch = ProcessInfo.processInfo.systemUptime
    let formatter = ISO8601DateFormatter()
    lazy var energy = EnergyProbes(h)
    private var sampleWebProcess: Int32 = 0
    private var inspectorView: WKWebView?

    private func inspectorJS(_ js: String) async -> Any? {
        guard let inspectorView else { return nil }
        return await withCheckedContinuation { continuation in
            inspectorView.callAsyncJavaScript(js, arguments: [:], in: nil, in: .page) { result in
                switch result {
                case .success(let output): continuation.resume(returning: output)
                case .failure(let error): continuation.resume(returning: "INSPECTOR ERROR: \(error)")
                }
            }
        }
    }

    // The test harness connects to the local Inspector frontend to use its Memory and Heap domains.
    private func startInspector(_ path: String) async -> Bool {
        let prefs = h.d.web.configuration.preferences
        let developer = NSSelectorFromString("_setDeveloperExtrasEnabled:")
        let inspectorName = NSSelectorFromString("_inspector")
        guard prefs.responds(to: developer), h.d.web.responds(to: inspectorName) else {
            h.log(false, "WebKit Inspector SPI is absent")
            return false
        }
        typealias SetBool = @convention(c) (AnyObject, Selector, Bool) -> Void
        unsafeBitCast(prefs.method(for: developer), to: SetBool.self)(prefs, developer, true)
        guard let inspector = h.d.web.perform(inspectorName)?.takeUnretainedValue() as? NSObject,
              inspector.responds(to: NSSelectorFromString("connect")) else {
            h.log(false, "local WebKit Inspector cannot connect")
            return false
        }
        _ = inspector.perform(NSSelectorFromString("connect"))
        let view = NSSelectorFromString("inspectorWebView")
        let until = elapsed + 8
        var ready = false
        while elapsed < until && !ready {
            if inspector.responds(to: view) {
                self.inspectorView = inspector.perform(view)?.takeUnretainedValue() as? WKWebView
            }
            ready = (await inspectorJS("return typeof WI === 'object' && !!WI.mainTarget && !!WI.heapManager") as? Bool) == true
            if !ready { await h.pause(0.25) }
        }
        guard ready, let script = try? String(contentsOfFile: path, encoding: .utf8) else {
            h.log(false, "Inspector frontend timed out or instrumentation is missing")
            return false
        }
        let response = await inspectorJS(script)
        guard let row = response as? [String: Any] else {
            h.log(false, "start Inspector memory tracking", response)
            return false
        }
        emit("inspector-start", row)
        let calls = row["calls"] as? [String: String]
        let tracking = row["heap"] as? Bool == true && row["memory"] as? Bool == true &&
            calls?["Memory.startTracking"] == "ok"
        h.log(tracking, "Inspector Heap and Memory domains ready", tracking ? nil : row)
        return tracking
    }

    private func inspectorSample() async {
        if let row = await inspectorJS("return globalThis.__nativeMemoryInspector?.read() ?? null") as? [String: Any] {
            emit("inspector", row)
        }
    }

    init(_ h: Harness) {
        self.h = h
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
    }
    var elapsed: Double { ProcessInfo.processInfo.systemUptime - epoch }

    private func emit(_ event: String, _ fields: [String: Any] = [:]) {
        var row = fields
        row["event"] = event
        row["elapsedSec"] = elapsed
        row["utc"] = formatter.string(from: Date())
        guard let data = try? JSONSerialization.data(withJSONObject: row, options: [.sortedKeys]),
              let line = String(data: data, encoding: .utf8) else {
            h.log(false, "serialize \(event)"); return
        }
        print("MEMORY " + line)
        fflush(stdout)
    }

    private func osSample() {
        var results: [String: Any] = [:]
        for (name, pid) in energy.pids() {
            var r = rusage_info_v6()
            let rc = withUnsafeMutablePointer(to: &r) {
                $0.withMemoryRebound(to: rusage_info_t?.self, capacity: 1) { proc_pid_rusage(pid, RUSAGE_INFO_V6, $0) }
            }
            var row: [String: Any] = ["pid": pid]
            if rc == 0 {
                row["rssBytes"] = r.ri_resident_size
                row["physicalFootprintBytes"] = r.ri_phys_footprint
                row["lifetimePeakPhysicalFootprintBytes"] = r.ri_lifetime_max_phys_footprint
                row["pageIns"] = r.ri_pageins
            } else {
                row["error"] = Int(errno)
            }
            results[name] = row
            if name == "web" && sampleWebProcess == 0 {
                sampleWebProcess = pid
            } else if name == "web" && sampleWebProcess != pid {
                h.log(false, "WebContent PID changed during the session", pid)
            }
        }
        let window = h.d.window!
        emit("processes", ["processes": results, "active": NSApp.isActive,
                           "windowVisible": window.isVisible, "windowOccluded": !window.occlusionState.contains(.visible)])
    }

    private func check(_ body: String, _ args: [String: Any] = [:]) async -> [String: Any]? {
        let result = await h.js(body, args)
        guard let row = result as? [String: Any] else {
            h.log(false, "native memory workload step", result); return nil
        }
        return row
    }

    private func recordLoadedSources(_ phase: String) async {
        let site = """
            const directory = new URL(".", document.baseURI).pathname;
            const file = value => {
                const pathname = new URL(value, document.baseURI).pathname;
                return pathname.startsWith(directory) ? pathname.slice(directory.length) : pathname.split("/").pop();
            };
            const scriptTags = [...document.scripts].filter(script => script.src).map(script => file(script.src));
            const resources = [...new Set(performance.getEntriesByType("resource")
                .filter(entry => /[.](?:js|mjs|css|wasm)(?:[?]|$)/.test(entry.name))
                .map(entry => file(entry.name)))];
            return {scripts: scriptTags, resourceTiming: resources, totalResourceTimingEntries: performance.getEntriesByType("resource").length};
            """
        if var loaded = await check(site) {
            loaded["phase"] = phase
            emit("source-loads", loaded)
        }
    }

    func run() async {
        let env = ProcessInfo.processInfo.environment
        let files = (env["HARNESS_PROBES"] ?? "").split(separator: ":")
        guard files.count == 2, let inspector = env["HARNESS_MEMORY_INSPECTOR_SCRIPT"] else {
            h.log(false, "configure the fixture, workload and Inspector probe with memory.sh")
            return
        }
        let duration = Double(env["HARNESS_MEMORY_SECONDS"] ?? "3605")
        let settling = Double(env["HARNESS_MEMORY_IDLE_SECONDS"] ?? "300")
        guard let duration, let settling, (1...3605).contains(duration), (0...300).contains(settling) else {
            h.log(false, "invalid memory probe durations")
            return
        }
        let cadence = 30.0
        let occlusion = UIProbes(h)
        occlusion.setOcclusionDetection(false)
        h.d.window.orderOut(nil)
        h.d.window.orderFrontRegardless()
        NotificationCenter.default.post(name: NSWindow.didChangeOcclusionStateNotification, object: h.d.window)
        h.d.web.viewDidUnhide()
        _ = await h.js("globalThis.AtriumPower?.host({occluded: false}); return true")
        let webKit = Bundle(for: WKWebView.self)
        if #available(macOS 13.3, *) { h.d.web.isInspectable = true }
        emit("metadata", ["revision": env["HARNESS_MEMORY_REV"] ?? "unknown", "durationSec": duration, "editCadenceSec": cadence,
                          "idleSec": settling, "macOS": ProcessInfo.processInfo.operatingSystemVersionString,
                          "webKit": webKit.infoDictionary?["CFBundleVersion"] ?? "?",
                          "inspectable": true, "windowOcclusionOverride": true])
        let input: String
        do { input = try files.map { try String(contentsOfFile: String($0), encoding: .utf8) }.joined(separator: "\n;\n") }
        catch { h.log(false, "read native memory workload", error); return }
        guard let info = await check(input + "\nreturn await __nativeMemory.setup();") else { return }
        emit("fixture", info)
        await recordLoadedSources("before edit window")
        guard await startInspector(inspector) else { return }
        let start = elapsed
        let wallStart = Date()
        emit("start", ["startSec": start])
        let observer = Task { @MainActor in
            var tick = 0.0
            while !Task.isCancelled {
                let delay = start + tick - elapsed
                if delay > 0 { await h.pause(delay) }
                if Task.isCancelled { break }
                osSample()
                await inspectorSample()
                tick += 10
                if start + tick < elapsed { tick = (floor((elapsed - start) / 10) + 1) * 10 }
            }
        }
        defer { observer.cancel() }
        var round = 0
        var lastStarted: Double?
        while Double(round) * cadence <= duration {
            let delay = start + Double(round) * cadence - elapsed
            if delay > 0 { await h.pause(delay) }
            let roundStarted = elapsed
            if let lastStarted, roundStarted - lastStarted > cadence * 1.5 {
                h.log(false, "continuity gap between edit rounds", roundStarted - lastStarted)
                return
            }
            lastStarted = roundStarted
            guard var row = await check("AtriumPower.host({occluded: false}); return await __nativeMemory.round(round);", ["round": round]) else { return }
            row["round"] = round
            row["startedSec"] = roundStarted
            row["roundSec"] = elapsed - roundStarted
            emit("round", row)
            round += 1
        }
        let ensureDuration = start + duration - elapsed
        if ensureDuration > 0 { await h.pause(ensureDuration) }
        let editsEnd = elapsed
        emit("edits-complete", ["rounds": round, "activeSeconds": editsEnd - start,
                               "wallSeconds": Date().timeIntervalSince(wallStart),
                               "firstToLastStartSeconds": (lastStarted ?? start) - start])
        guard let activeEndState = await check("return __nativeMemory.sample();") else { return }
        emit("active-complete-state", activeEndState)
        osSample()
        for offset in [10.0, 30.0, 60.0, 120.0].filter({ $0 < settling }) + [settling] {
            let delay = editsEnd + offset - elapsed
            if delay > 0 { await h.pause(delay) }
            guard var row = await check("return __nativeMemory.sample();") else { return }
            row["idleSec"] = elapsed - editsEnd
            emit("idle", row)
        }
        await h.pause(max(0, editsEnd + settling - elapsed))
        osSample()
        await inspectorSample()
        emit("complete", ["activeSeconds": editsEnd - start, "idleSeconds": elapsed - editsEnd])
        await recordLoadedSources("after idle settling")
        _ = await h.js("globalThis.AtriumHost?.setDirty?.(false); return true")
        h.d.window.isDocumentEdited = false
    }
}
