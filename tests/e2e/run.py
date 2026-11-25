#!/usr/bin/env python3
"""End-to-end import -> model -> outputs -> reference comparison -> native round trip.

Full tier: every project in tests/e2e/corpus.json (the Altium fidelity fixtures plus KiCad
projects), fetched and pinned outside the checkout by tests/altium-fidelity/fetch.py's verifier.
Optional private corpus: WAFFLE_E2E_PRIVATE names a local folder whose subfolders each hold one
project (sources plus the original tool's outputs). It is run locally only; the report names
those projects "private-N" and prints no paths or file names.

  python3 tests/e2e/run.py [--fetch] [--only ID ...] [--mutations] [--json OUT]
Prepare app assets first with python3 scripts/prepare-assets.py.
  python3 tests/e2e/run.py --write-modules     regenerate only the fidelity module manifest

Exit status 1 when a gating check fails that tests/e2e/known-failures.json does not list, or a
listed failure now passes (remove it from the list).
"""
import argparse
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import time
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent.parent
sys.path.insert(0, str(ROOT / "scripts"))
sys.path.insert(0, str(HERE.parent / "altium-fidelity"))
import fetch  # noqa: E402  (verified downloads outside the checkout, pinned by SHA-256)
from e2e_modules import prepare_modules  # noqa: E402


def corpus():
    data = json.loads((HERE / "corpus.json").read_text())
    altium = {p["id"]: p for p in fetch.manifest()}
    projects = []
    for entry in data["projects"]:
        if entry.get("fixtures") == "altium-fidelity":
            projects.append({**altium[entry["id"]], **{k: v for k, v in entry.items() if k != "fixtures"}, "translator": "altium"})
        else:
            if entry["license"] not in {"BSD-2-Clause", "BSD-3-Clause", "MIT", "Apache-2.0", "CERN-OHL-P-2.0", "CC-BY-4.0"}:
                raise ValueError("unexpected design licence")
            if not re.fullmatch(r"[0-9a-f]{40}", entry["revision"]) or not re.fullmatch(r"https://github\.com/[\w.-]+/[\w.-]+", entry["upstream"]):
                raise ValueError("invalid source repository or revision")
            projects.append(entry)
    return projects


def private_projects():
    """Subfolders of WAFFLE_E2E_PRIVATE; never printed, never written into the repository."""
    root = os.environ.get("WAFFLE_E2E_PRIVATE")
    if not root:
        return []
    base = Path(root).expanduser()
    if not base.is_dir():
        raise SystemExit("WAFFLE_E2E_PRIVATE is not a folder")
    resolved = base.resolve()
    if resolved == ROOT or ROOT in resolved.parents:
        raise SystemExit("WAFFLE_E2E_PRIVATE must be outside the checkout")
    folders = sorted(p for p in base.iterdir() if p.is_dir() and not p.name.startswith("."))
    out = []
    for i, folder in enumerate(folders or [base], 1):
        files = [p for p in folder.rglob("*") if p.is_file() and not any(part.startswith(".") for part in p.relative_to(folder).parts)]
        out.append({"id": f"private-{i}", "private": True, "origin": "auto", "dir": str(folder),
                    "files": [{"name": p.name, "path": str(p), "role": classify(p.name)} for p in files]})
    return out


GERBER_KEYS = {"F_Cu": "GTL", "B_Cu": "GBL", "F_Mask": "GTS", "B_Mask": "GBS", "F_Paste": "GTP", "B_Paste": "GBP",
               "F_Silkscreen": "GTO", "B_Silkscreen": "GBO", "F_SilkS": "GTO", "B_SilkS": "GBO", "Edge_Cuts": "profile"}


