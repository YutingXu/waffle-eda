import Foundation
import Darwin
import Security

enum AICredentials {
    static let maxBytes = 4096
    private static let service = "org.waffle.editor.ai-provider"
    static func validProvider(_ value: Any?) -> String? {
        guard let provider = value as? String, provider.utf8.count <= 192,
              provider.range(of: #"\A[A-Za-z0-9_.-]+:[a-z][a-z0-9-]{0,39}:[a-f0-9]{64}\z"#, options: .regularExpression) != nil else { return nil }
        return provider
    }
    static func label(_ provider: String) -> String { provider.split(separator: ":").dropLast().joined(separator: ":") }
    private static func query(_ provider: String) -> [String: Any] {
        [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: service, kSecAttrAccount as String: provider]
    }
    static func load(_ provider: String) throws -> String? {
        var find = query(provider)
        find[kSecReturnData as String] = true
        find[kSecMatchLimit as String] = kSecMatchLimitOne
        var value: CFTypeRef?
        let status = SecItemCopyMatching(find as CFDictionary, &value)
        if status == errSecItemNotFound { return nil }
        guard status == errSecSuccess, let data = value as? Data, let secret = String(data: data, encoding: .utf8) else {
            throw HostFiles.failure("The system keychain is unavailable.")
        }
        return secret
    }
    static func store(_ secret: String, _ provider: String) throws {
        guard !secret.isEmpty, secret.utf8.count <= maxBytes,
              secret.unicodeScalars.allSatisfy({ !CharacterSet.controlCharacters.contains($0) }) else {
            throw HostFiles.failure("Enter a single provider credential of at most 4096 bytes.")
        }
        let lookup = query(provider), data = Data(secret.utf8)
        var status = SecItemUpdate(lookup as CFDictionary, [kSecValueData as String: data] as CFDictionary)
        if status == errSecItemNotFound {
            var entry = lookup
            entry[kSecValueData as String] = data
            status = SecItemAdd(entry as CFDictionary, nil)
        }
        guard status == errSecSuccess else { throw HostFiles.failure("The credential could not be stored in the system keychain.") }
    }
    static func forget(_ provider: String) throws {
        let status = SecItemDelete(query(provider) as CFDictionary)
        guard status == errSecSuccess || status == errSecItemNotFound else {
            throw HostFiles.failure("The credential could not be removed from the system keychain.")
        }
    }
}

/// The application's bundled translator registry authorizes design selections.
struct TranslatorFiles {
    private(set) var types = Set<String>(), libraries = Set<String>()

    init(_ url: URL?) {
        guard let url = url, let bytes = try? Data(contentsOf: url),
              let rows = (try? JSONSerialization.jsonObject(with: bytes)) as? [[String: Any]] else { return }
        types.formUnion(["waffle","zip"]) // A native project archive is opened by the folder reader.
        types.formUnion(ProjectFileType.documentKinds.keys)
        for row in rows where row["import"] as? Bool == true && row["id"] as? String != "legacy" {
            let extensions = Set((row["extensions"] as? [String] ?? []).compactMap(Self.extensionType))
            types.formUnion(extensions.subtracting(["atrium"]))
            libraries.formUnion(extensions.intersection((row["libraryExtensions"] as? [String] ?? []).compactMap(Self.extensionType)))
        }
    }

