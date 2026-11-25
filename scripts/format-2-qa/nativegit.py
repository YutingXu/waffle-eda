#!/usr/bin/env python3
"""Whole-checkout 100-save history and first/later edit diffs with the shipping codec, native commit and ordinary Git.

Timing the running editor is deliberately handled by desktop.py. Every native acknowledgement here is followed by
a real working-file verification, normal Git add/commit and an independent final packed baseline comparison.
"""
import argparse
import hashlib
import json
from pathlib import Path
import shutil
import subprocess
import tempfile

from gitmetrics import Repo

HERE = Path(__file__).resolve().parent


def trial(o, which, edit, count):
    with tempfile.TemporaryDirectory(prefix="nativegit-", dir=o.scratch) as temp:
        work=Path(temp)
        folder=work/"design"
        prepared=o.prepared/which
        manifest=json.loads((prepared/"options.json").read_text())["manifest"]
        shutil.copytree(prepared/"design",folder)
        repo=Repo(folder)
        repo.initialize()
        before=repo.start_history(work/"one-commit") if count==100 else None
        run=subprocess.run([o.node,str(HERE/"owner-edits.cjs"),str(o.product),str(folder),manifest,which,edit,str(count)],
                           capture_output=True)
        if run.returncode:
            raise ValueError("The private codec edit failed" if which=="approved" else run.stderr.decode()[-1400:])
        items=[json.loads(line) for line in run.stdout.splitlines()]
        assert len(items)==count
        last_hash=None
        diffs=[]
        for i, row in enumerate(items,1):
            path=folder/row["path"]
            if last_hash is None:
                last_hash=hashlib.sha256(path.read_bytes()).hexdigest()
            request={"projectId":row["projectId"],"manifest":manifest,"plan":[{"path":row["path"],"expected":last_hash,
                     "splice":{"base":last_hash,"edits":row["edits"]}}]}
            writer=subprocess.run([o.driver,str(folder),manifest,"commit"],input=json.dumps(request).encode(),capture_output=True)
            if writer.returncode:
                raise ValueError("The private native save failed" if which=="approved" else writer.stdout.decode()[-400:])
            reply=json.loads(writer.stdout.splitlines()[0])
            assert reply["saved"] and reply["transaction"] and list(reply["hashes"])==[row["path"]]
            last_hash=reply["hashes"][row["path"]]
            assert hashlib.sha256(path.read_bytes()).hexdigest()==last_hash
            assert not (folder/".waffle/journal/active").exists()
            if "finalSha" in row:
                assert last_hash==row["finalSha"]
            result, filenames=repo.diff()
            assert filenames==[row["path"]], "Edit changed an unexpected checkout member"
            diffs.append(result)
            repo.commit(i)
        return {"diffs":diffs, **({"history":repo.finish_history(before)} if before else {})}


def main():
    p=argparse.ArgumentParser(description=__doc__)
    p.add_argument("--product",type=Path,required=True)
    p.add_argument("--prepared",type=Path,required=True)
    p.add_argument("--scratch",type=Path,required=True)
    p.add_argument("--out",type=Path,required=True)
    p.add_argument("--node",default="node")
    p.add_argument("--driver",required=True)
    p.add_argument("--case",required=True)
    o=p.parse_args()
    o.scratch.mkdir(parents=True,exist_ok=True,mode=0o700)
    o.out.parent.mkdir(parents=True,exist_ok=True)
    results={}
    for edit,count in (("label",2),("track",2),("part",100)):
        results[edit]=trial(o,o.case,edit,count)
        o.out.write_text(json.dumps(results,indent=2)+"\n")
        print(o.case,edit,count,"complete",flush=True)


if __name__=="__main__":
    main()
