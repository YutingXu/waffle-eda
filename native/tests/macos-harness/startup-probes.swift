import Cocoa

// Launch frames (startup.sh): what the window server shows of the editor window from process start until the
// launch settles (the start page, or the project reopened at launch). A background thread polls the window server every few milliseconds; whenever the window is
// on screen with a non-zero alpha it captures the window (our own window needs no Screen Recording permission)
// and keeps the frame when its 96 x 60 thumbnail differs from the previous one. The checks: the first visible
// frame already equals the settled page (no bare background, no workbench chrome, no theme switch), and
// the start page's backdrop is the theme's --app colour. HARNESS_APPEARANCE=light|dark sets the app's appearance.
enum StartupFrames {
    struct Frame { let ms: Double; let image: CGImage; let thumb: [UInt8] }
    static let thumbW = 96, thumbH = 60
    private static let lock = NSLock()
    private static var frames: [Frame] = []
    private static var firstVisibleMs: Double?
    private static var stop = false

    /// Milliseconds since this process started (kinfo_proc), so times include dyld and AppKit start-up.
    static func sinceProcessStart() -> Double {
        var info = kinfo_proc(), size = MemoryLayout<kinfo_proc>.stride
        var mib: [Int32] = [CTL_KERN, KERN_PROC, KERN_PROC_PID, getpid()]
        guard sysctl(&mib, 4, &info, &size, nil, 0) == 0 else { return 0 }
        let start = info.kp_proc.p_un.__p_starttime
        var now = timeval(); gettimeofday(&now, nil)
        return Double(now.tv_sec - start.tv_sec) * 1000 + Double(now.tv_usec - start.tv_usec) / 1000
    }

    static func applyAppearance() {
        switch ProcessInfo.processInfo.environment["HARNESS_APPEARANCE"] {
        case "light": NSApp.appearance = NSAppearance(named: .aqua)
        case "dark": NSApp.appearance = NSAppearance(named: .darkAqua)
        default: break
        }
    }

    private typealias Capture = @convention(c) (CGRect, UInt32, UInt32, UInt32) -> Unmanaged<CGImage>?
    private static let capture: Capture? = dlsym(UnsafeMutableRawPointer(bitPattern: -2), "CGWindowListCreateImage")
        .map { unsafeBitCast($0, to: Capture.self) }

    static func windowImage(_ id: CGWindowID, bestResolution: Bool = false) -> CGImage? {
        let flags: UInt32 = bestResolution ? 1 | 8 : 1 // boundsIgnoreFraming, bestResolution
        return capture?(.null, 1 << 3 /* optionIncludingWindow */, id, flags)?.takeRetainedValue()
    }

    static func thumbnail(_ image: CGImage) -> [UInt8] {
        var pixels = [UInt8](repeating: 0, count: thumbW * thumbH * 4)
        pixels.withUnsafeMutableBytes { buffer in
            guard let context = CGContext(data: buffer.baseAddress, width: thumbW, height: thumbH, bitsPerComponent: 8,
                                          bytesPerRow: thumbW * 4, space: CGColorSpace(name: CGColorSpace.sRGB)!,
                                          bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue) else { return }
            context.interpolationQuality = .medium
            context.draw(image, in: CGRect(x: 0, y: 0, width: thumbW, height: thumbH))
        }
        return pixels
    }

    /// Share of thumbnail pixels whose colour differs by more than 24 levels in any channel.
    static func difference(_ a: [UInt8], _ b: [UInt8]) -> Double {
        var changed = 0
        for i in stride(from: 0, to: min(a.count, b.count), by: 4) {
            if abs(Int(a[i]) - Int(b[i])) > 24 || abs(Int(a[i+1]) - Int(b[i+1])) > 24 || abs(Int(a[i+2]) - Int(b[i+2])) > 24 { changed += 1 }
        }
        return Double(changed) / Double(thumbW * thumbH)
    }

    /// At the fixture's default dock layout, this crop covers the Properties content below its title.
    static func propertiesInk(_ thumb: [UInt8]) -> Int {
        let levels = (8..<26).flatMap { row in (79..<94).map { col in Int(thumb[(row * thumbW + col) * 4]) } }
        let background = levels.sorted()[levels.count / 2]
        return levels.filter { abs($0 - background) > 10 }.count
    }

    static func copperInk(_ thumb: [UInt8]) -> Int {
        let offsets = (13..<48).flatMap { row in (23..<70).map { col in (row * thumbW + col) * 4 } }
        return offsets.filter { Int(thumb[$0]) - Int(max(thumb[$0+1], thumb[$0+2])) > 24 }.count
    }

