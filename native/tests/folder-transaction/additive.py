#!/usr/bin/env python3
"""Verify the additive owner contract with the real native driver and its stdio entry point."""
import argparse
import base64
import hashlib
import json
import os
import select
import time
import subprocess
import sys
import tempfile
from pathlib import Path


FIXTURE = json.loads(Path(__file__).with_suffix(".json").read_text())
MANIFEST, MEMBER, OPAQUE = (FIXTURE[k] for k in ("manifest", "member", "opaque"))


def digest(data):
    return hashlib.sha256(data.encode()).hexdigest()


def seed(root, files=None):
    for name, text in (files or FIXTURE["files"]).items():
        path = root / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(text.encode())


def snapshot(root):
    return {p.relative_to(root): p.read_bytes() if p.is_file() else None for p in root.rglob("*")}


def plan(source, target, *, path=MEMBER, payload="splice"):
    expected = digest(source)
    entry = {"path": path, "expected": expected}
    if payload == "splice":
        start, end = 0, len(source)
        a, b = source.splitlines(keepends=True), target.splitlines(keepends=True)
        while a and b and a[0] == b[0]:
            start += len(a.pop(0))
            b.pop(0)
        while a and b and a[-1] == b[-1]:
            end -= len(a.pop())
            b.pop()
        entry["splice"] = {"base": expected, "edits": [{"offset": len(source[:start].encode()),
            "remove": len(source[start:end].encode()), "insert": "".join(b)}]}
    elif payload == "text":
        entry["text"] = target
    else:
        entry["data"] = base64.b64encode(target.encode()).decode()
    return {"projectId": FIXTURE["projectId"], "manifest": MANIFEST, "plan": [entry]}


def call(driver, root, command, request=None, kill=None):
    env = os.environ.copy()
    if kill:
        env["WAFFLE_FOLDER_KILL"] = kill
    proc = subprocess.run([driver, root, MANIFEST, command], input=json.dumps(request or {}), text=True,
                          env=env, capture_output=True, timeout=30)
    return proc.returncode, [json.loads(s) for s in proc.stdout.splitlines()]


def pipe_barrier(helper, driver, before, new, external=False):
    """Read the actual durable reply with the writer still paused under its real lock."""
    with tempfile.TemporaryDirectory() as temp:
        parent = Path(temp)
        root, gate = parent / "Design", parent / "pause"
        root.mkdir()
        seed(root)
        env = dict(os.environ, WAFFLE_TEST_PAUSE_FOLDER_AT="before-install:0", WAFFLE_TEST_FOLDER_GATE=str(gate))
        proc = subprocess.Popen([helper, "--folder-mcp", root / MANIFEST], stdin=subprocess.PIPE, stdout=subprocess.PIPE, env=env)
        def send(value):
            proc.stdin.write((json.dumps(value) + "\n").encode())
            proc.stdin.flush()
        def receive(timeout=3):
            assert select.select([proc.stdout], [], [], timeout)[0], "native stdio did not reply"
            return json.loads(proc.stdout.readline())
        try:
            assert receive()["manifest"] == MANIFEST
            bad = plan(before, new.replace('"preserved"','"rewritten"'))
            send({"op":"commit", "request":bad})
            assert "error" in receive() and not (root / ".waffle").exists()
            send({"op":"commit", "request":plan(before,new)})
            receipt = receive()["result"]
            assert receipt["saved"] and receipt["hashes"][MEMBER] == digest(new)
            until = time.monotonic() + 3
            while not gate.with_suffix(".ready").exists():
                assert time.monotonic() < until
                time.sleep(0.005)
            assert (root / MEMBER).read_bytes() == before.encode()
            assert (root / ".waffle/journal/active").is_file()
            assert call(driver,root,"read",{"paths":[MANIFEST,MEMBER]})[0] != 0
            send({"op":"acquire"})
            assert not select.select([proc.stdout], [], [], 0.05)[0], "read completed during install"
            if external:
                (root / MEMBER).write_bytes(before.replace("SENSE","EXTERNAL").encode())
            gate.with_suffix(".resume").touch()
            result = receive()
            if external:
                assert "error" in result and (root / ".waffle/journal/active").is_file(), result
                assert "EXTERNAL" in (root / MEMBER).read_text()
            else:
                lease = result["result"]["lease"]
                send({"op":"read","lease":lease,"paths":[MANIFEST,MEMBER]})
                assert receive()["result"]["files"][1]["sha256"] == digest(new)
                send({"op":"release","lease":lease})
                assert receive()["result"] is True
            assert not select.select([proc.stdout], [], [], 0.05)[0], "commit produced a duplicate reply"
        finally:
            gate.with_suffix(".resume").touch(exist_ok=True)
            proc.stdin.close()
            proc.wait(timeout=8)
            proc.stdout.close()


