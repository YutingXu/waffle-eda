#!/usr/bin/env python3
"""Read committed revisions of the saved Waffle project in its own Git worktree.

Every native host runs this file (macOS and Windows as `python3 -I -B git_head.py`, Linux
in process) for all Git access, so the rules live in one place:

* History uses read-only plumbing. Explicit merge-driver setup and Commit each use a
  separate allowlist for the Git commands required by that operation.
* Every command gets SAFE_CONFIG: hooks point at the null device, fsmonitor, signatures,
  mailmap, rename following and colour are off, no protocol is allowed (so no fetch or lazy
  fetch) and no credential helper runs. Diffs pass --no-textconv --no-ext-diff --text, so a
  repository's .gitattributes or config cannot run a textconv or external diff program.
  Blobs are read with `cat-file blob`, which applies no filters.
* GIT_* variables are removed from the environment, replace objects are ignored and optional
  locks are off, so reads never refresh or write the index.
* Arguments from the page are never passed through: queries name an operation from QUERY_OPS
  and give only commit identifiers (full hex), small integers or search text, which go to
  Git as one `--grep=`/`--author=` argument each. Ref names are resolved to commit
  identifiers here and only identifiers reach Git.
* Commits are read only when reachable from HEAD or from a local branch, remote-tracking
  branch or tag.
"""
import argparse
import base64
from concurrent.futures import ThreadPoolExecutor
import hashlib
import json
import os
import posixpath
from pathlib import Path
import re
import shlex
import shutil
import stat
import subprocess
import sys
import tempfile
import threading
import time

# Isolated native invocations (-I) omit the sibling helper directory.
sys.path.insert(0, str(Path(__file__).resolve().parent))
from obsolete_project import LIMIT as HEADER_LIMIT, ObsoleteProject, reject as reject_obsolete

SOURCE_EXTENSIONS = frozenset({".prjpcb", ".schdoc", ".pcbdoc", ".kicad_pro", ".kicad_sch", ".kicad_pcb"})
SOURCE_QUERIES = frozenset({"projectLog", "projectBlobs", "sourceRevision", "sourceLog"})
FOLDER_QUERIES = frozenset({"createBranch", "refs", "status", "log", "fileLog", "projectLog", "projectBlobs", "folderRevisions", "mergeBase",
                            "lfsStatus", "lfsLocks", "lfsLock", "lfsUnlock", "commitPlan", "commitStaged"})
MAX_BYTES = 64 * 1024 * 1024
HISTORY_LIMIT = 40
TIMEOUT = 12
PATCH_TIMEOUT = 90
OBJECT_ID = re.compile(rb"(?:[0-9a-f]{40}|[0-9a-f]{64})\Z")
COMMIT_TEXT = re.compile(r"(?:[0-9a-f]{40}|[0-9a-f]{64})\Z")
HEX_PREFIX = re.compile(r"[0-9a-f]{4,64}\Z")
READ_ONLY = frozenset({"rev-parse", "log", "cat-file", "ls-tree", "merge-base", "for-each-ref", "ls-files"})
WRITE_ONLY = frozenset({"config"})
SAFE_CONFIG = ("-c", "core.hooksPath=" + os.devnull, "-c", "core.fsmonitor=false", "-c", "core.untrackedCache=false",
               "-c", "log.showSignature=false", "-c", "log.follow=false", "-c", "log.mailmap=false", "-c", "log.showRoot=true",
               "-c", "color.ui=never", "-c", "diff.renames=false", "-c", "credential.helper=", "-c", "protocol.allow=never",
               "-c", "i18n.logOutputEncoding=UTF-8", "-c", "core.quotePath=false",
               # A folder committed inside a clone that looks like a bare repository is never one (F1).
               "-c", "safe.bareRepository=explicit")
DIFF_SAFE = ("--no-textconv", "--no-ext-diff", "--text", "--no-color", "--no-renames")
LOG_SAFE = ("--no-decorate", "--no-notes", "--no-show-signature")
# Operations the page may ask for (bridge.js gitQuery, each host's gitQuery action).
QUERY_OPS = frozenset({"createBranch", "refs", "log", "fileLog", "status", "read", "mergeBase", "blameLog", "patches", "projectLog", "projectBlobs", "sourceRevision", "sourceLog", "installMergeDriver", "mergeDriverPlan",
                       "folderRevisions", "lfsStatus", "lfsLocks", "lfsLock", "lfsUnlock", "commitPlan", "commitStaged"})
QUERY_KEYS = {
    "refs": set(), "status": set(), "createBranch": {"name", "revision", "confirm"},
    "log": {"refs", "limit", "skip", "search"},
    "fileLog": {"limit", "skip"},
    "read": {"revision"},
    "projectLog": {"limit", "skip", "snapshot", "firstParent", "recordLinks"},
    "projectBlobs": {"revisions"},
    "folderRevisions": {"revisions", "stage", "stages", "known"},
    "sourceRevision": {"revision"},
    "sourceLog": {"limit", "skip"},
    "mergeBase": {"a", "b"},
    "blameLog": {"limit"},
    "patches": {"head", "revisions"},
    "commitPlan": set(), "commitStaged": {"confirm", "message", "paths", "plan"},
    "installMergeDriver": {"confirm", "plan"},
    "mergeDriverPlan": set(),
    "lfsStatus": set(), "lfsLocks": {"confirm"}, "lfsLock": {"confirm"}, "lfsUnlock": {"confirm"},
}
STAGES = {"base": 1, "ours": 2, "theirs": 3}
LOG_LIMIT = 1000
PATCH_BATCH = 256
PATCH_OUTPUT = 48 * 1024 * 1024
SUBJECT = "%<(180,trunc)%s"


class BaselineError(ValueError):
    pass


class OutsideWorktree(BaselineError):
    pass


def _clean_env():
    env = {key: value for key, value in os.environ.items() if not key.startswith("GIT_")}
    env.update(GIT_NO_REPLACE_OBJECTS="1", GIT_NO_LAZY_FETCH="1", GIT_OPTIONAL_LOCKS="0",
               GIT_TERMINAL_PROMPT="0", GIT_CONFIG_NOSYSTEM="1", LC_ALL="C")
    return env


def _subcommand(args):
    i = 0
    while i < len(args) and args[i] == "-c":
        i += 2
    return args[i] if i < len(args) else None


def _text(value, limit=200):
    if not isinstance(value, str) or len(value) > limit or any(ord(ch) < 32 or ord(ch) == 127 for ch in value):
        raise BaselineError("Invalid Git query text.")
    return value


def _integer(args, key, default, low, high):
    value = args.get(key, default)
    if type(value) is not int or not low <= value <= high:
        raise BaselineError("Invalid Git query: " + key + " must be a whole number from %d to %d." % (low, high))
    return value


def _commit(value):
    if not isinstance(value, str) or not COMMIT_TEXT.fullmatch(value):
        raise BaselineError("Choose a full commit identifier from the project history.")
    return value


class _Budget:
    """One byte allowance shared by parallel Git readers (patches)."""

    def __init__(self, limit):
        self.left, self.lock = limit, threading.Lock()

    def take(self, n):
        with self.lock:
            self.left -= n
            return self.left >= 0


def _run_git(command, env, timeout, max_output, output=None, budget=None, input=None, prefix=False):
    """Run Git, reading at most max_output bytes (and no more than the shared budget allows). The
    child is killed as soon as either is exceeded, so memory never holds more than the limit plus one
    block. Returns (returncode, stdout or None, over)."""
    proc = subprocess.Popen(command, stdin=subprocess.DEVNULL if input is None else subprocess.PIPE,
                            stdout=output if output is not None else subprocess.PIPE, stderr=subprocess.DEVNULL, env=env)
    if input is not None:
        def feed():
            try:
                proc.stdin.write(input)
                proc.stdin.close()
            except (OSError, ValueError):
                pass
        threading.Thread(target=feed, daemon=True).start()
    if output is not None:
        try:
            return proc.wait(timeout=timeout), None, False
        except subprocess.TimeoutExpired:
            proc.kill()
            proc.wait()
            raise
    chunks, state = [], {"size": 0, "over": False, "prefix": False}
    read = getattr(proc.stdout, "read1", proc.stdout.read)

    def reader():
        try:
            while True:
                block = read(min(65536, max_output - state["size"]) if prefix else 65536)
                if not block:
                    return
                state["size"] += len(block)
                if state["size"] > max_output or (budget is not None and not budget.take(len(block))):
                    state["over"] = True
                    proc.kill()
                    return
                chunks.append(block)
                if prefix and state["size"] == max_output:
                    state["prefix"] = True
                    proc.kill()
                    return
        except (OSError, ValueError):
            return
    thread = threading.Thread(target=reader, daemon=True)
    thread.start()
    thread.join(timeout)
    if thread.is_alive():
        proc.kill()
        thread.join()
        proc.wait()
        raise subprocess.TimeoutExpired(command, timeout)
    try:
        code = proc.wait(timeout=5)
    except subprocess.TimeoutExpired:
        proc.kill()
        code = proc.wait()
    proc.stdout.close()
    return 0 if state["prefix"] else code, b"".join(chunks), state["over"]


