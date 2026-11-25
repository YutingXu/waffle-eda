#!/usr/bin/env python3
"""Compare ODB++ against an independently generated, byte-pinned IPC-D-356 netlist."""

import argparse
from hashlib import sha256
import json
from pathlib import Path
from runpy import run_path
import subprocess
import tempfile


HERE = Path(__file__).resolve().parents[1]
PUBLIC = run_path(str(HERE / "formats/odb-public.py"))
SOURCE = "https://raw.githubusercontent.com/thisis-romar/drawing-corpus/81f10d211bd24e01ba8852a2b8fbff453eff2c7d/sources/kicad-demos/video/"
FILES = {
    "video.kicad_pcb": "f620675158ddd5c61e5ce9e15f4c92b230ae1df1cbcec6c502b8ce266e4007ea",
    "_generated/video.d356": "8d350cca0ce0be75a7f90ca039955c08a3f554906a5bc6ba556f1a3b96189b44",
}


def compare(root, fetch_missing):
    from fetch import fetch

    for name, expected in FILES.items():
        file = root / Path(name).name
        if fetch_missing:
            file.write_bytes(fetch(SOURCE + name))
        assert sha256(file.read_bytes()).hexdigest() == expected, f"Changed upstream fixture {file.name}"
    root_dir = PUBLIC["ROOT"]
    modules = [(name, str(file)) for name, file in PUBLIC["resolve"](PUBLIC["MODULES"])]
    modules.extend((name, str(root_dir / "app" / (name + ".js"))) for name in PUBLIC["TRANSLATORS"])
    subprocess.run(["node", str(HERE / "formats/odb-output.cjs"), "--ipc356"], cwd=root_dir, check=True, text=True, timeout=180,
                   input=json.dumps({"directory": str(root), "modules": modules}))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--fixtures", type=Path, help="Read the two existing external files from this directory")
    args = parser.parse_args()
    if args.fixtures:
        compare(args.fixtures.resolve(), False)
    else:
        with tempfile.TemporaryDirectory(prefix="waffle-ipc356-reference-") as scratch:
            compare(Path(scratch), True)


if __name__ == "__main__":
    main()
