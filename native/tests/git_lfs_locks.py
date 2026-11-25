#!/usr/bin/env python3
"""Git LFS lock queries in native/git_head.py (docs/collaboration.md), with a stand-in
git-lfs on PATH: status is local only, the server operations need confirm, results are parsed
for this project's path only, and a missing git-lfs or Git worktree is reported plainly.

    python3 native/tests/git_lfs_locks.py
"""
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile

NATIVE = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(NATIVE))
import git_head  # noqa: E402

FAKE = r"""#!/bin/sh
echo "$@" >> "$LFS_LOG"
case "$1" in
  version) echo "git-lfs/3.4.0 (fake)";;
  locks)
    case "$*" in
      *--local*) echo '[{"id":"1","path":"boards/Main.waffle","owner":{"name":"Bob"}}]';;
      *--verify*) echo '{"ours":[],"theirs":[{"id":"1","path":"boards/Main.waffle","owner":{"name":"Bob"}},{"id":"2","path":"other.waffle","owner":{"name":"Eve"}}]}';;
      *) echo '[]';;
    esac;;
  lock) if [ -n "$LFS_FAIL" ]; then echo "Lock exists" >&2; exit 2; fi; echo '{"id":"3","path":"boards/Main.waffle","owner":{"name":"Alice"}}';;
  unlock) echo '{"id":"3"}';;
esac
"""


def main():
    with tempfile.TemporaryDirectory() as directory:
        root = Path(directory).resolve()
        repo = root / "repo"
        (repo / "boards").mkdir(parents=True)
        env = {k: v for k, v in os.environ.items() if not k.startswith("GIT_")}
        subprocess.run(["git", "init", "-q", str(repo)], check=True, env=env)
        project = repo / "boards" / "Main.waffle"
        project.write_text('{"kind":"project","formatVersion":"2.0","id":"main"}\n')
        # No git-lfs: status says so, server operations refuse.
        status = git_head.query(project, "lfsStatus")
        if not status["lfs"]:
            try:
                git_head.query(project, "lfsLock", {"confirm": True})
                raise AssertionError("lock without git-lfs")
            except git_head.BaselineError as error:
                assert "not installed" in str(error)
        assert status["git"] and status["path"] == "boards/Main.waffle" and not status["lockable"] and not status["tracked"]
        # Outside a worktree.
        outside = root / "Loose.waffle"
        outside.write_text('{"kind":"project","formatVersion":"2.0","id":"main"}\n')
        assert git_head.query(outside, "lfsStatus") == {"git": False}
        # A repository that marks .waffle lockable, and a stand-in git-lfs.
        (repo / ".gitattributes").write_text("*.waffle filter=lfs diff=lfs merge=lfs -text lockable\n")
        bin_dir = root / "bin"
        bin_dir.mkdir()
        fake = bin_dir / "git-lfs"
        fake.write_text(FAKE)
        fake.chmod(0o755)
        log = root / "lfs.log"
        os.environ["PATH"] = str(bin_dir) + os.pathsep + os.environ["PATH"]
        os.environ["LFS_LOG"] = str(log)
        status = git_head.query(project, "lfsStatus")
        assert status["lfs"] and status["tracked"] and status["lockable"] and status["cached"] is None, status
        assert log.read_text().splitlines() == ["version"], "status runs only `git-lfs version`, outside the repository"
        # Server operations need the user's confirmation.
        for op in ("lfsLocks", "lfsLock", "lfsUnlock"):
            for args in ({}, {"confirm": False}):
                try:
                    git_head.query(project, op, args)
                    raise AssertionError(op + " without confirm")
                except git_head.BaselineError as error:
                    assert "confirmation" in str(error)
        for bad in ({"confirm": "yes"}, {"path": "x"}, {"confirm": True, "force": True}):
            try:
                git_head.query(project, "lfsLock", bad)
                raise AssertionError("bad arguments accepted")
            except git_head.BaselineError:
                pass
        assert git_head.query(project, "lfsLocks", {"confirm": True}) == {"locked": True, "owner": "Bob", "mine": False}
        # Repository settings that run commands stop the server operations (security review F1),
        # and status never runs them.
        marker = root / "PWNED"
        for key, value in (("core.sshCommand", "sh -c 'echo ssh >> %s'" % marker), ("credential.helper", "!echo cred >> %s" % marker),
                           ("lfs.customtransfer.x.path", "/bin/sh"), ("core.fsmonitor", "echo fsm >> %s; false" % marker)):
            subprocess.run(["git", "-C", str(repo), "config", key, value], check=True, env=env)
            try:
                git_head.query(project, "lfsLock", {"confirm": True})
                raise AssertionError("network op with " + key)
            except git_head.BaselineError as error:
                assert "would run commands" in str(error), error
            git_head.query(project, "lfsStatus")
            subprocess.run(["git", "-C", str(repo), "config", "--unset", key], check=True, env=env)
        assert not marker.exists(), "no repository command ran"
        assert git_head.query(project, "lfsLock", {"confirm": True}) == {"locked": True, "owner": "Alice"}
        assert "lock --json -- boards/Main.waffle" in log.read_text()
        os.environ["LFS_FAIL"] = "1"
        assert git_head.query(project, "lfsLock", {"confirm": True}) == {"locked": False, "message": "Lock exists"}
        del os.environ["LFS_FAIL"]
        assert git_head.query(project, "lfsUnlock", {"confirm": True}) == {"unlocked": True}
        # The command line the hosts build passes the same checks.
        out = subprocess.run([sys.executable, "-I", "-B", str(NATIVE / "git_head.py"), "--project", str(project), "--query", "lfsStatus", "--args={}"],
                             capture_output=True, text=True, env={**os.environ})
        assert out.returncode == 0 and json.loads(out.stdout)["lockable"], out.stderr
    print("git_lfs_locks: ok (local status, confirm for the server, parsing per path)")


if __name__ == "__main__":
    main()
