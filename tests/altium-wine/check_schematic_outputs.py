#!/usr/bin/env python3
"""Read generated schematic outputs with the already-open macOS Wine Designer.

Each directory under --inputs is one small synthetic project (or single sheet)
with its generated PNGs. All opens, compilation and bitmap extractions use
throwaway copies. Pass a verified macOS Designer window id to capture its sheets.
"""
import argparse
from contextlib import nullcontext
import hashlib
import json
import os
from pathlib import Path, PureWindowsPath
import shutil
import subprocess
import sys
import tempfile
import time

from compare_schematic_outputs import compare

HERE = Path(__file__).resolve().parent
SUFFIXES = {".prjpcb", ".schdoc", ".png"}
CASES = ("clip", "ink", "frames", "rich", "rc", "rc-changed", "clip-alt", "ink-alt")


def pascal_string(value):
    return "'" + str(value).replace("'", "''") + "'"


def decoded(path):
    raw = path.read_bytes()
    return raw.decode("utf-16" if raw.startswith((b"\xff\xfe", b"\xfe\xff")) else "utf-8-sig", errors="replace")


def stage_inputs(source, scratch, screenshots):
    calls, manifest, captures = [], {}, []
    for case in CASES:
        origin = source / case
        if not origin.is_dir():
            raise SystemExit(f"Missing generated case directory {case}")
        files = sorted(p for p in origin.iterdir() if p.is_file() and p.suffix.lower() in SUFFIXES)
        projects = [p for p in files if p.suffix.lower() == ".prjpcb"]
        sheets = [p for p in files if p.suffix.lower() == ".schdoc"]
        if not sheets or len(projects) > 1 or any(p.is_symlink() for p in files):
            raise SystemExit(f"Expected schematic files and at most one generated project in {case}")
        (scratch / case).mkdir()
        manifest[case] = {}
        for file in files:
            copy = scratch / case / file.name
            shutil.copyfile(file, copy)
            manifest[case][file.name] = hashlib.sha256(copy.read_bytes()).hexdigest()
        relative = lambda path: str(PureWindowsPath(case, path.name))
        project = relative(projects[0]) if projects else ""
        calls.append(f"StartGroup({pascal_string(case)}, {pascal_string(project)});")
        for index, sheet in enumerate(sheets, start=1):
            name = f"{case}-{index}" if screenshots else ""
            if name:
                captures.append(name)
            calls.append(f"ReadSheet({pascal_string(relative(sheet))}, {pascal_string(name)});")
        calls.append("EndGroup;")
    (scratch / "input-sha256.json").write_text(json.dumps(manifest, indent=2) + "\n")
    return "\n".join(calls), captures


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--inputs", type=Path, default=HERE.parent / "fixtures/altium/notebook-outputs")
    parser.add_argument("--out", type=Path, required=True)
    parser.add_argument("--window-id", type=int)
    parser.add_argument("--runner", type=Path, help="existing build of tests/altium-wine/RunDesigner.cs; default compiles a private copy")
    parser.add_argument("--activity-module-dir", type=Path, default=HERE.parents[1] / "scripts/altium-macos")
    args = parser.parse_args()
    args.out.mkdir(parents=True, exist_ok=True)
    stage = Path(tempfile.mkdtemp(dir=args.out.resolve(), prefix="run-"))
    guest = PureWindowsPath("Z:/", *stage.parts[1:])
    calls, captures = stage_inputs(args.inputs, stage, args.window_id is not None)
    pascal = (HERE / "ReadSchematicOutputs.pas").read_text("ascii")
    pascal = pascal.replace("@DIR@", str(guest).replace("'", "''")).replace("@CASES@", calls)
    script_name = "ReadSchematicOutputs.pas"
    (stage / script_name).write_bytes(pascal.replace("\n", "\r\n").encode("ascii"))
    kit = Path(os.getenv("ALTIUM_WINE_ROOT", Path.home() / "AltiumWineLab/kit-11.16"))
    prefix = kit / "volume/prefix"
    wine = kit / "wine-patched/Wine Staging.app/Contents/Resources/wine/bin/wine"
    x2 = PureWindowsPath("C:/Program Files/Altium/AD26/X2.EXE")
    if not all(path.is_file() for path in (wine, prefix / "drive_c" / Path(*x2.parts[1:]))):
        raise SystemExit("Configured Designer installation is unavailable")
    runner = args.runner
    env = dict(os.environ, WINEPREFIX=str(prefix), WINEDEBUG="-all")
    if runner is None:
        runner = stage / "RunDesigner.exe"
        shutil.copyfile(HERE / "RunDesigner.cs", stage / "RunDesigner.cs")
        compiler = r"C:\windows\Microsoft.NET\Framework64\v4.0.30319\csc.exe"
        with (stage / "compiler.log").open("wb") as log:
            subprocess.run([wine, compiler, "/nologo", "/platform:x64", "/out:RunDesigner.exe", "RunDesigner.cs"],
                           cwd=stage, env=env, stdin=subprocess.DEVNULL, stdout=log, stderr=subprocess.STDOUT, check=True, timeout=30)
    if not runner.is_file():
        raise SystemExit("Private Designer launcher is unavailable")
    lease = nullcontext()
    if (args.activity_module_dir / "designer_activity.py").is_file():
        sys.path.insert(0, str(args.activity_module_dir))
        from designer_activity import designer_activity
        lease = designer_activity(prefix)
    command = f"-RScriptingSystem:RunScriptFile(FileName={guest / script_name}|ProcName=InspectOutputs)"
    print(stage, flush=True)
    with lease, (stage / "runner.log").open("wb") as log:
        process = subprocess.Popen([wine, runner, str(x2), command, str(guest / "result.txt"), "75000", "--existing"],
                                   stdout=log, stderr=subprocess.STDOUT, stdin=subprocess.DEVNULL, cwd=prefix / "drive_c", env=env)
        remaining = set(captures)
        while process.poll() is None:
            for name in tuple(remaining):
                if (stage / (name + ".ready")).is_file():
                    time.sleep(0.45)
                    capture = subprocess.run(["/usr/sbin/screencapture", "-x", "-a", "-r", "-o", "-l",
                                              str(args.window_id), str(stage / (name + ".raw.png"))],
                                             capture_output=True)
                    print(f"{name} capture exit {capture.returncode}", flush=True)
                    (stage / (name + ".captured")).touch()
                    remaining.remove(name)
            time.sleep(0.08)
    report = stage / "result.txt"
    if report.is_file():
        lines = decoded(report).splitlines()
        comparison = compare(stage, lines)
        (stage / "comparison.json").write_text(json.dumps(comparison, indent=2, ensure_ascii=False) + "\n")
        failures = comparison["failedChecks"]
        print(f"{len(lines)} native rows, {len(failures)} comparison failures", flush=True)
        return process.returncode or bool(failures)
    print(decoded(stage / "runner.log").strip()[:400], flush=True)
    return process.returncode or 1


if __name__ == "__main__":
    sys.exit(main())
