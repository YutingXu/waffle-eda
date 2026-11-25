import Cocoa
import WebKit

@MainActor final class WorkspaceProbe {
    static let store = WKWebsiteDataStore.nonPersistent()
    let authority = Desktop()
    let manifest = CommandLine.arguments[1]

    func run(_ view: WKWebView, _ code: String) async throws -> Any? {
        try await withCheckedThrowingContinuation { next in
            view.callAsyncJavaScript(code, arguments:[:], in:nil, in:.page) { next.resume(with:$0) }
        }
    }

    func until(_ label: String, _ check: () async -> Bool) async throws {
        for _ in 0..<240 {
            if await check() { return }
            try await Task.sleep(nanoseconds:50_000_000)
        }
        throw NSError(domain:"Slide presenter",code:1,userInfo:[NSLocalizedDescriptionKey:label])
    }

    func verify() async throws {
        try await until("AppKit did not create the authoring window") { self.authority.workspaceFixtureView != nil }
        authority.application(NSApp,openFiles:[manifest])
        guard let writer = authority.workspaceFixtureView else { throw CocoaError(.fileReadUnknown) }
        try await until("Native writer did not admit the slide fixture") {
            (try? await self.run(writer,"return AtriumNavHost.folderProject() && AtriumNavHost.project().slides?.length === 3;")) as? Bool == true
        }
        let startedAt = Date()
        let started = try await run(writer, """
            const h = AtriumNavHost;
            AtriumPrefs.set('butter.windows',true); AtriumPrefs.set('butter.slides',true);
            const B = await AtriumLazy.need('AtriumButterEditor');
            const sensor = h.documentRefs().find(row => row.name === 'Sensor');
            await h.selectDocument(sensor.id);
            h.view().restoreCamera({...h.view().camera(),cx:12.125,cy:17.25,scale:8});
            globalThis.fixturePrior = h.captureViewState();
            const result = (await B.apply('butter.slides.start',{presenter:true})).result;
            if (result.presenterWindow?.status !== 'open') throw Error(JSON.stringify(result.presenterWindow));
            return result.index === 0 && h.doc().name === 'Top';
            """) as? Bool
        if started != true { throw CocoaError(.validationMissingMandatoryProperty) }
        try await until("The first slide did not reach its own native presenter WebView") {
            guard let peer = Desktop.workspaceFixtureMirrors.first, peer !== writer else { return false }
            let first = await self.projection(peer, index:0, notes:"Begin on SENSE.", next:true)
            return first
        }
        let provision = Date().timeIntervalSince(startedAt) * 1000
        let next = try await run(writer, """
            const r = (await AtriumButterEditor.apply('butter.slides.step',{direction:1})).result;
            return r.index === 1 && r.presenterWindow.status === 'open' && AtriumNavHost.doc().name === 'Sensor';
            """) as? Bool
        if next != true { throw CocoaError(.validationMissingMandatoryProperty) }
        try await until("Presenter snapshot failed to follow a cross-document step") {
            guard let peer = Desktop.workspaceFixtureMirrors.first else { return false }
            return await self.projection(peer,index:1,notes:"Walk through the linked input.",next:true)
        }
        let stopped = try await run(writer, """
            const r = (await AtriumButterEditor.apply('butter.slides.stop',{})).result;
            const camera = AtriumNavHost.captureViewState();
            return r.status === 'stopped' && r.restoredDocumentId === fixturePrior.documentId &&
              camera.camera.cx === fixturePrior.camera.cx && camera.camera.cy === fixturePrior.camera.cy;
            """) as? Bool
        if stopped != true { throw CocoaError(.validationMissingMandatoryProperty) }
        try await until("Stopping the deck did not close the native presenter window") { Desktop.workspaceFixtureMirrors.isEmpty }
        print(String(format:"Native presenter first snapshot within %.1f ms",provision))
        print("AppKit presenter creation, camera return, snapshot update and closure passed")
    }

    func projection(_ peer: WKWebView, index: Int, notes: String, next: Bool) async -> Bool {
        let outcome = try? await run(peer, """
            const model = globalThis.AtriumProjectWindowClient?.presenter();
            return model ? {index:model.index, notes:model.notes, next:!!model.next, elapsed:model.elapsedMs,
              measured:model.measuredAtUnixMs, hasGrant:!!AtriumNavHost.folderProject()} : null;
            """)
        guard let value = outcome as? [String:Any] else { return false }
        return value["index"] as? Int == index && (value["notes"] as? String)?.contains(notes) == true &&
            value["next"] as? Bool == next && (value["elapsed"] as? Double ?? -1) >= 0 &&
            (value["measured"] as? Double ?? -1) > 0 && value["hasGrant"] as? Bool == false
    }
}

let app = NSApplication.shared
app.setActivationPolicy(.accessory)
MainActor.assumeIsolated {
    let harness = WorkspaceProbe()
    app.delegate = harness.authority
    Task { @MainActor in
        do { try await harness.verify(); exit(0) }
        catch { fputs("\(error)\n",stderr); exit(1) }
    }
}
app.run()
