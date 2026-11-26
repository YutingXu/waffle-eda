import AppKit
import CryptoKit
import Darwin
import Foundation

enum UpdateError: LocalizedError {
    case manualDownload, diskFull
    case failure(String)

    var errorDescription: String? {
        switch self {
        case .manualDownload: return "Waffle needs a writable installation in Applications."
        case .diskFull: return "There isn’t enough disk space for the Waffle update. Free some space and try again."
        case .failure(let detail): return detail
        }
    }

    static func storage(_ error: Error) -> Error {
        let ns = error as NSError
        if ns.domain == NSPOSIXErrorDomain && ns.code == Int(ENOSPC) ||
           ns.domain == NSCocoaErrorDomain && ns.code == NSFileWriteOutOfSpaceError { return Self.diskFull }
        return error
    }

    static func posix(_ code: Int32) -> Error {
        storage(NSError(domain: NSPOSIXErrorDomain, code: Int(code)))
    }
}

struct UpdateTrust: Decodable {
    let repository: String
    let publicKey: String
    let signingLeaf: String

    init(repository: String, publicKey: String, signingLeaf: String) {
        self.repository = repository
        self.publicKey = publicKey
        self.signingLeaf = signingLeaf
    }

    static func read(_ bundle: Bundle) throws -> Self {
        guard let url = bundle.url(forResource: "update-trust", withExtension: "json") else {
            throw UpdateError.failure("This build does not have a signed release feed.")
        }
        let trust = try JSONDecoder().decode(Self.self, from: Data(contentsOf: url))
        guard trust.repository.range(of: #"\A[A-Za-z0-9_-]+/[A-Za-z0-9_.-]+\z"#, options: .regularExpression) != nil,
              trust.publicKey.range(of: #"\A[0-9a-f]{64}\z"#, options: .regularExpression) != nil,
              trust.signingLeaf.range(of: #"\A[0-9a-f]{40}\z"#, options: .regularExpression) != nil else {
            throw UpdateError.failure("The built-in update signing pins are invalid.")
        }
        return trust
    }

    var releases: String { "https://github.com/\(repository)/releases" }
    var requirement: String { "identifier \"org.waffle.editor\" and certificate leaf = H\"\(signingLeaf)\"" }
}

struct UpdateVersion: Comparable {
    private let parts: [Int]

    init?(_ text: String) {
        let parts = text.split(separator: ".", omittingEmptySubsequences: false)
        guard parts.count == 3, parts.allSatisfy({ part in
            (1...9).contains(part.utf8.count) && part.utf8.allSatisfy { (48...57).contains($0) } &&
                (part.count == 1 || part.first != "0")
        }) else { return nil }
        self.parts = parts.compactMap { Int($0) }
    }

    static func < (lhs: Self, rhs: Self) -> Bool {
        lhs.parts.lexicographicallyPrecedes(rhs.parts)
    }
}

struct UpdateManifest: Decodable {
    struct Formats: Decodable { let writes: String }

    struct Asset: Decodable {
        let platform: String
        let name: String
        let url: URL
        let sha256: String
        let size: Int64

        var forEditor: [String: Any] {
            ["platform": platform, "name": name, "url": url.absoluteString, "sha256": sha256, "size": size]
        }
    }

    let format: String
    let version: Int
    let app: String
    let published: String?
    let formats: Formats
    let apiVersions: [Int]
    let notes: [String]?
    private let assets: [Asset]

    struct Offer {
        let manifest: UpdateManifest
        let asset: Asset

        func forEditor(canInstall: Bool) -> [String: Any] {
            let value: [String: Any] = ["app": manifest.app, "notes": manifest.notes ?? [],
                "published": manifest.published ?? "", "formats": ["writes": manifest.formats.writes],
                "apiVersions": manifest.apiVersions, "assets": [asset.forEditor]]
            return ["status": "available", "manifest": value, "canInstall": canInstall]
        }
    }

    static func verified(_ body: Data, signature encoded: Data, trust: UpdateTrust, installed: String) throws -> Offer? {
        let keyBytes = stride(from: 0, to: trust.publicKey.utf8.count, by: 2).compactMap { offset in
            UInt8(String(decoding: trust.publicKey.utf8.dropFirst(offset).prefix(2), as: UTF8.self), radix: 16)
        }
        guard trust.publicKey.utf8.count == 64, keyBytes.count == 32,
              let key = try? Curve25519.Signing.PublicKey(rawRepresentation: Data(keyBytes)),
              let encoded = String(data: encoded, encoding: .utf8),
              let signature = Data(base64Encoded: encoded.trimmingCharacters(in: .whitespacesAndNewlines)),
              signature.count == 64, key.isValidSignature(signature, for: body) else {
            throw UpdateError.failure("The release manifest’s signature is invalid.")
        }
        guard let manifest = try? JSONDecoder().decode(Self.self, from: body),
              manifest.format == "atrium-release", manifest.version == 1,
              let offered = UpdateVersion(manifest.app), let current = UpdateVersion(installed),
              manifest.assets.count <= 50, manifest.notes?.allSatisfy({ $0.count <= 500 }) != false else {
            throw UpdateError.failure("The signed release manifest is invalid or unsupported.")
        }
        guard offered > current else { return nil }
        let name = "Waffle-\(manifest.app)-macOS.zip"
        let candidates = manifest.assets.filter { $0.name == name }
        guard candidates.count == 1, let asset = candidates.first, asset.platform == "macos",
              asset.url.absoluteString == "\(trust.releases)/download/v\(manifest.app)/\(name)",
              (1...2_000_000_000).contains(asset.size),
              asset.sha256.range(of: #"\A[0-9a-f]{64}\z"#, options: .regularExpression) != nil else {
            throw UpdateError.failure("The release manifest has no valid macOS update archive.")
        }
        return Offer(manifest: manifest, asset: asset)
    }

    static func fetch(trust: UpdateTrust, installed: String) async throws -> Offer? {
        let feed = trust.releases + "/latest/download/waffle-release.json"
        guard let url = URL(string: feed), let signature = URL(string: feed + ".sig") else {
            throw UpdateError.failure("The release feed address is invalid.")
        }
        async let body = UpdateTransfer.get(url, limit: 512 * 1024, label: "release manifest")
        async let signed = UpdateTransfer.get(signature, limit: 256, label: "release signature")
        return try await verified(body, signature: signed, trust: trust, installed: installed)
    }
}

// Each transfer uses a fresh session and sends the same headers on every redirect. Archive bytes
// go straight to a file created by Waffle, so they never acquire a browser's quarantine attribute.
final class UpdateTransfer: NSObject, URLSessionDataDelegate, @unchecked Sendable {
    private let limit: Int64
    private let exact: Bool
    private let label: String
    private let destination: FileHandle?
    private var data = Data()
    private var count: Int64 = 0
    private var failure: Error?
    private let completion: CheckedContinuation<Data, Error>

    private init(limit: Int64, label: String, destination: FileHandle?, completion: CheckedContinuation<Data, Error>) {
        self.limit = limit
        self.exact = destination != nil
        self.label = label
        self.destination = destination
        self.completion = completion
    }

    static func allows(_ url: URL?) -> Bool {
        guard let url, url.scheme == "https", url.user == nil, url.password == nil, url.port == nil || url.port == 443 else { return false }
        return ["github.com", "release-assets.githubusercontent.com", "objects.githubusercontent.com"].contains(url.host?.lowercased() ?? "")
    }

    static func request(_ url: URL) -> URLRequest {
        var request = URLRequest(url: url, cachePolicy: .reloadIgnoringLocalCacheData, timeoutInterval: 30)
        request.httpShouldHandleCookies = false
        request.setValue("Mozilla/5.0", forHTTPHeaderField: "User-Agent")
        request.setValue("application/octet-stream", forHTTPHeaderField: "Accept")
        request.setValue("identity", forHTTPHeaderField: "Accept-Encoding")
        return request
    }

    private final class Cancellation: @unchecked Sendable {
        private let lock = NSLock()
        private var task: URLSessionDataTask?
        private var cancelled = false

        func start(_ task: URLSessionDataTask) {
            lock.lock()
            self.task = task
            if cancelled { task.cancel() } else { task.resume() }
            lock.unlock()
        }

        func cancel() {
            lock.lock()
            cancelled = true
            task?.cancel()
            lock.unlock()
        }
    }

    static func get(_ url: URL, limit: Int64, label: String, to destination: FileHandle? = nil,
                    configuration: URLSessionConfiguration = .ephemeral) async throws -> Data {
        guard allows(url) else { throw UpdateError.failure("The \(label) address is not on the GitHub release feed.") }
        configuration.httpCookieStorage = nil
        configuration.httpShouldSetCookies = false
        configuration.urlCache = nil
        configuration.urlCredentialStorage = nil
        configuration.timeoutIntervalForResource = destination == nil ? 30 : 15 * 60
        let cancellation = Cancellation()
        return try await withTaskCancellationHandler {
            try Task.checkCancellation()
            return try await withCheckedThrowingContinuation { completion in
                let transfer = UpdateTransfer(limit: limit, label: label, destination: destination, completion: completion)
                let session = URLSession(configuration: configuration, delegate: transfer, delegateQueue: nil)
                cancellation.start(session.dataTask(with: request(url)))
            }
        } onCancel: {
            cancellation.cancel()
        }
    }

    private var sizeError: UpdateError {
        .failure("The \(label) has the wrong size. The download was discarded.")
    }

    func urlSession(_ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse,
                    newRequest proposed: URLRequest, completionHandler: @escaping (URLRequest?) -> Void) {
        guard let url = proposed.url, Self.allows(url) else {
            failure = UpdateError.failure("GitHub redirected the \(label) to an unexpected address.")
            completionHandler(nil)
            return
        }
        completionHandler(Self.request(url))
    }

    func urlSession(_ session: URLSession, task: URLSessionTask, didReceive challenge: URLAuthenticationChallenge,
                    completionHandler: @escaping (URLSession.AuthChallengeDisposition, URLCredential?) -> Void) {
        completionHandler(challenge.protectionSpace.authenticationMethod == NSURLAuthenticationMethodServerTrust ?
                          .performDefaultHandling : .cancelAuthenticationChallenge, nil)
    }

    func urlSession(_ session: URLSession, dataTask: URLSessionDataTask, didReceive response: URLResponse,
                    completionHandler: @escaping (URLSession.ResponseDisposition) -> Void) {
        guard let http = response as? HTTPURLResponse, Self.allows(http.url), http.statusCode == 200 else {
            if failure == nil {
                let status = (response as? HTTPURLResponse).map { " (HTTP \($0.statusCode))" } ?? ""
                failure = UpdateError.failure("Couldn’t download the \(label)\(status).")
            }
            completionHandler(.cancel)
            return
        }
        let length = response.expectedContentLength
        if length > limit || exact && length >= 0 && length != limit {
            failure = sizeError
            completionHandler(.cancel)
        } else { completionHandler(.allow) }
    }

    func urlSession(_ session: URLSession, dataTask: URLSessionDataTask, didReceive bytes: Data) {
        guard failure == nil else { return }
        count += Int64(bytes.count)
        guard count <= limit else {
            failure = sizeError
            dataTask.cancel()
            return
        }
        do {
            if let destination { try destination.write(contentsOf: bytes) }
            else { data.append(bytes) }
        } catch {
            failure = UpdateError.storage(error)
            dataTask.cancel()
        }
    }

    func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: Error?) {
        session.finishTasksAndInvalidate()
        if let failure { completion.resume(throwing: failure); return }
        if exact && count != limit && (count > 0 || error == nil) { completion.resume(throwing: sizeError); return }
        if let error {
            completion.resume(throwing: UpdateError.failure("Couldn’t download the \(label). \(error.localizedDescription)"))
        } else { completion.resume(returning: data) }
    }
}

enum UpdateArchive {
    static func verify(_ archive: URL, asset: UpdateManifest.Asset) throws {
        let file = try FileHandle(forReadingFrom: archive)
        defer { try? file.close() }
        guard try file.seekToEnd() == UInt64(asset.size) else {
            throw UpdateError.failure("The update archive has the wrong size. The download was discarded.")
        }
        try file.seek(toOffset: 0)
        var hash = SHA256()
        while let data = try file.read(upToCount: 1 << 20), !data.isEmpty { hash.update(data: data) }
        guard hash.finalize().map({ String(format: "%02x", $0) }).joined() == asset.sha256 else {
            throw UpdateError.failure("The update archive does not match the signed SHA-256 checksum.")
        }
    }

