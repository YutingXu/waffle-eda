"""Observe the real Git repository without asking Git to inspect or refresh its index."""
import hashlib
import json
import os
from pathlib import Path
import shutil
import stat
import subprocess


def git_tree(root):
    """Record every path, including the index, refs, objects, logs, and directory metadata."""
    root = Path(root) / ".git"
    entries = {}
    for item in [root, *sorted(root.rglob("*"))]:
        info = item.lstat()
        # The observer itself reads these paths. Access time cannot distinguish those reads
        # from the editor and may be disabled or updated lazily by the filesystem.
        identity = (info.st_mode, info.st_uid, info.st_gid, info.st_dev, info.st_ino,
                    info.st_nlink, info.st_size, info.st_mtime_ns, info.st_ctime_ns)
        if stat.S_ISREG(info.st_mode):
            data = hashlib.sha256(item.read_bytes()).hexdigest()
        elif stat.S_ISLNK(info.st_mode):
            data = os.readlink(item)
        else:
            assert stat.S_ISDIR(info.st_mode), item
            data = None
        entries[item.relative_to(root).as_posix()] = (identity, data)
    return entries


class GitSpy:
    def __init__(self, scratch):
        self.real = shutil.which("git")
        if not self.real:
            raise RuntimeError("The Git independence test requires Git.")
        self.env = {key: value for key, value in os.environ.items() if not key.startswith("GIT_")}
        self.env.update(GIT_CONFIG_GLOBAL=os.devnull, GIT_CONFIG_NOSYSTEM="1")
        self.log = scratch / "git-processes.jsonl"
        self.marker = scratch / "git-phase"
        self.marker.write_text("open")
        binary = scratch / "bin"
        binary.mkdir()
        spy = binary / "git"
        spy.write_text("""#!/usr/bin/env python3
import json, os, sys
from pathlib import Path
phase = Path(os.environ['WAFFLE_TEST_GIT_PHASE']).read_text()
fd = os.open(os.environ['WAFFLE_TEST_GIT_LOG'], os.O_WRONLY | os.O_CREAT | os.O_APPEND, 0o600)
os.write(fd, (json.dumps([phase, sys.argv[1:]]) + '\\n').encode())
os.close(fd)
os.environ['GIT_CONFIG_GLOBAL'] = os.devnull
os.execv(os.environ['WAFFLE_TEST_REAL_GIT'], [os.environ['WAFFLE_TEST_REAL_GIT'], *sys.argv[1:]])
""")
        spy.chmod(0o700)
        self.child_env = {**self.env, "PATH": str(binary) + os.pathsep + self.env.get("PATH", ""),
                          "WAFFLE_TEST_GIT_LOG": str(self.log), "WAFFLE_TEST_GIT_PHASE": str(self.marker),
                          "WAFFLE_TEST_REAL_GIT": self.real}

    def git(self, root, *args):
        # Explicit setup and the final commit bypass the capture executable.
        return subprocess.check_output([self.real, "-C", str(root), "-c", "user.name=Waffle Fixture",
                                        "-c", "user.email=fixture@example.invalid", "-c", "commit.gpgsign=false",
                                        "-c", "core.hooksPath=" + os.devnull, *args], env=self.env)

    def initialize(self, root):
        self.git(root, "init", "--quiet", "--initial-branch=fixture", "--template=")
        self.git(root, "add", "--all")
        self.git(root, "commit", "--quiet", "-m", "Initial project")

    def phase(self, name):
        self.marker.write_text(name)

    def calls(self, phase):
        if not self.log.exists():
            return []
        return [argv for record in self.log.read_text().splitlines() for name, argv in [json.loads(record)] if name == phase]
