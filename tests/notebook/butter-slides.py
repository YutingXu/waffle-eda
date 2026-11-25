#!/usr/bin/env python3
"""Verify presentation state and the actual confined vector export over MCP."""

from pathlib import Path
import json
import os
import re
import runpy
import tempfile
from time import monotonic
from zlib import decompress


HERE = Path(__file__).resolve().parents[1]
A = runpy.run_path(str(HERE / "automation/butter-acceptance.py"))
FIXTURE = A["read_json"](HERE / "fixtures/butter-acceptance/slides.json")
FLAGS = ("--enable-butter", "slides", "--allow-write")


def run(client, name, args=None, *, mode=None, denied=False):
    call = {"command": f"butter.slides.{name}", "args": args or {}}
    if mode:
        call["mode"] = mode
    return client.check_tool("run_command", call, denied=denied)


def id_(n):
    return f"018cc251-f400-7001-8000-{n:012}"


def check_pdf(root, client):
    names = FIXTURE["cases"]["export-pdf"]
    receipt = run(client, "export-pdf", names["args"], mode="write")
    data = (root / names["outputFile"]).read_bytes()
    assert receipt["pageCount"] == 2 and receipt["links"] >= 3, receipt
    assert data.startswith(b"%PDF-") and b"/Subtype /Image" not in data, "Vector-only sample"
    assert re.findall(rb"/MediaBox \[0 0 (\d+) (\d+)\]", data) == [(b"720", b"405"), (b"720", b"540")]
    for n in (11, 12):
        assert f"/URI (waffle://{id_(1)}/{id_(n)})".encode() in data
    assert re.search(rb"/Subtype /Link [^\n]+ /Dest \[", data), "Smart PDF internal destination"
    streams = []
    for part in re.finditer(rb"(?m)^\d+ 0 obj\n([^\n]+)\nstream\r?\n", data):
        length = re.search(rb"/Length (\d+)", part[1])
        assert length
        payload = data[part.end():part.end() + int(length[1])]
        streams.append(decompress(payload) if b"/FlateDecode" in part[1] else payload)
    assert any(re.search(rb"\bm\s+[\d. -]+ l\b", body) for body in streams), "Native vector strokes"
    cue = b"Private speaker cue"
    assert cue not in data and not any(cue in body or cue.decode().encode("utf-16-be").hex().encode() in body.lower()
                                      for body in streams), "Speaker notes stay in the presentation"
    return len(data)


def main():
    with tempfile.TemporaryDirectory(prefix="waffle-slide-integrity-") as scratch:
        root = Path(scratch).resolve()
        project = A["make_project"](root, FIXTURE)
        original = A["authored_files"](root)
        with A["Stdio"](A["server"](project, *FLAGS)) as client:
            for name in FIXTURE["cases"]:
                refusal = run(client, name, {"path": "outside"}, denied=True)
                assert refusal["code"] == "invalid_arguments", (name, refusal)
            assert run(client, "apply", {"id":id_(101)})["untrusted_design_text"]["status"] == "missing-slide"
            assert run(client, "export-pdf", {"ids":[id_(101)]}, denied=True)["code"] == "missing_slide"
            assert run(client, "add", {"name":"Broken", "source":{"kind":"frame","documentId":id_(2),"frameId":id_(101)}},
                       denied=True)["code"] == "missing_frame"
            start = monotonic()
            assert run(client, "start", mode="write")["index"] == 0
            first = run(client, "presenter")
            assert first["untrusted_design_text"]["current"]["id"] == id_(11)
            before = first["elapsedMs"]
            step = run(client, "step", {"direction":1}, mode="write")["untrusted_design_text"]
            assert step["status"] == "partial" and step["view"]["filter"]["status"] == "complete", step
            second = run(client, "presenter")
            assert second["untrusted_design_text"]["next"]["id"] == id_(13)
            assert 0 <= before <= second["elapsedMs"] <= 86400000
            assert run(client, "step", {"index":0,"direction":1}, mode="write", denied=True)["code"] == "invalid_arguments"
            assert run(client, "resume", mode="write")["index"] == 1
            assert run(client, "stop", mode="write")["untrusted_design_text"]["status"] == "stopped"
            elapsed = (monotonic() - start) * 1000
            start = monotonic()
            size = check_pdf(root, client)
            exported = (monotonic() - start) * 1000
            assert A["authored_files"](root) == original
            assert run(client, "start", mode="write")["index"] == 0
            run(client, "remove", {"id": id_(12)}, mode="write")
            missing = run(client, "step", {"direction": 1}, mode="write")
            assert missing["index"] == 1 and missing["untrusted_design_text"]["status"] == "missing-slide", missing
            assert run(client, "presenter")["index"] == 1
            advanced = run(client, "step", {"direction": 1}, mode="write")
            assert advanced["index"] == 2 and advanced["untrusted_design_text"]["current"]["id"] == id_(13), advanced
        with A["Stdio"](A["server"](project, *FLAGS)) as fresh:
            assert run(fresh, "presenter")["untrusted_design_text"]["status"] == "inactive"
    print("PASS live stdio slide state, invalid calls, PDF dimensions, Smart PDF links, vector paths and private notes")
    print(f"Seven state operations: {elapsed:.1f} ms. Two-page confined PDF: {exported:.1f} ms, {size} bytes.")


