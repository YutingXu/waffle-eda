#!/usr/bin/env python3
"""Terminate a real edited macOS folder, then exercise its normal private recovery choices."""
import argparse
import json
import os
from pathlib import Path
import selectors
import shutil
import signal
import subprocess
import tempfile
import time
import uuid

from desktop import selected_png


def snapshot(folder):
    return {p.relative_to(folder):p.read_bytes() for p in folder.rglob("*")
            if p.is_file() and p.relative_to(folder).parts[0]!=".waffle"}


def run_stage(exe,work,env,settings,callback):
    (work/"trial.json").write_text(json.dumps(settings))
    with (work/"draft-stderr").open("w+b") as log:
        proc=subprocess.Popen([str(exe)],env=env,stdout=subprocess.PIPE,stdin=subprocess.PIPE,stderr=log)
        poll=selectors.DefaultSelector()
        poll.register(proc.stdout,selectors.EVENT_READ)
        deadline=time.monotonic()+90
        pending=b""; result=None
        try:
            while True:
                if time.monotonic()>deadline or not poll.select(max(0,deadline-time.monotonic())):
                    raise TimeoutError("Folder draft native process timed out")
                block=os.read(proc.stdout.fileno(),65536)
                if not block:break
                pending+=block
                while b"\n" in pending:
                    data,pending=pending.split(b"\n",1)
                    if not data:continue
                    row=json.loads(data)
                    if "checkpoint" not in row:
                        result=row;continue
                    if callback(row):
                        proc.kill()
                        assert proc.wait(timeout=5)==-signal.SIGKILL
                        return {"processKilled":True}
                    proc.stdin.write(b"continue\n");proc.stdin.flush()
            if proc.wait(timeout=8) or result is None:
                log.seek(0)
                raise RuntimeError(log.read().decode(errors="replace")[-1600:])
            return result
        finally:
            poll.close()
            if proc.poll() is None:proc.kill();proc.wait()


def exercise(args,case,work):
    owner="child" if case=="child" else "existing"
    changed=case=="changed"
    folder=work/"design"
    shutil.copytree(args.prepared/"design",folder)
    original=snapshot(folder)
    meta=json.loads((args.prepared/"options.json").read_text())
    (work/"qa-selected.png").write_bytes(selected_png())
    profile=str(uuid.uuid4())
    env={**os.environ,"WAFFLE_FORMAT_TRIAL":str(work),"WAFFLE_FORMAT_DRAFT_PROFILE":profile,
         "WAFFLE_FORMAT_PRIVATE":"0"}
    cfg={k:meta[k] for k in ("manifest","visiblePaths","items")}
    cfg.update(owner=owner)
    state={"owner":owner,"changedBase":changed}
    journal=folder/".waffle/journal"
    try:
        def created(row):
            assert snapshot(folder)==original
            if row["checkpoint"]==1:
                state["normalScheduledDraft"]=row["observation"]
                journal.mkdir(exist_ok=True,parents=True)
                journal.chmod(0o500)
                return False
            assert row["checkpoint"]==2 and not (journal/"active").exists()
            state["failedSave"]=row["observation"]
            return True
        exit_result=run_stage(args.exe,work,env,{**cfg,"mode":"draft-create"},created)
        assert exit_result["processKilled"] and state["failedSave"]["dirtyAfterFailedSave"]
        journal.chmod(0o700)
        assert snapshot(folder)==original
        if changed:
            # The approved case uses a public test model with one existing schematic. Change its
            # actual saved label without touching any other project members to create a third base.
            path=next(p for p in folder.glob("*.wsch"))
            rows=path.read_bytes().splitlines(keepends=True)
            for i,raw in enumerate(rows):
                record=json.loads(raw)
                if record.get("kind")=="netlabel" and isinstance(record.get("text"),str):
                    record["text"]+="_EXTERNAL_QA"
                    rows[i]=(json.dumps(record,ensure_ascii=False,separators=(",",":"))+"\n").encode()
                    break
            else:raise ValueError("Public draft fixture lacks a label")
            path.write_bytes(b"".join(rows))
        current=snapshot(folder)
        keep=run_stage(args.exe,work,env,{**cfg,"mode":"draft-reopen","decision":"keep"},lambda row: False)
        assert keep["keptDraft"] and not keep["dirty"] and snapshot(folder)==current
        state["keptAcrossSecondProcess"]=keep
        if case=="discard":
            decision=run_stage(args.exe,work,env,{**cfg,"mode":"draft-reopen","decision":"discard"},lambda row:False)
            assert decision["discarded"] and not decision["dirty"] and snapshot(folder)==current
            reopened=run_stage(args.exe,work,env,{**cfg,"mode":"draft-reopen","decision":"none"},lambda row:False)
            assert reopened["clean"] and reopened["draftCount"]==0 and snapshot(folder)==current
            state["discarded"]=decision
            state["freshOpenAfterDiscard"]=reopened
            return state
        def before_explicit_save(row):
            assert row["checkpoint"]==3 and snapshot(folder)==current
            state["beforeExplicitSave"]=row["observation"]
            return False
        final=run_stage(args.exe,work,env,{**cfg,"mode":"draft-reopen","decision":"separate" if changed else "restore"},before_explicit_save)
        assert final["recovered"] and final["separate"]==changed
        if changed:assert snapshot(folder)==current
        else:
            import hashlib
            asset=folder/"assets"/hashlib.sha256(selected_png()).hexdigest()
            assert asset.read_bytes()==selected_png()
            installed=snapshot(folder)
            diff=sum(current.get(k)!=installed.get(k) for k in current.keys()|installed.keys())
            assert diff==(3 if owner=="child" else 2)
            state["authoredDiffAfterExplicitSave"]=diff
        state["reopen"]=final
        return state
    finally:
        if journal.exists():journal.chmod(0o700)
        cleanup={**env,"WAFFLE_FORMAT_REMOVE_DRAFT_PROFILE":profile}
        # Older WebKit sometimes removes the named store then faults while terminating its
        # asynchronous callback. Require physical absence of this test's own store as a fallback.
        clean=subprocess.run([str(args.exe)],env=cleanup,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL,timeout=25)
        if clean.returncode:
            directory=Path.home()/"Library/WebKit/org.waffle.format-benchmark/WebsiteDataStore"
            if not directory.is_dir() or any(p.name.lower()==profile.lower() for p in directory.iterdir()):
                clean.check_returncode()


def main():
    p=argparse.ArgumentParser(description=__doc__)
    p.add_argument("--exe",required=True,type=Path)
    p.add_argument("--prepared",required=True,type=Path)
    p.add_argument("--scratch",required=True,type=Path)
    p.add_argument("--out",required=True,type=Path)
    p.add_argument("--case",action="append",choices=("existing","child","changed","discard"))
    a=p.parse_args();a.scratch.mkdir(exist_ok=True,parents=True,mode=0o700)
    answer={}
    for name in a.case or ("existing","child","changed","discard"):
        with tempfile.TemporaryDirectory(dir=a.scratch) as tmp:
            answer[name]=exercise(a,name,Path(tmp))
        a.out.write_text(json.dumps(answer,indent=2)+"\n")


if __name__=="__main__":
    main()
