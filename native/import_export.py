"""Publish complete foreign design exports to an explicitly selected desktop/CLI location."""
import base64
import ctypes
import errno
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import stat
import sys
import tempfile
import unicodedata

from project_archive import fsync_dir, portable, publication_lock, publish

LIMIT = 256 * 1024 * 1024
MAX_MEMBERS = 4096


def key(path, digest):
    identity = os.path.normcase(os.path.realpath(path))
    return hashlib.sha256((identity + "\0" + digest).encode("utf-8")).hexdigest()


def safe_name(name):
    portable(name)
    if any(p.startswith(".") for p in name.split("/")):
        raise ValueError("Choose a visible export file or folder name.")
    return name


def folded(s):
    return unicodedata.normalize("NFC", s).casefold()


def identity(st):
    return [str(st.st_dev), str(st.st_ino)]


def regular(st):
    return stat.S_ISREG(st.st_mode) and st.st_nlink == 1 and not reparse(st)


def reparse(st):
    return bool(getattr(st, "st_file_attributes", 0) & 1024) or stat.S_ISLNK(st.st_mode)


def snapshot(root):
    """Record the identity and complete contents, including empty subdirectories."""
    rows = {}
    size = 0

    def visit(path, relative):
        nonlocal size
        st = path.lstat()
        if len(rows) > MAX_MEMBERS * 2 or reparse(st):
            raise ValueError("The export destination contains an unsupported entry.")
        if stat.S_ISDIR(st.st_mode):
            rows[relative] = ["directory", *identity(st)]
            for child in sorted(path.iterdir()):
                safe_name(child.name)
                visit(child, relative + "/" + child.name if relative else child.name)
        elif regular(st) and size + st.st_size <= LIMIT:
            flags = os.O_RDONLY | getattr(os, "O_BINARY", 0) | getattr(os, "O_NOFOLLOW", 0)
            with os.fdopen(os.open(path, flags), "rb") as reader:
                start = os.fstat(reader.fileno())
                if not regular(start) or identity(start) != identity(st):
                    raise ValueError("The export destination changed while reading.")
                content = hashlib.sha256()
                while chunk := reader.read(65536):
                    size += len(chunk)
                    if size > LIMIT:
                        raise ValueError("The export destination exceeds the size limit.")
                    content.update(chunk)
                end = os.fstat(reader.fileno())
                if (end.st_size, end.st_mtime_ns) != (start.st_size, start.st_mtime_ns):
                    raise ValueError("The export destination changed while reading.")
            rows[relative] = ["file", *identity(st), st.st_size, content.hexdigest()]
        else:
            raise ValueError("The export destination contains an unsupported file.")
        if identity(path.lstat()) != identity(st):
            raise ValueError("The export destination changed while reading.")

    visit(root, "")
    return rows


def exchange(left, right):
    """Swap complete sibling trees in one filesystem transaction."""
    if os.name == "nt":
        from ctypes import wintypes as W
        kernel = ctypes.WinDLL("kernel32", use_last_error=True)
        ktm = ctypes.WinDLL("ktmw32", use_last_error=True)
        create = ktm.CreateTransaction
        create.argtypes = [W.LPVOID, W.LPVOID, W.DWORD, W.DWORD, W.DWORD, W.DWORD, W.LPWSTR]
        create.restype = W.HANDLE
        move = kernel.MoveFileTransactedW
        move.argtypes = [W.LPCWSTR, W.LPCWSTR, W.LPVOID, W.LPVOID, W.DWORD, W.HANDLE]
        ktm.CommitTransaction.argtypes = [W.HANDLE]
        ktm.RollbackTransaction.argtypes = [W.HANDLE]
        kernel.CloseHandle.argtypes = [W.HANDLE]
        handle = create(None, None, 0, 0, 0, 0, None)
        if not handle or handle == W.HANDLE(-1).value:
            raise OSError("This Windows volume does not support atomic replacement of a project export.")
        marker = left.parent / (left.name + ".prior")
        try:
            for source, target in ((right, marker), (left, right), (marker, left)):
                if not move(str(source), str(target), None, None, 0, handle):
                    raise ctypes.WinError(ctypes.get_last_error())
            if not ktm.CommitTransaction(handle):
                raise ctypes.WinError(ctypes.get_last_error())
        except BaseException:
            ktm.RollbackTransaction(handle)
            raise
        finally:
            kernel.CloseHandle(handle)
        return
    libc = ctypes.CDLL(None, use_errno=True)
    if sys.platform == "darwin":
        rename, at = libc.renameatx_np, -2
    elif sys.platform.startswith("linux"):
        rename, at = libc.renameat2, -100
    else:
        raise OSError("This platform does not support atomic replacement of a project export.")
    rename.argtypes = (ctypes.c_int, ctypes.c_char_p, ctypes.c_int, ctypes.c_char_p, ctypes.c_uint)
    if rename(at, os.fsencode(left), at, os.fsencode(right), 2):
        code = ctypes.get_errno()
        raise OSError(code, os.strerror(code))


