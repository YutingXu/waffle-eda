#!/usr/bin/env python3
"""Native format-2 cases for scoped media and explicitly approved conflict resolution."""
import argparse
import base64
import hashlib
import json
import itertools
import os
from pathlib import Path
from tempfile import TemporaryDirectory
import subprocess
import time


def digest(b):
    return hashlib.sha256(b).hexdigest()


def rows(*values):
    return b"".join((json.dumps(v, separators=(",", ":"), ensure_ascii=False) + "\n").encode() for v in values)


def create(root):
    m = "Bench.waffle"
    header = {"kind": "schematic", "formatVersion": "2.0", "id": "s1"}
    initial = rows(header, {"kind": "netlabel", "id": "n1", "text": "A"})
    (root / "Power.wsch").write_bytes(initial)
    (root / m).write_bytes(rows({"kind": "project", "formatVersion": "2.0", "id": "p1", "name": "Bench"},
                                {"kind": "document", "id": "s1", "docKind": "schematic", "name": "Power", "path": "Power.wsch"}))
    return m, header, initial


def call(cli, root, manifest, command, body=None, env=None, ok=True):
    proc = subprocess.run([str(cli), str(root), manifest, command], input=json.dumps(body or {}), text=True,
                          env={**os.environ, **(env or {})}, capture_output=True, timeout=10)
    assert (proc.returncode == 0) == ok, (proc.returncode, proc.stdout, proc.stderr)
    return [json.loads(v) for v in proc.stdout.splitlines()]


def asset_case(cli, root):
    manifest, head, initial = create(root)
    raw = b"\x89PNG\r\n\x1a\n" + bytes(range(256)) * 5000
    sha = digest(raw)
    ref = {"sha256": sha, "byteLength": len(raw), "mediaType": "image/png"}
    owner = rows(head, {"kind": "image", "id": "img1", "asset": ref})
    path = "assets/" + sha
    req = {"projectId": "p1", "manifest": manifest, "attachment": base64.b64encode(raw).decode(),
           "ownerId": "s1", "mediaType": "image/png", "plan": [
               {"path": path, "expected": None, "assetToken": "test-token"},
               {"path": "Power.wsch", "expected": digest(initial), "text": owner.decode()}]}
    wrong = {**req, "ownerId": "s2"}
    call(cli, root, manifest, "stage-save", wrong, ok=False)
    assert not (root / path).exists() and (root / "Power.wsch").read_bytes() == initial
    assert call(cli, root, manifest, "stage-save", req)[0]["hashes"][path] == sha
    assert (root / path).read_bytes() == raw and (root / "Power.wsch").read_bytes() == owner
    for offset, length in ((0, 8), (1 << 20, 1 << 20), (len(raw), 17)):
        q = {"ownerId": "s1", "assetRef": ref, "offset": offset, "length": length}
        data = call(cli, root, manifest, "asset-read", q)[0]
        assert base64.b64decode(data["data"]) == raw[offset:offset + length]
    call(cli, root, manifest, "asset-read", {**q, "ownerId": "not-the-owner"}, ok=False)
    # An old placement can be unlinked without authorizing deletion of another owner's blob.
    del_req = {"projectId": "p1", "manifest": manifest, "plan": [{"path": path, "expected": sha, "remove": True}]}
    call(cli, root, manifest, "commit", del_req, ok=False)
    assert (root / path).read_bytes() == raw
    print("PASS attachment owner, preview, first save, bounded saved ranges, release and retention")


