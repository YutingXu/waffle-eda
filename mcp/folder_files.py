"""Use the native folder transaction API for one explicit CLI/MCP selection."""
from contextlib import contextmanager, suppress
import base64
import hashlib
import json
from itertools import islice
import os
from pathlib import Path
import re
import subprocess
import sys


APP_ROOT = Path(__file__).resolve().parents[1]
NATIVE = APP_ROOT / "native"
sys.path.insert(0, str(NATIVE))
import obsolete_project
MAX_REPLY = (512 << 20) * 4 // 3 + (4 << 20)


class FolderError(ValueError):
    def __init__(self, message, state="ioError", paths=()):
        super().__init__(message)
        self.paths = paths
        self.state = state
        self.code = ("incomplete_project" if "missing" in message.lower() else
                     "stale_source" if state == "conflict" else
                     "recovery_pending" if state in ("applying", "recoveryPending") else "io_error")


def is_folder_selection(path):
    if path.is_dir():
        return True
    if path.suffix.lower() != ".waffle":
        return False
    if not path.exists():
        # A published creation may not have installed its manifest yet.
        return (path.parent / ".waffle" / "journal" / "active").is_file()
    if not path.is_file():
        return False
    try:
        with path.open("rb") as source:
            line = source.readline(65537)
        if not line.endswith(b"\n"):
            return False
        head = json.loads(line)
        return (isinstance(head, dict) and head.get("kind") == "project" and
                re.fullmatch(r"(?:[2-9]|[1-9][0-9]+)\.[0-9]+", str(head.get("formatVersion"))) is not None)
    except (ValueError, RecursionError):
        return False


class PipeFolder:
    def __init__(self, host, path):
        self.process = subprocess.Popen([str(host), "--folder-mcp", str(path)], stdin=subprocess.PIPE,
                                        stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)
        try:
            self.manifest = self.response()["manifest"]
        except BaseException:
            self.close()
            raise

    def response(self):
        try:
            line = self.process.stdout.readline(MAX_REPLY + 1)
            if len(line) > MAX_REPLY or not line.endswith(b"\n"):
                raise ValueError("Incomplete native response.")
            reply = json.loads(line)
        except (OSError, ValueError) as exc:
            raise FolderError("The native folder host stopped or returned an invalid response.") from exc
        if "error" in reply:
            error = reply["error"]
            if error["message"] == obsolete_project.NOTE:
                raise obsolete_project.ObsoleteProject()
            raise FolderError(error["message"], error.get("state"), error.get("paths", []))
        return reply

    def call(self, op, **fields):
        packet = json.dumps({"op": op, **fields}, ensure_ascii=True, separators=(",", ":"), allow_nan=False).encode("ascii")
        if len(packet) > MAX_REPLY:
            raise FolderError("The native folder request exceeds the size limit.")
        try:
            self.process.stdin.write(packet + b"\n")
            self.process.stdin.flush()
        except OSError as exc:
            raise FolderError("The native folder host stopped.") from exc
        return self.response()["result"]

    def close(self):
        with suppress(BrokenPipeError):
            self.process.stdin.close()
        try:
            self.process.wait(timeout=2)
        except subprocess.TimeoutExpired:
            self.process.kill()
            self.process.wait()
        self.process.stdout.close()


def packaged_host():
    selected = os.environ.get("WAFFLE_FOLDER_MCP_HOST")
    if selected:
        return Path(selected).resolve(strict=True)
    if sys.platform == "darwin":
        path = APP_ROOT.parent / "MacOS" / "Waffle"
        if path.is_file():
            return path
    if os.name == "nt":
        for parent in (APP_ROOT, APP_ROOT.parent):
            path = parent / "Waffle.exe"
            if path.is_file():
                return path
    return None


class FolderFiles:
    def __init__(self, selected):
        self.pipe = self.native = None
        root = selected if selected.is_dir() else selected.parent
        if selected.is_dir():
            # A single explicitly selected historical project gets the same diagnosis as its manifest.
            eligible = (p for p in root.iterdir() if not p.name.startswith(".") and p.suffix.lower() in (".waffle", ".atrium"))
            candidates = list(islice(eligible, 2))
            if len(candidates) == 1 and not candidates[0].is_symlink():
                obsolete_project.reject_path(candidates[0])
        host = packaged_host()
        if host:
            self.pipe = PipeFolder(host, selected)
            manifest = self.pipe.manifest
        elif sys.platform.startswith("linux") and (NATIVE / "linux" / "folder_project.py").is_file():
            sys.path.insert(0, str(NATIVE / "linux"))
            from folder_project import RootFolder
            self.native = RootFolder.selected(selected)
            manifest = self.native.manifest
        else:
            raise FolderError("Format 2.0 projects need the native folder host from this Waffle installation.")
        if not isinstance(manifest, str) or Path(manifest).name != manifest or not manifest.lower().endswith(".waffle"):
            self.close()
            raise FolderError("The native host did not select a valid project manifest.")
        self.path = root / manifest

    def native_call(self, action, *args, **kwargs):
        try:
            return action(*args, **kwargs)
        except ValueError as exc:
            if not hasattr(exc, "state"):
                raise
            raise FolderError(str(exc), exc.state, getattr(exc, "paths", ())) from exc

    @contextmanager
    def snapshot(self):
        lease = (self.pipe.call("acquire")["lease"] if self.pipe else
                 self.native_call(self.native.acquire, recover=False))
        read_set = {}

        def read(path):
            result = (self.pipe.call("read", lease=lease, paths=[path]) if self.pipe else
                      self.native_call(self.native.read, lease, [path]))
            files = result["files"]
            if len(files) != 1 or files[0]["path"] != path:
                raise FolderError("The native host omitted project member " + path + ".")
            row = files[0]
            raw = base64.b64decode(row["data"], validate=True)
            digest = hashlib.sha256(raw).hexdigest()
            if len(raw) != row["length"] or digest != row["sha256"] or read_set.setdefault(path, digest) != digest:
                raise FolderError("The saved project member changed during the read: " + path, "conflict", [path])
            return raw

        def release():
            if self.pipe:
                self.pipe.call("release", lease=lease)
            else:
                self.native_call(self.native.release, lease)

        try:
            yield read, read_set
            if self.pipe:
                self.pipe.call("verify", lease=lease)
            else:
                self.native_call(self.native.verify_lease, lease)
        except BaseException:
            with suppress(FolderError, OSError):
                release()
            raise
        else:
            release()

    def commit(self, project_id, plan, read_set):
        request = {"projectId": project_id, "manifest": self.path.name, "plan": plan}
        if self.pipe:
            return self.pipe.call("commit", request=request, readSet=read_set)
        receipts = []
        self.native_call(self.native.commit, project_id, self.path.name, plan, receipts.append, read_set=read_set)
        return receipts[0]

    def recover(self):
        if self.pipe:
            self.pipe.call("recover")
        else:
            self.native_call(self.native.recover)

    def close(self):
        if self.pipe:
            self.pipe.close()
        if self.native:
            self.native.close()
