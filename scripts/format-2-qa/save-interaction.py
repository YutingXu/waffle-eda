#!/usr/bin/env python3
"""Measure trusted AppKit input and WebKit presentation across ordinary durable PCB saves."""
import argparse
from pathlib import Path
import json
from functools import partial
import statistics
import tempfile

from desktop import load_options, measure, quantile
from nativebuild import HERE, instrumentation, native_host


def distribution(values):
    if not values:
        return {"samples": 0, "median": None, "p95": None, "max": None}
    return {"samples": len(values), "median": statistics.median(values),
            "p95": quantile(values, .95), "max": max(values)}


def summarize(result):
    rows = result["rows"]
    data = {}
    for mode in sorted({row["mode"] for row in rows}):
        group = [row for row in rows if row["mode"] == mode]
        pending = [row for row in group if row["during"]["pendingWrites"] > 0]
        data[mode] = {
            "idlePresentationMs": distribution([row["idle"]["presentedMs"] for row in group]),
            "whileSavingPresentationMs": distribution([row["during"]["presentedMs"] for row in pending]),
            "whileSavingDeliveryMs": distribution([row["during"]["deliveryMs"] for row in pending]),
            "whileSavingPairs": len(pending), "notPendingAtDelivery": len(group) - len(pending),
        }
    return {"input": data, "saveMs": distribution([row["savedMs"] for row in rows]),
            "beforeStageMs": distribution([row["beforeStageMs"] for row in rows if row["beforeStageMs"] is not None]),
            "phaseSpansMs": {phase: distribution([span["duration"] for row in rows for span in row["work"] if span["kind"] == phase])
                             for phase in sorted({span["kind"] for row in rows for span in row["work"]})}}


def main():
    cli = argparse.ArgumentParser(description=__doc__)
    cli.add_argument("--product", type=Path, required=True, help="Frozen staged app/native source, including generated assets")
    cli.add_argument("--prepared", type=Path, required=True, help="Format 2.0 frozen controls prepared by prepare.py")
    cli.add_argument("--output", type=Path, required=True)
    cli.add_argument("--case", choices=("garganturam", "synthetic"), action="append")
    cli.add_argument("--mode", choices=("pointer", "pan", "wheel", "key"), action="append",
                     help="Default pointer. Other modes require a WebKit window that accepts the selected AppKit event.")
    cli.add_argument("--repeats", type=int, default=5, help="Matched pairs per input type per board")
    cli.add_argument("--base-probe", type=Path, default=HERE/"desktop-probe.js")
    args = cli.parse_args()
    if not 1 <= args.repeats <= 30:
        cli.error("--repeats must be between 1 and 30")
    args.output.parent.mkdir(parents=True, exist_ok=True)
    output = {}
    with tempfile.TemporaryDirectory(prefix="waffle-save-input-", dir=args.output.parent) as name:
        scratch = Path(name)
        probe = scratch/"probe.js"
        anchor = 'if (trial.mode === "open") return out;'
        source = args.base_probe.read_text()
        if source.count(anchor) != 1:
            raise ValueError("The shared format observer no longer has its open-mode endpoint")
        code = (HERE/"save-interaction-probe.js").read_text()
        probe.write_text(source.replace(anchor, anchor+'\nif (trial.mode === "save-interaction") return await measureSaveInteraction();')+"\n"+code)
        with native_host(probe_file=probe, input_driver=HERE/"save-interaction-input.swift",
                         product_root=args.product, instrumentation=partial(instrumentation, observe_transactions=True)) as executable:
            for case in args.case or ["garganturam", "synthetic"]:
                prepared = args.prepared/case
                options = {**load_options(prepared), "mode": "save-interaction", "repeats": args.repeats,
                           "modes": args.mode or ["pointer"]}
                result = measure(executable, prepared/"design", options, scratch)
                output[case] = {**result, "summary": summarize(result)}
                args.output.write_text(json.dumps(output, indent=2)+"\n")
                print(case, json.dumps(output[case]["summary"]), flush=True)


if __name__ == "__main__":
    main()
