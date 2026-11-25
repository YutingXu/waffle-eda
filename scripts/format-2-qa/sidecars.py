#!/usr/bin/env python3
"""Measure copied and verified-Git retention for exact R4 source sets using the product helper."""
import argparse
import json
from pathlib import Path
import subprocess
import sys
import tempfile

from cohort import input_table
from gitmetrics import Repo

HERE=Path(__file__).resolve().parent
SOURCE_DIR=HERE.parent/"format-baseline"
sys.path.insert(0,str(SOURCE_DIR))
from sources import selection, fidelity, materialize_choices


def main():
    p=argparse.ArgumentParser(description=__doc__)
    p.add_argument("--product",type=Path,required=True)
    p.add_argument("--scratch",type=Path,required=True)
    p.add_argument("--baseline-inputs",type=Path,required=True,help="Pinned input TSV supplied by the caller")
    p.add_argument("--out",type=Path,required=True)
    p.add_argument("--node",default="node")
    p.add_argument("--case",action="append")
    p.add_argument("--approved-export",type=Path)
    p.add_argument("--fidelity-cache",type=Path,default=fidelity.DEFAULT_CACHE)
    p.add_argument("--history-cache",type=Path,default=Path.home()/".cache/waffle/project-history")
    a=p.parse_args()
    a.scratch.mkdir(parents=True,exist_ok=True,mode=0o700)
    table=input_table(a.baseline_inputs)
    results=json.loads(a.out.read_text()) if a.out.exists() else {}
    for case in a.case or table:
        if case=="approved" and not a.approved_export:
            continue
        selected,_=selection(case,a)
        total=sum(map(len,selected.values()))
        assert total==int(table[case]["source_bytes"]) and len(selected)==int(table[case]["sources"])
        if case=="synthetic":
            results[case]={"originalBytes":0,"sourceBindings":0,"sidecarBytes":0}
        else:
            with tempfile.TemporaryDirectory(dir=a.scratch) as loc:
                root=Path(loc)
                choices, destination = materialize_choices(root, selected, "The source set contains a nonportable basename")
                # Real, separately committed working files in this isolated repository form the
                # spec's all-tracked condition. The originals that supplied them remain untouched.
                Repo(root).initialize()
                q={"translator":"kicad" if case in ("corne","lily58") else "altium","files":choices,
                   "destination":str(destination)}
                run=subprocess.run([a.node,str(a.product/"scripts/format-baseline/import-sidecars.cjs")],
                                   input=json.dumps(q).encode(),capture_output=True,timeout=180)
                if run.returncode:
                    results[case]={"error":"The production source binding helper failed."}
                else:
                    out=json.loads(run.stdout)
                    assert out["verifiedWorktree"]["gitBindings"]==len(choices)
                    assert out["copied"]["gitBindings"]==0
                    assert out["copied"]["originalBytes"]==out["verifiedWorktree"]["originalBytes"]
                    results[case]=out
        print(case, json.dumps(results[case]),flush=True)
        a.out.write_text(json.dumps(results,indent=2)+"\n")


if __name__=="__main__":
    main()
