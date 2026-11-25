#!/usr/bin/env python3
"""Summarize the public and aggregate-only private observations from the native Open cohort."""

import argparse
import json
import os
from pathlib import Path
import statistics

from accept import LIMITS


NAMES = {"pidp11-io-expander":"PiDP-11 I/O Expander", "snes-tap":"SNES-Tap", "midas-communication":"MIDAS Communication",
         "cm4-5-shim":"CM4–5 Shim", "esp32c3-haptic":"ESP32-C3 Haptic", "garganturam":"GargantuRAM",
         "corne":"Corne", "lily58":"Lily58", "synthetic":"Synthetic 25.6k board", "approved":"Approved aggregate"}
NUMBERS = ("firstPaintMs", "liveGeometryMs", "readyToEditMs", "firstRSS", "readyRSS", "firstRSSSamples", "readyRSSSamples",
           "activeItems", "documents", "items", "fullAtPresentation")


def load(path):
    return json.loads(path.read_text())


def report(args):
    measured = load(args.observations)
    runtime = load(args.observations.with_suffix(".runtime.json"))
    preparation = load(args.prepared / "preparation-runtime.json")
    if args.converter_seal:
        seal = load(args.converter_seal)
        preparation["frozenConverter"] = {key:seal[key] for key in ("baseCommit", "sha256", "files")}
    sources = load(args.prepared / "receipts.json")
    identity = load(args.prepared / "identity-check.json")
    if set(NAMES) != set(identity) or set(NAMES) != set(sources) or set(NAMES) != set(measured):
        raise ValueError("The Open cohort requires observations, provenance, and identity checks for all ten inputs")
    if not all(all(check.values()) for check in identity.values()) or not runtime["stockWriter"]:
        raise ValueError("Original and sample identities must pass with the stock native writer")
    approved_fields = {"sourceFiles", "sourceBytes", "matchesHistoricalSourceCounts", "documents", "items", "activeKind",
                       "activeItems", "memberCount", "nativeFolderVerified", "preparedWith"}
    if set(sources["approved"]) - approved_fields:
        raise ValueError("The approved input receipt must contain aggregate fields only")
    trials, aggregates = {}, {}
    for name in NAMES:
        rows = measured[name]
        successful = [row for row in rows if "error" not in row]
        items, active, docs = (sources[name][field] for field in ("items", "activeItems", "documents"))
        for row in successful:
            if (row["mode"] != "ready-open" or not row["stockWriter"] or (row["items"], row["activeItems"], row["documents"]) != (items, active, docs)
                    or row["readyToEditMs"] != max(row["firstPaintMs"], row["liveGeometryMs"])
                    or row["readyRSS"] < row["firstRSS"] or row["readyRSSSamples"] < row["firstRSSSamples"]):
                raise ValueError("A ready-to-edit observation disagrees with its verified input or measurement boundary")
        trials[name] = [{key:row[key] for key in NUMBERS} if "error" not in row else {"failed":True} for row in rows]
        result = {"completed":len(successful), "attempted":len(rows), "sameSourceCohort":sources[name]["matchesHistoricalSourceCounts"]}
        if successful:
            for key in ("firstPaintMs", "liveGeometryMs", "readyToEditMs"):
                values = [row[key] for row in successful]
                result[key] = {"median":statistics.median(values), "max":max(values)}
            for key in ("firstRSS", "readyRSS"):
                result[key] = max(row[key] for row in successful)
            if result["sameSourceCohort"]:
                paint, geometry, rss = LIMITS[name][:3]
                result["historicalReference"] = {"firstPaintMs":paint, "savedClosureMs":geometry, "firstRSSMiB":rss}
                complete = len(successful) == len(rows) and len(rows) >= args.repeats
                result["historicalFirstPresentationTargetsMet"] = {
                                        "firstPresentation":complete and result["firstPaintMs"]["median"] <= paint,
                                        "firstPresentationRSS":complete and result["firstRSS"] <= rss * 2**20}
        aggregates[name] = result
    published_sources = {**sources, "approved":{key:value for key, value in sources["approved"].items()
                                               if type(value) in (bool, int, float)}}
    safe = {"runtime":runtime, "preparationRuntime":preparation, "datasets":published_sources, "identity":identity,
            "identityStage":args.identity_stage,
            "trials":trials, "summary":aggregates}
    args.receipt.write_text(json.dumps(safe, indent=2) + "\n")
    return aggregates


def markdown(aggregates):
    lines = ["| Design | Fresh opens | First presentation / prior cap (ms) | All editable geometry (ms) | Ready median / max (ms) | Peak to first presentation / prior cap (MiB) | Peak through ready (MiB) |",
             "| --- | ---: | ---: | ---: | ---: | ---: | ---: |"]
    for name, row in aggregates.items():
        count = f'{row["completed"]}/{row["attempted"]}'
        values = ["—"] * 5
        if row["completed"]:
            cap = row.get("historicalReference", {})
            values = [f'{row["firstPaintMs"]["median"]:.1f} / {cap.get("firstPaintMs", "—")}',
                      f'{row["liveGeometryMs"]["median"]:.1f}',
                      f'{row["readyToEditMs"]["median"]:.1f} / {row["readyToEditMs"]["max"]:.1f}',
                      f'{row["firstRSS"]/2**20:.1f} / {cap.get("firstRSSMiB", "—")}', f'{row["readyRSS"]/2**20:.1f}']
        lines.append("| " + " | ".join([NAMES[name], count, *values]) + " |")
    return "\n".join(lines) + "\n"