    static func download(_ asset: UpdateManifest.Asset, to directory: URL) async throws -> URL {
        try checkSpace(directory, needed: asset.size)
        let archive = directory.appendingPathComponent(asset.name)
        let fd = open(archive.path, O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW, 0o600)
        guard fd >= 0 else { throw UpdateError.posix(errno) }
        let file = FileHandle(fileDescriptor: fd, closeOnDealloc: true)
        do {
            _ = try await UpdateTransfer.get(asset.url, limit: asset.size, label: "update archive", to: file)
            try file.close()
            try verify(archive, asset: asset)
            return archive
        } catch {
            try? file.close()
            throw UpdateError.storage(error)
        }
    }

    static func checkSpace(_ directory: URL, needed: Int64) throws {
        let available = try? directory.resourceValues(forKeys: [.volumeAvailableCapacityKey]).volumeAvailableCapacity
        if let available, Int64(available) < needed { throw UpdateError.diskFull }
    }

    static func unpack(_ archive: URL, in directory: URL) throws -> URL {
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: false)
        // bsdtar protects against traversal through .. and symlinks. The release ZIP needs no
        // platform metadata beyond the executable mode, and extraction never applies quarantine.
        let (status, detail) = try command("/usr/bin/tar", ["-xkf", archive.path, "--no-xattrs", "--no-mac-metadata",
            "--no-acls", "--no-fflags", "--no-same-owner", "--no-same-permissions", "-C", directory.path])
        if detail.contains("No space left on device") { throw UpdateError.diskFull }
        guard status == 0, try FileManager.default.contentsOfDirectory(atPath: directory.path) == ["Waffle.app"],
              let info = UpdateLocation.info(directory.appendingPathComponent("Waffle.app")), UpdateLocation.isDirectory(info) else {
            throw UpdateError.failure("The macOS archive could not be unpacked as a Waffle application.")
        }
        return directory.appendingPathComponent("Waffle.app", isDirectory: true)
    }

