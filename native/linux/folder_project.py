"""Root-bound Waffle 2.0 working folders and the WAFFLE-TXN 1 journal."""

import base64
import binascii
from contextlib import contextmanager
import ctypes
import errno
import fcntl
import hashlib
import hmac
import secrets
import json
import os
from pathlib import Path
import re
import stat
import struct
import tempfile
import unicodedata
import uuid


MAGIC = b"WAFFLE-TXN 1\n"
CHUNK = 256 * 1024
HEADER_CAP = 64 * 1024
DESCRIPTOR_CAP = 4 * 1024 * 1024
FILE_CAP = 256 * 1024 * 1024
BATCH_CAP = 2 * FILE_CAP
PLAN_CAP = 8192
READ_COUNT = PLAN_CAP
JOURNAL = ".waffle/journal"
DIR_FLAGS = os.O_RDONLY | os.O_DIRECTORY | os.O_CLOEXEC | os.O_NOFOLLOW
FILE_FLAGS = os.O_RDONLY | os.O_CLOEXEC | os.O_NOFOLLOW | os.O_NONBLOCK
DOC_TYPES = {".wsch", ".wpcb", ".wdraw", ".wpanel"}
COPY_OWNER_SUFFIXES = frozenset((".wsch", ".wpcb", ".wdraw", ".wpanel", ".wlib"))
MEMBER_SUFFIX = {"schematic": ".wsch", "pcb": ".wpcb", "drawing": ".wdraw", "panel": ".wpanel",
                 "library": ".wlib", "block": ".wblock"}
FUTURE_SUFFIX = re.compile(r"\.w[a-z][a-z0-9-]{0,30}\Z")
FUTURE_MINOR = re.compile(r"2\.([1-9][0-9]{0,3})\Z")
KNOWN_SUFFIX = {".waffle", *MEMBER_SUFFIX.values()}
ADDITIVE_SCALARS = frozenset("""
order text name label ref value x y z w h width height size length radius diameter thickness
rotation angle sweep layer hidden locked
""".split())
ADDITIVE_COORDINATES = frozenset(("at", "start", "end", "points"))
ADDITIVE_ITEMS = frozenset("""
part wire track graphic label netlabel junction via pad polygon power port offsheet sheetsymbol
bus busentry noerc textframe image frame richtext math calculation widget imageMarkup notesLayer
sticky callout reviewItem inkStroke
""".split())
ADDITIVE_DOCUMENT = ADDITIVE_ITEMS | frozenset("""
documentSettings panelCell drawingView drawingDimension boardBody modelAlias layer copperRegion
""".split())
ADDITIVE_LIBRARY = frozenset("librarySettings pin pad shape boardBody modelAlias".split())
ADDITIVE_BLOCK = ADDITIVE_ITEMS | {"blockSettings", "blockLibrary"}
HEX = re.compile(r"[0-9a-f]{64}\Z")
UUID = re.compile(r"[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}\Z")
DEVICE = re.compile(r"(?i)(?:con|prn|aux|nul|clock\$|conin\$|conout\$|com[1-9¹²³]|lpt[1-9¹²³])\Z")
MODEL = re.compile(r"[0-9a-f]{64}\.[a-z0-9]{1,16}\.gz\Z")
UNSAFE_NAME = set('<>:"\\|?*')
CHANGED = "The working folder changed on disk."


class FolderError(ValueError):
    def __init__(self, message, state="recoveryPending", paths=()):
        super().__init__(message)
        self.state = state
        self.paths = tuple(paths)


def digest(value):
    return isinstance(value, str) and HEX.fullmatch(value) is not None


def folded(value):
    return unicodedata.normalize("NFC", value.casefold())


def relative(value):
    """Return the components of a portable NFC relative path."""
    if not isinstance(value, str) or unicodedata.normalize("NFC", value) != value:
        raise FolderError("The project member path is not NFC UTF-8.")
    try:
        if not 0 < len(value.encode("utf-8")) <= 4096:
            raise FolderError("The project member path has an invalid length.")
    except UnicodeEncodeError:
        raise FolderError("The project member path is not UTF-8.") from None
    parts = value.split("/")
    if len(parts) > 64:
        raise FolderError("The project member path is too deep.")
    for index, name in enumerate(parts):
        if (name in ("", ".", "..") or name.endswith((".", " ")) or DEVICE.fullmatch(name.split(".", 1)[0])
                or any(c in UNSAFE_NAME or ord(c) < 32 or ord(c) == 127 for c in name)
                or len(name.encode("utf-8")) > 255):
            raise FolderError("The project member path is unsafe.")
        if index < len(parts) - 1 and name.lower().endswith((".wsch", ".wpcb", ".wdraw", ".wpanel", ".wlib")):
            raise FolderError("A native document path cannot be used as a directory.", paths=[value])
    return parts


def member_path(value, manifest):
    """Limit renderer access to native members, including content-addressed assets."""
    parts = relative(value)
    if value == manifest:
        return parts
    if value == ".waffle/.gitignore":
        return parts
    if (parts[:2] == [".waffle", "imports"] and len(parts) >= 4 and digest(parts[2])
            and all(not p.startswith(".") for p in parts[3:])):
        return parts
    first = parts[0]
    extension = Path(parts[-1]).suffix
    if first == "assets" and len(parts) == 2 and digest(parts[1]):
        return parts
    if first == "models" and len(parts) == 2 and MODEL.fullmatch(parts[1]):
        return parts
    if first == "libraries" and len(parts) >= 2 and extension in {".wlib", ".wblock"} and all(not p.startswith(".") for p in parts):
        return parts
    if first not in {"libraries", "assets", "models"} and extension in DOC_TYPES and all(not p.startswith(".") for p in parts):
        return parts
    raise FolderError("The path is outside the authorised project members: " + value, paths=[value])


def future_minor(version):
    match = FUTURE_MINOR.fullmatch(version) if isinstance(version, str) else None
    return int(match[1]) if match else 0


def future_document_path(path, kind):
    if not isinstance(kind, str) or not kind or kind in {*MEMBER_SUFFIX, "project", "snapshot", "import-index"}:
        return False
    parts = relative(path)
    extension = Path(parts[-1]).suffix
    return (folded(parts[0]) not in {"libraries", "assets", "models"} and all(not p.startswith(".") for p in parts)
            and extension not in KNOWN_SUFFIX and bool(FUTURE_SUFFIX.fullmatch(extension)))


def project_id(value):
    if isinstance(value, str) and value:
        try:
            if len(value.encode("utf-8")) <= 1024:
                return value
        except UnicodeEncodeError:
            pass
    raise FolderError("The project identifier is invalid.")


