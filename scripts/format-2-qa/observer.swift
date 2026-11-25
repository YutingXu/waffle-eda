import Foundation
import Darwin

// Test-only, attached at native open/read/flush boundaries. Paths stay in the private process.
// A lock coordinates the native filesystem queue and WebKit presentation callback. No polling.
enum Format2Audit {
    static var manifest = ""
    static var forceVisible = true
    private static let lock = NSLock()
    private static var files = [String:[String:Int]]()
    private static var actual = [String:[String:Int]]()
    private static var samplingFiles = false
    private static let projectPrefix: String = {
        let root = ProcessInfo.processInfo.environment["WAFFLE_FORMAT_TRIAL"] ?? ""
        // Darwin supplies a physical F_GETPATH (including /private). Foundation can
        // translate a resolved /private/var URL back to the /var display spelling.
        guard let physical = realpath(root + "/design", nil) else {
            preconditionFailure("The native benchmark project root cannot be resolved")
        }
        defer { free(physical) }
        return String(cString:physical) + "/"
    }()
    private static var steps = [String:Int]()
    private static var ticks = [String:UInt64]()
    private static var bridgeBytes = 0
    private static var stagedBytes = 0
    static func beginCommit(_ request: [String:Any]) {
        let bytes = (try? JSONSerialization.data(withJSONObject:request,options:[.withoutEscapingSlashes]))?.count ?? 0
        lock.lock(); defer { lock.unlock() }
        steps.removeAll(); ticks.removeAll(); stagedBytes = 0; bridgeBytes = bytes
    }
    private static var heldPoint: String?
    private static var arrived = DispatchSemaphore(value: 0)
    private static var release = DispatchSemaphore(value: 0)

    static func arm(_ name: String) {
        lock.lock(); defer { lock.unlock() }
        heldPoint = name; arrived = DispatchSemaphore(value: 0); release = DispatchSemaphore(value: 0)
    }

    static func reached() -> Bool {
        lock.lock(); let gate = arrived; lock.unlock()
        return gate.wait(timeout: .now() + 12) == .success
    }

    static func resume() {
        lock.lock(); let gate = release; lock.unlock()
        gate.signal()
    }

    static func reset() {
        lock.lock(); defer { lock.unlock() }
        files.removeAll(); actual.removeAll(); samplingFiles = true; steps.removeAll(); ticks.removeAll(); stagedBytes = 0
    }

    static func opened(_ path: String) {
        lock.lock(); defer { lock.unlock() }
        files[path, default: [:]]["opens", default: 0] += 1
    }

    static func read(_ path: String, _ count: Int) {
        lock.lock(); defer { lock.unlock() }
        files[path, default: [:]]["bytes", default: 0] += count
    }

    static func recordFD(_ fd: Int32, bytes: Int? = nil) {
        lock.lock(); let enabled = samplingFiles; lock.unlock()
        guard enabled, bytes != 0 else { return }
        let savedError = errno
        defer { errno = savedError }
        var buffer = [CChar](repeating:0,count:Int(MAXPATHLEN))
        guard fcntl(fd,F_GETPATH,&buffer) == 0 else { return }
        let path = String(cString:buffer)
        guard path.hasPrefix(projectPrefix) else { return }
        let member = String(path.dropFirst(projectPrefix.count))
        let extensions = ["waffle","wsch","wpcb","wlib","wblock","wdraw","wpanel"]
        guard extensions.contains((member as NSString).pathExtension) || member.hasPrefix("assets/") ||
              member.hasPrefix("models/") || member.hasPrefix(".waffle/imports/") else { return }
        lock.lock(); defer { lock.unlock() }
        guard samplingFiles else { return }
        if let count = bytes { actual[member,default:[:]]["bytes",default:0] += count }
        else { actual[member,default:[:]]["opens",default:0] += 1 }
    }

    static func physicalFrontier() -> [String:[String:Int]] {
        lock.lock(); defer { lock.unlock() }
        samplingFiles = false
        return actual
    }

    static func frontier() -> [String:[String:Int]] {
        lock.lock(); defer { lock.unlock() }
        return files
    }

    static func phase(_ name: String) {
        let instant = DispatchTime.now().uptimeNanoseconds
        lock.lock()
        if heldPoint == name {
            heldPoint = nil
            let gate = release
            arrived.signal()
            lock.unlock()
            _ = gate.wait(timeout: .now() + 18)
            lock.lock()
        }
        defer { lock.unlock() }
        let label = String(name.split(separator: ":")[0])
        steps[label, default: 0] += 1
        ticks[label] = instant
    }

    static func fullBarrier(_ descriptor: Int32) -> Int32 {
        let result = fcntl(descriptor, F_FULLFSYNC)
        let savedError = errno
        operation(result == 0 ? "fullDeviceFlushSucceeded" : "fullDeviceFlushRejected")
        errno = savedError
        return result
    }

    static func namespaceBarrier(_ descriptor: Int32) -> Int32 {
        let result = fsync(descriptor)
        let savedError = errno
        operation(result == 0 ? "witnessNamespaceFsyncSucceeded" : "witnessNamespaceFsyncRejected")
        errno = savedError
        return result
    }

    static func operation(_ kind: String) {
        lock.lock(); defer { lock.unlock() }
        steps[kind, default: 0] += 1
    }

    static func staged(_ length: Int) {
        lock.lock(); defer { lock.unlock() }
        stagedBytes += length
    }

    static func receipt() -> [String:Any] {
        lock.lock(); defer { lock.unlock() }
        let ack = ticks["acknowledged"]
        let applied = ticks["after-unlink-sync"]
        let tail = ack.flatMap { a in applied.map { t in Double(t - a) / 1_000_000 } }
        let clearClock = applied.map { Double($0) / 1_000_000 }
        let stageClock = ticks["before-stage"].map { Double($0) / 1_000_000 }
        let ackClock = ack.map { Double($0) / 1_000_000 }
        return ["clearUptimeMs": clearClock as Any? ?? NSNull(), "stageUptimeMs": stageClock as Any? ?? NSNull(),
                "ackUptimeMs": ackClock as Any? ?? NSNull(), "steps": steps, "stagedBytes": stagedBytes, "bridgeJSONBytes": bridgeBytes, "ackToClearedMs": tail as Any? ?? NSNull()]
    }
}