    private static func extensionType(_ value: String) -> String? {
        guard value.range(of: #"^\.[a-zA-Z0-9_-]{1,30}$"#, options: .regularExpression) != nil else { return nil }
        return String(value.dropFirst()).lowercased()
    }

    func accepts(_ url: URL) -> Bool { types.contains(url.pathExtension.lowercased()) }

    func openTypes(_ requested: Any?) throws -> Set<String> {
        guard let requested = requested else { return types }
        if requested is NSNull { return types }
        guard let list = requested as? [String], !list.isEmpty, list.count <= 64 else {
            throw HostFiles.failure("Unrecognised import file type.")
        }
        let choices = list.compactMap(Self.extensionType)
        guard choices.count == list.count, Set(choices).isSubset(of: types) else {
            throw HostFiles.failure("Unrecognised import file type.")
        }
        return Set(choices)
    }
}

enum AltiumProjectFiles {
    static let types: Set<String> = ["prjpcb", "schdoc", "pcbdoc", "schlib", "pcblib", "step", "stp"]
    static let maxFiles = 1024, manifestCap = 8 * 1024 * 1024
    static func include(_ manifest: URL, bytes: Data, selected: [URL], files: inout [[String: String]], remaining: inout Int, retained: ((URL,Data)->String)? = nil) throws {
        let root = ProjectWrites.canonical(manifest.deletingLastPathComponent())
        let encoding: String.Encoding = bytes.starts(with: [0xff, 0xfe]) ? .utf16LittleEndian :
            bytes.starts(with: [0xfe, 0xff]) ? .utf16BigEndian : .utf8
        guard let text = String(data: bytes, encoding: encoding) ?? String(data: bytes, encoding: .windowsCP1252) else { return }
        let selectedPaths = selected.map(ProjectWrites.canonical)
        var seen = Set<URL>(), documentSection = true
        for line in text.components(separatedBy: .newlines) {
            let s = line.trimmingCharacters(in: .whitespacesAndNewlines.union(CharacterSet(charactersIn: "\u{feff}")))
            if s.hasPrefix("[") {
                documentSection = s.range(of: #"^\[Document[0-9]+\]$"#, options: [.regularExpression, .caseInsensitive]) != nil
                continue
            }
            let pair = s.split(separator: "=", maxSplits: 1, omittingEmptySubsequences: false)
            guard documentSection, pair.count == 2, pair[0].trimmingCharacters(in: .whitespaces).lowercased() == "documentpath" else { continue }
            var path = pair[1].trimmingCharacters(in: .whitespaces)
            if path.hasPrefix("\""), path.hasSuffix("\""), path.count >= 2 { path = String(path.dropFirst().dropLast()) }
            path = path.replacingOccurrences(of: "\\", with: "/")
            guard !path.hasPrefix("/"), !path.contains(":"), path.utf8.count <= 4096,
                  path.rangeOfCharacter(from: .controlCharacters) == nil,
                  ["schdoc","pcbdoc","schlib","pcblib","step","stp"].contains((path as NSString).pathExtension.lowercased()) else { continue }
            let member = ProjectWrites.canonical(root.appendingPathComponent(path))
            guard member.pathComponents.starts(with: root.pathComponents), member.pathComponents.count > root.pathComponents.count,
                  seen.insert(member).inserted else { continue }
            if let index = selectedPaths.firstIndex(of: member) { files[index]["altiumPath"] = path; continue }
            guard let size = try? member.resourceValues(forKeys: [.fileSizeKey]).fileSize else { continue }
            if files.count >= maxFiles { throw HostFiles.failure("The Altium project has too many referenced documents.") }
            if size > remaining { throw HostFiles.failure("The referenced Altium documents exceed the desktop import size limit.") }
            guard let (data, _) = try? HostFiles.readRegular(member, cap: remaining) else { continue }
            remaining -= data.count
            var item = ["name": member.lastPathComponent, "altiumPath": path, "data": data.base64EncodedString()]
            item["retainedInputToken"] = retained?(member,data)
            files.append(item)
        }
    }
}

/// Host-side state that page JavaScript can use but never name freely: the recent-projects
/// list, the recovery sidecar next to the open project and the library files the user chose.
/// Every path page code sends is checked against a list only native dialogs (or the user's
/// own File menu) add to, then opened without following a final symlink.
enum HostFiles {
    static let recentLimit = 12
    static let allowLimit = 200
    static let projectReadCap = 256 * 1024 * 1024
    static let libraryReadCap = 16 * 1024 * 1024
    static let libraryTypes: Set<String> = ["atrlib", "json"]

    /// Where the lists live. Tests and the harness point this at a scratch folder.
    static var supportDirectory: URL = {
        let base = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask).first
            ?? URL(fileURLWithPath: NSHomeDirectory()).appendingPathComponent("Library/Application Support")
        return base.appendingPathComponent("Waffle", isDirectory: true)
    }()

    static func failure(_ message: String, code: Int = 1) -> NSError {
        NSError(domain: "AtriumHost", code: code, userInfo: [NSLocalizedDescriptionKey: message])
    }

    /// An absolute, canonical path from page input, or nil. Rejects relative paths, NUL bytes,
    /// `.`/`..` components and over-long strings before resolving symlinks.
    static func checkedPath(_ value: Any?) -> URL? {
        guard let text = value as? String, text.hasPrefix("/"), text.utf8.count <= 4096,
              !text.contains("\0") else { return nil }
        let parts = text.split(separator: "/", omittingEmptySubsequences: true)
        guard !parts.contains(where: { $0 == "." || $0 == ".." }) else { return nil }
        return ProjectWrites.canonical(URL(fileURLWithPath: text))
    }

