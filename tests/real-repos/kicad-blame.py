#!/usr/bin/env python3
"""Verify source object attribution on a renamed scratch copy of the public Lily58 keyboard."""
import argparse
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import tempfile

spec = importlib.util.spec_from_file_location("public_git", Path(__file__).with_name("git-workflows.py"))
common = importlib.util.module_from_spec(spec)
spec.loader.exec_module(common)
HEAD = "58c649797c185b7b32b9928d4546665153cfacfd"
MOVE = "5c68a0418d876c4e7639c701eeeddc104839a457"
BOARD = "Lite_Rev3/Lily58_Lite_Rev3.kicad_pcb"
UPSTREAM = "https://github.com/kata0510/Lily58.git"


def raw_placement(repo, revision, ref):
    # Read just the actual KiCad footprint record; the editor importer and attribution are not used.
    script = """
require(process.argv[1]);
const S = AtriumSexpr, root = S.parse(require('node:fs').readFileSync(0, 'utf8'));
const fp = S.all(root, 'footprint').find(f => S.all(f, 'property').some(p => p[1] === 'Reference' && p[2] === process.argv[2]) ||
                                              S.all(f, 'fp_text').some(p => p[1] === 'reference' && p[2] === process.argv[2]));
process.stdout.write(JSON.stringify({id: S.val(fp, 'uuid') || S.val(fp, 'tstamp'), xy: S.one(fp, 'at').slice(1,3)}));
"""
    raw = common.git(repo, "show", revision + ":" + BOARD)
    return json.loads(subprocess.check_output(["node", "-e", script, str(common.ROOT / "app/formats/sexpr.js"), ref], input=raw))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source", default=UPSTREAM)
    parser.add_argument("--shots", type=Path)
    parser.add_argument("--harness", type=Path)
    opts = parser.parse_args()
    with tempfile.TemporaryDirectory(prefix="waffle-public-kicad-", dir=Path.home() / "Library/Caches") as folder:
        work = Path(folder)
        repo = work / "lily58"
        common.git(work, "clone", "-q", "--no-checkout", "--no-local", "--", opts.source, repo.name)
        common.git(repo, "sparse-checkout", "set", "--no-cone", "/" + BOARD)
        common.git(repo, "switch", "-qc", "review-rename", HEAD)
        assert hashlib.sha256(common.git(repo, "show", HEAD + ":LICENSE")).hexdigest() == "d30e24e5e29bd5f296699f92b450dde67d9f8b65ce571a471a9e41ada66f6f6a"
        before, after = [raw_placement(repo, rev, "J10") for rev in (MOVE + "^", MOVE)]
        assert before["id"] == after["id"] and before["xy"] == ["273.66", "177.29"] and after["xy"] == ["272.55", "177.79"]
        renamed = repo / BOARD.replace("Lily58_Lite_Rev3", "Lily58 review")
        common.git(repo, "mv", "--sparse", "--", BOARD, str(renamed.relative_to(repo)))
        common.git(repo, "commit", "-qm", "Rename the Lily58 board without changing any object")
        rename = common.git(repo, "rev-parse", "HEAD").decode().strip()
        assert common.git(repo, "rev-parse", rename + ":" + str(renamed.relative_to(repo))) == common.git(repo, "rev-parse", HEAD + ":" + BOARD)
        bundle = opts.harness
        if not bundle:
            env = dict(os.environ, HARNESS_OUT=str(work / "build"), HARNESS_INSTALL=str(work / "install"))
            subprocess.run(["zsh", str(common.ROOT / "native/tests/macos-harness/build.sh")], check=True, env=env)
            bundle = work / "install/WaffleHarness.app"
        truth = {"name": renamed.name, "ref": "J10", "sourceId": after["id"], "latest": MOVE[:7], "rename": rename[:7],
                 "author": common.git(repo, "show", "-s", "--format=%an", MOVE).decode().strip(),
                 "coordinates": [[k, old, new] for k, old, new in zip(("X", "Y"), before["xy"], after["xy"])]}
        result = common.open_app(work, bundle, renamed, "kicad", truth, opts.shots)
        assert not common.git(repo, "status", "--porcelain", "--", str(renamed.relative_to(repo)))
        print(json.dumps(result))


if __name__ == "__main__":
    main()
