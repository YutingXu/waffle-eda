"""Install a fully verified portable project as one newly named folder.

The parent is supplied by a native chooser. A private same-volume staging directory never
uses a file from the destination. Publication asks the filesystem for a no-replacement
directory rename, including when two windows select the same project name.
"""
import base64
import ctypes
import errno
import gzip
import hashlib
import io
import json
import os
from pathlib import Path
from contextlib import contextmanager
import re
import shutil
import stat
import sys
import tempfile
from collections import deque
import unicodedata

ENTRY = 256 * 1048576
TOTAL = 512 * 1048576
COUNT = 10000
IGNORE = ".waffle/.gitignore"
HEX = r"[a-f0-9]{64}"
NATIVE = re.compile(r"\.(?:waffle|wsch|wpcb|wlib|wblock|wdraw|wpanel)\Z", re.I)
_IMPORT = re.compile(r"\.waffle/imports/("+HEX+r")/(source|bindings-[a-zA-Z0-9_-]{1,100}\.json)\Z")
_MODEL = re.compile(r"models/("+HEX+r")\.[a-z0-9]+\.gz\Z")
_ASSET = re.compile(r"assets/("+HEX+r")\Z")


class ParentNotWritable(PermissionError):
    """The explicitly selected parent cannot create the private sibling."""


def portable(path):
    if not isinstance(path, str) or not path or len(path.encode()) > 4096:
        raise ValueError("Invalid archive path.")
    for part in path.split("/"):
        if (part in ("", ".", "..") or part.endswith((" ", ".")) or len(part.encode()) > 255
                or any(ord(c) < 32 or ord(c) == 127 or c in '<>:"\\|?*' for c in part)
                or part.casefold() == ".git" or re.fullmatch(r"git~[1-9]", part, re.I)
                or re.fullmatch(r"(?:con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³]|conin\$|conout\$)(?:\..*)?",part,re.I)):
            raise ValueError("Invalid archive path: " + path)
    return path


def future_documents(manifest_bytes):
    lines=manifest_bytes.splitlines()
    header=json.loads(lines[0]) if lines else {}
    if not re.fullmatch(r"2\.[0-9]+",str(header.get("formatVersion"))) or int(header["formatVersion"][2:])==0:
        return set()
    extra=set()
    for line in lines[1:]:
        row=json.loads(line)
        if row.get("kind")=="document" and row.get("docKind") not in ("schematic","pcb","drawing","panel"):
            path=portable(row.get("path"))
            if any(part.startswith(".") for part in path.split("/")) or path.split("/")[0] in ("assets","models","libraries"):
                raise ValueError("Invalid future document path.")
            extra.add(path)
    return extra


def member(path, manifest, extra=()):
    portable(path)
    typed = NATIVE.search(path)
    return (path == IGNORE or path == manifest or path in extra or _IMPORT.fullmatch(path) or _MODEL.fullmatch(path) or _ASSET.fullmatch(path)
            or (not path.startswith(".") and typed and typed.group(0).lower() != ".waffle"))


DOCUMENTS = {"schematic": ".wsch", "pcb": ".wpcb", "drawing": ".wdraw", "panel": ".wpanel"}
OWNERS = {"library": ("library", ".wlib"), "layoutBlock": ("block", ".wblock"),
          "importIndex": ("importBindings", ".json")}
FUTURE_SUFFIX = re.compile(r"\.w[a-z][a-z0-9-]{0,30}\Z")
RESERVED = frozenset({"assets", "models", "libraries"})


def version(header):
    value = header.get("formatVersion") if isinstance(header, dict) else None
    if not isinstance(value, str) or not re.fullmatch(r"2\.(?:0|[1-9][0-9]{0,8})", value):
        raise ValueError("This revision uses an unsupported Waffle project format.")
    return int(value[2:])