    /// Reads a regular file without following a symlink at the final component, with a size cap.
    static func readRegular(_ url: URL, cap: Int, singleLink: Bool = false, check: () throws -> Void = {}) throws -> (Data, Date) {
        let (bytes, modified, _) = try readRegularFile(url, cap: cap, singleLink: singleLink, check: check)
        return (bytes, modified)
    }

    static func readRegularFile(_ url: URL, cap: Int, singleLink: Bool = false, check: () throws -> Void = {}) throws -> (Data, Date, FileStamp) {
        try check()
        let fd = Darwin.open(url.path, O_RDONLY | O_NOFOLLOW | O_CLOEXEC | O_NONBLOCK)
        guard fd >= 0 else {
            throw errno == ELOOP ? failure("The file is now a symbolic link. Choose it again.") : failure("The file could not be opened.")
        }
        let handle = FileHandle(fileDescriptor: fd, closeOnDealloc: true)
        var info = stat()
        guard fstat(fd, &info) == 0, (info.st_mode & S_IFMT) == S_IFREG else { throw failure("That path is not a regular file.") }
        guard !singleLink || info.st_nlink == 1 else { throw failure("The output has multiple links.") }
        guard info.st_size <= off_t(cap) else { throw failure("The file is too large.") }
        var bytes = Data()
        while let chunk = try handle.read(upToCount: min(cap - bytes.count + 1, 1024 * 1024)), !chunk.isEmpty {
            try check()
            guard chunk.count <= cap - bytes.count else { throw failure("The file is too large.") }
            bytes.append(chunk)
        }
        try check()
        let modified = Date(timeIntervalSince1970: TimeInterval(info.st_mtimespec.tv_sec) + TimeInterval(info.st_mtimespec.tv_nsec) / 1e9)
        return (bytes, modified, FileStamp(info))
    }

    /// Writes bytes beside `destination` in a fresh 0600 temporary file, then renames it into place.
    /// rename(2) replaces a symlink rather than following it, so the write never leaves the folder.
    static func atomicWrite(_ bytes: Data, to destination: URL) throws {
        let folder = destination.deletingLastPathComponent().path
        var template = Array((folder + "/." + destination.lastPathComponent + ".XXXXXX").utf8CString)
        let fd = mkstemp(&template)
        guard fd >= 0 else { throw failure("Could not create a temporary file.") }
        let temporary = String(cString: template)
        var moved = false
        defer { if !moved { unlink(temporary) } }
        fchmod(fd, 0o600)
        let written = ProjectWrites.writeAll(bytes, to: fd)
        let synced = fsync(fd) == 0
        Darwin.close(fd)
        guard written, synced else { throw failure("Could not write the file.") }
        guard rename(temporary, destination.path) == 0 else { throw failure("Could not replace the file.") }
        moved = true
    }

    static func loadJSON(_ name: String, cap: Int = 1024 * 1024) -> [[String: Any]] {
        let url = supportDirectory.appendingPathComponent(name)
        guard let (data, _) = try? readRegular(url, cap: cap),
              let list = (try? JSONSerialization.jsonObject(with: data)) as? [[String: Any]] else { return [] }
        return list
    }

    static func storeJSON(_ name: String, _ list: [[String: Any]]) {
        do {
            try FileManager.default.createDirectory(at: supportDirectory, withIntermediateDirectories: true,
                                                    attributes: [.posixPermissions: 0o700])
            let data = try JSONSerialization.data(withJSONObject: list, options: [.prettyPrinted, .sortedKeys, .withoutEscapingSlashes])
            try atomicWrite(data, to: supportDirectory.appendingPathComponent(name))
        } catch { /* a list that can't be stored only costs the user a menu entry */ }
    }
}

/// Recent projects: canonical paths of native projects and Altium manifests chosen by the user.
final class RecentProjects {
    private let file = "recent-projects.json"
    private(set) var entries: [(name: String, path: String, openedAt: Double)] = []

    init() { reload() }

    func reload() {
        entries = HostFiles.loadJSON(file).compactMap { item in
            guard let path = item["path"] as? String, path.hasPrefix("/"), (ProjectFileType.readable + ["prjpcb"]).contains((path as NSString).pathExtension.lowercased()) else { return nil }
            return ((path as NSString).lastPathComponent, path, item["openedAt"] as? Double ?? 0)
        }
        entries = Array(entries.prefix(HostFiles.recentLimit))
    }