def classify(name):
    """Role of a file in an unlabelled (private) project folder, from its name only."""
    low = name.lower()
    ext = Path(name).suffix.upper().lstrip(".")
    if low.endswith((".pcbdoc", ".schdoc", ".prjpcb", ".pcblib", ".schlib", ".kicad_pcb", ".kicad_sch", ".kicad_pro")):
        return "source"
    if re.fullmatch(r"G(TL|BL|TS|BS|TP|BP|TO|BO|\d+|P\d+)", ext):
        return "gerber:" + ext
    if ext in ("GKO", "GM1", "GM"):
        return "gerber:profile"
    m = re.search(r"-(In\d+_Cu|[FB]_(Cu|Mask|Paste|Silkscreen|SilkS)|Edge_Cuts)\.(gbr|g\w+)$", name)
    if m:
        key = m.group(1)
        inner = re.fullmatch(r"In(\d+)_Cu", key)
        return "gerber:" + ("G" + inner.group(1) if inner else GERBER_KEYS[key])
    if ext in ("DRL", "XLN") or (ext == "TXT" and re.search(r"drill|\.txt$", low) and "pick" not in low and "bom" not in low):
        return "drill"
    if re.search(r"pick.?place|-pos\.csv$|\.pos$|cpl", low):
        return "pnp"
    if re.search(r"bom|bill.of.materials", low) and ext in ("CSV", "XLSX"):
        return "bom"
    return "other"


def kicad_files(project, cache, offline):
    """Pinned KiCad project files, verified by SHA-256, under the shared fixture cache."""
    shaped = {"id": project["id"], "revision": project["revision"], "upstream": project["upstream"],
              "assets": [{"path": f["path"], "role": f["role"], "sha256": f["sha256"]} for f in project["files"]]}
    directory, resources = fetch.verified(shaped, cache, offline)
    return directory, resources


def request_for(project, cache, offline):
    if project.get("private"):
        return {"fixture": {"id": project["id"], "origin": "auto"}, "files": project["files"]}
    if project["translator"] == "altium":
        directory, resources = fetch.verified(project, cache, offline)
    else:
        directory, resources = kicad_files(project, cache, offline)
    files = [{"name": r["name"], "path": str(directory / r["name"]), "role": r["role"]} for r in resources]
    fixture = {k: project[k] for k in ("id", "name", "origin", "drillOrigin", "plotOffsetMm", "drillOffsetMm", "layerMap") if k in project}
    return {"fixture": fixture, "files": files, "translator": project["translator"]}


def run_one(node, request, mutation=None):
    with tempfile.TemporaryDirectory(prefix="waffle-e2e-") as tmp:
        out = Path(tmp) / "result.json"
        body = {**request, "root": str(ROOT), "out": str(out), "mutation": mutation}
        proc = subprocess.run([node, "--max-old-space-size=3072", str(HERE / "project.cjs")], input=json.dumps(body),
                              text=True, capture_output=True, timeout=900, env={**os.environ, "TZ": "UTC", "LC_ALL": "C"})
        if proc.returncode or not out.exists():
            tail = (proc.stderr or proc.stdout).strip().splitlines()[-3:]
            return {"id": request["fixture"]["id"], "crash": "\n".join(tail)[:600]}
        return json.loads(out.read_text())


def scrub(text, project):
    """Private projects: drop anything that could identify the board (paths, names, nets)."""
    return "(detail withheld for a private project)" if project.get("private") else text


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--cache", type=Path, default=fetch.DEFAULT_CACHE)
    parser.add_argument("--node", default=shutil.which("node"))
    parser.add_argument("--fetch", action="store_true", help="download missing pinned fixtures (default: offline)")
    parser.add_argument("--only", nargs="*", help="project IDs to run")
    parser.add_argument("--mutations", action="store_true", help="also prove each mutation turns the suite red")
    parser.add_argument("--json", type=Path, help="write the full results here")
    parser.add_argument("--write-modules", action="store_true")
    args = parser.parse_args()
    prepare_modules()
    if args.write_modules:
        return 0
    if not args.node:
        parser.error("Node.js 24 is required")
    known = json.loads((HERE / "known-failures.json").read_text())["failures"]
    projects = [p for p in corpus() + private_projects() if not args.only or p["id"] in args.only]
    status, results = 0, []
    for project in projects:
        t0 = time.monotonic()
        try:
            request = request_for(project, args.cache, offline=not args.fetch)
        except Exception as error:  # a missing fixture is a failure of the full tier, not a skip
            print(f"FAIL  {project['id']}: fixtures unavailable ({type(error).__name__}); run with --fetch")
            status = 1
            continue
        report = run_one(args.node, request)
        report["seconds"] = round(time.monotonic() - t0, 1)
        results.append(report)
        status |= summarise(report, known, project)
        if args.mutations and not project.get("private"):
            for mutation in json.loads((HERE / "mutations.json").read_text())["mutations"]:
                mutated = run_one(args.node, request, mutation)
                applied = mutated.get("mutationApplied")
                red = newly_red(report, mutated)
                if applied is None:
                    verdict = "FAIL: could not evaluate mutation"
                    status = 1
                elif applied and not red:
                    verdict = "STILL GREEN"
                    status = 1
                else:
                    verdict = "red" if red else "not applicable"
                print(f"      mutation {mutation:<20} {verdict}" + (f"  ({', '.join(red[:6])})" if red else ""))
                if mutated.get("crash"):
                    print("          " + mutated["crash"])
                results.append({"id": project["id"], "mutation": mutation, "applied": applied, "newFailures": red})
    if args.json:
        args.json.write_text(json.dumps([r for r in results if not str(r.get("id", "")).startswith("private-")], indent=1))
    return status


