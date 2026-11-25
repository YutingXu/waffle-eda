#!/usr/bin/env python3
"""Verify standalone native recovery and read/write scope with the Linux filesystem writer."""
import hashlib
import json
from pathlib import Path
import sys
from tempfile import TemporaryDirectory


HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parents[1] / "linux"))
from folder_project import NativeMember  # noqa: E402


def digest(data):
    return hashlib.sha256(data).hexdigest()


def refused(operation, expected):
    try:
        operation()
    except (OSError, ValueError) as error:
        assert expected in str(error), str(error)
    else:
        raise AssertionError("The invalid native member save was accepted")


def check(root, fixture, point):
    root.mkdir()
    path = root / fixture["filename"]
    before, after = (fixture[key].encode("utf-8") for key in ("before", "after"))
    path.write_bytes(before)
    active = root / fixture["journal"] / "active"

    def checkpoint(name):
        if name == point:
            raise OSError("test interruption")

    member = NativeMember(path, checkpoint=checkpoint)
    try:
        assert member.read() == {"data": before, "sha256": digest(before), "readOnly": False}
        assert not (root / ".waffle").exists()
        refused(lambda: member.commit(digest(after), after), "conflicts")
        if point is None or point == "before-install:0":
            assert member.commit(digest(before), after)["hash"] == digest(after)
        else:
            occurred = "test interruption" if point == "before-publish" else "journal is durable"
            refused(lambda: member.commit(digest(before), after), occurred)
        assert active.is_file() == (point in ("after-commit-sync", "before-install:0"))
        assert path.read_bytes() == (after if point is None else before)
    finally:
        member.close()

    member = NativeMember(path)
    try:
        expected = before if point == "before-publish" else after
        for _ in range(2):
            assert member.read()["data"] == expected
            assert not active.exists()
        assert member.commit(digest(expected), after)["hash"] == digest(after)
    finally:
        member.close()


def portable(root, fixture):
    root.mkdir()
    path = root / fixture["filename"]
    path.write_bytes(fixture["before"].encode())
    journal = root / fixture["journal"]
    journal.mkdir(mode=0o700, parents=True)
    stage = journal / fixture["transaction"]
    stage.mkdir(mode=0o700)
    after = fixture["after"].encode()
    (stage / digest(after)).write_bytes(after)
    (journal / "lock").touch(mode=0o600)
    (journal / "active").write_bytes(fixture["active"].encode())
    member = NativeMember(path)
    try:
        assert member.read()["data"] == after
        assert not (journal / "active").exists()
        assert path.is_file() and path.read_bytes() == after
    finally:
        member.close()


def read_only(root, fixture):
    root.mkdir()
    path = root / fixture["filename"]
    original = fixture["before"].replace('"id":"owner-scope"}', '"id":"owner-scope","requires":["future-feature"]}').encode()
    path.write_bytes(original)
    member = NativeMember(path)
    try:
        assert member.read()["readOnly"]
        refused(lambda: member.commit(digest(original), fixture["after"].encode()), "read-only")
        assert not (root / ".waffle").exists() and path.read_bytes() == original
    finally:
        member.close()


if __name__ == "__main__":
    with TemporaryDirectory(prefix="waffle-linux-member-") as directory:
        root = Path(directory).resolve()
        fixture = json.loads((HERE / "standalone.json").read_text(encoding="utf-8"))
        read_only(root / "read-only", fixture)
        if sys.platform.startswith("linux"):
            for i, point in enumerate((None, "before-publish", "after-commit-sync", "before-install:0")):
                check(root / ("write-" + str(i)), fixture, point)
            portable(root / "portable", fixture)
            print("PASS Linux standalone rollback, durable recovery, retries, Unicode-name replay and read-only feature refusal")
        else:
            print("PASS standalone read-only scope; publication checkpoints require the Linux filesystem adapter")
