#!/usr/bin/env python3
"""Time the Mac app's 3D view on two hash-pinned populated public boards."""
import argparse
import csv
import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
from uuid import UUID

sys.dont_write_bytecode = True
HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE / "format-baseline"))
from native import native_host
from sources import ROOT, external

CASES = ("pidp11-io-expander", "snes-tap")
parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument("--output", type=Path, required=True, help="External scratch directory for numeric receipts")
parser.add_argument("--case", action="append", choices=CASES)
parser.add_argument("--repeats", type=int, default=3)
parser.add_argument("--steps", type=int, default=180, help="Native input samples per action at 120 Hz")
parser.add_argument("--snapshots", type=Path, required=True, help="External frozen native files from the 1.5 format benchmark")
parser.add_argument("--baseline-inputs", type=Path, required=True, help="Pinned input TSV supplied by the caller")
parser.add_argument("--product-checkout", type=Path, default=ROOT, help="Clean product checkout to build with this probe")
parser.add_argument("--store", choices=("default", "ephemeral"), default="default", help="WebKit website data store in the benchmark app")
parser.add_argument("--allow-missing-models", action="store_true", help="Measure a failed-component diagnostic control")
args = parser.parse_args()
if not 1 <= args.repeats <= 20 or not 20 <= args.steps <= 600:
    parser.error("Choose 1–20 repetitions and 20–600 input samples.")
os.umask(0o077)
output = external(args.output)
output.mkdir(parents=True, exist_ok=True)
driver = HERE / "view3d-macos"
product = args.product_checkout.resolve()


def git(*arguments):
    return subprocess.check_output(["git", *arguments], cwd=product, text=True).strip()


def frozen_bytes(case, path, expected):
    raw = path.read_bytes()
    if hashlib.sha256(raw).hexdigest() != expected and case == "snes-tap":
        # A fresh original import assigns UUIDv4s to 21 unplaced public library definitions.
        # Restore only their recorded identity tokens and verify every resulting byte below.
        library = json.loads(raw)["library"]
        ids = json.loads((driver / "snes-library-ids.json").read_text())
        for index, recorded in ids.items():
            current = library[int(index)]["id"]
            token = json.dumps(current).encode()
            if UUID(current).version != 4 or raw.count(token) != 1:
                raise ValueError("Unexpected or referenced SNES library identity")
            raw = raw.replace(token, json.dumps(recorded).encode())
    if hashlib.sha256(raw).hexdigest() != expected:
        raise ValueError("Input bytes differ from the frozen public baseline: " + case)
    return raw


if git("status", "--porcelain", "--", "app", "native"):
    parser.error("Commit the product app and native sources before collecting a hardware receipt.")
stamp = {key: git("rev-parse", ref) for key, ref in
         (("commit", "HEAD"), ("appTree", "HEAD:app"), ("nativeTree", "HEAD:native"))}
with native_host(probe_file=driver / "probe.js", input_driver=driver / "input.swift",
                 product_root=product, ephemeral=args.store == "ephemeral") as exe:
    for case in args.case or CASES:
        with args.baseline_inputs.open(encoding="utf-8") as f:
            meta = next(row for row in csv.DictReader(f, delimiter="\t") if row["case"] == case)
        snapshot = external(args.snapshots) / (case + ".waffle")
        contents = frozen_bytes(case, snapshot, meta["snapshot_sha256"])
        rows = []
        for i in range(args.repeats):
            with tempfile.TemporaryDirectory(prefix="waffle-viewer-trial-") as trial_dir:
                work = Path(trial_dir)
                (work / "project.waffle").write_bytes(contents)
                (work / "trial.json").write_text(json.dumps({"steps": args.steps, "allowMissing": args.allow_missing_models}))
                result = subprocess.run([str(exe), str(work)], capture_output=True, timeout=210,
                                        env={**os.environ, "WAFFLE_VIEW3D_STORE": args.store})
                if result.returncode or not result.stdout.strip():
                    raise RuntimeError(case + ": " + result.stderr.decode(errors="replace")[-1500:])
                rows.append(json.loads(result.stdout.decode().splitlines()[-1]))
            print(case, i + 1, "verified", flush=True)
            (output / (case + ".json")).write_text(json.dumps({"case": case, "snapshotSha256": meta["snapshot_sha256"], "sourceRevision": meta["source_rev"],
                "product": stamp, "store": args.store, "runs": rows}, indent=2))
