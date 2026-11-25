#!/usr/bin/env python3
"""Measure the development single-file project format on pinned public inputs and an optional temporary export."""
import argparse
from contextlib import nullcontext
import hashlib
import json
import os
import platform
import plistlib
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile

sys.dont_write_bytecode = True
HERE = Path(__file__).resolve().parent / "format-baseline"
sys.path.insert(0, str(HERE))
from sources import CASES, PUBLIC, ROOT, external, fidelity, prepare
from native import native_host, measure, summary_for
from receipts import write as write_receipts


def command(*args):
    return subprocess.check_output(args, cwd=ROOT, text=True, stderr=subprocess.STDOUT).strip()


def environment():
    runtime = {"checkout": command("git", "rev-parse", "HEAD"), "architecture": platform.machine(),
               "productTrees": {p: command("git", "rev-parse", "HEAD:" + p) for p in ("app", "native/macos", "native/bridge.js")},
               "node": command("node", "--version"), "git": command("git", "--version")}
    if platform.system() == "Darwin":
        with Path("/System/Library/Frameworks/WebKit.framework/Resources/Info.plist").open("rb") as f:
            version = plistlib.load(f)["CFBundleVersion"]
        runtime.update(macOS=platform.mac_ver()[0], osBuild=command("sw_vers", "-buildVersion"),
                       cpu=command("sysctl", "-n", "machdep.cpu.brand_string"), ramBytes=int(command("sysctl", "-n", "hw.memsize")),
                       webkit=version, swift=command("xcrun", "swiftc", "--version").splitlines()[0])
    return runtime


def git_measure(case, snapshot):
    flags = [] if case == "approved" else ["--public-input"]
    if case == "lily58":
        flags.append("--kicad-global-label")
    result = subprocess.run(["node", str(ROOT / "scripts/format-baseline-git.mjs"), *flags, case, str(snapshot)], capture_output=True)
    if result.returncode:
        raise RuntimeError(case + ": isolated Git replay failed.")
    return json.loads(result.stdout)


def retain(snapshot, summary, directory, case):
    target = directory / (case + ".waffle")
    metadata = directory / (case + ".input.json")
    if target.exists() or metadata.exists():
        raise ValueError("A retained snapshot already exists.")
    record = {key: summary[key] for key in ("sourceFiles", "sourceBytes", "revision") if key in summary}
    # This local receipt binds the exact scratch bytes. The private fingerprint stays out of the exported results.
    record["sha256"] = hashlib.sha256(snapshot.read_bytes()).hexdigest()
    with tempfile.NamedTemporaryFile(dir=directory) as stage:
        with snapshot.open("rb") as original:
            shutil.copyfileobj(original, stage)
        stage.flush()
        os.fchmod(stage.fileno(), 0o400)
        with metadata.open("x") as out:
            json.dump(record, out)
        os.link(stage.name, target)


def retained_metadata(snapshot):
    record_path = snapshot.with_suffix(".input.json")
    if not record_path.is_file() or record_path.is_symlink():
        raise ValueError("The retained snapshot has no preparation receipt.")
    record = json.loads(record_path.read_bytes())
    if record.get("sha256") != hashlib.sha256(snapshot.read_bytes()).hexdigest():
        raise ValueError("The retained file does not match its preparation receipt.")
    return {key: record[key] for key in ("sourceFiles", "sourceBytes", "revision") if key in record}


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--case", action="append", choices=CASES)
    ap.add_argument("--fidelity-cache", type=Path, default=fidelity.DEFAULT_CACHE)
    ap.add_argument("--history-cache", type=Path, default=Path.home() / ".cache/waffle/project-history")
    ap.add_argument("--approved-export", type=Path)
    ap.add_argument("--output", type=Path, required=True, help="New or existing external scratch directory for numeric results")
    ap.add_argument("--prepare-only", action="store_true")
    ap.add_argument("--snapshots", type=Path, help="Keep canonical input snapshots in this external temporary directory for a second benchmark")
    ap.add_argument("--read-snapshots", type=Path, help="Use previously prepared, immutable scratch snapshots")
    ap.add_argument("--repeats", type=int, default=3, help="Fresh processes per case and save policy (default 3)")
    ap.add_argument("--native-only", action="store_true", help="Skip the separate 100-commit Git replay")
    args = ap.parse_args()
    if args.repeats < 1 or args.prepare_only and not args.snapshots:
        ap.error("Choose positive repeats and a snapshots directory when only preparing inputs.")
    os.umask(0o077)
    names = args.case or [*PUBLIC, "synthetic", *(["approved"] if args.approved_export else [])]
    output = external(args.output)
    if args.approved_export:
        source = args.approved_export.expanduser().resolve()
        destinations = [output, *([external(args.snapshots)] if args.snapshots else [])]
        if any(path == source or path.is_relative_to(source) for path in destinations):
            ap.error("Choose an output and snapshots directory outside the read-only export.")
    output.mkdir(parents=True, exist_ok=True)
    (output / "runtime.json").write_text(json.dumps(environment(), indent=2) + "\n")
    if args.snapshots:
        args.snapshots = external(args.snapshots)
        if not args.snapshots.is_relative_to(Path(tempfile.gettempdir()).resolve()):
            ap.error("Choose a snapshots directory in temporary storage.")
        args.snapshots.mkdir(parents=True, exist_ok=True)
    if args.read_snapshots:
        args.read_snapshots = external(args.read_snapshots)
        if not args.read_snapshots.is_relative_to(Path(tempfile.gettempdir()).resolve()):
            ap.error("Retained snapshots must be in temporary storage.")
    host = nullcontext(None) if args.prepare_only else native_host()
    summaries = {}
    with host as executable:
        for case in names:
            with tempfile.TemporaryDirectory(prefix="waffle-format-case-") as raw:
                case_dir = Path(raw)
                if args.read_snapshots:
                    snapshot = args.read_snapshots / (case + ".waffle")
                    if snapshot.is_symlink() or not snapshot.is_file():
                        raise ValueError("An expected scratch snapshot is unavailable.")
                    summary = {**summary_for(snapshot), **retained_metadata(snapshot)}
                else:
                    summary = prepare(case, args, case_dir, subprocess.run)
                    snapshot = case_dir / "project.waffle"
                print(case, summary["documents"], "documents,", summary["bytes"], "bytes", flush=True)
                if args.snapshots:
                    retain(snapshot, summary, args.snapshots, case)
                if executable:
                    summary.update(measure(executable, snapshot, summary, case, args.repeats))
                    if not args.native_only:
                        summary["controlledGit"] = git_measure(case, snapshot)
                if case != "approved":
                    summary["snapshotSHA256"] = hashlib.sha256(snapshot.read_bytes()).hexdigest()
                (output / (case + ".json")).write_text(json.dumps(summary, indent=2) + "\n")
                summaries[case] = summary
                print(case, "verified", flush=True)
    write_receipts(output, summaries)


if __name__ == "__main__":
    main()
