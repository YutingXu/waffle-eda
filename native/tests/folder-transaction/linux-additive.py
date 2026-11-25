#!/usr/bin/env python3
"""Run the shared newer-minor owner and mutation vectors on the actual Linux worker."""

import base64
import hashlib
import json
import os
from pathlib import Path
import sys
import tempfile

sys.path.insert(0, os.environ.get("WAFFLE_NATIVE_MODULE") or str(Path(__file__).resolve().parents[2] / "linux"))
from folder_project import FolderError, RootFolder  # noqa: E402
from additive import native_copy_fixture  # noqa: E402


def digest(data):
    return hashlib.sha256(data).hexdigest()


def splice(path, before, from_row, to_row):
    expected = digest(before)
    return [{"path": path, "expected": expected, "splice": {"base": expected, "edits": [{
        "offset": before.index(from_row), "remove": len(from_row), "insert": to_row.decode("utf-8"),
    }]}}]


def seed(path, fixture, replace=None):
    path.mkdir()
    before = {name: raw.encode("utf-8") for name, raw in fixture["files"].items()}
    if replace:
        before[replace[0]] = replace[1]
    for name, raw in before.items():
        (path / name).write_bytes(raw)
    return before


def rejected(path, fixture, entries, replace=None):
    before = seed(path, fixture, replace)
    root = RootFolder.selected(path)
    try:
        try:
            root.commit(fixture["projectId"], fixture["manifest"], entries, lambda _: None)
        except (FolderError, OSError):
            pass
        else:
            raise AssertionError(f"An unsafe future edit was accepted: {path.name}")
        assert not (path / ".waffle").exists()
        assert {name: (path / name).read_bytes() for name in before} == before
    finally:
        root.close()


def accepted(path, fixture, entries, after, *, crash=False):
    before = seed(path, fixture)
    root = RootFolder.selected(path)
    receipts = []
    path_to_change = fixture["member"]
    original_read = root._read

    def scoped_read(name, *args, **kwargs):
        assert name != fixture["opaque"], "The ordinary owner edit read an unrelated opaque member"
        return original_read(name, *args, **kwargs)

    root._read = scoped_read
    if crash:
        def checkpoint(point):
            if point == "before-install:0":
                raise OSError("Fixture interrupted apply after the durable receipt.")

        root.checkpoint = checkpoint
    try:
        root.commit(fixture["projectId"], fixture["manifest"], entries, receipts.append)
        assert receipts[0]["saved"] and receipts[0]["hashes"][path_to_change] == digest(after)
        if crash:
            assert (path / ".waffle" / "journal" / "active").is_file()
            assert (path / path_to_change).read_bytes() == before[path_to_change]
            root.close()
            root = RootFolder.selected(path)
            root.recover()
            root.recover()
        assert not (path / ".waffle" / "journal" / "active").exists()
        assert (path / path_to_change).read_bytes() == after
        assert all((path / name).read_bytes() == raw for name, raw in before.items() if name != path_to_change)
    finally:
        root.close()


