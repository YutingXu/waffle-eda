"""Measure physical save differences and whole-checkout Git storage in disposable projects."""
from fnmatch import fnmatchcase
import hashlib
import json
import os
from pathlib import Path
import shutil
import stat
import subprocess
import tempfile

CONFIG = [
    "core.autocrlf=false", "core.compression=6", "core.attributesFile=" + os.devnull,
    "core.excludesFile=" + os.devnull, "core.hooksPath=" + os.devnull, "core.logAllRefUpdates=true",
    "commit.gpgSign=false", "gc.auto=0", "gc.cruftPacks=false", "gc.writeCommitGraph=false",
    "gc.reflogExpire=never", "gc.reflogExpireUnreachable=never", "maintenance.auto=false",
    "pack.depth=50", "pack.threads=1", "pack.window=10", "pack.windowMemory=256m", "repack.writeBitmaps=false",
]
PRIVATE = ["cache", "previews", "history", "journal", "local"]
COLLAB_LOCK = "*.waffle.*.waffle-lock"
GIT_COMMAND = ["git", *(arg for setting in CONFIG for arg in ("-c", setting))]


def logical_size(path):
    return sum(p.stat().st_size for p in path.rglob("*") if p.is_file())


class Repo:
    def __init__(self, folder):
        self.folder = Path(folder)
        self.env = {key: value for key, value in os.environ.items() if not key.startswith("GIT_")}
        self.env.update(GIT_ATTR_NOSYSTEM="1", GIT_CONFIG_NOSYSTEM="1", GIT_CONFIG_GLOBAL=os.devnull,
                        GIT_AUTHOR_NAME="Format Benchmark", GIT_AUTHOR_EMAIL="benchmark@example.invalid",
                        GIT_COMMITTER_NAME="Format Benchmark", GIT_COMMITTER_EMAIL="benchmark@example.invalid",
                        GIT_TERMINAL_PROMPT="0", LC_ALL="C")

    def run(self, *args, check=True):
        return subprocess.run([*GIT_COMMAND, *args], cwd=self.folder, env=self.env, capture_output=True, check=check)

    def initialize(self, *, ignore_collaboration_lock=False):
        if (self.folder / ".git").exists():
            raise ValueError("Git measurements require a new disposable checkout")
        self.run("init", "--quiet", "--template=", "--object-format=sha1", "--initial-branch=baseline")
        # Imported folders may predate the tracked ignore template. Keep the local stores and,
        # for the native history probe, the host's root-level collaboration lock out of the diff.
        exclude = self.folder / ".git/info/exclude"
        exclude.parent.mkdir(exist_ok=True)
        patterns = ["/.waffle/" + name + "/" for name in PRIVATE]
        if ignore_collaboration_lock:
            patterns.append("/" + COLLAB_LOCK)
        exclude.write_text("\n".join(patterns) + "\n")
        self.commit(0)

    def diff(self):
        self.run("add", "-A", "--", ".")
        raw = self.run("diff", "--cached", "--no-ext-diff", "--no-textconv", "--no-renames",
                       "--diff-algorithm=myers", "--numstat", "-z", "HEAD", "--", ".").stdout
        additions = deletions = 0
        paths = []
        for row in raw.split(b"\0"):
            if not row:
                continue
            added, deleted, path = row.split(b"\t", 2)
            if not added.isdigit() or not deleted.isdigit():
                raise ValueError("The single-edit probe changed binary data")
            additions += int(added)
            deletions += int(deleted)
            paths.append(os.fsdecode(path))
        return {"files": len(paths), "additions": additions, "deletions": deletions}, paths

    def commit(self, nth):
        date = "@%d +0000" % (1704067200 + nth)
        self.env.update(GIT_AUTHOR_DATE=date, GIT_COMMITTER_DATE=date)
        self.run("add", "-A", "--", ".")
        self.run("commit", "--quiet", "-m", "Small save %03d" % nth if nth else "Baseline")

    def storage(self):
        metadata = self.folder / ".git"
        counts = dict(line.split(": ", 1) for line in self.run("count-objects", "-v").stdout.decode().splitlines())
        return {"gitBytes": logical_size(metadata), "objectBytes": logical_size(metadata / "objects"),
                "looseObjects": int(counts["count"]), "packedObjects": int(counts["in-pack"])}

    def packed(self):
        self.run("gc", "--prune=now")
        return self.storage()

    def packed_checkpoint(self):
        # Pack an isolated object/metadata copy so later commits can still be measured loose.
        with tempfile.TemporaryDirectory(prefix="packed-checkpoint-", dir=self.folder.parent) as path:
            copy = Path(path)
            shutil.copytree(self.folder / ".git", copy / ".git")
            return Repo(copy).packed()

    def start_history(self, other):
        before = self.storage()
        if before["packedObjects"] or before["looseObjects"] == 0:
            raise ValueError("A history trial must start immediately after the baseline commit")
        # Identical initial metadata, objects and refs. Each side gets a separate object database.
        other.mkdir()
        shutil.copytree(self.folder / ".git", other / ".git")
        baseline = Repo(other).packed()
        if before["looseObjects"] != baseline["packedObjects"]:
            raise ValueError("Packing changed the initial object count")
        return before, baseline

    def finish_history(self, before, expected_commits=101):
        commits = int(self.run("rev-list", "--count", "HEAD").stdout)
        if commits != expected_commits or self.run("status", "--porcelain", "-z").stdout:
            raise ValueError(f"The history trial did not produce exactly {expected_commits} clean commits")
        loose = self.storage()
        packed = self.packed()
        if loose["packedObjects"] or packed["looseObjects"] or loose["looseObjects"] != packed["packedObjects"]:
            raise ValueError("Packing changed the object count")
        def result(a, b):
            return {"before": a, "after": b, "gitGrowth": b["gitBytes"] - a["gitBytes"],
                    "objectGrowth": b["objectBytes"] - a["objectBytes"]}
        return {"commits": commits, "loose": result(before[0], loose), "packed": result(before[1], packed)}


