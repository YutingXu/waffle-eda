#!/usr/bin/env python3
"""Exercise source-preserving binary copy writes without presenting a file chooser."""
import importlib.util
import os
from pathlib import Path
import subprocess
import sys
import tempfile


NATIVE = Path(__file__).resolve().parents[1]
PREFIX = bytes(range(256)) * 121
PAYLOAD = PREFIX + b"\xff\x00new content"
ORIGINAL = PREFIX + b"source"


def python_worker(path):
    spec = importlib.util.spec_from_file_location("linux_atrium", NATIVE / "linux/waffle.py")
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    source = mod.AltiumCopySource(path)
    assert source.read() == ORIGINAL
    print("READY", flush=True)
    try:
        for destination in sys.stdin:
            try:
                source.save_copy(destination.rstrip("\n"), PAYLOAD)
                print("COPIED", flush=True)
            except (ValueError, OSError) as e:
                print(str(e), flush=True)
    finally:
        source.close()


SWIFT = '''
import Foundation
let source = try AltiumCopySource(URL(fileURLWithPath: CommandLine.arguments[1]))
let prefix = Data((0..<30976).map { UInt8($0 % 256) })
guard try source.read() == prefix + Data("source".utf8) else { exit(1) }
let copy = prefix + Data([255,0]) + Data("new content".utf8)
print("READY"); fflush(stdout)
while let path = readLine() {
    do { try source.saveCopy(copy, to: URL(fileURLWithPath: path)); print("COPIED") }
    catch { print(error.localizedDescription) }
    fflush(stdout)
}
'''


def exercise(cmd, folder, via_alias):
    folder.mkdir()
    original = folder / "Board.SchDoc"
    original.write_bytes(ORIGINAL)
    alias = folder / "Source Link.SchDoc"
    alias.symlink_to(original)
    hardlink = folder / "hard.SchDoc"
    os.link(original, hardlink)
    alias_dir = folder / "alias"
    alias_dir.symlink_to(folder, target_is_directory=True)
    selected = alias if via_alias else original
    with subprocess.Popen([*cmd, str(selected)], stdin=subprocess.PIPE, stdout=subprocess.PIPE, text=True) as proc:
        assert proc.stdout.readline().strip() == "READY"

        def write(dest):
            proc.stdin.write(str(dest) + "\n")
            proc.stdin.flush()
            return proc.stdout.readline().strip()

        for forbidden in (original, alias, hardlink, alias_dir / original.name):
            assert "original Altium source" in write(forbidden), forbidden
        allowed = folder / "Board edited.SchDoc"
        assert write(allowed) == "COPIED" and allowed.read_bytes() == PAYLOAD
        allowed.write_bytes(b"old unrelated destination")
        assert write(allowed) == "COPIED" and allowed.read_bytes() == PAYLOAD
        assert "extension" in write(folder / "wrong.PcbDoc")
        assert original.read_bytes() == ORIGINAL
        moved = folder / "renamed.SchDoc"
        original.rename(moved)
        for forbidden in (moved, original, alias_dir / original.name, hardlink, alias):
            assert "original Altium source" in write(forbidden), forbidden
        assert moved.read_bytes() == ORIGINAL
        assert not original.exists()
        replacement = folder / "replacement.SchDoc"
        replacement.write_bytes(b"new design")
        original.symlink_to(replacement)
        replacement_alias = folder / "replacement-link.SchDoc"
        os.link(replacement, replacement_alias)
        for forbidden in (replacement, replacement_alias, moved):
            assert "original Altium source" in write(forbidden), forbidden
        assert replacement.read_bytes() == b"new design"
        proc.stdin.close()


def main():
    if len(sys.argv) > 1:
        return python_worker(Path(sys.argv[1]))
    with tempfile.TemporaryDirectory() as temporary:
        tmp = Path(temporary)
        cmds = [[sys.executable, "-B", __file__]]
        if sys.platform == "darwin":
            src = tmp / "main.swift"
            src.write_text(SWIFT)
            command = tmp / "copy-check"
            subprocess.run(["xcrun","swiftc","-module-cache-path",str(tmp/"cache"),str(NATIVE/"macos/ProjectWrites.swift"),
                            str(src),"-o",str(command)],check=True)
            cmds.append([str(command)])
        for i, cmd in enumerate(cmds):
            for alias in (False, True):
                exercise(cmd, tmp / f"sample-{i}-{int(alias)}", alias)
    print("Passed binary copy, replacement, rename, hard link, symlink and source path protections for",len(cmds),"native writer(s).")


if __name__ == "__main__":
    main()
