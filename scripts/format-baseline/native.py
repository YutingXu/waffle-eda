"""Build an offscreen copy of the shipping macOS host, then run one isolated native open/edit/save."""
from contextlib import contextmanager
import hashlib
import json
import os
from pathlib import Path
import platform
import plistlib
import shutil
import subprocess
import tempfile

from sources import ROOT

HERE = Path(__file__).resolve().parent


def once(text, anchor, replacement):
    if text.count(anchor) != 1:
        raise ValueError("The macOS host changed; verify the benchmark's window setup against it.")
    return text.replace(anchor, replacement)


@contextmanager
def native_host(*, probe_file=None, input_driver=None, product_root=ROOT, ephemeral=True, instrumentation=None, visible_window=False):
    if platform.system() != "Darwin":
        raise ValueError("The native benchmark requires macOS with Xcode command line tools.")
    # As in native/tests/macos-harness/build.sh, WebKit file pages use a real bundle path.
    caches = Path.home() / "Library/Caches"
    with tempfile.TemporaryDirectory(prefix="waffle-format-host-", dir=caches) as temp:
        workspace = Path(temp)
        bundle = workspace / "Benchmark.app"
        contents = bundle / "Contents"
        mac = contents / "MacOS"
        mac.mkdir(parents=True)
        resources = contents / "Resources"
        resources.mkdir()
        source = product_root / "native/macos"
        text = (source / "main.swift").read_text()
        launch = "let application = NSApplication.shared\n"
        headless = 'if CommandLine.arguments.count == 3, CommandLine.arguments[1] == "--folder-mcp" {\n'
        if headless in text:
            launch = headless
        if text.count(launch) != 1:
            raise ValueError("The macOS host launch changed; verify the benchmark build.")
        text = text.split(launch)[0]
        text = once(text, "    private var web: WKWebView!", "    var web: WKWebView!")
        text = once(text, "func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { true }",
                    "func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { false }")
        text = once(text, "    private var window: NSWindow!", "    var window: NSWindow!")
        if ephemeral:
            text = once(text, "        let config = WKWebViewConfiguration()",
                        "        let config = WKWebViewConfiguration()\n        config.websiteDataStore = .nonPersistent()")
        text = once(text, '        window.setFrameAutosaveName("Waffle editor")',
                    "        window.setContentSize(NSSize(width: 1380, height: 860))\n        window.isRestorable = false; window.sharingType = .none")
        window_style = ("        window.ignoresMouseEvents = true\n" if visible_window else
                        "        window.level = NSWindow.Level(rawValue: NSWindow.Level.normal.rawValue - 2)\n"
                        "        window.ignoresMouseEvents = true; window.alphaValue = 0.025\n")
        text = once(text, "        window.makeKeyAndOrderFront(nil)\n        NSApp.activate(ignoringOtherApps: true)\n        watchPower()",
                    window_style + "        window.orderFrontRegardless()\n        watchPower()")
        if instrumentation:
            text, instrumented_sources = instrumentation(workspace, source, text)
        else:
            instrumented_sources = []
        (workspace / "Desktop.swift").write_text(text)
        with (source / "Info.plist").open("rb") as f:
            info = plistlib.load(f)
        # Do not register this private benchmark bundle as a project handler.
        for key in ("CFBundleDocumentTypes", "UTImportedTypeDeclarations", "UTExportedTypeDeclarations"):
            info.pop(key, None)
        identifier = "org.waffle.viewer-benchmark" if input_driver else "org.waffle.format-benchmark"
        info.update(CFBundleIdentifier=identifier, LSUIElement=True)
        with (contents / "Info.plist").open("wb") as f:
            plistlib.dump(info, f)
        shutil.copytree(product_root / "app", resources / "app")
        shutil.copy2(product_root / "native/bridge.js", resources / "bridge.js")
        (resources / "native").mkdir()
        for helper in ("git_head.py","project_archive.py","import_sources.py","obsolete_project.py"):
            helper_source = product_root / "native" / helper
            if helper_source.is_file():
                shutil.copy2(helper_source, resources / "native")
        shutil.copy2(HERE / "edits.js", resources / "edits.js")
        shutil.copy2(probe_file or HERE / "probe.js", resources / "probe.js")
        extra = ["-D", "VIEW3D_INPUT", str(input_driver)] if input_driver else []
        overrides = {Path(arg).name for arg in instrumented_sources if str(arg).endswith(".swift")}
        companions = [str(path) for path in sorted(source.glob("*.swift"))
                      if path.name != "main.swift" and path.name not in overrides]
        exe = mac / "Waffle"
        subprocess.run(["xcrun", "swiftc", "-O", "-swift-version", "5", "-target", platform.machine() + "-apple-macos12.0",
                        str(workspace / "Desktop.swift"), *companions, *extra, *instrumented_sources,
                        str(HERE / "main.swift"), "-o", str(exe)], check=True)
        subprocess.run(["codesign", "--force", "--sign", "-", str(bundle)], check=True, capture_output=True)
        yield exe


