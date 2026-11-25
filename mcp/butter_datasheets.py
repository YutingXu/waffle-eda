"""Approved PDF inputs and isolated headless PDF.js operations."""
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import stat
import subprocess
import sys
import tempfile

from board_runner import APP

MODULES = {
    "datasheet-record": (APP / "notebook/datasheet-record.js", (), False),
    "link-record": (APP / "project/link-record.js", (), False),
}
LIMIT = 128 << 20
CACHE_LIMIT = 512 << 20
HASH = re.compile(r"[0-9a-f]{64}\Z")
ALIAS = re.compile(r"[A-Za-z0-9][A-Za-z0-9_-]{0,63}\Z")


def configure_inputs(inputs, enabled):
    if not enabled or len(inputs) > 32:
        raise ValueError("Enable datasheets and grant at most 32 selected PDF inputs.")
    grants = {}
    for assignment in inputs:
        alias, sep, raw = assignment.partition("=")
        path = Path(raw).absolute()
        if not sep or not raw or not ALIAS.fullmatch(alias) or alias in grants or path.suffix.lower() != ".pdf":
            raise ValueError("Use a distinct alias and a selected PDF for each datasheet input.")
        found = path.lstat()
        if not stat.S_ISREG(found.st_mode) or not 0 < found.st_size <= LIMIT:
            raise ValueError("Select a regular PDF up to 128 MiB without links.")
        grants[alias] = (path, found.st_dev, found.st_ino)
    return grants


def cache():
    if os.name == "nt":
        root = Path(os.environ.get("LOCALAPPDATA") or Path.home() / "AppData/Local")
    elif sys.platform == "darwin":
        root = Path(os.environ.get("XDG_CACHE_HOME") or Path.home() / "Library/Caches")
    else:
        root = Path(os.environ.get("XDG_CACHE_HOME") or Path.home() / ".cache")
    folder = root / "waffle" / "datasheets"
    folder.mkdir(mode=0o700, parents=True, exist_ok=True)
    info = folder.lstat()
    if not stat.S_ISDIR(info.st_mode) or (os.name != "nt" and
            (info.st_uid != os.getuid() or stat.S_IMODE(info.st_mode) & 0o077)):
        raise OSError("The private datasheet cache is unavailable.")
    return folder


def read_regular(path, expected=None):
    if path.is_symlink():
        raise OSError("The selected PDF is a link.")
    with os.fdopen(os.open(path, os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0) |
                          getattr(os, "O_BINARY", 0) | getattr(os, "O_NONBLOCK", 0)), "rb") as file:
        info = os.fstat(file.fileno())
        if not stat.S_ISREG(info.st_mode) or not 0 < info.st_size <= LIMIT or (
                expected and (info.st_dev, info.st_ino) != expected):
            raise OSError("The selected PDF changed. Grant it again.")
        raw = file.read(LIMIT + 1)
        end = os.fstat(file.fileno())
        if len(raw) != info.st_size or end.st_mtime_ns != info.st_mtime_ns:
            raise OSError("The selected PDF changed during the read.")
    return raw


def read_input(server, alias):
    from automation import ToolError
    scoped = server.datasheet_inputs.get(alias)
    if not scoped:
        raise ToolError("Grant the chosen PDF to this workspace before opening it.", "datasheet_grant_required")
    path, device, inode = scoped
    try:
        raw = read_regular(path, (device, inode))
    except OSError:
        raise ToolError("The selected PDF changed or is unavailable. Grant it again.", "source_changed") from None
    if not raw.startswith((b"%PDF-", b"\xef\xbb\xbf%PDF-")):
        raise ToolError("The selected file is not a supported PDF.", "invalid_pdf")
    sha256 = hashlib.sha256(raw).hexdigest()
    title = "".join(c for c in path.stem if ord(c) >= 32 and ord(c) != 127)[:255].strip() or "Datasheet"
    return raw, {"sha256": sha256, "byteLength": len(raw), "title": title}


def save_cache(raw, ref):
    folder = cache()
    target = folder / ref["sha256"]
    tmp = None
    try:
        with tempfile.NamedTemporaryFile(dir=folder, prefix=".selected-", delete=False) as stream:
            tmp = Path(stream.name)
            stream.write(raw)
        os.replace(tmp, target)
    finally:
        if tmp is not None:
            tmp.unlink(missing_ok=True)
    entries = []
    for path in folder.iterdir():
        if HASH.fullmatch(path.name):
            try:
                meta = path.lstat()
            except FileNotFoundError:
                continue
            if stat.S_ISREG(meta.st_mode):
                entries.append((meta.st_mtime, path, meta.st_size))
    total = 0
    for i, (_, path, size) in enumerate(sorted(entries, reverse=True)):
        total += size
        if i >= 256 or total > CACHE_LIMIT:
            path.unlink(missing_ok=True)


