"""Plan project windows in the selected MCP workspace using the same layout engine."""

from contextlib import contextmanager
import json
import os
from pathlib import Path
import stat
import uuid

from board_runner import APP
import confined_files


MODULES = {"window-workspace": (APP / "native-bridge/window-workspace.js", (), False)}
STATE = "project-windows-headless-v1.json"
LOCK = "project-windows-headless-v1.lock"
LIMIT = 1 << 20  # Same bound as the native local workspace file.


def regular(info):
    return info is not None and not confined_files.linked(info) and stat.S_ISREG(info.st_mode) and info.st_nlink == 1


def read(directory):
    info = directory.stat(STATE)
    if info is None:
        return None
    if not regular(info):
        raise ValueError("The local workspace layout is not a private regular file.")
    record = json.loads(directory.read(STATE, LIMIT))
    if not isinstance(record, dict):
        raise ValueError("Invalid local workspace layout.")
    return record


@contextmanager
def locked(directory):
    fd = directory.open(LOCK, os.O_RDWR | os.O_CREAT)
    try:
        opened = os.fstat(fd)
        current = directory.stat(LOCK)
        if not regular(opened) or not regular(current) or not os.path.samestat(opened, current):
            raise ValueError("The local workspace lock changed while opening it.")
        if os.name == "nt":
            import msvcrt
            if not opened.st_size:
                os.write(fd, b"\0")
            os.lseek(fd, 0, os.SEEK_SET)
            msvcrt.locking(fd, msvcrt.LK_LOCK, 1)
        else:
            import fcntl
            fcntl.flock(fd, fcntl.LOCK_EX)
        current = directory.stat(LOCK)
        if not regular(current) or not os.path.samestat(opened, current):
            raise ValueError("The local workspace lock changed before the update.")
        yield
    finally:
        os.close(fd)


def write(directory, value):
    payload = json.dumps(value, separators=(",", ":"), ensure_ascii=False).encode()
    if len(payload) > LIMIT:
        raise ValueError("The local workspace layout exceeds its size limit.")
    old = directory.stat(STATE)
    if old is not None and not regular(old):
        raise ValueError("The local workspace layout is not a private regular file.")
    temporary, fd = directory.temporary(prefix=".project-windows-")
    try:
        with os.fdopen(fd, "wb") as stream:
            stream.write(payload)
            stream.flush()
            os.fsync(stream.fileno())
        directory.replace(temporary, STATE)
        if directory.fd is not None:
            os.fsync(directory.fd)
    finally:
        directory.remove(temporary)


def load_only(root):
    # Missing local state is the initial virtual workspace. A symlink in an
    # existing component is still refused by the descriptor-based reader.
    for part in (root / ".waffle", root / ".waffle" / "local"):
        try:
            info = part.lstat()
        except FileNotFoundError:
            return None
        if confined_files.linked(info) or not stat.S_ISDIR(info.st_mode):
            raise ValueError("The local project state is not an ordinary folder.")
    with confined_files.directory(root, [".waffle", "local"]) as directory:
        return read(directory)


def invoke(automation, local_id, args, mode, run):
    from automation import ToolError

    project = automation.server.folder
    if project is None:
        raise ToolError("Select a native Waffle project to use workspace layouts.", "unsupported_surface")
    info = project.list_documents()
    project_id = info["project_id"]
    members = [document["id"] for document in info["documents"]]
    if not members:
        raise ToolError("The project has no editable windows.", "unsupported_surface")
    root = Path(automation.server.path).parent
    initial = str(uuid.uuid5(uuid.NAMESPACE_URL, "waffle-virtual-project-window:" + project_id))
    new = str(uuid.uuid4())

    def execute(record):
        receipt = run(native={"project": project_id, "members": members, "active": members[0],
                              "initialWindow": initial, "newWindow": new, "record": record})
        private = receipt.get("untrusted_design_text", {})
        return receipt, private.pop("next", None)

    try:
        if mode != "write":
            receipt, _ = execute(load_only(root))
            return dict(receipt, virtual=True)
        with confined_files.directory(root, [".waffle", "local"], create=True) as directory:
            with locked(directory):
                receipt, next_record = execute(read(directory))
                if next_record is None:
                    raise ValueError("The workspace command returned no state to write.")
                write(directory, next_record)
        return dict(receipt, virtual=True)
    except (OSError, ValueError) as error:
        raise ToolError("The selected project's local workspace is unavailable. " + str(error), "workspace_storage") from error
