#!/usr/bin/env python3
"""Real SNES-Tap native Git workflows. Clones into fresh scratch; never edits the supplied source.
Run on macOS with python3 -B tests/real-repos/git-workflows.py [--source <public clone>] [--shots <dir>].
"""
import argparse
import base64
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "mcp"))
from board_runner import BoardRunner

FIXTURE = next(p for p in json.loads((ROOT / "tests/altium-fidelity/fixtures.json").read_text())["projects"] if p["id"] == "snes-tap")
REVISIONS = ("1047355808d68a07d69447ab82beebfd483d2f94", "dcf78f5e28b93ff680ef2c4818862a30920147d6", "8d8a80b26cfa76b1f514b83aadebb7ac4f95410c")
NAME = "SNES-Tap.waffle"
GIT = ["git", "-c", "core.hooksPath=" + os.devnull, "-c", "user.name=Codex", "-c", "user.email=codex@openai.com"]
ENV = {k: v for k, v in os.environ.items() if not k.startswith("GIT_")}
ENV.update(GIT_CONFIG_GLOBAL=os.devnull, GIT_CONFIG_NOSYSTEM="1", GIT_TERMINAL_PROMPT="0",
           GIT_AUTHOR_DATE="2026-11-21T12:00:00Z", GIT_COMMITTER_DATE="2026-11-21T12:00:00Z")


def git(repo, *args):
    return subprocess.check_output([*GIT, *args], cwd=repo, env=ENV)


def component(project, ref):
    sheet = next(d for d in project["documents"] if d["kind"] == "schematic")
    return next(i for i in sheet["items"] if i.get("ref") == ref)


def change_file(repo, values):
    file = repo / NAME
    project = json.loads(file.read_bytes())
    for ref, value in values.items():
        component(project, ref)["value"] = value
    file.write_text(json.dumps(project, separators=(",", ":"), ensure_ascii=False) + "\n")


def commit_file(repo, subject):
    git(repo, "add", "--", NAME)
    git(repo, "commit", "-qm", subject)
    return git(repo, "rev-parse", "HEAD").decode().strip()


def prepare(repo, source):
    git(repo.parent, "clone", "-q", "--no-local", "--no-checkout", "--", source, repo.name)
    git(repo, "switch", "-q", "-c", "review-ours", FIXTURE["revision"])
    licence = next(a["sha256"] for a in FIXTURE["assets"] if a.get("role") == "license")
    assert hashlib.sha256(git(repo, "show", FIXTURE["revision"] + ":LICENSE")).hexdigest() == licence
    runner = BoardRunner()
    subjects, snapshots, counts, xs = [], [], [], []
    try:
        for rev in REVISIONS:
            paths = git(repo, "ls-tree", "-r", "--name-only", rev, "--", "altium").decode().splitlines()
            files = [{"name": Path(p).name, "data": base64.b64encode(git(repo, "show", rev + ":" + p)).decode()}
                     for p in paths if Path(p).suffix.lower() in (".prjpcb", ".schdoc", ".pcbdoc", ".schlib", ".pcblib")]
            header, text = runner.headless("import_design", {"name": "SNES-Tap"}, json.dumps(files), modules=("import-formats",), timeout=90)
            assert text, header
            (repo / NAME).write_text(text)
            project = json.loads(text)
            counts.append(sum(len(d["items"]) for d in project["documents"]))
            xs.append(component(project, "J1")["x"])
            subject = "Import " + rev[:7] + " · " + git(repo, "show", "-s", "--format=%s", rev).decode().strip()
            subjects.append(subject)
            snapshots.append(commit_file(repo, subject))
    finally:
        runner.close()
    assert xs == [127, 121.92, 48.26], xs
    # A formatting-only native commit and a non-design commit must not claim J1.
    file = repo / NAME
    file.write_text(json.dumps(project, sort_keys=True, ensure_ascii=False, separators=(",", ":")) + "\n")
    subjects.append("Sort JSON keys without changing the design")
    commit_file(repo, subjects[-1])
    git(repo, "commit", "--allow-empty", "-qm", "Review notes only")
    expected = git(repo, "log", "--format=%s", "HEAD", "--", NAME).decode().splitlines()
    assert expected == subjects[::-1]
    return {"subjects": expected, "revisions": [h[:7] for h in snapshots[::-1]], "xs": xs, "objects": counts,
            "head": git(repo, "rev-parse", "HEAD").decode().strip()}


