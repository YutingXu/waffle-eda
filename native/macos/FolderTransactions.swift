import Foundation
import CryptoKit
import zlib
import Darwin

// Format 2 uses one checksummed cross-host descriptor. A writer holds the same
// advisory lock from verification through commit and asynchronous installation.
struct FolderFailure: LocalizedError {
    let state: String
    let message: String
    let paths: [String]
    init(_ message: String, state: String = "recoveryPending", paths: [String] = []) {
        self.message = message; self.state = state; self.paths = paths
    }
    var errorDescription: String? { message + (paths.isEmpty ? "" : " (" + paths.joined(separator: ", ") + ")") }
    static func conflict(_ path: String) -> FolderFailure {
        FolderFailure("The working file changed. The competing contents are preserved.", state: "conflict", paths: [path])
    }
}

private let folderBad = FolderFailure("Invalid or unsupported folder transaction.")
private let modelRawCap = 32 * 1024 * 1024
private let gzipHeader: [UInt8] = [0x1f, 0x8b, 8, 0, 0, 0, 0, 0, 2, 255]
private let modelStoredCap = gzipHeader.count + modelRawCap + 5 * (modelRawCap / 16383 + 1) + 8
private let folderCap = 256 * 1024 * 1024
private let folderTotal = 512 * 1024 * 1024
private let planCap = 8192
private let descriptorCap = 4 * 1024 * 1024
private let dirFlags = O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC
private let fileFlags = O_RDONLY | O_NONBLOCK | O_NOFOLLOW | O_CLOEXEC
private let portableDevices: Set<String> = ["CON","PRN","AUX","NUL","CLOCK$","CONIN$","CONOUT$"]
private let portableLocale = Locale(identifier: "en_US_POSIX")
private let ownerSuffix: [String:String] = ["schematic":"wsch","pcb":"wpcb","drawing":"wdraw","panel":"wpanel",
                                            "library":"wlib","block":"wblock"]
private func systemFailure(_ operation: String) -> FolderFailure {
    FolderFailure("\(operation) failed: \(String(cString: strerror(errno))).")
}
// A normal fsync can leave the device's volatile write cache outstanding. Use
// the pinned regular file on the same device when only the directory ioctl is unsupported.
func folderDeviceBarrier(_ fd: Int32, directory: Bool, witness: Int32? = nil,
                         full: (Int32) -> Int32 = { fcntl($0,F_FULLFSYNC) },
                         namespace: (Int32) -> Int32 = { fsync($0) }) throws {
    func unsupported() -> FolderFailure {
        FolderFailure("This volume cannot confirm a durable folder save. Choose a local volume that supports a full device flush.",
                      state:"unsupportedVolume")
    }
    func unsupportedOperation(_ code:Int32) -> Bool {
        code == EINVAL || code == ENOTSUP || code == EOPNOTSUPP || code == ENOTTY || code == ENOSYS
    }
    func attempt(_ file:Int32) throws -> Bool {
        while full(file) != 0 {
            if errno == EINTR { continue }
            if unsupportedOperation(errno) { return false }
            throw systemFailure("Flushing transaction data to the device")
        }
        return true
    }
    if try attempt(fd) { return }
    guard directory, let file = witness else { throw unsupported() }
    var parent = stat(), regular = stat()
    guard fstat(fd,&parent) == 0, parent.st_mode & S_IFMT == S_IFDIR,
          fstat(file,&regular) == 0, regular.st_mode & S_IFMT == S_IFREG,
          regular.st_nlink == 1, regular.st_dev == parent.st_dev else { throw unsupported() }
    while namespace(fd) != 0 {
        if errno == EINTR { continue }
        if unsupportedOperation(errno) { throw unsupported() }
        throw systemFailure("Flushing the transaction directory")
    }
    if try !attempt(file) { throw unsupported() }
}
private func uuidName() -> String { UUID().uuidString.lowercased() }
private func isUUID(_ s: String) -> Bool { UUID(uuidString: s)?.uuidString.lowercased() == s }
private func isDigest(_ s: String) -> Bool {
    s.utf8.count == 64 && s.utf8.allSatisfy { (48...57).contains($0) || (97...102).contains($0) }
}
private func futureMinor(_ header: [String:Any]?) -> Int? {
    guard let minor = AdditiveFile.minor(header), minor > 0, !AdditiveFile.tableProfile(header) else { return nil }
    return minor
}
// The packaged MCP process selects its one root before it accepts any requests.
// This protocol stays local to the parent/child pipe and never runs in WebKit.
func runFolderMCP(_ selection: String, checkpoint: @escaping FolderTransactions.Checkpoint = { _,_ in }) -> Int32 {
    func send(_ value: [String:Any]) {
        let bytes = (try? JSONSerialization.data(withJSONObject:value, options:[.sortedKeys])) ??
            Data("{\"error\":{\"message\":\"The native folder response was invalid.\"}}".utf8)
        FileHandle.standardOutput.write(bytes + Data([10]))
    }
    func sendError(_ error: Error) {
        let failure = error as? FolderFailure
        send(["error":["message":error.localizedDescription, "state":failure?.state ?? "ioError", "paths":failure?.paths ?? []]])
    }
    do {
        let selected = URL(fileURLWithPath:selection)
        var directory = ObjCBool(false)
        let exists = FileManager.default.fileExists(atPath:selected.path, isDirectory:&directory)
        let root = directory.boolValue ? selected : selected.deletingLastPathComponent()
        let manifest = directory.boolValue ? try FolderTransactions.selectedManifest(in:root) : selected.lastPathComponent
        if !exists {
            guard manifest == (try FolderTransactions.selectedManifest(in:root)) else { throw folderBad }
        }
        let store = try FolderTransactions(root:root, manifest:manifest, checkpoint:checkpoint)
        defer { store.close() }
        send(["manifest":manifest])
        while let line = readLine() {
            do {
                guard line.utf8.count <= folderTotal / 3 * 4 + descriptorCap,
                      let call = try JSONSerialization.jsonObject(with:Data(line.utf8)) as? [String:Any],
                      let op = call["op"] as? String else { throw folderBad }
                func lease() throws -> String {
                    guard let id = call["lease"] as? String else { throw folderBad }; return id
                }
                let result: Any
                switch op {
                case "acquire": result = ["lease":try store.acquire()]
                case "read":
                    guard let paths = call["paths"] as? [String], !paths.isEmpty else { throw folderBad }
                    result = ["files":try store.read(lease:lease(), paths:paths)]
                case "verify": try store.verifyHeadless(lease()); result = true
                case "release": try store.release(lease()); result = true
                case "recover": try store.recover(); result = true
                case "commit":
                    guard let request = call["request"] as? [String:Any],
                          let readSet = (call["readSet"] ?? [:]) as? [String:String] else { throw folderBad }
                    var sent = false
                    do {
                        try store.commitHeadless(request, readSet:readSet) { receipt in
                            send(["result":receipt])
                            sent = true
                        }
                    } catch {
                        // A post-commit conflict is retained by the store. A second
                        // response would be mistaken for the next request's result.
                        if !sent { throw error }
                    }
                    continue
                default: throw folderBad
                }
                send(["result":result])
            } catch { sendError(error) }
        }
        return 0
    } catch { sendError(error); return 1 }
}
private func hex<S: Sequence>(_ bytes: S) -> String where S.Element == UInt8 {
    let alphabet = Array("0123456789abcdef".utf8)
    var result = [UInt8](); result.reserveCapacity(64)
    for b in bytes { result.append(alphabet[Int(b >> 4)]); result.append(alphabet[Int(b & 15)]) }
    return String(decoding: result, as: UTF8.self)
}
private func sha(_ data: Data) -> String { hex(SHA256.hash(data: data)) }
private func countValue(_ value: Any?, max: Int) -> Int? {
    guard let n = value as? NSNumber, CFGetTypeID(n) != CFBooleanGetTypeID(),
          n.doubleValue >= 0, n.doubleValue <= Double(max), n.doubleValue == Double(n.intValue) else { return nil }
    return n.intValue
}
private func quote(_ text: String) -> String {
    var out = "\""
    for scalar in text.unicodeScalars {
        switch scalar.value {
        case 34: out += "\\\""
        case 92: out += "\\\\"
        case 0...31, 0x2028, 0x2029: out += String(format: "\\u%04x", scalar.value)
        default: out.unicodeScalars.append(scalar)
        }
    }
    return out + "\""
}

private let headerStrings: Set<String> = ["kind","id","formatVersion","compatibleWith","tableBaseVersion"]
private let headerKeys = headerStrings.union(["requires","readerRequires"])
private let nativeVersion = #"\A(0|[1-9][0-9]{0,3})\.(0|[1-9][0-9]{0,3})\z"#

private func nativeRequirements(_ header: [String:Any], path: String? = nil) throws -> (flags: [String], minima: [Data:String]) {
    guard header["requires"] != nil || header["readerRequires"] != nil else { return ([],[:]) }
    let paths = path.map { [$0] } ?? []
    guard let flags = (header["requires"] ?? [String]()) as? [String], flags.allSatisfy({ !$0.isEmpty }) else {
        throw FolderFailure("Invalid required feature list.",paths:paths)
    }
    let required = Set(flags.map { Data($0.utf8) })
    guard required.count == flags.count else { throw FolderFailure("Invalid required feature list.",paths:paths) }
    guard let versions = (header["readerRequires"] ?? NSDictionary()) as? NSDictionary else {
        throw FolderFailure("Invalid required reader versions.",paths:paths)
    }
    var minima = [Data:String]()
    for (rawToken,rawVersion) in versions {
        guard let token = rawToken as? String, let version = rawVersion as? String,
              required.contains(Data(token.utf8)), version.range(of:nativeVersion,options:.regularExpression) != nil else {
            throw FolderFailure("Invalid required reader versions.",paths:paths)
        }
        minima[Data(token.utf8)] = version
    }
    return (flags,minima)
}

// The bounded first line can contain optional values that Foundation cannot
// represent. Validate all JSON syntax and duplicate keys, then decode only
// the projected structural metadata. The original bytes stay with the owner.
private struct NativeHeaderLexer {
    let bytes: [UInt8]
    private var at = 0
    private var projected = [String:Any]()
    init(_ line: Data) { bytes = Array(line) }
    private var next: UInt8 { at < bytes.count ? bytes[at] : 0 }

    private mutating func take(_ byte: UInt8) -> Bool {
        guard next == byte else { return false }
        at += 1
        return true
    }
    private mutating func require(_ byte: UInt8) throws {
        if !take(byte) { throw folderBad }
    }
    private mutating func space() {
        while next == 32 || next == 9 || next == 13 { at += 1 }
    }
    private func hex(_ byte: UInt8) -> UInt16? {
        switch byte {
        case 48...57: return UInt16(byte - 48)
        case 65...70: return UInt16(byte - 55)
        case 97...102: return UInt16(byte - 87)
        default: return nil
        }
    }
    private mutating func string() throws -> Range<Int> {
        let start = at
        try require(34)
        while !take(34) {
            guard next >= 32 else { throw folderBad }
            if take(92) {
                if take(117) {
                    for _ in 0..<4 {
                        guard hex(next) != nil else { throw folderBad }
                        at += 1
                    }
                } else {
                    guard [34,92,47,98,102,110,114,116].contains(next) else { throw folderBad }
                    at += 1
                }
            } else { at += 1 }
        }
        return start..<at
    }
    private func keyUnits(_ range: Range<Int>) -> [UInt16] {
        let end = range.upperBound - 1
        var start = range.lowerBound + 1, decoded = [UInt16]()
        while let slash = bytes[start..<end].firstIndex(of:92) {
            decoded.append(contentsOf:String(decoding:bytes[start..<slash],as:UTF8.self).utf16)
            let escape = bytes[slash + 1]
            if escape == 117 {
                let value = bytes[(slash + 2)..<(slash + 6)].reduce(UInt16(0)) { ($0 << 4) | hex($1)! }
                decoded.append(value)
                start = slash + 6
            } else {
                let controls: [UInt8:UInt16] = [98:8,102:12,110:10,114:13,116:9]
                decoded.append(controls[escape] ?? UInt16(escape))
                start = slash + 2
            }
        }
        decoded.append(contentsOf:String(decoding:bytes[start..<end],as:UTF8.self).utf16)
        return decoded
    }
    private mutating func digits() throws {
        guard (48...57).contains(next) else { throw folderBad }
        repeat { at += 1 } while (48...57).contains(next)
    }
    private mutating func number() throws {
        _ = take(45)
        if !take(48) { try digits() }
        if take(46) { try digits() }
        if take(101) || take(69) {
            if !take(43) { _ = take(45) }
            try digits()
        }
    }
    private mutating func syntax(_ depth: Int) throws {
        guard depth <= 512 else { throw folderBad }
        switch next {
        case 123: try object(depth)
        case 91:
            at += 1; space()
            if take(93) { return }
            while true {
                try syntax(depth + 1); space()
                if take(93) { return }
                try require(44); space()
            }
        case 34: _ = try string()
        case 45,48...57: try number()
        case 110: for byte in "null".utf8 { try require(byte) }
        case 116: for byte in "true".utf8 { try require(byte) }
        case 102: for byte in "false".utf8 { try require(byte) }
        default: throw folderBad
        }
    }
    private mutating func object(_ depth: Int) throws {
        try require(123); space()
        if take(125) { return }
        var names = Set<[UInt16]>()
        while true {
            let spelling = try string(), units = keyUnits(spelling)
            guard names.insert(units).inserted else { throw folderBad }
            space(); try require(58); space()
            let start = at
            try syntax(depth + 1)
            if depth == 0 {
                let key = String(decoding:units,as:UTF16.self)
                if headerKeys.contains(key) {
                    let value = Data(bytes[start..<at])
                    guard bytes[spelling].elementsEqual(quote(key).utf8),
                          let parsed = try? JSONSerialization.jsonObject(with:value,options:[.fragmentsAllowed]) else { throw folderBad }
                    if headerStrings.contains(key) {
                        guard let text = parsed as? String, value.elementsEqual(quote(text).utf8) else { throw folderBad }
                    }
                    projected[key] = parsed
                }
            }
            space()
            if take(125) { return }
            try require(44); space()
        }
    }
    mutating func read() throws -> [String:Any] {
        space(); try object(0); space()
        guard at == bytes.count else { throw folderBad }
        return projected
    }
}

private func decodeNativeHeader(_ line: Data) -> [String:Any]? {
    guard line.count < 65536, String(data:line,encoding:.utf8) != nil else { return nil }
    var lexer = NativeHeaderLexer(line)
    guard let header = try? lexer.read(),
          let id = header["id"] as? String, !id.isEmpty, id.utf8.count <= 1024,
          let kind = header["kind"] as? String, !kind.isEmpty,
          let version = header["formatVersion"] as? String, version.range(of:nativeVersion,options:.regularExpression) != nil,
          (try? nativeRequirements(header)) != nil else { return nil }
    if let subset = header["compatibleWith"] {
        guard let version = subset as? String, version.range(of:nativeVersion,options:.regularExpression) != nil else { return nil }
    }
    return header
}

private func nativeHeader(_ bytes: Data) -> [String:Any]? {
    guard let end = bytes.prefix(65536).firstIndex(of:10) else { return nil }
    return decodeNativeHeader(bytes.prefix(upTo:end))
}

private func portableParts(_ path: String) throws -> [String] {
    guard !path.isEmpty, path.utf8.count <= 4096,
          path.utf8.allSatisfy({ $0 < 128 }) ||
          path.utf8.elementsEqual(path.precomposedStringWithCanonicalMapping.utf8) else { throw folderBad }
    let parts = path.utf8.contains(UInt8(ascii: "/")) ? path.components(separatedBy: "/") : [path]
    guard parts.count <= 64 else { throw folderBad }
    for (index,p) in parts.enumerated() {
        let stem = p.components(separatedBy: ".")[0].uppercased()
        let numberedDevice = ["COM", "LPT"].contains(String(stem.prefix(3))) &&
            stem.count == 4 && "123456789¹²³".contains(stem.last!)
        guard !p.isEmpty, p != ".", p != "..", p.utf8.count <= 255, !p.hasSuffix("."), !p.hasSuffix(" "),
              !p.unicodeScalars.contains(where: { $0.value < 32 || $0.value == 127 || "<>:\"\\|?*".unicodeScalars.contains($0) }),
              !portableDevices.contains(stem), !numberedDevice else { throw folderBad }
        if index < parts.count - 1,
           [".wsch", ".wpcb", ".wdraw", ".wpanel", ".wlib"].contains(where: p.lowercased().hasSuffix) {
            throw FolderFailure("A native document path cannot be used as a directory.", paths: [path])
        }
    }
    return parts
}
private func folded(_ s: String) -> String {
    if s.utf8.allSatisfy({ $0 < 128 }) { return s.lowercased() }
    return s.precomposedStringWithCanonicalMapping.folding(options: [.caseInsensitive], locale: portableLocale)
}
private func immutableDigest(_ path: String) -> String? {
    let parts = path.components(separatedBy:"/")
    if parts.count == 2, parts[0] == "assets", isDigest(parts[1]) { return parts[1] }
    if parts.count == 4, parts[0] == ".waffle", parts[1] == "imports", parts[3] == "source", isDigest(parts[2]) { return parts[2] }
    return nil
}
private func memberPath(_ path: String, manifest: String, extension ext: String? = nil) throws {
    let parts = try portableParts(path)
    if path == manifest { return }
    if path == ".waffle/.gitignore" { return }
    if parts[0] == ".waffle" && parts.count >= 4 && parts[1] == "imports" && isDigest(parts[2]) &&
        !parts.dropFirst(3).contains(where: { $0.hasPrefix(".") }) { return }
    guard !parts.contains(where: { $0.hasPrefix(".") }) else { throw folderBad }
    if parts[0] == "assets" {
        guard parts.count == 2, isDigest(parts[1]) else { throw folderBad }; return
    }
    if parts[0] == "models" {
        let f = parts.last!.components(separatedBy: ".")
        guard parts.count == 2, f.count == 3, isDigest(f[0]), f[2] == "gz", (1...16).contains(f[1].utf8.count),
              f[1].utf8.allSatisfy({ (97...122).contains($0) || (48...57).contains($0) }) else { throw folderBad }; return
    }
    let suffix = ext ?? (path as NSString).pathExtension
    if ["wlib","wblock"].contains(suffix) { guard parts[0] == "libraries", parts.count >= 2 else { throw folderBad }; return }
    guard ["wsch","wpcb","wdraw","wpanel"].contains(suffix) else { throw folderBad }
}