class ProjectHistory:
    def __init__(self, project, need_head=True, source=False):
        project = Path(project)
        self.source = source and project.suffix.lower() in SOURCE_EXTENSIONS
        if not project.is_absolute() or not (self.source or project.suffix.lower() in (".waffle", ".atrium")) or not project.is_file():
            raise BaselineError("Choose a saved .waffle project using its absolute path.")
        if project.is_symlink():
            raise BaselineError("Open the project at its original path to compare revisions.")
        project = project.resolve(strict=True)
        self.file = project
        self._folder_id = None
        if not self.source:
            if project.suffix.lower() == ".atrium":
                raise ObsoleteProject()
            with project.open("rb") as stream:
                self._folder_id = current_project(stream.read(HEADER_LIMIT), project.name)
        self._validated_manifests = set()
        self.env = _clean_env()
        self.until = time.monotonic() + TIMEOUT
        root = self.git(["rev-parse", "--show-toplevel"], OutsideWorktree("The saved project is outside a Git worktree."), cwd=project.parent)
        self.root = Path(os.fsdecode(root.removesuffix(b"\n"))).resolve(strict=True)
        try:
            self.path = project.relative_to(self.root).as_posix()
        except ValueError:
            raise BaselineError("The saved project is outside its Git worktree.") from None
        self.head = None
        try:
            head = self.git(["rev-parse", "--verify", "HEAD^{commit}"], "This Git worktree has no HEAD commit.").strip()
        except BaselineError:
            if need_head:
                raise
            head = None
        if head is not None:
            if not OBJECT_ID.fullmatch(head):
                raise BaselineError("Git returned an invalid commit identifier.")
            self.head = head.decode("ascii")
        self._refs = None
        self._folder_snapshots = {}
        self._folder_manifests = {}
        self.folder_objects = {}

    def git(self, args, failure, max_output=8192, cwd=None, output=None, input=None, allow=READ_ONLY, budget=None, prefix=False):
        if _subcommand(args) not in allow:
            raise BaselineError("Waffle runs only read-only Git commands.")
        remaining = self.until - time.monotonic()
        if remaining <= 0:
            raise BaselineError("Reading the Git revision timed out.")
        # Streamed: the child is killed past max_output (or a shared budget), never buffered first (F2).
        try:
            code, data, over = _run_git(["git", "--no-pager", "--literal-pathspecs", *SAFE_CONFIG,
                                         "-C", os.fspath(cwd or self.root), *args], self.env, remaining, max_output,
                                        output=output, budget=budget, input=input, prefix=prefix)
        except FileNotFoundError:
            raise BaselineError("Git is unavailable. Install Git to compare revisions.") from None
        except subprocess.TimeoutExpired:
            raise BaselineError("Reading the Git revision timed out.") from None
        if over:
            raise BaselineError("The Git response exceeds the comparison size limit.")
        if code:
            if isinstance(failure, BaselineError):
                raise failure
            raise BaselineError(failure)
        return data

    def require_head(self):
        if self.head is None:
            raise BaselineError("This Git worktree has no HEAD commit.")
        return self.head

    # ------------------------------------------------------------------ original calls
    def history(self):
        # A fixed number of commits and display-width-limited subjects keep the
        # picker small. Keep NUL separators even when subjects contain tabs.
        self.require_head()
        data = self.git(["log", *LOG_SAFE, "--follow", "--find-renames", "--no-ext-diff", "--no-textconv",
                         "--diff-filter=AMTR", "-n", str(HISTORY_LIMIT), "-z", "--format=%H%x00%cI%x00" + SUBJECT,
                         self.head, "--", self.path], "Unable to read this project's Git history.", max_output=256*1024)
        fields = data.removesuffix(b"\0").split(b"\0") if data else []
        if len(fields) % 3 or len(fields) > HISTORY_LIMIT*3:
            raise BaselineError("Git returned an invalid history listing.")
        commits = []
        for n in range(0, len(fields), 3):
            commit, date, subject = fields[n:n+3]
            if not OBJECT_ID.fullmatch(commit):
                raise BaselineError("Git returned an invalid commit identifier.")
            commits.append({"revision": commit.decode("ascii"), "subject": subject.decode("utf-8", "replace").strip()[:256],
                            "date": date.decode("ascii")})
        if not commits:
            raise BaselineError("This project path has no committed history.")
        return {"commits": commits, "path": self.path}

    def reachable(self, revision):
        """Refuse commits outside HEAD's history and every local, remote-tracking or tag ref."""
        kind = self.git(["cat-file", "-t", revision], "The selected revision is unavailable locally.").strip()
        if kind != b"commit":
            raise BaselineError("The selected revision is not a commit.")
        if revision == self.head:
            return
        if self.head is not None:
            try:
                self.git(["merge-base", "--is-ancestor", revision, self.head], "outside")
                return
            except BaselineError:
                pass
        found = self.git(["for-each-ref", "--count=1", "--contains", revision, "--format=%(objectname)",
                          "refs/heads", "refs/remotes", "refs/tags"], "The selected commit is outside this checkout's history.")
        if not found.strip():
            raise BaselineError("The selected commit is outside this checkout's history.")

    def read(self, revision, previous, validate_json, output, any_ref=False):
        if revision is None:
            revision = self.require_head()
        else:
            if not isinstance(revision, str) or not OBJECT_ID.fullmatch(revision.encode("utf-8")):
                raise BaselineError("Choose a full commit identifier from the project history.")
            if revision != self.head:
                if any_ref:
                    self.reachable(revision)
                else:
                    # Limit lookups to commits reachable from the current checkout.
                    kind = self.git(["cat-file", "-t", revision], "The selected revision is unavailable locally.").strip()
                    if kind != b"commit":
                        raise BaselineError("The selected revision is not a commit.")
                    self.git(["merge-base", "--is-ancestor", revision, self.require_head()],
                             "The selected commit is outside this checkout's history.")
        blob = self.blob_at(revision)
        if blob is None:
            raise BaselineError("This path has no committed project at "+("Git HEAD." if revision == self.head else "the selected commit."))
        if previous and previous.get("revision") == revision and previous.get("path") == self.path and isinstance(previous.get("text"), str):
            cached = previous["text"].encode("utf-8")
            if self.blob_id(cached) == blob:
                current_project(cached, self.file.name, self._folder_id)
                return previous
        return self.emit_blob(blob, {"revision": revision, "path": self.path}, validate_json, output)

    def literal_blob(self, revision, path):
        row = self.git(["ls-tree", "-z", revision, "--", path], "Unable to inspect the file at the selected commit.")
        if not row:
            return None
        metadata, separator, name = row.removesuffix(b"\0").partition(b"\t")
        fields = metadata.split()
        if (not separator or name != os.fsencode(path) or len(fields) != 3 or fields[0] not in (b"100644", b"100755")
                or fields[1] != b"blob" or not OBJECT_ID.fullmatch(fields[2])):
            raise BaselineError("The selected commit does not contain a regular project file at this path.")
        return fields[2].decode("ascii")

    def history_path(self, revision):
        """Trace the chosen regular file through Git's recorded rename pairs, never a basename guess."""
        path = self.path
        direct = self.literal_blob(revision, path)
        if direct or revision == self.head:
            return path, direct
        # On another branch the selected file may already have been moved away.
        seen = {path}
        for _ in range(16):
            removed = self.git(["log", *LOG_SAFE, "--no-renames", "--diff-filter=D", "-1", "--format=%H",
                                revision, "--", path], "Unable to trace this file's history.").strip()
            if not OBJECT_ID.fullmatch(removed):
                break
            pairs = self.git(["log", *LOG_SAFE, "-1", "--first-parent", "--diff-merges=first-parent", "--find-renames",
                              "--no-ext-diff", "--no-textconv", "--diff-filter=R", "--format=", "--name-status", "-z",
                              removed.decode(), "--"], "Unable to read the historical rename.", max_output=2*1024*1024)
            fields = pairs.rstrip(b"\0").split(b"\0")
            next_path = next((os.fsdecode(b) for kind, a, b in zip(fields[::3], fields[1::3], fields[2::3])
                              if re.fullmatch(rb"R[0-9]+", kind) and a == os.fsencode(path)), None)
            if not next_path or next_path in seen or Path(next_path).suffix.lower() != self.file.suffix.lower():
                break
            seen.add(next_path)
            path = next_path
            direct = self.literal_blob(revision, path)
            if direct:
                return path, direct
        # A commit on the old side of a rename can only use the old name if it is an
        # ancestor of its parent. This excludes later copies and unrelated side branches.
        if not hasattr(self, "_older_names"):
            raw = self.git(["log", *LOG_SAFE, "--follow", "--find-renames", "--no-textconv", "--no-ext-diff",
                            "--format=%x00%H", "--name-status", "-z", self.require_head(), "--", self.path],
                           "Unable to trace this project's old filenames.", max_output=2*1024*1024)
            self._older_names = []
            for block in re.split(rb"\0(?=[0-9a-f]{40}(?:[0-9a-f]{24})?\0)", raw):
                fields = block.rstrip(b"\0").split(b"\0")
                if len(fields) == 4 and OBJECT_ID.fullmatch(fields[0]) and re.fullmatch(rb"R[0-9]+", fields[1].strip()):
                    old = os.fsdecode(fields[2])
                    if Path(old).suffix.lower() == self.file.suffix.lower():
                        self._older_names.append((fields[0].decode(), old))
        for moved, old in self._older_names:
            blob = self.literal_blob(revision, old)
            if blob:
                try:
                    self.git(["merge-base", "--is-ancestor", revision, moved + "^1"], "not an ancestor")
                except BaselineError:
                    continue
                return old, blob
        return self.path, None

    def blob_at(self, revision):
        return self.history_path(revision)[1]

    def source_bytes(self, oid, limit):
        data = self.git(["cat-file", "blob", oid], "A design blob is unavailable locally.", max_output=limit)
        pointer = re.fullmatch(rb"version https://git-lfs.github.com/spec/v1\r?\noid sha256:([0-9a-f]{64})\r?\nsize ([0-9]{1,16})\s*", data)
        if not pointer:
            return data
        digest, size = pointer[1].decode(), int(pointer[2])
        if size > limit:
            raise BaselineError("The Git LFS design exceeds the comparison size limit.")
        common = self.git(["rev-parse", "--path-format=absolute", "--git-common-dir"], "Cannot locate local Git LFS objects.")
        directory = Path(os.fsdecode(common.rstrip(b"\n"))).resolve(strict=True)
        path = directory / "lfs" / "objects" / digest[:2] / digest[2:4] / digest
        try:
            if path.resolve(strict=True) != path or not path.is_file():
                raise OSError
            flags = os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0) | getattr(os, "O_NONBLOCK", 0) | getattr(os, "O_BINARY", 0)
            with os.fdopen(os.open(path, flags), "rb") as stream:
                info = os.fstat(stream.fileno())
                if not stat.S_ISREG(info.st_mode) or info.st_size != size:
                    raise BaselineError("The locally stored Git LFS design has the wrong size.")
                data = stream.read(size + 1)
        except OSError:
            raise BaselineError("Git LFS pointer only · the design content is unavailable locally.") from None
        if len(data) != size or hashlib.sha256(data).hexdigest() != digest:
            raise BaselineError("The locally stored Git LFS design failed its SHA-256 check.")
        return data

    def source_snapshot(self, revision, contents=False):
        """A revision-scoped design selected by the desktop. Never use files from the working tree."""
        anchor, blob = self.history_path(revision)
        if not blob:
            return {"blob": None, "files": [], "missing": []}
        root, name = posixpath.split(anchor)
        entries = [(self.file.name, blob)]
        missing, used = [], {name.casefold()}
        response = {"files": [], "missing": missing}
        remaining = MAX_BYTES

        def read(oid, limit):
            return self.source_bytes(oid, limit)

        suffix = Path(name).suffix.lower()
        if suffix in (".prjpcb", ".kicad_pro"):
            # All names come from this commit's tree, and all allowed members are confined
            # to its directory (Altium) or repository (KiCad shared sheets). Only regular blobs qualify.
            data = self.git(["ls-tree", "-r", "-z", revision, "--", *([root] if root and suffix == ".prjpcb" else [])],
                            "Unable to list the historical project.", max_output=8*1024*1024)
            tree = {}
            for row in data.rstrip(b"\0").split(b"\0"):
                meta, _, path = row.partition(b"\t")
                parts = meta.split()
                if len(parts) == 3 and parts[0] in (b"100644", b"100755") and parts[1] == b"blob" and OBJECT_ID.fullmatch(parts[2]):
                    actual = posixpath.relpath(os.fsdecode(path), root or ".")
                    key = actual.casefold()
                    tree[key] = None if key in tree else (actual, parts[2].decode())

            def add(ref, required=True):
                if len(used) >= 1024:
                    raise BaselineError("The historical project has too many referenced documents.")
                ref = posixpath.normpath(ref.replace(chr(92), "/"))
                key = ref.casefold()
                if key in used:
                    return
                used.add(key)
                outside = posixpath.normpath(posixpath.join(root, ref)).startswith("../") or suffix == ".prjpcb" and ref.startswith("../")
                if (ref.startswith("/") or outside or ":" in ref or any(ord(c) < 32 for c in ref)
                        or not tree.get(key)):
                    if required:
                        missing.append(ref)
                    return
                entries.append(tree[key])

            if suffix == ".prjpcb":
                raw = read(blob, 8*1024*1024)
                try:
                    text = raw.decode("utf-16" if raw.startswith((b"\xff\xfe", b"\xfe\xff")) else "utf-8-sig")
                except UnicodeError:
                    text = raw.decode("cp1252", errors="replace")
                section = True
                for line in text.splitlines():
                    line = line.strip()
                    if line.startswith("["):
                        section = bool(re.fullmatch(r"\[Document[0-9]+\]", line, re.I))
                    k, _, value = line.partition("=")
                    ref = value.strip().strip('"')
                    if section and k.strip().lower() == "documentpath":
                        extension = Path(ref).suffix.lower()
                        if extension in (".schdoc", ".pcbdoc", ".schlib", ".pcblib"):
                            add(ref)
                        elif extension in (".step", ".stp"):
                            # Historical models are optional, as they are when opening a live project.
                            add(ref, required=False)
            else:
                stem = posixpath.splitext(name)[0]
                add(stem + ".kicad_pcb", False)
                add(stem + ".kicad_sch", False)
                sheet_budget = MAX_BYTES
                for path, oid in entries:  # newly discovered child sheets join this bounded traversal
                    if path.lower().endswith(".kicad_sch"):
                        raw = read(oid, sheet_budget)
                        sheet_budget -= len(raw)
                        text = raw.decode("utf-8-sig")
                        for child in re.findall(r'\(property\s+"Sheet ?file"\s+"([^"\r\n]+\.kicad_sch)"', text, re.I):
                            add(posixpath.join(posixpath.dirname(path), child))
                if len(entries) == 1:
                    missing.append("Matching KiCad board or schematic")
        signature = json.dumps([entries, missing], ensure_ascii=True, separators=(",", ":")).encode()
        response["blob"] = hashlib.sha256(signature).hexdigest()
        if contents:
            for path, oid in entries:
                data = read(oid, remaining)
                remaining -= len(data)
                response["files"].append({"name": posixpath.basename(path), "altiumPath": path,
                                          "blob": oid, "data": base64.b64encode(data).decode("ascii")})
        return response

    def check_manifest_blob(self, blob):
        if blob not in self._validated_manifests:
            prefix = self.git(["cat-file", "blob", blob], "The committed project is unavailable locally.",
                              max_output=HEADER_LIMIT, prefix=True)
            current_project(prefix, self.file.name, self._folder_id)
            self._validated_manifests.add(blob)

    def emit_blob(self, blob, info, validate_json, output):
        self.check_manifest_blob(blob)
        size = self.git(["cat-file", "-s", blob], "The committed project object is unavailable locally.").strip()
        if not size.isdigit() or int(size) > MAX_BYTES:
            raise BaselineError("The committed project exceeds the 64 MiB comparison limit.")
        size = int(size)
        command = ["cat-file", "blob", blob]
        failed = "Unable to read the locally committed project."
        # Desktop frames contain a small ASCII header, newline, then exact UTF-8
        # file bytes. Git writes the blob straight into the host's pipe. The
        # consumer checks the declared length and validates the project once.
        if output is not None:
            output.write(json.dumps({**info, "size": size}, ensure_ascii=True).encode("ascii")+b"\n")
            output.flush()
            self.git(command, failed, output=output)
            return None
        data = self.git(command, failed, max_output=size)
        if len(data) != size:
            raise BaselineError("The committed project object is incomplete.")
        return {**info, "text": self.decode_project(data, validate_json)}

    def decode_project(self, data, validate_json):
        current_project(data, self.file.name, self._folder_id)
        try:
            text = data.decode("utf-8-sig")
            if validate_json:
                from project_archive import manifest_references
                manifest_references(data)
            return text
        except (UnicodeError, ValueError, RecursionError) as error:
            raise BaselineError("The file at the selected commit is not valid Waffle project data.") from error

    # ------------------------------------------------------------------ queries
    def refs(self, all_refs=False):
        """Branches, remote-tracking branches and tags (peeled to commits), and HEAD."""
        if self._refs is not None and not all_refs:
            return self._refs
        limit = [] if all_refs else ["--count=2000"]
        data = self.git(["for-each-ref", *limit,
                         "--format=%(refname)%00%(objectname)%00%(objecttype)%00%(*objectname)%00%(*objecttype)%00%(creatordate:iso-strict)",
                         "refs/heads", "refs/remotes", "refs/tags"], "Unable to read the repository's branches and tags.",
                        max_output=4*1024*1024)
        refs = []
        for line in data.split(b"\n"):
            fields = line.split(b"\0")
            if len(fields) != 6:
                continue
            name, oid, kind, peeled, peeled_kind, date = fields
            commit = peeled if kind == b"tag" else oid
            if (kind == b"tag" and peeled_kind != b"commit") or (kind != b"tag" and kind != b"commit") or not OBJECT_ID.fullmatch(commit):
                continue
            try:
                text = name.decode("utf-8")
                _text(text, 256)
            except (UnicodeError, BaselineError):
                continue
            if text.startswith("refs/heads/"):
                group, short = "branch", text[11:]
            elif text.startswith("refs/remotes/"):
                group, short = "remote", text[13:]
                if short.endswith("/HEAD"):
                    continue
            else:
                group, short = "tag", text[10:]
            refs.append({"name": text, "short": short, "kind": group, "revision": commit.decode("ascii"),
                         "date": date.decode("ascii", "replace")[:40]})
        current = None
        if self.head is not None:
            name = self.git(["rev-parse", "--symbolic-full-name", "HEAD"], "Unable to read HEAD.").strip().decode("utf-8", "replace")
            current = name if name.startswith("refs/heads/") else None
        result = {"head": self.head, "ref": current, "refs": refs, "path": self.path}
        if not all_refs:
            self._refs = result
        return result

    def resolve_refs(self, names):
        if names in (None, "all"):
            # Git's own ref selectors: no ref names on the command line.
            return ["--branches", "--remotes", "--tags"] + ([self.head] if self.head else [])
        if names == "head":
            return [self.require_head()]
        if not isinstance(names, list) or not 1 <= len(names) <= 64:
            raise BaselineError("Choose up to 64 branches or tags.")
        known = {ref["name"]: ref["revision"] for ref in self.refs()["refs"]}
        revs = []
        for name in names:
            if name == "HEAD":
                revs.append(self.require_head())
            elif isinstance(name, str) and COMMIT_TEXT.fullmatch(name):
                self.reachable(name)
                revs.append(name)
            elif isinstance(name, str) and name in known:
                revs.append(known[name])
            else:
                raise BaselineError("That branch or tag is not in this repository.")
        return sorted(set(revs))

    FIELDS = "%H%x00%P%x00%an%x00%aI%x00" + SUBJECT

    def parse_commits(self, data):
        fields = data.removesuffix(b"\0").split(b"\0") if data else []
        if len(fields) % 5:
            raise BaselineError("Git returned an invalid history listing.")
        commits = []
        for n in range(0, len(fields), 5):
            commit, parents, author, date, subject = fields[n:n+5]
            commit = commit.lstrip(b"\n")
            parent_ids = parents.split()
            if not OBJECT_ID.fullmatch(commit) or not all(OBJECT_ID.fullmatch(p) for p in parent_ids):
                raise BaselineError("Git returned an invalid commit identifier.")
            commits.append({"revision": commit.decode("ascii"), "parents": [p.decode("ascii") for p in parent_ids],
                            "author": author.decode("utf-8", "replace").strip()[:120], "date": date.decode("ascii", "replace")[:40],
                            "subject": subject.decode("utf-8", "replace").strip()[:256]})
        return commits

    def touching(self, commits):
        """The subset of these commits that changed the project file."""
        ids = [c["revision"] for c in commits]
        found = set()
        for start in range(0, len(ids), 300):
            chunk = ids[start:start+300]
            data = self.git(["log", *LOG_SAFE, "--no-walk=unsorted", "-z", "--format=%H", *chunk, "--", self.path],
                            "Unable to read this project's Git history.", max_output=64*1024)
            found.update(x.strip().decode("ascii") for x in data.split(b"\0") if x.strip())
        return found

    def log(self, args):
        limit = _integer(args, "limit", 200, 1, LOG_LIMIT)
        skip = _integer(args, "skip", 0, 0, 1000000)
        revs = self.resolve_refs(args.get("refs", "all"))
        if not revs:
            return {"commits": [], "path": self.path, "more": False}
        search = args.get("search")
        base = ["log", *LOG_SAFE, "--topo-order", "-z", "--format=" + self.FIELDS]
        if search is None or search == "":
            data = self.git([*base, "--skip=%d" % skip, "-n", str(limit + 1), *revs, "--"], "Unable to read the Git history.",
                            max_output=8*1024*1024)
            commits = self.parse_commits(data)
        else:
            search = _text(search, 200)
            def matches(option):
                data = self.git([*base, "--fixed-strings", "--regexp-ignore-case", option + search, "-n", str(skip + limit + 1),
                                 *revs, "--"], "Unable to search the Git history.", max_output=8*1024*1024)
                return self.parse_commits(data)
            # Git combines these filters with AND. Run them concurrently to find either match.
            with ThreadPoolExecutor(2) as pool:
                merged = {commit["revision"]: commit for group in pool.map(matches, ("--grep=", "--author="))
                          for commit in group}
            prefix = search.lower()
            if HEX_PREFIX.fullmatch(prefix):
                listed = self.git(["rev-parse", "--disambiguate=" + prefix], "Unable to search the Git history.", max_output=64*1024) \
                    if len(prefix) < 40 else prefix.encode("ascii") + b"\n"
                candidates = [x.decode("ascii") for x in listed.split() if OBJECT_ID.fullmatch(x)][:32]
                hits = []
                for candidate in candidates:
                    try:
                        self.reachable(candidate)
                        hits.append(candidate)
                    except BaselineError:
                        pass
                if hits:
                    data = self.git(["log", *LOG_SAFE, "--no-walk=unsorted", "-z", "--format=" + self.FIELDS, *hits, "--"],
                                    "Unable to search the Git history.", max_output=1024*1024)
                    for c in self.parse_commits(data):
                        merged[c["revision"]] = c
            commits = sorted(merged.values(), key=lambda c: c["date"], reverse=True)[skip:skip + limit + 1]
        more = len(commits) > limit
        commits = commits[:limit]
        touched = self.touching(commits)
        for c in commits:
            c["touches"] = c["revision"] in touched
        return {"commits": commits, "path": self.path, "more": more, "head": self.head}

    def create_branch(self, args):
        """The explicit Branch button creates exactly one new local ref, with no checkout or config write."""
        if args.get("confirm") is not True:
            raise BaselineError("Confirm the new Git branch first.")
        name = _text(args.get("name"), 200)
        if not name or name.startswith("-") or name in ("@", "HEAD") or name != name.strip():
            raise BaselineError("Choose a valid Git branch name.")
        revision = _commit(args.get("revision"))
        self.reachable(revision)
        ref = "refs/heads/" + name
        self.git(["check-ref-format", ref], "Choose a valid Git branch name.", allow={"check-ref-format"})
        # The old zero object id makes this create-only, including when another client wins a race.
        self.git(["update-ref", "--no-deref", ref, revision, "0" * len(revision)],
                 "The branch could not be created. It may already exist.", allow={"update-ref"})
        return {"branch": name, "revision": revision}

    def project_log(self, args):
        """All branches in topological order, with real parents. Only requested rows need blob lookups."""
        limit = _integer(args, "limit", 500, 1, LOG_LIMIT)
        skip = _integer(args, "skip", 0, 0, 1000000)
        first_parent = args.get("firstParent", False)
        refs = {"head": self.head, "path": self.path} if first_parent else self.refs(all_refs=True)
        tips = set() if first_parent else {r["revision"] for r in refs["refs"]}
        if self.head:
            tips.add(self.head)
        revisions = "".join(rev + "\n" for rev in sorted(tips)).encode("ascii")
        snapshot = hashlib.sha256((b"first-parent\0" if first_parent else b"") + revisions).hexdigest()
        if "snapshot" in args and args["snapshot"] != snapshot:
            raise BaselineError("The repository history changed. Refresh project history.")
        commits = []
        if tips:
            order = "--first-parent" if first_parent else "--topo-order"
            data = self.git(["log", *LOG_SAFE, order, "-z", "--format=" + self.FIELDS,
                             "--skip=%d" % skip, "-n", str(limit + 1), "--stdin", "--"],
                            "Unable to read the project history.", input=revisions, max_output=8*1024*1024)
            commits = self.parse_commits(data)
        selected = commits[:limit]
        if selected and args.get("recordLinks"):
            self.record_links(selected)
        return {**refs, "commits": selected, "more": len(commits) > limit, "snapshot": snapshot}

    def record_links(self, commits):
        """Return bounded link data from the bodies of the already-authorized log page."""
        ident = r"[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}"
        pattern = re.compile(rf"(?<!\w)waffle://{ident}/{ident}(?:#datasheet:page=[1-9][0-9]{{0,15}})?(?![\w%/#?=&@:+~-])")
        by_id = {commit["revision"]: commit for commit in commits}
        data = self.git(["log", *LOG_SAFE, "--no-walk=unsorted", "--grep=waffle://", "--fixed-strings", "-z",
                         "--format=%H%x00%B", *by_id, "--"], "Unable to read Waffle links in Git messages.",
                        max_output=8*1024*1024)
        fields = data.removesuffix(b"\0").split(b"\0") if data else []
        if len(fields) % 2:
            raise BaselineError("Git returned an invalid message listing.")
        for oid, body in zip(fields[::2], fields[1::2]):
            revision = oid.decode("ascii")
            if revision not in by_id:
                raise BaselineError("Git returned an unexpected commit.")
            links = {}
            for match in pattern.finditer(body.decode("utf-8", "replace")):
                value = match[0]
                if "#" in value and int(value.rsplit("=", 1)[1]) > 9007199254740991:
                    continue
                if len(links) >= 128:
                    by_id[revision]["recordLinksTruncated"] = True
                    break
                links[value] = None
            by_id[revision]["recordLinks"] = list(links)


    def project_blobs(self, args):
        """Resolve the selected project's immutable identity without reading document geometry."""
        revisions = args.get("revisions")
        if not isinstance(revisions, list) or not 1 <= len(revisions) <= 2:
            raise BaselineError("Choose one or two commits from the project history.")
        blobs = {}
        for revision in dict.fromkeys(revisions):
            commit = _commit(revision)
            if commit != self.head and not self._folder_id:
                self.reachable(commit)
            if self.source:
                blobs[commit] = self.source_snapshot(commit)["blob"]
            elif self._folder_id:
                snapshot = self.folder_snapshot(commit)
                blobs[commit] = snapshot.identity() if snapshot.exists else None
            else:
                blobs[commit] = self.blob_at(commit)
        return {"blobs": blobs}

    def folder_snapshot(self, revision):
        if not self._folder_id:
            raise BaselineError("Choose a saved Waffle folder project.")
        if revision not in self._folder_snapshots:
            if revision not in FOLDER_STAGES and revision != self.head:
                self.reachable(_commit(revision))
            self._folder_snapshots[revision] = FolderRevision(self, revision)
            while len(self._folder_snapshots) > 1 and (len(self._folder_snapshots) > 48 or
                    sum(len(item.raw or b"") for item in self._folder_snapshots.values()) > FOLDER_MAX_BUNDLE):
                del self._folder_snapshots[next(iter(self._folder_snapshots))]
        return self._folder_snapshots[revision]

    def folder_revisions(self, args):
        revisions, stage, stages = args.get("revisions"), args.get("stage"), args.get("stages")
        known = args.get("known", [])
        if not isinstance(known, list) or len(known) > 256:
            raise BaselineError("Invalid cached project member list.")
        known = {_commit(value) for value in known}
        if stages is not None:
            if revisions is not None or stage is not None or not 1 <= len(stages) <= 3 or len(set(stages)) != len(stages):
                raise BaselineError("Choose one to three distinct conflict stages.")
            first = self.folder_snapshot(stages[0])
            sides = [first, *(FolderRevision(self, name, index=first.index) for name in stages[1:])]
        elif stage in FOLDER_STAGES and revisions is None:
            sides = [self.folder_snapshot(stage)]
        elif stage is not None or not isinstance(revisions, list) or not 1 <= len(revisions) <= 2:
            raise BaselineError("Choose one or two commits or an index stage.")
        else:
            sides = [self.folder_snapshot(_commit(rev)) for rev in dict.fromkeys(revisions)]
        objects = {}
        bundles = [side.bundle(objects) for side in sides]
        result = {"revisions": bundles}
        if stages is not None:
            removed = self.removed_conflict_owners(first.index, first.index.get(self.path, {}), self.merge_head())
            if removed:
                total = sum(len(raw) for raw in objects.values())
                for member in removed.values():
                    for label, oid in member["stages"].items():
                        if label in stages and oid not in objects:
                            raw = self.source_bytes(oid, MAX_BYTES)
                            total += len(raw)
                            if total > FOLDER_MAX_BUNDLE:
                                raise BaselineError("The saved project revisions exceed the comparison size limit.")
                            objects[oid] = raw
                result["removedOwners"] = removed
        result["objects"] = {key: base64.b64encode(raw).decode("ascii") for key, raw in objects.items() if key not in known}
        return result

    def file_log(self, args):
        limit = _integer(args, "limit", 200, 1, LOG_LIMIT)
        skip = _integer(args, "skip", 0, 0, 1000000)
        self.require_head()
        data = self.git(["log", *LOG_SAFE, "--follow", "--find-renames", "--no-ext-diff", "--no-textconv", "-z", "--format=" + self.FIELDS, "--skip=%d" % skip, "-n", str(limit + 1),
                         self.head, "--", self.path], "Unable to read this project's Git history.", max_output=8*1024*1024)
        commits = self.parse_commits(data)
        for c in commits:
            c["touches"] = True
        return {"commits": commits[:limit], "path": self.path, "more": len(commits) > limit, "head": self.head}

    @staticmethod
    def index_rows(data):
        for row in data.rstrip(b"\0").split(b"\0") if data else ():
            meta, sep, name = row.partition(b"\t")
            fields = meta.split()
            if not sep or not name or len(fields) != 3 or not OBJECT_ID.fullmatch(fields[1]) or fields[2] not in (b"0", b"1", b"2", b"3"):
                raise BaselineError("Git returned an invalid project index entry.")
            mode, oid, stage = fields
            yield os.fsdecode(name), int(stage), mode, oid.decode("ascii")

    def index_entries(self):
        data = self.git(["ls-files", "-s", "-z", "--", self.path], "Unable to read the Git index.", max_output=64*1024)
        stages = {}
        for name, stage, mode, oid in self.index_rows(data):
            if name != self.path:
                raise BaselineError("Git returned an invalid index entry.")
            if mode in (b"100644", b"100755"):
                stages[stage] = oid
        return stages

    def merge_head(self):
        try:
            revision = self.git(["rev-parse", "--verify", "--quiet", "MERGE_HEAD^{commit}"], "none").strip()
            return revision.decode("ascii") if OBJECT_ID.fullmatch(revision) else None
        except BaselineError:
            return None

    def removed_conflict_owners(self, index, manifest_stages, merging):
        """Find modify/delete conflicts no longer named by the merged manifest."""
        stable = manifest_stages.get(0)
        if not self.head or not merging or not stable or stable[0] not in (b"100644", b"100755"):
            return {}
        from io import BytesIO
        from project_archive import DOCUMENTS, manifest_references
        kinds = set(DOCUMENTS.values())
        regular = (b"100644", b"100755")
        candidates = {path: rows for path, rows in index.items()
                      if Path(path).suffix in kinds and 0 not in rows and 1 in rows and (2 in rows) != (3 in rows)
                      and all(mode in regular for mode, _ in rows.values())}
        if not candidates:
            return {}
        _, live = manifest_references(self.source_bytes(stable[1], MAX_BYTES))
        current_ids = {identity for _, _, identity, _ in live}
        root = posixpath.dirname(self.path)
        removed = {}
        for number, revision in ((2, self.head), (3, merging)):
            possible = {path for path, rows in candidates.items() if number in rows}
            if not possible:
                continue
            oid = self.literal_blob(revision, self.path)
            if not oid:
                continue
            raw = self.source_bytes(oid, MAX_BYTES)
            if folder_project_id(raw[:HEADER_LIMIT].partition(b"\n")[0]) != self._folder_id:
                continue
            _, members = manifest_references(raw)
            paths = {}
            for path, kind, identity, opaque in members:
                physical = posixpath.join(root, path)
                if physical in possible and identity not in current_ids and kind in DOCUMENTS and not opaque:
                    match = candidates[physical]
                    # The surviving parent must own this very blob at this exact path.
                    if self.literal_blob(revision, physical) == match[number][1]:
                        paths[identity] = (path, kind, match)
            for line in BytesIO(raw):
                row = json.loads(line)
                member = paths.get(row.get("id"))
                if not member or row.get("path") != member[0]:
                    continue
                path, kind, match = member
                removed[path] = {"id": row["id"], "kind": kind, "edit": STAGES_NAME[number],
                                 "reference": line.decode("utf-8"),
                                 "stages": {STAGES_NAME[stage]: item[1] for stage, item in match.items() if stage in STAGES_NAME}}
        return removed

    def folder_conflicts(self, manifest, stages, merging):
        root = posixpath.dirname(self.path)
        data = self.git(["ls-files", "--unmerged", "-z", "--", *([root] if root else [])],
                        "Unable to read the project's Git conflicts.", max_output=12 * 1024 * 1024)
        if not data:
            return [], None
        from project_archive import manifest_references, walk_graph
        paths, index = {}, {}
        for name, number, mode, oid in self.index_rows(data):
            if number in STAGES_NAME:
                paths.setdefault(posixpath.relpath(name, root or "."), {})[STAGES_NAME[number]] = oid
                index.setdefault(name, {})[number] = (mode, oid)
        owned = {posixpath.basename(self.path)}
        # A conflicted rename can be named by just one of the immutable manifest stages.
        def members(raw):
            current_project(raw, self.file.name, self._folder_id)
            _, refs = manifest_references(raw)
            owned.update(path for path, _, _, _ in refs)
        if manifest is not None:
            members(manifest)
        for oid in set(stages.values()):
            self.check_manifest_blob(oid)
            members(self.source_bytes(oid, MAX_BYTES))
        manifest_rows = {0: (b"100644", stages[0])} if 0 in stages else {}
        owned.update(self.removed_conflict_owners(index, manifest_rows, merging))
        if any(path.startswith(tuple(name + "/" for name in FOLDER_AUXILIARY)) for path in paths.keys() - owned):
            first = self.folder_snapshot("ours")
            for side in [first, *(FolderRevision(self, revision, index=first.index) for revision in ("base", "theirs"))]:
                if side.exists:
                    walk_graph(side.name, side.raw, lambda path: side.member({"path": path})[1], owned.add)
        conflicts = [(path, paths[path]) for path in sorted(paths.keys() & owned)]
        if not conflicts:
            return [], None
        identity = json.dumps(conflicts, ensure_ascii=True, sort_keys=True, separators=(",", ":")).encode("ascii")
        return [{"path": path, "stages": sorted(stages)} for path, stages in conflicts], hashlib.sha256(identity).hexdigest()

    def project_key(self):
        # The opaque local key distinguishes two copies even when their project IDs match.
        # It is independent of the renderer's short-lived grant and current Git HEAD.
        identity = json.dumps([os.path.normcase(os.fspath(self.root)), self.path, self._folder_id],
                              ensure_ascii=True, separators=(",", ":")).encode("ascii")
        return hashlib.sha256(b"waffle-git-project\0" + identity).hexdigest()

    def object_format(self):
        name = self.git(["rev-parse", "--show-object-format"], "Unable to read the repository format.").strip()
        return "sha256" if name == b"sha256" else "sha1"

    def worktree_bytes(self):
        info = os.lstat(self.file)
        if not stat.S_ISREG(info.st_mode):
            raise BaselineError("The project file is not a regular file.")
        if info.st_size > MAX_BYTES:
            raise BaselineError("The project exceeds the 64 MiB comparison limit.")
        with open(self.file, "rb") as handle:
            return handle.read(MAX_BYTES + 1)

    def blob_id(self, data):
        digest = hashlib.sha256 if self.object_format() == "sha256" else hashlib.sha1
        return digest(b"blob %d\0" % len(data) + data).hexdigest()

    def status(self):
        stages = self.index_entries()
        head_blob = self.blob_at(self.head) if self.head else None
        try:
            manifest = self.worktree_bytes()
            worktree = self.blob_id(manifest)
        except OSError:
            manifest = None
            worktree = None
        merging = self.merge_head()
        refs = self.refs()
        conflicts, conflict_version = self.folder_conflicts(manifest, stages, merging)
        return {"head": self.head, "ref": refs["ref"], "path": self.path, "headBlob": head_blob, "indexBlob": stages.get(0),
                "worktreeBlob": worktree, "conflicted": bool(conflicts), "conflicts": conflicts, "projectKey": self.project_key(),
                "stages": sorted({stage for conflict in conflicts for stage in conflict["stages"]}), "mergeHead": merging,
                "conflictVersion": conflict_version}

    def read_query(self, args, output):
        revision = args.get("revision")
        info = {"revision": revision, "path": self.path}
        if revision == "worktree":
            data = self.worktree_bytes()
            current_project(data, self.file.name, self._folder_id)
            info["blob"] = self.blob_id(data)
            if output is not None:
                output.write(json.dumps({**info, "size": len(data)}, ensure_ascii=True).encode("ascii") + b"\n")
                output.write(data)
                output.flush()
                return None
            return {**info, "text": self.decode_project(data, False)}
        if revision == "index" or revision in STAGES:
            stages = self.index_entries()
            blob = stages.get(0 if revision == "index" else STAGES[revision])
            if blob is None:
                raise BaselineError("The project is not staged." if revision == "index" else
                                    "Git has no " + revision + " version of this project: it is not in a merge conflict.")
            return self.emit_blob(blob, {**info, "blob": blob}, False, output)
        commit = _commit(revision)
        if commit != self.head:
            self.reachable(commit)
        blob = self.blob_at(commit)
        if blob is None:
            raise BaselineError("This project is not in the selected commit.")
        return self.emit_blob(blob, {**info, "blob": blob}, False, output)

    def merge_base(self, args):
        a, b = _commit(args.get("a")), _commit(args.get("b"))
        self.reachable(a)
        self.reachable(b)
        try:
            base = self.git(["merge-base", a, b], "none").strip()
        except BaselineError:
            return {"base": None}
        if not OBJECT_ID.fullmatch(base):
            raise BaselineError("Git returned an invalid commit identifier.")
        return {"base": base.decode("ascii")}

    def blame_log(self, args, *, include_paths=False):
        """First-parent commits from HEAD that changed the file, with the blob before and after."""
        limit = _integer(args, "limit", 400, 1, 4000)
        self.require_head()
        data = self.git(["log", *LOG_SAFE, "--first-parent", "--diff-merges=first-parent", "--follow", "--find-renames",
                         "--no-textconv", "--no-ext-diff", "--raw", "--no-abbrev", "-z", "-n", str(limit + 1),
                         "--format=%x01" + self.FIELDS, self.head, "--", self.path], "Unable to read this project's Git history.",
                        max_output=16*1024*1024)
        commits, path = [], os.fsencode(self.path)
        header = re.compile(rb":\d{6} \d{6} ([0-9a-f]{40,64}) ([0-9a-f]{40,64}) ([A-Z])\d*")
        for record in data.split(b"\x01")[1:]:
            parts = record.split(b"\0")
            if len(parts) < 5:
                raise BaselineError("Git returned an invalid history listing.")
            commit = self.parse_commits(b"\0".join(parts[:5]))[0]
            at = 5
            while at < len(parts) and parts[at]:
                entry = header.fullmatch(parts[at].lstrip(b"\n"))
                if not entry or at + 1 >= len(parts):
                    raise BaselineError("Git returned an invalid file history.")
                old, new, status = entry.groups()
                count = 2 if status in (b"R", b"C") else 1
                names = parts[at + 1:at + 1 + count]
                at += 1 + count
                if len(names) != count or not all(names):
                    raise BaselineError("Git returned an invalid historical path.")
                if names[-1] != path:
                    continue
                commit["oldBlob"] = old.decode("ascii") if old.strip(b"0") else None
                commit["blob"] = new.decode("ascii") if new.strip(b"0") else None
                commit["status"] = status.decode("ascii")
                if include_paths:
                    commit["paths"] = tuple(os.fsdecode(name) for name in names)
                commits.append(commit)
                path = names[0]  # Only Git's rename pair can change the name used in older commits.
                break
        if not include_paths:
            for entry in commits[:limit]:
                for obj in (entry["oldBlob"], entry["blob"]):
                    if obj:
                        self.check_manifest_blob(obj)
        return {"commits": commits[:limit], "more": len(commits) > limit, "head": self.head, "path": self.path}

    def patches(self, args):
        """Zero-context hunks of each commit against its first parent, for semantic blame."""
        head = _commit(args.get("head"))
        if head != self.head:
            raise BaselineError("HEAD moved. Run the history again.")
        wanted = args.get("revisions")
        if not isinstance(wanted, list) or not 1 <= len(wanted) <= PATCH_BATCH:
            raise BaselineError("Ask for 1 to %d commits at a time." % PATCH_BATCH)
        wanted = [_commit(c) for c in wanted]
        listed = {c["revision"]: c for c in self.blame_log({"limit": 4000}, include_paths=True)["commits"]}
        if any(c not in listed for c in wanted):
            raise BaselineError("That commit is not in this file's first-parent history.")
        # Size both sides of every commit first: a blob over MAX_BYTES is refused before any diff runs (F2).
        blobs = sorted({b for c in wanted for b in (listed[c]["oldBlob"], listed[c]["blob"]) if b})
        if blobs:
            for blob in blobs:
                self.check_manifest_blob(blob)
            sizes = self.git(["cat-file", "--batch-check=%(objectsize)"], "Unable to size the committed projects.",
                             max_output=64 * len(blobs) + 64, input=("\n".join(blobs) + "\n").encode("ascii"))
            if any(not s.isdigit() or int(s) > MAX_BYTES for s in sizes.split()):
                raise BaselineError("A committed version exceeds the 64 MiB comparison limit.")
        self.until = time.monotonic() + PATCH_TIMEOUT
        budget = _Budget(PATCH_OUTPUT)  # one allowance for every worker together (F2)
        workers = max(1, min(12, (os.cpu_count() or 2), len(wanted)))
        groups = {}
        for revision in wanted:
            c = listed[revision]
            if c["oldBlob"] != c["blob"]:  # A pure rename has no semantic patch.
                groups.setdefault(c["paths"], []).append(revision)
        chunks = [(paths, revisions[i::workers]) for paths, revisions in groups.items()
                  for i in range(min(workers, len(revisions)))]

        def run(job):
            paths, revisions = job
            rename = ["--find-renames"] if len(paths) == 2 else []
            return self.git(["log", *LOG_SAFE, "-p", "-U0", *DIFF_SAFE, *rename, "--first-parent", "--diff-merges=first-parent",
                             "--no-walk=unsorted", "--format=%x01%H", *revisions, "--", *paths], "Unable to read the changes of a commit.",
                            max_output=PATCH_OUTPUT, budget=budget)
        with ThreadPoolExecutor(workers) as pool:
            outputs = list(pool.map(run, chunks))
        if sum(len(o) for o in outputs) > PATCH_OUTPUT:
            raise BaselineError("These commits change too much to compare line by line.")
        result = {}
        for output in outputs:
            for record in output.split(b"\x01")[1:]:
                commit, hunks = parse_patch(record)
                result[commit] = hunks
        return {"head": head, "path": self.path, "patches": [{"revision": c, "hunks": result.get(c, [])} for c in wanted]}


