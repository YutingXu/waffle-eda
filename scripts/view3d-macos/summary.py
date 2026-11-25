#!/usr/bin/env python3
"""Print per-trial and pooled timings from the native viewer's numeric JSON receipts."""
import argparse
import csv
import json
import math
from pathlib import Path
import statistics
import sys


def percentile(values, q):
    ordered = sorted(values)
    index = (len(ordered) - 1) * q
    a, b = math.floor(index), math.ceil(index)
    return round(ordered[a] + (ordered[b] - ordered[a]) * (index - a), 2)


def join(values):
    return "/".join(f"{x:g}" for x in values)


def detail(record, group, phases):
    modes = ("orbit", "pan", "zoom")

    def across(read):
        return ";".join(sorted({read(row) for row in group}))

    def motion(mode, *values):
        return across(lambda row: join(round(row["phases"][mode]["motion"][key], 3) for key in values))

    return [record["product"]["commit"],
            statistics.median(r["idle"]["displayFrameMedianMs"] for r in group),
            join(round(1000 * len(gaps) / sum(gaps), 1) for gaps in phases),
            join(sum(r["phases"][mode]["trustedEvents"] for r in group) for mode in modes),
            across(lambda row: join(row["requestedPointer"])),
            *(across(lambda row: "→".join(join(row["phases"][mode][key])
                                         for key in ("firstPointer", "lastPointer"))) for mode in modes),
            motion("orbit", "yawDeg", "pitchDeg"), motion("pan", "targetMm"),
            motion("zoom", "distanceBeforeMm", "distanceAfterMm"),
            across(lambda row: join(row["phases"]["zoom"]["wheel"][key] for key in ("dy", "wheelDeltaY"))),
            across(lambda row: join(row["precision"]["event"][key] for key in ("dy", "wheelDeltaY"))),
            across(lambda row: join([round(row["precision"]["targetMm"], 3), row["precision"]["distanceChangeMm"]])),
            sum(r["hidden"]["elapsedMs"] for r in group), sum(r["hidden"]["draws"] for r in group),
            sum(r["hidden"]["instancedCalls"] for r in group),
            statistics.median(r["hidden"]["revealedMs"] for r in group),
            across(lambda row: join(row["hidden"][key] for key in ("reusedGeometryBuffers", "originalGeometryBuffers"))),
            int(any(r["gpu"]["active"] or r["gpu"]["keyWindow"] or r["focus"]["active"] or r["focus"]["keyWindow"] for r in group))]


def summarize(files, diagnostics=False):
    out = csv.writer(sys.stdout, delimiter="\t", lineterminator="\n")
    header = ["case", "sample", "cold_submit_ms", "cold_first_present_ms", "cold_detail_present_ms",
                  "warm_submit_ms", "warm_first_present_ms", "warm_detail_present_ms", "decoded_assets", "placements", "extrusions",
                  "triangles", "idle_ms", "idle_draws", "orbit_gaps_p50_p95_worst_ms", "pan_gaps_p50_p95_worst_ms",
                  "zoom_gaps_p50_p95_worst_ms", "orbit_pan_zoom_gaps", "orbit_pan_zoom_over_33_4_ms", "max_zoom_drift_px"]
    if diagnostics:
        header += ["product_commit", "display_interval_p50_ms", "orbit_pan_zoom_draw_hz", "orbit_pan_zoom_trusted_events",
                   "requested_pointer_css_xy", "orbit_pointer_css_xy", "pan_pointer_css_xy", "zoom_pointer_css_xy",
                   "orbit_yaw_pitch_deg", "pan_target_delta_mm", "zoom_distance_before_after_mm", "wheel_delta_y_legacy",
                   "precision_delta_y_legacy", "precision_pan_and_distance_delta_mm", "occluded_ms", "occluded_draws",
                   "occluded_instanced_calls", "reveal_present_ms", "geometry_buffers_retained", "focus_taken"]
    out.writerow(header)
    for path in files:
        record = json.loads(path.read_text())
        runs = record["runs"]
        for name, group in [*((str(i + 1), [run]) for i, run in enumerate(runs)), ("pooled", runs)]:
            def median(section, key):
                return statistics.median(r[section][key] for r in group)

            cold = group[0]["cold"]
            state = cold["detail"]
            assert all(run["fileOrigin"] and not run["initiallyLoaded"] and
                       run["gpu"]["webgl"].startswith("WebGL 2") for run in group)
            assert all((r["cold"]["detail"], r["cold"]["triangles"]) == (state, cold["triangles"])
                       and r["warm"]["detail"] == state for r in group)
            phases = [[gap for r in group for gap in r["phases"][mode]["intervalsMs"]] for mode in ("orbit", "pan", "zoom")]
            row = [record["case"], name,
                          *(median(section, key) for section in ("cold", "warm")
                            for key in ("submitMs", "firstPresentMs", "detailPresentMs")),
                          join([state["decodedAssets"], state["expectedAssets"]]), join([state["shownPlacements"], state["expectedPlacements"]]),
                          join([state["shownExtrusions"], state["expectedExtrusions"]]), cold["triangles"], sum(r["idle"]["elapsedMs"] for r in group), sum(r["idle"]["draws"] for r in group),
                          *(join([percentile(gaps, .5), percentile(gaps, .95), max(gaps)]) for gaps in phases),
                          join([len(gaps) for gaps in phases]), join([sum(n > 33.4 for n in gaps) for gaps in phases]),
                          round(max(r["phases"]["zoom"]["zoomErrorPx"] for r in group), 3)]
            if diagnostics:
                row.extend(detail(record, group, phases))
            out.writerow(row)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--diagnostics", action="store_true", help="Include input coordinates and incremental visibility checks")
    parser.add_argument("receipts", type=Path, nargs="+")
    args = parser.parse_args()
    summarize(args.receipts, args.diagnostics)
