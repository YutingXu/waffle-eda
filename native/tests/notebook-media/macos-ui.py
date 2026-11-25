"""Run the native PDF placement, keyboard save and fresh-process reopen against a signed Waffle test app."""
import argparse
import base64
import hashlib
import json
import os
from pathlib import Path
import subprocess
import struct
import tempfile
import zlib


HERE = Path(__file__).resolve().parent


def records(path, rows):
    path.write_text("".join(json.dumps(row, separators=(",", ":")) + "\n" for row in rows))


def run():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("executable", type=Path, help="WaffleHarness.app/Contents/MacOS/Waffle")
    parser.add_argument("--new-sheet", action="store_true", help="Add a new schematic, place an image twice and save while a PCB edit remains pending")
    parser.add_argument("--edit-marks", action="store_true", help="After reopening the new sheet, edit crop, angle, caption and all five annotation shapes")
    args = parser.parse_args()
    if args.edit_marks:
        args.new_sheet = True
    with tempfile.TemporaryDirectory(prefix="waffle-native-clip-") as temp:
        scratch = Path(temp)
        project = scratch / "project"
        project.mkdir()
        manifest = project / "Notebook.waffle"
        sheet = project / "Notes.wsch"
        members = [{"kind":"project", "formatVersion":"2.0", "id":"clip-project", "entryDocument":"clip-sheet", "name":"Clipped datasheet"}]
        board = project / "Board.wpcb"
        if args.new_sheet:
            members.append({"kind":"document", "id":"clip-board", "docKind":"pcb", "name":"Board", "order":"U", "path":board.name})
            records(board, [{"kind":"pcb","formatVersion":"2.0","id":"clip-board"},
                            {"kind":"label","id":"marker","at":[1000000,1000000],"layer":"Silk","order":"F","size":600000,"text":"Board marker"}])
        members.append({"kind":"document", "id":"clip-sheet", "docKind":"schematic", "name":"Notes", "order":"F", "path":sheet.name})
        records(manifest, members)
        records(sheet, [{"kind":"schematic", "formatVersion":"2.0", "id":"clip-sheet"}])
        original_manifest = manifest.read_bytes()
        def open_app(name, payload):
            work = scratch / name
            probe = "folder-new-image-browser.js" if args.new_sheet else "folder-clip-browser.js"
            env = {**os.environ, "HARNESS_EPHEMERAL":"1", "HARNESS_SUITE":"ui", "HARNESS_NOTEBOOK_MEDIA":"1",
                   "HARNESS_INPUT_STDIN":"1", "HARNESS_WORK":str(work), "HARNESS_OPEN_PROJECT":str(manifest),
                   "HARNESS_PROBES":str(HERE / probe)}
            result = subprocess.run([str(args.executable.resolve())], input=json.dumps(payload), text=True,
                                    capture_output=True, timeout=150, env=env, check=False)
            report = work / "folder-clip.json"
            if result.returncode or "RESULT ok" not in result.stdout or not report.exists():
                raise RuntimeError(result.stdout + result.stderr)
            data = json.loads(report.read_bytes())
            if data.get("error"):
                raise RuntimeError(data["error"])
            return data

        if args.new_sheet:
            def chunk(kind, data):
                return struct.pack(">I", len(data)) + kind + data + struct.pack(">I", zlib.crc32(kind + data))
            image = (b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", 2, 1, 8, 2, 0, 0, 0)) +
                     chunk(b"IDAT", zlib.compress(bytes([0, 222, 56, 56, 6, 123, 119]))) + chunk(b"IEND", b""))
            digest = hashlib.sha256(image).hexdigest()
            original_board, original_cover = board.read_bytes(), sheet.read_bytes()
            placed = open_app("first", {"png":base64.b64encode(image).decode("ascii"), "length":len(image), "sha256":digest})
            child = project / placed["owner"]
            members = [json.loads(line) for line in manifest.read_text().splitlines()]
            assert len(members) == 4 and any(r.get("path") == child.name and r["id"] == placed["id"] for r in members)
            assert child.is_file() and manifest.read_bytes() != original_manifest
            assert board.read_bytes() == original_board and sheet.read_bytes() == original_cover
            assets = list((project / "assets").iterdir())
            assert len(assets) == 1 and assets[0].name == digest and assets[0].read_bytes() == image
            rows = [json.loads(line) for line in child.read_text().splitlines()]
            photos = [row for row in rows if row["kind"] == "image"]
            assert len(photos) == 2 and all(i["asset"]["sha256"] == digest for i in photos), [row["kind"] for row in rows]
            opened = open_app("reopen", {"reopen":placed["id"], "sha256":digest, "editMarks":args.edit_marks})
            assert opened["reopenedBytes"] == len(image) and opened["reopenedItems"] == 2
            if args.edit_marks:
                edited = [json.loads(line) for line in child.read_text().splitlines()]
                marked = next(row for row in edited if row.get("caption") == "Board photo")
                # Editor angles run clockwise. Native placement angles use counterclockwise nanodegrees.
                assert marked["angle"] == 270000000000 and marked["crop"] == [100000,0,950000,1000000], marked
                assert marked["alt"] == "Two colour pads"
                shapes = [row for row in edited if row.get("imageId") == marked["id"]]
                assert len({row["id"] for row in shapes}) == 5
                assert {row["shape"] for row in shapes} == {"arrow","ellipse","box","highlight","text"}
                assert next(row for row in shapes if row["shape"] == "text")["richText"] == "Test pin"
            print(json.dumps({"firstFiles":len(placed["firstPaths"]), "secondFiles":len(placed["secondPaths"]),
                              "reopenedPlacements":opened["reopenedItems"], "sourceBytes":len(image), "rawSHA256":digest,
                              **({"savedMarkupShapes":opened["markCount"], "annotationText":opened["annotationText"]} if args.edit_marks else {}),
                              "boardStayedDirty":placed["otherDirty"], "boardFileChanged":board.read_bytes()!=original_board}, indent=2))
            return

        pdf = scratch / "source.pdf"
        subprocess.run(["xcrun", "swift", str(HERE / "pdf-fixture.swift"), str(pdf)], check=True)
        source = pdf.read_bytes()
        placed = open_app("first", {"pdf":base64.b64encode(source).decode("ascii"), "length":len(source)})
        rows = [json.loads(line) for line in sheet.read_text().splitlines()]
        assert len(rows) == 2
        item = rows[1]
        assert item["id"] == placed["id"] and item["clip"]["page"] == 2
        assert item["clip"]["region"] == [100000, 100000, 400000, 400000]
        assert manifest.read_bytes() == original_manifest
        files = list((project / "assets").iterdir())
        assert sorted(p.name for p in files) == sorted(ref["sha256"] for ref in [item["asset"], item["clip"]["source"]])
        assert all(hashlib.sha256(file.read_bytes()).hexdigest() == file.name for file in files)
        assert (project / "assets" / item["clip"]["source"]["sha256"]).read_bytes() == source
        assert sorted(placed["written"]) == sorted([sheet.name, *("assets/" + path.name for path in files)])
        opened = open_app("reopen", {"reopen":item["id"], "length":len(source)})
        for key in ["id", "extent", "source", "snapshot", "page", "region", "sheetCountAfter"]:
            assert placed[key] == opened[key], key
        print(json.dumps({"originalBytes":len(source), "originalSHA256":item["clip"]["source"]["sha256"],
                          "snapshotSHA256":item["asset"]["sha256"], "snapshotBytes":item["asset"]["byteLength"],
                          "extent":item["extent"], "reopenedRedPixels":opened["redPixels"], "page":item["clip"]["page"],
                          "regionMillionths":item["clip"]["region"], "filesWritten":len(placed["written"]),
                          "manifestChanged":False, "authoredItems":len(rows)-1}, indent=2))


if __name__ == "__main__":
    run()
