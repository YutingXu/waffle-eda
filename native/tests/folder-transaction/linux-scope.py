#!/usr/bin/env python3
"""Linux-specific confinement, inotify, lease and explicit-resolution checks."""

import base64
import hashlib
import json
import os
from pathlib import Path
import select
import sys
import tempfile


module = os.environ.get("WAFFLE_NATIVE_MODULE") or str(Path(__file__).resolve().parents[2] / "linux")
sys.path.insert(0, module)
from folder_project import FolderError, FolderWatch, RootFolder, stamp, unpack_descriptor  # noqa: E402


MANIFEST = "Sensor.waffle"
SHEET = "Sheets/Power.wsch"
HEADER = b'{"kind":"schematic","formatVersion":"2.0","id":"s1"}\n'
BEFORE = HEADER + b'{"kind":"netlabel","id":"n1","text":"SENSE"}\n'
OWN = BEFORE.replace(b"SENSE", b"LOCAL")
OUTSIDE = BEFORE.replace(b"SENSE", b"OTHER")
MERGED = BEFORE.replace(b"SENSE", b"MERGE")


def sha(data):
    return hashlib.sha256(data).hexdigest()


def refused(operation):
    try:
        operation()
    except (OSError, FolderError) as error:
        return error
    raise AssertionError("The operation should have been refused")


def seed(directory):
    directory.mkdir()
    target = directory / SHEET
    target.parent.mkdir()
    target.write_bytes(BEFORE)
    (directory / MANIFEST).write_text(
        '{"kind":"project","formatVersion":"2.0","id":"p1","name":"Sensor"}\n'
        '{"kind":"document","id":"s1","docKind":"schematic","name":"Power","path":"Sheets/Power.wsch"}\n')
    return target


def scoped(directory):
    target = seed(directory)
    root = RootFolder(directory, MANIFEST)
    try:
        root.recover()
        assert not (directory / ".waffle").exists()
        lease = root.acquire(recover=False)
        root.read(lease, [MANIFEST, SHEET])
        assert not (directory / ".waffle").exists()
        refused(lambda: root.commit("p1", MANIFEST, plan(), lambda _: None))
        refused(lambda: root.read(lease, ["../private.wsch"]))
        refused(lambda: root.read(lease, [".git/config"]))
        state = target.stat()
        target.write_bytes(OUTSIDE)
        os.utime(target, ns=(state.st_atime_ns, state.st_mtime_ns))
        refused(lambda: root.read(lease, [SHEET]))
        if root.member_stamp(SHEET) != stamp(state):
            refused(lambda: root.verify_lease(lease))
        root.release(lease)
        target.write_bytes(BEFORE)
        refused(lambda: root.commit("p1", MANIFEST, plan(), lambda _: None, read_set={MANIFEST: "0" * 64}))
        assert target.read_bytes() == BEFORE

        external = directory.parent / "external.wsch"
        external.write_bytes(OUTSIDE)
        target.unlink()
        target.symlink_to(external)
        lease = root.acquire(recover=False)
        refused(lambda: root.read(lease, [SHEET]))
        root.release(lease)
        target.unlink()
        os.link(external, target)
        lease = root.acquire(recover=False)
        refused(lambda: root.read(lease, [SHEET]))
        root.release(lease)
        refused(lambda: root.commit("p1", MANIFEST, plan(), lambda _: None))
        assert external.read_bytes() == OUTSIDE and os.path.samefile(external, target)
        target.unlink()
        target.write_bytes(BEFORE)

        watch = FolderWatch(root)
        try:
            watch.track([SHEET])
            assert not select.select([watch.fd], [], [], 0.1)[0]
            target.write_bytes(OUTSIDE)
            assert select.select([watch.fd], [], [], 1)[0]
            paths, overflow = watch.drain()
            assert paths == {SHEET} and not overflow
        finally:
            watch.close()
    finally:
        root.close()


def plan():
    return [{"path": SHEET, "expected": sha(BEFORE), "text": OWN.decode()}]


def resolve(directory):
    target = seed(directory)
    def interrupted(point):
        if point == "before-install:0":
            raise OSError("A fixture interrupted installation after acknowledgement.")
    root = RootFolder(directory, MANIFEST, checkpoint=interrupted)
    receipts = []
    try:
        root.commit("p1", MANIFEST, plan(), receipts.append)
        assert receipts[0]["saved"] and root.status()["state"] == "recoveryPending"
        target.write_bytes(OUTSIDE)
        external = root.conflict()
        transaction = external["transaction"]
        assert external["paths"] == [SHEET]
        root.checkpoint = lambda _: None
        refused(lambda: root.acquire(recover=True))
        pair = []
        for side in ("staged", "external"):
            packet = root.conflict_read({"transaction": transaction, "path": SHEET, "side": side,
                                         "offset": 0, "length": 4096})
            pair.append(base64.b64decode(packet["data"], validate=True))
        assert pair == [OWN, OUTSIDE]
        choice = {"path": SHEET, "current": sha(BEFORE), "use": "merged", "text": MERGED.decode()}
        refused(lambda: root.resolve({"transaction": transaction, "choices": [choice]}, receipts.append))
        assert target.read_bytes() == OUTSIDE and len(receipts) == 1
        choice["current"] = sha(OUTSIDE)
        root.resolve({"transaction": transaction, "choices": [choice]}, receipts.append)
        assert receipts[-1]["saved"] and receipts[-1]["transaction"] != transaction
        assert root.status()["state"] == "settled" and target.read_bytes() == MERGED
        archive = directory / ".waffle" / "local" / "conflicts" / transaction
        assert (archive / sha(OWN)).read_bytes() == OWN and (archive / sha(OUTSIDE)).read_bytes() == OUTSIDE
        assert unpack_descriptor((archive / "original.active").read_bytes(), MANIFEST)["transaction"] == transaction
    finally:
        root.close()