def unique_object(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            raise FolderError("A save record has a duplicate key.")
        result[key] = value
    return result


def canonical_json(value):
    # json.dumps already emits escaped controls without short names for most code points.
    # Rewrite only the actual JSON escapes, preserving a literal backslash in a string.
    short = {"b": 8, "t": 9, "n": 10, "f": 12, "r": 13}
    def escaped(match):
        text = match.group()
        if text == "\\\\":
            return text
        return "\\u%04x" % (short[text[1]] if len(text) == 2 else ord(text))
    text = json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"), allow_nan=False)
    return (re.sub(r"\\\\|\\[btnfr]|[\u2028\u2029]", escaped, text) + "\n").encode("utf-8")


def invalid_number(_value):
    raise FolderError("The newer project row has an invalid number.")


ADDITIVE_JSON = json.JSONDecoder(object_pairs_hook=unique_object, parse_constant=invalid_number)
# Native envelope policy only consumes strings, lists and objects. Leave any
# otherwise valid opaque numeric token to the original bytes.
HEADER_JSON = json.JSONDecoder(object_pairs_hook=unique_object, parse_constant=invalid_number,
                               parse_int=lambda _: None, parse_float=lambda _: None)


def additive_record(line):
    try:
        row = ADDITIVE_JSON.decode(line.decode("utf-8"))
    except (ValueError, RecursionError) as error:
        raise FolderError("The newer project row could not be verified.") from error
    if not isinstance(row, dict) or not isinstance(row.get("kind"), str) or not row["kind"]:
        raise FolderError("The newer project row has no record kind.")
    project_id(row.get("id"))
    return row


def raw_lines(data):
    begin = 0
    while begin < len(data):
        end = data.find(b"\n", begin)
        if end < 0:
            raise FolderError("The newer project member lacks its final line ending.")
        yield data[begin:end + 1]
        begin = end + 1


OPTIONAL_PROJECT_FIELDS = {
    "savedQuery": "name query languageVersion source bindings scope columns documentId instanceId span target docId itemId signalId entityId pinId definitionId parameterId projectId field kind detached needsRebind",
    "link": "source target objectId documentId kind projectId fragment label",
    "linkAnchor": "kind documentId ownerId terminal terminalId",
    "savedView": "name documentId camera center scale referenceScale flipped rotationRadians viewport pixelWidth pixelHeight selection layers hidden active mode filter scope savedQueryId mask highlight netHighlight languageVersion source bindings span target docId itemId instanceId signalId entityId pinId definitionId parameterId projectId field kind detached needsRebind $number",
    "slide": "name aspect notes source kind documentId frameId savedViewId",
    "datasheetRef": "sha256 byteLength title version sourceURL pageCount asset mediaType",
    "datasheetAnnotation": "datasheetId page region type text points",
}
BASELINE_PROJECT_KINDS = frozenset("document library layoutBlock importIndex release projectSetting rule signal tag variant bomView outputJob reviewThread reviewReply".split())
PROJECT_RECORD_ID = re.compile(r"[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\Z")


def optional_project(base, desired, identity, manifest):
    """Prove that the only changed physical rows are recognized optional metadata."""
    refuse = "This change requires a compatible Waffle project writer."

    def parts(raw):
        lines = iter(raw_lines(raw))
        first = next(lines, b"")
        header = additive_record(first)
        if header["id"] != identity or header["kind"] != "project":
            raise FolderError(refuse, paths=[manifest])
        require_writable_header(header, manifest)
        rows, last = {}, ""
        for line in lines:
            row = additive_record(line)
            if row["id"] <= last or row["id"] == identity:
                raise FolderError(refuse, paths=[manifest])
            last = row["id"]
            rows[last] = (row, line)
        return header, first, rows

    def known(row):
        key_string = OPTIONAL_PROJECT_FIELDS.get(row["kind"])
        if key_string is None:
            return False
        keys = set(("id " + key_string).split())
        value = row.get("value")
        def supported(node):
            if isinstance(node, dict):
                return all(k in keys and supported(v) for k, v in node.items())
            return not isinstance(node, list) or all(map(supported, node))
        if (not PROJECT_RECORD_ID.fullmatch(row["id"]) or not set(row) <= {"kind", "id", "order", "value"}
                or not isinstance(value, dict) or value.get("id", row["id"]) != row["id"] or not supported(value)):
            raise FolderError(refuse, paths=[manifest])
        return True

    next_header, next_line, next_rows = parts(desired)
    if next_header["formatVersion"] != "2.1":
        raise FolderError(refuse, paths=[manifest])
    if base == desired:
        return  # A recovered transaction may already have installed the manifest.
    previous = {}
    if base is not None:
        old_header, old_line, previous = parts(base)
        if old_header["formatVersion"] not in ("2.0", "2.1"):
            raise FolderError(refuse, paths=[manifest])
        if old_line != next_line:
            old, new = additive_fields(old_line), additive_fields(next_line)
            old.pop("formatVersion", None)
            new.pop("formatVersion", None)
            if old_header["formatVersion"] != "2.0" or old != new:
                raise FolderError(refuse, paths=[manifest])
    changed = False
    for identity in previous.keys() | next_rows.keys():
        left, right = previous.get(identity), next_rows.get(identity)
        if left is not None and right is not None and left[1] == right[1]:
            continue
        if base is None and right[0]["kind"] in BASELINE_PROJECT_KINDS:
            continue
        if (left is not None and not known(left[0]) or right is not None and not known(right[0])
                or left is not None and right is not None and left[0]["kind"] != right[0]["kind"]):
            raise FolderError(refuse, paths=[manifest])
        changed = True
    if not changed:
        raise FolderError(refuse, paths=[manifest])


def additive_fields(line):
    """Identify each original value, including its escapes and exact whitespace."""
    encoded = line.decode("utf-8").removesuffix("\n").removesuffix("\r")
    if not encoded.startswith("{") or not encoded.endswith("}"):
        raise FolderError("The newer project record is invalid.")
    end = len(encoded) - 1
    fields, at = {}, 1
    while at < end:
        if encoded[at] != '"':
            raise FolderError("The newer project record is invalid.")
        key, colon = ADDITIVE_JSON.raw_decode(encoded, at)
        if key in fields or encoded[colon:colon + 1] != ":":
            raise FolderError("The newer project record is invalid.")
        start = value = colon + 1
        while value < end and encoded[value] in " \t\r":
            value += 1
        _, next_field = ADDITIVE_JSON.raw_decode(encoded, value)
        while next_field < end and encoded[next_field] in " \t\r":
            next_field += 1
        fields[key] = encoded[start:next_field]
        if next_field == end:
            break
        if encoded[next_field:next_field + 1] != ",":
            raise FolderError("The newer project record is invalid.")
        at = next_field + 1
    return fields


def additive_integer(value):
    return (type(value) is int or type(value) is float and value.is_integer()) and abs(value) <= (1 << 53) - 1


def additive_vector(value):
    return isinstance(value, list) and 2 <= len(value) <= 3 and all(additive_integer(axis) for axis in value)


def additive_field_mutable(key, value):
    if key in ADDITIVE_SCALARS:
        return type(value) in (str, bool, type(None)) or additive_integer(value)
    return (key in ADDITIVE_COORDINATES and isinstance(value, list)
            and (additive_vector(value) or all(additive_vector(point) for point in value)))


def additive_rows(lines, owner):
    previous = None
    for line in lines:
        row = additive_record(line)
        identity = row["id"]
        if identity == owner or previous is not None and identity <= previous:
            raise FolderError("Keep unique, sorted record identifiers in the newer owner.")
        previous = identity
        yield identity, line, row


def additive_row(before, after, kinds):
    _, old_line, old = before or (None, b"{}", {})
    _, new_line, new = after or (None, b"{}", {})
    if old_line == new_line:
        return
    kind = (old or new)["kind"]
    if kind not in kinds or new.get("kind", kind) != kind:
        raise FolderError("Keep unknown records and types unchanged in a newer project owner.")
    old_fields, new_fields = additive_fields(old_line), additive_fields(new_line)
    for field in (set(old_fields) | set(new_fields)) - {"kind", "id"}:
        if field in old_fields and old_fields[field] == new_fields.get(field):
            continue
        if any(not additive_field_mutable(field, row[field]) for row in (old, new) if field in row):
            raise FolderError("The edit would change a field that needs a newer version.")


def additive_owner(before, after, member, ceiling):
    previous, desired = raw_lines(before), raw_lines(after)
    header, next_header = next(previous, b""), next(desired, b"")
    if header != next_header:
        raise FolderError("Keep the newer project's owner header unchanged.")
    row = additive_record(header)
    version = row.get("formatVersion")
    minor = future_minor(version)
    if ((row["id"], row["kind"]) != member or row.get("requires", []) != []
            or version != "2.0" and not 0 < minor <= ceiling):
        raise FolderError("The owner needs a compatible version before it can be saved.")
    kind = row["kind"]
    kinds = ADDITIVE_LIBRARY if kind == "library" else ADDITIVE_BLOCK if kind == "block" else ADDITIVE_DOCUMENT
    before_rows, after_rows = additive_rows(previous, row["id"]), additive_rows(desired, row["id"])
    old, new = next(before_rows, None), next(after_rows, None)
    while old is not None or new is not None:
        if new is None or old is not None and old[0] < new[0]:
            additive_row(old, None, kinds)
            old = next(before_rows, None)
        elif old is None or new[0] < old[0]:
            additive_row(None, new, kinds)
            new = next(after_rows, None)
        else:
            additive_row(old, new, kinds)
            old, new = next(before_rows, None), next(after_rows, None)


def complete_payload(entry, limit):
    if isinstance(entry.get("text"), str):
        data = entry["text"].encode("utf-8")
    elif isinstance(entry.get("data"), str) and len(entry["data"]) <= 4 * (limit // 3 + 1):
        try:
            data = base64.b64decode(entry["data"], validate=True)
        except binascii.Error as error:
            raise FolderError("The save payload is invalid.") from error
    else:
        raise FolderError("The save payload is invalid.")
    if len(data) > limit:
        raise FolderError("The save plan exceeds its content size limit.")
    return data


def pack_descriptor(value):
    payload = canonical_json(value)
    return MAGIC + hashlib.sha256(payload).hexdigest().encode("ascii") + b"\n" + payload


def check_order(entries, manifest):
    def deleting(entry):
        return entry["desired"] is None if "desired" in entry else entry.get("remove") is True

    seen = {}
    owner = False
    for index, entry in enumerate(entries):
        path = entry["path"]
        if path == manifest and index != len(entries) - 1:
            raise FolderError("Install the manifest after its member files.")
        if owner and path.startswith("assets/") and not deleting(entry):
            raise FolderError("Install the new attachment before its owner.")
        if Path(path).suffix in MEMBER_SUFFIX.values():
            owner = True
        key = folded(path)
        earlier = seen.get(key)
        if earlier is not None:
            # A case-only rename removes the old spelling before creating the new one.
            if (earlier["path"] == path or not deleting(earlier)
                    or entry["expected"] is not None or deleting(entry)):
                raise FolderError("Project targets collide: " + path, "conflict", [path])
        seen[key] = entry
    for key, entry in seen.items():
        end = key.find("/")
        while end != -1:
            if key[:end] in seen:
                raise FolderError("A save target also names a directory.", paths=[seen[key[:end]]["path"], entry["path"]])
            end = key.find("/", end + 1)


def unpack_descriptor(raw, manifest):
    try:
        if not raw.startswith(MAGIC):
            raise FolderError("The save journal requires a compatible version.")
        checksum, payload = raw[len(MAGIC):].split(b"\n", 1)
        if hashlib.sha256(payload).hexdigest().encode("ascii") != checksum:
            raise FolderError("The save journal checksum does not match.")
        item = json.loads(payload.decode("utf-8"), object_pairs_hook=unique_object)
        if (not isinstance(item, dict) or set(item) != {"projectId", "transaction", "plan"}
                or pack_descriptor(item) != raw or not isinstance(item["transaction"], str)
                or not UUID.fullmatch(item["transaction"]) or not isinstance(item["plan"], list)
                or not 1 <= len(item["plan"]) <= PLAN_CAP):
            raise FolderError("The save journal descriptor is invalid.")
        project_id(item["projectId"])
        staged_bytes = 0
        for entry in item["plan"]:
            if not isinstance(entry, dict) or set(entry) != {"path", "expected", "desired"}:
                raise FolderError("The save journal entry is invalid.")
            member_path(entry["path"], manifest)
            if entry["expected"] is not None and not digest(entry["expected"]):
                raise FolderError("The save journal base is invalid.")
            wished = entry["desired"]
            if wished is not None and (not isinstance(wished, dict) or set(wished) != {"sha256", "length"}
                                       or not digest(wished["sha256"]) or type(wished["length"]) is not int
                                       or not 0 <= wished["length"] <= FILE_CAP):
                raise FolderError("The save journal payload identity is invalid.")
            if wished is None and entry["expected"] is None:
                raise FolderError("A deletion requires an expected file.")
            if entry["path"].startswith("assets/") and wished is not None and entry["path"][7:] != wished["sha256"]:
                raise FolderError("The asset name differs from the staged bytes.")
            if wished is not None:
                staged_bytes += wished["length"]
        if staged_bytes > BATCH_CAP:
            raise FolderError("The save journal exceeds its total payload limit.")
        check_order(item["plan"], manifest)
        return item
    except (UnicodeError, TypeError, RecursionError, json.JSONDecodeError) as error:
        raise FolderError("The save journal descriptor is invalid.") from error


def format_header(line):
    """Inspect the bounded first line without opening any referenced member."""
    data, newline, _ = line.partition(b"\n")
    if not newline or len(data) >= HEADER_CAP:
        return None
    try:
        header = HEADER_JSON.decode(data.decode("utf-8"))
    except (ValueError, RecursionError):
        return None
    if isinstance(header, dict) and header.get("kind") == "project":
        version = header.get("formatVersion")
        if isinstance(version, str) and re.fullmatch(r"(?:[2-9]|[1-9][0-9]+)\.[0-9]+", version):
            project_id(header.get("id"))
            return header
    return None


TABLE_FEATURE = "notebook.table.v1"


def table_profile(header):
    return (header.get("formatVersion") == "2.1" and "compatibleWith" not in header
            and header.get("kind") in ("project", "schematic") and header.get("requires") == [TABLE_FEATURE]
            and ("tableBaseVersion" not in header or header.get("kind")=="project" and header["tableBaseVersion"]=="2.1")
            and header.get("readerRequires", {TABLE_FEATURE: "2.1"}) == {TABLE_FEATURE: "2.1"})


def regular_version(header):
    return header.get("formatVersion") == "2.0" or table_profile(header)


def has_optional_rows(raw):
    return any(additive_record(line)["kind"] in OPTIONAL_PROJECT_FIELDS for line in list(raw_lines(raw))[1:])


def project_write(base, desired, identity, manifest):
    """Verify a 2.1 table transition without replacing any unrelated physical row."""
    refuse = FolderError("This change requires a compatible Waffle project writer.", paths=[manifest])
    before = format_header(base) if base is not None else None
    after = format_header(desired)
    if after is None or after["id"] != identity or after["formatVersion"] not in ("2.0", "2.1"):
        raise refuse
    require_writable_header(after, manifest)
    old_table = before is not None and table_profile(before)
    new_table = table_profile(after)
    if not old_table and not new_table:
        if after["formatVersion"] == "2.1":
            optional_project(base, desired, identity, manifest)
        elif before is not None and before["formatVersion"] != "2.0":
            raise refuse
        return
    if old_table and new_table:
        if before.get("tableBaseVersion") != after.get("tableBaseVersion"):
            raise refuse
        return
    if before is None or before["formatVersion"] == "2.0":
        if not new_table or "tableBaseVersion" in after:
            raise refuse
        return
    if after["formatVersion"] == "2.0":
        if not old_table or "tableBaseVersion" in before or has_optional_rows(base):
            raise refuse
        return
    if before["formatVersion"] != "2.1" or before["id"] != identity:
        raise refuse
    require_writable_header(before, manifest)
    table, plain = (after, before) if new_table else (before, after)
    if (plain.get("requires", []) or "compatibleWith" in plain
            or table.get("tableBaseVersion") != "2.1" and (new_table or not has_optional_rows(base))):
        raise refuse
    old_lines, next_lines = list(raw_lines(base)), list(raw_lines(desired))
    x, y = additive_fields(old_lines[0]), additive_fields(next_lines[0])
    for key in ("tableBaseVersion","requires","readerRequires"):
        x.pop(key,None)
        y.pop(key,None)
    if x != y or len(old_lines) != len(next_lines):
        raise refuse
    changed = False
    for old, new in zip(old_lines[1:], next_lines[1:]):
        if old == new:
            continue
        plain_row, table_row = (old,new) if new_table else (new,old)
        p, t = additive_record(plain_row), additive_record(table_row)
        if (p["kind"] != "document" or t["kind"] != "document" or p["id"] != t["id"]
                or p.get("docKind") != "schematic" or p.get("requires",[]) or t.get("requires") != [TABLE_FEATURE]):
            raise refuse
        x, y = additive_fields(plain_row), additive_fields(table_row)
        x.pop("requires",None)
        y.pop("requires",None)
        if x != y:
            raise refuse
        changed = True
    if not changed:
        raise refuse


def require_writable_header(header, path, *, exact_native_copy=False):
    flags = header.get("requires", [])
    if (not isinstance(flags, list) or any(not isinstance(flag, str) or not flag for flag in flags)
            or len(set(flags)) != len(flags)):
        raise FolderError("Invalid required feature list.", paths=[path])
    minima = header.get("readerRequires", {})
    if not isinstance(minima, dict) or any(
            token not in flags or not isinstance(version, str) or not re.fullmatch(r"(?:0|[1-9]\d{0,3})\.(?:0|[1-9]\d{0,3})", version, re.ASCII)
            for token, version in minima.items()):
        raise FolderError("Invalid required reader versions.", paths=[path])
    if "tableBaseVersion" in header and not table_profile(header):
        raise FolderError("Invalid preserved native table base.", paths=[path])
    if exact_native_copy:
        flags = [flag for flag in flags if flag == "continuation-parts-v1"]
    elif table_profile(header):
        return
    if flags:
        token = flags[0]
        version = header.get("formatVersion")
        if not isinstance(version, str):
            raise FolderError("Invalid native format version.", paths=[path])
        explanation = (f"A reader supporting native format {minima[token]} is required." if token in minima
                       else f"The file declares native format {version}.")
        raise FolderError(f"Unsupported required feature {token}. {explanation}", paths=[path])


def is_manifest(path):
    """Check the selected manifest header without reading any project companion."""
    path = Path(path)
    if path.suffix.lower() != ".waffle":
        return False
    fd = os.open(path.resolve(), FILE_FLAGS)
    try:
        if not stat.S_ISREG(os.fstat(fd).st_mode):
            return False
        return format_header(os.read(fd, HEADER_CAP + 1)) is not None
    finally:
        os.close(fd)


def inode(info):
    return info.st_dev, info.st_ino


def stamp(info):
    return inode(info), info.st_size, info.st_mtime_ns, info.st_ctime_ns, info.st_nlink


def open_root(path):
    """Open an absolute directory without accepting a link at any component."""
    if not path.is_absolute() or ".." in path.parts:
        raise FolderError("Choose an absolute project folder.")
    fd = os.open("/", DIR_FLAGS)
    try:
        for name in path.parts[1:]:
            child = os.open(name, DIR_FLAGS, dir_fd=fd)
            os.close(fd)
            fd = child
        return fd
    except OSError:
        os.close(fd)
        raise


def require_local_volume(fd):
    if os.uname().sysname != "Linux":
        return  # Only the Linux backend is packaged with this module.
    fs = (ctypes.c_long * 32)()
    libc = ctypes.CDLL(None, use_errno=True)
    if libc.fstatfs(fd, ctypes.byref(fs)) != 0:
        error = ctypes.get_errno()
        raise OSError(error, os.strerror(error))
    family = fs[0] & 0xffffffff
    unreliable = {0x6969, 0x517b, 0xFF534D42, 0xFE534D42, 0x01021997, 0x65735546}
    if family in unreliable:  # NFS, SMB/CIFS, 9p and other host-mounted user-space volumes.
        raise FolderError("The volume cannot guarantee local project durability. Choose a local folder.")


def suggested_name(name):
    if not isinstance(name, str) or not name.strip():
        name = "Untitled"
    if name.lower().endswith(".waffle"):
        name = name[:-7]
    name = unicodedata.normalize("NFC", name.strip())
    name = "".join("-" if c in UNSAFE_NAME or c == "/" or ord(c) < 32 or ord(c) == 127 else c for c in name)
    name = name.rstrip(". ")
    if not name or name.startswith(".") or DEVICE.fullmatch(name.split(".", 1)[0]):
        name = "Untitled"
    while len(name.encode("utf-8")) > 200:
        name = name[:-1]
    return name


def create_selected(path):
    """Create the exact new folder named by the user in the native Save dialog."""
    path = Path(path)
    name = path.name
    relative(name)
    relative(name + ".waffle")
    if name.startswith(".") or Path(name).name != name:
        raise FolderError("Choose a portable project folder name.")
    parent = path.parent
    fd = open_root(parent)
    try:
        require_local_volume(fd)
        with os.scandir(fd) as entries:
            if any(folded(e.name) == folded(name) for e in entries):
                raise FolderError("A file or folder already uses this name. Choose a new project folder name.")
        os.mkdir(name, 0o755, dir_fd=fd)
        os.fsync(fd)
        return RootFolder(path, name + ".waffle", create=True)
    finally:
        os.close(fd)


def read_stream(fd, limit, collect=False):
    sha = hashlib.sha256()
    count = 0
    data = bytearray() if collect else None
    while True:
        chunk = os.read(fd, min(CHUNK, limit - count + 1))
        if not chunk:
            break
        count += len(chunk)
        if count > limit:
            raise FolderError("The project member exceeds its size limit.")
        sha.update(chunk)
        if collect:
            data.extend(chunk)
    return sha.hexdigest(), count, data


def write_all(fd, data):
    rest = memoryview(data)
    while rest:
        size = os.write(fd, rest)
        if size <= 0:
            raise OSError("A journal write made no progress.")
        rest = rest[size:]


def rename_new(src_fd, src, dst_fd, dst):
    """Linux atomic creation without replacing an occupied name."""
    lib = ctypes.CDLL(None, use_errno=True)
    call = getattr(lib, "renameat2", None)
    if call is None:
        raise FolderError("This volume cannot install files exclusively. Choose a local folder.")
    call.argtypes = [ctypes.c_int, ctypes.c_char_p, ctypes.c_int, ctypes.c_char_p, ctypes.c_uint]
    call.restype = ctypes.c_int
    if call(src_fd, os.fsencode(src), dst_fd, os.fsencode(dst), 1) != 0:  # RENAME_NOREPLACE
        error = ctypes.get_errno()
        if error in (errno.ENOSYS, errno.EINVAL, errno.EOPNOTSUPP, errno.EXDEV):
            raise FolderError("This volume cannot install files exclusively. Choose a local folder.")
        raise OSError(error, os.strerror(error), dst)


def is_pdf(prefix):
    return prefix.startswith((b"%PDF-", b"\xef\xbb\xbf%PDF-"))


def asset_media(prefix):
    if prefix.startswith(b"\x89PNG\r\n\x1a\n"):
        return "image/png"
    if prefix.startswith(b"\xff\xd8\xff"):
        return "image/jpeg"
    if prefix[:4] == b"RIFF" and prefix[8:12] == b"WEBP":
        return "image/webp"
    if is_pdf(prefix):
        return "application/pdf"
    if prefix[4:8] == b"ftyp" and prefix[8:12] in (b"heic", b"heix", b"hevc", b"mif1"):
        return "image/heic"
    if re.match(br"(?:\xef\xbb\xbf)?\s*(?:<\?xml[^>]*\?>\s*)?<svg(?:\s|>)", prefix):
        return "image/svg+xml"
    return None


def owner_has_asset(fd, owner, sha, size, media):
    """Match a reference against the canonical, pinned owner stream."""
    with os.fdopen(os.dup(fd), "rb") as source:
        source.seek(0)
        header = json.loads(source.readline(HEADER_CAP))
        if not isinstance(header, dict) or header.get("id") != owner:
            return False
        if header.get("kind") == "project":
            return media == "application/pdf" and manifest_has_pdf(source, sha, size)
        if header.get("kind") != "schematic":
            return False
        needle = sha.encode("ascii")

        def matches(item):
            if isinstance(item, dict):
                if item.get("sha256") == sha and item.get("byteLength") == size and item.get("mediaType") == media:
                    return True
                values = item.values()
            elif isinstance(item, list):
                values = item
            else:
                return False
            return any(matches(entry) for entry in values)

        return any(needle in line and matches(json.loads(line)) for line in source)


def manifest_has_pdf(lines, sha, size):
    needle = sha.encode("ascii")
    ref = {"sha256": sha, "byteLength": size, "mediaType": "application/pdf"}
    for line in lines:
        if needle not in line:
            continue
        row = json.loads(line)
        value = row.get("value") if isinstance(row, dict) and row.get("kind") == "datasheetRef" else None
        if isinstance(value, dict) and value.get("sha256") == sha and value.get("byteLength") == size and value.get("asset") == ref:
            return True
    return False


class RootFolder:
    """One selected root with its manifest, shared leases and a recoverable writer."""

    journal = JOURNAL

    def __init__(self, directory, manifest, *, create=False, checkpoint=None):
        self.directory = Path(directory)
        if len(relative(manifest)) != 1 or manifest.startswith(".") or not self._valid_bound_name(manifest):
            raise FolderError("Choose a .waffle manifest in its project folder.")
        self.manifest = manifest
        self.checkpoint = checkpoint or (lambda _name: None)
        self.fd = open_root(self.directory)
        self.root_id = inode(os.fstat(self.fd))
        self.create = create
        self.leases = {}
        self.asset_leases = {}
        self.staged = {}
        self.members = {manifest}
        self.membership_cache = None
        self.manifest_version = None
        self.project_identity = None
        self.installed = {}
        self.state = "settled"
        self.paths = ()
        self.error = None

    def _valid_bound_name(self, name):
        return name.endswith(".waffle")

    @classmethod
    def selected(cls, path):
        """Find the one authored manifest or the committed creation of it."""
        path = Path(path)
        if not path.is_dir():
            return cls(path.parent, path.name)
        probe = cls(path, "Project.waffle")
        try:
            names = [name for name in os.listdir(probe.fd) if not name.startswith(".") and name.endswith(".waffle")]
            if len(names) > 64:
                raise FolderError("Choose the project's .waffle manifest directly.")
            candidates = []
            for name in names:
                if probe.header(name) is not None:
                    candidates.append(name)
            if len(candidates) == 1:
                return cls(path, candidates[0])
            if not candidates:
                raw = probe._active()
                if raw is not None:
                    try:
                        proposed = json.loads(raw.split(b"\n", 2)[2])
                        final = proposed["plan"][-1]["path"]
                        if (len(relative(final)) == 1 and not final.startswith(".") and final.endswith(".waffle")
                                and unpack_descriptor(raw, final)):
                            return cls(path, final)
                    except (ValueError, TypeError, KeyError, IndexError, RecursionError):
                        raise FolderError("A committed project creation has an unreadable journal.") from None
            raise FolderError("Choose a folder containing exactly one .waffle manifest.")
        finally:
            probe.close()

    def close(self):
        for token in list(self.leases):
            self.release(token)
        for token in list(self.staged):
            self.drop_asset(token)
        if self.fd is not None:
            os.close(self.fd)
            self.fd = None

    def _root_current(self):
        if self.fd is None:
            raise FolderError("The selected project folder is closed.")
        with self._closing(open_root(self.directory)) as current:
            if inode(os.fstat(current)) != self.root_id:
                raise FolderError(CHANGED)

    @staticmethod
    @contextmanager
    def _closing(fd):
        try:
            yield fd
        finally:
            os.close(fd)

    def _check_chain(self, chain):
        self._root_current()
        for index in range(1, len(chain)):
            parent, _ = chain[index - 1]
            child, name = chain[index]
            data = os.stat(name, dir_fd=parent, follow_symlinks=False)
            if not stat.S_ISDIR(data.st_mode) or inode(data) != inode(os.fstat(child)):
                raise FolderError(CHANGED)

    @contextmanager
    def directory_at(self, parts, *, create=False, private=False):
        """Keep every directory open and provide an identity recheck before mutation."""
        self._root_current()
        chain = [(self.fd, None)]
        try:
            for name in parts:
                prev, _ = chain[-1]
                try:
                    child = os.open(name, DIR_FLAGS, dir_fd=prev)
                except FileNotFoundError:
                    self._check_alias(prev, name, "/".join(parts))
                    if not create:
                        raise
                    self._check_chain(chain)
                    try:
                        os.mkdir(name, 0o700 if private else 0o755, dir_fd=prev)
                    except FileExistsError:
                        pass
                    os.fsync(prev)
                    child = os.open(name, DIR_FLAGS, dir_fd=prev)
                chain.append((child, name))
                if os.fstat(child).st_dev != self.root_id[0]:
                    raise FolderError("Project members must stay on the selected project volume.")
            self._check_chain(chain)
            yield chain[-1][0], lambda: self._check_chain(chain)
        finally:
            for child, _ in reversed(chain[1:]):
                os.close(child)

    @staticmethod
    def _entry(parent, name):
        return os.stat(name, dir_fd=parent, follow_symlinks=False)

    @staticmethod
    def _regular(info):
        if not stat.S_ISREG(info.st_mode) or info.st_nlink != 1:
            raise FolderError("A project member is a link or is not a regular file.")

    @staticmethod
    def _exact(parent, name):
        # A lookup on a case-insensitive volume can find the other spelling of a rename.
        # Treat that as absent for replay only when the actual directory entry is different.
        with os.scandir(parent) as entries:
            return any(item.name == name for item in entries)

    @contextmanager
    def _file(self, parent, name):
        fd = os.open(name, FILE_FLAGS, dir_fd=parent)
        with self._closing(fd):
            info = os.fstat(fd)
            self._regular(info)
            if stamp(self._entry(parent, name)) != stamp(info):
                raise FolderError(CHANGED)
            yield fd, info

    def _check_file(self, parent, name, fd, info):
        if stamp(os.fstat(fd)) != stamp(info) or stamp(self._entry(parent, name)) != stamp(info):
            raise FolderError(CHANGED)

    def _read(self, path, limit, *, collect=False, exact=False):
        parts = relative(path)
        with self.directory_at(parts[:-1]) as (directory, verify):
            name = parts[-1]
            if exact and not self._exact(directory, name):
                raise FileNotFoundError(path)
            with self._file(directory, name) as (fd, info):
                if info.st_size > limit:
                    raise FolderError("The project member exceeds its size limit: " + path)
                sha, length, data = read_stream(fd, limit, collect)
                self._check_file(directory, name, fd, info)
                verify()
                return sha, length, data, stamp(info)

    def header(self, path=None):
        parts = relative(path or self.manifest)
        with self.directory_at(parts[:-1]) as (directory, verify):
            name = parts[-1]
            with self._file(directory, name) as (fd, info):
                value = format_header(os.read(fd, HEADER_CAP + 1))
                self._check_file(directory, name, fd, info)
                verify()
                if path is None:
                    has_tables = bool(value and table_profile(value))
                    self.manifest_version = stamp(info), future_minor(value.get("formatVersion")) if value and not has_tables else 0, has_tables
                return value

    @staticmethod
    def _flock(fd, exclusive):
        try:
            fcntl.flock(fd, (fcntl.LOCK_EX if exclusive else fcntl.LOCK_SH) | fcntl.LOCK_NB)
        except BlockingIOError:
            raise FolderError("The project is busy or recovery is pending.") from None

    def _journal_lock(self, exclusive, *, create=False):
        with self.directory_at(relative(self.journal), create=create, private=True) as (journal, verify):
            info = os.fstat(journal)
            if info.st_uid != os.geteuid() or info.st_mode & 0o077:
                raise FolderError("The project journal directory must be private.")
            if create:
                try:
                    with self._closing(self._temp(journal, "lock")) as new:
                        os.fsync(new)
                    os.fsync(journal)
                except FileExistsError:
                    pass
            fd = os.open("lock", FILE_FLAGS, dir_fd=journal)
            try:
                pin = os.fstat(fd)
                self._regular(pin)
                if pin.st_uid != os.geteuid() or pin.st_mode & 0o077:
                    raise FolderError("The project journal lock must be private.")
                self._flock(fd, exclusive)
                verify()
                self._check_file(journal, "lock", fd, pin)
                return fd
            except BaseException:
                os.close(fd)
                raise

    def _lock(self, exclusive, *, before_bootstrap=None):
        self._root_current()
        if exclusive:
            require_local_volume(self.fd)
        gate = os.open(".", DIR_FLAGS, dir_fd=self.fd)
        try:
            self._flock(gate, False)
            try:
                fd = self._journal_lock(exclusive)
            except FileNotFoundError:
                if not exclusive:
                    return gate
                self._flock(gate, True)
                if before_bootstrap is not None:
                    before_bootstrap()
                fd = self._journal_lock(True, create=True)
        except BaseException:
            os.close(gate)
            raise
        os.close(gate)
        return fd

    def _check_lock(self, fd):
        if stat.S_ISDIR(os.fstat(fd).st_mode):
            self._root_current()
            return
        with self.directory_at(relative(self.journal)) as (journal, verify):
            self._check_file(journal, "lock", fd, os.fstat(fd))
            verify()

    def _active(self):
        try:
            return bytes(self._read(self.journal + "/active", DESCRIPTOR_CAP, collect=True)[2])
        except FileNotFoundError:
            return None

    def acquire(self, *, recover=True):
        if len(self.leases) >= 16:
            raise FolderError("Close a saved snapshot before opening another.")
        fd = self._lock(False)
        try:
            if self._active() is None:
                return self._lease(fd)
        except BaseException:
            os.close(fd)
            raise
        os.close(fd)
        if not recover:
            raise FolderError("A committed project save needs recovery.")
        self.recover()
        fd = self._lock(False)
        try:
            if self._active() is not None:
                raise FolderError("A committed project save needs recovery.")
            return self._lease(fd)
        except BaseException:
            os.close(fd)
            raise

    def _lease(self, fd):
        token = uuid.uuid4().hex
        self.leases[token] = fd, {}, {"minor": None, "members": {}, "digests": {}}
        self.asset_leases[token] = set()
        return token

    def release(self, token):
        if not isinstance(token, str) or token not in self.leases:
            raise FolderError("The project read lease is invalid.")
        fd, _, _ = self.leases.pop(token)
        self.asset_leases.pop(token, None)
        os.close(fd)
        return True

    def verify_lease(self, token):
        if not isinstance(token, str) or token not in self.leases:
            raise FolderError("The project read lease is invalid.")
        fd, observed, snapshot = self.leases[token]
        self._check_lock(fd)
        if self._active() is not None:
            raise FolderError("A committed project save needs recovery.")
        for path, expected in observed.items():
            try:
                if self.member_stamp(path) == expected:
                    continue
            except OSError:
                pass
            raise FolderError(CHANGED + " Reopen the project read lease.", "conflict", [path])
        # Newer owners are authorised by the manifest already read on this lease.
        # A same-size external rewrite can leave Linux timestamps unchanged.
        manifest_digest = snapshot["digests"].get(self.manifest)
        if snapshot["minor"] and manifest_digest is not None:
            try:
                current, _, _, identity = self._read(self.manifest, FILE_CAP, exact=True)
            except (OSError, FolderError):
                current, identity = None, None
            if current != manifest_digest or identity != observed[self.manifest]:
                raise FolderError(CHANGED + " Reopen the project read lease.", "conflict", [self.manifest])
        return observed

    def member_stamp(self, path):
        parts = relative(path)
        with self.directory_at(parts[:-1]) as (parent, verify):
            info = self._entry(parent, parts[-1])
            self._regular(info)
            verify()
            return stamp(info)

    def _current_minor(self):
        pin = self.member_stamp(self.manifest)
        if self.manifest_version is None or self.manifest_version[0] != pin:
            self.header()
        return self.manifest_version[1]

    def read(self, token, paths):
        observed = self.verify_lease(token)
        if not isinstance(paths, list) or not 1 <= len(paths) <= READ_COUNT:
            raise FolderError("Choose a bounded set of project members to read.")
        snapshot = self.leases[token][2]
        files = []
        seen = set()
        remaining = FILE_CAP
        for path in paths:
            member = snapshot["members"].get(path) if isinstance(path, str) else None
            if member is None:
                member_path(path, self.manifest)
            if Path(path).suffix in MEMBER_SUFFIX.values():
                if snapshot["minor"] is None and self._current_minor():
                    raise FolderError("Read the newer project manifest on this lease before opening an owner.", paths=[path])
                if snapshot["minor"] and member is None:
                    raise FolderError("The owner is outside this newer project's declared membership.", paths=[path])
            key = folded(path)
            if key in seen:
                raise FolderError("The requested project paths collide.")
            seen.add(key)
            try:
                sha, length, data, file_identity = self._read(path, remaining, collect=True, exact=True)
            except FileNotFoundError:
                raise FolderError("A project member is missing: " + path, paths=[path]) from None
            if (observed.setdefault(path, file_identity) != file_identity or
                    snapshot["digests"].setdefault(path, sha) != sha):
                raise FolderError(CHANGED + " Reopen the project read lease.", "conflict", [path])
            remaining -= length
            if path.startswith("assets/") and sha != path[7:]:
                raise self._recovery_conflict(path)
            if path == self.manifest:
                header = format_header(data[:HEADER_CAP])
                self._check_project_identity(header)
                has_tables = table_profile(header)
                minor = 0 if has_tables else future_minor(header["formatVersion"])
                self.manifest_version = file_identity, minor, has_tables
                members = self._observe_members(data, minor)
                snapshot.update(minor=minor, members=members if minor else {})
            if member is not None:
                member_id, member_kind = member
                header = self._parse_member_header(data)
                version = header.get("formatVersion")
                minor = future_minor(version)
                compatible = (version == "2.0" and member_kind in MEMBER_SUFFIX) or 0 < minor <= snapshot["minor"]
                if not compatible or (header.get("id"), header.get("kind")) != (member_id, member_kind):
                    raise FolderError("The saved owner and newer manifest identity disagree.", paths=[path])
            files.append({"path": path, "data": base64.b64encode(data).decode("ascii"), "sha256": sha, "length": length})
        self.verify_lease(token)
        return {"files": files}

    def _membership(self, manifest, *, future=False, additive=False, table_owners=None):
        if not manifest.endswith(b"\n"):
            raise FolderError("The project manifest lacks its final line ending.")
        paths = {folded(self.manifest)}
        ids, members, table_paths = set(), {}, set()
        tables = table_profile(self._parse_member_header(manifest))
        for line in manifest.split(b"\n")[1:-1]:
            record = additive_record(line) if additive else json.loads(line, object_pairs_hook=unique_object)
            if not isinstance(record, dict):
                raise FolderError("The project manifest contains an invalid member.")
            kind = record.get("kind")
            if kind not in {"document", "library", "layoutBlock"}:
                continue
            path, identity = record.get("path"), project_id(record.get("id"))
            native = record.get("docKind") if kind == "document" else ("library" if kind == "library" else "block")
            if not (future and kind == "document" and future_document_path(path, native)):
                member_path(path, self.manifest)
                if MEMBER_SUFFIX.get(native) != Path(path).suffix:
                    raise FolderError("The project member kind and filename disagree.")
            normalized = folded(path)
            if normalized in paths or identity in ids:
                raise FolderError("Project membership contains a duplicate path or identifier.")
            flags = record.get("requires")
            if isinstance(flags, list) and TABLE_FEATURE in flags:
                if not tables or native != "schematic":
                    raise FolderError("The table member has no matching project requirement.", paths=[path])
                table_paths.add(path)
            paths.add(normalized)
            ids.add(identity)
            members[path] = (identity, native)
        if tables and not table_paths:
            raise FolderError("The table project needs a declared schematic owner.")
        if table_owners is not None:
            table_owners.update(table_paths)
        return members

    def _observe_members(self, raw, minor):
        try:
            members = self._membership(raw, future=minor > 0)
        except (ValueError, TypeError, RecursionError):
            return {}  # Let the model codec present its own format diagnostic.
        self.members = {self.manifest, *members}
        return members

    def _old_membership(self, table_owners=None):
        try:
            identity = self.member_stamp(self.manifest)
        except FileNotFoundError:
            return {}
        if self.membership_cache is not None and identity == self.membership_cache[0]:
            if table_owners is not None:
                table_owners.update(self.membership_cache[2])
            return self.membership_cache[1]
        _, _, raw, identity = self._read(self.manifest, FILE_CAP, collect=True)
        paths = set()
        members = self._membership(raw, table_owners=paths)
        self.membership_cache = identity, members, paths
        if table_owners is not None:
            table_owners.update(paths)
        return members

    @staticmethod
    def _parse_member_header(data):
        header, newline, _ = data[:HEADER_CAP].partition(b"\n")
        if not newline:
            return {}
        value = HEADER_JSON.decode(header.decode("utf-8"))
        return value if isinstance(value, dict) else {}

    @classmethod
    def _record_header(cls, fd):
        return cls._parse_member_header(os.pread(fd, HEADER_CAP, 0))

    def _require_writable_owner(self, path, *, exact_native_copy=False, identity=None, replaying=False):
        parts = relative(path)
        try:
            with self.directory_at(parts[:-1]) as (parent, verify):
                with self._file(parent, parts[-1]) as (fd, info):
                    header = self._record_header(fd)
                    if replaying and table_profile(header):
                        exact_native_copy = False
                    if exact_native_copy and (header.get("formatVersion") != "2.0" or (
                            identity is not None and (header.get("id"), header.get("kind")) != identity)):
                        raise FolderError("The exact native copy's owner identity changed.", paths=[path])
                    require_writable_header(header, path, exact_native_copy=exact_native_copy)
                    self._check_file(parent, parts[-1], fd, info)
                verify()
        except FileNotFoundError:
            # The transaction's existing expected/destination checks own absence.
            pass

    def _verify_members(self, plan, directory, *, resolving=False, native_copy_hashes=None):
        before_tables = set()
        before = self._old_membership(before_tables)
        after = before
        after_tables = before_tables
        changed = {entry["path"]: entry for entry in plan}
        if self.manifest in changed:
            wished = changed[self.manifest]["desired"]
            if wished is None:
                raise FolderError("A save cannot remove the project manifest.")
            after_tables = set()
            with self._file(directory, wished["sha256"]) as (fd, _):
                after = self._membership(read_stream(fd, FILE_CAP, collect=True)[2], table_owners=after_tables)
        for path, entry in changed.items():
            if Path(path).suffix not in MEMBER_SUFFIX.values():
                continue
            if not resolving and entry["expected"] is not None and path not in before:
                raise FolderError("The entry is outside the saved project membership.", paths=[path])
            wished = entry["desired"]
            exact_native_copy = native_copy_hashes is not None and path in native_copy_hashes
            if wished is None:
                if path in after or (exact_native_copy and (self.manifest not in changed or path not in before
                                                            or entry["expected"] != native_copy_hashes[path])):
                    raise FolderError("Removing a member requires its manifest change.", paths=[path])
                if exact_native_copy:
                    self._require_writable_owner(path, exact_native_copy=True, identity=before[path])
                continue
            with self._file(directory, wished["sha256"]) as (fd, _):
                row = self._record_header(fd)
            if ((row.get("id"), row.get("kind")) != after.get(path) or not regular_version(row)
                    or table_profile(row) != (path in after_tables)):
                raise FolderError("The staged member and manifest identity disagree.", paths=[path])
            if exact_native_copy and (path in after_tables or self.manifest not in changed or wished["sha256"] != native_copy_hashes[path]
                                          or any(folded(prior) == folded(path) for prior in before)):
                raise FolderError("The exact native copy's bytes or destination changed.", paths=[path])
            require_writable_header(row, path, exact_native_copy=exact_native_copy)
        for path, expected in after.items():
            if path in changed or before.get(path) == expected and (path in before_tables) == (path in after_tables):
                continue
            parts = relative(path)
            with self.directory_at(parts[:-1]) as (parent, verify):
                with self._file(parent, parts[-1]) as (fd, info):
                    row = self._record_header(fd)
                    self._check_file(parent, parts[-1], fd, info)
                verify()
            if ((row.get("id"), row.get("kind")) != expected or not regular_version(row)
                    or table_profile(row) != (path in after_tables)):
                raise FolderError("The adopted member and manifest identity disagree.", paths=[path])

    def status(self):
        if self.state != "settled":
            status = {"state": self.state, "paths": list(self.paths)}
            if self.error:
                status["error"] = self.error
            return status
        return {"state": "recoveryPending" if self._active() is not None else "settled", "paths": []}

    def local_state(self, state=None):
        """Read or atomically replace the ignored view layout for this workspace."""
        path = ".waffle/local/workspace-v1.json"
        cap = 1024 * 1024
        if state is None:
            try:
                with self._closing(self._lock(False)):
                    current = json.loads(self._read(path, cap, collect=True)[2])
            except FileNotFoundError:
                current = {}
            if not isinstance(current, dict):
                raise FolderError("The local workspace view is invalid.")
            return current
        if not isinstance(state, dict):
            raise FolderError("The local workspace view is invalid.")
        try:
            raw = canonical_json(state)
        except (ValueError, UnicodeError, RecursionError):
            raise FolderError("The local workspace view is invalid.") from None
        if len(raw) > cap:
            raise FolderError("The local workspace view exceeds its size limit.")
        with self._closing(self._lock(True)) as lock:
            with self.directory_at(relative(path)[:-1], create=True, private=True) as (directory, verify):
                name = Path(path).name
                temp = ".workspace-" + uuid.uuid4().hex
                try:
                    with self._closing(self._temp(directory, temp)) as fd:
                        write_all(fd, raw)
                        os.fsync(fd)
                    self._check_lock(lock)
                    verify()
                    try:
                        self._regular(self._entry(directory, name))
                    except FileNotFoundError:
                        pass
                    os.replace(temp, name, src_dir_fd=directory, dst_dir_fd=directory)
                    os.fsync(directory)
                finally:
                    try:
                        os.unlink(temp, dir_fd=directory)
                    except FileNotFoundError:
                        pass
        return state

    def _set_error(self, error):
        self.state = error.state if isinstance(error, FolderError) else "recoveryPending"
        self.paths = error.paths if isinstance(error, FolderError) else ()
        self.error = str(error)

    @staticmethod
    def _temp(parent, name, mode=0o600):
        return os.open(name, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW | os.O_CLOEXEC,
                       mode, dir_fd=parent)

    def _check_alias(self, parent, name, path, rename_source=None):
        key = folded(name)
        with os.scandir(parent) as entries:
            for entry in entries:
                if entry.name not in (name, rename_source) and folded(entry.name) == key:
                    raise FolderError("The project filename collides with " + entry.name, "conflict", [path])

    def _target(self, path, *, alias=None):
        parts = relative(path)
        try:
            with self.directory_at(parts[:-1]) as (parent, verify):
                name = parts[-1]
                self._check_alias(parent, name, path, alias)
                if not self._exact(parent, name):
                    return None
                with self._file(parent, name) as (fd, info):
                    if info.st_size > FILE_CAP:
                        raise FolderError("The project member exceeds its size limit: " + path)
                    sha, length, _ = read_stream(fd, FILE_CAP)
                    self._check_file(parent, name, fd, info)
                    verify()
                    return sha, length, stamp(info), stat.S_IMODE(info.st_mode)
        except FileNotFoundError:
            return None

    def _input(self, value, manifest, project, *, native_copy_hashes=None):
        if not isinstance(value, list) or not 1 <= len(value) <= PLAN_CAP:
            raise FolderError("The save plan is empty or exceeds its operation limit.")
        plan = []
        checked_copies = set()
        native_copy_hashes = native_copy_hashes or {}
        for entry in value:
            if not isinstance(entry, dict) or not {"path", "expected"} <= set(entry):
                raise FolderError("The save plan entry is invalid.")
            kinds = set(entry) - {"path", "expected", "nativeCopy"}
            if len(kinds) != 1 or not kinds <= {"text", "data", "splice", "remove", "assetToken"}:
                raise FolderError("Each save entry needs one complete payload, splice or removal.")
            path = entry["path"]
            member_path(path, self.manifest)
            base = entry["expected"]
            if base is not None and not digest(base):
                raise FolderError("The save entry has an invalid expected digest.")
            if "nativeCopy" in entry or path in native_copy_hashes:
                marker = entry.get("nativeCopy")
                wanted = native_copy_hashes.get(path)
                create_copy = base is None and kinds <= {"text", "data"}
                reverse_copy = base == wanted and entry.get("remove") is True
                if (not isinstance(marker, dict) or not isinstance(marker.get("grant"), str) or not marker["grant"]
                        or not digest(wanted) or marker.get("sha256") != wanted
                        or Path(path).suffix not in COPY_OWNER_SUFFIXES or not (create_copy or reverse_copy)):
                    raise FolderError("The exact native copy has no matching selected-file grant.", paths=[path])
                checked_copies.add(path)
            if "remove" in entry and (entry["remove"] is not True or base is None or path == self.manifest):
                raise FolderError("The save entry cannot remove this file.")
            if path.startswith("assets/") and base is not None and "remove" not in entry:
                raise FolderError("An immutable asset must use exclusive creation.")
            if "assetToken" in entry:
                token = entry["assetToken"]
                holder = self.staged.get(token) if isinstance(token, str) else None
                if holder is None or base is not None or path != "assets/" + holder["assetRef"]["sha256"]:
                    raise FolderError("The selected attachment does not belong to this save.")
            plan.append(entry)
        if len(checked_copies) != len(native_copy_hashes):
            raise FolderError("The selected-file grant has no matching exact native copy.")
        check_order(plan, self.manifest)
        project_id(project)
        if manifest != self.manifest:
            raise FolderError("The save plan belongs to a different project folder.")
        return plan

    def _parent_pins(self, plan):
        parents = {()}
        for entry in plan:
            parts = relative(entry["path"])
            parents.update(tuple(parts[:end]) for end in range(1, len(parts)))
        pinned = {}
        for parts in parents:
            try:
                with self.directory_at(parts) as (parent, verify):
                    pinned[parts] = inode(os.fstat(parent))
                    verify()
            except FileNotFoundError:
                pinned[parts] = None
        return pinned

    def _splice(self, output, path, expected, operation, write):
        if (not isinstance(operation, dict) or set(operation) != {"base", "edits"}
                or operation["base"] != expected or not digest(expected)
                or not isinstance(operation["edits"], list) or len(operation["edits"]) > 100000):
            raise FolderError("The save splice has an invalid base or edit list.")
        parts = relative(path)
        with self.directory_at(parts[:-1]) as (parent, verify):
            with self._file(parent, parts[-1]) as (fd, info):
                source_sha = hashlib.sha256()
                at = 0
                def consume(count, keep):
                    nonlocal at
                    while count > 0:
                        chunk = os.read(fd, min(count, CHUNK))
                        if not chunk:
                            raise FolderError(CHANGED, "conflict", [path])
                        source_sha.update(chunk)
                        if keep:
                            write(output, chunk)
                        at += len(chunk)
                        count -= len(chunk)
                for edit in operation["edits"]:
                    if not isinstance(edit, dict) or set(edit) != {"offset", "remove", "insert"}:
                        raise FolderError("A save splice has an invalid edit.")
                    offset, remove, insert = edit["offset"], edit["remove"], edit["insert"]
                    if (type(offset) is not int or type(remove) is not int or not isinstance(insert, str)
                            or offset < at or remove < 0 or offset + remove > info.st_size):
                        raise FolderError("A save splice is out of order or outside its base file.")
                    consume(offset - at, True)
                    consume(remove, False)
                    # Insertions replace UTF-8 physical rows and are bounded by the output cap.
                    write(output, insert.encode("utf-8"))
                consume(info.st_size - at, True)
                self._check_file(parent, parts[-1], fd, info)
                verify()
                if source_sha.hexdigest() != expected:
                    raise FolderError(CHANGED, "conflict", [path])

    def _stage(self, directory, entry, index, remaining):
        if entry.get("remove") is True:
            return None
        temp = ".stage-" + str(index)
        sha = hashlib.sha256()
        length = 0
        def write(fd, data):
            nonlocal length
            length += len(data)
            if length > min(FILE_CAP, remaining):
                raise FolderError("The save plan exceeds its content size limit.")
            sha.update(data)
            write_all(fd, data)
        try:
            with self._closing(self._temp(directory, temp)) as out:
                if "text" in entry or "data" in entry:
                    write(out, complete_payload(entry, min(FILE_CAP, remaining)))
                elif "splice" in entry:
                    self._splice(out, entry["path"], entry["expected"], entry["splice"], write)
                elif "assetToken" in entry:
                    holder = self.staged[entry["assetToken"]]
                    source = holder["stream"].fileno()
                    pos = 0
                    while True:
                        chunk = os.pread(source, CHUNK, pos)
                        if not chunk:
                            break
                        write(out, chunk)
                        pos += len(chunk)
                    asset = holder["assetRef"]
                    if asset["sha256"] != sha.hexdigest() or asset["byteLength"] != length:
                        raise FolderError("The staged attachment changed.")
                else:
                    raise FolderError("The save entry payload is invalid.")
                self.checkpoint("after-stage-write:" + str(index))
                os.fsync(out)
                self.checkpoint("after-stage-flush:" + str(index))
            content = sha.hexdigest()
            try:
                rename_new(directory, temp, directory, content)
            except FileExistsError:
                # The same complete bytes may serve two different plan paths.
                with self._file(directory, content) as (existing, _):
                    if read_stream(existing, length)[:2] != (content, length):
                        raise FolderError("A staged save payload is corrupt.")
                os.unlink(temp, dir_fd=directory)
            return {"sha256": content, "length": length}
        except (UnicodeError, binascii.Error):
            raise FolderError("The save entry payload is invalid.") from None

    @contextmanager
    def _transaction(self, transaction):
        with self.directory_at(relative(self.journal + "/" + transaction)) as (directory, verify):
            info = os.fstat(directory)
            if info.st_uid != os.geteuid() or info.st_mode & 0o077:
                raise FolderError("The staged transaction directory must be private.")
            yield directory, verify

    def _additive_manifest(self, project, entries, *, durable=False):
        hashed, _, raw, _ = self._read(self.manifest, FILE_CAP, collect=True, exact=True)
        header = additive_record(next(raw_lines(raw), b""))
        require_writable_header(header, self.manifest)
        minor = future_minor(header.get("formatVersion"))
        if (not minor or header["kind"] != "project" or header["id"] != project
                or not isinstance(header.get("name"), str) or not header["name"]):
            raise FolderError("This project needs a compatible version before it can be saved.")
        self._check_project_identity(header)
        members = self._membership(raw, future=True, additive=True)
        for entry in entries:
            path = entry["path"]
            if minor == 1 and path.startswith("assets/") and entry["expected"] is None:
                payload = entry["desired"] is not None if durable else ("assetToken" in entry or "data" in entry)
                if payload:
                    continue
            member = members.get(path)
            replacement = entry.get("desired") is not None if durable else ("text" in entry or "data" in entry or "splice" in entry)
            optional_manifest = minor == 1 and path == self.manifest
            if ((not optional_manifest and (member is None or member[1] not in MEMBER_SUFFIX))
                    or entry["expected"] is None or not replacement):
                raise FolderError("Edit an existing known project owner without replacing its format.", paths=[path])
        return minor, members, hashed

    def _future_input(self, project, entries, *, native_copy_hashes=None):
        try:
            header = self.header()
        except FileNotFoundError:
            return  # A new or not-yet-applied project can lack the installed manifest.
        if header is None:
            raise FolderError("The selected project manifest is invalid.")
        require_writable_header(header, self.manifest)
        root_change = next((entry for entry in entries if entry["path"]==self.manifest),None)
        if header["formatVersion"] == "2.1" and not table_profile(header) and root_change is not None:
            _, _, original, _ = self._read(self.manifest, FILE_CAP, collect=True, exact=True)
            proposed = self._assembly(root_change, original)
            to_header = format_header(proposed)
            if to_header is not None and table_profile(to_header):
                project_write(original,proposed,project,self.manifest)
                return
        if regular_version(header):
            for entry in entries:
                if entry["expected"] is not None and Path(entry["path"]).suffix in MEMBER_SUFFIX.values():
                    path = entry["path"]
                    exact_undo = native_copy_hashes is not None and entry.get("remove") is True and path in native_copy_hashes
                    self._require_writable_owner(path, exact_native_copy=exact_undo)
            return
        context = self._additive_manifest(project, entries)
        minor, members, _ = context
        root = None
        pdfs = []
        for entry in entries:
            path, expected = entry["path"], entry["expected"]
            if minor == 1 and path.startswith("assets/") and expected is None:
                if "assetToken" in entry:
                    holder = self.staged[entry["assetToken"]]
                    ref = holder["assetRef"]
                    if holder["ownerId"] != project or ref["mediaType"] != "application/pdf":
                        raise FolderError("Save the selected PDF with its project manifest.", paths=[path])
                    pdfs.append((ref["sha256"], ref["byteLength"]))
                else:
                    data = complete_payload(entry, FILE_CAP)
                    sha = hashlib.sha256(data).hexdigest()
                    if path != "assets/" + sha or not is_pdf(data):
                        raise FolderError("The PDF and its immutable asset name do not match.", paths=[path])
                    pdfs.append((sha, len(data)))
                continue
            _, _, original, _ = self._read(path, FILE_CAP, collect=True, exact=True)
            assembled = self._assembly(entry, original)
            if path == self.manifest:
                project_write(original, assembled, project, path)
                if original != assembled:
                    root = assembled
            else:
                additive_owner(original, assembled, members[path], minor)
        if pdfs and (root is None or any(not manifest_has_pdf(raw_lines(root), sha, length) for sha, length in pdfs)):
            raise FolderError("Save the selected PDF with its project manifest.")
        return context

    def _assembly(self, entry, original):
        path, expected = entry["path"], entry["expected"]
        if hashlib.sha256(original).hexdigest() != expected:
            raise self._recovery_conflict(path)
        if "splice" not in entry:
            return complete_payload(entry, FILE_CAP)
        assembled = bytearray()

        def collect(_fd,data):
            if len(assembled)+len(data) > FILE_CAP:
                raise FolderError("The save plan exceeds its content size limit.", paths=[path])
            assembled.extend(data)

        self._splice(None,path,expected,entry["splice"],collect)
        return assembled

    def _future_staged(self, context, plan, directory):
        minor, members, _ = context
        root = None
        pdfs = []
        for entry in plan:
            path, wished = entry["path"], entry["desired"]
            if minor == 1 and path.startswith("assets/") and entry["expected"] is None:
                if path != "assets/" + wished["sha256"]:
                    raise self._recovery_conflict(path)
                with self._file(directory, wished["sha256"]) as (fd, pin):
                    if not is_pdf(os.pread(fd, 8, 0)):
                        raise self._recovery_conflict(path)
                    self._check_file(directory, wished["sha256"], fd, pin)
                pdfs.append((wished["sha256"], wished["length"]))
                continue
            try:
                hashed, _, original, _ = self._read(path, FILE_CAP, collect=True, exact=True)
            except FileNotFoundError:
                raise self._recovery_conflict(path) from None
            if hashed not in (entry["expected"], wished["sha256"]):
                raise self._recovery_conflict(path)
            with self._file(directory, wished["sha256"]) as (fd, pin):
                sha, length, raw = read_stream(fd, wished["length"], collect=True)
                self._check_file(directory, wished["sha256"], fd, pin)
                if (sha, length) != (wished["sha256"], wished["length"]):
                    raise FolderError("A staged save payload is corrupt.", paths=[path])
            if path == self.manifest:
                project_write(original, raw, format_header(original)["id"], path)
                if entry["expected"] != sha:
                    root = raw
            else:
                additive_owner(original, raw, members[path], minor)
        if pdfs and (root is None or any(not manifest_has_pdf(raw_lines(root), sha, length) for sha, length in pdfs)):
            raise FolderError("Save the selected PDF with its project manifest.")

    def _manifest_base(self, desired, directory=None):
        try:
            actual = self.header()
        except FileNotFoundError:
            actual = None
        target = next((e for e in desired["plan"] if e["path"] == self.manifest), None)
        if target is not None and target["desired"] is not None:
            with self._file(directory,target["desired"]["sha256"]) as (source,_):
                header = format_header(os.read(source,HEADER_CAP+1))
                if (header is None or header["formatVersion"] not in ("2.0","2.1") or header["id"]!=desired["projectId"]):
                    raise FolderError("The save plan contains an invalid project manifest.")
                require_writable_header(header,self.manifest)
                if header["formatVersion"]=="2.1" or actual is not None and table_profile(actual):
                    os.lseek(source,0,os.SEEK_SET)
                    raw = read_stream(source,FILE_CAP,collect=True)[2]
                    original = self._read(self.manifest,FILE_CAP,collect=True,exact=True)[2] if actual is not None else None
                    project_write(original,raw,desired["projectId"],self.manifest)
                if actual is not None and actual["formatVersion"]=="2.1" and table_profile(header):
                    return
        if actual is not None:
            self._check_project_identity(actual)
            if actual["id"] != desired["projectId"]:
                raise FolderError("The save journal belongs to another project.")
            require_writable_header(actual, self.manifest)
            if not regular_version(actual):
                fresh = (actual["formatVersion"] == "2.1" and target is not None
                         and target["expected"] is None and target["desired"] is not None
                         and self._read(self.manifest, FILE_CAP, collect=False, exact=True)[0] == target["desired"]["sha256"])
                if not fresh:
                    return self._additive_manifest(desired["projectId"], desired["plan"], durable=True)
        elif target is None or target["expected"] is not None or target["desired"] is None:
            raise FolderError("The save could not verify the project manifest.")

    def _check_project_identity(self, header):
        if header is None:
            raise FolderError("The selected project manifest is invalid.")
        identity = header["id"]
        if self.project_identity is not None and identity != self.project_identity:
            raise self._recovery_conflict(self.manifest)
        self.project_identity = identity

    def _publish(self, lock, desired, journal, verify, *, replace=False, require_writable=None):
        raw = pack_descriptor(desired)
        if len(raw) > DESCRIPTOR_CAP:
            raise FolderError("The save descriptor is too large.")
        name = ".active-" + desired["transaction"]
        with self._closing(self._temp(journal, name)) as out:
            write_all(out, raw)
            os.fsync(out)
        self.checkpoint("before-publish")
        verify()
        self._check_lock(lock)
        if require_writable is not None:
            require_writable()
        if replace:
            os.replace(name, "active", src_dir_fd=journal, dst_dir_fd=journal)
        else:
            rename_new(journal, name, journal, "active")
        self.checkpoint("after-publish")
        os.fsync(journal)
        self.checkpoint("after-commit-sync")

    def _read_set(self, expected, additive=None):
        if expected is None:
            return
        if not isinstance(expected, dict) or len(expected) > PLAN_CAP:
            raise FolderError("The project read preconditions are invalid.")
        members = additive[1] if additive is not None else {}
        for path, hashed in expected.items():
            if path not in members:
                member_path(path, self.manifest)
            if not digest(hashed):
                raise FolderError("A project read precondition has an invalid digest.", paths=[path])
            try:
                current = self._target(path)
            except (OSError, FolderError):
                raise self._recovery_conflict(path) from None
            if current is None or current[0] != hashed:
                raise self._recovery_conflict(path)

    def commit(self, project, manifest, entries, acknowledge, *, read_set=None, native_copy_hashes=None):
        """Publish the descriptor, acknowledge, then apply on this worker under the lock."""
        if entries == [] and not native_copy_hashes and manifest == self.manifest and project_id(project):
            context = self._future_input(project, entries)
            if read_set is not None:
                with self._closing(self._lock(True)) as lock:
                    self._recover_locked(lock)
                    if self._future_input(project, entries) != context:
                        raise self._recovery_conflict(self.manifest)
                    self._read_set(read_set, context)
            acknowledge({"saved": True, "transaction": None, "hashes": {}})
            return
        plan = self._input(entries, manifest, project, native_copy_hashes=native_copy_hashes)
        def write_context():
            return self._future_input(project, plan, native_copy_hashes=native_copy_hashes)
        selection = write_context()
        with self._closing(self._lock(True, before_bootstrap=write_context)) as lock:
            self._recover_locked(lock)
            accepted = write_context()
            if accepted != selection:
                raise self._recovery_conflict(self.manifest)
            self._read_set(read_set, accepted)
            parents = self._parent_pins(plan)
            transaction = str(uuid.uuid4())
            desired = {"projectId": project, "transaction": transaction, "plan": []}
            remaining = BATCH_CAP
            preflight = {}
            try:
                self.checkpoint("before-stage")
                with self.directory_at(relative(self.journal)) as (journal, verify_journal):
                    os.mkdir(transaction, 0o700, dir_fd=journal)
                    with self._transaction(transaction) as (directory, verify):
                        for index, entry in enumerate(plan):
                            path = entry["path"]
                            previous = preflight.get(folded(path))
                            alias = Path(previous).name if previous else None
                            current = self._target(path, alias=alias)
                            before = current[0] if current else None
                            if before != entry["expected"] and not (path.startswith("assets/") and entry["expected"] is None):
                                raise FolderError(CHANGED + " " + path, "conflict", [path])
                            data = self._stage(directory, entry, index, remaining)
                            if data is not None:
                                remaining -= data["length"]
                                if path.startswith("assets/") and (path[7:] != data["sha256"] or before not in (None, data["sha256"])):
                                    raise FolderError("The immutable asset name conflicts with its bytes.", "conflict", [path])
                            if entry.get("remove") is True:
                                preflight[folded(path)] = path
                            desired["plan"].append({"path": path, "expected": entry["expected"], "desired": data})
                        if self.create is False and not self.header():
                            raise FolderError("The selected project manifest is unavailable.")
                        additive = self._manifest_base(desired, directory)
                        if additive != accepted:
                            raise self._recovery_conflict(self.manifest)
                        if additive is None:
                            self._verify_members(desired["plan"], directory, native_copy_hashes=native_copy_hashes)
                        else:
                            self._future_staged(additive, desired["plan"], directory)
                        self._verify_attachments(plan, desired["plan"], directory)
                        if self._parent_pins(plan) != parents:
                            raise FolderError(CHANGED, "conflict")
                        verify()
                        os.fsync(directory)
                        os.fsync(journal)
                        self.checkpoint("after-stage-dir-sync")
                        self._read_set(read_set, additive)
                        def confirm_current_requirements():
                            if write_context() is not None:
                                raise self._recovery_conflict(self.manifest)
                            for path in native_copy_hashes or {}:
                                expected = next(e["expected"] for e in plan if e["path"] == path)
                                current = self._target(path)
                                if (current[0] if current else None) != expected:
                                    raise self._recovery_conflict(path)
                        self._publish(lock, desired, journal, verify_journal,
                                      require_writable=confirm_current_requirements if additive is None else None)
                self.state = "applying"
                self.paths = ()
                self.error = None
            except (FolderError, OSError) as error:
                if self._active() is not None:
                    self._set_error(error)
                    raise FolderError("The save could not confirm that the journal is durable. Reopen to check recovery.",
                                      paths=getattr(error, "paths", ())) from error
                raise
            acknowledge({"saved": True, "transaction": transaction, "hashes": {
                e["path"]: e["desired"]["sha256"] if e["desired"] else None for e in desired["plan"]}})
            for entry in plan:
                if "assetToken" in entry:
                    self.drop_asset(entry["assetToken"])
            try:
                self._apply(lock, desired, parents)
            except (FolderError, OSError) as error:
                self._set_error(error)

    def _recovery_conflict(self, path):
        return FolderError("The saved transaction conflicts with these working bytes: " + path, "conflict", [path])

    def _install(self, lock, directory, entry, index, *, case_source=None, case_target=None):
        path, expected, wished = entry["path"], entry["expected"], entry["desired"]
        if wished is None and case_target is not None:
            # On a case-insensitive volume the requested old spelling may now open the new name.
            current = self._target(path, alias=Path(case_target).name)
        else:
            current = self._target(path, alias=Path(case_source).name if case_source else None)
        current_sha = current[0] if current is not None else None
        desired_sha = wished["sha256"] if wished else None
        parts = relative(path)
        if current_sha == desired_sha:
            # A crash may have interrupted the target-directory flush after an install.
            try:
                with self.directory_at(parts[:-1]) as (parent, verify):
                    self._check_lock(lock)
                    verify()
                    if current is not None:
                        with self._file(parent, parts[-1]) as (fd, info):
                            if stamp(info) != current[2]:
                                raise self._recovery_conflict(path)
                            os.fsync(fd)
                    os.fsync(parent)
            except FileNotFoundError:
                if current is not None:
                    raise
            return
        if current_sha != expected:
            raise self._recovery_conflict(path)
        staged = None
        if wished is not None:
            staged = ".install-" + uuid.uuid4().hex
            mode = current[3] & 0o777 if current is not None else 0o644
            with self._file(directory, desired_sha) as (source, info):
                with self._closing(self._temp(directory, staged, mode)) as out:
                    sha = hashlib.sha256()
                    length = 0
                    while True:
                        data = os.read(source, CHUNK)
                        if not data:
                            break
                        length += len(data)
                        if length > wished["length"]:
                            raise FolderError("A staged save payload is too large.")
                        sha.update(data)
                        write_all(out, data)
                    if sha.hexdigest() != desired_sha or length != wished["length"]:
                        raise FolderError("A staged save payload is corrupt.")
                    self._check_file(directory, desired_sha, source, info)
                    if current is not None:
                        os.fchmod(out, mode)
                    os.fsync(out)
        with self.directory_at(parts[:-1], create=wished is not None) as (parent, verify):
            name = parts[-1]
            self._check_lock(lock)
            self.checkpoint("before-install:" + str(index))
            verify()
            self._check_alias(parent, name, path)
            if current is None:
                if self._exact(parent, name):
                    raise self._recovery_conflict(path)
                try:
                    rename_new(directory, staged, parent, name)
                except FileExistsError:
                    raise self._recovery_conflict(path) from None
            else:
                with self._file(parent, name) as (fd, info):
                    if stamp(info) != current[2]:
                        raise self._recovery_conflict(path)
                    self._check_file(parent, name, fd, info)
                    if staged is None:
                        os.unlink(name, dir_fd=parent)
                    else:
                        os.replace(staged, name, src_dir_fd=directory, dst_dir_fd=parent)
            self.checkpoint("after-install:" + str(index))
            verify()
            os.fsync(parent)
            os.fsync(directory)
            self.checkpoint("after-dir-sync:" + str(index))

    def _apply(self, lock, desired, parents=None):
        transaction = desired["transaction"]
        plan = desired["plan"]
        case_remove = {folded(e["path"]): e["path"] for e in plan if e["desired"] is None}
        case_create = {folded(e["path"]): e["path"] for e in plan if e["expected"] is None}
        with self._transaction(transaction) as (directory, verify):
            additive = self._manifest_base(desired, directory)
            if additive is not None:
                self._future_staged(additive, plan, directory)
            else:
                current_has_tables = bool(self.manifest_version and self.manifest_version[2])
                final_members, final_tables = None, set()
                def copy_membership():
                    nonlocal final_members
                    if final_members is None:
                        manifest = next((e["desired"] for e in plan if e["path"] == self.manifest), None)
                        final_members = self._old_membership(final_tables) if manifest is None else {}
                        if manifest is not None:
                            with self._file(directory, manifest["sha256"]) as (saved, _):
                                final_members = self._membership(read_stream(saved, FILE_CAP, collect=True)[2], table_owners=final_tables)
                    return final_members

                manifest_changed = any(e["path"] == self.manifest and e["desired"] is not None for e in plan)
                for entry in plan:
                    path, wished = entry["path"], entry["desired"]
                    suffix = Path(path).suffix
                    owner = suffix in MEMBER_SUFFIX.values()
                    if owner and entry["expected"] is not None:
                        exact_undo = (wished is None and manifest_changed and suffix in COPY_OWNER_SUFFIXES
                                      and path not in copy_membership())
                        self._require_writable_owner(path, exact_native_copy=exact_undo, replaying=True)
                    if wished is not None:
                        with self._file(directory, wished["sha256"]) as (fd, info):
                            if read_stream(fd, wished["length"])[:2] != (wished["sha256"], wished["length"]):
                                raise FolderError("A staged save payload is corrupt.")
                            if owner:
                                header = self._record_header(fd)
                                if not regular_version(header):
                                    raise FolderError("This member needs a compatible project version before recovery.", paths=[path])
                                if suffix == ".wsch" and (table_profile(header) or manifest_changed or current_has_tables):
                                    copy_membership()
                                    if table_profile(header) != (path in final_tables):
                                        raise FolderError("The staged table owner and manifest disagree.", paths=[path])
                                exact_native_copy = False
                                if entry["expected"] is None and header.get("requires") and suffix in COPY_OWNER_SUFFIXES and not table_profile(header):
                                    exact_native_copy = copy_membership().get(path) == (header.get("id"), header.get("kind"))
                                require_writable_header(header, path, exact_native_copy=exact_native_copy)
                            self._check_file(directory, wished["sha256"], fd, info)
            for index, entry in enumerate(plan):
                key = folded(entry["path"])
                verify()
                if parents is not None:
                    target_parents = self._parent_pins([entry])
                    if any(value != parents[path] for path, value in target_parents.items()):
                        raise self._recovery_conflict(entry["path"])
                self._install(lock, directory, entry, index, case_source=case_remove.get(key), case_target=case_create.get(key))
                if parents is not None:
                    parents.update(self._parent_pins([entry]))
            for entry in plan:
                path, wished = entry["path"], entry["desired"]
                alternate = case_create.get(folded(path)) if wished is None else None
                current = self._target(path, alias=Path(alternate).name if alternate else None)
                if (current[:2] if current else None) != ((wished["sha256"], wished["length"]) if wished else None):
                    raise self._recovery_conflict(path)
                self.installed[path] = current[2] if current else None
            with self.directory_at(relative(self.journal)) as (journal, verify_journal):
                self._check_lock(lock)
                self.checkpoint("before-unlink")
                verify_journal()
                if self._active() != pack_descriptor(desired):
                    raise FolderError("The active transaction changed during recovery.")
                os.unlink("active", dir_fd=journal)
                self.checkpoint("after-unlink")
                os.fsync(journal)
                self.checkpoint("after-unlink-sync")
        self.create = False
        self.state = "settled"
        self.paths = ()
        self.error = None
        self._cleanup(transaction)
        self.checkpoint("after-cleanup")

    def _cleanup(self, transaction):
        if not UUID.fullmatch(transaction):
            return
        with self.directory_at(relative(self.journal)) as (journal, verify):
            try:
                with self._transaction(transaction) as (inside, verify_inside):
                    names = os.listdir(inside)
                    if any(not (HEX.fullmatch(name) or re.fullmatch(r"\.(?:stage-[0-9]+|(?:install|preserve)-[0-9a-f]{32})", name))
                           or not stat.S_ISREG(self._entry(inside, name).st_mode) for name in names):
                        return
                    verify_inside()
                    for name in names:
                        os.unlink(name, dir_fd=inside)
                    os.fsync(inside)
                verify()
                os.rmdir(transaction, dir_fd=journal)
                temporary = ".active-" + transaction
                try:
                    if stat.S_ISREG(self._entry(journal, temporary).st_mode):
                        os.unlink(temporary, dir_fd=journal)
                except FileNotFoundError:
                    pass
                os.fsync(journal)
            except FileNotFoundError:
                pass

    def _recover_locked(self, lock):
        raw = self._active()
        if raw is not None:
            self.state = "applying"
            try:
                self._apply(lock, unpack_descriptor(raw, self.manifest))
            except (OSError, FolderError) as error:
                self._set_error(error)
                raise
        with self.directory_at(relative(self.journal)) as (journal, _):
            dirs = os.listdir(journal)
        for name in dirs:
            if UUID.fullmatch(name):
                self._cleanup(name)
        self.state = "settled"
        self.paths = ()
        self.error = None

    def recover(self):
        with self._closing(self._lock(False)) as lease:
            # A pristine workspace uses the directory lock and has nothing to recover.
            if stat.S_ISDIR(os.fstat(lease).st_mode) and self._active() is None:
                return
        with self._closing(self._lock(True)) as lock:
            self._recover_locked(lock)

    def _review(self, transaction=None):
        raw = self._active()
        if raw is None:
            raise FolderError("This project has no unresolved transaction.")
        descriptor = unpack_descriptor(raw, self.manifest)
        if transaction is not None and descriptor["transaction"] != transaction:
            raise FolderError("The conflict review has expired.")
        return raw, descriptor

    def _observed_targets(self, plan):
        spellings = {}
        for entry in plan:
            path = entry["path"]
            spellings.setdefault(folded(path), []).append(path)
        for entry in plan:
            path = entry["path"]
            alternate = next((name for name in spellings[folded(path)] if name != path), None)
            yield entry, self._target(path, alias=Path(alternate).name if alternate else None)

    @staticmethod
    def _changed(entry, current):
        wished = entry["desired"]
        return ((current[:2] if current else None) != ((wished["sha256"], wished["length"]) if wished else None)
                and (current[0] if current else None) != entry["expected"])

    def conflict(self):
        with self._closing(self._lock(False)):
            _, descriptor = self._review()
            paths, rows = [], []
            for entry, current in self._observed_targets(descriptor["plan"]):
                if self._changed(entry, current):
                    paths.append(entry["path"])
                rows.append({**entry, "current": current[0] if current else None})
            return {"state": "conflict" if paths else "recoveryPending", "paths": paths,
                    "transaction": descriptor["transaction"], "plan": rows}

    def conflict_read(self, request):
        transaction, path, side = request.get("transaction"), request.get("path"), request.get("side")
        offset, count = request.get("offset"), request.get("length")
        if not isinstance(transaction, str) or type(offset) is not int or type(count) is not int or not 1 <= count <= 1 << 20:
            raise FolderError("The requested conflict range is invalid.")
        member_path(path, self.manifest)
        with self._closing(self._lock(False)):
            _, descriptor = self._review(transaction)
            entry = next((e for e in descriptor["plan"] if e["path"] == path), None)
            if entry is None:
                raise FolderError("The path does not take part in this conflict.")
            if side == "staged" and entry["desired"] is not None:
                filename = self.journal + "/" + transaction + "/" + entry["desired"]["sha256"]
            elif side == "external":
                filename = path
            else:
                raise FolderError("That side of the conflict has no file.")
            parts = relative(filename)
            with self.directory_at(parts[:-1]) as (parent, verify):
                if not self._exact(parent, parts[-1]):
                    raise FolderError("That side of the conflict has no file.")
                with self._file(parent, parts[-1]) as (fd, info):
                    sha, size, _ = read_stream(fd, FILE_CAP)
                    if not 0 <= offset <= size:
                        raise FolderError("The requested conflict range is invalid.")
                    if side == "staged" and {"sha256": sha, "length": size} != entry["desired"]:
                        raise FolderError("The staged conflict contents are corrupt.")
                    data = os.pread(fd, min(count, size - offset), offset)
                    self._check_file(parent, parts[-1], fd, info)
                verify()
            return {"sha256": sha, "data": base64.b64encode(data).decode("ascii"), "offset": offset,
                    "length": len(data), "eof": offset + len(data) == size}

    def _preserve(self, source, desired, target):
        sha, size = desired["sha256"], desired["length"]
        try:
            with self._file(target, sha) as (existing, info):
                if read_stream(existing, size)[:2] != (sha, size):
                    raise FolderError("A preserved conflict payload is corrupt.")
                self._check_file(target, sha, existing, info)
                return
        except FileNotFoundError:
            pass
        temporary = ".preserve-" + uuid.uuid4().hex
        try:
            with self._closing(self._temp(target, temporary)) as out:
                copied = 0
                checksum = hashlib.sha256()
                while True:
                    data = os.pread(source, CHUNK, copied)
                    if not data:
                        break
                    copied += len(data)
                    if copied > size:
                        raise FolderError(CHANGED)
                    checksum.update(data)
                    write_all(out, data)
                if copied != size or checksum.hexdigest() != sha:
                    raise FolderError(CHANGED)
                os.fsync(out)
            rename_new(target, temporary, target, sha)
        finally:
            try:
                os.unlink(temporary, dir_fd=target)
            except FileNotFoundError:
                pass

    def _preserve_external(self, path, current, archive):
        if current is None:
            return None
        desired = {"sha256": current[0], "length": current[1]}
        parts = relative(path)
        with self.directory_at(parts[:-1]) as (parent, verify):
            with self._file(parent, parts[-1]) as (fd, info):
                if stamp(info) != current[2]:
                    raise self._recovery_conflict(path)
                self._preserve(fd, desired, archive)
                self._check_file(parent, parts[-1], fd, info)
            verify()
        return desired

    def _write_private(self, directory, name, data):
        try:
            with self._closing(self._temp(directory, name)) as fd:
                write_all(fd, data)
                os.fsync(fd)
        except FileExistsError:
            with self._file(directory, name) as (fd, _):
                if read_stream(fd, len(data), collect=True)[2] != data:
                    raise FolderError("The preserved conflict record differs.")

    def _additive_resolution(self, descriptor, current, choices):
        try:
            header = self.header()
        except FileNotFoundError:
            return None  # An accepted 2.0 creation can still lack the installed manifest.
        if header is None:
            raise FolderError("The selected project manifest is invalid.")
        if regular_version(header):
            require_writable_header(header, self.manifest)
            for entry, observed in current:
                if observed is not None and Path(entry["path"]).suffix in MEMBER_SUFFIX.values():
                    self._require_writable_owner(entry["path"])
            return None
        context = self._additive_manifest(descriptor["projectId"], descriptor["plan"], durable=True)
        minor, members, _ = context
        with self._transaction(descriptor["transaction"]) as (staged, verify):
            for entry, observed in current:
                path, wished = entry["path"], entry["desired"]
                if observed is None:
                    raise self._recovery_conflict(path)
                hashed, _, external, current_pin = self._read(path, FILE_CAP, collect=True, exact=True)
                if hashed != observed[0] or current_pin != observed[2]:
                    raise self._recovery_conflict(path)
                choice = choices.get(path, {"use": "staged"})
                action = choice.get("use")
                if action == "external":
                    selected = external
                elif action == "merged" and ("text" in choice) != ("data" in choice):
                    selected = complete_payload(choice, FILE_CAP)
                elif action == "staged":
                    with self._file(staged, wished["sha256"]) as (fd, pin):
                        sha, length, selected = read_stream(fd, wished["length"], collect=True)
                        self._check_file(staged, wished["sha256"], fd, pin)
                        if (sha, length) != (wished["sha256"], wished["length"]):
                            raise FolderError("A staged save payload is corrupt.", paths=[path])
                else:
                    raise FolderError("The conflict decision is invalid.", paths=[path])
                if path == self.manifest:
                    optional_project(external, selected, descriptor["projectId"], path)
                else:
                    additive_owner(external, selected, members[path], minor)
            verify()
        return context

    def resolve(self, request, acknowledge):
        """Keep both reviewed versions, then atomically supersede the committed plan."""
        transaction, choices = request.get("transaction"), request.get("choices")
        if not isinstance(transaction, str) or not isinstance(choices, list) or not 1 <= len(choices) <= PLAN_CAP:
            raise FolderError("Choose how to resolve each listed conflict.")
        self._review(transaction)  # A pristine project has no conflict journal to initialize.
        with self._closing(self._lock(True)) as lock:
            raw, old = self._review(transaction)
            current = list(self._observed_targets(old["plan"]))
            by_path = {entry["path"]: value for entry, value in current}
            decisions = {}
            for choice in choices:
                if not isinstance(choice, dict):
                    raise FolderError("A conflict decision is invalid.")
                path = choice.get("path")
                if not isinstance(path, str) or path in decisions or path not in by_path or "current" not in choice:
                    raise FolderError("A conflict decision does not name a unique listed path.")
                occupied = by_path[path]
                if choice["current"] != (occupied[0] if occupied else None):
                    raise self._recovery_conflict(path)
                decisions[path] = choice
            conflicts = [entry["path"] for entry, value in current if self._changed(entry, value)]
            if not conflicts or any(path not in decisions for path in conflicts):
                raise FolderError("Refresh the review and resolve every competing version.", "conflict", conflicts)
            reviewed = self._additive_resolution(old, current, decisions)
            replacement = str(uuid.uuid4())
            plan, total, snapshots = [], 0, {}
            archive_parts = [".waffle", "local", "conflicts", transaction]
            with self.directory_at(relative(self.journal)) as (journal, verify_journal):
                os.mkdir(replacement, 0o700, dir_fd=journal)
                with (self._transaction(transaction) as (prior, _),
                      self._transaction(replacement) as (stage, verify_stage),
                      self.directory_at(archive_parts, create=True, private=True) as (archive, verify_archive)):
                    for index, (entry, occupied) in enumerate(current):
                        path, wished = entry["path"], entry["desired"]
                        external = self._preserve_external(path, occupied, archive)
                        snapshots[path] = external["sha256"] if external else None
                        if wished is not None:
                            with self._file(prior, wished["sha256"]) as (fd, _):
                                self._preserve(fd, wished, archive)
                        choice = decisions.get(path, {"use": "staged"})
                        action = choice.get("use")
                        if action == "external":
                            wished = external
                        elif action == "merged":
                            content = {key: choice[key] for key in ("text", "data") if key in choice}
                            if len(content) != 1:
                                raise FolderError("A merge needs the complete reviewed contents.")
                            wished = self._stage(stage, content, index, BATCH_CAP - total)
                        elif action != "staged":
                            raise FolderError("The conflict decision is invalid.")
                        if wished is not None:
                            total += wished["length"]
                            if total > BATCH_CAP or (path.startswith("assets/") and path[7:] != wished["sha256"]):
                                raise FolderError("The resolution exceeds the allowed content.")
                            if action != "merged":
                                with self._file(archive, wished["sha256"]) as (fd, _):
                                    self._preserve(fd, wished, stage)
                        if wished is not None or occupied is not None:
                            plan.append({"path": path, "expected": snapshots[path], "desired": wished})
                    if not plan:
                        manifest = self._target(self.manifest)
                        wished = self._preserve_external(self.manifest, manifest, stage)
                        plan.append({"path": self.manifest, "expected": wished["sha256"], "desired": wished})
                    check_order(plan, self.manifest)
                    desired = {"projectId": old["projectId"], "transaction": replacement, "plan": plan}
                    additive = self._manifest_base(desired, stage)
                    if additive != reviewed:
                        raise self._recovery_conflict(self.manifest)
                    if additive is None:
                        self._verify_members(plan, stage, resolving=True)
                    else:
                        self._future_staged(additive, plan, stage)
                    self._write_private(archive, "original.active", raw)
                    self._write_private(archive, replacement + ".json", canonical_json({"observed": snapshots}))
                    verify_archive()
                    os.fsync(archive)
                    verify_stage()
                    os.fsync(stage)
                    os.fsync(journal)
                    for entry, actual in self._observed_targets(old["plan"]):
                        if snapshots[entry["path"]] != (actual[0] if actual else None):
                            raise self._recovery_conflict(entry["path"])
                    if self._active() != raw:
                        raise FolderError("The active transaction changed during review.")
                    try:
                        self._publish(lock, desired, journal, verify_journal, replace=True)
                    except (OSError, FolderError) as error:
                        self._set_error(error)
                        raise FolderError("The reviewed resolution may have committed. Reopen to verify.") from error
            self.state, self.paths, self.error = "applying", (), None
            acknowledge({"saved": True, "transaction": replacement, "hashes": {
                e["path"]: e["desired"]["sha256"] if e["desired"] else None for e in plan}})
            try:
                self._apply(lock, desired)
                self._cleanup(transaction)
            except (OSError, FolderError) as error:
                self._set_error(error)

    def _verify_attachments(self, requested, plan, directory):
        for index, request in enumerate(requested):
            if "assetToken" not in request:
                continue
            holder = self.staged[request["assetToken"]]
            asset, owner = holder["assetRef"], holder["ownerId"]
            for entry in plan[index + 1:]:
                wished = entry["desired"]
                if wished is None or entry["path"] != self.manifest and not entry["path"].endswith(".wsch"):
                    continue
                with self._file(directory, wished["sha256"]) as (fd, _):
                    if owner_has_asset(fd, owner, asset["sha256"], asset["byteLength"], asset["mediaType"]):
                        break
            else:
                raise FolderError("Save the selected attachment with its owner.")

    def stage_asset(self, owner, media, *, source=None, data=None):
        """Capture a user-selected native handle or a bounded clipboard result privately."""
        if not isinstance(owner, str) or not 1 <= len(owner.encode("utf-8")) <= 1024 or len(self.staged) >= 64:
            raise FolderError("Choose an editable attachment owner.")
        used = sum(holder["assetRef"]["byteLength"] for holder in self.staged.values())
        cap = min(FILE_CAP, BATCH_CAP - used)
        if cap <= 0:
            raise FolderError("The project has too many staged attachment bytes.")
        stream = tempfile.TemporaryFile(mode="w+b")
        try:
            checksum = hashlib.sha256()
            size = 0

            def capture(chunk):
                nonlocal size
                size += len(chunk)
                if size > cap:
                    raise FolderError("The attachment exceeds its size limit.")
                checksum.update(chunk)
                write_all(stream.fileno(), chunk)

            if source is not None:
                info = os.fstat(source)
                self._regular(info)
                if info.st_size > cap:
                    raise FolderError("The attachment exceeds its size limit.")
                while True:
                    chunk = os.read(source, CHUNK)
                    if not chunk:
                        break
                    capture(chunk)
                if stamp(os.fstat(source)) != stamp(info):
                    raise FolderError("The selected attachment changed while it was read.")
            elif isinstance(data, str) and len(data) <= 4 * (cap // 3 + 1):
                try:
                    capture(base64.b64decode(data, validate=True))
                except binascii.Error:
                    raise FolderError("The attachment bytes are invalid.") from None
            else:
                raise FolderError("The attachment bytes are invalid.")
            detected = asset_media(os.pread(stream.fileno(), HEADER_CAP, 0))
            if detected is None or (media is not None and detected != media):
                raise FolderError("The attachment has an unsupported or mismatched media type.")
            token = str(uuid.uuid4())
            ref = {"sha256": checksum.hexdigest(), "byteLength": size, "mediaType": detected}
            self.staged[token] = {"stream": stream, "assetRef": ref, "ownerId": owner}
            return {"assetToken": token, "assetRef": ref, "ownerId": owner}
        except BaseException:
            stream.close()
            raise

    @property
    def draft_scope(self):
        return hashlib.sha256(("%d/%d" % self.root_id).encode()).hexdigest()

    def draft_asset(self, request, profile, restore=False):
        """A receipt permits only the same private original, root and owner after restart."""
        self._root_current()
        owner, ref = request.get("ownerId"), request.get("assetRef")
        if not isinstance(owner, str) or not 0 < len(owner.encode()) <= 1024 or not isinstance(ref, dict):
            raise FolderError("Invalid private draft attachment.")
        sha, size, media = ref.get("sha256"), ref.get("byteLength"), ref.get("mediaType")
        if not digest(sha) or type(size) is not int or not 0 < size <= FILE_CAP or media not in {
                "image/png", "image/jpeg", "image/webp", "image/heic", "image/svg+xml", "application/pdf"}:
            raise FolderError("Invalid private draft attachment.")
        if not restore:
            token = request.get("assetToken")
            prior = self.staged.get(token) if isinstance(token, str) else None
            if not prior or prior["ownerId"] != owner or prior["assetRef"] != ref:
                raise FolderError("This owner has no such staged original.")
        keydir = Path(profile) / "folder-recovery"
        keydir.mkdir(parents=True, mode=0o700, exist_ok=True)
        keypath = keydir / "provenance-v1"
        if not keypath.exists() and not restore:
            temp, name = tempfile.mkstemp(dir=keydir)
            try:
                with os.fdopen(temp, "wb") as out:
                    out.write(secrets.token_bytes(32))
                    out.flush()
                    os.fsync(out.fileno())
                try:
                    os.link(name, keypath)
                except FileExistsError:
                    pass
                d = os.open(keydir, DIR_FLAGS)
                try:
                    os.fsync(d)
                finally:
                    os.close(d)
            finally:
                os.unlink(name)
        fd = os.open(keypath, FILE_FLAGS)
        try:
            key = os.read(fd, 33)
            if len(key) != 32 or os.fstat(fd).st_uid != os.getuid():
                raise FolderError("The private draft key is unavailable.")
        finally:
            os.close(fd)
        proof = hmac.new(key, "\n".join([self.draft_scope, sha, str(size), media, owner]).encode(), hashlib.sha256).hexdigest()
        if not restore:
            return {"proof": proof}
        data, supplied = request.get("data"), request.get("proof")
        if not isinstance(supplied, str) or not digest(supplied) or not hmac.compare_digest(supplied, proof) or not isinstance(data, str) or len(data) != 4 * ((size + 2) // 3):
            raise FolderError("The private draft original could not be verified.")
        staged = self.stage_asset(owner, media, data=data)
        if staged["assetRef"] != ref:
            self.drop_asset(staged["assetToken"])
            raise FolderError("The private draft original changed.")
        return staged

    def drop_asset(self, token):
        holder = self.staged.pop(token, None) if isinstance(token, str) else None
        if holder is not None:
            holder["stream"].close()
        return True

    def _asset_owner(self, lease, owner, ref):
        snapshots = self.verify_lease(lease)
        manifest = self._read(self.manifest, FILE_CAP, collect=True)
        if snapshots.setdefault(self.manifest, manifest[3]) != manifest[3]:
            raise FolderError(CHANGED)
        header, *lines = manifest[2].splitlines()
        if ref["mediaType"] == "application/pdf":
            root = json.loads(header)
            if root.get("kind") == "project" and root.get("id") == owner and manifest_has_pdf(lines, ref["sha256"], ref["byteLength"]):
                return snapshots
        owners = []
        for line in lines:
            row = json.loads(line)
            if isinstance(row, dict) and row.get("kind") == "document" and row.get("id") == owner and row.get("docKind") == "schematic":
                owners.append(row.get("path"))
        if len(owners) != 1:
            raise FolderError("The attachment owner is unavailable.")
        path = owners[0]
        parts = member_path(path, self.manifest)
        with self.directory_at(parts[:-1]) as (folder, verify):
            with self._file(folder, parts[-1]) as (fd, info):
                if info.st_size > FILE_CAP or not owner_has_asset(fd, owner, ref["sha256"], ref["byteLength"], ref["mediaType"]):
                    raise FolderError("The attachment does not belong to this saved sheet.")
                self._check_file(folder, parts[-1], fd, info)
                if snapshots.setdefault(path, stamp(info)) != stamp(info):
                    raise FolderError(CHANGED)
                verify()
        return snapshots

    def read_asset(self, request):
        owner, ref, purpose = request.get("ownerId"), request.get("assetRef"), request.get("purpose")
        if (not isinstance(owner, str) or not owner or not isinstance(ref, dict) or not digest(ref.get("sha256"))
                or type(ref.get("byteLength")) is not int or not 0 <= ref["byteLength"] <= FILE_CAP
                or not isinstance(ref.get("mediaType"), str) or not isinstance(purpose, str) or not purpose):
            raise FolderError("The attachment reference is not authorised.")
        sha, size = ref["sha256"], ref["byteLength"]
        offset, count = request.get("offset", 0), request.get("length", 1 << 20)
        if type(offset) is not int or type(count) is not int or not 0 <= offset <= size or not 1 <= count <= 1 << 20:
            raise FolderError("The attachment read exceeds its range.")
        token = request.get("assetToken")
        if token is not None:
            holder = self.staged.get(token) if isinstance(token, str) else None
            if holder is None or owner != holder["ownerId"] or ref != holder["assetRef"]:
                raise FolderError("The staged attachment is not authorised.")
            data = os.pread(holder["stream"].fileno(), min(count, size - offset), offset)
        else:
            lease = request.get("lease")
            snapshots = self.verify_lease(lease)
            references = self.asset_leases[lease]
            key = (owner, sha, size, ref["mediaType"])
            if key not in references:
                self._asset_owner(lease, owner, ref)
                references.add(key)
            path = "assets/" + sha
            with self.directory_at(["assets"]) as (folder, verify):
                with self._file(folder, sha) as (fd, info):
                    if (info.st_size != size or
                            (snapshots.get(path) != stamp(info) and read_stream(fd, size)[:2] != (sha, size))):
                        raise self._recovery_conflict(path)
                    data = os.pread(fd, min(count, size - offset), offset)
                    self._check_file(folder, sha, fd, info)
                    if snapshots.setdefault(path, stamp(info)) != stamp(info):
                        raise FolderError(CHANGED)
                    verify()
            self.verify_lease(lease)
        return {"data": base64.b64encode(data).decode("ascii"), "offset": offset, "length": len(data),
                "eof": offset + len(data) == size}


class NativeMember(RootFolder):
    """A regular native file selected with its parent grant and an isolated redo journal."""

    kinds = {".wsch": "schematic", ".wpcb": "pcb", ".wdraw": "drawing", ".wpanel": "panel", ".wlib": "library"}

    def __init__(self, selected, *, checkpoint=None):
        selected = Path(selected)
        self.kind = self.kinds.get(selected.suffix.lower())
        if self.kind is None or any(p.lower().endswith(tuple(self.kinds)) for p in selected.parent.parts):
            raise FolderError("Choose a regular native document outside other native document paths.")
        # Use the same locale-independent journal name as the other native hosts.
        leaf = selected.name.translate(str.maketrans("ABCDEFGHIJKLMNOPQRSTUVWXYZ", "abcdefghijklmnopqrstuvwxyz"))
        key = hashlib.sha256(leaf.encode("utf-8")).hexdigest()
        self.journal = JOURNAL + "/member-" + key
        super().__init__(selected.parent, selected.name, checkpoint=checkpoint)

    def _valid_bound_name(self, name):
        return Path(name).suffix.lower() in self.kinds

    def _header_policy(self, header):
        version = header.get("formatVersion")
        parts = re.fullmatch(r"([2-9]|[1-9][0-9]{1,3})\.(0|[1-9][0-9]{0,3})", version or "") if isinstance(version, str) else None
        if header.get("kind") != self.kind or not parts or (parts[1] != "2" and header.get("compatibleWith") != "2.0"):
            raise FolderError("The selected file is not a compatible native document.", paths=[self.manifest])
        project_id(header.get("id"))
        requires = header.get("requires", [])
        if not isinstance(requires, list) or any(not isinstance(r, str) or not r for r in requires) or len(set(requires)) != len(requires):
            raise FolderError("The selected file has an invalid required feature list.", paths=[self.manifest])
        return version != "2.0" or bool(requires)

    def header(self):
        self._check_alias(self.fd, self.manifest, self.manifest)
        with self._file(self.fd, self.manifest) as (fd, info):
            header = self._record_header(fd)
            self._check_file(self.fd, self.manifest, fd, info)
        self._header_policy(header)
        return header

    def read(self):
        lease = self.acquire()
        try:
            self._check_alias(self.fd, self.manifest, self.manifest)
            sha, _, data, _ = self._read(self.manifest, FILE_CAP, collect=True, exact=True)
            header = self._parse_member_header(data)
            readonly = self._header_policy(header)
            self._check_project_identity(header)
            self.verify_lease(lease)
            return {"data": bytes(data), "sha256": sha, "readOnly": readonly}
        finally:
            self.release(lease)

    def _bound(self, project, entries):
        if (len(entries) != 1 or entries[0]["path"] != self.manifest or entries[0]["expected"] is None):
            raise FolderError("The journal does not belong to the selected native document.", paths=[self.manifest])
        header = self.header()
        if self._header_policy(header) or project != header["id"]:
            raise FolderError("The selected native document is read-only or its identity changed.", paths=[self.manifest])
        self._check_project_identity(header)
        return entries[0]

    def _future_input(self, project, entries, *, native_copy_hashes=None):
        self._bound(project, entries)

    def _manifest_base(self, desired, directory=None):
        entry = self._bound(desired["projectId"], desired["plan"])
        if not entry["desired"]:
            raise FolderError("The selected native document cannot be removed.", paths=[self.manifest])
        with self._file(directory, entry["desired"]["sha256"]) as (source, _):
            header = self._record_header(source)
        if self._header_policy(header) or header["id"] != desired["projectId"]:
            raise FolderError("A save cannot change this native document's identity or format.", paths=[self.manifest])

    def _verify_members(self, plan, directory, *, resolving=False, native_copy_hashes=None):
        # The selected file's own header is the complete scope in _manifest_base.
        pass

    def commit(self, expected, data):
        if not digest(expected) or not isinstance(data, bytes) or len(data) > FILE_CAP or not data.endswith(b"\n"):
            raise FolderError("The native document save payload or precondition is invalid.", paths=[self.manifest])
        # Verify the selected spelling before comparing its identity or allocating a journal.
        saved = self.read()
        if saved["sha256"] != expected:
            raise self._recovery_conflict(self.manifest)
        if saved["readOnly"]:
            raise FolderError("The selected native document is read-only.", paths=[self.manifest])
        desired = self._parse_member_header(data)
        if self._header_policy(desired) or desired["id"] != self.project_identity:
            raise FolderError("A save cannot change this native document's identity or format.", paths=[self.manifest])
        sha = hashlib.sha256(data).hexdigest()
        if sha == expected:
            return {"saved": True, "hash": sha, "transaction": None}
        receipts = []
        super().commit(self.project_identity, self.manifest,
                       [{"path": self.manifest, "expected": expected, "text": data.decode("utf-8")}], receipts.append)
        receipt = receipts[0]
        return {"saved": True, "hash": receipt["hashes"][self.manifest], "transaction": receipt["transaction"]}


class FolderWatch:
    """A GLib-compatible Linux inotify descriptor, with no polling."""

    RECORD = struct.Struct("iIII")
    MODIFY = 0x00000002 | 0x00000004 | 0x00000008
    NAMES = 0x00000040 | 0x00000080 | 0x00000100 | 0x00000200
    MOVED_OR_REMOVED = 0x00000400 | 0x00000800
    OVERFLOW = 0x00004000
    IGNORED = 0x00008000
    IS_DIRECTORY = 0x40000000

    def __init__(self, root):
        self.root = root
        self.lib = ctypes.CDLL(None, use_errno=True)
        self.fd = self.lib.inotify_init1(os.O_NONBLOCK | os.O_CLOEXEC)
        if self.fd < 0:
            error = ctypes.get_errno()
            raise OSError(error, os.strerror(error))
        self.lib.inotify_add_watch.argtypes = [ctypes.c_int, ctypes.c_char_p, ctypes.c_uint]
        self.by_watch = {}
        self.by_dir = {}
        self.wanted = {()}
        self.overflowed = False
        try:
            self.refresh()
        except BaseException:
            self.close()
            raise

    def close(self):
        os.close(self.fd)
        self.by_watch.clear()
        self.by_dir.clear()

    def track(self, paths):
        wanted = {(), ("assets",), ("models",), ("libraries",), (".waffle",), (".waffle", "imports")}
        for path in paths:
            parts = tuple(relative(path)[:-1])
            for end in range(1, len(parts) + 1):
                wanted.add(parts[:end])
        for directory in self.by_dir.keys() - wanted:
            index = self.by_dir.pop(directory)
            self.by_watch.pop(index, None)
            self.lib.inotify_rm_watch(self.fd, index)
        self.wanted = wanted
        self.refresh()

    def refresh(self):
        mask = self.MODIFY | self.NAMES | self.MOVED_OR_REMOVED
        for path in sorted(self.wanted - self.by_dir.keys()):
            try:
                with self.root.directory_at(path) as (folder, verify):
                    watch = self.lib.inotify_add_watch(self.fd, ("/proc/self/fd/" + str(folder)).encode("ascii"), mask)
                    verify()
                    if watch < 0:
                        error = ctypes.get_errno()
                        raise OSError(error, os.strerror(error))
            except FileNotFoundError:
                continue
            except (OSError, FolderError):
                self.overflowed = True
                continue
            self.by_watch[watch] = path
            self.by_dir[path] = watch

    def drain(self):
        folders_changed = False
        paths = set()
        while True:
            try:
                data = os.read(self.fd, 128 * 1024)
            except BlockingIOError:
                break
            offset = 0
            while offset < len(data):
                watch, mask, _, length = self.RECORD.unpack_from(data, offset)
                offset += self.RECORD.size
                name = os.fsdecode(data[offset:offset + length].split(b"\0", 1)[0])
                offset += length
                directory = self.by_watch.get(watch)
                if mask & self.OVERFLOW:
                    self.overflowed = True
                if directory is None:
                    continue
                if mask & (self.MOVED_OR_REMOVED | self.IGNORED):
                    self.by_watch.pop(watch, None)
                    self.by_dir.pop(directory, None)
                    self.overflowed = True
                    folders_changed = True
                if mask & self.IS_DIRECTORY:
                    relevant = directory != (".waffle",) or name == "imports"
                    if relevant and name != ".git" and (not name.startswith(".") or name == ".waffle"):
                        folders_changed = True
                    continue
                if not name:
                    continue
                path = "/".join((*directory, name))
                try:
                    member_path(path, self.root.manifest)
                except FolderError:
                    continue
                if len(paths) < 512:
                    paths.add(path)
                else:
                    self.overflowed = True
        if folders_changed or self.overflowed:
            self.refresh()
        overflow, self.overflowed = self.overflowed or folders_changed, False
        return paths, overflow