// Only established 2.0 field shapes can be changed in a newer native owner.
// The portable examples and refusal vectors live in folder-transaction/additive.json.
private enum AdditiveFile {
    static let tableFeature = "notebook.table.v1"
    static let documentItems = Set("part wire track graphic label netlabel junction via pad polygon power port offsheet sheetsymbol bus busentry noerc textframe image frame richtext math calculation widget imageMarkup notesLayer sticky callout reviewItem inkStroke".split(separator:" ").map(String.init))
    static let document = documentItems.union(["documentSettings","panelCell","drawingView","drawingDimension","boardBody","modelAlias","layer","copperRegion"])
    static let library = Set(["librarySettings","pin","pad","shape","boardBody","modelAlias"])
    static let block = documentItems.union(["blockSettings","blockLibrary"])
    static let scalars = Set("order text name label ref value x y z w h width height size length radius diameter thickness rotation angle sweep layer hidden locked".split(separator:" ").map(String.init))
    static let coordinates = Set(["at","start","end","points"])
    private static let optionalProjectFields = [
        "savedQuery":"name query languageVersion source bindings scope columns documentId instanceId span target docId itemId signalId entityId pinId definitionId parameterId projectId field kind detached needsRebind",
        "link":"source target objectId documentId kind projectId fragment label",
        "linkAnchor":"kind documentId ownerId terminal terminalId",
        "savedView":"name documentId camera center scale referenceScale flipped rotationRadians viewport pixelWidth pixelHeight selection layers hidden active mode filter scope savedQueryId mask highlight netHighlight languageVersion source bindings span target docId itemId instanceId signalId entityId pinId definitionId parameterId projectId field kind detached needsRebind $number",
        "slide":"name aspect notes source kind documentId frameId savedViewId",
        "datasheetRef":"sha256 byteLength title version sourceURL pageCount asset mediaType",
        "datasheetAnnotation":"datasheetId page region type text points"
    ]
    private static let baselineProjectKinds = Set("document library layoutBlock importIndex release projectSetting rule signal tag variant bomView outputJob reviewThread reviewReply".split(separator:" ").map(String.init))
    static let refusal = FolderFailure("This edit cannot preserve the project's newer native format. Use a compatible Waffle version.")
    static func minor(_ head: [String:Any]?) -> Int? {
        guard let version = head?["formatVersion"] as? String, version.hasPrefix("2.") else { return nil }
        let digits = version.dropFirst(2).utf8
        guard (1...4).contains(digits.count), (digits.count == 1 || digits.first != 48),
              digits.allSatisfy({ (48...57).contains($0) }) else { return nil }
        return Int(version.dropFirst(2))
    }
    static func supports(_ head:[String:Any]) -> Bool {
        head["requires"] == nil || (head["requires"] as? [Any])?.isEmpty == true
    }
    static func tableProfile(_ head: [String:Any]?) -> Bool {
        guard let head = head, head["formatVersion"] as? String == "2.1", head["compatibleWith"] == nil,
              let kind = head["kind"] as? String, ["project","schematic"].contains(kind),
              head["tableBaseVersion"] == nil || (kind == "project" && head["tableBaseVersion"] as? String == "2.1"),
              head["requires"] as? [String] == [tableFeature] else { return false }
        return head["readerRequires"] == nil || (head["readerRequires"] as? [String:String]) == [tableFeature:"2.1"]
    }
    static func regular(_ head: [String:Any]?) -> Bool {
        minor(head) == 0 || tableProfile(head)
    }
    static func optionalProjectKind(_ kind: String) -> Bool { optionalProjectFields[kind] != nil }
    static func requireWritable(_ head:[String:Any], path:String, exactNativeCopy:Bool = false) throws {
        let (flags,minima) = try nativeRequirements(head,path:path)
        if head["tableBaseVersion"] != nil && !tableProfile(head) { throw refusal }
        let refused = exactNativeCopy ? flags.first(where:{ $0 == "continuation-parts-v1" }) :
            tableProfile(head) ? nil : flags.first
        if let token = refused {
            guard let version = head["formatVersion"] as? String else { throw folderBad }
            let diagnostic = minima[Data(token.utf8)].map { "A reader supporting native format \($0) is required." } ??
                "The file declares native format \(version)."
            throw FolderFailure("Unsupported required feature \(token). \(diagnostic)",paths:[path])
        }
    }
    private static func safeInteger(_ value: Any) -> Bool {
        guard let n = value as? NSNumber, CFGetTypeID(n) != CFBooleanGetTypeID() else { return false }
        return n.doubleValue.rounded() == n.doubleValue && abs(n.doubleValue) <= 9007199254740991
    }
    private static func vector(_ value:Any) -> Bool {
        guard let a = value as? [Any], (2...3).contains(a.count) else { return false }
        return a.allSatisfy(safeInteger)
    }
    private static func scalarText(_ value: Any) -> String? {
        if let s = value as? String { return quote(s) }
        if value is NSNull { return "null" }
        guard let n = value as? NSNumber else { return nil }
        if CFGetTypeID(n) == CFBooleanGetTypeID() { return n.boolValue ? "true" : "false" }
        return safeInteger(n) ? String(n.int64Value) : nil
    }
    private static func mutableText(_ key:String, _ value:Any) -> String? {
        if scalars.contains(key) { return scalarText(value) }
        guard coordinates.contains(key), let list = value as? [Any] else { return nil }
        func pack(_ a:[Any]) -> String { "[" + a.compactMap(scalarText).joined(separator:",") + "]" }
        if vector(list) { return pack(list) }
        guard list.allSatisfy(vector) else { return nil }
        return "[" + list.compactMap { ($0 as? [Any]).map(pack) }.joined(separator:",") + "]"
    }
    private static func precedes(_ a:String, _ b:String) -> Bool {
        func rank(_ key:String) -> Int {
            switch key { case "kind": return 0; case "formatVersion": return 1; case "id": return 2; default: return 3 }
        }
        let left = rank(a), right = rank(b)
        return left == right ? a.utf8.lexicographicallyPrecedes(b.utf8) : left < right
    }
    // Foundation validates the complete object. Keep slices into its original UTF-8
    // for every value so changing an escape or re-encoding an extension cannot pass.
    private static func fieldBytes(_ line:Data) throws -> [String:Data] {
        guard line.first == 123 else { throw refusal }
        var i = line.startIndex + 1, fields = [String:Data](), previous: String?
        while i < line.endIndex && line[i] != 125 {
            let keyStart = i
            guard line[i] == 34 else { throw refusal }; i += 1
            while i < line.endIndex && line[i] != 34 {
                if line[i] == 92 { i += 1 }
                i += 1
            }
            guard i + 1 < line.endIndex, line[i+1] == 58 else { throw refusal }; i += 2
            guard let key = try JSONSerialization.jsonObject(with:line[keyStart..<i-1],options:[.fragmentsAllowed]) as? String,
                  fields[key] == nil, previous.map({ precedes($0,key) }) ?? true,
                  line[keyStart..<i-1].elementsEqual(quote(key).utf8) else { throw refusal }
            previous = key
            let valueStart = i
            var depth = 0, quoted = false
            while i < line.endIndex {
                let c = line[i]
                if quoted {
                    if c == 92 { i += 1 } else if c == 34 { quoted = false }
                } else if c == 34 { quoted = true }
                else if c == 123 || c == 91 { depth += 1 }
                else if c == 125 || c == 93 { if depth == 0 { break }; depth -= 1 }
                else if c == 44 && depth == 0 { break }
                i += 1
            }
            guard !quoted, depth == 0, i > valueStart, i < line.endIndex else { throw refusal }
            fields[key] = line[keyStart..<i]
            if line[i] == 125 { break }
            guard line[i] == 44 else { throw refusal }; i += 1
        }
        guard i < line.endIndex, line[i] == 125,
              i + 1 == line.endIndex || (i + 2 == line.endIndex && line[i+1] == 13) else { throw refusal }
        return fields
    }
    struct Record {
        let line:Data, id:String, kind:String
        let values:[String:Any]
        init(_ bytes:Data) throws {
            guard let o = try JSONSerialization.jsonObject(with:bytes) as? [String:Any],
                  let id = o["id"] as? String, !id.isEmpty, let kind = o["kind"] as? String, !kind.isEmpty else { throw refusal }
            self.id = id; self.kind = kind; line = bytes; values = o
        }
    }
    // Capability writes may change only currently implemented metadata rows.
    // Compare every other physical line, including unrecognized optional fields.
    static func verifyProjectWrite(_ base: Data?, _ desired: Data, id: String) throws {
        guard let head = nativeHeader(desired), head["kind"] as? String == "project",
              head["id"] as? String == id, let target = minor(head), target <= 1 else { throw refusal }
        try requireWritable(head,path:"Project manifest")
        let before = base.flatMap(nativeHeader), oldTable = tableProfile(before), newTable = tableProfile(head)
        if !oldTable && !newTable {
            if target == 1 { try verifyOptionalProject(base,desired,id:id) }
            else if before != nil && minor(before) != 0 { throw refusal }
        } else if oldTable && newTable {
            guard before?["tableBaseVersion"] as? String == head["tableBaseVersion"] as? String else { throw refusal }
        } else if let original = base, minor(before) == 1 && target == 1 {
            try verifyTableTransition(original,desired,id:id,promoting:newTable)
        } else if newTable {
            guard head["tableBaseVersion"] == nil, before == nil || minor(before) == 0 else { throw refusal }
        } else {
            guard before?["tableBaseVersion"] == nil, target == 0, let original = base,
                  !containsOptionalRows(original) else { throw refusal }
        }
    }

    private static func containsOptionalRows(_ bytes: Data) -> Bool {
        bytes.split(separator:10).dropFirst().contains { line in
            guard let record = try? Record(Data(line)) else { return true }
            return optionalProjectKind(record.kind)
        }
    }

    private static func verifyTableTransition(_ base: Data, _ desired: Data, id: String, promoting: Bool) throws {
        let old = base.split(separator:10,omittingEmptySubsequences:false)
        let next = desired.split(separator:10,omittingEmptySubsequences:false)
        guard old.count == next.count, old.last?.isEmpty == true, next.last?.isEmpty == true,
              let before = old.first, let after = next.first else { throw refusal }
        let a = try Record(Data(before)), b = try Record(Data(after))
        guard a.id == id, b.id == id, a.kind == "project", b.kind == "project" else { throw refusal }
        try requireWritable(a.values,path:"Project manifest")
        let table = promoting ? b : a, plain = promoting ? a : b
        guard supports(plain.values), plain.values["compatibleWith"] == nil,
              table.values["tableBaseVersion"] as? String == "2.1" || (!promoting && containsOptionalRows(base)) else { throw refusal }
        var oldTokens = try fieldBytes(a.line), newTokens = try fieldBytes(b.line)
        for key in ["requires","readerRequires","tableBaseVersion"] {
            oldTokens.removeValue(forKey:key); newTokens.removeValue(forKey:key)
        }
        guard oldTokens == newTokens else { throw refusal }
        var changed = false
        for (left,right) in zip(old.dropFirst().dropLast(),next.dropFirst().dropLast()) where left != right {
            let first = try Record(Data(promoting ? left : right)), second = try Record(Data(promoting ? right : left))
            guard first.id == second.id, first.kind == "document", second.kind == "document",
                  first.values["docKind"] as? String == "schematic", supports(first.values),
                  second.values["requires"] as? [String] == [tableFeature] else { throw refusal }
            var prior = try fieldBytes(first.line), wanted = try fieldBytes(second.line)
            prior.removeValue(forKey:"requires"); wanted.removeValue(forKey:"requires")
            guard prior == wanted else { throw refusal }
            changed = true
        }
        guard changed else { throw refusal }
    }

    private static func verifyOptionalProject(_ base:Data?, _ desired:Data, id:String) throws {
        func parts(_ bytes:Data) throws -> (head:Record,rows:ArraySlice<Data>) {
            guard bytes.last == 10 else { throw refusal }
            let lines = bytes.split(separator:10,omittingEmptySubsequences:false).dropLast()
            guard let line = lines.first else { throw refusal }
            return (try Record(Data(line)),lines.dropFirst().map { Data($0) }[...])
        }
        func known(_ row:Record) throws -> Bool {
            guard let enabled = optionalProjectFields[row.kind] else { return false }
            let keys = Set(("id " + enabled).split(separator:" ").map(String.init))
            func supported(_ value:Any) -> Bool {
                if let fields = value as? [String:Any] { return fields.allSatisfy { keys.contains($0.key) && supported($0.value) } }
                if let array = value as? [Any] { return array.allSatisfy(supported) }
                return true
            }
            guard row.id.range(of:"^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$",options:.regularExpression) != nil,
                  Set(row.values.keys).isSubset(of:["kind","id","order","value"]),
                  let value = row.values["value"] as? [String:Any], supported(value),
                  value["id"] == nil || value["id"] as? String == row.id else { throw refusal }
            return true
        }
        let next = try parts(desired)
        guard next.head.id == id, next.head.kind == "project", minor(next.head.values) == 1 else { throw refusal }
        try requireWritable(next.head.values,path:"Project manifest")
        if base == desired { return } // An acknowledged manifest may already be installed.
        var old = RowReader(owner:id,lines:[])
        if let base = base {
            let prior = try parts(base)
            guard prior.head.id == id, prior.head.kind == "project", let beforeMinor = minor(prior.head.values), beforeMinor <= 1 else { throw refusal }
            try requireWritable(prior.head.values,path:"Project manifest")
            if prior.head.line != next.head.line {
                var before = try fieldBytes(prior.head.line), after = try fieldBytes(next.head.line)
                before.removeValue(forKey:"formatVersion"); after.removeValue(forKey:"formatVersion")
                guard beforeMinor == 0, before == after else { throw refusal }
            }
            old = RowReader(owner:id,lines:prior.rows)
        }
        var new = RowReader(owner:id,lines:next.rows), a = try old.next(), b = try new.next(), changed = false
        while a != nil || b != nil {
            if let left = a, let right = b, left.id == right.id {
                if left.line != right.line {
                    guard left.kind == right.kind, try known(left), try known(right) else { throw refusal }
                    changed = true
                }
                a = try old.next(); b = try new.next()
            } else if let left = a, b == nil || left.id.utf8.lexicographicallyPrecedes(b!.id.utf8) {
                guard try known(left) else { throw refusal }
                changed = true; a = try old.next()
            } else if let right = b {
                let writable = try known(right)
                guard writable || base == nil && baselineProjectKinds.contains(right.kind) else { throw refusal }
                changed = changed || writable; b = try new.next()
            }
        }
        guard changed else { throw refusal }
    }
    // Advance the two sorted streams together. Only the current pair of decoded
    // rows remains resident while comparing a large owner.
    private struct RowReader {
        let owner:String
        var lines:ArraySlice<Data>
        var prior:String?
        mutating func next() throws -> Record? {
            guard let bytes = lines.popFirst() else { return nil }
            let row = try Record(bytes)
            guard row.id != owner, prior.map({ $0.utf8.lexicographicallyPrecedes(row.id.utf8) }) ?? true else { throw refusal }
            prior = row.id
            return row
        }
    }
    private static func compare(_ old:Record?, _ new:Record?, known:Set<String>) throws {
        if let a = old, let b = new, a.line == b.line { return }
        guard let row = old ?? new, known.contains(row.kind),
              old == nil || new == nil || old?.kind == new?.kind else { throw refusal }
        let af = try old.map { try fieldBytes($0.line) } ?? [:]
        let bf = try new.map { try fieldBytes($0.line) } ?? [:]
        if old != nil && new != nil && (af["id"] != bf["id"] || af["kind"] != bf["kind"]) { throw refusal }
        for field in Set(af.keys).union(bf.keys) {
            if let raw = af[field], raw == bf[field] { continue }
            for (record,raw) in [(old,af[field]),(new,bf[field])] {
                guard let value = record?.values[field], let bytes = raw else { continue }
                let encoded = (field == "id" || field == "kind") ? (value as? String).map(quote) : mutableText(field,value)
                guard let text = encoded, bytes.elementsEqual((quote(field) + ":" + text).utf8) else { throw refusal }
            }
        }
    }
    static func verify(_ old:Data, _ new:Data, id:String, kind:String, minor:Int) throws {
        let before = old.split(separator:10,omittingEmptySubsequences:false)
        let after = new.split(separator:10,omittingEmptySubsequences:false)
        guard before.last?.isEmpty == true, after.last?.isEmpty == true, let header = before.first, !header.isEmpty,
              header == after.first, let h = try JSONSerialization.jsonObject(with:header) as? [String:Any],
              h["kind"] as? String == kind, h["id"] as? String == id, supports(h),
              let ownerMinor = self.minor(h), ownerMinor <= minor else { throw refusal }
        var oldRows = RowReader(owner:id,lines:before.dropFirst().dropLast())
        var newRows = RowReader(owner:id,lines:after.dropFirst().dropLast())
        let known: Set<String>
        switch kind {
        case "schematic","pcb","drawing","panel": known = document
        case "library": known = library
        case "block": known = block
        default: throw refusal
        }
        var a = try oldRows.next(), b = try newRows.next()
        while a != nil || b != nil {
            if let left = a, let right = b, left.id == right.id {
                try compare(left,right,known:known); a = try oldRows.next(); b = try newRows.next()
            } else if let left = a, b.map({ left.id.utf8.lexicographicallyPrecedes($0.id.utf8) }) ?? true {
                try compare(left,nil,known:known); a = try oldRows.next()
            } else {
                try compare(nil,b,known:known); b = try newRows.next()
            }
        }
    }
}

