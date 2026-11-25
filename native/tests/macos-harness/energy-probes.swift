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
    struct Usage { var cpuNs = 0.0, idleW = 0.0, intW = 0.0, energyNj = 0.0 }
    func usage(_ pid: Int32) -> Usage? {
        var r = rusage_info_v6()
        let rc = withUnsafeMutablePointer(to: &r) { p in p.withMemoryRebound(to: rusage_info_t?.self, capacity: 1) { proc_pid_rusage(pid, RUSAGE_INFO_V6, $0) } }
        guard rc == 0 else { return nil }
        // ri_user_time and ri_system_time are mach time units on Apple silicon.
        return Usage(cpuNs: Double(r.ri_user_time + r.ri_system_time) * EnergyProbes.timebase, idleW: Double(r.ri_pkg_idle_wkups),
                     intW: Double(r.ri_interrupt_wkups), energyNj: Double(r.ri_energy_nj))
    }
    /// Deltas over `seconds` for each process and their sum: cpu (% of one core), idle and interrupt
    /// wakeups a second, energy (mW), and top's POWER for the same window.
    func measure(_ seconds: Double) async -> [String: Any] {
        let s = max(0.25, seconds), procs = pids()
        let top = Process(), pipe = Pipe()
        top.executableURL = URL(fileURLWithPath: "/usr/bin/top")
        top.arguments = ["-l", "2", "-s", String(max(1, Int(s.rounded()))), "-stats", "pid,cpu,idlew,power"] + procs.flatMap { ["-pid", String($0.1)] }
        top.standardOutput = pipe; top.standardError = FileHandle.nullDevice
        let topRuns = s >= 1.5 && (try? top.run()) != nil
        let t0 = Date(), before = procs.map { usage($0.1) }
        await h.pause(s)
        let dt = Date().timeIntervalSince(t0), after = procs.map { usage($0.1) }
        var out: [String: Any] = ["seconds": dt]
        var total = Usage()
        for (i, p) in procs.enumerated() {
            guard let a = before[i], let b = after[i] else { continue }
            let d = Usage(cpuNs: b.cpuNs - a.cpuNs, idleW: b.idleW - a.idleW, intW: b.intW - a.intW, energyNj: b.energyNj - a.energyNj)
            total.cpuNs += d.cpuNs; total.idleW += d.idleW; total.intW += d.intW; total.energyNj += d.energyNj
            out[p.0] = row(d, dt)
        }
        out["total"] = row(total, dt)
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
    func row(_ d: Usage, _ dt: Double) -> [String: Any] {
        ["cpu": d.cpuNs / 1e9 / dt * 100, "cpuMs": d.cpuNs / 1e6, "idleW": d.idleW / dt, "intW": d.intW / dt, "mW": d.energyNj / 1e6 / dt]
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
