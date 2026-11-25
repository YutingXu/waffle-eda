import Cocoa

extension Harness {
    func folderGitHistory() async {
        let env = ProcessInfo.processInfo.environment
        guard let manifest = env["HARNESS_GIT_MANIFEST"], let merge = env["HARNESS_GIT_MERGE"] else {
            log(false,"prepare the synthetic folder Git tree"); return
        }
        d.application(NSApp,openFiles:[manifest])
        let opened = await until(15) { await self.truthy("return !!AtriumHost.folderGitGrant && AtriumNavHost.project().id === 'p1'") }
        guard opened else { log(false,"Finder opens the verified folder and binds Git"); return }
        let screen = UIProbes(self)
        screen.setOcclusionDetection(false)
        defer { screen.setOcclusionDetection(true) }
        d.window.orderOut(nil); d.window.orderFrontRegardless(); d.window.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps:true)
        _ = await js("AtriumStartPage.close(); AtriumPower.host({occluded:false}); return true")
        let args = ["merge":merge]
        let query = await truthy("""
            const list = await AtriumHost.gitQuery('projectLog',{limit:20});
            const item = await AtriumHost.gitQuery('folderRevisions',{revisions:[merge]});
            let refused = false;
            try { await AtriumHost.gitQuery('installMergeDriver',{confirm:true,plan:'unapproved'}); } catch { refused = true; }
            return list.commits.find(c=>c.revision===merge)?.parents.length===2 && item.revisions[0]?.files?.['Power.wsch'] && refused;
            """,args)
        log(query,"native grant reads the committed folder and refuses a write operation")
        _ = await js("AtriumNavHost.act('project-history'); return true")
        let row = await until(12) { await self.truthy("""
            const row = document.querySelector('.hv-row[data-key="'+merge+'"]');
            if (row && AtriumHistoryView.state().sel !== merge) row.click();
            return !!document.querySelector('.hv-details .hv-headline') &&
                document.querySelector('.hv-details .ui-badge') !== null;
            """,args) }
        let state = row ? nil : await js("""
            return {status:document.querySelector('.hv-foot')?.textContent, rows:document.querySelectorAll('.hv-row').length,
              line:document.querySelector('.hv-details .hv-headline')?.textContent,
              hidden:document.hidden, power:AtriumPower.state()};
            """,args)
        log(row,"Project History draws a first-parent sheet change on the merge row",state)
        _ = await js("""
            [...document.querySelectorAll('.hv-detail-actions button')].find(button => button.textContent === 'Compare')?.click(); return true
            """)
        let compared = await until(12) { await self.truthy("""
            const view = globalThis.AtriumDiffView?.session();
            return view?.b.project.documents[0].items[0].text === 'SENSE' && view?.a.project.documents[0].items[0].text === 'SIGNAL';
            """) }
        log(compared,"the normal history row opens the two exact Git designs in Compare")
        let revoked = await truthy("""
            const grant = AtriumHost.folderGitGrant;
            const reading = AtriumHost.gitQuery('folderRevisions',{revisions:[merge]}).then(() => false, () => true);
            await AtriumHost.folderClose({grant});
            return await reading && !AtriumHost.folderGitGrant;
            """,args)
        log(revoked,"closing the folder invalidates an outstanding Git reply")
    }

    /// Exercise the shipping WK message handler and the actual AppKit sheet.
    /// All accepted destinations are verified inside this suite's disposable root.
    func folderDraftLifecycle() async {
        let phase = ProcessInfo.processInfo.environment["HARNESS_DRAFT_PHASE"] ?? "edit"
        let folder = work.appendingPathComponent("proj")
        let manifest = folder.appendingPathComponent("Draft.waffle"), member = folder.appendingPathComponent("Power.wsch")
        let source = "{\"kind\":\"schematic\",\"formatVersion\":\"2.0\",\"id\":\"s1\"}\n{\"kind\":\"netlabel\",\"id\":\"n1\",\"at\":[1270000,2540000],\"text\":\"SENSE\"}\n"
        if !fm.fileExists(atPath:manifest.path) {
            let root = "{\"kind\":\"project\",\"formatVersion\":\"2.0\",\"id\":\"p1\",\"name\":\"Draft\"}\n" +
                "{\"kind\":\"document\",\"id\":\"s1\",\"docKind\":\"schematic\",\"name\":\"Power\",\"path\":\"Power.wsch\"}\n" +
                "{\"kind\":\"document\",\"id\":\"s2\",\"docKind\":\"schematic\",\"name\":\"Unrelated\",\"path\":\"Unrelated.wsch\"}\n"
            try! Data(root.utf8).write(to:manifest)
            try! Data(source.utf8).write(to:member)
            try! Data("{\"kind\":\"schematic\",\"formatVersion\":\"2.0\",\"id\":\"s2\"}\n".utf8).write(to:folder.appendingPathComponent("Unrelated.wsch"))
        }
        let was = try! Data(contentsOf:member)
        NSApp.activate(ignoringOtherApps:true)
        d.window.makeKeyAndOrderFront(nil)
        _ = await js("const welcome = document.querySelector('dialog.sp-dialog[open]'); [...(welcome?.querySelectorAll('button') || [])].find(b => /continue to editor/i.test(b.textContent || b.title || b.getAttribute('aria-label') || ''))?.click(); return true")
        d.application(NSApp,openFiles:[manifest.path])
        var page: Harness?
        let opened = await until(25) {
            for window in NSApp.windows.compactMap({ $0.delegate as? Desktop }) where window.web != nil && !window.web.isLoading {
                let h = Harness(window)
                if await h.truthy("return globalThis.AtriumNavHost?.folderProject?.()?.activeId === 's1'") {page=h;return true}
            }
            return false
        }
        log(opened,"Finder opens the temporary native folder")
        guard let h = page else {note("state="+String(describing:await js("return {s:document.querySelector('#status')?.textContent,dialogs:[...document.querySelectorAll('dialog[open]')].map(d=>d.textContent.slice(0,130))}")));return}
        h.d.window.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps:true)
        guard let file = ProcessInfo.processInfo.environment["HARNESS_DRAFT_PROBE"],
              let probe = try? String(contentsOfFile:file,encoding:.utf8) else {log(false,"browser draft probe is installed");return}
        var args: [String:Any] = ["phase":phase]
        if phase == "edit" {
            // Use a held public-fixture handle in place of driving AppKit's remote picker.
            // Staging, private receipt, original range reads and new-grant restoration use the shipping bridge.
            let png = Data(base64Encoded:"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j8XkAAAAASUVORK5CYII=")!
            let url = work.appendingPathComponent("outside/selected.png")
            try! png.write(to:url)
            guard let grant = await h.js("return AtriumNavHost.folderProject().grant") as? String else { log(false,"native grant"); return }
            let token = UUID().uuidString.lowercased()
            let fixture = try! FileHandle(forReadingFrom:url)
            let media = try! FolderTransactions.mediaType(of:fixture)
            h.d.folderQueue.sync { h.d.folderSources[token] = (grant,"s1",media,fixture) }
            args["sourceToken"] = token
        }
        let answer = await h.js(probe,args)
        let data = answer as? [String:Any]
        log(data?["ok"] as? Bool == true,"folder draft "+phase,answer)
        if phase != "save" { log((try? Data(contentsOf:member)) == was,"working document bytes stayed intact") }
        if phase == "edit", data?["ok"] as? Bool == true {
            print("RESULT killed after durable private draft"); fflush(stdout); kill(getpid(),SIGKILL)
        }
    }
    func folderTransactions() async {
        let ready = await truthy("""
            const send = window.webkit.messageHandlers.atriumHost, receive = window.__atriumReceive;
            let next = 1000000000;
            const pending = new Map();
            window.__folderCall = (action,args={}) => new Promise((resolve,reject) => {
              const id=++next; pending.set(id,{resolve,reject});
              send.postMessage(JSON.stringify({...args,action,id}));
            });
            window.__atriumReceive = (id,value,error) => {
              const job=pending.get(id);
              if (!job) return receive(id,value,error);
              pending.delete(id); if (error) job.reject(Error(error)); else job.resolve(value);
            };
            window.__folderCall('open').then(x=>window.__openCancelled=Array.isArray(x)&&!x.length);
            return true;
            """)
        guard ready else { log(false,"the main-frame native bridge is available"); return }
        guard let open = await sheet() as? NSOpenPanel else { log(false,"File Open presents the native picker"); return }
        log(open.canChooseFiles && open.canChooseDirectories,"File Open offers both project folders and existing design files")
        d.window.endSheet(open,returnCode:.cancel)
        log(await until(3) { await self.truthy("return window.__openCancelled === true") },"cancelling File Open preserves the current project")
        let previousRoot = work.appendingPathComponent("proj/Previous",isDirectory:true)
        try! fm.createDirectory(at:previousRoot,withIntermediateDirectories:true)
        let previous = previousRoot.appendingPathComponent("Previous.waffle")
        let original = "{\"kind\":\"project\",\"formatVersion\":\"2.0\",\"id\":\"previous\",\"name\":\"Previous\"}\n"
        try! Data(original.utf8).write(to:previous)
        d.incoming = [previous]
        let adopted = await truthy("""
            const [file]=await window.__folderCall('open');
            const grant=file.folderProject.grant;
            await window.__folderCall('folderAdopt',{grant});
            window.__previousGrant=grant;
            return true;
            """)
        guard adopted else { log(false,"a saved current folder is adopted before choosing another folder"); return }
        _ = await js("""
            window.__folderCall('chooseProjectFolder',{mode:'create',name:'Panel Proof.waffle'})
              .then(x=>window.__folderChoice=x,e=>window.__folderError=e.message);
            return true;
            """)
        guard let create = await sheet() as? NSSavePanel else { log(false,"new folder opens the native save panel"); return }
        create.directoryURL = work.appendingPathComponent("proj",isDirectory:true)
        create.nameFieldStringValue = "Panel Proof"
        await pause(0.8)
        guard await confirm(create) else { log(false,"the new-folder choice stayed inside the test workspace"); return }
        guard await until(5,{ await self.truthy("return !!window.__folderChoice?.grant") }) else {
            log(false,"new-folder picker minted a scoped grant",await js("return window.__folderError")); return
        }
        let result = await js("""
            const call=window.__folderCall, pick=window.__folderChoice, grant=pick.grant, manifest=pick.manifest;
            const header=JSON.stringify({kind:'schematic',formatVersion:'2.0',id:'s1'})+'\\n';
            const row=JSON.stringify({kind:'netlabel',id:'n1',text:'SENSE'})+'\\n';
            const meta=JSON.stringify({kind:'project',formatVersion:'2.0',id:'p1',name:'Panel Proof'})+'\\n'+
              JSON.stringify({kind:'document',id:'s1',docKind:'schematic',name:'Power',path:'Power.wsch'})+'\\n';
            const first=await call('folderCommit',{grant,projectId:'p1',manifest,plan:[
              {path:'Power.wsch',expected:null,text:header+row},{path:manifest,expected:null,text:meta}]});
            await call('folderAdopt',{grant});
            let previousRevoked=false;
            try { await call('folderReadLease',{grant:window.__previousGrant}); } catch { previousRevoked=true; }
            const lease=(await call('folderReadLease',{grant})).lease;
            const initial=await call('folderRead',{grant,lease,paths:['Power.wsch']});
            await call('folderRelease',{grant,lease});
            const base=initial.files[0].sha256, begin=performance.now();
            const ack=await call('folderCommit',{grant,projectId:'p1',manifest,plan:[{path:'Power.wsch',expected:base,
              splice:{base,edits:[{offset:(header+row).indexOf('SENSE'),remove:5,insert:'DRIVE'}]}}]});
            const elapsed=performance.now()-begin;
            const l2=(await call('folderReadLease',{grant})).lease;
            const after=await call('folderRead',{grant,lease:l2,paths:['Power.wsch',manifest]});
            await call('folderRelease',{grant,lease:l2});
            AtriumHost.clearProjectPath();
            let revoked=false; try { await call('folderReadLease',{grant}); } catch { revoked=true; }
            return {ok:first.saved&&ack.saved&&/DRIVE/.test(atob(after.files[0].data))&&atob(after.files[1].data)===meta&&
              !('path' in pick)&&revoked&&previousRevoked,elapsed,manifest};
            """)
        let value = result as? [String:Any]
        let previousContents = try? String(contentsOf:previous,encoding:.utf8)
        log(value?["ok"] as? Bool == true && previousContents == original,
            "native folder adoption, durable one-row save and revocation of the previous folder grant",result)
    }
}