def conflict_case(cli, root, checkpoint=None):
    manifest, head, old = create(root)
    path = "Power.wsch"
    desired = rows(head, {"kind": "netlabel", "id": "n1", "text": "selected"})
    external = rows(head, {"kind": "netlabel", "id": "n1", "text": "external"})
    merged = rows(head, {"kind": "netlabel", "id": "n1", "text": "agreed"})
    req = {"projectId": "p1", "manifest": manifest, "plan": [{"path": path, "expected": digest(old), "text": desired.decode()}]}
    call(cli, root, manifest, "commit", req, {"WAFFLE_FOLDER_KILL": "acknowledged"}, ok=False)
    (root / path).write_bytes(external)
    assert call(cli, root, manifest, "recover", ok=False)[0]["paths"] == [path]
    review = call(cli, root, manifest, "conflict")[0]
    assert review["paths"] == [path] and review["plan"][0]["current"] == digest(external)
    tx = review["transaction"]
    choices = {"transaction": tx, "choices": [{"path": path, "current": digest(external), "use": "merged", "text": merged.decode()}]}
    call(cli, root, manifest, "resolve", {"transaction": tx, "choices": [{"path": path, "current": digest(old), "use": "staged"}]}, ok=False)
    assert (root / path).read_bytes() == external
    if checkpoint:
        call(cli, root, manifest, "resolve", choices, {"WAFFLE_FOLDER_KILL": checkpoint}, ok=False)
        if checkpoint == "before-publish":
            assert call(cli, root, manifest, "recover", ok=False)[0]["paths"] == [path]
            call(cli, root, manifest, "resolve", choices)
    else:
        call(cli, root, manifest, "resolve", choices)
    call(cli, root, manifest, "recover")
    assert (root / path).read_bytes() == merged
    archive = root / ".waffle/local/conflicts" / tx
    assert (archive / digest(external)).read_bytes() == external and (archive / digest(desired)).read_bytes() == desired
    assert not (root / ".waffle/journal/active").exists()
    print("PASS conflict supersession", checkpoint or "completion")


def portable_replay(cli, root):
    here = Path(__file__).resolve().parent
    vector = json.loads((here / "replay.json").read_bytes())
    manifest = vector["manifest"]
    for name, value in vector["before"].items():
        (root / name).write_bytes(value.encode())
    j = root / ".waffle/journal"
    stage = j / vector["transaction"]
    stage.mkdir(parents=True)
    (j / "lock").touch()
    (j / "active").write_bytes((here / "replay.active").read_bytes())
    for name in vector["plan"]:
        b = vector["after"][name].encode()
        (stage / digest(b)).write_bytes(b)
    call(cli, root, manifest, "read", {"paths": [manifest]}, ok=False)
    for _ in range(2):
        call(cli, root, manifest, "recover")
        assert not (j / "active").exists()
        for name, expected in vector["after"].items():
            assert (root / name).read_bytes() == expected.encode()
    print("PASS shared portable reader barrier and byte-for-byte replay twice")


def power_boundary_model(cli, parent):
    """Replay all namespace outcomes allowed by the checked same-device barriers."""
    here = Path(__file__).resolve().parent
    v = json.loads((here / "replay.json").read_bytes())
    active = (here / "replay.active").read_bytes()
    old, desired, order = v["before"], v["after"], v["plan"]

    def restore(label, working, published, staged, want_new):
        root = parent / label
        root.mkdir()
        for path, value in working.items():
            dst = root / path
            dst.parent.mkdir(parents=True, exist_ok=True)
            dst.write_bytes(value.encode())
        j = root / ".waffle/journal"
        tx = j / v["transaction"]
        tx.mkdir(parents=True)
        (j / "lock").touch()
        for path in staged:
            b = desired[path].encode()
            (tx / digest(b)).write_bytes(b)
        if published:
            (j / "active").write_bytes(active)
            call(cli, root, v["manifest"], "read", {"paths": [v["manifest"]]}, ok=False)
        for _ in range(2):
            call(cli, root, v["manifest"], "recover")
            expect = desired if want_new else old
            for name in set(old) | set(desired):
                f = root / name
                assert (f.read_bytes() if f.exists() else None) == (expect[name].encode() if name in expect else None)

    # No authored install is issued before durable publication. Partial orphan
    # staging cannot affect an old checkout, regardless of what the device retained.
    for size in range(len(order) + 1):
        restore("prepare-" + str(size), old, False, order[:size], False)
    # An unconfirmed active-name rename may survive or disappear. The earlier
    # whole-device barrier has already persisted every staged payload and its name.
    restore("unconfirmed-name", old, True, order, True)
    # A valid durable active descriptor survives any permissible subset of
    # subsequent atomic namespace installs until the working-files device barrier.
    for mask in itertools.product((False, True), repeat=len(order)):
        working = dict(old)
        for installed, name in zip(mask, order):
            if installed:
                working[name] = desired[name]
        restore("install-" + "".join(str(int(x)) for x in mask), working, True, order, True)
    # The active unlink may survive only after the complete desired tree is durable.
    # Once its absence is flushed, even partially retired private payloads are harmless.
    for size in range(len(order) + 1):
        restore("retire-" + str(size), desired, False, order[:size], True)
    print("PASS 11 modeled device-persistence outcomes through two independent native recoveries")


