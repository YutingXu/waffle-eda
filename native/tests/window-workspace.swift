import Cocoa
import WebKit

@MainActor final class WorkspaceProbe {
    static let store = WKWebsiteDataStore.nonPersistent()
    let authority = Desktop()
    let manifest: String

    init(manifest: String) { self.manifest = manifest }

    func run(_ view: WKWebView, _ code: String, _ args: [String:Any] = [:]) async throws -> Any? {
        try await withCheckedThrowingContinuation { next in
            view.callAsyncJavaScript(code, arguments:args, in:nil, in:.page) { next.resume(with:$0) }
        }
    }

    func until(_ label: String, _ test: () async -> Bool) async throws {
        for _ in 0..<320 {
            if await test() { return }
            try await Task.sleep(nanoseconds: 50_000_000)
        }
        throw NSError(domain:"Workspace probe",code:1,userInfo:[NSLocalizedDescriptionKey:label])
    }

    func check(_ ok: Bool, _ label: String) throws {
        if !ok { throw NSError(domain:"Workspace probe",code:1,userInfo:[NSLocalizedDescriptionKey:label]) }
    }

    func rendererPID(_ view: WKWebView) throws -> pid_t {
        let process = NSSelectorFromString("_webProcessIdentifier")
        try check(view.responds(to:process), "This WebKit does not expose its test renderer identity")
        typealias GetPID = @convention(c) (AnyObject, Selector) -> pid_t
        let pid = unsafeBitCast(view.method(for:process),to:GetPID.self)(view,process)
        try check(pid > 1 && pid != getpid(), "The fixture needs an isolated WebContent process")
        return pid
    }

    func launchWithHeldSnapshot(_ author: WKWebView) async throws -> WKWebView {
        let previous = Set(Desktop.workspaceFixtureMirrors.map(ObjectIdentifier.init))
        _ = try await run(author, """
            const client = AtriumProjectWindowClient, tab = AtriumNavHost.currentId();
            globalThis.workspaceHeldSnapshot = false;
            const wait = new Promise(resolve => {
                globalThis.releaseHeldSnapshot = () => {
                    globalThis.AtriumProjectWindowClient = client;
                    resolve();
                };
            });
            globalThis.AtriumProjectWindowClient = {...client, async serve(packet) {
                if (packet.operation === 'snapshot' && packet.value?.document === tab) {
                    globalThis.workspaceHeldSnapshot = true;
                    await wait;
                }
                return client.serve(packet);
            }};
            await client.openAuxiliary({kind:'presenter', documentId:tab, deckId:crypto.randomUUID()});
            return true;
            """)
        try await until("The auxiliary window did not request the held writer snapshot") {
            (try? await self.run(author, "return globalThis.workspaceHeldSnapshot")) as? Bool == true
        }
        guard let peer = Desktop.workspaceFixtureMirrors.first(where: { !previous.contains(ObjectIdentifier($0)) }) else {
            throw CocoaError(.fileReadUnknown)
        }
        try check(peer.window?.alphaValue == 0, "An auxiliary window awaiting its snapshot must stay hidden")
        return peer
    }

    func hasFailedLaunch(_ peer: WKWebView) -> Bool {
        peer.isHidden && peer.window?.alphaValue == 1 && peer.window?.attachedSheet != nil
    }

