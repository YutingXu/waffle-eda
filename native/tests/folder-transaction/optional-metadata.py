#!/usr/bin/env python3
"""Run the optional manifest change vectors against a real native transaction driver."""
import argparse
from base64 import b64encode
from hashlib import sha256
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile


ROOT = Path(__file__).resolve().parents[3]
FIXTURE = ROOT / "tests/fixtures/format-2/butter-query"
NAME = "Saved Query.waffle"
OWNER = "Power.wpcb"
OPAQUE = b'{"kind":"futureMetadata","id":"z-opaque","value":{ "huge":90071992547409919999999, "escaped":"\\u0058" }}\r\n'


def hashed(data):
    return sha256(data).hexdigest()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--driver", type=Path, help="Compiled macOS or Windows folder conformance driver")
    parser.add_argument("--previous-driver", type=Path, help="Compiled Apricot macOS folder conformance driver")
    args = parser.parse_args()
    full = (FIXTURE / NAME).read_bytes()
    board = (FIXTURE / OWNER).read_bytes()
    identity = json.loads(full.splitlines()[0])["id"]
    with_query = full + OPAQUE
    baseline = b"".join(row for row in with_query.splitlines(keepends=True) if b'"kind":"savedQuery"' not in row)
    baseline = baseline.replace(b'"2.1"', b'"2.0"', 1)
    removed = baseline.replace(b'"2.0"', b'"2.1"', 1)
    updated = with_query.replace(b"Narrow Rails", b"Changed query name")
    rejected = {
        "opaque record": updated.replace(b"90071992547409919999999", b"90071992547409919999998"),
        "baseline rule": updated.replace(b"Rail minimum", b"Some other rule"),
        "renamed manifest": updated.replace(b"Saved Query Design", b"Changed name"),
        "unknown nested field": updated.replace(b'"columns":["width"]', b'"columns":["width"],"futureValue":true'),
        "new requirement": updated.replace(b'"name":"Saved Query Design"}',
            b'"name":"Saved Query Design","requires":["unavailable-preview-clause"]}'),
        "unsupported minor": updated.replace(b'"2.1"', b'"2.2"', 1),
        "unsupported major": updated.replace(b'"2.1"', b'"3.0"', 1),
        "downgrade": updated.replace(b'"2.1"', b'"2.0"', 1),
    }

    if args.driver is None:
        sys.path.insert(0, str(ROOT / "native/linux"))
        from folder_project import RootFolder, FolderError

        class SimulatedExit(Exception):
            pass

        def call(folder, action, request=None, fault=None):
            def interrupt(point):
                if point == fault:
                    raise SimulatedExit()
            with_root = RootFolder(folder, NAME, checkpoint=interrupt)
            replies = []
            try:
                if action == "recover":
                    with_root.recover()
                else:
                    plan = request["plan"]
                    if action == "stage-save":
                        result = with_root.stage_asset(request["ownerId"], request["mediaType"], data=request["attachment"])
                        plan = [dict(row, assetToken=result["assetToken"]) if row.get("assetToken") == "test-token" else row
                                for row in plan]
                    with_root.commit(identity, NAME, plan, replies.append)
                return 0, replies
            except SimulatedExit:
                return 1, replies
            except FolderError as error:
                return 1, [*replies, {"error":str(error)}]
            finally:
                with_root.close()
    def native(driver, folder, action, request=None, fault=None):
        environment = dict(os.environ)
        if fault:
            environment["WAFFLE_FOLDER_KILL"] = fault
        reply = subprocess.run([driver, folder, NAME, action], input=json.dumps(request or {}),
                               capture_output=True, text=True, timeout=25, env=environment)
        return reply.returncode, [json.loads(line) for line in reply.stdout.splitlines()]

    if args.driver is not None:
        def call(folder, action, request=None, fault=None):
            return native(args.driver, folder, action, request, fault)

    def request(before, after, before_root=()):
        return {"projectId":identity, "manifest":NAME, "plan":[*before_root, {
            "path":NAME, "expected":hashed(before), "text":after.decode("utf-8"),
        }]}

    def pdf_row(original, record, data, *, length=None):
        size = len(data) if length is None else length
        ref = {"sha256":hashed(data), "byteLength":size, "mediaType":"application/pdf"}
        line = json.dumps({"kind":"datasheetRef", "id":record, "value":{
            "title":"Test datasheet", "sha256":hashed(data), "byteLength":size, "asset":ref,
        }}, separators=(",", ":")).encode("utf-8")
        return original.replace(OPAQUE, line + b"\n" + OPAQUE)

    # In Darwin's test environment resolve the /var alias before opening the root.
    with tempfile.TemporaryDirectory(prefix="waffle-optional-metadata-") as scratch:
        folder = Path(scratch).resolve()
        manifest = folder / NAME
        manifest.write_bytes(baseline)
        (folder / OWNER).write_bytes(board)
        status, durable = call(folder, "commit", request(baseline, with_query), fault="before-install:0")
        assert status != 0 and durable and durable[0].get("saved"), (status, durable)
        assert manifest.read_bytes() == baseline
        for _ in range(2):
            assert call(folder, "recover")[0] == 0
        assert manifest.read_bytes() == with_query and manifest.read_bytes().endswith(OPAQUE)
        for label, malformed in rejected.items():
            status, receipt = call(folder, "commit", request(with_query, malformed))
            assert status != 0 and not any(row.get("saved") for row in receipt), (label, status, receipt)
            assert manifest.read_bytes() == with_query, label
        assert call(folder, "commit", request(with_query, updated))[0] == 0
        assert manifest.read_bytes() == updated
        assert call(folder, "commit", request(updated, removed))[0] == 0
        assert manifest.read_bytes() == removed
        assert call(folder, "commit", request(removed, with_query))[0] == 0
        assert manifest.read_bytes() == with_query

        first_pdf = b"%PDF-1.7\n% first transaction fixture\n%%EOF\n"
        first_id = "01a20135-9d5a-7000-8000-000000000008"
        first_path = "assets/" + hashed(first_pdf)
        first_inline = {"path":first_path, "expected":None, "data":b64encode(first_pdf).decode("ascii")}
        first_stage = {"path":first_path, "expected":None, "assetToken":"test-token"}
        with_pdf = pdf_row(with_query, first_id, first_pdf)
        selected = {"ownerId":identity, "mediaType":"application/pdf", "attachment":first_inline["data"]}
        fake_pdf = b"This is not a PDF."
        selected_without_owner = request(with_query, updated, [first_stage]) | selected
        invalid_assets = [
            ("asset alone", "commit", request(with_query, with_pdf) | {"plan":[first_inline]}),
            ("unchanged root", "commit", request(with_query, with_query, [first_inline])),
            ("undeclared asset", "commit", request(with_query, updated, [first_inline])),
            ("wrong declared length", "commit", request(with_query, pdf_row(with_query, first_id, first_pdf, length=1), [first_inline])),
            ("wrong immutable digest", "commit", request(with_query, with_pdf, [first_inline | {"path":"assets/" + "a"*64}])),
            ("non-PDF bytes", "commit", request(with_query, pdf_row(with_query, first_id, fake_pdf), [{
                "path":"assets/" + hashed(fake_pdf), "expected":None, "data":b64encode(fake_pdf).decode("ascii"),
            }])),
            ("text transport", "commit", request(with_query, with_pdf, [{
                "path":first_path, "expected":None, "text":first_pdf.decode("ascii"),
            }])),
            ("wrong selected owner", "stage-save", request(with_query, with_pdf, [first_stage]) | selected | {"ownerId":"other"}),
            ("unattached selection", "stage-save", selected_without_owner),
            ("opaque row modified", "commit", request(with_query, with_pdf.replace(b"90071992547409919999999", b"4"), [first_inline])),
            ("known document removed", "commit", request(with_query, b"".join(
                line for line in with_pdf.splitlines(keepends=True) if b'"kind":"document"' not in line
            ), [first_inline])),
        ]
        for label, action, invalid in invalid_assets:
            status, receipt = call(folder, action, invalid)
            assert status != 0 and not any(row.get("saved") for row in receipt), (label, status, receipt)
            assert manifest.read_bytes() == with_query and not (folder / first_path).exists(), label

        status, durable = call(folder, "stage-save", request(with_query, with_pdf, [first_stage]) | selected, fault="before-install:0")
        assert status != 0 and durable and durable[0].get("saved"), (status, durable)
        assert manifest.read_bytes() == with_query and not (folder / first_path).exists()
        assert call(folder, "recover")[0] == 0
        assert manifest.read_bytes() == with_pdf and (folder / first_path).read_bytes() == first_pdf

        second_pdf = b"%PDF-1.7\n% second transaction fixture\n%%EOF\n"
        second_path = "assets/" + hashed(second_pdf)
        both_pdfs = pdf_row(with_pdf, "01a20135-9d5a-7000-8000-000000000009", second_pdf)
        second = request(with_pdf, both_pdfs, [{
            "path":second_path, "expected":None, "data":b64encode(second_pdf).decode("ascii"),
        }])
        status, durable = call(folder, "commit", second, fault="before-install:1")
        assert status != 0 and durable and durable[0].get("saved"), (status, durable)
        assert manifest.read_bytes() == with_pdf and (folder / second_path).read_bytes() == second_pdf
        for _ in range(2):
            assert call(folder, "recover")[0] == 0
        assert manifest.read_bytes() == both_pdfs and manifest.read_bytes().endswith(OPAQUE)
        assert (folder / first_path).read_bytes() == first_pdf and (folder / second_path).read_bytes() == second_pdf
        assert (folder / OWNER).read_bytes() == board
        if args.previous_driver:
            status, receipt = native(args.previous_driver, folder, "commit", request(both_pdfs, both_pdfs.replace(
                b"Test datasheet", b"Old reader edit", 1)))
            assert status != 0 and not any(row.get("saved") for row in receipt), (status, receipt)
            edited = board.replace(b'"width":180000', b'"width":190000')
            status, receipt = native(args.previous_driver, folder, "commit", {"projectId":identity, "manifest":NAME, "plan":[{
                "path":OWNER, "expected":hashed(board), "text":edited.decode("utf-8"),
            }]})
            assert status == 0 and receipt and receipt[0].get("saved"), (status, receipt)
            assert (folder / OWNER).read_bytes() == edited and manifest.read_bytes() == both_pdfs
            assert (folder / first_path).read_bytes() == first_pdf and (folder / second_path).read_bytes() == second_pdf
    print("Optional manifest promotion, protected rows, PDF owner proofs, crash replay, update and removal passed")


if __name__ == "__main__":
    main()
