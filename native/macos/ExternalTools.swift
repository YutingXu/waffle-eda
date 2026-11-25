import AppKit
import CryptoKit
import Foundation

/// run:external for connector extensions (app/native-bridge/external-tools.js). The contract is the one in
/// native/external_tools.py (the Linux host, with its tests); this file mirrors it with Process.
///
/// - The user chooses each program: an NSOpenPanel, or a detected install path they confirm in an
///   NSAlert. An .app bundle resolves to its executable. Page code names a tool id, never a path.
/// - Approval (approvalNeeded / recordApproval, as native/external_tools.py): kept for one extension
///   version (id@sha256 of its bundle), one tool and one resolved program path (symlinks followed),
///   for runs within the extension's declared argument template (its own input file names, plain names
///   matching its output patterns, and contributes.externalTools[].args entries, literal or with one
///   {input} / {output}). The first run shows the full command; a run with any other argument shows it
///   and asks for that exact command. A new version or another program file asks again.
/// - A run starts the executable directly (argument list, no shell) in a new temporary folder that
///   holds the extension's input files, with stdin closed and a minimal environment; it has a timeout
///   (SIGTERM, then SIGKILL two seconds later), caps on stdout, stderr and the output files returned,
///   and cancellation. The folder is deleted afterwards. Data crosses as base64.
final class ExternalTools {
    static let shared = ExternalTools()
    static let toolPattern = try! NSRegularExpression(pattern: "^[a-z0-9][a-z0-9_.-]{0,63}$")
    static let filePattern = try! NSRegularExpression(pattern: "^[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}$")
    static let outputPattern = try! NSRegularExpression(pattern: "^[A-Za-z0-9_*?][A-Za-z0-9_.*?-]{0,127}$")
    static let runPattern = try! NSRegularExpression(pattern: "^[\\w.:-]{1,200}$")
    static let extensionPattern = try! NSRegularExpression(pattern: "^[A-Za-z0-9][\\w.-]{0,119}$")
    static let hashPattern = try! NSRegularExpression(pattern: "^sha256:[0-9a-f]{64}$")
    static let placeholders = ["{input}", "{output}"]
    static let limits = (args: 256, argChars: 4096, files: 64, fileBytes: 64_000_000, outputs: 64,
                         timeoutMs: 600_000.0, minTimeoutMs: 100.0, outputBytes: 64_000_000, probe: 16, concurrent: 8)

    struct Run {
        let tool: String, toolName: String, extensionId: String, extensionName: String
        let args: [String], files: [(String, Data)], outputs: [String]
        let timeout: TimeInterval, cap: Int, runId: String?
        var extensionHash = "", template: [String] = []
        var extensionKey: String { extensionId + "@" + extensionHash }
    }
    /// What to ask before a run (nil: it may start): approve the program for this extension version
    /// and/or this exact command (outside the template).
    struct Approval { let title: String, detail: String, program: Bool, command: Bool, path: String }

    private let lock = NSLock()
    private var running: [String: (process: Process, cancelled: Bool)] = [:]
    private var storeURL: URL { HostFiles.supportDirectory.appendingPathComponent("external-tools.json") }

    static func matches(_ re: NSRegularExpression, _ s: String) -> Bool {
        re.firstMatch(in: s, range: NSRange(s.startIndex..., in: s)) != nil
    }
    static func failure(_ message: String) -> NSError { HostFiles.failure(message) }

