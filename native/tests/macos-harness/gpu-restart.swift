import Cocoa
import CryptoKit
import Darwin
import Security
import WebKit

// The WebKitTestRunner SPI terminates the GPUProcessProxy of this UI process. The
// macOS launcher uses a one-shot XPC instance for that proxy. A process pool
// alone does not isolate a GPU process on modern WebKit.
@MainActor final class GPUProcessRestart {
    static let suiteName = "gpu-process-recovery"
    static let bundleIdentifier = "org.waffle.editor.harness.gpu-restart"
    private static let processPool = WKProcessPool()
    private static let symbols = UnsafeMutableRawPointer(bitPattern: -2) // RTLD_DEFAULT
    private static let gpuExecutable = "/System/Library/Frameworks/WebKit.framework/Versions/A/XPCServices/com.apple.WebKit.GPU.xpc/Contents/MacOS/com.apple.WebKit.GPU"
    private static var existing: Set<pid_t>?
    private static var viewCount = 0
    private static var preparedAt: UInt64 = 0

    private struct Identity: Equatable {
        let pid: pid_t
        let startSeconds: UInt64
        let startMicroseconds: UInt64
    }

    unowned let probes: UIProbes
    private var exitedCandidates: [Identity] = []
    init(_ probes: UIProbes) { self.probes = probes }

    static func prepare(_ configuration: WKWebViewConfiguration) {
        guard suite == suiteName else { return }
        viewCount += 1
        if viewCount == 1 {
            preparedAt = UInt64(Date().timeIntervalSince1970)
            existing = allGPUPIDs()
        }
        configuration.processPool = processPool
        configuration.websiteDataStore = Harness.ephemeralStore
    }

    func accepts(_ message: WKScriptMessage) -> Bool {
        guard suite == Self.suiteName, Bundle.main.bundleIdentifier == Self.bundleIdentifier,
              message.webView === probes.web, message.frameInfo.isMainFrame,
              let url = message.frameInfo.request.url, url.isFileURL,
              let shippedPage = Bundle.main.resourceURL?.appendingPathComponent("app/index.html") else { return false }
        return real(url.path) == real(shippedPage.path)
    }

    private static func path(_ pid: pid_t) -> String? {
        var bytes = [CChar](repeating: 0, count: 4 * Int(MAXPATHLEN))
        guard proc_pidpath(pid, &bytes, UInt32(bytes.count)) > 0 else { return nil }
        return String(cString: bytes)
    }

    private static func isGPUPath(_ path: String) -> Bool {
        path == gpuExecutable || path == "/System/Volumes/Preboot/Cryptexes/OS" + gpuExecutable
    }

    private static func allGPUPIDs() -> Set<pid_t>? {
        let estimate = Int(proc_listallpids(nil, 0))
        guard estimate > 0 else { return nil }
        var pids = [pid_t](repeating: 0, count: estimate + 64)
        let count = pids.withUnsafeMutableBytes { proc_listallpids($0.baseAddress, Int32($0.count)) }
        guard count > 0, count < pids.count else { return nil }
        return Set(pids.prefix(Int(count)).filter { pid in path(pid).map(isGPUPath) == true })
    }

    private static func identity(_ pid: pid_t) -> Identity? {
        var info = proc_bsdinfo()
        let size = Int32(MemoryLayout<proc_bsdinfo>.size)
        guard proc_pidinfo(pid, PROC_PIDTBSDINFO, 0, &info, size) == size,
              info.pbi_pid == UInt32(pid), info.pbi_uid == getuid(),
              let path = path(pid), isGPUPath(path) else { return nil }
        return Identity(pid: pid, startSeconds: info.pbi_start_tvsec, startMicroseconds: info.pbi_start_tvusec)
    }

    private func pagePID(_ name: String) -> pid_t {
        let selector = NSSelectorFromString(name), view = probes.web
        guard view.responds(to: selector), let getter = view.method(for: selector) else { return 0 }
        typealias GetPID = @convention(c) (AnyObject, Selector) -> pid_t
        return unsafeBitCast(getter, to: GetPID.self)(view, selector)
    }

    private static func hasSignature() -> Bool {
        var code: SecCode?
        guard SecCodeCopySelf([], &code) == errSecSuccess, let code else { return false }
        return SecCodeCheckValidity(code, [], nil) == errSecSuccess
    }

    private typealias Terminate = @convention(c) (UnsafeRawPointer) -> Void
    private struct Ownership {
        let process: Identity
        let context: UnsafeRawPointer
        let terminate: Terminate
    }