    /// Starts polling once the Desktop has its window. Runs before the delegate's applicationDidFinishLaunching.
    static func begin(_ window: @escaping () -> NSWindow?) {
        let timer = Timer(timeInterval: 0.002, repeats: true) { timer in
            guard let w = window(), w.windowNumber > 0 else { return }
            timer.invalidate()
            let id = CGWindowID(w.windowNumber)
            Thread.detachNewThread { poll(id) }
        }
        RunLoop.main.add(timer, forMode: .common)
    }

    private static func poll(_ id: CGWindowID) {
        var last: [UInt8]? = nil
        let deadline = Date().addingTimeInterval(30)
        while Date() < deadline {
            lock.lock(); let done = stop; lock.unlock()
            if done { return }
            let info = (CGWindowListCopyWindowInfo([.optionIncludingWindow], id) as? [[String: Any]])?.first
            let onscreen = info?[kCGWindowIsOnscreen as String] as? Bool == true
            let alpha = (info?[kCGWindowAlpha as String] as? NSNumber)?.doubleValue ?? 0
            if onscreen && alpha > 0, let capture = capture,
               let image = capture(.null, 1 << 3 /* optionIncludingWindow */, id, 1 /* boundsIgnoreFraming */)?.takeRetainedValue(),
               image.width > 0 {
                let ms = sinceProcessStart(), thumb = thumbnail(image)
                lock.lock()
                if firstVisibleMs == nil { firstVisibleMs = ms }
                if last == nil || difference(last!, thumb) > 0.002 { frames.append(Frame(ms: ms, image: image, thumb: thumb)); last = thumb }
                lock.unlock()
            }
            usleep(4000)
        }
    }

    static func finish() -> (frames: [Frame], firstVisibleMs: Double?) {
        lock.lock(); defer { lock.unlock() }
        stop = true
        return (frames, firstVisibleMs)
    }

    static func save(_ image: CGImage, to url: URL) {
        if let png = NSBitmapImageRep(cgImage: image).representation(using: .png, properties: [:]) { try? png.write(to: url) }
    }
}

extension Harness {
    /// HARNESS_SUITE=startup-seed: a project in the browser recovery store, closed cleanly, so the next launch
    /// (startup-reopen, same work folder and WebKit store) reopens it instead of showing the start page.
    func startupSeed() async {
        _ = await until(20) { await self.truthy("return !!document.querySelector('dialog.sp-dialog[open]')") }
        if ProcessInfo.processInfo.environment["HARNESS_START_PAGE_NEVER"] == "1" {
            _ = await js("AtriumPrefs.set('general.startPage', 'never'); return true")
        }
        let target = ProcessInfo.processInfo.environment["HARNESS_STARTUP_TARGET"] ?? "board"
        let saved = await js("""
            AtriumStartPage.close();
            const p = Atrium.project('Reopened at launch', AtriumParts.catalogue);
            const board = p.documents.find(doc => doc.kind === 'pcb');
            board.outline = [[0,0], [0,46], [60,46], [60,0]];
            for (const y of [4,12,20,28,36]) {
                board.items.push({id:Atrium.id(), kind:'track', layer:'Top', width:2, points:[[4,y],[56,y]]});
            }
            const target = '\(target)';
            if (target === 'sheet') {
                const sheet = p.documents.find(doc => doc.kind === 'schematic');
                p.documents = [sheet];
                for (const y of [30,50,70,90,110]) {
                    sheet.items.push({id:Atrium.id(), kind:'wire', width:1.5, points:[[30,y],[240,y]]});
                }
            }
            if (!await AtriumNavHost.replaceProject(p, {force: true, dirty: false})) return 'not replaced';
            if (target === 'prompt') AtriumNavHost.markUnsaved();

            if (!await AtriumAutosave.save('manual', true)) return 'not saved';
            // As a clean quit records it (WebKit does not fire pagehide when the app terminates).
            dispatchEvent(new Event('pagehide'));
            return AtriumNavHost.isDirty?.() === (target === 'prompt') ? 'saved' : 'unexpected dirty state'
            """)
        d.window.isDocumentEdited = false
        log(saved as? String == "saved", "a project is in the recovery store", saved)
    }

