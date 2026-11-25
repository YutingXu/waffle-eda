"""Forward a macOS Open Documents event to the existing Altium window."""
import csv
import fcntl
import os
from pathlib import Path, PureWindowsPath
import plistlib
import subprocess
import sys
import tempfile
import time


def open_selection(files):
    resources = Path(__file__).resolve().parent
    with (resources.parent / "Info.plist").open("rb") as info:
        settings = plistlib.load(info)
    root = Path(settings["AltiumWineRoot"])
    prefix = root / "volume/prefix"
    drive = prefix / "drive_c"
    bin_dir = root / "wine-patched/Wine Staging.app/Contents/Resources/wine/bin"
    env = dict(os.environ, WINEPREFIX=str(prefix), WINEDEBUG="-all")
    paths = []
    for name in files:
        path = Path(name).resolve(strict=True)
        if not path.is_file():
            raise ValueError("Choose a file to open in Designer: " + path.name)
        if any(c in str(path) for c in '<>:"|?*\\') or any(ord(c) < 32 for c in str(path)):
            raise ValueError("Windows cannot open a path containing these characters: " + path.name)
        if drive in path.parents:
            guest = PureWindowsPath("C:/", path.relative_to(drive))
        else:
            if (prefix / "dosdevices/z:").resolve() != Path("/"):
                raise ValueError("The installation's Z: mapping for Mac files is unavailable.")
            guest = PureWindowsPath("Z:/", *path.parts[1:])
        paths.append(str(guest))
    if not paths:
        return

    def wine(*args, timeout=10):
        # An idle Wine service can retain stdout after the command has exited.
        with tempfile.TemporaryFile() as log:
            result = subprocess.run([bin_dir / "wine", *map(str, args)], env=env, cwd=drive,
                                    stdin=subprocess.DEVNULL, stdout=log, stderr=subprocess.STDOUT,
                                    timeout=timeout)
            log.seek(0)
            return result.returncode, log.read().decode(errors="replace").strip()

    with (prefix / ".atrium-finder-open.lock").open("a") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        readiness = bin_dir / "altium-ui-ready.exe"
        code, identity = wine(readiness)
        if code == 1 and identity:
            raise ValueError("Finish the open dialog or command in Designer, then try again.")
        if code != 0:
            code, processes = wine("tasklist.exe", "/FO", "CSV", "/NH")
            if code:
                raise ValueError("Could not check whether Designer is already running.")
            running = any(row and row[0].strip().lower() == "x2.exe"
                          for row in csv.reader(processes.splitlines()))
            if not running:
                subprocess.run(["/usr/bin/open", "-a", settings["AltiumMacLauncher"]], check=True)
            deadline = time.monotonic() + 90
            while time.monotonic() < deadline:
                if wine(readiness)[0] == 0:
                    break
                time.sleep(0.8)
            else:
                raise ValueError("Designer is still starting or waiting for a dialog. Try again when it is ready.")

        with tempfile.TemporaryDirectory(prefix="AtriumMacOpen-", dir=drive) as request:
            stage = Path(request)
            guest = PureWindowsPath("C:/", stage.name)
            (stage / "files.txt").write_bytes(("\r\n".join(paths) + "\r\n").encode("utf-16"))
            script = (resources / "OpenFiles.pas").read_text("ascii").replace("@DIR@", str(guest))
            (stage / "OpenFiles.pas").write_bytes(script.replace("\n", "\r\n").encode("ascii"))
            command = f"-RScriptingSystem:RunScriptFile(FileName={guest / 'OpenFiles.pas'}|ProcName=OpenSelection)"
            code, output = wine(resources / "RunDesigner.exe", settings["AltiumWindowsExecutable"],
                                command, guest / "result.txt", "90000", "--existing", timeout=96)
            if code:
                reason = next((s[14:] for s in output.splitlines() if s.startswith("Altium check: ")), "")
                raise ValueError(reason or "Designer did not finish opening the selection.")
            data = (stage / "result.txt").read_bytes()
            codec = "utf-16" if data.startswith((b"\xff\xfe", b"\xfe\xff")) else "utf-8-sig"
            report = data.decode(codec).strip()
            if report != "OK":
                raise ValueError(report or "Designer did not confirm the selection.")


if __name__ == "__main__":
    try:
        open_selection(sys.argv[1:])
    except (OSError, ValueError, subprocess.SubprocessError) as error:
        sys.exit(str(error))
