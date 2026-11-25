"""Convert the native soak's mixed log into normalized evidence and checkpoint summaries."""
import argparse
from collections import Counter, defaultdict
import json
import math
from pathlib import Path
from statistics import median

MIB = 1024 * 1024


def metrics(values):
    values = list(values)
    if not values:
        return {}
    return {"count": len(values), "min": min(values), "median": median(values), "max": max(values)}


def pairwise_slope(rows):
    # Use one median point per minute to avoid giving a pause or dense burst extra weight.
    by_minute = defaultdict(list)
    for timestamp, value in rows:
        by_minute[math.floor(timestamp / 60)].append(value)
    minutes = sorted((minute, median(values)) for minute, values in by_minute.items())
    slopes = [(b - a) / (second - first) for i, (first, a) in enumerate(minutes)
              for second, b in minutes[i + 1:]]
    return median(slopes) if slopes else None


def parse(file):
    events = defaultdict(list)
    failures = []
    with file.open() as handle:
        for line in handle:
            if line.startswith("MEMORY "):
                try:
                    row = json.loads(line[7:])
                except json.JSONDecodeError:
                    # A reader inspecting an in-progress log may encounter the last partial row.
                    if not line.endswith("\n"):
                        break
                    raise
                events[row["event"]].append(row)
            if line.startswith(("FAIL", "RESULT")):
                failures.append(line.strip())
    return events, failures


def packet_time(packet):
    body = packet["data"]
    return body.get("timestamp", (body.get("event") or {}).get("timestamp",
        (body.get("collection") or {}).get("endTime")))


