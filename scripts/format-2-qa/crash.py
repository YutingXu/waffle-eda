#!/usr/bin/env python3
"""Kill a real format-2 native CLI at each reported boundary and check saved bytes independently.

Run with Python 3.9+ as: crash.py --out result.json -- /path/to/native-driver [driver arguments]
Every mutating operation uses a new private temporary folder. The driver takes ROOT MANIFEST COMMAND
and a bridge request as JSON on stdin. Its test-only fault hooks are described in the format review.
"""
import argparse
import base64
import errno
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import signal
import subprocess
import tempfile
import time
from dataclasses import dataclass


def digest(data):
    return hashlib.sha256(data).hexdigest()


def lines(*rows):
    return b"".join(json.dumps(row, ensure_ascii=False, separators=(",", ":")).encode() + b"\n" for row in rows)


PROJECT = "Sensor.waffle"
HEADER = {"kind": "project", "formatVersion": "2.0", "id": "p1", "name": "Sensor"}
SHEET = {"kind": "schematic", "formatVersion": "2.0", "id": "s1"}
PCB = {"kind": "pcb", "formatVersion": "2.0", "id": "b1"}
CHILD = {"kind": "schematic", "formatVersion": "2.0", "id": "s2"}
LABEL = {"kind": "netlabel", "id": "n1", "at": [1270000, 2540000], "text": "SENSE"}
MOVED = {**LABEL, "at": [1397000, 2540000]}
# A synthetic, one-pixel PNG. None of the ten benchmark inputs enter the fault suite.
ASSET = base64.b64decode("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jZFcAAAAASUVORK5CYII=")
ASSET_PATH = "assets/" + digest(ASSET)
IMAGE = {"kind": "image", "id": "img1", "asset": {"byteLength": len(ASSET), "mediaType": "image/png", "sha256": digest(ASSET)}}
META = "notes/untouched.txt"


def manifest(power="Power", child=False):
    docs = [{"kind": "document", "id": "b1", "docKind": "pcb", "name": "Main", "path": "Main.wpcb"},
            {"kind": "document", "id": "s1", "docKind": "schematic", "name": power.split("/")[-1], "path": power + ".wsch"}]
    if child:
        docs.append({"kind": "document", "id": "s2", "docKind": "schematic", "name": "Child", "path": "Child.wsch"})
    return lines(HEADER, *docs)


@dataclass
class Case:
    before: dict
    after: dict
    request: dict


def case(name):
    before = {PROJECT: manifest(), "Power.wsch": lines(SHEET, LABEL), "Main.wpcb": lines(PCB), META: b"untouched\n"}
    if name == "delete-asset":
        before[PROJECT] = manifest(child=True)
        before["Child.wsch"] = lines(CHILD)
    after = dict(before)
    plan = []

    def set_file(path, data, *, splice=False):
        old = before.get(path)
        op = {"path": path, "expected": digest(old) if old is not None else None}
        if data is None:
            op["remove"] = True
            del after[path]
        else:
            after[path] = data
            if splice:
                offset = old.index(b"1270000")
                op["splice"] = {"base": digest(old), "edits": [{"offset": offset, "remove": 7, "insert": "1397000"}]}
            else:
                op["data"] = base64.b64encode(data).decode("ascii")
        plan.append(op)

    if name == "edit":
        set_file("Power.wsch", lines(SHEET, MOVED), splice=True)
    elif name == "pair":
        set_file("Power.wsch", lines(SHEET, MOVED))
        set_file("Main.wpcb", lines(PCB, {"kind": "track", "id": "t1", "points": [[0, 0], [254000, 0]], "width": 200000}))
    elif name == "asset":
        set_file(ASSET_PATH, ASSET)
        set_file("Power.wsch", lines(SHEET, IMAGE, LABEL))
    elif name == "child-asset":
        set_file(ASSET_PATH, ASSET)
        set_file("Child.wsch", lines(CHILD, IMAGE))
        set_file(PROJECT, manifest(child=True))
    elif name == "delete-asset":
        set_file(ASSET_PATH, ASSET)
        set_file("Power.wsch", lines(SHEET, IMAGE, MOVED))
        set_file("Main.wpcb", lines(PCB, {"kind": "track", "id": "t1", "points": [[0, 0], [254000, 0]], "width": 200000}))
        set_file("Child.wsch", None)
        set_file(PROJECT, manifest())
    elif name in ("rename", "cross-folder", "case-only"):
        new = {"rename": "Supply", "cross-folder": "Sheets/Supply", "case-only": "power"}[name]
        contents = before["Power.wsch"]
        if name == "case-only":
            set_file("Power.wsch", None)
        set_file(new + ".wsch", contents)
        if name != "case-only":
            set_file("Power.wsch", None)
        set_file(PROJECT, manifest(new))
    else:
        raise ValueError(name)
    return Case(before, after, {"projectId": "p1", "manifest": PROJECT, "plan": plan})


