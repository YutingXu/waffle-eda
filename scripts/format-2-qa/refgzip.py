"""Produce the specified deterministic reference bytes for benchmark input preparation."""
import struct
from pathlib import Path
import sys
import zlib

if zlib.ZLIB_RUNTIME_VERSION != "1.2.12":
    raise SystemExit("The input oracle requires the spec's stock zlib 1.2.12 runtime")
raw = Path(sys.argv[1]).read_bytes()
encoder = zlib.compressobj(9, zlib.DEFLATED, -15, 8, zlib.Z_DEFAULT_STRATEGY)
bits = encoder.compress(raw) + encoder.flush(zlib.Z_FINISH)
member = bytes.fromhex("1f8b08000000000002ff") + bits + struct.pack("<II", zlib.crc32(raw), len(raw) & 0xffffffff)
assert zlib.decompress(member, 31) == raw
Path(sys.argv[2]).write_bytes(member)
