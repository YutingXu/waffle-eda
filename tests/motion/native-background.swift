// A private ephemeral WebKit view stays behind other apps. This probe never activates a window.
import AppKit
import CoreGraphics
import WebKit

@MainActor final class Run: NSObject, NSApplicationDelegate, WKNavigationDelegate {
    var window:NSWindow!;var web:WKWebView!;var exitCode:Int32=1
    let root=URL(fileURLWithPath:CommandLine.arguments[1],isDirectory:true)
    var focus:pid_t?
    // Use the same per-process counters and WebKit process identifiers as the native energy suite.
    func energy() -> [Double] {
        func pid(_ object:AnyObject,_ name:String) -> Int32 {
            let sel=NSSelectorFromString(name)
            guard object.responds(to:sel) else{return 0}
            typealias Getter = @convention(c) (AnyObject,Selector)->Int32
            return unsafeBitCast(object.method(for:sel),to:Getter.self)(object,sel)
        }
        let processes=Set([getpid(),pid(web,"_webProcessIdentifier"),pid(web,"_gpuProcessIdentifier"),pid(web.configuration.websiteDataStore,"_networkProcessIdentifier")].filter{$0>0})
        var total=[Double](repeating:0,count:3),base=mach_timebase_info_data_t()
        mach_timebase_info(&base)
        for id in processes {
            var r=rusage_info_v6()
            let rc=withUnsafeMutablePointer(to:&r){p in p.withMemoryRebound(to:rusage_info_t?.self,capacity:1){proc_pid_rusage(id,RUSAGE_INFO_V6,$0)}}
            if rc==0 {
                total[0]+=Double(r.ri_user_time+r.ri_system_time)*Double(base.numer)/Double(base.denom)
                total[1]+=Double(r.ri_pkg_idle_wkups);total[2]+=Double(r.ri_energy_nj)
            }
        }
        return total
    }
    func applicationDidFinishLaunching(_ n:Notification) {
        focus=NSWorkspace.shared.frontmostApplication?.processIdentifier
        let cfg=WKWebViewConfiguration();cfg.websiteDataStore = .nonPersistent()
        web=WKWebView(frame:NSRect(x:0,y:0,width:1120,height:720),configuration:cfg);web.navigationDelegate=self
        window=NSWindow(contentRect:web.frame,styleMask:[.titled],backing:.buffered,defer:false)
        window.title="Butter motion private review";window.isRestorable=false;window.contentView=web;window.orderBack(nil)
        web.loadFileURL(root.appendingPathComponent("app/index.html"),allowingReadAccessTo:root)
    }
    func webView(_ webView:WKWebView,didFinish:WKNavigation!) {
        Task { @MainActor in
            do {
                let key=window.isKeyWindow,visible=window.occlusionState.contains(.visible),locked=(CGSessionCopyCurrentDictionary() as? [String:Any])?["CGSSessionScreenIsLocked"] as? Bool ?? false
                let display=CGDisplayCopyDisplayMode(CGMainDisplayID())?.refreshRate ?? 0
                print("native session locked=\(locked) displayHz=\(display) windowVisible=\(visible) key=\(key) appActive=\(NSApp.isActive)")
                let result=try await web.callAsyncJavaScript("""
                await AtriumLazy.need(["AtriumMotion","AtriumCamera"]);
                const H=AtriumNavHost, project=AtriumParts.example(), board=project.documents.find(d=>d.kind==="pcb");
                await H.replaceProject(project,{copy:true,dirty:false,force:true}); H.selectDocument(board.id);
                if(H.doc().kind!=="pcb" || !H.doc().items.length)throw Error("demo board did not open");
                AtriumPower.setMode("off"); AtriumTheme.set({motion:"full"}); AtriumPower.host({occluded:!windowVisible});
                const M=AtriumMotion, hidden=document.hidden||!AtriumPower.visible();
                let travelled=0, value=0;
                const callback=p=>{travelled++;value=p;};
                const handle=M.choreograph ? M.choreograph(H,"native-proof",{preset:"standard",step:callback}) : M.animate({ms:200,step:callback});
                await new Promise(resolve=>setTimeout(resolve,370));
                const first={hidden,frames:travelled,value,running:handle.running,clock:M.active(),visibility:document.visibilityState};
                if(hidden && travelled) throw Error("occluded webview ran a visual frame");
                if(!hidden && (travelled<2 || value!==1)) throw Error("visible flight did not finish");
                AtriumTheme.set({motion:"reduce"});
                await Promise.resolve(); // let the motion policy's preference observer deliver the update
                if(M.choreograph && (value!==1 || handle.running))throw Error("reduced preference did not land: "+JSON.stringify({level:M.level(),value,running:handle.running}));
                handle.cancel();
                AtriumTheme.set({motion:"full"}); AtriumPower.setMode("always");
                let energy=0;M.animate({ms:320,step(p){energy=p;}});if(M.choreograph && (energy!==1 || M.active()))throw Error("efficiency queued visual frames");
                return JSON.stringify({doc:H.doc().kind,items:H.doc().items.length,first,energy,active:M.active()});
                """,arguments:["windowVisible":visible],in:nil,contentWorld:.page)
                print("WK probe \(result ?? "missing")")
                try await Task.sleep(for:.seconds(1))
                let t=ProcessInfo.processInfo.systemUptime, before=energy()
                try await Task.sleep(for:.seconds(6))
                let dt=ProcessInfo.processInfo.systemUptime-t,after=energy()
                print(String(format:"native six-second idle CPU %.3f%% idleWakeups/s %.3f mW %.3f",100*(after[0]-before[0])/1e9/dt,(after[1]-before[1])/dt,(after[2]-before[2])/1e6/dt))
                print("frontmost application unchanged=\(focus==NSWorkspace.shared.frontmostApplication?.processIdentifier)")
                guard !key && !NSApp.isActive && focus==NSWorkspace.shared.frontmostApplication?.processIdentifier else {throw NSError(domain:"background",code:1)}
                exitCode=0
            }catch{print("WK ERROR \(error)")}
            exit(exitCode)
        }
    }
}
@main struct Main { @MainActor static func main() { let app=NSApplication.shared; app.setActivationPolicy(.prohibited);let run=Run();app.delegate=run;app.run();exit(run.exitCode) } }