    func verify() async throws {
        try await until("AppKit did not create the editor window") { self.authority.workspaceFixtureView != nil }
        authority.application(NSApp, openFiles:[manifest])
        guard var author = authority.workspaceFixtureView else { throw CocoaError(.fileReadUnknown) }
        try await until("The project did not open through the normal macOS entry point") {
            (try? await self.run(author, "return !!globalThis.AtriumNavHost?.folderProject?.()")) as? Bool == true
        }
        let detachAt = Date()
        let baseline = try await run(author, """
            const h = AtriumNavHost;
            const initial = document.querySelector('[data-action="butter.windows.move-tab-to-new-window"]');
            AtriumPrefs.set('butter.windows', true);
            AtriumPrefs.set('general.autosave', false);
            const B = await AtriumLazy.need('AtriumButterEditor');
            AtriumPrefs.set('general.startPage', 'always');
            const client = await AtriumLazy.need('AtriumProjectWindowClient');
            const firstSnapshot = new Promise(resolve => {
                globalThis.releaseFirstSnapshot = () => {
                    globalThis.AtriumProjectWindowClient = client;
                    resolve();
                };
            });
            globalThis.AtriumProjectWindowClient = {...client, async serve(packet) {
                if (packet.operation === 'snapshot') {
                    globalThis.waitingForFirstSnapshot = true;
                    await firstSnapshot;
                }
                return client.serve(packet);
            }};
            const sheet = h.documentRefs().find(row => row.kind === 'schematic');
            const result = await B.apply('butter.windows.move-tab-to-new-window', {tab:sheet.id});
            return {document:sheet.id, initial:!!initial, count:result.result.layout.windows.length};
            """) as? [String:Any]
        try check(baseline?["initial"] as? Bool == false && baseline?["count"] as? Int == 2, "Default-off selection and the native detach command must agree")
        guard let document = baseline?["document"] as? String else { throw CocoaError(.fileReadCorruptFile) }

        try await until("The detached window did not request the writer's snapshot") {
            (try? await self.run(author, "return !!globalThis.waitingForFirstSnapshot")) as? Bool == true
        }
        guard let pending = Desktop.workspaceFixtureMirrors.first as? EditorWebView else { throw CocoaError(.fileReadUnknown) }
        let waitingForSnapshot = try await run(pending, """
            return AtriumPref.get('general.startPage') === 'always' && globalThis.__atriumOpeningProject === true &&
                AtriumNavHost.isStarter() && !document.querySelector('dialog[open]');
            """) as? Bool
        try check(waitingForSnapshot == true && pending.window?.alphaValue == 0,
                  "The detached window must stay hidden and skip Welcome until its project arrives")
        try check(pending.fingers.view === pending && pending.fingers.allowedTouchTypes == .direct &&
                  !pending.allowsMagnification && !pending.allowsBackForwardNavigationGestures && !pending.allowsLinkPreview,
                  "The detached native WebView must use direct touch and native navigation settings")
        try await Task.sleep(nanoseconds: 2_100_000_000)
        try check(pending.window?.alphaValue == 0, "A detached window must stay hidden past the ordinary launch fallback")
        guard let writerWindow = author.window else { throw CocoaError(.fileReadUnknown) }
        try check(authority.windowShouldClose(writerWindow), "A concealed peer must not retain the last visible writer on close")
        _ = try await run(author, "globalThis.releaseFirstSnapshot(); AtriumPrefs.set('general.startPage', 'auto'); return true;")
        try await until("No detached native WebView rendered the selected tab") {
            guard let mirror = Desktop.workspaceFixtureMirrors.first, mirror.window?.alphaValue == 1 else { return false }
            return (try? await self.run(mirror, """
                return globalThis.AtriumProjectWindowClient?.isMirror() && AtriumNavHost.currentId() === doc &&
                    !!AtriumNavHost.doc().items.length && typeof globalThis.__waffleDirectTouch === 'function' &&
                    !globalThis.__atriumOpeningProject && !document.querySelector('dialog[open]');
                """, ["doc":document])) as? Bool == true
        }
        print("The detached window stayed hidden past two seconds, then opened its project with direct touch enabled")
        try check(!authority.windowShouldClose(writerWindow) && !writerWindow.isVisible,
                  "A visible detached window must keep its writer available")
        writerWindow.orderFront(nil)
        let mirror = Desktop.workspaceFixtureMirrors[0]
        let detachMS = Date().timeIntervalSince(detachAt) * 1000
        try check(author !== mirror, "Detaching creates a separate native WebView")
        let dragging = try await run(author, """
            const h = AtriumNavHost, session = h.folderProject();
            await session.requireClosure({purpose:'project'});
            AtriumPrefs.set('pcb.rerouteOnDrag', false);
            const part = h.doc().items.find(item=>item.kind==='part' && !item.locked);
            const p = AtriumEditSelection.originOf(part), c = h.canvas(), box = c.getBoundingClientRect();
            const [x,y] = h.view().worldToScreen(p);
            h.select([part.id]);
            h.beginStickyMove(part,p);
            c.dispatchEvent(new PointerEvent('pointermove', {pointerType:'mouse', clientX:box.left+x+40, clientY:box.top+y+25}));
            return !!h.drag()?.before;
            """) as? Bool
        try check(dragging == true, "The writer must have an open drag and Undo mark")
        let editAt = Date()
        let input = try await run(mirror, """
            const h = AtriumNavHost;
            const item = h.doc().items.find(row => typeof row.text === 'string');
            if (!item) throw Error('The sample sheet needs one text item.');
            const old = item.text;
            h.edit(() => item.text = 'Shared window native edit', 'Edit shared text', [item]);
            return {item:item.id, old, mirrorGrant:!!h.folderProject()};
            """) as? [String:Any]
        try check(input?["mirrorGrant"] as? Bool == false, "The detached view must never receive a project writer grant")
        guard let item = input?["item"] as? String, let old = input?["old"] as? String else { throw CocoaError(.fileReadCorruptFile) }
        func matches(_ view: WKWebView, _ expected: String) async -> Bool {
            (try? await run(view, "return AtriumNavHost.docById(doc)?.items.find(row => row.id === item)?.text === expected", ["doc":document,"item":item,"expected":expected])) as? Bool == true
        }
        try await until("The detached edit did not reach the writer while its gesture was active") {
            (try? await self.run(author, "return !!AtriumNavHost.folderProject().localState.workspacePending")) as? Bool == true
        }
        try await Task.sleep(nanoseconds: 150_000_000)
        let waiting = await matches(author,old)
        try check(waiting, "A detached edit must wait for the writer's drag to finish")
        _ = try await run(author, "AtriumNavHost.executeKey('escape'); return true;")
        try await until("The native writer did not receive and rebroadcast the detached edit") {
            let reachesAuthor = await matches(author,"Shared window native edit")
            return reachesAuthor ? await matches(mirror,"Shared window native edit") : false
        }
        try await until("The detached edit was acknowledged without a recovery checkpoint") {
            (try? await self.run(author, """
                const session = AtriumNavHost.folderProject();
                return !AtriumPrefs.get('general.autosave') && session.draftMetrics().writes > 0 &&
                  session.localState.workspaceEditReceipt?.dirty && !session.localState.workspacePending;
                """)) as? Bool == true
        }
        let editMS = Date().timeIntervalSince(editAt) * 1000
        _ = try await run(mirror, "AtriumNavHost.select([item]); return true;", ["item":item])
        let distinct = try await run(author, "return AtriumNavHost.currentId() !== doc && !AtriumNavHost.selection().includes(item);", ["doc":document,"item":item]) as? Bool
        try check(distinct == true, "A detached tab selection must leave the writer’s separate document selection alone")
        _ = try await run(mirror, "AtriumNavHost.select([]); return true;")
        let probed = try await run(author, "const C=await AtriumLazy.need('AtriumCrossProbe'); return C.go({docId:doc,ids:[item],label:'Workspace probe'},true)",
                                   ["doc":document,"item":item]) as? Bool
        try check(probed == true, "The regular cross-probe path must accept a detached target")
        try await until("Cross-probe did not select the target in its owning window") {
            (try? await self.run(mirror,"return AtriumNavHost.selection().includes(item)",["item":item])) as? Bool == true
        }
        _ = try await run(mirror, "return await AtriumNavHost.historyGo(-1)")
        try await until("The detached Undo did not change the writer's history") { await matches(author,old) }
        _ = try await run(mirror, "return await AtriumNavHost.historyGo(1)")
        try await until("The detached Redo did not change the writer's history") { await matches(author,"Shared window native edit") }
        guard let revision = try await run(author,"return AtriumNavHost.authoredRevision()") as? Int else { throw CocoaError(.fileReadCorruptFile) }
        let races = try await run(mirror, """
            const C = AtriumProjectWindowClient;
            const request = text => ({id:crypto.randomUUID(),document:doc,revision,ops:[
                {op:'set',target:'item',document:doc,id:item,path:['text'],before:'Shared window native edit',after:text}
            ]});
            const first=request('First native contender');
            const second=request('Second native contender');
            const entries=await Promise.allSettled([C.forward('edit',first),C.forward('edit',second)]);
            if (entries[0].status!=='fulfilled' || entries[1].status!=='rejected') return false;
            const repeat=await C.forward('edit',first);
            return repeat.id===first.id && repeat.revision===entries[0].value.revision;
            """,["revision":revision,"doc":document,"item":item]) as? Bool
        try check(races == true, "Concurrent detached requests must reject a stale revision and acknowledge a duplicate once")
        _ = try await run(mirror, "return await AtriumNavHost.historyGo(-1)")
        try await until("The duplicate delivery added an extra Undo step") { await matches(author,"Shared window native edit") }
        let board = try await run(author, """
            const h = AtriumNavHost, board = h.doc();
            h.edit(()=>{board.grid += .1;}, 'Change writer board grid');
            return h.folderProject().modified(board.id) ? board.id : null;
            """) as? String
        try check(board != nil, "The writer needs a second dirty document for Save All")
        let saved = try await run(mirror, """
            const h = AtriumNavHost, lazy = globalThis.AtriumLazy;
            await AtriumProjectWindowClient.receive({type:'view',tab:doc});
            let release;
            const load = new Promise(resolve=>{release=resolve;});
            const field = document.createElement('input');
            field.addEventListener('blur',()=>{
              const row = h.doc().items.find(row=>row.id===item);
              h.edit(()=>{row.text='Detached focus commit';},'Commit the focused field',[row]);
            },{once:true});
            document.body.append(field);
            field.focus();
            globalThis.AtriumLazy = {...lazy,need:(name,...args)=>name==='AtriumProposal' ?
              load.then(()=>lazy.need(name,...args)) : lazy.need(name,...args)};
            try {
              setTimeout(release,90);
              return await h.saveAll();
            } finally {globalThis.AtriumLazy=lazy;field.remove();}
            """, ["item":item, "doc":document]) as? Bool
        let committed = try await run(author, """
            const h = AtriumNavHost, session = h.folderProject();
            return !session.modified(board) && !session.modified(doc) &&
              h.docById(doc).items.find(row=>row.id===item)?.text==='Detached focus commit';
            """, ["board":board ?? "", "doc":document, "item":item]) as? Bool
        try check(saved == true && committed == true, "Detached Save All must commit the focused edit before saving both documents")
        let named = try await run(author, """
            const b = await AtriumLazy.need('AtriumButterEditor');
            const save = await b.apply('butter.windows.save-workspace-layout', {name:'Native review'});
            const list = await AtriumButter.run('butter.windows.list-workspace-layouts');
            return save.result.layout.windows.every(w=>w.bounds?.width>0 && w.bounds.height>0) && list.result.layouts.includes('Native review');
            """) as? Bool
        try check(named == true, "Named native layouts preserve actual per-window bounds")
        let splits = try await run(author, """
            const h = AtriumNavHost, b = await AtriumLazy.need('AtriumButterEditor');
            await h.openSplit('down',h.currentId(),{ratio:.31});
            await b.apply('butter.windows.save-workspace-layout', {name:'Split layout'});
            await h.openSplit('right',h.currentId(),{ratio:.65});
            await b.apply('butter.windows.restore-workspace-layout', {name:'Split layout'});
            const restored = h.captureWorkspaceSplit();
            await b.apply('butter.windows.restore-workspace-layout', {name:'Native review'});
            return restored?.direction==='down' && restored.ratio===.31 && !h.captureWorkspaceSplit();
            """) as? Bool
        try check(splits == true, "Named layouts restore the saved split ratio and close an omitted split")
        let acknowledged = try await run(mirror, """
            const h = AtriumNavHost, client = AtriumProjectWindowClient;
            await client.receive({type:'view',tab:doc});
            const before = h.project(), after = client.copyProject(before);
            after.documents.find(row=>row.id===doc).items.find(row=>row.id===item).text='Acknowledged before writer crash';
            const receipt = await client.submit(before,after,'Edit before crash');
            return receipt?.dirty === true;
            """, ["doc":document,"item":item]) as? Bool
        try check(acknowledged == true, "The detached editor must receive a dirty receipt before the crash")
        _ = try await run(author, """
            const h=AtriumNavHost, session=h.folderProject();
            await session.setView({workspacePending:{id:crypto.randomUUID(),document:doc,revision:h.authoredRevision(),label:'Recover shared edit',ops:[
              {op:'set',target:'item',document:doc,id:item,path:['text'],before:'Acknowledged before writer crash',after:'Replayed project window edit'}
            ]}}, {strict:true});
            return true;
            """, ["doc":document,"item":item])
        let pid = try rendererPID(author)
        let replayAt = Date()
        try check(Darwin.kill(pid,SIGKILL) == 0, "Could not interrupt the isolated writer WebContent process")
        let previous = author
        do {
            try await until("The acknowledged unsaved edit did not appear in recovery after the writer crashed") {
                guard let recovered = self.authority.workspaceFixtureView, recovered !== previous else { return false }
                return (try? await self.run(recovered, """
                    const button = [...document.querySelectorAll('dialog[open] button')].find(b=>b.textContent==='Restore Draft');
                    if (!button) return false;
                    button.click();
                    return true;
                    """)) as? Bool == true
            }
            try await until("AppKit did not restore the shared window and its interrupted write") {
                guard let recovered = self.authority.workspaceFixtureView, recovered !== previous else { return false }
                return await matches(recovered,"Replayed project window edit")
            }
        } catch {
            if let view = authority.workspaceFixtureView {
                if let context = try? await run(view, """
                    const h=globalThis.AtriumNavHost, f=h?.folderProject?.();
                    return {folder:!!f, ready:!!f?.workspaceRecoveryReady, pending:!!f?.localState.workspacePending,
                      windows:!!globalThis.AtriumProjectWindowClient, flag:globalThis.AtriumPrefs?.get('butter.windows'),
                      status:document.getElementById('status')?.textContent, dialogs:[...document.querySelectorAll('dialog[open]')].map(d=>d.getAttribute('aria-label'))};
                    """) { fputs("Workspace recovery state: \(context)\n", stderr) }
            }
            throw error
        }
        guard let recovered = authority.workspaceFixtureView else { throw CocoaError(.fileReadUnknown) }
        author = recovered
        try await until("The second native window did not reconnect to the recovered writer") {
            guard let peer = Desktop.workspaceFixtureMirrors.first else { return false }
            return await matches(peer,"Replayed project window edit")
        }
        let replayMS = Date().timeIntervalSince(replayAt) * 1000
        _ = try await run(author, "return await AtriumNavHost.saveAll()")
        _ = try await run(author, """
            globalThis.testPresenter=await AtriumProjectWindowClient.openAuxiliary({kind:'presenter',documentId:doc,deckId:'window-suite-deck'});
            await testPresenter.update({elapsedMs:125,current:{id:'slide-1'},next:{id:'slide-2'},notes:'workspace witness'});
            return true;
            """, ["doc":document])
        try await until("Presenter state did not reach its own auxiliary WebView") {
            guard Desktop.workspaceFixtureMirrors.count == 2 else { return false }
            for peer in Desktop.workspaceFixtureMirrors {
                if (try? await self.run(peer,"return globalThis.AtriumProjectWindowClient?.presenter()?.elapsedMs === 125")) as? Bool == true { return true }
            }
            return false
        }
        _ = try await run(author,"await testPresenter.close(); await testPresenter.close(); return true;")
        let merged = try await run(author, """
            const b = await AtriumLazy.need('AtriumButterEditor');
            return (await b.apply('butter.windows.merge-all-windows', {})).result.layout.windows.length;
            """) as? Int
        try check(merged == 1 && Desktop.workspaceFixtureMirrors.isEmpty, "Merge closes the detached native window")
        let restored = try await run(author, """
            const b = await AtriumLazy.need('AtriumButterEditor');
            await b.apply('butter.windows.restore-workspace-layout', {name:'Native review'});
            return (await AtriumButter.run('butter.windows.list-windows')).result.layout.windows.length;
            """) as? Int
        try check(restored == 2 && Desktop.workspaceFixtureMirrors.count == 1, "Restoring a named layout creates its native peer again")
        let panel = try await run(author, """
            const h = AtriumNavHost, panels = await AtriumLazy.need('AtriumPanel');
            const assembly = panels.create(h.project(),{rows:1,cols:1});
            h.edit(()=>h.project().documents.push(assembly),'Add assembly panel');
            const b = await AtriumLazy.need('AtriumButterEditor');
            await b.apply('butter.windows.move-tab-to-new-window',{tab:assembly.id});
            return assembly.id;
            """) as? String
        guard let panel = panel else { throw CocoaError(.fileReadCorruptFile) }
        try await until("The detached panel lost its source board") {
            for peer in Desktop.workspaceFixtureMirrors {
                let populated = try? await self.run(peer, """
                    const h = AtriumNavHost;
                    if (h.currentId()!==panel) return false;
                    const panels=await AtriumLazy.need('AtriumPanel'), source=h.doc().panel.board;
                    return h.docById(source)?.kind==='pcb' && panels.layout(h.project(),h.doc(),h.defs()).instances.length===1 &&
                        AtriumProjectWindowClient.visibleTabs(h.documentRefs()).every(row=>row.id===panel);
                    """, ["panel":panel]) as? Bool
                if populated == true { return true }
            }
            return false
        }
        let storedBytes = try await run(author, """
            return new TextEncoder().encode(JSON.stringify(AtriumNavHost.folderProject().localState.projectWindows)).length;
            """) as? Int
        try check(storedBytes.map { $0 > 0 } == true, "The ignored workspace record must contain the saved layout")

        let timedOut = try await launchWithHeldSnapshot(author)
        try await until("A timed-out auxiliary window should offer to close without exposing the starter") { self.hasFailedLaunch(timedOut) }
        if let window = timedOut.window, let sheet = window.attachedSheet { window.endSheet(sheet) }
        try await until("Closing the launch failure should dismiss the auxiliary window") { timedOut.window == nil }
        _ = try await run(author, "globalThis.releaseHeldSnapshot(); return true;")
        let savedAfterTimeout = try await run(author, "return await AtriumNavHost.saveAll()") as? Bool
        try check(savedAfterTimeout == true, "A failed auxiliary launch must leave the writer able to save")
        print("A stalled peer offered to close with no editor exposed, and the working writer still saved")

        // Hold a forwarding call in the replacement writer. The native fatal sheet remains open
        // while a surviving peer observes the request result and the writer-loss event.
        guard let peer = Desktop.workspaceFixtureMirrors.first else { throw CocoaError(.fileReadUnknown) }
        let interrupted = try await launchWithHeldSnapshot(author)
        _ = try await run(author, """
            const client = AtriumProjectWindowClient;
            globalThis.AtriumProjectWindowClient = {...client, serve(packet) {
              if (packet.value?.kind!=='save') return client.serve(packet);
              globalThis.workspaceHeldSave = true;
              return new Promise(()=>{});
            }};
            return true;
            """)
        _ = try await run(peer, """
            const receive = window.__waffleWorkspaceEvent;
            window.workspaceLossEvents = 0;
            window.__waffleWorkspaceEvent = event=>{
              if(event.type==='writer-unavailable') window.workspaceLossEvents++;
              return receive(event);
            };
            AtriumHost.workspaceWindow({operation:'command',value:{kind:'save'}}).then(
              ()=>{window.workspaceLostSave='fulfilled';},error=>{window.workspaceLostSave=error.message;});
            return true;
            """)
        try await until("The forwarding call did not reach the writer before its failure") {
            (try? await self.run(author,"return !!globalThis.workspaceHeldSave")) as? Bool == true
        }
        let writerPID = try rendererPID(author), peerPID = try rendererPID(peer)
        try check(writerPID != peerPID, "The workspace failure probe needs a surviving detached process")
        try check(Darwin.kill(writerPID,SIGTERM) == 0, "Could not terminate the restarted writer WebContent process")
        try await until("The second renderer termination did not show its native crash sheet") { self.authority.workspaceFixtureCrashSheet }
        try await until("The in-flight Save did not terminate while the crash sheet was still open") {
            (try? await self.run(peer,"return typeof window.workspaceLostSave==='string' && window.workspaceLostSave!=='fulfilled'")) as? Bool == true
        }
        try await until("A surviving peer was not notified of writer loss while the fatal sheet was open") {
            guard self.authority.workspaceFixtureCrashSheet else { return false }
            return (try? await self.run(peer,"return window.workspaceLossEvents")) as? Int == 1
        }
        try await until("Writer loss during detach should show the launch failure with the starter hidden") { self.hasFailedLaunch(interrupted) }
        print("Pending Save rejected and the live peer received writer loss before the macOS crash sheet closed")
        print(String(format:"Fixture observation upper bounds in ms: detach %.1f, edit replication %.1f, writer replay %.1f",detachMS,editMS,replayMS))
        print("Local workspace record: \(storedBytes ?? 0) bytes")
        print("macOS project windows passed selection, cross-probe, edit/Undo/Redo/Save All, writer crash recovery, named splits and detached panels")
    }
}

let app = NSApplication.shared
app.setActivationPolicy(.accessory)
MainActor.assumeIsolated {
    let harness = WorkspaceProbe(manifest:CommandLine.arguments[1])
    app.delegate = harness.authority
    Task { @MainActor in
        do { try await harness.verify(); exit(0) }
        catch { fputs("\(error)\n",stderr); exit(1) }
    }
}
app.run()
