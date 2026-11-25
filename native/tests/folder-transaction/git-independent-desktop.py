#!/usr/bin/env python3
"""Run 50 real Command-S saves with a real Git index, autosave, and crash-draft recovery."""
from functools import partial
import json
import os
from pathlib import Path
import platform
import selectors
import shutil
import subprocess
import sys
import tempfile
import time
import uuid


ROOT = Path(__file__).resolve().parents[3]
sys.path[:0] = [str(ROOT / name) for name in ("scripts/format-2-qa", "tests/support")]
from git_spy import GitSpy, git_tree
from nativebuild import instrumentation, native_host


MANIFEST, OWNER = "Instrument.waffle", "Schematic.wsch"
PRIVATE = {"cache", "previews", "history", "journal", "local"}


def project_files(root):
    found = {}
    for item in root.rglob("*"):
        parts = item.relative_to(root).parts
        if parts[0] == ".git" or parts[0] == ".waffle" and len(parts) > 1 and parts[1] in PRIVATE:
            continue
        if item.is_file():
            found["/".join(parts)] = item.read_bytes()
    return found


def run_editor(exe, work, env, trial, observe):
    (work / "trial.json").write_text(json.dumps(trial))
    with (work / "desktop.stderr").open("w+b") as errors:
        with subprocess.Popen([exe], stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=errors, env=env) as proc:
            try:
                with selectors.DefaultSelector() as selector:
                    selector.register(proc.stdout, selectors.EVENT_READ)
                    deadline, remainder, result = time.monotonic() + 180, b"", None
                    while selector.select(max(0, deadline - time.monotonic())):
                        chunk = os.read(proc.stdout.fileno(), 65536)
                        if not chunk:
                            break
                        *lines, remainder = (remainder + chunk).split(b"\n")
                        for line in lines:
                            row = json.loads(line)
                            if "checkpoint" not in row:
                                result = row
                                continue
                            observe(row["checkpoint"], row["observation"])
                            if trial["mode"] == "draft" and row["checkpoint"] == "draft":
                                # Kill only the isolated test editor after a verified private draft.
                                proc.kill()
                                proc.wait(timeout=10)
                                return {"crashDraft": True}
                            proc.stdin.write(b"continue\n")
                            proc.stdin.flush()
                    if result is None or remainder or proc.wait(timeout=8):
                        errors.seek(0)
                        raise RuntimeError(errors.read().decode(errors="replace")[-2500:])
                    return result
            finally:
                if proc.poll() is None:
                    proc.kill()
                    proc.wait(timeout=10)


def main():
    if platform.system() != "Darwin" or int(platform.mac_ver()[0].split(".")[0]) < 14:
        print("SKIP the real desktop Git independence probe requires macOS 14 or later")
        return
    with tempfile.TemporaryDirectory(prefix="waffle-save-no-git-") as temp:
        work = Path(temp).resolve()
        project = work / "design"
        shutil.copytree(ROOT / "tests/fixtures/format-2/instrument", project)
        spy = GitSpy(work)
        unrelated = project / "notes.txt"
        unrelated.write_text("Initial tracked notes\n")
        spy.initialize(project)
        unrelated.write_text("An independently staged edit\n")
        spy.git(project, "add", "--", unrelated.name)
        head = spy.git(project, "rev-parse", "HEAD").decode().strip()
        initial_git, initial_design = git_tree(project), project_files(project)
        last, saves, local_controls = initial_design[OWNER], [], []

        def observe(point, details):
            nonlocal last
            assert git_tree(project) == initial_git, f"Git changed at {point}"
            assert not spy.calls("save"), spy.calls("save")
            if point == "start-saves":
                spy.phase("save")
                return
            current = project_files(project)
            assert current.keys() == initial_design.keys(), (point, current.keys() ^ initial_design.keys())
            assert all(data == initial_design[path] for path, data in current.items() if path != OWNER), point
            assert not (project / ".waffle/journal/active").exists(), point
            if isinstance(point, int):
                assert point == len(saves) + 1 and details["transaction"], (point, details)
                target = details["value"]
                before = last.splitlines(keepends=True)
                after = current[OWNER].splitlines(keepends=True)
                assert len(before) == len(after), point
                changes = [(a, b) for a, b in zip(before, after) if a != b]
                assert len(changes) == 1, (point, changes)
                old, new = [json.loads(row) for row in changes[0]]
                assert old["id"] == "reference-label" and new == {**old, "text": target}, (point, old, new)
                saves.append(point)
                last = current[OWNER]
            else:
                assert current[OWNER] == last, f"{point} wrote the working sheet"
                local_controls.append(point)

        profile = str(uuid.uuid4())
        env = {**spy.child_env, "WAFFLE_FORMAT_TRIAL": str(work), "WAFFLE_FORMAT_DRAFT_PROFILE": profile}
        options = {"manifest": MANIFEST, "head": head}
        probe = Path(__file__).with_suffix(".js")
        with native_host(probe_file=probe, product_root=ROOT,
                         instrumentation=partial(instrumentation, observe_transactions=False)) as exe:
            try:
                assert run_editor(exe, work, env, {**options, "mode": "draft"}, observe) == {"crashDraft": True}
                spy.phase("open")  # ordinary Git discovery on reopen precedes any recovery action
                assert run_editor(exe, work, env, {**options, "mode": "recovery"}, observe) == {"ordinarySaves": 50}
            finally:
                subprocess.run([exe], env={**env, "WAFFLE_FORMAT_REMOVE_DRAFT_PROFILE": profile}, timeout=30, check=True)
        assert saves == list(range(1, 51)) and local_controls == ["draft", "restore", "draft"]
        assert spy.calls("open"), "Positive control: ordinary Open had to reach the Git process spy."
        assert not spy.calls("save") and git_tree(project) == initial_git
        assert spy.git(project, "rev-parse", "HEAD").decode().strip() == head
        spy.git(project, "commit", "--quiet", "-m", "Explicitly commit the saved sheet", "--only", "--", OWNER)
        changed = spy.git(project, "diff-tree", "--no-commit-id", "--name-only", "-r", "HEAD")
        assert changed.decode().splitlines() == [OWNER]
        assert spy.git(project, "show", ":notes.txt") == unrelated.read_bytes()
        assert spy.git(project, "show", "HEAD:notes.txt") == b"Initial tracked notes\n"
        print(f"PASS 50 trusted Command-S saves, 2 timed private drafts and crash recovery; zero Git commands, "
              f"all {len(initial_git)} .git paths byte- and metadata-identical, explicit Git commit changed only {OWNER}.")


if __name__ == "__main__":
    main()
