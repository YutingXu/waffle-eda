#!/usr/bin/env python3
"""Print the Waffle extension-index entry for a package (docs/extension-registry.md).

    python3 scripts/registry-entry.py my-ext-1.0.0.zip --download https://example.org/my-ext-1.0.0.zip \
        [--source https://github.com/me/my-ext] [--license MIT]

Reads waffle-extension.json from a .zip (optionally inside one top-level folder) or a
.waffle-extension bundle, and prints a JSON entry with the package's SHA-256 and size.
Paste it into the "extensions" list of your index.

The index uses the JSON integer 1 for v1 manifests that declare 1, "1" or "^1",
or omit the declaration. Other declarations retain their existing serialization.
"""
import argparse
import hashlib
import json
import sys
import zipfile
from pathlib import Path


def manifest_of(path, data):
    if data[:2] == b"PK":
        with zipfile.ZipFile(path) as z:
            names = [n for n in z.namelist() if n == "waffle-extension.json" or n.endswith("/waffle-extension.json")]
            if not names:
                sys.exit("registry-entry: the package has no waffle-extension.json")
            return json.loads(z.read(min(names, key=len)))
    return json.loads(data)["manifest"]


def published_api_version(manifest):
    value = manifest.get("apiVersion", 1)
    if value in ("1", "^1"):
        return 1
    return value


def main():
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("package")
    ap.add_argument("--download", required=True, help="https URL the package will be served from (or a path relative to the index)")
    ap.add_argument("--source", help="https URL of the source repository")
    ap.add_argument("--license", help="SPDX licence identifier")
    a = ap.parse_args()
    path = Path(a.package)
    data = path.read_bytes()
    m = manifest_of(path, data)
    entry = {
        "id": m["id"], "name": m["name"], "publisher": m.get("publisher") or m["id"].split(".")[0], "version": m["version"],
        "apiVersion": published_api_version(m), "description": m.get("description", ""), "permissions": m.get("permissions", []),
        "download": a.download, "size": len(data), "sha256": hashlib.sha256(data).hexdigest(),
        "source": a.source, "license": a.license, "signature": None,
    }
    print(json.dumps({k: v for k, v in entry.items() if v is not None or k == "signature"}, indent=2, ensure_ascii=False))


if __name__ == "__main__":
    main()
