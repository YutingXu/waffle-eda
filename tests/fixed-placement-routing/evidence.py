"""Summarise repeated offline runs and require identical non-timing evidence."""
import argparse
import json
from pathlib import Path
from statistics import median


def clean(value):
    if isinstance(value, dict):
        return {k: clean(v) for k, v in value.items() if k not in {"routeMs", "searchAndCheckMs"}}
    if isinstance(value, list):
        return [clean(v) for v in value]
    return value


def batch(paths):
    rows = {}
    for path in paths:
        data = json.loads(path.read_text())
        assert len(data["boards"]) == len(data["folds"])
        for b, f in zip(data["boards"], data["folds"]):
            assert b["id"] == f["id"] and b["family"] not in f["model"]["families"]
            assert b["id"] not in rows
            rows[b["id"]] = (b, f)
    return rows


def comparison(paths, trials, old_engine, new_engine):
    before = batch(paths)
    after = [batch(pair) for pair in trials]
    assert len(before) == 8 and all(list(before) == list(run) for run in after), "incomplete corpus"
    for run in after[1:]:
        for key in run:
            assert clean(list(run[key])) == clean(list(after[0][key])), f"{key} changed on repeat"
    output = {"originalEngine": old_engine, "correctedEngine": new_engine, "repeats": len(after),
              "routeColumns": ["connections", "opens", "vias", "trackMm", "medianRouteMs", "expansions", "withheldNets"],
              "referenceColumns": ["opens", "vias", "trackMm"], "boards": {}}
    for key, (b, fold) in after[0].items():
        old, old_fold = before[key]
        for field in ["revision", "stripSha256", "features", "source", "stripped", "initial", "reference"]:
            assert b[field] == old[field], f"{key} input or oracle changed at {field}"
        assert fold == old_fold, f"{key} model changed"
        initial = b["initial"]["opens"]
        get = lambda row: [row["opens"], row["vias"], row["lengthMm"]]
        row = {"family": b["family"], "revision": b["revision"], "source": b["source"], "stripped": b["stripped"],
               "stripSha256": b["stripSha256"], "inputOpens": initial, "placementIssues": b["initial"]["issues"],
               "reference": get(b["reference"]), "referenceNewIssues": b["reference"]["newIssues"],
               "referenceShorts": b["reference"]["shorts"], "poursMm2ByLayer": b["reference"]["filledMm2ByLayer"],
               "pouredNetsWithoutTracks": b["reference"]["pourOnlyNets"], "choice": fold["choice"],
               "trainingBoards": fold["trainingBoards"], "routes": {}, "geometrySha256": {}, "rawIssues": {}, "fallback": {}, "originalRoutes": {}}
        for name, v in b["runs"].items():
            q = v["accepted"]
            assert q["legal"] and q["shorts"] == 0 and not q["newIssues"], f"{key}/{name} accepted illegal copper"
            times = [run[key][0]["runs"][name]["routeMs"] for run in after]
            row["routes"][name] = [initial-q["opens"], *get(q), median(times), v["expansions"], v["withheldNets"]]
            row["geometrySha256"][name] = v["geometrySha256"]
            if v["raw"]["newIssues"]:
                row["rawIssues"][name] = {"opens": v["raw"]["opens"], "issues": v["raw"]["newIssues"]}
            ov = old["runs"][name]
            row["originalRoutes"][name] = {"accepted": get(ov["accepted"]), "rawOpens": ov["raw"]["opens"],
                                           "rawNewIssues": ov["raw"]["newIssues"]}
        for mode, result in b["fallback"].items():
            q = result["accepted"]
            assert q["legal"] and q["shorts"] == 0 and not q["newIssues"]
            row["fallback"][mode] = {"initialOpens": result["initial"], "opens": q["opens"], "vias": q["vias"],
                                     "trackMm": q["lengthMm"], "calls": result["calls"], "cells": result["cells"],
                                     "acceptedOffers": result["landed"], "rejectedOffers": result["rejected"],
                                     "medianMs": median(run[key][0]["fallback"][mode]["searchAndCheckMs"] for run in after)}
        output["boards"][key] = row
    return output


if __name__ == "__main__":
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--before", nargs=2, required=True, type=Path, metavar=("DEVELOPMENT", "CONFIRMATION"))
    ap.add_argument("--after", nargs=2, action="append", required=True, type=Path, metavar=("DEVELOPMENT", "CONFIRMATION"))
    ap.add_argument("--original-engine", required=True)
    ap.add_argument("--corrected-engine", required=True)
    args = ap.parse_args()
    print(json.dumps(comparison(args.before, args.after, args.original_engine, args.corrected_engine), indent=2))