def open_app(work, bundle, project, phase, truth, shot_dir):
    setup = work / (phase + "-input.js")
    setup.write_text("globalThis.probeInput = " + json.dumps(dict(truth, phase=phase)) + ";\n")
    run = work / ("ui-" + phase)
    env = dict(ENV, HARNESS_WORK=str(run), HARNESS_SUITE="ui", HARNESS_EPHEMERAL="1", HARNESS_OPEN_PROJECT=str(project),
               HARNESS_PROBES=str(setup) + ":" + str(Path(__file__).with_name("git-workflows.js")))
    if "sibling" in truth:
        env["HARNESS_RECENT_PROJECT"] = truth["sibling"]
    result = subprocess.run([str(bundle / "Contents/MacOS/Waffle")], env=env, cwd=work, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, timeout=240, text=True)
    lines = [line for line in result.stdout.splitlines() if line.startswith(("PASS", "FAIL", "RESULT", "NOTE"))]
    print("\n".join(lines), flush=True)
    assert result.returncode == 0 and "RESULT ok" in lines and not any(s.startswith("FAIL") for s in lines), phase
    evidence = json.loads((run / "evidence.json").read_text())
    if shot_dir:
        shot_dir.mkdir(parents=True, exist_ok=True)
        for file in (run / "shots").glob("*.png"):
            shutil.copy(file, shot_dir / file.name)
    return evidence


