#!/usr/bin/env python3
"""Optional cross-check of the Signal Integrity solver (extensions/si/solver.js) against ngspice.

A 10 ohm source drives a lossless 50 ohm, 1 ns line (ngspice T element) into 200 ohm || 2 pF, with a
100 ps edge. The receiver voltage at 0.5 ns steps from 1 to 9 ns must agree within 1 % of the swing.
Skips (exit 0) when ngspice is not on PATH or JavaScriptCore is unavailable.
    python3 tests/analysis/si-ngspice.py
"""
import json
import re
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
TIMES = [0.5e-9 * k for k in range(2, 19)]


def ours():
    sys.path.insert(0, str(ROOT / "mcp"))
    from board_runner import JavaScriptCore, load_jsc
    lib = load_jsc()
    if not lib:
        return None
    js = JavaScriptCore(lib, ())
    try:
        js.evaluate((ROOT / "extensions" / "si" / "solver.js").read_text())
        script = """(() => { const S = AtriumSISolver, c = new S.Circuit(), a = c.node("a"), b = c.node("b");
          c.V(a, 10, t => Math.min(1, Math.max(0, (t - 0.1e-9) / 100e-12))); c.T(a, b, 50, 1e-9); c.R(b, -1, 200); c.C(b, -1, 2e-12);
          const r = S.simulate(c, {dt: 1e-12, tstop: 10e-9, probes: [b]});
          return JSON.stringify(%s.map(t => S.at(r.t, r.v[0], t))); })()""" % json.dumps(TIMES)
        return json.loads(js.value_text(js.evaluate(script)))
    finally:
        js.close()


def spice(ngspice):
    deck = """* Waffle SI cross-check
V1 src 0 PWL(0 0 0.1n 0 0.2n 1)
R1 src a 10
T1 a 0 b 0 Z0=50 TD=1n
R2 b 0 200
C2 b 0 2p
.tran 1p 10n
.control
run
wrdata {out} v(b)
.endc
.end
"""
    with tempfile.TemporaryDirectory() as tmp:
        out = Path(tmp) / "out.txt"
        deck_path = Path(tmp) / "deck.cir"
        deck_path.write_text(deck.replace("{out}", str(out)))
        subprocess.run([ngspice, "-b", str(deck_path)], check=True, capture_output=True, timeout=120)
        rows = [tuple(map(float, re.split(r"\s+", line.strip())[:2])) for line in out.read_text().splitlines() if line.strip()]
    def at(t):
        for (t0, v0), (t1, v1) in zip(rows, rows[1:]):
            if t0 <= t <= t1:
                return v0 + (v1 - v0) * (t - t0) / ((t1 - t0) or 1)
        return rows[-1][1]
    return [at(t) for t in TIMES]


def main():
    ngspice = shutil.which("ngspice")
    if not ngspice:
        print("si-ngspice: skipped (ngspice is not on PATH)")
        return 0
    mine = ours()
    if mine is None:
        print("si-ngspice: skipped (JavaScriptCore is unavailable)")
        return 0
    ref = spice(ngspice)
    worst = max(abs(a - b) for a, b in zip(mine, ref))
    print("si-ngspice: worst difference %.4f V over %d samples" % (worst, len(TIMES)))
    if worst > 0.01 * (200 / 210 * 1.5):
        print("si-ngspice: FAIL")
        return 1
    print("si-ngspice: ok")
    return 0


if __name__ == "__main__":
    sys.exit(main())
