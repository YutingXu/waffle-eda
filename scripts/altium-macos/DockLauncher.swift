import AppKit

// Wine's editor process runs from this same app bundle. A cold Dock launch uses
// the kit so the first editor gets the graphics settings and the correct prefix.
let others = NSRunningApplication.runningApplications(withBundleIdentifier: Bundle.main.bundleIdentifier ?? "")
    .filter { $0.processIdentifier != ProcessInfo.processInfo.processIdentifier && $0.executableURL?.lastPathComponent == "wine" }
if let editor = others.first {
    editor.activate(options: [.activateAllWindows])
} else if let kitLauncher = Bundle.main.object(forInfoDictionaryKey: "AltiumKitLauncher") as? String {
    let launch = Process()
    launch.executableURL = URL(fileURLWithPath: "/usr/bin/open")
    // The kit launcher can stay alive briefly after its Windows editor exits.
    // Start its launch sequence even while the previous one waits for Wine.
    launch.arguments = ["-n", "-a", kitLauncher]
    try launch.run()
    launch.waitUntilExit()
}
