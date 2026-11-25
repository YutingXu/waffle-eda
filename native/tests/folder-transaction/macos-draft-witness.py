#!/usr/bin/env python3
"""Exercise first-use private draft key publication on a file-witness-only macOS volume."""
import argparse
import concurrent.futures
from pathlib import Path
import subprocess
import tempfile

ROOT = Path(__file__).resolve().parents[3]
FULL = "full: (Int32) -> Int32 = { fcntl($0,F_FULLFSYNC) }"
WITNESS_ONLY = """full: (Int32) -> Int32 = { fd in
    var s = stat()
    if fstat(fd, &s) == 0 && s.st_mode & S_IFMT == S_IFDIR { errno = ENOTSUP; return -1 }
    return fcntl(fd,F_FULLFSYNC)
}"""
MAIN = r'''
import Foundation
let root = URL(fileURLWithPath:CommandLine.arguments[1],isDirectory:true)
let profile = URL(fileURLWithPath:CommandLine.arguments[2],isDirectory:true)
let store = try FolderTransactions(root:root,manifest:"Draft.waffle")
let bytes = Data(base64Encoded:"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j8XkAAAAASUVORK5CYII=")!
let stage = try store.stageAsset(bytes:bytes,owner:"sheet",mediaType:"image/png")
var request: [String:Any] = ["ownerId":"sheet","assetToken":stage["assetToken"]!,"assetRef":stage["assetRef"]!]
let proof = try store.draftAsset(request,profile:profile,restore:false)["proof"] as! String
request["proof"] = proof; request["data"] = bytes.base64EncodedString()
let restored = try store.draftAsset(request,profile:profile,restore:true)
guard restored["assetToken"] is String else { exit(2) }
print(proof)
'''


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source", type=Path, default=ROOT / "native/macos/FolderTransactions.swift")
    source = parser.parse_args().source.read_text()
    if source.count(FULL) != 1:
        raise RuntimeError("Check the native full-device call before running the witness-only volume test.")
    with tempfile.TemporaryDirectory(prefix="waffle-private-witness-") as directory:
        temp = Path(directory)
        root, profile, exe = temp / "design", temp / "profile", temp / "check"
        root.mkdir()
        (temp / "main.swift").write_text(MAIN)
        (temp / "FolderTransactions.swift").write_text(source.replace(FULL, WITNESS_ONLY))
        subprocess.run(["xcrun","swiftc","-O",temp/"FolderTransactions.swift",temp/"main.swift","-o",exe],check=True)
        with concurrent.futures.ThreadPoolExecutor(max_workers=8) as workers:
            runs = list(workers.map(lambda _: subprocess.run([exe,root,profile],capture_output=True,text=True),range(8)))
        if any(run.returncode for run in runs):
            raise RuntimeError("The draft key could not be published or restored with a regular-file witness.")
        assert len({run.stdout for run in runs}) == 1 and len(runs[0].stdout.strip()) == 64
        key = profile / "folder-recovery/provenance-v1"
        assert key.stat().st_nlink == 1 and key.stat().st_size == 32
        assert [p.name for p in key.parent.iterdir()] == [key.name] and not list(root.iterdir())
    print("PASS eight native processes published the same single-link draft key and restored its original with a file witness")


if __name__ == "__main__":
    main()
