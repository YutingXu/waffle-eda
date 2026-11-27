#!/usr/bin/env python3
"""Measure native PCB GPU navigation on an untouched copy of a saved folder project."""
from argparse import ArgumentParser
from bisect import bisect_right
from hashlib import sha256
import json
import math
import os
from pathlib import Path
import shutil
import subprocess
import sys
from tempfile import TemporaryDirectory

HERE = Path(__file__).resolve().parent
PREFIX = "NOTE  probe summary: LABEL_FEEL "
GPU_WORK = ("frames", "gridBufferAllocations", "driverFenceSubmissions", "driverMemoryChecks")


def digest(path):
    with path.open("rb") as handle:
        return sha256(handle.read()).hexdigest()


def fingerprint(folder):
    return {p.relative_to(folder): digest(p) for p in folder.rglob("*")
            if ".git" not in p.relative_to(folder).parts and p.is_file()}


def stats(values):
    samples = sorted(values)
    return {"n": len(samples), **{
        name: round(samples[math.ceil(p * len(samples)) - 1], 3) if samples else None
        for name, p in (("p50", .5), ("p95", .95), ("max", 1))
    }}


def difference(before, after):
    return {key: value - before[key] for key, value in after.items()
            if type(value) in (int, float) and type(before.get(key)) in (int, float)}


def gpu_work(step):
    counters = difference(step["before"], step["after"])
    if any(type(counters.get(key)) is not int or counters[key] < 0 for key in GPU_WORK):
        return None
    work = {key: counters[key] for key in GPU_WORK}
    if "retainedFrames" in step["before"] or "retainedFrames" in step["after"]:
        retained = counters.get("retainedFrames")
        if type(retained) is not int or not 0 <= retained <= work["frames"]:
            return None
        work["retainedFrames"] = retained
    for key in ("textSliceRows", "wideSliceRows", "textSliceWorkMs", "wideSliceWorkMs"):
        if key in step["before"] or key in step["after"]:
            value = counters.get(key)
            if value is None or not math.isfinite(value) or value < 0:
                return None
            work[key] = value
    return work


def input_rows(phase):
    return [row for row in phase["inputs"] if row["type"] == "wheel" and (row.get("dx") or row.get("dy"))]