    private func authorize(_ pid: pid_t) -> (Ownership?, String) {
        guard suite == Self.suiteName, Bundle.main.bundleIdentifier == Self.bundleIdentifier else {
            return (nil, "the dedicated recovery bundle is not running")
        }
        let instances = NSRunningApplication.runningApplications(withBundleIdentifier: Self.bundleIdentifier)
        guard instances.map(\.processIdentifier) == [getpid()], Self.hasSignature(),
              Self.viewCount == 1, probes.web.configuration.processPool === Self.processPool,
              !probes.web.configuration.websiteDataStore.isPersistent else {
            return (nil, "one signed host with one private WebKit view could not be established")
        }
        let web = pagePID("_webProcessIdentifier")
        guard let existing = Self.existing, pid > 1, web > 1, pid != getpid(), pid != web,
              !existing.contains(pid), let process = Self.identity(pid),
              process.startSeconds >= Self.preparedAt else {
            return (nil, "the view's newly launched WebKit GPU process could not be identified")
        }
        guard let ownerSymbol = dlsym(Self.symbols, "responsibility_get_pid_responsible_for_pid"),
              let typeSymbol = dlsym(Self.symbols, "WKGetTypeID"),
              let contextTypeSymbol = dlsym(Self.symbols, "WKContextGetTypeID"),
              let terminateSymbol = dlsym(Self.symbols, "WKContextTerminateGPUProcess") else {
            return (nil, "WebKit recovery SPI or process identity metadata is unavailable")
        }
        let responsible = unsafeBitCast(ownerSymbol, to: (@convention(c) (pid_t) -> pid_t).self)
        let responsibility = responsible(pid)
        guard responsibility > 1, responsibility == responsible(getpid()) else {
            return (nil, "the GPU process is outside the test host's responsibility group")
        }
        let context = UnsafeRawPointer(Unmanaged.passUnretained(Self.processPool).toOpaque())
        let kind = unsafeBitCast(typeSymbol, to: (@convention(c) (UnsafeRawPointer) -> UInt).self)
        let contextKind = unsafeBitCast(contextTypeSymbol, to: (@convention(c) () -> UInt).self)
        guard kind(context) == contextKind() else { return (nil, "WebKit did not validate the private context") }
        return (Ownership(process: process, context: context, terminate: unsafeBitCast(terminateSymbol, to: Terminate.self)), "")
    }

    func state() -> [String: Any] {
        let pid = pagePID("_gpuProcessIdentifier")
        let (ownership, reason) = authorize(pid)
        return ["hostPID": getpid(), "webPID": pagePID("_webProcessIdentifier"), "gpuPID": pid,
                "isolated": ownership != nil, "reason": reason,
                "exited": exitedCandidates.filter { Self.identity($0.pid) != $0 }.map(\.pid)]
    }

    func exitGPU(_ expectedPID: pid_t) -> [String: Any] {
        let pid = pagePID("_gpuProcessIdentifier")
        guard expectedPID == pid, !exitedCandidates.contains(where: { $0.pid == pid }) else {
            return ["requested": false, "reason": "the expected GPU process is no longer current"]
        }
        let (ownership, reason) = authorize(pid)
        guard let ownership else { return ["requested": false, "reason": reason] }
        // No await or run-loop turn may occur between verifying the connection
        // and using WebKit's own local proxy. No PID is ever signalled directly.
        guard pagePID("_gpuProcessIdentifier") == pid, Self.identity(pid) == ownership.process else {
            return ["requested": false, "reason": "the GPU process changed during ownership verification"]
        }
        exitedCandidates.append(ownership.process)
        ownership.terminate(ownership.context)
        return ["requested": true, "gpuPID": pid]
    }

    func capture(_ arguments: [String: Any]) async -> [String: Any] {
        let number = { (key: String) in (arguments[key] as? NSNumber)?.doubleValue ?? 0 }
        let strip = number("frameStrip")
        let rect = NSRect(x: number("x"), y: number("y"), width: number("w"), height: number("h") + strip)
        guard rect.width > 0, rect.height > strip, probes.web.bounds.contains(rect),
              let tiff = await probes.snapshot(rect)?.tiffRepresentation, var image = NSBitmapImageRep(data: tiff)
        else { return ["error": "no valid viewport snapshot"] }
        var frameID = 0
        if strip == 8 {
            let scale = CGFloat(image.pixelsWide) / rect.width
            let h = image.pixelsHigh - Int((strip * scale).rounded())
            guard h > 0, let crop = image.cgImage?.cropping(to: CGRect(x: 0, y: 0, width: image.pixelsWide, height: h))
            else { return ["error": "no valid copper crop"] }
            for bit in 0..<16 {
                let x = Int(CGFloat(2 * (bit % 4) + 1) * scale)
                let y = h + Int(CGFloat(2 * (bit / 4) + 1) * scale)
                guard let color = image.colorAt(x: x, y: y)?.usingColorSpace(.sRGB)
                else { return ["error": "no valid frame strip"] }
                let rgb = [color.redComponent, color.greenComponent, color.blueComponent]
                if rgb.allSatisfy({ $0 > 0.9 }) { frameID |= 1 << bit }
                else if !rgb.allSatisfy({ $0 < 0.1 }) { return ["error": "unreadable frame strip"] }
            }
            image = NSBitmapImageRep(cgImage: crop)
        }
        guard let bytes = image.bitmapData, image.bytesPerRow > 0 else { return ["error": "no valid viewport pixels"] }
        let size = image.bytesPerRow * image.pixelsHigh
        let hash = SHA256.hash(data: Data(bytes: bytes, count: size)).map { String(format: "%02x", $0) }.joined()
        var copper = 0, total = 0
        // Distinguish saturated track and pad pixels from the grid and board fill.
        for y in stride(from: 0, to: image.pixelsHigh, by: 3) {
            for x in stride(from: 0, to: image.pixelsWide, by: 3) {
                if let rgb = image.colorAt(x: x, y: y)?.usingColorSpace(.sRGB) {
                    let r = rgb.redComponent, g = rgb.greenComponent, b = rgb.blueComponent
                    if (r > 0.48 && r - g > 0.28 && r - b > 0.28) ||
                        (b > 0.48 && b - r > 0.28 && b - g > 0.18) { copper += 1 }
                }
                total += 1
            }
        }
        if let name = arguments["name"] as? String, ["before", "during-1", "during-2", "after-1", "after-2",
                                                     "fresh-1", "fresh-2", "after-input"].contains(name),
           let png = image.representation(using: .png, properties: [:]) {
            try? png.write(to: probes.shots.appendingPathComponent(name + ".png"))
        }
        return ["sha256": hash, "copper": copper, "samples": total, "width": image.pixelsWide, "height": image.pixelsHigh, "frameID": frameID]
    }
}
