import Cocoa
import CryptoKit
import WebKit

// In-process driver for the real Desktop class (main.swift): the same WKWebView setup, bridge,
// message handler, menus and panels, with a scratch Application Support folder and bundle id.
// The work folder comes from the environment: NSApplication treats command-line arguments as files to open.
let work = URL(fileURLWithPath: ProcessInfo.processInfo.environment["HARNESS_WORK"] ?? NSTemporaryDirectory() + "atrium-harness")
let fm = FileManager.default
let suite = ProcessInfo.processInfo.environment["HARNESS_SUITE"] ?? ""
// The second recovery launch uses the same project and isolated WebKit profile.
if !["kill2", "crash2", "import-quit2", "folder-drafts", "startup-reopen"].contains(suite) { try? fm.removeItem(at: work) }
for d in ["support", "proj", "libs", "shots", "outside", "out"] {
    try! fm.createDirectory(at: work.appendingPathComponent(d), withIntermediateDirectories: true)
}
HostFiles.supportDirectory = work.appendingPathComponent("support")
if let path = ProcessInfo.processInfo.environment["HARNESS_RECENT_PROJECT"] {
    RecentProjects().note(URL(fileURLWithPath: path))
}
func canon(_ u: URL) -> String { ProjectWrites.canonical(u).path }
/// The real path (realpath(3)), "/private" kept; the path itself when it does not exist.
func real(_ path: String) -> String {
    guard let p = realpath(path, nil) else { return path }
    defer { free(p) }
    return String(cString: p)
}
/// Views of a type anywhere under a view (an alert's buttons and labels).
func views<T: NSView>(_ type: T.Type, in view: NSView?) -> [T] {
    guard let view = view else { return [] }
    let own: [T] = (view as? T).map { [$0] } ?? []
    return own + view.subviews.flatMap { views(type, in: $0) }
}
func findButton(_ title: String, in view: NSView?) -> NSButton? { views(NSButton.self, in: view).first { $0.title == title } }
func fixtureManifest(_ name: String) -> URL {
    work.appendingPathComponent("proj").appendingPathComponent(name).appendingPathComponent(name + ".waffle")
}
let demo = fixtureManifest("Demo")
let demoSheet = "Analog front end.wsch"
let demoBoard = "Sensor board.wpcb"
let library = work.appendingPathComponent("libs/parts.atrlib")
let secret = work.appendingPathComponent("outside/secret.json")
let linked = work.appendingPathComponent("libs/linked.atrlib")
try! Data(#"{"format":"atrium-library","version":1,"name":"Harness parts v2","defs":[]}"#.utf8).write(to: library)
try! Data(#"{"secret":"do not read"}"#.utf8).write(to: secret)
try? fm.removeItem(at: linked)
try! fm.createSymbolicLink(at: linked, withDestinationURL: secret)
// As if the user had chosen these files with Open library file… in an earlier session.
HostFiles.storeJSON("library-sources.json", [["path": canon(library)], ["path": linked.path]])

extension Desktop {
    @objc(_webView:didReceiveConsoleLogForTesting:)
    func tourConsoleLog(_ view: WKWebView, _ message: String) {
        Harness.captureConsole(message)
    }
}

@MainActor final class Harness {
    static let ephemeralStore = WKWebsiteDataStore.nonPersistent()
    static var consoleAvailable = false
    static var consolePhase = "startup"
    static let consoleEpoch = ProcessInfo.processInfo.systemUptime
    static var consoleEvents: [[String: Any]] = []
    static func captureConsole(_ text: String) {
        guard consoleAvailable else { return }
        let ms = Int(((ProcessInfo.processInfo.systemUptime - consoleEpoch) * 1000).rounded())
        consoleEvents.append(["action": consolePhase, "ms": ms, "text": text])
    }
    // WebKit deliberately does not mirror its console to the UI delegate in a non-persistent
    // session. A public fixture may use a fresh website store rooted entirely in its scratch folder.
    static func publicTourStore() -> WKWebsiteDataStore? {
        guard ProcessInfo.processInfo.environment["HARNESS_TOUR_PUBLIC_WEB_DATA"] == "1",
              let configurationType = NSClassFromString("_WKWebsiteDataStoreConfiguration") else { return nil }
        let instantiate = NSSelectorFromString("alloc"), configure = NSSelectorFromString("initWithDirectory:")
        let initialize = NSSelectorFromString("_initWithConfiguration:")
        let type: AnyObject = configurationType, storeType: AnyObject = WKWebsiteDataStore.self
        guard configurationType.instancesRespond(to: configure), WKWebsiteDataStore.instancesRespond(to: initialize) else { return nil }
        let folder = work.appendingPathComponent("public-web-data", isDirectory: true)
        guard (try? fm.createDirectory(at: folder, withIntermediateDirectories: true)) != nil,
              let configObject = type.perform(instantiate)?.takeUnretainedValue(),
              let settings = configObject.perform(configure, with: folder)?.takeRetainedValue(),
              let storeObject = storeType.perform(instantiate)?.takeUnretainedValue() else { return nil }
        return storeObject.perform(initialize, with: settings)?.takeRetainedValue() as? WKWebsiteDataStore
    }
    // Test-only observations of the shipping page, from document start (before its first script).
    static func installEarlyProbe(_ config: WKWebViewConfiguration) {
        GPUProcessRestart.prepare(config)
        guard let path = ProcessInfo.processInfo.environment["HARNESS_EARLY_PROBE"],
              let script = try? String(contentsOfFile: path, encoding: .utf8) else { return }
        if let store = publicTourStore() { config.websiteDataStore = store }
        else if ["kill", "kill2", "crash", "crash2", "import-quit", "import-quit2"].contains(suite) {
            fatalError("These recovery suites require their isolated persistent WebKit store.")
        }
        let selector = NSSelectorFromString("_setShouldSendConsoleLogsToUIProcessForTesting:")
        if config.websiteDataStore.isPersistent && config.responds(to: selector) {
            typealias SetBool = @convention(c) (AnyObject, Selector, Bool) -> Void
            unsafeBitCast(config.method(for: selector), to: SetBool.self)(config, selector, true)
            _ = consoleEpoch
            consoleAvailable = true
        }
        config.userContentController.addUserScript(WKUserScript(source: script, injectionTime: .atDocumentStart, forMainFrameOnly: true))
    }
    let d: Desktop
    var failures = 0
    init(_ d: Desktop) { self.d = d }

    func log(_ ok: Bool, _ name: String, _ detail: Any? = nil) {
        let text = detail.map { "\($0)".replacingOccurrences(of: "\n", with: " ").replacingOccurrences(of: "    ", with: "") }
        print((ok ? "PASS  " : "FAIL  ") + name + (text.map { "  — " + String($0.prefix(400)) } ?? ""))
        fflush(stdout)
        if !ok { failures += 1 }
    }
    func note(_ text: String) { print("NOTE  " + text); fflush(stdout) }

    @discardableResult
    func expectFocus(_ window: NSWindow, _ name: String, wasActive: Bool, timeout: Double = 5, keyOnly: Bool = false) async -> Bool {
        var observedActivation = wasActive
        let focused = await until(timeout) {
            guard NSApp.isActive else { return false }
            observedActivation = true
            return window.isKeyWindow || (!keyOnly && window.isMainWindow)
        }
        if observedActivation {
            log(focused, name, focused ? nil : "appActive=\(NSApp.isActive) key=\(NSApp.keyWindow?.windowNumber ?? -1) main=\(NSApp.mainWindow?.windowNumber ?? -1) expected=\(window.windowNumber)")
        } else {
            print("SKIP  \(name): macOS did not activate the harness (appActive=false)")
            fflush(stdout)
        }
        return focused
    }

    func js(_ body: String, _ args: [String: Any] = [:]) async -> Any? {
        await withCheckedContinuation { c in
            d.web.callAsyncJavaScript(body, arguments: args, in: nil, in: .page) { r in
                switch r {
                case .success(let v): c.resume(returning: v)
                case .failure(let e): c.resume(returning: "JSERROR: \(e)")
                }
            }
        }
    }
    func truthy(_ body: String, _ args: [String: Any] = [:]) async -> Bool { (await js(body, args)) as? Bool == true }

    // Use the shipping owner writer to stage independent, physically stored projects.
    // A Git fixture can use the same writer on several versions with identical object IDs.
    private let fixtureWriter = """
        await AtriumLazy.need(['AtriumParts','AtriumFormat2Closure']);
        const fixtureFiles = (project, manifest, entryDocument) => {
            const {files,assets,models} = AtriumFormat2Model.fromEditor(project,{manifestPath:manifest,entryDocument});
            if (assets.length || models.length) throw Error('The sample fixture should have no binary members');
            const utf8 = new TextDecoder();
            return files.map(({path,file}) => ({path,text:utf8.decode(AtriumFormat2.serialize(file))}));
        };
        """

    func writeFixture(_ rows: [[String:String]], to manifest: URL) throws {
        if !rows.contains(where: { $0["path"] == manifest.lastPathComponent }) {
            throw CocoaError(.fileWriteInvalidFileName)
        }
        let root = manifest.deletingLastPathComponent()
        for row in rows {
            guard let path = row["path"], let records = row["text"],
                  !path.split(separator: "/", omittingEmptySubsequences: false).contains(where: {
                      $0.isEmpty || $0 == "." || $0 == ".."
                  }) else { throw CocoaError(.fileWriteInvalidFileName) }
            let output = root.appendingPathComponent(path)
            try fm.createDirectory(at: output.deletingLastPathComponent(), withIntermediateDirectories: true)
            try Data(records.utf8).write(to: output, options: .atomic)
        }
    }

    func prepareProject(_ manifest: URL, initialKind: String = "schematic") async throws {
        let fixture = await js(fixtureWriter + """
            const p = AtriumParts.example();
            p.name = name;
            return fixtureFiles(p, filename, p.documents.find(d => d.kind === kind).id);
            """, ["filename": manifest.lastPathComponent, "name": manifest.deletingPathExtension().lastPathComponent, "kind": initialKind])
        guard let rows = fixture as? [[String:String]] else {
            throw NSError(domain: "Harness project fixture", code: 1, userInfo: [NSLocalizedDescriptionKey: String(describing: fixture)])
        }
        try writeFixture(rows, to: manifest)
    }

    func folderBytes(_ directory: URL) -> [String:Data]? {
        let root = URL(fileURLWithPath: real(directory.path), isDirectory: true)
        let prefix = root.path + "/"
        guard let members = fm.enumerator(at: root, includingPropertiesForKeys: [.isRegularFileKey], options: [.skipsHiddenFiles]) else { return nil }
        var bytes: [String:Data] = [:]
        for case let file as URL in members {
            if (try? file.resourceValues(forKeys: [.isRegularFileKey]).isRegularFile) != true { continue }
            let path = real(file.path)
            guard path.hasPrefix(prefix), let data = try? Data(contentsOf: file) else { return nil }
            bytes[String(path.dropFirst(prefix.count))] = data
        }
        return bytes
    }

    func projectBytes(_ manifest: URL) -> [String:Data]? {
        guard let bytes = folderBytes(manifest.deletingLastPathComponent()),
              bytes[manifest.lastPathComponent] != nil else { return nil }
        // Opening a native folder starts collaboration independently of saves and drafts.
        // Keep unexpected paths and malformed files in the byte comparison.
        let prefix = manifest.lastPathComponent + ".", suffix = CollabLocks.suffix(for: manifest)
        return bytes.filter { name, data in
            guard name.hasPrefix(prefix), name.hasSuffix(suffix), name.count > prefix.count + suffix.count,
                  let key = CollabLocks.validKey(String(name.dropFirst(prefix.count).dropLast(suffix.count))),
                  data.count <= CollabLocks.textCap,
                  let record = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any],
                  record["atrium-lock"] as? Int == 1, record["pid"] is Int, record["written"] is Double,
                  CollabLocks.validKey(record["machine"]) != nil,
                  let session = CollabLocks.validKey(record["session"]),
                  let payload = record["data"] as? [String: Any] else { return true }
            switch payload["kind"] as? String {
            case "edit":
                return !key.hasPrefix("d-") || (payload["doc"] as? String ?? "").isEmpty
            case "presence":
                return key != "s-" + session
            default:
                return true
            }
        }
    }

    func bound(to manifest: URL) async -> Bool {
        guard d.web != nil, d.window.representedURL.map(canon) == canon(manifest) else { return false }
        return await truthy("""
            const s = globalThis.AtriumNavHost?.folderProject();
            return !!s && s.grant === AtriumHost.folderGitGrant;
            """)
    }

    func openFixture(_ manifest: URL) async -> Bool {
        _ = await js("AtriumStartPage.close(); return true")
        d.application(NSApp, openFiles: [manifest.path])
        return await until(20) { await self.bound(to: manifest) }
    }

    func editName(_ name: String) async -> Bool {
        await truthy("""
            const h = AtriumNavHost;
            h.edit(() => { h.project().name = name; });
            return h.isDirty() && h.project().name === name;
            """, ["name": name])
    }

    func writePrivateDraft(_ name: String) async -> Bool {
        guard await editName(name) else { return false }
        return await truthy("""
            const s = AtriumNavHost.folderProject();
            await s.flushDrafts();
            return s.dirty && s.draftMetrics().writes > 0 && !s.draftMetrics().pending;
            """)
    }

    func waitForDraft(_ name: String, of manifest: URL) async -> Bool {
        await until(18) {
            guard await self.bound(to: manifest) else { return false }
            return await self.truthy("""
                const h = AtriumNavHost;
                const dialog = [...document.querySelectorAll('dialog[open]')].find(d => d.querySelector('h2')?.textContent === 'Recover private draft');
                return h.project().name === name && !h.isDirty() &&
                    !![...(dialog?.querySelectorAll('button') || [])].find(b => b.textContent.trim() === 'Restore Draft');
                """, ["name": name])
        }
    }

    func restoreDraft(_ name: String) async -> Bool {
        guard await truthy("""
            const dialog = [...document.querySelectorAll('dialog[open]')].find(d => d.querySelector('h2')?.textContent === 'Recover private draft');
            const restore = [...(dialog?.querySelectorAll('button') || [])].find(b => b.textContent.trim() === 'Restore Draft');
            if (!restore) return false;
            restore.click(); return true;
            """) else { return false }
        return await until(15) { await self.truthy("""
            return AtriumNavHost.isDirty() && AtriumNavHost.project().name === name;
            """, ["name": name]) }
    }

    func settled(_ manifest: URL) async -> Bool {
        guard !fm.fileExists(atPath: manifest.deletingLastPathComponent().appendingPathComponent(".waffle/journal/active").path) else { return false }
        return await truthy("return (await AtriumHost.folderStatus({grant:AtriumHost.folderGitGrant})).state === 'settled'")
    }

    func pause(_ s: Double) async { try? await Task.sleep(nanoseconds: UInt64(s * 1e9)) }
    func until(_ timeout: Double, _ cond: () async -> Bool) async -> Bool {
        let end = Date().addingTimeInterval(timeout)
        while Date() < end { if await cond() { return true }; await pause(0.2) }
        return false
    }
    func sheet(_ timeout: Double = 8) async -> NSWindow? {
        var found: NSWindow?
        _ = await until(timeout) { found = d.window.attachedSheet; return found != nil }
        return found
    }
    func button(_ title: String, in view: NSView?) -> NSButton? {
        guard let view = view else { return nil }
        if let b = view as? NSButton, b.title == title { return b }
        for v in view.subviews { if let b = button(title, in: v) { return b } }
        return nil
    }

    func shot(_ name: String) async {
        let dir = work.appendingPathComponent("shots")
        _ = await js("""
            const d = [...document.querySelectorAll('dialog[open]')].at(-1); document.getElementById('__shot')?.remove();
            if (d) { const m = document.createElement('div'); m.id = '__shot'; m.className = d.className; m.innerHTML = d.innerHTML;
              m.style.cssText = 'position:fixed;left:50%;top:8%;transform:translateX(-50%);z-index:2147483647;display:block;max-height:84vh;overflow:auto;box-shadow:0 0 0 100vmax rgba(0,0,0,.35)';
              document.body.append(m); }
            await new Promise(r => setTimeout(r, 150)); return true
            """)
        defer { Task { _ = await js("document.getElementById('__shot')?.remove(); return true") } }
        let image: NSImage? = await withCheckedContinuation { c in d.web.takeSnapshot(with: nil) { img, _ in c.resume(returning: img) } }
        if let tiff = image?.tiffRepresentation, let rep = NSBitmapImageRep(data: tiff), let png = rep.representation(using: .png, properties: [:]) {
            try? png.write(to: dir.appendingPathComponent(name + ".png"))
        }
        // The native window (title bar, sheets) where the system lets us capture our own window.
        typealias Capture = @convention(c) (CGRect, UInt32, UInt32, UInt32) -> Unmanaged<CGImage>?
        if let sym = dlsym(UnsafeMutableRawPointer(bitPattern: -2), "CGWindowListCreateImage") {
            let capture = unsafeBitCast(sym, to: Capture.self)
            var ids = [d.window.windowNumber]
            if let s = d.window.attachedSheet { ids.append(s.windowNumber) }
            for (i, id) in ids.enumerated() {
                if let cg = capture(.null, 1 << 3 /* optionIncludingWindow */, UInt32(id), 1 | 8 /* ignoreFraming|bestResolution */)?.takeRetainedValue(),
                   let png = NSBitmapImageRep(cgImage: cg).representation(using: .png, properties: [:]) {
                    try? png.write(to: dir.appendingPathComponent(name + (i == 0 ? "-window" : "-sheet") + ".png"))
                }
            }
        }
    }

    // Open and save panels run out of process, so a click cannot be scripted. Ending the sheet
    // with OK hands the completion handler the directory and name set above.
    // Never confirms a destination outside the harness folder (the panel may ignore directoryURL).
    func confirm(_ panel: NSSavePanel) async -> Bool {
        // realpath on both sides: URL.resolvingSymlinksInPath drops "/private" (/var -> /private/var
        // under $TMPDIR), so a plain prefix test never matched there and the panel was cancelled.
        let root = real(work.path)
        let inside = await until(4) { panel.url.map { real($0.deletingLastPathComponent().path).hasPrefix(root) } == true }
        note("save panel url: \(String(describing: panel.url))")
        d.window.endSheet(panel, returnCode: inside ? .OK : .cancel)
        return inside
    }

    func keyEquivalentPause() {
        d.window.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
        let event = NSEvent.keyEvent(with: .keyDown, location: .zero, modifierFlags: [.command, .shift],
                                     timestamp: ProcessInfo.processInfo.systemUptime, windowNumber: d.window.windowNumber,
                                     context: nil, characters: "\u{1b}", charactersIgnoringModifiers: "\u{1b}", isARepeat: false, keyCode: 53)!
        NSApp.sendEvent(event)
    }

    func postKey(_ key: String, code: UInt16, modifiers: NSEvent.ModifierFlags = [.command]) {
        for type in [NSEvent.EventType.keyDown, .keyUp] {
            let event = NSEvent.keyEvent(with: type, location: .zero, modifierFlags: modifiers,
                timestamp: ProcessInfo.processInfo.systemUptime, windowNumber: d.window.windowNumber,
                context: nil, characters: key, charactersIgnoringModifiers: key, isARepeat: false, keyCode: code)!
            NSApp.postEvent(event, atStart: false)
        }
    }

    func keyboardProfiles() async {
        do { try await prepareProject(demo, initialKind: "pcb") }
        catch { log(false, "prepared the native keyboard fixture", error); return }
        guard await openFixture(demo) else { log(false, "opened the native keyboard fixture"); return }
        let ready = await truthy("""
            await AtriumLazy.need(['AtriumKeymapPresets','AtriumVSKeys','AtriumPalette']);
            AtriumStartPage.close(); AtriumKeymap.setPreset('modern');
            AtriumNavHost.canvas().focus();
            return AtriumNavHost.doc().kind === 'pcb';
            """)
        log(ready, "the native keyboard fixture opens a board")
        guard ready else { return }
        let wasActive = NSApp.isActive
        d.window.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
        guard await expectFocus(d.window, "the keyboard test window has focus", wasActive: wasActive, timeout: 4, keyOnly: true) else { return }
        _ = d.window.makeFirstResponder(d.web)
        _ = await js("AtriumNavHost.canvas().focus(); return true")
        postKey("k", code: 40)
        let palette = await until(3) { await self.truthy("return AtriumPalette.isOpen()") }
        var keys = false
        if palette {
            postKey("s", code: 1)
            keys = await until(3) { await self.truthy("return !!document.querySelector('dialog.keymap-dialog[open]')") }
        }
        log(palette && keys && d.window.attachedSheet == nil, "Modern Command+K Command+S continues through the native Save equivalent")
        if let sheet = d.window.attachedSheet { d.window.endSheet(sheet, returnCode: .cancel) }
        _ = await js("AtriumPalette.close(); document.querySelector('dialog.keymap-dialog[open]')?.close(); AtriumNavHost.canvas().focus(); return true")
        _ = await js("""
            window.__testUnits = AtriumNavHost.units();
            AtriumKeymap.setBindings('toggle-units', ['Meta+C']);
            window.__testCopy = 0;
            document.addEventListener('copy', () => window.__testCopy++);
            return true;
            """)
        postKey("c", code: 8)
        let remapped = await until(3) { await self.truthy("return AtriumNavHost.units() !== __testUnits && __testCopy === 0") }
        log(remapped, "Command+C follows the custom canvas binding through the native Edit menu")
        _ = await js("""
            window.__testUnits = AtriumNavHost.units();
            AtriumKeymap.setBindings('toggle-units', ['Meta+Z']);
            const text=document.createElement('input'); text.id='test-key-edit'; document.body.append(text); text.focus();
            return true;
            """)
        postKey("a", code: 0, modifiers: [])
        let typed = await until(3) { await self.truthy("return document.getElementById('test-key-edit').value === 'a'") }
        postKey("z", code: 6)
        let nativeUndo = await until(3) { await self.truthy("return document.getElementById('test-key-edit').value === '' && AtriumNavHost.units() === __testUnits") }
        log(typed && nativeUndo, "Command+Z keeps native undo in a focused text input")
        _ = await js("document.getElementById('test-key-edit').remove(); AtriumKeymap.resetAll(); AtriumNavHost.canvas().focus(); return true")
        for profile in ["modern", "vscode"] {
            _ = await js("""
                AtriumKeymap.setPreset(profile); AtriumNavHost.canvas().focus();
                window.__testDoc = AtriumNavHost.currentId(); return true;
                """, ["profile": profile])
            postKey("w", code: 13)
            let tabClosed = await until(3) { await self.truthy("return AtriumNavHost.currentId() !== __testDoc && document.querySelector('[data-tab='+CSS.escape(__testDoc)+']').hidden") }
            log(tabClosed && d.window.isVisible, "\(profile) Command+W closes the document tab and keeps the editor window")
            if !tabClosed { return }
            postKey("T", code: 17, modifiers: [.command, .shift])
            let reopened = await until(3) { await self.truthy("return AtriumNavHost.currentId() === __testDoc") }
            log(reopened, "\(profile) Shift+Command+T reopens the document")
        }
        _ = await js("AtriumKeymap.setPreset('altium'); AtriumNavHost.canvas().focus(); return true")
        _ = await js("AtriumNavHost.selectDocument(AtriumNavHost.project().documents.find(d=>d.kind==='schematic').id); AtriumNavHost.canvas().focus(); return true")
        postKey("w", code: 13, modifiers: [.control])
        let wire = await until(3) { await self.truthy("return AtriumNavHost.tool() === 'route'") }
        log(wire, "Altium Control+W starts a wire on the schematic")
        _ = await js("AtriumNavHost.act('select'); return true")
        log(await editName("Keyboard edit"), "the keyboard close test has an authored folder edit")
        postKey("w", code: 13)
        let prompt = await sheet(3)
        let promptShown = prompt.flatMap { findButton("Don’t Save", in: $0.contentView) } != nil
        if let prompt = prompt, let cancel = findButton("Cancel", in: prompt.contentView) { cancel.performClick(nil) }
        await pause(0.3)
        log(promptShown && d.window.isVisible && d.window.attachedSheet == nil, "Altium Command+W preserves the native dirty-window confirmation")
        _ = await js("AtriumNavHost.act('undo'); return true")
    }

    func editor(for file: URL) -> Desktop? {
        NSApp.windows.first {
            $0.isVisible && ($0.delegate as? Desktop)?.web != nil && $0.representedURL.map(canon) == canon(file)
        }?.delegate as? Desktop
    }

    func overlappingProjectReads(_ manifest: URL) async {
        let result = await js("""
            const H = AtriumHost, session = AtriumNavHost.folderProject(), adopted = H.folderGitGrant;
            const [selected] = await H.openRecent({path});
            const [background] = await H.openRecent({path});
            if (!selected?.folderProject || !background?.folderProject) return 'No project capability';
            const first = selected.folderProject.grant, second = background.folderProject.grant;
            try {
                const {lease} = await H.folderReadLease({grant:first});
                const {files} = await H.folderRead({grant:first,lease,paths:[manifest,owner]});
                await H.folderRelease({grant:first,lease});
                await H.folderClose({grant:second});
                return new Set([first,second,adopted]).size === 3 && files.every(f => f.sha256.length === 64) &&
                    files.map(f => f.path).sort().join('/') === [manifest,owner].sort().join('/') &&
                    H.folderGitGrant === adopted && session === AtriumNavHost.folderProject();
            } finally {
                await H.folderClose({grant:first});
            }
            """, ["path": canon(manifest), "manifest": manifest.lastPathComponent, "owner": demoSheet])
        let bound = await bound(to: manifest)
        log(result as? Bool == true && bound, "a second background read preserves the earlier grant and the selected window", result)
    }

    func projectWindows() async {
        let other = fixtureManifest("Other")
        do {
            try await prepareProject(demo)
            try await prepareProject(other)
        } catch { log(false, "prepared both native project fixtures", error); return }
        guard let firstSaved = projectBytes(demo), let secondSaved = projectBytes(other),
              await openFixture(demo) else { log(false, "Finder opens the first project from Home"); return }
        await overlappingProjectReads(demo)
        guard await writePrivateDraft("First unsaved") else { log(false, "the first window keeps a private draft"); return }
        let activeBeforeOpen = NSApp.isActive
        d.application(NSApp, openFiles: [other.path])
        d.application(NSApp, openFiles: [other.path]) // a second Finder event before the new editor has loaded
        let ready = await until(15) { self.editor(for: other) != nil }
        guard ready, let second = editor(for: other), second !== d else { log(false, "second project has its own editor window"); return }
        let probe = Harness(second)
        let secondReady = await probe.until(8) { await probe.bound(to: other) }
        let kept = await truthy("return AtriumNavHost.project().name === 'First unsaved' && AtriumNavHost.isDirty()")
        let windows = NSApp.windows.filter { $0.isVisible && $0.delegate is Desktop }
        log(kept && secondReady && windows.count == 2, "repeated Finder opens use one new window and preserve the original edits and path",
            "kept=\(kept) ready=\(secondReady) windows=\(windows.count)")
        await expectFocus(second.window, "Finder focuses the newly opened window", wasActive: activeBeforeOpen)
        log(await probe.editNetName("Second saved"), "the second window has its own active-sheet edit")
        let file = NSApp.mainMenu?.items.first { $0.submenu?.title == "File" }?.submenu
        if let file = file, let save = file.items.firstIndex(where: { $0.representedObject as? String == "save" }) {
            file.performActionForItem(at: save)
        }
        let saved = await probe.until(12) {
            let clean = await probe.truthy("return !AtriumNavHost.isDirty()")
            let owner = other.deletingLastPathComponent().appendingPathComponent(demoSheet)
            return clean && (try? String(contentsOf: owner, encoding: .utf8))?.contains("Second saved") == true
        }
        let idle = await probe.until(8) { await probe.settled(other) }
        let secondBytes = projectBytes(other)
        let unchangedOwners = secondBytes?.filter { $0.key != demoSheet } == secondSaved.filter { $0.key != demoSheet }
        log(saved && idle && unchangedOwners && projectBytes(demo) == firstSaved,
            "the File menu saves only the active sheet in the active window",
            await probe.js("return {dirty:AtriumNavHost.isDirty(),status:document.querySelector('#status')?.textContent}"))
        let activeBeforeReopen = NSApp.isActive
        d.application(NSApp, openFiles: [demo.path])
        await expectFocus(d.window, "Finder focuses the already edited project window", wasActive: activeBeforeReopen)
        let intact = await truthy("return AtriumNavHost.project().name === 'First unsaved' && AtriumNavHost.isDirty()")
        log(intact && editor(for: demo) === d && NSApp.windows.filter { $0.isVisible && $0.delegate is Desktop }.count == 2,
            "opening an already edited file preserves its unsaved edits and window")
        _ = await js("window.dispatchEvent(new CustomEvent('atrium-command', {detail: 'start-page'})); return true")
        let activeBeforeRecent = NSApp.isActive
        let clicked = await until(8) { await truthy("""
            const row = [...document.querySelectorAll('dialog.sp-dialog[open] .sp-recent-item')].find(b => (b.dataset.tooltip ?? b.title) === p);
            if (row?.querySelector('strong')?.textContent !== 'Other.waffle') return false;
            row.click(); return true
            """, ["p": canon(other)]) }
        let homeClosed = await until(5) { await truthy("return !AtriumStartPage.isOpen()") }
        await expectFocus(second.window, "Home focuses the existing recent-project window", wasActive: activeBeforeRecent, timeout: 4)
        let stillEdited = await truthy("return AtriumNavHost.isDirty() && AtriumNavHost.project().name === 'First unsaved'")
        log(clicked && homeClosed && editor(for: other) === second && editor(for: demo) === d && stillEdited &&
            NSApp.windows.filter { $0.isVisible && $0.delegate is Desktop }.count == 2,
            "Home activates the saved recent project while the other window keeps its private draft")
        // A rejected file leaves an empty editor. Opening Demo from it should return to its
        // original window, where the unsaved edits are still the user's working copy.
        let invalid = fixtureManifest("Invalid")
        do {
            try await prepareProject(invalid)
            try Data("Invalid sheet\n".utf8).write(to: invalid.deletingLastPathComponent().appendingPathComponent(demoSheet))
        } catch { log(false, "prepared a broken native owner fixture", error); return }
        d.application(NSApp, openFiles: [invalid.path])
        var empty: Desktop?
        let rejected = await until(10) {
            empty = NSApp.windows.compactMap { $0.delegate as? Desktop }.first { $0 !== self.d && $0 !== second }
            guard let empty = empty else { return false }
            return await Harness(empty).truthy("return AtriumNavHost.isStarter() && [...document.querySelectorAll('dialog.ui-sheet[open] h2')].some(h => h.textContent === 'Couldn’t open this file')")
        }
        if rejected, let empty = empty {
            let blank = Harness(empty)
            _ = await blank.js("[...document.querySelectorAll('dialog.ui-sheet[open] h2')].find(h => h.textContent === 'Couldn’t open this file')?.closest('dialog').close(); return true")
            let activeBeforeEmptyOpen = NSApp.isActive
            d.application(NSApp, openFiles: [demo.path])
            await expectFocus(d.window, "opening an existing file from an empty editor focuses its original window", wasActive: activeBeforeEmptyOpen)
            let stayedEmpty = await blank.truthy("return !AtriumHost.folderGitGrant && AtriumNavHost.isStarter()")
            let reveal = await blank.js("return !AtriumHost.canRevealProject && await AtriumHost.revealProject() === false")
            log(reveal as? Bool == true, "Reveal in Finder requires a saved project", reveal)
            log(stayedEmpty && editor(for: demo) === d && NSApp.windows.filter { $0.isVisible && $0.delegate is Desktop }.count == 3,
                "opening an existing file from an empty editor keeps that editor empty")
            empty.window.close()
        } else { log(false, "a rejected project leaves its editor empty") }
        await altiumProject(alongside: second)
        if let prompt = await closePrompt(self) {
            press("Don’t Save", prompt.sheet)
            log(await until(8) { self.d.web == nil }, "the original project can close while keeping its private draft")
        } else { log(false, "the original project still offers a dirty close confirmation") }
        second.window.performClose(nil)
    }

    /// Finder opens only the .PrjPcb: the host reads the documents the project lists beside it, and the
    /// project opens in its own window, leaving the open (edited) project and its window as they were.
    /// HARNESS_ALTIUM names the project folder (default: the PiDP-11 fixture); it is copied first.
    func altiumProject(alongside second: Desktop) async {
        guard let source = ProcessInfo.processInfo.environment["HARNESS_ALTIUM"],
              let manifest = (try? fm.contentsOfDirectory(atPath: source))?.first(where: { $0.lowercased().hasSuffix(".prjpcb") }) else {
            note("HARNESS_ALTIUM not set; skipped the Altium project open"); return
        }
        note("opening the Altium project " + manifest)
        let folder = work.appendingPathComponent("altium")
        try? fm.removeItem(at: folder)
        try! fm.copyItem(at: URL(fileURLWithPath: source), to: folder)
        let before = Set(NSApp.windows.compactMap { $0.delegate as? Desktop }.map { ObjectIdentifier($0) })
        guard let originals = folderBytes(folder), let contents = try? fm.contentsOfDirectory(atPath:folder.path) else {
            log(false, "recorded the selected Altium source before opening"); return
        }
        let entries = Set(contents)
        func sourceUnchanged() -> Bool {
            originals.allSatisfy { (try? Data(contentsOf:folder.appendingPathComponent($0.key))) == $0.value }
        }
        func noSiblingWrites() -> Bool {
            sourceUnchanged() && (try? fm.contentsOfDirectory(atPath:folder.path)).map(Set.init) == entries
        }
        d.application(NSApp, openFiles: [folder.appendingPathComponent(manifest).path])
        var opened: Desktop?
        // Script calls wait until the new window's page has loaded (a call before that never returns).
        let loaded = await until(30) {
            opened = NSApp.windows.compactMap { $0.delegate as? Desktop }.first { !before.contains(ObjectIdentifier($0)) }
            guard let w = opened, w.web != nil else { return false }
            return !w.web.isLoading && w.web.url != nil
        }
        await pause(1)
        var ready = false
        if loaded, let w = opened {
            ready = await until(60) { await Harness(w).truthy("return !!globalThis.AtriumNavHost && !AtriumNavHost.isStarter() && !document.querySelector('dialog:modal:not(.sp-dialog)')") }
        }
        guard ready, let w = opened else {
            var state: Any?
            if loaded, let editor = opened {
                state = await Harness(editor).js("""
                    const h = globalThis.AtriumNavHost;
                    return {starter:h?.isStarter(),pending:h?.importSession?.(),status:document.querySelector('#status')?.textContent,
                        dialogs:[...document.querySelectorAll('dialog[open]')].map(d=>d.textContent.slice(0,240))};
                    """)
            }
            log(false, "Finder opens an Altium .PrjPcb with the documents it lists", state); return
        }
        let probe = Harness(w)
        let state = await probe.js("""
            const p = await AtriumNavHost.requireProjectClosure({purpose:'import verification'});
            return {name:p.name, docs:p.documents.map(d => d.kind + ':' + d.items.length), dialogs:[...document.querySelectorAll('dialog[open]')].map(d => d.textContent.slice(0,80))};
            """) as? [String: Any]
        let docs = state?["docs"] as? [String] ?? []
        let schematic = docs.contains { $0.hasPrefix("schematic:") && $0 != "schematic:0" }, board = docs.contains { $0.hasPrefix("pcb:") && $0 != "pcb:0" }
        log(schematic && board && (state?["dialogs"] as? [String] ?? []).isEmpty, "Finder opens an Altium .PrjPcb with the documents it lists, no file prompt", state)
        let kept = await truthy("return AtriumNavHost.project().name === 'First unsaved' && AtriumNavHost.isDirty()")
        let secondKept = await Harness(second).truthy("""
            return AtriumNavHost.doc().items.some(i => i.kind === 'netlabel' && i.text === 'Second saved') && !AtriumNavHost.isDirty();
            """)
        log(kept && secondKept && w !== d && w !== second, "the Altium project opens alongside, in its own window; the open projects stay")
        let banner = await probe.until(10) { await probe.truthy("""
            const h = AtriumNavHost, pending = h.importSession();
            const hint = document.querySelector('#editor-area > .editor-tabbar + .import-save-hint');
            return pending?.translator === 'altium' && pending.state === 'unsaved' &&
                hint?.querySelector('.import-save-source')?.textContent === 'Imported from ' + pending.formatLabel &&
                hint.querySelector('button')?.textContent === 'Save as Waffle Project…' &&
                !h.folderProject() && !AtriumHost.folderGitGrant && !document.querySelector('dialog[open]');
            """) }
        log(banner && w.window.representedURL == nil && noSiblingWrites(),
            "foreign Open shows an under-tabs Save link without a sibling folder or writes to the original files",
            await probe.js("return AtriumNavHost.importSession?.()"))
        guard banner, let format = await probe.js("return AtriumNavHost.importSession().formatLabel") as? String else { return }
        guard await probe.editForeignLabel("HARNESS_FIRST_EXPORT") else {
            log(false, "the imported Altium sheet can be edited before choosing Save"); return
        }

        _ = await probe.js("document.querySelector('.import-save-hint button').click(); return true")
        let nativeChoice = "Save as Waffle Project…"
        let exportChoice = "Export to \(format)…"
        guard let first = await probe.sheet(), let cancel = findButton("Cancel", in:first.contentView) else {
            log(false, "the import Save link opens the native first Save sheet"); return
        }
        let labels = views(NSTextField.self,in:first.contentView).map(\.stringValue)
        let title = "Save “\(state?["name"] as? String ?? "")” as a Waffle project?"
        let detail = "This design was imported from Altium. Saving as a Waffle project keeps everything you add and makes saves instant and Git-friendly. Your original Altium files stay untouched."
        let save = findButton(nativeChoice,in:first.contentView)
        let defaultSave = save?.keyEquivalent == "\r" || (save != nil && first.defaultButtonCell === save?.cell)
        log(labels.contains(title) && labels.contains(detail) && defaultSave &&
            findButton(exportChoice,in:first.contentView) != nil && cancel.keyEquivalent == "\u{1b}",
            "the native first Save sheet explains the options, defaults to Waffle on Return and allows source-format export or Escape", labels)
        await probe.sheetShot("foreign-first-save-sheet")
        cancel.performClick(nil)
        let cancelled = await probe.until(8) {
            guard w.window.attachedSheet == nil else { return false }
            return await probe.truthy("""
                const h = AtriumNavHost;
                return h.importSession()?.state === 'unsaved' && !h.folderProject() && h.isDirty() &&
                    !!document.querySelector('.import-save-hint') && h.doc().items.some(i => i.text === 'HARNESS_FIRST_EXPORT');
                """)
        }
        log(cancelled && noSiblingWrites(), "Cancel leaves the imported design open and the source directory untouched")

        let exported = await probe.exportAltium(exportChoice)
        log(exported && noSiblingWrites(), "export and the remembered repeat write only the separately chosen output")
        _ = await probe.js("AtriumNavHost.act('save-as'); return true")
        guard let changeChoice = await probe.sheet(), let saveNative = findButton(nativeChoice,in:changeChoice.contentView) else {
            log(false, "Save As lets the user choose native Save after remembering Export"); return
        }
        saveNative.performClick(nil)
        guard let destination = await probe.sheet() as? NSSavePanel, destination.title == "Save Waffle Project Folder" else {
            log(false, "Save As opens the native project-folder picker"); return
        }
        destination.directoryURL = folder
        destination.nameFieldStringValue = "Waffle copy"
        guard await probe.until(5, { destination.url.map { real($0.deletingLastPathComponent().path) == real(folder.path) } == true }) else {
            w.window.endSheet(destination,returnCode:.cancel)
            log(false,"the native Save As picker selects a sibling inside the fixture",destination.url); return
        }
        guard await probe.confirm(destination) else { log(false,"Save As confirms its destination inside the fixture"); return }
        var adopted: URL?
        let saved = await probe.until(30) {
            guard let manifest = w.window.representedURL else { return false }
            adopted = manifest
            return await probe.bound(to:manifest)
        }
        let nativeFiles = adopted.flatMap(projectBytes)
        let owners = nativeFiles?.keys.sorted() ?? []
        let edited = nativeFiles?.filter { $0.key.hasSuffix(".wsch") }.values.contains {
            String(decoding:$0,as:UTF8.self).contains("HARNESS_REPEAT_EXPORT")
        }
        let projectRoot = adopted.map { real($0.deletingLastPathComponent().deletingLastPathComponent().path) }
        log(saved && projectRoot == real(folder.path) && nativeFiles?.keys.contains(where:{ $0.hasSuffix(".wpcb") }) == true &&
            edited == true && sourceUnchanged(), "explicit Waffle Save creates a sibling with the edited sheet and all other native owners", owners)
        let cleared = await probe.truthy("return !AtriumNavHost.isDirty() && !AtriumNavHost.importSession() && !document.querySelector('.import-save-hint')")
        log(cleared, "the first native Save retires the imported state and its banner")
        w.window.performClose(nil)
        await pause(0.3)
    }

    func editForeignLabel(_ name: String) async -> Bool {
        await truthy("""
            const h = AtriumNavHost;
            const item = h.doc().items.find(x => x.kind === 'netlabel');
            if (!item || !h.importSession()) return false;
            h.edit(() => { item.text = name; });
            return h.isDirty() && item.text === name;
            """, ["name":name])
    }

    // Use the actual fidelity report, chooser and receipt-checked remembered destination.
    func exportAltium(_ exportChoice: String) async -> Bool {
        _ = await js("AtriumNavHost.act('save'); return true")
        guard let choose = await sheet(), let export = findButton(exportChoice,in:choose.contentView) else {
            log(false,"first Save offers the source export after editing"); return false
        }
        export.performClick(nil)
        let ready = await until(22) { await self.truthy("""
            const dialog = document.querySelector('dialog.import-save-sheet[open]');
            return !!dialog?.querySelector('.import-save-group li') &&
                dialog.querySelector('.import-save-remember')?.textContent.trim() === 'Remember for this project';
            """) }
        log(ready, "the export report lists actual fidelity and offers Remember for this project",
            await js("return document.querySelector('dialog.import-save-sheet[open]')?.textContent.slice(0,240)"))
        guard ready else { return false }
        await shot("foreign-export-review")
        let out = work.appendingPathComponent("out",isDirectory:true)
        guard let initial = try? fm.contentsOfDirectory(atPath:out.path) else { return false }
        let beforeNames = Set(initial)
        UserDefaults.standard.set(out.path,forKey:"NSNavLastRootDirectory")
        _ = await js("""
            const d = document.querySelector('dialog.import-save-sheet[open]');
            d.querySelector('.import-save-remember input').click();
            [...d.querySelectorAll('button')].find(b => b.textContent === 'Export').click();
            return true;
            """)
        guard let panel = await sheet() as? NSOpenPanel, panel.canChooseDirectories, !panel.canChooseFiles else {
            log(false, "the multi-file export opens a native folder picker"); return false
        }
        guard await until(5, { panel.url.map { real($0.path) == real(out.path) } == true }) else {
            d.window.endSheet(panel,returnCode:.cancel)
            log(false,"the export folder picker selects the fixture output directory",panel.url); return false
        }
        guard await confirm(panel) else { log(false,"the export stays inside the fixture output folder"); return false }
        func bytesWithEdit(_ text: String, at destination: URL) -> [String:Data]? {
            let files = folderBytes(destination)
            guard files?.keys.contains(where:{ $0.lowercased().hasSuffix(".prjpcb") }) == true,
                  files?.keys.contains(where:{ $0.lowercased().hasSuffix(".pcbdoc") }) == true,
                  files?.filter({ $0.key.lowercased().hasSuffix(".schdoc") }).values.contains(where:{
                      String(decoding:$0,as:UTF8.self).contains(text)
                  }) == true else { return nil }
            return files
        }
        var destination: URL?
        let wrote = await until(30) {
            guard let names = try? fm.contentsOfDirectory(atPath:out.path) else { return false }
            let new = Set(names).subtracting(beforeNames)
            guard new.count == 1, let name = new.first else { return false }
            let published = out.appendingPathComponent(name,isDirectory:true)
            guard bytesWithEdit("HARNESS_FIRST_EXPORT",at:published) != nil else { return false }
            destination = published
            return await self.truthy("return AtriumNavHost.importSession()?.state === 'export-preferred' && !AtriumNavHost.isDirty()")
        }
        log(wrote, "the selected export contains the changed design and retains the remembered choice",
            await js("return {status:document.querySelector('#status')?.textContent,state:AtriumNavHost.importSession()?.state}"))
        guard wrote, let destination = destination, let first = bytesWithEdit("HARNESS_FIRST_EXPORT",at:destination),
              await editForeignLabel("HARNESS_REPEAT_EXPORT") else { return false }
        _ = await js("AtriumNavHost.act('save'); return true")
        let repeated = await until(30) {
            guard self.d.window.attachedSheet == nil, let newer = bytesWithEdit("HARNESS_REPEAT_EXPORT",at:destination),
                  newer != first, newer.keys.sorted() == first.keys.sorted() else { return false }
            return await self.truthy("""
                return AtriumNavHost.importSession()?.state === 'export-preferred' && !AtriumNavHost.isDirty() &&
                    !document.querySelector('dialog.import-save-sheet[open]');
                """)
        }
        log(repeated, "the next Save reuses the same export destination and preserves all member names",
            await js("return {status:document.querySelector('#status')?.textContent,state:AtriumNavHost.importSession()?.state}"))
        return repeated
    }

    var privateImport: URL { work.appendingPathComponent("foreign-import",isDirectory:true) }

    func importedQuitFixture() -> (root:URL,selection:URL,bytes:[String:Data],entries:Set<String>)? {
        guard let location = ProcessInfo.processInfo.environment["HARNESS_ALTIUM"] else { return nil }
        let root = URL(fileURLWithPath:location,isDirectory:true)
        guard let contents = try? fm.contentsOfDirectory(atPath:root.path),
              let name = contents.first(where:{ $0.lowercased().hasSuffix(".prjpcb") }),
              let bytes = folderBytes(root) else { return nil }
        return (root,privateImport.appendingPathComponent(name),bytes,Set(contents))
    }

    func importedSourceMatches(_ bytes: [String:Data], entries: Set<String>) -> Bool {
        folderBytes(privateImport) == bytes &&
            (try? fm.contentsOfDirectory(atPath:privateImport.path)).map(Set.init) == entries
    }

    func quitImportedDraft() async {
        guard let fixture = importedQuitFixture() else { log(false, "prepared the foreign Quit fixture"); return finish() }
        do { try fm.copyItem(at:fixture.root,to:privateImport) }
        catch { log(false, "copied the original foreign Quit fixture",error); return finish() }
        _ = await js("AtriumStartPage.close(); return true")
        d.application(NSApp,openFiles:[fixture.selection.path])
        let opened = await until(30) { await truthy("""
            const h = AtriumNavHost;
            return h.importSession()?.translator === 'altium' && !h.folderProject();
            """) }
        guard opened, let format = await js("return AtriumNavHost.importSession()?.formatLabel") as? String,
              await editForeignLabel("HARNESS_RECOVERED_IMPORT") else {
            log(false, "opened and edited a pending Altium project"); return finish()
        }
        let binding = await js("return AtriumNavHost.importSession().id") as? String
        do {
            guard let binding = binding, !binding.isEmpty else { throw CocoaError(.fileWriteUnknown) }
            try Data(binding.utf8).write(to:work.appendingPathComponent("out/foreign-recovery-id"))
        } catch { log(false,"recorded the private imported project identity",error); return finish() }

        var cancelled: Bool?
        Desktop.reviewBeforeQuit { cancelled = $0 }
        let label = "Not saved yet (imported from \(format))"
        let asked = await until(12) { await self.truthy("""
            const d = document.querySelector('dialog.foreign-import-close[open]');
            return !!d && d.textContent.includes(label) &&
                [['save','Save'],['keep','Keep for Later'],['discard','Discard'],['cancel','Cancel']].every(([key,text]) =>
                    d.querySelector('[data-choice='+key+']')?.textContent === text);
            """, ["label":label]) }
        log(asked, "Quit identifies the unsaved import and offers Save, Keep for Later, Discard, and Cancel",
            await js("return document.querySelector('dialog.foreign-import-close[open]')?.textContent"))
        guard asked else { return finish() }
        _ = await js("document.querySelector('dialog.foreign-import-close[open] [data-choice=cancel]').click(); return true")
        let stayed = await until(8) {
            guard cancelled == false && self.d.window.attachedSheet == nil else { return false }
            return await self.truthy("return AtriumNavHost.isDirty() && !!AtriumNavHost.importSession()")
        }
        log(stayed && importedSourceMatches(fixture.bytes,entries:fixture.entries), "Cancel preserves the unsaved import and its source files")
        guard failures == 0 else { return finish() }

        // A real application quit must wait for the private draft rather than create a sibling.
        RunLoop.main.perform(inModes:[.default]) { NSApp.terminate(nil) }
        guard await until(12, { await self.truthy("return !!document.querySelector('dialog.foreign-import-close[open] [data-choice=keep]')") }) else {
            log(false, "the real quit offers Keep for Later"); return finish()
        }
        print("RESULT kept foreign draft"); fflush(stdout)
        _ = await js("document.querySelector('dialog.foreign-import-close[open] [data-choice=keep]').click(); return true")
    }

    func restoreImportedDraft() async {
        guard let fixture = importedQuitFixture(),
              let binding = try? String(contentsOf:work.appendingPathComponent("out/foreign-recovery-id"),encoding:.utf8) else {
            log(false, "loaded the imported draft proof from the prior quit"); return
        }
        let offered = await until(25) { await truthy("""
            const d = document.querySelector('dialog.foreign-import-recovery[open]');
            return !!d?.querySelector('.foreign-import-draft [data-choice=restore]') &&
                d.textContent.includes('Not saved yet (imported from') && AtriumNavHost.isStarter();
            """) }
        log(offered && importedSourceMatches(fixture.bytes,entries:fixture.entries),
            "the next launch offers the imported draft before opening it and the source directory is unchanged")
        guard offered else { return }
        _ = await js("document.querySelector('dialog.foreign-import-recovery[open] [data-choice=restore]').click(); return true")
        let restored = await until(25) { await truthy("""
            const h = AtriumNavHost;
            return h.importSession()?.id === id && h.isDirty() && !h.folderProject() &&
                h.project().documents.some(d => d.items.some(i => i.text === 'HARNESS_RECOVERED_IMPORT'));
            """, ["id":binding]) }
        log(restored && importedSourceMatches(fixture.bytes,entries:fixture.entries),
            "Restore recovers the same imported project and unsaved edit without a native or source write")
    }

    func editNetName(_ name: String) async -> Bool {
        await truthy("""
            const h = AtriumNavHost;
            const item = h.doc().items.find(i => i.kind === 'netlabel');
            if (!item) return false;
            h.edit(() => { item.text = name; });
            const s = h.folderProject();
            await s.flushDrafts();
            return h.isDirty() && item.text === name && s.draftMetrics().writes > 0;
            """, ["name": name])
    }

    func checkMemberSave(_ before: [String:Data], text: String) async -> [String:Data]? {
        _ = await js("AtriumNavHost.act('save'); return true")
        let saved = await until(12) {
            let clean = await self.truthy("return !AtriumNavHost.isDirty()")
            if !clean { return false }
            return await self.settled(demo)
        }
        let receipt = await js("return AtriumNavHost.folderProject().metrics().lastSave") as? [String:Any] ?? [:]
        let after = projectBytes(demo)
        let changed = after?.filter { before[$0.key] != $0.value }.map(\.key)
        let member = after?[demoSheet].map { String(decoding: $0, as: UTF8.self) }
        let ok = saved && before.keys.sorted() == after?.keys.sorted() && changed == [demoSheet] &&
            receipt["splices"] as? Int == 1 && receipt["rowsEncoded"] as? Int == 1 &&
            (receipt["transferBytes"] as? Int ?? Int.max) < 4096 && receipt["paths"] as? [String] == [demoSheet] &&
            receipt["transaction"] is String && member?.contains(text) == true && d.window.attachedSheet == nil
        log(ok, "an in-place transaction changes one sheet row and preserves every other saved member", receipt)
        return after
    }

    // Interrupt the native writer after the durable descriptor has been acknowledged, before
    // applying the target. Finder must settle this real journal on the normal open path.
    func interruptTransaction(_ manifest: URL, saved: [String:Data]) throws -> Data {
        let filename = manifest.lastPathComponent
        guard let old = saved[filename],
              let header = String(decoding: old, as: UTF8.self).split(separator: "\n").first,
              let object = try JSONSerialization.jsonObject(with: Data(header.utf8)) as? [String:Any],
              let projectId = object["id"] as? String else {
            throw CocoaError(.fileReadCorruptFile)
        }
        let updated = String(decoding: old, as: UTF8.self)
            .replacingOccurrences(of: #""name":"Other""#, with: #""name":"Recovered journal""#)
        guard Data(updated.utf8) != old else { throw CocoaError(.fileReadCorruptFile) }
        let checksum = SHA256.hash(data: old).map { String(format: "%02x", $0) }.joined()
        enum Interrupted: Error { case afterReceipt }
        let folder = try FolderTransactions(root: manifest.deletingLastPathComponent(), manifest: filename) { point,_ in
            if point == "acknowledged" { throw Interrupted.afterReceipt }
        }
        defer { folder.close() }
        var acknowledged = false
        do {
            try folder.commit(["manifest":filename, "projectId":projectId,
                "plan":[["path":filename, "expected":checksum, "text":updated]]]) { receipt in
                acknowledged = receipt["saved"] as? Bool == true && receipt["transaction"] is String
            }
        } catch Interrupted.afterReceipt {
            let active = manifest.deletingLastPathComponent().appendingPathComponent(".waffle/journal/active")
            if acknowledged && projectBytes(manifest) == saved && fm.fileExists(atPath: active.path) {
                return Data(updated.utf8)
            }
        }
        throw CocoaError(.fileWriteUnknown)
    }

    func run() async {
        if suite == "startup" || suite == "startup-reopen" { await startupFrames(); return finish() }
        if suite == "startup-seed" { await startupSeed(); return finish() }
        if suite == "folder-drafts", !(await until(25,{ d.web != nil })) {
            log(false,"signed editor created its WebView"); return finish()
        }
        // 1. Boot and start page
        let launchDialog = suite == "import-quit2" ? "dialog.sp-dialog[open],dialog.foreign-import-recovery[open]" : "dialog.sp-dialog[open]"
        let booted = await until(25) { await truthy("return !!document.querySelector(selector)", ["selector":launchDialog]) }
        log(booted, "app boots and the start page shows")
        if !booted {
            let state = await js("return JSON.stringify({page:document.readyState, editor:!!globalThis.AtriumNavHost, starter:globalThis.AtriumNavHost?.isStarter(), start:!!globalThis.AtriumStartPage, status:document.getElementById('status')?.textContent, dialog:document.querySelector('dialog[open]')?.className, errors:await globalThis.AtriumDiagnostics?.entries()})")
            note("url=\(String(describing: d.web.url)) loading=\(d.web.isLoading) state=\(state ?? "nil")")
        }
        if suite == "memory" { await NativeMemorySoak(self).run(); return finish() }
        if ProcessInfo.processInfo.environment["HARNESS_SUITE"] == "projects" { await projectWindows(); return finish() }
        if ProcessInfo.processInfo.environment["HARNESS_SUITE"] == "keys" { await keyboardProfiles(); return finish() }
        // HARNESS_SUITE=ui: the WebKit UI probes (ui-probes.js) instead of the native file workflow.
        if suite == "ui" || suite == GPUProcessRestart.suiteName { await UIProbes(self).run(); return finish() }
        if suite == "crash" {
            await rendererRecovery()
            if failures > 0 { finish() }
            return
        }
        if suite == "folder" { await folderTransactions(); return finish() }
        if suite == "folder-drafts" { await folderDraftLifecycle(); return finish() }
        if suite == "folder-git" { await folderGitHistory(); return finish() }
        if suite == "legacy-folder" { await legacyFolderOpen(); return finish() }
        if suite == "hang" { await hangRecovery(); return finish() }
        if suite == "kill" { await nativeKill(); return finish() }
        if suite == "kill2" { await afterEditorExit(savedName: "Demo", draftName: "Native kill draft"); return finish() }
        if suite == "crash2" { await afterEditorExit(savedName: "Private fixture draft", draftName: "Final accepted draft"); return finish() }
        if suite == "import-quit" { await quitImportedDraft(); return }
        if suite == "import-quit2" {
            await restoreImportedDraft()
            return finish()
        }
        if suite == "close" { await closePrompts(); return }
        if suite == "updater" { await updateReview(); return finish() }
        _ = await js("for (const d of document.querySelectorAll('dialog.recover-prompt[open]')) d.close(); return true")
        await shot("01-start-page")
        let boot = await js("return {bridge: typeof AtriumHost, frozen: Object.isFrozen(AtriumHost), title: document.title, folder: typeof AtriumHost.folderAdopt}")
        log((boot as? [String: Any])?["bridge"] as? String == "object", "native bridge injected", boot)

        // Authored notebook extensions need an explicit opt-in in the isolated test profile.
        let optedIn = await truthy("""
            const prefs = await AtriumLazy.need('AtriumPrefs');
            prefs.set('labs.notebook',true);
            return AtriumLabs.notebookEnabled();
            """)
        log(optedIn, "the extension test explicitly enables Notebook Labs")
        _ = await js("document.querySelector('dialog.sp-dialog[open] [data-start-action=close]')?.click(); return true")
        let registered = await until(10) { await truthy("""
            const X = globalThis.AtriumExtensions;
            return !AtriumStartPage.isOpen() && X?.attached && X.list().some(e => e.id === 'waffle.calculators');
            """) }
        log(registered, "Continue to editor registers the calculator extension")
        let ext = await js("""
            const X = globalThis.AtriumExtensions;
            if (!registered) return {error: 'Calculator extension registration timed out'};
            let result;
            try {
                const calculation = X.execute('calculators.compute', 'eseries', {value: '4k7', series: 'E24'});
                result = await Promise.race([calculation, new Promise((_, reject) => setTimeout(() => reject(Error('Calculation timed out')), 15000))]);
            }
            catch (e) { return {error: String(e.message || e)}; }
            const e = X.list().find(e => e.id === 'waffle.calculators');
            const frame = document.querySelector('iframe[srcdoc]');
            return {status: e?.status, workers: X.workers.length, value: result?.value, sandbox: frame?.getAttribute('sandbox'), srcdoc: frame?.hasAttribute('srcdoc'), errors: e?.errors || []};
            """, ["registered":registered])
        let extInfo = ext as? [String: Any]
        log(extInfo?["status"] as? String == "active" && (extInfo?["workers"] as? Int ?? 0) > 0
            && extInfo?["value"] as? Double == 4700 && extInfo?["sandbox"] as? String == "allow-scripts"
            && extInfo?["srcdoc"] as? Bool == true, "extension activates in the sandboxed about:srcdoc frame", ext)

        // 3. Pause All Extensions with ⌘⇧Esc
        keyEquivalentPause()
        var paused = await until(3) { await truthy("return AtriumExtensions.safeMode === true") }
        var how = "key event through NSApp.sendEvent"
        if !paused {
            if let ev = NSEvent.keyEvent(with: .keyDown, location: .zero, modifierFlags: [.command, .shift], timestamp: 0, windowNumber: d.window.windowNumber,
                                         context: nil, characters: "\u{1b}", charactersIgnoringModifiers: "\u{1b}", isARepeat: false, keyCode: 53) {
                _ = NSApp.mainMenu?.performKeyEquivalent(with: ev)
            }
            paused = await until(3) { await truthy("return AtriumExtensions.safeMode === true") }
            how = "main menu key equivalent"
        }
        let after = await js("return {safe: AtriumExtensions.safeMode, workers: AtriumExtensions.workers.length, status: AtriumExtensions.list().find(e => e.id === 'waffle.calculators')?.status}")
        log(paused, "⌘⇧Esc pauses all extensions (" + how + ")", after)
        await shot("02-extensions-paused")
        _ = await js("AtriumExtensions.setSafeMode(false); return true")

        if suite == "history" { await gitStep(); return finish(close: true) }
        do { try await prepareProject(demo) }
        catch { log(false, "prepared the native demo", error); return finish() }
        guard let baseline = projectBytes(demo), await openFixture(demo) else {
            log(false, "Finder opens the native demo"); return finish()
        }
        await shot("03-project-open")
        let stored = (try? Data(contentsOf: HostFiles.supportDirectory.appendingPathComponent("recent-projects.json"))).flatMap { try? JSONSerialization.jsonObject(with: $0) as? [[String: Any]] } ?? []
        log(stored.first?["path"] as? String == canon(demo), "recent-projects.json records the adopted manifest", stored)

        let recent = await js("""
            const H = AtriumHost, list = await H.refreshRecentFiles(), out = {list};
            for (const [k, path] of [['etc', '/etc/hosts'], ['traversal', selectedPath.replace('/proj/', '/proj/../proj/')], ['number', 42], ['relative', 'proj/Demo.waffle']]) {
              try { await H.openRecent({path}); out[k] = 'OPENED'; } catch (e) { out[k] = e.message; }
            }
            const files = await H.openRecent(list[0]);
            out.files = files.filter(f => f.folderProject?.grant && f.folderProject.manifest === 'Demo.waffle').map(f => f.name);
            for (const f of files) if (f.folderProject?.grant) await H.folderClose({grant:f.folderProject.grant});
            const palette = globalThis.AtriumPalette || await AtriumLazy.need('AtriumPalette');
            out.palette = (palette.entries('') || []).map(e => e.key);
            return out;
            """, ["selectedPath": canon(demo)])
        let r = recent as? [String: Any] ?? [:]
        let list = r["list"] as? [[String:Any]] ?? []
        log(list.first?["path"] as? String == canon(demo) && list.first?["openedAt"] is Double, "recentFiles returns the saved path and open time", list)
        log(["etc", "traversal", "number", "relative"].allSatisfy { (r[$0] as? String)?.contains("not in the recent") == true },
            "openRecent refuses paths outside the list", r.filter { !["list","files","palette"].contains($0.key) })
        log(r["files"] as? [String] == ["Demo.waffle"], "openRecent returns a folder grant for a listed project", r["files"])
        log((r["palette"] as? [String])?.contains("file:" + canon(demo)) == true, "command palette lists the recent folder")
        await overlappingProjectReads(demo)

        let edited = await editNetName("Harness draft one")
        log(edited && projectBytes(demo) == baseline, "private autosave writes no project members while a sheet is dirty")
        guard let first = await checkMemberSave(baseline, text: "Harness draft one") else { return finish() }
        await overlappingProjectReads(demo)
        log(await editNetName("Harness saved two"), "a new active sheet edit follows the extra reads")
        _ = await checkMemberSave(first, text: "Harness saved two")
        let draftsRetired = await truthy("""
            const s = AtriumNavHost.folderProject();
            await s.flushDrafts(); return !s.dirty && (await s.listDrafts()).length === 0 && !s.draftMetrics().pending;
            """)
        log(draftsRetired, "the saved session settles its private draft")

        // Reopen another physically stored project after an acknowledged transaction was interrupted.
        let other = fixtureManifest("Other")
        do {
            try await prepareProject(other)
            guard var expected = projectBytes(other) else { throw CocoaError(.fileReadCorruptFile) }
            expected[other.lastPathComponent] = try interruptTransaction(other, saved: expected)
            guard let otherEditor = await openWindow(other) else { log(false, "Finder opens an interrupted native transaction"); return finish() }
            let otherHarness = Harness(otherEditor)
            let reopened = await otherHarness.truthy("return AtriumNavHost.project().name === 'Recovered journal' && !AtriumNavHost.isDirty()")
            let idle = await otherHarness.settled(other)
            log(reopened && idle && projectBytes(other) == expected,
                "Finder replays the acknowledged native journal and leaves other members byte-identical")
        } catch { log(false, "prepared and reopened the interrupted native transaction", error); return finish() }

        // File › Open Recent focuses the original folder even though a second project is active.
        let originalBound = await bound(to: demo)
        log(editor(for: other) != nil && originalBound, "a second project opens in its own window")
        let file = NSApp.mainMenu?.items.first { $0.submenu?.title == "File" }?.submenu
        let recentMenu = file?.items.first { $0.title == "Open Recent" }?.submenu
        if let menu = recentMenu {
            d.menuNeedsUpdate(menu)
            let titles = menu.items.map { $0.isSeparatorItem ? "—" : $0.title }
            log(titles == ["Other.waffle", "Demo.waffle", "—", "Clear Menu"] && titles.last == "Clear Menu", "File › Open Recent lists the projects", titles)
            if let index = menu.items.firstIndex(where: { $0.title == "Demo.waffle" }) {
                let wasActive = NSApp.isActive
                menu.performActionForItem(at: index)
                await expectFocus(d.window, "File › Open Recent focuses the open project", wasActive: wasActive, timeout: 10)
                log(editor(for: demo) === d && editor(for: other) != nil, "File › Open Recent keeps both project windows")
            }
        } else { log(false, "File › Open Recent menu exists") }
        _ = await js("for (const d of document.querySelectorAll('dialog.recover-prompt[open]')) d.close(); return true")

        editor(for: other)?.window.close()

        // 10. readFile for library sources
        let reads = await js("""
            const out = {};
            const f = await AtriumHost.readFile(lib); out.ok = {name: f.name, path: f.path, text: await f.text()};
            for (const [k, p] of [['secret', secret], ['symlink', linked], ['traversal', lib.replace('/libs/', '/libs/../libs/')], ['project', demo], ['relative', 'libs/parts.atrlib']]) {
              try { await AtriumHost.readFile(p); out[k] = 'READ'; } catch (e) { out[k] = e.message; }
            }
            return out;
            """, ["lib": canon(library), "secret": canon(secret), "linked": linked.path, "demo": canon(demo)])
        let rd = reads as? [String: Any] ?? [:]
        log(((rd["ok"] as? [String: Any])?["text"] as? String)?.contains("Harness parts v2") == true, "readFile reads a library file chosen earlier", rd["ok"])
        log(["secret", "symlink", "traversal", "project", "relative"].allSatisfy { (rd[$0] as? String).map { $0 != "READ" } ?? false }, "readFile refuses other paths, symlinks and traversal",
            rd.filter { $0.key != "ok" })
        // Library sources › Reload
        _ = await js("""
            localStorage.setItem('atrium.libraries.v1', JSON.stringify([{id: 'h1', name: 'Harness parts', path: lib, defs: [], added: '2026-01-01', modified: false}]));
            window.dispatchEvent(new CustomEvent('atrium-command', {detail: 'library-sources'})); return true
            """, ["lib": canon(library)])
        let reloadButton = await until(10) { await truthy("return [...document.querySelectorAll('dialog[open] button')].some(b => b.textContent === 'Reload')") }
        await shot("06-library-sources")
        _ = await js("[...document.querySelectorAll('dialog[open] button')].find(b => b.textContent === 'Reload')?.click(); return true")
        let reloaded = await until(5) { await truthy("return JSON.parse(localStorage.getItem('atrium.libraries.v1'))[0].name === 'Harness parts v2'") }
        log(reloadButton && reloaded, "Library sources › Reload re-reads the .atrlib from disk")
        _ = await js("for (const d of document.querySelectorAll('dialog[open]')) d.close(); return true")
        // The library pick panel (the user's choice there is what allows readFile)
        _ = await js("window.__picked = undefined; AtriumHost.pickFile(['.atrlib', '.json']).then(v => window.__picked = v ? v.name : null, e => window.__picked = 'ERR ' + e.message); return true")
        if let panel = await sheet() as? NSOpenPanel {
            let types = panel.allowedContentTypes.compactMap { $0.preferredFilenameExtension }
            log(types.contains("atrlib") && types.contains("json"), "Open library file shows an open panel for .atrlib/.json", types)
            d.window.endSheet(panel, returnCode: .cancel)
        } else { log(false, "library open panel appears") }
        _ = await until(5) { await truthy("return window.__picked !== undefined") }

        // 11. Print (PDFKit) and PDF export
        _ = await js("""
            window.__printed = undefined;
            if (globalThis.AtriumLazy && !globalThis.AtriumPrint) await AtriumLazy.need('AtriumPrint');
            AtriumPrint.print(AtriumNavHost.project(), {...AtriumPrint.DEFAULTS}, 'Harness.pdf').then(v => window.__printed = v, e => window.__printed = 'ERR ' + e.message);
            return true
            """)
        if let printSheet = await sheet(15) {
            await pause(1.5)
            await shot("07-print-panel")
            log(true, "Print opens the native print panel for the PDF", type(of: printSheet))
            if let cancel = button("Cancel", in: printSheet.contentView) { cancel.performClick(nil) } else { d.window.endSheet(printSheet, returnCode: .cancel) }
        } else {
            log(false, "Print opens the native print panel", await js("return window.__printed"))
        }
        let printed = await until(10) { await truthy("return window.__printed !== undefined") }
        log(printed, "printPDF completes after the panel closes", await js("return window.__printed"))
        UserDefaults.standard.set(work.appendingPathComponent("out").path, forKey: "NSNavLastRootDirectory")
        _ = await js("""
            window.__pdf = undefined;
            const bytes = AtriumPrint.build(AtriumNavHost.project(), {...AtriumPrint.DEFAULTS}).bytes();
            AtriumHost.exportFile('Harness.pdf', bytes).then(v => window.__pdf = v, e => window.__pdf = 'ERR ' + e.message); return true
            """)
        if let panel = await sheet() as? NSSavePanel {
            panel.directoryURL = work.appendingPathComponent("out")
            panel.nameFieldStringValue = "Harness.pdf"
            await pause(0.8)
            _ = await confirm(panel)
        }
        _ = await until(10) { await truthy("return window.__pdf !== undefined") }
        let pdf = (try? Data(contentsOf: work.appendingPathComponent("out/Harness.pdf"))) ?? Data()
        log(pdf.starts(with: Data("%PDF".utf8)), "Export PDF writes a PDF through the save panel", "\(pdf.count) bytes")

        // 12. Start page lists the recent projects
        _ = await js("window.dispatchEvent(new CustomEvent('atrium-command', {detail: 'start-page'})); return true")
        let listed = await until(8) { await truthy("""
            const names = [...document.querySelectorAll('dialog.sp-dialog[open] .sp-recent li')].map(li => li.textContent);
            return ['Demo.waffle', 'Other.waffle'].every(name => names.some(text => text.includes(name)));
            """) }
        await shot("08-start-page-recent")
        log(listed, "Home lists native projects opened in either window", await js("return [...document.querySelectorAll('dialog.sp-dialog[open] .sp-recent li')].map(li => li.textContent.slice(0, 60))"))
        _ = await js("document.querySelector('dialog.sp-dialog[open]')?.close(); return true")

        await gitStep(fixtureManifest("History"))

        log(await settled(demo), "clean close begins with a settled native transaction")
        finish(close: true)
    }

    // Real Git commits contain a native manifest and every referenced owner. The same fixture
    // drives the revision picker, history worker, semantic object blame, and merge review.
    @discardableResult func git(_ args: [String], in root: URL, author: String = "Ana Lee", daysAgo: Double = 0) -> (Int32, String) {
        let p = Process(), out = Pipe()
        p.executableURL = URL(fileURLWithPath: "/usr/bin/env")
        p.arguments = ["git", "-c", "user.name=" + author, "-c", "user.email=" + author.split(separator: " ")[0].lowercased() + "@example.invalid", "-c", "core.hooksPath=/dev/null"] + args
        p.currentDirectoryURL = root
        var env = ProcessInfo.processInfo.environment.filter { !$0.key.hasPrefix("GIT_") }
        let date = ISO8601DateFormatter().string(from: Date().addingTimeInterval(-daysAgo * 86400))
        env["GIT_AUTHOR_DATE"] = date; env["GIT_COMMITTER_DATE"] = date
        p.environment = env; p.standardOutput = out; p.standardError = out
        do { try p.run() } catch { return (-1, "\(error)") }
        let data = out.fileHandleForReading.readDataToEndOfFile(); p.waitUntilExit()
        return (p.terminationStatus, String(decoding: data, as: UTF8.self))
    }

    func gitStep(_ manifest: URL = demo) async {
        let made = await js(fixtureWriter + """
            const copy = x => structuredClone(x);
            const pcb = p => p.documents.find(d => d.kind === 'pcb'), part = (p, r) => pcb(p).items.find(i => i.kind === 'part' && i.ref === r);
            const v0 = AtriumParts.example();
            v0.name = name;
            const v1 = copy(v0); part(v1, 'R1').x += 4;
            const v2 = copy(v1); part(v2, 'C1').value = '22 nF';
            const v3 = copy(v2); pcb(v3).items.find(i => i.kind === 'track').width = 0.4;
            const v4 = copy(v3); part(v4, 'R1').x -= 1.5; part(v4, 'R1').angle = 90;
            const f1 = copy(v1); part(f1, 'R1').x += 6; part(f1, 'U1').y += 2;
            const initial = fixtureFiles(v0, filename, pcb(v0).id);
            const owner = initial.find(row => row.path.endsWith('.wpcb'));
            if (!owner) throw Error('The initial history fixture needs its native PCB owner');
            const M = AtriumFormat2Model, F = AtriumFormat2, utf8 = new TextDecoder();
            const board = M.parse(new TextEncoder().encode(owner.text));
            const original = new Map(pcb(v0).items.map(item => [item.id, JSON.stringify(item)]));
            const versions = [v0, v1, v2, v3, v4, f1].map(project => {
                const doc = pcb(project);
                const put = doc.items.filter(item => JSON.stringify(item) !== original.get(item.id));
                if (!put.length) return initial;
                const change = F.applyDelta(board, M.documentEdits(board, doc, {put}));
                if (change.headerChanged || change.changedRows !== put.length)
                    throw Error('A history revision changed records outside its intended PCB edits');
                const text = utf8.decode(F.serialize(change.file));
                const edited = new Set(put.map(item => item.id));
                const untouched = value => value.split('\\n').filter(line => !line || !edited.has(JSON.parse(line).id)).join('\\n');
                if (untouched(text) !== untouched(owner.text))
                    throw Error('A history revision changed unchanged PCB bytes');
                return initial.map(row => row === owner ? {path: row.path, text} : row);
            });
            return {versions, r1: part(v4, 'R1').id, pcb: pcb(v4).id};
            """, ["filename":manifest.lastPathComponent,"name":manifest.deletingPathExtension().lastPathComponent])
        guard let fixture = made as? [String:Any], let versions = fixture["versions"] as? [[[String:String]]],
              versions.count == 6, let r1 = fixture["r1"] as? String, let boardId = fixture["pcb"] as? String else {
            log(false, "prepared all six native history snapshots with fixed design IDs", made); return
        }
        let root = manifest.deletingLastPathComponent()
        func run(_ args: [String], author: String = "Ana Lee", daysAgo: Double = 0) throws {
            let (status, detail) = git(args, in: root, author: author, daysAgo: daysAgo)
            if status != 0 { throw NSError(domain:"Harness Git fixture",code:Int(status),userInfo:[NSLocalizedDescriptionKey: detail]) }
        }
        do {
            try writeFixture(versions[0], to: manifest)
            try run(["init", "-q", "-b", "main"])
            try run(["add", "--", "."])
            try run(["commit", "-qm", "Initial board from the schematic"], daysAgo:6)
            try writeFixture(versions[1], to: manifest)
            try run(["commit", "-qam", "Move R1 closer to J1"], author:"Ben Ortiz", daysAgo:4)
            try run(["tag", "v0.1"])
            try run(["checkout", "-qb", "feature/connector"])
            try writeFixture(versions[5], to: manifest)
            try run(["commit", "-qam", "Make room for the new connector"], author:"Chen Wu", daysAgo:3)
            try run(["checkout", "-q", "main"])
            try writeFixture(versions[2], to: manifest)
            try run(["commit", "-qam", "C1 to 22 nF for the filter corner"], daysAgo:2)
            try Data("Design notes\n".utf8).write(to: root.appendingPathComponent("NOTES.md"))
            try run(["add", "NOTES.md"])
            try run(["commit", "-qm", "Design notes"], author:"Ben Ortiz", daysAgo:1.5)
            try writeFixture(versions[3], to: manifest)
            try run(["commit", "-qam", "Widen the VIN track"], author:"Ben Ortiz", daysAgo:1)
            try writeFixture(versions[4], to: manifest)
            try run(["commit", "-qam", "Rotate R1 to shorten the feedback loop"], daysAgo:0.1)
        } catch { log(false, "created a real Git repository with branches and a tag", error); return }
        _ = await js("AtriumStartPage.close(); return true")
        guard let editor = await openWindow(manifest) else { log(false, "Finder opens the current native Git head"); return }
        let probe = editor === d ? self : Harness(editor)
        await probe.verifyGit(manifest, r1:r1, boardId:boardId)
        if probe !== self {
            failures += probe.failures
            editor.window.performClose(nil)
        }
    }

    func verifyGit(_ manifest: URL, r1: String, boardId: String) async {
        let q = await js("""
            const H = AtriumHost, out = {};
            try {
                const refs = await H.gitQuery('refs');
                out.branches = refs.refs.filter(r => r.kind === 'branch').map(r => r.short).sort();
                out.tags = refs.refs.filter(r => r.kind === 'tag').map(r => r.short);
                const {commits} = await H.gitQuery('projectLog', {limit: 50});
                out.commits = commits.length;
                out.changed = [];
                for (const c of commits) {
                    const {blobs} = await H.gitQuery('projectBlobs',{revisions:[c.revision,...c.parents.slice(0,1)]});
                    if (blobs[c.revision] !== (blobs[c.parents[0]] ?? null)) out.changed.push(c.subject);
                }
                const peek = (await H.gitQuery('folderRevisions',{revisions:[refs.head]})).revisions[0];
                out.committed = !!peek.files[board] && !!peek.files[sheet];
                const saved = await AtriumNavHost.requireProjectClosure({purpose:'history',saved:true});
                const resistor = saved.project.documents.find(doc => doc.kind === 'pcb').items.find(i => i.ref === 'R1');
                out.worktree = resistor.angle === 90 && Math.abs(resistor.x - 12.4) < 1e-6;
                for (const [key, op, args] of [['push','push',{}],['exec','log',{exec:'x'}],
                    ['bad','folderRevisions',{revisions:['--output=/tmp/x']}],['ref','log',{refs:['--all']}],['legacy','read',{revision:'worktree'}]]) {
                    try { await H.gitQuery(op,args); out[key] = 'RAN'; } catch (e) { out[key] = e.message; }
                }
            } catch (e) { out.error = e.message; }
            return out;
            """, ["board":demoBoard,"sheet":demoSheet]) as? [String:Any] ?? [:]
        log((q["branches"] as? [String]) == ["feature/connector", "main"] && (q["tags"] as? [String]) == ["v0.1"] &&
            q["commits"] as? Int == 7 && (q["changed"] as? [String])?.count == 6 &&
            (q["changed"] as? [String])?.contains("Design notes") == false && q["committed"] as? Bool == true &&
            q["worktree"] as? Bool == true, "the native Git bridge distinguishes six exact design revisions from a notes-only commit",q)
        log(["push", "exec", "bad", "ref", "legacy"].allSatisfy { (q[$0] as? String).map { $0 != "RAN" } ?? false },
            "the native Git bridge refuses writes, unknown keys, option-like values and old single-file reads",
            q.filter { ["push","exec","bad","ref","legacy"].contains($0.key) })
        // Revision picker
        _ = await js("AtriumLazy.need('AtriumGitPicker').then(() => AtriumGitPicker.pickPair({title: 'Compare revisions', after: {type: 'working'}})); return true")
        _ = await until(15) { await truthy("return document.querySelectorAll('dialog.gp-dialog[open] .gp-row').length === 7") }
        _ = await js("const r = document.querySelectorAll('dialog.gp-dialog[open] .gp-row')[1]; r?.click(); return true")
        await pause(0.4); await shot("20-git-picker")
        let graph = await js("""
            const dialog = document.querySelector('dialog.gp-dialog[open]');
            if (!dialog) return {};
            const chips = tone => [...dialog.querySelectorAll(`.gp-row .gp-chip.ui-badge[data-tone="${tone}"]`)].map(chip => chip.textContent).sort();
            return {rows: dialog.querySelectorAll('.gp-row').length,
                lanes: [0, 1].filter(lane => dialog.querySelector(`.gp-graph path.gp-lane-${lane}`)).length,
                branches: chips('accent'), tags: chips('info'), status: dialog.querySelector('.gp-status')?.textContent};
            """) as? [String:Any] ?? [:]
        log(graph["rows"] as? Int == 7 && graph["lanes"] as? Int == 2 &&
            graph["branches"] as? [String] == ["feature/connector", "main"] && graph["tags"] as? [String] == ["v0.1"],
            "revision picker: commit graph with lanes, branch and tag chips", graph)
        _ = await js("for (const d of document.querySelectorAll('dialog[open]')) d.close(); return true")
        // Use the UI harness's on-screen setting for unattended runs with the display asleep.
        let screen = UIProbes(self)
        screen.setOcclusionDetection(false)
        d.window.orderOut(nil); d.window.orderFrontRegardless(); d.window.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
        _ = await js("AtriumPower.host({occluded:false}); return true")
        // The native file-origin worker must produce real design summaries and previews.
        _ = await js("AtriumNavHost.act('project-history'); return true")
        let visual = await until(20) { await truthy("""
            const row = document.querySelector('.hv-row[data-type=commit]');
            const changed = [...document.querySelectorAll('.hv-row[data-type=commit]')].find(r => r.querySelector('.ui-dot'));
            if (row && changed && AtriumHistoryView.state().sel !== changed.dataset.key) changed.click();
            return !!document.querySelector('.hv-details .hv-headline') &&
              document.querySelectorAll('.hv-details .hv-tile').length === 2 &&
              !!document.querySelector('.hv-details .hv-tile .hv-changed') &&
              getComputedStyle(document.querySelector('.hv-view')).backgroundColor !== 'rgba(0, 0, 0, 0)';
            """) }
        log(visual, "Project History renders first-parent design summaries in a file-origin worker", await js("return {power:AtriumPower.state(), hidden:document.hidden, height:document.querySelector('.hv-scroll')?.clientHeight, rows:document.querySelectorAll('.hv-row').length, line:document.querySelector('.hv-headline')?.textContent}"))
        await shot("project-history")
        _ = await js("AtriumHistoryView.close(); return true")
        screen.setOcclusionDetection(true)
        // File history
        _ = await js("AtriumNavHost.act('file-history'); return true")
        let fh = await until(15) { await truthy("""
            const actual = [...document.querySelectorAll('.hv-row[data-type=commit] .ui-row-title')].map(n => n.textContent);
            const expected = ['Rotate R1 to shorten the feedback loop','Widen the VIN track',
                'C1 to 22 nF for the filter corner','Move R1 closer to J1','Initial board from the schematic'];
            return document.querySelector('.hv-branches')?.value === 'file' && JSON.stringify(actual) === JSON.stringify(expected);
            """) }
        await shot("21-git-file-history")
        log(fh, "file history lists the five commits on main that changed a native project member",
            await js("return [...document.querySelectorAll('.hv-row[data-type=commit] .ui-row-title')].map(n => n.textContent)"))
        _ = await js("AtriumHistoryView.close(); return true")
        // Blame line in Properties
        let selected = await truthy("""
            const H = AtriumNavHost;
            await H.selectDocument(p);
            H.select([r], r);
            if (document.body.classList.contains('hide-right')) H.act('toggle-right');
            return H.doc().id === p && H.selection()[0] === r;
            """, ["p":boardId,"r":r1])
        // Blame walks the history only on request: press the Properties line's "Who changed this?" first.
        _ = await until(10) { await truthy("const l = document.querySelector('#inspector .blame-line'); if (/Changed .* by/.test(l?.textContent || '')) return true; const b = [...(l?.querySelectorAll('.blame-link') || [])].find(x => /Who changed/.test(x.textContent)); if (b) b.click(); return !!b") }
        let blamed = await until(20) { await truthy("return /Changed .* by Ana Lee/.test(document.querySelector('#inspector .blame-line')?.textContent || '')") }
        // The Properties panel in a dialog frame, so the screenshot shows it whatever WebKit last painted.
        _ = await js("""
            const d = document.createElement('dialog'); d.className = 'work-dialog'; d.style.width = '380px';
            const h = document.createElement('h2'); h.textContent = 'Properties (R1 selected)'; d.append(h, document.getElementById('inspector').cloneNode(true)); d.onclose = () => d.remove();
            document.body.append(d); d.showModal(); return true
            """)
        await shot("22-git-blame-line")
        _ = await js("for (const d of document.querySelectorAll('dialog[open]')) d.close(); return true")
        log(selected && blamed, "Properties shows who last changed the selected part", await js("return document.querySelector('#inspector .blame-line')?.textContent"))
        // Show History of This Object
        _ = await js("AtriumNavHost.act('object-history'); return true")
        let hist = await until(15) { await truthy("return AtriumHistoryView.state()?.query.object === 'R1' && AtriumHistoryView.state().objectHits >= 3") }
        await shot("23-git-object-history")
        log(hist, "Show History of This Object lists every change to R1",
            await js("return [...document.querySelectorAll('.hv-row[data-type=commit] .ui-row-title')].map(n => n.textContent)"))
        _ = await js("AtriumHistoryView.close(); return true")
        // A conflicting merge (no driver: Git's text merge stops on R1) and the merge view.
        let root = manifest.deletingLastPathComponent()
        let merged = git(["merge", "--no-edit", "feature/connector"], in: root)
        let conflicts = git(["diff", "--name-only", "--diff-filter=U"], in: root).1
        log(merged.0 != 0 && conflicts.trimmingCharacters(in:.whitespacesAndNewlines) == demoBoard,
            "Git reports a real unmerged PCB owner on the feature branch", merged.1)
        _ = await js("AtriumNavHost.act('merge-conflicts'); return true")
        let mg = await until(15) { await truthy("return document.querySelectorAll('dialog.mg-dialog[open] .mg-row').length === 1") }
        let checked = await until(15) { await truthy("""
            const check = document.querySelector('dialog.mg-dialog[open] .mg-checks')?.textContent || '';
            return /DRC \\d+/.test(check) && /ERC errors \\d+/.test(check);
            """) }
        await shot("24-git-merge")
        let info = await js("""
            const d = document.querySelector('dialog.mg-dialog[open]');
            return {conflict: d?.querySelector('.mg-row strong')?.textContent, sub: d?.querySelector('.mg-sub')?.textContent, checks: d?.querySelector('.mg-checks')?.textContent,
              auto: [...(d?.querySelectorAll('.mg-auto-text') || [])].map(n => n.textContent)}
            """) as? [String: Any] ?? [:]
        log(mg && checked && (info["conflict"] as? String)?.contains("R1") == true && ((info["auto"] as? [String]) ?? []).contains { $0.contains("U1") },
            "merge view: R1 is the one conflict; U1's move merged by itself; live DRC/ERC", info)
        if mg {
            _ = await js("[...document.querySelectorAll('dialog.mg-dialog[open] .mg-take-btn')].find(b => b.textContent === 'Take Theirs')?.click(); return true")
            let preview = await until(12) { await truthy("return document.querySelector('dialog.mg-dialog[open] .mg-checks')?.textContent.includes('All conflicts resolved')") }
            log(preview && git(["diff", "--name-only", "--diff-filter=U"], in: root).1 == conflicts,
                "Take Theirs updates the preview while leaving the actual Git conflict untouched")
            await shot("25-git-merge-theirs")
        }
        _ = await js("for (const d of document.querySelectorAll('dialog[open]')) d.close(); return true")
        git(["merge", "--abort"], in: root)
        let left = git(["status", "--porcelain", "--untracked-files=no"], in: root).1.trimmingCharacters(in: .whitespacesAndNewlines)
        log(left.isEmpty, "git: nothing tracked changed (merge aborted, queries read-only)", left)
    }

    func stopRenderer(_ view: WKWebView) -> Bool {
        // A client-requested shutdown through WebKit SPI can suppress the crash delegate.
        let pid = EnergyProbes(self).spi(view, "_webProcessIdentifier")
        return pid > 1 && pid != getpid() && Darwin.kill(pid, SIGKILL) == 0
    }

    func rendererRecovery() async {
        defer { d.window.isDocumentEdited = false }
        do { try await prepareProject(demo) }
        catch { log(false, "prepared the native recovery fixture", error); return }
        guard let saved = projectBytes(demo), await openFixture(demo),
              let oldGrant = await js("return AtriumHost.folderGitGrant") as? String,
              await writePrivateDraft("Private fixture draft") else {
            log(false, "a dirty private draft is durable before renderer termination"); return
        }
        let old = d.web!
        if let recorder = (old as? EditorWebView)?.inputLog {
            _ = await js("return await AtriumHost.inputDiagnostics('start')")
            recorder.gesture("pinch")
            log((recorder.inspect("read")?["rows"] as? [[String: Any]])?.count == 1, "the active editor records requested input categories")
        }
        guard stopRenderer(old), let restartSheet = await sheet(),
              let restart = button("Restart Editor", in: restartSheet.contentView) else {
            log(false, "termination offers an editor restart"); return
        }
        log(((old as? EditorWebView)?.inputLog.inspect("read")?["rows"] as? [[String: Any]])?.isEmpty == true,
            "WebContent termination clears the previous editor's input diagnostics")
        restart.performClick(nil)
        let prompt = await waitForDraft("Demo", of: demo)
        let newGrant = await js("return AtriumHost.folderGitGrant") as? String
        log(d.web !== old && prompt && newGrant != nil && newGrant != oldGrant,
            "a fresh renderer reopens the saved folder with a new grant and offers its private draft")
        log(projectBytes(demo) == saved, "offering the private draft leaves every saved member byte-identical")
        let restored = await restoreDraft("Private fixture draft")
        log(restored && projectBytes(demo) == saved, "Restore installs only this folder’s unsaved changes")
        _ = await js("document.querySelector('button[data-action=crash-diagnostics]')?.click(); return true")
        let expectedHost = ["architecture": SupportDiagnostics.architecture,
                            "displays": SupportDiagnostics.displayCount(NSScreen.screens.count)]
        let diagnostic = await until(8) { await truthy("""
            const text = document.querySelector('dialog.diagnostics-dialog[open] textarea')?.value;
            if (!text) return false;
            const report = JSON.parse(text);
            return report.format === 'waffle-diagnostics' && report.host.platform === 'macos' &&
              report.host.architecture === architecture && report.rendererTerminations.terminated === 'one' &&
              report.host.availableDisplays === displays && !['Private fixture draft', 'Demo.waffle', 'file://'].some(value => text.includes(value));
            """, expectedHost) }
        log(diagnostic, "Crash Diagnostics exposes the local renderer failure without project data")
        if diagnostic, let preview = await js("return document.querySelector('dialog.diagnostics-dialog[open] textarea').value") as? String {
            let copied = await truthy("""
                const original = Object.getOwnPropertyDescriptor(navigator, 'clipboard');
                let copied;
                // Capture the text at the web clipboard boundary without using the app user's pasteboard.
                Object.defineProperty(navigator, 'clipboard', {configurable:true, value:{async writeText(text) { copied = text; }}});
                try {
                  const dialog = document.querySelector('dialog.diagnostics-dialog[open]');
                  [...dialog.querySelectorAll('button')].find(button => button.textContent === 'Copy report').click();
                  return copied === preview;
                } finally {
                  if (original) Object.defineProperty(navigator, 'clipboard', original);
                  else delete navigator.clipboard;
                }
                """, ["preview": preview])
            log(copied, "Copy report forwards the exact preview text")
            _ = await js("""
                const dialog = document.querySelector('dialog.diagnostics-dialog[open]');
                [...dialog.querySelectorAll('button')].find(button => button.textContent === 'Save report…').click();
                return true;
                """)
            let confirmed: Bool
            if let panel = await sheet() as? NSSavePanel { confirmed = await confirm(panel) } else { confirmed = false }
            let reportURL = work.appendingPathComponent("out/waffle-diagnostics.json")
            let exported = await until(5) { confirmed && (try? String(contentsOf: reportURL, encoding: .utf8)) == preview }
            log(exported, "Save report writes the exact preview through the native save panel")
        }
        _ = await js("document.querySelector('dialog.diagnostics-dialog[open]')?.close(); AtriumNavHost.act('save-all'); return true")
        let clean = await until(12) {
            let clean = await self.truthy("""
                const s = AtriumNavHost.folderProject();
                await s.flushDrafts();
                return !s.dirty && (await s.listDrafts()).length === 0;
                """)
            return clean && (try? String(contentsOf:demo,encoding:.utf8))?.contains("Private fixture draft") == true
        }
        log(clean, "a durable Save retires the recovered version before a later independent edit")
        guard clean, rememberProject(), await writePrivateDraft("Final accepted draft"), stopRenderer(d.web),
              let again = await sheet(), button("Close Window", in: again.contentView) != nil,
              button("Restart Editor", in: again.contentView) == nil else {
            log(false, "a second failure offers a close after the latest private draft is durable"); return
        }
        log(true, "a second failure offers a close without entering a restart loop")
        // The next app process must still find the latest acknowledged draft, with all saved
        // owners identical to their pre-termination bytes.
        print("RESULT closed after second crash"); fflush(stdout)
        button("Close Window", in: again.contentView)?.performClick(nil)
        if await until(8, { self.d.web == nil }) { exit(0) }
        log(false, "Close Window retires the failed renderer")
    }

    /// A page that stops answering (an endless loop on its main thread): a key press or click shows
    /// the watchdog sheet; Restart Editor terminates the old WebContent process and reopens its folder.
    func hangRecovery() async {
        defer {
            d.window.isDocumentEdited = false
            Desktop.hangSeconds = 10
        }
        let project = fixtureManifest("Hang")
        do { try await prepareProject(project) }
        catch { log(false, "prepared the native watchdog fixture", error); return }
        guard let saved = projectBytes(project), await openFixture(project),
              let oldGrant = await js("return AtriumHost.folderGitGrant") as? String,
              await writePrivateDraft("Hung editor draft") else {
            log(false, "a private draft is durable before the page hangs"); return
        }
        Desktop.hangSeconds = 1.5
        d.probeResponsive()
        await pause(2.2)
        log(d.window.attachedSheet == nil, "a responsive page never shows the not-responding sheet")
        let old = d.web!
        old.evaluateJavaScript("setTimeout(() => { for (;;) {} }, 30); 0", completionHandler: nil)
        await pause(0.4)
        d.probeResponsive()   // as a click or key press in the window does
        guard let hung = await sheet(6), button("Wait", in: hung.contentView) != nil,
              let restart = button("Restart Editor", in: hung.contentView) else {
            log(false, "a page that stops answering gets a Wait / Restart Editor sheet"); return
        }
        log(true, "a page that stops answering gets a Wait / Restart Editor sheet")
        restart.performClick(nil)
        let prompt = await waitForDraft("Hang", of: project)
        let newGrant = await js("return AtriumHost.folderGitGrant") as? String
        log(d.web !== old && prompt && newGrant != nil && newGrant != oldGrant && d.window.attachedSheet == nil,
            "Restart Editor reopens the saved folder and offers the draft without a second native question")
        let restored = await restoreDraft("Hung editor draft")
        log(restored && projectBytes(project) == saved, "only the explicit Restore changes the working copy")
        let reasons = await js("return (await AtriumHost.crashHistory()).map(r => r.reason)") as? [String] ?? []
        log(reasons.last == "unresponsive", "Crash Diagnostics records the unresponsive editor", reasons)
    }

    var savedCopy: URL { work.appendingPathComponent("out/saved-copy/Demo.waffle") }

    func rememberProject() -> Bool {
        do {
            try fm.copyItem(at: demo.deletingLastPathComponent(), to: savedCopy.deletingLastPathComponent())
            return true
        } catch {
            log(false, "copied the physical project for byte comparison after restart", error)
            return false
        }
    }

    /// First launch: the editor acknowledges a private draft, then the real app is killed.
    func nativeKill() async {
        do { try await prepareProject(demo) }
        catch { log(false, "prepared the native termination fixture", error); return finish() }
        guard rememberProject(), await openFixture(demo), await writePrivateDraft("Native kill draft"),
              projectBytes(demo) == projectBytes(savedCopy) else {
            log(false, "a durable private draft leaves the saved project byte-identical before SIGKILL"); return finish()
        }
        log(true, "a durable private draft leaves the saved project byte-identical before SIGKILL")
        print("RESULT killed"); fflush(stdout)
        Darwin.kill(getpid(), SIGKILL)
    }

    /// Second process: the real folder open offers the locally persisted version before any edit.
    func afterEditorExit(savedName: String, draftName: String) async {
        defer { d.window.isDocumentEdited = false }
        guard let saved = projectBytes(savedCopy), projectBytes(demo) == saved else {
            log(false, "the previous app left every saved project member intact"); return
        }
        log(true, "the previous app left every saved project member intact")
        let opened = await openFixture(demo)
        let prompt = await waitForDraft(savedName, of: demo)
        log(opened && prompt && projectBytes(demo) == saved,
            "the normal Finder open presents the persisted private draft without changing saved bytes")
        let restored = await restoreDraft(draftName)
        log(restored && projectBytes(demo) == saved, "Restore recovers the latest acknowledged draft as an unsaved edit")
    }

    // ---- HARNESS_SUITE=close: closing and quitting with unsaved changes (HIG). A sheet on the window:
    // Save (Return), Cancel (Esc), Don't Save (⌘D, on the left). Save is the page's own save, in place or
    // through the save panel, and the window closes only after it; quitting with two unsaved windows asks
    // NSDocumentController's "Review Changes…" question, then each window. The last step quits for real:
    // run.sh then checks that both projects were saved during the quit.
    func openWindow(_ file: URL) async -> Desktop? {
        d.application(NSApp, openFiles: [file.path])
        var found: Desktop?
        _ = await until(15) { found = self.editor(for: file); return found != nil }
        guard let editor = found else { return nil }
        let h = Harness(editor)
        let ready = await h.until(15) { await h.bound(to: file) }
        return ready ? editor : nil
    }
    /// The close button: -> the sheet and its texts.
    func closePrompt(_ h: Harness) async -> (sheet: NSWindow, texts: [String])? {
        h.d.window.performClose(nil)
        guard let sheet = await h.sheet(5), findButton("Don’t Save", in: sheet.contentView) != nil else { return nil }
        return (sheet, views(NSTextField.self, in: sheet.contentView).map { $0.stringValue }.filter { !$0.isEmpty })
    }
    func press(_ title: String, _ sheet: NSWindow?) {
        if let button = findButton(title, in: sheet?.contentView) { button.performClick(nil) } else { note("no \(title) button") }
    }
    /// NSAlert.runModal holds the main actor's tasks, so a run-loop timer answers the next app-modal alert.
    func answerModal(_ title: String, _ seen: @escaping (String) -> Void = { _ in }) {
        let timer = Timer(timeInterval: 0.1, repeats: true) { timer in
            guard let modal = NSApp.modalWindow, let button = findButton(title, in: modal.contentView) else { return }
            timer.invalidate()
            seen(views(NSTextField.self, in: modal.contentView).map { $0.stringValue }.joined(separator: " | "))
            button.performClick(nil)
        }
        RunLoop.main.add(timer, forMode: .common)
    }
    /// The window with its sheet, as one picture (shots/<name>.png), drawn from the window's own parts:
    /// WebKit's snapshot of the page (the window's whole content) and the sheet's views. CoreGraphics
    /// does not list sheet windows on current macOS, and a window behind others can show it an older
    /// frame of the page. The title bar's window controls and the canvas's GPU layer are not drawn.
    func sheetShot(_ name: String) async {
        let page: NSImage? = await withCheckedContinuation { c in d.web.takeSnapshot(with: nil) { image, _ in c.resume(returning: image) } }
        guard let page = page, let sheet = d.window.attachedSheet, let content = sheet.contentView else { note("no sheet to capture"); return }
        let size = d.window.frame.size, scale = d.window.backingScaleFactor
        guard let out = NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: Int(size.width * scale), pixelsHigh: Int(size.height * scale),
                                         bitsPerSample: 8, samplesPerPixel: 4, hasAlpha: true, isPlanar: false, colorSpaceName: .deviceRGB,
                                         bytesPerRow: 0, bitsPerPixel: 0) else { return }
        out.size = size
        func paint(_ view: NSView, at rect: NSRect) {
            guard let rep = view.bitmapImageRepForCachingDisplay(in: view.bounds) else { return }
            view.cacheDisplay(in: view.bounds, to: rep)
            rep.draw(in: rect)
        }
        NSGraphicsContext.saveGraphicsState()
        NSGraphicsContext.current = NSGraphicsContext(bitmapImageRep: out)
        page.draw(in: d.web.convert(d.web.bounds, to: nil))
        let at = NSRect(x: sheet.frame.minX - d.window.frame.minX, y: sheet.frame.minY - d.window.frame.minY,
                        width: sheet.frame.width, height: sheet.frame.height)
        let shadow = NSShadow()
        shadow.shadowBlurRadius = 18
        shadow.shadowOffset = NSSize(width: 0, height: -4)
        shadow.shadowColor = NSColor.black.withAlphaComponent(0.45)
        NSGraphicsContext.saveGraphicsState()
        shadow.set()
        sheet.effectiveAppearance.performAsCurrentDrawingAppearance { NSColor.windowBackgroundColor.setFill() }
        NSBezierPath(roundedRect: at, xRadius: 14, yRadius: 14).fill()
        NSGraphicsContext.restoreGraphicsState()
        NSBezierPath(roundedRect: at, xRadius: 14, yRadius: 14).addClip()
        paint(content, at: at)
        NSGraphicsContext.restoreGraphicsState()
        guard let png = out.representation(using: .png, properties: [:]) else { return }
        try? png.write(to: work.appendingPathComponent("shots/" + name + ".png"))
    }

    func updateReview() async {
        _ = await js("globalThis.AtriumStartPage?.close?.()")
        let file = fixtureManifest("Update")
        do { try await prepareProject(file) }
        catch { log(false, "prepare the update project", error); return }
        d.application(NSApp, open: [file])
        guard await until(10, { await self.truthy("return !!AtriumNavHost.folderProject()") }) else {
            log(false, "open the saved project for update review"); return
        }
        let original = try? Data(contentsOf: file)
        let name = "Edit before installing the update"
        let edited = await editName(name)
        guard edited, await until(4, { self.d.window.isDocumentEdited }) else {
            log(false, "make an unsaved edit before starting the update"); return
        }
        do {
            try await d.lockSavedEditorsForUpdate()
            Desktop.unlockUpdateEditors()
            log(false, "an unsaved editor blocks bundle replacement")
        } catch { log(true, "an unsaved editor blocks bundle replacement", error.localizedDescription) }

        func review(_ decision: String) async -> Bool {
            let review = Task { await d.confirmUpdateRestart() }
            guard await until(5, { self.d.window.attachedSheet != nil }), let sheet = d.window.attachedSheet else {
                log(false, "show the native restart review"); return false
            }
            log(findButton("Save All and Restart", in: sheet.contentView) != nil &&
                findButton("Don’t Save", in: sheet.contentView) == nil, "update offers Save All or Cancel")
            press(decision, sheet)
            return await review.value
        }
        let cancelled = await review("Cancel")
        let keptDirty = await truthy("return AtriumNavHost.isDirty() && !document.documentElement.inert")
        log(!cancelled && keptDirty && (try? Data(contentsOf: file)) == original,
            "Cancel leaves the unsaved change open and the saved document untouched")

        let saved = await review("Save All and Restart")
        log(saved && (try? Data(contentsOf: file)) != original, "Save All writes the changes before restart")
        do {
            try await d.lockSavedEditorsForUpdate()
            let locked = await truthy("return !AtriumNavHost.isDirty() && document.documentElement.inert")
            log(locked, "saved windows are ready to restart")
            Desktop.unlockUpdateEditors()
        } catch { log(false, "the saved project permits restart", error.localizedDescription) }
    }

    func closePrompts() async {
        _ = await js("AtriumStartPage.close(); return true")
        let files = ["Saved", "Discarded", "QuitA", "QuitB"].map(fixtureManifest)
        do { for file in files { try await prepareProject(file) } }
        catch { log(false, "prepared the separated native folders for close and quit", error); return finish() }
        let fresh = fixtureManifest("Close Prompt Board")
        let destination = fresh.deletingLastPathComponent().deletingLastPathComponent()
        let text = { (url: URL) in (try? String(contentsOf: url, encoding: .utf8)) ?? "" }

        // 1. An untitled project with unsaved changes: the sheet, then Cancel.
        let untitled = await truthy("""
            await AtriumNavHost.replaceProject(AtriumParts.example(), {copy: true, dirty: false});
            globalThis.AtriumStartPage?.close?.();
            for (const d of document.querySelectorAll('dialog[open]')) d.close();
            await new Promise(r => setTimeout(r, 300));
            globalThis.AtriumStartPage?.close?.();
            for (const d of document.querySelectorAll('dialog[open]')) d.close();
            const board = AtriumNavHost.project().documents.find(d => d.kind === 'pcb');
            if (board) AtriumNavHost.selectDocument(board.id);
            AtriumNavHost.edit(() => { AtriumNavHost.project().name = 'Close Prompt Board'; });
            await new Promise(r => setTimeout(r, 200));
            try { AtriumNavHost.view().fit(AtriumNavHost.doc(), AtriumNavHost.defs()); AtriumNavHost.redraw(); } catch {}
            await new Promise(r => setTimeout(r, 400));
            await new Promise(r => setTimeout(r, 50));
            return AtriumNavHost.isDirty() && !AtriumHost.folderGitGrant
            """)
        // Home may open again once the starter is replaced: close it so the picture shows the board.
        _ = await until(3) { await self.truthy("""
            document.querySelector('dialog.sp-dialog[open] [data-start-action=close]')?.click();
            globalThis.AtriumStartPage?.close?.(); for (const d of document.querySelectorAll('dialog[open]')) d.close();
            await new Promise(r => setTimeout(r, 300));
            return !document.querySelector('dialog[open]')
            """) }
        guard untitled, let first = await closePrompt(self) else { log(false, "closing a window with unsaved changes shows the close sheet"); return finish() }
        let save = findButton("Save", in: first.sheet.contentView), cancel = findButton("Cancel", in: first.sheet.contentView)
        let dontSave = findButton("Don’t Save", in: first.sheet.contentView)
        log(first.texts.contains("Do you want to save the changes you made to “Close Prompt Board”?")
            && first.texts.contains("Your changes will be lost if you don’t save them."), "the sheet asks to save the changes made to the project", first.texts)
        log(NSApp.modalWindow == nil && d.window.attachedSheet === first.sheet, "the prompt is a sheet on its window, not app-modal")
        // NSAlert makes its first button the sheet's default button (Return) instead of a key equivalent.
        let saveIsDefault = save?.keyEquivalent == "\r" || (save != nil && first.sheet.defaultButtonCell === save?.cell)
        log(saveIsDefault && cancel?.keyEquivalent == "\u{1b}" && dontSave?.keyEquivalent == "d"
            && dontSave?.keyEquivalentModifierMask == .command, "Save answers Return, Cancel Esc and Don’t Save ⌘D",
            [save?.keyEquivalent, cancel?.keyEquivalent, dontSave?.keyEquivalent].map { String(describing: $0) })
        if let save = save, let dontSave = dontSave, let cancel = cancel {
            // NSAlert's layout: in a row, the third button on the left; stacked (narrow alerts), below Save.
            let s = save.convert(save.bounds, to: nil), n = dontSave.convert(dontSave.bounds, to: nil), c = cancel.convert(cancel.bounds, to: nil)
            log(n.maxX <= s.minX || n.maxY <= s.minY, "Don’t Save is set apart from Save, on the left (or below it)", "save=\(s) cancel=\(c) dontSave=\(n)")
        }
        await pause(0.6)
        await sheetShot("close-sheet")
        press("Cancel", first.sheet)
        await pause(0.6)
        let keptDirty = await truthy("return AtriumNavHost.isDirty()")
        log(d.window.isVisible && d.window.attachedSheet == nil && d.window.isDocumentEdited && keptDirty,
            "Cancel keeps the window and its unsaved changes")

        // 2. Save opens the save panel (no file yet); cancelling it keeps the window open and unsaved.
        UserDefaults.standard.set(destination.path, forKey: "NSNavLastRootDirectory")
        guard let second = await closePrompt(self) else { log(false, "the close sheet shows again"); return finish() }
        press("Save", second.sheet)
        var panel: NSSavePanel?
        _ = await until(8) { panel = self.d.window.attachedSheet as? NSSavePanel; return panel != nil }
        log(panel != nil, "Save on an untitled project opens the save panel")
        if let panel = panel { d.window.endSheet(panel, returnCode: .cancel) }
        await pause(1.2)
        let stillDirty = await truthy("return AtriumNavHost.isDirty()")
        log(d.window.isVisible && d.window.attachedSheet == nil && d.window.isDocumentEdited && stillDirty
            && !fm.fileExists(atPath: fresh.path), "a cancelled save panel keeps the window open, still unsaved")
        // A later ordinary save (the File menu's, or ⌘S) saves and leaves the window open.
        _ = await js("window.__saved = undefined; AtriumNavHost.saveProject().then(v => window.__saved = v, e => window.__saved = 'ERR ' + e.message); return true")
        if let panel = await sheet() as? NSSavePanel {
            panel.directoryURL = destination
            panel.nameFieldStringValue = fresh.deletingPathExtension().lastPathComponent
            await pause(0.8)
            _ = await confirm(panel)
        } else { log(false, "the ordinary save opens the save panel") }
        let savedLater = await until(10) { await truthy("return window.__saved === true && !AtriumNavHost.isDirty()") }
        await pause(1)
        let initialBinding = await bound(to: fresh)
        let written = projectBytes(fresh)
        log(savedLater && initialBinding && d.window.isVisible && !d.window.isDocumentEdited &&
            text(fresh).contains("Close Prompt Board") && written?[demoSheet] != nil && written?[demoBoard] != nil,
            "a later ordinary Save creates the complete native folder and keeps the window open",
            "saved=\(savedLater) visible=\(d.window.isVisible) edited=\(d.window.isDocumentEdited) files=\(written?.keys.sorted() ?? [])")

        // 3. Save on a project with a file: saved in place, then the window closes.
        guard let savedBeforeClose = projectBytes(files[0]), let saving = await openWindow(files[0]) else { log(false, "a second project window opens"); return finish() }
        let hs = Harness(saving)
        let edited = await hs.editName("Saved on close")
        guard edited, let third = await closePrompt(hs) else { log(false, "the second window shows the close sheet"); return finish() }
        log(third.texts.contains("Do you want to save the changes you made to “Saved on close”?"), "the sheet names the window's project", third.texts)
        press("Save", third.sheet)
        let closedAfterSave = await until(10) { saving.web == nil && !saving.window.isVisible }
        let afterClose = projectBytes(files[0])
        log(closedAfterSave && text(files[0]).contains("Saved on close") &&
            afterClose?.filter { $0.key != "Saved.waffle" } == savedBeforeClose.filter { $0.key != "Saved.waffle" },
            "Save writes the native manifest in place, preserves both owners and then closes", "closed=\(closedAfterSave)")

        // Don’t Save closes this window while its dedicated on-profile draft remains available.
        guard let discardedBytes = projectBytes(files[1]), let discarding = await openWindow(files[1]) else {
            log(false, "a third project window opens"); return finish()
        }
        let hd = Harness(discarding)
        guard await hd.writePrivateDraft("Discarded draft"), let fourth = await closePrompt(hd) else {
            log(false, "the third window shows the close sheet after writing its draft"); return finish()
        }
        press("Don’t Save", fourth.sheet)
        let closedUnsaved = await until(8) { discarding.web == nil && !discarding.window.isVisible }
        guard closedUnsaved, let reopened = await openWindow(files[1]) else {
            log(false, "Don’t Save closes the window and the saved folder reopens"); return finish()
        }
        let recovered = Harness(reopened)
        let offered = await recovered.waitForDraft("Discarded", of: files[1])
        let recoveredDraft = await recovered.restoreDraft("Discarded draft")
        log(offered && recoveredDraft && projectBytes(files[1]) == discardedBytes,
            "Don’t Save closes the window, preserves all project members and leaves a recoverable private edit")
        guard let inspection = await closePrompt(recovered) else {
            log(false, "the restored private edit still prompts on close"); return finish()
        }
        press("Don’t Save", inspection.sheet)
        guard await until(8, { reopened.web == nil && !reopened.window.isVisible }) else {
            log(false, "the restored private edit closes without a Save"); return finish()
        }

        // 5. Quitting with two unsaved windows: NSDocumentController's question first.
        guard let quitA = await openWindow(files[2]), let quitB = await openWindow(files[3]) else { log(false, "two quit windows open"); return finish() }
        let ha = Harness(quitA), hb = Harness(quitB)
        let bothEdited = await ha.editName("Quit A edit")
        let bothEdited2 = await hb.editName("Quit B edit")
        log(bothEdited && bothEdited2 && !d.needsSaveReview && quitA.needsSaveReview && quitB.needsSaveReview, "two windows have unsaved changes")
        var asked = ""
        var outcome: Bool?
        answerModal("Cancel") { asked = $0 }
        Desktop.reviewBeforeQuit { outcome = $0 }
        _ = await until(5) { outcome != nil }
        log(outcome == false && asked.contains("You have 2 documents with unsaved changes. Do you want to review these changes before quitting?")
            && asked.contains("If you don’t review your documents, all your changes will be lost.")
            && quitA.window.isDocumentEdited && quitB.window.isDocumentEdited && quitA.window.attachedSheet == nil && quitB.window.attachedSheet == nil,
            "quitting with two unsaved windows asks Review Changes… / Cancel / Discard Changes; Cancel quits nothing", asked)
        // Review Changes…: each window's sheet, front first. Save the first, Cancel the second: the quit stops.
        outcome = nil
        answerModal("Review Changes…")
        Desktop.reviewBeforeQuit { outcome = $0 }
        var asking: Desktop?
        _ = await until(5) { asking = [quitA, quitB].first { $0.window.attachedSheet != nil }; return asking != nil }
        let firstAsked = asking
        let front = NSApp.orderedWindows.first { $0.delegate is Desktop }
        log(firstAsked != nil && front === firstAsked?.window, "Review Changes… brings the first window forward with its sheet")
        press("Save", firstAsked?.window.attachedSheet)
        let other = firstAsked === quitA ? quitB : quitA
        let next = await until(10) { other.window.attachedSheet != nil }
        log(next && firstAsked?.window.isDocumentEdited == false, "Save during the quit saves that window, then the next window asks")
        press("Cancel", other.window.attachedSheet)
        _ = await until(5) { outcome != nil }
        log(outcome == false && other.window.isDocumentEdited && other.window.isVisible && other.needsSaveReview && firstAsked?.window.isVisible == true,
            "Cancel on a later window cancels the quit, its changes kept")
        // One unsaved window: its sheet straight away, no question first.
        outcome = nil
        Desktop.reviewBeforeQuit { outcome = $0 }
        let direct = await until(5) { other.window.attachedSheet != nil && NSApp.modalWindow == nil }
        press("Don’t Save", other.window.attachedSheet)
        _ = await until(5) { outcome != nil }
        log(direct && outcome == true && other.window.isVisible, "with one unsaved window the quit asks that window's sheet; Don’t Save lets it quit")

        // 6. Quit for real: Review Changes…, then Save in both windows. The app ends once both are saved;
        // run.sh checks the files. Nothing may print FAIL after RESULT.
        _ = await ha.editName("Quit final A")
        _ = await hb.editName("Quit final B")
        print("RESULT \(failures == 0 ? "ok" : "\(failures) failed")")
        fflush(stdout)
        let driver = Timer(timeInterval: 0.2, repeats: true) { _ in
            if let modal = NSApp.modalWindow, let review = findButton("Review Changes…", in: modal.contentView) { review.performClick(nil); return }
            for editor in [quitA, quitB] {
                if let sheet = editor.window?.attachedSheet, let save = findButton("Save", in: sheet.contentView) { save.performClick(nil) }
            }
        }
        RunLoop.main.add(driver, forMode: .common)
        let giveUp = Timer(timeInterval: 60, repeats: false) { _ in
            print("FAIL  quitting with two unsaved windows did not finish"); fflush(stdout); exit(1)
        }
        RunLoop.main.add(giveUp, forMode: .common)
        // As ⌘Q does: from the run loop, not from inside this main-actor task (a main-queue block,
        // which would hold the main queue for the whole quit).
        RunLoop.main.perform(inModes: [.default]) { NSApp.terminate(nil) }
    }

    func finish(close: Bool = false) {
        print("RESULT \(failures == 0 ? "ok" : "\(failures) failed")")
        fflush(stdout)
        if ["folder-drafts", "import-quit2", "updater"].contains(suite) || failures > 0 { exit(failures == 0 ? 0 : 1) }
        if close { d.window.performClose(nil) } else { NSApp.terminate(nil) }
        DispatchQueue.main.asyncAfter(deadline: .now() + 3) { exit(self.failures == 0 ? 0 : 1) }
    }
}

let application = NSApplication.shared
let desktop = Desktop()
application.delegate = desktop
if suite.hasPrefix("startup") { StartupFrames.applyAppearance(); StartupFrames.begin { desktop.window } }
application.setActivationPolicy(ProcessInfo.processInfo.environment["HARNESS_BACKGROUND"] == "1" ? .accessory : .regular)
DispatchQueue.main.asyncAfter(deadline: .now() + 0.5) { Task { @MainActor in await Harness(desktop).run() } }
application.run()