FOLDER_STAGES = {"index": 0, **STAGES}
FOLDER_AUXILIARY = ("assets", "models", ".waffle/imports")
FOLDER_MAX_BUNDLE = 128 * 1024 * 1024


def folder_project_id(line):
    try:
        if not all(tag in line for tag in (b'"formatVersion"', b'"project"')):
            return None
        header = json.loads(line)
        if (isinstance(header, dict) and header.get("kind") == "project" and isinstance(header.get("id"), str)
                and header["id"] and re.fullmatch(r"2\.(?:0|[1-9][0-9]{0,8})", str(header.get("formatVersion", "")))):
            return header["id"]
    except (ValueError, RecursionError):
        pass
    return None


def current_project(data, name, expected=None):
    """Check a bounded historical or working manifest before exposing bytes or traversing owners."""
    prefix = data[:HEADER_LIMIT]
    reject_obsolete(prefix, name)
    line, newline, _ = prefix.partition(b"\n")
    identity = folder_project_id(line) if newline else None
    if not identity:
        try:
            candidate = json.loads(line)
        except (ValueError, RecursionError):
            candidate = None
        if isinstance(candidate, dict) and candidate.get("kind") == "project" and "formatVersion" in candidate:
            raise BaselineError("This revision uses an unsupported Waffle project format.")
        raise BaselineError("The file is not a valid supported Waffle project manifest.")
    if expected is not None and identity != expected:
        raise BaselineError("The selected revision belongs to a different Waffle project.")
    return identity