def physical_members(root):
    """Snapshot regular-file identity and modification witnesses outside Git and local stores."""
    members = {}
    private = {Path(".waffle") / name for name in PRIVATE}
    pending = [Path()]
    while pending:
        parent = pending.pop()
        for member in (root / parent).iterdir():
            relative = parent / member.name
            local_lock = not parent.parts and fnmatchcase(member.name, COLLAB_LOCK)
            if relative == Path(".git") or relative in private or local_lock:
                continue
            identity = member.lstat()
            if stat.S_ISDIR(identity.st_mode):
                pending.append(relative)
                continue
            if not stat.S_ISREG(identity.st_mode):
                raise ValueError("The history checkout contains a non-regular member")
            members[relative] = (identity.st_dev, identity.st_ino, identity.st_mode, identity.st_size,
                                 identity.st_mtime_ns, identity.st_ctime_ns)
    return members


def physical_digests(root):
    result = {}
    for path in physical_members(root):
        digest = hashlib.sha256()
        with (root / path).open("rb") as source:
            for block in iter(lambda: source.read(1 << 20), b""):
                digest.update(block)
        result[path] = digest.digest()
    return result


def move_bytes(before, after, distance=127_000, *, expected=None):
    old, new = before.splitlines(keepends=True), after.splitlines(keepends=True)
    if len(old) != len(new) or not before.endswith(b"\n") or not after.endswith(b"\n"):
        raise ValueError("A component move changed the document's line structure")
    changes = [(left, right) for left, right in zip(old, new) if left != right]
    if len(changes) != 1:
        raise ValueError("A component move must replace exactly one owner record")
    removed, added = changes[0]
    left, right = json.loads(removed), json.loads(added)
    x, y = left["at"]
    if left["kind"] != "part" or {**left, "at": [x + distance, y]} != right:
        raise ValueError("The persisted record differs from the intended component move")
    if expected is not None and (right["id"] != expected["id"] or right["at"] != expected["at"]):
        raise ValueError("The persisted component differs from the editor's observed component")
    start = next((i for i, (a, b) in enumerate(zip(removed, added)) if a != b), min(len(removed), len(added)))
    tail = 0
    while tail < min(len(removed), len(added)) - start and removed[-tail-1] == added[-tail-1]:
        tail += 1
    return {"files": 1, "additions": 1, "deletions": 1,
            "removedRowBytes": len(removed), "addedRowBytes": len(added),
            "removedSpanBytes": len(removed) - start - tail, "addedSpanBytes": len(added) - start - tail,
            "workingFileBeforeBytes": len(before), "workingFileAfterBytes": len(after)}