def classify(phase, interval):
    ticks, work, draws = phase["ticks"], phase["work"], phase["draws"]
    counters = gpu_work(phase)
    if counters is None:
        return {"invalid": "GPU work counters became invalid"}
    if len(ticks) < 2:
        return {"invalid": "WebKit frame clock did not run"}
    # The final rAF can contain an app draw before the phase returns. Keep its
    # measured work separate from the preceding complete callback interval.
    partial = phase["end"] > ticks[-1]
    bounds = [*ticks, phase["end"]] if partial else ticks
    bins = [0.] * (len(bounds) - 1)

    def bucket(t):
        return min(len(bins) - 1, max(0, bisect_right(bounds, t) - 1))

    for t, duration in zip(work[::2], work[1::2]):
        if ticks[0] <= t < phase["end"]:
            bins[bucket(t)] += duration
    # A direct render from an untimed promise continuation still ran on the main thread.
    for draw in draws:
        if not draw["inCallback"]:
            bins[bucket(draw["t"])] += draw["end"] - draw["t"]
    events = input_rows(phase)
    last_motion = max((i for i, draw in enumerate(draws) if draw["changed"]), default=-1)
    stationary = []
    if events and last_motion >= 0:
        first, last = events[0]["at"], events[-1]["at"]
        # Some renderers present a transitional stationary frame while exact text is prepared.
        stationary = [i for i, draw in enumerate(draws) if i >= last_motion and draw["t"] >= last and not draw["moving"]]
        settled = stationary[0] if stationary else last_motion
        end = max(last, draws[settled]["t"])
        motion_end = max(last, draws[last_motion]["end"])
        activity = {bucket(draw["raf"] if draw.get("raf") is not None else draw["t"])
                    for draw in draws if first <= draw["t"] <= end and draw["moving"]}
        # Use all active callback intervals for cadence, including the long intervals with no draw.
        cadences = [b - a for a, b in zip(ticks, ticks[1:]) if b >= first and a <= end]
        motion_cadences = [b - a for a, b in zip(ticks, ticks[1:]) if b >= first and a <= motion_end]
    else:
        settled, cadences, motion_cadences = None, [], []
        activity = {bucket(draw["raf"] if draw.get("raf") is not None else draw["t"]) for draw in draws}
    settled_bins, terminal_bins = [], []
    settle_mode = None
    if settled is not None:
        draw = draws[settled]
        final_bucket = bucket(draw["raf"] if draw.get("raf") is not None else draw["t"])
        settled_bins = [final_bucket]
        terminal_draw = draws[stationary[-1] if stationary else settled]
        terminal_bins = [bucket(terminal_draw["raf"] if terminal_draw.get("raf") is not None else terminal_draw["t"])]
        activity.discard(final_bucket)
        settle_mode = ("stationary-after-motion" if settled > last_motion else
                       "final-camera-stationary" if not draw["moving"] else "last-moving-draw-only")
    dom_latency, native_latency = [], []
    for event in events:
        draw = next((draw for draw in draws if draw["changed"] and draw["t"] >= event["at"]), None)
        if draw:
            dom_latency.append(draw["end"] - event["at"])
            native_latency.append(draw["end"] - event["stamp"])
    return {
        "jsWorkMovingOrHeld": [bins[i] for i in sorted(activity)],
        "jsWorkSettle": [bins[i] for i in settled_bins],
        "jsWorkTerminalSettle": [bins[i] for i in terminal_bins],
        "workIntervalsAfterLastInput": [duration for i, duration in enumerate(bins)
                                        if events and bounds[i + 1] > events[-1]["at"] and duration > 0],
        "terminalPartialInterval": bool(partial and terminal_bins and terminal_bins[0] == len(bins) - 1),
        "settleMode": settle_mode,
        "drawWork": [draw["end"] - draw["t"] for draw in draws],
        "callbacks": cadences,
        "motionCallbacks": motion_cadences,
        "settleCallbackSpans": [ticks[i + 1] - ticks[i] for i in settled_bins if i + 1 < len(ticks)],
        "missedDisplaySlots": sum(max(0, int(value / interval + .5) - 1) for value in cadences) if interval else None,
        "aboveRefreshInterval": sum(value > interval for value in cadences) if interval else None,
        "sourceIntervals": [second["ms"] - first["ms"] for first, second in
                            zip(phase["operation"]["sent"], phase["operation"]["sent"][1:])] if events else [],
        "nativeStampToDOM": [event["at"] - event["stamp"] for event in events],
        "domToCompletedDraw": dom_latency,
        "nativeStampToCompletedDraw": native_latency,
        "renderUploadBytes": sum(draw["uploadBytes"] for draw in draws),
        "fullSurfaces": difference(phase["fullSurfaces"]["before"], phase["fullSurfaces"]["after"]),
        "counters": counters,
    }


def summarize(run, budget):
    group = {}
    failed = []
    interval = None if run["drawWork"] else 1000 / run["native"]["displayHz"]
    if not run["nativeEndOK"] or not run["documentUnchanged"]:
        failed.append("Focus, display or authored document changed")
    if run["power"]["requestedLowPowerSimulation"] and not run["power"]["measured"]["lowPower"]:
        failed.append("WKWebView did not retain the requested Low Power Mode hint")
    for trial in run["operations"].values():
        for phase in trial["phases"]:
            checks = phase["verification"]
            flags = [key for key, value in checks.items() if value is False]
            if flags or not phase["gpu"]:
                failed.append(f"{phase['name']}: {' '.join(flags) or 'GPU renderer unavailable'}")
                continue
            measured = classify(phase, interval)
            if "invalid" in measured:
                failed.append(f"{phase['name']}: {measured['invalid']}")
                continue
            phase["measured"] = measured
            group.setdefault(phase["name"], []).append(measured)
    budgets = []
    summary = {}
    for name, rows in group.items():
        metrics = {key: stats(value for row in rows for value in row[key]) for key in (
            "jsWorkMovingOrHeld", "jsWorkSettle", "jsWorkTerminalSettle", "workIntervalsAfterLastInput",
            "drawWork", "callbacks", "motionCallbacks", "settleCallbackSpans", "sourceIntervals",
            "nativeStampToDOM", "nativeStampToCompletedDraw", "domToCompletedDraw")}
        summary[name] = {"trials": len(rows), **metrics, **{
            key: sum(row[key] for row in rows) if interval else None
            for key in ("missedDisplaySlots", "aboveRefreshInterval")}}
        for key in ("jsWorkMovingOrHeld", "jsWorkSettle", "jsWorkTerminalSettle"):
            if name == "held" and key != "jsWorkMovingOrHeld":
                continue
            measured_ms = metrics[key]["p95"]
            if measured_ms is None:
                failed.append(f"{name}: no frame work samples for {key}")
            elif measured_ms > budget:
                budgets.append(f"{name} {key} p95 {measured_ms:g} ms exceeds {budget:g} ms")
        if any(row["settleMode"] == "last-moving-draw-only" for row in rows):
            failed.append(f"{name}: final camera has no witnessed stationary frame")
    return {"byPhase": summary, "correctnessFailures": failed, "budgetFailures": budgets}