def owner_reference(row, minor):
    tag = row.get("kind")
    if not isinstance(tag, str):
        raise ValueError("Invalid project record kind.")
    if tag == "document":
        kind = row.get("docKind")
        if not isinstance(kind, str) or not kind:
            raise ValueError("Invalid document kind.")
        suffix = DOCUMENTS.get(kind)
    elif tag in OWNERS:
        kind, suffix = OWNERS[tag]
    else:
        return None
    path, identity = portable(row.get("path")), row.get("id")
    parts = path.split("/")
    if not isinstance(identity, str) or not identity or path != unicodedata.normalize("NFC", path):
        raise ValueError("Invalid member identity: " + path)
    root = parts[0].casefold()
    if tag == "importIndex":
        valid = bool(_IMPORT.fullmatch(path)) and parts[-1] != "source"
    elif tag in ("library", "layoutBlock"):
        valid = path.startswith("libraries/") and path.endswith(suffix)
    elif suffix:
        valid = root not in RESERVED and path.endswith(suffix)
    else:
        ext = Path(parts[-1]).suffix
        valid = bool(minor and root not in RESERVED and FUTURE_SUFFIX.fullmatch(ext)
                     and not NATIVE.fullmatch(ext) and kind not in {"project", "block", "library", "snapshot", "importBindings"})
    if not valid or tag != "importIndex" and any(part.startswith(".") for part in parts):
        raise ValueError("Invalid project member path: " + path)
    return path, kind, identity, suffix is None


def json_rows(data):
    for line in io.BytesIO(data):
        row = json.loads(line)
        if not isinstance(row, dict):
            raise ValueError("Invalid project record.")
        yield row


def manifest_references(data):
    rows = json_rows(data)
    header = next(rows, None)
    minor = version(header)
    if header.get("kind") != "project" or not isinstance(header.get("id"), str) or not header["id"]:
        raise ValueError("Invalid project manifest.")
    refs = [ref for row in rows if (ref := owner_reference(row, minor))]
    keys = {ref[0].casefold() for ref in refs}
    if len(refs) >= COUNT or len(refs) != len(keys):
        raise ValueError("Too many or colliding project member paths.")
    return header, refs


def walk_graph(manifest, manifest_data, read, allow, *, binary=None):
    """Enumerate only members authorised by the project graph.

    The archive verifier or Git reader supplies bytes from its own immutable view. The
    semantic codec still validates canonical rows and every content digest.
    """
    header, roots = manifest_references(manifest_data)
    root_minor = version(header)
    pending = deque([(manifest, "project", None, False, False)])
    required = {manifest: ("project", None, False, False)}

    def enqueue(path, kind, identity=None, archived=False, opaque=False, source=None):
        allow(path)
        descriptor = (kind, identity, archived, opaque)
        previous = required.get(path)
        if previous is None:
            if len(required) >= COUNT:
                raise ValueError("Too many required project members.")
            required[path] = descriptor
            if kind == "binary":
                if binary is not None:
                    binary(path, source)
            else:
                pending.append((path, *descriptor))
        elif previous != descriptor:
            raise ValueError("Inconsistent project references: " + path)

    for path, kind, identity, opaque in roots:
        enqueue(path, kind, identity, opaque=opaque)
    while pending:
        path, kind, identity, archived, opaque = pending.popleft()
        raw = manifest_data if path == manifest else read(path)
        lines = iter(io.BytesIO(raw))
        header = json.loads(next(lines, b"null"))
        if not isinstance(header, dict) or header.get("kind") != kind:
            raise ValueError("Invalid project member header: " + path)
        minor = version(header)
        if identity is not None and identity != header.get("id"):
            raise ValueError("Project member identity differs: " + path)
        if not archived and (minor > root_minor or opaque and not minor):
            raise ValueError("The manifest format differs from its member: " + path)
        if opaque:
            continue

        def asset(ref, recorded_kind=None, owner=None):
            digest = ref.get("sha256")
            if not isinstance(digest, str) or not re.fullmatch(HEX, digest):
                raise ValueError("Invalid content identity in " + path)
            target = "models/" + digest + ".step.gz" if ref.get("mediaType") == "model/step" else "assets/" + digest
            child = recorded_kind or ("snapshot" if ref.get("mediaType") == "application/vnd.waffle.snapshot+jsonl" else "binary")
            enqueue(target, child, owner, recorded_kind is not None)

        def visit(value):
            stack = [value]
            while stack:
                item = stack.pop()
                if isinstance(item, dict):
                    if {"sha256", "mediaType", "byteLength"} <= item.keys():
                        asset(item)
                    else:
                        stack.extend(item.values())
                elif isinstance(item, list):
                    stack.extend(item)

        if kind != "importBindings":
            visit(header)
        for line in lines:
            # Canonical keys are literal ASCII. A geometry row without a digest cannot
            # request any file. The codec validates skipped design records later.
            if b'"sha256"' not in line and kind not in ("snapshot", "importBindings"):
                continue
            row = json.loads(line)
            if not isinstance(row, dict):
                raise ValueError("Invalid project record: " + path)
            tag = row.get("kind")
            if kind == "importBindings":
                if tag == "input":
                    digest = row.get("sha256")
                    if not isinstance(digest, str) or not re.fullmatch(HEX, digest):
                        raise ValueError("Invalid retained input identity: " + path)
                    enqueue(".waffle/imports/" + digest + "/source", "binary", source=row)
            elif kind == "snapshot" and tag == "snapshotMember":
                ref, child, owner = row.get("asset"), row.get("fileKind"), row.get("ownerId")
                if not isinstance(ref, dict) or not isinstance(child, str) or child not in {*DOCUMENTS, "project", "library", "block"} or not isinstance(owner, str):
                    raise ValueError("Invalid frozen project member: " + path)
                asset(ref, child, owner)
            else:
                visit(row)
    return required


