"""Prepare the public commits in a separate Git cache. The application itself stays offline."""
import argparse
import hashlib
import json
from pathlib import Path
import re
import subprocess

HERE = Path(__file__).resolve().parent
DEFAULT = Path.home()/".cache"/"waffle"


def git(repo, *args):
    return subprocess.check_output(["git", "-C", str(repo), *args])


def prepare(project, cache, fidelity):
    repo = cache / project["id"]
    new = not repo.exists()
    if new:
        repo.mkdir(parents=True)
        git(repo, "init", "-q", "-b", "source-history")
        git(repo, "remote", "add", "origin", project["url"])
        refs = [project["head"], *project["otherTips"]]
        git(repo, "fetch", "--no-tags", "origin", *[sha+":refs/remotes/history/pin-"+str(i) for i,sha in enumerate(refs)])
        git(repo, "update-ref", "refs/heads/source-history", refs[0])
    if git(repo, "remote", "get-url", "origin").decode().strip().removesuffix(".git") != project["url"]:
        raise ValueError("Choose a separate public fixture cache.")
    if git(repo, "rev-parse", "HEAD").decode().strip() != project["head"]:
        raise ValueError("Existing public cache is on a different revision.")
    if not project["design"]:
        return
    anchor = repo / project["design"]
    anchor.parent.mkdir(parents=True, exist_ok=True)
    content = git(repo, "cat-file", "blob", "HEAD:"+project["design"])
    if not anchor.exists():
        anchor.write_bytes(content)
    if anchor.read_bytes() != content:
        raise ValueError("Existing working file differs from the pinned public revision.")
    if project["id"] != "pidp11-io-expander" or not fidelity:
        return
    for name in ("PiDP11IOExpander.SchDoc", "PiDP11IOExpander.PcbDoc"):
        pointer = git(repo, "cat-file", "blob", "HEAD:"+name).decode()
        digest = re.search(r"oid sha256:([0-9a-f]{64})", pointer).group(1)
        size = int(re.search(r"size (\d+)", pointer).group(1))
        source = next(fidelity.rglob(name), None)
        if not source:
            continue
        data = source.read_bytes()
        if len(data) != size or hashlib.sha256(data).hexdigest() != digest:
            raise ValueError("The public release drawing differs from the Git LFS pointer.")
        dest = repo/".git"/"lfs"/"objects"/digest[:2]/digest[2:4]/digest
        dest.parent.mkdir(parents=True, exist_ok=True)
        if not dest.exists():
            dest.write_bytes(data)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--cache", type=Path, default=DEFAULT/"project-history")
    parser.add_argument("--fidelity", type=Path, default=DEFAULT/"altium-fidelity"/"pidp11-io-expander")
    args = parser.parse_args()
    for row in json.loads((HERE/"sources.json").read_bytes()):
        prepare(row, args.cache, args.fidelity)
        print(row["id"], row["head"][:12])
