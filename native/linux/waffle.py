#!/usr/bin/env python3
"""Launch Waffle in GTK WebKit on Linux, with an offline browser fallback."""
import argparse
import base64
from contextlib import contextmanager
from concurrent.futures import ThreadPoolExecutor
import errno
import fcntl
import hashlib
import json
import os
from pathlib import Path
import re
import sys
import stat
import subprocess
import threading
import tempfile
import time
import uuid
from urllib.parse import unquote, urlsplit
import webbrowser

ROOT = Path(__file__).resolve().parents[2]
PAGE = ROOT / "app" / "index.html"
sys.path.insert(0, str(ROOT / "native"))
sys.path.insert(0, str(ROOT / "native" / "linux"))
from git_head import ProjectHistory, baseline, query as git_query, validate_query, SOURCE_EXTENSIONS as HISTORY_TYPES, SOURCE_QUERIES, FOLDER_QUERIES


AI_CREDENTIAL_MAX_BYTES = 4096


def ai_secret_tool(operation, provider, secret=None):
    executable = "/usr/bin/secret-tool"
    if not os.access(executable, os.X_OK):
        if operation == "status":
            return {"available": False, "maxBytes": AI_CREDENTIAL_MAX_BYTES}
        raise ValueError("The system Secret Service is unavailable.")
    attributes = ["application", "org.waffle.editor.ai-provider", "provider", provider]
    command = [executable, "store", "--label", "Waffle provider credential", *attributes] if operation == "configure" else [
        executable, "clear" if operation == "forget" else "lookup", *attributes]
    try:
        result = subprocess.run(command, input=secret.encode("utf-8") if secret is not None else b"",
                                stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=5, check=False)
    except (OSError, subprocess.TimeoutExpired):
        raise ValueError("The system Secret Service is unavailable.") from None
    missing = result.returncode == 1 and not result.stderr and not result.stdout
    if operation in ("load", "status"):
        if result.returncode and not missing:
            raise ValueError("The system Secret Service is unavailable.")
        value = result.stdout.rstrip(b"\n")
        if len(value) > AI_CREDENTIAL_MAX_BYTES:
            raise ValueError("The stored provider credential is invalid.")
        if operation == "status":
            return {"available": True, "configured": bool(value), "maxBytes": AI_CREDENTIAL_MAX_BYTES}
        return value.decode("utf-8") if value else None
    if result.returncode and not (operation == "forget" and missing):
        raise ValueError("The system Secret Service could not change this credential.")
    return {"available": True, "configured": operation == "configure", "maxBytes": AI_CREDENTIAL_MAX_BYTES}
import external_tools
from obsolete_project import NOTE as PRE_RELEASE_MESSAGE, ObsoleteProject, reject_path
import folder_project
import import_export
import notebook_media


def atomic_write(destination, payload):
    temporary = None
    try:
        with tempfile.NamedTemporaryFile("wb", dir=destination.parent, delete=False) as out:
            temporary = out.name
            try:
                os.fchmod(out.fileno(), destination.stat().st_mode & 0o777)
            except FileNotFoundError:
                pass
            out.write(payload)
            out.flush()
            os.fsync(out.fileno())
        os.replace(temporary, destination)
    finally:
        if temporary and os.path.exists(temporary):
            os.unlink(temporary)


PROJECT_EXTENSIONS = {".waffle"}

DOCUMENT_KINDS = {suffix: kind for kind, suffix in folder_project.MEMBER_SUFFIX.items() if kind != "block"}


def document_named(path):
    return Path(path).name.lower().endswith(tuple(DOCUMENT_KINDS))


def regular_document(path):
    path = Path(path)
    if path.suffix.lower() not in DOCUMENT_KINDS:
        return False
    try:
        return stat.S_ISREG(path.lstat().st_mode)
    except OSError:
        return False

def native_project_name(path):
    return Path(path).suffix.lower() in {".waffle", ".atrium"}


def check_open_selection(paths):
    """Inspect authored headers before opening a window, reading companions or issuing a grant."""
    for selected in map(Path, paths):
        if document_named(selected) and not regular_document(selected):
            raise HostError("Choose a regular Waffle document file.")
        candidates = (selected,)
        if selected.is_dir():
            candidates = [p for p in selected.iterdir() if p.suffix.lower() == ".waffle" and not p.name.startswith(".")]
            if len(candidates) != 1:
                continue
        for path in candidates:
            if not native_project_name(path):
                continue
            if path.suffix.lower() == ".atrium":
                raise ObsoleteProject()
            if path.is_file():
                reject_path(path)
                if not folder_project.is_manifest(path):
                    raise HostError("Choose a Waffle folder-format project manifest.")


SOURCE_EXTENSIONS = {".schdoc", ".pcbdoc"}


class TranslatorFiles:
    """The bundled registry is authoritative for native design Opens."""

    def __init__(self, path):
        self.types = {".zip", ".waffle", *DOCUMENT_KINDS}
        self.libraries = set()
        try:
            rows = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            return
        if not isinstance(rows, list):
            return
        for row in rows:
            if not isinstance(row, dict) or row.get("import") is not True or row.get("id") == "legacy":
                continue
            extensions = self.extensions(row.get("extensions"))
            self.types.update(extensions - {".atrium"})
            self.libraries.update(extensions & self.extensions(row.get("libraryExtensions")))

    @staticmethod
    def extensions(values):
        return {v.lower() for v in values if isinstance(v, str) and re.fullmatch(r"\.[a-zA-Z0-9_-]{1,30}", v)} if isinstance(values, list) else set()

    def accepts(self, path):
        return Path(path).suffix.lower() in self.types

    def open_types(self, requested):
        if requested is None:
            return self.types
        if not isinstance(requested, list) or len(requested) > 64 or any(not self.extensions([v]) for v in requested):
            raise HostError("Unrecognised import file type.")
        chosen = self.extensions(requested)
        if not chosen or not chosen <= self.types:
            raise HostError("Unrecognised import file type.")
        return chosen


TRANSLATORS = TranslatorFiles(ROOT / "app" / "translators.json")


class AltiumCopySource:
    """Retain the picked inode and both path spellings until the next source pick."""

    def __init__(self, path):
        self.path = Path(os.path.abspath(path))
        self.canonical = self.path.resolve()
        self.token = str(uuid.uuid4())
        self.handle = self.path.open("rb")

    def read(self):
        self.handle.seek(0)
        return self.handle.read()

    def save_copy(self, path, payload):
        selected = Path(os.path.abspath(path))
        destination = selected.resolve()
        same_file = False
        try:
            existing = destination.stat()
            same_file = os.path.samestat(os.fstat(self.handle.fileno()), existing)
            if not same_file:
                same_file = os.path.samestat(self.path.stat(), existing)
        except FileNotFoundError:
            pass
        if selected == self.path or destination == self.canonical or same_file:
            raise ValueError("Choose a different destination. This is the original Altium source.")
        if selected.suffix.lower() != self.path.suffix.lower():
            raise ValueError("The exported copy must have the same extension as its source.")
        atomic_write(destination, payload)

    def close(self):
        self.handle.close()


def durable_replace(temporary, destination):
    """rename(2) into place, then fsync the directory so the rename survives power loss."""
    os.replace(temporary, destination)
    try:
        fd = os.open(str(Path(destination).parent), os.O_RDONLY | os.O_DIRECTORY)
    except OSError:
        return
    try:
        os.fsync(fd)
    except OSError:
        pass
    finally:
        os.close(fd)


def atomic_write_mode(destination, payload, mode=None, *, collaboration_lock=False):
    """Temporary file beside destination (the old file's mode, or mode), fsync, rename, fsync dir."""
    destination = Path(destination)
    prefix = ".waffle.pending-" if collaboration_lock else "." + destination.name + "."
    suffix = ".waffle-lock" if collaboration_lock else ""
    fd, temporary = tempfile.mkstemp(prefix=prefix, suffix=suffix, dir=str(destination.parent))
    try:
        if mode is None:
            try:
                mode = destination.stat().st_mode & 0o777
            except FileNotFoundError:
                mask = os.umask(0)
                os.umask(mask)
                mode = 0o666 & ~mask
        os.fchmod(fd, mode)
        with os.fdopen(fd, "wb") as out:
            out.write(payload)
            out.flush()
            os.fsync(out.fileno())
        durable_replace(temporary, str(destination))
        temporary = None
    finally:
        if temporary and os.path.exists(temporary):
            os.unlink(temporary)


# ---- host state page code can use but never name freely ---------------------------------------
# Recent projects, the recovery sidecar beside the open project and library files the user chose.
# Every path from page code is checked against a list only native dialogs (or the user's own
# Open Recent menu) add to, then opened without following a final symlink.
RECENT_LIMIT = 12
ALLOW_LIMIT = 200
PROJECT_READ_CAP = 256 * 1024 * 1024
LIBRARY_READ_CAP = 16 * 1024 * 1024
LIBRARY_TYPES = {".atrlib", ".json"}
ALTIUM_TYPES = {".prjpcb", ".schdoc", ".pcbdoc", ".schlib", ".pcblib", ".step", ".stp"}
ALTIUM_FILE_LIMIT = 1024
ALTIUM_MANIFEST_CAP = 8 * 1024 * 1024


class HostError(ValueError):
    pass


def external_url(value):
    """An external link the user followed (shell.js): http(s) with a host, no credentials."""
    from urllib.parse import urlsplit
    if not isinstance(value, str) or len(value) > 2048 or any(ord(c) < 33 for c in value):
        raise ValueError("Enter an HTTP or HTTPS URL.")
    parts = urlsplit(value)
    if parts.scheme not in ("http", "https") or not parts.hostname or parts.username or parts.password:
        raise ValueError("Enter an HTTP or HTTPS URL without credentials.")
    return value


def data_dir():
    """$XDG_DATA_HOME/waffle (default ~/.local/share/waffle)."""
    base = os.environ.get("XDG_DATA_HOME", "")
    if not base or not os.path.isabs(base):
        base = os.path.join(os.path.expanduser("~"), ".local", "share")
    return Path(base) / "waffle"


def checked_path(value):
    """An absolute, canonical Path from page input, or None: no relative paths, NUL bytes,
    "." or ".." components or over-long strings."""
    if not isinstance(value, str) or not value.startswith("/") or "\0" in value or len(value.encode("utf-8", "surrogatepass")) > 4096:
        return None
    if any(part in (".", "..") for part in value.split("/")):
        return None
    return Path(os.path.realpath(value))


def read_regular_file(path, cap, *, cancelled=None):
    """Bytes and stat of the same regular file, without following a final symlink."""
    try:
        fd = os.open(str(path), os.O_RDONLY | os.O_NOFOLLOW | os.O_CLOEXEC | os.O_NONBLOCK)
    except OSError as error:
        if error.errno in (errno.ELOOP, errno.EMLINK):
            raise HostError("The file is now a symbolic link. Choose it again.") from None
        raise HostError("The file could not be opened.") from None
    with os.fdopen(fd, "rb") as handle:
        info = os.fstat(handle.fileno())
        if not stat.S_ISREG(info.st_mode):
            raise HostError("That path is not a regular file.")
        if info.st_size > cap:
            raise HostError("The file is too large.")
        if cancelled is None:
            payload = handle.read(cap + 1)
        else:
            payload = bytearray()
            while not cancelled.is_set():
                chunk = handle.read(min(cap - len(payload) + 1, 1 << 20))
                if not chunk:
                    break
                payload.extend(chunk)
                if len(payload) > cap:
                    break
            if cancelled.is_set():
                raise HostError("The drop was cancelled.")
        if len(payload) > cap:
            raise HostError("The file is too large.")
        return payload, info


def read_regular(path, cap, *, cancelled=None):
    payload, info = read_regular_file(path, cap, cancelled=cancelled)
    return payload, info.st_mtime


# ---- format upgrade backup (app/compat.js, docs/format-versioning.md) --------------------------
def private_atomic_write(destination, payload):
    """Write a fresh 0600 temporary file beside destination, fsync it, then rename it into place.
    rename(2) replaces a symlink rather than following it, so nothing is written elsewhere."""
    destination = Path(destination)
    fd, temporary = tempfile.mkstemp(prefix="." + destination.name + ".", dir=str(destination.parent))
    try:
        os.fchmod(fd, 0o600)
        with os.fdopen(fd, "wb") as out:
            out.write(payload)
            out.flush()
            os.fsync(out.fileno())
        os.replace(temporary, str(destination))
        temporary = None
    finally:
        if temporary and os.path.exists(temporary):
            os.unlink(temporary)


def load_list(folder, name, cap=1024 * 1024):
    try:
        payload, _ = read_regular(Path(folder) / name, cap)
        value = json.loads(payload.decode("utf-8"))
    except (HostError, OSError, ValueError):
        return []
    return [item for item in value if isinstance(item, dict)] if isinstance(value, list) else []


def store_list(folder, name, items):
    try:
        os.makedirs(str(folder), mode=0o700, exist_ok=True)
        private_atomic_write(Path(folder) / name, json.dumps(items, indent=2, sort_keys=True).encode("utf-8"))
    except OSError:
        pass  # a list that can't be stored only costs the user a menu entry


CRASH_LOG = "renderer-crashes.json"


def crash_history(folder):
    return load_list(folder, CRASH_LOG, 16 * 1024)[-32:]