    func note(_ url: URL, at date: Date = Date()) {
        let path = ProjectWrites.canonical(url).path
        guard (ProjectFileType.readable + ["prjpcb"]).contains((path as NSString).pathExtension.lowercased()) else { return }
        entries.removeAll { $0.path == path }
        entries.insert((url.lastPathComponent, path, (date.timeIntervalSince1970 * 1000).rounded()), at: 0)
        entries = Array(entries.prefix(HostFiles.recentLimit))
        save()
    }

    func clear() { entries = []; save() }

    /// Cached Welcome metadata skips filesystem checks. Opening validates the selected path.
    func listing(checkAvailability: Bool = true) -> [[String: Any]] {
        entries.filter { !checkAvailability || FileManager.default.fileExists(atPath: $0.path) }
            .map { ["name": $0.name, "path": $0.path, "openedAt": $0.openedAt] }
    }

    /// The URL for a page-supplied path, only if it is a remembered project that is still a regular file.
    func allowed(_ value: Any?) throws -> URL {
        guard let url = HostFiles.checkedPath(value), entries.contains(where: { $0.path == url.path }) else {
            throw HostFiles.failure("That project is not in the recent files list.")
        }
        var info = stat()
        guard lstat(url.path, &info) == 0, (info.st_mode & S_IFMT) == S_IFREG else {
            throw HostFiles.failure("That recent project is no longer available.")
        }
        guard info.st_size <= off_t(HostFiles.projectReadCap) else { throw HostFiles.failure("The file is too large.") }
        return url
    }

    private func save() {
        HostFiles.storeJSON(file, entries.map { ["name": $0.name, "path": $0.path, "openedAt": $0.openedAt] })
    }
}

/// Library files (.atrlib, .json) chosen in an open panel for the library sources, readable again later.
final class LibraryReads {
    private let file = "library-sources.json"
    private var paths: [String] = []

    init() {
        paths = HostFiles.loadJSON(file).compactMap { $0["path"] as? String }.filter { $0.hasPrefix("/") }
    }

    func remember(_ url: URL) {
        let path = ProjectWrites.canonical(url).path
        guard HostFiles.libraryTypes.contains((path as NSString).pathExtension.lowercased()) else { return }
        paths.removeAll { $0 == path }
        paths.insert(path, at: 0)
        paths = Array(paths.prefix(HostFiles.allowLimit))
        HostFiles.storeJSON(file, paths.map { ["path": $0] })
    }

    func contains(_ path: String) -> Bool { paths.contains(path) }

    /// The file's name and text, if the canonical path was chosen before, has a library extension,
    /// is a regular file under the size cap and holds JSON.
    func read(_ value: Any?) throws -> [String: String] {
        guard let url = HostFiles.checkedPath(value), paths.contains(url.path) else {
            throw HostFiles.failure("Open this library file again with Open library file… to allow reloading it.")
        }
        guard HostFiles.libraryTypes.contains(url.pathExtension.lowercased()) else { throw HostFiles.failure("Only .atrlib and .json library files can be reloaded.") }
        let (bytes, _) = try HostFiles.readRegular(url, cap: HostFiles.libraryReadCap)
        guard (try? JSONSerialization.jsonObject(with: bytes, options: [.fragmentsAllowed])) is [String: Any],
              let text = String(data: bytes, encoding: .utf8) else { throw HostFiles.failure("This is not a JSON library file.") }
        return ["name": url.lastPathComponent, "path": url.path, "text": text]
    }
}

/// Folder grants come from the native picker. A grant records the chosen directory's identity and
/// whether it holds libraries, is an explicit save destination, or holds STEP models.
enum LibraryFolders {
    static let queue = DispatchQueue(label: "com.atrium.library-folders", qos: .userInitiated)
    static let purposes = ["read", "write", "models"]
    private static let file = "library-folders.json"
    private static let dirFlags = O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC

