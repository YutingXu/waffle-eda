import CryptoKit
import Foundation

private enum FixtureError: Error { case unexpected(String) }

private func require(_ predicate: Bool, _ label: String) throws {
    guard predicate else { throw FixtureError.unexpected(label) }
}

private func rejects(_ message: String, _ action: () throws -> Void) throws {
    do { try action() } catch {
        try require(error.localizedDescription.localizedCaseInsensitiveContains(message), "\(message): \(error)")
        return
    }
    throw FixtureError.unexpected("Expected an error about \(message)")
}

private func hex(_ bytes: some Sequence<UInt8>) -> String {
    bytes.map { String(format: "%02x", $0) }.joined()
}

private final class TransferFixture: URLProtocol {
    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func startLoading() {
        let headers = request.allHTTPHeaderFields ?? [:]
        guard request.httpMethod == "GET", !request.httpShouldHandleCookies,
              request.value(forHTTPHeaderField: "User-Agent") == "Mozilla/5.0",
              ["Authorization", "Cookie", "Referer"].allSatisfy({ request.value(forHTTPHeaderField: $0) == nil }),
              headers.values.allSatisfy({ !$0.contains("Waffle") }) else {
            client?.urlProtocol(self, didFailWithError: FixtureError.unexpected("The request sent identifying headers"))
            return
        }
        let url = request.url!, shortened = url.lastPathComponent == "truncated"
        let response = HTTPURLResponse(url: url, statusCode: 200, httpVersion: "HTTP/1.1", headerFields: nil)!
        client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: Data((shortened ? "ab" : "abcd").utf8))
        client?.urlProtocolDidFinishLoading(self)
    }
    override func stopLoading() {}
}