def record_renderer_termination(folder, reason):
    if reason not in ("exited", "memory-limit", "terminated", "unresponsive"):
        return
    rows = crash_history(folder)
    rows.append({"at": time.time_ns() // 1_000_000, "kind": "renderer", "type": "Linux", "reason": reason})
    store_list(folder, CRASH_LOG, rows[-32:])


class RecentProjects:
    """Canonical paths of projects the user opened or saved through the host."""
    FILE = "recent-projects.json"

    def __init__(self, folder):
        self.folder = Path(folder)
        self.entries = []
        for item in load_list(self.folder, self.FILE):
            path = item.get("path")
            if isinstance(path, str) and path.startswith("/") and Path(path).suffix.lower() in PROJECT_EXTENSIONS | {".prjpcb"}:
                opened = item.get("openedAt")
                self.entries.append({"name": os.path.basename(path), "path": path,
                                     "openedAt": float(opened) if isinstance(opened, (int, float)) else 0.0})
        self.entries = self.entries[:RECENT_LIMIT]

    def note(self, path, when=None):
        path = os.path.realpath(str(path))
        if Path(path).suffix.lower() not in PROJECT_EXTENSIONS | {".prjpcb"}:
            return
        stamp = round((time.time() if when is None else when) * 1000)
        self.entries = [e for e in self.entries if e["path"] != path]
        self.entries.insert(0, {"name": os.path.basename(path), "path": path, "openedAt": float(stamp)})
        del self.entries[RECENT_LIMIT:]
        store_list(self.folder, self.FILE, self.entries)

    def clear(self):
        self.entries = []
        store_list(self.folder, self.FILE, self.entries)

    def listing(self, *, check_availability=True):
        return [dict(e) for e in self.entries if not check_availability or os.path.isfile(e["path"])]

    def allowed(self, value):
        path = checked_path(value)
        if path is None or not any(e["path"] == str(path) for e in self.entries):
            raise HostError("That project is not in the recent files list.")
        try:
            info = os.lstat(str(path))
        except OSError:
            info = None
        if info is None or not stat.S_ISREG(info.st_mode):
            raise HostError("That recent project is no longer available.")
        if info.st_size > PROJECT_READ_CAP:
            raise HostError("The file is too large.")
        return path


class LibraryReads:
    """Library files (.atrlib, .json) chosen in an open dialog, readable again later."""
    FILE = "library-sources.json"

    def __init__(self, folder):
        self.folder = Path(folder)
        self.paths = [i["path"] for i in load_list(self.folder, self.FILE)
                      if isinstance(i.get("path"), str) and i["path"].startswith("/")][:ALLOW_LIMIT]

    def remember(self, path):
        path = os.path.realpath(str(path))
        if os.path.splitext(path)[1].lower() not in LIBRARY_TYPES:
            return
        self.paths = [path] + [p for p in self.paths if p != path]
        del self.paths[ALLOW_LIMIT:]
        store_list(self.folder, self.FILE, [{"path": p} for p in self.paths])

    def read(self, value):
        path = checked_path(value)
        if path is None or str(path) not in self.paths:
            raise HostError("Open this library file again with Open library file… to allow reloading it.")
        if path.suffix.lower() not in LIBRARY_TYPES:
            raise HostError("Only .atrlib and .json library files can be reloaded.")
        payload, _ = read_regular(path, LIBRARY_READ_CAP)
        try:
            text = payload.decode("utf-8")
            parsed = json.loads(text.lstrip("\ufeff"))
        except ValueError:
            parsed = None
        if not isinstance(parsed, dict):
            raise HostError("This is not a JSON library file.")
        return {"name": path.name, "path": str(path), "text": text}


class LibraryFolders:
    """Persistent grants from the native folder chooser, restricted to library or model data."""
    FILE = "library-folders.json"
    PURPOSES = {"read", "write", "models"}
    DIR = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC

    def __init__(self, folder):
        self.folder = folder

    def remember(self, path, purpose):
        root = Path(path).resolve(strict=True)
        fd = os.open(root, self.DIR)
        try:
            info = os.fstat(fd)
        finally:
            os.close(fd)
        key = [info.st_dev, info.st_ino]
        rows = load_list(self.folder, self.FILE)
        grant = next((r["grant"] for r in rows if r.get("key") == key and r.get("purpose") == purpose), uuid.uuid4().hex)
        rows = [{"grant": grant, "path": str(root), "key": key, "purpose": purpose}] + [r for r in rows if r.get("grant") != grant]
        store_list(self.folder, self.FILE, rows[:ALLOW_LIMIT])
        return {"grant": grant, "name": root.name or "/"}

    def forget(self, grant):
        if isinstance(grant, str):
            store_list(self.folder, self.FILE, [r for r in load_list(self.folder, self.FILE) if r.get("grant") != grant])

    @contextmanager
    def access(self, grant):
        row = next((r for r in load_list(self.folder, self.FILE) if isinstance(grant, str) and r.get("grant") == grant), None)
        if not row:
            raise HostError("Choose this library folder again to allow access.")
        root = row["path"]
        fd = os.open(root, self.DIR)
        try:
            info = os.fstat(fd)
            if row.get("key") != [info.st_dev, info.st_ino]:
                raise HostError("The library folder changed. Choose it again to allow access.")
            yield fd, root, row["purpose"]
        finally:
            os.close(fd)

    @staticmethod
    def parts(path):
        if not isinstance(path, str) or not path or len(os.fsencode(path)) > 4096 or "\\" in path or any(ord(c) < 32 or ord(c) == 127 for c in path):
            return None
        parts = path.split("/")
        return parts if len(parts) <= 24 and all(part and not part.startswith(".") for part in parts) else None

    @staticmethod
    def cap(parts, purpose):
        name = parts[-1].lower()
        if purpose == "models":
            return 32 << 20 if name.endswith((".step", ".stp")) else None
        if name in ("license", "licence", "license.md", "licence.md", "license.txt", "licence.txt"):
            return 64 << 10
        if name.endswith((".atrlib", ".schlib", ".pcblib", ".kicad_sym")):
            return 64 << 20
        if name.endswith(".kicad_mod"):
            return 8 << 20
        if name in ("sym-lib-table", "fp-lib-table") or (len(parts) == 1 and name == "library.json") or (
                len(parts) > 1 and parts[-2] == "components" and name.endswith(".json")):
            return 4 << 20
        return None

    @classmethod
    @contextmanager
    def parent(cls, root, parts):
        fd = os.dup(root)
        try:
            for part in parts[:-1]:
                child = os.open(part, cls.DIR, dir_fd=fd)
                os.close(fd)
                fd = child
            yield fd
        finally:
            os.close(fd)

    def list(self, grant):
        with self.access(grant) as (fd, root, purpose):
            if purpose == "models":
                raise HostError("This is a 3D model folder.")
            entries = []
            def walk(directory_fd, prefix):
                with os.scandir(directory_fd) as children:
                    for child in children:
                        if child.name.startswith(".") or child.name.endswith(".3dshapes") or child.name in ("__pycache__", "node_modules"):
                            continue
                        path = prefix + [child.name]
                        rel = "/".join(path)
                        try:
                            info = child.stat(follow_symlinks=False)
                            if stat.S_ISDIR(info.st_mode) and len(path) < 24:
                                child_fd = os.open(child.name, self.DIR, dir_fd=directory_fd)
                                try:
                                    walk(child_fd, path)
                                finally:
                                    os.close(child_fd)
                            elif stat.S_ISREG(info.st_mode) and self.parts(rel) and self.cap(path, purpose):
                                entries.append({"path": rel, "size": info.st_size, "mtime": info.st_mtime_ns / 1e6})
                                if len(entries) > 200000:
                                    raise HostError("The folder contains too many library files.")
                        except (FileNotFoundError, NotADirectoryError, PermissionError):
                            continue
            walk(fd, [])
            return {"root": root, "entries": entries}

    def read(self, grant, paths):
        if not isinstance(paths, list) or len(paths) > 64:
            raise HostError("Invalid library file request.")
        with self.access(grant) as (root, _, purpose):
            files, remaining = [], 64 << 20
            for path in paths:
                try:
                    parts = self.parts(path)
                    cap = self.cap(parts, purpose) if parts else None
                    if not cap:
                        raise HostError("Invalid library file path.")
                    with self.parent(root, parts) as parent:
                        fd = os.open(parts[-1], os.O_RDONLY | os.O_NONBLOCK | os.O_NOFOLLOW | os.O_CLOEXEC, dir_fd=parent)
                        with os.fdopen(fd, "rb") as data:
                            info = os.fstat(fd)
                            maximum = min(cap, remaining)
                            if not stat.S_ISREG(info.st_mode) or info.st_size > maximum:
                                raise HostError("The library file could not be read or is too large.")
                            payload = data.read(maximum + 1)
                            if len(payload) > maximum:
                                raise HostError("The library file is too large.")
                    remaining -= len(payload)
                    files.append({"data": base64.b64encode(payload).decode("ascii")})
                except HostError as error:
                    files.append({"error": str(error)})
                except (OSError, ValueError):
                    files.append({"error": "The library file could not be opened."})
            return files

    def write(self, grant, path, text):
        parts = self.parts(path)
        if not parts or len(parts) != 2 or parts[0] != "components" or not parts[1].lower().endswith(".json") or not isinstance(text, str):
            raise HostError("Save a component JSON file inside the components folder.")
        payload = text.encode("utf-8")
        if len(payload) > 4 << 20 or not isinstance(json.loads(text), dict):
            raise HostError("Save a component JSON file inside the components folder.")
        with self.access(grant) as (root, _, purpose):
            if purpose != "write":
                raise HostError("Choose a library folder to save to.")
            try:
                os.mkdir("components", mode=0o700, dir_fd=root)
            except FileExistsError:
                pass
            with self.parent(root, parts) as parent:
                temp = ".atrium-" + uuid.uuid4().hex
                fd = os.open(temp, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_CLOEXEC | os.O_NOFOLLOW, 0o600, dir_fd=parent)
                try:
                    with os.fdopen(fd, "wb") as out:
                        out.write(payload)
                        out.flush()
                        os.fsync(out.fileno())
                    os.replace(temp, parts[1], src_dir_fd=parent, dst_dir_fd=parent)
                    os.fsync(parent)
                finally:
                    try:
                        os.unlink(temp, dir_fd=parent)
                    except FileNotFoundError:
                        pass
        return True


# ---- collab-locks (docs/collaboration.md, app/project/collab-lock.js) -----------------------------
# Document lock and presence sidecars beside the open project: "<name>.waffle.<key>.waffle-lock",
# key 1-64 letters, digits, "-" or "_" starting with a letter or digit. The only names written,
# always in the project's own folder, never through a final symlink. The host fills in a random
# machine id (made once, $XDG_DATA_HOME/waffle/machine-id), its session id, pid and write time;
# the page supplies a small JSON object. Created with O_EXCL, replaced only by the owning
# session (or an explicit take-over) and removed only by the owning session.
LOCK_TEXT_CAP = 16 * 1024
LOCK_DATA_CAP = 8 * 1024
LOCK_LIST_CAP = 256


def lock_suffix(project):
    return ".waffle-lock"


def lock_key(value):
    if not isinstance(value, str) or not 1 <= len(value) <= 64 or not value.isascii():
        return None
    if not value[0].isalnum() or not all(ch.isalnum() or ch in "-_" for ch in value):
        return None
    return value


class CollabLocks:
    def __init__(self, folder=None):
        self.session = str(uuid.uuid4())
        self.folder = folder
        self._machine = None

    @property
    def machine(self):
        if self._machine is None:
            folder = Path(self.folder) if self.folder else data_dir()
            path = folder / "machine-id"
            try:
                text = read_regular(path, 128)[0].decode("ascii").strip()
                if 16 <= len(text) <= 64 and lock_key(text):
                    self._machine = text
            except (HostError, UnicodeError, OSError):
                pass
            if self._machine is None:
                self._machine = str(uuid.uuid4())
                try:
                    folder.mkdir(mode=0o700, parents=True, exist_ok=True)
                    private_atomic_write(path, self._machine.encode("ascii"))
                except OSError:
                    pass
        return self._machine

    @staticmethod
    def path(project, key):
        project = Path(project)
        return project.parent / (project.name + "." + key + lock_suffix(project))

    def listing(self, project):
        project = Path(project)
        prefix = project.name + "."
        suffix = lock_suffix(project)
        locks = []
        try:
            names = sorted(os.listdir(str(project.parent)))
        except OSError:
            names = []
        for name in names:
            if len(locks) >= LOCK_LIST_CAP:
                break
            if not name.startswith(prefix) or not name.endswith(suffix):
                continue
            key = name[len(prefix):-len(suffix)]
            if not lock_key(key):
                continue
            try:
                payload, modified = read_regular(project.parent / name, LOCK_TEXT_CAP)
                locks.append({"key": key, "text": payload.decode("utf-8"), "modified": round(modified * 1000)})
            except (HostError, UnicodeError, OSError):
                continue
        result = {"session": self.session, "machine": self.machine, "now": round(time.time() * 1000), "locks": locks}
        try:
            info = os.stat(str(project), follow_symlinks=False)
            if stat.S_ISREG(info.st_mode):
                result["project"] = {"size": info.st_size, "modified": info.st_mtime_ns // 1000000, "inode": info.st_ino}
        except OSError:
            pass
        return result

    def _current(self, path):
        try:
            info = os.lstat(str(path))
        except FileNotFoundError:
            return False, None
        if not stat.S_ISREG(info.st_mode):
            return True, None
        try:
            value = json.loads(read_regular(path, LOCK_TEXT_CAP)[0])
            return True, value.get("session") if isinstance(value, dict) else None
        except (HostError, ValueError, OSError):
            return True, None

    def record(self, data):
        if not isinstance(data, str) or len(data.encode("utf-8", "surrogatepass")) > LOCK_DATA_CAP:
            raise HostError("Lock data must be a small JSON object.")
        try:
            value = json.loads(data)
        except ValueError:
            value = None
        if not isinstance(value, dict):
            raise HostError("Lock data must be a small JSON object.")
        record = {"atrium-lock": 1, "machine": self.machine, "session": self.session, "pid": os.getpid(),
                  "written": round(time.time() * 1000), "data": value}
        return json.dumps(record, sort_keys=True, ensure_ascii=True).encode("ascii")

    def write(self, project, key, data, mode):
        key = lock_key(key)
        if key is None or Path(str(project)).suffix.lower() not in PROJECT_EXTENSIONS:
            raise HostError("Invalid lock name.")
        payload, path = self.record(data), self.path(project, key)
        if mode == "create":
            try:
                fd = os.open(str(path), os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW | os.O_CLOEXEC, 0o644)
            except FileExistsError:
                return {"written": False, "exists": True}
            except OSError:
                raise HostError("Could not create the lock file.") from None
            try:
                os.fchmod(fd, 0o644)
                with os.fdopen(fd, "wb") as out:
                    out.write(payload)
                    out.flush()
                    os.fsync(out.fileno())
            except OSError:
                try:
                    os.unlink(str(path))
                except OSError:
                    pass
                raise HostError("Could not write the lock file.") from None
            return {"written": True}
        if mode in ("replace", "takeover"):
            exists, session = self._current(path)
            if mode == "replace":
                if not exists:
                    return {"written": False, "missing": True}
                if session != self.session:
                    return {"written": False, "owner": False}
            try:
                info = os.lstat(str(path))
                if not (stat.S_ISREG(info.st_mode) or stat.S_ISLNK(info.st_mode)):
                    raise HostError("The lock path is not a file.")
            except FileNotFoundError:
                pass
            atomic_write_mode(path, payload, 0o644, collaboration_lock=True)
            return {"written": True}
        raise HostError("Unknown lock mode.")

    def remove(self, project, key, force=False):
        key = lock_key(key)
        if key is None or Path(str(project)).suffix.lower() not in PROJECT_EXTENSIONS:
            raise HostError("Invalid lock name.")
        path = self.path(project, key)
        exists, session = self._current(path)
        if not exists:
            return {"removed": False}
        if not force and session != self.session:
            return {"removed": False, "owner": False}
        try:
            info = os.lstat(str(path))
            if stat.S_ISREG(info.st_mode) or stat.S_ISLNK(info.st_mode):
                os.unlink(str(path))
                return {"removed": True}
        except OSError:
            pass
        return {"removed": False}

    def remove_own(self, project):
        if project is None or Path(str(project)).suffix.lower() not in PROJECT_EXTENSIONS:
            return
        for lock in self.listing(project)["locks"]:
            try:
                if json.loads(lock["text"]).get("session") == self.session:
                    self.remove(project, lock["key"])
            except (ValueError, AttributeError, HostError):
                continue


def browser(startup=None):
    if valid_link(startup):
        print("Opening a Waffle record link requires the GTK WebKit desktop runtime.", file=sys.stderr)
        return 1
    if startup is not None:
        try:
            check_open_selection([startup])
        except (OSError, ValueError) as error:
            print(str(error), file=sys.stderr)
            return 1
        print("Opening a project by filename requires the GTK WebKit desktop runtime. "
              "To open it manually, start waffle --browser and use Open.", file=sys.stderr)
        return 1
    if not webbrowser.open(PAGE.as_uri()):
        print(f"Open {PAGE} in a browser to start Waffle.", file=sys.stderr)
        return 1
    return 0


LINK_ID = r"[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}"
LINK_URI = re.compile(rf"waffle://{LINK_ID}/{LINK_ID}(?:#datasheet:page=([1-9][0-9]{{0,15}}))?")


def valid_link(value):
    match = LINK_URI.fullmatch(value) if isinstance(value, str) and len(value) <= 114 else None
    return bool(match and (match[1] is None or int(match[1]) <= 9007199254740991))


def link_windows(windows, url):
    """Return open windows for one adopted project, or flag distinct folders with the same identity."""
    if not valid_link(url):
        return [], False
    identity = url[len("waffle://"):len("waffle://") + 36]
    matches = []
    for window, peer in windows.items():
        scope = peer["scope"]()
        if scope is not None and scope[1] == identity:
            matches.append((window, scope[0]))
    if len({path for _, path in matches}) > 1:
        return [], True
    return [window for window, _ in matches], False


def project_path(value):
    if value.lower().startswith("waffle:"):
        if valid_link(value):
            return value
        raise argparse.ArgumentTypeError("Choose a valid Waffle record link.")
    if value.startswith("file:"):
        uri = urlsplit(value)
        if uri.netloc not in ("", "localhost") or not uri.path.startswith("/") or uri.query or uri.fragment:
            raise argparse.ArgumentTypeError("Choose a local Waffle file.")
        value = unquote(uri.path, errors="strict")
        if "\0" in value:
            raise argparse.ArgumentTypeError("Choose a local Waffle file.")
    path = Path(value).expanduser().absolute()
    if document_named(path) and not regular_document(path):
        raise argparse.ArgumentTypeError("Choose a regular Waffle document file.")
    if path.is_dir():
        return path
    if not native_project_name(path) and not TRANSLATORS.accepts(path):
        raise argparse.ArgumentTypeError("Choose a file in a supported import format.")
    if not path.is_file():
        raise argparse.ArgumentTypeError("Project file does not exist: " + str(path))
    return path


def retain_input(receipts, path, payload):
    if receipts is None:
        return {}
    token = uuid.uuid4().hex
    receipts[token] = (path, hashlib.sha256(payload).hexdigest(), len(payload))
    while len(receipts) > 4096:
        del receipts[next(iter(receipts))]
    return {"retainedInputToken": token, "importSaveKey": import_export.key(path, receipts[token][1])}


def include_altium_members(manifest, payload, selected, files, remaining, receipts=None):
    try:
        text = payload.decode("utf-16" if payload.startswith((b"\xff\xfe", b"\xfe\xff")) else "utf-8-sig")
    except UnicodeError:
        text = payload.decode("cp1252", errors="replace")
    root = manifest.parent.resolve()
    seen, document_section = set(), True
    for line in text.splitlines():
        line = line.strip()
        if line.startswith("["):
            document_section = bool(re.fullmatch(r"\[Document[0-9]+\]", line, re.I))
            continue
        key, _, value = line.partition("=")
        if not document_section or key.strip().lower() != "documentpath":
            continue
        ref = value.strip()
        if len(ref) >= 2 and ref[0] == ref[-1] == '"':
            ref = ref[1:-1]
        ref = ref.replace("\\", "/")
        if (len(ref) > 4096 or ref.startswith("/") or ":" in ref or any(ord(c) < 32 for c in ref)
                or Path(ref).suffix.lower() not in ALTIUM_TYPES - {".prjpcb"}):
            continue
        try:
            member = root
            for part in Path(ref).parts:
                candidate = member / part
                if not candidate.exists():
                    matches = [p for p in member.iterdir() if p.name.casefold() == part.casefold()]
                    if len(matches) != 1:
                        break
                    candidate = matches[0]
                member = candidate.resolve()
                if member != root and root not in member.parents:
                    break
            else:
                if member in seen or not member.is_file():
                    continue
                seen.add(member)
                if member in selected:
                    files[selected[member]]["altiumPath"] = ref
                    continue
                if len(files) >= ALTIUM_FILE_LIMIT:
                    raise ValueError("The Altium project has too many referenced documents.")
                if member.stat().st_size > remaining:
                    raise ValueError("The referenced Altium documents exceed the desktop import size limit.")
                data, _ = read_regular(member, remaining)
                remaining -= len(data)
                files.append({"name": member.name, "altiumPath": ref, "data": base64.b64encode(data).decode("ascii"),
                              **retain_input(receipts, member, data)})
        except (OSError, RuntimeError, HostError):
            continue  # Missing members appear by name in the editor's import report.


def owning_document_project(path):
    """Find an unambiguous exact indexed member without recovering or writing the project."""
    path = Path(path)
    matches = []
    for directory in path.parents:
        relative = path.relative_to(directory)
        if len(relative.parts) != 1 and relative.parts[0] not in ("documents", "libraries"):
            continue
        try:
            with os.scandir(directory) as entries:
                names = [row.name for row in entries if not row.name.startswith(".") and
                         row.name.endswith(".waffle") and row.is_file(follow_symlinks=False)]
        except OSError:
            continue
        if len(names) > 64:
            continue
        for name in names:
            root = None
            try:
                root = folder_project.RootFolder(directory, name)
                with root._closing(root._lock(False)) as lease:
                    header = root.header()
                    if header is None:
                        continue
                    version = header.get("formatVersion")
                    minor = folder_project.future_minor(version)
                    if version != "2.0" and not minor:
                        continue
                    _, _, raw, _ = root._read(name, folder_project.FILE_CAP, collect=True, exact=True)
                    selected = root._membership(raw, future=minor > 0).get(relative.as_posix())
                    if selected is None:
                        continue
                    with root.directory_at(relative.parts[:-1]) as (parent, verify):
                        with root._file(parent, relative.name) as (fd, info):
                            record = root._record_header(fd)
                            root._check_file(parent, relative.name, fd, info)
                        verify()
                    if selected == (record.get("id"), record.get("kind")) and record.get("kind") == DOCUMENT_KINDS.get(path.suffix.lower()):
                        root._check_lock(lease)
                        matches.append((root, relative.as_posix()))
                        root = None
            except (OSError, ValueError, TypeError, RecursionError):
                pass
            finally:
                if root is not None:
                    root.close()
            if len(matches) > 1:
                for matched, _ in matches:
                    matched.close()
                raise HostError("More than one Waffle project owns this document. Choose the project manifest.")
    return matches[0] if matches else None


def encode_files(paths, *, background=False, receipts=None, copy_proof=None):
    check_open_selection(paths)
    if any(native_project_name(p) for p in paths):
        raise HostError("Open the selected Waffle project through its folder grant.")
    files = []
    manifests = []
    remaining = PROJECT_READ_CAP
    if sum(Path(p).suffix.lower() in ALTIUM_TYPES for p in paths) > ALTIUM_FILE_LIMIT:
        raise HostError("Too many Altium documents were selected.")
    for filename in paths:
        path = Path(filename)
        ext, canonical = path.suffix.lower(), path.resolve()
        cap = min(remaining, ALTIUM_MANIFEST_CAP) if ext == ".prjpcb" else remaining
        payload, _ = read_regular(path if ext in DOCUMENT_KINDS else canonical, cap)
        if len(payload) > remaining:
            raise HostError("The selected files exceed the import size limit.")
        remaining -= len(payload)
        entry = {"name": path.name, "data": base64.b64encode(payload).decode("ascii")}
        if ext in DOCUMENT_KINDS:
            entry["memberPath"] = path.name
            if copy_proof is not None:
                proof = copy_proof(payload)
                if proof:
                    entry["nativeCopy"] = proof
        elif not background and ext != ".zip":
            entry.update(retain_input(receipts, canonical, payload))
        if ext == ".prjpcb":
            entry["altiumPath"] = path.name
            manifests.append((path, payload))
        files.append(entry)
    if len(manifests) == 1:
        include_altium_members(*manifests[0], {Path(p).resolve(): i for i, p in enumerate(paths)}, files, remaining, receipts if not background else None)
    return files


class ProjectOpen:
    """Route a native selection without replacing another window's active project."""
    def __init__(self, read_files, open_window, note_recent, library_types=None):
        self.read_files = read_files
        self.open_window = open_window
        self.note_recent = note_recent
        self.library_types = TRANSLATORS.libraries if library_types is None else library_types
        self.has_project = False
        self.opening = False
        self.importing = None

    def open(self, paths):
        check_open_selection(paths)
        independent = any(Path(p).suffix.lower() not in self.library_types for p in paths)
        if independent:
            if self.has_project or self.opening:
                self.open_window([Path(p).absolute() for p in paths])
                return []
            self.opening = True
            manifests = [Path(p).resolve() for p in paths if Path(p).suffix.lower() == ".prjpcb"]
            self.importing = manifests[0] if len(manifests) == 1 else None
        try:
            return self.read_files(paths)
        except (OSError, ValueError):
            if independent:
                self.finished(False)
            raise

    def finished(self, success):
        if success and self.importing is not None:
            self.note_recent(self.importing)
        self.importing = None
        self.opening = False

    def recent(self, entries, value, activate):
        paths = [entries.allowed(value)]
        return self.open(paths) if activate else self.read_files(paths, background=True)


class SaveToClose:
    """Save on the close prompt (GNOME HIG): the page's own Save, in place or through the save dialog.
    The window closes only when the page reports that save finished ("saveForClose") with the project
    clean ("dirty" false, which the page sends first). A cancelled dialog or a failed save leaves the
    window open and unsaved; each Save is answered once, so a later ordinary save never closes it."""

    TITLE = "Save changes to \u201c{}\u201d before closing?"
    DETAIL = "If you don\u2019t save, your changes will be permanently lost."

    def __init__(self):
        self.pending = False

    @staticmethod
    def title(project_name):
        name = (project_name or "").strip()
        return SaveToClose.TITLE.format(name[:160] if name else "Untitled")

    def start(self):
        """False while an earlier Save for closing is still running."""
        if self.pending:
            return False
        self.pending = True
        return True

    def finished(self, saved, dirty):
        """The page's report: True when the window may close now."""
        was, self.pending = self.pending, False
        return was and saved is True and not dirty

    def abandon(self):
        self.pending = False


def main():
    parser = argparse.ArgumentParser(prog="waffle", description="Open the offline Waffle EDA electronics editor.")
    parser.add_argument("project", type=project_path, nargs="?", help="Waffle project to open")
    parser.add_argument("--browser", action="store_true", help="launch the browser edition")
    parser.add_argument("--version", action="version", version="Waffle EDA " + (ROOT / "app/VERSION").read_text(encoding="ascii").strip())
    args = parser.parse_args()
    if not PAGE.is_file():
        print(f"Editor file is missing: {PAGE}", file=sys.stderr)
        return 1
    if args.browser:
        return browser(args.project)
    try:
        import gi
        gi.require_version("Gtk", "3.0")
        gi.require_version("Gdk", "3.0")
        try:
            gi.require_version("WebKit2", "4.1")
        except ValueError:
            gi.require_version("WebKit2", "4.0")
        from gi.repository import Gdk, Gio, GLib, Gtk, WebKit2
    except (ImportError, ValueError):
        return browser(args.project)

    GLib.set_prgname("waffle")
    GLib.set_application_name("Waffle")
    ready, _ = Gtk.init_check([])
    if not ready:
        return browser(args.project)
    windows = {}
    recent = RecentProjects(data_dir())
    application = Gtk.Application(application_id="org.waffle.editor",
                                  flags=Gio.ApplicationFlags.HANDLES_COMMAND_LINE)

    def open_window(paths, link=None):
        if link:
            matches, ambiguous = link_windows(windows, link)
            if ambiguous:
                alert = Gtk.MessageDialog(transient_for=application.get_active_window(), modal=True,
                                          message_type=Gtk.MessageType.WARNING, buttons=Gtk.ButtonsType.CLOSE,
                                          text="More than one open project has this Waffle link's identity.")
                alert.run()
                alert.destroy()
                return
            if matches:
                writers = [window for window in matches if windows[window]["writer"]()] or matches
                active = application.get_active_window()
                owner = active if active in writers else writers[0]
                windows[owner]["follow"](link)
                return
        if len(paths) == 1 and (paths[0].is_dir() or paths[0].suffix.lower() in PROJECT_EXTENSIONS):
            selected = paths[0].resolve()
            for window, peer in windows.items():
                scope = peer["scope"]()
                current = scope[0] if scope else None
                if current == selected or (current is not None and selected.is_dir() and current.parent == selected):
                    peer["present"]()
                    return
        create_editor_window(Gdk, GLib, Gtk, WebKit2, paths, open_window, windows, recent, application, link)

    def command_line(_app, command):
        arguments = command.get_arguments()[1:]
        if len(arguments) > 1:
            return 2
        try:
            value = project_path(arguments[0]) if arguments else None
        except (argparse.ArgumentTypeError, ValueError, OSError):
            return 2
        link = value if valid_link(value) else None
        open_window([value] if value and link is None else [], link)
        return 0

    application.connect("command-line", command_line)
    return application.run([sys.argv[0], str(args.project)] if args.project else [sys.argv[0]])


def bridge_message(raw, capability):
    """GTK's message signal does not supply the sending frame. Authenticate before dispatch."""
    if not isinstance(raw, str) or not raw.startswith(capability):
        return None
    try:
        message = json.loads(raw[len(capability):])
    except (ValueError, RecursionError):
        return None
    return message if isinstance(message, dict) else None


class WorkspaceWindows:
    def __init__(self, project, scope, writer, spawn):
        self.project, self.scope, self.writer, self.spawn = project, scope, writer, spawn
        self.members = {writer["id"]: writer}
        self.pending = {}
        self.writer_available = True

    def fail_pending(self, message, peer=None):
        for token, (requester, request_id) in list(self.pending.items()):
            if peer is None or requester is peer:
                del self.pending[token]
                requester["reply"](request_id, error=message)

    def adopt_scope(self, scope):
        if scope != self.scope:
            self.scope = scope
            self.fail_pending("The project window writer was replaced.")

    def retire(self, peer):
        if self.members.get(peer["id"]) is not peer:
            return False
        del self.members[peer["id"]]
        self.fail_pending("The project window closed.", peer)
        return True

    def stop_writer(self, message):
        if not self.writer_available:
            return
        self.writer_available = False
        for member in list(self.members.values()):
            if member is not self.writer:
                member["send"]({"type": "writer-unavailable"})
        self.fail_pending(message)

    def renderer_failed(self, peer):
        if self.members.get(peer["id"]) is not peer:
            return
        if peer is self.writer:
            self.stop_writer("The project window writer is unavailable.")
        else:
            self.fail_pending("The project window renderer is unavailable.", peer)

    def keep_writer(self, peer):
        return peer is self.writer and any(member is not peer and member["visible"]() for member in self.members.values())

    def request(self, peer, request):
        operation, request_id = request.get("operation"), request.get("id")
        reply = peer["reply"]
        if not self.writer_available or self.writer["scope"]() != self.scope or self.members.get(peer["id"]) is not peer:
            raise HostError("The project window writer is unavailable.")
        write = peer is self.writer
        if operation == "describe":
            return reply(request_id, {"project": self.project, "window": peer["id"], "writer": write, "tab": peer["tab"],
                                      "frames": [{"id": member["id"], "bounds": member["capture"]()} for member in self.members.values()] if write else []})
        if operation == "apply-layout" and write:
            rows, focused = request.get("windows"), request.get("focused")
            if not isinstance(rows, list) or not rows or not all(
                isinstance(row, dict) and isinstance(row.get("id"), str) and re.fullmatch(r"[0-9a-f-]{36}", row["id"])
                and isinstance(row.get("active"), str) and row["active"] for row in rows
            ):
                raise HostError("The project window layout is invalid.")
            keys = {row["id"] for row in rows}
            if len(keys) != len(rows) or focused not in keys or self.writer["id"] not in keys:
                raise HostError("The project window layout is invalid.")
            for row in rows:
                member = self.members.get(row["id"])
                if member is None:
                    self.spawn(self, row["id"], row["active"])
                    member = self.members[row["id"]]
                member["tab"] = row["active"]
                if member is not self.writer:
                    member["send"]({"type": "view", "tab": member["tab"]})
                if row["id"] == focused:
                    member["present"]()
                member["bounds"](row.get("bounds"))
            for key, member in list(self.members.items()):
                if key not in keys and self.retire(member):
                    member["close"]()
            return reply(request_id, True)
        if operation in ("snapshot", "command"):
            if len(self.pending) >= 32:
                raise HostError("The project writer is busy.")
            token = uuid.uuid4().hex
            self.pending[token] = (peer, request_id)
            self.writer["send"]({"type": "rpc", "token": token, "packet": {
                "operation": operation, "from": peer["id"], "value": request.get("value")}})
            return
        if operation == "deliver" and write:
            waiting = self.pending.pop(request.get("token"), None)
            if waiting is not None:
                waiting[0]["reply"](waiting[1], request.get("value"), request.get("error"))
            return reply(request_id, True)
        if operation == "broadcast" and write and isinstance(request.get("value"), dict):
            for member in self.members.values():
                if member is not self.writer:
                    member["send"](request["value"])
            return reply(request_id, True)
        raise HostError("The project window operation is unavailable.")

    def close(self, peer):
        if self.members.get(peer["id"]) is not peer:
            return
        if peer is self.writer:
            self.stop_writer("The project window writer closed.")
            self.retire(peer)
            for member in list(self.members.values()):
                if self.retire(member):
                    member["close"]()
        else:
            self.retire(peer)
            self.writer["send"]({"type": "closed", "window": peer["id"]})


def create_editor_window(Gdk, GLib, Gtk, WebKit2, initial_files, open_window, windows, recent, application, startup_link=None, workspace=None):
    manager = WebKit2.UserContentManager()
    manager.register_script_message_handler("atriumHost")
    capability = uuid.uuid4().hex + ":"
    def system_accent(context):
        for name in ("accent_bg_color", "theme_selected_bg_color"):
            found, color = context.lookup_color(name)
            if found:
                return "#%02x%02x%02x" % tuple(round(max(0, min(1, v)) * 255) for v in (color.red, color.green, color.blue))
        return None

    bridge = (ROOT / "native" / "bridge.js").read_text(encoding="utf-8")
    # Only this window's top-frame closure receives the capability. The app page, an opaque
    # subframe and workers have no global value that a direct handler message could reuse.
    bridge = ("((__waffleTopFramePost) => {" + bridge +
              "})(text => window.webkit.messageHandlers.atriumHost.postMessage(" + json.dumps(capability) + " + text));")
    bridge = "window.__waffleLaunchSettle = true;\n" + bridge
    if workspace:
        bridge = "window.__waffleWorkspaceLaunch = true;\n" + bridge
    if initial_files or workspace:
        bridge = "window.__atriumOpeningProject = true;\n" + bridge
    bridge = "window.__atriumHostAccent = " + json.dumps(system_accent(Gtk.Button().get_style_context())) + ";\n" + bridge
    manager.add_script(WebKit2.UserScript.new(
        bridge, WebKit2.UserContentInjectedFrames.TOP_FRAME,
        WebKit2.UserScriptInjectionTime.START, None, None))
    editor = WebKit2.WebView.new_with_user_content_manager(manager)
    accent = None

    def accent_changed(view):
        nonlocal accent
        if view.get_uri() != PAGE.as_uri():
            return
        color = system_accent(view.get_style_context())
        if accent == color:
            return
        accent = color
        view.run_javascript("window.__waffleSystemAccent?.(" + json.dumps(color) + ")", None, None, None)

    async_git_reply = hasattr(editor, "call_async_javascript_function")
    # Live sessions use WebRTC data channels where this WebKitGTK provides them (2.38+, built with
    # WebRTC); otherwise the editor reports "relay server only" and uses the relay (collab-transport.js).
    try:
        settings = editor.get_settings()
        if any(p.name == "enable-webrtc" for p in settings.list_properties()):
            settings.set_property("enable-webrtc", True)
    except Exception:  # an older WebKitGTK: the relay carries everything
        pass

    # Native behaviour (docs/design-system.md): the page opens its own menus and cancels the
    # web view's (workbench.js). Should one still open, it keeps only editing entries: never
    # Reload, Back, Inspect or open-in-new-window. The page is never zoomed as a page either.
    page_actions = {getattr(WebKit2.ContextMenuAction, name) for name in (
        "GO_BACK", "GO_FORWARD", "STOP", "RELOAD", "OPEN_LINK", "OPEN_LINK_IN_NEW_WINDOW", "DOWNLOAD_LINK_TO_DISK",
        "COPY_LINK_TO_CLIPBOARD", "OPEN_IMAGE_IN_NEW_WINDOW", "DOWNLOAD_IMAGE_TO_DISK", "COPY_IMAGE_TO_CLIPBOARD",
        "COPY_IMAGE_URL_TO_CLIPBOARD", "OPEN_FRAME_IN_NEW_WINDOW", "OPEN_VIDEO_IN_NEW_WINDOW", "OPEN_AUDIO_IN_NEW_WINDOW",
        "DOWNLOAD_VIDEO_TO_DISK", "DOWNLOAD_AUDIO_TO_DISK", "INSPECT_ELEMENT")
        if hasattr(WebKit2.ContextMenuAction, name)}

    def context_menu(_view, menu, *_args):
        for item in list(menu.get_items()):
            if item.get_stock_action() in page_actions:
                menu.remove(item)
        items = menu.get_items()
        while items and items[0].is_separator():
            menu.remove(items[0])
            items = menu.get_items()
        while items and items[-1].is_separator():
            menu.remove(items[-1])
            items = menu.get_items()
        return not items

    def keep_page_scale(view, _spec):
        if abs(view.get_zoom_level() - 1.0) > 1e-6:
            view.set_zoom_level(1.0)

    window = Gtk.Window(title="Waffle")
    application.add_window(window)
    window.set_icon_name("org.waffle.editor")
    window.set_default_size(1250, 800)
    window.add(editor)
    # X11 without a compositor ignores top-level opacity.
    map_on_reveal = not window.is_composited()
    present_when_ready = False
    dirty = False
    project_name = None
    foreign_import_id = None
    save_to_close = SaveToClose()
    retained_inputs = {}
    pending_import = set()
    bound_import = {}
    restored_import = {}
    import_targets = {}
    import_ops = {}

    def reset_import():
        stops = list(import_ops.values())
        import_ops.clear()
        bound_import.clear()
        restored_import.clear()
        import_targets.clear()
        for stop in stops:
            stop()

    def bind_import(request):
        reset_import()
        token, session = request.get("sourceToken"), request.get("session")
        selected = request.get("tokens")
        if (token not in pending_import or not isinstance(selected, list) or not set(selected) <= pending_import
                or not isinstance(session, str) or not re.fullmatch("[a-fA-F0-9-]{36}", session)):
            return
        rows = [retained_inputs[t] for t in pending_import if t in retained_inputs]
        if len(rows) == len(pending_import):
            path, sha, _ = retained_inputs[token]
            bound_import.update(session=session, token=token, key=import_export.key(path, sha), sources=[str(r[0]) for r in rows])
        pending_import.clear()

    def check_import(request):
        if not bound_import or (request.get("session"), request.get("sourceToken")) != (bound_import["session"], bound_import["token"]):
            raise HostError("The imported design changed. Open it again.")

    selected_source = None
    picked_history = git_source = None
    startup = initial_files
    folders = {}
    native_members = {}
    native_copy_receipts = {}
    folder_sources = {}
    folder_current = folder_pending = None
    butter_drop_enabled = False
    typed_drop = None
    collab_writers = set()

    def current_project():
        folder = folders.get(folder_current)
        if folder is not None:
            return folder["root"].directory / folder["root"].manifest
        return None

    workspace_group, workspace_id, workspace_tab = workspace or (None, str(uuid.uuid4()), None)
    workspace_peer = None

    support = data_dir()
    library_reads = LibraryReads(support)
    library_folders = LibraryFolders(support)
    library_queue = ThreadPoolExecutor(max_workers=1, thread_name_prefix="atrium-library")
    # run:external (native/external_tools.py): the user's program choices and approvals, and the runner.
    external_store, external_runner = external_tools.Store(support), external_tools.Runner()
    renderer_failed = False
    closed = False
    # Lock and presence sidecars (CollabLocks): their own worker, so a slow share never delays a save.
    collab_locks = CollabLocks()
    from lan_relay import LanRelay, handle as lan_handle   # same-network sessions: listens only while shared
    lan = LanRelay()
    collab_queue = ThreadPoolExecutor(max_workers=1)
    folder_queue = ThreadPoolExecutor(max_workers=1, thread_name_prefix="waffle-folder")

    def note_recent(path):
        recent.note(path)
        try:
            Gtk.RecentManager.get_default().add_item(Path(os.path.realpath(str(path))).as_uri())
        except Exception:
            pass  # the desktop's recent list is a convenience

    def read_projects(paths, background=False):
        nonlocal folder_pending, picked_history
        check_open_selection(paths)
        candidates = [p for p in paths if Path(p).is_dir() or Path(p).suffix.lower() == ".waffle"]
        if candidates:
            if len(paths) != 1:
                raise HostError("Open one Waffle project folder at a time.")
            root = folder_project.RootFolder.selected(candidates[0])
            selection = grant_folder(root)
            folder_pending = selection["grant"]
            return [{"name": root.manifest, "folderProject": selection}]
        if any(not TRANSLATORS.accepts(p) for p in paths):
            raise HostError("Choose a file in a supported import format.")
        if not background and len(paths) == 1 and regular_document(paths[0]):
            path = Path(paths[0])
            owner = owning_document_project(path)
            if owner is not None:
                root, member = owner
                selection = grant_folder(root)
                folders[selection["grant"]]["recover_on_read"] = False
                folder_pending = selection["grant"]
                return [{"name": path.name, "folderProject": selection, "memberPath": member}]
            if len(native_members) >= 8:
                raise HostError("Close an open Waffle document first.")
            document = folder_project.NativeMember(path)
            try:
                read = document.read()
            except BaseException:
                document.close()
                raise
            grant = uuid.uuid4().hex
            native_members[grant] = (path, document)
            return [{"name": path.name, "memberPath": path.name, "data": base64.b64encode(read["data"]).decode("ascii"),
                     "standaloneMember": {"grant": grant, "sha256": read["sha256"], "readOnly": bool(read.get("readOnly"))}}]
        files = encode_files(paths, background=background, receipts=retained_inputs)
        if not background:
            pending_import.clear()
            pending_import.update(row["retainedInputToken"] for row in files if "retainedInputToken" in row)
            picked_history = None
            manifests = [i for i, p in enumerate(paths) if Path(p).suffix.lower() in (".prjpcb", ".kicad_pro")]
            index = 0 if len(paths) == 1 else manifests[0] if len(manifests) == 1 else None
            if index is not None and Path(paths[index]).suffix.lower() in HISTORY_TYPES:
                picked_history = str(uuid.uuid4()), Path(paths[index]).resolve()
                files[index]["historyToken"] = picked_history[0]
        return files

    project_open = ProjectOpen(read_projects, open_window, note_recent)

    def read_document_copies(paths):
        target = folder_current

        def proof(payload):
            token = uuid.uuid4().hex
            sha = hashlib.sha256(payload).hexdigest()
            if len(native_copy_receipts) >= 512:
                expired = next((key for key, receipt in native_copy_receipts.items() if not receipt[2]), None)
                if expired is None:
                    return None
                del native_copy_receipts[expired]
            native_copy_receipts[token] = (target, sha, set())
            return {"grant": token, "sha256": sha}
        return encode_files(paths, background=True, copy_proof=proof if target else None)

    def authorised_document_copies(request, target):
        plan = request.get("plan")
        verified, changes = {}, []
        for row in plan if isinstance(plan, list) else ():
            if not isinstance(row, dict) or "nativeCopy" not in row:
                continue
            proof, path = row.get("nativeCopy"), row.get("path")
            ticket = proof.get("grant") if isinstance(proof, dict) else None
            if not isinstance(path, str) or not isinstance(ticket, str) or path in verified:
                raise HostError("Choose the original Waffle document again.")
            sha, receipt = proof.get("sha256"), native_copy_receipts.get(ticket)
            remove = row.get("remove") is True
            if (target != folder_current or receipt is None or receipt[:2] != (target, sha)
                    or remove and (path not in receipt[2] or row.get("expected") != sha)):
                raise HostError("Choose the original Waffle document again.")
            verified[path] = sha
            changes.append((receipt[2], path, remove))
        return verified, changes

    def native_document_action(action, request):
        key = request.get("grant")
        selection = native_members.get(key) if isinstance(key, str) else None
        if selection is None:
            raise HostError("Open the Waffle document again.")
        path, document = selection
        if action == "nativeMemberClose":
            del native_members[key]
            folder_queue.submit(document.close)
            return True
        encoded = request.get("data")
        if not isinstance(encoded, str) or len(encoded) > (PROJECT_READ_CAP + 2) // 3 * 4:
            raise HostError("The Waffle document exceeds its size limit.")
        try:
            payload = base64.b64decode(encoded, validate=True)
        except ValueError:
            raise HostError("The Waffle document bytes are invalid.") from None

        if action == "nativeMemberExportCopy":
            name = request.get("name")
            if not isinstance(name, str) or Path(name).name != name or Path(name).suffix.lower() != path.suffix.lower():
                raise HostError("Choose a matching Waffle document filename.")
            panel = dialog(Gtk.FileChooserAction.SAVE, "Save a Waffle document copy", "Save")
            panel.set_current_name(name)
            panel.set_do_overwrite_confirmation(True)
            try:
                target = Path(panel.get_filename()) if panel.run() == Gtk.ResponseType.ACCEPT else None
            finally:
                panel.destroy()
            if target is None:
                return False
            if target.suffix.lower() != path.suffix.lower() or target.resolve() == path.resolve():
                raise HostError("Choose a separate file for the Waffle document copy.")
            if target.exists() or target.is_symlink():
                if not regular_document(target) or os.path.samefile(path, target):
                    raise HostError("Choose a separate regular file for the Waffle document copy.")
            atomic_write(target, payload)
            return True

        def write():
            try:
                owner = owning_document_project(path)
                if owner is not None:
                    owner[0].close()
                    raise HostError("A Waffle project now owns this document. Reopen it before saving.")
                value, error = document.commit(request.get("expected"), payload), None
            except (OSError, ValueError, TypeError) as failure:
                value, error = None, str(failure)
            GLib.idle_add(reply, request["id"], value, error)
        folder_queue.submit(write)
        return None


    @contextmanager
    def collab_path(root, cleanup=False):
        with root._closing(folder_project.open_root(root.directory)) as fd:
            if folder_project.inode(os.fstat(fd)) != root.root_id:
                raise HostError("The selected Waffle folder changed.")
            if not cleanup:
                with root._file(fd, root.manifest) as (file, info):
                    header = folder_project.format_header(os.read(file, folder_project.HEADER_CAP + 1))
                    root._check_file(fd, root.manifest, file, info)
                if not header or header.get("id") != root.project_identity:
                    raise HostError("The selected Waffle project changed.")
            # Keep all lock names relative to the verified directory even during a rename.
            yield Path("/proc/self/fd") / str(fd) / root.manifest

    def close_project(grant, wait=False):
        if grant in collab_writers:
            collab_writers.discard(grant)
            root = folders[grant]["root"]
            def cleanup():
                try:
                    with collab_path(root, cleanup=True) as project:
                        collab_locks.remove_own(project)
                except (OSError, ValueError):
                    pass
            job = collab_queue.submit(cleanup)
            if wait:
                job.result()

    closing = {"asking": False, "foreign": None, "approved": None}

    def confirm_close(*_):
        """delete-event: True keeps the window. Unsaved changes get the GNOME close prompt: Close
        Without Saving (the recovery sidecar stays for draft recovery), Cancel, or Save (default),
        after which the window closes once the page reports the save done (SaveToClose)."""
        if renderer_failed:
            return False
        if workspace_group is not None and workspace_group.keep_writer(workspace_peer):
            window.hide()
            return True
        if dirty:
            if closing["approved"] and closing["approved"] == foreign_import_id:
                close_project(current_project(), wait=True)
                return False
            if closing["asking"] or closing["foreign"] or save_to_close.pending:
                Gdk.beep()
                return True
            if foreign_import_id:
                closing["foreign"] = foreign_import_id
                editor.run_javascript("window.__atriumReviewForeignClose(" + json.dumps(foreign_import_id)
                                      + ",true); void 0", None, None, None)
                return True
            alert = Gtk.MessageDialog(transient_for=window, modal=True, message_type=Gtk.MessageType.WARNING,
                                      buttons=Gtk.ButtonsType.NONE, text=SaveToClose.title(project_name))
            alert.format_secondary_text(SaveToClose.DETAIL)
            alert.add_buttons("Close _Without Saving", Gtk.ResponseType.REJECT,
                              "_Cancel", Gtk.ResponseType.CANCEL, "_Save", Gtk.ResponseType.ACCEPT)
            alert.set_default_response(Gtk.ResponseType.ACCEPT)
            closing["asking"] = True
            try:
                response = alert.run()
            finally:
                closing["asking"] = False
                alert.destroy()
            if renderer_failed:
                return True  # the crash path closes this window itself
            if response == Gtk.ResponseType.ACCEPT:
                if save_to_close.start():
                    editor.run_javascript(
                        "window.__atriumSaveForClose ? window.__atriumSaveForClose(true) : "
                        "window.webkit.messageHandlers.atriumHost.postMessage(" + json.dumps(capability) + " + JSON.stringify({action:'saveForClose',saved:false}));"
                        " void 0", None, None, None)
                return True
            if response != Gtk.ResponseType.REJECT:
                return True
        close_project(folder_current, wait=True)
        return False

    def reply(request_id, value=None, error=None):
        if closed or renderer_failed:
            return
        args = ", ".join(json.dumps(v, ensure_ascii=True) for v in (request_id, value, error))
        editor.run_javascript("window.__atriumReceive(" + args + ")", None, None, None)

    def folder_event(grant, record, paths, overflow, status=None):
        if closed or renderer_failed or folders.get(grant) is not record or not (paths or overflow or status):
            return False
        record["seq"] += 1
        event = {"type": "folderChanged", "grant": grant, "seq": record["seq"],
                 "paths": sorted(paths), "overflow": overflow}
        if status is not None:
            event["status"] = status
        editor.run_javascript("window.__waffleFolderChanged?.(" + json.dumps(event, ensure_ascii=True) + ")",
                              None, None, None)
        return False

    def flush_folder_events(grant):
        record = folders.get(grant)
        if record is None:
            return False
        paths, overflow = record["events"], record["overflow"]
        record.update(events=set(), overflow=False, scheduled=0)
        def verify():
            root = record["root"]
            observed = set()
            for path in paths:
                if path in root.installed:
                    try:
                        identity = root.member_stamp(path)
                    except FileNotFoundError:
                        identity = None
                    except (OSError, ValueError):
                        observed.add(path)
                        continue
                    if identity == root.installed[path]:
                        continue
                observed.add(path)
            GLib.idle_add(folder_event, grant, record, observed, overflow or root.state in ("conflict", "recoveryPending"))
        folder_queue.submit(verify)
        return False

    def native_folder_event(_fd, condition, grant):
        record = folders.get(grant)
        if record is None:
            return False
        if condition & (GLib.IO_ERR | GLib.IO_HUP):
            record["watch_id"] = 0
            return folder_event(grant, record, (), True)
        paths, overflow = record["watch"].drain()
        record["events"].update(paths)
        if len(record["events"]) > 512:
            record["events"] = set(sorted(record["events"])[:512])
            overflow = True
        record["overflow"] |= overflow
        if (paths or overflow) and not record["scheduled"]:
            record["scheduled"] = GLib.timeout_add(75, flush_folder_events, grant)
        return True

    def grant_folder(root):
        if len(folders) >= 8:
            root.close()
            raise HostError("Close a Waffle project folder before opening another.")
        grant = uuid.uuid4().hex
        record = {"root": root, "watch": None, "watch_id": 0, "scheduled": 0, "events": set(), "overflow": False, "seq": 0}
        folders[grant] = record
        try:
            observer = folder_project.FolderWatch(root)
            record["watch"] = observer
            record["watch_id"] = GLib.io_add_watch(observer.fd, GLib.PRIORITY_DEFAULT,
                                                   GLib.IO_IN | GLib.IO_ERR | GLib.IO_HUP, native_folder_event, grant)
        except (OSError, ValueError, AttributeError):
            # Read and save remain available when the kernel cannot supply watch notifications.
            GLib.idle_add(folder_event, grant, record, (), True)
        selection = {"grant": grant, "manifest": root.manifest, "name": root.directory.name, "draftScope": root.draft_scope}
        try:
            status = root.status()
            if status["state"] != "settled":
                selection["status"] = status
        except (OSError, ValueError) as error:
            selection["status"] = {"state": "recoveryPending", "paths": [], "error": str(error)}
        return selection

    def folder_service(grant):
        record = folders.get(grant) if isinstance(grant, str) else None
        if record is None:
            raise HostError("Open the Waffle project folder again.")
        return record["root"]

    notebook = notebook_media.Bridge(folder_queue, folder_service)

    def close_folder(grant):
        notebook.close_grant(grant)
        nonlocal folder_current, folder_pending
        close_project(grant)
        record = folders.pop(grant, None)
        for ticket, receipt in list(native_copy_receipts.items()):
            if receipt[0] == grant:
                del native_copy_receipts[ticket]
        if record is None:
            return
        if folder_current == grant:
            folder_current = None
        if folder_pending == grant:
            folder_pending = None
        for source in (record["watch_id"], record["scheduled"]):
            if source:
                GLib.source_remove(source)
        if record["watch"] is not None:
            record["watch"].close()
        def release():
            for token, source in list(folder_sources.items()):
                if source[0] == grant:
                    os.close(source[3])
                    del folder_sources[token]
            record["root"].close()
        folder_queue.submit(release)

    def choose_project_folder(request):
        mode = request.get("mode")
        if mode not in ("open", "create"):
            raise HostError("Choose whether to open or create a project folder.")
        creating = mode == "create"
        panel = dialog(Gtk.FileChooserAction.SAVE if creating else Gtk.FileChooserAction.SELECT_FOLDER,
                       "Save Waffle Project Folder" if creating else "Open Waffle Project Folder",
                       "Create Folder" if creating else "Open")
        if creating:
            panel.set_current_name(folder_project.suggested_name(request.get("name")))
        try:
            selected = panel.get_filename() if panel.run() == Gtk.ResponseType.ACCEPT else None
        finally:
            panel.destroy()
        if selected is None:
            return False
        root = folder_project.create_selected(selected) if creating else folder_project.RootFolder.selected(selected)
        return grant_folder(root)

    def notebook_action(action, request):
        def finished(value=None, error=None):
            GLib.idle_add(reply, request["id"], value, error)
        if action != "notebookPaste":
            return notebook.run(action, request, finished)
        folder_service(request.get("grant"))
        clipboard = Gtk.Clipboard.get(Gdk.SELECTION_CLIPBOARD)
        def targets(_clipboard, atoms, *_args):
            names = {atom.name():atom for atom in atoms or []}
            media = next((k for k in ("image/png", "image/jpeg", "image/heic", "image/webp", "image/svg+xml", "application/pdf") if k in names), None)
            if media is None:
                return finished(False)
            def contents(_clipboard, selection, *_args):
                count = selection.get_length()
                if not 0 < count <= notebook_media.MAX_BYTES:
                    return finished(None, "The copied image exceeds its size limit.")
                data = selection.get_data()
                if not data:
                    return finished(False)
                name = "Clipboard." + ("svg" if media == "image/svg+xml" else media.split("/")[1])
                notebook.run("notebookTransfer", {**request,"mediaType":media,"origin":"paste",
                             "data":notebook_media.encoded(data),"name":name}, finished)
            clipboard.request_contents(names[media],contents,None)
        clipboard.request_targets(targets,None)

    def perform_folder_action(action, request):
        grant, request_id = request.get("grant"), request["id"]
        root = folder_service(grant)
        record = folders[grant]
        if action == "folderClose":
            close_folder(grant)
            return reply(request_id, True)
        if action == "folderStatus" and root.state != "settled":
            return reply(request_id, root.status())
        picked = None
        selected = None
        if action == "folderPickAsset":
            allowed = {"image/png", "image/jpeg", "image/webp", "image/svg+xml", "image/heic", "application/pdf"}
            requested = request.get("mediaTypes", list(allowed))
            owner = request.get("ownerId")
            if (not isinstance(owner, str) or not 1 <= len(owner.encode("utf-8")) <= 1024
                    or not isinstance(requested, list) or not 1 <= len(requested) <= len(allowed)
                    or any(not isinstance(media, str) or media not in allowed for media in requested)):
                raise HostError("Choose an editable sheet and a supported attachment type.")
            panel = dialog(Gtk.FileChooserAction.OPEN, "Choose a project attachment", "Choose")
            formats = Gtk.FileFilter()
            formats.set_name("Images and PDF")
            for media in requested:
                formats.add_mime_type(media)
            panel.add_filter(formats)
            try:
                selected = panel.get_filename() if panel.run() == Gtk.ResponseType.ACCEPT else None
            finally:
                panel.destroy()
            if selected is None:
                return reply(request_id, False)
            picked = os.open(selected, folder_project.FILE_FLAGS)
        if action == "folderResolve" and not ask("Apply the reviewed conflict choices?",
                                                "Waffle will preserve both versions and install the changes selected for this project.",
                                                "Apply Choices"):
            return reply(request_id, False)

        def adopt():
            nonlocal folder_current, git_source, picked_history
            if not closed and not renderer_failed and folders.get(grant) is record:
                reset_import()
                pending_import.clear()
                if folder_current != grant:
                    close_project(folder_current)
                git_source = picked_history = None
                folder_current = grant
                project_open.has_project = True
                if (root.directory / root.manifest).is_file():
                    note_recent(root.directory / root.manifest)
            return False

        def committed(value):
            if not closed and not renderer_failed and folders.get(grant) is record:
                if value.get("saved") is True:
                    for installed, path, remove in copied:
                        if remove:
                            installed.discard(path)
                        else:
                            installed.add(path)
                adopt()
                reply(request_id, value)
            return False

        copy_hashes, copied = authorised_document_copies(request, grant) if action == "folderCommit" else ({}, [])

        def work():
            claimed = False
            acknowledged = False
            def saved(result):
                nonlocal acknowledged
                acknowledged = True
                GLib.idle_add(committed, result)
            try:
                if action in ("folderCommit", "folderResolve"):
                    if action == "folderCommit":
                        options = {"native_copy_hashes": copy_hashes} if copy_hashes else {}
                        root.commit(request.get("projectId"), request.get("manifest"), request.get("plan"), saved, **options)
                    else:
                        root.resolve(request, saved)
                    status = root.status()
                    GLib.idle_add(folder_event, grant, record, status["paths"], False, status)
                    if status["state"] == "settled":
                        GLib.idle_add(adopt)
                    return
                if action == "folderReadLease":
                    value = {"lease": root.acquire(recover=record.get("recover_on_read", True))}
                elif action == "folderRead":
                    paths = request.get("paths")
                    value = root.read(request.get("lease"), paths)
                    wanted = set(paths) | root.members
                    def track():
                        if folders.get(grant) is record and record["watch"] is not None:
                            record["watch"].track(wanted)
                        return False
                    GLib.idle_add(track)
                elif action == "folderRelease":
                    value = root.release(request.get("lease"))
                elif action == "folderLocalState":
                    value = root.local_state(request.get("localState", request.get("state")))
                elif action == "folderAdopt":
                    GLib.idle_add(adopt)
                    value = True
                elif action == "folderConflict":
                    value = root.conflict()
                elif action == "folderConflictRead":
                    value = root.conflict_read(request)
                elif action == "folderPickAsset":
                    if len(folder_sources) >= 64:
                        raise HostError("Finish or cancel the pending attachments first.")
                    info = os.fstat(picked)
                    root._regular(info)
                    media = folder_project.asset_media(os.pread(picked, folder_project.HEADER_CAP, 0))
                    if media not in requested:
                        raise HostError("The attachment does not match a selected media type.")
                    token = str(uuid.uuid4())
                    folder_sources[token] = (grant, owner, media, picked, folder_project.stamp(info))
                    claimed = True
                    value = {"sourceToken": token, "name": Path(selected).name, "mediaType": media}
                elif action in ("folderDraftAssetProof", "folderRestoreDraftAsset"):
                    value = root.draft_asset(request, data_dir(), action == "folderRestoreDraftAsset")
                elif action == "folderStageAsset":
                    token = request.get("sourceToken")
                    source = folder_sources.get(token) if isinstance(token, str) else None
                    if source is None or source[:3] != (grant, request.get("ownerId"), request.get("mediaType")):
                        raise HostError("Choose this sheet's attachment again.")
                    if folder_project.stamp(os.fstat(source[3])) != source[4]:
                        raise HostError("The selected attachment changed. Choose it again.")
                    os.lseek(source[3], 0, os.SEEK_SET)
                    value = root.stage_asset(source[1], source[2], source=source[3])
                    os.close(source[3])
                    del folder_sources[token]
                elif action == "folderDropAsset":
                    value = root.drop_asset(request.get("assetToken"))
                    token = request.get("sourceToken")
                    source = folder_sources.get(token) if isinstance(token, str) else None
                    if source is not None and source[0] == grant:
                        os.close(source[3])
                        del folder_sources[token]
                elif action == "folderReadAsset":
                    value = root.read_asset(request)
                else:
                    value = root.status()
                GLib.idle_add(reply, request_id, value)
            except (OSError, ValueError, TypeError, KeyError, RecursionError) as error:
                if acknowledged:
                    root._set_error(error)
                    GLib.idle_add(folder_event, grant, record, root.paths, False, root.status())
                else:
                    GLib.idle_add(reply, request_id, None, str(error))
            finally:
                if picked is not None and not claimed:
                    os.close(picked)
        folder_queue.submit(work)

    # run:external: the user picks the program (or confirms a detected path) in a native dialog,
    # and approves each program's exact command once per extension before it first runs.
    def ask(text, detail, accept):
        alert = Gtk.MessageDialog(transient_for=window, modal=True, message_type=Gtk.MessageType.QUESTION, text=text)
        alert.format_secondary_text(detail)
        alert.add_buttons("Cancel", Gtk.ResponseType.CANCEL, accept, Gtk.ResponseType.YES)
        response = alert.run()
        alert.destroy()
        return response == Gtk.ResponseType.YES

    def choose_external(request):
        tool_id, name, path = str(request.get("toolId") or ""), str(request.get("name") or "")[:80], request.get("path")
        if not external_tools.TOOL_ID.match(tool_id):
            raise ValueError("Invalid external tool.")
        if isinstance(path, str):
            if not external_tools.executable(path):
                raise ValueError("That program was not found.")
            if not ask("Use this program for " + (name or tool_id) + "?", path, "Use"):
                return None
            return external_store.choose(tool_id, name, path)
        panel = dialog(Gtk.FileChooserAction.OPEN, "Choose " + (name or tool_id), "Choose")
        chosen = panel.get_filename() if panel.run() == Gtk.ResponseType.ACCEPT else None
        panel.destroy()
        return external_store.choose(tool_id, name, chosen) if chosen else None

    def run_external(request_id, run):
        req = external_tools.check_run(run)
        tool = external_store.tool(req["tool"])
        if not tool:
            raise ValueError(req["tool_name"] + " is not set up. Choose it in Preferences \u203a External Tools.")
        path = external_tools.resolved(tool["path"])
        if not external_tools.executable(path):
            raise ValueError(req["tool_name"] + " was not found at " + path + ". Choose it again in Preferences \u203a External Tools.")
        # Approval per extension version (id@sha256), tool and resolved program, within the extension's
        # declared argument template; any other argument asks for the exact command (external_tools.py).
        need = external_tools.approval_needed(external_store, req, path)
        reservation = external_runner.reserve(req)
        try:
            if need:
                allowed = ask(need["title"], need["detail"], "Allow")
                if reservation[1]["cancelled"] or not allowed:
                    external_runner.release(reservation)
                    reply(request_id, {"cancelled": True} if reservation[1]["cancelled"] else {"denied": True})
                    return
                external_tools.record_approval(external_store, req, need)
            def work():
                try:
                    value = external_runner.run(path, req, reservation)
                    GLib.idle_add(reply, request_id, value)
                except (OSError, ValueError) as error:
                    GLib.idle_add(reply, request_id, None, str(error))
            threading.Thread(target=work, daemon=True).start()
        except Exception:
            external_runner.release(reservation)
            raise

    def dialog(action, title, accept):
        panel = Gtk.FileChooserDialog(title=title, parent=window, action=action)
        panel.add_buttons("Cancel", Gtk.ResponseType.CANCEL, accept, Gtk.ResponseType.ACCEPT)
        return panel

    exchange = {".waffle-block", ".waffle-rules", ".waffle-eco", ".waffle-ai", ".atrgroup", ".rul"}
    exchange_inputs = exchange | SOURCE_EXTENSIONS | PROJECT_EXTENSIONS | LIBRARY_TYPES
    # Exchange files plus manufacturing outputs (reports, drawings, archives, Gerber, drill).
    exchange_outputs = exchange | {".step", ".stp", ".glb", ".csv", ".kicad_pcb", ".kicad_sch", ".txt", ".drl", ".svg", ".html", ".zip", ".xlsx", ".pdf",
                                   ".gtl", ".gbl", ".gto", ".gbo", ".gts", ".gbs", ".gtp", ".gbp", ".gm1", ".gko"} | {".g%d" % n for n in range(1, 31)}
    def open_files(picking=False, requested=None, detached=False):
        nonlocal selected_source
        if picking:
            extensions = TranslatorFiles.extensions(requested)
            if not extensions or not extensions <= exchange_inputs:
                raise HostError("Unrecognised exchange file type.")
        else:
            extensions = TRANSLATORS.open_types(requested)
            if not extensions:
                raise HostError("The import formats could not be loaded.")
        # Library sources (.atrlib, .json) are remembered so they can be reloaded later.
        library = picking and ".atrlib" in extensions and extensions <= LIBRARY_TYPES
        panel = dialog(Gtk.FileChooserAction.OPEN, "Open in Waffle", "Open")
        panel.set_select_multiple(not picking)
        formats = Gtk.FileFilter()
        formats.set_name("Supported files")
        for ext in sorted(extensions):
            formats.add_pattern("*" + "".join(("[" + c.upper() + c.lower() + "]" if c.isalpha() else c) for c in ext))
        panel.add_filter(formats)
        try:
            paths = panel.get_filenames() if panel.run() == Gtk.ResponseType.ACCEPT else []
        finally:
            panel.destroy()
        if any(Path(p).suffix.lower() == ".atrium" for p in paths):
            raise HostError(PRE_RELEASE_MESSAGE)
        if any(Path(p).suffix.lower() not in extensions for p in paths):
            raise HostError("Choose one of the requested document types.")
        if detached or picking:
            if any(native_project_name(p) for p in paths):
                return read_projects(paths, background=True)
        if detached:
            return read_document_copies(paths)
        if not picking:
            return project_open.open(paths)
        if not paths:
            return []
        path = Path(paths[0])
        if path.suffix.lower() in SOURCE_EXTENSIONS:
            source = AltiumCopySource(path)
            try:
                data = base64.b64encode(source.read()).decode("ascii")
            except Exception:
                source.close()
                raise
            if selected_source:
                selected_source.close()
            selected_source = source
            return [{"name": path.name, "data": data, "sourceToken": source.token}]
        entry = {"name": path.name, "data": base64.b64encode(path.read_bytes()).decode("ascii")}
        if library and path.suffix.lower() in LIBRARY_TYPES:
            library_reads.remember(path)
            entry["path"] = os.path.realpath(str(path))
        return [entry]

    def imported_save(request):
        op, action, request_id = request.get("operation"), request["action"], request["id"]
        if not isinstance(op, str) or not re.fullmatch("[a-fA-F0-9-]{36}", op) or op in import_ops:
            raise HostError("Invalid import Save operation.")

        def run(panel):
            import_ops[op] = lambda: panel.response(Gtk.ResponseType.CANCEL)
            try:
                response = panel.run()
                return response if op in import_ops else Gtk.ResponseType.CANCEL
            finally:
                import_ops.pop(op, None)

        if action == "reselectImportSave":
            key = request.get("sourceKey")
            panel = dialog(Gtk.FileChooserAction.OPEN, "Choose the original design to reconnect this draft", "Open")
            panel.set_select_multiple(True)
            try:
                paths = [Path(p) for p in panel.get_filenames()] if run(panel) == Gtk.ResponseType.ACCEPT else []
            finally:
                panel.destroy()
            if paths and all(TRANSLATORS.accepts(p) and not native_project_name(p) for p in paths):
                files = read_projects(paths)
                index = next((i for i,r in enumerate(files) if r.get("importSaveKey") == key), None)
                if index is not None:
                    files.insert(0, files.pop(index))
                    return reply(request_id, files)
                pending_import.clear()
            return reply(request_id, None)
        choice_only = (action == "importSaveChoice" and restored_import and restored_import["draftId"] == foreign_import_id
                       and all(request.get(k) == v for k,v in restored_import.items()))
        if not choice_only:
            check_import(request)
        if action == "importSaveChoice":
            labels = request["labels"]
            panel = Gtk.MessageDialog(transient_for=window, modal=True, message_type=Gtk.MessageType.QUESTION,
                                      buttons=Gtk.ButtonsType.NONE, text=labels["title"][:512])
            if labels.get("detail"):
                panel.format_secondary_text(labels["detail"][:1024])
            panel.add_button(labels["cancel"][:120], Gtk.ResponseType.CANCEL)
            if request.get("canExport") is not False and labels.get("export"):
                panel.add_button(labels["export"][:120], Gtk.ResponseType.APPLY)
            panel.add_button(labels["save"][:120], Gtk.ResponseType.ACCEPT)
            panel.set_default_response(Gtk.ResponseType.ACCEPT)
            try:
                response = run(panel)
            finally:
                panel.destroy()
            return reply(request_id, {Gtk.ResponseType.ACCEPT:"waffle", Gtk.ResponseType.APPLY:"export"}.get(response, "cancel"))

        token = request.get("destination")
        receipt = import_targets.get(token)
        if (token is not None or action == "rememberImportExport") and receipt is None:
            raise HostError("The export destination grant expired. Choose a new destination.")
        args = {"support": str(support), "key": bound_import["key"], "receipt": receipt}
        if action == "writeImportExport":
            name = import_export.safe_name(request["name"])
            if "/" in name:
                raise HostError("Choose a single export name.")
            single = request.get("single") is True
            args.update(files=request["files"], single=single, sources=bound_import["sources"])
            if receipt is None:
                panel = dialog(Gtk.FileChooserAction.SAVE if single else Gtk.FileChooserAction.SELECT_FOLDER,
                               "Export design" if single else "Choose the parent folder for the exported design", "Save" if single else "Choose")
                if single:
                    panel.set_current_name(name)
                try:
                    selected = panel.get_filename() if run(panel) == Gtk.ResponseType.ACCEPT else None
                finally:
                    panel.destroy()
                if not selected:
                    return reply(request_id, False)
                args["selected"] = str(Path(selected) if single else Path(selected) / name)
        fd, marker = tempfile.mkstemp(prefix="waffle-export-")
        os.close(fd)
        import_ops[op] = lambda: Path(marker).unlink(missing_ok=True)
        args["guardFile"] = marker
        verb = {"writeImportExport":"writeExport", "rememberImportExport":"rememberExport",
                "recalledImportExport":"recallExport", "forgetImportExport":"forgetExport"}[action]
        def complete(job):
            def deliver():
                done = import_ops.pop(op, None)
                if not done:
                    if not closed and not renderer_failed:
                        reply(request_id, error="The imported design changed.")
                    return False
                done()
                try:
                    value = job.result()
                    if verb in ("writeExport", "recallExport"):
                        item = value.get("receipt")
                        destination = token or uuid.uuid4().hex
                        if item:
                            import_targets[destination] = item
                        visible = {"destination":destination,"name":item["name"]} if item else None
                        if visible is not None and value.get("preferenceError"):
                            visible["preferenceError"] = value["preferenceError"]
                        reply(request_id, visible)
                    else:
                        reply(request_id, True)
                except (OSError, ValueError, KeyError, TypeError) as error:
                    reply(request_id, error=str(error))
                return False
            GLib.idle_add(deliver)
        folder_queue.submit(import_export.command, verb, args).add_done_callback(complete)

    def portable_action(request):
        # Choosers and grant adoption run on GTK; the read lease, original and publication on
        # this window's serial folder executor. Only the two selection dialogs can add access.
        import project_archive
        action, request_id = request["action"], request["id"]
        def selected(token):
            if not isinstance(token, str):
                return None
            if token in retained_inputs:
                return retained_inputs[token][0]
            return None

        def choose_parent():
            chooser = dialog(Gtk.FileChooserAction.SELECT_FOLDER, "Choose a folder for the new Waffle project", "Choose")
            try:
                if chooser.run() == Gtk.ResponseType.ACCEPT:
                    return Path(chooser.get_filename())
            finally:
                chooser.destroy()
            return None

        def choose_destination(source):
            # First Save of an import always asks where the project goes: the folder of the most
            # recent Waffle project, else beside the source project folder, never inside it by default.
            manifest = request.get("manifest") if isinstance(request.get("manifest"), str) else "Project.waffle"
            stem = request.get("folderName") if isinstance(request.get("folderName"), str) else Path(manifest).stem
            start, name = project_archive.suggest_destination(source, [e["path"] for e in recent.entries], stem)
            chooser = dialog(Gtk.FileChooserAction.SAVE, "Save Waffle Project Folder", "Create Folder")
            chooser.set_do_overwrite_confirmation(False)
            chooser.set_current_folder(str(start))
            chooser.set_current_name(name)
            try:
                if chooser.run() == Gtk.ResponseType.ACCEPT:
                    chosen = Path(chooser.get_filename())
                    return chosen.parent, chosen.name
            finally:
                chooser.destroy()
            return None, None

        conversion_op = None
        conversion_stop = None
        root = folder_service(request["grant"]) if request.get("grant") is not None else None
        token = request.get("sourceToken")
        source = selected(token)
        if action in ("installProjectArchive", "folderConvertSibling"):
            convert = action == "folderConvertSibling"
            if convert and source is None:
                raise HostError("Choose the original file again before converting it.")
            if convert:
                check_import(request)
            destination = None
            if convert:
                parent, destination = choose_destination(source)
            else:
                parent = choose_parent()
            if parent is None:
                return reply(request_id, False)
            if convert:
                check_import(request)
                conversion_op = request.get("operation")
                if not isinstance(conversion_op, str) or conversion_op in import_ops:
                    raise HostError("Invalid import Save operation.")
                conversion_stop = threading.Event()
                import_ops[conversion_op] = conversion_stop.set
            def still_current():
                if conversion_stop is not None and conversion_stop.is_set():
                    raise HostError("The import Save operation was cancelled.")
            def work():
                return project_archive.install(parent, request.get("manifest"), request.get("files"), request.get("version"),
                                               destination_name=destination, before_publish=still_current)
            def result(path):
                return read_projects([path])[0]
        else:
            if root is None:
                raise HostError("The saved project grant has expired.")
            def work():
                lease = request.get("lease")
                root.verify_lease(lease)
                value = project_archive.retained_original(root.directory, root.manifest,
                                                          request.get("bindingPath"), request.get("inputId"))
                root.verify_lease(lease)
                return value
            result = lambda data: data

        def completed(job):
            def deliver():
                if closed or renderer_failed:
                    return False
                try:
                    if conversion_op is not None and import_ops.pop(conversion_op, None) is None:
                        return reply(request_id, False)
                    reply(request_id, result(job.result()))
                except project_archive.ParentNotWritable as error:
                    reply(request_id, error=str(error))
                except (OSError, ValueError, TypeError, KeyError, RuntimeError) as error:
                    reply(request_id, error=str(error))
                return False
            GLib.idle_add(deliver)
        folder_queue.submit(work).add_done_callback(completed)

    def save_file(request):
        copying = request["action"] == "exportBinaryCopy"
        expected = Path(request["name"]).suffix.lower()
        source = selected_source
        if copying and (not source or request.get("sourceToken") != source.token):
            raise ValueError("Select the original Altium document again.")
        if copying and expected != source.path.suffix.lower():
            raise ValueError("Use the same document extension as the source.")
        panel = dialog(Gtk.FileChooserAction.SAVE, "Export Altium Copy" if copying else "Export", "Save")
        panel.set_do_overwrite_confirmation(True)
        panel.set_current_name(Path(request["name"]).name)
        try:
            path = panel.get_filename() if panel.run() == Gtk.ResponseType.ACCEPT else None
        finally:
            panel.destroy()
        if not path:
            return False
        destination = Path(path)
        if copying:
            source.save_copy(destination, base64.b64decode(request["data"], validate=True))
            return True
        allowed = exchange_outputs
        if expected not in allowed or destination.suffix.lower() != expected:
            raise ValueError("Choose a filename ending in " + expected + ".")
        if request["action"] == "export" and "data" in request:
            payload = base64.b64decode(request["data"], validate=True)
        else:
            payload = request["text"].encode("utf-8")
        atomic_write(destination, payload)
        return True

    def read_git(request_id, action, binding, revision, op=None, query_args=None, saved_folder=None):
        def deliver(callback, *args):
            if closed or renderer_failed:
                return False
            if git_source != binding and folder_current != binding[0]:
                reply(request_id, error="The active project changed. Open revision review again.")
            else:
                callback(*args)
            return False
        try:
            if action == "gitHistory" or (action == "gitQuery" and op != "read"):
                # gitQuery: git_head.query checks the operation and arguments (validate_query),
                # the same rules as the macOS and Windows hosts.
                if saved_folder is not None:
                    def read_saved_git():
                        # Acquire and release in one queued operation. A writer queued in between
                        # could otherwise wait for a shared lock that this queue must release.
                        lease = saved_folder.acquire(recover=False)
                        try:
                            result = git_query(binding[1], op, query_args)
                            saved_folder.verify_lease(lease)
                            return result
                        finally:
                            saved_folder.release(lease)
                    value = folder_queue.submit(read_saved_git).result()
                else:
                    value = ProjectHistory(binding[1]).history() if action == "gitHistory" else git_query(binding[1], op, query_args)
                GLib.idle_add(deliver, reply, request_id, value)
                return
            if action == "gitRevision" and not isinstance(revision,str):
                raise ValueError("Choose a full commit identifier from the project history.")
            if action == "gitQuery":
                value = git_query(binding[1], "read", query_args)
            else:
                # Any commit reachable from HEAD or a branch, remote branch or tag (as the macOS and Windows hosts' CLI reads).
                value = ProjectHistory(binding[1]).read(revision if action=="gitRevision" else None, None, False, None, any_ref=True)
            if async_git_reply:
                if "\0" in value["text"]:
                    raise ValueError("The selected commit contains invalid project JSON.")
                args = {k:GLib.Variant("s",v) for k,v in value.items() if isinstance(v,str)}
                args["id"] = GLib.Variant("d",float(request_id))
                arguments = GLib.Variant("a{sv}",args)
                fields = "text,revision,path" + (",blob" if "blob" in args else "")
                GLib.idle_add(deliver, lambda: editor.call_async_javascript_function(
                    "window.__atriumReceive(id, {" + fields + "}, null)", -1,
                    arguments, None, None, None, None, None))
            else:
                # Older WebKitGTK has only a source-string API. Quote the
                # untrusted text once, away from the UI thread.
                script = "window.__atriumReceive(%d,%s,null)" % (request_id, json.dumps(value,ensure_ascii=True))
                GLib.idle_add(deliver, lambda: editor.run_javascript(script, None, None, None))
        except (OSError, ValueError, RuntimeError) as error:
            GLib.idle_add(reply, request_id, None, str(error))

    def on_message(_manager, result):
        nonlocal dirty, project_name, foreign_import_id, startup, git_source, picked_history
        nonlocal folder_current, folder_pending
        nonlocal butter_drop_enabled, typed_drop
        if closed or renderer_failed or editor.get_uri() != PAGE.as_uri():
            return
        request = bridge_message(result.get_js_value().to_string(), capability)
        if not request:
            return
        action = request.get("action")
        if action == "launchReady":
            reveal()
            return
        if action == "workspaceLaunchFailed":
            fail_workspace_launch()
            return
        if action == "workspaceWindow" and type(request.get("id")) is int:
            try:
                workspace_request(request)
            except (ValueError, TypeError) as error:
                reply(request["id"], error=str(error))
            return
        if action == "butterDropEnabled":
            butter_drop_enabled = request.get("enabled") is True
            if not butter_drop_enabled:
                retire_typed_drop()
            return
        if action in ("butterDropCancel", "butterDropFinish"):
            if isinstance(request.get("token"), str):
                retire_typed_drop(request["token"], fallback=action == "butterDropFinish" and request.get("handled") is False)
            return
        if action == "butterDropTake":
            offer = typed_drop
            if type(request.get("id")) is int:
                if (not offer or offer["token"] != request.get("token") or offer["taken"] or
                        time.monotonic() - offer["time"] > 10 or not current_typed_drop(offer)):
                    reply(request["id"])
                else:
                    offer["taken"], offer["request"] = True, request["id"]
                    if offer["raw"]:
                        view, context, timestamp = offer["raw"]
                        view.drag_get_data(context,pdf_drop,timestamp)
                    else:
                        load_typed_drop(offer)
            return
        if action == "finishedOpening":
            success = request.get("success") is True
            project_open.finished(success)
            if folder_pending is not None:
                grant, folder_pending = folder_pending, None
                if success and grant in folders:
                    root = folders[grant]["root"]
                    if folder_current != grant:
                        close_project(folder_current)
                    folder_current = grant
                    note_recent(root.directory / root.manifest)
                elif not success:
                    close_folder(grant)
            return
        if action == "acceptHistorySource":
            if picked_history and request.get("token") == picked_history[0]:
                git_source, picked_history = picked_history, None
            return
        if action == "bindRestoredImportSave":
            reset_import()
            draft, key, session, fmt = (request.get(k) for k in ("draftId", "sourceKey", "session", "format"))
            if (isinstance(draft,str) and 0 < len(draft) <= 160 and isinstance(key,str) and re.fullmatch(r"(?:[a-z0-9_-]+:)?[0-9a-f]{64}",key)
                    and isinstance(session,str) and re.fullmatch(r"[a-fA-F0-9-]{36}",session) and fmt in ("altium","kicad","eagle","easyeda")):
                restored_import.update(draftId=draft,sourceKey=key,session=session,format=fmt)
            return
        if action == "bindImportSave":
            bind_import(request)
            return
        if action == "cancelImportSave":
            cancel = import_ops.pop(request.get("operation"), None)
            if cancel:
                cancel()
            return
        if action == "clearGitProject":
            reset_import()
            git_source = None
            if folder_current is not None:
                close_folder(folder_current)
            return
        if action == "externalCancel":
            external_runner.cancel(str(request.get("runId") or ""))
            return
        if action == "foreignCloseReviewed":
            expected = closing["foreign"]
            if expected is not None and request.get("importId") == expected:
                closing["foreign"] = None
                if request.get("approved") is True and (foreign_import_id == expected or not dirty and foreign_import_id is None):
                    closing["approved"] = expected
                    GLib.idle_add(window.close)
            return
        if action == "saveForClose":
            if save_to_close.finished(request.get("saved"), dirty):
                GLib.idle_add(window.close)  # delete-event again, now clean
            return
        if action == "dirty":
            dirty = bool(request.get("dirty"))
            foreign_import_id = request.get("importId")
            if not isinstance(foreign_import_id, str) or not 0 < len(foreign_import_id) <= 160:
                foreign_import_id = None
            closing["approved"] = None
            project_name = request.get("projectName") if isinstance(request.get("projectName"), str) else None
            project_open.has_project = (isinstance(request.get("projectName"), str) if "projectName" in request
                                        else bool(dirty or folder_current))
            window.set_title("Waffle •" if dirty else "Waffle")
            return
        try:
            if action == "recoverySession":
                reply(request["id"], None)
                return
            if action == "printPDF":
                # print.js has mounted the pages as SVG and print.css hides the editor.
                operation = WebKit2.PrintOperation.new(editor)
                request_id = request["id"]
                operation.connect("finished", lambda *_: reply(request_id, True))
                operation.connect("failed", lambda _op, error: reply(request_id, None, error.message))
                if operation.run_dialog(window) == WebKit2.PrintOperationResponse.CANCEL:
                    reply(request_id, False)
                return
            if action == "writeSelection":
                data, summary = request.get("data"), request.get("summary")
                if not isinstance(data,str) or len(data.encode("utf-8")) > 16*1024*1024 or not isinstance(summary,str) or len(summary) >= 512:
                    raise ValueError("Invalid clipboard selection.")
                clipboard = Gtk.Clipboard.get(Gdk.SELECTION_CLIPBOARD)
                # GTK3's standard text target also survives clipboard managers.
                clipboard.set_text(summary + "\nWaffle-Selection/1\n" + data, -1)
                reply(request["id"], True)
                return
            if action == "readSelection":
                clipboard = Gtk.Clipboard.get(Gdk.SELECTION_CLIPBOARD)
                captured = folder_current

                def received_files(_clipboard, uris, *_user_data):
                    paths = []
                    if not closed and captured == folder_current:
                        for uri in (uris or [])[:32]:
                            try:
                                filename, hostname = GLib.filename_from_uri(uri)
                                if filename and hostname in (None, "", "localhost") and regular_document(filename):
                                    paths.append(filename)
                            except GLib.Error:
                                continue
                    try:
                        reply(request["id"], {"files": read_document_copies(paths)} if paths else {})
                    except (OSError, ValueError) as error:
                        reply(request["id"], None, str(error))

                def received(_clipboard, text, *_user_data):
                    typed = (isinstance(text, str) and text.startswith("Waffle ") and
                             "\nWaffle-Selection/1\n" in text[:535] and len(text.encode("utf-8")) <= 16*1024*1024+512)
                    if typed:
                        reply(request["id"], {"text": text})
                    else:
                        clipboard.request_uris(received_files, None)
                clipboard.request_text(received, None)
                return
            if action in ("gitHead", "gitHistory", "gitRevision"):
                if folder_current is None or request.get("token") != folder_current:
                    raise ValueError("Save or open a Waffle project to compare its Git revision.")
                binding = (folder_current, current_project())
                threading.Thread(target=read_git, args=(request["id"],action,binding,request.get("revision")), daemon=True).start()
                return
            if action == "gitQuery":
                token, op = request.get("token"), request.get("op")
                record = folders.get(folder_current) if token == folder_current else None
                saved_folder = record["root"] if record else None
                if saved_folder is not None and op not in FOLDER_QUERIES:
                    raise ValueError("This Git command is unavailable for a folder project.")
                binding = (token, saved_folder.directory / saved_folder.manifest) if saved_folder is not None else (
                    git_source if git_source and token == git_source[0] and op in SOURCE_QUERIES else None)
                if binding is None or request.get("token") != binding[0]:
                    raise ValueError("Save or open a Waffle project to compare its Git revision.")
                query_args = validate_query(op, request.get("args"))
                threading.Thread(target=read_git, args=(request["id"],action,binding,None,op,query_args,saved_folder), daemon=True).start()
                return
            if action == "open" and startup and request.get("into") is not True:
                paths, startup = startup, []
                value = project_open.open(paths)
            elif action == "open":
                value = open_files(requested=request.get("extensions"), detached=request.get("into") is True)
            elif action in ("nativeMemberCommit", "nativeMemberExportCopy", "nativeMemberClose"):
                value = native_document_action(action, request)
                if action == "nativeMemberCommit":
                    return
            elif action in ("notebookMedia","notebookTransfer","notebookClip","notebookDerivative","notebookPaste","notebookDrop"):
                notebook_action(action,request)
                return
            elif action in ("reselectImportSave","importSaveChoice","writeImportExport","rememberImportExport","recalledImportExport","forgetImportExport"):
                imported_save(request)
                return
            elif action == "chooseProjectFolder":
                value = choose_project_folder(request)
            elif action in ("folderAdopt", "folderConflict", "folderConflictRead", "folderResolve",
                            "folderReadLease", "folderRead", "folderRelease", "folderCommit", "folderStatus", "folderLocalState", "folderClose",
                            "folderPickAsset", "folderStageAsset", "folderDropAsset", "folderReadAsset", "folderDraftAssetProof", "folderRestoreDraftAsset"):
                perform_folder_action(action, request)
                return
            elif action == "pick":
                value = open_files(picking=True, requested=request.get("extensions"))
            elif action in ("folderReadImportSource", "installProjectArchive", "folderConvertSibling"):
                portable_action(request)
                return
            elif action in ("export", "exportBinaryCopy"):
                value = save_file(request)
            elif action in ("collabLocks", "collabLockWrite", "collabLockRemove"):
                grant = request.get("grant")
                if not isinstance(grant, str) or grant != folder_current:
                    raise HostError("The active Waffle project changed.")
                root = folder_service(grant)
                request_id = request["id"]
                if action == "collabLockWrite":
                    collab_writers.add(grant)
                def work():
                    if grant != folder_current:
                        raise HostError("The active Waffle project changed.")
                    with collab_path(root) as project:
                        if action == "collabLocks":
                            return collab_locks.listing(project)
                        if action == "collabLockWrite":
                            return collab_locks.write(project, request.get("key"), request.get("data"), request.get("mode"))
                        return collab_locks.remove(project, request.get("key"))
                def delivered(job):
                    def deliver():
                        try:
                            if folder_current != grant:
                                raise HostError("The active Waffle project changed.")
                            reply(request_id, job.result())
                        except (OSError, ValueError) as error:
                            reply(request_id, error=str(error))
                        return False
                    GLib.idle_add(deliver)
                collab_queue.submit(work).add_done_callback(delivered)
                return
            elif action == "aiCredential":
                provider, operation = request.get("provider"), request.get("operation")
                if (not isinstance(provider, str) or len(provider) > 192 or
                        not re.fullmatch(r"[A-Za-z0-9_.-]+:[a-z][a-z0-9-]{0,39}:[a-f0-9]{64}", provider) or
                        operation not in ("status", "load", "configure", "forget")):
                    raise ValueError("Invalid provider credential request.")
                if operation in ("status", "load"):
                    value = ai_secret_tool(operation, provider)
                else:
                    prompt = Gtk.Dialog(title="Provider credential", transient_for=window, modal=True)
                    prompt.add_button("Cancel", Gtk.ResponseType.CANCEL)
                    prompt.add_button("Store in keychain" if operation == "configure" else "Remove", Gtk.ResponseType.OK)
                    box = prompt.get_content_area()
                    box.pack_start(Gtk.Label(label=provider.rsplit(":", 1)[0]), False, False, 6)
                    field = Gtk.Entry(visibility=False, max_length=AI_CREDENTIAL_MAX_BYTES)
                    if operation == "configure":
                        box.pack_start(field, False, False, 6)
                    prompt.show_all()
                    accepted = prompt.run() == Gtk.ResponseType.OK
                    secret = field.get_text() if operation == "configure" and accepted else None
                    field.set_text("")
                    prompt.destroy()
                    if secret is not None and (not 0 < len(secret.encode("utf-8")) <= AI_CREDENTIAL_MAX_BYTES or any(ord(ch) < 32 or 127 <= ord(ch) <= 159 for ch in secret)):
                        raise ValueError("Enter a single provider credential of at most 4096 bytes.")
                    value = ai_secret_tool(operation, provider, secret) if accepted else {"cancelled": True}
            elif action == "externalToolList":
                value = dict(external_store.listing(), platform="linux")
            elif action == "externalToolProbe":
                value = external_tools.probe(request.get("paths"))
            elif action == "externalToolForget":
                value = external_store.forget(str(request.get("toolId") or ""))
            elif action == "externalToolChoose":
                value = choose_external(request)
            elif action == "externalRun":
                run_external(request["id"], request.get("run"))
                return
            elif action in ("lanStart", "lanHost", "lanStop", "lanBrowse"):
                request_id = request["id"]
                def lan_work(action=action, request=request):
                    return lan_handle(lan, action, request)
                def lan_done(job, request_id=request_id):
                    def deliver():
                        try:
                            reply(request_id, job.result())
                        except (OSError, ValueError) as error:
                            reply(request_id, error=str(error))
                        return False
                    GLib.idle_add(deliver)
                collab_queue.submit(lan_work).add_done_callback(lan_done)
                return
            elif action == "crashHistory":
                value = crash_history(support)
            elif action == "recentFiles":
                value = recent.listing(check_availability=request.get("metadataOnly") is not True)
            elif action == "linkRecentProjects":
                project_id = request.get("projectId")
                if not isinstance(project_id, str) or len(project_id) != 36 or not re.fullmatch(LINK_ID, project_id):
                    raise HostError("Choose a valid Waffle project identity.")
                recent_entries = recent.listing()
                request_id = request["id"]
                def match_recent():
                    matches = []
                    for entry in recent_entries:
                        if Path(entry["path"]).suffix.lower() != ".waffle":
                            continue
                        try:
                            fd = os.open(entry["path"], folder_project.FILE_FLAGS)
                            try:
                                if not stat.S_ISREG(os.fstat(fd).st_mode):
                                    continue
                                header = folder_project.format_header(os.read(fd, folder_project.HEADER_CAP + 1))
                                if header and header["id"] == project_id:
                                    matches.append(entry)
                            finally:
                                os.close(fd)
                        except (OSError, ValueError):
                            continue
                    GLib.idle_add(reply, request_id, matches)
                folder_queue.submit(match_recent)
                return
            elif action == "openRecent":
                value = project_open.recent(recent, request.get("path"), request.get("activate") is True)
            elif action in ("chooseLibraryFolder", "libraryFolderList", "libraryFolderRead", "libraryFolderWrite", "forgetLibraryFolder"):
                request_id, grant = request["id"], request.get("grant")
                if action == "chooseLibraryFolder":
                    purpose = request.get("purpose")
                    if purpose not in LibraryFolders.PURPOSES:
                        raise HostError("Invalid library folder request.")
                    title = "Choose the KiCad 3D model folder" if purpose == "models" else "Choose a library folder"
                    panel = dialog(Gtk.FileChooserAction.SELECT_FOLDER, title, "Save here" if purpose == "write" else "Choose")
                    try:
                        path = panel.get_filename() if panel.run() == Gtk.ResponseType.ACCEPT else None
                    finally:
                        panel.destroy()
                    if not path:
                        reply(request_id, None)
                        return
                    job = library_queue.submit(library_folders.remember, path, purpose)
                elif action == "libraryFolderList":
                    job = library_queue.submit(library_folders.list, grant)
                elif action == "libraryFolderRead":
                    job = library_queue.submit(library_folders.read, grant, request.get("paths"))
                elif action == "libraryFolderWrite":
                    job = library_queue.submit(library_folders.write, grant, request.get("path"), request.get("text"))
                else:
                    job = library_queue.submit(library_folders.forget, grant)

                def completed(job, request_id=request_id):
                    def deliver():
                        if closed:
                            return False
                        try:
                            reply(request_id, job.result())
                        except (OSError, ValueError) as error:
                            reply(request_id, error=str(error))
                        return False
                    GLib.idle_add(deliver)
                job.add_done_callback(completed)
                return
            elif action == "openKiCadLicence":
                value = webbrowser.open("https://www.kicad.org/libraries/license/")
            elif action == "openURL":
                value = webbrowser.open(external_url(request.get("url")))
            elif action == "readFile":
                value = library_reads.read(request.get("path"))
            else:
                raise ValueError("Unknown file action.")
            reply(request["id"], value)
        except (OSError, ValueError, KeyError) as error:
            reply(request.get("id"), error=str(error))

    def policy(_editor, decision, kind):
        if kind in (WebKit2.PolicyDecisionType.NAVIGATION_ACTION, WebKit2.PolicyDecisionType.NEW_WINDOW_ACTION):
            uri = decision.get_navigation_action().get_request().get_uri()
            # Inline subframe documents: the extension sandbox (about:srcdoc) and print previews
            # (about:blank). Only the editor's own page script can create them; extension code has no DOM.
            inline = kind == WebKit2.PolicyDecisionType.NAVIGATION_ACTION and uri in ("about:srcdoc", "about:blank")
            if not inline and (uri != PAGE.as_uri() or kind == WebKit2.PolicyDecisionType.NEW_WINDOW_ACTION):
                decision.ignore()
                return True
        return False

    def workspace_scope():
        folder = folders.get(folder_current)
        return (current_project(), folder["root"].project_identity, folder_current) if folder else None

    def workspace_event(event):
        if not closed and not renderer_failed:
            editor.run_javascript("window.__waffleWorkspaceEvent?.(" + json.dumps(event, ensure_ascii=True) + ")", None, None, None)

    def workspace_bounds(bounds):
        if isinstance(bounds, dict) and all(type(bounds.get(key)) is int for key in ("left", "top", "width", "height")):
            if bounds["width"] > 0 and bounds["height"] > 0:
                window.move(bounds["left"], bounds["top"])
                window.resize(bounds["width"], bounds["height"])

    def workspace_capture():
        left, top = window.get_position()
        width, height = window.get_size()
        display = window.get_display()
        monitor = display.get_monitor_at_window(window.get_window()) if window.get_window() else None
        return {"left": left, "top": top, "width": width, "height": height,
                "display": monitor.get_model() if monitor else None}

    def workspace_spawn(group, key, tab):
        create_editor_window(Gdk, GLib, Gtk, WebKit2, [], open_window, windows, recent, application,
                             workspace=(group, key, tab))

    def present():
        nonlocal present_when_ready
        if window.get_opacity() < 1:
            present_when_ready = True
        else:
            window.present()

    workspace_peer = {"id": workspace_id, "tab": workspace_tab, "scope": workspace_scope, "reply": reply,
                      "send": workspace_event, "present": present, "close": window.destroy,
                      "bounds": workspace_bounds, "capture": workspace_capture,
                      "visible": lambda: window.get_visible() and window.get_opacity() == 1}
    if workspace_group is not None:
        workspace_group.members[workspace_id] = workspace_peer

    def workspace_request(request):
        nonlocal workspace_group
        cap = 32 << 20 if request.get("operation") == "deliver" else 1 << 20
        if len(json.dumps(request, ensure_ascii=False).encode()) > cap:
            raise HostError("The project window operation exceeds its size limit.")
        if request.get("operation") == "describe" and (workspace_group is None or
                workspace_group.writer is workspace_peer and workspace_scope() != workspace_group.scope):
            scope = workspace_scope()
            if scope is None or not scope[1] or request.get("project") != scope[1] or request.get("grant") != scope[2]:
                raise HostError("Open a native Waffle project to manage its windows.")
            if workspace_group is not None and scope[:2] == workspace_group.scope[:2]:
                workspace_group.adopt_scope(scope)
            else:
                if workspace_group is not None:
                    old = workspace_group
                    for other in list(old.members.values()):
                        if other is not workspace_peer:
                            old.retire(other)
                            other["close"]()
                workspace_group = WorkspaceWindows(scope[1], scope, workspace_peer, workspace_spawn)
        if workspace_group is None:
            raise HostError("The project window writer is unavailable.")
        return workspace_group.request(workspace_peer, request)

    def follow_link(url):
        present()
        if not closed and editor.get_uri() == PAGE.as_uri():
            editor.run_javascript("window.__waffleOpenLink(" + json.dumps(url) + ")", None, None, None)

    windows[window] = {"scope": workspace_scope, "follow": follow_link, "present": present,
                       "writer": lambda: workspace_group is None or workspace_group.writer is workspace_peer}

    launch_timer = 0
    launch_failed = False

    def cancel_launch_timer():
        nonlocal launch_timer
        if launch_timer:
            GLib.source_remove(launch_timer)
            launch_timer = 0

    def reveal():
        cancel_launch_timer()
        if not closed and not launch_failed and window.get_opacity() < 1:
            window.set_opacity(1)
            if map_on_reveal:
                window.show_all()
            if present_when_ready:
                window.present()

    def fail_workspace_launch(*_):
        nonlocal launch_failed
        if closed or launch_failed or not workspace or window.get_opacity() == 1:
            return False
        cancel_launch_timer()
        launch_failed = True
        alert = Gtk.MessageDialog(transient_for=window, modal=True, destroy_with_parent=True,
                                  message_type=Gtk.MessageType.WARNING, buttons=Gtk.ButtonsType.CLOSE,
                                  text="This project window could not open.")
        alert.format_secondary_text("Close this window and try opening the tab again from the main project window.")

        def dismiss(dialog, _response):
            dialog.destroy()
            window.destroy()

        alert.connect("response", dismiss)
        alert.show()
        return False

    def launch_timeout():
        nonlocal launch_timer
        launch_timer = 0
        if workspace:
            fail_workspace_launch()
        else:
            reveal()
        return False

    def loaded(_editor, event):
        nonlocal startup_link
        if event == WebKit2.LoadEvent.STARTED:
            lan.stop()   # a reloaded page has no session to share
        if event == WebKit2.LoadEvent.FINISHED:
            accent_changed(editor)
            if workspace_group is not None and workspace_peer is not workspace_group.writer:
                workspace_event({"type": "arrival", "tab": workspace_peer["tab"]})
        if event == WebKit2.LoadEvent.FINISHED and startup_link and editor.get_uri() == PAGE.as_uri():
            follow_link(startup_link)
            startup_link = None
        if event == WebKit2.LoadEvent.FINISHED and startup and editor.get_uri() == PAGE.as_uri():
            editor.run_javascript("window.dispatchEvent(new CustomEvent('atrium-command',{detail:'open'}))",
                                  None, None, None)

    # Responsiveness watchdog: WebKitGTK reports a web process that stopped answering. The user
    # may wait, or close the window (the page is ended, the sidecar kept); reopening Waffle offers
    # the autosaved work. The dialog goes away by itself if the page answers again.
    hang = {"dialog": None, "closing": False}

    def responsiveness_changed(*_):
        dialog = hang["dialog"]
        if editor.get_property("is-web-process-responsive"):
            if dialog is not None:
                hang["dialog"] = None
                dialog.destroy()
            return
        if renderer_failed or dialog is not None:
            return
        dialog = Gtk.MessageDialog(transient_for=window, modal=True, message_type=Gtk.MessageType.WARNING,
                                   buttons=Gtk.ButtonsType.NONE, text="The editor is not responding.")
        dialog.format_secondary_text("It may be busy with a long task. Wait for it, or close the window: reopening Waffle "
                                     "offers your autosaved work, and nothing is written to your files without asking.")
        dialog.add_button("Wait", Gtk.ResponseType.CANCEL)
        dialog.add_button("Close Window", Gtk.ResponseType.CLOSE)
        hang["dialog"] = dialog

        def answered(widget, response):
            if hang["dialog"] is widget:
                hang["dialog"] = None
            widget.destroy()
            if response == Gtk.ResponseType.CLOSE and not renderer_failed:
                hang["closing"] = True
                record_renderer_termination(support, "unresponsive")
                editor.terminate_web_process()

        dialog.connect("response", answered)
        dialog.show()

    def renderer_terminated(_editor, reason):
        nonlocal renderer_failed
        if renderer_failed:
            return
        renderer_failed = True
        if not workspace:
            reveal()
        else:
            cancel_launch_timer()
        if workspace_group is not None:
            workspace_group.renderer_failed(workspace_peer)
        reset_import()
        save_to_close.abandon()
        if launch_failed:
            return
        if hang["dialog"] is not None:
            hang["dialog"].destroy()
            hang["dialog"] = None
        if hang["closing"]:
            window.destroy()  # the user chose Close Window; the sidecar survives
            return
        reasons = WebKit2.WebProcessTerminationReason
        code = "exited" if reason == reasons.CRASHED else "memory-limit" if reason == reasons.EXCEEDED_MEMORY_LIMIT else "terminated"
        record_renderer_termination(support, code)
        alert = Gtk.MessageDialog(transient_for=window, modal=True, message_type=Gtk.MessageType.ERROR,
                                  buttons=Gtk.ButtonsType.CLOSE, text="Waffle's editor closed unexpectedly.")
        alert.format_secondary_text("Reopen Waffle and choose File › Recover to review your autosaved work.")
        alert.run()
        alert.destroy()
        # The native sidecar survives this closing path.
        window.destroy()

    editor_handlers = [editor.connect("style-updated", accent_changed),
        editor.connect("context-menu", context_menu),
        editor.connect("notify::zoom-level", keep_page_scale),
        editor.connect("load-changed", loaded),
        editor.connect("web-process-terminated", renderer_terminated),
        editor.connect("decide-policy", policy),
    ]
    if editor.find_property("is-web-process-responsive") is not None:  # WebKitGTK 2.34 and later
        editor_handlers.append(editor.connect("notify::is-web-process-responsive", responsiveness_changed))
    if workspace:
        editor_handlers.append(editor.connect("load-failed", fail_workspace_launch))
    message_handler = manager.connect("script-message-received::atriumHost", on_message)
    window_handlers = [window.connect("delete-event", confirm_close)]
    def destroyed(*_):
        if workspace_group is not None:
            workspace_group.close(workspace_peer)
        nonlocal closed, editor, manager
        closed = True
        cancel_launch_timer()
        # Each handler captures this window or its WebKit view. Break the cycles on GTK's thread
        # so a worker's Python garbage collection cannot release the closed WebKit view.
        manager.disconnect(message_handler)
        manager.unregister_script_message_handler("atriumHost")
        for handler in editor_handlers:
            editor.disconnect(handler)
        for handler in window_handlers:
            window.disconnect(handler)
        reset_import()
        pending_import.clear()
        retained_inputs.clear()
        for grant in list(folders):
            close_folder(grant)
        notebook.shutdown()
        folder_queue.shutdown(wait=True)
        for _, document in native_members.values():
            document.close()
        native_members.clear()
        collab_queue.shutdown(wait=True)
        # A previously queued lanStart may still have been running when the window closed.
        lan.stop()
        library_queue.shutdown(wait=False, cancel_futures=True)
        windows.pop(window, None)
        # Pending Git delivery closures can outlive the window. Drop the native references here
        # while on GTK's thread. Those deliveries recheck the window before touching WebKit.
        editor = manager = None

    window_handlers.append(window.connect("destroy", destroyed))
    def open_recent_menu(event=None):
        # Linux has no menu bar here: Ctrl+Shift+O shows Open Recent as a popup menu.
        menu = Gtk.Menu()
        entries = recent.listing()
        for entry in entries:
            item = Gtk.MenuItem(label=entry["name"])
            item.set_tooltip_text(entry["path"])
            item.connect("activate", lambda _item, path=entry["path"]: open_recent(path))
            menu.append(item)
        if entries:
            menu.append(Gtk.SeparatorMenuItem())
        clear = Gtk.MenuItem(label="Clear Menu" if entries else "No Recent Projects")
        clear.set_sensitive(bool(entries))
        clear.connect("activate", lambda _item: recent.clear())
        menu.append(clear)
        menu.show_all()
        menu.attach_to_widget(window, None)
        menu.popup_at_widget(editor, Gdk.Gravity.NORTH_WEST, Gdk.Gravity.NORTH_WEST, event)

    def open_recent(path):
        nonlocal startup
        try:
            startup = [recent.allowed(path)]
        except HostError:
            Gdk.beep()
            return
        # The same route as a project named on the command line: the page asks for "open".
        editor.run_javascript("window.dispatchEvent(new CustomEvent('atrium-command',{detail:'open'}))", None, None, None)

    def pause_extensions(_widget, event):
        control = event.state & Gdk.ModifierType.CONTROL_MASK and event.state & Gdk.ModifierType.SHIFT_MASK
        # Ctrl+Shift+Escape: pause every extension, even while an extension dialog is open.
        if event.keyval == Gdk.KEY_Escape and control:
            editor.run_javascript("globalThis.AtriumExtensions?.pauseAll?.(); void 0", None, None, None)
            return True
        if event.keyval in (Gdk.KEY_O, Gdk.KEY_o) and control:
            open_recent_menu(event)
            return True
        return False
    window_handlers.append(window.connect("key-press-event", pause_extensions))
    # Route OS file drops through the same native selection as Open, so the origin is known.
    file_drop = Gdk.Atom.intern("text/uri-list", False)
    pdf_drop = Gdk.Atom.intern("application/pdf", False)
    targets = editor.drag_dest_get_target_list()
    if targets is None:
        editor.drag_dest_set(Gtk.DestDefaults(0), [], Gdk.DragAction.COPY)
        targets = Gtk.TargetList.new([])
    targets.add(file_drop, 0, 0)
    targets.add(pdf_drop, 0, 1)
    editor.drag_dest_set_target_list(targets)

    def drop_target(context):
        if not context.get_actions() & Gdk.DragAction.COPY or Gtk.drag_get_source_widget(context) is editor:
            return None
        targets = {atom.name() for atom in context.list_targets()}
        if file_drop.name() in targets:
            return file_drop
        if butter_drop_enabled and pdf_drop.name() in targets:
            return pdf_drop
        return None

    def drag_motion(_view, context, _x, _y, timestamp):
        if not drop_target(context):
            return False
        Gdk.drag_status(context, Gdk.DragAction.COPY, timestamp)
        return True

    pending_drop = None

    def drop_script(view, script, args, callback=None):
        view.run_javascript("((v)=>{"+script+"})("+json.dumps(args)+");",None,callback,None)

    def finish_notebook_drop(view, intent, token=None, x=0, y=0):
        if not intent:
            return
        _,grant,key,owner=intent
        script="""
            const [grant,key,ownerId,dropToken,x,y]=v, pending=globalThis.__waffleGtkDrop;
            const discard=()=>dropToken&&globalThis.AtriumHost.notebookDrop({grant,ownerId,dropToken,discard:true}).catch(()=>{});
            if(pending?.key!==key){discard();return;}
            delete globalThis.__waffleGtkDrop;
            const scope=pending.scope;
            if(!dropToken||!scope?.current()){scope?.close();discard();return;}
            scope.signal.addEventListener("abort",discard,{once:true});
            globalThis.AtriumLazy.need("AtriumNotebookImageUI").then(ui=>scope.current()&&
                ui.dropCaptured(grant,dropToken,x,y,{signal:scope.signal})).then(placed=>{if(!placed)discard();},
                error=>{discard();if(!scope.signal.aborted)globalThis.AtriumNavHost.info(error.message);})
                .finally(()=>{scope.signal.removeEventListener("abort",discard);scope.close();});
        """
        drop_script(view,script,[grant,key,owner,token,x,y])

    def current_typed_drop(offer):
        return typed_drop is offer and butter_drop_enabled and not renderer_failed and folder_current == offer["grant"]

    def retire_typed_drop(token=None, *, fallback=False):
        nonlocal typed_drop
        offer = typed_drop
        if not offer or token is not None and offer["token"] != token:
            return
        allowed = current_typed_drop(offer)
        typed_drop = None
        offer["cancelled"].set()
        if offer["request"] is not None:
            reply(offer["request"])
        if offer["raw"]:
            _, context, timestamp = offer["raw"]
            Gtk.drag_finish(context,False,False,timestamp)
        if offer["fallback"]:
            offer["fallback"](fallback and allowed and not offer["taken"])

    def load_typed_drop(offer, data=None):
        def packet():
            meta = offer["file"]
            mime = meta["mime"]
            if data is None:
                cap = {"model/step":32 << 20,"text/csv":65536,"application/octet-stream":16 << 20}.get(mime,128 << 20)
                contents, _ = read_regular(offer["path"],cap,cancelled=offer["cancelled"])
                if meta["size"] != len(contents):
                    raise ValueError("The selected file changed while reading.")
            else:
                contents = data
            if offer["cancelled"].is_set():
                raise HostError("The drop was cancelled.")
            if not contents or mime == "application/pdf" and not folder_project.is_pdf(contents):
                raise ValueError("The dropped file does not match its type.")
            return {"name":meta["name"],"mime":mime,"data":base64.b64encode(contents).decode("ascii")}

        def complete(future):
            def finish():
                if typed_drop is not offer:
                    return False
                request, offer["request"] = offer["request"], None
                try:
                    reply(request,future.result() if current_typed_drop(offer) else None)
                except (OSError, ValueError, HostError) as error:
                    reply(request,None,str(error))
                return False
            GLib.idle_add(finish)
        notebook.media_queue.submit(packet).add_done_callback(complete)

    def offer_typed_drop(view, x, y, *, path=None, mime=None, size=None, raw=None, fallback=None):
        nonlocal typed_drop
        retire_typed_drop()
        token = uuid.uuid4().hex
        file = {"name":path.name if path else "Dropped.pdf","mime":mime or "application/pdf","size":size}
        typed_drop = {"token":token,"grant":folder_current,"time":time.monotonic(),"path":path,"raw":raw,
                      "file":file,"fallback":fallback,"taken":False,"request":None,"cancelled":threading.Event()}
        if raw:
            def expire():
                if typed_drop and typed_drop["token"] == token and typed_drop["raw"]:
                    retire_typed_drop(token)
                return False
            GLib.timeout_add_seconds(12,expire)
        script = """
            Promise.resolve(globalThis.__waffleNativeDropOffer?.(...v)).then(handled =>
              globalThis.AtriumHost?.finishTypedDrop?.(v[0],handled));
        """
        drop_script(view, script, [token,x/max(1,view.get_allocated_width()),y/max(1,view.get_allocated_height()),file])

    typed_extensions = {
        ".step":"model/step",".stp":"model/step",".csv":"text/csv",".pdf":"application/pdf",
        ".png":"image/png",".jpg":"image/jpeg",".jpeg":"image/jpeg",".webp":"image/webp",
        ".heic":"image/heic",".heif":"image/heif",".svg":"image/svg+xml",
        **{suffix:"application/octet-stream" for suffix in (".wlib",".atrlib",".schlib",".pcblib",".kicad_sym",".kicad_mod")},
    }

    def drag_drop(view, context, _x, _y, timestamp):
        nonlocal pending_drop
        target = drop_target(context)
        if target is None:
            return False
        if target == pdf_drop:
            offer_typed_drop(view,_x,_y,raw=(view,context,timestamp))
            return True
        if not folder_current:
            pending_drop = None
            view.drag_get_data(context,target,timestamp)
            return True
        intent=[context,folder_current,uuid.uuid4().hex,None]
        pending_drop=intent
        script="""
            const h=globalThis.AtriumNavHost;
            globalThis.__waffleGtkDrop?.scope?.close();
            const scope=h?.doc()?.kind==="schematic"&&h.folderProject?.()?.grant===v[0]
              ?globalThis.AtriumNotebookImageDrop?.capture(h):null;
            globalThis.__waffleGtkDrop={key:v[1],scope};
            return scope?.doc.id||"";
        """
        def selected(editor,result,_unused=None):
            if pending_drop is not intent:
                Gtk.drag_finish(context,False,False,timestamp)
                return
            try:
                value=editor.run_javascript_finish(result).get_js_value()
                if value.is_string() and folder_current==intent[1]:
                    intent[3]=value.to_string()
            except GLib.Error:
                pass
            editor.drag_get_data(context,file_drop,timestamp)
        drop_script(view,script,intent[1:3],selected)
        return True

    def drag_received(view, context, _x, _y, data, _info, timestamp):
        nonlocal startup,pending_drop
        if data.get_target().name() == pdf_drop.name():
            view.stop_emission_by_name("drag-data-received")
            offer = typed_drop
            if not offer or not offer["raw"] or offer["raw"][1] != context or offer["request"] is None:
                return
            offer["raw"] = None
            length = data.get_length()
            raw = bytes(data.get_data()) if 8 <= length <= 128 << 20 else b""
            accepted = folder_project.is_pdf(raw)
            Gtk.drag_finish(context,accepted,False,timestamp)
            load_typed_drop(offer,raw)
            return
        target = drop_target(context)
        if not target or data.get_target().name() != target.name():
            return
        view.stop_emission_by_name("drag-data-received")
        intent=pending_drop if pending_drop and pending_drop[0]==context else None
        if intent:
            pending_drop=None
        paths = []
        uris = data.get_uris() or []
        for uri in uris:
            try:
                filename, hostname = GLib.filename_from_uri(uri)
            except GLib.Error:
                continue
            path = Path(filename)
            suffix = path.suffix.lower()
            if butter_drop_enabled and len(uris) == 1 and hostname in (None,"","localhost") and suffix in typed_extensions:
                try:
                    info = path.lstat()
                except OSError:
                    info = None
                if info is not None and stat.S_ISREG(info.st_mode):
                    def fallback(accepted):
                        nonlocal startup
                        token = None
                        if accepted and intent and folder_current == intent[1] and typed_extensions[suffix].startswith(("application/pdf","image/")):
                            try:
                                token = notebook.offer_drop(intent[1],intent[3],path)
                            except (OSError, ValueError):
                                pass
                        finish_notebook_drop(view,intent,token,_x,_y)
                        if accepted and not token and (TRANSLATORS.accepts(path) or native_project_name(path)):
                            startup = [path]
                            view.run_javascript("window.dispatchEvent(new CustomEvent('atrium-command',{detail:'open'}))",None,None,None)
                    offer_typed_drop(view,_x,_y,path=path,mime=typed_extensions[suffix],size=info.st_size,fallback=fallback)
                    Gtk.drag_finish(context,True,False,timestamp)
                    return
            if (len(uris)==1 and hostname in (None,"","localhost") and intent and
                    path.suffix.lower() in (".png",".jpg",".jpeg",".heic",".heif",".webp",".svg",".pdf")):
                try:
                    token = notebook.offer_drop(intent[1],intent[3],path) if folder_current==intent[1] else None
                except (OSError, ValueError):
                    token = None
                finish_notebook_drop(view,intent,token,_x,_y)
                Gtk.drag_finish(context,bool(token),False,timestamp)
                return
            if hostname in (None, "", "localhost"):
                if document_named(path):
                    if regular_document(path):
                        paths.append(path)
                elif path.is_dir() or ((TRANSLATORS.accepts(path) or native_project_name(path)) and path.is_file()):
                    paths.append(path)
        finish_notebook_drop(view,intent)
        Gtk.drag_finish(context, bool(paths), False, timestamp)
        if project_open.has_project:
            documents = [path for path in paths if path.suffix.lower() in DOCUMENT_KINDS]
            if documents:
                try:
                    rows = read_document_copies(documents)
                    drop_script(view, "window.__waffleCopyNativeDocuments?.(v);", rows)
                    paths = [path for path in paths if path not in documents]
                except (OSError, ValueError) as failure:
                    drop_script(view, "globalThis.AtriumNavHost?.info(v);", str(failure))
                    return
        if paths:
            startup = paths
            view.run_javascript("window.dispatchEvent(new CustomEvent('atrium-command',{detail:'open'}))", None, None, None)

    editor_handlers.extend([editor.connect("drag-motion", drag_motion), editor.connect("drag-drop", drag_drop),
                            editor.connect("drag-data-received", drag_received)])
    window.set_opacity(0)
    launch_timer = GLib.timeout_add(15000 if workspace else 2000, launch_timeout)
    if map_on_reveal:
        window.realize()
        editor.show()
    else:
        window.show_all()
    editor.load_uri(PAGE.as_uri())


if __name__ == "__main__":
    raise SystemExit(main())
