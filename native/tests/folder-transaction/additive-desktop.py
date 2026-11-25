#!/usr/bin/env python3
"""Drive a real macOS File Open and Command-S on the shared additive project."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile


def main():
    path = Path(__file__).resolve()
    product = path.parents[3]
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--builder", type=Path, default=product / "scripts/format-baseline")
    args = parser.parse_args()
    sys.path.insert(0, str(args.builder.resolve()))
    import native

    fixture = json.loads(path.with_name("additive.json").read_text())
    with tempfile.TemporaryDirectory(prefix="waffle-additive-panel-") as temp:
        work = Path(temp)
        project = work / "project.waffle"
        project.mkdir()
        for name, raw in fixture["files"].items():
            (project / name).write_bytes(raw.encode())
        (work / "trial.json").write_text("{}")
        scaffolding = work / "probe"
        scaffolding.mkdir()
        shutil.copy2(native.HERE / "edits.js", scaffolding)
        swift = (native.HERE / "main.swift").read_text()
        open_case = '            case "open":'
        key = r'''            case "saveKey":
                guard let event = NSEvent.keyEvent(with: .keyDown, location: .zero, modifierFlags: [.command],
                        timestamp: ProcessInfo.processInfo.systemUptime, windowNumber:desktop.window.windowNumber,
                        context:nil, characters:"s", charactersIgnoringModifiers:"s", isARepeat:false, keyCode:1),
                      NSApp.mainMenu?.performKeyEquivalent(with:event) == true else {
                    throw Failure("The normal Save key equivalent did not run.")
                }
                replyHandler(true,nil)
            case "open":
                desktop.window.alphaValue = 1
                desktop.window.ignoresMouseEvents = false
                desktop.window.level = .normal
                desktop.window.makeKeyAndOrderFront(nil)
                NSApp.activate(ignoringOtherApps:true)'''
        (scaffolding / "main.swift").write_text(native.once(swift, open_case, key))
        native.HERE = scaffolding
        probe = scaffolding / "probe.js"
        probe.write_text("""
          const native = op => webkit.messageHandlers.formatBenchmark.postMessage({op});
          async function until(test) {
            const end = performance.now() + 30000;
            while (!test()) { if (performance.now() > end) throw Error("Editor did not reach the expected project state."); await new Promise(r => setTimeout(r,25)); }
          }
          const H = AtriumNavHost;
          await native("open");
          await until(() => H.folderProject?.()?.project?.name === "Forward sensor" && H.doc()?.items?.some(i => i.id === "n1"));
          await native("finishOpen");
          const item = H.doc().items.find(i => i.id === "n1");
          if (item.text !== "SENSE" || item.x !== 0.001 || item.y !== 0.002) throw Error("The native project opened with incorrect authored values.");
          H.edit(() => Object.assign(item,{x:0.0011,y:0.0022,text:"DRIVE"}),"Edit label",[item.id],{documents:[H.currentId()],items:[item.id]});
          if (!H.isDirty()) throw Error("The edit did not mark the sheet dirty.");
          await native("saveKey");
          await until(() => !H.isDirty() && H.folderProject().metrics().lastSave);
          const metrics = H.folderProject().metrics();
          return {saved:true, paths:metrics.lastSave.paths, read:metrics.reads.map(r=>r.path)};
        """)
        with native.native_host(probe_file=probe, product_root=product) as exe:
            result = subprocess.run([exe, work], text=True, capture_output=True, timeout=90,
                                    env={**os.environ, "WAFFLE_FORMAT_PRIVATE": "1"})
        if result.returncode:
            raise RuntimeError((result.stderr + result.stdout)[-1600:])
        receipt = json.loads(result.stdout.splitlines()[-1])
        assert receipt["saved"] and receipt["paths"] == [fixture["member"]] and fixture["opaque"] not in receipt["read"], receipt
        for name, raw in fixture["files"].items():
            data = (project / name).read_bytes()
            if name == fixture["member"]:
                assert hashlib.sha256(data).hexdigest() == fixture["desired"]
            else:
                assert data == raw.encode()
        print("PASS native macOS File Open and Command-S with the shared worker, physical owner hash and untouched opaque file.")


if __name__ == "__main__":
    main()
