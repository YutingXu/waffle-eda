#!/usr/bin/env python3
"""Measure the verified Altium corpus and compare the results with the committed baseline."""
import argparse
import json
import math
import os
import shutil
import subprocess
import sys
import tempfile
from collections import Counter
from pathlib import Path

from fetch import DEFAULT_CACHE, HERE, ROOT, manifest, verified

sys.path.insert(0, str(ROOT / "mcp"))
from board_runner import resolve

BASELINE = HERE.parent / "altium-fidelity.json"
MODULES = ("core", "parts", "import-formats", "import-rules", "erc", "connectivity", "stackup", "pcb-appearance",
           "board-shape", "viastack", "via-stubs", "rule-sets", "dfa", "drc", "polygon-pour", "si", "ipc2152",
           "fab-outputs", "bom", "print", "altium-export", "ipc2581", "step-export", "dxf", "translators",
           "translator-adapters", "translator-exports", "translator-manufacturing")
SILK_COUNTS = ("authored", "exactStock", "legacyStock")
SPARSE_DELTAS = ("byCheck", "byRule", "kindDelta", "kindCountDecreases", "kindCountIncreases")


def gap_categories(report, notes):
    layers = report["gerbers"]["layers"]
    def differs(names):
        return any((layers.get(k, {}).get("xorMm2") or 0) >= 1 for k in names)
    trip = report["roundTrip"]
    pnp = report["assembly"]["pickPlace"]
    categories = {
        "Altium rule records without native conversion":report["convertedRules"] < report["sourceRules"],
        "3D component body records omitted":"Omitted componentbodies6 (" in notes,
        "Shape-based region records omitted":any(message in notes for message in ("Omitted shapebasedregions6 (", "Truncated ShapeBasedRegions6", "Unreadable region:", "Unreadable board cutout:",
            "Unreadable polygon cutout:", "Unreadable keepout:", "Omitted region ", "Region used its stored tessellation:")),
        "Arcs approximated with line segments":"Tessellated arcs (" in notes,
        "Layer-specific pad stacks simplified":"Layer-specific pad stacks simplified (" in notes,
        "Stored split-plane or non-copper polygons omitted":"not copper pours" in notes,
        "Unresolved external project libraries":report["missingSourceLibraries"] > 0,
        "Outer copper differs by at least 1 mm²":differs(("GTL", "GBL")),
        "Inner copper differs by at least 1 mm²":differs(("G1", "G2", "G3", "G4", "GP1", "GP2")),
        "Legend differs by at least 1 mm²":differs(("GTO", "GBO")),
        "Solder mask differs by at least 1 mm²":differs(("GTS", "GBS")),
        "Solder paste differs by at least 1 mm²":differs(("GTP", "GBP")),
        "Profile differs by at least 1 mm²":any((v.get("xorMm2") or 0) >= 1 for k,v in layers.items() if k in ("GM", "GM1", "GKO")),
        "Shipped Gerber has no equivalent generated layer":any(v.get("reason") in ("no equivalent Waffle layer","layer absent from export") for v in layers.values()),
        "Shipped drill hits missing or added":bool(report["drill"] and (report["drill"]["missingHits"] or report["drill"]["extraHits"])),
        "Pick-and-place centre differs by more than 10 µm":bool(pnp and pnp["centresOver10um"]),
        "Round-trip part pad net assignments differ":trip["padNetsLost"] + trip["padNetsAdded"] > 0,
        "Round-trip schematic pin groups differ":trip["pinGroupsLost"] + trip["pinGroupsAdded"] > 0,
        "Round-trip object counts differ":bool(trip["kindDelta"]),
    }
    return sorted(k for k, present in categories.items() if present)