def reviewed_resolution(path, fixture, entries, desired, *, keep):
    before = seed(path, fixture)
    root = RootFolder.selected(path)
    name = fixture["member"]
    owner = path / name
    external = before[name].replace(b'"measurement":21', b'"measurement":29').replace(b'"SENSE"', b'"OUTSIDE"')
    merged = desired.replace(b'"measurement":21', b'"measurement":29')
    receipts = []

    def pause(point):
        if point == "before-install:0":
            raise OSError("Fixture interrupted the acknowledged transaction.")

    root.checkpoint = pause
    try:
        root.commit(fixture["projectId"], fixture["manifest"], entries, receipts.append)
        transaction = receipts[0]["transaction"]
        active = path / ".waffle" / "journal" / "active"
        original = active.read_bytes()
        owner.write_bytes(external)
        conflict = root.conflict()
        assert conflict["transaction"] == transaction and conflict["paths"] == [name]
        decision = {"path": name, "current": digest(external), "use": "staged"}
        request = {"transaction": transaction, "choices": [decision]}
        try:
            root.resolve(request, receipts.append)
        except FolderError:
            pass
        else:
            raise AssertionError("Conflict choice would discard a newly observed unknown value")
        archive = path / ".waffle" / "local" / "conflicts" / transaction
        assert not archive.exists() and active.read_bytes() == original and owner.read_bytes() == external
        if keep:
            decision["use"] = "external"
            def pause_unchanged(point):
                if point == "before-unlink":
                    raise OSError("Fixture interrupted cleanup of the elected external version.")

            root.checkpoint = pause_unchanged
        else:
            decision.update(use="merged", text=merged.decode("utf-8"))
        root.resolve(request, receipts.append)
        assert receipts[-1]["transaction"] != transaction
        assert active.is_file() and owner.read_bytes() == external
        assert (archive / "original.active").read_bytes() == original
        assert (archive / digest(external)).read_bytes() == external
        assert (archive / digest(desired)).read_bytes() == desired
        root.close()
        root = RootFolder.selected(path)
        root.recover()
        assert not active.exists() and owner.read_bytes() == (external if keep else merged)
        assert all((path / other).read_bytes() == data for other, data in before.items() if other != name)
    finally:
        root.close()


def check_native_copy(fixture, project, owner):
    manifest = fixture["manifest"]
    path, raw, reserved, after, request = native_copy_fixture(project, owner)
    for payload, witness, approved, message in (
            (raw, raw, False, "selected-file grant"),
            (raw.replace("SENSE", "NEW"), raw, True, "bytes or destination changed"),
            (reserved, reserved, True, "continuation-parts-v1")):
        with tempfile.TemporaryDirectory() as temp:
            selected = Path(temp) / "Design"
            seed(selected, {**fixture, "files": {manifest: project}})
            root = RootFolder.selected(selected)
            receipts = []
            try:
                q = request(payload, witness)
                proof = q["testNativeCopyHashes"] if approved else None
                try:
                    root.commit(fixture["projectId"], manifest, q["plan"], receipts.append, native_copy_hashes=proof)
                except FolderError as error:
                    assert message in str(error), str(error)
                else:
                    raise AssertionError("The selected copy's authority or bytes must be verified.")
                assert not receipts and not (selected / ".waffle/journal/active").exists()
                assert not (selected / path).exists() and (selected / manifest).read_bytes() == project.encode()
            finally:
                root.close()
    with tempfile.TemporaryDirectory() as temp:
        selected = Path(temp) / "Design"
        seed(selected, {**fixture, "files": {manifest: project}})
        q, receipts = request(raw, raw), []
        def interrupt(point):
            if point == "before-install:0":
                raise OSError("Interrupted the authorized copy after publication.")
        root = RootFolder.selected(selected)
        try:
            root.checkpoint = interrupt
            root.commit(fixture["projectId"], manifest, q["plan"], receipts.append, native_copy_hashes=q["testNativeCopyHashes"])
            assert receipts[0]["saved"] and receipts[0]["hashes"][path] == digest(raw.encode())
            assert not (selected / path).exists() and (selected / ".waffle/journal/active").exists()
        finally:
            root.close()
        root = RootFolder.selected(selected)
        try:
            root.recover()
            root.recover()
            assert (selected / path).read_bytes() == raw.encode() and (selected / manifest).read_bytes() == after.encode()
            try:
                root.commit(fixture["projectId"], manifest, splice(path, raw.encode(), b"SENSE", b"NEW"), lambda _: None)
            except FolderError as error:
                assert "future-constraint" in str(error), str(error)
            else:
                raise AssertionError("A copied document with unsupported requirements must remain read-only.")
            assert (selected / path).read_bytes() == raw.encode() and not (selected / ".waffle/journal/active").exists()
            q = request(None, raw, undo=True)
            (selected / path).write_bytes(raw.replace("SENSE", "EXTERNAL").encode())
            try:
                root.commit(fixture["projectId"], manifest, q["plan"], receipts.append, native_copy_hashes=q["testNativeCopyHashes"])
            except FolderError:
                pass
            else:
                raise AssertionError("The native Undo would delete a changed destination.")
            assert (selected / path).read_bytes() == raw.replace("SENSE", "EXTERNAL").encode()
            (selected / path).write_bytes(raw.encode())
            root.checkpoint = interrupt
            root.commit(fixture["projectId"], manifest, q["plan"], receipts.append, native_copy_hashes=q["testNativeCopyHashes"])
            assert receipts[-1]["saved"] and receipts[-1]["hashes"][path] is None
        finally:
            root.close()
        root = RootFolder.selected(selected)
        try:
            root.recover()
            root.recover()
            assert not (selected / path).exists() and (selected / manifest).read_bytes() == project.encode()
            q = request(raw, raw)
            root.commit(fixture["projectId"], manifest, q["plan"], receipts.append, native_copy_hashes=q["testNativeCopyHashes"])
            assert (selected / path).read_bytes() == raw.encode() and (selected / manifest).read_bytes() == after.encode()
        finally:
            root.close()


