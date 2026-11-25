#!/usr/bin/env python3
"""Exercise the macOS verification-only read with real pinned files and leases."""
import argparse
import base64
import hashlib
import json
import os
from pathlib import Path
import random
import select
import struct
import subprocess
import tempfile
import time
import zlib
from contextlib import contextmanager


HEADER = bytes.fromhex("1f8b08000000000002ff")
NONCE = "0123456789abcdef" * 2
CAP = 32 * 1024 * 1024
MANIFEST = "Sensor.waffle"
ROOT_BYTES = b'{"formatVersion":"2.0","id":"project","kind":"project"}\n'


def sha(data):
    return hashlib.sha256(data).hexdigest()


def gzip_member(raw, level=9):
    encoder = zlib.compressobj(level, zlib.DEFLATED, -15)
    return HEADER + encoder.compress(raw) + encoder.flush() + struct.pack("<II", zlib.crc32(raw), len(raw))


def reference(raw):
    digest = sha(raw)
    return {"path": f"models/{digest}.step.gz", "sha256": digest, "byteLength": len(raw)}


def put(root, raw):
    ref, stored = reference(raw), gzip_member(raw)
    (root / ref["path"]).write_bytes(stored)
    return ref, stored


def seed(root):
    root.mkdir()
    (root / MANIFEST).write_bytes(ROOT_BYTES)
    (root / "models").mkdir()


class Client:
    def __init__(self, executable, root, manifest, env):
        self.proc = subprocess.Popen([executable, root, manifest, "model-session"], env=env, text=True,
                                     stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)
        self.grant = self.receive()["grant"]

    def send(self, op, **fields):
        self.proc.stdin.write(json.dumps(dict(op=op, **fields)) + "\n")
        self.proc.stdin.flush()

    def receive(self):
        assert select.select([self.proc.stdout], [], [], 15)[0], "native verifier timed out"
        return json.loads(self.proc.stdout.readline())

    def call(self, op, **fields):
        self.send(op, **fields)
        return self.receive()

    def lease(self):
        response = self.call("acquire")
        assert response["verifyModels"] == "gzip-v1", response
        return response["lease"]

    def request(self, lease, paths, refs):
        return {"grant": self.grant, "lease": lease, "verificationNonce": NONCE, "paths": paths, "models": refs}

    def close(self):
        self.proc.stdin.close()
        try:
            self.proc.wait(timeout=5)
        except subprocess.TimeoutExpired:
            self.proc.kill()
            self.proc.wait(timeout=5)
        self.proc.stdout.close()


@contextmanager
def client(driver, root, manifest=MANIFEST, **environment):
    host = Client(driver, root, manifest, {**os.environ, **environment})
    try:
        yield host
    finally:
        host.close()


def checked_row(ref, stored):
    return {"path": ref["path"], "sha256": sha(stored), "length": len(stored),
            "model": {"sha256": ref["sha256"], "byteLength": ref["byteLength"]}}