def future_documents(directory):
    seed(directory)
    manifest = directory / MANIFEST
    old_manifest = manifest.read_bytes()
    reference = b'{"kind":"document","id":"f1","docKind":"waveform","name":"Trace","path":"Sheets/Trace.wwave"}\n'
    future_manifest = old_manifest.replace(b'"2.0"', b'"2.2"') + reference
    path = "Sheets/Trace.wwave"
    member = directory / path
    original = b'{"kind":"waveform","formatVersion":"2.1","id":"f1"}\n{"kind":"samples","id":"a1","points":[2,4]}\n'
    member.write_bytes(original)
    board_path = "Sheets/Board.wpcb"
    future_manifest += b'{"kind":"document","id":"pcb","docKind":"pcb","name":"Board","path":"Sheets/Board.wpcb"}\n'
    manifest.write_bytes(future_manifest)
    (directory / board_path).write_bytes(b'{"kind":"pcb","formatVersion":"2.0","id":"pcb"}\n'
                                        b'{"kind":"futureArtwork","id":"opaque","data":"' + b"x" * (4 << 20) + b'"}\n')
    ghost = directory / "Sheets/Unindexed.wwave"
    ghost.write_bytes(original)
    root = RootFolder(directory, MANIFEST)
    try:
        read = root._read
        board_reads = []

        def trace(name, *args, **kwargs):
            if name == board_path:
                board_reads.append(name)
            return read(name, *args, **kwargs)

        root._read = trace
        root.recover()
        assert not (directory / ".waffle").exists()
        lease = root.acquire(recover=False)
        refused(lambda: root.read(lease, [path]))
        refused(lambda: root.read(lease, [SHEET]))
        files = root.read(lease, [MANIFEST, SHEET, path, board_path])["files"]
        assert base64.b64decode(files[1]["data"], validate=True) == BEFORE
        assert base64.b64decode(files[2]["data"], validate=True) == original and files[2]["sha256"] == sha(original)
        refused(lambda: root.read(lease, [ghost.relative_to(directory).as_posix()]))
        different = root.acquire(recover=False)
        refused(lambda: root.read(different, [path]))
        root.release(different)
        manifest.write_bytes(future_manifest.replace(b'"Sensor"', b'"Outlet"'))
        error = refused(lambda: root.read(lease, [path]))
        assert isinstance(error, FolderError) and error.state == "conflict" and error.paths == (MANIFEST,)
        assert board_reads == [board_path], "verifying newer membership rescanned the unrelated PCB"
        root.release(lease)
        manifest.write_bytes(future_manifest)
        sheet = directory / SHEET
        sheet.write_bytes(BEFORE.replace(b'"s1"', b'"s2"'))
        lease = root.acquire(recover=False)
        root.read(lease, [MANIFEST])
        refused(lambda: root.read(lease, [SHEET]))
        root.release(lease)
        sheet.write_bytes(BEFORE)
        for invalid in (original.replace(b'"f1"', b'"f2"'), original.replace(b'"2.1"', b'"2.3"'),
                        original.replace(b'"2.1"', b'"2.0"'), original.replace(b'"waveform"', b'"sch"')):
            member.write_bytes(invalid)
            lease = root.acquire(recover=False)
            root.read(lease, [MANIFEST])
            refused(lambda: root.read(lease, [path]))
            root.release(lease)
        member.unlink()
        member.symlink_to(ghost)
        lease = root.acquire(recover=False)
        root.read(lease, [MANIFEST])
        refused(lambda: root.read(lease, [path]))
        root.release(lease)
        refused(lambda: root.commit("p1", MANIFEST, [{"path": path, "expected": sha(original),
                                                    "text": original.decode("utf-8")}], lambda _: None))
        assert not (directory / ".waffle").exists() and manifest.read_bytes() == future_manifest
        manifest.write_bytes(old_manifest + reference)
        lease = root.acquire(recover=False)
        root.read(lease, [MANIFEST])
        refused(lambda: root.read(lease, [path]))
        root.release(lease)
        assert ghost.read_bytes() == original and not (directory / ".waffle").exists()
    finally:
        root.close()


if __name__ == "__main__":
    with tempfile.TemporaryDirectory() as temp:
        scratch = Path(temp).resolve()
        scoped(scratch / "Scope")
        resolve(scratch / "Resolution")
        future_documents(scratch / "Future")
    print("PASS Linux confined paths, stale leases/read sets, sleeping inotify and conflict supersession.")
    print("PASS authentic newer-minor members retain exact bytes only under their manifest's read lease.")
