"""Measure cold and paginated MCP Git review in separate, fresh backend processes."""
import argparse
import json
from pathlib import Path
import resource
import shutil
import statistics
import subprocess
import sys
import tempfile
import time
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "mcp"))
sys.dont_write_bytecode = True
from board_runner import BoardRunner, load_jsc
from server import Server
import sys as _test_sys
from pathlib import Path as _TestPath
_test_sys.path.insert(0, str((_TestPath(__file__).resolve().parent / "../support").resolve()))
from native_sample import authored_files, ensure_native_host, write_design


def prepare(path, count):
    def git(*args):
        subprocess.run(["git", "-C", str(path.parent), "-c", "user.name=Test",
                        "-c", "user.email=test@example.invalid", "-c", "commit.gpgSign=false", *args], check=True)

    items = [{"kind":"track", "id":f"t{i}", "net":f"N{i%25}", "layer":"Top", "width":0.2,
              "points":[[i,0],[i+1,0]]} for i in range(count)]
    board = {"id":"pcb", "name":"Board", "kind":"pcb", "grid":0.25, "outline":[], "notes":[], "items":items}
    project = {"format":"atrium", "version":1, "name":"Saved", "library":[], "documents":[board]}
    git("init", "-q")
    write_design(path, project)
    git("add", "--", ".")
    git("commit", "-qm", "Recorded board")
    for item in items[::5]:
        item["width"] = 0.31
    write_design(path, project)


def measure(path, backend, count):
    ensure_native_host()
    server = Server(path)
    runner = server.board_runner = BoardRunner(backend)
    changed = (count + 4) // 5
    def page(**options):
        begin = time.perf_counter()
        result = server.call("compare_git_head", {"limit":50, **options})
        assert result["total"] == changed
        return result, (time.perf_counter()-begin)*1000

    # Keep counts, never the snapshots themselves, in the instrumentation.
    loads = 0
    original = runner.load_comparison
    def load(committed, saved):
        nonlocal loads
        loads += 1
        return original(committed, saved)

    try:
        with patch.object(runner, "load_comparison", load):
            first, cold = page()
            pid = runner.worker.pid if runner.worker else None
            latencies = []
            for offset in range(0, min(changed, 1000), 50):
                result, elapsed = page(offset=offset)
                assert result["commit"] == first["commit"] and result["file_revision"] == first["file_revision"]
                assert result["items"][0]["locate_id"] == f"t{offset*5}"
                latencies.append(elapsed)
            _, scan = page(query="0.31 mm")
            _, filtered = page(query="0.31 mm", offset=50)
            assert loads == 1 and server.project is None
            assert set(server.git_baseline) == {"key", "base_file_revision", "read_only_documents"}
            assert server.git_baseline["key"][::2] == (first["commit"], first["file_revision"])
            assert server.git_baseline["base_file_revision"] == first["base_file_revision"]
            assert not pid or runner.worker.pid == pid
    finally:
        server.close()
    scale = 1048576 if sys.platform == "darwin" else 1024
    def peak(who):
        return round(resource.getrusage(who).ru_maxrss/scale, 1)

    print(json.dumps({"backend":backend, "tracks":count, "changes":changed, "bytes_per_revision":sum(map(len, authored_files(path.parent).values())),
                      "pages":len(latencies), "cold_ms":round(cold,1), "warm_median_ms":round(statistics.median(latencies),1),
                      "first_search_ms":round(scan,1), "repeated_search_ms":round(filtered,1),
                      "server_peak_mib":peak(resource.RUSAGE_SELF), "largest_child_peak_mib":peak(resource.RUSAGE_CHILDREN)}))


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--tracks", type=int, default=40000)
    parser.add_argument("--backend", choices=["jsc","node"])
    parser.add_argument("--fixture", type=Path, help=argparse.SUPPRESS)
    opts = parser.parse_args()
    if opts.tracks < 1:
        parser.error("Use at least one track.")
    if opts.fixture:
        measure(opts.fixture, opts.backend, opts.tracks)
    else:
        engines = [opts.backend] if opts.backend else [name for name, available in
                    (("jsc",load_jsc()),("node",shutil.which("node"))) if available]
        if not engines:
            parser.error("This benchmark needs JavaScriptCore or Node.js.")
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "Board.waffle"
            prepare(path, opts.tracks)
            for name in engines:
                subprocess.run([sys.executable, "-B", __file__, "--backend", name, "--fixture", str(path),
                                "--tracks", str(opts.tracks)], check=True)
