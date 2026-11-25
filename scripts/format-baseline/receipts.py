#!/usr/bin/env python3
"""Export aggregate benchmark receipts, or check a complete published ten-design run without any design files."""
import argparse
import csv
from pathlib import Path
import sys

sys.dont_write_bytecode = True
from sources import CASES, KICAD, fidelity


def write_table(directory, name, rows):
    if not rows:
        return
    with (directory / (name + ".tsv")).open("w", newline="") as stream:
        writer = csv.DictWriter(stream, fieldnames=list(rows[0]), delimiter="\t", lineterminator="\n")
        writer.writeheader()
        writer.writerows(rows)


def write(directory, summaries):
    inputs, native, git = [], [], []
    for case, v in summaries.items():
        inputs.append(dict(case=case, format=v["version"], source_rev=v.get("revision", ""),
                           snapshot_sha256="" if case == "approved" else v.get("snapshotSHA256", ""),
                           sources=v.get("sourceFiles", ""), source_bytes=v.get("sourceBytes", ""),
                           file_bytes=v["bytes"], allocated_bytes=v["allocatedBytes"], documents=v["documents"],
                           first_doc_items=v["items"][0], total_items=sum(v["items"])))
        for phase, rows in [("settled", v.get("observations", [])), ("first", [
                {**row, "edit": edit, "repeat": 1, "policy": "close"} for edit, row in v.get("firstEditorSave", {}).items()])]:
            for row in rows:
                native.append(dict(case=case, phase=phase, edit=row.get("edit", "part"), repeat=row["repeat"], policy=row["policy"],
                                   first_doc=row["firstDocumentKind"], paint_ms=row["firstPaintMs"], all_model_ms=row["modelMs"],
                                   peak_rss_bytes=row["peakRSSBytes"], rss_samples=row["memorySamples"], save_ms=row["saveMs"],
                                   journal_bytes=row["journalBytes"], patch_bytes=row["patchBytes"],
                                   compacted=int(row["compacted"]),
                                   extra_fields=",".join(row["extraFields"]), git_added=row.get("additions", ""), git_deleted=row.get("deletions", ""),
                                   exact_edit=int(row["exactEdit"])))
        controlled = v.get("controlledGit")
        if controlled:
            if controlled["snapshotBytes"] != v["bytes"] or case != "approved" and controlled.get("snapshotSha256") != v["snapshotSHA256"]:
                raise ValueError("Git and editor inputs differ.")
            history, edits = controlled["history"], controlled["edits"]
            r = {"case": case}
            for short, key in [("part", "movePart"), ("label", "editNetLabel"), ("track", "addTrack")]:
                e = edits[key]
                r.update({short + "_added": e["additions"], short + "_deleted": e["deletions"], short + "_files": e["files"]})
            for mode in ("loose", "packed"):
                for stage in ("before", "after", "increase"):
                    value = history[mode][stage]
                    r[mode + "_git_" + stage] = value["gitBytes"]
                    r[mode + "_objects_" + stage] = value["objectBytes"]
            r.update(baseline_commits=history["baselineCommits"], final_commits=history["finalCommits"],
                     loose_objects=history["loose"]["after"]["looseObjects"], packed_objects=history["packed"]["after"]["packedObjects"])
            git.append(r)
    write_table(directory, "inputs", inputs)
    write_table(directory, "native", native)
    write_table(directory, "git", git)


def check(directory):
    def load(name):
        with (directory / (name + ".tsv")).open() as stream:
            return list(csv.DictReader(stream, delimiter="\t"))
    inputs, native, git = (load(name) for name in ("inputs", "native", "git"))
    pins = {r["id"]: r["revision"] for r in fidelity.manifest()}
    pins.update({case: KICAD[case][1] for case in ("corne", "lily58")})
    assert len(inputs) == len(git) == len(CASES)
    assert {r["case"] for r in inputs} == {r["case"] for r in git} == {r["case"] for r in native} == set(CASES)
    for row in inputs:
        case = row["case"]
        assert row["source_rev"] == pins.get(case, "") and int(row["documents"]) >= 2
        assert len(row["snapshot_sha256"]) == (0 if case == "approved" else 64)
        assert int(row["file_bytes"]) > 0 and int(row["allocated_bytes"]) > 0
        assert int(row["total_items"]) >= int(row["first_doc_items"]) > 0
        records = [r for r in native if r["case"] == case]
        first = [r for r in records if r["phase"] == "first"]
        assert len(first) == 3 and {r["edit"] for r in first} == {"part", "label", "track"}
        assert all(int(r["git_added"]) > 0 and int(r["git_deleted"]) > 0 for r in first)
        steady = [r for r in records if r["phase"] == "settled"]
        assert len(steady) == 6
        assert {(r["policy"], int(r["repeat"])) for r in steady} == {(p, n) for p in ("close", "always") for n in (1, 2, 3)}
        for obs in records:
            assert float(obs["paint_ms"]) >= float(obs["all_model_ms"]) > 0 and float(obs["save_ms"]) > 0
            assert int(obs["peak_rss_bytes"]) > 0 and int(obs["rss_samples"]) >= 2
            assert (int(obs["journal_bytes"]) == 0) == (obs["compacted"] == "1")
        for obs in steady:
            assert obs["edit"] == "part" and obs["exact_edit"] == "1" and obs["extra_fields"] == ""
            assert (obs["policy"] == "always") == (obs["compacted"] == "1")
    for row in git:
        assert [int(row[k]) for k in ("baseline_commits", "final_commits", "loose_objects", "packed_objects")] == [1, 101, 303, 303]
        assert all(int(row[edit + "_files"]) == 1 for edit in ("part", "label", "track"))
        for mode in ("loose", "packed"):
            for field in ("git", "objects"):
                key = mode + "_" + field
                assert int(row[key + "_after"]) - int(row[key + "_before"]) == int(row[key + "_increase"]) > 0
    print("Verified 10 inputs, 60 timed native saves, 30 first-edit Git diffs and 1,000 Git commits.")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--check", type=Path, required=True)
    check(parser.parse_args().check)