    static func verifyBundle(_ bundle: URL, version: String, trust: UpdateTrust) throws {
        let (valid, _) = try command("/usr/bin/codesign", ["--verify", "--strict", "--deep", "--all-architectures", bundle.path])
        guard valid == 0 else { throw UpdateError.failure("The Waffle application’s code signature could not be verified.") }

        let (trusted, _) = try command("/usr/bin/codesign", ["--verify", "--strict", "--all-architectures", "-R=" + trust.requirement, bundle.path])
        guard trusted == 0 else { throw UpdateError.failure("The update was signed with a different macOS signing identity.") }
        for arch in ["arm64", "x86_64"] {
            let (status, detail) = try command("/usr/bin/codesign", ["--display", "--arch", arch, "-r-", bundle.path])
            let requirements = detail.split(separator: "\n").filter { $0.hasPrefix("designated => ") }
            guard status == 0, requirements == ["designated => \(trust.requirement)"] else {
                throw UpdateError.failure("The update’s designated code signing requirement does not match Waffle.")
            }
        }

        let infoURL = bundle.appendingPathComponent("Contents/Info.plist")
        guard let data = try? Data(contentsOf: infoURL),
              let info = (try? PropertyListSerialization.propertyList(from: data, format: nil)) as? [String: Any],
              info["CFBundleIdentifier"] as? String == "org.waffle.editor",
              info["CFBundleExecutable"] as? String == "Waffle",
              info["CFBundleShortVersionString"] as? String == version else {
            throw UpdateError.failure("The Waffle application’s bundle version or identity does not match the release manifest.")
        }
    }