class FolderRevision:
    """A selected manifest and its owned members in one immutable Git tree or index view."""

    def __init__(self, history, revision, index=None):
        self.history, self.revision = history, revision
        self.index = None
        self.files = {}
        self._identity = None
        if revision in FOLDER_STAGES:
            self.anchor = history.path
            self.index = self.read_index() if index is None else index
            self.oid = self.index_blob(self.anchor)
        else:
            self.anchor, self.oid = history.history_path(revision)
        self.root = posixpath.dirname(self.anchor)
        self.name = posixpath.basename(self.anchor)
        self.exists = self.oid is not None
        self.raw = None
        self.references = []
        self.native = False
        if self.exists:
            history.check_manifest_blob(self.oid)
            self.raw = history._folder_manifests.get(self.oid)
            if self.raw is None:
                self.raw = history.source_bytes(self.oid, MAX_BYTES)
                if len(self.raw) <= 1024 * 1024:
                    history._folder_manifests[self.oid] = self.raw
                    if len(history._folder_manifests) > 16:
                        del history._folder_manifests[next(iter(history._folder_manifests))]
            first = self.raw.partition(b"\n")[0]
            self.native = folder_project_id(first) is not None
            if self.native:
                from project_archive import manifest_references
                header, self.references = manifest_references(self.raw)
                if header["id"] != history._folder_id:
                    raise BaselineError("The selected revision belongs to a different Waffle project.")

    def read_index(self):
        root = posixpath.dirname(self.anchor)
        data = self.history.git(["ls-files", "-s", "-z", "--", *([root] if root else [])],
                                "Unable to read the saved project's index stage.", max_output=12 * 1024 * 1024)
        entries = {}
        for path, stage, mode, oid in self.history.index_rows(data):
            entries.setdefault(path, {})[stage] = (mode, oid)
        return entries

    def index_blob(self, path):
        stages = self.index.get(path, {})
        entry = stages.get(FOLDER_STAGES[self.revision]) or stages.get(0)
        if entry is None:
            return None
        if entry[0] not in (b"100644", b"100755"):
            raise BaselineError("The index does not contain a regular project file: " + path)
        return entry[1]

    def tree_entries(self, paths):
        # The selected manifest supplies these exact relative paths. Bound argument bytes
        # as well as output so a large library index works on Windows and POSIX alike.
        group, size = [], 0

        def find(names):
            raw = self.history.git(["ls-tree", "-z", self.revision, "--", *names],
                                   "Unable to inspect the selected project tree.", max_output=4 * 1024 * 1024)
            wanted = set(names)
            for entry in raw.rstrip(b"\0").split(b"\0") if raw else ():
                meta, sep, name = entry.partition(b"\t")
                mode, kind, oid = meta.split()
                path = os.fsdecode(name)
                if not sep or path not in wanted or not OBJECT_ID.fullmatch(oid):
                    raise BaselineError("Git returned an invalid project tree entry.")
                self.files[posixpath.relpath(path, self.root or ".")] = (mode, kind, oid.decode("ascii"))

        for path in paths:
            path = posixpath.join(self.root, path)
            length = len(path.encode("utf-8")) + 3
            if group and size + length > 12000:
                find(group)
                group, size = [], 0
            group.append(path)
            size += length
        if group:
            find(group)

    def identity(self):
        if not self.exists or not self.native:
            return self.oid
        if self._identity is None:
            roots = [ref[0] for ref in self.references]
            if self.index is None:
                self.tree_entries(roots)
                # Git expands an ancestor pathspec when a requested descendant is in
                # the same invocation. Keep the CAS tree IDs separate from named bindings.
                self.tree_entries(FOLDER_AUXILIARY)
                auxiliary = [(path, self.files.get(path)) for path in FOLDER_AUXILIARY]
            else:
                prefix = self.root + "/" if self.root else ""
                auxiliary = [(path, self.index_blob(path)) for path in sorted(self.index)
                             if path.startswith(tuple(prefix + root + "/" for root in FOLDER_AUXILIARY))]
            owners = [(path, self.member_blob(path, required=True)) for path in sorted(roots)]
            entries = json.dumps([self.oid, owners, auxiliary], ensure_ascii=True,
                                 default=lambda value: value.decode("ascii"), separators=(",", ":")).encode("ascii")
            self._identity = hashlib.sha256(b"WAFFLE-GIT-TREE-V1\0" + entries).hexdigest()
        return self._identity

    def member_blob(self, path, *, required):
        absolute = posixpath.join(self.root, path)
        if self.index is not None:
            blob = self.index_blob(absolute)
        elif path in self.files:
            mode, kind, blob = self.files[path]
            if mode not in (b"100644", b"100755") or kind != b"blob":
                raise BaselineError("The selected commit does not contain a regular project member: " + path)
        else:
            blob = self.history.literal_blob(self.revision, absolute)
        if required and not blob:
            raise BaselineError("Missing required project member: " + path)
        return blob

    def member(self, ref, objects=None):
        path = ref["path"]
        source = ref if ref.get("kind") == "source" else ref.get("source")
        blob = self.member_blob(path, required=not source or not source.get("git"))
        if not blob:
            digest, length = source.get("sha256"), source.get("byteLength")
            key = "source:" + digest
            if objects is None or key not in objects:
                from import_sources import read_pinned
                raw = read_pinned(self.history.file.parent, source["git"], digest, length, working_copy=False)
                return key, raw
            return key, objects[key]
        if objects is not None and blob in objects:
            return blob, objects[blob]
        return blob, self.history.source_bytes(blob, MAX_BYTES)

    def bundle(self, objects):
        response = {"revision": self.revision, "path": self.anchor, "blob": self.identity()}
        if not self.exists:
            return response
        from project_archive import walk_graph
        files = {self.name: self.oid}
        used = sum(len(raw) for raw in objects.values())

        def store(blob, raw):
            nonlocal used
            if blob not in objects:
                used += len(raw)
                if used > FOLDER_MAX_BUNDLE:
                    raise BaselineError("The saved project revisions exceed the comparison size limit.")
                objects[blob] = raw

        def read(path, source=None):
            blob, raw = self.member({"path": path, "source": source}, objects)
            files[path] = blob
            store(blob, raw)
            return raw

        store(self.oid, self.raw)
        walk_graph(self.name, self.raw, read, lambda path: None, binary=read)
        return {**response, "manifest": self.name, "files": files}


