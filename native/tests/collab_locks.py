#!/usr/bin/env python3
"""Lock and presence sidecars (docs/collaboration.md) on the macOS and Linux hosts, against
each other in one shared folder: exclusive create across processes and hosts, owner-only
replace and remove, explicit take-over, confinement to "<project>.<key>.waffle-lock" beside the
project, no writes through links, and closing removes only the window's own sidecars. The
Windows host has the same checks in native/windows/tests (CollabLockTests).

    python3 native/tests/collab_locks.py
"""
import importlib.util
import json
import os
from pathlib import Path
from fnmatch import fnmatchcase
import subprocess
import sys
import tempfile
from unittest.mock import patch

NATIVE = Path(__file__).resolve().parents[1]

SWIFT_WORKER = r"""
import Foundation
HostFiles.supportDirectory = URL(fileURLWithPath: CommandLine.arguments[1])
let project = URL(fileURLWithPath: CommandLine.arguments[2])
let locks = CollabLocks()
func emit(_ value: Any) {
    let data = try! JSONSerialization.data(withJSONObject: value, options: [.sortedKeys])
    print(String(data: data, encoding: .utf8)!); fflush(stdout)
}
emit(["ready": true, "session": locks.session, "machine": locks.machine])
while let line = readLine() {
    guard let request = try? JSONSerialization.jsonObject(with: Data(line.utf8)) as? [String: Any], let op = request["op"] as? String else { continue }
    do {
        switch op {
        case "list": emit(locks.listing(project: project))
        case "write": emit(try locks.write(project: URL(fileURLWithPath: request["project"] as? String ?? project.path), key: request["key"], data: request["data"], mode: request["mode"]))
        case "remove": emit(try locks.remove(project: project, key: request["key"], force: request["force"] as? Bool ?? false))
        case "own": locks.removeOwn(project: project); emit(["done": true])
        default: emit(["error": "op"])
        }
    } catch { emit(["error": error.localizedDescription]) }
}
"""


