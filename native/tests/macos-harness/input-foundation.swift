import Cocoa
import WebKit

// Run with the app resources from a verified package. The nonactivating panel never takes the
// keyboard or posts an event to the user's desktop. Its responder receives synthetic AppKit signals.
private final class CanvasGesture: NSEvent {
    let gestureType: NSEvent.EventType
    let amount: CGFloat
    let step: NSEvent.Phase
    let point: NSPoint
    weak var panel: NSPanel?
    init(_ type: NSEvent.EventType, _ amount: CGFloat, _ step: NSEvent.Phase, _ point: NSPoint, _ panel: NSPanel) {
        self.gestureType=type;self.amount = amount; self.step = step; self.point = point; self.panel = panel
        super.init()
    }
    required init?(coder: NSCoder) { fatalError() }
    override var type: NSEvent.EventType { gestureType }
    override var phase: NSEvent.Phase { step }
    override var magnification: CGFloat { amount }
    override var rotation: Float { Float(amount) }
    override var locationInWindow: NSPoint { point }
    override var window: NSWindow? { panel }
    override var windowNumber: Int { panel?.windowNumber ?? 0 }
    override var timestamp: TimeInterval { ProcessInfo.processInfo.systemUptime }
    override var modifierFlags: NSEvent.ModifierFlags { [] }
}