def removed_volume(driver, before, new):
    """Detach a private test disk after publication and before the durable reply."""
    if sys.platform != "darwin":
        raise ValueError("The detached-volume check requires macOS disk images.")

    def disk(*args):
        subprocess.run(["hdiutil", *map(str, args)], capture_output=True, check=True, timeout=35)

    with tempfile.TemporaryDirectory(prefix="waffle-folder-volume-") as tmp:
        base = Path(tmp)
        mount, image, gate = base / "mount", base / "private.dmg", base / "checkpoint"
        disk("create", "-quiet", "-size", "24m", "-fs", "HFS+", "-layout", "NONE", "-type", "UDIF",
             "-volname", "WaffleFolderTest", image)

        def attach():
            mount.mkdir(exist_ok=True)
            disk("attach", "-quiet", "-nobrowse", "-noautoopen", "-owners", "on", "-mountpoint", mount, image)
            assert mount.stat().st_dev != base.stat().st_dev

        attach()
        mounted = True
        process = None
        try:
            root = mount / "Design"
            root.mkdir(mode=0o700)
            seed(root)
            env = dict(os.environ, WAFFLE_FOLDER_PAUSE="after-publish", WAFFLE_FOLDER_GATE=str(gate))
            process = subprocess.Popen([driver, root, MANIFEST, "commit"], stdin=subprocess.PIPE,
                                       stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, env=env)
            process.stdin.write(json.dumps(plan(before, new)))
            process.stdin.close()
            deadline = time.monotonic() + 8
            while not gate.with_suffix(".ready").exists():
                assert process.poll() is None and time.monotonic() < deadline
                time.sleep(0.005)

            active = root / ".waffle/journal/active"
            assert active.is_file() and (root / MEMBER).read_bytes() == before.encode()
            disk("detach", "-force", mount)
            mounted = False
            gate.with_suffix(".resume").touch()
            process.wait(timeout=8)
            replies = [json.loads(line) for line in process.stdout]
            assert process.returncode and not any(value.get("saved") for value in replies)

            attach()
            mounted = True
            expected = new if active.exists() else before
            for _ in range(2):
                code, response = call(driver, root, "recover")
                assert code == 0 and response[0]["state"] == "settled"
                assert (root / MEMBER).read_bytes() == expected.encode()
                for name in (MANIFEST, OPAQUE):
                    assert (root / name).read_bytes() == FIXTURE["files"][name].encode()
            return "published" if expected == new else "original"
        finally:
            gate.with_suffix(".resume").touch(exist_ok=True)
            if process is not None:
                try:
                    process.wait(timeout=8)
                except subprocess.TimeoutExpired:
                    process.kill()
                    process.wait(timeout=8)
                process.stdout.close()
                process.stderr.close()
            if mounted:
                disk("detach", "-quiet", mount)


def native_copy_fixture(project, owner):
    path, owner_id = "Selected.wsch", "f1234567-89ab-7cde-8f01-23456789abcd"
    head, body = owner.split("\n", 1)
    opaque = r',"x-header": {"\ud800":"\udfff","mass":1e400}'
    raw = head.replace('"d1"', json.dumps(owner_id))[:-1] + opaque + "}\r\n" + body
    after = project + json.dumps({"kind":"document", "id":owner_id, "docKind":"schematic",
                                  "name":"Selected", "path":path}, separators=(",", ":")) + "\n"

    def request(payload, witnessed, *, undo=False):
        sha = digest(witnessed)
        owner = {"path":path, "nativeCopy":{"grant":"selected-fixture", "sha256":sha}}
        if undo:
            owner.update(expected=sha, remove=True)
        else:
            owner.update(expected=None, data=base64.b64encode(payload.encode()).decode())
        manifest = {"path":MANIFEST, "expected":digest(after if undo else project), "text":project if undo else after}
        return {"projectId":FIXTURE["projectId"], "manifest":MANIFEST, "testNativeCopyHashes":{path:sha}, "plan":[owner, manifest]}

    reserved = raw.replace('["future-constraint"]', '["future-constraint","continuation-parts-v1"]')
    return path, raw, reserved, after, request


