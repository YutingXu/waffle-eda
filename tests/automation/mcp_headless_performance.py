"""Measure the headless MCP engine on the 25,600-object dense board from tests/pcb/dense-board.js.

Each scenario runs a fresh server process over stdio and reports:
  cold_start_ms        process start to the initialize reply
  first_drc_ms         first run_drc: engine, lazily loaded modules, project parse and the check
  warm_drc_ms          median run_drc with other options: every rule rechecked, project and connectivity reused
  cached_page_ms       median run_drc page served from the cached result
  fabrication_ms       generate_fabrication streamed into one ZIP
  peak_rss_mib         the server's peak resident set size
"""
import argparse
import json
from pathlib import Path
import resource
import select
import statistics
import subprocess
import sys
import tempfile
import time

ROOT = Path(__file__).resolve().parents[2]
SERVER = ROOT / "mcp" / "server.py"
sys.path.insert(0, str(ROOT / "mcp"))
sys.dont_write_bytecode = True
import sys as _test_sys
from pathlib import Path as _TestPath
_test_sys.path.insert(0, str((_TestPath(__file__).resolve().parent / "../support").resolve()))
from native_sample import authored_files, ensure_native_host, write_design

BUILD = """
const {d} = makeAtriumBenchmarkBoard(%d);
if (%s) {
  // Give every copper object a net so clearance and connectivity rules have work to do.
  let n = 0;
  for (const i of d.items) if (i.kind !== "part") i.net = "N" + (n++ %% 400);
    else i.pinNets = {"1": "N" + (n %% 400), "2": "N" + ((n + 1) %% 400)};
}
JSON.stringify(Atrium.validate({format: "atrium", version: 1, name: "Dense", library: AtriumParts.catalogue, documents: [d]}));
"""


def build(path, size, nets):
    from board_runner import JavaScriptCore, load_jsc
    js = JavaScriptCore(load_jsc(), ("parts",))
    try:
        js.evaluate((ROOT / "tests/pcb/dense-board.js").read_text(), str(ROOT / "tests/pcb/dense-board.js"))
        model = json.loads(js.value_text(js.evaluate(BUILD % (size, "true" if nets else "false"))))
        write_design(path, model)
    finally:
        js.close()


def measure(path, runs):
    ensure_native_host()
    project_bytes = sum(map(len, authored_files(path.parent).values()))
    started = time.perf_counter()
    proc = subprocess.Popen([sys.executable, "-B", str(SERVER), "--project", str(path)], stdin=subprocess.PIPE,
                            stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, bufsize=1)
    seq = 0

    def call(method, params):
        nonlocal seq
        seq += 1
        proc.stdin.write(json.dumps({"jsonrpc": "2.0", "id": seq, "method": method, "params": params}) + "\n")
        proc.stdin.flush()
        if not select.select([proc.stdout], [], [], 300)[0]:
            raise TimeoutError(method)
        reply = json.loads(proc.stdout.readline())
        if "error" in reply or reply["result"].get("isError"):
            raise RuntimeError(reply)
        return reply["result"]

    def tool(name, args):
        begin = time.perf_counter()
        result = json.loads(call("tools/call", {"name": name, "arguments": args})["content"][0]["text"])
        return result, (time.perf_counter() - begin) * 1000

    call("initialize", {"protocolVersion": "2025-06-18"})
    cold = (time.perf_counter() - started) * 1000
    first, first_ms = tool("run_drc", {"limit": 50})
    warm = [tool("run_drc", {"limit": 50, "max_per_rule": 2000 - i})[1] for i in range(runs)]
    cached = [tool("run_drc", {"limit": 50, "offset": 50, "max_per_rule": 2000 - runs + 1})[1] for _ in range(runs)]
    fab, fab_ms = tool("generate_fabrication", {"zip": True, "date": "2026-01-01T00:00:00Z"})
    proc.stdin.close()
    proc.wait(timeout=60)
    proc.stdout.close()
    proc.stderr.close()
    scale = 1048576 if sys.platform == "darwin" else 1024
    return {"objects": first["stats"]["objects"], "project_bytes": project_bytes, "violations": first["total"],
            "cold_start_ms": round(cold), "first_drc_ms": round(first_ms), "warm_drc_ms": round(statistics.median(warm)),
            "drc_engine_ms": first["stats"]["ms"], "cached_page_ms": round(statistics.median(cached), 1),
            "fabrication_ms": round(fab_ms), "fabrication_zip_bytes": fab["zip"]["bytes"],
            "peak_rss_mib": round(resource.getrusage(resource.RUSAGE_CHILDREN).ru_maxrss / scale, 1)}


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--size", type=int, default=160, help="Grid size; 160 gives 25,600 objects.")
    parser.add_argument("--runs", type=int, default=5)
    parser.add_argument("--fixture", type=Path, help=argparse.SUPPRESS)
    opts = parser.parse_args()
    if opts.fixture:
        print(json.dumps(measure(opts.fixture, opts.runs)))
        sys.exit(0)
    from board_runner import load_jsc
    if not load_jsc():
        parser.error("This benchmark builds its board with JavaScriptCore.")
    with tempfile.TemporaryDirectory() as directory:
        for nets in (False, True):
            path = Path(directory) / ("with-nets" if nets else "as-generated") / "Dense.waffle"
            build(path, opts.size, nets)
            # A separate process per scenario keeps each peak RSS reading independent.
            out = subprocess.run([sys.executable, "-B", __file__, "--fixture", str(path), "--runs", str(opts.runs)],
                                 check=True, capture_output=True, text=True).stdout
            print(json.dumps(dict(json.loads(out), board="dense " + ("with nets" if nets else "as generated"))))