    private static func grants() -> [[String: Any]] { HostFiles.loadJSON(file) }
    static func remember(_ url: URL, purpose: String) throws -> [String: String] {
        let root = ProjectWrites.canonical(url)
        let fd = open(root.path, dirFlags)
        guard fd >= 0 else { throw HostFiles.failure("The selected folder could not be opened.") }
        defer { close(fd) }
        var info = stat()
        guard fstat(fd, &info) == 0 else { throw HostFiles.failure("The selected folder could not be opened.") }
        let bookmark = (try? url.bookmarkData(options: [.withSecurityScope])) ?? (try? root.bookmarkData())
        guard let bookmark = bookmark else { throw HostFiles.failure("The selected folder could not be remembered.") }
        let group = grants()
        let key = String(info.st_dev) + ":" + String(info.st_ino)
        let token = group.first { $0["key"] as? String == key && $0["purpose"] as? String == purpose }?["grant"] as? String ?? UUID().uuidString.lowercased()
        let row = ["grant": token, "key": key, "bookmark": bookmark.base64EncodedString(), "purpose": purpose]
        HostFiles.storeJSON(file, [row] + Array(group.filter { $0["grant"] as? String != token }.prefix(HostFiles.allowLimit - 1)))
        return ["grant": token, "name": root.lastPathComponent]
    }
    static func forget(_ grant: Any?) {
        guard let token = grant as? String else { return }
        HostFiles.storeJSON(file, grants().filter { $0["grant"] as? String != token })
    }
    private static func access<T>(_ grant: Any?, _ run: (Int32, URL, String) throws -> T) throws -> T {
        guard let token = grant as? String, let entry = grants().first(where: { $0["grant"] as? String == token }),
              let encoded = entry["bookmark"] as? String, let bookmark = Data(base64Encoded: encoded),
              let purpose = entry["purpose"] as? String else { throw HostFiles.failure("Choose this library folder again to allow access.") }
        var stale = false
        let url = (try? URL(resolvingBookmarkData: bookmark, options: [.withSecurityScope, .withoutUI], relativeTo: nil, bookmarkDataIsStale: &stale)) ??
            (try? URL(resolvingBookmarkData: bookmark, options: [.withoutUI], relativeTo: nil, bookmarkDataIsStale: &stale))
        guard let url = url else { throw HostFiles.failure("The library folder could not be opened.") }
        let scoped = url.startAccessingSecurityScopedResource()
        defer { if scoped { url.stopAccessingSecurityScopedResource() } }
        let root = ProjectWrites.canonical(url), fd = open(root.path, dirFlags)
        guard fd >= 0 else { throw HostFiles.failure("The library folder could not be opened.") }
        defer { close(fd) }
        var info = stat()
        guard fstat(fd, &info) == 0, entry["key"] as? String == String(info.st_dev) + ":" + String(info.st_ino)
        else { throw HostFiles.failure("The library folder changed. Choose it again to allow access.") }
        return try run(fd, root, purpose)
    }
    private static func parts(_ value: Any?) -> [String]? {
        guard let path = value as? String, !path.isEmpty, path.utf8.count <= 4096,
              !path.contains("\\"), path.rangeOfCharacter(from: .controlCharacters) == nil else { return nil }
        let parts = path.components(separatedBy: "/")
        guard parts.count <= 24, parts.allSatisfy({ !$0.isEmpty && !$0.hasPrefix(".") }) else { return nil }
        return parts
    }
    private static func cap(_ p: [String], purpose: String) -> Int? {
        let name = p.last?.lowercased() ?? ""
        if purpose == "models" { return name.hasSuffix(".step") || name.hasSuffix(".stp") ? 32 << 20 : nil }
        let ext = (name as NSString).pathExtension
        if ["atrlib", "schlib", "pcblib", "kicad_sym"].contains(ext) { return 64 << 20 }
        if ext == "kicad_mod" { return 8 << 20 }
        if ["license", "licence", "license.md", "licence.md", "license.txt", "licence.txt"].contains(name) { return 64 << 10 }
        if ["sym-lib-table", "fp-lib-table"].contains(name) || p.count == 1 && name == "library.json" ||
            ext == "json" && p.count > 1 && p[p.count - 2] == "components" { return 4 << 20 }
        return nil
    }
    private static func skip(_ name: String) -> Bool {
        name.hasPrefix(".") || name == "node_modules" || name == "__pycache__" || name.hasSuffix(".3dshapes")
    }
    static func list(_ grant: Any?) throws -> [String: Any] {
        try access(grant) { fd, root, purpose in
            guard purpose != "models" else { throw HostFiles.failure("This is a 3D model folder.") }
            var entries = [[String: Any]]()
            func walk(_ fd: Int32, _ prefix: [String]) throws {
                let copy = dup(fd)
                guard copy >= 0 else { return }
                guard let dir = fdopendir(copy) else { close(copy); return }
                defer { closedir(dir) }
                while let item = readdir(dir) {
                    let name = withUnsafePointer(to: item.pointee.d_name) {
                        $0.withMemoryRebound(to: CChar.self, capacity: Int(MAXNAMLEN) + 1) { String(validatingUTF8: $0) }
                    }
                    guard let name = name, !skip(name), parts(name) != nil else { continue }
                    let path = prefix + [name]
                    var info = stat()
                    guard fstatat(fd, name, &info, AT_SYMLINK_NOFOLLOW) == 0 else { continue }
                    let kind = info.st_mode & S_IFMT
                    if kind == S_IFDIR && path.count < 24 {
                        let child = openat(fd, name, dirFlags)
                        if child >= 0 {
                            defer { close(child) }
                            try walk(child, path)
                        }
                    } else if kind == S_IFREG && cap(path, purpose: purpose) != nil {
                        guard entries.count < 200000 else { throw HostFiles.failure("The folder contains too many library files.") }
                        let ms = Double(info.st_mtimespec.tv_sec) * 1000 + Double(info.st_mtimespec.tv_nsec) / 1e6
                        entries.append(["path": path.joined(separator: "/"), "size": info.st_size, "mtime": ms])
                    }
                }
            }
            try walk(fd, [])
            return ["root": root.path, "entries": entries]
        }
    }
    private static func parent(_ root: Int32, _ p: [String]) throws -> Int32 {
        var fd = dup(root)
        for dir in p.dropLast() where fd >= 0 {
            let next = openat(fd, dir, dirFlags)
            close(fd); fd = next
        }
        guard fd >= 0 else { throw HostFiles.failure("The library file's folder could not be opened.") }
        return fd
    }
    static func read(_ grant: Any?, _ value: Any?) throws -> [[String: String]] {
        guard let paths = value as? [String], paths.count <= 64 else { throw HostFiles.failure("Invalid library file request.") }
        return try access(grant) { root, _, purpose in
            var remaining = 64 << 20
            return paths.map { path in
                do {
                    guard let p = parts(path), let limit = cap(p, purpose: purpose) else { throw HostFiles.failure("Invalid library file path.") }
                    let dir = try parent(root, p); defer { close(dir) }
                    let fd = openat(dir, p[p.count - 1], O_RDONLY | O_CLOEXEC | O_NONBLOCK | O_NOFOLLOW)
                    guard fd >= 0 else { throw HostFiles.failure("The library file could not be opened.") }
                    let handle = FileHandle(fileDescriptor: fd, closeOnDealloc: true)
                    var info = stat()
                    guard fstat(fd, &info) == 0, (info.st_mode & S_IFMT) == S_IFREG, info.st_size <= min(limit, remaining)
                    else { throw HostFiles.failure("The library file could not be read or is too large.") }
                    let max = min(limit, remaining)
                    var bytes = Data()
                    while let chunk = try handle.read(upToCount: min(1024 * 1024, max + 1 - bytes.count)), !chunk.isEmpty {
                        guard bytes.count + chunk.count <= max else { throw HostFiles.failure("The library file is too large.") }
                        bytes.append(chunk)
                    }
                    remaining -= bytes.count
                    return ["data": bytes.base64EncodedString()]
                } catch { return ["error": error.localizedDescription] }
            }
        }
    }
    static func write(_ grant: Any?, _ value: Any?, _ text: Any?) throws {
        guard let p = parts(value), p.count == 2, p[0] == "components", p[1].lowercased().hasSuffix(".json"),
              let text = text as? String, text.utf8.count <= 4 << 20,
              (try? JSONSerialization.jsonObject(with: Data(text.utf8))) is [String: Any] else {
            throw HostFiles.failure("Save a component JSON file inside the components folder.")
        }
        try access(grant) { root, _, purpose in
            guard purpose == "write" else { throw HostFiles.failure("Choose a library folder to save to.") }
            if mkdirat(root, "components", 0o700) != 0 && errno != EEXIST { throw HostFiles.failure("Could not create the components folder.") }
            let dir = try parent(root, p); defer { close(dir) }
            let temp = ".atrium-" + UUID().uuidString
            let fd = openat(dir, temp, O_WRONLY | O_CREAT | O_EXCL | O_CLOEXEC | O_NOFOLLOW, 0o600)
            guard fd >= 0 else { throw HostFiles.failure("Could not create a temporary library file.") }
            defer { close(fd); unlinkat(dir, temp, 0) }
            let handle = FileHandle(fileDescriptor: fd, closeOnDealloc: false)
            try handle.write(contentsOf: Data(text.utf8))
            try handle.synchronize()
            guard renameat(dir, temp, dir, p[1]) == 0 else { throw HostFiles.failure("Could not save the component.") }
            _ = fsync(dir)
        }
    }
}

/// The hardware architecture for a user-requested support report. WKWebView's UA is not authoritative.
enum SupportDiagnostics {
    static func displayCount(_ count: Int) -> String {
        switch count {
        case 1: return "one"
        case 2: return "two"
        case 3...: return "three-or-more"
        default: return "unknown"
        }
    }

