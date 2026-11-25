#!/bin/zsh
# Builds WaffleHarness.app: the real Desktop class from native/macos/main.swift (top-level launch
# code removed, `web`/`window` made visible) plus harness.swift, which drives the app in-process.
set -eu
H=${0:A:h}; ROOT=${H:h:h:h}; OUT=${HARNESS_OUT:-${TMPDIR:-/tmp}/atrium-harness-build}
python3 -B "$ROOT/scripts/prepare-assets.py"
rm -rf $OUT; mkdir -p $OUT/cache
sed -e 's/^    private var window: NSWindow!/    var window: NSWindow!/' -e 's/^    private var web: WKWebView!/    var web: WKWebView!/' \
    -e 's/^    private var visibleFolder:/    var visibleFolder:/' -e 's/^    private var incoming:/    var incoming:/' \
    -e 's/^    private var folderSources:/    var folderSources:/' \
    $ROOT/native/macos/main.swift | sed -e '/^if CommandLine.arguments.count == 3, CommandLine.arguments\[1\] == "--folder-mcp" {/,$d' -e '/^let application = NSApplication.shared$/,$d' > $OUT/desktop.swift
# Share one non-persistent WebKit store across the run's windows, as the real app shares its default store.
perl -0pi -e 's/(        let config = WKWebViewConfiguration\(\)\n)/$1        if ProcessInfo.processInfo.environment["HARNESS_EPHEMERAL"] != nil { config.websiteDataStore = Harness.ephemeralStore }\n        Harness.installEarlyProbe(config)\n/' $OUT/desktop.swift
grep -q HARNESS_EPHEMERAL $OUT/desktop.swift
# AppKit snapshots the initial directory before it presents the remote save sheet.
# Keep the folder-picker proof in the private fixture even if another harness previously ran.
python3 - "$OUT/desktop.swift" <<'PYTHON'
from pathlib import Path
import sys
file = Path(sys.argv[1])
text = file.read_text()
clipboard = "let clipboard=NSPasteboard.general"
if clipboard in text:
    text = text.replace(clipboard, "let clipboard=NotebookFixtureClipboard.board")
show = '        window.makeKeyAndOrderFront(nil)\n        NSApp.activate(ignoringOtherApps: true)'
background = '        if ProcessInfo.processInfo.environment["HARNESS_BACKGROUND"] == "1" { window.orderBack(nil) } else {\n' + show + '\n        }'
assert text.count(show) == 1
text = text.replace(show, background)
new_folder = '        panel.title = "Save Waffle Project Folder"'
for anchor in (new_folder, '            let panel = NSSavePanel()\n            panel.allowedContentTypes = [contentType]'):
    assert text.count(anchor) == 1
    indent = anchor[:len(anchor) - len(anchor.lstrip())]
    text = text.replace(anchor, anchor + '\n' + indent + 'if suite == "folder" || suite == "legacy-folder" { panel.directoryURL = work.appendingPathComponent("proj",isDirectory:true) }')
text = text.replace(new_folder, new_folder + '\n        if suite == "projects" { panel.directoryURL = work.appendingPathComponent("altium",isDirectory:true) }')
export_parent = '            folder.message="Choose the parent folder for the exported design.";panel=folder'
assert text.count(export_parent) == 1
text = text.replace(export_parent, export_parent + '\n' +
    '            if suite == "projects" { folder.directoryURL = work.appendingPathComponent("out",isDirectory:true) }')

anchor = '                    if panel.urls.contains(where: { $0.pathExtension.lowercased() == "atrium" })'
assert text.count(anchor) == 1
start = text.index(anchor)
end = text.index('                else { self.reply(id, []) }', start)
selection = text[start:end].replace('panel.urls', 'selected')
text = text[:start] + '                    let selected = Harness.legacyPickerURLs(panel)\n' + selection + text[end:]
file.write_text(text)
PYTHON
perl -0pi -e 's/(guard let frame = action.targetFrame, let url = action.request.url else \{ decisionHandler\(.cancel\); return \})/$1\n        if ProcessInfo.processInfo.environment["HARNESS_TRACE"] != nil { print("POLICY", frame.isMainFrame, url.absoluteString, page.absoluteString) }/' $OUT/desktop.swift
cp $H/harness.swift $OUT/main.swift
xcrun swiftc -swift-version 5 -target arm64-apple-macos12.0 -module-cache-path $OUT/cache \
  $OUT/desktop.swift $ROOT/native/macos/FolderTransactions.swift $ROOT/native/macos/FolderWatch.swift $ROOT/native/macos/ProjectWrites.swift $ROOT/native/macos/HostState.swift $ROOT/native/macos/ExternalTools.swift $ROOT/native/macos/LanRelay.swift $ROOT/native/macos/NotebookMedia.swift $ROOT/native/macos/NotebookFolderMedia.swift $H/ui-probes.swift $H/notebook-fixture-clipboard.swift $H/energy-probes.swift $H/folder-probes.swift $H/legacy-folder-probes.swift $H/startup-probes.swift $H/native-feel.swift \
  $H/memory-probes.swift $H/gpu-restart.swift $OUT/main.swift -o $OUT/WaffleHarness
APP=$OUT/WaffleHarness.app/Contents
mkdir -p $APP/MacOS $APP/Resources/native $APP/Resources/mcp
bundle_id=org.waffle.editor.harness
[[ ${HARNESS_GPU_RESTART_BUILD:-0} == 1 ]] && bundle_id+=.gpu-restart
sed "s|<string>org.waffle.editor</string>|<string>$bundle_id</string>|" $ROOT/native/macos/Info.plist > $APP/Info.plist
cp $ROOT/native/bridge.js $APP/Resources/bridge.js
cp -R $ROOT/app $APP/Resources/app
python3 -B "$ROOT/scripts/package_payload.py" stage "$APP/Resources"
cp $OUT/WaffleHarness $APP/MacOS/Waffle
codesign --force --sign - --identifier "$bundle_id" $OUT/WaffleHarness.app 2>/dev/null
echo $OUT/WaffleHarness.app
# WebKit will not load file pages from under the /tmp symlink, so run from a real path.
# HARNESS_INSTALL overrides the folder (it must be a real path, not under the /tmp symlink).
C=${HARNESS_INSTALL:-$HOME/Library/Caches/atrium-harness}; rm -rf $C; mkdir -p $C; cp -R $OUT/WaffleHarness.app $C/
echo $C/WaffleHarness.app