def remove(path):
    if path.is_dir() and not path.is_symlink():
        shutil.rmtree(path)
    elif os.path.lexists(path):
        path.unlink()


def write_export(parent, name, members, sources, *, single=False, receipt=None, before_publish=None, strict=False):
    if "/" in safe_name(name):
        raise ValueError("Choose a single export destination name.")
    parent = Path(parent).resolve(strict=True)
    if not parent.is_dir():
        raise ValueError("Choose a destination directory.")
    paths = [Path(os.path.realpath(source)) for source in sources]
    source_ids = {tuple(identity(p.stat())) for p in paths if p.exists()}
    parent_id = identity(parent.stat())
    if receipt and (receipt.get("parent") != parent_id or receipt.get("path") != str(parent / name)):
        raise ValueError("The export destination changed. Choose a new destination.")
    tmp = Path(tempfile.mkdtemp(prefix=".waffle-export-", dir=parent))
    stage = tmp / "output"
    seen = {}
    seen_files = set()
    size = 0
    try:
        if not single:
            stage.mkdir(mode=0o700)
        for row, (relative, data) in enumerate(members, 1):
            if row > MAX_MEMBERS or not isinstance(data, bytes) or (single and row > 1):
                raise ValueError("Invalid export member set.")
            rel = safe_name(relative)
            pieces = rel.split("/")
            for i in range(1, len(pieces) + 1):
                partial = "/".join(pieces[:i])
                if seen.setdefault(folded(partial), partial) != partial:
                    raise ValueError("Export member names collide.")
            if rel in seen_files:
                raise ValueError("Duplicate export member.")
            seen_files.add(rel)
            size += len(data)
            if size > LIMIT:
                raise ValueError("The export exceeds the size limit.")
            target = stage if single else stage.joinpath(*pieces)
            target.parent.mkdir(parents=True, exist_ok=True)
            with target.open("xb") as out:
                out.write(data)
                out.flush()
                os.fsync(out.fileno())
        if not seen_files:
            raise ValueError("The export is empty.")
        if not single:
            for directory, _, _ in os.walk(stage, topdown=False):
                fsync_dir(directory)
        desired = snapshot(stage)
        with publication_lock(parent):
            if identity(parent.stat()) != parent_id:
                raise ValueError("The selected export directory changed.")
            siblings = {folded(child.name) for child in parent.iterdir()}
            for attempt in range(1, 10002):
                stem, suffix = os.path.splitext(name) if single else (name, "")
                dest = parent / (name if attempt == 1 else f"{stem} ({attempt}){suffix}")
                existing = os.path.lexists(dest)
                if any(p == dest or dest in p.parents for p in paths) or (existing and tuple(identity(dest.lstat())) in source_ids):
                    if strict or receipt or single:
                        raise ValueError("Choose an export destination separate from the original design.")
                    continue
                if receipt:
                    if not existing or snapshot(dest) != receipt["entries"]:
                        raise ValueError("The export destination changed. Choose a new destination.")
                elif existing or folded(dest.name) in siblings:
                    if strict:
                        raise FileExistsError(errno.EEXIST, "The export destination already exists.")
                    continue
                if before_publish:
                    before_publish()
                if receipt:
                    exchange(stage, dest)
                    try:
                        if snapshot(stage) != receipt["entries"]:
                            raise ValueError("The export destination changed during publication.")
                    except (OSError, ValueError):
                        exchange(stage, dest)
                        raise
                else:
                    try:
                        publish(stage, dest)
                    except FileExistsError:
                        if strict:
                            raise
                        continue
                try:
                    fsync_dir(parent)
                except OSError:
                    # Publication reached the namespace but the parent did not acknowledge it.
                    # Restore the prior target while we still own both sibling entries.
                    if receipt:
                        exchange(stage, dest)
                    else:
                        publish(dest, stage)
                    raise
                return {"path": str(dest), "name": dest.name, "parent": parent_id, "entries": desired, "single": single}
        raise ValueError("Choose a new export destination name.")
    finally:
        remove(tmp)