@main struct UpdaterTests {
    @MainActor static func main() async throws {
        let args = CommandLine.arguments
        let bundle = Bundle.main
        let fixtureRoot = bundle.bundleURL.deletingLastPathComponent()
        if args[1] == "--waffle-update-worker" {
            let result = UpdateRestart.complete(args, bundle: bundle, applications: fixtureRoot) { error in
                try? Data(error.utf8).write(to: fixtureRoot.appendingPathComponent("worker-error"))
            }
            exit(result)
        }
        if args[1] == "--fixture-handoff" {
            let location = UpdateLocation(app: bundle.bundleURL, applications: fixtureRoot)
            let staged = StagedUpdate(directory: location.stagingDirectory(named: args[2])!,
                                      original: UpdateLocation.Stamp.read(location.app)!, version: "1.2.0")
            try staged.handoff(using: bundle.executableURL!)
            return
        }
        if args[1] == "--waffle-update-failed" {
            try Data(args[2].utf8).write(to: fixtureRoot.appendingPathComponent("rollback"), options: .atomic)
            return
        }
        let root = URL(fileURLWithPath: CommandLine.arguments[1], isDirectory: true)
        let privateKey = Curve25519.Signing.PrivateKey()
        let trust = UpdateTrust(repository: "test/waffle", publicKey: hex(privateKey.publicKey.rawRepresentation),
                                signingLeaf: CommandLine.arguments[2])
        let assetName = "Waffle-1.2.0-macOS.zip"
        let contents = Data("abcd".utf8)
        let checksum = hex(SHA256.hash(data: contents))
        let url = trust.releases + "/download/v1.2.0/" + assetName
        let body = Data("""
          {"format":"atrium-release","version":1,"app":"1.2.0","formats":{"writes":"2.0"},
          "apiVersions":[1],"notes":["fixture"],"assets":[{"platform":"macos","name":"\(assetName)",
          "url":"\(url)","size":4,"sha256":"\(checksum)"}]}
          """.utf8)
        let raw = try privateKey.signature(for: body)
        let signed = raw.base64EncodedData()
        let update = try UpdateManifest.verified(body, signature: signed, trust: trust, installed: "1.1.0")
        try require(update?.manifest.app == "1.2.0", "Authentic newer manifest")
        let same = try UpdateManifest.verified(body, signature: signed, trust: trust, installed: "1.2.0")
        let downgrade = try UpdateManifest.verified(body, signature: signed, trust: trust, installed: "1.10.0")
        try require(same == nil && downgrade == nil, "Never offer an equal or older version")
        try rejects("signature") {
            _ = try UpdateManifest.verified(body + Data([32]), signature: signed, trust: trust, installed: "1.1.0")
        }
        var changed = raw
        changed[0] ^= 1
        try rejects("signature") {
            _ = try UpdateManifest.verified(body, signature: changed.base64EncodedData(), trust: trust, installed: "1.1.0")
        }
        let substituted = Data(String(decoding: body, as: UTF8.self).replacingOccurrences(of: "/test/waffle/", with: "/other/waffle/").utf8)
        let substitutedSignature = try privateKey.signature(for: substituted).base64EncodedData()
        try rejects("valid macOS update archive") {
            _ = try UpdateManifest.verified(substituted, signature: substitutedSignature, trust: trust, installed: "1.1.0")
        }
        print("PASS signed manifest, tampering, bad signature, release origin and downgrade")

        let fileURL = root.appendingPathComponent("download")
        try Data().write(to: fileURL)
        let transferFile = try FileHandle(forWritingTo: fileURL)
        defer { try? transferFile.close() }
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [TransferFixture.self]
        do {
            _ = try await UpdateTransfer.get(URL(string: trust.releases + "/truncated")!, limit: 4, label: "archive",
                                             to: transferFile, configuration: configuration)
            throw FixtureError.unexpected("Accepted a truncated download")
        } catch {
            try require(error.localizedDescription.contains("wrong size"), "Unexpected truncated download error: \(error)")
        }
        try rejects("wrong size") { try UpdateArchive.verify(fileURL, asset: update!.asset) }
        try transferFile.seek(toOffset: 0)
        _ = try await UpdateTransfer.get(URL(string: url)!, limit: 4, label: "archive", to: transferFile, configuration: configuration)
        try UpdateArchive.verify(fileURL, asset: update!.asset)
        try Data("abce".utf8).write(to: fileURL)
        try rejects("signed SHA-256") { try UpdateArchive.verify(fileURL, asset: update!.asset) }
        try rejects("disk space") { try UpdateArchive.checkSpace(root, needed: Int64.max) }
        try rejects("disk space") { throw UpdateError.posix(ENOSPC) }
        try require(!UpdateTransfer.allows(URL(string: "https://release-assets.githubusercontent.com.evil.example/test")),
                    "Redirects to arbitrary hosts must be blocked")
        print("PASS bounded anonymous transfer, truncated archive, wrong checksum and full disk")

        let signedApp = root.appendingPathComponent("Waffle.app", isDirectory: true)
        let extracted = try UpdateArchive.unpack(root.appendingPathComponent("update.zip"), in: root.appendingPathComponent("extracted"))
        try UpdateArchive.verifyBundle(extracted, version: "1.2.0", trust: trust)
        let wrongTrust = UpdateTrust(repository: trust.repository, publicKey: trust.publicKey, signingLeaf: String(repeating: "0", count: 40))
        try rejects("different macOS signing identity") { try UpdateArchive.verifyBundle(extracted, version: "1.2.0", trust: wrongTrust) }
        try rejects("different macOS signing identity") {
            try UpdateArchive.verifyBundle(root.appendingPathComponent("AdHoc.app"), version: "1.2.0", trust: trust)
        }
        try rejects("designated code signing requirement") {
            try UpdateArchive.verifyBundle(root.appendingPathComponent("OtherRequirement.app"), version: "1.2.0", trust: trust)
        }
        try rejects("bundle version") { try UpdateArchive.verifyBundle(extracted, version: "1.2.1", trust: trust) }
        let quarantine = "com.apple.quarantine"
        try require(getxattr(signedApp.path, quarantine, nil, 0, 0, XATTR_NOFOLLOW) > 0, "Original quarantine preserved")
        for url in [extracted, extracted.appendingPathComponent("Contents/MacOS/Waffle")] {
            try require(getxattr(url.path, quarantine, nil, 0, 0, XATTR_NOFOLLOW) == -1 && errno == ENOATTR,
                        "Extracted file carries quarantine")
        }
        print("PASS pinned signer, ad hoc, exact requirement, version and quarantine scope")

        let fm = FileManager.default
        let applications = root.appendingPathComponent("Applications", isDirectory: true)
        try fm.createDirectory(at: applications, withIntermediateDirectories: false)
        let installed = applications.appendingPathComponent("Waffle.app", isDirectory: true)
        try fm.copyItem(at: signedApp, to: installed)
        let location = UpdateLocation(app: installed, applications: applications)
        try require(location.writable && !UpdateLocation(app: installed).writable, "Only Applications installations can update")
        try fm.setAttributes([.posixPermissions: 0o500], ofItemAtPath: applications.path)
        try require(!location.writable, "Non-writable Applications uses verified Download")
        try fm.setAttributes([.posixPermissions: 0o700], ofItemAtPath: applications.path)
        let alias = applications.appendingPathComponent("Alias.app")
        try fm.createSymbolicLink(at: alias, withDestinationURL: signedApp)
        try require(!UpdateLocation(app: alias, applications: applications).writable, "Install cannot follow a symlink")
        let directory = try UpdateLocation.temp(in: applications)
        let staged = StagedUpdate(directory: directory, original: UpdateLocation.Stamp.read(installed)!, version: "1.2.0")
        try fm.createDirectory(at: staged.candidate.deletingLastPathComponent(), withIntermediateDirectories: false)
        try fm.moveItem(at: extracted, to: staged.candidate)
        let new = UpdateLocation.Stamp.read(staged.candidate)!
        try rejects("previous version was restored") {
            try staged.replace(at: location) {
                try require(UpdateLocation.Stamp.read(installed) == new &&
                            UpdateLocation.Stamp.read(staged.candidate) == staged.original, "Old bundle held across launch")
                let failed = try UpdateRestart.launch(installed, arguments: [])
                try UpdateRestart.awaitReady(failed, at: staged.readyFile, timeout: 0.3)
            }
        }
        try require(UpdateLocation.Stamp.read(installed) == staged.original &&
                    UpdateLocation.Stamp.read(staged.candidate) == new, "Failed launch rolls back both paths")
        let process = Process()
        process.executableURL = URL(fileURLWithPath: "/bin/sleep")
        process.arguments = ["10"]
        defer { if process.isRunning { process.terminate(); process.waitUntilExit() } }
        try staged.replace(at: location) {
            try process.run()
            try Data(String(process.processIdentifier).utf8).write(to: staged.readyFile, options: .atomic)
            try UpdateRestart.awaitReady(process, at: staged.readyFile, timeout: 0.3)
        }
        try require(UpdateLocation.Stamp.read(staged.candidate) == staged.original, "Backup remains available after readiness")
        staged.discard()
        try require(UpdateLocation.Stamp.read(installed) == new && !fm.fileExists(atPath: directory.path), "Commit deletes only backup")
        print("PASS unsupported and non-writable locations, atomic replacement, failed relaunch and ready cleanup")
        try await workerTests(root: root, trust: trust, signedApp: installed)
    }