    /// HARNESS_SUITE=startup: launch frames until the start page settles (startup.sh).
    func startupFrames() async {
        let appearance = ProcessInfo.processInfo.environment["HARNESS_APPEARANCE"] ?? "system"
        let target = ProcessInfo.processInfo.environment["HARNESS_STARTUP_TARGET"] ?? "board"
        if target == "prompt" {
            let shown = await until(20) { await self.truthy("return !!document.querySelector('dialog.recover-dialog[open]')") }
            log(shown, "the recovery prompt is the launch surface (\(appearance))")
        } else if suite == "startup-reopen" {
            let reopened = await until(20) { await self.truthy("""
                const host = globalThis.AtriumNavHost;
                return host?.isStarter?.() === false && host.project()?.name === 'Reopened at launch' &&
                    host.doc().items.filter(item => item.kind === '\(target == "sheet" ? "wire" : "track")').length === 5;
                """) }
            log(reopened, "the last project reopens at launch (\(appearance))")
            if ProcessInfo.processInfo.environment["HARNESS_START_PAGE_NEVER"] == "1" {
                let disabled = await truthy("return AtriumPref.get('general.startPage') === 'never' && !document.querySelector('dialog.sp-dialog[open]')")
                log(disabled, "Welcome stays closed on launch when disabled (\(appearance))")
            }
        } else {
            let shown = await until(20) { await self.truthy("return !!document.querySelector('dialog.sp-dialog[open]')") }
            log(shown, "start page opens at launch (\(appearance))")
        }
        // Let late paints (recent-project thumbnails, focus) land, then stop and judge.
        try? await Task.sleep(nanoseconds: 1_500_000_000)
        let theme = await js("return document.documentElement.dataset.theme || ''") as? String ?? ""
        let renderer = await js("return JSON.stringify(window.__waffleStartupReport?.())")
        note("STARTUP_WEB " + (renderer as? String ?? "unavailable"))
        let (frames, firstVisible) = StartupFrames.finish()
        let dir = work.appendingPathComponent("shots")
        for (i, f) in frames.enumerated() {
            StartupFrames.save(f.image, to: dir.appendingPathComponent(String(format: "startup-%@-%02d-%05.0fms.png", appearance, i, f.ms)))
        }
        guard let first = frames.first, let final = frames.last else { log(false, "the window became visible"); return }
        let timeline = frames.map { String(format: "%.0fms Δfinal %.1f%%", $0.ms, 100 * StartupFrames.difference($0.thumb, final.thumb)) }
        note("STARTUP \(appearance): window visible \(String(format: "%.0f", firstVisible ?? -1)) ms after process start; " +
             "\(frames.count) distinct frames (ms after process start, share of pixels unlike the last): " + timeline.joined(separator: ", "))
        // A frame differs by over 3 % from the settled page: the bare window, the empty workbench or another theme.
        let flashes = frames.dropLast().filter { StartupFrames.difference($0.thumb, final.thumb) > 0.03 }
        log(flashes.isEmpty, "the first visible frame is the settled launch page (\(appearance))",
            flashes.isEmpty ? nil : flashes.map { String(format: "%.0fms differs %.0f%%", $0.ms, 100 * StartupFrames.difference($0.thumb, final.thumb)) }.joined(separator: ", "))
        if suite == "startup-reopen" && target != "prompt" {
            let ink = StartupFrames.propertiesInk(first.thumb)
            log(ink >= 24, "the reopened project's Properties content is in the first frame (\(appearance))", "\(ink) contrasted pixels")
            if target == "sheet" {
                let firstRegion = first.thumb, finalRegion = final.thumb
                let matches = StartupFrames.difference(firstRegion, finalRegion) < 0.03
                log(matches, "the first schematic frame matches the settled canvas (\(appearance))")
            } else {
                let copper = StartupFrames.copperInk(first.thumb)
                log(copper >= 24, "the reopened project's copper is in the first frame (\(appearance))", "\(copper) copper pixels")
            }
        }
        // Start page: the top-left corner below the caption is its launch backdrop: the theme's --app colour.
        let t = first.thumb, i = (StartupFrames.thumbH / 6 * StartupFrames.thumbW + 1) * 4
        let expected: (Int, Int, Int) = theme == "light" ? (0xe6, 0xe6, 0xe6) : (0x1d, 0x1d, 0x1d)
        let near = abs(Int(t[i]) - expected.0) < 12 && abs(Int(t[i+1]) - expected.1) < 12 && abs(Int(t[i+2]) - expected.2) < 12
        if suite == "startup" { log(near, "the first frame's backdrop is the \(theme) theme's --app colour", "rgb(\(t[i]),\(t[i+1]),\(t[i+2]))") }
        if appearance != "system" {
            log(theme == appearance, "the page follows the system appearance", "data-theme=\(theme)")
        }
    }
}
