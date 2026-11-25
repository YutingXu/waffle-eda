#!/usr/bin/env python3
"""Exercise a saved real PCB using the signed native UI harness and a disposable folder copy."""
from argparse import ArgumentParser
from hashlib import sha256
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
from tempfile import TemporaryDirectory

HERE = Path(__file__).resolve().parent
PREFIX = "NOTE  probe summary: BOARD_FEEL "


def digest(path):
    with path.open("rb") as handle:
        return sha256(handle.read()).hexdigest()


def fingerprint(folder):
    return {p.relative_to(folder): digest(p) for p in folder.rglob("*") if p.is_file()}


def main():
    parser = ArgumentParser(description=__doc__)
    parser.add_argument("bundle", type=Path, help="Signed WaffleHarness.app")
    parser.add_argument("manifest", type=Path, help="Saved format 2.0 project manifest")
    parser.add_argument("--display", required=True, type=int, help="CoreGraphics display ID")
    parser.add_argument("--hz", required=True, type=int, help="Expected active display refresh rate")
    parser.add_argument("--repetitions", type=int, default=1, choices=range(1, 11))
    parser.add_argument("--private", action="store_true", help="Silence native diagnostics and disable window sharing")
    parser.add_argument("--shot", type=Path, help="Write a public board image after all timings")
    parser.add_argument("--drag-diagnostic", action="store_true", help="Capture redacted pointer state and committed move information")
    parser.add_argument("--legacy-drag", action="store_true", help="Compare the original single-call press and drag")
    parser.add_argument("--edit-only", action="store_true", help="Run the warm-open and trusted edit correctness lane")
    args = parser.parse_args()
    if args.edit_only and args.shot:
        parser.error("The snapshot requires the camera workflow")
    if args.private and args.shot:
        parser.error("Snapshots are available for public inputs only")
    bundle = args.bundle.resolve(strict=True)
    manifest = args.manifest.resolve(strict=True)
    source = manifest.parent
    if manifest.suffix != ".waffle" or any(p.is_symlink() for p in source.rglob("*")):
        parser.error("The manifest must be a saved project in a self-contained folder without symlinks")
    executable = bundle / "Contents/MacOS/Waffle"
    subprocess.run(["/usr/bin/codesign", "--verify", "--strict", str(bundle)], check=True, capture_output=True)
    initial = fingerprint(source)
    with TemporaryDirectory(prefix="waffle-real-board-feel-") as directory:
        work = Path(directory).resolve()
        copy = work / "input"
        shutil.copytree(source, copy, ignore=shutil.ignore_patterns(".git"))
        initial_copy = fingerprint(copy)
        if initial_copy != {path: value for path, value in initial.items() if ".git" not in path.parts}:
            raise SystemExit("Scratch project copy changed bytes")
        env = {key: value for key, value in os.environ.items() if not key.startswith("HARNESS_")}
        env.update(HARNESS_SUITE="ui", HARNESS_EPHEMERAL="1", HARNESS_INPUT_STDIN="1",
                   HARNESS_EARLY_PROBE=str(HERE / "pan-early.js"),
                   HARNESS_PROBES=":".join(str(HERE / path) for path in ("native-feel.js", "real-board-feel.js")),
                   HARNESS_WORK=str(work / "run"), HARNESS_OPEN_PROJECT=str(copy / manifest.name),
                   NATIVE_FEEL_DISPLAY_ID=str(args.display), WHEEL_TEST_DISPLAY=str(args.display))
        try:
            run = subprocess.run(["/usr/bin/caffeinate", "-d", str(executable)], env=env, capture_output=True,
                                 input=json.dumps({"private": args.private, "repetitions": args.repetitions,
                                                   "display": args.display, "hz": args.hz,
                                                   "shot": bool(args.shot), "dragDiagnostic": args.drag_diagnostic,
                                                   "legacyDrag": args.legacy_drag, "editOnly": args.edit_only}),
                                 text=True, timeout=30 * args.repetitions)
        except subprocess.TimeoutExpired:
            raise SystemExit("Native real-board probe timed out") from None
        unchanged = fingerprint(source) == initial
        if not unchanged:
            raise SystemExit("Native workload source folder changed")
        line = next((row.removeprefix(PREFIX) for row in run.stdout.splitlines() if row.startswith(PREFIX)), None)
        if run.returncode or not line or "RESULT ok" not in run.stdout:
            # The probe's own allowlisted failure labels contain no design-derived data.
            if args.private:
                marker = "JSERROR BOARD_FEEL: "
                diagnostic = next((row.split(marker, 1)[1] for row in run.stdout.splitlines()
                                   if row.startswith("FAIL  probe script ran to the end") and marker in row),
                                  "Native real-board probe failed")
                raise SystemExit(diagnostic)
            print(run.stdout, run.stderr, file=sys.stderr)
            return 1
        result = json.loads(line)
        result["executableSHA256"] = digest(executable)
        result["originalFolderFilesUnchanged"] = unchanged
        result["scratchFolderSavedFilesUnchanged"] = all(
            (copy / path).is_file() and digest(copy / path) == before for path, before in initial_copy.items()
        )
        if not result["scratchFolderSavedFilesUnchanged"]:
            raise SystemExit("The native editor changed saved input bytes in the scratch copy")
        if args.shot:
            shutil.copyfile(work / "run/shots/board-zoom.png", args.shot)
        print(json.dumps(result, indent=2))
    return int(result.get("restored") is False)


if __name__ == "__main__":
    sys.exit(main())
