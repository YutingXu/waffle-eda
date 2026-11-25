#!/usr/bin/env python3
"""Summarize the public numeric receipts from view3d-macos-responsive.py."""
import argparse
import csv
import json
from math import ceil
from pathlib import Path
import sys


def quantiles(values):
    values = sorted(values)
    return [round(values[ceil(len(values) * q) - 1], 2) for q in (.50, .95, 1)] if values else ["", "", ""]


def summarize(receipts):
    out = csv.writer(sys.stdout, delimiter="\t", lineterminator="\n")
    out.writerow(["case", "kind", "trials", "Samples", "p50_ms", "p95_ms", "max_ms", "over_8.33_ms", "over_16.67_ms",
                  "samples_hz", "native_inputs", "trusted_inputs", "paired_latest_inputs", "dom_coalesced", "dom_pending"])
    for path in receipts:
        receipt = json.loads(path.read_text())
        if receipt["control"] or "failures" in receipt:
            continue
        case, runs = receipt["case"], receipt["runs"]

        def output(label, values, *, counts=(), intervals=False):
            values = list(values)
            misses = [sum(value > ms for value in values) for ms in (8.33, 16.67)] if intervals else ["", ""]
            rate = round(1000 * len(values) / sum(values), 1) if intervals and sum(values) > 0 else ""
            out.writerow([case, label, len(runs), len(values), *quantiles(values), *misses, rate, *counts])

        for stage in ("cold", "warm"):
            for key in ("firstDrawMs", "firstPresentMs", "detailSubmittedMs", "detailPresentMs"):
                output(stage + "." + key, (r[stage][key] for r in runs))
        output("idle.rAF_gaps", (ms for r in runs for ms in r["idle"]["rafIntervalsMs"]), intervals=True)
        for phase in ("orbit", "pan", "zoom"):
            rows = [r["phases"][phase] for r in runs]
            counts = [sum(row[key] for row in rows) for key in ("nativeInputs", "trustedInputs", "pairedInputs", "coalescedInputs", "pendingInputs")]
            output(phase + ".changed_draw_gaps", (ms for row in rows for ms in row["changedIntervalsMs"]), counts=counts, intervals=True)
            output(phase + ".DOM_to_draw", (ms for row in rows for ms in row["latestDOMInputToDrawMs"]), counts=counts)
            output(phase + ".release_to_ack", (row["acknowledgedAfterDispatchReturnMs"] for row in rows))


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("receipts", nargs="+", type=Path)
    summarize(parser.parse_args().receipts)
