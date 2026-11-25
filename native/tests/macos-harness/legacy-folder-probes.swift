import Cocoa
import UniformTypeIdentifiers

// Send AppKit file-URL pasteboard data to the production drag destination method.
@MainActor final class LegacyFolderDrop: NSObject, NSDraggingInfo {
    let draggingPasteboard = NSPasteboard(name: NSPasteboard.Name("waffle-folder-harness-" + UUID().uuidString))
    let draggingSourceOperationMask = NSDragOperation.copy
    let draggingDestinationWindow: NSWindow?
    let draggingLocation = NSPoint.zero, draggedImageLocation = NSPoint.zero
    let draggingSource: Any? = nil, draggedImage: NSImage? = nil
    let draggingSequenceNumber = 1
    var draggingFormation = NSDraggingFormation.default
    var animatesToDestination = false, numberOfValidItemsForDrop = 1
    let springLoadingHighlight = NSSpringLoadingHighlight.none

    init(_ url: URL, window: NSWindow) {
        draggingDestinationWindow = window
        super.init()
        draggingPasteboard.clearContents()
        draggingPasteboard.writeObjects([url as NSURL])
    }
    func slideDraggedImage(to point: NSPoint) {}
    func enumerateDraggingItems(options: NSDraggingItemEnumerationOptions, for view: NSView?, classes classArray: [AnyClass],
                                searchOptions: [NSPasteboard.ReadingOptionKey: Any] = [:],
                                using block: (NSDraggingItem, Int, UnsafeMutablePointer<ObjCBool>) -> Void) {}
    func resetSpringLoading() {}
}

extension Harness {
    static var legacyPickerSelection: URL?

    static func legacyPickerURLs(_ panel: NSOpenPanel) -> [URL] {
        // The remote panel is real. Supply its designated fixture at the selection boundary.
        guard suite == "legacy-folder", let chosen = legacyPickerSelection else { return panel.urls }
        legacyPickerSelection = nil
        return [chosen]
    }

    func legacyFolderOpen() async {
        let folder = work.appendingPathComponent("proj",isDirectory:true)
        let note = "This file is from a pre-release Waffle build; re-import the design from its source EDA"
        let held = Data(#"{"format":"atrium","version":1,"formatVersion":"1.5","name":"Retired","documents":[],"library":[]}"#.utf8)
        _ = await js("""
            AtriumStartPage.close();
            const receive=window.__atriumReceive;
            window.__atriumReceive=(id,value,error)=>{
              if(error) window.__retiredReply={message:error,value};
              return receive(id,value,error);
            };
            return true
            """)
        for ext in ["waffle","atrium"] {
            let selected = folder.appendingPathComponent("Retired." + ext)
            let journal = folder.appendingPathComponent(selected.lastPathComponent+".journal"), draft = folder.appendingPathComponent(selected.lastPathComponent+"~")
            let files:[URL:Data] = [selected:held,journal:Data("ATRIUM-JOURNAL 1\nprivate saved edit".utf8),draft:Data("private draft".utf8)]
            for (u,b) in files { try! b.write(to:u) }
            for route in ["picker","finder","drop"] {
                _ = await js("window.__retiredReply=null; for (const d of document.querySelectorAll('dialog[open]')) d.close(); return true")
                if route == "picker" {
                    _ = await js("AtriumNavHost.act('open'); return true")
                    guard let panel = await sheet() as? NSOpenPanel else { log(false,"normal File Open panel for "+ext); return }
                    let suffixes = panel.allowedContentTypes.compactMap { $0.preferredFilenameExtension?.lowercased() }
                    log(suffixes.contains("waffle") && !suffixes.contains("atrium"),"File Open offers the current project extension")
                    Harness.legacyPickerSelection = selected
                    d.window.endSheet(panel,returnCode:.OK)
                } else if route == "finder" {
                    d.application(NSApp,openFiles:[selected.path])
                } else if let view = d.web as? EditorWebView {
                    let drop = LegacyFolderDrop(selected,window:d.window)
                    let accepted = view.draggingEntered(drop) == .copy && view.prepareForDragOperation(drop) && view.performDragOperation(drop)
                    log(accepted,"AppKit handles the explicit "+ext+" design drop")
                } else { log(false,"the shipping WebKit drop destination is available"); return }
                let refused = await until(6) { await self.truthy("return __retiredReply?.message === note && __retiredReply?.value == null && !AtriumHost.folderGitGrant",["note":note]) }
                log(refused,route+" rejects pre-release ."+ext+" with the exact re-import message",await js("return window.__retiredReply"))
                log(files.allSatisfy { (try? Data(contentsOf:$0.key)) == $0.value } && !fm.fileExists(atPath:folder.appendingPathComponent(".waffle").path),
                    route+" keeps the original, saved journal and private draft intact")
            }
        }
        _ = await js("for (const d of document.querySelectorAll('dialog[open]')) d.close(); return true")
        let good = folder.appendingPathComponent("Current.waffle")
        let sheet = folder.appendingPathComponent("Power.wsch")
        try! Data(("{\"kind\":\"project\",\"formatVersion\":\"2.0\",\"id\":\"p1\",\"name\":\"Current\"}\n" +
                   "{\"kind\":\"document\",\"id\":\"s1\",\"docKind\":\"schematic\",\"name\":\"Power\",\"path\":\"Power.wsch\"}\n").utf8).write(to:good)
        try! Data("{\"kind\":\"schematic\",\"formatVersion\":\"2.0\",\"id\":\"s1\"}\n".utf8).write(to:sheet)
        d.application(NSApp,openFiles:[good.path])
        let current = await until(12) {
            for editor in NSApp.windows.compactMap({ $0.delegate as? Desktop }) where editor.visibleFolder?.manifest.path == canon(good) {
                if await Harness(editor).truthy("return !!AtriumHost.folderGitGrant && AtriumNavHost.project().name==='Current' && AtriumNavHost.doc().id==='s1'") { return true }
            }
            return false
        }
        if !current {
            for editor in NSApp.windows.compactMap({ $0.delegate as? Desktop }) {
                self.note("Open state " + String(describing:await Harness(editor).js("return {grant:!!globalThis.AtriumHost?.folderGitGrant,name:globalThis.AtriumNavHost?.project().name,doc:globalThis.AtriumNavHost?.doc()?.id,status:document.getElementById('status')?.textContent,dialog:[...document.querySelectorAll('dialog[open]')].map(d=>d.textContent.slice(0,140))}")))
            }
        }
        log(current,"Finder opens the declared sheet of the current project after the refused inputs")
    }
}
