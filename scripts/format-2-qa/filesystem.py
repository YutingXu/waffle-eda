#!/usr/bin/env python3
"""Exercise real filesystem write failures in private projects and a bounded disposable volume."""
import argparse
import base64
import errno
import json
import os
from pathlib import Path
import platform
import resource
import signal
import subprocess
import tempfile
import time
from contextlib import contextmanager

from crash import ASSET, Driver, PROJECT, case, check_namespace, descriptor, digest, seed


def large_asset(c):
    body = bytes(range(256)) * 32768
    old = c.request["plan"][0]["path"]
    path = "assets/" + digest(body)
    c.after[path] = body
    del c.after[old]
    c.request["plan"][0].update(path=path, data=base64.b64encode(body).decode())
    sheet = c.after["Power.wsch"].replace(old[7:].encode(), path[7:].encode())
    sheet = sheet.replace(b'"byteLength":' + str(len(ASSET)).encode(), b'"byteLength":' + str(len(body)).encode())
    c.after["Power.wsch"] = sheet
    c.request["plan"][1]["data"] = base64.b64encode(sheet).decode()
    return c


def assert_failed(root, c, result, committed):
    if not result.returncode:
        raise ValueError("A real write error went unreported")
    rows = [json.loads(row) for row in result.stdout.splitlines()]
    if not any("error" in row for row in rows):
        raise ValueError("The native driver did not surface the storage error")
    if not committed and (descriptor(root) is not None or any(row.get("saved") for row in rows)):
        raise ValueError("The failed prepare published new bytes")
    if committed and descriptor(root) is None:
        raise ValueError("The failed apply discarded the committed journal")
    check_namespace(root, c.before)
    return {"ack": any(row.get("saved") for row in rows), "message": rows[-1]["error"]}


def run_command(driver, root, c, **opts):
    return subprocess.run([*driver.command, str(root), PROJECT, "commit"],
                          input=json.dumps(c.request).encode(), capture_output=True,
                          env=driver.environment, timeout=30, **opts)


def deny_stage(driver, parent):
    with tempfile.TemporaryDirectory(dir=parent) as folder:
        root = Path(folder)
        c = case("asset")
        seed(root, c.before)
        driver.recover(root)
        j = root / ".waffle/journal"
        j.mkdir(parents=True, exist_ok=True)
        j.chmod(0o500)
        try:
            result = assert_failed(root, c, run_command(driver, root, c), False)
        finally:
            j.chmod(0o700)
        driver.recover(root)
        check_namespace(root, c.before)
        return result


def partial_write(driver, parent):
    def bounded():
        signal.signal(signal.SIGXFSZ, signal.SIG_IGN)
        resource.setrlimit(resource.RLIMIT_FSIZE, (65536, 65536))
    with tempfile.TemporaryDirectory(dir=parent) as folder:
        root = Path(folder)
        c = large_asset(case("asset"))
        seed(root, c.before)
        result = assert_failed(root, c, run_command(driver, root, c, preexec_fn=bounded), False)
        driver.recover(root)
        check_namespace(root, c.before)
        return result


@contextmanager
def volume(parent):
    if platform.system() != "Darwin":
        raise ValueError("For this runner the bounded-volume test requires macOS hdiutil")
    with tempfile.TemporaryDirectory(dir=parent) as temp:
        loc = Path(temp)
        mount = loc / "mount"
        image = loc / "reserved.dmg"
        mount.mkdir()
        subprocess.run(["hdiutil", "create", "-quiet", "-size", "24m", "-fs", "HFS+", "-layout", "NONE", "-type", "UDIF",
                        "-volname", "WaffleScratch", str(image)], check=True, timeout=30)
        subprocess.run(["hdiutil", "attach", "-quiet", "-nobrowse", "-noautoopen", "-owners", "on",
                        "-mountpoint", str(mount), str(image)], check=True, timeout=30)
        try:
            if mount.stat().st_dev == loc.stat().st_dev:
                raise ValueError("The test image did not mount on a distinct filesystem")
            yield mount
        finally:
            subprocess.run(["hdiutil", "detach", "-quiet", str(mount)], check=True, timeout=30)


def occupy(volume_path, filler):
    # This must never fill the host filesystem. Both filesystem identity and capacity are checked.
    fs = os.statvfs(volume_path)
    if fs.f_blocks * fs.f_frsize > 32 * 1024 ** 2 or volume_path.stat().st_dev == volume_path.parent.stat().st_dev:
        raise ValueError("Refusing to fill anything other than the bounded scratch volume")
    data = b"\xa5" * 65536
    with filler.open("wb", buffering=0) as stream:
        for index in range(1024):
            try:
                stream.write(data)
                if index % 16 == 0:
                    os.fsync(stream.fileno())
            except OSError as error:
                if error.errno == errno.ENOSPC:
                    break
                raise
        else:
            raise ValueError("The bounded image did not report ENOSPC")


def no_space(driver, parent):
    results = {}
    with volume(parent) as disk:
        for stage in ("prepare", "apply"):
            with tempfile.TemporaryDirectory(dir=disk) as folder:
                root = Path(folder)
                c = large_asset(case("asset"))
                seed(root, c.before)
                filler = disk / "space-reservation"
                if stage == "prepare":
                    occupy(disk, filler)
                    try:
                        results[stage] = assert_failed(root, c, run_command(driver, root, c), False)
                    finally:
                        filler.unlink()
                    driver.recover(root)
                    check_namespace(root, c.before)
                else:
                    gate = parent / ("gate-" + root.name)
                    p = driver.start(root, "commit", c.request, {"WAFFLE_FOLDER_PAUSE": "acknowledged", "WAFFLE_FOLDER_GATE": str(gate)})
                    try:
                        deadline = time.monotonic() + 10
                        while not Path(str(gate) + ".ready").exists():
                            if time.monotonic() > deadline or p.poll() is not None:
                                raise ValueError("The actual staging writer did not reach its acknowledgement")
                            time.sleep(.01)
                        occupy(disk, filler)
                        Path(str(gate) + ".resume").touch()
                        stdout, stderr = p.communicate(timeout=15)
                        results[stage] = assert_failed(root, c, subprocess.CompletedProcess(p.args,p.returncode,stdout,stderr), True)
                    finally:
                        if p.poll() is None:
                            p.kill()
                            p.communicate()
                        filler.unlink(missing_ok=True)
                        for suffix in (".ready", ".resume"):
                            Path(str(gate) + suffix).unlink(missing_ok=True)
                    driver.recover(root)
                    check_namespace(root, c.after)
    return results


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root", type=Path, required=True)
    parser.add_argument("--out", type=Path, required=True)
    parser.add_argument("--image", action="store_true")
    parser.add_argument("driver", nargs=argparse.REMAINDER)
    o = parser.parse_args()
    args = o.driver[1:] if o.driver[:1] == ["--"] else o.driver
    d = Driver(args)
    results = {}
    try:
        results["deniedJournalDirectory"] = deny_stage(d, o.root)
        results["fileSizeLimit"] = partial_write(d, o.root)
        if o.image:
            results["boundedENOSPC"] = no_space(d, o.root)
        results["complete"] = True
    finally:
        o.out.write_text(json.dumps(results, indent=2) + "\n")


if __name__ == "__main__":
    main()