class BatchedHistory:
    def __init__(self, repo, before, moves, batch_size, distance=127_000):
        if batch_size <= 0 or moves <= 0 or moves % batch_size:
            raise ValueError("The move count must consist of complete positive batches")
        self.repo, self.before = repo, before
        self.moves, self.batch_size, self.distance = moves, batch_size, distance
        self.members = physical_members(repo.folder)
        self.path = None
        self.previous = None
        self.transactions = set()
        self.checkpoints = []

    def observe(self, n, observation):
        transaction = observation["transaction"]
        if n != len(self.transactions) + 1 or not isinstance(transaction, str) or not transaction or transaction in self.transactions:
            raise ValueError("The editor did not acknowledge a distinct transaction for this move")
        members = physical_members(self.repo.folder)
        paths = [path for path in self.members.keys() | members.keys()
                 if self.members.get(path) != members.get(path)]
        if len(paths) != 1 or paths[0] not in self.members or paths[0] not in members or paths[0].suffix != ".wpcb":
            changed = ", ".join(sorted(path.as_posix() for path in paths)[:8]) or "(none)"
            raise ValueError(f"Physical Save at edit {n} failed the one-file scope check. Expected {observation['path']}. "
                             f"Observed metadata changes at {len(paths)} authored paths ({changed}).")
        changed = paths[0]
        if changed != Path(observation["path"]):
            raise ValueError(f"Physical Save at edit {n} changed {changed.as_posix()} instead of {observation['path']}.")
        if self.path is None:
            self.path = changed
            self.previous = self.repo.run("show", "HEAD:" + changed.as_posix()).stdout
        if changed != self.path:
            raise ValueError("The physical Save changed a different owner than the previous move")
        after = (self.repo.folder / changed).read_bytes()
        if len(after) != members[changed][3]:
            raise ValueError("The owner changed while it was inspected")
        result = move_bytes(self.previous, after, self.distance, expected=observation)
        self.previous, self.members = after, members
        self.transactions.add(transaction)
        if n % self.batch_size == 0:
            git_diff, git_paths = self.repo.diff()
            if git_diff != {"files": 1, "additions": 1, "deletions": 1} or git_paths != [changed.as_posix()]:
                raise ValueError("The batched stage changed more than the moved component's row")
            committed = self.repo.run("show", "HEAD:" + changed.as_posix()).stdout
            move_bytes(committed, after, self.distance * self.batch_size)
            self.repo.commit(n)
            if self.repo.run("show", "HEAD:" + changed.as_posix()).stdout != after:
                raise ValueError("The Git checkpoint does not match the installed working file")
            loose = self.repo.storage()
            packed = self.repo.packed_checkpoint() if n < self.moves else None
            if packed and (packed["looseObjects"] or packed["packedObjects"] != loose["looseObjects"]):
                raise ValueError("Checkpoint packing changed the Git object count")
            self.checkpoints.append({"edit": n, **git_diff, "loose": loose, "packed": packed})
        return {**result, "activeKind": changed.suffix}

    def finish(self):
        expected = self.moves // self.batch_size
        if len(self.checkpoints) != expected or len(self.transactions) != self.moves:
            raise ValueError("Some batch commits did not reach the verified Git checkpoint")
        final = self.repo.finish_history(self.before, expected + 1)
        self.checkpoints[-1]["packed"] = final["packed"]["after"]
        return {**final,
                "editCommits": expected, "editsPerCommit": self.batch_size, "checkpoints": self.checkpoints,
                "gitVersion": self.repo.run("--version").stdout.decode().strip()}