    static var architecture: String {
        #if arch(arm64)
        return "arm64"
        #elseif arch(x86_64)
        var translated: Int32 = 0
        var size = MemoryLayout<Int32>.size
        if sysctlbyname("sysctl.proc_translated", &translated, &size, nil, 0) != 0 {
            return errno == ENOENT ? "x64" : "unknown"
        }
        if translated == 1 { return "arm64" }
        return translated == 0 ? "x64" : "unknown"
        #else
        return "unknown"
        #endif
    }
}

/// WebKit failures are recorded by the shell even when the page cannot run JavaScript.
enum CrashHistory {
    private static let limit = 32
    private static let file = "renderer-crashes.json"

    static func listing() -> [[String: Any]] {
        Array(HostFiles.loadJSON(file, cap: 16 * 1024).suffix(limit))
    }

    static func counts() -> [String: Int] {
        var result = ["terminated": 0, "unresponsive": 0]
        for row in listing() where row["kind"] as? String == "renderer" && row["type"] as? String == "macOS" {
            if let reason = row["reason"] as? String, let count = result[reason] { result[reason] = count + 1 }
        }
        return result
    }

    /// reason: "terminated" (a crash or the system), "unresponsive" (ended from the not-responding sheet).
    static func noteTermination(reason: String = "terminated") {
        let at = Int64(Date().timeIntervalSince1970 * 1000)
        let rows = listing() + [["at": at, "kind": "renderer", "type": "macOS", "reason": reason]]
        HostFiles.storeJSON(file, Array(rows.suffix(limit)))
        NSLog("Waffle: WebKit web content process terminated.")
    }
}

/// Host-owned collaboration lock and presence files.
final class CollabLocks {
    static func suffix(for project: URL) -> String {
        ".waffle-lock"
    }
    static let textCap = 16 * 1024, dataCap = 8 * 1024, listCap = 256
    let session = UUID().uuidString.lowercased()
    private(set) lazy var machine: String = CollabLocks.machineID()

