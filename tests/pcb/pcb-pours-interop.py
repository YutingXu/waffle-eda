"""Compare decoded canvas geometry with raw OLE Regions6 subpolygon contours.
Run pcb-pours.cjs --fixtures DIR --dump file.json first. Requires olefile.
"""
import argparse
import json
import struct
from pathlib import Path

import olefile


def records(stream):
    position = 0
    while position < len(stream):
        assert stream[position] == 11
        size, = struct.unpack_from("<I", stream, position + 1)
        position += 5
        yield stream[position:position + size]
        position += size
    assert position == len(stream)


def last_pour(file):
    result = []
    with olefile.OleFileIO(file) as board:
        data = board.openstream("Regions6/Data").read()
        for raw in records(data):
            polygon, owner = struct.unpack_from("<HH", raw, 5)
            if polygon == 65535 or owner != 65535 or raw[0] not in [1, 32]:
                continue
            size, = struct.unpack_from("<I", raw, 18)
            properties = raw[22:22 + size].rstrip(b"\0").split(b"|")
            if b"KIND=0" not in properties or b"ISSHAPEBASED=FALSE" not in properties:
                continue
            offset = 22 + size
            rings = []
            holes, = struct.unpack_from("<H", raw, 14)
            for _ in range(1 + holes):
                vertices, = struct.unpack_from("<I", raw, offset)
                offset += 4
                pairs = list(struct.iter_unpack("<dd", raw[offset:offset + 16 * vertices]))
                assert vertices >= 3 and len(pairs) == vertices
                rings.append([axis for x, y in pairs for axis in (x * .00000254, -y * .00000254)])
                offset += 16 * vertices
            assert offset == len(raw)
            result.append(("Top" if raw[0] == 1 else "Bottom", rings))
    return result


def bounds(ring):
    xs, ys = ring[::2], ring[1::2]
    return [min(xs), min(ys), max(xs), max(ys)]


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("fixtures", type=Path)
    parser.add_argument("dump", type=Path)
    args = parser.parse_args()
    for name, actual in json.loads(args.dump.read_text()).items():
        expected = last_pour(args.fixtures / name)
        assert len(expected) == len(actual), name
        points = 0
        for (layer, rings), region in zip(expected, actual):
            assert region["layer"] == layer
            assert region["bounds"] == bounds(rings[0])
            assert len(rings) == len(region["rings"])
            for source, projected in zip(rings, region["rings"]):
                assert bounds(source) == bounds(projected)
                assert source == projected
                points += len(source) // 2
        print(f"PASS {name}: {points} vertices and all outer and interior extents match the native compound file.")
