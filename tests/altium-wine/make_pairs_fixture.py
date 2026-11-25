#!/usr/bin/env python3
"""Rebuild tests/fixtures/altium/pairs-xsignals/PairsXSignals.PcbDoc with Altium Designer.

Opt-in, macOS Wine only. This generator saves a board with differential pairs, xSignals and their classes.

Designer must already be running and idle. The script runs MakePairsFixture.pas in
that window through the RunDesigner.exe helper installed with "Open in Altium",
normalizes the saved file (see normalize()), then asks Designer to reopen the
normalized copy and checks what it reads back.
"""
import argparse
import os
from pathlib import Path, PureWindowsPath
import re
import shutil
import struct
import subprocess
import sys

HERE = Path(__file__).resolve().parent
FIXTURE = HERE.parent / "fixtures/altium/pairs-xsignals/PairsXSignals.PcbDoc"
STAGE = "AtriumPairsFixture"
EXPECTED = [
    "class HS_PAIRS kind=6 members=2",
    "class POWER kind=0 members=2",
    "class HS_NETS kind=0 members=6",
    "class USB_XSIGNALS kind=10 members=2",
    "class PCIE_TX_XSIGNALS kind=10 members=2",
    "diffpair PCIE_TX",
    "diffpair USB",
    "pads=19",
    "rule HS_DiffPairs scope=InDifferentialPairClass('HS_PAIRS')",
    "rule PCIE_TX_MatchedLength scope=InxSignalClass('PCIE_TX_XSIGNALS')",
    "xsignals=4",
    "xsignal[0] PCIE_TX_P_XS",
    "xsignal[1] PCIE_TX_N_XS",
    "xsignal[2] USB_DP_XS",
    "xsignal[3] USB_DM_XS",
]

END = 0xFFFFFFFE
FREE = 0xFFFFFFFF