def main(fixture):
    manifest, member, opaque = (fixture[key] for key in ("manifest", "member", "opaque"))
    saved = fixture["files"]
    current = "".join(row for row in saved[manifest].splitlines(keepends=True) if opaque not in row)
    current = current.replace('"formatVersion":"2.1"', '"formatVersion":"2.0"')
    owner = saved[member].replace('"formatVersion":"2.1"', '"formatVersion":"2.0"')
    requirement = ',"readerRequires":{"future-constraint":"2.8"},"requires":["future-constraint"]'
    def required(text):
        head, body = text.split("\n", 1)
        return head[:-1] + requirement + "}\n" + body
    check_native_copy(fixture, current, required(owner))
    for mode in ("manifest", "owner", "proposed"):
        with tempfile.TemporaryDirectory() as temp:
            path = Path(temp) / "Design"
            project = required(current) if mode == "manifest" else current
            original = required(owner) if mode == "owner" else owner
            proposed = original.replace("SENSE", "NEW")
            if mode == "proposed":
                proposed = required(proposed)
            values = seed(path, {**fixture, "files":{manifest:project, member:original}})
            root = RootFolder.selected(path)
            receipt = []
            try:
                try:
                    root.commit(fixture["projectId"], manifest,
                                splice(member, original.encode(), original.encode(), proposed.encode()), receipt.append)
                except FolderError as error:
                    assert "future-constraint" in str(error) and "native format 2.8" in str(error), str(error)
                else:
                    raise AssertionError(f"Unsupported required capability was writable: {mode}")
                assert not receipt and not (path / ".waffle/journal/active").exists()
                assert all((path / name).read_bytes() == raw for name, raw in values.items())
            finally:
                root.close()
    with tempfile.TemporaryDirectory() as temp:
        path = Path(temp) / "Design"
        header, known, _ = owner.splitlines()
        raw = header + "\r\n" + known + '\n{ "kind":"futureTrace", "id":"n2", "future": {"q":1.20e2,"\\u0061":1e400} }\r\n'
        edited = raw.replace("SENSE", "NEW")
        values = seed(path, {**fixture, "files":{manifest:current, member:raw}})
        root = RootFolder.selected(path)
        receipts = []
        try:
            root.commit(fixture["projectId"], manifest, splice(member, raw.encode(), b"SENSE", b"NEW"), receipts.append)
            assert receipts[0]["hashes"][member] == digest(edited.encode())
            assert (path / member).read_bytes() == edited.encode() and (path / manifest).read_bytes() == values[manifest]
        finally:
            root.close()
    member, manifest = fixture["member"], fixture["manifest"]
    old, new = (fixture["edit"][key].encode("utf-8") for key in ("from", "to"))
    before = fixture["files"][member].encode("utf-8")
    desired = before.replace(old, new)
    assert digest(before) == fixture["expected"] and digest(desired) == fixture["desired"]
    with tempfile.TemporaryDirectory(prefix="waffle-additive-") as tmp:
        base = Path(tmp).resolve()
        plan = splice(member, before, old, new)
        accepted(base / "splice", fixture, plan, desired)
        accepted(base / "replay", fixture, plan, desired, crash=True)
        accepted(base / "full-payload", fixture,
                 [{"path": member, "expected": digest(before), "data": base64.b64encode(desired).decode("ascii")}], desired)
        added = b'{"kind":"netlabel","id":"n0","at":[900,1900],"text":"NEW"}\n'
        with_added = desired.replace(new, added + new)
        accepted(base / "known-row-create", fixture,
                 [{"path": member, "expected": digest(before), "text": with_added.decode("utf-8")}], with_added)
        for case in fixture["refuse"]:
            find, replacement = (case[key].encode("utf-8") for key in ("find", "replace"))
            replace = None
            if case["file"] == "desired":
                candidate = desired.replace(find, replacement, 1)
                assert candidate != desired, case["name"]
                entry = splice(member, before, before, candidate)
            else:
                path = manifest if case["file"] == "project" else member
                original = fixture["files"][path].encode("utf-8")
                changed = original.replace(find, replacement, 1)
                assert changed != original, case["name"]
                replace = (path, changed)
                entry = plan if path == manifest else splice(member, changed, old, new)
            rejected(base / case["name"], fixture, entry, replace)
        rejected(base / "stale", fixture, [{**plan[0], "expected": "a" * 64}])
        original_manifest = fixture["files"][manifest]
        manifest_entry = {"path": manifest, "expected": digest(original_manifest.encode()), "text": original_manifest}
        path = base / "manifest-replay"
        originals = seed(path, fixture)
        root = RootFolder.selected(path)
        receipts = []
        try:
            root.commit(fixture["projectId"], manifest, [manifest_entry], receipts.append)
            assert receipts[0]["saved"] and receipts[0]["hashes"] == {manifest: manifest_entry["expected"]}
            assert not (path / ".waffle/journal/active").exists()
            assert all((path / name).read_bytes() == before for name, before in originals.items())
        finally:
            root.close()
        renamed = original_manifest.replace('"Forward sensor"', '"Renamed sensor"')
        assert renamed != original_manifest
        rejected(base / "manifest-rename", fixture, [{**manifest_entry, "text": renamed}])
        without_opaque = "".join(line for line in original_manifest.splitlines(keepends=True)
                                 if json.loads(line).get("path") != fixture["opaque"])
        assert without_opaque != original_manifest
        rejected(base / "manifest-remove-opaque", fixture, [{**manifest_entry, "text": without_opaque}])
        bad_coords = desired.replace(b"[1100,2200]", b"[true,2200]")
        rejected(base / "non-numeric-vector", fixture, splice(member, before, before, bad_coords))
        reviewed_resolution(base / "merge-external-unknown", fixture, plan, desired, keep=False)
        reviewed_resolution(base / "retain-external-unknown", fixture, plan, desired, keep=True)
    print(f"PASS Linux additive text/move, known-row insertion, staged replay, and {len(fixture['refuse']) + 4} pristine refusals.")
    print("PASS an exact-byte manifest replay preserves all authored bytes.")
    print("PASS reviewed merge and keep-external preserve newly seen opaque values and replay after interruption.")


if __name__ == "__main__":
    fixture_path = Path(sys.argv[1]) if len(sys.argv) > 1 else Path(__file__).with_name("additive.json")
    main(json.loads(fixture_path.read_text(encoding="utf-8")))
