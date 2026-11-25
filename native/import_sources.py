"""Read-only identity of explicitly selected translator inputs inside a saved project worktree.

The native picker supplies the source path, never page-supplied locators. Committed bindings
contain only repo-relative paths. A portable copy, when present, always has the raw SHA name.
"""
import hashlib
import os
from pathlib import Path
import re
import stat
import subprocess
import time

from git_head import SAFE_CONFIG, _clean_env, _run_git

SHA = re.compile(r"[a-f0-9]{64}\Z")
BYTES = 256 * 1024 * 1024
_REPARSE = getattr(stat, "FILE_ATTRIBUTE_REPARSE_POINT", 1024)


def relative_name(name):
    if not isinstance(name, str) or not name or len(name) > 4096 or "\\" in name or ":" in name:
        raise ValueError("Invalid retained source path.")
    if any(p in ("", ".", "..") or p.casefold() == ".git" for p in name.split("/")) or any(ord(c) < 32 or ord(c) == 127 for c in name):
        raise ValueError("Invalid retained source path.")
    return name


def _regular_path(path, root):
    """Reject symlink/reparse traversal, including an intermediate directory."""
    path, root = Path(path), Path(root)
    path.relative_to(root)
    current = root
    for part in path.relative_to(root).parts:
        current /= part
        meta = current.lstat()
        if stat.S_ISLNK(meta.st_mode) or getattr(meta, "st_file_attributes", 0) & _REPARSE:
            raise ValueError("Choose the original source path without links.")
    return path


def read_regular(path, root, maximum=BYTES):
    path = _regular_path(path, root)
    before = path.lstat()
    if not stat.S_ISREG(before.st_mode) or before.st_size > maximum:
        raise ValueError("The source is not a bounded regular file.")
    fd = os.open(path, os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0) | getattr(os, "O_BINARY", 0) | getattr(os, "O_NONBLOCK", 0))
    with os.fdopen(fd, "rb") as src:
        opened = os.fstat(src.fileno())
        if not os.path.samestat(before, opened) or not stat.S_ISREG(opened.st_mode):
            raise ValueError("The selected file changed before it could be read.")
        data = src.read(maximum + 1)
    if len(data) > maximum:
        raise ValueError("The retained input exceeds the size limit.")
    return data


class Git:
    """Git plumbing, bounded and offline, reusing the History runner's process policy."""
    def __init__(self):
        self.env = _clean_env()
        self.until = time.monotonic() + 30

    def run(self, directory, args, limit=65536):
        if args[0] not in ("rev-parse", "log", "cat-file", "ls-tree", "ls-files", "check-ignore"):
            raise ValueError("Invalid source lookup.")
        remaining = self.until - time.monotonic()
        if remaining <= 0:
            raise ValueError("Reading the retained Git source timed out.")
        try:
            literal = [] if args[0] == "check-ignore" else ["--literal-pathspecs"]
            rc, data, over = _run_git(["git", "--no-pager", *literal, *SAFE_CONFIG, "-C", str(directory), *args],
                                      self.env, remaining, limit)
        except FileNotFoundError:
            return None
        except (OSError, subprocess.TimeoutExpired) as error:
            raise ValueError("Git could not verify the retained source.") from error
        if over:
            raise ValueError("Git source lookup exceeds its limit.")
        return data if rc == 0 else None

    def root(self, directory):
        result = self.run(directory, ["rev-parse", "--show-toplevel"])
        return None if not result else Path(os.fsdecode(result.removesuffix(b"\n"))).resolve(strict=True)

    def blob(self, root, commit, path, length):
        # ls-tree verifies the exact path, regular mode and immutable blob, not a symlink or submodule.
        row = self.run(root, ["ls-tree", "-z", commit, "--", path])
        if not row or row.count(b"\0") != 1:
            return None
        header, sep, name = row[:-1].partition(b"\t")
        match = re.fullmatch(rb"100(?:644|755) blob ([a-f0-9]{40}|[a-f0-9]{64})", header)
        if not sep or not match or os.fsdecode(name) != path:
            return None
        oid = match[1].decode("ascii")
        rawsize = self.run(root, ["cat-file", "-s", oid])
        if rawsize is None or rawsize.strip() != str(length).encode():
            return None
        return self.run(root, ["cat-file", "blob", oid], limit=length)