def linux_module():
    spec = importlib.util.spec_from_file_location("atrium_linux", NATIVE / "linux" / "waffle.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class LinuxHost:
    """The Linux host's CollabLocks, called directly (same request shape as the page)."""
    name = "linux"

    def __init__(self, app, support, project):
        self.locks, self.project, self.app = app.CollabLocks(support), project, app
        self.session, self.machine = self.locks.session, self.locks.machine

    def call(self, op, **kw):
        try:
            if op == "list":
                return self.locks.listing(self.project)
            if op == "write":
                publish = self.app.durable_replace

                def inspect_staging(source, destination):
                    staged = Path(source)
                    assert staged.parent == Path(destination).parent
                    assert staged.name.startswith(".waffle.pending-") and fnmatchcase(staged.name, "*.waffle.*.waffle-lock")
                    assert json.loads(staged.read_bytes())["atrium-lock"] == 1
                    assert all(not row["key"].startswith("pending-") for row in self.locks.listing(self.project)["locks"])
                    return publish(source, destination)

                with patch.object(self.app, "durable_replace", inspect_staging):
                    return self.locks.write(kw.get("project", self.project), kw.get("key"), kw.get("data"), kw.get("mode"))
            if op == "remove":
                return self.locks.remove(self.project, kw.get("key"), kw.get("force", False))
            if op == "own":
                self.locks.remove_own(self.project)
                return {"done": True}
        except ValueError as error:
            return {"error": str(error)}


class SwiftHost:
    """The macOS host's CollabLocks in its own process."""
    name = "macos"

    def __init__(self, binary, support, project):
        self.proc = subprocess.Popen([str(binary), str(support), str(project)], stdin=subprocess.PIPE, stdout=subprocess.PIPE, text=True)
        hello = json.loads(self.proc.stdout.readline())
        self.session, self.machine, self.project = hello["session"], hello["machine"], project

    def call(self, op, **kw):
        kw["op"] = op
        kw.setdefault("project", str(self.project))
        self.proc.stdin.write(json.dumps(kw) + "\n")
        self.proc.stdin.flush()
        return json.loads(self.proc.stdout.readline())

    def close(self):
        self.proc.stdin.close()
        self.proc.wait(timeout=10)


def check(hosts_a, hosts_b, root, project):
    a, b = hosts_a, hosts_b
    data = json.dumps({"kind": "edit", "doc": "board", "name": "Alice"})
    suffix = ".atrium-lock" if project.suffix == ".atrium" else ".waffle-lock"
    sidecar = root / (project.name + ".d-board" + suffix)
    old_stage = root / ".waffle.pending-crashed.waffle-lock"
    old_stage.write_text('{"atrium-lock":1,"session":"another-session"}')
    owner = root / "Layout.wpcb"
    owner.write_bytes(b"unchanged native owner\n")
    authored = {path: (path.stat(), path.read_bytes()) for path in (project, owner)}
    assert a.call("write", key="d-board", data=data, mode="create") == {"written": True}
    assert sidecar.exists()
    assert b.call("write", key="d-board", data="{}", mode="create") == {"written": False, "exists": True}, "exclusive create across hosts"
    assert b.call("write", key="d-board", data="{}", mode="replace") == {"written": False, "owner": False}
    assert a.call("write", key="d-board", data=json.dumps({"beat": 2}), mode="replace") == {"written": True}
    listing = b.call("list")
    record = json.loads(listing["locks"][0]["text"])
    assert listing["session"] == b.session and "project" in listing and listing["project"]["size"] > 0
    assert record["session"] == a.session and record["machine"] == a.machine and record["data"] == {"beat": 2} and record["atrium-lock"] == 1
    assert isinstance(record["pid"], int) and record["written"] > 1.6e12
    assert list(root.glob(".waffle.pending-*.waffle-lock")) == [old_stage], "successful replacement cleans only its own staging file"
    assert all(path.stat().st_mtime_ns == info.st_mtime_ns and path.stat().st_ino == info.st_ino and path.read_bytes() == contents
               for path, (info, contents) in authored.items()), "collaboration replacement leaves both manifest and owner physically unchanged"
    assert b.call("remove", key="d-board") == {"removed": False, "owner": False}
    assert b.call("write", key="d-board", data="{}", mode="takeover") == {"written": True}
    assert a.call("write", key="d-board", data="{}", mode="replace") == {"written": False, "owner": False}, "the old owner learns it lost the lock"
    # Confinement: keys, data, project, links.
    for bad in ("../x", "-x", "a/b", "a b", "", "x" * 65, "d-é"):
        assert "Invalid lock name" in a.call("write", key=bad, data="{}", mode="create").get("error", ""), bad
    assert "small JSON object" in a.call("write", key="d-x", data="[1]", mode="create").get("error", "")
    assert "small JSON object" in a.call("write", key="d-x", data=json.dumps({"a": "x" * 9000}), mode="create").get("error", "")
    assert "Unknown lock mode" in a.call("write", key="d-x", data="{}", mode="overwrite").get("error", "")
    assert "error" in a.call("write", project=str(root / "notes.txt"), key="d-x", data="{}", mode="create")
    target = root / "target.txt"
    target.write_text("keep")
    link = root / (project.name + ".d-link" + suffix)
    link.symlink_to(target)
    assert a.call("write", key="d-link", data="{}", mode="create") == {"written": False, "exists": True}
    assert target.read_text() == "keep", "create never writes through a link"
    assert not any(l["key"] == "d-link" for l in a.call("list")["locks"]), "a link is not listed (reads never follow it)"
    link.unlink()
    (root / ("Other" + project.suffix + ".d-x" + suffix)).write_text("{}")
    (root / (project.name + ".bad name" + suffix)).write_text("{}")
    assert [l["key"] for l in a.call("list")["locks"]] == ["d-board"], "only this project's well-named sidecars"
    # Presence, then closing a window removes only its own files.
    assert a.call("write", key="s-a", data=json.dumps({"kind": "presence"}), mode="create") == {"written": True}
    b.call("own")
    assert not sidecar.exists() and (root / (project.name + ".s-a" + suffix)).exists()
    a.call("own")
    (root / ("Other" + project.suffix + ".d-x" + suffix)).unlink()
    (root / (project.name + ".bad name" + suffix)).unlink()
    assert not list(root.glob(project.name + ".*" + suffix))
    assert old_stage.read_text() == '{"atrium-lock":1,"session":"another-session"}', "closing ignores an unrelated staged lock"
    old_stage.unlink()


def observed_mac_writer(path):
    """Inspect the actual flushed staging file in a scratch copy of the native writer."""
    source = (NATIVE / "macos" / "ProjectWrites.swift").read_text()
    publish = '        guard rename(temporary, destination.path) == 0'
    assert source.count(publish) == 1
    observation = r'''        if collaborationLock {
            let staged = URL(fileURLWithPath: temporary)
            let basename = staged.lastPathComponent
            precondition(staged.deletingLastPathComponent().path == folder)
            precondition(basename.hasPrefix(".waffle.pending-") && basename.hasSuffix(".waffle-lock"))
            let payload = try JSONSerialization.jsonObject(with: Data(contentsOf: staged)) as? [String: Any]
            precondition(payload?["atrium-lock"] as? Int == 1)
            let project = URL(fileURLWithPath: CommandLine.arguments[2])
            let locks = CollabLocks().listing(project: project)["locks"] as? [[String: Any]] ?? []
            precondition(!locks.contains { ($0["key"] as? String)?.hasPrefix("pending-") == true })
        }
'''
    path.write_text(source.replace(publish, observation + publish))
    return path


def main():
    app = linux_module()
    with tempfile.TemporaryDirectory() as directory:
        root = Path(directory).resolve()
        factories = [lambda support, project: LinuxHost(app, support, project)]
        if sys.platform == "darwin":
            source = root / "worker" / "main.swift"
            source.parent.mkdir()
            source.write_text(SWIFT_WORKER)
            binary = root / "worker" / "locks"
            writer = observed_mac_writer(source.parent / "ProjectWrites.swift")
            subprocess.run(["xcrun", "swiftc", "-module-cache-path", str(root / "worker" / "cache"), str(writer),
                            str(NATIVE / "macos" / "HostState.swift"), str(source), "-o", str(binary)], check=True)
            factories.append(lambda support, project: SwiftHost(binary, support, project))
        runs = 0
        project = root / "Board.waffle"
        project.write_text('{"kind":"project","formatVersion":"2.0","id":"cooperative"}\n')
        for i, first in enumerate(factories):
            for j, second in enumerate(factories):
                a, b = first(root / ("support-a%d%d" % (i, j)), project), second(root / ("support-b%d%d" % (i, j)), project)
                assert a.session != b.session and a.machine != b.machine
                check(a, b, root, project)
                again = first(root / ("support-a%d%d" % (i, j)), project)
                assert again.machine == a.machine and again.session != a.session, "the machine id persists; each window has a session"
                for h in (a, b, again):
                    if hasattr(h, "close"):
                        h.close()
                runs += 1
        assert oct(os.stat(root / "support-a00" / "machine-id").st_mode & 0o777) == "0o600"
    print("collab_locks: ok (%d host pairings: %s)" % (runs, ", ".join("linux" if i == 0 else "macos" for i in range(len(factories)))))


if __name__ == "__main__":
    main()