private struct Desired: Equatable {
    let sha256: String
    let length: Int
    var json: String { "{\"length\":\(length),\"sha256\":" + quote(sha256) + "}" }
}
private struct Target {
    let path: String
    let expected: String?
    let desired: Desired?
    var json: String {
        "{\"desired\":" + (desired?.json ?? "null") + ",\"expected\":" + (expected.map(quote) ?? "null") + ",\"path\":" + quote(path) + "}"
    }
}
private struct Descriptor {
    let projectId: String
    let transaction: String
    let plan: [Target]
    func encoded() -> Data {
        let json = "{\"plan\":[" + plan.map(\.json).joined(separator: ",") + "],\"projectId\":" + quote(projectId) +
            ",\"transaction\":" + quote(transaction) + "}\n"
        let body = Data(json.utf8)
        return Data("WAFFLE-TXN 1\n\(sha(body))\n".utf8) + body
    }
    static func decode(_ data: Data, manifest: String) throws -> Descriptor {
        let prefix = Data("WAFFLE-TXN 1\n".utf8), offset = prefix.count + 65
        guard data.count > offset, data.count <= descriptorCap, data.starts(with: prefix),
              data[offset - 1] == 10, data.last == 10 else { throw folderBad }
        let payload = Data(data.dropFirst(offset))
        guard sha(payload) == String(decoding: data[prefix.count..<offset - 1], as: UTF8.self),
              let obj = try JSONSerialization.jsonObject(with: payload) as? [String:Any],
              let id = obj["projectId"] as? String, !id.isEmpty, id.utf8.count <= 1024,
              let tx = obj["transaction"] as? String, isUUID(tx),
              let items = obj["plan"] as? [[String:Any]], (1...planCap).contains(items.count) else { throw folderBad }
        var total = 0
        let targets: [Target] = try items.map { item in
            guard let path = item["path"] as? String else { throw folderBad }
            try memberPath(path, manifest: manifest)
            let expected = item["expected"] as? String
            guard expected.map(isDigest) ?? (item["expected"] is NSNull) else { throw folderBad }
            var desired: Desired?
            if let d = item["desired"] as? [String: Any], let h = d["sha256"] as? String, isDigest(h),
               let len = countValue(d["length"], max: folderCap) {
                total += len; guard total <= folderTotal else { throw folderBad }
                desired = Desired(sha256: h, length: len)
            } else if !(item["desired"] is NSNull) { throw folderBad }
            guard expected != nil || desired != nil else { throw folderBad }
            if let pinned = immutableDigest(path), let d = desired, pinned != d.sha256 { throw folderBad }
            return Target(path: path, expected: expected, desired: desired)
        }
        let result = Descriptor(projectId: id, transaction: tx, plan: targets)
        try result.validateOrder(manifest: manifest)
        guard result.encoded() == data else { throw folderBad } // also rejects duplicate/extra keys
        return result
    }
    func validateOrder(manifest: String) throws {
        guard Set(plan.map(\.path)).count == plan.count else { throw folderBad }
        var aliases = [String:Target]()
        var hasOwner = false
        for (i,t) in plan.enumerated() {
            if t.path == manifest, i != plan.count - 1 { throw folderBad }
            if t.path.hasPrefix("assets/"), t.desired != nil, hasOwner { throw folderBad }
            if ["wsch","wpcb","wlib","wblock","wdraw","wpanel"].contains((t.path as NSString).pathExtension) { hasOwner = true }
            let key = folded(t.path)
            if let old = aliases[key] {
                guard old.expected != nil, old.desired == nil, t.expected == nil, t.desired != nil else { throw folderBad }
            }
            aliases[key] = t
        }
        for (key,target) in aliases {
            for separator in key.indices where key[separator] == "/" {
                if let ancestor = aliases[String(key[..<separator])] {
                    throw FolderFailure("A save target also names a directory.", paths: [ancestor.path, target.path])
                }
            }
        }
    }
}

private final class FD {
    let value: Int32
    init(_ value: Int32, _ action: String) throws {
        guard value >= 0 else { throw systemFailure(action) }; self.value = value
    }
    deinit { Darwin.close(value) }
    func spelling() -> String? {
        var path = [CChar](repeating:0,count:Int(MAXPATHLEN))
        guard fcntl(value,F_GETPATH,&path) == 0, let actual = String(validatingUTF8:path) else { return nil }
        return (actual as NSString).lastPathComponent.precomposedStringWithCanonicalMapping
    }
    func info() throws -> stat {
        var s = stat(); guard fstat(value, &s) == 0 else { throw systemFailure("Inspecting the open file") }; return s
    }
    // macOS fcntl(2): F_FULLFSYNC on this device also persists earlier I/O
    // synchronized with fsync. Establish each inode/namespace dependency first;
    // the descriptor's full device barrier then covers the entire prepared plan.
    func flushForCommit() throws {
        while fsync(value) != 0 { if errno != EINTR { throw systemFailure("Flushing a transaction member") } }
    }
    func sync(directory: Bool = false, witness: FD? = nil) throws {
        try folderDeviceBarrier(value,directory:directory,witness:witness?.value)
    }
    private func rawChunks(cap: Int, privateTemporary: Bool = false, _ body: (UnsafeRawBufferPointer) throws -> Void) throws {
        let initial = try info()
        guard (initial.st_mode & S_IFMT) == S_IFREG, (initial.st_nlink == 1 || (privateTemporary && initial.st_nlink == 0)), initial.st_size >= 0,
              initial.st_size <= cap else { throw FolderFailure("The member must be a bounded, singly linked regular file.") }
        var offset = 0, buffer = [UInt8](repeating: 0, count: min(1 << 20, max(4096, Int(initial.st_size))))
        while true {
            let n = buffer.withUnsafeMutableBytes { pread(value, $0.baseAddress!, $0.count, off_t(offset)) }
            if n < 0 { if errno == EINTR { continue }; throw systemFailure("Reading the member") }
            if n == 0 { break }
            offset += n
            guard offset <= cap else { throw folderBad }
            try buffer.withUnsafeBytes { try body(UnsafeRawBufferPointer(rebasing:$0[..<n])) }
        }
        let end = try info()
        guard offset == initial.st_size, sameContents(initial,end) else {
            throw FolderFailure("The member changed during the read.")
        }
    }
    func chunks(cap: Int, privateTemporary: Bool = false, _ body: (Data) throws -> Void) throws {
        try rawChunks(cap:cap,privateTemporary:privateTemporary) { try body(Data($0)) }
    }
    func read(_ cap: Int) throws -> Data {
        let size = try info().st_size
        guard size >= 0, size <= cap else { throw folderBad }
        var result = Data(capacity:Int(size))
        try rawChunks(cap:cap) { result.append($0.baseAddress!.assumingMemoryBound(to:UInt8.self),count:$0.count) }
        return result
    }
    func digest(cap: Int = folderCap) throws -> Desired {
        var hash = SHA256(), size = 0
        try rawChunks(cap:cap) { hash.update(bufferPointer:$0); size += $0.count }
        return Desired(sha256: hex(hash.finalize()), length: size)
    }
    // The gzip wrapper verifies CRC32 and ISIZE. Require exactly one complete member,
    // the format's fixed header and the original content identity as separate checks.
    func verifyModel(_ expected: Desired, cap: Int) throws -> Desired {
        let invalid = FolderFailure("The model's gzip or original bytes do not match its saved reference.")
        let length = try info().st_size
        guard length >= gzipHeader.count + 2 + 8, length <= min(cap,modelStoredCap) else { throw invalid }
        var stream = z_stream()
        guard inflateInit2_(&stream, 15 + 16, ZLIB_VERSION, Int32(MemoryLayout<z_stream>.size)) == Z_OK else { throw invalid }
        defer { inflateEnd(&stream) }

        var storedHash = SHA256(), rawHash = SHA256()
        var received = 0, expanded = 0, finished = false
        var output = [UInt8](repeating:0,count:min(65536,expected.length + 1))
        try rawChunks(cap:min(cap,modelStoredCap)) { input in
            guard !finished else { throw invalid }
            if received < gzipHeader.count {
                let n = min(input.count, gzipHeader.count - received)
                guard input.prefix(n).elementsEqual(gzipHeader[received..<received+n]) else { throw invalid }
            }
            storedHash.update(bufferPointer:input)
            received += input.count
            stream.next_in = UnsafeMutablePointer(mutating:input.bindMemory(to:Bytef.self).baseAddress)
            stream.avail_in = uInt(input.count)
            try output.withUnsafeMutableBytes { out in
                while stream.avail_in > 0 {
                    let capacity = min(out.count, expected.length - expanded + 1)
                    stream.next_out = out.bindMemory(to:Bytef.self).baseAddress
                    stream.avail_out = uInt(capacity)
                    let available = stream.avail_in
                    let status = inflate(&stream,Z_NO_FLUSH)
                    let produced = capacity - Int(stream.avail_out)
                    guard status == Z_OK || status == Z_STREAM_END, produced <= expected.length - expanded else { throw invalid }
                    rawHash.update(bufferPointer:UnsafeRawBufferPointer(rebasing:out[..<produced]))
                    expanded += produced
                    if status == Z_STREAM_END {
                        guard stream.avail_in == 0 else { throw invalid }
                        finished = true
                        break
                    }
                    guard stream.avail_in < available || produced > 0 else { throw invalid }
                }
            }
        }
        guard finished, received == length, stream.total_in == received, expanded == expected.length,
              hex(rawHash.finalize()) == expected.sha256 else { throw invalid }
        return Desired(sha256:hex(storedHash.finalize()),length:received)
    }
    func write(_ data: Data) throws {
        try data.withUnsafeBytes { b in
            var offset = 0
            while offset < b.count {
                let n = Darwin.write(value, b.baseAddress! + offset, b.count - offset)
                if n < 0 { if errno == EINTR { continue }; throw systemFailure("Writing staged data") }
                guard n > 0 else { throw FolderFailure("A staged write made no progress.") }
                offset += n
            }
        }
    }
}
private func sameFile(_ a: stat, _ b: stat) -> Bool { a.st_dev == b.st_dev && a.st_ino == b.st_ino }
private func sameContents(_ a: stat, _ b: stat) -> Bool {
    sameFile(a,b) && a.st_nlink == b.st_nlink && a.st_size == b.st_size &&
        a.st_ctimespec.tv_sec == b.st_ctimespec.tv_sec && a.st_ctimespec.tv_nsec == b.st_ctimespec.tv_nsec
}
private func entryInfo(_ dir: FD, _ name: String) throws -> stat? {
    var s = stat()
    if fstatat(dir.value, name, &s, AT_SYMLINK_NOFOLLOW) == 0 { return s }
    if errno == ENOENT { return nil }; throw systemFailure("Inspecting a directory entry")
}
private func names(_ dir: FD) throws -> [String] {
    let copy = openat(dir.value, ".", dirFlags)
    guard copy >= 0 else { throw systemFailure("Opening a directory listing") }
    guard let stream = fdopendir(copy) else { Darwin.close(copy); throw systemFailure("Listing a directory") }
    defer { closedir(stream) }
    var result = [String]()
    while true {
        errno = 0
        guard let e = readdir(stream) else { if errno != 0 { throw systemFailure("Listing a directory") }; return result }
        let name = withUnsafePointer(to: &e.pointee.d_name) { ptr in
            ptr.withMemoryRebound(to: CChar.self, capacity: Int(e.pointee.d_namlen) + 1) { String(validatingUTF8: $0) }
        }
        guard let n = name else { throw folderBad }
        if n != "." && n != ".." { result.append(n.precomposedStringWithCanonicalMapping) }
        guard result.count <= 100_000 else { throw FolderFailure("The directory exceeds the entry limit.") }
    }
}
private func spellings(_ dir: FD, _ name: String) throws -> [String] {
    // Constant-time common path on case-insensitive APFS. A case-sensitive
    // volume additionally needs the folded-name collision check over its directory.
    if fpathconf(dir.value,_PC_CASE_SENSITIVE) == 0 {
        guard try entryInfo(dir,name) != nil else { return [] }
        let n = openat(dir.value,name,O_EVTONLY | O_NOFOLLOW | O_CLOEXEC)
        if n >= 0 {
            let f = try FD(n,"Checking the entry spelling")
            if let actual = f.spelling() { return [actual] }
        }
    }
    return try names(dir).filter { folded($0) == folded(name) }
}
private func regular(_ dir: FD, _ name: String) throws -> FD? {
    let n = openat(dir.value, name, fileFlags)
    if n < 0 && errno == ENOENT { return nil }
    let fd = try FD(n, "Opening a project member")
    let s = try fd.info()
    guard (s.st_mode & S_IFMT) == S_IFREG, s.st_nlink == 1,
          fd.spelling() == name, let path = try entryInfo(dir, name), sameFile(s,path) else { throw FolderFailure("The member is linked, replaced, or not a regular file.", paths: [name]) }
    return fd
}
private func freshFile(_ dir: FD, _ name: String) throws -> FD {
    try FD(openat(dir.value, name, O_CREAT | O_EXCL | O_RDWR | O_NOFOLLOW | O_CLOEXEC, 0o600), "Creating a private file")
}
private func directory(_ dir: FD, _ name: String, create: Bool = false) throws -> FD? {
    if create {
        let collisions = try spellings(dir,name)
        guard collisions.isEmpty || collisions == [name] else { throw FolderFailure.conflict(name) }
        if collisions.isEmpty {
            if mkdirat(dir.value,name,0o700) == 0 { try dir.flushForCommit() }
            else if errno != EEXIST { throw systemFailure("Creating a project directory") }
        }
    }
    let n = openat(dir.value, name, dirFlags)
    if n < 0 && errno == ENOENT { return nil }
    let fd = try FD(n, "Opening a project directory")
    let s = try fd.info(), parent = try dir.info()
    guard s.st_dev == parent.st_dev, fd.spelling() == name, let entry = try entryInfo(dir, name), sameFile(s,entry) else {
        throw FolderFailure("A directory was replaced or crosses a volume.")
    }
    return fd
}
private func exclusiveRename(_ from: FD, _ name: String, _ to: FD, _ final: String) throws {
    guard renameatx_np(from.value, name, to.value, final, UInt32(RENAME_EXCL)) == 0 else {
        if errno == EEXIST { throw FolderFailure.conflict(final) }; throw systemFailure("Publishing a new project entry")
    }
}

private final class BoundTree {
    let url: URL
    let root: FD
    private var directories: [String: stat] = [:]
    init(_ chosen: URL) throws {
        // Resolve the selected parent's OS aliases (e.g. /var), never the selected entry.
        url = chosen.deletingLastPathComponent().resolvingSymlinksInPath().appendingPathComponent(chosen.lastPathComponent)
        root = try FD(Darwin.open(url.path, dirFlags), "Opening the selected project folder")
        try checkRoot()
    }
    func checkRoot() throws {
        var current = stat()
        guard lstat(url.path, &current) == 0, sameFile(try root.info(), current) else {
            throw FolderFailure("The selected project folder was moved or replaced. Choose it again.")
        }
    }
    func walk(_ parts: [String], create: Bool = false) throws -> FD? {
        try checkRoot()
        var dir = root, path = ""
        for part in parts {
            path += "/" + part
            guard let next = try directory(dir, part, create: create) else { return nil }
            let info = try next.info()
            if let saved = directories[path], !sameFile(saved,info) {
                throw FolderFailure("A project directory was replaced. Reopen the folder.", paths: [String(path.dropFirst())])
            }
            directories[path] = info; dir = next
        }
        return dir
    }
    func journal(create: Bool = false) throws -> FD? { try walk([".waffle","journal"], create: create) }
    func parent(_ path: String, create: Bool = false) throws -> FD? {
        try walk(Array(try portableParts(path).dropLast()), create: create)
    }
    func matches(_ dir: FD, path: String) throws {
        guard let current = try parent(path), sameFile(try current.info(), try dir.info()) else {
            throw FolderFailure.conflict(path)
        }
    }
    func lock(write: Bool, beforeCreating: () throws -> Void = {}) throws -> FD {
        func lockFD(_ fd: FD, write: Bool) throws {
            if flock(fd.value, (write ? LOCK_EX : LOCK_SH) | LOCK_NB) != 0 {
                if errno == EWOULDBLOCK { throw FolderFailure("A project reader or writer is busy. Retry after it finishes.") }
                throw systemFailure("Locking the local project")
            }
        }
        // First use of a fresh clone has no ignored state. Its reader holds the root
        // SH until release; the first writer must get EX on this identity to bootstrap.
        if write {
            var volume = statfs()
            guard fstatfs(root.value, &volume) == 0, (UInt64(volume.f_flags) & UInt64(MNT_LOCAL)) != 0 else {
                throw FolderFailure("The volume does not provide local project durability. Choose a local folder.",state:"unsupportedVolume")
            }
        }
        let gate = try FD(openat(root.value, ".", dirFlags), "Opening the root lock")
        try lockFD(gate, write: false)
        if let j = try journal(), let file = try regular(j, "lock") {
            try lockFD(file, write: write); try verifyLock(file, in: j); return file
        }
        if !write { return gate }
        try lockFD(gate, write: true)
        try beforeCreating()
        guard let j = try journal(create: true) else { throw folderBad }
        let file: FD
        if let existing = try regular(j,"lock") { file = existing }
        else {
            file = try freshFile(j,"lock")
            // Root EX excludes first readers/writers until the stable lock exists.
            // A subsequent descriptor's device barrier includes these fsync'd names.
            try file.flushForCommit(); try j.flushForCommit()
        }
        try lockFD(file, write: true); try verifyLock(file, in: j); return file
    }
    func verifyLock(_ file: FD, in j: FD) throws {
        guard let now = try entryInfo(j, "lock"), now.st_nlink == 1, sameFile(try file.info(), now),
              let actual = try journal(), sameFile(try actual.info(), try j.info()) else {
            throw FolderFailure("The local project lock was replaced.")
        }
    }
}

private struct Occupant {
    let file: FD
    let checkedVersion: stat
    let state: Desired
    let bytes: Data?
}
private final class AssetStage {
    let file: FD
    let owner: String
    let mediaType: String
    let state: Desired
    init(file: FD, owner: String, mediaType: String, state: Desired) {
        self.file = file; self.owner = owner; self.mediaType = mediaType; self.state = state
    }
}
private final class ReadSnapshot {
    let lock: FD
    var media: [String:(file:FD,length:Int)] = [:]
    var observed: [String:stat] = [:]
    var verifiedModels = Set<String>()
    var newerMembers: [String:(id:String, kind:String)] = [:]
    var newerMinor: Int?
    var sawManifest = false
    init(_ lock: FD) { self.lock = lock }
}
private func spliceMember(_ value: [String:Any], bytes: Data, base: String) throws -> Data {
    guard value["base"] as? String == base,
          let edits = value["edits"] as? [[String:Any]], edits.count <= 1_000_000 else { throw folderBad }
    var end = 0, output = Data(capacity:bytes.count)
    for edit in edits {
        guard let offset = countValue(edit["offset"], max: bytes.count), offset >= end,
              let remove = countValue(edit["remove"], max: bytes.count - offset),
              let insert = edit["insert"] as? String, insert.utf8.count <= folderCap,
              output.count + (offset - end) + insert.utf8.count <= folderCap else { throw folderBad }
        output.append(bytes[end..<offset]); output.append(contentsOf: insert.utf8); end = offset + remove
    }
    guard output.count + bytes.count - end <= folderCap else { throw folderBad }
    output.append(bytes[end..<bytes.count]); return output
}

private struct Captured {
    let target: Target
    let expectedFile: stat?
    let data: Data?
    let asset: AssetStage?
    let exactNativeCopy: Bool
    let originalNativeCopyOwner: (id:String,kind:String)?
}

