"""Recognize a retired project header without opening a design or its companions."""
import json
from pathlib import Path, PurePosixPath
import struct
import zipfile
import re

NOTE = "This file is from a pre-release Waffle build; re-import the design from its source EDA"
CODE = "pre-release-format"
LIMIT = 65536
TOKEN = re.compile(r'"(?:[^"\\]|\\.)*"|[{}\[\]]')
VALUE = re.compile(r'\s*:\s*(?:"([a-zA-Z0-9_.-]{1,48})"|(\[))')


class ObsoleteProject(ValueError):
    code = CODE

    def __init__(self):
        super().__init__(NOTE)


def reject(data, name=""):
    """Mirror AtriumObsoleteProject's bounded top-level signatures at the filesystem boundary."""
    raw = data[:LIMIT]
    encoding = "utf-16" if raw[:2] in (b"\xff\xfe", b"\xfe\xff") else "utf-8-sig"
    text = raw.decode(encoding, "replace").lstrip()
    if re.match(r"^ATRIUM-JOURNAL 1(?:\r?\n|$)", text):
        raise ObsoleteProject()
    if not text.startswith("{"):
        return
    depth, design = 0, False
    keys = {}
    for token in TOKEN.finditer(text):
        char = text[token.start()]
        if char in "{[":
            depth += 1
        elif char in "}]":
            depth -= 1
            if not depth:
                break
        elif depth == 1 and token.end() - token.start() <= 26:
            key = text[token.start() + 1:token.end() - 1]
            if key in ("format", "kind", "formatVersion", "documents", "library", "sheets"):
                value = VALUE.match(text, token.end(), token.end() + 64)
                if value:
                    keys[key] = value.group(1)
                    design |= key in ("documents", "library", "sheets") and bool(value.group(2))
    named = bool(re.search(r"\.(?:waffle|atrium)(?:\.journal|~)?$", str(name), re.I))
    if keys.get("format") in ("atrium", "waffle") or (named and (
            str(keys.get("formatVersion", "")).startswith(("0.", "1.")) if keys.get("kind") == "project"
            else not keys.get("format") and design)):
        raise ObsoleteProject()


def reject_archive(stream):
    """Inspect only project prefixes in an ordinary ZIP. Never extract an entry."""
    stream.seek(0, 2)
    end = stream.tell()
    stream.seek(max(0, end - 65557))
    tail = stream.read()
    offset = tail.rfind(b"PK\x05\x06")
    if offset < 0 or len(tail) - offset < 22:
        return
    _, disk, directory_disk, disk_count, count, size, start, comment = struct.unpack_from("<4s4H2IH", tail, offset)
    if (disk or directory_disk or disk_count != count or count > 10000 or size > 8 << 20 or
            len(tail) - offset != 22 + comment or start + size > end):
        return
    old = False
    try:
        with zipfile.ZipFile(stream) as archive:
            for entry in archive.infolist():
                path = PurePosixPath(entry.filename)
                if (path.suffix.lower() not in (".waffle", ".atrium") or path.is_absolute() or
                        any(piece in (".waffle", "..") for piece in path.parts) or entry.is_dir() or
                        entry.compress_type not in (zipfile.ZIP_STORED, zipfile.ZIP_DEFLATED)):
                    continue
                with archive.open(entry) as file:
                    prefix = file.read(LIMIT)
                try:
                    reject(prefix, entry.filename)
                except ObsoleteProject:
                    old = True
                    continue
                # Mixed archives can offer a valid native project to the desktop chooser.
                try:
                    head = json.loads(prefix.partition(b"\n")[0])
                except (ValueError, RecursionError):
                    continue
                if isinstance(head, dict) and head.get("kind") == "project":
                    return
    except (zipfile.BadZipFile, NotImplementedError, OSError, RuntimeError, EOFError):
        return
    if old:
        raise ObsoleteProject()


def reject_file(stream, name):
    if Path(name).suffix.lower() == ".zip":
        reject_archive(stream)
    else:
        reject(stream.read(LIMIT), name)


def reject_path(path):
    path = Path(path)
    if path.is_file():
        with path.open("rb") as source:
            reject_file(source, path.name)
