#!/usr/bin/env python3
"""Independent format 2.0 framing proof. Uses only the standard library and disk fixtures."""

import hashlib
import io
import json
import re
import stat
import struct
import unittest
from decimal import Decimal
from pathlib import Path

ROOT = Path(__file__).parents[1] / "fixtures" / "format-2"
KINDS = {".waffle": "project", ".wpcb": "pcb", ".wsch": "schematic",
         ".wlib": "library", ".wdraw": "drawing", ".wpanel": "panel", ".wblock": "block"}
VERSION = re.compile(r"(0|[1-9][0-9]{0,3})\.(0|[1-9][0-9]{0,3})")


def indexed(pairs):
    record = {}
    for key, value in pairs:
        if key in record:
            raise ValueError("duplicate key")
        record[key] = value
    return record


def invalid_number(token):
    raise ValueError("invalid JSON number " + token)


def row(line):
    if not line.endswith(b"\n") or line.startswith(b"\xef\xbb\xbf"):
        raise ValueError("native UTF-8 line framing")
    value = json.loads(line.decode("utf-8"), object_pairs_hook=indexed,
                       parse_float=Decimal, parse_constant=invalid_number)
    if not isinstance(value, dict) or not all(isinstance(value.get(k), str) and value[k]
                                               for k in ("id", "kind")):
        raise ValueError("missing identity")
    value["id"].encode("utf-8")
    value["kind"].encode("utf-8")
    return value


def version(value):
    match = VERSION.fullmatch(value) if isinstance(value, str) else None
    if match is None:
        raise ValueError("invalid format version")
    return tuple(map(int, match.groups()))


def read(stream, kind):
    header_line = stream.readline(65_536)
    header = row(header_line)
    current = version(header.get("formatVersion"))
    subset = version(header["compatibleWith"]) if "compatibleWith" in header else None
    if current[0] < 2 or (current[0] > 2 and subset != (2, 0)):
        raise ValueError("unsupported format " + header["formatVersion"])
    if header["kind"] != kind:
        raise ValueError("suffix disagrees with owner kind")
    tokens = header.get("requires", [])
    if (not isinstance(tokens, list) or any(not isinstance(t, str) or not t for t in tokens)
            or len(set(tokens)) != len(tokens)):
        raise ValueError("invalid capabilities")
    minimums = header.get("readerRequires", {})
    if not isinstance(minimums, dict) or minimums.keys() - set(tokens):
        raise ValueError("invalid required reader versions")
    for minimum in minimums.values():
        version(minimum)
    if "continuation-parts-v1" in tokens:
        raise ValueError("unsupported continuation-parts-v1 in format " + header["formatVersion"])
    diagnostics = {token: minimums.get(token, header["formatVersion"]) for token in tokens}
    records = {}
    previous = b""
    for line in stream:
        decoded = row(line)
        identity = decoded["id"].encode("utf-8")
        if identity <= previous or decoded["id"] == header["id"]:
            raise ValueError("record order or repeated identity")
        previous = identity
        if decoded["kind"] == "netlabel":
            at = decoded.get("at")
            if not isinstance(at, list) or len(at) != 2 or any(type(n) is not int or
                    abs(n) > 9_007_199_254_740_991 for n in at):
                raise ValueError("net label requires integer nanometres")
        records[decoded["id"]] = (decoded, line)
    return header, header_line, records, diagnostics


def read_file(path):
    if not stat.S_ISREG(path.lstat().st_mode):
        raise ValueError("expected a regular native owner")
    with path.open("rb") as stream:
        return read(stream, KINDS[path.suffix])