# ---------------------------------------------------------------------- explicit Git commit
COMMIT_INSPECT = READ_ONLY | {"symbolic-ref", "check-ref-format"}
COMMIT_WRITE = frozenset({"read-tree", "update-index", "write-tree", "commit-tree", "update-ref"})


def _worktree_git_paths(history, origin):
    """Accept an ordinary .git directory or an actual linked worktree of one."""
    git = history.git
    git_dir = Path(os.fsdecode(git(["rev-parse", "--absolute-git-dir"], "Unable to locate Git.", cwd=origin).removesuffix(b"\n")))
    common = Path(os.fsdecode(git(["rev-parse", "--git-common-dir"], "Unable to locate Git.", cwd=origin).removesuffix(b"\n")))
    git_dir, common = (Path(os.path.abspath(origin / path)) for path in (git_dir, common))
    dot = history.root / ".git"
    nearest = next((p / ".git" for p in (origin, *origin.parents)
                    if (p / ".git").exists() or (p / ".git").is_symlink()), None)
    failure = BaselineError("The saved project is outside its own Git worktree.")
    if nearest != dot or dot.is_symlink() or git_dir.resolve() != git_dir or common.resolve() != common:
        raise failure
    if dot.is_dir():
        if git_dir != dot or common != dot:
            raise failure
    elif dot.is_file():
        backlink = git_dir / "gitdir"
        if (git_dir.parent != common / "worktrees" or common.name != ".git" or not common.is_dir()
                or backlink.is_symlink() or not backlink.is_file()
                or Path(backlink.read_text(encoding="utf-8").strip()).resolve() != dot):
            raise failure
    else:
        raise failure
    if any(path.is_symlink() for path in (common / "objects", common / "refs", common / "packed-refs",
                                          common / "logs", git_dir / "logs", git_dir / "index")):
        raise failure
    return git_dir, common