def summary_for(snapshot):
    contents = snapshot.read_bytes()
    p = json.loads(contents)
    return {"bytes": len(contents), "allocatedBytes": snapshot.stat().st_blocks * 512, "documents": len(p["documents"]),
            "items": [len(d["items"]) for d in p["documents"]], "version": p["formatVersion"]}


def trial_run(executable, snapshot, summary, case, digest, policy, edit, settle):
    with tempfile.TemporaryDirectory(prefix="waffle-format-trial-") as raw:
        work = Path(raw)
        project = work / "project.waffle"
        shutil.copyfile(snapshot, project)
        (work / "trial.json").write_text(json.dumps({"original": digest, "policy": policy, "items": summary["items"],
                                                     "globalLabel": case == "lily58", "edit": edit, "settle": settle}))
        p = subprocess.run([str(executable), str(work)], capture_output=True, timeout=180,
                           env={**os.environ, "WAFFLE_FORMAT_PRIVATE": str(int(case == "approved"))})
        if p.returncode or not p.stdout.strip():
            if case == "approved":
                raise RuntimeError("Native measurement failed on the approved export.")
            raise RuntimeError("Native exit %s: %s" % (p.returncode, (p.stderr + p.stdout).decode(errors="replace")[-1800:]))
        row = json.loads(p.stdout.decode().splitlines()[-1])
        if not settle:
            result = subprocess.run(["git", "--no-pager", "diff", "--no-index", "--no-ext-diff", "--no-textconv", "--no-renames",
                                     "--diff-algorithm=myers", "--numstat", "--", str(snapshot), str(project)], cwd=work, capture_output=True)
            if result.returncode != 1:
                raise RuntimeError("The editor saved no difference, or Git could not read it.")
            additions, deletions, _ = result.stdout.split(b"\t", 2)
            row["additions"], row["deletions"] = int(additions), int(deletions)
        return row


def measure(executable, snapshot, summary, case, repeats):
    results = []
    digest = hashlib.sha256(snapshot.read_bytes()).hexdigest()
    for repeat in range(repeats):
        # Alternate policy order. Every observation starts in a fresh process on a new copy of identical bytes.
        policies = ["close", "always"] if repeat % 2 == 0 else ["always", "close"]
        for policy in policies:
            row = trial_run(executable, snapshot, summary, case, digest, policy, "part", True)
            results.append({**row, "repeat": repeat + 1, "policy": policy})
    first = {edit: trial_run(executable, snapshot, summary, case, digest, "close", edit, False)
             for edit in ("part", "label", "track")}
    if digest != hashlib.sha256(snapshot.read_bytes()).hexdigest():
        raise RuntimeError("The input snapshot changed.")
    return {"observations": results, "firstEditorSave": first}
