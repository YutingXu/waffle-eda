"""Prepare frozen benchmark cases, verifying all public hashes and keeping private metadata local."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import subprocess

from cohort import input_table

HERE = Path(__file__).resolve().parent


def main():
    p=argparse.ArgumentParser(description=__doc__)
    p.add_argument("--product",type=Path,required=True)
    p.add_argument("--snapshots",type=Path,required=True)
    p.add_argument("--baseline-inputs",type=Path,required=True,help="Pinned input TSV supplied by the caller")
    p.add_argument("--target",type=Path,required=True)
    p.add_argument("--node",default="node")
    p.add_argument("--case",action="append")
    args=p.parse_args()
    args.target.mkdir(parents=True,exist_ok=True,mode=0o700)
    inputs=input_table(args.baseline_inputs)
    receipt=args.target/"receipts.json"
    results=json.loads(receipt.read_text()) if receipt.exists() else {}
    for which in args.case or inputs:
        info=inputs[which]
        original=args.snapshots/(which + ".waffle")
        frozen=original.read_bytes()
        expected=json.loads((args.snapshots/(which + ".input.json")).read_bytes())["sha256"] if which=="approved" else info["snapshot_sha256"]
        if len(frozen)!=int(info["file_bytes"]) or hashlib.sha256(frozen).hexdigest()!=expected:
            raise RuntimeError("The frozen input has the wrong length or checksum")
        directory=args.target/which
        directory.mkdir(mode=0o700)
        run=subprocess.run([args.node,str(HERE/"prepare.cjs"),str(args.product),str(original),str(directory/"design"),
                            str(directory/"options.json"),"private" if which=="approved" else "public"],
                           capture_output=True)
        if run.returncode:
            results[which]={"error":run.stderr.decode().strip()}
        else:
            results[which]=json.loads(run.stdout)
        print(which, json.dumps(results[which]),flush=True)
        receipt.write_text(json.dumps(results,indent=2)+"\n")
    return 1 if any("error" in r for r in results.values()) else 0


if __name__=="__main__":
    raise SystemExit(main())