    static func validKey(_ value: Any?) -> String? {
        guard let key = value as? String, !key.isEmpty, key.utf8.count <= 64 else { return nil }
        let bytes = Array(key.utf8)
        func alnum(_ c: UInt8) -> Bool { (48...57).contains(c) || (65...90).contains(c) || (97...122).contains(c) }
        guard alnum(bytes[0]), bytes.allSatisfy({ alnum($0) || $0 == 45 || $0 == 95 }) else { return nil }
        return key
    }

    static func url(project: URL, key: String) -> URL {
        return project.deletingLastPathComponent().appendingPathComponent(project.lastPathComponent + "." + key + suffix(for: project))
    }

    static func machineID() -> String {
        let file = HostFiles.supportDirectory.appendingPathComponent("machine-id")
        if let (data, _) = try? HostFiles.readRegular(file, cap: 128),
           let text = String(data: data, encoding: .utf8)?.trimmingCharacters(in: .whitespacesAndNewlines),
           text.count >= 16, text.count <= 64, validKey(text) != nil { return text }
        let id = UUID().uuidString.lowercased()
        try? FileManager.default.createDirectory(at: HostFiles.supportDirectory, withIntermediateDirectories: true,
                                                 attributes: [.posixPermissions: 0o700])
        try? HostFiles.atomicWrite(Data(id.utf8), to: file)
        return id
    }

    private static func millis(_ date: Date) -> Double { (date.timeIntervalSince1970 * 1000).rounded() }

    /// The lock and presence files beside the project, and the project file's stat.
    func listing(project: URL) -> [String: Any] {
        let folder = project.deletingLastPathComponent()
        let prefix = project.lastPathComponent + ".", suffix = Self.suffix(for: project)
        var locks: [[String: Any]] = []
        let names = (try? FileManager.default.contentsOfDirectory(atPath: folder.path)) ?? []
        for name in names.sorted() where name.hasPrefix(prefix) && name.hasSuffix(suffix) && locks.count < Self.listCap {
            let key = String(name.dropFirst(prefix.count).dropLast(suffix.count))
            guard Self.validKey(key) != nil,
                  let (bytes, modified) = try? HostFiles.readRegular(folder.appendingPathComponent(name), cap: Self.textCap),
                  let text = String(data: bytes, encoding: .utf8) else { continue }
            locks.append(["key": key, "text": text, "modified": Self.millis(modified)])
        }
        var result: [String: Any] = ["session": session, "machine": machine, "now": Self.millis(Date()), "locks": locks]
        var info = stat()
        if lstat(project.path, &info) == 0, (info.st_mode & S_IFMT) == S_IFREG {
            result["project"] = ["size": Int(info.st_size), "inode": Double(info.st_ino),
                                 "modified": Double(info.st_mtimespec.tv_sec) * 1000 + Double(info.st_mtimespec.tv_nsec / 1_000_000)]
        }
        return result
    }

