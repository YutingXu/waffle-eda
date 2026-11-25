#!/usr/bin/env python3
"""Run the signed WKWebView 3D responsiveness suite on prepared Format 2 project folders."""
import argparse
import base64
from collections import Counter
import hashlib
import json
import os
from pathlib import Path
import platform
import plistlib
import re
import shutil
import subprocess
import sys
import tempfile

sys.dont_write_bytecode = True
HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE / "format-baseline"))
from native import native_host
from sources import KICAD, PUBLIC, ROOT, external, fidelity

DRIVER = HERE / "view3d-macos"
CONTROLS = {
    "no-motion": ('cam = drag.mode === "pan" ? pan(cam, dx, dy, size()[1]) : orbit(cam, dx, dy); invalidate();',
                  'cam = drag.mode === "pan" ? pan(cam, dx, dy, size()[1]) : cam; invalidate();',
                  "CONTROL_ORBIT_DID_NOT_MOVE"),
    "idle-redraw": ("if (anim || fold.anim) requestFrame();", "invalidate();",
                    "CONTROL_IDLE_KEPT_DRAWING"),
}


def git(root, *args):
    return subprocess.check_output(["git", *args], cwd=root, text=True).strip()


UUID = r"[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}"


def runtime_lock(relative, data, manifest):
    if relative == ".waffle/journal/lock":
        return data == b""
    match = re.fullmatch(re.escape(manifest) + r"\.([ds])-(" + UUID + r")\.waffle-lock", relative)
    if not match or len(data) > 65536:
        return False
    try:
        row = json.loads(data)
        lock = row["data"]
        if (row["atrium-lock"] != 1 or not isinstance(row["pid"], int) or row["pid"] <= 0 or
                not isinstance(row["written"], int) or row["written"] <= 0 or
                not re.fullmatch(UUID, row["machine"]) or not re.fullmatch(UUID, row["session"])):
            return False
        return (lock["kind"] == "edit" and lock["doc"] == match[2] if match[1] == "d" else
                lock["kind"] == "presence" and row["session"] == match[2])
    except (KeyError, TypeError, ValueError):
        return False


def inventory(folder, *, runtime_manifest=None):
    members = {}
    for file in sorted(folder.rglob("*")):
        if file.is_symlink():
            raise ValueError("A prepared project must contain regular files, with no symlinks.")
        if file.is_file():
            relative = file.relative_to(folder).as_posix()
            if relative.startswith(".waffle/local/"):
                continue
            data = file.read_bytes()
            if runtime_manifest and runtime_lock(relative, data, runtime_manifest):
                continue
            members[relative] = {"sha256": hashlib.sha256(data).hexdigest(), "bytes": len(data)}
    return members

def fixture(case, prepared):
    folder = prepared / case / "design"
    options = json.loads((folder.parent / "options.json").read_text())
    manifest = options["manifest"]
    if Path(manifest).name != manifest or Path(manifest).suffix != ".waffle" or not (folder / manifest).is_file():
        raise ValueError("A prepared project lacks its Format 2 manifest.")
    members = inventory(folder)
    ledger = hashlib.sha256(json.dumps(members, sort_keys=True, separators=(",", ":")).encode()).hexdigest()
    if ledger != options["memberLedgerSHA256"]:
        raise ValueError("A prepared project differs from its recorded inventory.")
    receipt = json.loads((prepared / "receipts.json").read_text())[case]
    if not receipt["nativeFolderVerified"] or receipt["memberCount"] != len(members):
        raise ValueError("Run the Format 2 read-only preparation first.")
    if case == "approved":
        return folder, manifest, {}
    source_pin = KICAD[case][1] if case in KICAD else next(row["revision"] for row in fidelity.manifest() if row["id"] == case)
    if ledger != receipt["memberLedgerSHA256"] or source_pin != receipt["sourceRevision"]:
        raise ValueError("The public project differs from its pinned preparation receipt.")
    return folder, manifest, {"sourceRevision": receipt["sourceRevision"], "memberLedgerSha256": ledger}


def foreign_files(case, prepared, folder):
    guard = json.loads((prepared / "originals.local.json").read_text())[case]
    sources = {}
    for name, expected in guard["members"].items():
        if Path(name).name != name or name in ("", ".", "..") or len(expected) != 64 or any(c not in "0123456789abcdef" for c in expected):
            raise ValueError("Invalid retained foreign input.")
        source = folder / ".waffle" / "imports" / expected / "source"
        data = source.read_bytes()
        if hashlib.sha256(data).hexdigest() != expected:
            raise ValueError("The retained foreign input differs from the preparation receipt.")
        sources[name] = data
    return sources