def member_digest(name, data, extra):
    source, asset, model = _IMPORT.fullmatch(name), _ASSET.fullmatch(name), _MODEL.fullmatch(name)
    native = name in extra or NATIVE.search(name) or (source and source[2] != "source")
    logical = hashlib.sha256(data.replace(b"\r\n", b"\n") if native else data).digest()
    expected = asset[1] if asset else source[1] if source and source[2] == "source" else None
    if expected and expected != logical.hex():
        raise ValueError("Archive digest mismatch: " + name)
    if model:
        raw_hash = hashlib.sha256()
        with gzip.GzipFile(fileobj=io.BytesIO(data)) as inp:
            length = 0
            while chunk := inp.read(65536):
                length += len(chunk)
                if length > ENTRY: raise ValueError("Model exceeds its raw expansion limit: " + name)
                raw_hash.update(chunk)
        if raw_hash.hexdigest() != model[1]: raise ValueError("Raw model identity mismatch: " + name)
    return logical


def verified_digest(manifest, names, read):
    manifest_data = read(manifest)
    manifest_bytes = manifest_data.replace(b"\r\n", b"\n")
    extra = future_documents(manifest_bytes)
    digests = {}

    def allow(path):
        if path not in names:
            raise ValueError("Missing required project member: " + str(path))

    def read_owner(path):
        data = read(path)
        digests[path] = member_digest(path, data, extra)
        return data

    required = walk_graph(manifest, manifest_data, read_owner, allow)
    unexpected = names - required.keys() - {IGNORE}
    if unexpected:
        raise ValueError("Unexpected unreferenced project member: " + min(unexpected))
    paths = sorted(names - {manifest, IGNORE}, key=lambda p:p.encode())
    digest = hashlib.sha256(b"WAFFLE-PROJECT-V1\0" + len(manifest_bytes).to_bytes(8,"big") + manifest_bytes + len(paths).to_bytes(8,"big"))
    for name in paths:
        logical = digests.get(name)
        if logical is None:
            logical = member_digest(name, read(name), extra)
        encoded = name.encode()
        digest.update(len(encoded).to_bytes(4,"big") + encoded + logical)
    return digest.hexdigest()


def verify(root, manifest, members):
    return verified_digest(manifest, set(members), lambda path: (root / path).read_bytes())


def staged_identity(info):
    return info.st_dev, info.st_ino, info.st_mode, info.st_size, info.st_mtime_ns, info.st_ctime_ns


def fsync_dir(path):
    if os.name != "nt":
        fd = os.open(path, os.O_RDONLY | getattr(os,"O_DIRECTORY",0))
        try: os.fsync(fd)
        finally: os.close(fd)


