import Cocoa

// Use a private OS pasteboard for the synthetic clip probe so the user's general clipboard is untouched.
@MainActor enum NotebookFixtureClipboard {
    static var isEnabled:Bool {ProcessInfo.processInfo.environment["HARNESS_NOTEBOOK_MEDIA"]=="1"}
    private static let isolated=NSPasteboard.withUniqueName()
    static var board:NSPasteboard {isEnabled ? isolated : .general}
}
