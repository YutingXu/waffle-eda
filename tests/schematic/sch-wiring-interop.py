#!/usr/bin/env python3
"""Verify a native wire split, junction and new branch using independent readers."""
import argparse
from collections import Counter
import os
from pathlib import Path
import re
import runpy
import subprocess
import tempfile

common = runpy.run_path(str((Path(__file__).parent / "../formats/altium-copy-interop.py")))


def topology(schematic):
    segments = Counter()
    for line in re.findall(r'^Wire Wire Line\n\s*(-?\d+\s+-?\d+\s+-?\d+\s+-?\d+)$', schematic, re.M):
        x, y, u, v = map(int, line.split())
        segments[tuple(sorted(((x, y), (u, v))))] += 1
    junctions = Counter(re.findall(r'^Connection ~ (\d+ \d+)$', schematic, re.M))
    return segments, junctions


def check(source, result):
    streams, n = common["compare_ole"](source, result, {"FileHeader"})
    old, new = (list(common["records"](s)) for s in streams["FileHeader"])
    assert n == 3 and len(old) == 335 and len(new) == 338
    assert old[0][0] == new[0][0] and old[0][1].replace(b"Weight=334", b"Weight=337") == new[0][1]
    changed = [(a, b) for a, b in zip(old[1:], new[1:]) if a != b]
    assert len(changed) == 1
    (old_flags, prior), (new_flags, edited) = changed[0]
    assert old_flags == new_flags == 0 and prior.replace(b"X2=490", b"X2=475") == edited
    assert b"X1=460|Y1=340" in prior
    extra = [dict(pair.split(b"=", 1) for pair in record.rstrip(b"\x00").split(b"|") if b"=" in pair) for _, record in new[-3:]]
    assert [r[b"RECORD"] for r in extra] == [b"27", b"29", b"27"]
    assert [r[b"IndexInSheet"] for r in extra] == [b"66", b"-1", b"67"]
    assert extra[0][b"X1"] == b"475" and extra[0][b"X2"] == b"490"
    assert extra[1][b"Location.X"] == b"475" and extra[1][b"Location.Y"] == b"340"
    assert extra[2][b"Y1"] == b"340" and extra[2][b"Y2"] == b"335"
    original_ids = {m for _, payload in old for m in re.findall(rb"\|UniqueID=([A-Z]{8})", payload)}
    generated = {extra[i][b"UniqueID"] for i in (0, 2)}
    assert len(generated) == 2 and not original_ids.intersection(generated)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--fixtures", required=True, type=Path)
    parser.add_argument("--dom", type=Path, help="Standalone LinkeDOM module, to verify a copy generated through actual editor controls")
    parser.add_argument("--node", default=os.environ.get("NODE", "node"))
    parser.add_argument("--altium2kicad", type=Path)
    args = parser.parse_args()
    if not __debug__:
        parser.error("Run with assertions enabled")
    source = args.fixtures / common["SCHEMATIC"]
    assert common["digest"](source) == common["DIGESTS"][common["SCHEMATIC"]]
    with tempfile.TemporaryDirectory() as temp:
        directory = Path(temp)
        edited = directory / "Edited.SchDoc"
        driver = "../editor/wire-edit-ui.cjs" if args.dom else "wire-edit.cjs"
        command = [args.node, str((Path(__file__).parent / driver)), "--fixtures", str(args.fixtures), "--write-copy", str(edited)]
        if args.dom:
            command.extend(["--dom", str(args.dom)])
        subprocess.run(command, check=True)
        check(source, edited)
        print("PASS olefile read all three streams, preserved every prior record except the header weight and shortened wire, and recovered all three new records")
        if args.altium2kicad:
            board = args.fixtures / common["BOARD"]
            original, _ = common["convert"](args.altium2kicad, directory / "original", source, board)
            result, _ = common["convert"](args.altium2kicad, directory / "result", edited, board)
            expected, expected_dots = topology(original)
            span = ((4600, 7600), (4900, 7600))
            assert expected[span] == 1
            del expected[span]
            expected.update([((4600,7600),(4750,7600)), ((4750,7600),(4900,7600)), ((4750,7600),(4750,7650))])
            expected_dots["4750 7600"] += 1
            assert topology(result) == (expected, expected_dots)
            assert common["component_fields"](result) == common["component_fields"](original)
            print("PASS independent Altium2KiCad conversion: 36 wire segments, added T junction, ten component/power symbols and all other wire coordinates verified")


if __name__ == "__main__":
    main()
