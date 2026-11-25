#!/usr/bin/env python3
"""Produce numeric desktop receipts from independent private trial directories."""
import argparse
import csv
import json
import math
import statistics
from pathlib import Path

from accept import LIMITS


def dump_table(path, names, rows):
    with path.open("w") as text:
        writer=csv.DictWriter(text,fieldnames=names,delimiter="\t",lineterminator="\n")
        writer.writeheader()
        for row in rows:
            writer.writerow({k:round(v,4) if isinstance(v,float) else v for k,v in row.items()})


def quantile(data,p):
    return sorted(data)[max(0,math.ceil(p*len(data))-1)]


def main():
    p=argparse.ArgumentParser(description=__doc__)
    p.add_argument("--receipts",type=Path,required=True)
    p.add_argument("--out",type=Path,required=True)
    a=p.parse_args()
    a.out.mkdir(exist_ok=True,parents=True)
    opens,saves,histories,history_moves,aggregate,energy,memory=[],[],[],[],[],[],[]
    def read(key):
        f=a.receipts/(key+".json")
        return json.loads(f.read_text()) if f.exists() else {}
    memory_trials=read("save-memory-all")
    for case,target in LIMITS.items():
        paint,full,rss,journal,_,_=target
        parts=[]
        trials=read("designs-"+case).get(case,[])
        for seq,trial in enumerate(trials,1):
            if "error" in trial:continue
            parts.append(trial)
            io=trial["visibleIO"]
            opens.append(dict(case=case,opening=seq,edit=trial.get("editMode") or "open",
                adopted_ms=trial["adoptedMs"],paint_ms=trial["firstPaintMs"],editable_geometry_ms=trial.get("liveGeometryMs"),
                verified_full_ms=trial["fullMs"],full_error=trial.get("fullValidationError"),failed_full_ms=trial.get("failedFullMs"),verified_models=trial.get("verifiedModelMembers"),
                first_rss_B=trial["firstRSS"],full_rss_B=trial["fullRSS"],first_samples=trial["firstRSSSamples"],full_samples=trial["fullRSSSamples"],
                visible_opens=io["opens"],visible_B=io["bytes"],outside_opens=io["outsideOpens"],outside_B=io["outsideBytes"],
                visible_items=trial["activeItems"],items=trial["items"],documents=trial["documents"]))
            for save,diff in zip(trial.get("saves",[]),trial.get("diffs",[])):
                step=save["steps"]
                saves.append(dict(case=case,opening=seq,edit=trial["editMode"],ordinal=save["n"],ack_ms=save["savedMs"],
                    editor_ms=save["editorMs"],command_end_ms=save["commandCompletionMs"],native_staging_start_ms=save["nativeBeforeStageMs"],
                    native_durable_ms=save["nativeDurableMs"],final_apply_ms=save["appliedMs"],clock_bound_ms=trial["clockBoundMs"],
                    native_ack_to_clear_ms=save["actualAckToClearedMs"],rows=save["rowsEncoded"],reported_unrelated=save["unrelatedVisits"],
                    row_payload_B=save["transferBytes"],bridge_json_B=save["bridgeJSONBytes"],staged_B=save["stagedBytes"],splices=save["splices"],
                    file_hashes=step.get("fileDigest",0),checked_fsync_calls=step.get("checkedFsyncCalls",0),file_sync_calls=step.get("fileSync",0),
                    directory_sync_calls=step.get("directorySync",0),full_device_flushes=step.get("fullDeviceFlushSucceeded",0),
                    rejected_full_flushes=step.get("fullDeviceFlushRejected",0),files=diff["files"],additions=diff["additions"],deletions=diff["deletions"]))
        if parts:
            times=[(r["editMode"],s["n"],s["savedMs"]) for r in parts for s in r.get("saves",[])]
            settled=[n for mode,num,n in times if mode=="part" and num==2]
            median=lambda seq:statistics.median(seq) if seq else None
            first=median([r["firstPaintMs"] for r in parts]); end=median([r["fullMs"] for r in parts if r["fullMs"] is not None])
            first_ram=max(r["firstRSS"] for r in parts);moves=median(settled)
            total=len(times); max_ack=max((n for _,_,n in times),default=None)
            aggregate.append(dict(case=case,opens=len(parts),failed_opens=sum("error" in r for r in trials),
                median_paint_ms=first,paint_cap_ms=paint,paint_pass=first<=paint,median_geometry_ms=median([r["liveGeometryMs"] for r in parts]),
                median_verified_full_ms=end,full_cap_ms=full,full_pass=end is not None and end<=full and all(r["fullMs"] is not None for r in parts),failed_full=sum(r["fullMs"] is None for r in parts),max_first_rss_B=first_ram,rss_cap_B=rss*2**20,
                first_rss_pass=first_ram<=rss*2**20,max_full_rss_B=max(r["fullRSS"] for r in parts),
                max_opened_outside=max(r["visibleIO"]["outsideOpens"] for r in parts),timed_saves=total,
                first_max_ms=max((n for _,num,n in times if num==1),default=None),later_max_ms=max((n for _,num,n in times if num>1),default=None),
                saves_at_or_above_50_ms=sum(n>=50 for _,_,n in times),all_strict=(max_ack<50) if max_ack is not None else None,
                settled_moves=len(settled),median_settled_move_ms=moves,settled_cap_ms=journal,
                settled_pass=(moves<=journal) if moves is not None else None))
        for trial in read("history-"+case).get(case,[]):
            if "history" not in trial:continue
            hist=trial["history"]; times=[r["savedMs"] for r in trial["saves"]]
            diffs=trial["diffs"]
            cleared=trial.get("physicallySettledCommits")
            clear_source="descriptor absent at Git checkpoint"
            if cleared is None:
                cleared=sum(bool((r.get("steps") or {}).get("after-unlink-sync")) for r in trial["saves"])
                clear_source="native durable descriptor removal"
            histories.append(dict(case=case,commits=hist["commits"]-1,one_row_moves=sum(d["files"]==d["additions"]==d["deletions"]==1 for d in diffs),
                cleared=cleared,clear_evidence=clear_source,
                median_ack_ms=statistics.median(times),p95_ack_ms=quantile(times,.95),max_ack_ms=max(times),saves_at_or_above_50_ms=sum(n>=50 for n in times),
                editor_ms_max=max(r["editorMs"] for r in trial["saves"]),loose_B=hist["loose"]["gitGrowth"],packed_B=hist["packed"]["gitGrowth"]))
            for move,diff in zip(trial["saves"],diffs):
                history_moves.append(dict(case=case,commit=move["n"],save_ms=move["savedMs"],editor_ms=move["editorMs"],
                    native_stage_ms=move["nativeBeforeStageMs"],native_durable_ms=move["nativeDurableMs"],installed_ms=move["appliedMs"],
                    observed_settled_ms=move["observedSettleMs"],
                    rows=move["rowsEncoded"],row_payload_B=move["transferBytes"],bridge_B=move["bridgeJSONBytes"],staged_B=move["stagedBytes"],
                    files=diff["files"],additions=diff["additions"],deletions=diff["deletions"]))
        for trial in memory_trials.get(case,[]):
            for sample,diff in zip(trial["saves"],trial["diffs"]):
                before=sample["beforeEditRSS"]
                peak=sample["peakEditSaveRSS"]
                count=sample["editSaveRSSSamples"]
                if not before or peak<before or count<3:
                    raise ValueError("Invalid native edit and save RSS sample")
                memory.append(dict(case=case,move=sample["n"],before_edit_rss_B=before,peak_through_install_B=peak,
                    increase_B=peak-before,samples=count,ack_ms=sample["savedMs"],install_ms=sample["appliedMs"],
                    files=diff["files"],additions=diff["additions"],deletions=diff["deletions"]))
    for power in ("foreground","hidden","lowPower","rapid"):
        for r in read("idle-synthetic-"+power).get("synthetic",[]):
            slices=r["hydrationSlices"]
            energy.append(dict(mode=power,elapsed_ms=r["idleMs"],idle_callbacks=r["idleCallbacks"],native_events=r.get("watcherEvents"),
                reads=r["idleReads"],read_B=r["idleBytes"],before_rss_B=r.get("startRSS"),after_rss_B=r.get("endRSS"),
                loaded_before=r["loadedBefore"],loaded_after=r["loadedAfter"],same_active=r["sameActive"],settling_callbacks=r.get("settlingCallbacks"),
                hydration_slices=len(slices),p95_hydration_slice_ms=quantile(slices,.95) if slices else None,
                low_power=r["lowPower"],visible=r["visible"]))
    for filename,rows in (("native-open.tsv",opens),("native-save.tsv",saves),("native-summary.tsv",aggregate),
                          ("native-history.tsv",histories),("native-history-moves.tsv",history_moves),
                          ("native-idle.tsv",energy),("save-memory.tsv",memory)):
        if rows:dump_table(a.out/filename,list(rows[0]),rows)


if __name__=="__main__":
    main()