def _git_commit_branch(history):
    git_dir, common = _worktree_git_paths(history, history.file.parent)
    if any((git_dir / name).exists() for name in ("MERGE_HEAD", "CHERRY_PICK_HEAD", "REVERT_HEAD", "rebase-merge",
                                                  "rebase-apply", "sequencer", "BISECT_START")):
        raise BaselineError("Finish the Git operation already in progress before committing project files.")
    if history.git(["ls-files", "--unmerged", "-z"], "Unable to inspect the Git index.", max_output=1, prefix=True):
        raise BaselineError("Resolve the Git conflicts before committing project files.")
    branch = os.fsdecode(history.git(["symbolic-ref", "--quiet", "HEAD"], "Check out a local branch before committing.",
                                      allow=COMMIT_INSPECT).removesuffix(b"\n"))
    if not branch.startswith("refs/heads/"):
        raise BaselineError("Check out a local branch before committing.")
    history.git(["check-ref-format", branch], "The current Git branch is invalid.", allow=COMMIT_INSPECT)
    for ref in (common / branch, common / "logs" / branch):
        for path in (ref, *ref.parents):
            if path == common:
                break
            if path.is_symlink():
                raise BaselineError("The local Git branch uses a redirected reference.")
    return branch


def _owned_git_members(side):
    from project_archive import IGNORE, walk_graph
    if not side or not side.exists or not side.native:
        return set()
    owned = {side.name, IGNORE}
    walk_graph(side.name, side.raw, lambda path: side.member({"path": path})[1], owned.add)
    return {posixpath.join(side.root, path) for path in owned}


def _git_commit_plan(history):
    branch = _git_commit_branch(history)
    staged = history.folder_snapshot("index")
    saved = history.folder_snapshot(history.head) if history.head else None
    if staged.exists and not staged.native:
        raise BaselineError("Stage a valid native Waffle manifest before committing.")
    if saved and saved.exists and not saved.native:
        saved = None
    if saved and saved.exists and saved.root != staged.root:
        raise BaselineError("Commit a move of the project folder with Git.")
    touched = _owned_git_members(staged) | _owned_git_members(saved)
    if not staged.exists:
        return {"branch": branch, "head": history.head, "paths": [], "plan": None}, {}, {}
    if saved:
        saved.tree_entries(posixpath.relpath(path, saved.root or ".") for path in sorted(touched))
    before = {}
    if saved:
        for path, (mode, kind, oid) in saved.files.items():
            if kind == b"blob" and mode in (b"100644", b"100755"):
                before[posixpath.join(saved.root, path)] = (mode, oid)
    changes = {}
    for path in sorted(touched):
        entry = staged.index.get(path, {}).get(0)
        if entry and entry[0] not in (b"100644", b"100755"):
            raise BaselineError("The Git index does not contain a regular project member: " + path)
        if before.get(path) != entry:
            changes[path] = entry
    rows = [{"path": p, "change": "removed" if not entry else "modified" if p in before else "added"}
            for p, entry in changes.items()]
    identity = [history.project_key(), branch, history.head, [(p, before.get(p), entry) for p, entry in changes.items()]]
    token = hashlib.sha256(json.dumps(identity, ensure_ascii=True, default=lambda b: b.decode("ascii")).encode("ascii")).hexdigest()
    return {"branch": branch, "head": history.head, "paths": rows, "plan": token}, changes, before


def _validate_commit_tree(history, selected, before):
    from project_archive import walk_graph
    root, name = posixpath.split(history.path)

    def blob(path, source=None):
        full = posixpath.join(root, path)
        entry = selected[full] if full in selected else before.get(full)
        if entry:
            return entry[1]
        if not source or not source.get("git"):
            raise BaselineError("Select the staged files required by the project: " + path)
        return None

    def read(path):
        return history.source_bytes(blob(path), MAX_BYTES)

    raw = read(name)
    current_project(raw, name, history._folder_id)
    walk_graph(name, raw, read, lambda _path: None, binary=blob)