def _identity(sha256, length):
    if not isinstance(sha256, str) or not SHA.fullmatch(sha256) or type(length) is not int or not 0 <= length <= BYTES:
        raise ValueError("Invalid retained source digest or byte length.")


def locate(destination, granted_source, sha256, length):
    """For a new binding. None means store a copy. Tracked mismatches must be resolved by the user."""
    _identity(sha256, length)
    git = Git()
    source = Path(os.path.abspath(granted_source))
    project_root = git.root(destination)
    source_root = git.root(source.parent)
    if not project_root or project_root != source_root:
        return None
    # macOS may expose its system temporary volume under /var while Git returns /private/var.
    # Anchor the selected spelling at the actual worktree inode, then verify every component
    # beneath it. A link to a subdirectory or a symlinked repo entry is still rejected.
    root_stat = project_root.stat()
    anchor = next((p for p in source.parents if os.path.samestat(p.stat(), root_stat)), None)
    if anchor is None or anchor.is_symlink():
        raise ValueError("Choose the source at its original worktree path.")
    rel = relative_name(source.relative_to(anchor).as_posix())
    _regular_path(project_root / rel, project_root)
    tracked = git.run(project_root, ["ls-files", "--stage", "-z", "--", rel])
    if not tracked:
        return None
    algorithm = (git.run(project_root, ["rev-parse", "--show-object-format"]) or b"").strip().decode()
    if algorithm not in ("sha1", "sha256"):
        raise ValueError("Unknown Git object format.")
    head = git.run(project_root, ["rev-parse", "--verify", "HEAD^{commit}"])
    commits = [head.strip()] if head else []
    # A dirty file may be an exact copy of an older commit. Include all reachable local refs;
    # never use the mutable working tree or staged object as an invented immutable reference.
    def candidates():
        yield from commits
        history = git.run(project_root, ["log", "--all", "--full-history", "--format=%H", "--", rel], limit=8 * 1024 * 1024)
        yield from (history or b"").splitlines()
    seen = set()
    for raw in candidates():
        if raw in seen or not re.fullmatch(rb"[a-f0-9]{%d}" % (40 if algorithm == "sha1" else 64), raw):
            continue
        seen.add(raw)
        commit = raw.decode()
        payload = git.blob(project_root, commit, rel, length)
        if payload is not None and hashlib.sha256(payload).hexdigest() == sha256:
            return {"algorithm": algorithm, "commit": commit, "path": rel}
    raise ValueError("The selected tracked bytes have no matching local commit. Choose a verified committed version or commit those bytes and retry.")


def read_pinned(destination, locator, sha256, length, *, working_copy=True):
    _identity(sha256, length)
    if not isinstance(locator, dict) or set(locator) != {"algorithm", "commit", "path"}:
        raise ValueError("Invalid retained Git binding.")
    algorithm, commit, path = locator["algorithm"], locator["commit"], relative_name(locator["path"])
    if algorithm not in ("sha1", "sha256") or not isinstance(commit, str) or not re.fullmatch(r"[a-f0-9]{%d}" % (40 if algorithm == "sha1" else 64), commit):
        raise ValueError("Invalid retained Git commit.")
    git = Git()
    root = git.root(destination)
    if root and (git.run(root, ["rev-parse", "--show-object-format"]) or b"").strip() == algorithm.encode():
        if working_copy:
            working = root.joinpath(*path.split("/"))
            try:
                data = read_regular(working, root, length)
                if len(data) == length and hashlib.sha256(data).hexdigest() == sha256:
                    return data
            except (OSError, ValueError):
                pass
        # A tag or tree object ID is not an immutable commit identity.
        if (git.run(root, ["cat-file", "-t", commit]) or b"").strip() == b"commit":
            data = git.blob(root, commit, path, length)
            if data is not None and hashlib.sha256(data).hexdigest() == sha256:
                return data
    raise ValueError("Missing retained source at " + path + " for " + commit + ". Supply matching source bytes or local Git history.")


def ignore_notice(destination):
    git = Git()
    result = git.run(destination, ["check-ignore", "--no-index", "--", ".waffle/.gitignore", ".waffle/imports"])
    return "An existing Git ignore rule excludes Waffle import data or its ignore file. Review the repository ignore rules." if result else None
