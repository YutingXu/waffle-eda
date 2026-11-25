"""Collect comparable measurements from Waffle's existing benchmark entry points."""

import hashlib
import json
import math
import os
from pathlib import Path
import shutil
import signal
import statistics
import subprocess


class BenchmarkError(Exception):
    pass


SHEETS = 100
BROWSER_SAMPLES = 20
ROUTE_TRIALS = 30
DRC_BOARDS = ("demo", "dense-netted")
CHECK_SAMPLES = 7
COMMANDS = {
    "pour": (["zsh", "scripts/perf-pour.sh", "--json", "--measure-only"], {"RUNS": "3"}, 1100),
    "schematic": (["zsh", "scripts/perf-sch.sh", "--sheets", str(SHEETS), "--json", "--no-budget"],
                  {"RUNS": "1"}, 240),
    "routing": (["node", "scripts/perf-route-moves.cjs", str(ROUTE_TRIALS)], {"JSON": "1"}, 240),
    "diff": (["zsh", "scripts/perf-diff.sh", "--json", "--measure-only"],
             {"RUNS": str(BROWSER_SAMPLES)}, 240),
    "startup": (["zsh", "scripts/startup-budget.sh", "--json", "--measure-only",
                 "--runs", str(BROWSER_SAMPLES)], {}, 240),
    "drc": (["node", "scripts/perf-checks.cjs", "drc"], {}, 240),
    "erc": (["node", "scripts/perf-checks.cjs", "erc"], {}, 120),
}


def workload_id(root):
    # App code and the DRC implementations are the subjects of the benchmark. These inputs
    # describe the measurement method and fixtures, so a change starts an independent series.
    sources = {cmd[1] for cmd, _, _ in COMMANDS.values()} | {
        "tests/pcb/dense-board.js", "tests/pcb/perf-pour.js", "tests/integration/perf-sch.js",
        "tests/schematic/sch-bench-project.js", "tests/maintenance/startup-budget.py",
        "tests/support/app-source-paths.cjs",
    }
    digest = hashlib.sha256(json.dumps(COMMANDS, sort_keys=True).encode())
    for source in sorted(sources):
        digest.update(source.encode())
        digest.update(hashlib.sha256((root / source).read_bytes()).digest())
    return digest.hexdigest()


def browser_path():
    if os.environ.get("CHROME"):
        candidates = [os.environ["CHROME"]]
    else:
        candidates = ["/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
                      "/Applications/Chromium.app/Contents/MacOS/Chromium"]
        candidates += [shutil.which(name) for name in ("google-chrome", "chromium", "chromium-browser")]
    for candidate in candidates:
        if candidate and os.access(candidate, os.X_OK) and Path(candidate).is_file():
            return str(Path(candidate).resolve())
    raise BenchmarkError("Chrome or Chromium could not be found. Set CHROME to its executable.")


def numeric(value):
    return type(value) in (int, float) and math.isfinite(value) and value >= 0


def number(value):
    if not numeric(value):
        raise ValueError("expected a finite, nonnegative measurement")
    return value


def timing(row):
    if type(row["n"]) != int or row["n"] < 1:
        raise ValueError("expected a positive sample count")
    result = {"unit": "ms", "n": row["n"]}
    for name in ("p50", "p95", "p99", "min", "max"):
        if name in row or name == "p95":
            result[name] = number(row[name])
    if result.get("p50", 0) > result["p95"] or result["p95"] > result.get("max", math.inf):
        raise ValueError("timing percentiles are out of order")
    return result


def value(value, unit):
    return {"unit": unit, "value": number(value)}