def linked_input(server, identity):
    from automation import ToolError
    if not server.folder_files:
        raise ToolError("Open a Waffle project folder first.", "missing_datasheet")
    folder = server.folder
    with server.folder_files.snapshot() as (read, seen):
        manifest = server.folder_files.path.name
        raw = read(manifest)
        if seen[manifest] != folder.last["read_set"].get(manifest):
            raise ToolError("The saved datasheet reference changed. Read again and retry.", "stale_source")
        rows = (json.loads(line) for line in raw.splitlines()[1:] if line.strip())
        row = next((r for r in rows if r.get("kind") == "datasheetRef" and r.get("id") == identity), None)
        if not row:
            raise ToolError("Choose a datasheet referenced by this project.", "missing_datasheet")
        ref = row["value"]
        digest = ref["sha256"]
        if not HASH.fullmatch(digest):
            raise ToolError("The saved datasheet identity is invalid.", "invalid_pdf")
        if ref.get("asset"):
            data = read("assets/" + digest)
        else:
            try:
                path = cache() / digest
                data = read_regular(path)
                os.utime(path, None, follow_symlinks=False)
            except OSError:
                raise ToolError("The PDF is absent from the private cache. Grant the original PDF.", "missing_datasheet") from None
    if len(data) != ref["byteLength"] or hashlib.sha256(data).hexdigest() != digest:
        raise ToolError("The PDF no longer matches this reference.", "source_changed")
    return data, ref


def extract(op, args, raw, *, timeout=20):
    from automation import ToolError
    node = shutil.which("node")
    if not node:
        raise ToolError("Headless PDF.js needs Node.js 24 or newer.", "pdf_unavailable")
    here = Path(__file__).resolve().parent
    command = [node, "--permission", "--max-old-space-size=384",
               "--allow-fs-read=" + str(here), "--allow-fs-read=" + str(APP)]
    canvas_root = None
    if op in ("snip", "image"):
        # Optional canvas backend is installed by the process owner, never by a
        # command, project, or PDF. Grant only its dedicated node_modules root.
        canvas_root = Path(os.environ.get("WAFFLE_PDF_CANVAS_ROOT") or here.parent).resolve()
        command += ["--allow-addons", "--allow-fs-read=" + str(canvas_root)]
    command += [str(here / "datasheet-pdf.js"), op, json.dumps(args, separators=(",", ":"))]
    # Do not inherit startup scripts or library search paths into the renderer.
    runtime_env = {key: os.environ[key] for key in ("SystemRoot", "WINDIR") if key in os.environ}
    if canvas_root:
        runtime_env.update(WAFFLE_PDF_CANVAS_ROOT=str(canvas_root), DISABLE_SYSTEM_FONTS_LOAD="1")
    try:
        result = subprocess.run(command, input=raw, capture_output=True, env=runtime_env, timeout=timeout)
        data = json.loads(result.stdout)
        if not isinstance(data, dict):
            raise ValueError("Invalid PDF worker reply.")
    except subprocess.TimeoutExpired:
        raise ToolError("The datasheet reader exceeded its time limit.", "pdf_timeout") from None
    except (OSError, ValueError):
        raise ToolError("Headless PDF.js could not start. Use Node.js 24 or newer.", "pdf_unavailable") from None
    if result.returncode:
        raise ToolError(data.get("error", "The PDF operation failed."), data.get("code", "invalid_pdf"))
    return data


def invoke(automation, op, args, mode, run):
    from automation import ToolError
    server = automation.server
    if op == "reference":
        if args.get("existingId") and not args.get("embed"):
            raise ToolError("Choose explicit embedding to update an existing PDF reference.", "invalid_arguments")
        if args.get("embed") and mode not in ("plan", "write"):
            raise ToolError("Embedding bytes requires explicit write mode.", "write_not_allowed")
        raw, ref = read_input(server, args["grant"])
        if not args.get("embed"):
            if mode != "plan":
                try:
                    save_cache(raw, ref)
                except OSError:
                    raise ToolError("The private datasheet cache could not retain the PDF.", "cache_unavailable") from None
            return run(native={"reference": ref})
        ref["asset"] = {"sha256":ref["sha256"], "byteLength":ref["byteLength"], "mediaType":"application/pdf"}
        if mode == "plan":
            return run(native={"reference": ref})
        automation._approved_datasheet_bytes = {ref["sha256"]: raw}
        try:
            return run(native={"reference": ref})
        finally:
            automation._approved_datasheet_bytes = {}
    raw, ref = linked_input(server, args["id"])
    pdf_op = "info" if op == "annotate" else op
    options = {} if op == "annotate" else {k:v for k,v in args.items() if k != "id"}
    return run(native={"reference": ref, "pdf": extract(pdf_op, options, raw)})