    // ------------------------------------------------------------------ store
    private func read() -> (tools: [String: [String: String]], approvals: [String]) {
        guard let data = try? Data(contentsOf: storeURL),
              let object = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] else { return ([:], []) }
        var tools: [String: [String: String]] = [:]
        for (key, value) in object["tools"] as? [String: Any] ?? [:] {
            if Self.matches(Self.toolPattern, key), let row = value as? [String: Any], let path = row["path"] as? String {
                tools[key] = ["path": path, "name": String((row["name"] as? String ?? key).prefix(80))]
            }
        }
        return (tools, Array((object["approvals"] as? [String] ?? []).prefix(2000)))
    }
    private func write(_ tools: [String: [String: String]], _ approvals: [String]) throws {
        try FileManager.default.createDirectory(at: storeURL.deletingLastPathComponent(), withIntermediateDirectories: true)
        let data = try JSONSerialization.data(withJSONObject: ["tools": tools, "approvals": approvals], options: [.prettyPrinted])
        try data.write(to: storeURL, options: [.atomic])
        try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: storeURL.path)
    }
    func listing() -> [String: Any] {
        lock.lock(); defer { lock.unlock() }
        return ["platform": "macos", "tools": read().tools]
    }
    func tool(_ id: String) -> [String: String]? { lock.lock(); defer { lock.unlock() }; return read().tools[id] }
    func forget(_ id: String) throws {
        lock.lock(); defer { lock.unlock() }
        var state = read()
        state.tools.removeValue(forKey: id)
        state.approvals.removeAll { $0.split(separator: "\n", omittingEmptySubsequences: false).dropFirst().first.map(String.init) == id }
        try write(state.tools, state.approvals)
    }
    /// The executable of a chosen path: the file itself, or an .app bundle's main executable.
    static func executable(_ path: String) -> String? {
        guard path.hasPrefix("/"), path.utf8.count < 4096, !path.contains("\0") else { return nil }
        var isDir: ObjCBool = false
        guard FileManager.default.fileExists(atPath: path, isDirectory: &isDir) else { return nil }
        if isDir.boolValue {
            guard path.hasSuffix(".app"), let exe = Bundle(url: URL(fileURLWithPath: path))?.executableURL?.path else { return nil }
            return FileManager.default.isExecutableFile(atPath: exe) ? exe : nil
        }
        return FileManager.default.isExecutableFile(atPath: path) ? path : nil
    }
    func probe(_ paths: Any?) -> [String] {
        (paths as? [Any] ?? []).prefix(Self.limits.probe).compactMap { $0 as? String }.filter { Self.executable($0) != nil }
    }
    func choose(_ id: String, name: String, path: String) throws -> [String: Any] {
        guard Self.matches(Self.toolPattern, id), let exe = Self.executable(path) else { throw Self.failure("Choose a program file that can be run.") }
        lock.lock(); defer { lock.unlock() }
        var state = read()
        state.tools[id] = ["path": exe, "name": String((name.isEmpty ? id : name).prefix(80))]
        try write(state.tools, state.approvals)
        return ["path": exe]
    }
    /// ext: "id@sha256:..." (one version); path: the resolved program; args: one exact command's arguments.
    static func approvalKey(_ ext: String, _ tool: String, _ path: String, _ args: [String]? = nil) -> String {
        var key = [ext, tool, path]
        if let args, let data = try? JSONSerialization.data(withJSONObject: args) {
            key.append("argv:" + SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined())
        }
        return key.joined(separator: "\n")
    }
    func approved(_ ext: String, _ tool: String, _ path: String, _ args: [String]? = nil) -> Bool {
        lock.lock(); defer { lock.unlock() }
        return read().approvals.contains(Self.approvalKey(ext, tool, path, args))
    }
    func approve(_ ext: String, _ tool: String, _ path: String, _ args: [String]? = nil) {
        lock.lock(); defer { lock.unlock() }
        var state = read()
        let key = Self.approvalKey(ext, tool, path, args)
        if !state.approvals.contains(key) { state.approvals = Array((state.approvals + [key]).suffix(2000)); try? write(state.tools, state.approvals) }
    }
    /// The program file an approval names: the chosen path with symlinks followed.
    static func resolved(_ path: String) -> String { URL(fileURLWithPath: path).resolvingSymlinksInPath().path }
    /// The arguments a run passes that its extension does not declare (native/external_tools.py outside_template).
    static func outsideTemplate(_ args: [String], _ template: [String], _ inputs: [String], _ outputs: [String]) -> [String] {
        let inputs = Set(inputs)
        func output(_ name: String) -> Bool {
            matches(filePattern, name) && !name.contains("..") && outputs.contains { fnmatch($0, name, 0) == 0 }
        }
        func fits(_ arg: String, _ entry: String) -> Bool {
            for placeholder in placeholders {
                guard let r = entry.range(of: placeholder) else { continue }
                let pre = String(entry[..<r.lowerBound]), post = String(entry[r.upperBound...])
                guard arg.count > pre.count + post.count, arg.hasPrefix(pre), arg.hasSuffix(post) else { return false }
                let middle = String(arg.dropFirst(pre.count).dropLast(post.count))
                return placeholder == "{input}" ? inputs.contains(middle) : output(middle)
            }
            return arg == entry
        }
        return args.filter { a in !inputs.contains(a) && !output(a) && !template.contains { fits(a, $0) } }
    }
    func approvalNeeded(_ req: Run, _ path: String) -> Approval? {
        let real = Self.resolved(path)
        let outside = Self.outsideTemplate(req.args, req.template, req.files.map { $0.0 }, req.outputs)
        let program = !approved(req.extensionKey, req.tool, real)
        let command = !outside.isEmpty && !approved(req.extensionKey, req.tool, real, req.args)
        guard program || command else { return nil }
        let who = req.extensionName.isEmpty ? req.extensionId : req.extensionName
        let version = req.extensionId + ", " + String(req.extensionHash.prefix(19)) + "\u{2026}"
        let shown = Self.commandLine(path, req.args)
        let place = "It runs in a new temporary folder with the files the extension supplies."
        let extra = outside.map(Self.quote).joined(separator: " ")
        var detail: String
        if program {
            let declared = req.template.isEmpty ? "only its own input and output file names" : "its declared arguments (" + req.template.joined(separator: " ") + ") and its own file names"
            detail = who + " (" + version + ") wants to run:\n\n" + shown + "\n\n" + place + " Allow this program for this version of the extension? Later runs that use " +
                declared + " run without asking; any other argument, a new version or another program asks again."
            if !outside.isEmpty { detail += "\n\nThis command also passes arguments the extension does not declare (" + extra + "); allowing it allows this exact command too." }
        } else {
            detail = who + " (" + version + ") wants to run " + req.toolName + " with arguments it does not declare (" + extra + "):\n\n" + shown + "\n\n" + place + " Allow this exact command?"
        }
        return Approval(title: "Allow " + who + " to run " + req.toolName + "?", detail: detail, program: program, command: !outside.isEmpty, path: real)
    }
    func recordApproval(_ req: Run, _ need: Approval) {
        if need.program { approve(req.extensionKey, req.tool, need.path) }
        if need.command { approve(req.extensionKey, req.tool, need.path, req.args) }
    }

    // ------------------------------------------------------------------ requests
    static func check(_ value: Any?) throws -> Run {
        let bad = failure("Invalid external tool request.")
        guard let r = value as? [String: Any], let tool = r["tool"] as? String, matches(toolPattern, tool) else { throw bad }
        let args = r["args"] as? [Any] ?? []
        guard args.count <= limits.args else { throw failure("Invalid program arguments.") }
        let list: [String] = try args.map {
            guard let a = $0 as? String, a.utf16.count <= limits.argChars, !a.contains("\0") else { throw failure("Invalid program arguments.") }
            return a
        }
        var files: [(String, Data)] = [], total = 0
        let raw = r["files"] as? [Any] ?? []
        guard raw.count <= limits.files else { throw failure("Invalid input files.") }
        for f in raw {
            guard let row = f as? [String: Any], let name = row["name"] as? String, matches(filePattern, name), !name.contains(".."),
                  let encoded = row["data"] as? String, let data = Data(base64Encoded: encoded) else { throw failure("Invalid input files.") }
            total += data.count
            guard total <= limits.fileBytes else { throw failure("The input files are too large.") }
            files.append((name, data))
        }
        let outputs = (r["outputs"] as? [Any] ?? []).compactMap { $0 as? String }
        guard outputs.count == (r["outputs"] as? [Any] ?? []).count, outputs.count <= limits.outputs,
              outputs.allSatisfy({ matches(outputPattern, $0) && !$0.contains("..") }) else { throw failure("Invalid output patterns.") }
        let timeout = (r["timeoutMs"] as? NSNumber)?.doubleValue ?? 60000, cap = (r["maxOutputBytes"] as? NSNumber)?.intValue ?? 16_000_000
        guard timeout >= limits.minTimeoutMs, timeout <= limits.timeoutMs else { throw failure("Invalid timeout.") }
        guard cap >= 1024, cap <= limits.outputBytes else { throw failure("Invalid output limit.") }
        let runId = r["runId"] as? String
        if let id = runId, !matches(runPattern, id) { throw failure("Invalid run id.") }
        guard let ext = r["extension"] as? String, matches(extensionPattern, ext), let digest = r["extensionHash"] as? String, matches(hashPattern, digest) else {
            throw failure("Invalid external tool request: the extension and its version are required.")
        }
        let rawTemplate = r["argTemplate"] as? [Any] ?? []
        let template = rawTemplate.compactMap { $0 as? String }
        guard template.count == rawTemplate.count, template.count <= 64, template.allSatisfy({ t in
            !t.isEmpty && t.count <= 200 && !t.contains("\0") && placeholders.map({ t.components(separatedBy: $0).count - 1 }).reduce(0, +) <= 1
        }) else { throw failure("Invalid argument template.") }
        var run = Run(tool: tool, toolName: String((r["toolName"] as? String ?? tool).prefix(80)), extensionId: ext,
                      extensionName: String((r["extensionName"] as? String ?? "").prefix(120)), args: list, files: files, outputs: outputs,
                      timeout: timeout / 1000, cap: cap, runId: runId)
        run.extensionHash = digest; run.template = template
        return run
    }
    static let plainArgument = try! NSRegularExpression(pattern: "^[\\w./:=+-]+$")
    static func quote(_ a: String) -> String { matches(plainArgument, a) ? a : "'" + a.replacingOccurrences(of: "'", with: "'\\''") + "'" }
    static func commandLine(_ path: String, _ args: [String]) -> String {
        ([path] + args).map(quote).joined(separator: " ")
    }

    // ------------------------------------------------------------------ running
    func reserve(_ req: Run) throws -> String {
        let key = req.runId ?? UUID().uuidString
        lock.lock(); defer { lock.unlock() }
        guard running.count < Self.limits.concurrent, running[key] == nil else { throw Self.failure("Too many external programs are running.") }
        running[key] = (Process(), false)
        return key
    }
    func release(_ key: String) {
        lock.lock(); running.removeValue(forKey: key); lock.unlock()
    }
    func isCancelled(_ key: String) -> Bool {
        lock.lock(); defer { lock.unlock() }
        return running[key]?.cancelled != false
    }
    func cancel(_ runId: String) {
        lock.lock()
        guard var job = running[runId] else { lock.unlock(); return }
        job.cancelled = true; running[runId] = job
        lock.unlock()
        stop(job.process)
    }
    private func stop(_ process: Process) {
        guard process.isRunning else { return }
        process.terminate()
        let pid = process.processIdentifier
        DispatchQueue.global().asyncAfter(deadline: .now() + 2) { if process.isRunning { kill(pid, SIGKILL) } }
    }
    /// Runs on a background queue; `done` is called once, on that queue.
    func run(_ path: String, _ req: Run, reservation key: String, done: @escaping (Result<[String: Any], Error>) -> Void) {
        DispatchQueue.global(qos: .userInitiated).async {
            let fm = FileManager.default
            let work = fm.temporaryDirectory.appendingPathComponent("atrium-run-" + UUID().uuidString, isDirectory: true)
            defer { try? fm.removeItem(at: work) }
            do {
                self.lock.lock()
                let job = self.running[key]
                self.lock.unlock()
                guard let process = job?.process else { throw Self.failure("The run is no longer active.") }
                defer { self.release(key) }
                try fm.createDirectory(at: work, withIntermediateDirectories: false, attributes: [.posixPermissions: 0o700])
                for (name, data) in req.files {
                    guard fm.createFile(atPath: work.appendingPathComponent(name).path, contents: data) else { throw Self.failure("Could not write " + name + ".") }
                }
                process.executableURL = URL(fileURLWithPath: path)
                process.arguments = req.args
                process.currentDirectoryURL = work
                var env = ["PATH": "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin", "TMPDIR": work.path + "/", "LANG": ProcessInfo.processInfo.environment["LANG"] ?? "en_US.UTF-8"]
                for key in ["HOME", "USER", "LOGNAME"] { if let v = ProcessInfo.processInfo.environment[key] { env[key] = v } }
                process.environment = env
                process.standardInput = FileHandle.nullDevice
                let out = Pipe(), err = Pipe()
                process.standardOutput = out; process.standardError = err
                var streams: [Int: Data] = [:]
                var truncated = false
                let group = DispatchGroup(), streamLock = NSLock()
                let started = Date()
                let launched = try { () throws -> Bool in
                    self.lock.lock(); defer { self.lock.unlock() }
                    guard self.running[key]?.cancelled == false else { return false }
                    try process.run()
                    return true
                }()
                guard launched else {
                    done(.success(["exitCode": NSNull(), "signal": NSNull(), "timedOut": false, "cancelled": true,
                                   "truncated": false, "durationMs": 0, "stdout": "", "stderr": "", "files": []]))
                    return
                }
                for (index, pipe) in [out, err].enumerated() {
                    group.enter()
                    DispatchQueue.global().async {
                        var kept = Data()
                        while true {
                            let chunk = pipe.fileHandleForReading.availableData
                            if chunk.isEmpty { break }
                            let room = req.cap - kept.count
                            if room > 0 { kept.append(chunk.prefix(room)) }
                            if chunk.count > max(room, 0) { streamLock.lock(); truncated = true; streamLock.unlock() }
                        }
                        streamLock.lock(); streams[index] = kept; streamLock.unlock()
                        group.leave()
                    }
                }
                var timedOut = false
                let finished = DispatchSemaphore(value: 0)
                process.terminationHandler = { _ in finished.signal() }
                if !process.isRunning { finished.signal() }
                if finished.wait(timeout: .now() + req.timeout) == .timedOut {
                    timedOut = true
                    self.stop(process)
                    finished.wait()
                }
                _ = group.wait(timeout: .now() + 5)
                self.lock.lock(); let cancelled = self.running[key]?.cancelled ?? false; self.lock.unlock()
                var files: [[String: Any]] = [], budget = req.cap
                if !req.outputs.isEmpty {
                    var names: [String] = []
                    if let directory = fm.enumerator(at: work, includingPropertiesForKeys: nil, options: [.skipsSubdirectoryDescendants]) {
                        for case let url as URL in directory {
                            if names.count >= 4096 { truncated = true; names.removeAll(); break }
                            names.append(url.lastPathComponent)
                        }
                    }
                    for name in names.sorted() where req.outputs.contains(where: { fnmatch($0, name, 0) == 0 }) {
                        let url = work.appendingPathComponent(name)
                        do {
                            let (data, _) = try HostFiles.readRegular(url, cap: budget, singleLink: true)
                            budget -= data.count
                            files.append(["name": name, "data": data.base64EncodedString()])
                        } catch { truncated = true }
                    }
                }
                let signalled = process.terminationReason == .uncaughtSignal
                done(.success(["exitCode": signalled ? NSNull() : process.terminationStatus as Any, "signal": signalled ? process.terminationStatus as Any : NSNull(),
                               "timedOut": timedOut, "cancelled": cancelled, "truncated": truncated, "durationMs": Int(Date().timeIntervalSince(started) * 1000),
                               "stdout": (streams[0] ?? Data()).base64EncodedString(), "stderr": (streams[1] ?? Data()).base64EncodedString(), "files": files]))
            } catch {
                done(.failure(error))
            }
        }
    }
}
