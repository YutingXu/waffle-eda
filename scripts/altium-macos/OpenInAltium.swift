import AppKit
import UniformTypeIdentifiers

final class FileOpener: NSObject, NSApplicationDelegate {
    private var panel: NSOpenPanel?
    private var jobs = 0
    private let setProjectDefault = CommandLine.arguments.contains("--make-project-default")

    func applicationWillFinishLaunching(_ notification: Notification) {
        NSApp.servicesProvider = self
    }

    func applicationDidFinishLaunching(_ notification: Notification) {
        guard setProjectDefault else { return }
        guard let type = UTType(filenameExtension: "prjpcb") else { NSApp.terminate(nil); return }
        NSApp.activate(ignoringOtherApps: true)
        NSWorkspace.shared.setDefaultApplication(at: Bundle.main.bundleURL, toOpen: type) { error in
            DispatchQueue.main.async {
                if let error { self.showError(error.localizedDescription, title: "Couldn’t change the default project app") }
                NSApp.terminate(nil)
            }
        }
    }

    func applicationOpenUntitledFile(_ sender: NSApplication) -> Bool {
        if !setProjectDefault { choose() }
        return true
    }

    func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows: Bool) -> Bool {
        if !setProjectDefault { choose() }
        return false
    }

    func application(_ sender: NSApplication, open urls: [URL]) {
        openFiles(urls)
    }

    @objc func chooseForAltium(_ pasteboard: NSPasteboard, userData: String?,
                               error: AutoreleasingUnsafeMutablePointer<NSString?>) {
        DispatchQueue.main.async { self.choose() }
    }

    private func choose() {
        NSApp.activate(ignoringOtherApps: true)
        if let panel {
            panel.makeKeyAndOrderFront(nil)
            return
        }
        let picker = NSOpenPanel()
        picker.title = "Open in Altium"
        picker.allowsMultipleSelection = true
        picker.canChooseDirectories = false
        let types = Bundle.main.object(forInfoDictionaryKey: "CFBundleDocumentTypes") as? [[String: Any]]
        let extensions = types?.first?["CFBundleTypeExtensions"] as? [String] ?? []
        picker.allowedContentTypes = extensions.compactMap { UTType(filenameExtension: $0) }
        picker.directoryURL = UserDefaults.standard.url(forKey: "lastFolder")
            ?? FileManager.default.urls(for: .documentDirectory, in: .userDomainMask).first
        panel = picker
        picker.begin { result in
            self.panel = nil
            if result == .OK {
                UserDefaults.standard.set(picker.directoryURL, forKey: "lastFolder")
                self.openFiles(picker.urls)
            } else {
                self.finishIfIdle()
            }
        }
    }

    private func openFiles(_ urls: [URL]) {
        guard !urls.isEmpty, let resources = Bundle.main.resourceURL else { return }
        let process = Process()
        let output = Pipe()
        process.executableURL = URL(fileURLWithPath: "/usr/bin/python3")
        process.arguments = [resources.appendingPathComponent("open_files.py").path] + urls.map(\.path)
        process.currentDirectoryURL = resources
        process.standardInput = FileHandle.nullDevice
        process.standardOutput = output
        process.standardError = output
        jobs += 1
        process.terminationHandler = { completed in
            let data = output.fileHandleForReading.readDataToEndOfFile()
            DispatchQueue.main.async {
                self.jobs -= 1
                if completed.terminationStatus == 0 {
                    let editors = NSRunningApplication.runningApplications(withBundleIdentifier: "local.altium-wine.runtime.ad26")
                    editors.first?.activate(options: [.activateAllWindows])
                } else {
                    let reason = String(decoding: data, as: UTF8.self).trimmingCharacters(in: .whitespacesAndNewlines)
                    self.showError(reason)
                }
                self.finishIfIdle()
            }
        }
        do {
            try process.run()
        } catch {
            jobs -= 1
            showError(error.localizedDescription)
            finishIfIdle()
        }
    }

    private func showError(_ reason: String, title: String = "Altium couldn’t open the selection") {
        NSApp.activate(ignoringOtherApps: true)
        let alert = NSAlert()
        alert.messageText = title
        alert.informativeText = reason
        alert.runModal()
    }

    private func finishIfIdle() {
        if panel == nil && jobs == 0 { NSApp.terminate(nil) }
    }
}

let application = NSApplication.shared
let opener = FileOpener()
application.delegate = opener
application.setActivationPolicy(.accessory)
application.run()