def publish(source, destination):
    if os.name == "nt":
        move = ctypes.WinDLL("kernel32", use_last_error=True).MoveFileExW
        move.argtypes = (ctypes.c_wchar_p,ctypes.c_wchar_p,ctypes.c_ulong)
        if move(str(source),str(destination),8): return
        code = ctypes.get_last_error()
        if code in (80,183): raise FileExistsError(errno.EEXIST,"Destination exists.")
        raise ctypes.WinError(code)
    libc = ctypes.CDLL(None,use_errno=True)
    if sys.platform == "darwin": fn = libc.renameatx_np; flags = 4; atcwd = -2
    elif sys.platform.startswith("linux"):
        fn = libc.renameat2; flags = 1; atcwd = -100
    else: raise OSError("Exclusive project-folder installation is unavailable.")
    fn.argtypes = (ctypes.c_int,ctypes.c_char_p,ctypes.c_int,ctypes.c_char_p,ctypes.c_uint)
    if fn(atcwd, os.fsencode(source), atcwd, os.fsencode(destination), flags) != 0:
        code = ctypes.get_errno()
        raise OSError(code, os.strerror(code))


@contextmanager
def publication_lock(parent):
    # Coordinate Waffle publishers on case-sensitive volumes without creating a tracked
    # lock file in the selected parent. The no-replacement rename also handles other writers.
    if os.name == "nt":
        yield
        return
    import fcntl
    fd = os.open(parent, os.O_RDONLY | getattr(os,"O_DIRECTORY",0))
    try:
        fcntl.flock(fd, fcntl.LOCK_EX)
        yield
    finally:
        os.close(fd)


def within(path, folder):
    """True when path is folder or lies beneath it (after resolving links)."""
    try:
        path, folder = Path(path).resolve(), Path(folder).resolve()
    except OSError:
        return True
    return path == folder or folder in path.parents


def suggest_destination(source, recent_manifests, stem):
    """Where the first Save of an import starts: (folder, free name).

    The folder holding the most recent Waffle project when that exists and lies outside the
    source project folder, else the folder that holds the source project folder. The name follows
    the first-save convention, "Sensor Board", then "Sensor Board (2)" when taken.
    """
    project_folder = Path(source).parent
    start = None
    for manifest in recent_manifests or ():
        manifest = Path(manifest)
        if manifest.suffix.lower() != ".waffle":
            continue
        candidate = manifest.parent.parent
        if not candidate.is_dir():
            continue
        if not within(candidate, project_folder):
            start = candidate
        break
    if start is None:
        start = project_folder.parent
    try:
        stem = portable(str(stem or "Project").replace("/", "-"))
    except ValueError:
        stem = "Project"
    try:
        occupied = {unicodedata.normalize("NFC", entry.name).casefold() for entry in start.iterdir()}
    except OSError:
        occupied = set()
    for i in range(1, 10001):
        name = stem if i == 1 else f"{stem} ({i})"
        if unicodedata.normalize("NFC", name).casefold() not in occupied:
            return start, name
    return start, stem


