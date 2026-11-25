"""Coordinate locally generated output manifests across Waffle processes."""
import contextlib
import hashlib
import os
import sys
import time


@contextlib.contextmanager
def save_lock(project, attempts=20):
    """The hosts' cross-process save lock for the project's folder (they never wait; this retries briefly)."""
    folder = os.path.dirname(os.path.realpath(str(project)))
    if sys.platform == "win32":
        release = _windows_mutex(folder, attempts)
        try:
            yield
        finally:
            release()
        return
    import fcntl
    fd = os.open(folder, os.O_RDONLY)
    try:
        for n in range(attempts):
            try:
                fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
                break
            except BlockingIOError:
                if n == attempts - 1:
                    raise ValueError("Waffle is saving this project. Nothing was written. Retry in a moment.") from None
                time.sleep(0.05)
        yield
    finally:
        os.close(fd)


def _windows_mutex(folder, attempts):
    # native/windows/src/Win/WinFs.cs TryLockFolder: "Local\\Atrium.save." + 16 bytes of SHA-256(upper-case folder).
    try:
        import ctypes
        kernel = ctypes.WinDLL("kernel32", use_last_error=True)
        kernel.CreateMutexW.restype = ctypes.c_void_p
        kernel.CreateMutexW.argtypes = (ctypes.c_void_p, ctypes.c_int, ctypes.c_wchar_p)
        kernel.WaitForSingleObject.argtypes = (ctypes.c_void_p, ctypes.c_uint32)
        kernel.ReleaseMutex.argtypes = kernel.CloseHandle.argtypes = (ctypes.c_void_p,)
        name = "Local\\Atrium.save." + hashlib.sha256(folder.upper().encode("utf-8")).hexdigest()[:32].upper()
        handle = kernel.CreateMutexW(None, False, name)
    except (OSError, AttributeError):
        return lambda: None
    if not handle:
        return lambda: None
    for n in range(attempts):
        if kernel.WaitForSingleObject(handle, 0) in (0, 0x80):  # WAIT_OBJECT_0, WAIT_ABANDONED
            def release():
                kernel.ReleaseMutex(handle)
                kernel.CloseHandle(handle)
            return release
        time.sleep(0.05)
    kernel.CloseHandle(handle)
    raise ValueError("Waffle is saving this project. Nothing was written. Retry in a moment.")