def measurements(suite, data):
    """Keep numeric data and known fixture facts. Raw page errors, paths and user agents stay out."""
    metrics, workload = {}, {}
    if suite in ("pour", "schematic"):
        source = data["metrics"]
        required = (("editToScreen", "editToExact", "dragFrame") if suite == "pour"
                    else ("sheetSwitchCold", "sheetSwitchWarm", "panFit", "editFrame", "searchQuery"))
        checks = data["checks"]
        if suite == "pour":
            workload = {"launches": checks["runs"], "tileSessions": checks["sessions"],
                        "refreshHz": checks["refreshHz"]}
        else:
            workload = {key: checks["project"][key] for key in ("sheets", "items", "denseItems", "parts")}
            if workload["sheets"] != SHEETS:
                raise ValueError("unexpected schematic workload")
        for name in required:
            timing(source[name])
        for name, raw in source.items():
            if isinstance(raw, dict):
                metrics[name] = timing(raw)
            elif raw is not None:
                units = {"dragPatches": "count", "dragLongTasks": "count", "idleCpuPct": "%"}
                unit = units.get(name, "MiB" if name.endswith("MB") else
                                 "Hz" if name.endswith("PerSec") else "ms")
                metrics[name] = value(raw, unit)
    elif suite == "routing":
        expected = {mode + clicks: ROUTE_TRIALS * 75
                    for mode in ("walkaround", "push", "hug", "pair walkaround", "pair push")
                    for clicks in ("", " +clicks")}
        expected.update({"bus sweep " + mode: 903 for mode in ("push", "hug", "pair push")})
        for name, count in expected.items():
            metrics[name] = timing(data[name])
            if metrics[name]["n"] != count:
                raise ValueError("incomplete routing workload")
        workload = {"trials": ROUTE_TRIALS}
    elif suite == "diff":
        for name in ("firstPaint", "compare", "listPaint", "step"):
            metrics[name] = timing(data["timings"][name])
            if metrics[name]["n"] != BROWSER_SAMPLES * (10 if name == "step" else 1):
                raise ValueError("incomplete visual diff workload")
        workload = {key: number(data[key]) for key in ("items", "changes")}
    elif suite == "startup":
        boots = sorted(number(ms) for ms in data["chrome"]["bootMs"])
        if len(boots) != BROWSER_SAMPLES:
            raise ValueError("incomplete startup workload")
        metrics["boot"] = timing({"n": len(boots), "p50": statistics.median(boots),
                                  "p95": boots[math.ceil(.95 * len(boots)) - 1], "max": max(boots)})
        for key in ("eagerJsBytes", "eagerCssBytes", "inlineScriptBytes"):
            metrics[key] = value(data["static"][key], "bytes")
        metrics["bootHeap"] = value(data["chrome"]["heapMB"], "MiB")
        workload = {"eagerJsBudgetBytes": number(data["budgets"]["eagerJsBytes"])}
    elif suite == "drc":
        for board in DRC_BOARDS:
            result = data[board]
            workload[board] = {key: number(result[key]) for key in ("items", "violations")}
            if board == "dense-netted" and workload[board]["items"] != 25600:
                raise ValueError("incomplete dense DRC workload")
            for name in ("batch", "clearance", "onlineOpen", "onlineEdit"):
                metrics[f"{board}/{name}"] = timing(result["timings"][name])
        if any(row["n"] != CHECK_SAMPLES for row in metrics.values()):
            raise ValueError("incomplete DRC sampling")
    elif suite == "erc":
        workload = {key: number(data[key]) for key in ("sheets", "items", "messages")}
        if workload["sheets"] != SHEETS:
            raise ValueError("incomplete ERC workload")
        for name in ("full", "connectivity", "netlistWrite", "netlistParse"):
            metrics[name] = timing(data["timings"][name])
        if any(row["n"] != CHECK_SAMPLES for row in metrics.values()):
            raise ValueError("incomplete ERC sampling")
        metrics["netlistBytes"] = value(data["netlistBytes"], "bytes")
    else:
        raise ValueError("unknown performance suite")
    return {f"{suite}/{name}": row for name, row in metrics.items()}, workload


def collect(root, chrome, suite):
    command, settings, timeout = COMMANDS[suite]
    # Clear per-benchmark overrides and keep the history token out of the child processes.
    env = {name: os.environ[name] for name in ("PATH", "HOME", "TMPDIR", "LANG", "LC_ALL")
           if name in os.environ}
    env.update(settings, CHROME=chrome)
    with subprocess.Popen(command, cwd=root, env=env, text=True, stdout=subprocess.PIPE,
                          stderr=subprocess.PIPE, start_new_session=True) as child:
        try:
            output, _ = child.communicate(timeout=timeout)
        except BaseException as exc:
            try:
                os.killpg(child.pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
            child.communicate()
            if isinstance(exc, subprocess.TimeoutExpired):
                raise BenchmarkError(f"{suite} exceeded its measurement timeout.") from exc
            raise
    if child.returncode:
        raise BenchmarkError(f"{suite} exited with code {child.returncode}. Run its benchmark directly for details.")
    try:
        # The routing benchmark prints a readable summary before its final JSON line.
        if suite == "routing":
            output = output.splitlines()[-1]
        return measurements(suite, json.loads(output))
    except (KeyError, TypeError, ValueError, IndexError, OverflowError) as exc:
        raise BenchmarkError(f"{suite} returned incomplete or invalid benchmark JSON.") from exc
