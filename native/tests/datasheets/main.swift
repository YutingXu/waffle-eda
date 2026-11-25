import AppKit
import Foundation
import WebKit

final class Probe: NSObject, WKNavigationDelegate, WKScriptMessageHandler {
    func webView(_ web: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
        finish(error.localizedDescription, 1)
    }
    func webView(_ web: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
        finish(error.localizedDescription, 1)
    }
    func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage) {
        if message.name == "presented", let web = message.webView {
            let config = WKSnapshotConfiguration()
            config.afterScreenUpdates = true
            web.takeSnapshot(with:config) {image,error in
                if let error = error {self.finish(error.localizedDescription,1);return}
                guard image != nil else {self.finish("WKWebView returned no presented frame.",1);return}
                web.evaluateJavaScript("window.finishProofFrame()")
            }
            return
        }
        guard message.name == "proof", let result = message.body as? [String: Any],
              let raw = try? JSONSerialization.data(withJSONObject: result, options: [.sortedKeys]),
              let text = String(data: raw, encoding: .utf8) else { finish("Invalid probe result.", 1); return }
        finish(text, result["error"] == nil ? 0 : 1)
    }
    func finish(_ result: String, _ status: Int32) {
        print(result)
        fflush(stdout)
        exit(status)
    }
}

let root = URL(fileURLWithPath: CommandLine.arguments[1], isDirectory: true)
let app = NSApplication.shared
app.setActivationPolicy(.accessory)
let probe = Probe()
let config = WKWebViewConfiguration()
config.websiteDataStore = .nonPersistent()
config.userContentController.add(probe, name: "proof")
config.userContentController.add(probe, name: "presented")
let web = WKWebView(frame: NSRect(x: 0, y: 0, width: 600, height: 450), configuration: config)
web.navigationDelegate = probe
let win = NSWindow(contentRect: web.frame, styleMask: [.titled, .closable], backing: .buffered, defer: false)
win.contentView = web
win.orderFront(nil)
DispatchQueue.main.asyncAfter(deadline: .now() + 90) { probe.finish("The WKWebView datasheet probe timed out.", 1) }
web.loadFileURL(root.appendingPathComponent("reader.html"), allowingReadAccessTo: root)
app.run()
