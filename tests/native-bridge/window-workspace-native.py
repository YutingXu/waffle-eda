#!/usr/bin/env python3
"""Run the project-window contract through real AppKit and WKWebView instances."""

from pathlib import Path
import plistlib
import shutil
import subprocess
import tempfile


ROOT = Path(__file__).resolve().parents[2]
MAC = ROOT / "native/macos"


def run_probe(fixture, manifest, swift_driver, verify_design):
    with tempfile.TemporaryDirectory(prefix="waffle-workspace-native-", dir=Path.home() / "Library/Caches") as scratch:
        scratch = Path(scratch)
        app = scratch / "WorkspaceProbe.app"
        bin_dir = app / "Contents/MacOS"
        bin_dir.mkdir(parents=True)
        resources = app / "Contents/Resources"
        resources.mkdir()
        subprocess.run(["/bin/cp", "-cR", str(ROOT / "app"), str(resources / "app")], check=True)
        shutil.copy2(ROOT / "native/bridge.js", resources / "bridge.js")
        design = scratch / "design"
        shutil.copytree(fixture, design)
        info = plistlib.loads((MAC / "Info.plist").read_bytes())
        for role in ("CFBundleDocumentTypes", "CFBundleURLTypes", "UTImportedTypeDeclarations", "UTExportedTypeDeclarations"):
            info.pop(role, None)
        info.update(CFBundleIdentifier="org.waffle.workspace-fixture", CFBundleExecutable="WorkspaceProbe", LSUIElement=True)
        (app / "Contents/Info.plist").write_bytes(plistlib.dumps(info))
        prod = (MAC / "main.swift").read_text()
        prod = prod.split("let application = NSApplication.shared\n")[0]
        headless = 'if CommandLine.arguments.count == 3, CommandLine.arguments[1] == "--folder-mcp" {'
        if headless in prod:
            prod = prod.split(headless)[0]
        prod = prod.replace("        NSApp.activate(ignoringOtherApps: true)\n", "")
        prod = prod.replace("        window.setFrameAutosaveName(\"Waffle editor\")", "        window.isRestorable = false; window.sharingType = .none")
        if swift_driver.name == "window-workspace.swift":
            # Exercise the workspace deadline without having to stall the fixture for 15 seconds.
            fallback = "Timer(timeInterval: detached ? 15 : 2, repeats: false)"
            assert prod.count(fallback) == 1
            prod = prod.replace(fallback, "Timer(timeInterval: detached ? 6 : 2, repeats: false)")
        prod = prod.replace("let config = WKWebViewConfiguration()", "let config = WKWebViewConfiguration()\n        config.websiteDataStore = WorkspaceProbe.store")
        prod += """
extension Desktop {
    var workspaceFixtureView: WKWebView? { web }
    var workspaceFixtureCrashSheet: Bool { !webProcessAvailable && window.attachedSheet != nil }
    static var workspaceFixtureMirrors: [WKWebView] {
        editors.filter { $0.workspaceGroup != nil && $0.workspaceGroup?.writer !== $0 }.compactMap { $0.web }
    }
}
"""
        desktop = scratch / "Desktop.swift"
        desktop.write_text(prod)
        driver = scratch / "main.swift"
        shutil.copy2(swift_driver, driver)
        exe = bin_dir / "WorkspaceProbe"
        others = sorted(str(src) for src in MAC.glob("*.swift") if src.name != "main.swift")
        subprocess.run(["xcrun", "swiftc", "-swift-version", "5", "-target", "arm64-apple-macos12.0",
                        str(desktop), *others, str(driver), "-o", str(exe)], check=True)
        subprocess.run(["codesign", "--force", "--sign", "-", str(app)], check=True, capture_output=True)
        subprocess.run([str(exe), str(design / manifest)], check=True, timeout=80)
        verify_design(design)


def check():
    def verify(design):
        assert sum(b"Replayed project window edit" in p.read_bytes() for p in design.rglob("*.wsch")) == 1

    run_probe(ROOT / "mcp/examples/sensor-interface", "Board.waffle", ROOT / "native/tests/window-workspace.swift", verify)


if __name__ == "__main__":
    check()