class TrialStageError(RuntimeError):
    def __init__(self, message, aggregate=None):
        super().__init__(message)
        self.aggregate = aggregate


def trial(exe, args, fixture_info, private, capture=False, sources=None):
    folder, manifest, _ = fixture_info
    with tempfile.TemporaryDirectory(prefix="waffle-viewer-responsive-") as scratch:
        work = Path(scratch)
        options = {"steps": args.steps, "displayID": args.display_id, "inputHz": args.input_hz, "capture": capture, "foreground": args.foreground, "private": private}
        design = work / ("foreign" if sources else "design")
        if sources:
            design.mkdir()
            for name, data in sources.items():
                (design / name).write_bytes(data)
            options["foreignFiles"] = sorted(sources, key=lambda s: (Path(s).suffix.lower() not in (".prjpcb", ".kicad_pro"), s))
        else:
            shutil.copytree(folder, design, ignore=lambda directory, _: ["local"] if Path(directory).name == ".waffle" else [])
            options["manifest"] = manifest
        before = inventory(design)
        if not sources and before != inventory(folder):
            raise TrialStageError("The fixture changed while making the trial copy.")
        (work / "trial.json").write_text(json.dumps(options))
        env = {**os.environ, "WAFFLE_VIEW3D_STORE": "ephemeral", "WAFFLE_FORMAT_PRIVATE": str(int(private))}
        result = subprocess.run([str(exe), str(work)], capture_output=True, timeout=145, env=env)
        if inventory(design, runtime_manifest=manifest if not sources else None) != before:
            raise TrialStageError("The 3D workload changed its read-only input.")
        if args.control:
            if result.returncode == 0 or CONTROLS[args.control][2] not in result.stderr.decode(errors="replace"):
                raise RuntimeError("The negative control did not fail for the expected reason. " + result.stderr.decode(errors="replace")[-2000:])
            return {"expectedFailure": CONTROLS[args.control][2]}
        if result.returncode or not result.stdout.strip():
            error = "" if private else result.stderr.decode(errors="replace")[-2500:]
            raise RuntimeError("The signed native measurement failed. " + error)
        row = json.loads(result.stdout.decode().splitlines()[-1])
        if private and "failureStage" in row:
            stage = row["failureStage"]
            if isinstance(stage, str) and re.fullmatch(r"[a-z0-9-]{1,40}", stage):
                raise TrialStageError("Approved native trial stopped during " + stage + ".", row.get("aggregate"))
            raise RuntimeError("Unrecognized native trial result.")
        return row


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--prepared", required=True, type=Path, help="Read-only output of scripts/format-2-qa/reimport.py")
    parser.add_argument("--output", required=True, type=Path, help="External scratch directory for numeric receipts")
    parser.add_argument("--product-checkout", default=ROOT, type=Path, help="Clean product checkout with prepared runtime assets")
    parser.add_argument("--case", choices=[*PUBLIC, "approved"], action="append")
    parser.add_argument("--repeats", type=int, default=3)
    parser.add_argument("--steps", type=int, default=90, help="AppKit events per drag")
    parser.add_argument("--input-hz", type=int, default=120)
    parser.add_argument("--foreground", action="store_true", help="Make the private harness window active for the trial")
    parser.add_argument("--display-id", type=int, help="Center the signed harness on a specific public CoreGraphics display ID")
    parser.add_argument("--open", choices=("folder", "source"), default="folder",
                        help="Open a saved Format 2 folder or its pinned original source files through native File Open")
    parser.add_argument("--control", choices=CONTROLS)
    parser.add_argument("--capture", action="store_true", help="Capture public canvas images after timing in the first trial per public case")
    args = parser.parse_args()
    cases = args.case or (["pidp11-io-expander"] if args.control else ["pidp11-io-expander", "snes-tap"])
    if not 1 <= args.repeats <= 20 or not 24 <= args.steps <= 600 or not 30 <= args.input_hz <= 240:
        parser.error("Choose 1–20 repetitions, 24–600 steps and 30–240 input Hz.")
    if args.control and ("approved" in cases or len(cases) != 1 or args.repeats != 1 or args.capture):
        parser.error("Run a negative control with one public case and --repeats 1.")
    temporary_roots = {Path(tempfile.gettempdir()).resolve(), Path("/tmp").resolve()}
    if "approved" in cases and not any(root in args.prepared.resolve().parents for root in temporary_roots):
        parser.error("Keep the already approved project's prepared copy in temporary storage.")
    os.umask(0o077)
    output, prepared, product = external(args.output), external(args.prepared), args.product_checkout.resolve()
    if output == prepared or output.is_relative_to(prepared):
        parser.error("Choose an output directory outside the prepared project inputs.")
    if git(product, "status", "--porcelain", "--", "app", "native"):
        parser.error("Use committed product sources for a hardware receipt.")
    stamp = {key: git(product, "rev-parse", ref) for key, ref in
             (("commit", "HEAD"), ("tree", "HEAD^{tree}"), ("appTree", "HEAD:app"), ("nativeTree", "HEAD:native"))}
    fixtures, sources = {}, {}
    for case in cases:
        try:
            fixtures[case] = fixture(case, prepared)
            if args.open == "source":
                sources[case] = foreign_files(case, prepared, fixtures[case][0])
        except (OSError, ValueError, KeyError):
            if case == "approved":
                raise RuntimeError("The temporary approved project did not pass its preparation check.") from None
            raise
    output.mkdir(parents=True, exist_ok=True)
    with Path("/System/Library/Frameworks/WebKit.framework/Resources/Info.plist").open("rb") as info:
        webkit = plistlib.load(info)["CFBundleVersion"]
    with native_host(probe_file=DRIVER / "responsive.js", input_driver=DRIVER / "input.swift", product_root=product,
                     visible_window=True) as exe:
        if args.control:
            anchor, mutant, _ = CONTROLS[args.control]
            module = Path("app/canvas/view3d.js")
            if not (product / module).is_file():
                module = Path("app/view3d.js")  # Pre-restructure comparison checkout.
            path = exe.parents[1] / "Resources" / module
            source = path.read_text()
            if source.count(anchor) != 1:
                raise RuntimeError("The negative-control anchor is no longer unique.")
            path.write_text(source.replace(anchor, mutant))
            subprocess.run(["codesign", "--force", "--sign", "-", str(exe.parents[2])], check=True, capture_output=True)
        subprocess.run(["codesign", "--verify", "--strict", str(exe.parents[2])], check=True, capture_output=True)
        runs = {case: [] for case in cases}
        failures = []
        for repeat in range(args.repeats):
            # Alternate order so a design does not always run first.
            for case in list(reversed(cases)) if repeat % 2 else cases:
                try:
                    row = trial(exe, args, fixtures[case], case == "approved",
                                capture=args.capture and repeat == 0 and case != "approved", sources=sources.get(case))
                    for pose, url in row.pop("images", {}).items():
                        if case == "approved" or pose not in ("oblique", "inspection") or not url.startswith("data:image/png;base64,"):
                            raise RuntimeError("Unexpected canvas image.")
                        (output / f"{case}-{pose}.png").write_bytes(base64.b64decode(url.split(",", 1)[1], validate=True))
                except (RuntimeError, subprocess.TimeoutExpired) as error:
                    failure = ("The signed native measurement did not finish."
                               if case == "approved" and not isinstance(error, TrialStageError) else str(error))
                    aggregate = error.aggregate if isinstance(error, TrialStageError) else None
                    failures.append((case, repeat + 1, failure, aggregate))
                    mode = "-" + args.control if args.control else ""
                    (output / (case + mode + "-failure.json")).write_text(json.dumps({
                        "case": case, "product": stamp, "open": args.open, "control": args.control, "failures": [
                            {"repeat": number, "message": message, **({"aggregate": aggregate} if aggregate else {})}
                            for case_id, number, message, aggregate in failures if case_id == case]
                    }, indent=2) + "\n")
                    print(case, repeat + 1, failure, file=sys.stderr, flush=True)
                    continue
                runs[case].append({"repeat": repeat + 1, **row})
                print(case, repeat + 1, "verified", flush=True)
                mode = "-" + args.control if args.control else ""
                receipt = {"case": case, "product": stamp, "macOS": platform.mac_ver()[0],
                           "macOSBuild": subprocess.check_output(["sw_vers", "-buildVersion"], text=True).strip(),
                           "signed": "ad-hoc", "open": args.open, "foreground": args.foreground, "webkit": webkit, "architecture": platform.machine(), "inputHz": args.input_hz, "steps": args.steps, "control": args.control,
                           **fixtures[case][2], "runs": runs[case]}
                (output / (case + mode + ".json")).write_text(json.dumps(receipt, indent=2) + "\n")
        if failures:
            raise SystemExit("Failed trials by case: " + str(dict(Counter(case for case, _, _, _ in failures))))


if __name__ == "__main__":
    main()
