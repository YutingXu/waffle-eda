#!/usr/bin/env python3
"""Verify the immutable pre-release project inventory and the production refusal for each file."""
import argparse
import hashlib
import json
from pathlib import Path
import sys

ROOT = Path(__file__).resolve().parents[1]
CORPUS = ROOT / "tests/fixtures/compat"
sys.path.insert(0, str(ROOT / "native"))
from obsolete_project import CODE, NOTE, ObsoleteProject, reject_path


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--check", action="store_true")
    parser.parse_args()
    files = sorted(p.name for p in (CORPUS / "projects").iterdir() if p.suffix in (".waffle", ".atrium"))
    index = json.loads((CORPUS / "index.json").read_text())["projects"]
    guard = json.loads((CORPUS / "guard.json").read_text())["files"]
    if files != json.loads((CORPUS / "files.json").read_text()) or sorted(row["file"] for row in index) != files:
        sys.exit("The pre-release fixture inventory is incomplete or contains duplicates.")
    for row in index:
        path = CORPUS / "projects" / row["file"]
        if row["expect"] != CODE or hashlib.sha256(path.read_bytes()).hexdigest() != guard[path.name]:
            sys.exit("The pinned pre-release fixture or its expected diagnostic changed: " + path.name)
        try:
            reject_path(path)
        except ObsoleteProject as error:
            if error.code != CODE or str(error) != NOTE:
                raise
        else:
            sys.exit("A pre-release fixture was accepted: " + path.name)
    print("ok: %d byte-identical pre-release fixtures rejected" % len(files))


if __name__ == "__main__":
    main()