def preference(support, source_key):
    if not isinstance(source_key, str) or not re.fullmatch("[a-f0-9]{64}", source_key):
        raise ValueError("The imported source grant expired.")
    return Path(support) / "import-exports" / (source_key + ".json")


def saved(path):
    try:
        if not regular(path.lstat()) or path.stat().st_size > 4 * 1024 * 1024:
            return None
        receipt = json.loads(path.read_bytes())
        if identity(Path(receipt["path"]).parent.stat()) != receipt["parent"] or snapshot(Path(receipt["path"])) != receipt["entries"]:
            return None
        return receipt
    except (OSError, ValueError, KeyError, TypeError):
        return None


def remember(path, receipt):
    path.parent.mkdir(parents=True, mode=0o700, exist_ok=True)
    if reparse(path.parent.lstat()):
        raise ValueError("The private export preference is unavailable.")
    fd, tmp = tempfile.mkstemp(dir=path.parent)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as out:
            json.dump(receipt, out, ensure_ascii=False, separators=(",", ":"))
            out.flush()
            os.fsync(out.fileno())
        os.replace(tmp, path)
        fsync_dir(path.parent)
    finally:
        if os.path.exists(tmp):
            os.unlink(tmp)


def guard_operation(arg):
    marker = arg.get("guardFile")
    if marker and not Path(marker).is_file():
        raise ValueError("The import Save operation was cancelled.")


def command(op, arg):
    guard_operation(arg)
    prior = arg.get("receipt")
    pref = preference(arg["support"], arg["key"])
    if op == "recallExport":
        return {"receipt": saved(pref)}
    if op == "forgetExport":
        pref.unlink(missing_ok=True)
        return {"saved": True}
    if op == "rememberExport":
        if not prior or snapshot(Path(prior["path"])) != prior["entries"]:
            raise ValueError("The export destination changed. Choose a new destination.")
        remember(pref, prior)
        return {"saved": True}
    if op != "writeExport":
        raise ValueError("Unknown export operation.")
    selected = Path(prior["path"]) if prior else Path(arg["selected"])
    single = arg["single"] is True
    if prior and prior["single"] != single:
        raise ValueError("The export changed from a file to a folder. Choose a new destination.")
    rows = arg["files"]
    if not isinstance(rows, list) or not 1 <= len(rows) <= MAX_MEMBERS:
        raise ValueError("Invalid export member set.")
    if single and (len(rows) != 1 or selected.suffix.casefold() != Path(safe_name(rows[0]["name"])).suffix.casefold()):
        raise ValueError("Use the output file extension supplied by the design writer.")
    members = ((r["name"], base64.b64decode(r["data"], validate=True)) for r in rows)
    was_remembered = prior is not None and saved(pref) == prior
    receipt = write_export(selected.parent, selected.name, members, arg["sources"], single=single, receipt=prior, before_publish=lambda: guard_operation(arg))
    if was_remembered:
        try:
            remember(pref, receipt)
        except (OSError, ValueError):
            return {"receipt": receipt, "preferenceError": "The export was saved. Its private destination preference could not be updated."}
    return {"receipt": receipt}