    private static func command(_ executable: String, _ arguments: [String]) throws -> (Int32, String) {
        let process = Process(), output = Pipe()
        process.executableURL = URL(fileURLWithPath: executable)
        process.arguments = arguments
        process.environment = ["LC_ALL": "C"]
        process.standardInput = FileHandle.nullDevice
        process.standardOutput = output
        process.standardError = output
        try process.run()
        let detail = output.fileHandleForReading.readDataToEndOfFile()
        process.waitUntilExit()
        return (process.terminationStatus, String(decoding: detail, as: UTF8.self))
    }
}

struct UpdateLocation {
    static let applications = URL(fileURLWithPath: "/Applications", isDirectory: true)
    static let prefix = ".waffle-update."
    let app: URL
    let applications: URL

    init(app: URL, applications: URL = Self.applications) {
        self.app = app.standardizedFileURL
        self.applications = applications.standardizedFileURL
    }

    static func info(_ url: URL) -> stat? {
        var info = stat()
        return lstat(url.path, &info) == 0 ? info : nil
    }

    static func isDirectory(_ info: stat) -> Bool { info.st_mode & S_IFMT == S_IFDIR }

    var writable: Bool {
        let flags = UInt32(UF_IMMUTABLE) | UInt32(SF_IMMUTABLE) | UInt32(UF_APPEND) | UInt32(SF_APPEND)
        guard app.deletingLastPathComponent().path == applications.path, app.pathExtension == "app",
              let info = Self.info(app), Self.isDirectory(info),
              info.st_flags & flags == 0 else { return false }
        return FileManager.default.isWritableFile(atPath: app.path) && access(applications.path, W_OK | X_OK) == 0
    }