def check_native_copy(driver, project, owner):
    path, raw, reserved, after, request = native_copy_fixture(project, owner)
    for command, payload, witness, message in (
            ("commit", raw, raw, "selected-file grant"),
            ("commit-approved-copy", raw.replace("SENSE","NEW"), raw, "bytes or destination changed"),
            ("commit-approved-copy", reserved, reserved, "continuation-parts-v1")):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            seed(root, {MANIFEST:project})
            code, reply = call(driver,root,command,request(payload,witness))
            assert code != 0 and message in reply[0]["error"], reply
            assert not (root / ".waffle/journal/active").exists() and not (root / path).exists()
            assert (root / MANIFEST).read_bytes() == project.encode()
    with tempfile.TemporaryDirectory() as temp:
        root = Path(temp)
        seed(root, {MANIFEST:project})
        code, reply = call(driver,root,"commit-approved-copy",request(raw,raw),kill="before-install:0")
        assert code != 0 and reply[0]["saved"] and reply[0]["hashes"][path] == digest(raw), reply
        assert not (root / path).exists() and (root / ".waffle/journal/active").is_file()
        for _ in range(2):
            assert call(driver,root,"recover")[0] == 0
        assert (root / path).read_bytes() == raw.encode() and (root / MANIFEST).read_bytes() == after.encode()
        code, reply = call(driver,root,"commit",plan(raw,raw.replace("SENSE","NEW"),path=path))
        assert code != 0 and "future-constraint" in reply[0]["error"], reply
        assert (root / path).read_bytes() == raw.encode() and not (root / ".waffle/journal/active").exists()
        undo = request(None,raw,undo=True)
        assert call(driver,root,"commit",undo)[0] != 0
        (root / path).write_bytes(raw.replace("SENSE","EXTERNAL").encode())
        assert call(driver,root,"commit-approved-copy",undo)[0] != 0
        assert (root / path).read_bytes() == raw.replace("SENSE","EXTERNAL").encode()
        (root / path).write_bytes(raw.encode())
        code, reply = call(driver,root,"commit-approved-copy",undo,kill="before-install:0")
        assert code != 0 and reply[0]["saved"] and reply[0]["hashes"][path] is None, reply
        for _ in range(2):
            assert call(driver,root,"recover")[0] == 0
        assert not (root / path).exists() and (root / MANIFEST).read_bytes() == project.encode()
        assert call(driver,root,"commit-approved-copy",request(raw,raw))[0] == 0
        assert (root / path).read_bytes() == raw.encode() and (root / MANIFEST).read_bytes() == after.encode()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("driver", type=Path)
    parser.add_argument("--stdio", type=Path, help="the native Waffle executable with --folder-mcp support")
    parser.add_argument("--pause-host", type=Path, help="optional macOS test executable from mcp-main.swift")
    parser.add_argument("--detached-volume", action="store_true", help="detach a new private macOS disk image before the save receipt")
    args = parser.parse_args()
    before = FIXTURE["files"][MEMBER]
    new = before.replace(FIXTURE["edit"]["from"], FIXTURE["edit"]["to"])
    assert digest(before) == FIXTURE["expected"] and digest(new) == FIXTURE["desired"]
    current_project = "".join(row for row in FIXTURE["files"][MANIFEST].splitlines(keepends=True) if OPAQUE not in row)
    current_owner = before.replace('"2.1"', '"2.0"')
    requirement = ',"readerRequires":{"future-constraint":"2.8"},"requires":["future-constraint"]'
    current_project = current_project.replace('"formatVersion":"2.1"', '"formatVersion":"2.0"')
    def required(text):
        head, body = text.split("\n", 1)
        return head[:-1] + requirement + "}\n" + body
    header, body = current_owner.split("\n",1)
    lexical = '\\u006b' + 'ind'
    invalid_headers = [
        header.replace('"kind"', '"' + lexical + '"'),
        header[:-1] + ',"x-field":{"label":1,"\\u006cabel":2}}',
        header[:-1] + ',"readerRequires":{"missing-capability":"2.8"}}',
        header[:-1] + r',"x-field":{"\ud800":1,"\uD800":2}}',
        header[:-1] + ',"x-field":[1,]}',
        header[:-1] + ',}',
        header[:-1] + ',"x-field":"' + ("x" * 65536) + '"}',
    ]
    invalid_owners = [(invalid_header + "\n" + body).encode() for invalid_header in invalid_headers]
    invalid_owners.extend([current_owner.encode("utf-16-le"), current_owner.encode().replace(b'"kind"', b'"\xffkind"', 1)])
    for invalid_owner in invalid_owners:
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            seed(root, {MANIFEST:current_project})
            (root / MEMBER).write_bytes(invalid_owner)
            assert call(args.driver,root,"read",{"paths":[MANIFEST,MEMBER]})[0] != 0
            assert not (root / ".waffle").exists()
            assert (root / MEMBER).read_bytes() == invalid_owner
    check_native_copy(args.driver, current_project, required(current_owner))
    for mode in ("manifest", "owner", "proposed"):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            manifest = required(current_project) if mode == "manifest" else current_project
            owner = required(current_owner) if mode == "owner" else current_owner
            proposed = owner.replace("SENSE", "NEW")
            if mode == "proposed":
                proposed = required(proposed)
            seed(root, {MANIFEST:manifest,MEMBER:owner})
            code, reply = call(args.driver,root,"commit",plan(owner,proposed))
            diagnostic = reply[0].get("error", "") if reply else ""
            assert code != 0 and "future-constraint" in diagnostic and "native format 2.8" in diagnostic, (mode,reply)
            assert not (root / ".waffle/journal/active").exists()
            assert (root / MANIFEST).read_bytes() == manifest.encode() and (root / MEMBER).read_bytes() == owner.encode()
    with tempfile.TemporaryDirectory() as temp:
        root = Path(temp)
        header, known, _ = current_owner.splitlines()
        raw = header + "\r\n" + known + '\n{ "kind":"futureTrace", "id":"n2", "future": {"q":1.20e2,"\\u0061":1e400} }\r\n'
        edited = raw.replace("SENSE", "NEW")
        seed(root, {MANIFEST:current_project,MEMBER:raw})
        code, reply = call(args.driver,root,"commit",plan(raw,edited))
        assert code == 0 and reply[0]["hashes"][MEMBER] == digest(edited), reply
        assert (root / MEMBER).read_bytes() == edited.encode() and (root / MANIFEST).read_bytes() == current_project.encode()
    for payload in ("splice", "text", "data"):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            seed(root)
            request = plan(before, new, payload=payload)
            code, reply = call(args.driver, root, "commit", request)
            assert code == 0 and reply[0]["saved"] and reply[0]["hashes"][MEMBER] == digest(new), (payload, reply)
            for name, contents in FIXTURE["files"].items():
                assert (root / name).read_bytes() == (new if name == MEMBER else contents).encode()
    with tempfile.TemporaryDirectory() as temp:
        root = Path(temp)
        seed(root)
        (root / "Unlisted.wsch").write_bytes(before.encode())
        for paths in ([MEMBER], [OPAQUE], [MANIFEST,"Unlisted.wsch"]):
            assert call(args.driver,root,"read",{"paths":paths})[0] != 0, paths
        code, data = call(args.driver,root,"read",{"paths":[MANIFEST,MEMBER,OPAQUE]})
        assert code == 0 and [f["path"] for f in data[0]["files"]] == [MANIFEST,MEMBER,OPAQUE], data
        assert not (root / ".waffle").exists()
    clean_row = '{"kind":"netlabel","id":"n3","at":[1,2],"text":"GND"}\n'
    with tempfile.TemporaryDirectory() as temp:
        root = Path(temp)
        seed(root)
        for baseline, desired in ((before,before+clean_row),(before+clean_row,before)):
            code, reply = call(args.driver,root,"commit",plan(baseline,desired))
            assert code == 0 and reply[0]["saved"] and (root / MEMBER).read_bytes() == desired.encode(), reply
    mutations = list(FIXTURE["refuse"]) + [
        {"name": "staleBase"}, {"name": "undeclared"}, {"name": "opaqueOwner"}, {"name": "unknownFieldDropped"},
        {"name": "untypedCoordinate"}, {"name": "addedOpaqueKey"}, {"name": "removedOpaqueRow"},
        {"name": "secretNestedChange"}, {"name": "misplacedUnrelatedLine"}]
    for case in mutations:
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            files, target, path = FIXTURE["files"].copy(), new, MEMBER
            label = case["name"]
            if "file" in case:
                key = case["file"]
                if key == "desired":
                    target = new.replace(case["find"], case["replace"])
                else:
                    name = MEMBER if key == "owner" else MANIFEST
                    files[name] = files[name].replace(case["find"], case["replace"])
                    if key == "owner":
                        target = target.replace(case["find"], case["replace"])
            elif label == "undeclared":
                path = "Unindexed.wsch"
                files[path] = before
            elif label == "opaqueOwner":
                path = OPAQUE
                target = files[path].replace("[2,4]", "[2,5]")
            elif label == "unknownFieldDropped":
                target = target.replace(',"future":{"nested":["preserved",{"measurement":21}]}', "")
            elif label == "untypedCoordinate":
                target = target.replace("[1100,2200]", '[1100,{"x":2200}]')
            elif label == "addedOpaqueKey":
                target = target.replace('"text":"DRIVE"', '"extra":1,"text":"DRIVE"')
            elif label == "removedOpaqueRow":
                target = "".join(target.splitlines(keepends=True)[:-1])
            elif label == "secretNestedChange":
                target = target.replace('"preserved"', '"changed"')
            elif label == "misplacedUnrelatedLine":
                rows = target.splitlines(keepends=True)
                target = rows[0] + rows[2] + rows[1]
            request = plan(files[path], target, path=path)
            if label == "staleBase":
                request["plan"][0]["expected"] = "0" * 64
            seed(root, files)
            pristine = snapshot(root)
            code, replies = call(args.driver, root, "commit", request)
            assert code and "error" in replies[0] and snapshot(root) == pristine, (label, replies, snapshot(root).keys())
    for step in ("before-publish", "after-publish", "acknowledged", "after-install:0", "after-unlink"):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            seed(root)
            code, _ = call(args.driver, root, "commit", plan(before, new), kill=step)
            assert code != 0
            expected = before if step == "before-publish" else new
            for repeat in range(2):
                code, reply = call(args.driver, root, "recover")
                assert code == 0 and reply[0]["state"] == "settled", (step, repeat, reply)
                assert (root / MEMBER).read_bytes() == expected.encode()
                assert (root / OPAQUE).read_bytes() == FIXTURE["files"][OPAQUE].encode()
    if args.stdio:
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            seed(root)
            message = {"op": "commit", "request": plan(before, new), "readSet": {name: digest(raw) for name,raw in FIXTURE["files"].items()}}
            rejected = {**message, "request":plan(before,new.replace('"preserved"','"changed"'))}
            calls = "".join(json.dumps(packet) + "\n" for packet in (rejected,message))
            proc = subprocess.run([args.stdio, "--folder-mcp", root / MANIFEST], input=calls,
                                  text=True, capture_output=True, check=True, timeout=30)
            replies = [json.loads(line) for line in proc.stdout.splitlines()]
            assert len(replies) == 3 and replies[0] == {"manifest": MANIFEST}, replies
            assert "error" in replies[1] and replies[2]["result"]["saved"], replies
            assert (root / MEMBER).read_bytes() == new.encode()
    if args.detached_volume:
        state = removed_volume(args.driver, before, new)
        print(f"PASS private device removal withheld Saved; two remounted recoveries observed the {state} state.")
    if args.pause_host:
        pipe_barrier(args.pause_host,args.driver,before,new)
        pipe_barrier(args.pause_host,args.driver,before,new,external=True)
        print("PASS one native stdio durable receipt while installation is blocked; successful and conflicting reads.")
    print("PASS additive owner through byte splice, complete bytes, untouched files,", len(mutations),
          "pristine refusals and five twice-recovered interruptions" + (", including native stdio" if args.stdio else ""))


if __name__ == "__main__":
    main()