def prepared_assets():
    with tempfile.TemporaryDirectory(prefix="waffle-slide-assets-") as scratch:
        root = Path(scratch).resolve()
        project = A["make_project"](root, FIXTURE)
        document, frame = "older-top", "older-overview"
        top = root / "Top.wsch"
        def rewrite(file, extra=()):
            header, *rows = file.read_text().replace(id_(2), document).replace(id_(4), frame).splitlines()
            rows = sorted([*rows, *extra], key=lambda line: json.loads(line)["id"])
            file.write_text("\n".join([header, *rows, ""]))
        rewrite(project)
        sha = "7f2f9088c8f90652a6aaa45e69623b55316b6d080c2213d29819976b71454840"
        reference = HERE / "fixtures/format-2/notebook/assets" / sha
        (root / "assets").mkdir()
        (root / "assets" / sha).write_bytes(reference.read_bytes())
        photo = {"kind": "image", "id": "verified-photo", "asset": {
            "byteLength": reference.stat().st_size, "mediaType": "image/png", "sha256": sha},
            "extent": [1, 1], "h": 4000000, "name": "Photo.png", "order": "o", "w": 5000000,
            "x": 18000000, "y": 12000000}
        rewrite(top, [json.dumps(photo, separators=(",", ":"))])
        source = {"kind": "frame", "documentId": document, "frameId": frame}
        with A["Stdio"](A["server"](project, *FLAGS)) as client:
            new = run(client, "add", {"name": "Older source", "source": source}, mode="write")["untrusted_design_text"]["slide"]
            identity = new["id"]
            assert new["source"] == source
            run(client, "update", {"id": identity, "source": source, "aspect": "4:3"}, mode="write")
        with A["Stdio"](A["server"](project, *FLAGS)) as client:
            view = run(client, "apply", {"id": identity})["untrusted_design_text"]
            assert view["status"] == "ready" and view["documentId"] == document, view
            receipt = run(client, "export-pdf", {"ids": [identity]}, mode="write")
            data = (root / FIXTURE["cases"]["export-pdf"]["outputFile"]).read_bytes()
            if os.environ.get("WAFFLE_PDF_CANVAS_ROOT"):
                assert b"/Subtype /Image" in data, receipt
                assert receipt["untrusted_design_text"]["notes"] == [], receipt
            else:
                assert b"/Subtype /Image" in data or any("Image" in note for note in receipt["untrusted_design_text"]["notes"]), receipt
            assert f"/URI (waffle://{id_(1)}/{identity})".encode() in data
        top.write_text("".join(line for line in top.read_text().splitlines(keepends=True)
                               if json.loads(line).get("id") != frame))
        with A["Stdio"](A["server"](project, *FLAGS)) as client:
            for mode in ("plan", "write"):
                assert run(client, "export-pdf", {"ids": [identity]}, mode=mode, denied=True)["code"] == "missing_frame"
    print("PASS legacy native frame identity, verified image preparation, PDF source link and broken preview")


if __name__ == "__main__":
    main()
    prepared_assets()
