import Cocoa
import WebKit
import IOKit.ps

// Energy probes (energy.sh, through the UIProbes "measure", "window" and "power" ops): per-process
// CPU time, idle and interrupt wakeups and energy (proc_pid_rusage, which needs no privileges for
// the user's own processes) of the app and its WebKit WebContent, GPU and Networking processes over
// a fixed window, with top's POWER column ("energy impact") for the same processes alongside.
// Test-only: the shipping app has none of this.
@MainActor final class EnergyProbes {
    let h: Harness
    var cover: NSWindow?
    private var workload: Sample?
    init(_ h: Harness) { self.h = h }
    var web: WKWebView { h.d.web }
    var window: NSWindow { h.d.window }

    static let timebase: Double = { var t = mach_timebase_info_data_t(); mach_timebase_info(&t); return Double(t.numer) / Double(t.denom) }()
    func spi(_ object: AnyObject, _ name: String) -> Int32 {
        let sel = NSSelectorFromString(name)
        guard object.responds(to: sel) else { return 0 }
        typealias GetPid = @convention(c) (AnyObject, Selector) -> Int32
        return unsafeBitCast(object.method(for: sel), to: GetPid.self)(object, sel)
    }
    func pids() -> [(String, Int32)] {
        let list: [(String, Int32)] = [("app", getpid()), ("web", spi(web, "_webProcessIdentifier")), ("gpu", spi(web, "_gpuProcessIdentifier")),
                                        ("net", spi(web.configuration.websiteDataStore, "_networkProcessIdentifier"))]
        return list.filter { $0.1 > 0 }
    }
    private struct Usage {
        let cpuNs, idleW, intW: Double
        let energyNj, processStart: UInt64

        func delta(since before: Usage) -> Delta? {
            guard processStart != 0, processStart == before.processStart, energyNj >= before.energyNj else { return nil }
            return Delta(cpuNs: cpuNs - before.cpuNs, idleW: idleW - before.idleW,
                         intW: intW - before.intW, energyJ: Double(energyNj - before.energyNj) / 1e9)
        }
    }
    private struct Delta {
        var cpuNs = 0.0, idleW = 0.0, intW = 0.0, energyJ = 0.0