def check_renamed_history(repo, truth):
    git(repo, "switch", "-q", "review-ours")
    renamed = repo / "SNES-Tap renamed.waffle"
    git(repo, "mv", "--", NAME, renamed.name)
    git(repo, "commit", "-qm", "Rename the design without changing any object")

    def query(op, args):
        command = [sys.executable, "-B", str(ROOT / "native/git_head.py"), "--project", str(renamed),
                   "--query", op, "--args", json.dumps(args)]
        return json.loads(subprocess.check_output(command, env=ENV))

    log = query("blameLog", {})
    rows = log["commits"]
    assert rows[0]["status"] == "R" and rows[0]["oldBlob"] == rows[0]["blob"]
    upstream = {c["revision"][:7]: c["revision"] for c in rows}
    assert all(r in upstream for r in truth["revisions"])
    move = upstream[truth["revisions"][1]]
    patches = query("patches", {"head": log["head"], "revisions": [rows[0]["revision"], move]})["patches"]
    assert patches[0]["hunks"] == []
    [hunk] = patches[1]["hunks"]
    original, updated = [json.loads("\n".join(lines)) for lines in hunk[4:]]
    assert [component(p, "J1")["x"] for p in (original, updated)] == [127, 121.92]
    return {"pureRenameHunks": 0, "originalDesignRevisionsFound": len(truth["revisions"])}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source", default=FIXTURE["upstream"])
    parser.add_argument("--shots", type=Path)
    parser.add_argument("--harness", type=Path, help="reuse a harness built from this checkout")
    options = parser.parse_args()
    cache = Path.home() / "Library/Caches"
    with tempfile.TemporaryDirectory(prefix="waffle-public-git-", dir=cache) as folder:
        work = Path(folder)
        repo = work / "snes-tap"
        truth = prepare(repo, options.source)
        copy = json.loads(git(repo, "show", truth["revisions"][1] + ":" + NAME))
        copy["name"] = "SNES-Tap previous"
        sibling = work / "SNES-Tap previous.waffle"
        sibling.write_text(json.dumps(copy))
        copy_bytes = sibling.read_bytes()
        bundle = options.harness
        if not bundle:
            env = dict(os.environ, HARNESS_OUT=str(work / "build"), HARNESS_INSTALL=str(work / "install"))
            subprocess.run(["zsh", str(ROOT / "native/tests/macos-harness/build.sh")], check=True, env=env)
            bundle = work / "install/WaffleHarness.app"
        file = repo / NAME
        change_file(repo, {"C1": "15p"})
        assert git(repo, "status", "--porcelain", "--", NAME).decode().strip() == "M " + NAME
        dirty = file.read_bytes()
        first = open_app(work, bundle, file, "history", dict(truth, sibling=str(sibling)), options.shots)
        assert file.read_bytes() == dirty, "an unsaved edit, comparison or history changed the saved design"
        assert sibling.read_bytes() == copy_bytes, "undoing Open wrote to the other saved copy"
        assert b"--merge-driver" in git(repo, "config", "--local", "--get", "merge.waffle.driver")
        assert git(repo, "check-attr", "merge", "--", NAME).decode().strip().endswith(": waffle")
        git(repo, "restore", "--", NAME)
        git(repo, "add", "--", ".gitattributes")
        git(repo, "commit", "-qm", "Register the Waffle merge attribute in the scratch copy")
        git(repo, "switch", "-qc", "review-theirs")
        change_file(repo, {"C1": "18p", "C4": "33p"})
        theirs = commit_file(repo, "Change C1 and C4")
        git(repo, "switch", "-q", "review-ours")
        change_file(repo, {"C1": "12p", "C3": "27p"})
        commit_file(repo, "Change C1 and C3")
        merge = subprocess.run([*GIT, "merge", "--no-edit", "review-theirs"], cwd=repo, env=ENV, capture_output=True)
        assert merge.returncode == 1 and b"waffle-merge: 1 conflict(s)" in merge.stderr, (merge.stdout, merge.stderr)
        assert git(repo, "rev-parse", "MERGE_HEAD").decode().strip() == theirs
        stages = [json.loads(git(repo, "show", f":{n}:{NAME}")) for n in (1, 2, 3)]
        values = [component(p, "C1")["value"] for p in stages]
        assert values == ["10p", "12p", "18p"]
        auto = json.loads(file.read_bytes())
        assert [component(auto, r)["value"] for r in ("C1", "C3", "C4")] == ["12p", "27p", "33p"]
        second = open_app(work, bundle, file, "merge", {"stageValues": values}, options.shots)
        resolved = json.loads(file.read_bytes())
        assert [component(resolved, r)["value"] for r in ("C1", "C3", "C4")] == ["18p", "27p", "33p"]
        git(repo, "add", "--", NAME)
        assert not git(repo, "ls-files", "-u")
        git(repo, "commit", "-qm", "Resolve C1 with the incoming value")
        assert len(git(repo, "show", "-s", "--format=%P", "HEAD").split()) == 2
        git(repo, "switch", "-q", "--detach", FIXTURE["revision"])
        manifest = repo / "altium/maxout_conn.PrjPcb"
        logs = git(repo, "log", "--first-parent", "--format=%H%x09%s", "--", "altium").decode().splitlines()
        ids, subjects = zip(*(line.split("\t", 1) for line in logs))
        original = {"revisions": [h[:7] for h in ids], "subjects": list(subjects), "xs": truth["xs"],
                    "author": git(repo, "show", "-s", "--format=%an", ids[0]).decode().strip(),
                    "commitCount": int(git(repo, "rev-list", "--count", "--first-parent", "HEAD"))}
        assert len(ids) == 5 and ids[0] == REVISIONS[-1]
        third = open_app(work, bundle, manifest, "source", original, options.shots)
        assert not git(repo, "status", "--porcelain", "--", "altium")
        git(repo, "switch", "-qc", "review-missing-lib", FIXTURE["revision"])
        subject = "Reference a missing historical library"
        with manifest.open("ab") as f:
            f.write(b"\r\n[Document999]\r\nDocumentPath=Unavailable.SchLib\r\n")
        git(repo, "add", "--", str(manifest.relative_to(repo)))
        git(repo, "commit", "-qm", subject)
        open_app(work, bundle, manifest, "source-warning", {"subject": subject}, options.shots)
        rename = check_renamed_history(repo, truth)
        print(json.dumps({"upstream": REVISIONS, "objects": truth["objects"], "history": first, "merge": second, "source": third, "rename": rename}, indent=2))


if __name__ == "__main__":
    main()