final class FolderTransactions {
    typealias Checkpoint = (String, String?) throws -> Void
    let grant = uuidName()
    let manifest: String
    let rootURL: URL
    private let tree: BoundTree
    private let point: Checkpoint
    private var leases = [String:ReadSnapshot]()
    private var staged = [String:AssetStage]()
    private var issue: FolderFailure?
    private(set) var projectID: String?
    private struct Installed { let digest: String? }
    private var notifications: [String:Installed] = [:]
    private struct Member: Equatable { let id: String; let kind: String; let table: Bool }
    private var lastMembership: (stat, [String:Member])?
    // All calls on an instance run on the host's serial folder queue. Different
    // instances and processes coordinate through the same stable project lock.
    init(root: URL, manifest: String, checkpoint: @escaping Checkpoint = { _,_ in }) throws {
        let parts = try portableParts(manifest)
        guard parts.count == 1, !manifest.hasPrefix("."), manifest.hasSuffix(".waffle") else { throw folderBad }
        self.manifest = manifest; tree = try BoundTree(root); rootURL = tree.url; point = checkpoint
    }
    private var draftScope: String? {
        guard let s = try? tree.root.info() else { return nil }
        return sha(Data("\(s.st_dev)/\(s.st_ino)/\(s.st_birthtimespec.tv_sec)/\(s.st_birthtimespec.tv_nsec)".utf8))
    }
    var selection: [String:Any] {
        var result = ["grant":grant,"manifest":manifest,"name":rootURL.lastPathComponent]
        result["draftScope"] = draftScope
        return result
    }

    static func manifestIdentity(_ url: URL) throws -> String? {
        guard url.pathExtension.lowercased() == "waffle" else { return nil }
        let fd = try FD(Darwin.open(url.path,fileFlags), "Opening the selected manifest")
        guard (try fd.info().st_mode & S_IFMT) == S_IFREG else { return nil }
        let h = try header(fd)
        guard h?["kind"] as? String == "project", (h?["formatVersion"] as? String)?.hasPrefix("2.") == true else { return nil }
        return h?["id"] as? String
    }
    static func isManifest(_ url: URL) throws -> Bool {
        guard url.pathExtension.lowercased() == "waffle" else { return false }
        let fd = try FD(Darwin.open(url.path,fileFlags), "Opening the selected manifest")
        guard (try fd.info().st_mode & S_IFMT) == S_IFREG else { throw folderBad }
        let h = try header(fd)
        return h?["kind"] as? String == "project" && (h?["formatVersion"] as? String)?.hasPrefix("2.") == true
    }
    static func selectedManifest(in root: URL) throws -> String {
        let tree = try BoundTree(root)
        let candidates = try names(tree.root).filter { name in
            guard !name.hasPrefix("."), name.hasSuffix(".waffle"), let s = try entryInfo(tree.root,name) else { return false }
            return s.st_mode & S_IFMT == S_IFREG && s.st_nlink == 1
        }
        let manifests = try candidates.filter { try isManifest(root.appendingPathComponent($0)) }
        if manifests.count == 1 { return manifests[0] }
        // A freshly committed creation can be recovered before its manifest has been installed.
        if manifests.isEmpty, let j = try tree.journal(), let active = try regular(j,"active") {
            let bytes = try active.read(descriptorCap)
            if candidates.count == 1, (try? Descriptor.decode(bytes,manifest:candidates[0])) != nil { return candidates[0] }
            if let last = bytes.split(separator:10).last,
               let object = try? JSONSerialization.jsonObject(with: Data(last)) as? [String:Any],
               let plan = object["plan"] as? [[String:Any]], let final = plan.last?["path"] as? String,
               final.hasSuffix(".waffle"), (try? Descriptor.decode(bytes, manifest: final)) != nil { return final }
        }
        throw FolderFailure("Choose the project's .waffle manifest or a folder containing exactly one manifest.")
    }
    private static func header(_ fd: FD) throws -> [String:Any]? {
        var b = [UInt8](repeating: 0, count: 65536)
        let n = b.withUnsafeMutableBytes { pread(fd.value, $0.baseAddress!, $0.count, 0) }
        guard n >= 0 else { throw systemFailure("Reading the project header") }
        guard let e = b[0..<n].firstIndex(of: 10) else { return nil }
        return decodeNativeHeader(Data(b[0..<e]))
    }
    private func checkIdentity(_ id: String, plan: [Target], stage: FD?) throws {
        let change = plan.first(where: { $0.path == manifest })
        if let file = try regular(tree.root,manifest) {
            guard let header = try Self.header(file), header["kind"] as? String == "project",
                  let minor = AdditiveFile.minor(header),
                  (minor <= 1 || change == nil), header["id"] as? String == id else { throw FolderFailure.conflict(manifest) }
            try AdditiveFile.requireWritable(header,path:manifest)
        } else if change?.expected != nil || change?.desired == nil { throw FolderFailure.conflict(manifest) }
        if let change = change, let stage = stage {
            guard let d = change.desired, let file = try regular(stage,d.sha256), let header = try Self.header(file),
                  header["kind"] as? String == "project", let minor = AdditiveFile.minor(header), minor <= 1,
                  header["id"] as? String == id else { throw folderBad }
            try AdditiveFile.requireWritable(header,path:manifest)
            let current = try regular(tree.root,manifest)
            let currentHeader = try current.flatMap { try Self.header($0) }
            if minor == 1 || AdditiveFile.tableProfile(currentHeader) {
                try AdditiveFile.verifyProjectWrite(try current?.read(folderCap),try file.read(folderCap),id:id)
            } else if let current = current, !AdditiveFile.regular(try Self.header(current)) { throw AdditiveFile.refusal }
        }
        if let prior = projectID, prior != id { throw FolderFailure.conflict(manifest) }
    }

    private func membership(_ bytes: Data, includeOpaque: Bool = false) throws -> [String:Member] {
        var result = [String:Member](), paths = Set<String>(), ids = Set<String>()
        let lines = bytes.split(separator:10)
        guard let line = lines.first else { throw folderBad }
        guard let head = decodeNativeHeader(line) else { throw folderBad }
        let newer = includeOpaque && futureMinor(head) != nil
        let tables = AdditiveFile.tableProfile(head)
        // The manifest can also contain project settings and other non-member rows.
        let capacity = min(lines.count - 1,planCap)
        result.reserveCapacity(capacity)
        paths.reserveCapacity(capacity)
        ids.reserveCapacity(capacity)
        for row in lines.dropFirst() {
            // Drain the Foundation objects from this line before decoding the next one.
            try autoreleasepool {
                guard let record = try JSONSerialization.jsonObject(with:row) as? NSDictionary else { throw folderBad }
                let k = record["kind"] as? String
                guard k == "document" || k == "library" || k == "layoutBlock" else { return }
                guard let p = record["path"] as? String, let id = record["id"] as? String, !id.isEmpty,
                      paths.insert(folded(p)).inserted, ids.insert(id).inserted else { throw folderBad }
                let kind = k == "document" ? record["docKind"] as? String : (k == "library" ? "library" : "block")
                guard let kind = kind, !kind.isEmpty else { throw folderBad }
                let ext = (p as NSString).pathExtension
                if let expected = ownerSuffix[kind] {
                    try memberPath(p,manifest:manifest,extension:ext)
                    guard ext == expected else { throw folderBad }
                } else {
                    let parts = try portableParts(p)
                    guard newer, k == "document", !["project","snapshot","import-index"].contains(kind), p != manifest, !parts.contains(where: { $0.hasPrefix(".") }),
                          !["assets","models","libraries"].contains(folded(parts[0])),
                          !["waffle","wsch","wpcb","wdraw","wpanel","wlib","wblock"].contains(ext),
                          ext.range(of:"^w[a-z][a-z0-9-]{0,30}$",options:.regularExpression) != nil else { throw folderBad }
                }
                let table = (record["requires"] as? [String])?.contains(AdditiveFile.tableFeature) == true
                if table && (kind != "schematic" || !tables) { throw folderBad }
                result[p] = Member(id:id,kind:kind,table:table)
            }
        }
        if tables && !result.values.contains(where:{ $0.table }) { throw folderBad }
        return result
    }
    private static func nativeOwner(_ path:String) -> Bool {
        ["wsch","wpcb","wdraw","wpanel","wlib","wblock"].contains((path as NSString).pathExtension)
    }
    private struct AdditiveProject {
        let members: [String:Member], minor: Int, hash: String
    }
    private func additiveProject(_ id: String) throws -> AdditiveProject? {
        guard let f = try regular(tree.root,manifest) else { return nil }
        guard let head = try Self.header(f), head["kind"] as? String == "project", head["id"] as? String == id,
              projectID == nil || projectID == id else { throw FolderFailure.conflict(manifest) }
        guard let minor = AdditiveFile.minor(head) else { throw AdditiveFile.refusal }
        try AdditiveFile.requireWritable(head,path:manifest)
        guard minor > 0, !AdditiveFile.tableProfile(head) else { return nil }
        let data = try f.read(folderCap)
        return AdditiveProject(members:try membership(data,includeOpaque:true),minor:minor,hash:sha(data))
    }
    private func inputContext(_ id: String, _ request: [String:Any]) throws -> AdditiveProject? {
        guard let forward = try additiveProject(id) else { return nil }
        guard forward.minor == 1, let row = (request["plan"] as? [[String:Any]])?.first(where: { $0["path"] as? String == manifest }),
              let current = try regular(tree.root,manifest) else { return forward }
        let base = try current.read(folderCap)
        let desired: Data?
        if let splice = row["splice"] as? [String:Any] { desired = try spliceMember(splice,bytes:base,base:forward.hash) }
        else if let text = row["text"] as? String { desired = Data(text.utf8) }
        else if let data = row["data"] as? String { desired = Data(base64Encoded:data) }
        else { return forward }
        guard let desired = desired, AdditiveFile.tableProfile(nativeHeader(desired)) else { return forward }
        guard row["expected"] as? String == forward.hash else { throw FolderFailure.conflict(manifest) }
        try AdditiveFile.verifyProjectWrite(base,desired,id:id)
        return nil
    }
    private func oldMembership() throws -> [String:Member] {
        guard let f = try regular(tree.root,manifest) else { return [:] }
        let info = try f.info()
        if let (previous,members) = lastMembership, sameFile(previous,info), previous.st_size == info.st_size,
           previous.st_ctimespec.tv_sec == info.st_ctimespec.tv_sec, previous.st_ctimespec.tv_nsec == info.st_ctimespec.tv_nsec { return members }
        let members = try membership(f.read(folderCap))
        lastMembership = (info,members); return members
    }
    private func verifyMembers(_ captures: [Captured]) throws {
        let before = try oldMembership(), manifestEdit = captures.first { $0.target.path == manifest }
        let after = try manifestEdit?.data.map { try membership($0) } ?? before
        let changed = Dictionary(uniqueKeysWithValues: captures.map { ($0.target.path,$0) })
        let kinds = ["wsch","wpcb","wdraw","wpanel","wlib","wblock"]
        for c in captures where kinds.contains((c.target.path as NSString).pathExtension) {
            let p = c.target.path
            if c.target.expected != nil && before[p] == nil { throw FolderFailure("The entry is outside the saved membership.",paths:[p]) }
            guard let desired = c.data else {
                guard after[p] == nil, !c.exactNativeCopy || manifestEdit != nil else {
                    throw FolderFailure("Removing a member also requires its manifest change.",paths:[p])
                }
                if c.exactNativeCopy {
                    guard let prior = before[p], let original = c.originalNativeCopyOwner,
                          prior.id == original.id, prior.kind == original.kind else {
                        throw FolderFailure("The exact native copy's owner identity changed.",paths:[p])
                    }
                }
                continue
            }
            guard let m = after[p], let header = nativeHeader(desired),
                  header["id"] as? String == m.id, header["kind"] as? String == m.kind,
                  AdditiveFile.regular(header), m.table == AdditiveFile.tableProfile(header) else {
                throw FolderFailure("The saved membership and document identity disagree.",paths:[p])
            }
            if c.exactNativeCopy && (m.table || manifestEdit == nil || before.keys.contains(where:{ folded($0) == folded(p) })) {
                throw FolderFailure("An exact native copy must create a new project member.",paths:[p])
            }
            try AdditiveFile.requireWritable(header,path:p,exactNativeCopy:c.exactNativeCopy)
        }
        if manifestEdit != nil {
            let oldNames = Dictionary(uniqueKeysWithValues:before.map { ($0.value.id,$0.key) })
            let order = Dictionary(uniqueKeysWithValues:captures.enumerated().map { ($1.target.path,$0) })
            for (destination,m) in after {
                guard let source = oldNames[m.id], source != destination else { continue }
                guard let old = changed[source]?.target, let new = changed[destination]?.target,
                      old.expected != nil, old.desired == nil, new.expected == nil, new.desired != nil,
                      let from = order[source], let to = order[destination],
                      (folded(source) == folded(destination) ? from < to : to < from) else {
                    throw FolderFailure("A rename requires the verified source, exclusive destination and ordered manifest update.",paths:[source,destination])
                }
            }
            for (p,m) in after where before[p] != m && changed[p] == nil {
                // Explicitly adopting an existing stray member is allowed only under
                // its declared identity. An unpublished file cannot join the manifest.
                guard let dir = try tree.parent(p), let file = try regular(dir,(p as NSString).lastPathComponent),
                      let h = try Self.header(file), h["id"] as? String == m.id, h["kind"] as? String == m.kind,
                      m.table == AdditiveFile.tableProfile(h) else {
                    throw FolderFailure("The new manifest refers to a missing or different member.",paths:[p])
                }
            }
        }
    }
    func acquire() throws -> String {
        guard leases.count < 16 else { throw FolderFailure("Close a saved snapshot before opening another.") }
        let lock = try readLock()
        let token = uuidName(); leases[token] = ReadSnapshot(lock); return token
    }
    private func readLock() throws -> FD {
        let lock = try tree.lock(write:false)
        if let j = try tree.journal(), try entryInfo(j,"active") != nil {
            throw issue ?? FolderFailure("Committed edits are awaiting recovery.")
        }
        return lock
    }
    // A synchronous external helper keeps this lock alive across all of its reads.
    // Revoking the window's page tokens cannot release the helper's live lock.
    func holdSnapshot() throws -> AnyObject { try readLock() }
    private func checkObserved(_ snapshot: ReadSnapshot) throws {
        try tree.checkRoot()
        let gate = snapshot.lock
        if try gate.info().st_mode & S_IFMT == S_IFDIR {
            if let j = try tree.journal(), try entryInfo(j,"lock") != nil || (try entryInfo(j,"active")) != nil {
                throw FolderFailure("The new project's read barrier changed. Open a fresh saved snapshot.")
            }
        } else {
            guard let j = try tree.journal() else { throw FolderFailure("The saved snapshot lost its project lock.") }
            try tree.verifyLock(gate,in:j)
            guard try entryInfo(j,"active") == nil else { throw FolderFailure("Committed edits are awaiting recovery.") }
        }
        if !snapshot.verifiedModels.isEmpty, try spellings(tree.root,"models") != ["models"] {
            throw FolderFailure.conflict("models")
        }
        for (path,old) in snapshot.observed {
            let name = (path as NSString).lastPathComponent
            guard let dir = try tree.parent(path), let info = try entryInfo(dir,name), sameContents(old,info) else {
                throw FolderFailure("The saved snapshot changed while it was being read.",paths:[path])
            }
            if snapshot.verifiedModels.contains(path), try spellings(dir,name) != [name] { throw FolderFailure.conflict(path) }
        }
    }
    func verifyHeadless(_ lease: String) throws {
        guard let snapshot = leases[lease] else { throw FolderFailure("This saved snapshot has expired.") }
        try tree.checkRoot()
        if try hasActive() { throw FolderFailure("Committed edits are awaiting recovery.") }
        do { try checkObserved(snapshot) }
        catch let error as FolderFailure where !error.paths.isEmpty {
            throw FolderFailure.conflict(error.paths[0])
        }
    }