        func row(_ seconds: TimeInterval) -> [String: Any] {
            ["cpu": cpuNs / 1e9 / seconds * 100, "cpuMs": cpuNs / 1e6, "idleW": idleW / seconds,
             "intW": intW / seconds, "mW": energyJ * 1000 / seconds, "energyJ": energyJ]
        }
    }
    private struct Sample {
        let at: TimeInterval
        let processes: [(String, Int32)]
        let usage: [Usage?]
    }
    private func usage(_ pid: Int32) -> Usage? {
        var r = rusage_info_v6()
        let rc = withUnsafeMutablePointer(to: &r) { p in p.withMemoryRebound(to: rusage_info_t?.self, capacity: 1) { proc_pid_rusage(pid, RUSAGE_INFO_V6, $0) } }
        guard rc == 0 else { return nil }
        // ri_user_time and ri_system_time are mach time units on Apple silicon.
        return Usage(cpuNs: Double(r.ri_user_time + r.ri_system_time) * EnergyProbes.timebase, idleW: Double(r.ri_pkg_idle_wkups),
                     intW: Double(r.ri_interrupt_wkups), energyNj: r.ri_energy_nj, processStart: r.ri_proc_start_abstime)
    }
    /// Deltas over `seconds` for each process and their sum: cpu (% of one core), idle and interrupt
    /// wakeups per second, energy (J), mean power (mW), and top's POWER for the same window.
    func measure(_ seconds: Double) async -> [String: Any] {
        let s = max(0.25, seconds), procs = pids()
        let top = Process(), pipe = Pipe()
        top.executableURL = URL(fileURLWithPath: "/usr/bin/top")
        top.arguments = ["-l", "2", "-s", String(max(1, Int(s.rounded()))), "-stats", "pid,cpu,idlew,power"] + procs.flatMap { ["-pid", String($0.1)] }
        top.standardOutput = pipe; top.standardError = FileHandle.nullDevice
        let topRuns = s >= 1.5 && (try? top.run()) != nil
        let before = sample(procs)
        await h.pause(s)
        var out = delta(before)
        // top's second sample is the window's delta; it can lag the window by a moment.
        let deadline = Date().addingTimeInterval(4)
        while top.isRunning && Date() < deadline { await h.pause(0.1) }
        if top.isRunning { top.terminate() }
        let text = topRuns ? String(data: pipe.fileHandleForReading.readDataToEndOfFile(), encoding: .utf8) ?? "" : ""
        var power = 0.0, sample = 0
        for line in text.split(separator: "\n") {
            if line.hasPrefix("PID") { sample += 1; continue }
            let f = line.split(separator: " ")
            if sample == 2, f.count >= 4, Int32(f[0]) != nil, let pw = Double(f[3]) { power += pw }
        }
        out["topPower"] = power
        return out
    }
    // Bracket the caller's actual workload with the same process sampler. No subprocess is needed.
    func measureBoundary(_ boundary: String) -> Any {
        if boundary == "begin", workload == nil {
            workload = sample(pids())
            return true
        }
        guard boundary == "end", let before = workload else { return NSNull() }
        workload = nil
        return delta(before)
    }
    private func sample(_ processes: [(String, Int32)]) -> Sample {
        Sample(at: ProcessInfo.processInfo.systemUptime, processes: processes, usage: processes.map { usage($0.1) })
    }
    private func delta(_ before: Sample) -> [String: Any] {
        let dt = ProcessInfo.processInfo.systemUptime - before.at, after = pids()
        return Self.delta(before, after: after, seconds: dt, read: usage)
    }
    private static func delta(_ before: Sample, after: [(String, Int32)], seconds: TimeInterval,
                              read: (Int32) -> Usage?) -> [String: Any] {
        var out: [String: Any] = ["seconds": seconds]
        var total = Delta()
        for (i, p) in before.processes.enumerated() {
            guard after.contains(where: { $0 == p }), let a = before.usage[i], let b = read(p.1),
                  let d = b.delta(since: a) else { continue }
            total.cpuNs += d.cpuNs; total.idleW += d.idleW; total.intW += d.intW; total.energyJ += d.energyJ
            out[p.0] = d.row(seconds)
        }
        // A missing or replaced process makes this total partial.
        out["completeProcessCoverage"] = ["app", "web", "gpu", "net"].allSatisfy { out[$0] != nil }
        out["total"] = total.row(seconds)
        return out
    }
    func window(_ act: String) async -> [String: Any] {
        switch act {
        case "minimize": window.miniaturize(nil)
        case "restore": window.deminiaturize(nil); window.makeKeyAndOrderFront(nil); NSApp.activate(ignoringOtherApps: true)
        case "cover":
            // An opaque window of this app over the editor's: the editor window is fully occluded.
            let c = NSWindow(contentRect: window.frame.insetBy(dx: -20, dy: -20), styleMask: [.borderless], backing: .buffered, defer: false)
            c.backgroundColor = .gray; c.isOpaque = true; c.isReleasedWhenClosed = false; c.level = .floating
            c.orderFrontRegardless(); cover = c
        case "uncover": cover?.orderOut(nil); cover = nil; window.makeKeyAndOrderFront(nil)
        case "deactivate": NSApp.deactivate()
        case "hide": NSApp.hide(nil)
        case "unhide": NSApp.unhide(nil); window.makeKeyAndOrderFront(nil)
        default: break
        }
        await h.pause(1.5)
        // The page's view of occlusion as the app reports it (energy-probes.js told the page "on screen" before).
        h.d.pushPower(force: true)
        await h.pause(0.3)
        return ["visible": window.occlusionState.contains(.visible), "mini": window.isMiniaturized, "key": window.isKeyWindow, "active": NSApp.isActive]
    }
    /// Writes `text` as a project file in the work folder and opens it the way Finder does (a saved project:
    /// autosave's sidecar and the collaboration lock and presence files beside it).
    func open(_ text: String, name: String) -> String {
        let url = work.appendingPathComponent("proj").appendingPathComponent(name)
        try? Data(text.utf8).write(to: url)
        h.d.application(NSApp, openFiles: [url.path])
        return ProjectWrites.canonical(url).path
    }
    static func powerState() -> [String: Any] {
        let source = IOPSGetProvidingPowerSourceType(nil)?.takeUnretainedValue() as String? ?? "?"
        return ["lowPower": ProcessInfo.processInfo.isLowPowerModeEnabled, "source": source]
    }
}