def read_cfb(data):
    """Return [(path tuple, bytes or None for a storage)] in directory order."""
    if data[:8] != bytes.fromhex("d0cf11e0a1b11ae1"):
        raise ValueError("not a compound file")
    ss = 1 << struct.unpack_from("<H", data, 30)[0]
    mss = 1 << struct.unpack_from("<H", data, 32)[0]
    nfat, dir0, _, cutoff, minifat0, nmini, difat0, _ = struct.unpack_from("<8I", data, 44)
    sector = lambda i: data[(i + 1) * ss:(i + 2) * ss]
    difat = list(struct.unpack_from("<109I", data, 76))
    s = difat0
    while s < 0xFFFFFFFA:
        block = sector(s)
        difat += struct.unpack_from("<%dI" % (ss // 4 - 1), block)
        s = struct.unpack_from("<I", block, ss - 4)[0]
    fat = []
    for f in difat[:nfat]:
        fat += struct.unpack("<%dI" % (ss // 4), sector(f))

    def chain(s):
        out = b""
        while s < 0xFFFFFFFA:
            out += sector(s)
            s = fat[s]
        return out

    raw = chain(dir0)
    entries = []
    for o in range(0, len(raw), 128):
        e = raw[o:o + 128]
        n = struct.unpack_from("<H", e, 64)[0]
        left, right, child = struct.unpack_from("<3I", e, 68)
        start, size = struct.unpack_from("<IQ", e, 116)
        entries.append((e[:max(0, n - 2)].decode("utf-16le"), e[66], left, right, child, start, size))
    ministream = chain(entries[0][5])
    minifat = struct.unpack("<%dI" % (len(chain(minifat0)) // 4), chain(minifat0)) if nmini else ()

    def payload(start, size):
        if size >= cutoff:
            return chain(start)[:size]
        out = b""
        while start < 0xFFFFFFFA:
            out += ministream[start * mss:(start + 1) * mss]
            start = minifat[start]
        return out[:size]

    items = []

    def walk(i, parent):
        if i == FREE:
            return
        name, kind, left, right, child, start, size = entries[i]
        walk(left, parent)
        if kind == 1:
            items.append((parent + (name,), None))
            walk(child, parent + (name,))
        elif kind == 2:
            items.append((parent + (name,), payload(start, size)))
        walk(right, parent)

    walk(entries[0][4], ())
    return items


def write_cfb(items):
    """Write a version 3 compound file (512-byte sectors, 64-byte mini sectors)."""
    ss, mss, cutoff = 512, 64, 4096
    index = {(): 0}
    nodes = [dict(name="Root Entry", kind=5, data=b"", children=[])]
    for path, data in items:
        nodes.append(dict(name=path[-1], kind=1 if data is None else 2, data=data or b"", children=[]))
        index[path] = len(nodes) - 1
        nodes[index[path[:-1]]]["children"].append(len(nodes) - 1)
    for node in nodes:
        node.update(left=FREE, right=FREE, child=FREE, start=0, size=0)

    def tree(ids):
        # Balanced search tree in CFB name order. All nodes are written black,
        # which Wine's ole32 (Designer), SheetJS CFB and olefile accept.
        if not ids:
            return FREE
        mid = len(ids) // 2
        nodes[ids[mid]]["left"] = tree(ids[:mid])
        nodes[ids[mid]]["right"] = tree(ids[mid + 1:])
        return ids[mid]

    for node in nodes:
        node["child"] = tree(sorted(node["children"], key=lambda i: (len(nodes[i]["name"]), nodes[i]["name"].upper())))

    pad = lambda b, unit=ss: b + b"\0" * (-len(b) % unit)
    mini, minifat, big = b"", [], []
    for node in nodes[1:]:
        data = node["data"]
        node["size"] = len(data)
        if node["kind"] != 2:
            continue
        if not data:
            node["start"] = END
        elif len(data) < cutoff:
            first, count = len(mini) // mss, -(-len(data) // mss)
            mini += pad(data, mss)
            minifat += list(range(first + 1, first + count)) + [END]
            node["start"] = first
        else:
            big.append(node)

    entry_count = len(nodes) + (-len(nodes) % (ss // 128))
    minifat_bytes = struct.pack("<%dI" % len(minifat), *minifat)
    minifat_bytes += b"\xff" * (-len(minifat_bytes) % ss)
    blocks = [("dir", entry_count * 128)] + [(node, len(node["data"])) for node in big]
    if mini:
        blocks.append((nodes[0], len(mini)))
    if minifat:
        blocks.append(("minifat", len(minifat_bytes)))
    data_sectors = sum(-(-size // ss) for _, size in blocks)
    nfat = 1
    while nfat * (ss // 4) < data_sectors + nfat:
        nfat += 1
    if nfat > 109:
        raise ValueError("file too large for this writer")
    fat, starts, cursor = [0xFFFFFFFD] * nfat, {}, nfat
    for owner, size in blocks:
        count = -(-size // ss)
        starts[owner if isinstance(owner, str) else id(owner)] = cursor
        if not isinstance(owner, str):
            owner["start"] = cursor
        fat += list(range(cursor + 1, cursor + count)) + [END]
        cursor += count
    nodes[0]["size"] = len(mini)
    if not mini:
        nodes[0]["start"] = END
    fat += [FREE] * (-len(fat) % (ss // 4))

    directory = b""
    for node in nodes:
        name = node["name"].encode("utf-16le") + b"\0\0"
        e = bytearray(128)
        e[:len(name)] = name
        struct.pack_into("<HBB3I", e, 64, len(name), node["kind"], 1, node["left"], node["right"], node["child"])
        struct.pack_into("<IQ", e, 116, node["start"], node["size"])
        directory += bytes(e)
    for _ in range(entry_count - len(nodes)):
        e = bytearray(128)
        struct.pack_into("<3I", e, 68, FREE, FREE, FREE)
        directory += bytes(e)

    body = b""
    for owner, _ in blocks:
        if owner == "dir":
            body += pad(directory)
        elif owner == "minifat":
            body += minifat_bytes
        elif owner is nodes[0]:
            body += pad(mini)
        else:
            body += pad(owner["data"])
    header = bytearray(ss)
    header[:8] = bytes.fromhex("d0cf11e0a1b11ae1")
    struct.pack_into("<HHHHH", header, 24, 0x3E, 3, 0xFFFE, 9, 6)
    struct.pack_into("<8I", header, 44, nfat, starts["dir"], 0, cutoff,
                     starts.get("minifat", END), len(minifat_bytes) // ss, END, 0)
    struct.pack_into("<109I", header, 76, *(list(range(nfat)) + [FREE] * (109 - nfat)))
    return bytes(header) + struct.pack("<%dI" % len(fat), *fat) + body


def records(stream):
    """Split a stream of length-prefixed text records."""
    out, i = [], 0
    while i < len(stream):
        length = struct.unpack_from("<I", stream, i)[0]
        out.append(stream[i + 4:i + 4 + length])
        i += 4 + length
    return out


def normalize(data):
    """Drop machine state that Designer adds depending on the session.

    - EmbeddedFonts6: once Designer has rendered a TrueType font in the session,
      saves embed it (Arial, about 0.4 MB) although every text here is a stroke
      text. The first save in a fresh session wrote this stream empty.
    - Board6 2DCONFIGFULLFILENAME: points into the Windows user's profile.
    """
    items = []
    for path, payload in read_cfb(data):
        if path == ("EmbeddedFonts6", "Data"):
            payload = b""
        elif path == ("EmbeddedFonts6", "Header"):
            payload = struct.pack("<I", 0)
        elif path == ("Board6", "Data"):
            payload = b"".join(struct.pack("<I", len(r)) + r for r in
                               (re.sub(rb"2DCONFIGFULLFILENAME=[^|\r\0]*", b"2DCONFIGFULLFILENAME=", r)
                                for r in records(payload)))
        items.append((path, payload))
    return write_cfb(items)


def run_designer(script, procedure, stage, guest, timeout):
    root = Path(os.environ.get("ALTIUM_WINE_ROOT", Path.home() / "AltiumWineLab/kit-11.16"))
    prefix = root / "volume/prefix"
    wine = root / "wine-patched/Wine Staging.app/Contents/Resources/wine/bin/wine"
    runner = Path.home() / "Applications/Open in Altium.app/Contents/Resources/RunDesigner.exe"
    x2 = os.environ.get("ALTIUM_X2", r"C:\Program Files\Altium\AD26\X2.EXE")
    text = script.read_text("ascii").replace("@RUN_DIRECTORY@", str(guest))
    (stage / script.name).write_bytes(text.replace("\n", "\r\n").encode("ascii"))
    (stage / "result.txt").unlink(missing_ok=True)
    command = f"-RScriptingSystem:RunScriptFile(FileName={guest / script.name}|ProcName={procedure})"
    env = dict(os.environ, WINEPREFIX=str(prefix), WINEDEBUG="-all")
    result = subprocess.run([wine, runner, x2, command, str(guest / "result.txt"), str(timeout * 1000), "--existing"],
                            env=env, cwd=prefix / "drive_c", stdin=subprocess.DEVNULL,
                            capture_output=True, timeout=timeout + 20)
    if result.returncode:
        raise RuntimeError(result.stdout.decode(errors="replace").strip() or "Designer check failed")
    raw = (stage / "result.txt").read_bytes()
    codec = "utf-16" if raw[:2] in (b"\xff\xfe", b"\xfe\xff") else "utf-8-sig"
    return raw.decode(codec).splitlines()


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--out", type=Path, default=FIXTURE)
    parser.add_argument("--normalize-only", type=Path, help="normalize an existing PcbDoc into --out")
    parser.add_argument("--timeout", type=int, default=150)
    args = parser.parse_args()
    if args.normalize_only:
        args.out.write_bytes(normalize(args.normalize_only.read_bytes()))
        return 0
    root = Path(os.environ.get("ALTIUM_WINE_ROOT", Path.home() / "AltiumWineLab/kit-11.16"))
    stage = root / "volume/prefix/drive_c" / STAGE
    guest = PureWindowsPath("C:/", STAGE)
    shutil.rmtree(stage, ignore_errors=True)
    stage.mkdir()
    script = HERE / "MakePairsFixture.pas"
    log = run_designer(script, "MakePairsFixture", stage, guest, args.timeout)
    print("\n".join(log))
    if not any(line.startswith("save ") and "-> True" in line for line in log):
        print("FAIL Designer did not save the board", file=sys.stderr)
        return 1
    built = stage / "PairsXSignals.PcbDoc"
    built.write_bytes(normalize(built.read_bytes()))
    # Ignore Designer's built-in classes (layers, components, pads, polygons, superclasses).
    readback = [line for line in run_designer(script, "VerifyPairsFixture", stage, guest, args.timeout)
                if line != "done" and not line.startswith("class All ")
                and not re.match(r"class .* kind=(1|2|3|4|7|11|12) ", line)]
    if readback != EXPECTED:
        print("FAIL Designer read back:\n" + "\n".join(readback), file=sys.stderr)
        return 1
    args.out.parent.mkdir(parents=True, exist_ok=True)
    shutil.copyfile(built, args.out)
    shutil.rmtree(stage)
    print(f"PASS wrote {args.out}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
