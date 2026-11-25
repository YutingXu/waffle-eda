#!/usr/bin/env python3
"""Recheck portable source-backed ZIPs through the real archive writer and native installation."""
import argparse
import json
from pathlib import Path
import subprocess
import sys
import tempfile

from cohort import first_matching_row
from gitmetrics import Repo
SOURCE=Path(__file__).resolve().parents[1]/"format-baseline"
sys.path.insert(0,str(SOURCE))
from sources import fidelity, selection, materialize_choices


def main():
    p=argparse.ArgumentParser(description=__doc__)
    p.add_argument("--product",type=Path,required=True)
    p.add_argument("--prepared",type=Path,required=True)
    p.add_argument("--baseline-inputs",type=Path,required=True,help="Pinned input TSV supplied by the caller")
    p.add_argument("--scratch",type=Path,required=True)
    p.add_argument("--out",type=Path,required=True)
    p.add_argument("--case",required=True)
    p.add_argument("--node",default="node")
    p.add_argument("--mode",choices=("tracked","copied","native"),action="append")
    p.add_argument("--approved-export",type=Path)
    p.add_argument("--fidelity-cache",type=Path,default=fidelity.DEFAULT_CACHE)
    p.add_argument("--history-cache",type=Path,default=Path.home()/".cache/waffle/project-history")
    a=p.parse_args()
    a.scratch.mkdir(parents=True,exist_ok=True,mode=0o700)
    base=first_matching_row(a.case,a.baseline_inputs)
    files,_=selection(a.case,a)
    assert len(files)==int(base["sources"]) and sum(map(len,files.values()))==int(base["source_bytes"])
    result={}
    with tempfile.TemporaryDirectory(dir=a.scratch) as tmp:
        repo=Path(tmp)
        choices,project=materialize_choices(repo,files,"Unexpected source-set path")
        if choices:Repo(repo).initialize()
        for mode in a.mode or (("copied","tracked","native") if choices else ("native",)):
            query={"storage":mode,"translator":"kicad" if a.case in ("corne","lily58") else "altium","destination":str(project),"files":choices}
            if mode=="native":query={"folder":str(a.prepared/a.case/"design"),"manifest":"project.waffle"}
            run=subprocess.run([a.node,str(a.product/"scripts/format-baseline/project-archive.cjs")],
                    input=json.dumps(query).encode(),capture_output=True,timeout=240)
            if run.returncode:raise RuntimeError("The production portable archive check failed.")
            metrics=json.loads(run.stdout)
            assert all(isinstance(val,(int,bool)) for val in metrics.values()) and metrics["nativeReopened"]
            result[mode]=metrics
            a.out.write_text(json.dumps(result,indent=2)+"\n")


if __name__=="__main__":
    main()
