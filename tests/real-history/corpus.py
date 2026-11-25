"""Measure each first-parent design comparison using pinned Git trees and the production JS worker."""
import argparse
import json
from pathlib import Path
import subprocess
import sys
import time

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parents[1] / "native"))
from git_head import ProjectHistory, TIMEOUT

EMPTY = {"text": "No design changes", "total": 0, "counts": {"electrical": 0, "mechanical": 0, "cosmetic": 0}, "regions": []}


def inventory(anchor, output, private):
    git = ProjectHistory(anchor, source=True)
    listing = git.project_log({"limit": 1000})
    if listing["more"]:
        raise ValueError("This pinned inventory exceeds a metadata page.")
    commits = listing["commits"]
    snapshots, pairs = {}, {}
    started = time.monotonic()
    with subprocess.Popen(["node", str(HERE / "engine.cjs")], stdin=subprocess.PIPE, stdout=subprocess.PIPE) as worker:
        with output.open("w") as rows:
            for n, commit in enumerate(commits, 1):
                revision = commit["revision"]
                source_changed = None
                parent = next(iter(commit["parents"]), None)
                git.until = time.monotonic() + TIMEOUT
                try:
                    for rev in (parent, revision):
                        if rev and rev not in snapshots:
                            snapshots[rev] = git.source_snapshot(rev)["blob"]
                    key = (snapshots.get(parent), snapshots[revision])
                    source_changed = key[0] != key[1]
                    if not source_changed:
                        result = EMPTY
                    else:
                        if key not in pairs:
                            msg = {side: git.source_snapshot(rev, True) if blob else None
                                   for side, rev, blob in zip(("before", "after"), (parent, revision), key)}
                            worker.stdin.write(json.dumps(msg, separators=(",", ":")).encode() + b"\n")
                            worker.stdin.flush()
                            pairs[key] = json.loads(worker.stdout.readline())
                        result = pairs[key]
                except (RuntimeError, ValueError) as exc:
                    result = {"error": str(exc)}
                regions = result.get("regions", [])
                row = {"index": n, "sourceChanged": source_changed, "merge": len(commit["parents"]) > 1, "total": result.get("total"),
                       "counts": result.get("counts"), "regions": len(regions),
                       "beforeInk": bool(regions and regions[0].get("before") and any(regions[0]["before"].values())),
                       "afterInk": bool(regions and regions[0].get("after") and any(regions[0]["after"].values())),
                       "beforeChangedInk": bool(regions and (regions[0].get("before") or {}).get("changed")),
                       "afterChangedInk": bool(regions and (regions[0].get("after") or {}).get("changed"))}
                if "error" in result:
                    row["error"] = "Historical source unavailable" if private else result["error"]
                if not private:
                    row.update(revision=revision, summary=result.get("text"))
                rows.write(json.dumps(row, ensure_ascii=False) + "\n")
                rows.flush()
            worker.stdin.close()
    return {"commits": len(commits), "differentPairs": len(pairs), "elapsedSeconds": round(time.monotonic() - started, 2)}


if __name__ == "__main__":
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("design", type=Path)
    ap.add_argument("output", type=Path)
    ap.add_argument("--private", action="store_true", help="Write only anonymous counts and row indices.")
    args = ap.parse_args()
    print(json.dumps(inventory(args.design.resolve(), args.output, args.private)))