def measure(fixture, cache, node):
    from compare_outputs import assembly, check_reports, pdf_comparisons
    from pdf_layouts import resolve as resolve_pdf_views

    directory, resources = verified(fixture, cache, offline=True)
    modules = [(name, str(path)) for name, path in resolve(MODULES)]
    files = [(f["role"], directory / f["name"]) for f in resources]
    views = resolve_pdf_views(fixture, files)
    with tempfile.TemporaryDirectory(prefix="waffle-fidelity-") as tmp:
        scratch = Path(tmp)
        request = {"project":fixture, "modules":modules, "resources":resources, "directory":str(directory), "scratch":tmp,
                   "publicationViews":views}
        subprocess.run([node, "--max-old-space-size=1536", str(HERE / "measure.cjs")], input=json.dumps(request),
                       text=True, check=True, timeout=240, env={**os.environ, "TZ":"UTC", "LC_ALL":"C"})
        detail = json.loads((scratch / "detail.json").read_text())
        out = detail["report"]
        out["assembly"], bom_refs = assembly(dict(files), scratch, out["outputs"])
        out["pdfs"] = pdf_comparisons(fixture, [(r, p) for r, p in files if r.startswith("pdf:")], scratch, detail, bom_refs, views)
        out["publishedChecks"] = check_reports([(r, p) for r, p in files if r.startswith("check:")], out)
        out["observedGaps"] = gap_categories(out, "\n".join(detail["notes"]))
        return {"revision":fixture["revision"], "origin":fixture["origin"], **out}