    func release(_ lease: String) throws {
        guard let snapshot = leases.removeValue(forKey:lease) else { throw FolderFailure("This saved snapshot has expired.") }
        // The lock stays retained through this final external-editor check.
        try checkObserved(snapshot)
    }
    func close() { leases.removeAll(); staged.removeAll() }
    func read(lease: String, paths: [String]) throws -> [[String:Any]] {
        try read(lease:lease,paths:paths,models:[:])
    }
    func desktopReadLease() throws -> [String:String] {
        ["lease":try acquire(),"verifyModels":"gzip-v1"]
    }
    static func modelReadIdentity(_ request: [String:Any]) -> (lease:String, nonce:String)? {
        guard let lease = request["lease"] as? String, isUUID(lease),
              let nonce = request["verificationNonce"] as? String, nonce.utf8.count == 32,
              nonce.utf8.allSatisfy({ (48...57).contains($0) || (97...102).contains($0) }) else { return nil }
        return (lease,nonce)
    }
    func readVerified(_ request: [String:Any]) throws -> [String:Any] {
        guard request["grant"] as? String == grant, let identity = Self.modelReadIdentity(request),
              let paths = request["paths"] as? [String], (1...8).contains(paths.count),
              paths.allSatisfy({ $0.utf8.count <= 4096 }), Set(paths.map(folded)).count == paths.count,
              let refs = request["models"] as? [[String:Any]],
              refs.count <= paths.count else { throw folderBad }
        var models = [String:Desired]()
        for ref in refs {
            guard ref.count == 3, let path = ref["path"] as? String, let hash = ref["sha256"] as? String, isDigest(hash),
                  path == "models/" + hash + ".step.gz", paths.contains(path), models[path] == nil,
                  let length = countValue(ref["byteLength"],max:modelRawCap) else { throw folderBad }
            models[path] = Desired(sha256:hash,length:length)
        }
        return ["lease":identity.lease,"verificationNonce":identity.nonce,"files":try read(lease:identity.lease,paths:paths,models:models)]
    }
    private func read(lease: String, paths: [String], models: [String:Desired]) throws -> [[String:Any]] {
        guard let snapshot = leases[lease], paths.count <= planCap else { throw FolderFailure("This saved snapshot has expired.") }
        try checkObserved(snapshot)
        var remaining = folderCap
        let results: [[String:Any]] = try paths.map { path in
            let future = snapshot.newerMembers[path]
            if future == nil {
                try memberPath(path, manifest:manifest)
                if Self.nativeOwner(path) {
                    if snapshot.newerMinor != nil { throw AdditiveFile.refusal }
                    if !snapshot.sawManifest, let root = try regular(tree.root,manifest), futureMinor(try Self.header(root)) != nil {
                        throw FolderFailure("Read the selected manifest through this snapshot before requesting its newer members.")
                    }
                }
            }
            guard let dir = try tree.parent(path), let file = try regular(dir, (path as NSString).lastPathComponent) else {
                throw FolderFailure("Missing project member.", paths: [path])
            }
            if let model = models[path] {
                let name = (path as NSString).lastPathComponent
                guard try spellings(tree.root,"models") == ["models"], try spellings(dir,name) == [name] else { throw FolderFailure.conflict(path) }
                let initial = try file.info()
                guard initial.st_dev == (try dir.info()).st_dev,
                      snapshot.observed[path].map({ sameContents($0,initial) }) ?? true else { throw FolderFailure.conflict(path) }
                let stored = try file.verifyModel(model,cap:remaining)
                try point("verified-model-read",path)
                try tree.matches(dir,path:path)
                guard let current = try entryInfo(dir,name), sameContents(initial,current) else { throw FolderFailure.conflict(path) }
                snapshot.observed[path] = current
                snapshot.verifiedModels.insert(path)
                remaining -= stored.length
                return ["path":path,"sha256":stored.sha256,"length":stored.length,
                        "model":["sha256":model.sha256,"byteLength":model.length]]
            }
            let bytes = try file.read(remaining); remaining -= bytes.count
            if let future = future {
                let header = nativeHeader(bytes)
                guard header?["kind"] as? String == future.kind, header?["id"] as? String == future.id,
                      let minor = AdditiveFile.minor(header), minor <= (snapshot.newerMinor ?? 0),
                      minor > 0 || Self.nativeOwner(path) else { throw folderBad }
            } else if Self.nativeOwner(path), nativeHeader(bytes) == nil {
                throw FolderFailure("Invalid native document header.",paths:[path])
            }
            if path == manifest {
                guard let head = nativeHeader(bytes), head["kind"] as? String == "project", let id = head["id"] as? String,
                      !id.isEmpty, id.utf8.count <= 1024, projectID == nil || projectID == id else { throw FolderFailure.conflict(manifest) }
                let members = try membership(bytes,includeOpaque:true)
                snapshot.sawManifest = true
                snapshot.newerMinor = futureMinor(head)
                snapshot.newerMembers = snapshot.newerMinor == nil ? [:] : members.mapValues { ($0.id,$0.kind) }
                if snapshot.newerMinor == nil { lastMembership = (try file.info(),members) }
            }
            let h = sha(bytes)
            if let pinned = immutableDigest(path), pinned != h { throw FolderFailure.conflict(path) }
            try tree.matches(dir, path: path)
            guard let current = try entryInfo(dir,(path as NSString).lastPathComponent), sameFile(try file.info(),current) else { throw FolderFailure.conflict(path) }
            snapshot.observed[path] = current
            return ["path":path,"data":bytes.base64EncodedString(),"sha256":h,"length":bytes.count]
        }
        try checkObserved(snapshot)
        return results
    }
    func isSelectedManifest() throws -> Bool {
        if let f = try regular(tree.root,manifest), let h = try Self.header(f),
           h["kind"] as? String == "project", (h["formatVersion"] as? String)?.hasPrefix("2.") == true,
           let id = h["id"] as? String, !id.isEmpty { return true }
        // An interrupted first save can precede installation of its manifest.
        guard let j = try tree.journal(), let f = try regular(j,"active") else { return false }
        let d = try Descriptor.decode(f.read(descriptorCap),manifest:manifest)
        if d.plan.contains(where:{ $0.path == manifest }) { return true }
        let candidates = try names(tree.root).filter { !$0.hasPrefix(".") && $0.hasSuffix(".waffle") }
        return candidates == [manifest]
    }
    func confirmSelection() throws {
        let lock = try readLock()
        try withExtendedLifetime(lock) {
            guard let f = try regular(tree.root,manifest), let h = try Self.header(f),
                  h["kind"] as? String == "project", let version = h["formatVersion"] as? String,
                  version.hasPrefix("2."), let id = h["id"] as? String, !id.isEmpty, id.utf8.count <= 1024 else { throw folderBad }
            if let bound = projectID, bound != id { throw FolderFailure.conflict(manifest) }
            projectID = id
        }
    }
    func hasActive() throws -> Bool {
        guard let j = try tree.journal() else { return false }
        return try entryInfo(j,"active") != nil
    }
    func status() -> [String:Any] {
        if let issue = issue { return ["state":issue.state,"paths":issue.paths,"error":issue.localizedDescription] }
        do {
            if let j = try tree.journal(), try entryInfo(j,"active") != nil { return ["state":"applying","paths":[]] }
            return ["state":"settled","paths":[]]
        } catch { return ["state":"recoveryPending","paths":[],"error":error.localizedDescription] }
    }

    // Return actual NFC spelling. Alias lookups would otherwise remove the new
    // spelling after a crash in a case-only rename on a case-insensitive volume.
    private func occupant(_ t: Target, plan: [Target], retainBytes: Bool = false) throws -> Occupant? {
        guard let dir = try tree.parent(t.path) else { return nil }
        let name = (t.path as NSString).lastPathComponent
        let siblings = try spellings(dir,name)
        guard siblings.count <= 1 else { throw FolderFailure.conflict(t.path) }
        if let other = siblings.first, other != name {
            let peer = (t.path as NSString).deletingLastPathComponent
            let otherPath = peer.isEmpty ? other : peer + "/" + other
            guard plan.contains(where: { $0.path == otherPath && folded($0.path) == folded(t.path) }) else {
                throw FolderFailure.conflict(t.path)
            }
            return nil
        }
        guard siblings.first != nil else { return nil }
        do {
            guard let file = try regular(dir,name) else { return nil }
            let checkedVersion = try file.info()
            if retainBytes {
                let bytes = try file.read(folderCap)
                return Occupant(file:file,checkedVersion:checkedVersion,state:Desired(sha256:sha(bytes),length:bytes.count),bytes:bytes)
            }
            return Occupant(file:file,checkedVersion:checkedVersion,state:try file.digest(),bytes:nil)
        } catch { throw FolderFailure.conflict(t.path) }
    }
    private func patch(_ value: [String:Any], current: Occupant?) throws -> Data {
        guard let current = current, let bytes = current.bytes else { throw folderBad }
        return try spliceMember(value,bytes:bytes,base:current.state.sha256)
    }

    private func capture(_ request: [String:Any], additive: AdditiveProject? = nil, nativeCopyHashes:[String:String]) throws -> ([Captured], [String], [String:String]) {
        guard let input = request["plan"] as? [[String:Any]], input.count <= planCap else { throw folderBad }
        let project = request["projectId"] as? String ?? ""
        var spent = [String](), reused = [String:String]()
        var projectPDFs = [Desired]()
        var total = 0
        let placeholders: [Target] = try input.map { e in
            guard let p = e["path"] as? String else { throw folderBad }; try memberPath(p, manifest: manifest)
            let expected = e["expected"] as? String
            guard expected.map(isDigest) ?? (e["expected"] is NSNull) else { throw folderBad }
            return Target(path: p, expected: expected, desired: (e["remove"] as? Bool == true) ? nil : Desired(sha256:"",length:0))
        }
        try Descriptor(projectId:"",transaction:"",plan:placeholders).validateOrder(manifest: manifest)
        var captured = [Captured](), checkedCopies = Set<String>()
        for (i, e) in input.enumerated() {
            let t = placeholders[i]
            let optionalPDF = additive?.minor == 1 && t.path.hasPrefix("assets/") && t.expected == nil &&
                (e["assetToken"] != nil || e["data"] != nil)
            var exactNativeCopy = false
            if e["nativeCopy"] != nil || nativeCopyHashes[t.path] != nil {
                let copyOwner = ["wsch","wpcb","wdraw","wpanel","wlib"].contains((t.path as NSString).pathExtension)
                guard let marker = e["nativeCopy"] as? [String:Any],
                      let token = marker["grant"] as? String, !token.isEmpty,
                      let hash = marker["sha256"] as? String, isDigest(hash), nativeCopyHashes[t.path] == hash,
                      copyOwner, additive == nil,
                      (t.expected == nil && (e["text"] != nil || e["data"] != nil)) ||
                      (t.expected == hash && e["remove"] as? Bool == true) else {
                    throw FolderFailure("The exact native copy has no matching selected-file grant.",paths:[t.path])
                }
                exactNativeCopy = true
                checkedCopies.insert(t.path)
            }
            if let forward = additive {
                let optionalManifest = t.path == manifest && forward.minor == 1
                guard optionalPDF || (t.expected != nil && t.desired != nil && e["assetToken"] == nil &&
                    (optionalManifest || forward.members[t.path].map({ ["schematic","pcb","drawing","panel","library","block"].contains($0.kind) }) == true))
                    else { throw AdditiveFile.refusal }
            }
            let current = try occupant(t,plan:placeholders,retainBytes:e["splice"] != nil || additive != nil)
            var originalNativeCopyOwner: (id:String,kind:String)?
            if Self.nativeOwner(t.path), let current = current {
                guard let head = try Self.header(current.file),
                      !exactNativeCopy || head["formatVersion"] as? String == "2.0" else { throw folderBad }
                let exactNativeUndo = exactNativeCopy && t.desired == nil
                try AdditiveFile.requireWritable(head,path:t.path,exactNativeCopy:exactNativeUndo)
                if exactNativeUndo, let id = head["id"] as? String, let kind = head["kind"] as? String {
                    originalNativeCopyOwner = (id,kind)
                }
            }
            guard ["remove","text","data","splice","assetToken"].filter({ e[$0] != nil }).count == 1 else { throw folderBad }
            var data: Data?, asset: AssetStage?, desired: Desired?
            if let token = e["assetToken"] as? String {
                guard let item = staged[token], t.path == "assets/" + item.state.sha256, t.expected == nil else { throw folderBad }
                asset = item; desired = item.state; spent.append(token)
            } else if let str = e["text"] as? String { data = Data(str.utf8) }
            else if let str = e["data"] as? String, str.utf8.count <= (folderCap + 2) / 3 * 4, let b = Data(base64Encoded:str) { data = b }
            else if let edits = e["splice"] as? [String:Any] { data = try patch(edits,current:current) }
            else if e["remove"] as? Bool != true || t.expected == nil { throw folderBad }
            if let b = data { guard b.count <= folderCap else { throw folderBad }; desired = Desired(sha256:sha(b),length:b.count) }
            if optionalPDF {
                guard let desired = desired, t.path == "assets/" + desired.sha256,
                      asset.map({ $0.owner == project && $0.mediaType == "application/pdf" }) ?? (data.map { Self.isPDF($0) } == true)
                      else { throw AdditiveFile.refusal }
                projectPDFs.append(desired)
            }
            if exactNativeCopy {
                let checkedHash = t.expected == nil ? desired?.sha256 : current?.state.sha256
                if checkedHash != nativeCopyHashes[t.path] || (t.expected == nil && current != nil) {
                    throw FolderFailure("The exact native copy's bytes or destination changed.",paths:[t.path])
                }
            }
            if let forward = additive, let member = forward.members[t.path] {
                guard let base = current?.bytes, current?.state.sha256 == t.expected, let proposed = data else { throw AdditiveFile.refusal }
                try AdditiveFile.verify(base,proposed,id:member.id,kind:member.kind,minor:forward.minor)
            }
            if t.path == manifest, let proposed = data {
                let currentHeader = try current.flatMap { try Self.header($0.file) }
                if AdditiveFile.minor(nativeHeader(proposed)) == 1 || AdditiveFile.tableProfile(currentHeader) {
                    let base = try current?.bytes ?? current?.file.read(folderCap)
                    try AdditiveFile.verifyProjectWrite(base,proposed,id:project)
                }
            }
            if let pinned = immutableDigest(t.path), let value = desired, value.sha256 != pinned { throw FolderFailure.conflict(t.path) }
            if t.path == manifest, desired == nil { throw folderBad }
            if t.path.hasPrefix("assets/"), desired == nil {
                throw FolderFailure("Removing a placement retains its asset. Blob reclamation requires a verified project-wide reachability check.",paths:[t.path])
            }
            if t.path.hasPrefix("assets/"), let d = desired {
                guard t.path == "assets/" + d.sha256, t.expected == nil else { throw folderBad }
                if current?.state == d { reused[t.path] = d.sha256; continue }
            }
            guard current?.state.sha256 == t.expected else { throw FolderFailure.conflict(t.path) }
            if let d = desired, current?.state == d { reused[t.path] = d.sha256; continue }
            total += desired?.length ?? 0; guard total <= folderTotal else { throw folderBad }
            captured.append(Captured(target:Target(path:t.path,expected:t.expected,desired:desired),expectedFile:current?.checkedVersion,data:data,asset:asset,exactNativeCopy:exactNativeCopy,
                                     originalNativeCopyOwner:originalNativeCopyOwner))
        }
        guard checkedCopies.count == nativeCopyHashes.count else { throw folderBad }
        if !projectPDFs.isEmpty {
            guard let root = captured.first(where:{ $0.target.path == manifest })?.data,
                  projectPDFs.allSatisfy({ Self.ownerContains(root,owner:project,digest:$0.sha256,length:$0.length,media:"application/pdf") })
                  else { throw AdditiveFile.refusal }
        }
        for token in spent {
            guard let a = staged[token], captured.contains(where: { c in
                guard let b = c.data, c.target.path == manifest || c.target.path.hasSuffix(".wsch") else { return false }
                return Self.ownerContains(b, owner:a.owner, digest:a.state.sha256, length:a.state.length, media:a.mediaType)
            }) else { throw FolderFailure("The attachment and its owner must be saved together.") }
        }
        return (captured,spent,reused)
    }

    private func verifyReadSet(_ readSet: [String:String], additive: AdditiveProject? = nil) throws {
        guard readSet.count <= planCap else { throw folderBad }
        for (path, hash) in readSet {
            if let context = additive, let known = context.members[path] {
                guard let dir = try tree.parent(path), let file = try regular(dir,(path as NSString).lastPathComponent),
                      let head = try Self.header(file), head["id"] as? String == known.id,
                      head["kind"] as? String == known.kind, let minor = AdditiveFile.minor(head), minor <= context.minor else {
                    throw FolderFailure.conflict(path)
                }
            } else {
                try memberPath(path, manifest:manifest)
                if additive != nil && Self.nativeOwner(path) { throw AdditiveFile.refusal }
            }
            guard isDigest(hash) else { throw folderBad }
            let target = Target(path:path,expected:hash,desired:nil)
            guard try occupant(target,plan:[target])?.state.sha256 == hash else { throw FolderFailure.conflict(path) }
        }
    }

    func commit(_ request: [String:Any], nativeCopyHashes:[String:String] = [:], acknowledged: ([String:Any]) -> Void) throws {
        try commitHeadless(request,readSet:[:],nativeCopyHashes:nativeCopyHashes,acknowledged:acknowledged)
    }

    func commitHeadless(_ request: [String:Any], readSet: [String:String], nativeCopyHashes:[String:String] = [:], acknowledged: ([String:Any]) -> Void) throws {
        guard request["manifest"] as? String == manifest, let id = request["projectId"] as? String,
              !id.isEmpty, id.utf8.count <= 1024 else { throw folderBad }
        let lock = try tree.lock(write:true,beforeCreating:{
            if let future = try self.inputContext(id,request) {
                try self.verifyReadSet(readSet,additive:future)
                _ = try self.capture(request,additive:future,nativeCopyHashes:nativeCopyHashes)
            }
        })
        try withExtendedLifetime(lock) {
            guard let j = try tree.journal() else { throw folderBad }
            try recoverLocked(j,lock:lock)
            let forward = try inputContext(id,request)
            try verifyReadSet(readSet,additive:forward)
            let (captures,spent,reused) = try capture(request,additive:forward,nativeCopyHashes:nativeCopyHashes)
            if captures.isEmpty {
                try checkIdentity(id,plan:[],stage:nil)
                acknowledged(["saved":true,"transaction":NSNull(),"hashes":reused]); return
            }
            if forward == nil { try verifyMembers(captures) }
            let tx = uuidName()
            let descriptor = Descriptor(projectId:id,transaction:tx,plan:captures.map(\.target))
            try checkIdentity(id,plan:descriptor.plan,stage:nil)
            try point("before-stage",nil)
            guard mkdirat(j.value,tx,0o700) == 0, let stage = try directory(j,tx) else { throw systemFailure("Preparing the transaction") }
            var written = Set<String>()
            for (i,c) in captures.enumerated() {
                guard let desired = c.target.desired, written.insert(desired.sha256).inserted else { continue }
                let f = try freshFile(stage,desired.sha256)
                if let b = c.data { try f.write(b) } else if let a = c.asset { try a.file.chunks(cap:folderCap,privateTemporary:true) { try f.write($0) } } else { throw folderBad }
                try point("after-stage-write:\(i)",c.target.path)
                try f.flushForCommit(); try point("after-stage-flush:\(i)",c.target.path)
                guard try f.digest() == desired else { throw folderBad }
            }
            try stage.flushForCommit(); try j.flushForCommit()
            try point("after-stage-dir-sync",nil)
            try checkIdentity(id,plan:descriptor.plan,stage:stage)
            try verifyParents(descriptor.plan)
            let temp = ".active-" + tx, out = try freshFile(j,temp), bytes = descriptor.encoded()
            guard bytes.count <= descriptorCap else { throw folderBad }
            try out.write(bytes); try point("after-descriptor-write",nil)
            try out.sync(); try point("after-descriptor-flush",nil)
            try point("before-publish",nil)
            try verifyReadSet(readSet,additive:forward)
            if let forward = forward, try additiveProject(id)?.hash != forward.hash { throw FolderFailure.conflict(manifest) }
            if forward == nil { try checkIdentity(id,plan:descriptor.plan,stage:nil) }
            for (path,h) in reused {
                let t = Target(path:path,expected:h,desired:nil)
                if try occupant(t,plan:[t])?.state.sha256 != h { throw FolderFailure.conflict(path) }
            }
            for capture in captures {
                let t = capture.target
                if let previous = capture.expectedFile, let dir = try tree.parent(t.path),
                   let current = try entryInfo(dir,(t.path as NSString).lastPathComponent),
                   try spellings(dir,(t.path as NSString).lastPathComponent) == [(t.path as NSString).lastPathComponent],
                   sameFile(previous,current), current.st_nlink == 1, current.st_size == previous.st_size,
                   current.st_ctimespec.tv_sec == previous.st_ctimespec.tv_sec, current.st_ctimespec.tv_nsec == previous.st_ctimespec.tv_nsec {
                    // We just hashed these raw bytes under this lock. A write, relink
                    // or equal-size/mtime edit changes the APFS inode change time.
                    continue
                }
                guard try occupant(t,plan:descriptor.plan)?.state.sha256 == t.expected else { throw FolderFailure.conflict(t.path) }
            }
            guard let actual = try tree.journal(), sameFile(try actual.info(),try j.info()) else { throw folderBad }
            try tree.verifyLock(lock,in:j)
            try exclusiveRename(j,temp,j,"active")
            do {
                try point("after-publish",nil)
                try j.sync(directory:true,witness:out); try point("after-commit-sync",nil)
            } catch {
                issue = Self.publicationFailure(error, "The descriptor may have been published. Reopen the folder to verify the save.")
                throw issue!
            }
            projectID = id
            var hashes: [String:Any] = reused
            for t in descriptor.plan { hashes[t.path] = (t.desired?.sha256 as Any?) ?? NSNull() }
            acknowledged(["saved":true,"transaction":tx,"hashes":hashes])
            for token in spent { staged.removeValue(forKey:token) }
            do {
                try point("acknowledged",nil)
                try apply(descriptor,journal:j,stage:stage,lock:lock)
                issue = nil
            } catch { issue = failure(error); throw error }
        }
    }
    // FSEvents coalesces neighbouring writes. Suppress a matching committed
    // content identity only; external changes in the same batch still surface.
    func externalChanges(_ paths: [String]) -> [String] {
        guard !notifications.isEmpty, let lock = try? readLock() else { return paths }
        return withExtendedLifetime(lock) {
            paths.filter { p in
                guard let installed = notifications[p] else { return true }
                do {
                    let parts = try portableParts(p), dir = try tree.parent(p)
                    let file = try dir.flatMap { try regular($0,parts.last!) }
                    if try file?.digest().sha256 == installed.digest { return false }
                } catch { }
                notifications.removeValue(forKey:p); return true
            }
        }
    }