    struct Stamp: Equatable {
        let device: Int32
        let inode: UInt64

        init(device: Int32, inode: UInt64) {
            self.device = device
            self.inode = inode
        }

        static func read(_ path: URL) -> Self? {
            guard let info = UpdateLocation.info(path), UpdateLocation.isDirectory(info) else { return nil }
            return Self(device: info.st_dev, inode: info.st_ino)
        }
    }

    static func temp(in parent: URL) throws -> URL {
        var name = parent.appendingPathComponent(prefix + "XXXXXX").path.utf8CString
        guard name.withUnsafeMutableBufferPointer({ mkdtemp($0.baseAddress!) }) != nil else {
            let code = errno
            if code == EACCES || code == EPERM || code == EROFS { throw UpdateError.manualDownload }
            throw UpdateError.posix(code)
        }
        return name.withUnsafeBufferPointer { URL(fileURLWithPath: String(cString: $0.baseAddress!), isDirectory: true) }
    }

    func stagingDirectory(named name: String) -> URL? {
        guard app.deletingLastPathComponent().path == applications.path,
              name.range(of: #"\A\.waffle-update\.[A-Za-z0-9]{6}\z"#, options: .regularExpression) != nil else { return nil }
        let path = applications.appendingPathComponent(name, isDirectory: true)
        guard let info = Self.info(path), Self.isDirectory(info), info.st_uid == geteuid(), info.st_mode & 0o777 == 0o700 else { return nil }
        return path
    }
}

struct StagedUpdate {
    let directory: URL
    let original: UpdateLocation.Stamp
    let version: String