def regressions(previous, measured, publication_baselines=None):
    """Apply metric directions. Lost comparison coverage fails even if total XOR decreases."""
    errors = []
    def fail(p, msg):
        errors.append(".".join(p) + " " + msg)
    def walk(old, new, p, direction="max"):
        key = p[-1]
        if old is None:
            return  # A previously unavailable reference can acquire a comparison.
        if new is None:
            fail(p, "became unavailable")
            return
        if isinstance(old, dict):
            if not isinstance(new, dict):
                fail(p, "changed type")
                return
            for k, value in old.items():
                # Zero findings often disappear from sparse tallies as a result improves.
                sparse = key in (*SPARSE_DELTAS, "boardKinds", "schematicKinds")
                if k not in new and not sparse:
                    fail(p + [k], "is missing")
                elif k in new or sparse:
                    walk(value, new.get(k, 0), p + [k], direction)
            if key in SPARSE_DELTAS or "reimportedDifference" in p:
                for k in new.keys() - old.keys():
                    walk(0, new[k], p + [k], direction)
            return
        if isinstance(old, list):
            # Descriptive rankings change when improvements move a project between categories.
            return
        if isinstance(old, str):
            if key not in ("reason", "drillUnavailable") and old != new:
                fail(p, "changed")
            return
        if not isinstance(new, (float, int)) or isinstance(new, bool) or not math.isfinite(new):
            fail(p, "is not a numeric measurement")
            return
        if key in ("reference", "referenceParts", "referenceRows", "referenceHits", "referencePages"):
            direction = "equal"
        elif key in ("unresolvedReferences", "stepBodiesMissing"):
            direction = "max"
        elif key == "generated":
            return  # Independent missing and extra counts gate each designator comparison.
        if direction == "min" and new < old or direction == "max" and new > old or direction == "equal" and old != new:
            fail(p, f"{old} -> {new}")

    def distance(source, recovered):
        if isinstance(source, dict) or isinstance(recovered, dict):
            source = source if isinstance(source, dict) else {}
            recovered = recovered if isinstance(recovered, dict) else {}
            return {k:distance(source.get(k, 0), recovered.get(k, 0)) for k in source.keys() | recovered.keys()}
        return abs(source - recovered)

    def check_translation(old, new, p):
        # Source objects have three ordered outcomes. Keeping an approximated record, or
        # representing one that used to drop, improves fidelity. An exporter may emit
        # additional features, and a reader may identify additional source records.
        if not isinstance(new, dict):
            fail(p, "is missing a translator report")
            return
        for phase in ("imported", "exported", "reimported"):
            earlier, current = old.get(phase, {}), new.get(phase)
            if not isinstance(current, dict):
                fail(p + [phase], "is missing a translator phase")
                continue
            for kind in earlier.keys() - current.keys():
                fail(p + [phase,kind], "lost source accounting")
            for kind, counts in current.items():
                here = p + [phase,kind]
                statuses = ("kept", "approximated", "dropped")
                if not isinstance(counts, dict) or any(type(counts.get(k)) is not int or counts[k] < 0 for k in statuses):
                    fail(here, "needs three nonnegative integer source counts")
                    continue
                if kind not in earlier:
                    continue
                prior, actual = 0, 0
                for status, metric in zip(statuses, ("kept", "kept or approximated", "accounted source objects")):
                    prior += earlier[kind][status]
                    actual += counts[status]
                    if actual < prior:
                        fail(here, f"{metric} {prior} -> {actual}")

    def check_geometry(old, new, p):
        for stage, coverage in old.items():
            if stage not in new:
                fail(p + [stage], "is missing")
                continue
            if stage == "formats":
                # The PDF count includes cubic glyphs, pad outlines and circles. The
                # published PDF raster comparison gates the rendered page separately.
                coverage = {k:v for k,v in coverage.items() if k != "pcbPdfCubicSegments"}
            walk(coverage, new[stage], p + [stage], "equal" if stage == "source" else "min")

    def check_outputs(old, new, p):
        lower = old["outputs"].copy()
        if "drillHits" in lower and "drillSlots" in lower:
            current = new["outputs"]
            slots = new.get("drillSlotEvidence", {})
            source = slots.get("sourcePadSlots", 0)
            new_slots = current.get("drillSlots", 0)
            opening_count = lower["drillHits"] + lower["drillSlots"]
            if "physicalDrillOpenings" in current:
                walk(opening_count, current["physicalDrillOpenings"], p + ["physicalDrillOpenings"], "min")
                if current["physicalDrillOpenings"] != current["drillHits"] + new_slots:
                    fail(p + ["physicalDrillOpenings"], "does not equal round hits plus slots")
            # Older exporters treated source slots as round drills. Only accept
            # a count transfer when all new slots match the pinned source pad
            # geometry and the corpus has no published NC drill comparison.
            prior = old.get("drillSlotEvidence")
            if (old.get("drillUnavailable") == new.get("drillUnavailable") == "no shipped NC drill"
                    and old.get("drill") is None and new.get("drill") is None
                    and 0 < source <= lower["drillHits"] and lower["drillSlots"] == 0
                    and new_slots == source == slots.get("matched")
                    and slots.get("unmatched") == slots.get("slotsStillRound") == 0
                    and (not prior or prior["slotsStillRound"] == source == prior["sourcePadSlots"])
                    and current.get("physicalDrillOpenings", 0) >= opening_count):
                lower["drillHits"] -= source
        walk(lower, new["outputs"], p, "min")

    def check_pdfs(old, new, p, declared):
        for filename, prior in old.items():
            here = p + [filename]
            if filename not in new:
                fail(here, "reference is missing")
                continue
            current = new[filename]
            before = declared.get(filename, {})
            if not before:
                walk(prior, current, here)
                continue
            views = current.get("sourcePageViews")
            if views is None or views.keys() != before.keys():
                fail(here + ["sourcePageViews"], "published page bindings changed")
                continue
            sections = {}
            for kind, section in prior["sections"].items():
                sections[kind] = dict(section)
                if "pageInkDifferencePct" in section:
                    numbers = section["pageInkDifferencePct"]
                    actual = current["sections"].get(kind, {}).get("pageInkDifferencePct", {})
                    for n in numbers.keys() & before.keys():
                        if not isinstance(actual.get(n), (int, float)) or not math.isfinite(actual[n]):
                            fail(here + ["sections", kind, n], "historical diagnostic is missing")
                    sections[kind]["pageInkDifferencePct"] = {n:v for n,v in numbers.items() if n not in before}
            walk({"referencePages":prior["referencePages"], "sections":sections}, current, here)
            for n, measurement in before.items():
                walk(measurement, views[n].get("inkDifferencePct"), here + ["sourcePageViews", n, "inkDifferencePct"])
            for n, view in prior.get("sourcePageViews", {}).items():
                actual = views[n]
                ink = "inkDifferencePct"
                if {k:v for k,v in view.items() if k != ink} != {k:v for k,v in actual.items() if k != ink}:
                    fail(here + ["sourcePageViews", n], "page layout changed")
                walk(view[ink], actual[ink], here + ["sourcePageViews", n, ink])

    if previous["protocol"] != measured["protocol"]:
        errors.append("measurement protocol changed")
    for name, old in previous["projects"].items():
        new = measured["projects"].get(name)
        if new is None:
            errors.append(name + " disappeared")
            continue
        old_silk, new_silk = old.get("silkRuleComparison", {}), new.get("silkRuleComparison", {})
        old_text, new_text = old_silk.get("legendText", {}), new_silk.get("legendText", {})
        if "legendText" in new_silk and (not isinstance(new_text, dict) or set(new_text) != set(SILK_COUNTS)
                or any(type(count) is not int or type(new_silk.get(metric)) is not int or not 0 <= count <= new_silk[metric]
                       for metric, count in new_text.items())):
            fail([name, "silkRuleComparison", "legendText"], "invalid text finding counts")
            new_text = {}
        if "translation" in old or "translation" in new:
            check_translation(old.get("translation", {}), new.get("translation"), [name,"translation"])
        for key, value in old.items():
            if key == "translation":
                continue
            if key == "observedGaps":
                for gap in set(new.get(key, [])) - set(value):
                    fail([name, key], "acquired " + gap)
                continue
            if key == "drillUnavailable":
                continue
            if key not in new:
                fail([name, key], "is missing")
            elif key == "reimported":
                # An export can approximate one source object with many graphic primitives.
                # Closing the discrepancy in either direction improves a round trip.
                old_delta = distance(old["imported"], value)
                new_delta = distance(new["imported"], new[key])
                walk(old_delta, new_delta, [name, "reimportedDifference"])
            elif key == "gerbers":
                for metric in ("gerberXorMm2", "registeredXorMm2"):
                    if metric in value:
                        walk(value[metric], new[key].get(metric), [name,key,metric])
                walk(value["measuredLayers"], new[key]["measuredLayers"], [name,key,"measuredLayers"], "min")
                if "generatedArcs" in value:
                    walk(value["generatedArcs"], new[key].get("generatedArcs"), [name,key,"generatedArcs"], "min")
                if "declaredProfile" in value:
                    actual = new[key].get("declaredProfile", {})
                    for metric, prior in value["declaredProfile"].items():
                        walk(prior, actual.get(metric), [name,key,"declaredProfile",metric], "equal" if metric == "widthMm" else "max")
                for layer, prior in value["layers"].items():
                    if layer not in new[key]["layers"]:
                        fail([name, key, layer], "reference is missing")
                    else:
                        for metric in ("xorMm2", "registeredXorMm2", "referencePolarity", "outputLayer"):
                            if metric in prior:
                                walk(prior[metric], new[key]["layers"][layer].get(metric), [name, key, layer, metric])
                        if "referenceArcs" in prior:
                            walk(prior["referenceArcs"], new[key]["layers"][layer].get("referenceArcs"),
                                 [name,key,layer,"referenceArcs"], "equal")
            elif key == "geometry":
                check_geometry(value, new[key], [name, key])
            elif key == "pdfs":
                sources = (publication_baselines or {}).get(name, {})
                check_pdfs(value, new[key], [name,key], sources)
            elif key == "drc" and "silkRuleComparison" in new:
                policy = new["silkRuleComparison"]
                current = new[key]
                actual_silk = current["byRule"].get("silkToMask", 0)
                if (not policy["sourceRules"] or policy["sourceRules"] != len(policy["sourceLimits"])
                        or policy["authored"] != actual_silk or current["total"] != sum(current["byRule"].values())):
                    fail([name,key,"silkToMask"], "unclassified silk findings")
                    continue
                # Historical baselines used lines only. The oldest also use stock
                # rule limits and the compatibility shapes from the binary pads.
                if "silkRuleComparison" not in old:
                    comparable = policy["legacyStock"] - new_text.get("legacyStock", 0)
                elif "legendText" not in old_silk:
                    comparable = actual_silk - new_text.get("authored", 0)
                else:
                    comparable = actual_silk
                projection = {"total":current["total"] - actual_silk + comparable,
                              "byRule":{**current["byRule"], "silkToMask":comparable}}
                walk(value, projection, [name,key])
            elif key == "silkRuleComparison":
                if value["sourceLimits"] != new[key].get("sourceLimits"):
                    fail([name,key,"sourceLimits"], "source surfaces or limits changed")
                for metric, prior in value.items():
                    if metric == "sourceLimits":
                        continue
                    path = [name,key,metric]
                    if metric in SILK_COUNTS:
                        count = new[key].get(metric)
                        walk(prior - old_text.get(metric, 0), count - new_text.get(metric, 0) if type(count) is int else count, path)
                    else:
                        direction = "min" if metric == "projectedPads" else "equal"
                        walk(prior, new[key].get(metric), path, direction)
            elif key == "outputs":
                check_outputs(old, new, [name, key])
            elif key == "drillSlotEvidence":
                for metric, prior in value.items():
                    direction = "equal" if metric == "sourcePadSlots" else "min" if metric == "matched" else "max"
                    walk(prior, new[key].get(metric), [name, key, metric], direction)
            elif key == "ruleCoverage" and value is not None:
                walk(value["supported"], new[key].get("supported") if new[key] else None, [name,key,"supported"], "min")
                walk(value["source-only"], new[key].get("source-only") if new[key] else None, [name,key,"source-only"])
            else:
                direction = "min" if key in ("imported", "reimported", "sourceRules", "convertedRules", "rulesChecked", "outputs") else "max"
                walk(value, new[key], [name, key], direction)
    return errors