def review(args, aggregates):
    runtime = load(args.observations.with_suffix(".runtime.json"))
    sources = load(args.prepared / "receipts.json")
    approved = sources["approved"]
    completed = sum(row["completed"] for row in aggregates.values())
    attempted = sum(row["attempted"] for row in aggregates.values())
    comparable = {name:row["historicalFirstPresentationTargetsMet"] for name, row in aggregates.items()
                  if "historicalFirstPresentationTargetsMet" in row}
    presentation_misses = [NAMES[name] for name, values in comparable.items() if not values["firstPresentation"]]
    rss_passes = sum(values["firstPresentationRSS"] for values in comparable.values())
    title = "# Native Open and ready-to-edit measurements"
    if args.identity_stage == "after-conversion":
        title += f" for the earlier runtime {runtime['sourceParent'][:8]}"
    text = [title, "",
            f"The stock macOS editor completed {completed} of {attempted} fresh-process Opens across ten designs. "
            f"The host ran macOS {runtime['macOS']} ({runtime['macOSBuild']}) on {runtime['processor']} "
            f"with {runtime['physicalMemoryBytes']/2**30:g} GiB RAM. "
            "Each trial used a disposable copy of the shared Save and Git measurement cohort.", ""]
    if presentation_misses:
        text.extend(["The median first-presentation time exceeded the earlier cap for " + ", ".join(presentation_misses) + ".", ""])
    text.extend([f"{rss_passes} of {len(comparable)} comparable designs stayed within their earlier first-presentation RSS cap.", "",
            markdown(aggregates).rstrip(), "", "## Measurement boundaries", "",
            "- Immediately before each Open, the harness read every member of that trial's working copy to give all cases a controlled warm filesystem cache. Each run used a fresh native process and a fresh, nonpersistent WebKit content process. The timer starts at the normal native Open entry with the editor already running.",
            "- First presentation is WebKit's acknowledgement of a frame with the expected populated active document. The live geometry check requests the full editable document and library closure, then verifies each document's item count against the verified fixture. Readiness is the later of these two observations. When the full geometry was ready at first presentation, that presentation provides the upper bound for geometry readiness.",
            "- The harness measures presentation acknowledgement in a nonactivating window. Peak resident memory is the highest 5 ms sample of the combined editor and WebKit content processes, including samples at both endpoints. GPU and networking processes are outside this measure. All table times are medians unless a maximum is shown.",
            "- The historical first-presentation and memory caps are included for context. The earlier full-closure test also read and verified saved attachments, so its cap is separate from the live geometry measurement here. Reimporting the same public source revisions can produce different item counts with the amended translator.", "",
            "## Inputs and identity checks", "",
            "The public originals match their pinned source sets byte for byte. The dense control was re-authored with new UUIDv7 identities and checked for unchanged geometry after rebinding. "
            f"The approved run uses the current authorized local source set of {approved['sourceFiles']} files and {approved['sourceBytes']:,} bytes. "
            "The previous six-file cohort was unavailable. The approved fixture used the browser editor's ordinary first Save."])
    if args.identity_stage == "after-conversion":
        text.extend(["", "This earlier runtime receipt carries the post-conversion checksum checks. The later end-to-end checks are recorded with the final runtime measurements."])
    elif args.identity_stage == "before-final-readback":
        text.extend(["", "The private original and prepared member checks passed during the preceding Open round. The final checksum verification follows the remaining independent timing runs."])
    else:
        text.extend(["", "The protected verification checked the approved repository's HEAD, index state, selected working files, and pinned source bytes before and after all runs. All prepared projects passed the final member checksum check."])
    higher_memory = [(NAMES[case], row["preparationCliMemoryMiB"]) for case, row in sources.items()
                     if row.get("preparationCliMemoryMiB", 0) > 2048]
    if higher_memory:
        fixture_settings = ", ".join(f"{name} at {mib} MiB" for name, mib in higher_memory)
        text.extend(["", f"Only the isolated CLI fixture conversion used a raised memory allowance ({fixture_settings}). The Open trials used the stock desktop runtime."])
    relative_receipt = Path(os.path.relpath(args.receipt, args.markdown.parent)).as_posix()
    text.extend(["", f"Runtime commit `{runtime['sourceParent']}` and the signed observer's app, bridge, executable and probe digests accompany the [individual observations]({relative_receipt}).", ""])
    return "\n".join(text).rstrip("\n") + "\n"


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--observations", type=Path, required=True)
    parser.add_argument("--prepared", type=Path, required=True)
    parser.add_argument("--receipt", type=Path, required=True)
    parser.add_argument("--markdown", type=Path)
    parser.add_argument("--converter-seal", type=Path)
    parser.add_argument("--identity-stage", choices=("after-conversion", "before-final-readback", "after-all-runs"), default="after-all-runs")
    parser.add_argument("--repeats", type=int, default=3)
    options = parser.parse_args()
    aggregates = report(options)
    if options.markdown:
        options.markdown.write_text(review(options, aggregates))
    else:
        print(markdown(aggregates), end="")