    var candidate: URL { directory.appendingPathComponent("archive/Waffle.app", isDirectory: true) }
    var readyFile: URL { directory.appendingPathComponent("ready") }

    static func prepare(_ offer: UpdateManifest.Offer, at location: UpdateLocation, trust: UpdateTrust) async throws -> Self {
        guard location.writable, let original = UpdateLocation.Stamp.read(location.app) else { throw UpdateError.manualDownload }
        let directory = try UpdateLocation.temp(in: location.applications)
        do {
            let archive = try await UpdateArchive.download(offer.asset, to: directory)
            try Task.checkCancellation()
            let staged = Self(directory: directory, original: original, version: offer.manifest.app)
            let candidate = try UpdateArchive.unpack(archive, in: staged.candidate.deletingLastPathComponent())
            try UpdateArchive.verifyBundle(candidate, version: staged.version, trust: trust)
            try FileManager.default.removeItem(at: archive)
            return staged
        } catch {
            try? FileManager.default.removeItem(at: directory)
            throw UpdateError.storage(error)
        }
    }

    func discard() {
        try? FileManager.default.removeItem(at: directory)
    }

    func replace(at location: UpdateLocation, launch: () throws -> Void) throws {
        guard location.writable, UpdateLocation.Stamp.read(location.app) == original,
              let replacement = UpdateLocation.Stamp.read(candidate) else {
            throw UpdateError.failure("The copy of Waffle in Applications changed before the update could be installed.")
        }
        // Both complete bundles are on the same volume. The installed path is never absent.
        try swap(location.app, candidate)
        do { try launch() }
        catch {
            guard UpdateLocation.Stamp.read(location.app) == replacement, UpdateLocation.Stamp.read(candidate) == original else {
                throw UpdateError.failure("The installation changed during restart. The previous Waffle is at \(candidate.path).")
            }
            do { try swap(location.app, candidate) }
            catch {
                throw UpdateError.failure("Couldn’t restore the previous Waffle. It is still at \(candidate.path). \(error.localizedDescription)")
            }
            throw UpdateError.failure("Waffle couldn’t start the update. The previous version was restored. \(error.localizedDescription)")
        }
    }

    private func swap(_ first: URL, _ second: URL) throws {
        guard renameatx_np(AT_FDCWD, first.path, AT_FDCWD, second.path, UInt32(RENAME_SWAP)) == 0 else {
            let code = errno
            if code == EACCES || code == EPERM || code == EROFS { throw UpdateError.manualDownload }
            throw UpdateError.posix(code)
        }
    }

    func handoff(using executable: URL) throws {
        let process = Process()
        process.executableURL = executable
        process.arguments = ["--waffle-update-worker", directory.lastPathComponent, version,
                             String(original.device), String(original.inode), String(getpid())]
        process.standardInput = FileHandle.nullDevice
        process.standardOutput = FileHandle.nullDevice
        process.standardError = FileHandle.nullDevice
        try process.run()
    }
}

enum UpdateRestart {
    static func readinessFile(arguments: [String], location: UpdateLocation) -> URL? {
        guard arguments.count == 3, arguments[1] == "--waffle-update-ready",
              let directory = location.stagingDirectory(named: arguments[2]) else { return nil }
        return directory.appendingPathComponent("ready")
    }

    static func launch(_ app: URL, arguments: [String]) throws -> Process {
        let process = Process()
        process.executableURL = app.appendingPathComponent("Contents/MacOS/Waffle")
        process.arguments = arguments
        process.standardInput = FileHandle.nullDevice
        process.standardOutput = FileHandle.nullDevice
        process.standardError = FileHandle.nullDevice
        try process.run()
        return process
    }