def replaced_lock_case(cli, root):
    manifest, _, _ = create(root)
    j = root / ".waffle/journal"
    j.mkdir(parents=True)
    (j / "lock").touch()
    gate = root.parent / "reader-gate"
    env = {**os.environ, "WAFFLE_FOLDER_PAUSE": "read-locked", "WAFFLE_FOLDER_GATE": str(gate)}
    process = subprocess.Popen([str(cli), str(root), manifest, "read"], stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                               stderr=subprocess.PIPE, text=True, env=env)
    try:
        process.stdin.write(json.dumps({"paths": [manifest]}))
        process.stdin.close()
        deadline = time.monotonic() + 5
        while not Path(str(gate) + ".ready").exists() and time.monotonic() < deadline:
            time.sleep(0.002)
        assert Path(str(gate) + ".ready").exists()
        os.replace(j / "lock", j / "removed-lock")
        (j / "lock").touch()
        Path(str(gate) + ".resume").touch()
        assert process.wait(timeout=5) != 0
        assert "error" in json.loads(process.stdout.read())
    finally:
        if process.poll() is None:
            process.kill()
            process.wait()
    print("PASS replacing a live lock invalidates the cross-process snapshot")


def finder_folder_case(cli, root):
    # A launcher may supply an outer run directory with a real *directory* named
    # project.waffle inside it. Finder may open only the inner project.
    nested = root / "project.waffle"
    nested.mkdir()
    manifest, _, _ = create(nested)
    assert call(cli, nested, manifest, "discover")[0]["manifest"] == manifest
    response = call(cli, root, manifest, "discover", ok=False)
    assert "exactly one manifest" in response[0]["error"]
    print("PASS Finder distinguishes a nested project folder from its launch directory")


def manifest_membership_case(cli, root):
    manifest, _, _ = create(root)
    path = root / manifest
    original = path.read_bytes()

    def member(name, id):
        return {"kind": "document", "docKind": "schematic", "path": name, "id": id,
                "name": Path(name).stem}

    # Native membership validates every reference without accessing an inactive body.
    valid = original + rows(member("Schematics/Étage.wsch", "unicode"), member("Upper-case_1.wsch", "ascii"))
    path.write_bytes(valid)
    files = call(cli, root, manifest, "read", {"paths": [manifest]})[0]["files"]
    assert len(files) == 1 and files[0]["sha256"] == digest(valid)
    for case in (
        [member("POWER.wsch", "other")],
        [member("Other.wsch", "s1")],
        [member("Étage.wsch", "a"), member("étage.wsch", "b")],
        [member("E\u0301tage.wsch", "non-nfc")],
        [member("../Power.wsch", "escape")],
        [member("Schematics/COM¹.wsch", "device")],
        [member("Schematics/.wsch", "hidden-extension")],
    ):
        path.write_bytes(original + rows(*case))
        call(cli, root, manifest, "read", {"paths": [manifest]}, ok=False)
    print("PASS strict native membership accepts portable paths and rejects aliases and invalid owners")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("driver", type=Path)
    driver = parser.parse_args().driver.resolve()
    with TemporaryDirectory(prefix="waffle-native-folder-") as temp:
        root = Path(temp)
        barrier = root / "barrier"
        barrier.mkdir()
        checks = call(driver,barrier,"Project.waffle","check-device-barriers")[0]["cases"]
        assert len(checks) == 9 and not list(barrier.iterdir()), checks
        print("PASS nine native full-device barriers, including rejected and verified fallback paths")
        finder = root / "finder"
        finder.mkdir()
        finder_folder_case(driver, finder)
        membership = root / "membership"
        membership.mkdir()
        manifest_membership_case(driver, membership)
        power = root / "power"
        power.mkdir()
        power_boundary_model(driver, power)
        replaced = root / "replaced"
        replaced.mkdir()
        replaced_lock_case(driver, replaced)
        replay = root / "replay"
        replay.mkdir()
        portable_replay(driver, replay)
        asset = root / "asset"
        asset.mkdir()
        asset_case(driver, asset)
        for i, point in enumerate((None, "before-publish", "after-publish", "acknowledged", "after-install:0")):
            target = root / str(i)
            target.mkdir()
            conflict_case(driver, target, point)


if __name__ == "__main__":
    main()
