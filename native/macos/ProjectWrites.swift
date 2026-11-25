import Foundation
import CryptoKit
import Darwin

/// Current native document names and the reject-only pre-release extension.
enum ProjectFileType {
    static let preferred = "waffle"
    static let readable = [preferred]
    static let documentKinds = ["wpcb":"pcb", "wsch":"schematic", "wlib":"library", "wdraw":"drawing", "wpanel":"panel"]
    static let preReleaseMessage = "This file is from a pre-release Waffle build; re-import the design from its source EDA"
    static func projectName(_ url: URL) -> Bool { accepts(url) || url.pathExtension.lowercased() == "atrium" }
    private static let documentSuffixes = documentKinds.keys.map { "." + $0 }
    static func documentName(_ url: URL) -> Bool {
        return documentSuffixes.contains(where:url.lastPathComponent.lowercased().hasSuffix)
    }
    static func accessSelection<T>(_ url: URL, _ read: () throws -> T) rethrows -> T {
        let scoped = url.startAccessingSecurityScopedResource()
        defer { if scoped { url.stopAccessingSecurityScopedResource() } }
        return try read()
    }
    private static let tokens = try! NSRegularExpression(pattern: #""(?:[^"\\]|\\.)*"|[{}\[\]]"#)
    private static let value = try! NSRegularExpression(pattern: #"^\s*:\s*(?:"([a-zA-Z0-9_.-]{1,48})"|(\[))"#)

    static func obsolete(_ bytes: Data) -> Bool {
        let b = bytes.prefix(65536)
        let text: String
        if b.starts(with:[255,254]) || b.starts(with:[254,255]) { text = String(data:b, encoding:.utf16) ?? "" }
        else { text = String(decoding:b,as:UTF8.self) }
        let input = text.trimmingCharacters(in:CharacterSet.whitespacesAndNewlines.union(CharacterSet(charactersIn:"\u{feff}"))) as NSString
        if input.range(of:#"^ATRIUM-JOURNAL 1(?:\r?\n|$)"#,options:.regularExpression).location == 0 { return true }
        guard input.hasPrefix("{") else { return false }
        var depth = 0, keys: [String:String] = [:], design = false
        tokens.enumerateMatches(in:input as String,range:NSRange(location:0,length:input.length)) { match,_,stop in
            guard let r = match?.range else { return }
            switch input.character(at:r.location) {
            case 123,91: depth += 1
            case 125,93: depth -= 1; if depth == 0 { stop.pointee = true }
            default:
                guard depth == 1, r.length <= 26 else { return }
                let key = input.substring(with:NSRange(location:r.location+1,length:r.length-2))
                guard ["format","kind","formatVersion","documents","library","sheets"].contains(key) else { return }
                let offset = NSMaxRange(r), tail = input.substring(with:NSRange(location:offset,length:min(input.length-offset,64))) as NSString
                guard let v = value.firstMatch(in:tail as String,range:NSRange(location:0,length:tail.length)) else { return }
                if v.range(at:1).location != NSNotFound { keys[key] = tail.substring(with:v.range(at:1)) }
                if v.range(at:2).location != NSNotFound && ["documents","library","sheets"].contains(key) { design = true }
            }
        }
        if ["atrium","waffle"].contains(keys["format"] ?? "") { return true }
        if keys["kind"] == "project" { return ["0.","1."].contains { keys["formatVersion"]?.hasPrefix($0) == true } }
        return keys["format"] == nil && design
    }

    static func checkSelection(_ selected: URL) throws {
        if documentName(selected) {
            try accessSelection(selected) {
                var entry = stat()
                let parent = selected.deletingLastPathComponent()
                guard !parent.pathComponents.contains(where: { component in
                    documentSuffixes.contains(where:component.lowercased().hasSuffix)
                }),
                      lstat(selected.path,&entry) == 0, (entry.st_mode & S_IFMT) == S_IFREG, entry.st_nlink == 1 else {
                    throw ProjectWrites.failure("Choose a regular Waffle document file.")
                }
            }
            return
        }
        var dir: ObjCBool = false
        guard FileManager.default.fileExists(atPath:selected.path,isDirectory:&dir) else { return }
        var url = selected
        if dir.boolValue {
            let names = try FileManager.default.contentsOfDirectory(atPath:selected.path).filter { !$0.hasPrefix(".") && ($0 as NSString).pathExtension.lowercased() == preferred }
            guard names.count == 1 else { return }
            url = selected.appendingPathComponent(names[0])
        }
        guard projectName(url) else { return }
        if !accepts(url) { throw ProjectWrites.failure(preReleaseMessage) }
        let fd = Darwin.open(url.path,O_RDONLY|O_NOFOLLOW|O_CLOEXEC|O_NONBLOCK)
        guard fd >= 0 else { throw ProjectWrites.failure("Cannot open the selected Waffle manifest.") }
        let stream = FileHandle(fileDescriptor:fd,closeOnDealloc:true)
        defer { try? stream.close() }
        var info = stat()
        guard fstat(fd,&info) == 0, (info.st_mode & S_IFMT) == S_IFREG else { throw ProjectWrites.failure("Select a regular Waffle manifest.") }
        let data = try stream.read(upToCount:65536) ?? Data()
        if obsolete(data) { throw ProjectWrites.failure(preReleaseMessage) }
        guard let end = data.firstIndex(of:10), let object = try? JSONSerialization.jsonObject(with:data[..<end]) as? [String:Any],
              object["kind"] as? String == "project", (object["formatVersion"] as? String)?.hasPrefix("2.") == true else {
            throw ProjectWrites.failure("Choose a Waffle folder-format project manifest.")
        }
    }

    static func accepts(_ url: URL) -> Bool { readable.contains(url.pathExtension.lowercased()) }
}

/// Common native file primitives for current foreign inputs, exports and library state.
enum ProjectWrites {
    static func digest(_ bytes: Data) -> Data { Data(SHA256.hash(data: bytes)) }
    static func hex(_ bytes: Data) -> String { bytes.map { String(format: "%02x", $0) }.joined() }

    static func canonical(_ url: URL) -> URL {
        url.standardizedFileURL.resolvingSymlinksInPath()
    }

    static func failure(_ message: String, code: Int = 3) -> NSError {
        NSError(domain: "AtriumProject", code: code, userInfo: [NSLocalizedDescriptionKey: message])
    }

    /// Write all bytes to an open descriptor. The caller owns flushing and closing it.
    static func writeAll(_ bytes: Data, to fd: Int32) -> Bool {
        bytes.withUnsafeBytes { raw in
            var offset = 0
            while offset < raw.count {
                let n = Darwin.write(fd, raw.baseAddress! + offset, raw.count - offset)
                if n < 0 {
                    if errno == EINTR { continue }
                    return false
                }
                offset += n
            }
            return true
        }
    }

    /// Writes bytes beside `destination` in a fresh temporary file (the old file's mode, or
    /// `mode`), flushes it to the drive (F_FULLFSYNC), renames it into place and flushes the
    /// directory. rename(2) replaces a symlink rather than following it.
    static func atomicWrite(_ bytes: Data, to destination: URL, mode: mode_t? = nil, collaborationLock: Bool = false) throws {
        let folder = destination.deletingLastPathComponent().path
        let prefix = collaborationLock ? ".waffle.pending-" : "." + destination.lastPathComponent + "."
        let suffix = collaborationLock ? ".waffle-lock" : ""
        var template = Array((folder + "/" + prefix + "XXXXXX" + suffix).utf8CString)
        let fd = collaborationLock ? mkstemps(&template, Int32(suffix.utf8.count)) : mkstemp(&template)
        guard fd >= 0 else { throw failure("Could not create a temporary file.") }
        let temporary = String(cString: template)
        var moved = false
        defer { if !moved { unlink(temporary) } }
        var info = stat()
        if let mode = mode { fchmod(fd, mode) }
        else if stat(destination.path, &info) == 0 { fchmod(fd, info.st_mode & 0o777) }
        else { let mask = umask(0); umask(mask); fchmod(fd, 0o666 & ~mask) }
        let written = writeAll(bytes, to: fd)
        let synced = fcntl(fd, F_FULLFSYNC) == 0 || fsync(fd) == 0
        Darwin.close(fd)
        guard written, synced else { throw failure("Could not write the file.") }
        guard rename(temporary, destination.path) == 0 else { throw failure("Could not replace the file.") }
        moved = true
        let dir = Darwin.open(folder, O_RDONLY | O_CLOEXEC)
        if dir >= 0 { _ = fcntl(dir, F_FULLFSYNC) == 0 || fsync(dir) == 0; Darwin.close(dir) }
    }
}

struct FileStamp: Equatable {
    let device: UInt64, inode: UInt64, size: Int, seconds: Int, nanoseconds: Int
    init?(_ url: URL) {
        var info = stat()
        guard stat(url.path, &info) == 0, (info.st_mode & S_IFMT) == S_IFREG else { return nil }
        self.init(info)
    }
    init(_ info: stat) {
        device = UInt64(info.st_dev); inode = UInt64(info.st_ino); size = Int(info.st_size)
        seconds = Int(info.st_mtimespec.tv_sec); nanoseconds = Int(info.st_mtimespec.tv_nsec)
    }
    func sameFile(_ other: FileStamp?) -> Bool {
        guard let other = other else { return false }
        return device == other.device && inode == other.inode
    }
}

final class AltiumCopySource {
    let token = UUID().uuidString
    let url: URL
    private let canonicalURL: URL
    private let handle: FileHandle
    private let device: dev_t
    private let inode: ino_t

    init(_ url: URL) throws {
        self.url = url.standardizedFileURL
        canonicalURL = try Self.destinationURL(url)
        handle = try FileHandle(forReadingFrom: url)
        var origin = stat()
        guard fstat(handle.fileDescriptor, &origin) == 0 else {
            throw NSError(domain: NSPOSIXErrorDomain, code: Int(errno))
        }
        device = origin.st_dev
        inode = origin.st_ino
    }

    func read() throws -> Data {
        try handle.seek(toOffset: 0)
        return try handle.readToEnd() ?? Data()
    }

    private static func destinationURL(_ selected: URL, depth: Int = 0) throws -> URL {
        guard depth < 40 else { throw NSError(domain: NSPOSIXErrorDomain, code: Int(ELOOP)) }
        if let existing = realpath(selected.path, nil) {
            defer { free(existing) }
            return URL(fileURLWithPath: String(cString: existing))
        }
        guard errno == ENOENT else { throw NSError(domain: NSPOSIXErrorDomain, code: Int(errno)) }
        let parent = selected.deletingLastPathComponent()
        if let target = try? FileManager.default.destinationOfSymbolicLink(atPath: selected.path) {
            let url = target.hasPrefix("/") ? URL(fileURLWithPath: target) : parent.appendingPathComponent(target)
            return try destinationURL(url, depth: depth + 1)
        }
        guard let directory = realpath(parent.path, nil) else {
            throw NSError(domain: NSPOSIXErrorDomain, code: Int(errno))
        }
        defer { free(directory) }
        return URL(fileURLWithPath: String(cString: directory), isDirectory: true).appendingPathComponent(selected.lastPathComponent)
    }

    func saveCopy(_ bytes: Data, to selected: URL) throws {
        let destination = try Self.destinationURL(selected)
        var existing = stat()
        let exists = stat(destination.path, &existing) == 0
        if !exists && errno != ENOENT { throw NSError(domain: NSPOSIXErrorDomain, code: Int(errno)) }
        var currentSource = stat()
        let originalPathNowAliasesDestination = exists && stat(url.path, &currentSource) == 0
            && existing.st_dev == currentSource.st_dev && existing.st_ino == currentSource.st_ino
        guard selected.standardizedFileURL != url, destination != canonicalURL,
              !originalPathNowAliasesDestination,
              !(exists && existing.st_dev == device && existing.st_ino == inode) else {
            throw NSError(domain: "AtriumSource", code: 1, userInfo: [
                NSLocalizedDescriptionKey: "Choose a different destination. This is the original Altium source."
            ])
        }
        guard selected.pathExtension.lowercased() == url.pathExtension.lowercased() else {
            throw NSError(domain: "AtriumSource", code: 2, userInfo: [
                NSLocalizedDescriptionKey: "The exported copy must have the same extension as its source."
            ])
        }
        try bytes.write(to: destination, options: .atomic)
    }
}