@main private enum InputFoundationProbe {
    static func fail(_ s: String) -> NSError { NSError(domain:"WaffleInputProbe",code:1,userInfo:[NSLocalizedDescriptionKey:s]) }
    @MainActor static func main() async {
        do {
            guard CommandLine.arguments.count == 3 else { throw fail("Pass the signed app resource directory and the common probe.js") }
            let root=URL(fileURLWithPath:CommandLine.arguments[1]), script=try String(contentsOfFile:CommandLine.arguments[2],encoding:.utf8)
            let app=NSApplication.shared
            app.setActivationPolicy(.prohibited)
            let panel=NSPanel(contentRect:NSRect(x:16,y:16,width:1400,height:900),styleMask:[.borderless,.nonactivatingPanel],backing:.buffered,defer:false)
            panel.isReleasedWhenClosed=false; panel.hidesOnDeactivate=false; panel.ignoresMouseEvents=true
            let config=WKWebViewConfiguration()
            config.websiteDataStore = .nonPersistent()
            config.userContentController.addUserScript(WKUserScript(source:"window.nativeInput=[];for(const t of ['wheel','gesturestart','gesturechange','gestureend'])window.addEventListener(t,e=>{if(e.isTrusted)nativeInput.push([t,e.scale||0,e.deltaX||0,e.deltaY||0,e.target.id,e.target.tagName,e.target.className,e.clientX,e.clientY,e.rotation||0]);},true)",injectionTime:.atDocumentStart,forMainFrameOnly:true))
            let web=WKWebView(frame:NSRect(x:0,y:0,width:1400,height:900),configuration:config)
            panel.contentView=web
            panel.alphaValue=0;panel.orderBack(nil)
            web.loadFileURL(root.appendingPathComponent("index.html"),allowingReadAccessTo:root)
            func js(_ code:String) async throws -> Any? { try await web.evaluateJavaScript(code) }
            func pause(_ ms:UInt64) async { try? await Task.sleep(nanoseconds:ms*1_000_000) }
            for _ in 0..<160 {
                if (try? await js("!!document.querySelector('dialog.sp-dialog[open] [data-start-action=demo]')")) as? Bool == true { break }
                await pause(100)
            }
            _=try await js("document.querySelector('dialog.sp-dialog[open] [data-start-action=demo]').click();true")
            for _ in 0..<100 {
                if (try? await js("globalThis.AtriumNavHost?.doc()?.kind==='pcb' && !document.querySelector('dialog.sp-dialog[open] [data-start-action=demo]')?.offsetWidth")) as? Bool == true { break }
                await pause(50)
            }
            _=try await js(script+";true")
            let shared:Any = try await withCheckedThrowingContinuation { continuation in
                web.callAsyncJavaScript("return await WaffleInputProbe()",arguments:[:],in:nil,in:.page) { result in continuation.resume(with:result) }
            }
            guard let data=shared as? [String:Any],let checks=data["checks"] as? [String],checks.count>=34 else{throw fail("shared input checks missing")}
            let position=try await js("(()=>{const h=AtriumNavHost,r=h.canvas().getBoundingClientRect(); window.nativeStart=h.view().camera(); nativeInput.length=0;return [r.left+r.width/2,r.top+r.height/2]})()") as! [Double]
            let p=web.convert(NSPoint(x:position[0],y:web.isFlipped ? position[1]:web.bounds.height-position[1]),to:nil)
            let move=NSEvent.mouseEvent(with:.mouseMoved,location:p,modifierFlags:[],timestamp:ProcessInfo.processInfo.systemUptime,windowNumber:panel.windowNumber,context:nil,eventNumber:0,clickCount:0,pressure:0)!
            web.mouseMoved(with:move);await pause(150)
            for (step,amount) in [(NSEvent.Phase.began,0.0),(.changed,0.1),(.changed,0.1),(.ended,0.0)] {
                web.magnify(with:CanvasGesture(.magnify,amount,step,p,panel));await pause(55)
            }
            let magnified=try await js("(()=>({events:nativeInput.slice(),rect:JSON.stringify(AtriumNavHost.canvas().getBoundingClientRect()),ratio:AtriumNavHost.view().scale()/nativeStart.scale}))()") as! [String:Any]
            let ratio=magnified["ratio"] as? Double ?? 0
            guard abs(ratio-1.21)<0.01,(magnified["events"] as? [[Any]])?.contains(where:{($0.first as? String)=="gesturechange" && ($0[4] as? String)=="canvas"}) == true else {throw fail("native magnification: \(magnified)")}
            _=try await js("window.beforeScroll=AtriumNavHost.view().camera(); nativeInput.length=0; true")
            let screen=panel.convertPoint(toScreen:p),height=NSScreen.screens.first?.frame.height ?? 0
            for _ in 0..<3 {
                let cg=CGEvent(scrollWheelEvent2Source:nil,units:.pixel,wheelCount:2,wheel1:7,wheel2:11,wheel3:0)!
                cg.location=CGPoint(x:screen.x,y:height-screen.y)
                if let event=NSEvent(cgEvent:cg){web.scrollWheel(with:event)}
                await pause(35)
            }
            let scrolled=try await js("(()=>{const c=AtriumNavHost.view().camera();return {events:nativeInput,dx:c.cx-beforeScroll.cx,dy:c.cy-beforeScroll.cy,scale:c.scale/beforeScroll.scale}})()") as! [String:Any]
            guard (scrolled["events"] as? [[Any]])?.contains(where:{($0.first as? String)=="wheel" && ($0[4] as? String)=="canvas"})==true,
                  abs(scrolled["dx"] as? Double ?? 0)>0,abs(scrolled["dy"] as? Double ?? 0)>0,(scrolled["scale"] as? Double)==1 else{throw fail("native pixel scrolling: \(scrolled)")}
            var rotations:[[String:Any]]=[]
            for enabled in [false,true] {
                _=try await js("AtriumCamera.setPref('camera.rotate',"+(enabled ? "true":"false")+");AtriumNavHost.view().restoreCamera({...AtriumNavHost.view().camera(),rotation:0});nativeInput.length=0;true")
                for (step,degrees) in [(NSEvent.Phase.began,0.0),(.changed,12.0),(.changed,12.0),(.ended,0.0)] {
                    web.rotate(with:CanvasGesture(.rotate,degrees,step,p,panel));await pause(55)
                }
                let turn=try await js("(()=>({events:nativeInput.slice(),degrees:(AtriumNavHost.view().camera().rotation||0)*180/Math.PI}))()") as! [String:Any]
                let measured=turn["degrees"] as? Double ?? .nan
                guard abs(measured-(enabled ? -24:0))<0.1,(turn["events"] as? [[Any]])?.contains(where:{($0.first as? String)=="gesturechange" && ($0[4] as? String)=="canvas" && abs($0[9] as? Double ?? 0)>0})==true else{throw fail("native rotation: \(turn)")}
                rotations.append(turn)
            }
            _=try await js("AtriumCamera.setPref('camera.rotate',false);AtriumNavHost.view().restoreCamera({...AtriumNavHost.view().camera(),rotation:0});true")
            let fixture=URL(fileURLWithPath:CommandLine.arguments[2]).deletingLastPathComponent().appendingPathComponent("manufacturing.js")
            _=try await js(String(contentsOf:fixture,encoding:.utf8)+";true")
            let editors:Any=try await withCheckedThrowingContinuation { continuation in
                web.callAsyncJavaScript("return await WaffleManufacturingInputProbe()",arguments:[:],in:nil,in:.page){result in continuation.resume(with:result)}
            }
            guard let details=editors as? [String],details.count>=16 else{throw fail("drawing and panel checks missing")}
            let reported:[String:Any]=["shared":data,"manufacturing":details,"trustedMagnification":magnified,"trustedScroll":scrolled,"trustedRotation":rotations,
                "frontmostProbe":NSWorkspace.shared.frontmostApplication?.processIdentifier==ProcessInfo.processInfo.processIdentifier,
                "os":ProcessInfo.processInfo.operatingSystemVersionString,"webkit":Bundle(for:WKWebView.self).object(forInfoDictionaryKey:"CFBundleVersion") ?? "unknown"]
            print(String(data:try JSONSerialization.data(withJSONObject:reported,options:[.prettyPrinted,.sortedKeys]),encoding:.utf8)!)
            panel.orderOut(nil)
        }catch{FileHandle.standardError.write(Data(("FAIL "+String(describing:error)+"\n").utf8));exit(1)}
    }
}
