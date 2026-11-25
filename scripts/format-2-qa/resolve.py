#!/usr/bin/env python3
"""Crash a real, explicitly chosen conflict resolution after a previous partially applied transaction."""
import argparse
import json
from pathlib import Path
import tempfile

from crash import Driver, EVENT, PCB, authored, case, check_namespace, descriptor, digest, lines, seed, verify_reader


def setup(d,root):
    initial=case("pair")
    seed(root,initial.before)
    # This synthetic private recovery draft has an older base. A transaction replay may not
    # silently promote, overwrite or remove it during the independently approved disk resolution.
    drafts=root/".waffle/local/drafts"
    drafts.mkdir(parents=True)
    draft=drafts/"pinned.json"
    draft.write_bytes(lines({"version":1,"owner":"b1","base":digest(initial.before["Main.wpcb"]),"draft":"earlier unsaved edit"}))
    original_draft=draft.read_bytes()
    rc,_,_=d.call(root,"commit",initial.request,{"WAFFLE_FOLDER_KILL":"after-install:0"})
    assert rc and descriptor(root)
    target=root/"Main.wpcb"
    external=lines(PCB,{"kind":"track","id":"x1","points":[[0,0],[762000,0]],"width":200000})
    chosen=lines(PCB,{"kind":"track","id":"t1","points":[[0,0],[508000,0]],"width":200000})
    target.write_bytes(external)
    before=authored(root)
    assert before["Power.wsch"]==initial.after["Power.wsch"]
    rc,r,_=d.call(root,"recover")
    assert rc and any("Main.wpcb" in val.get("paths",[]) for val in r)
    check_namespace(root,before)
    rc,r,_=d.call(root,"conflict")
    assert not rc and r[-1]["paths"]==["Main.wpcb"]
    choice={"transaction":r[-1]["transaction"],"choices":[{"path":"Main.wpcb","current":digest(external),"use":"merged","text":chosen.decode()}]}
    return before,{**initial.after,"Main.wpcb":chosen},choice,draft,original_draft


def verify(d,parent):
    with tempfile.TemporaryDirectory(dir=parent) as f:
        before,after,choice,draft,raw=setup(d,Path(f))
        rc,rows,log=d.call(Path(f),"resolve",choice)
        assert not rc and any(r.get("saved") for r in rows)
        check_namespace(Path(f),after)
        assert draft.read_bytes()==raw
        events=[m.group(1) for line in log.splitlines() for m in EVENT.finditer(line)]
    assert len(events)==len(set(events)) and {"before-publish","after-publish","after-commit-sync"} <= set(events)
    for index,point in enumerate(events):
        with tempfile.TemporaryDirectory(dir=parent) as f:
            root=Path(f)
            before,after,choice,draft,raw=setup(d,root)
            old_descriptor=descriptor(root)
            rc,_,_=d.call(root,"resolve",choice,{"WAFFLE_FOLDER_KILL":point})
            assert rc
            if index<events.index("after-publish"):
                assert descriptor(root)==old_descriptor
                rc,rows,_=d.call(root,"recover")
                assert rc and any("Main.wpcb" in row.get("paths",[]) for row in rows)
                check_namespace(root,before)
                rc,rows,_=d.call(root,"resolve",choice)
                assert not rc and any(r.get("saved") for r in rows)
            d.recover(root)
            d.recover(root)
            check_namespace(root,after)
            verify_reader(d,root,after)
            assert draft.read_bytes()==raw
            archive=root/".waffle/local/conflicts"/choice["transaction"]
            retained={digest(p.read_bytes()) for p in archive.rglob("*") if p.is_file()}
            assert digest(before["Main.wpcb"]) in retained and digest(case("pair").after["Main.wpcb"]) in retained
    return {"checkpoints":events,"actualDeaths":len(events),"preservedConflictArchive":True,
            "preservedOlderOpaqueDraft":True,"allAgreedAfterRestart":True}


def main():
    p=argparse.ArgumentParser(description=__doc__)
    p.add_argument("--root",type=Path,required=True)
    p.add_argument("--out",type=Path,required=True)
    p.add_argument("driver")
    a=p.parse_args()
    a.root.mkdir(parents=True,exist_ok=True)
    a.out.write_text(json.dumps(verify(Driver([a.driver]),a.root),indent=2)+"\n")


if __name__=="__main__":
    main()
