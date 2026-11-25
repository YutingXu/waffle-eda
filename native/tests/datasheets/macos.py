"""Run the file-origin PDF worker proof in real AppKit WKWebView."""
import base64
import json
from pathlib import Path
import shutil
import subprocess
import tempfile

ROOT = Path(__file__).resolve().parents[3]


def main():
    with tempfile.TemporaryDirectory(prefix="waffle-wk-datasheets-") as tmp:
        stage = Path(tmp)
        for source, name in (
            ('core/sha256.js', 'sha256.js'),
            ('project/source-file.js', 'source-file.js'),
            ('notebook/datasheet-record.js', 'datasheet-record.js'),
            ('notebook/datasheets.js', 'datasheets.js'),
            ('datasheet-worker-source.js', 'datasheet-worker-source.js'),
        ):
            shutil.copyfile(ROOT / "app" / source, stage / name)
        fixture = subprocess.check_output(["node", "-e",
            'process.stdout.write(require("./tests/support/datasheet-pdf.cjs").fixture(300))'], cwd=ROOT)
        (stage / "probe.js").write_text((ROOT / "tests/support/datasheet-probe.js").read_text() +
            '\nrunDatasheetProbe("' + base64.b64encode(fixture).decode() +
            '",{present:()=>new Promise(done=>{window.finishProofFrame=done;webkit.messageHandlers.presented.postMessage(0);})})'
            '.then(d=>webkit.messageHandlers.proof.postMessage(d),e=>webkit.messageHandlers.proof.postMessage({error:e.message}));\n')
        (stage / "reader.html").write_text('''<!doctype html><meta charset="utf-8">
<script src="sha256.js"></script><script src="source-file.js"></script>
<script src="datasheet-worker-source.js"></script>
<script src="datasheet-record.js"></script><script src="datasheets.js"></script>
<script>globalThis.AtriumLazy={need:async name=>window[name]};</script>
<script src="probe.js"></script>''')
        command = stage / "probe"
        subprocess.run(["xcrun", "swiftc", "-swift-version", "5", str(Path(__file__).with_name("main.swift")),
                        "-o", str(command)], check=True)
        result = subprocess.run([str(command), str(stage)], text=True, capture_output=True, timeout=100)
        print(result.stdout.strip(), flush=True)
        if result.returncode:
            raise SystemExit(result.returncode)
        data = json.loads(result.stdout)
        assert data["untouched"] == {"liveReaders": 0, "parseRequests": 0}
        assert data["pages"] == 300 and data["colored"] and data["cancelled"] == "AbortError"
        assert data["rows"] == [["Pin", "Name", "Function"], ["1", "VCC", "Power"], ["2", "GND", "Ground"]]
        assert all(0 < n <= shown for n, shown in zip(data["warmMs"], data["presentedMs"]))
        assert len(data["warmMs"]) == len(data["presentedMs"]) == 10
        assert data["ended"] == {"liveReaders": 0, "parseRequests": 2}


if __name__ == "__main__":
    main()
