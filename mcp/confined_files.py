"""File handles for MCP's explicitly granted inputs and generated-output folders."""
from contextlib import contextmanager, ExitStack
import errno
import os
from pathlib import Path
import secrets
import shutil
import stat


def linked(info):
    return stat.S_ISLNK(info.st_mode) or bool(getattr(info, "st_file_attributes", 0) & stat.FILE_ATTRIBUTE_REPARSE_POINT)


class Directory:
    def __init__(self, path, fd):
        self.path, self.fd = path, fd

    def name(self, name):
        if not name or name in (".", "..") or "/" in name or "\\" in name:
            raise ValueError("Invalid file name.")
        return self.path / name if self.fd is None else name

    def stat(self, name):
        try:
            return os.stat(self.name(name), dir_fd=self.fd, follow_symlinks=False)
        except FileNotFoundError:
            return None

    def open(self, name, flags):
        return os.open(self.name(name), flags | getattr(os, "O_BINARY", 0) | getattr(os, "O_NOFOLLOW", 0) |
                       getattr(os, "O_NONBLOCK", 0), 0o600, dir_fd=self.fd)

    def temporary(self, prefix=".waffle-", suffix=".tmp", *, token=None, attempts=1):
        token = token or (lambda: secrets.token_hex(16))
        for attempt in range(attempts):
            name = prefix + token() + suffix
            try:
                return name, self.open(name, os.O_RDWR | os.O_CREAT | os.O_EXCL)
            except FileExistsError:
                if attempt + 1 == attempts:
                    raise

    def replace(self, src, dst):
        os.replace(self.name(src), self.name(dst), src_dir_fd=self.fd, dst_dir_fd=self.fd)

    def install_new(self, src, dst):
        """Publish a complete temporary file without replacing any existing name."""
        staged = self.stat(src)
        if os.name == "nt":
            os.rename(self.name(src), self.name(dst))  # Windows rename refuses an existing target.
            return staged
        try:
            os.link(self.name(src), self.name(dst), src_dir_fd=self.fd, dst_dir_fd=self.fd, follow_symlinks=False)
            return staged
        except OSError as error:
            if error.errno not in (errno.EOPNOTSUPP, errno.EPERM, errno.ENOSYS):
                raise
        # Some removable filesystems have no hard links. Write exclusively to one opened
        # descriptor there, and clean up only the file we created if the copy fails.
        with os.fdopen(self.open(src, os.O_RDONLY), "rb") as source:
            with os.fdopen(self.open(dst, os.O_WRONLY | os.O_CREAT | os.O_EXCL), "wb") as target:
                ours = os.fstat(target.fileno())
                try:
                    shutil.copyfileobj(source, target, length=1024 * 1024)
                    target.flush()
                    os.fsync(target.fileno())
                except BaseException:
                    self.remove_if_same(dst, ours)
                    raise
                return ours

    def remove_if_same(self, name, info):
        current = self.stat(name)
        if current and os.path.samestat(current, info):
            self.remove(name)

    def remove(self, name):
        try:
            os.unlink(self.name(name), dir_fd=self.fd)
        except FileNotFoundError:
            pass

    @contextmanager
    def reading(self, name):
        info = self.stat(name)
        if info is None or linked(info) or not stat.S_ISREG(info.st_mode):
            raise ValueError("Choose a regular file inside the granted folder.")
        with os.fdopen(self.open(name, os.O_RDONLY), "rb") as stream:
            opened = os.fstat(stream.fileno())
            if not os.path.samestat(info, opened) or not stat.S_ISREG(opened.st_mode):
                raise ValueError("The file changed while it was opened.")
            yield stream, opened

    def read(self, name, cap):
        with self.reading(name) as (stream, opened):
            if cap is None:
                return stream.read()
            if opened.st_size <= cap:
                data = bytearray()
                while len(data) <= cap:
                    chunk = stream.read(min(1024 * 1024, cap + 1 - len(data)))
                    if not chunk:
                        return bytes(data)
                    data.extend(chunk)
        raise ValueError("The input files exceed the size limit.")


@contextmanager
def directory(root, parts=(), create=False):
    """Pin each directory while descending. Unix uses openat; Windows denies rename/delete."""
    path = Path(root)
    with ExitStack() as stack:
        fd = None

        def hold(folder, segment=None):
            if os.name == "nt":
                import _winapi
                # FILE_READ_ATTRIBUTES, share read/write, OPEN_EXISTING, backup semantics + open reparse point.
                handle = _winapi.CreateFile(str(folder), 0x80, 3, 0, 3, 0x02200000, 0)
                stack.callback(_winapi.CloseHandle, handle)
                info = folder.lstat()
                if linked(info) or not stat.S_ISDIR(info.st_mode):
                    raise ValueError("Refusing a symbolic link or non-directory in the output or input path.")
                return None
            flags = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW
            result = os.open(segment if segment is not None else folder, flags, dir_fd=fd)
            stack.callback(os.close, result)
            return result

        try:
            fd = hold(path)
            for part in parts:
                entry = Directory(path, fd).name(part)
                path = path / part
                if create:
                    try:
                        os.mkdir(entry, dir_fd=fd)
                    except FileExistsError:
                        pass
                fd = hold(path, part)
        except OSError as error:
            raise ValueError("Cannot open the folder. Refusing a symbolic link or unavailable directory.") from error
        yield Directory(path, fd)


def read_input(path, roots, cap):
    for root in roots:
        if root in path.parents:
            with directory(root, path.parent.relative_to(root).parts) as parent:
                return parent.read(path.name, cap)
    raise ValueError("Choose a file inside a granted folder.")