def commit_staged_project(history, args):
    """Commit staged bytes for chosen project paths, leaving the real index byte-identical."""
    if (args.get("confirm") is not True or not isinstance(args.get("plan"), str)
            or not isinstance(args.get("paths"), list) or not 1 <= len(args["paths"]) <= 256
            or len(set(args["paths"])) != len(args["paths"])):
        raise BaselineError("Preview and confirm the exact paths to commit.")
    message = _text(args.get("message"), 256).strip()
    if not message:
        raise BaselineError("Enter a commit message.")
    preview, changes, before = _git_commit_plan(history)
    if args["plan"] != preview["plan"] or not set(args["paths"]) <= changes.keys():
        raise BaselineError("Git HEAD or the staged project files changed. Preview the commit again.")
    selected = {path: changes[path] for path in args["paths"]}
    git = history.git
    head = history.head
    zero = "0" * (64 if history.object_format() == "sha256" else 40)
    branch = preview["branch"]
    git_dir, _ = _worktree_git_paths(history, history.file.parent)
    lock = git_dir / "index.lock"
    try:
        fd = os.open(lock, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    except FileExistsError:
        raise BaselineError("The Git index is busy. Preview the commit again.") from None
    lock_info = os.fstat(fd)
    os.close(fd)
    try:
        verified, _, _ = _git_commit_plan(ProjectHistory(history.file, need_head=False))
        if verified["plan"] != preview["plan"]:
            raise BaselineError("Git HEAD or the staged project files changed. Preview the commit again.")
        _validate_commit_tree(history, selected, before)
        with tempfile.TemporaryDirectory(prefix="waffle-git-commit-") as scratch:
            git_env = history.env
            history.env = {**git_env, "GIT_INDEX_FILE": str(Path(scratch) / "index")}
            try:
                git(["read-tree", head or "--empty"], "Could not read the parent commit tree.", allow=COMMIT_WRITE)
                rows = [(entry[0], entry[1], path) if entry else (b"0", zero, path) for path, entry in selected.items()]
                index = b"".join(mode + b" " + oid.encode("ascii") + b"\t" + os.fsencode(path) + b"\0"
                                 for mode, oid, path in rows)
                git(["update-index", "-z", "--index-info"], "Could not assemble the selected Git paths.", input=index, allow=COMMIT_WRITE)
                tree = _commit(git(["write-tree"], "Could not write the selected Git tree.", allow=COMMIT_WRITE).strip().decode("ascii"))
                commit = _commit(git(["-c", "commit.gpgSign=false", "commit-tree", tree, "--no-gpg-sign",
                                      *(["-p", head] if head else []), "-F", "-"],
                                     "Could not create the commit. Check your Git author name and email.",
                                     input=(message + "\n").encode("utf-8"), allow=COMMIT_WRITE).strip().decode("ascii"))
            finally:
                history.env = git_env
        git(["update-ref", "-m", "Waffle: commit selected project files", branch, commit, head or zero],
            "Git HEAD moved. Preview the commit again.", allow=COMMIT_WRITE)
    finally:
        try:
            if os.path.samestat(lock_info, lock.lstat()):
                lock.unlink()
        except FileNotFoundError:
            pass
    return {"commit": commit, "branch": branch, "paths": list(selected)}


def baseline(project, previous=None, *, validate_json=True, revision=None):
    """Read a pinned revision, optionally reusing metadata verified by the caller."""
    return ProjectHistory(project).read(revision, previous, validate_json, None)


STAGES_NAME = {1: "base", 2: "ours", 3: "theirs"}
HUNK = re.compile(rb"@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@")


def parse_patch(record):
    """One `log -p -U0` record: the commit line, then the file header and hunks.

    Returns (commit, [[oldStart, oldCount, newStart, newCount, removedLines, addedLines], ...]).
    Hunk bodies are read by count, so removed or added lines that look like headers stay content."""
    lines = record.split(b"\n")
    commit = lines[0].strip()
    if not OBJECT_ID.fullmatch(commit):
        raise BaselineError("Git returned an invalid commit identifier.")
    hunks, i = [], 1
    while i < len(lines):
        match = HUNK.match(lines[i])
        if not match:
            i += 1
            continue
        a, b, c, d = int(match.group(1)), int(match.group(2) or 1), int(match.group(3)), int(match.group(4) or 1)
        i += 1
        removed, added = [], []
        while i < len(lines) and (len(removed) < b or len(added) < d):
            line = lines[i]
            if line.startswith(b"-") and len(removed) < b:
                removed.append(line[1:].decode("utf-8", "replace"))
            elif line.startswith(b"+") and len(added) < d:
                added.append(line[1:].decode("utf-8", "replace"))
            elif not line.startswith(b"\\"):
                raise BaselineError("Git returned an invalid patch.")
            i += 1
        if len(removed) != b or len(added) != d:
            raise BaselineError("Git returned an incomplete patch.")
        hunks.append([a, b, c, d, removed, added])
    return commit.decode("ascii"), hunks


def validate_query(op, args):
    """The shape every host checks before it starts this script (main.swift gitQueryArguments,
    Policy.GitQuery on Windows, waffle.py through this function): an allowed operation and its
    keys; strings of at most 256 printable characters; whole numbers from 0 to 10,000,000;
    bounded lists for refs, commit IDs, and conflict stages, and booleans for explicit flags.
    Returns a clean copy."""
    if op not in QUERY_OPS:
        raise BaselineError("Waffle does not run that Git query.")
    if args is None:
        args = {}
    if not isinstance(args, dict) or not set(args) <= QUERY_KEYS[op]:
        raise BaselineError("Waffle does not run that Git query.")
    clean = {}
    for key, value in args.items():
        if key in ("confirm", "firstParent", "recordLinks"):
            if type(value) is not bool:
                raise BaselineError("Waffle does not run that Git query.")
        elif key == "stages":
            if not isinstance(value, list) or not 1 <= len(value) <= 3 or any(
                    not isinstance(item, str) or item not in STAGES for item in value):
                raise BaselineError("Choose up to three Git conflict stages.")
        elif key == "paths":
            if not isinstance(value, list) or not 1 <= len(value) <= 256:
                raise BaselineError("Choose one to 256 staged project files.")
            value = [_query_text(item) for item in value]
        elif type(value) in (int, float) and type(value) is not bool:
            if not 0 <= value <= 10000000 or value != int(value):
                raise BaselineError("Waffle does not run that Git query.")
            value = int(value)
        elif isinstance(value, list):
            if key not in ("refs", "revisions", "known") or len(value) > 256:
                raise BaselineError("Waffle does not run that Git query.")
            value = [_query_text(item) for item in value]
            if key in ("revisions", "known") and not all(COMMIT_TEXT.fullmatch(item) for item in value):
                raise BaselineError("Waffle does not run that Git query.")
        else:
            value = _query_text(value)
        clean[key] = value
    return clean


def _query_text(value):
    try:
        return _text(value, 256)
    except BaselineError:
        raise BaselineError("Waffle does not run that Git query.") from None


def query(project, op, args=None, output=None):
    args = validate_query(op, args)
    if Path(project).suffix.lower() in SOURCE_EXTENSIONS:
        if op not in SOURCE_QUERIES:
            raise BaselineError("This operation needs a saved Waffle project.")
        history = ProjectHistory(project, need_head=False, source=True)
        if op == "projectLog":
            return history.project_log(args)
        if op == "sourceLog":
            limit = _integer(args, "limit", 40, 1, LOG_LIMIT)
            skip = _integer(args, "skip", 0, 0, 1000000)
            rows = history.parse_commits(history.git(["log", *LOG_SAFE, "--first-parent", "-z", "--format=" + history.FIELDS,
                                          "--skip=" + str(skip), "-n", str(limit + 1), history.require_head(), "--"],
                                         "Unable to read the source history.", max_output=4*1024*1024))
            return {"commits": rows[:limit], "head": history.head, "more": len(rows) > limit, "path": history.path}
        if op == "projectBlobs":
            return history.project_blobs(args)
        revision = _commit(args.get("revision"))
        history.reachable(revision)
        return history.source_snapshot(revision, contents=True)
    if op in ("sourceRevision", "sourceLog"):
        raise BaselineError("Choose an Altium or KiCad source to read design revisions.")
    if op.startswith("lfs"):
        return lfs_query(project, op, args)
    if op == "installMergeDriver":
        if args.get("confirm") is not True or not isinstance(args.get("plan"), str):
            raise BaselineError("Registering the merge driver needs your confirmation of the files it writes.")
        return install_merge_driver(project, plan=args.get("plan"))
    if op == "mergeDriverPlan":
        return {k: v for k, v in merge_driver_plan(project).items() if k != "history"}
    history = ProjectHistory(project, need_head=op in ("log", "fileLog", "mergeBase", "blameLog", "patches"))
    if op == "commitPlan":
        return _git_commit_plan(history)[0]
    if op == "commitStaged":
        return commit_staged_project(history, args)
    if op == "createBranch":
        return history.create_branch(args)
    if op == "refs":
        return history.refs()
    if op == "status":
        return history.status()
    if op == "log":
        return history.log(args)
    if op == "fileLog":
        return history.file_log(args)
    if op == "projectLog":
        return history.project_log(args)
    if op == "projectBlobs":
        return history.project_blobs(args)
    if op == "folderRevisions":
        return history.folder_revisions(args)
    if op == "read":
        return history.read_query(args, output)
    if op == "mergeBase":
        return history.merge_base(args)
    if op == "blameLog":
        return history.blame_log(args)
    return history.patches(args)


# ---------------------------------------------------------------------- Git LFS locks
# The project file's Git LFS lock,
# for teams whose repository marks .waffle files lockable. Repository code never runs:
#   * Git itself runs only through ProjectHistory.git() (SAFE_CONFIG, --literal-pathspecs, a
#     scrubbed environment and GIT_CONFIG_NOSYSTEM), for check-attr, remote and a config scan.
#   * git-lfs is run by its absolute path, never as "git lfs", so alias.lfs cannot apply; it is
#     found on PATH (absolute directories outside the repository only).
#   * lfsStatus is local and never runs git-lfs inside the repository: "git-lfs version" runs in
#     the filesystem root.
#   * lfsLocks, lfsLock and lfsUnlock contact the LFS server, so they run only for an explicit
#     user command (confirm: true). They refuse when repository-level config (local or worktree
#     scope, includes too) sets a key that runs a command or redirects the connection. The Git
#     commands git-lfs starts get safe settings through GIT_CONFIG_PARAMETERS; the user's own
#     global credentials apply, and nothing prompts (GIT_TERMINAL_PROMPT=0).
LFS_TIMEOUT = 30
LFS_OUTPUT = 1024 * 1024
LFS_ALLOW = frozenset({"check-attr", "remote", "config"})
LFS_CHILD_CONFIG = ("core.hooksPath=" + os.devnull, "core.fsmonitor=false", "core.untrackedCache=false",
                    "safe.bareRepository=explicit", "protocol.file.allow=never", "protocol.ext.allow=never")
# Repository config keys that run a command, or send the connection or credentials elsewhere.
LFS_EXEC_KEYS = re.compile(r"(core\.(sshcommand|gitproxy|askpass|fsmonitor|hookspath)|credential\..*helper"
                           r"|lfs\.customtransfer\..*|lfs\.standalonetransferagent|lfs\.extension\..*"
                           r"|remote\..*\.(uploadpack|receivepack|proxy|vcs)|url\..*\.(insteadof|pushinsteadof)"
                           r"|http\..*\.?(proxy|sslcainfo|sslcert|sslkey|cookiefile|extraheader)|include\.path|includeif\..*"
                           r"|filter\..*|alias\.lfs)\Z", re.I)


def _git_lfs_binary(root):
    """git-lfs's absolute path from PATH (absolute folders outside the repository), or None."""
    root = os.path.realpath(os.fspath(root))
    folders = []
    for folder in os.environ.get("PATH", "").split(os.pathsep):
        if not folder or not os.path.isabs(folder):
            continue
        real = os.path.realpath(folder)
        if real == root or real.startswith(root + os.sep):
            continue
        folders.append(folder)
    found = shutil.which("git-lfs", path=os.pathsep.join(folders)) if folders else None
    return os.path.abspath(found) if found else None


def _lfs_env(history):
    env = dict(history.env)  # GIT_* scrubbed, GIT_CONFIG_NOSYSTEM, GIT_TERMINAL_PROMPT=0
    env["GIT_CONFIG_PARAMETERS"] = " ".join("'" + item + "'" for item in LFS_CHILD_CONFIG)
    return env


def _lfs_tool(binary, args, cwd, env, network):
    try:
        result = subprocess.run([binary, *args], cwd=cwd, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                                env=env, timeout=LFS_TIMEOUT, check=False)
    except (FileNotFoundError, PermissionError):
        raise BaselineError("Git LFS could not be started.") from None
    except subprocess.TimeoutExpired:
        raise BaselineError("The Git LFS server did not answer in time." if network else "Git LFS timed out.") from None
    message = result.stderr[:2000].decode("utf-8", "replace").strip().splitlines()
    return result.returncode, result.stdout[:LFS_OUTPUT], (message[0][:300] if message else "")


def _lfs_unsafe_config(history):
    """Repository-level (local or worktree scope) keys that would run a command or redirect git-lfs."""
    try:
        out = history.git(["config", "--show-scope", "--null", "--list"], "Unable to read the repository's Git config.",
                          max_output=LFS_OUTPUT, allow=LFS_ALLOW)
    except BaselineError:
        return ["(unreadable config)"]
    found = []
    fields = out.split(b"\0")
    # --null --show-scope --list: "<scope>\0<key>\n<value>\0" per entry.
    for i in range(0, len(fields) - 1, 2):
        scope = fields[i].decode("utf-8", "replace").strip()
        key = fields[i + 1].split(b"\n", 1)[0].decode("utf-8", "replace").strip()
        if scope in ("local", "worktree") and LFS_EXEC_KEYS.match(key):
            found.append(key)
    return found


def _lfs_owner(lock):
    owner = lock.get("owner") if isinstance(lock, dict) else None
    name = owner.get("name") if isinstance(owner, dict) else None
    return name[:120] if isinstance(name, str) else None


def lfs_query(project, op, args):
    if op != "lfsStatus" and args.get("confirm") is not True:
        raise BaselineError("Contacting the Git LFS server needs your confirmation.")
    try:
        history = ProjectHistory(project, need_head=False)
    except BaselineError:
        if op == "lfsStatus":
            return {"git": False}
        raise
    path, binary = history.path, _git_lfs_binary(history.root)
    if op == "lfsStatus":
        installed = False
        if binary:
            code, _, _ = _lfs_tool(binary, ["version"], os.path.abspath(os.sep), _lfs_env(history), False)
            installed = code == 0
        attrs = {}
        try:
            out = history.git(["check-attr", "filter", "lockable", "--", path], "Unable to read the project's Git attributes.", allow=LFS_ALLOW)
        except BaselineError:
            out = b""
        for line in out.decode("utf-8", "replace").splitlines():
            parts = line.rsplit(": ", 2)
            if len(parts) == 3:
                attrs[parts[1]] = parts[2]
        try:
            remotes = history.git(["remote"], "Unable to list the repository's remotes.", allow=LFS_ALLOW).decode("utf-8", "replace").split()
        except BaselineError:
            remotes = []
        return {"git": True, "lfs": installed, "path": path, "tracked": attrs.get("filter") == "lfs",
                "lockable": attrs.get("lockable") not in (None, "unspecified", "unset"), "remote": remotes[0][:80] if remotes else None, "cached": None}
    if not binary:
        raise BaselineError("Git LFS is not installed.")
    unsafe = _lfs_unsafe_config(history)
    if unsafe:
        raise BaselineError("This repository's own Git settings (" + ", ".join(sorted(set(unsafe)))[:200] +
                            ") would run commands or redirect the connection, so Waffle will not contact the LFS server for it. Use git lfs in a terminal.")
    env, root = _lfs_env(history), os.fspath(history.root)
    if op == "lfsLocks":
        rc, out, message = _lfs_tool(binary, ["locks", "--verify", "--json", "--path=" + path], root, env, True)
        if rc != 0:
            rc, out, message = _lfs_tool(binary, ["locks", "--json", "--path=" + path], root, env, True)
            if rc != 0:
                raise BaselineError(message or "Git LFS could not list locks.")
        try:
            value = json.loads(out)
        except ValueError:
            raise BaselineError("Git LFS returned an invalid lock list.") from None
        if isinstance(value, dict):
            ours = [l for l in value.get("ours") or [] if isinstance(l, dict) and l.get("path") == path]
            theirs = [l for l in value.get("theirs") or [] if isinstance(l, dict) and l.get("path") == path]
            lock = (ours or theirs or [None])[0]
            return {"locked": lock is not None, "owner": _lfs_owner(lock), "mine": bool(ours)}
        locks = [l for l in value if isinstance(l, dict) and l.get("path") == path] if isinstance(value, list) else []
        return {"locked": bool(locks), "owner": _lfs_owner(locks[0]) if locks else None}
    if op == "lfsLock":
        rc, out, message = _lfs_tool(binary, ["lock", "--json", "--", path], root, env, True)
        if rc != 0:
            return {"locked": False, "message": message or "Git LFS could not lock the file."}
        try:
            value = json.loads(out)
        except ValueError:
            value = {}
        return {"locked": True, "owner": _lfs_owner(value)}
    rc, out, message = _lfs_tool(binary, ["unlock", "--json", "--", path], root, env, True)
    if rc != 0:
        return {"unlocked": False, "message": message or "Git LFS could not unlock the file."}
    return {"unlocked": True}


# ---------------------------------------------------------------------- merge driver
MERGE_ATTRIBUTE = "*.waffle merge=waffle"
MERGE_FILE_KINDS = {
    ".waffle": "project", ".wsch": "schematic", ".wpcb": "pcb", ".wdraw": "drawing",
    ".wpanel": "panel", ".wlib": "library", ".wblock": "block",
}
MERGE_ATTRIBUTES = (MERGE_ATTRIBUTE, *(f"*{suffix} merge=waffle" for suffix in MERGE_FILE_KINDS if suffix != ".waffle"))


def driver_command():
    """The merge.waffle.driver value: this Python and this script, quoted for git's shell."""
    script = Path(__file__).resolve()
    quote = lambda value: shlex.quote(str(value).replace("\\", "/"))
    return quote(sys.executable) + " -I -B " + quote(script) + " --merge-driver %O %A %B -- %P"


def _repository(project=None, repo=None):
    if project is not None:
        history = ProjectHistory(project, need_head=False)
        history.origin = history.file.parent
        return history
    history = ProjectHistory.__new__(ProjectHistory)
    history.env, history.until, history._refs = _clean_env(), time.monotonic() + TIMEOUT, None
    top = history.git(["rev-parse", "--show-toplevel"], "That folder is not a Git worktree.", cwd=Path(repo).resolve())
    history.root = Path(os.fsdecode(top.removesuffix(b"\n"))).resolve(strict=True)
    history.origin = Path(repo).resolve()
    return history


def merge_driver_plan(project=None, repo=None):
    """Where Set Up would write, read-only (F4). Refuses a repository whose git directory is not
    <worktree>/.git (core.worktree pointing elsewhere, a .git file naming another repository) unless it
    is a linked worktree of a normal repository, and a .gitattributes that is not a regular file. The
    plan token names the exact files and driver; installMergeDriver needs it back."""
    history = _repository(project, repo)
    # Asked from the project's own folder: `git -C <toplevel>` would find whatever repository owns the
    # toplevel folder, which core.worktree can make an ancestor's.
    top, here = history.root, history.origin
    git_dir = Path(os.fsdecode(history.git(["rev-parse", "--absolute-git-dir"], "Unable to locate the Git directory.", cwd=here).strip())).resolve()
    common = Path(os.fsdecode(history.git(["rev-parse", "--git-common-dir"], "Unable to locate the Git directory.", cwd=here).strip()))
    common = (common if common.is_absolute() else here / common).resolve()
    dot = top / ".git"
    redirected = BaselineError("This repository's Git directory is not " + str(dot) + " (core.worktree or a .git file points elsewhere). "
                               "Waffle does not set up the merge driver here; run git config yourself if you mean it.")
    if dot.is_symlink():
        raise redirected
    if dot.is_dir():
        if git_dir != dot.resolve() or common != git_dir:
            raise redirected
    elif dot.is_file():
        # A linked worktree: <main>/.git/worktrees/<name>, with <main>/.git a real directory.
        if git_dir.parent != common / "worktrees" or common.name != ".git" or common.is_symlink() or not common.is_dir():
            raise redirected
    else:
        raise redirected
    attributes = top / ".gitattributes"
    try:
        info = os.lstat(attributes)
        if not stat.S_ISREG(info.st_mode):
            raise BaselineError(str(attributes) + " is not a regular file.")
    except FileNotFoundError:
        pass
    config, driver = common / "config", driver_command()
    if not stat.S_ISREG(config.lstat().st_mode):
        raise BaselineError(str(config) + " is not a regular repository config file.")
    token = hashlib.sha256(json.dumps([str(config), str(attributes), driver, MERGE_ATTRIBUTES]).encode("utf-8")).hexdigest()[:32]
    return {"config": str(config), "attributes": str(attributes), "attributeLines": list(MERGE_ATTRIBUTES),
            "worktree": str(top), "driver": driver, "plan": token, "history": history}


def _read_attributes(path):
    flags = os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0) | getattr(os, "O_NONBLOCK", 0)
    try:
        fd = os.open(path, flags)
    except FileNotFoundError:
        return ""
    with os.fdopen(fd, "rb") as handle:
        if not stat.S_ISREG(os.fstat(handle.fileno()).st_mode):
            raise BaselineError(str(path) + " is not a regular file.")
        data = handle.read((1 << 20) + 1)
        if len(data) > 1 << 20:
            raise BaselineError(str(path) + " exceeds the 1 MiB merge setup limit.")
    return data.decode("utf-8", "replace")