def install(parent, manifest, rows, version, *, destination_name=None, folder_stem=None, before_publish=None):
    if "/" in portable(manifest) or not manifest.lower().endswith(".waffle") or not isinstance(version,str) or not re.fullmatch(HEX,version):
        raise ValueError("Invalid portable project identity.")
    if not isinstance(rows,list) or not 2 <= len(rows) <= COUNT:
        raise ValueError("Invalid number of portable project members.")
    # An alias/reparse point must not silently redirect a user-selected destination.
    parent = Path(parent)
    # Foundation can spell the system temporary directory under /var or /tmp.
    if sys.platform == "darwin" and len(parent.parts) > 1 and parent.parts[0] == "/" and parent.parts[1] in ("var", "tmp"):
        system_alias = Path("/", parent.parts[1])
        if system_alias.is_symlink() and os.readlink(system_alias) == "private/" + parent.parts[1]:
            parent = Path("/private", *parent.parts[1:])
    if not parent.is_absolute() or not parent.is_dir() or os.path.normcase(str(parent.resolve())) != os.path.normcase(str(parent)):
        raise ValueError("Choose the original destination folder without links.")
    root_id = parent.stat()
    # destination_name is an exact folder chosen in a save panel; folder_stem is a suggested
    # name beneath a chosen parent, which claims a fresh " (2)" suffix when occupied.
    stem = portable(destination_name if destination_name is not None else folder_stem if folder_stem is not None else manifest[:-7])
    if "/" in stem:
        raise ValueError("Choose a single project folder name.")
    names = set()
    entries = {}
    manifest_rows=[r["data"] for r in rows if r.get("path")==manifest]
    if len(manifest_rows)!=1: raise ValueError("Missing or duplicate project manifest.")
    payload=manifest_rows[0]
    if isinstance(payload,str):
        if len(payload)>(ENTRY+2)//3*4: raise ValueError("Manifest exceeds its size limit.")
        payload=base64.b64decode(payload,validate=True)
    extra=future_documents(payload)
    for row in rows:
        path = row["path"]
        if not member(path,manifest,extra): raise ValueError("Unexpected project archive member: " + path)
        for i in range(1,len(path.split("/"))+1):
            part = "/".join(path.split("/")[:i])
            key = unicodedata.normalize("NFC",part).casefold()
            isfile = part == path
            if key in entries and (entries[key][0] != part or entries[key][1] or isfile):
                raise ValueError("Duplicate or colliding archive member: " + part)
            entries[key] = (part,isfile)
        names.add(path)
    if not {manifest,IGNORE} <= names: raise ValueError("Incomplete project archive.")
    try:
        stage = Path(tempfile.mkdtemp(prefix=".waffle-extract-",dir=parent))
    except OSError as error:
        if error.errno in (errno.EROFS,errno.EACCES,errno.EPERM):
            raise ParentNotWritable("Choose a writable project destination.") from error
        raise
    try:
        total=0
        staged={}
        for row in rows:
            target = stage / row["path"]
            raw = row["data"]
            if isinstance(raw,str):
                if len(raw)>((ENTRY+2)//3)*4: raise ValueError("Archive entry exceeds its size limit.")
                raw = base64.b64decode(raw,validate=True)
            if not isinstance(raw,(bytes,bytearray)) or len(raw)>ENTRY: raise ValueError("Archive entry exceeds its size limit.")
            total+=len(raw)
            if total>TOTAL: raise ValueError("Archive exceeds its expanded size limit.")
            target.parent.mkdir(parents=True, exist_ok=True)
            with target.open("xb") as out:
                out.write(raw); out.flush(); os.fsync(out.fileno())
            # Windows may finish updating the write timestamp upon closing the handle.
            info = target.lstat()
            if not stat.S_ISREG(info.st_mode): raise ValueError("The staged archive member changed.")
            staged[target] = staged_identity(info)
        # Keep receipts for files and directories through the publication guard.
        # Directory identities also detect substitutions of intermediate paths.
        for directory in [stage, *(stage / path for path,isfile in entries.values() if not isfile)]:
            info = directory.lstat()
            if not stat.S_ISDIR(info.st_mode): raise ValueError("The staged archive directory changed.")
            staged[directory] = staged_identity(info)

        def check_staged(path):
            try:
                current = staged_identity(path.lstat())
            except FileNotFoundError:
                current = None
            if current != staged[path]:
                raise ValueError("The staged archive changed: " + str(path.relative_to(stage)))

        def read_staged(path):
            target = stage / path
            check_staged(target)
            return target.read_bytes()

        if verified_digest(manifest,names,read_staged) != version:
            raise ValueError("The extracted folder differs from the verified project ZIP.")
        for directory,_,_ in os.walk(stage,topdown=False): fsync_dir(directory)
        if not os.path.samestat(root_id,parent.stat()): raise ValueError("The selected parent folder changed.")
        with publication_lock(parent):
            occupied = {unicodedata.normalize("NFC",entry.name).casefold() for entry in parent.iterdir()}
            for i in range(1, 10001 if destination_name is None else 2):
                dest = parent / (stem if i==1 else f"{stem} ({i})")
                if unicodedata.normalize("NFC",dest.name).casefold() in occupied: continue
                if before_publish is not None: before_publish()
                if not os.path.samestat(root_id,parent.stat()): raise ValueError("The selected parent folder changed.")
                for path in staged: check_staged(path)
                try: publish(stage,dest)
                except FileExistsError: continue
                fsync_dir(parent)
                return dest / manifest
        if destination_name is not None:
            raise FileExistsError("The destination already exists. Choose a new project folder name.")
        raise ValueError("Choose a destination with an available project name.")
    finally:
        if stage.exists(): shutil.rmtree(stage)


def retained_original(root, manifest, binding, input_id):
    # Called while the host's shared read lease is held. The page names an input ID; it cannot
    # request arbitrary Git paths or fields outside the retained scope.
    from import_sources import read_pinned, read_regular
    root = Path(root)
    if "/" in portable(manifest) or not _IMPORT.fullmatch(portable(binding)) or not re.fullmatch(r"input-\d{6}",input_id):
        raise ValueError("Invalid retained import selection.")
    indexes = [json.loads(s) for s in read_regular(root/manifest,root).splitlines()]
    ref = next((r for r in indexes if r.get("kind")=="importIndex" and r.get("path")==binding),None)
    if not ref: raise ValueError("The project does not reference this import.")
    rows = [json.loads(s) for s in read_regular(root/binding,root,128*1048576).splitlines()]
    if not rows or rows[0].get("kind")!="importBindings" or rows[0].get("id")!=ref["id"]:
        raise ValueError("The retained import index differs from its manifest.")
    row = next((r for r in rows if r.get("kind")=="input" and r.get("id")==input_id),None)
    if not row or not isinstance(row.get("sha256"),str) or not re.fullmatch(HEX,row["sha256"]) or type(row.get("byteLength")) is not int or not 0<=row["byteLength"]<=ENTRY:
        raise ValueError("Invalid retained input.")
    sha,length = row["sha256"],row["byteLength"]
    copied = root/".waffle"/"imports"/sha/"source"
    try:
        data = read_regular(copied,root,length)
    except FileNotFoundError:
        if not row.get("git"): raise ValueError("Missing retained original: " + row["name"]) from None
        data = read_pinned(root,row["git"],sha,length)
    if len(data)!=length or hashlib.sha256(data).hexdigest()!=sha: raise ValueError("The retained original has changed: " + row["name"])
    return {"data":base64.b64encode(data).decode(),"length":length,"sha256":sha}


def command(op, arg):
    if op in ("writeExport", "rememberExport", "recallExport", "forgetExport"):
        from import_export import command as foreign_export
        return foreign_export(op, arg)
    if op in ("install","convert"):
        guard = None
        if arg.get("guardFile") is not None:
            from import_export import guard_operation
            guard = lambda: guard_operation(arg)
        dest = install(Path(arg["parent"]),arg["manifest"],arg["files"],arg["version"],
                       destination_name=arg.get("destinationName"),folder_stem=arg.get("folderStem"),before_publish=guard)
        return {"manifest":str(dest)}
    if op=="suggest":
        folder, name = suggest_destination(arg["source"], arg.get("recent"), arg.get("stem"))
        return {"folder":str(folder),"name":name}
    if op=="original":
        return retained_original(arg["root"],arg["manifest"],arg["bindingPath"],arg["inputId"])
    if op=="locate":
        from import_sources import locate
        return {"git":locate(arg["root"],arg["source"],arg["sha256"],arg["byteLength"])}
    if op=="ignore":
        from import_sources import ignore_notice
        return {"notice":ignore_notice(arg["root"])}
    raise ValueError("Unknown project archive operation.")


if __name__=="__main__":
    # Native hosts run Python in isolated mode. Only the installed program directory supplies
    # our companion and the existing Git policy module; the selected project is always data.
    sys.path.insert(0,str(Path(__file__).resolve().parent))
    try:
        value=json.load(sys.stdin)
        print(json.dumps(command(sys.argv[1],value),separators=(",",":")))
    except ParentNotWritable:
        print("WAFFLE-PARENT-READ-ONLY",file=sys.stderr)
        sys.exit(1)
    except (OSError,ValueError,KeyError,TypeError,IndexError) as error:
        print(str(error),file=sys.stderr)
        sys.exit(1)