WORSE = ("xorMm2", "missing", "extra", "wrong", "wrongSize", "netMismatch", "changed", "rewritten", "missingMm2", "addedMm2")


def newly_red(clean, mutated):
    """Checks the mutation made red, or (already failing) measurably worse. Mirrors pipeline.cjs newlyRed."""
    before = {r["id"]: r for r in clean.get("results", [])}
    out = []
    for r in mutated.get("results", []):
        if not r["gating"] or r["pass"]:
            continue
        old = before.get(r["id"])
        if not old or old["pass"] or any(isinstance(r["metric"].get(k), (int, float)) and isinstance(old["metric"].get(k), (int, float))
                                         and r["metric"][k] > old["metric"][k] + (0.05 if k.endswith("Mm2") else 0) for k in WORSE):
            out.append(r["id"])
    return out


def summarise(report, known, project):
    pid = report["id"]
    if report.get("crash"):
        print(f"FAIL  {pid}: pipeline crashed: {scrub(report['crash'], project)}")
        return 1
    status = 0
    lines = []
    for r in report["results"]:
        k = next((k for k in known if k["project"] in (pid, "*") and k["check"] == r["id"]), None)
        if not r["gating"]:
            tag = "info"
        elif r["pass"] and k and k["project"] == pid:
            tag, status = "FIXED", 1
        elif r["pass"]:
            tag = "ok"
        elif k:
            tag = "known"
        else:
            tag, status = "FAIL", 1
        metric = json.dumps(r["metric"], ensure_ascii=False)
        lines.append(f"  {tag:<5} {r['id']:<28} {scrub(metric[:220], project) if tag != 'ok' else ''}")
        if tag in ("FAIL", "known") and r["detail"] and not project.get("private"):
            lines.extend("          " + d[:200] for d in r["detail"][:3])
        if tag == "known":
            lines.append("          known failure: " + k["bug"])
        if tag == "FIXED":
            lines.append("          now passes; remove it from tests/e2e/known-failures.json (" + k["bug"] + ")")
    timing = " ".join(f"{k}={v / 1000:.1f}s" for k, v in report.get("timings", {}).items())
    print(f"{'FAIL' if status else 'ok  '}  {pid} ({report['seconds']}s; {timing})")
    acc = report.get("accounting", {})
    if acc:
        total = {k: sum(v.get(k, 0) for v in acc.values()) for k in ("kept", "approximated", "dropped")}
        lossy = sorted((k for k, v in acc.items() if v.get("approximated") or v.get("dropped")), key=lambda k: -(acc[k]["approximated"] + acc[k]["dropped"]))
        most = ", ".join("%s %d/%d" % (k, acc[k]["approximated"], acc[k]["dropped"]) for k in lossy[:4])
        print(f"  translator: kept {total['kept']}, approximated {total['approximated']}, dropped {total['dropped']}"
              + ("" if project.get("private") or not most else f" (most approximated/dropped: {most})"))
    print("\n".join(lines))
    return status


if __name__ == "__main__":
    raise SystemExit(main())