    private static func workerTests(root: URL, trust: UpdateTrust, signedApp: URL) async throws {
        let fm = FileManager.default
        for succeeds in [false, true] {
            let applications = root.appendingPathComponent(succeeds ? "Commit" : "Rollback")
            let installed = applications.appendingPathComponent("Waffle.app", isDirectory: true)
            let contents = installed.appendingPathComponent("Contents", isDirectory: true)
            let executable = contents.appendingPathComponent("MacOS/Waffle")
            let resources = contents.appendingPathComponent("Resources")
            try fm.createDirectory(at: executable.deletingLastPathComponent(), withIntermediateDirectories: true)
            try fm.createDirectory(at: resources, withIntermediateDirectories: false)
            try fm.copyItem(at: URL(fileURLWithPath: CommandLine.arguments[0]), to: executable)
            try JSONSerialization.data(withJSONObject: ["publicKey": trust.publicKey, "signingLeaf": trust.signingLeaf,
                "repository": trust.repository]).write(to: resources.appendingPathComponent("update-trust.json"))
            try PropertyListSerialization.data(fromPropertyList: ["CFBundleIdentifier": "org.waffle.editor",
                "CFBundleExecutable": "Waffle", "CFBundleShortVersionString": "1.1.0", "CFBundlePackageType": "APPL"],
                format: .xml, options: 0).write(to: contents.appendingPathComponent("Info.plist"))
            let directory = try UpdateLocation.temp(in: applications)
            let original = UpdateLocation.Stamp.read(installed)!
            let staged = StagedUpdate(directory: directory, original: original, version: "1.2.0")
            try fm.createDirectory(at: staged.candidate.deletingLastPathComponent(), withIntermediateDirectories: false)
            let fixture = succeeds ? root.appendingPathComponent("Ready.app") : signedApp
            try fm.copyItem(at: fixture, to: staged.candidate)
            let new = UpdateLocation.Stamp.read(staged.candidate)
            let parent = try UpdateRestart.launch(installed, arguments: ["--fixture-handoff", directory.lastPathComponent])
            let rollback = applications.appendingPathComponent("rollback")
            let workerError = applications.appendingPathComponent("worker-error")
            let deadline = ProcessInfo.processInfo.systemUptime + 12
            while ProcessInfo.processInfo.systemUptime < deadline {
                if let error = try? String(contentsOf: workerError, encoding: .utf8) {
                    throw FixtureError.unexpected("Worker: " + error)
                }
                if !parent.isRunning && !fm.fileExists(atPath: directory.path) &&
                   (succeeds || fm.fileExists(atPath: rollback.path)) { break }
                try await Task.sleep(nanoseconds: 50_000_000)
            }
            try require(!parent.isRunning && parent.terminationStatus == 0, "Fixture editor handed off and exited")
            try require(!fm.fileExists(atPath: directory.path), "Worker cleaned up its private staging directory")
            try require(UpdateLocation.Stamp.read(installed) == (succeeds ? new : original), "Worker installed or restored the correct bundle")
            if !succeeds {
                try require((try String(contentsOf: rollback, encoding: .utf8)).contains("previous version was restored"),
                            "Worker relaunched the prior app with an explanation")
            }
        }
        print("PASS out-of-process handoff, ready commit, rollback and previous app relaunch")
    }
}