def _append_attribute(path, text):
    flags = os.O_WRONLY | os.O_APPEND | os.O_CREAT | getattr(os, "O_NOFOLLOW", 0) | getattr(os, "O_NONBLOCK", 0)
    fd = os.open(path, flags, 0o644)
    with os.fdopen(fd, "a", encoding="utf-8", newline="\n") as handle:
        if not stat.S_ISREG(os.fstat(handle.fileno()).st_mode):
            raise BaselineError(str(path) + " is not a regular file.")
        handle.write(text)


def install_merge_driver(project=None, repo=None, plan=None):
    """Register the driver in the repository's own config and add the attribute to <worktree>/.gitattributes.

    Only an explicit user command calls this: the dialog (after showing mergeDriverPlan's two paths and
    passing its token back) or --install-merge-driver. It never touches the global or system config."""
    p = merge_driver_plan(project, repo)
    if plan is not None and plan != p["plan"]:
        raise BaselineError("The repository changed since the setup was shown. Open Set Up Merge Driver again.")
    history, command, attributes = p["history"], p["driver"], Path(p["attributes"])
    text = _read_attributes(attributes)
    history.git(["config", "--local", "merge.waffle.name", "Waffle semantic merge"], "Unable to write the repository's Git config.", cwd=history.origin, allow=WRITE_ONLY)
    history.git(["config", "--local", "merge.waffle.driver", command], "Unable to write the repository's Git config.", cwd=history.origin, allow=WRITE_ONLY)
    present = {line.strip() for line in text.splitlines()}
    added = [line for line in p["attributeLines"] if line not in present]
    if added:
        newline = "\r\n" if "\r\n" in text else "\n"
        _append_attribute(attributes, ("" if not text or text.endswith(("\r", "\n")) else newline) +
                          newline.join(added) + newline)
    return {"installed": True, "driver": command, "config": p["config"], "attributes": str(attributes), "attributeAdded": bool(added),
            "note": "Commit .gitattributes so collaborators get the same merges; each clone registers the driver once."}


def uninstall_merge_driver(repo):
    history = merge_driver_plan(repo=repo)["history"]
    try:
        history.git(["config", "--local", "--remove-section", "merge.waffle"], "not set", cwd=history.origin, allow=WRITE_ONLY)
    except BaselineError:
        pass
    return {"uninstalled": True, "note": "Remove the Waffle merge attribute lines from .gitattributes if you added them.",
            "attributeLines": list(MERGE_ATTRIBUTES)}


def _safe_program_lookup():
    """Before anything resolves a program (BoardRunner finds `node` with shutil.which): leave the
    worktree, which Git runs merge drivers from, and drop empty, "." and relative PATH entries, so a
    node.exe or node.cmd committed to the repository is never found (Windows searches the current
    directory first unless NoDefaultCurrentDirectoryInExePath is set) (F3)."""
    os.chdir(Path(__file__).resolve().parent)
    os.environ["NoDefaultCurrentDirectoryInExePath"] = "1"
    os.environ["PATH"] = os.pathsep.join(p for p in os.environ.get("PATH", "").split(os.pathsep) if p and p != "." and os.path.isabs(p))


def merge_driver(base_path, ours_path, theirs_path, name=None):
    """Merge native records for an already-installed Git attribute or an explicit CLI invocation."""
    paths = [Path(path).absolute() for path in (base_path, ours_path, theirs_path)]
    inputs = []
    flags = os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0) | getattr(os, "O_NONBLOCK", 0) | getattr(os, "O_BINARY", 0)
    for path in paths:
        info = path.lstat()
        if not stat.S_ISREG(info.st_mode) or info.st_size > MAX_BYTES:
            raise BaselineError("The merge input is not a regular file within the 64 MiB limit.")
        with os.fdopen(os.open(path, flags), "rb") as handle:
            if not stat.S_ISREG(os.fstat(handle.fileno()).st_mode):
                raise BaselineError("The merge input is not a regular file.")
            raw = handle.read(MAX_BYTES + 1)
        if len(raw) > MAX_BYTES:
            raise BaselineError("The merge input exceeds the 64 MiB limit.")
        reject_obsolete(raw[:HEADER_LIMIT], name or "selected.waffle")
        raw.decode("utf-8")
        if b"\0" in raw or b"\x1e" in raw:
            raise BaselineError("Invalid control character in a Waffle merge input.")
        inputs.append(raw)
    options = {}
    kind = MERGE_FILE_KINDS.get(Path(name).suffix.lower()) if name else None
    if kind:
        options["kind"] = kind
    _safe_program_lookup()
    sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "mcp"))
    from board_runner import BoardRunner
    runner = BoardRunner()
    try:
        # U+001E cannot occur unescaped in canonical JSON. Keep large inputs out of the options JSON.
        reply = runner.call("AtriumFormat2MergeDriver", ("format-2-git",), options, b"\x1e".join(inputs),
                            retry=True, timeout=120 if os.name != "nt" else None, memory=2 << 30)
    finally:
        runner.close()
    header, _, merged = reply.partition("\n")
    result = json.loads(header)
    if not result["conflicts"]:
        output = merged.encode("utf-8")
        if len(output) > MAX_BYTES:
            raise BaselineError("The merged Waffle file exceeds the 64 MiB limit.")
        if output != inputs[1]:
            ours = paths[1]
            # Git opens %A after the driver exits. Publish only a complete result and keep the
            # original file and all three Git stages intact on conflict or an interrupted write.
            mode = stat.S_IMODE(ours.lstat().st_mode)
            fd, name = tempfile.mkstemp(dir=ours.parent, prefix=".waffle-merge-")
            temporary = Path(name)
            try:
                with os.fdopen(fd, "wb") as handle:
                    handle.write(output)
                temporary.chmod(mode)
                os.replace(temporary, ours)
            finally:
                temporary.unlink(missing_ok=True)
    return result


def main():
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    parser.add_argument("--project", type=Path)
    modes = parser.add_mutually_exclusive_group()
    modes.add_argument("--history", action="store_true")
    modes.add_argument("--revision")
    modes.add_argument("--query", choices=sorted(QUERY_OPS))
    modes.add_argument("--merge-driver", nargs="+", metavar="FILE", help="git merge driver: %%O %%A %%B [%%P]")
    modes.add_argument("--install-merge-driver", metavar="REPO", help="register Waffle's merge driver in this repository")
    modes.add_argument("--uninstall-merge-driver", metavar="REPO")
    parser.add_argument("--args", default="{}", help="JSON arguments for --query")
    parser.add_argument("merge_path", nargs="?", help="after --: the merged file's path (%%P), for messages only")
    parser.add_argument("--desktop-stream", action="store_true")
    args = parser.parse_args()
    try:
        if args.merge_driver:
            files = args.merge_driver + ([args.merge_path] if args.merge_path else [])
            if not 3 <= len(files) <= 4:
                parser.error("--merge-driver takes %O %A %B and optionally -- %P")
            reply = merge_driver(*files)
            conflicts = reply.get("conflicts") or []
            # Design text: printable characters only (no terminal escapes from a hostile project).
            text = lambda v, n: "".join(ch for ch in str(v)[:n] if ch.isprintable())
            for r in (reply.get("renumbered") or [])[:20]:
                print("waffle-merge: both sides added %s; theirs renumbered to %s" % (text(r.get("from"), 40), text(r.get("to"), 40)), file=sys.stderr)
            for c in conflicts[:20]:
                print("waffle-merge: conflict: " + text(c.get("label", "object"), 200), file=sys.stderr)
            if conflicts:
                print("waffle-merge: %d conflict(s); open the project in Waffle and choose Project › Git › Resolve Merge Conflicts."
                      % len(conflicts), file=sys.stderr)
            return 1 if conflicts else 0
        if args.install_merge_driver or args.uninstall_merge_driver:
            result = install_merge_driver(repo=args.install_merge_driver) if args.install_merge_driver else uninstall_merge_driver(args.uninstall_merge_driver)
            print(json.dumps(result, indent=2))
            return 0
        if args.project is None:
            parser.error("--project is required")
        if args.query:
            try:
                options = json.loads(args.args)
            except ValueError:
                raise BaselineError("Invalid Git query arguments.") from None
            response = query(args.project, args.query, options, sys.stdout.buffer if args.desktop_stream and args.query == "read" else None)
        else:
            project = ProjectHistory(args.project)
            # Desktop reads may name any commit reachable from HEAD, a branch, a remote branch or a tag
            # (branch and tag comparisons); dangling and unreachable objects stay refused.
            response = project.history() if args.history else project.read(args.revision, None, True,
                                                                         sys.stdout.buffer if args.desktop_stream else None, any_ref=True)
        if response is not None:
            sys.stdout.buffer.write((json.dumps(response, ensure_ascii=True) + "\n").encode("ascii"))
    except (ValueError, OSError, RecursionError) as error:
        message = str(error)
        print("".join(ch for ch in message[:400] if ch.isprintable()) if args.merge_driver else message, file=sys.stderr)
        return 2 if args.merge_driver else 1
    except Exception as error:  # The merge engine: report, leave %A as ours.
        if args.merge_driver:
            print("waffle-merge: " + str(error)[:400], file=sys.stderr)
            return 2
        raise
    return 0


if __name__ == "__main__":
    sys.exit(main())