def summarize(file):
    events, results = parse(file)
    if not (events["metadata"] and events["start"] and events["round"]):
        raise ValueError("The native log is missing setup or the first edit round.")
    metadata = events["metadata"][0]
    start = events["start"][0]
    begin = start["elapsedSec"]
    completion = events["edits-complete"][-1] if events["edits-complete"] else {}
    finish = events["complete"][-1] if events["complete"] else {}
    rounds = events["round"]
    page_end = events["active-complete-state"][-1] if events["active-complete-state"] else rounds[-1]
    active_end = completion.get("activeSeconds", page_end["elapsedSec"] - begin)
    markers = [0, 900, 1800, 2700, 3600]
    complete = bool(completion and finish) and "RESULT ok" in results and not any(
        line.startswith("FAIL") for line in results
    )

    # The Inspector execution stopwatch lives in WebContent. Bound offset using the last
    # sample drained in each host poll. The smallest receipt delay is usually <0.1s.
    offsets = []
    packets = []
    for batch in events["inspector"]:
        packets.extend(p for p in batch["samples"] if packet_time(p) is not None)
        stamps = [packet_time(p) for p in batch["samples"] if packet_time(p) is not None]
        if stamps:
            offsets.append(batch["elapsedSec"] - max(stamps))
    tracking_clock_offset = min(offsets) if offsets else None

    os_mem = defaultdict(list)
    pids = defaultdict(set)
    proc_peaks = defaultdict(int)
    for row in events["processes"]:
        elapsed = row["elapsedSec"] - begin
        for label, process in row["processes"].items():
            pids[label].add(process["pid"])
            if "error" not in process:
                os_mem[label + "RSSMiB"].append((elapsed, process["rssBytes"] / MIB))
                os_mem[label + "FootprintMiB"].append((elapsed, process["physicalFootprintBytes"] / MIB))
                if elapsed <= active_end:
                    proc_peaks[label] = max(proc_peaks[label], process["lifetimePeakPhysicalFootprintBytes"])

    inspector_mem = defaultdict(list)
    collections = defaultdict(list)
    pressure = []
    for packet in packets:
        elapsed = packet_time(packet) + tracking_clock_offset - begin
        data = packet["data"]
        method = packet["method"]
        if method == "Memory.trackingUpdate":
            for category in data["event"]["categories"]:
                inspector_mem[category["type"] + "MiB"].append((elapsed, category["size"] / MIB))
        elif method == "Heap.garbageCollected":
            obj = data["collection"]
            collections[obj["type"]].append((elapsed, (obj["endTime"] - obj["startTime"]) * 1000))
        elif method == "Memory.memoryPressure":
            pressure.append({"elapsed": elapsed, "severity": data["severity"]})

    page_series = defaultdict(list)
    for row in events["fixture"] + rounds + events["idle"]:
        elapsed = max(0., row["elapsedSec"] - begin)
        values = {
            "undoMiB": row["undo"]["bytes"] / MIB,
            "undoRecords": row["undo"]["records"],
            "undoShadowMiB": row["undo"]["shadow"] / MIB,
            "undoBranches": row["undo"]["branches"],
            "gpuAllocMiB": None if row["gpu"]["bytes"] is None else row["gpu"]["bytes"] / MIB,
            "gpuInstanceMiB": None if row["gpu"]["itemBytes"] is None else row["gpu"]["itemBytes"] / MIB,
            "gpuDeadInstances": row["gpu"]["dead"],
            "indexedCanvasItems": row["canvas"]["indexedItems"],
            "domElements": row["canvas"]["domElements"],
            "domCanvases": row["canvas"]["domCanvases"],
            "reuseEntries": row["pours"]["reuse"],
            "tilePatches": row["pours"]["tilePatches"],
            "autosaveMiB": row["autosave"]["bytes"] / MIB,
        }
        for key, value in values.items():
            if value is not None:
                page_series[key].append((elapsed, value))

    full = collections.get("full", [])
    heap = sorted(inspector_mem.get("javascriptMiB", []))
    after_full = []
    index = 0
    for collected_at, _ in sorted(full):
        while index < len(heap) and heap[index][0] < collected_at:
            index += 1
        if index < len(heap) and heap[index][0] - collected_at < .75:
            after_full.append(heap[index])
    if after_full:
        inspector_mem["javascriptAfterFullGcMiB"] = sorted(set(after_full))

    series = dict(os_mem) | dict(inspector_mem) | dict(page_series)
    active = {k: [(t, v) for t, v in items if 0 <= t <= active_end] for k, items in series.items()}
    checkpoints = {}
    for mark in markers:
        if mark <= active_end + .1:
            checkpoints[str(mark)] = {k: metrics(v for t, v in rows if max(0, mark - 30) <= t <= mark + 30)
                                      for k, rows in active.items()}
    elapsed_idle = finish.get("idleSeconds", 0.)
    tail = {
        k: metrics(v for t, v in rows if active_end + max(0, elapsed_idle - 30) <= t)
        for k, rows in series.items()
    } if finish else {}
    active_starts = [r["startedSec"] for r in rounds]
    active_ends = [r["elapsedSec"] for r in rounds]
    cadence = metadata["editCadenceSec"]
    n = len(rounds)
    continuity = {
        "rounds": n,
        "expectedRounds": int(metadata["durationSec"] // cadence) + 1,
        "maxEditStartGapSec": max((b - a for a, b in zip(active_starts, active_starts[1:])), default=0.),
        "firstAndLastEditStartGapSec": active_starts[-1] - active_starts[0],
        "firstToLastEditEndSec": active_ends[-1] - active_starts[0],
        "sameDoc": len({r["docId"] for r in rounds}) == 1,
        "constantBoardItems": all(r["boardItems"] == 25601 for r in rounds),
        "checkedEveryUndoChain": all(r["undoChain"] == 10 and r["received"]["edits"] == r["received"]["undos"]
                                     == r["received"]["redos"] == 10 * (r["round"] + 1) for r in rounds),
        "visibleRounds": sum(r["webVisibility"] == "visible" and r["pagePowerVisible"] for r in rounds),
        "renderedRounds": sum(r["canvas"]["indexedItems"] == 25601 for r in rounds),
        "gpuRounds": sum(r["gpu"]["route"] == "gpu" for r in rounds),
        "processIDs": {k: sorted(v) for k, v in pids.items()},
        "activeSeconds": completion.get("activeSeconds"),
        "wallSeconds": completion.get("wallSeconds"),
        "idleSeconds": finish.get("idleSeconds"),
        "complete": complete,
    }
    last_half = max(0, active_end - 1800)
    report = {
        "sourceLog": file.name,
        "metadata": metadata,
        "utcStart": start["utc"],
        "utcEnd": completion.get("utc"),
        "utcIdleEnd": finish.get("utc"),
        "continuity": continuity,
        "counts": page_end["received"],
        "endCounts": (events["idle"][-1] if events["idle"] else page_end)["received"],
        "roundEditMs": metrics(r["editMs"] for r in rounds),
        "checkpoints": checkpoints,
        "lastIdleWindow": tail,
        "active": {k: metrics(v for _, v in rows) for k, rows in active.items()},
        "lifetimeProcessPeakFootprintMiB": {k: v / MIB for k, v in proc_peaks.items()},
        "halfHourTrendMiB": {
            k: slope * 30 for k in ("javascriptMiB", "javascriptAfterFullGcMiB", "webRSSMiB", "webFootprintMiB",
                                     "appRSSMiB", "appFootprintMiB", "undoMiB", "gpuAllocMiB")
            if (slope := pairwise_slope([(t, v) for t, v in active.get(k, []) if last_half <= t])) is not None
        },
        "quarterMedians": {
            k: [median(values) if (values := [v for t, v in rows if lower <= t < lower + 900]) else None
                for lower in (0, 900, 1800, 2700)] for k, rows in active.items()
        },
        "inspectorGcMs": {k: metrics(v for t, v in rows if 0 <= t <= active_end) for k, rows in collections.items()},
        "inspectorIdleGcMs": {k: metrics(v for t, v in rows if active_end < t) for k, rows in collections.items()},
        "inspectorMemoryPressure": pressure,
        "inspectorDropped": max((r["dropped"] for r in events["inspector"]), default=0),
        "inspectorClockOffsetSec": tracking_clock_offset,
        "result": results,
        "routeAndVisibility": dict(Counter(f"{r['webVisibility']} / {r['gpu']['route']}" for r in rounds)),
    }
    return report, series


def validate(report, require_hour):
    checks = report["continuity"]
    counts = report["endCounts"]
    metadata = report["metadata"]
    requirements = {
        "harness exited cleanly": checks["complete"],
        "ran every scheduled edit round": checks["rounds"] == checks["expectedRounds"],
        "completed the configured active and idle phases":
            (checks["activeSeconds"] or 0) >= metadata["durationSec"] and
            (checks["idleSeconds"] or 0) >= metadata["idleSec"],
        "maintained the edit cadence": checks["maxEditStartGapSec"] <= 1.5 * metadata["editCadenceSec"],
        "verified every edit, undo and redo": checks["checkedEveryUndoChain"],
        "panned once per round": counts["pans"] == checks["rounds"],
        "edited one dense board": checks["sameDoc"] and checks["constantBoardItems"],
        "kept one WebContent process": len(checks["processIDs"].get("web", [])) == 1,
        "kept editor visible and indexed": checks["visibleRounds"] == checks["renderedRounds"] == checks["rounds"],
        "recorded WebContent and JavaScript memory": all(
            report["active"].get(metric) for metric in ("webRSSMiB", "webFootprintMiB", "javascriptMiB")
        ),
        "lost no inspector packets from the buffer": report["inspectorDropped"] == 0,
    }
    if require_hour:
        requirements.update({
            "ran for at least 3,600 real seconds":
                (checks["activeSeconds"] or 0) >= 3600 and (checks["wallSeconds"] or 0) >= 3600,
            "ran all 121 edit rounds": checks["rounds"] == checks["expectedRounds"] == 121,
            "verified 1,210 moves, undos and redos": counts["edits"] == counts["undos"] == counts["redos"] == 1210,
            "verified edit starts at least one hour apart": checks["firstAndLastEditStartGapSec"] >= 3600,
            "completed repour, DRC and recovery writes":
                counts["repours"] == counts["drcs"] == 20 and counts["autosaves"] == 121,
            "recorded OS and inspector samples at all checkpoints": all(
                report["checkpoints"].get(str(mark), {}).get("javascriptMiB") and
                report["checkpoints"].get(str(mark), {}).get("webFootprintMiB")
                for mark in (0, 900, 1800, 2700, 3600)
            ),
            "measured at least five minutes settling": (checks["idleSeconds"] or 0) >= 300,
        })
    return [name for name, passed in requirements.items() if not passed]


def main():
    args = argparse.ArgumentParser(description=__doc__)
    args.add_argument("log", type=Path)
    args.add_argument("--out", type=Path)
    args.add_argument("--series", type=Path)
    gate = args.add_mutually_exclusive_group()
    gate.add_argument("--require-complete", action="store_true", help="require a complete run with memory samples")
    gate.add_argument("--require-hour", action="store_true", help="require a complete edit hour and idle period")
    cli = args.parse_args()
    try:
        report, series = summarize(cli.log)
    except ValueError as error:
        raise SystemExit(str(error)) from None
    output = json.dumps(report, indent=2, sort_keys=True) + "\n"
    if cli.out:
        cli.out.write_text(output)
    else:
        print(output, end="")
    if cli.series:
        cli.series.write_text(json.dumps(series, separators=(",", ":"), sort_keys=True) + "\n")
    if cli.require_complete or cli.require_hour:
        missing = validate(report, cli.require_hour)
        if missing:
            label = "native hour" if cli.require_hour else "native memory run"
            raise SystemExit(f"Incomplete {label}: " + ", ".join(missing))


if __name__ == "__main__":
    main()