    static func awaitReady(_ process: Process, at readyFile: URL, timeout: TimeInterval = 45) throws {
        let deadline = ProcessInfo.processInfo.systemUptime + timeout
        let expected = Data(String(process.processIdentifier).utf8)
        while process.isRunning && ProcessInfo.processInfo.systemUptime < deadline {
            if (try? Data(contentsOf: readyFile)) == expected, process.isRunning { return }
            Thread.sleep(forTimeInterval: 0.05)
        }
        if process.isRunning {
            kill(process.processIdentifier, SIGKILL)
            process.waitUntilExit()
        }
        throw UpdateError.failure("The updated editor did not report ready.")
    }

    // The worker runs as the original executable and outlives its editor process. No replacement
    // starts until that process has exited, so its WebKit and project writes have stopped.
    static func otherInstance(at location: UpdateLocation) -> Bool {
        NSRunningApplication.runningApplications(withBundleIdentifier: "org.waffle.editor").contains {
            $0.processIdentifier != getpid() && $0.bundleURL?.standardizedFileURL.path == location.app.path && !$0.isTerminated
        }
    }

    @MainActor static func complete(_ args: [String], bundle: Bundle,
                                    applications: URL = UpdateLocation.applications,
                                    reportFailure: ((String) -> Void)? = nil) -> Int32 {
        let location = UpdateLocation(app: bundle.bundleURL, applications: applications)
        guard args.count == 7, let directory = location.stagingDirectory(named: args[2]),
              let device = Int32(args[4]), let inode = UInt64(args[5]), let parent = Int32(args[6]), parent > 1,
              let offered = UpdateVersion(args[3]), let version = bundle.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String,
              let current = UpdateVersion(version), offered > current else { return 1 }
        let staged = StagedUpdate(directory: directory, original: .init(device: device, inode: inode), version: args[3])
        let deadline = ProcessInfo.processInfo.systemUptime + 30
        while kill(parent, 0) == 0 && ProcessInfo.processInfo.systemUptime < deadline { Thread.sleep(forTimeInterval: 0.05) }
        guard kill(parent, 0) != 0, errno == ESRCH else {
            staged.discard()
            return 1
        }

        // Lock the original inode and confirm it still occupies the installed path. A second
        // updater that prepared against the same bundle cannot swap in a different replacement.
        let lock = open(location.app.path, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC)
        defer { if lock >= 0 { close(lock) } }
        do {
            guard lock >= 0, flock(lock, LOCK_EX | LOCK_NB) == 0 else {
                throw UpdateError.failure("Another copy of Waffle is installing an update.")
            }
            guard !otherInstance(at: location) else {
                throw UpdateError.failure("Another Waffle window opened while the update was restarting.")
            }
            try UpdateArchive.verifyBundle(staged.candidate, version: staged.version, trust: UpdateTrust.read(bundle))
            try staged.replace(at: location) {
                let process = try launch(location.app, arguments: ["--waffle-update-ready", directory.lastPathComponent])
                try awaitReady(process, at: staged.readyFile)
            }
            staged.discard()
            return 0
        } catch {
            if UpdateLocation.Stamp.read(staged.candidate) != staged.original { staged.discard() }
            if UpdateLocation.Stamp.read(location.app) == staged.original {
                let manual = (error as? UpdateError).map { if case .manualDownload = $0 { return true }; return false } ?? false
                let flag = manual ? "--waffle-update-manual" : "--waffle-update-failed"
                if !otherInstance(at: location),
                   (try? launch(location.app, arguments: [flag, error.localizedDescription])) != nil { return 1 }
            }
            if let reportFailure { reportFailure(error.localizedDescription) }
            else { presentFailure(error.localizedDescription) }
            return 1
        }
    }

    @MainActor private static func presentFailure(_ detail: String) {
        let application = NSApplication.shared
        application.setActivationPolicy(.accessory)
        application.activate(ignoringOtherApps: true)
        let alert = NSAlert()
        alert.messageText = "Waffle couldn’t finish the update."
        alert.informativeText = detail
        alert.runModal()
    }
}