    private func verifyRecoveryMembership(_ plan: [Target], stage: FD, project:String,
                                          inheritedNativeCopies:[String:String]? = nil) throws {
        let manifestEdit = plan.first(where:{ $0.path == manifest })
        var joinsTable = false
        if let desired = manifestEdit?.desired, let staged = try regular(stage,desired.sha256),
           let current = try regular(tree.root,manifest), AdditiveFile.minor(try Self.header(current)) == 1,
           AdditiveFile.tableProfile(try Self.header(staged)) {
            let old = try current.read(folderCap), installed = sha(old)
            guard installed == manifestEdit?.expected || installed == desired.sha256 else { throw FolderFailure.conflict(manifest) }
            try AdditiveFile.verifyProjectWrite(old,try staged.read(folderCap),id:project)
            joinsTable = true
        }
        if let forward = try additiveProject(project),
           !joinsTable,
           !(manifestEdit?.expected == nil && manifestEdit?.desired?.sha256 == forward.hash) {
            var nextRoot: Data?
            if let target = manifestEdit {
                guard forward.minor == 1, let desired = target.desired, let expected = target.expected,
                      let staged = try regular(stage,desired.sha256), let current = try regular(tree.root,manifest)
                      else { throw AdditiveFile.refusal }
                let old = try current.read(folderCap), hash = sha(old), next = try staged.read(folderCap)
                guard hash == expected || hash == desired.sha256 else { throw FolderFailure.conflict(manifest) }
                try AdditiveFile.verifyProjectWrite(old,next,id:project)
                if expected != desired.sha256 { nextRoot = next }
            }
            for target in plan where target.path != manifest {
                if target.path.hasPrefix("assets/"), target.expected == nil, let desired = target.desired,
                   target.path == "assets/" + desired.sha256, let root = nextRoot,
                   let staged = try regular(stage,desired.sha256),
                   Self.ownerContains(root,owner:project,digest:desired.sha256,length:desired.length,media:"application/pdf") {
                    var prefix = [UInt8](repeating:0,count:8)
                    let count = prefix.withUnsafeMutableBytes { pread(staged.value,$0.baseAddress!,$0.count,0) }
                    guard count >= 5, Self.isPDF(prefix.prefix(count)) else { throw AdditiveFile.refusal }
                    continue
                }
                guard let m = forward.members[target.path], ["schematic","pcb","drawing","panel","library","block"].contains(m.kind),
                      let expected = target.expected, let desired = target.desired,
                      let f = try regular(stage,desired.sha256), let dir = try tree.parent(target.path),
                      let current = try regular(dir,(target.path as NSString).lastPathComponent) else { throw FolderFailure.conflict(target.path) }
                let old = try current.read(folderCap), hash = sha(old)
                guard hash == expected || hash == desired.sha256 else { throw FolderFailure.conflict(target.path) }
                try AdditiveFile.verify(old,try f.read(folderCap),id:m.id,kind:m.kind,minor:forward.minor)
            }
            return
        }
        let next: [String:Member]
        if let d = manifestEdit?.desired, let f = try regular(stage,d.sha256) {
            next = try membership(f.read(folderCap))
        } else { next = try oldMembership() }
        let suffixes = ["wsch","wpcb","wdraw","wpanel","wlib","wblock"]
        for t in plan where suffixes.contains((t.path as NSString).pathExtension) {
            let canReplayCopy = manifestEdit != nil && (t.path as NSString).pathExtension != "wblock"
            if let expected = t.expected, let dir = try tree.parent(t.path), let current = try regular(dir,(t.path as NSString).lastPathComponent) {
                guard let head = try Self.header(current) else { throw folderBad }
                let exactNativeUndo = !AdditiveFile.tableProfile(head) && canReplayCopy && next[t.path] == nil && t.desired == nil &&
                    (inheritedNativeCopies == nil || inheritedNativeCopies?[t.path] == expected)
                guard !exactNativeUndo || head["formatVersion"] as? String == "2.0" else { throw folderBad }
                try AdditiveFile.requireWritable(head,path:t.path,exactNativeCopy:exactNativeUndo)
            }
            if let d = t.desired {
                guard let member = next[t.path], let f = try regular(stage,d.sha256), let h = try Self.header(f),
                      h["id"] as? String == member.id, h["kind"] as? String == member.kind,
                      AdditiveFile.regular(h), member.table == AdditiveFile.tableProfile(h) else {
                    throw FolderFailure("A staged document does not match the transaction's declared membership.",paths:[t.path])
                }
                // A published descriptor already carries the verified complete new owner.
                // Conflict replacements can inherit that authority only for its original bytes.
                let exactNativeCopy = !member.table && canReplayCopy && t.expected == nil &&
                    (inheritedNativeCopies == nil || inheritedNativeCopies?[t.path] == d.sha256)
                try AdditiveFile.requireWritable(h,path:t.path,exactNativeCopy:exactNativeCopy)
            } else if next[t.path] != nil || !plan.contains(where:{ $0.path == manifest }) {
                throw FolderFailure("The removal has no matching change of project membership.",paths:[t.path])
            }
        }
    }
    private func verifyParents(_ plan: [Target]) throws {
        for t in plan { _ = try tree.parent(t.path) }
    }
    private static func publicationFailure(_ error: Error, _ otherwise: String) -> FolderFailure {
        if let original = error as? FolderFailure, original.state == "unsupportedVolume" {
            return FolderFailure(original.message + " The published journal has been retained.",state:original.state)
        }
        return FolderFailure(otherwise)
    }
    private func failure(_ e: Error) -> FolderFailure {
        e as? FolderFailure ?? FolderFailure(e.localizedDescription)
    }
    func recover() throws {
        // Ordinary opens are read-only; a fresh clone acquires no ignored files.
        do {
            let l = try acquire()
            defer { try? release(l) }
            if let j = try tree.journal() {
                let abandoned = try names(j).contains { isUUID($0) || ($0.hasPrefix(".active-") && isUUID(String($0.dropFirst(8)))) }
                if !abandoned { issue = nil; return }
            } else { issue = nil; return }
        } catch { /* An active descriptor is recovered exclusively below. */ }
        let lock = try tree.lock(write:true)
        try withExtendedLifetime(lock) {
            guard let j = try tree.journal() else { throw folderBad }
            try recoverLocked(j,lock:lock)
        }
    }
    private func recoverLocked(_ j: FD, lock: FD) throws {
        guard let file = try regular(j,"active") else {
            // An interrupted descriptor unlink may not yet have reached the disk.
            // Persist its absence before releasing any retained desired bytes.
            if try names(j).contains(where: { isUUID($0) || $0.hasPrefix(".active-") }) {
                try j.sync(directory:true,witness:lock); try Self.cleanOrphans(j,lock:lock)
            }
            issue = nil; return
        }
        do {
            let descriptor = try Descriptor.decode(file.read(descriptorCap),manifest:manifest)
            guard let stage = try directory(j,descriptor.transaction) else { throw FolderFailure("Missing staged transaction.") }
            try checkIdentity(descriptor.projectId,plan:descriptor.plan,stage:stage)
            var verified = Set<String>()
            for t in descriptor.plan {
                guard let d = t.desired, verified.insert(d.sha256).inserted else { continue }
                guard let f = try regular(stage,d.sha256), try f.digest() == d else {
                    throw FolderFailure("A staged member failed verification.",paths:[t.path])
                }
            }
            try verifyRecoveryMembership(descriptor.plan,stage:stage,project:descriptor.projectId)
            try apply(descriptor,journal:j,stage:stage,lock:lock); issue = nil
        } catch { issue = failure(error); throw error }
    }
    private func apply(_ d: Descriptor, journal j: FD, stage: FD, lock: FD) throws {
        for (i,t) in d.plan.enumerated() {
            let current = try occupant(t,plan:d.plan)
            try point("before-install:\(i)",t.path)
            guard current?.state == t.desired || current?.state.sha256 == t.expected else { throw FolderFailure.conflict(t.path) }
            if current?.state != t.desired {
                guard let dir = try tree.parent(t.path, create:t.desired != nil) else { throw FolderFailure.conflict(t.path) }
                let name = (t.path as NSString).lastPathComponent
                var tmp: String?
                if let desired = t.desired {
                    let temp = ".install-" + uuidName(), out = try freshFile(stage,temp)
                    guard let source = try regular(stage,desired.sha256) else { throw folderBad }
                    var hash = SHA256(), count = 0
                    try source.chunks(cap:desired.length) { try out.write($0); hash.update(data:$0); count += $0.count }
                    guard hex(hash.finalize()) == desired.sha256, count == desired.length else { throw folderBad }
                    try point("after-install-temp-write:\(i)",t.path)
                    try out.flushForCommit(); try point("after-install-temp-flush:\(i)",t.path)
                    tmp = temp
                }
                // The final guard hashes the current raw bytes and verifies the open
                // directory and target identities immediately before the namespace edit.
                try tree.verifyLock(lock,in:j)
                try tree.matches(dir,path:t.path)
                let final = try occupant(t,plan:d.plan)
                guard final?.state == current?.state else { throw FolderFailure.conflict(t.path) }
                if let a = current, let b = final, !(try sameFile(a.file.info(),b.file.info())) { throw FolderFailure.conflict(t.path) }
                try point("after-target-verify:\(i)",t.path)
                if let temp = tmp {
                    if current == nil { try exclusiveRename(stage,temp,dir,name) }
                    else if renameat(stage.value,temp,dir.value,name) != 0 { throw systemFailure("Replacing a project member") }
                } else if unlinkat(dir.value,name,0) != 0 { throw systemFailure("Removing the verified project member") }
                try point("after-install:\(i)",t.path)
                try stage.flushForCommit()
            }
            if let dir = try tree.parent(t.path) { try dir.flushForCommit() }
            try point("after-dir-sync:\(i)",t.path)
        }
        for t in d.plan {
            guard try occupant(t,plan:d.plan)?.state == t.desired else { throw FolderFailure.conflict(t.path) }
        }
        guard let active = try regular(j,"active"), try active.read(descriptorCap) == d.encoded(),
              let current = try tree.journal(), sameFile(try j.info(),try current.info()) else { throw folderBad }
        // The already durable descriptor protects every intermediate install.
        // Persist all fsync'd working files and parent entries before it can vanish.
        try j.sync(directory:true,witness:lock)
        try point("before-unlink",nil)
        try tree.verifyLock(lock,in:j)
        guard unlinkat(j.value,"active",0) == 0 else { throw systemFailure("Clearing the transaction") }
        try point("after-unlink",nil); try j.sync(directory:true,witness:lock); try point("after-unlink-sync",nil)
        try Self.clean(j,name:d.transaction); try point("after-cleanup",nil)
        if notifications.count + d.plan.count > planCap { notifications.removeAll() }
        for target in d.plan { notifications[target.path] = Installed(digest:target.desired?.sha256) }
    }
    fileprivate static func clean(_ j: FD, name: String, orphan: Bool = false) throws {
        guard isUUID(name), let stage = try directory(j,name) else { return }
        let files = try names(stage)
        guard try files.allSatisfy({ n in
            guard isDigest(n) || (n.hasPrefix(".install-") && isUUID(String(n.dropFirst(9)))) else { return false }
            guard let info = try entryInfo(stage,n) else { return false }
            guard info.st_mode & S_IFMT == S_IFREG, info.st_nlink == 1 else { return false }
            if orphan && isDigest(n) { return try regular(stage,n)?.digest().sha256 == n }
            return true
        }) else { return } // Preserve anything of unknown origin/type.
        for n in files { guard unlinkat(stage.value,n,0) == 0 else { throw systemFailure("Cleaning staged data") } }
        try stage.flushForCommit()
        guard unlinkat(j.value,name,AT_REMOVEDIR) == 0 else { throw systemFailure("Cleaning the transaction") }
        try j.flushForCommit()
    }
    fileprivate static func cleanOrphans(_ j: FD, lock: FD) throws {
        for n in try names(j) {
            if isUUID(n) { try clean(j,name:n,orphan:true) }
            else if n.hasPrefix(".active-"), isUUID(String(n.dropFirst(8))), let info = try entryInfo(j,n),
                    info.st_mode & S_IFMT == S_IFREG, info.st_nlink == 1 {
                guard unlinkat(j.value,n,0) == 0 else { throw systemFailure("Cleaning an unpublished descriptor") }
                try j.sync(directory:true,witness:lock)
            }
        }
    }
    private static func ownerContains(_ bytes: Data, owner: String, digest: String, length: Int, media: String) -> Bool {
        let lines = bytes.split(separator:10)
        guard let head = lines.first, let h = try? JSONSerialization.jsonObject(with:head) as? [String:Any],
              h["id"] as? String == owner else { return false }
        func matches(_ value: Any) -> Bool {
            if let o = value as? [String:Any] {
                if o["sha256"] as? String == digest, countValue(o["byteLength"],max:folderCap) == length,
                   o["mediaType"] as? String == media { return true }
                return o.values.contains(where:matches)
            }
            return (value as? [Any])?.contains(where:matches) ?? false
        }
        let kind = h["kind"] as? String
        guard kind == "schematic" || kind == "project" && media == "application/pdf" else { return false }
        let needle = Data(digest.utf8)
        return lines.dropFirst().contains {
            guard $0.range(of:needle) != nil,
                  let row = try? JSONSerialization.jsonObject(with:$0) as? [String:Any] else { return false }
            if kind == "schematic" { return matches(row) }
            guard row["kind"] as? String == "datasheetRef", let value = row["value"] as? [String:Any],
                  value["sha256"] as? String == digest, countValue(value["byteLength"],max:folderCap) == length,
                  let ref = value["asset"] as? [String:Any], ref["sha256"] as? String == digest,
                  countValue(ref["byteLength"],max:folderCap) == length else { return false }
            return ref["mediaType"] as? String == media
        }
    }
    // The source is an already-open, authorized native selection. It never crosses
    // the page bridge as a filename. Unlink the private temp immediately; the
    // OS releases a cancelled or crashed edit's bytes on closing its open handle.
    private func stageAsset(owner: String, media: String, copy: (FD,Int) throws -> Desired) throws -> [String:Any] {
        guard !owner.isEmpty, owner.utf8.count <= 1024, !media.isEmpty, media.utf8.count <= 128, staged.count < 64 else { throw folderBad }
        var template = Array((NSTemporaryDirectory() as NSString).appendingPathComponent("waffle-attachment.XXXXXX").utf8CString)
        let fd = try FD(mkstemp(&template),"Staging a selected attachment")
        guard unlink(String(cString:template)) == 0 else { throw systemFailure("Protecting the private attachment") }
        let available = folderTotal - staged.values.reduce(0) { $0 + $1.state.length }
        let desired = try copy(fd,min(folderCap,available)), token = uuidName()
        staged[token] = AssetStage(file:fd,owner:owner,mediaType:media,state:desired)
        return ["assetToken":token,"ownerId":owner,"assetRef":["sha256":desired.sha256,"byteLength":desired.length,"mediaType":media] as [String:Any]]
    }
    func stageAsset(source: FileHandle, owner: String, mediaType: String) throws -> [String:Any] {
        try stageAsset(owner:owner,media:mediaType) { out,cap in
            let input = try FD(dup(source.fileDescriptor),"Holding the selected attachment")
            var hash = SHA256(), size = 0
            try input.chunks(cap:cap) { try out.write($0); hash.update(data:$0); size += $0.count }
            return Desired(sha256:hex(hash.finalize()),length:size)
        }
    }
    func stageAsset(bytes: Data, owner: String, mediaType: String) throws -> [String:Any] {
        try stageAsset(owner:owner,media:mediaType) { out,cap in
            guard bytes.count <= cap else { throw folderBad }
            try out.write(bytes); return Desired(sha256:sha(bytes),length:bytes.count)
        }
    }
    private func proofKey(_ profile: URL, create: Bool) throws -> SymmetricKey {
        let path = profile.appendingPathComponent("folder-recovery",isDirectory:true)
        if create { try FileManager.default.createDirectory(at:path,withIntermediateDirectories:true,attributes:[.posixPermissions:0o700]) }
        let dir = try FD(Darwin.open(path.path,dirFlags),"Opening private draft storage")
        let name = "provenance-v1"
        var confirmPublication = false
        if create && faccessat(dir.value,name,F_OK,0) != 0 && errno == ENOENT {
            let temp = uuidName()
            let file = try FD(openat(dir.value,temp,O_WRONLY|O_CREAT|O_EXCL|O_NOFOLLOW|O_CLOEXEC,0o600),"Creating private draft key")
            defer { unlinkat(dir.value,temp,0) }
            let key = SymmetricKey(size:.bits256)
            try file.write(key.withUnsafeBytes { Data($0) }); try file.sync()
            guard renameatx_np(dir.value,temp,dir.value,name,UInt32(RENAME_EXCL)) == 0 || errno == EEXIST else { throw folderBad }
            confirmPublication = true
        }
        let file = try FD(openat(dir.value,name,O_RDONLY|O_NOFOLLOW|O_CLOEXEC),"Opening private draft key")
        let st = try file.info()
        guard st.st_uid == getuid(), st.st_mode & S_IFMT == S_IFREG, st.st_nlink == 1, st.st_size == 32 else { throw folderBad }
        if confirmPublication { try dir.sync(directory:true,witness:file) }
        var bytes = [UInt8](repeating:0,count:32)
        guard bytes.withUnsafeMutableBytes({ pread(file.value,$0.baseAddress!,32,0) }) == 32 else { throw folderBad }
        return SymmetricKey(data:bytes)
    }
    func draftAsset(_ r: [String:Any], profile: URL, restore: Bool) throws -> [String:Any] {
        try tree.checkRoot()
        guard let scope = draftScope, let owner = r["ownerId"] as? String, !owner.isEmpty, owner.utf8.count <= 1024,
              let ref = r["assetRef"] as? [String:Any], let hash = ref["sha256"] as? String, isDigest(hash),
              let size = countValue(ref["byteLength"],max:folderCap), size > 0, let media = ref["mediaType"] as? String,
              ["image/png","image/jpeg","image/webp","image/heic","image/svg+xml","application/pdf"].contains(media) else { throw folderBad }
        if !restore {
            guard let token = r["assetToken"] as? String, let a = staged[token], a.owner == owner,
                  a.mediaType == media, a.state == Desired(sha256:hash,length:size) else { throw folderBad }
        }
        let fields = Data([scope,hash,String(size),media,owner].joined(separator:"\n").utf8)
        let key = try proofKey(profile,create:!restore)
        let mac = HMAC<SHA256>.authenticationCode(for:fields,using:key)
        if !restore { return ["proof":hex(mac)] }
        guard let proof = r["proof"] as? String, proof == hex(mac),
              let encoded = r["data"] as? String, encoded.utf8.count == (size+2)/3*4,
              let bytes = Data(base64Encoded:encoded), bytes.count == size, sha(bytes) == hash,
              try Self.mediaType(prefix:Array(bytes.prefix(8192))) == media else { throw FolderFailure("The private draft original could not be verified.") }
        return try stageAsset(bytes:bytes,owner:owner,mediaType:media)
    }
    func dropAsset(_ token: String) { staged.removeValue(forKey:token) }
    private func range(_ file: FD, size: Int, offset: Int, length: Int) throws -> [String:Any] {
        let wanted = min(length,size-offset)
        var bytes = [UInt8](repeating:0,count:wanted), done = 0
        while done < wanted {
            let n = bytes.withUnsafeMutableBytes { pread(file.value,$0.baseAddress!+done,wanted-done,off_t(offset+done)) }
            if n < 0 && errno == EINTR { continue }
            guard n > 0 else { throw FolderFailure("The attachment range could not be read.") }; done += n
        }
        return ["data":Data(bytes).base64EncodedString(),"offset":offset,"length":done,"eof":offset+done == size]
    }
    func readAsset(lease: String?, stagedToken: String? = nil, owner: String, asset: [String:Any], purpose: String, offset: Int, length: Int) throws -> [String:Any] {
        guard let digest = asset["sha256"] as? String, isDigest(digest),
              let size = countValue(asset["byteLength"],max:folderCap), let media = asset["mediaType"] as? String,
              !owner.isEmpty, !purpose.isEmpty, (0...size).contains(offset), (1...(1<<20)).contains(length) else { throw folderBad }
        if let token = stagedToken {
            guard let a = staged[token], a.owner == owner, a.mediaType == media, a.state == Desired(sha256:digest,length:size) else { throw folderBad }
            return try range(a.file,size:size,offset:offset,length:length)
        }
        guard let lease = lease, let snapshot = leases[lease] else { throw FolderFailure("This saved snapshot has expired.") }
        try checkObserved(snapshot)
        let key = quote(owner) + quote(digest) + quote(media) + String(size)
        if let cached = snapshot.media[key] { return try range(cached.file,size:size,offset:offset,length:length) }
        guard let manifestFile = try regular(tree.root,manifest) else { throw folderBad }
        let manifestBytes = try manifestFile.read(folderCap)
        let paths: [String] = manifestBytes.split(separator:10).compactMap { line in
            guard let r = try? JSONSerialization.jsonObject(with:line) as? [String:Any],
                  r["kind"] as? String == "document", r["id"] as? String == owner,
                  r["docKind"] as? String == "schematic" else { return nil }
            return r["path"] as? String
        }
        let ownerPath: String, ownerFile: FD
        if Self.ownerContains(manifestBytes,owner:owner,digest:digest,length:size,media:media) {
            ownerPath = manifest
            ownerFile = manifestFile
        } else {
            guard paths.count == 1 else { throw FolderFailure("The attachment owner is unavailable.") }
            ownerPath = paths[0]; try memberPath(ownerPath,manifest:manifest)
            guard let parent = try tree.parent(ownerPath), let doc = try regular(parent,(ownerPath as NSString).lastPathComponent),
                  Self.ownerContains(try doc.read(folderCap),owner:owner,digest:digest,length:size,media:media) else {
                throw FolderFailure("The attachment does not belong to its saved owner.")
            }
            ownerFile = doc
        }
        guard let assets = try tree.walk(["assets"]), let f = try regular(assets,digest) else {
            throw FolderFailure("Missing attachment.",paths:["assets/"+digest])
        }
        // Spool a verified immutable read once per lease. A client reading 256 MiB
        // in 1 MiB ranges neither rehashes the file 256 times nor trusts a mutable inode.
        var temp = Array((NSTemporaryDirectory() as NSString).appendingPathComponent("waffle-read.XXXXXX").utf8CString)
        let copy = try FD(mkstemp(&temp),"Preparing the verified attachment")
        guard unlink(String(cString:temp)) == 0 else { throw systemFailure("Protecting the attachment snapshot") }
        var hash = SHA256(), pos = 0
        try f.chunks(cap:size) { chunk in try copy.write(chunk); hash.update(data:chunk); pos += chunk.count }
        guard pos == size, hex(hash.finalize()) == digest else { throw FolderFailure.conflict("assets/"+digest) }
        if snapshot.media.count >= 16 || snapshot.media.values.reduce(0,{ $0+$1.length }) + size > folderTotal { snapshot.media.removeAll() }
        snapshot.observed[manifest] = try manifestFile.info()
        snapshot.observed[ownerPath] = try ownerFile.info()
        snapshot.observed["assets/"+digest] = try f.info()
        try checkObserved(snapshot)
        snapshot.media[key] = (copy,size)
        return try range(copy,size:size,offset:offset,length:length)
    }
    func localState(_ newValue: [String:Any]?) throws -> [String:Any] {
        let name = "workspace-v1.json"
        let lock = try tree.lock(write:newValue != nil)
        return try withExtendedLifetime(lock) {
            guard let dir = try tree.walk([".waffle","local"],create:newValue != nil) else { return [:] }
            if let new = newValue {
                let data = try JSONSerialization.data(withJSONObject:new)
                guard data.count <= 1<<20 else { throw folderBad }
                let temp = ".workspace-" + uuidName(), fd = try freshFile(dir,temp)
                defer { unlinkat(dir.value,temp,0) }
                try fd.write(data); try fd.sync()
                if let old = try entryInfo(dir,name), old.st_mode & S_IFMT != S_IFREG || old.st_nlink != 1 { throw folderBad }
                guard renameat(dir.value,temp,dir.value,name) == 0 else { throw systemFailure("Writing the local workspace") }
                try dir.sync(directory:true,witness:fd); return new
            }
            guard let f = try regular(dir,name) else { return [:] }
            guard let o = try JSONSerialization.jsonObject(with:f.read(1<<20)) as? [String:Any] else { throw folderBad }
            return o
        }
    }
}