class IndependentReader(unittest.TestCase):
    def test_durable_preset_members_and_rule_ids(self):
        folder = ROOT / "durable-preset"
        project, _, records, issues = read_file(folder / "Durable Preset.waffle")
        self.assertFalse(issues)
        self.assertEqual(project["formatVersion"], "2.0")
        board, _, _, issues = read_file(folder / "Board.wpcb")
        self.assertFalse(issues)
        self.assertEqual(board["formatVersion"], "2.0")
        self.assertEqual(records[board["id"]][0]["path"], "Board.wpcb")
        rules = [record for record, _ in records.values() if record["kind"] == "rule"]
        preset = [record for record in rules if "presetKey" in record["value"]]
        self.assertEqual(len(preset), 10)
        self.assertLess(len(preset), len(rules), "ordinary rules leave the preset key out")
        self.assertEqual(len({record["value"]["presetKey"] for record in preset}), len(preset))
        for record in preset:
            self.assertRegex(record["id"], r"^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$")
            self.assertEqual(record["id"], record["value"]["id"])
            self.assertTrue(record["value"]["presetKey"].startswith("fp-jlcpcb-2l-"))

    def test_workshop_members(self):
        folder = ROOT / "workshop"
        header, _, refs, _ = read_file(folder / "Reference.waffle")
        found = set()
        for ref, _ in refs.values():
            if ref["kind"] not in ("document", "library", "layoutBlock"):
                continue
            path = Path(ref["path"])
            self.assertFalse(path.is_absolute() or ".." in path.parts)
            member, _, _, diagnostics = read_file(folder / path)
            self.assertEqual(member["id"], ref["id"])
            root_major, root_minor = version(header["formatVersion"])
            major, minor = version(member["formatVersion"])
            self.assertEqual(major, root_major)
            self.assertLessEqual(minor, root_minor)
            self.assertFalse(diagnostics)
            found.add(member["kind"])
        self.assertEqual(found, {"schematic", "pcb", "library", "drawing", "panel", "block"})

    def test_golden_project_digest(self):
        folder = ROOT / "golden"
        _, manifest_head, refs, _ = read_file(folder / "Sensor Board.waffle")
        manifest = manifest_head + b"".join(raw for _, raw in refs.values())
        path = refs["s1"][0]["path"].encode("utf-8")
        _, member_head, records, _ = read_file(folder / path.decode("utf-8"))
        member = member_head + b"".join(raw for _, raw in records.values())
        self.assertEqual(records["n1"][0]["at"], [1_270_000, 2_540_000])
        frame = (b"WAFFLE-PROJECT-V1\0" + struct.pack(">Q", len(manifest)) + manifest
                 + struct.pack(">QI", 1, len(path)) + path + hashlib.sha256(member).digest())
        self.assertEqual(hashlib.sha256(frame).hexdigest(),
                         "0b1e6a5e9b241a9ffb2f1fd92fbafb656d1cd6f3f64e908c7c591d55c8135f64")

    def test_optional_project_metadata_and_unchanged_live_owners(self):
        folder = ROOT / "butter-project-metadata"
        path = folder / "Project Metadata.waffle"
        header, physical_header, records, diagnostics = read_file(path)
        self.assertEqual(header["formatVersion"], "2.1")
        self.assertNotIn("requires", header)
        self.assertFalse(diagnostics)
        self.assertEqual({record["kind"] for record, _ in records.values()}, {
            "document", "library", "savedQuery", "savedView", "slide", "link", "linkAnchor",
            "datasheetRef", "datasheetAnnotation",
        })
        by_kind = {record["kind"]: (record, raw) for record, raw in records.values()}
        entries = []
        for kind in ("document", "library"):
            ref, _ = by_kind[kind]
            member_path = folder / ref["path"]
            member, _, _, issues = read_file(member_path)
            self.assertEqual(member["formatVersion"], "2.0")
            self.assertEqual(member["id"], ref["id"])
            self.assertFalse(issues)
            entries.append((ref["path"].encode("utf-8"), hashlib.sha256(member_path.read_bytes()).digest()))
        frame = by_kind["slide"][0]["value"]["source"]
        view = by_kind["savedView"][0]
        query = by_kind["savedQuery"][0]
        datasheet = by_kind["datasheetRef"][0]
        annotation = by_kind["datasheetAnnotation"][0]["value"]
        self.assertEqual(frame, {"kind": "frame", "documentId": header["entryDocument"], "frameId": "input-frame"})
        self.assertEqual(view["value"]["camera"]["center"], [1_000_000, 2_500_000])
        self.assertEqual(view["value"]["camera"]["referenceScale"], 2)
        self.assertEqual(view["value"]["camera"]["scale"], {"$number": "1.5"})
        self.assertEqual(view["value"]["filter"]["scope"], {"savedQueryId": query["id"]})
        self.assertEqual(annotation["datasheetId"], datasheet["id"])
        self.assertNotIn("id", datasheet["value"])
        _, _, pins, _ = read_file(folder / by_kind["library"][0]["path"])
        self.assertIn(by_kind["linkAnchor"][0]["value"]["terminalId"], pins)

        body = b"".join(raw for _, raw in records.values())
        manifest = physical_header + body
        self.assertIn(b'"x-editor": { "marker":"Re\\u0076iew" }', by_kind["link"][1])
        # An older reader can edit the header while carrying unknown body lines verbatim.
        changed = physical_header.replace(b"Project Metadata", b"Renamed project") + body
        _, _, after, _ = read(io.BytesIO(changed), "project")
        self.assertEqual([raw for _, raw in after.values()], [raw for _, raw in records.values()])
        digest_frame = (b"WAFFLE-PROJECT-V1\0" + struct.pack(">Q", len(manifest)) + manifest
                        + struct.pack(">Q", len(entries)) + b"".join(
                            struct.pack(">I", len(name)) + name + digest for name, digest in sorted(entries)))
        index = json.loads((ROOT / "projects.json").read_text(encoding="utf-8"))
        recorded = next(row["sha256"] for row in index if row["directory"] == folder.name)
        self.assertEqual(hashlib.sha256(digest_frame).hexdigest(), recorded)

    def test_capabilities_are_checked_before_body(self):
        header = b'{"kind":"pcb","formatVersion":"2.0","id":"p","requires":["continuation-parts-v1"]}\n'
        stream = io.BytesIO(header + b"\xff")
        with self.assertRaisesRegex(ValueError, "continuation-parts-v1 in format 2.0"):
            read(stream, "pcb")
        self.assertEqual(stream.tell(), len(header))
        required = (b'{"kind":"pcb","formatVersion":"2.1","id":"p","readerRequires":{"exact":"2.4"},'
                    b'"requires":["exact","unmapped"]}\n')
        self.assertEqual(read(io.BytesIO(required), "pcb")[3], {"exact": "2.4", "unmapped": "2.1"})

    def test_raw_unknown_content_survives_an_edit(self):
        header = b'{"kind":"schematic","formatVersion":"2.1","id":"s","requires":[]}\r\n'
        known = b'{"kind":"netlabel","id":"a","at":[0,0],"text":"OLD","x-author": { "exact": 1e9999 }}\n'
        opaque = b' { "id":"b", "kind":"next", "value": "\\u0041" }\r\n'
        _, _, records, _ = read(io.BytesIO(header + known + opaque), "schematic")
        edit = records["a"][1].replace(b'"text":"OLD"', b'"text":"NEW"')
        updated = header + edit + records["b"][1]
        _, saved_head, saved, _ = read(io.BytesIO(updated), "schematic")
        self.assertEqual(saved_head, header)
        self.assertEqual(saved["b"][1], opaque)
        self.assertEqual(saved["a"][1].replace(b'"text":"NEW"', b'"text":"OLD"'), known)
        self.assertEqual(saved["a"][0]["text"], "NEW")


if __name__ == "__main__":
    unittest.main()