def write_result(path, data):
    # Keep project totals scannable while retaining individual layer/rule counters.
    def pretty(obj, depth):
        single = json.dumps(obj, ensure_ascii=False, allow_nan=False)
        if not isinstance(obj, dict) or len(single) < 140:
            return single
        ind = "  " * depth
        lines = [ind + "  " + json.dumps(k, ensure_ascii=False) + ": " + pretty(v, depth+1) for k,v in obj.items()]
        return "{\n" + ",\n".join(lines) + "\n" + ind + "}"
    path.write_text(pretty(data, 0) + "\n", encoding="utf-8")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--cache", type=Path, default=DEFAULT_CACHE)
    parser.add_argument("--node", default=shutil.which("node"))
    parser.add_argument("--output", type=Path, help="also save measured JSON at this path")
    parser.add_argument("--against", type=Path, help="also check an earlier commit's baseline")
    parser.add_argument("--write-baseline", action="store_true", help="replace the baseline after reviewing intentional changes")
    args = parser.parse_args()
    if not args.node:
        parser.error("Node.js 24 is required")
    protected = {BASELINE.resolve()}
    if args.against:
        protected.add(args.against.resolve())
    if args.output and args.output.resolve() in protected:
        parser.error("--output needs a separate result file; --write-baseline updates the baseline")
    result = {"protocol":{"pixelMm":0.025, "areaUnit":"mm²", "drillToleranceMm":0.005,
                          "pickPlaceToleranceMm":0.01, "rotationToleranceDeg":0.1, "pdfGrid":128}, "projects":{}}
    publication_baselines = {}
    for fixture in manifest():
        out = measure(fixture, args.cache, args.node)
        result["projects"][fixture["id"]] = out
        print(f"{fixture['id']}: {out['imported']['objects']} objects, {out['drc']['total']} DRC findings, "
              f"{out['gerbers']['measuredLayers']} measured layers, {out['gerbers']['gerberXorMm2']} mm² XOR", flush=True)
        publication_baselines[fixture["id"]] = {name: view["predecessorInkPct"]
            for name,view in fixture.get("pdfPageViews", {}).items() if "predecessorInkPct" in view}
    counts = Counter(g for p in result["projects"].values() for g in p["observedGaps"])
    result["rankedGaps"] = dict(sorted(counts.items(), key=lambda v: (-v[1], v[0])))
    if args.output:
        write_result(args.output, result)
    failures = []
    for baseline in dict.fromkeys([BASELINE] + ([args.against] if args.against else [])):
        previous = json.loads(baseline.read_text())
        failures.extend(regressions(previous, result, publication_baselines))
        if baseline == BASELINE and previous["projects"].keys() != result["projects"].keys():
            failures.append("manifest and baseline project lists differ")
    if failures:
        print("\n".join(failures), file=sys.stderr)
        return 1
    if args.write_baseline:
        write_result(BASELINE, result)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
