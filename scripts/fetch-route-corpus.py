#!/usr/bin/env python3
"""Fetch the routing evaluation corpus (tests/route-corpus/manifest.json) into a local cache.

The corpus is routed, permissively licensed open-hardware boards used only to evaluate Route
Suggestions against human routing (tests/pcb/route-suggest-eval.cjs --corpus). Nothing here is
committed: files go to ~/.cache/atrium-corpus (or ATRIUM_CORPUS), one fresh directory per
download, and each file is checked against the SHA-256 pinned in the manifest. Files are treated
as untrusted data: they are only parsed by Waffle's importers, never executed.

Requests are plain public HTTPS GETs with a generic user agent: no credentials, no identifying
headers.

Usage: scripts/fetch-route-corpus.py [--pin] [--only NAME ...]
  --pin   record the SHA-256 of downloaded files in the manifest (maintainers, when adding a board)
"""
import hashlib
import json
import os
from pathlib import Path
import shutil
import sys
import tempfile
import urllib.request

ROOT = Path(__file__).resolve().parents[1]
MANIFEST = ROOT / "tests" / "route-corpus" / "manifest.json"
CACHE = Path(os.environ.get("ATRIUM_CORPUS") or Path.home() / ".cache" / "atrium-corpus")
UA = "Mozilla/5.0 (compatible; corpus-fetch)"
LIMIT = 64 * 1024 * 1024


def get(url):
    req = urllib.request.Request(url, headers={"User-Agent": UA})
    with urllib.request.urlopen(req, timeout=120) as r:
        data = r.read(LIMIT + 1)
    if len(data) > LIMIT:
        raise RuntimeError("download larger than %d bytes: %s" % (LIMIT, url))
    return data


def main(argv):
    pin = "--pin" in argv
    only = set(argv[argv.index("--only") + 1:]) if "--only" in argv else None
    man = json.loads(MANIFEST.read_text(encoding="utf-8"))
    CACHE.mkdir(parents=True, exist_ok=True)
    changed = False
    for b in man["boards"]:
        if only and b["name"] not in only:
            continue
        dest = CACHE / ("%s-%s" % (b["name"], b["commit"][:10]))
        ok = dest.is_dir() and all((dest / f["path"].split("/")[-1]).is_file() and
                                   hashlib.sha256((dest / f["path"].split("/")[-1]).read_bytes()).hexdigest() == f.get("sha256") for f in b["files"])
        if ok:
            print("cached  %s" % b["name"])
            continue
        # A fresh, empty directory per download; moved into place only when every pin matches.
        tmp = Path(tempfile.mkdtemp(prefix="dl-", dir=CACHE))
        try:
            for f in b["files"]:
                url = "https://raw.githubusercontent.com/%s/%s/%s" % (b["repo"], b["commit"], f["path"])
                data = get(url)
                digest = hashlib.sha256(data).hexdigest()
                if f.get("sha256") and f["sha256"] != digest:
                    raise RuntimeError("%s: SHA-256 mismatch for %s" % (b["name"], f["path"]))
                if not f.get("sha256"):
                    if not pin:
                        raise RuntimeError("%s: %s has no pinned SHA-256 (run with --pin)" % (b["name"], f["path"]))
                    f["sha256"] = digest
                    changed = True
                f["bytes"] = len(data)
                (tmp / f["path"].split("/")[-1]).write_bytes(data)
            if dest.exists():
                shutil.rmtree(dest)
            tmp.rename(dest)
            print("fetched %s (%d files) -> %s" % (b["name"], len(b["files"]), dest))
        except Exception:
            shutil.rmtree(tmp, ignore_errors=True)
            raise
    if changed:
        MANIFEST.write_text(json.dumps(man, indent=2) + "\n", encoding="utf-8")
        print("pinned new hashes in", MANIFEST)
    print("cache:", CACHE)


if __name__ == "__main__":
    main(sys.argv[1:])