def proofs(driver, base):
    root = base / "vectors"
    seed(root)
    golden = b"ISO-10303-21;\nHEADER;\nENDSEC;\nDATA;\nENDSEC;\nEND-ISO-10303-21;\n"
    golden_gz = bytes.fromhex("1f8b08000000000002fff30cf6d73534303630d63532b4e6f2707574710db2e672f573097675b6e672710c7144f080b4ae278a7a00ff45e3cd3e000000")
    assert gzip_member(golden) == golden_gz
    samples = [put(root, raw) for raw in (golden, b"", random.Random(7).randbytes(1100000), b"A" * 65536)]
    ref, stored = samples[0]
    path = ref["path"]
    with client(driver, root) as host:
        lease = host.lease()
        req = host.request(lease, [MANIFEST, path], [ref])
        response = host.call("verify", **req)
        assert response == {"lease": lease, "verificationNonce": NONCE, "files": [
            {"path": MANIFEST, "sha256": sha(ROOT_BYTES), "length": len(ROOT_BYTES),
             "data": base64.b64encode(ROOT_BYTES).decode()}, checked_row(ref, stored)]}, response
        all_refs = [r for r, _ in samples]
        batch = host.request(lease, [r["path"] for r in all_refs], all_refs)
        assert host.call("verify", **batch)["files"] == [checked_row(*sample) for sample in samples]
        plain = host.call("verify", **{**req, "paths": [path], "models": []})["files"][0]
        assert base64.b64decode(plain["data"]) == stored and "model" not in plain
        invalid = [{"verificationNonce": v} for v in ("x" * 32, NONCE.upper(), NONCE[:-1], None)]
        invalid += [{"grant": "a different root"}, {"lease": "expired"}, {"paths": []},
                    {"paths": [str(i) for i in range(9)]}, {"paths": [path, path.upper()]},
                    {"models": [ref, ref]}, {"paths": [MANIFEST]}, {"models": [{"path": path}]}]
        for field, val in (("byteLength", -1), ("byteLength", False), ("byteLength", 1.5),
                           ("byteLength", CAP + 1), ("sha256", ref["sha256"].upper()),
                           ("path", path.replace("step", "stp")), ("path", "/" + path),
                           ("path", "models/../" + path), ("path", path.replace(".gz", ".GZ"))):
            edited = {**ref, field: val}
            invalid.append({"paths": [edited["path"]], "models": [edited]})
        for override in invalid:
            assert "error" in host.call("verify", **{**req, **override}), override
        assert host.call("release", lease=lease) == {"released": True}
        assert "error" in host.call("verify", **req)

    target = root / path
    corrupt = [b"", stored[:15], stored[:-1], stored + b" ", stored + stored,
               stored[:3] + b"\x08" + stored[4:], stored[:9] + b"\x03" + stored[10:],
               stored[:-8] + bytes([stored[-8] ^ 1]) + stored[-7:], stored[:-1] + bytes([stored[-1] ^ 1]),
               stored[:10] + b"\xff\xff" + stored[12:], gzip_member(b"X" * len(golden))]
    with client(driver, root) as host:
        for content in corrupt:
            target.write_bytes(content)
            lease = host.lease()
            assert "error" in host.call("verify", **host.request(lease, [path], [ref]))
            assert "released" in host.call("release", lease=lease)
        alternate = gzip_member(golden, level=0)
        assert alternate != stored
        target.write_bytes(alternate)
        lease = host.lease()
        proof = host.call("verify", **host.request(lease, [path], [ref]))
        assert proof["files"] == [checked_row(ref, alternate)]
        target.write_bytes(stored)
        assert "error" in host.call("release", lease=lease)
        for length in (1, len(golden) - 1, len(golden) + 1):
            lease = host.lease()
            assert "error" in host.call("verify", **host.request(lease, [path], [{**ref, "byteLength": length}]))
            assert "released" in host.call("release", lease=lease)
        with target.open("wb") as stream:
            stream.truncate(10 + CAP + 5 * (CAP // 16383 + 1) + 9)
        lease = host.lease()
        assert "error" in host.call("verify", **host.request(lease, [path], [ref]))
        assert "released" in host.call("release", lease=lease)
    assert not (root / ".waffle").exists()


def containment(driver, base):
    raw = b"checked fixture"
    counts = {}
    for mode in ("hardlink", "symlink", "case-only-name", "directory-symlink", "file-alias", "directory-alias",
                 "after-read-replace", "between-check-and-receipt", "after-read-root", "after-read-alias"):
        root = base / mode
        seed(root)
        ref, stored = put(root, raw)
        name = ref["path"]
        target = root / name
        alias = target.with_name(target.name.upper())
        sensitive = not alias.exists()
        if "alias" in mode and not sensitive:
            counts[mode] = "needs case-sensitive volume"
            continue
        env = {}
        gate = base / "model-checkpoint"
        if mode == "between-check-and-receipt":
            env = {"WAFFLE_FOLDER_PAUSE": "verified-model-read", "WAFFLE_FOLDER_GATE": str(gate)}
        with client(driver, root, **env) as host:
            lease = host.lease()
            req = host.request(lease, [name], [ref])
            if mode == "hardlink":
                os.link(target, root / "second")
            elif mode == "symlink":
                target.rename(root / "other")
                target.symlink_to(root / "other")
            elif mode == "case-only-name":
                target.rename(alias)
            elif mode == "directory-symlink":
                (root / "models").rename(root / "other")
                (root / "models").symlink_to(root / "other", target_is_directory=True)
            elif mode == "file-alias":
                alias.write_bytes(stored)
            elif mode == "directory-alias":
                (root / "MODELS").mkdir()
            elif mode == "between-check-and-receipt":
                host.send("verify", **req)
                try:
                    until = time.monotonic() + 5
                    while not gate.with_suffix(".ready").exists():
                        assert time.monotonic() < until
                        time.sleep(0.005)
                    (root / "replacement").write_bytes(stored)
                    os.replace(root / "replacement", target)
                finally:
                    gate.with_suffix(".resume").touch()
                assert "error" in host.receive()
                counts[mode] = "passed"
                continue
            else:
                assert "files" in host.call("verify", **req)
                if mode == "after-read-root":
                    root.rename(base / "moved")
                    seed(root)
                elif mode == "after-read-alias":
                    alias.write_bytes(stored)
                else:
                    (root / "replacement").write_bytes(stored)
                    os.replace(root / "replacement", target)
                assert "error" in host.call("release", lease=lease), mode
                counts[mode] = "passed"
                continue
            assert "error" in host.call("verify", **req), mode
        counts[mode] = "passed"
    return counts


def corpus(driver, project):
    manifest, = [p.name for p in project.glob("*.waffle") if p.is_file()]
    samples = []
    for path in sorted((project / "models").glob("*.step.gz")):
        stored = path.read_bytes()
        ref = reference(zlib.decompress(stored, 31))
        assert project / ref["path"] == path
        samples.append((ref, checked_row(ref, stored)))
    assert samples
    with client(driver, project, manifest) as host:
        lease = host.lease()
        t0 = time.perf_counter_ns()
        for index in range(0, len(samples), 8):
            batch = samples[index:index + 8]
            refs = [item[0] for item in batch]
            result = host.call("verify", **host.request(lease, [r["path"] for r in refs], refs))
            assert result["files"] == [item[1] for item in batch]
        assert host.call("release", lease=lease) == {"released": True}
        elapsed = (time.perf_counter_ns() - t0) / 1_000_000
    return {"members": len(samples), "storedBytes": sum(r["length"] for _, r in samples),
            "rawBytes": sum(r["byteLength"] for r, _ in samples), "verificationMs": round(elapsed, 2)}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("driver", type=Path)
    parser.add_argument("--corpus", type=Path, help="read an explicitly selected public canonical project")
    parser.add_argument("--temporary-parent", type=Path, help="place synthetic tests on a selected test filesystem")
    args = parser.parse_args()
    if args.corpus:
        print(json.dumps(corpus(args.driver, args.corpus)))
    else:
        with tempfile.TemporaryDirectory(prefix="waffle-model-proof-", dir=args.temporary_parent) as temp:
            proofs(args.driver, Path(temp))
            print(json.dumps(containment(args.driver, Path(temp))))
        print("PASS canonical gzip, raw/stored identities, bounds, nonce, lease and unchanged byte reads")


if __name__ == "__main__":
    main()