    /// Whether a lock file exists, and the session it names (nil when unreadable).
    private func current(_ url: URL) -> (exists: Bool, session: String?) {
        var info = stat()
        guard lstat(url.path, &info) == 0 else { return (false, nil) }
        guard (info.st_mode & S_IFMT) == S_IFREG, let (bytes, _) = try? HostFiles.readRegular(url, cap: Self.textCap),
              let object = (try? JSONSerialization.jsonObject(with: bytes)) as? [String: Any] else { return (true, nil) }
        return (true, object["session"] as? String)
    }

    func record(_ data: Any?) throws -> Data {
        guard let text = data as? String, text.utf8.count <= Self.dataCap,
              let object = try? JSONSerialization.jsonObject(with: Data(text.utf8)), object is [String: Any] else {
            throw HostFiles.failure("Lock data must be a small JSON object.")
        }
        let record: [String: Any] = ["atrium-lock": 1, "machine": machine, "session": session, "pid": Int(getpid()),
                                     "written": Self.millis(Date()), "data": object]
        return try JSONSerialization.data(withJSONObject: record, options: [.sortedKeys])
    }

    /// mode "create" (exclusive), "replace" (own lock only) or "takeover" (the user confirmed).
    func write(project: URL, key value: Any?, data: Any?, mode: Any?) throws -> [String: Any] {
        guard ProjectFileType.accepts(project), let key = Self.validKey(value) else { throw HostFiles.failure("Invalid lock name.") }
        let bytes = try record(data), destination = Self.url(project: project, key: key)
        switch mode as? String {
        case "create":
            let fd = Darwin.open(destination.path, O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW | O_CLOEXEC, 0o644)
            if fd < 0 {
                if errno == EEXIST { return ["written": false, "exists": true] }
                throw HostFiles.failure("Could not create the lock file.")
            }
            fchmod(fd, 0o644)
            let ok = ProjectWrites.writeAll(bytes, to: fd)
            let synced = fsync(fd) == 0
            Darwin.close(fd)
            guard ok, synced else { unlink(destination.path); throw HostFiles.failure("Could not write the lock file.") }
            return ["written": true]
        case "replace", "takeover":
            let found = current(destination)
            if mode as? String == "replace" {
                guard found.exists else { return ["written": false, "missing": true] }
                guard found.session == session else { return ["written": false, "owner": false] }
            }
            var info = stat()
            if lstat(destination.path, &info) == 0, (info.st_mode & S_IFMT) != S_IFREG, (info.st_mode & S_IFMT) != S_IFLNK {
                throw HostFiles.failure("The lock path is not a file.")
            }
            try ProjectWrites.atomicWrite(bytes, to: destination, mode: 0o644, collaborationLock: true)
            return ["written": true]
        default:
            throw HostFiles.failure("Unknown lock mode.")
        }
    }

    func remove(project: URL, key value: Any?, force: Bool) throws -> [String: Any] {
        guard ProjectFileType.accepts(project), let key = Self.validKey(value) else { throw HostFiles.failure("Invalid lock name.") }
        let destination = Self.url(project: project, key: key), found = current(destination)
        guard found.exists else { return ["removed": false] }
        guard force || found.session == session else { return ["removed": false, "owner": false] }
        var info = stat()
        guard lstat(destination.path, &info) == 0, (info.st_mode & S_IFMT) == S_IFREG || (info.st_mode & S_IFMT) == S_IFLNK else {
            return ["removed": false]
        }
        return ["removed": unlink(destination.path) == 0]
    }

    /// Closing the project or the window removes this session's sidecars.
    func removeOwn(project: URL) {
        guard ProjectFileType.accepts(project), let list = listing(project: project)["locks"] as? [[String: Any]] else { return }
        for lock in list {
            guard let key = lock["key"] as? String, let text = lock["text"] as? String,
                  let object = (try? JSONSerialization.jsonObject(with: Data(text.utf8))) as? [String: Any],
                  object["session"] as? String == session else { continue }
            _ = try? remove(project: project, key: key, force: false)
        }
    }
}