def seed(root, files):
    for name, data in files.items():
        path = root / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(data)


def authored(root):
    return {p.relative_to(root).as_posix(): p.read_bytes() for p in root.rglob("*")
            if p.is_file() and p.relative_to(root).parts[0] != ".waffle"}


def check_namespace(root, expected):
    actual = authored(root)
    assert actual == expected, "wrong saved namespace: " + ", ".join(sorted(
        key for key in expected.keys() | actual.keys() if expected.get(key) != actual.get(key)))


def check_case(root, case_data, installed):
    desired, other = ((case_data.after, case_data.before) if installed else (case_data.before, case_data.after))
    check_namespace(root, desired)
    entries = {p.relative_to(root).as_posix() for p in root.rglob("*")}
    wrongly_present = (other.keys() - desired.keys()) & entries
    assert not wrongly_present, "absent file paths became occupied: " + ", ".join(sorted(wrongly_present))


def descriptor(root):
    active = root / ".waffle/journal/active"
    if not active.exists():
        return None
    magic, checksum, payload = active.read_bytes().split(b"\n", 2)
    assert magic == b"WAFFLE-TXN 1" and checksum.decode("ascii") == digest(payload)
    assert payload.endswith(b"\n")
    decoded = json.loads(payload)
    canonical = json.dumps(decoded, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode() + b"\n"
    assert payload == canonical
    stage = active.parent / decoded["transaction"]
    for op in decoded["plan"]:
        goal = op["desired"]
        if goal is None:
            continue
        body = stage / goal["sha256"]
        data = body.read_bytes()
        assert digest(data) == goal["sha256"] and len(data) == goal["length"], "staged body failed the independent digest"
        working = root / op["path"]
        if working.is_file():
            assert not os.path.samefile(working, body), "working file aliases the retained recovery copy"
    return decoded


EVENT = re.compile(r"(?<![A-Za-z0-9_-])((?:before|after)-[a-z][a-z-]*(?::[0-9]+)?|acknowledged)(?![A-Za-z0-9_:-])")
POST_UNLINK = {"after-unlink", "after-unlink-sync", "after-cleanup"}


class Driver:
    def __init__(self, arguments):
        self.command = arguments
        self.environment = {k: v for k, v in os.environ.items() if not k.startswith("WAFFLE_FOLDER_")}

    def start(self, root, operation, request, fault=None):
        proc = subprocess.Popen([*self.command, str(root), PROJECT, operation], stdin=subprocess.PIPE,
                                stdout=subprocess.PIPE, stderr=subprocess.PIPE, env={**self.environment, **(fault or {})})
        proc.stdin.write(json.dumps(request).encode())
        proc.stdin.close()
        proc.stdin = None
        return proc

    def call(self, root, operation, request=None, fault=None, timeout=15):
        proc = self.start(root, operation, request or {}, fault)
        try:
            output, err = proc.communicate(timeout=timeout)
        except subprocess.TimeoutExpired:
            proc.kill()
            proc.communicate()
            raise
        rows = []
        for line in output.splitlines():
            try:
                rows.append(json.loads(line))
            except ValueError:
                pass
        return proc.returncode, rows, err.decode(errors="replace")

    def recover(self, root):
        code, rows, err = self.call(root, "recover")
        assert code == 0 and any(r.get("state") == "settled" for r in rows), (code, rows, err[-600:])

    def read(self, root, paths):
        code, rows, err = self.call(root, "read", {"paths": list(paths)})
        assert code == 0 and any("files" in r for r in rows), (code, rows, err[-600:])
        files = {}
        for f in next(r["files"] for r in rows if "files" in r):
            body = base64.b64decode(f["data"], validate=True)
            assert f["sha256"] == digest(body) and f["length"] == len(body)
            files[f["path"]] = body
        return files


def as_readable(files):
    return {key: value for key, value in files.items() if key != META}


def verify_reader(driver, root, files):
    wanted = as_readable(files)
    assert driver.read(root, wanted) == wanted


def temporary(parent):
    return tempfile.TemporaryDirectory(prefix="case-", dir=parent)


def trace(driver, case_data, parent, operation="commit"):
    with temporary(parent) as tmp:
        root = Path(tmp)
        seed(root, case_data.before)
        code, rows, stderr = driver.call(root, operation, case_data.request, {"WAFFLE_FOLDER_TRACE": "1"})
        assert code == 0 and sum(r.get("saved") is True for r in rows) == 1, (code, rows, stderr[-1000:])
        check_case(root, case_data, True)
        verify_reader(driver, root, case_data.after)
        assert descriptor(root) is None
        events = [m.group(1) for line in stderr.splitlines() for m in EVENT.finditer(line)]
        assert len(events) == len(set(events)), "each fault boundary needs an unambiguous ordinal"
        common = {"before-stage", "after-stage-dir-sync", "before-publish", "after-publish", "after-commit-sync",
                  "before-install:0", "after-install:0", "after-dir-sync:0", "before-unlink", "after-unlink",
                  "after-unlink-sync", "after-cleanup"}
        assert common <= set(events), ("trace omitted boundaries", sorted(common - set(events)), stderr[-1200:])
        return events


def kill_matrix(driver, case_data, parent, operation="commit"):
    events = trace(driver, case_data, parent, operation)
    published = events.index("after-publish")
    for index, name in enumerate(events):
        with temporary(parent) as tmp:
            root = Path(tmp)
            seed(root, case_data.before)
            code, rows, _ = driver.call(root, operation, case_data.request, {"WAFFLE_FOLDER_KILL": name})
            assert code != 0, "kill hook was not reached: " + name
            installed = index >= published
            expected = case_data.after if installed else case_data.before
            pending = descriptor(root)
            if not installed:
                assert pending is None and not any(r.get("saved") for r in rows), name
                check_case(root, case_data, False)
                verify_reader(driver, root, case_data.before)
            elif name not in POST_UNLINK:
                assert pending and pending["projectId"] == "p1", name
                # No writer survives. A read-only participant must report the active barrier or wait.
                try:
                    rc, results, _ = driver.call(root, "read", {"paths": [PROJECT]}, timeout=1)
                    assert rc != 0 and not any("files" in r for r in results), name
                except subprocess.TimeoutExpired:
                    pass
            driver.recover(root)
            check_case(root, case_data, installed)
            verify_reader(driver, root, expected)
            driver.recover(root)
            check_case(root, case_data, installed)
            assert descriptor(root) is None, name
    return events


def wait_ready(proc, gate, timeout=10):
    end = time.monotonic() + timeout
    while not gate.with_suffix(".ready").exists():
        if proc.poll() is not None or time.monotonic() >= end:
            raise RuntimeError("the writer did not enter its test-only gate")
        time.sleep(.01)


def gated(driver, root, request, point, gate):
    proc = driver.start(root, "commit", request, {"WAFFLE_FOLDER_PAUSE": point, "WAFFLE_FOLDER_GATE": str(gate)})
    try:
        wait_ready(proc, gate)
    except Exception:
        proc.kill()
        proc.communicate()
        raise
    return proc


def finish(proc):
    output, error = proc.communicate(timeout=15)
    rows = []
    for line in output.splitlines():
        try:
            rows.append(json.loads(line))
        except json.JSONDecodeError:
            pass
    return proc.returncode, rows, error.decode(errors="replace")


def barrier_and_stale(driver, parent):
    c = case("pair")
    with temporary(parent) as tmp:
        p = Path(tmp); root = p / "project"; gate = p / "apply"
        seed(root, c.before)
        first = gated(driver, root, c.request, "after-install:0", gate)
        try:
            assert (root / "Power.wsch").read_bytes() == c.after["Power.wsch"]
            assert (root / "Main.wpcb").read_bytes() == c.before["Main.wpcb"]
            assert descriptor(root)
            paths = ["Power.wsch", "Main.wpcb"]
            reader = driver.start(root, "read", {"paths": paths})
            competing = json.loads(json.dumps(c.request))
            competing["plan"][0]["data"] = base64.b64encode(lines(SHEET, {**LABEL, "text": "OTHER"})).decode()
            stale = driver.start(root, "commit", competing)
            time.sleep(.15)
            if reader.poll() is not None:
                rc, rows, _ = finish(reader)
                assert rc and not any("files" in r for r in rows), "mixed bytes were exposed to a saved reader"
                reader = None
            if stale.poll() is not None:
                rc, rows, _ = finish(stale)
                assert rc and not any(r.get("saved") for r in rows), "a stale second writer acknowledged"
                stale = None
            gate.with_suffix(".resume").touch()
            rc, _, err = finish(first)
            assert rc == 0, err[-600:]
            if reader:
                rc, rows, err = finish(reader)
                if rc == 0:
                    got = {f["path"]: base64.b64decode(f["data"]) for r in rows for f in r.get("files", [])}
                    assert got == {k: c.after[k] for k in paths}
            if stale:
                rc, rows, _ = finish(stale)
                assert rc and not any(r.get("saved") for r in rows), "a stale writer silently overwrote the winner"
            check_namespace(root, c.after)
        finally:
            gate.with_suffix(".resume").touch()
            if first.poll() is None:
                first.kill(); first.communicate()


def interrupted(driver, root, data, point="after-commit-sync"):
    seed(root, data.before)
    rc, _, _ = driver.call(root, "commit", data.request, {"WAFFLE_FOLDER_KILL": point})
    assert rc and descriptor(root)


def refusal(driver, root):
    rc, rows, _ = driver.call(root, "recover")
    assert rc and not any(r.get("state") == "settled" for r in rows)
    rc, rows, _ = driver.call(root, "read", {"paths": [PROJECT]})
    assert rc and not any("files" in r for r in rows)


def exceptional(driver, parent):
    results = []
    c = case("asset")
    for label in ["other-digest", "matching-asset", "damaged-stage", "damaged-descriptor"]:
        with temporary(parent) as tmp:
            root = Path(tmp); interrupted(driver, root, c)
            record = descriptor(root)
            active = root / ".waffle/journal/active"
            blob = root / ASSET_PATH
            blob.parent.mkdir(exist_ok=True)
            if label == "matching-asset":
                blob.write_bytes(ASSET); driver.recover(root); check_namespace(root, c.after)
            elif label == "other-digest":
                blob.write_bytes(b"external occupant\n")
                refusal(driver, root)
                assert blob.read_bytes() == b"external occupant\n" and descriptor(root) == record
                assert (root / "Power.wsch").read_bytes() == c.before["Power.wsch"]
            elif label == "damaged-stage":
                staged = active.parent / record["transaction"] / digest(ASSET)
                staged.write_bytes(b"damaged\n")
                refusal(driver, root)
                assert active.exists() and staged.read_bytes() == b"damaged\n"
                check_namespace(root, c.before)
            else:
                changed = active.read_bytes().replace(b"WAFFLE-TXN 1", b"WAFFLE-TXN 9", 1)
                active.write_bytes(changed); refusal(driver,root)
                assert active.read_bytes() == changed
                check_namespace(root, c.before)
        results.append(label)
    for name in ["rename", "cross-folder"]:
        with temporary(parent) as tmp:
            root = Path(tmp); c = case(name); seed(root, c.before)
            dest = root / c.request["plan"][0]["path"]; dest.parent.mkdir(exist_ok=True)
            dest.write_bytes(c.before["Power.wsch"])
            before = authored(root)
            rc, rows, _ = driver.call(root, "commit", c.request)
            assert rc and not any(r.get("saved") for r in rows), "occupied rename destination acknowledged"
            check_namespace(root,before)
        results.append(name + "-occupied")
    # A same-size edit with its original nanosecond timestamp cannot pass a raw-digest precondition.
    with temporary(parent) as tmp:
        root = Path(tmp); c = case("edit"); seed(root,c.before)
        sheet = root / "Power.wsch"; old = sheet.stat()
        sheet.write_bytes(sheet.read_bytes().replace(b"SENSE",b"OTHER"))
        os.utime(sheet,ns=(old.st_atime_ns,old.st_mtime_ns))
        before=authored(root); rc,rows,_=driver.call(root,"commit",c.request)
        assert rc and not any(r.get("saved") for r in rows)
        check_namespace(root,before)
    results.append("same-time-and-length-external-edit")
    results.extend(typed_directories(driver, parent))
    return results


def typed_directories(driver, parent):
    """A file-suffixed directory is invalid even when it is not also listed as a file."""
    checked = []
    for basename in ("Looks like a file.wsch", "Looks like a file.WPCB", "Looks like a file.wDrAw",
                     "Looks like a file.WPANEL", "Looks like a file.wlib", ".WpCb"):
        with temporary(parent) as tmp:
            root = Path(tmp)
            c = case("cross-folder")
            seed(root, c.before)
            directory = "Drawings/" + basename
            name = directory + "/Nested/Supply"
            c.request["plan"][0]["path"] = name + ".wsch"
            c.request["plan"][-1]["data"] = base64.b64encode(manifest(name)).decode()
            rc, rows, _ = driver.call(root, "commit", c.request)
            assert rc and not any(r.get("saved") for r in rows), rows
            assert descriptor(root) is None and not (root / directory).exists()
            check_namespace(root, c.before)
            checked.append("typed-directory-" + basename.lower())
    # Reproduce the historical failure: both typed targets are initially absent, so
    # accepting the nested file would create a directory where the other file belongs.
    with temporary(parent) as tmp:
        root = Path(tmp)
        c = case("cross-folder")
        seed(root, c.before)
        path = "Supply.wsch"
        c.request["plan"][0]["path"] = "SUPPLY.WSCH/Nested/Supply.wsch"
        c.request["plan"].insert(1, {"path": path, "expected": None,
                                     "text": lines({**SHEET, "id": "separate"}).decode()})
        c.request["plan"][-1]["data"] = base64.b64encode(manifest("SUPPLY.WSCH/Nested/Supply") +
            lines({"kind": "document", "id": "separate", "docKind": "schematic", "name": "Supply", "path": path})).decode()
        rc, rows, _ = driver.call(root, "commit", c.request)
        assert rc and not any(r.get("saved") for r in rows), rows
        assert descriptor(root) is None and not (root / path).exists() and not (root / "SUPPLY.WSCH").exists()
        check_namespace(root, c.before)
        checked.append("case-folded-file-and-directory")
    return checked


def error_matrix(driver, parent):
    c = case("asset"); rows = []
    for point in ("after-stage-write:0","after-stage-flush:0","before-publish","after-publish",
                  "after-commit-sync","before-install:1","after-install:1","after-dir-sync:1","before-unlink"):
        with temporary(parent) as tmp:
            root=Path(tmp);seed(root,c.before)
            rc,reply,_=driver.call(root,"commit",c.request,{"WAFFLE_FOLDER_FAIL":point,"WAFFLE_FOLDER_ERRNO":str(errno.ENOSPC)})
            assert rc, "injected failure not reported: " + point
            committed=descriptor(root) is not None
            if not committed:
                assert not any(r.get("saved") for r in reply)
                check_namespace(root,c.before)
            driver.recover(root)
            check_namespace(root,c.after if committed else c.before)
            rows.append({"point":point,"activeAfterError":committed,"acknowledged":any(r.get("saved") for r in reply)})
    return rows


def main():
    args=argparse.ArgumentParser(description=__doc__)
    args.add_argument("--out",type=Path,required=True)
    args.add_argument("--root",type=Path,required=True,help="private scratch parent on the target filesystem")
    args.add_argument("--host",required=True)
    args.add_argument("--case",action="append",choices=["edit","pair","asset","child-asset","delete-asset","rename","cross-folder","case-only"])
    args.add_argument("--skip-supplementary",action="store_true",help="run only the selected kill matrices")
    args.add_argument("driver",nargs=argparse.REMAINDER)
    o=args.parse_args();args=o.driver[1:] if o.driver[:1]==["--"] else o.driver
    if not args:raise SystemExit("supply a real native CLI after --")
    o.root.mkdir(mode=0o700,parents=True,exist_ok=True);o.out.parent.mkdir(parents=True,exist_ok=True)
    d=Driver(args);report={"host":o.host,"killMatrix":{},"supplementary":{},"complete":False}
    try:
        for k in o.case or ["edit","pair","asset","child-asset","delete-asset","rename","cross-folder","case-only"]:
            events=kill_matrix(d,case(k),o.root);report["killMatrix"][k]=events
            print(k,len(events),"native process deaths verified",flush=True)
        if not o.skip_supplementary:
            report["supplementary"]["conflicts"]=exceptional(d,o.root)
            barrier_and_stale(d,o.root)
            report["supplementary"]["readBarrierAndStaleWriter"]=True
            report["supplementary"]["injectedErrors"]=error_matrix(d,o.root)
        report["complete"]=True
    finally:
        o.out.write_text(json.dumps(report,indent=2)+"\n")


if __name__=="__main__":
    main()