extension FolderTransactions {
    static func createRoot(at selection: URL) throws -> String {
        let name = selection.lastPathComponent
        guard !name.hasPrefix("."), (try portableParts(name + ".waffle")).count == 1 else { throw folderBad }
        let parent = selection.deletingLastPathComponent().resolvingSymlinksInPath()
        let dir = try FD(Darwin.open(parent.path,dirFlags),"Opening the chosen parent folder")
        var volume = statfs()
        guard fstatfs(dir.value,&volume) == 0, (UInt64(volume.f_flags) & UInt64(MNT_LOCAL)) != 0 else {
            throw FolderFailure("The volume does not provide local project durability. Choose a local folder.",state:"unsupportedVolume")
        }
        guard !(try names(dir)).contains(where:{ folded($0) == folded(name) }) else { throw FolderFailure.conflict(name) }
        // There is no project-file witness until the folder exists. Check the
        // selected parent's capability before creating a name on an unsupported volume.
        try dir.sync(directory:true)
        guard mkdirat(dir.value,name,0o700) == 0 else {
            if errno == EEXIST { throw FolderFailure.conflict(name) }; throw systemFailure("Creating the new project folder")
        }
        try dir.sync(directory:true)
        return name + ".waffle"
    }
    static func mediaType(of handle: FileHandle) throws -> String {
        var s = stat()
        guard fstat(handle.fileDescriptor,&s) == 0, s.st_mode & S_IFMT == S_IFREG, s.st_nlink == 1,
              s.st_size > 0, s.st_size <= folderCap else { throw folderBad }
        var b = [UInt8](repeating:0,count:8192)
        let n = b.withUnsafeMutableBytes { pread(handle.fileDescriptor,$0.baseAddress!,$0.count,0) }
        guard n > 0 else { throw FolderFailure("The selected attachment has no readable signature.") }
        return try mediaType(prefix:Array(b.prefix(n)))
    }
    static func isPDF<Bytes: Collection>(_ bytes: Bytes) -> Bool where Bytes.Element == UInt8 {
        let content = bytes.starts(with:[0xef,0xbb,0xbf]) ? bytes.dropFirst(3) : bytes.dropFirst(0)
        return content.starts(with:"%PDF-".utf8)
    }
    private static func mediaType(prefix b: [UInt8]) throws -> String {
        func ascii(_ lo: Int, _ hi: Int) -> String {
            guard hi <= b.count else { return "" }; return String(decoding:b[lo..<hi],as:UTF8.self)
        }
        if b.starts(with:[0x89,80,78,71,13,10,26,10]) { return "image/png" }
        if b.starts(with:[255,216,255]) { return "image/jpeg" }
        if ascii(0,4) == "RIFF" && ascii(8,12) == "WEBP" { return "image/webp" }
        if ascii(4,8) == "ftyp" && ["heic","heix","hevc","hevx","mif1","msf1"].contains(ascii(8,12)) { return "image/heic" }
        if isPDF(b) { return "application/pdf" }
        let xml = String(decoding:b,as:UTF8.self)
        if xml.range(of:#"^\s*(?:<\?xml[^>]*>\s*)?<svg(?:\s|>)"#,options:.regularExpression) != nil { return "image/svg+xml" }
        throw FolderFailure("The attachment's media type was not recognised.")
    }
}

extension FolderTransactions {
    private func activePlan(_ j: FD, transaction: String? = nil) throws -> (Descriptor,FD,Data) {
        guard let active = try regular(j,"active") else { throw FolderFailure("The project has no unresolved transaction.") }
        let bytes = try active.read(descriptorCap), descriptor = try Descriptor.decode(bytes,manifest:manifest)
        if let expected = transaction, expected != descriptor.transaction { throw FolderFailure("The conflict review has expired.") }
        guard let stage = try directory(j,descriptor.transaction) else { throw FolderFailure("Missing staged transaction.") }
        return (descriptor,stage,bytes)
    }
    func conflict() throws -> [String:Any] {
        let lock = try tree.lock(write:false)
        return try withExtendedLifetime(lock) {
            guard let j = try tree.journal() else { throw folderBad }
            let (d,_,_) = try activePlan(j)
            var paths = [String]()
            let ops: [[String:Any]] = try d.plan.map { t in
                let actual = try occupant(t,plan:d.plan)?.state
                if actual != t.desired && actual?.sha256 != t.expected { paths.append(t.path) }
                return ["path":t.path,"expected":t.expected as Any? ?? NSNull(),"desired":t.desired.map { ["sha256":$0.sha256,"length":$0.length] as [String:Any] } as Any? ?? NSNull(),
                        "current":actual?.sha256 as Any? ?? NSNull()]
            }
            return ["state":paths.isEmpty ? "recoveryPending":"conflict","transaction":d.transaction,"paths":paths,"plan":ops]
        }
    }
    func conflictRead(transaction: String, path: String, side: String, offset: Int, length: Int) throws -> [String:Any] {
        let lock = try tree.lock(write:false)
        return try withExtendedLifetime(lock) {
            guard let j = try tree.journal(), (1...(1<<20)).contains(length) else { throw folderBad }
            let (d,stage,_) = try activePlan(j,transaction:transaction)
            guard let t = d.plan.first(where:{ $0.path == path }) else { throw folderBad }
            let file: FD, value: Desired
            if side == "external", let current = try occupant(t,plan:d.plan) { file = current.file; value = current.state }
            else if side == "staged", let expected = t.desired, let stored = try regular(stage,expected.sha256),
                    try stored.digest() == expected { file = stored; value = expected }
            else { throw FolderFailure("That side of the conflict has no available file.",paths:[path]) }
            guard (0...value.length).contains(offset) else { throw folderBad }
            var result = try range(file,size:value.length,offset:offset,length:length); result["sha256"] = value.sha256; return result
        }
    }
    private func preserve(_ file: FD, value: Desired, in directory: FD) throws {
        if let existing = try regular(directory,value.sha256) {
            guard try existing.digest() == value else { throw folderBad }; return
        }
        let out = try freshFile(directory,value.sha256)
        var hash = SHA256(), size = 0
        try file.chunks(cap:value.length) { try out.write($0); hash.update(data:$0); size += $0.count }
        guard size == value.length, hex(hash.finalize()) == value.sha256 else { throw folderBad }
        try out.sync()
    }
    /// Supersede a committed plan only following the user's explicit per-path
    /// decisions. Both old sides survive in the private conflict archive.
    func resolve(_ request:[String:Any], acknowledged: ([String:Any]) -> Void) throws {
        let lock = try tree.lock(write:true)
        try withExtendedLifetime(lock) {
            guard let j = try tree.journal(), let tx = request["transaction"] as? String,
                  let choices = request["choices"] as? [[String:Any]], (1...planCap).contains(choices.count) else { throw folderBad }
            let (old,prior,original) = try activePlan(j,transaction:tx)
            var options = [String:[String:Any]]()
            for c in choices {
                guard let path = c["path"] as? String, old.plan.contains(where:{ $0.path == path }), options[path] == nil else { throw folderBad }
                options[path] = c
            }
            let newID = uuidName()
            guard mkdirat(j.value,newID,0o700) == 0, let stage = try directory(j,newID),
                  let archive = try tree.walk([".waffle","local","conflicts",tx],create:true) else { throw folderBad }
            var plan = [Target](), hadConflict = false
            var seen = [String:String](), seenAbsent = Set<String>()
            for t in old.plan {
                let current = try occupant(t,plan:old.plan)
                let changed = current?.state != t.desired && current?.state.sha256 != t.expected
                hadConflict = hadConflict || changed
                var desired = t.desired, data:Data?, source:FD?
                if let value = t.desired {
                    guard let f = try regular(prior,value.sha256), try f.digest() == value else { throw folderBad }
                    try preserve(f,value:value,in:archive); source = f
                }
                if let existing = current {
                    try preserve(existing.file,value:existing.state,in:archive); seen[t.path] = existing.state.sha256
                } else { seenAbsent.insert(t.path) }
                if let decision = options[t.path] {
                    let hash = decision["current"] as? String
                    guard (hash.map(isDigest) ?? (decision["current"] is NSNull)), hash == current?.state.sha256 else { throw FolderFailure.conflict(t.path) }
                    switch decision["use"] as? String {
                    case "external": desired = current?.state; source = current?.file
                    case "staged": break
                    case "merged":
                        if let text = decision["text"] as? String { data = Data(text.utf8) }
                        else if let text = decision["data"] as? String, text.utf8.count <= (folderCap+2)/3*4 { data = Data(base64Encoded:text) }
                        guard let b = data, b.count <= folderCap else { throw folderBad }
                        desired = Desired(sha256:sha(b),length:b.count); source = nil
                    default: throw folderBad
                    }
                } else if changed { throw FolderFailure.conflict(t.path) }
                if let value = desired {
                    if let input = source { try preserve(input,value:value,in:stage) }
                    else if let b = data, try regular(stage,value.sha256) == nil {
                        let file = try freshFile(stage,value.sha256); try file.write(b); try file.sync()
                    }
                    if let pinned = immutableDigest(t.path), pinned != value.sha256 { throw folderBad }
                }
                if current != nil || desired != nil { plan.append(Target(path:t.path,expected:current?.state.sha256,desired:desired)) }
            }
            guard hadConflict else { throw FolderFailure("The competing versions have changed. Refresh the conflict review.") }
            if plan.isEmpty {
                guard let m = try regular(tree.root,manifest) else { throw folderBad }
                let v = try m.digest(); try preserve(m,value:v,in:stage)
                plan.append(Target(path:manifest,expected:v.sha256,desired:v))
            }
            let d = Descriptor(projectId:old.projectId,transaction:newID,plan:plan)
            try d.validateOrder(manifest:manifest)
            try checkIdentity(d.projectId,plan:plan,stage:stage)
            let inheritedNativeCopies = Dictionary(uniqueKeysWithValues:old.plan.compactMap { t in
                if t.expected == nil { return t.desired.map { (t.path,$0.sha256) } }
                if t.desired == nil { return t.expected.map { (t.path,$0) } }
                return nil
            })
            try verifyRecoveryMembership(plan,stage:stage,project:d.projectId,inheritedNativeCopies:inheritedNativeCopies)
            // The archive records both the superseded intent and the physical
            // contents actually shown to the user, including external deletions.
            if let existing = try regular(archive,"original.active") {
                guard try existing.read(descriptorCap) == original else { throw folderBad }
            } else {
                let f = try freshFile(archive,"original.active"); try f.write(original); try f.sync()
            }
            let evidence = try JSONSerialization.data(withJSONObject:["present":seen,"absent":seenAbsent.sorted()],options:[.sortedKeys,.withoutEscapingSlashes])
            let receipt = try freshFile(archive,newID + ".json"); try receipt.write(evidence); try receipt.sync()
            try archive.sync(directory:true,witness:lock); try stage.sync(directory:true,witness:lock); try j.sync(directory:true,witness:lock)
            for t in old.plan where try occupant(t,plan:old.plan)?.state.sha256 != seen[t.path] { throw FolderFailure.conflict(t.path) }
            let tmp = ".active-" + newID, out = try freshFile(j,tmp)
            let bytes = d.encoded(); guard bytes.count <= descriptorCap else { throw folderBad }
            try out.write(bytes); try out.sync()
            guard let active = try regular(j,"active"), try active.read(descriptorCap) == original else { throw folderBad }
            try point("before-publish",nil)
            try tree.verifyLock(lock,in:j)
            guard renameat(j.value,tmp,j.value,"active") == 0 else { throw systemFailure("Publishing the approved resolution") }
            do { try point("after-publish",nil); try j.sync(directory:true,witness:out); try point("after-commit-sync",nil) }
            catch { issue = Self.publicationFailure(error,"The conflict resolution may have been committed. Reopen to verify."); throw issue! }
            let hashes = Dictionary(uniqueKeysWithValues:plan.map { ($0.path,($0.desired?.sha256 as Any?) ?? NSNull()) })
            acknowledged(["saved":true,"transaction":newID,"hashes":hashes])
            do {
                try point("acknowledged",nil); try apply(d,journal:j,stage:stage,lock:lock)
                try Self.clean(j,name:old.transaction); issue = nil
            } catch { issue = failure(error); throw error }
        }
    }
}

extension FolderTransactions {
    private func imageCache(_ digest: String, variant: String, create: Bool) throws -> (FD?,String) {
        guard isDigest(digest), (1...64).contains(variant.utf8.count),
              variant.utf8.allSatisfy({ (97...122).contains($0) || (48...57).contains($0) || $0 == 45 }) else { throw folderBad }
        return (try tree.walk([".waffle","cache","images-v1",digest],create:create),variant+".png")
    }
    func readImageDerivative(digest: String, variant: String) throws -> Data? {
        let (dir,name) = try imageCache(digest,variant:variant,create:false)
        guard let dir = dir, let file = try regular(dir,name) else { return nil }
        let bytes = try file.read(8<<20)
        return bytes.starts(with:[0x89,80,78,71,13,10,26,10]) ? bytes : nil
    }
    func writeImageDerivative(digest: String, variant: String, png: Data) throws {
        guard png.count <= 8<<20, png.starts(with:[0x89,80,78,71,13,10,26,10]) else { throw folderBad }
        let (candidate,name) = try imageCache(digest,variant:variant,create:true)
        guard let dir = candidate else { throw folderBad }
        let temp = ".png-" + uuidName(), out = try freshFile(dir,temp)
        defer { unlinkat(dir.value,temp,0) }
        try out.write(png)
        let (current,_) = try imageCache(digest,variant:variant,create:false)
        guard let current = current, try sameFile(dir.info(),current.info()) else { throw folderBad }
        if let occupied = try entryInfo(dir,name), occupied.st_mode & S_IFMT != S_IFREG || occupied.st_nlink != 1 { throw folderBad }
        // A derived rendition is reconstructible. Atomic visibility suffices here.
        guard renameat(dir.value,temp,dir.value,name) == 0 else { throw systemFailure("Recording the thumbnail") }
    }
}

extension FolderTransactions {
    /// Resolve only a manifest that indexes this selected, regular document and whose
    /// declared kind and id match the selected file. Candidate roots are the containing
    /// folder and the roots of the standard documents/libraries subtrees.
    static func indexedDocument(_ selected: URL, kind: String) throws -> (manifest: URL, path: String)? {
        let scoped = selected.startAccessingSecurityScopedResource()
        defer { if scoped { selected.stopAccessingSecurityScopedResource() } }
        return try indexedDocumentWithAccess(selected,kind:kind)
    }

