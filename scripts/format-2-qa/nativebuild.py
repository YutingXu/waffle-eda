"""Attach read/write counters to an otherwise shipping folder build of the baseline native driver."""
from pathlib import Path
from functools import partial
import sys

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent / "format-baseline"))
from native import native_host, once


def instrumentation(workspace, source, desktop, *, observe_transactions=True):
    capabilities = workspace / "Benchmark.app/Contents/Resources/format2-qa-env-root"
    capabilities.write_text("1\n")
    anonymous = "config.websiteDataStore = .nonPersistent()"
    named = """if #available(macOS 14.0,*), let token = ProcessInfo.processInfo.environment["WAFFLE_FORMAT_DRAFT_PROFILE"],
           let id = UUID(uuidString:token) { config.websiteDataStore = WKWebsiteDataStore(forIdentifier:id) }
        else { config.websiteDataStore = .nonPersistent() }"""
    desktop = once(desktop,anonymous,named)
    # The nonactivating benchmark runs below the user's windows. Maintain the visible power
    # condition used by the 1.5/v3d benchmarks while retaining real WebKit presentation.
    desktop = once(desktop, '"occluded": !window.occlusionState.contains(.visible)',
                   '"occluded": Format2Audit.forceVisible ? false : !window.occlusionState.contains(.visible)')
    cli = 'if CommandLine.arguments.count == 3, CommandLine.arguments[1] == "--folder-mcp" {'
    if cli in desktop:
        # The release script dispatches the separate headless executable mode before launching AppKit.
        # This benchmark supplies its own main.swift and only exercises the native desktop mode.
        desktop = once(desktop,cli+'\n    exit(runFolderMCP(CommandLine.arguments[2]))\n}',"")
    shipping = {p.name for p in source.glob("*.swift")}
    baseline = {"ProjectWrites.swift", "HostState.swift", "ExternalTools.swift", "LanRelay.swift", "main.swift", "FolderTransactions.swift"}
    additional = [str(source / p) for p in sorted(shipping - baseline)]
    def inputs(writer):
        return ["-D","FORMAT2_QA",str(writer),*additional,str(HERE/"observer.swift")]
    if not observe_transactions:
        # The normal window and independent Git controller still bracket the observation.
        # Compile the shipping transaction implementation directly with no counters or gates.
        (workspace/"Benchmark.app/Contents/Resources/format2-stock-writer").write_text("1\n")
        return desktop, inputs(source/"FolderTransactions.swift")
    entry = "private func performFolderAction(_ action: String, id: Int, request: [String:Any]) {"
    desktop = once(desktop, entry, entry + '\n        if action == "folderCommit" { Format2Audit.beginCommit(request) }')
    # A deterministic picker response is used only in a private benchmark process. Keep
    # native regular-file opening, media validation, owner-bound grants and staging unchanged.
    picker = """        panel.allowedContentTypes = requested.compactMap { UTType(mimeType:$0) }
        panel.beginSheetModal(for:window) { response in
            guard self.currentRequest(id) else { return }
            guard response == .OK, let url = panel.url else { self.reply(id,false); return }"""
    if picker in desktop:
        selected = """        let selected = URL(fileURLWithPath:ProcessInfo.processInfo.environment["WAFFLE_FORMAT_TRIAL"] ?? "")
            .appendingPathComponent("qa-selected.png")
        DispatchQueue.main.async {
            guard self.currentRequest(id) else { return }
            guard FileManager.default.fileExists(atPath:selected.path) else { self.reply(id,false); return }
            let url = selected"""
        desktop = once(desktop,picker,selected)
    store = (source / "FolderTransactions.swift").read_text()
    store = once(store, "; point = checkpoint", "; point = { n,p in Format2Audit.phase(n); try checkpoint(n,p) }")
    store = once(store, "let bytes = try file.read(remaining); remaining -= bytes.count", """
            Format2Audit.opened(path)
            let bytes = try file.read(remaining); remaining -= bytes.count
            Format2Audit.read(path, bytes.count)""")
    store = once(store, 'try point("after-stage-write:', 'Format2Audit.staged(desired.length); try point("after-stage-write:')
    # Count member selection's physical header read separately from the later full manifest read.
    store = once(store, "let h = try header(fd)", "Format2Audit.opened(url.lastPathComponent); let h = try header(fd, auditPath:url.lastPathComponent)")
    store = once(store, "private static func header(_ fd: FD) throws", "private static func header(_ fd: FD, auditPath: String? = nil) throws")
    store = once(store, 'guard n >= 0 else { throw systemFailure("Reading the project header") }',
                 'guard n >= 0 else { throw systemFailure("Reading the project header") }; if let p = auditPath { Format2Audit.read(p,n) }')
    sync = ("func sync(directory: Bool = false, witness: FD? = nil) throws {" if
            "func folderDeviceBarrier(" in store else "func sync(directory: Bool = false) throws {")
    store = once(store,sync,sync + ' Format2Audit.operation(directory ? "directorySync" : "fileSync")')
    store = once(store, "func digest(cap: Int = folderCap) throws -> Desired {",
                 'func digest(cap: Int = folderCap) throws -> Desired { Format2Audit.operation("fileDigest")')
    if "func isSelectedManifest()" in store:
        store = once(store, "if let f = try regular(tree.root,manifest), let h = try Self.header(f),",
                     "Format2Audit.opened(manifest); if let f = try regular(tree.root,manifest), let h = try Self.header(f,auditPath:manifest),")
    if "func flushForCommit() throws {" in store:
        store = once(store, "func flushForCommit() throws {", 'func flushForCommit() throws { Format2Audit.operation("checkedFsyncCalls")')
        if "func folderDeviceBarrier(" in store:
            store = once(store,"{ fcntl($0,F_FULLFSYNC) }","{ Format2Audit.fullBarrier($0) }")
            store = once(store,"{ fsync($0) }","{ Format2Audit.namespaceBarrier($0) }")
        else:
            store = once(store, "while fcntl(value,F_FULLFSYNC) != 0 {", "while Format2Audit.fullBarrier(value) != 0 {")
    # Record successful physical design-member opens and nonempty pread calls, including repeated
    # manifest header, digest and file-identity checks that the higher-level request trace omits.
    for opening in ('let fd = try FD(n, "Opening a project member")',
                    'let fd = try FD(Darwin.open(url.path,fileFlags), "Opening the selected manifest")'):
        store = once(store,opening,opening + "; Format2Audit.recordFD(fd.value)")
    event = 'let f = try FD(n,"Checking the entry spelling")'
    if event in store:
        store = once(store,event,event + "; Format2Audit.recordFD(f.value)")
    header = 'let n = b.withUnsafeMutableBytes { pread(fd.value, $0.baseAddress!, $0.count, 0) }'
    store = once(store,header,header + '; if n > 0 { Format2Audit.recordFD(fd.value,bytes:n) }')
    chunk = 'let n = buffer.withUnsafeMutableBytes { pread(value, $0.baseAddress!, $0.count, off_t(offset)) }'
    store = once(store,chunk,chunk + '; if n > 0 { Format2Audit.recordFD(value,bytes:n) }')
    edited = workspace / "FolderTransactions.swift"
    edited.write_text(store)
    return desktop, inputs(edited)


def build(root, *, observe_transactions=True):
    return native_host(probe_file=HERE/"desktop-probe.js",product_root=root,
                       instrumentation=partial(instrumentation,observe_transactions=observe_transactions))
