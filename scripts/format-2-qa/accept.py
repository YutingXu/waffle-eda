#!/usr/bin/env python3
"""Compare unrounded observed bytes, physical Git growth and native timing to the reviewed limits."""
import argparse
import csv
import json
import math
from pathlib import Path
import statistics

# (paint, full, RSS MiB, settled journal median ms, inline-M, model-G), as published in docs/format-2.md.
LIMITS = {
    "pidp11-io-expander": (65,65,262,26,415512,292323),
    "snes-tap": (106,84,384,44,192744,68517),
    "midas-communication": (65,65,238,19,169488,80545),
    "cm4-5-shim": (265,100,572,84,4803280,3445355),
    "esp32c3-haptic": (152,116,562,71,7948520,2935789),
    "garganturam": (353,129,702,117,4197056,3012380),
    "corne": (80,77,345,200,0,0),
    "lily58": (65,65,274,32,0,0),
    "synthetic": (248,86,583,29,0,0),
    "approved": (158,121,578,90,3916880,2808809),
}


def table(path):
    with path.open(encoding="utf-8") as f:
        return {row["case"]:row for row in csv.DictReader(f,delimiter="\t")}


def ceiling(numerator,denominator):
    return (numerator+denominator-1)//denominator


def calc(result, baseline, git, caps):
    paint,full,rss,journal,m,gzip=caps
    b,s=int(baseline["file_bytes"]),int(baseline["source_bytes"])
    allowance=gzip+ceiling(135*(b-m),100)+65536
    core_limit=min(allowance,ceiling(105*b,100)) if m else allowance
    tracked_limit=core_limit+(ceiling(s,2)+32768 if s else 0)
    l=int(git["loose_git_increase"])
    r={"sourceBytes":b,"coreCap":core_limit,"trackedCap":tracked_limit,"copiedCap":tracked_limit+s,
       "looseCap":ceiling(5*l*(b-m),4*b)+262144,"packedCap":int(git["packed_git_increase"])+16384,
       "paintCapMs":paint,"fullCapMs":full,"rssCapBytes":rss*2**20,"settledSaveCapMs":journal}
    if result:
        r.update(coreBytes=result["coreBytes"],corePass=result["coreBytes"]<=core_limit,
                 models=result["models"],rawModels=result["modelBytes"],gzipModels=result["compressedBytes"],
                 modelBytesAgree=result["compressedBytes"]==gzip)
    return r


def summarize(options, git_path, desktop, sidecars, baseline_inputs, baseline_git):
    baselines, gitbase=table(baseline_inputs),table(baseline_git)
    rows={}
    for which,caps in LIMITS.items():
        meta=options/which/"options.json"
        row=calc(json.loads(meta.read_text()) if meta.exists() else None,baselines[which],gitbase[which],caps)
        retention=sidecars.get(which)
        if retention and "error" not in retention:
            if which=="synthetic":
                row.update(trackedBytes=row["coreBytes"],copiedBytes=row["coreBytes"],gitBindings=0,sourceBindings=0)
            else:
                for label,form in (("tracked","verifiedWorktree"),("copied","copied")):
                    value=retention[form]
                    row[label+"Bytes"]=row["coreBytes"]+sum(value[k] for k in ("sidecarBytes","manifestReferenceBytes","ignoreBytes"))
                row.update(gitBindings=retention["verifiedWorktree"]["gitBindings"],
                           sourceBindings=retention["copied"]["sourceBindings"],verifiedResiduals=retention["copied"].get("verifiedResiduals"))
            row.update(trackedPass=row["trackedBytes"]<=row["trackedCap"],copiedPass=row["copiedBytes"]<=row["copiedCap"])
        source=git_path/(which+".json")
        if source.exists():
            measured=json.loads(source.read_text())
            hist=measured.get("part",{}).get("history")
            if hist:
                row.update(commits=hist["commits"],looseGrowth=hist["loose"]["gitGrowth"],packedGrowth=hist["packed"]["gitGrowth"])
                row["loosePass"]=row["looseGrowth"]<=row["looseCap"]
                row["packedPass"]=row["packedGrowth"]<=row["packedCap"]
            for mode in ("label","track","part"):
                if mode in measured:
                    diffs=measured[mode]["diffs"]
                    row[mode+"Diffs"]=len(diffs)
                    row[mode+"Pass"]=all(d=={"files":1,"additions":1,"deletions":0 if mode=="track" else 1} for d in diffs)
        saved=desktop.get(which,[])
        obs=[r for r in saved if "firstPaintMs" in r and "fullMs" in r]
        if any("error" in r for r in saved):
            row["nativeErrors"]=sum("error" in r for r in saved)
        if obs:
            full_times=[r["fullMs"] for r in obs if r["fullMs"] is not None]
            first=[r["firstPaintMs"] for r in obs]
            all_saves=[r for ob in obs for r in ob.get("saves",[])]
            moves=[r["saves"][1]["savedMs"] for r in obs if len(r.get("saves",[]))==2 and r.get("editMode","part")=="part" and r.get("diffs") and
                   r["diffs"][0].get("activeKind")==".wpcb" and r["diffs"][0]["deletions"]==1]
            row.update(opens=len(first),paintMs=statistics.median(first),fullMs=statistics.median(full_times) if full_times else None,
                       maxFirstRSS=max(r["firstRSS"] for r in obs),maxFullRSS=max(r["fullRSS"] for r in obs),
                       maxOutsideOpens=max(r["visibleIO"]["outsideOpens"] for r in obs),
                       maxOutsideBytes=max(r["visibleIO"]["outsideBytes"] for r in obs),timedSaves=len(all_saves))
            row.update(paintPass=row["paintMs"]<=row["paintCapMs"],fullPass=len(full_times)==len(obs) and row["fullMs"]<=row["fullCapMs"],
                       rssPass=row["maxFirstRSS"]<=row["rssCapBytes"])
            if all_saves:
                row["maxSaveMs"]=max(r["savedMs"] for r in all_saves)
                row["firstSaveMsMax"]=max(r["savedMs"] for r in all_saves if r["n"]==1)
                row["laterSaveMsMax"]=max((r["savedMs"] for r in all_saves if r["n"]>1),default=None)
                row["everySaveUnder50"]=row["maxSaveMs"]<50
            if moves:
                row["settledMoveMs"]=statistics.median(moves)
                row["settledPass"]=row["settledMoveMs"]<=row["settledSaveCapMs"]
        rows[which]=row
    return rows


def main():
    p=argparse.ArgumentParser(description=__doc__)
    p.add_argument("--options",required=True,type=Path)
    p.add_argument("--nativegit",required=True,type=Path)
    p.add_argument("--baseline-inputs",required=True,type=Path,help="Pinned input TSV supplied by the caller")
    p.add_argument("--baseline-git",required=True,type=Path,help="Pinned Git growth TSV supplied by the caller")
    p.add_argument("--sidecars",type=Path,help="Measured production copied and verified Git totals")
    p.add_argument("--desktop",action="append",type=Path,default=[])
    p.add_argument("--out",type=Path,required=True)
    a=p.parse_args()
    desktop={}
    for f in a.desktop:
        desktop.update(json.loads(f.read_text()))
    output=summarize(a.options,a.nativegit,desktop,json.loads(a.sidecars.read_text()) if a.sidecars else {},
                     a.baseline_inputs,a.baseline_git)
    a.out.write_text(json.dumps(output,indent=2)+"\n")


if __name__=="__main__":
    main()