    private static func indexedDocumentWithAccess(_ selected: URL, kind: String) throws -> (manifest: URL, path: String)? {
        let chosen = try FD(Darwin.open(selected.path, fileFlags), "Opening the selected document")
        guard let header = try Self.header(chosen),
              let id = header["id"] as? String, !id.isEmpty,
              ownerSuffix[kind] == selected.pathExtension.lowercased(),
              header["kind"] as? String == kind else { return nil }
        let chosenInfo = try chosen.info()
        guard chosenInfo.st_mode & S_IFMT == S_IFREG, chosenInfo.st_nlink == 1 else { throw folderBad }
        let expected = Member(id:id,kind:kind,table:AdditiveFile.tableProfile(header))

        var parent = selected.deletingLastPathComponent(), relative = selected.lastPathComponent
        var roots = [(parent, relative)]
        for _ in 0..<63 {
            let next = parent.deletingLastPathComponent()
            if next.path == parent.path || next.path == "/" { break }
            relative = parent.lastPathComponent + "/" + relative
            if parent.lastPathComponent == "documents" || parent.lastPathComponent == "libraries" {
                roots.append((next, relative))
            }
            parent = next
        }
        var result: (manifest: URL, path: String)?
        for (root, rawPath) in roots {
            let path = rawPath.precomposedStringWithCanonicalMapping
            guard let tree = try? BoundTree(root),
                  let manifestNames = try? names(tree.root).filter({ !$0.hasPrefix(".") && $0.hasSuffix(".waffle") }) else { continue }
            guard manifestNames.count <= 64 else {
                throw FolderFailure("Choose the Waffle project manifest that owns this document.")
            }
            for name in manifestNames {
                guard let store = try? FolderTransactions(root:root,manifest:name),
                      let index = try? regular(store.tree.root,name),
                      let indexHeader = try? Self.header(index),
                      indexHeader["kind"] as? String == "project",
                      AdditiveFile.minor(indexHeader) != nil || indexHeader["compatibleWith"] as? String == "2.0",
                      let membership = try? store.membership(index.read(folderCap),includeOpaque:true),
                      membership[path] == expected,
                      let containing = try store.tree.parent(path),
                      let file = try regular(containing,(path as NSString).lastPathComponent),
                      try sameContents(chosenInfo,file.info()) else { continue }
                // Confirm the on-disk owner under its existing shared lock. If a
                // durable project transaction is pending, the normal folder open
                // recovers it after this exact owner selection.
                let lock = try store.tree.lock(write:false)
                let exact = try withExtendedLifetime(lock) {
                    guard let current = try regular(store.tree.root,name),
                          let actual = try regular(containing,(path as NSString).lastPathComponent),
                          try sameContents(chosenInfo,actual.info()) else { return false }
                    return try store.membership(current.read(folderCap),includeOpaque:true)[path] == expected
                }
                guard exact else { throw FolderFailure.conflict(path) }
                guard result == nil else {
                    throw FolderFailure("More than one project indexes this document. Choose its Waffle project manifest.")
                }
                result = (store.rootURL.appendingPathComponent(name), path)
            }
        }
        return result
    }
}

/// A window-scoped capability for a single independently selected document.
/// It reuses the folder writer's directories, descriptors and durability barriers,
/// with a journal keyed to the precise filename and no project or Git grant.
final class NativeMemberFile {
    let grant = uuidName()
    private let selection: URL
    private let scope: Bool
    private let tree: BoundTree
    private let name: String
    private let kind: String
    private let journalName: String
    private let checkpoint: (String) throws -> Void
    private var openedID: String?

    private struct Head {
        let id: String
        let editable: Bool
    }

    init(_ selection: URL, kind: String, checkpoint: @escaping (String) throws -> Void = { _ in }) throws {
        let scoped = selection.startAccessingSecurityScopedResource()
        do {
            let suffixes = ownerSuffix.filter { $0.key != "block" }.values.map { "." + $0 }
            let parent = selection.deletingLastPathComponent()
            guard ownerSuffix[kind] == selection.pathExtension.lowercased(), kind != "block",
                  !parent.pathComponents.contains(where: { component in suffixes.contains(where: component.lowercased().hasSuffix) }) else {
                throw FolderFailure("Choose a regular Waffle document outside any document-named directory.")
            }
            let name = selection.lastPathComponent.precomposedStringWithCanonicalMapping
            guard try portableParts(name).count == 1, !name.hasPrefix(".") else { throw folderBad }
            self.tree = try BoundTree(parent)
            self.kind = kind
            self.name = name
            let foldedBytes = name.utf8.map { (65...90).contains($0) ? $0 + 32 : $0 }
            self.journalName = "member-" + sha(Data(foldedBytes))
            self.selection = selection
            self.scope = scoped
            self.checkpoint = checkpoint
        } catch {
            if scoped { selection.stopAccessingSecurityScopedResource() }
            throw error
        }
    }

    deinit { if scope { selection.stopAccessingSecurityScopedResource() } }

    private func head(_ bytes: Data) throws -> Head {
        guard bytes.last == 10, let envelope = nativeHeader(bytes),
              envelope["kind"] as? String == kind, let version = envelope["formatVersion"] as? String,
              version.range(of:#"^([2-9]|[1-9][0-9]{1,3})\.(0|[1-9][0-9]{0,3})$"#,options:.regularExpression) != nil,
              version.hasPrefix("2.") || envelope["compatibleWith"] as? String == "2.0",
              let id = envelope["id"] as? String, !id.isEmpty, id.utf8.count <= 1024 else {
            throw FolderFailure("The selected file is not a supported Waffle document.")
        }
        let (requires,_) = try nativeRequirements(envelope,path:name)
        return Head(id:id,editable:version == "2.0" && requires.isEmpty)
    }

    private func identity(_ file: FD, _ info: stat) throws {
        try tree.checkRoot()
        guard let current = try entryInfo(tree.root,name), current.st_nlink == 1,
              try sameContents(info,file.info()), sameContents(info,current) else { throw FolderFailure.conflict(name) }
    }

    private func current() throws -> (FD, stat, Data) {
        guard let file = try regular(tree.root,name), try spellings(tree.root,name) == [name] else {
            throw FolderFailure("The selected document was moved or replaced. Open it again.")
        }
        let info = try file.info(), bytes = try file.read(folderCap)
        try identity(file,info)
        return (file,info,bytes)
    }

    private func writable() -> Bool {
        var volume = statfs()
        return fstatfs(tree.root.value,&volume) == 0 &&
            UInt64(volume.f_flags) & UInt64(MNT_LOCAL) != 0 &&
            FileManager.default.isWritableFile(atPath:tree.url.path) &&
            FileManager.default.isWritableFile(atPath:tree.url.appendingPathComponent(name).path)
    }

    private func journal(create: Bool) throws -> FD? {
        try tree.checkRoot()
        guard let dir = try tree.walk([".waffle","journal",journalName],create:create) else { return nil }
        let st = try dir.info()
        guard st.st_uid == getuid(), st.st_mode & 0o077 == 0 else {
            throw FolderFailure("The selected document's private save journal could not be verified.")
        }
        return dir
    }

    private func lock(_ dir: FD) throws -> FD {
        let gate = try FD(openat(dir.value,"lock",O_RDWR | O_CREAT | O_NOFOLLOW | O_CLOEXEC | O_NONBLOCK,0o600),
                          "Opening the document save lock")
        let info = try gate.info()
        guard info.st_mode & S_IFMT == S_IFREG, info.st_nlink == 1, info.st_uid == getuid(), info.st_mode & 0o077 == 0,
              flock(gate.value,LOCK_EX | LOCK_NB) == 0 else { throw FolderFailure("The selected document has another save in progress.") }
        try verify(dir,gate)
        return gate
    }

    private func verify(_ dir: FD, _ gate: FD) throws {
        guard let bound = try journal(create:false), let entry = try entryInfo(dir,"lock"),
              try sameFile(dir.info(),bound.info()), try sameFile(gate.info(),entry), entry.st_nlink == 1 else { throw folderBad }
    }

    private func recover(_ dir: FD, _ gate: FD) throws {
        guard let marker = try regular(dir,"active") else { return }
        let descriptor = try Descriptor.decode(marker.read(descriptorCap),manifest:name)
        guard descriptor.plan.count == 1, let target = descriptor.plan.first, target.path == name,
              let expected = target.expected, let desired = target.desired,
              let stage = try directory(dir,descriptor.transaction),
              let staged = try regular(stage,desired.sha256) else { throw folderBad }
        let next = try staged.read(desired.length), nextHead = try head(next)
        guard next.count == desired.length, sha(next) == desired.sha256, nextHead.editable,
              nextHead.id == descriptor.projectId else { throw folderBad }
        let (currentFile,info,bytes) = try current()
        let digest = sha(bytes), currentHead = try head(bytes)
        guard currentHead.id == descriptor.projectId, currentHead.editable else { throw FolderFailure.conflict(name) }
        if digest != desired.sha256 {
            guard digest == expected, writable() else { throw FolderFailure.conflict(name) }
            let temp = ".install-" + uuidName(), output = try freshFile(stage,temp)
            defer { unlinkat(stage.value,temp,0) }
            guard fchmod(output.value,info.st_mode & 0o777) == 0 else { throw systemFailure("Preserving the document's permissions") }
            try output.write(next)
            try output.flushForCommit()
            try checkpoint("before-install")
            try verify(dir,gate)
            try identity(currentFile,info)
            guard renameat(stage.value,temp,tree.root.value,name) == 0 else { throw systemFailure("Saving the selected document") }
            try checkpoint("after-install")
            try tree.root.sync(directory:true,witness:output)
        } else {
            try tree.root.sync(directory:true,witness:currentFile)
        }
        guard sha(try current().2) == desired.sha256,
              let active = try regular(dir,"active"), try active.read(descriptorCap) == descriptor.encoded() else { throw folderBad }
        try verify(dir,gate)
        try dir.sync(directory:true,witness:gate)
        guard unlinkat(dir.value,"active",0) == 0 else { throw systemFailure("Clearing the document save journal") }
        try checkpoint("after-unlink")
        try dir.sync(directory:true,witness:gate)
        try FolderTransactions.clean(dir,name:descriptor.transaction)
    }

    func open() throws -> [String:Any] {
        if let dir = try journal(create:false), try regular(dir,"active") != nil {
            let gate = try lock(dir)
            try recover(dir,gate)
        }
        let bytes = try current().2
        let header = try head(bytes)
        openedID = header.id
        let root = try tree.root.info()
        let draftScope = sha(Data("\(root.st_dev)/\(root.st_ino)/\(root.st_birthtimespec.tv_sec)/\(root.st_birthtimespec.tv_nsec)/\(name)/\(header.id)".utf8))
        return ["name":selection.lastPathComponent,"memberPath":selection.lastPathComponent,"data":bytes.base64EncodedString(),
                "standaloneMember":["grant":grant,"sha256":sha(bytes),"readOnly":!header.editable || !writable(),"draftScope":draftScope,"splices":true]]
    }

    private func decode(_ encoded: String) throws -> Data {
        guard encoded.utf8.count <= (folderCap+2)/3*4, let bytes = Data(base64Encoded:encoded),
              bytes.count <= folderCap else { throw folderBad }
        return bytes
    }

    func commit(expected: String, encoded: String?, splice: [String:Any]?) throws -> [String:Any] {
        guard isDigest(expected), (encoded != nil) != (splice != nil),
              let openedID = openedID, writable() else { throw folderBad }
        guard let dir = try journal(create:true) else { throw folderBad }
        let gate = try lock(dir)
        try recover(dir,gate)
        try verify(dir,gate)
        try FolderTransactions.cleanOrphans(dir,lock:gate)
        let (file,info,before) = try current(), beforeHash = sha(before), opened = try head(before)
        guard opened.id == openedID, opened.editable else {
            throw FolderFailure("The selected document is read-only or its identity changed.")
        }
        let bytes: Data
        if let splice = splice {
            guard beforeHash == expected else { throw FolderFailure.conflict(name) }
            bytes = try spliceMember(splice,bytes:before,base:beforeHash)
        } else if let encoded = encoded { bytes = try decode(encoded) }
        else { throw folderBad }
        let proposed = try head(bytes), desired = sha(bytes)
        guard proposed.id == openedID, proposed.editable else { throw FolderFailure.conflict(name) }
        let tx = uuidName()
        guard beforeHash == expected else { throw FolderFailure.conflict(name) }
        if beforeHash == desired { return ["saved":true,"hash":desired,"transaction":NSNull()] }
        guard mkdirat(dir.value,tx,0o700) == 0, let stage = try directory(dir,tx) else { throw folderBad }
        let preparing = ".active-" + tx
        let target = Target(path:name,expected:expected,desired:Desired(sha256:desired,length:bytes.count))
        let descriptor = Descriptor(projectId:proposed.id,transaction:tx,plan:[target])
        var published = false
        defer {
            if !published {
                unlinkat(stage.value,desired,0)
                unlinkat(dir.value,tx,AT_REMOVEDIR)
            }
            unlinkat(dir.value,preparing,0)
        }
        let payload = try freshFile(stage,desired)
        try payload.write(bytes)
        try payload.flushForCommit()
        try stage.flushForCommit()
        try dir.flushForCommit()
        let marker = try freshFile(dir,preparing)
        try marker.write(descriptor.encoded())
        try marker.sync()
        try checkpoint("before-publish")
        try verify(dir,gate)
        try identity(file,info)
        try exclusiveRename(dir,preparing,dir,"active")
        published = true
        try checkpoint("after-publish")
        try dir.sync(directory:true,witness:marker)
        try checkpoint("after-commit-sync")
        try recover(dir,gate)
        return ["saved":true,"hash":desired,"transaction":tx]
    }

    func copyBytes(_ encoded: String) throws -> Data {
        let bytes = try decode(encoded)
        guard let openedID = openedID, try head(bytes).id == openedID else { throw folderBad }
        return bytes
    }

    func exportCopy(_ bytes: Data, to url: URL) throws {
        guard url.pathExtension.lowercased() == selection.pathExtension.lowercased() else { throw folderBad }
        let scope = url.startAccessingSecurityScopedResource()
        defer { if scope { url.stopAccessingSecurityScopedResource() } }
        let parent = try BoundTree(url.deletingLastPathComponent())
        let target = url.lastPathComponent.precomposedStringWithCanonicalMapping
        let sourceInfo = try current().1
        let existing = try entryInfo(parent.root,target)
        if let existing = existing {
            guard existing.st_mode & S_IFMT == S_IFREG, existing.st_nlink == 1, !sameFile(sourceInfo,existing),
                  try spellings(parent.root,target) == [target] else {
                throw FolderFailure("Choose a different regular file for the document copy.")
            }
        }
        let temp = ".waffle-copy-" + uuidName(), file = try freshFile(parent.root,temp)
        defer { unlinkat(parent.root.value,temp,0) }
        if let existing = existing, fchmod(file.value,existing.st_mode & 0o777) != 0 {
            throw systemFailure("Preserving the copy's permissions")
        }
        try file.write(bytes)
        try file.flushForCommit()
        try parent.checkRoot()
        if let existing = existing {
            guard let selected = try entryInfo(parent.root,target), sameContents(existing,selected),
                  renameat(parent.root.value,temp,parent.root.value,target) == 0 else { throw FolderFailure.conflict(target) }
        } else { try exclusiveRename(parent.root,temp,parent.root,target) }
        try parent.root.sync(directory:true,witness:file)
    }
}
