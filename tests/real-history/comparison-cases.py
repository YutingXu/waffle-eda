"""Run the original-file comparison cases using local public source caches and the History worker."""
import argparse
import json
import subprocess
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parents[1] / "native"))
from git_head import ProjectHistory

CASES = [
    ("sofle", "63ff1360"), ("corne", "ffca3be3"), ("lily58", "5c68a041"),
    ("lily58", "a09f651b"), ("snes-tap", "dcf78f5e"), ("snes-tap", "077a5c67"),
    ("esp32c3-haptic", "dca4f6a5")
]


def main(cache):
    sources = {s["id"]: s for s in json.loads((HERE / "sources.json").read_text())}
    for name, selected in CASES:
        history = ProjectHistory(cache / name / sources[name]["design"], source=True)
        commit = next(c for c in history.project_log({"limit": 1000})["commits"] if c["revision"].startswith(selected))
        data = {"comparison": True, "before": history.source_snapshot(commit["parents"][0], True),
                "after": history.source_snapshot(commit["revision"], True)}
        worker = subprocess.run(["node", str(HERE / "engine.cjs")], input=json.dumps(data)+"\n",
                                text=True, capture_output=True, check=True)
        forward, reverse = json.loads(worker.stdout)
        kinds = forward["kinds"]
        if selected == "63ff1360":
            assert kinds == {"label.removed": 2, "library.footprint": 1} and forward["targets"] == ["J1"]
            assert reverse["kinds"] == {"label.added": 2, "library.footprint": 1}
        elif selected == "ffca3be3":
            assert forward["total"] == reverse["total"] < 500
            assert "board.shape" not in kinds  # every re-ordered cutout still has the same complete physical contour
            for a, b, sign in [(forward, reverse, 1), (reverse, forward, -1)]:
                motion = a["translation"]
                assert (motion["dx"], motion["dy"], motion["anchors"]) == (sign*210, sign*117.16875, 178)
                assert motion["byKind"]["part"] == 180 and motion["objects"] > 3_000
                for k, v in a["kinds"].items():
                    other = k.replace(".added", ".removed") if k.endswith(".added") else k.replace(".removed", ".added")
                    assert b["kinds"][other] == v, (k, v)
            assert (kinds["track.removed"], kinds["track.added"]) == (32, 60)
            # Explicit source IDs can identify one old/new via pair as the same moved via.
            moved_vias = kinds.get("via.moved", 0)
            assert (kinds.get("via.removed", 0)+moved_vias, kinds.get("via.added", 0)+moved_vias) == (1, 12)
            assert kinds["routing.changed"] == 50
        elif selected in ("a09f651b", "077a5c67"):
            assert forward["total"] == reverse["total"] == 0
        else:
            assert not forward["translation"] and not reverse["translation"]
            if name == "lily58":
                assert kinds["part.moved"] >= 4 and kinds["routing.changed"] > 0
                assert forward["total"] == reverse["total"]
                assert kinds["pad.shortCleared"] == reverse["kinds"]["pad.shorted"]
                assert kinds["pad.reconnected"] == reverse["kinds"]["pad.opened"]
            if name == "snes-tap":
                assert kinds["library.symbol"] > 0 and kinds["part.moved"] > 0
            if name == "esp32c3-haptic":
                assert kinds["part.moved"] >= 100
        print(name, selected, json.dumps({"total":forward["total"], "reverse":reverse["total"],
              "components": forward["components"], "kinds":kinds, "translation":forward["translation"]}))


if __name__ == "__main__":
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("--cache", type=Path, default=Path.home()/".cache"/"waffle"/"project-history")
    main(p.parse_args().cache)