def report_work(name, counters, process):
    work = "  ".join(f"{key}={value}" for key, value in counters.items()) if counters else "GPU work unavailable"
    cpu = " ".join(f"{key}={process[key]['cpuMs']:.2f}" for key in ("app", "web", "gpu", "net", "total")
                   if process and key in process)
    print(f"{name}  {work}  CPU ms {cpu or 'unavailable'}")


def main():
    parser = ArgumentParser(description=__doc__)
    parser.add_argument("--bundle", required=True, type=Path, help="Signed WaffleHarness.app")
    parser.add_argument("--project", required=True, type=Path, help="Saved Format 2.0 .waffle manifest")
    parser.add_argument("--display", required=True, type=int, help="CoreGraphics display ID")
    parser.add_argument("--hz", type=int, help="Expected active display refresh rate")
    parser.add_argument("--draw-work", action="store_true",
                        help="Measure native input and render work without certifying physical display cadence")
    parser.add_argument("--repetitions", type=int, default=4, choices=range(1, 11), metavar="1..10")
    parser.add_argument("--settle-ms", type=int, default=380, help="Observation after AppKit input completes, from 380 to 1200 ms")
    parser.add_argument("--layer-mode", choices=("saved", "all", "dim", "single"), default="saved")
    parser.add_argument("--cross-view", action="store_true", help="Also pan to disjoint label origins and zoom out beyond Fit")
    parser.add_argument("--work-budget", type=float, default=8.0, help="p95 main-thread budget in ms (default 8)")
    parser.add_argument("--low-power", action="store_true", help="Simulate the app's Low Power Mode hint (Efficiency mode) in this ephemeral window")
    parser.add_argument("--characterize", action="store_true", help="Capture budgets without failing exit status for a budget miss")
    parser.add_argument("--json", action="store_true", help="Emit every callback, render, event and correctness witness as JSON")
    args = parser.parse_args()
    if sys.platform != "darwin":
        parser.error("the native GPU labels track requires macOS")
    if (args.hz is not None and args.hz <= 0) or not math.isfinite(args.work_budget) or args.work_budget <= 0:
        parser.error("expected refresh rate and work budget must be positive")
    if args.hz is None and not args.draw_work:
        parser.error("provide --hz for physical display cadence, or use --draw-work")
    if not 380 <= args.settle_ms <= 1200:
        parser.error("settle observation must be from 380 to 1200 ms")
    bundle, manifest = args.bundle.resolve(), args.project.resolve()
    executable = bundle / "Contents/MacOS/Waffle"
    if not executable.is_file() or not manifest.is_file() or manifest.suffix != ".waffle":
        parser.error("provide the signed harness and a saved .waffle manifest")
    folder = manifest.parent
    if any(p.is_symlink() for p in folder.rglob("*") if ".git" not in p.relative_to(folder).parts):
        parser.error("the project folder must be self-contained without symlinks")
    if subprocess.run(["/usr/bin/codesign", "--verify", "--strict", "--deep", str(bundle)], capture_output=True).returncode:
        parser.error("harness signature verification failed")
    original = fingerprint(folder)
    with TemporaryDirectory(prefix="waffle-native-label-feel-") as directory:
        work = Path(directory).resolve()
        copied = work / "project"
        shutil.copytree(folder, copied, ignore=shutil.ignore_patterns(".git"))
        if fingerprint(copied) != original:
            raise RuntimeError("Scratch project copy changed bytes")
        probes = ("native-feel.js", "label-feel.js")
        env = {key: value for key, value in os.environ.items()
               if not key.startswith("HARNESS_") and key not in {"UI_ONLY", "WHEEL_TEST_DISPLAY", "NATIVE_FEEL_DISPLAY_ID"}}
        env.update(HARNESS_SUITE="ui", HARNESS_EPHEMERAL="1", HARNESS_INPUT_STDIN="1",
                   HARNESS_EARLY_PROBE=str(HERE / "pan-early.js"), HARNESS_WORK=str(work / "run"),
                   HARNESS_PROBES=":".join(str(HERE / name) for name in probes),
                   HARNESS_OPEN_PROJECT=str(copied / manifest.name), NATIVE_FEEL_DISPLAY_ID=str(args.display))
        config = json.dumps({"display": args.display, "hz": args.hz, "repetitions": args.repetitions, "lowPower": args.low_power,
                             "layerMode": args.layer_mode, "crossView": args.cross_view, "settleMs": args.settle_ms,
                             "drawWork": args.draw_work})
        try:
            run = subprocess.run(["/usr/bin/caffeinate", "-d", str(executable)], env=env,
                                 capture_output=True, input=config, text=True, timeout=25 + 10 * args.repetitions)
        except subprocess.TimeoutExpired:
            print("Native labels probe timed out", file=sys.stderr)
            return 2
        line = next((row.removeprefix(PREFIX) for row in run.stdout.splitlines() if row.startswith(PREFIX)), None)
        if run.returncode or "RESULT ok" not in run.stdout or line is None:
            print(run.stdout, run.stderr, file=sys.stderr)
            return 2
        report = json.loads(line)
        report["executableSHA256"] = digest(executable)
        report["savedFilesUnchanged"] = fingerprint(folder) == original and all(
            (copied / p).is_file() and digest(copied / p) == checksum for p, checksum in original.items())
        result = summarize(report, args.work_budget)
        if not report["savedFilesUnchanged"]:
            result["correctnessFailures"].append("Saved project bytes changed")
        report["budgetMs"] = args.work_budget
        report["result"] = result
        idle = report["idle"]
        idle["counters"] = gpu_work(idle)
        if idle["counters"] is None:
            result["correctnessFailures"].append("Idle GPU work counters became invalid")
        if args.json:
            print(json.dumps(report, indent=2))
        else:
            print(f"GPU: {report['engine']}, {report['beforeItems']} objects, {report['native']['displayHz']:g} Hz, "
                  f"{report['viewport']['backing'][0]}×{report['viewport']['backing'][1]} backing pixels")
            if args.draw_work:
                print("Native draw work only. Physical display cadence is unqualified.")
            for name, metrics in result["byPhase"].items():
                moving, settled, terminal = (metrics[key] for key in ("jsWorkMovingOrHeld", "jsWorkSettle", "jsWorkTerminalSettle"))
                print(f"{name}  work p50/p95/max {moving['p50']}/{moving['p95']}/{moving['max']} ms ({moving['n']} frames)  "
                      f"first stationary {settled['p50']}/{settled['p95']}/{settled['max']} ms ({settled['n']} frames)  "
                      f"last stationary {terminal['p50']}/{terminal['p95']}/{terminal['max']} ms ({terminal['n']} frames)")
            for trial in report["operations"].values():
                for phase in trial["phases"]:
                    if "measured" in phase:
                        report_work(phase["name"], phase["measured"]["counters"], phase["process"])
            report_work("idle", idle["counters"], idle["process"])
            for fault in result["correctnessFailures"] + result["budgetFailures"]:
                print(f"FAIL  {fault}")
        if result["correctnessFailures"]:
            return 2
        return int(bool(result["budgetFailures"]) and not args.characterize)


if __name__ == "__main__":
    sys.exit(main())
