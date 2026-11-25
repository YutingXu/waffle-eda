#!/usr/bin/env python3
"""Opt-in macOS Wine checks."""
import argparse
import os
from pathlib import Path, PureWindowsPath
import shutil
import subprocess
import sys
import tempfile
import time


HERE = Path(__file__).resolve().parent
FIXTURE = HERE.parent / "fixtures/altium/pidp11-io-expander/PiDP11IOExpander.PcbDoc"


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("check", choices=("graphics", "editor", "board"))
    parser.add_argument("--wine", default=os.environ.get("WINE", "wine"),
                        help="Wine executable (default: $WINE or wine on PATH)")
    parser.add_argument("--prefix", default=os.environ.get("WINEPREFIX"), type=Path,
                        help="initialized test prefix (default: $WINEPREFIX)")
    parser.add_argument("--x2", type=Path, help="Mac path to the installed X2.EXE in this prefix")
    parser.add_argument("--board", type=Path, default=FIXTURE,
                        help="PiDP-11 board or an Atrium export of the same board")
    parser.add_argument("--dxvk", type=Path,
                        help="graphics check only: directory with the two x64 DXVK-macOS DLLs")
    parser.add_argument("--timeout", type=int, default=120, help="total time limit in seconds")
    args = parser.parse_args()
    if args.timeout < 1:
        parser.error("--timeout must be positive")
    if args.dxvk and args.check != "graphics":
        parser.error("--dxvk applies to the graphics probe. Configure Designer's renderer at installation.")
    wine = shutil.which(os.path.expanduser(args.wine))
    if not wine:
        parser.error("Wine executable missing. Set WINE or pass --wine.")
    if not args.prefix:
        parser.error("Set WINEPREFIX or pass --prefix for the dedicated Altium installation.")
    prefix = args.prefix.expanduser().resolve()
    drive = prefix / "drive_c"
    if not drive.is_dir() or not (prefix / "system.reg").is_file():
        parser.error(f"Initialize the Wine prefix first: {prefix}")
    if args.check != "graphics":
        if args.x2:
            x2 = args.x2.expanduser().resolve()
        else:
            matches = [p for p in (drive / "Program Files/Altium").glob("*/*")
                       if p.name.lower() == "x2.exe" and p.is_file()]
            if len(matches) != 1:
                parser.error(f"Found {len(matches)} Altium installations under Program Files/Altium. "
                             "Install Designer in this prefix or select its executable with --x2.")
            x2 = matches[0]
        if not x2.is_file() or x2.name.lower() != "x2.exe" or drive not in x2.parents:
            parser.error("--x2 must point to an installed X2.EXE inside the selected drive_c")
        if args.check == "board" and not args.board.is_file():
            parser.error(f"Board file missing: {args.board}")

    stage = Path(tempfile.mkdtemp(prefix="AtriumSmoke-", dir=drive))
    guest = PureWindowsPath("C:/") / stage.name
    env = dict(os.environ, WINEPREFIX=str(prefix))
    env.setdefault("WINEDEBUG", "-all")
    deadline = time.monotonic() + args.timeout

    def run(*argv, output=None, cleanup_time=0):
        subprocess.run([wine, *map(str, argv)], env=env, cwd=stage, check=True,
                       stdin=subprocess.DEVNULL, stdout=output, stderr=subprocess.STDOUT,
                       timeout=max(0, deadline - time.monotonic()) + cleanup_time)

    def compile_probe(name, output=None):
        shutil.copyfile(HERE / f"{name}.cs", stage / f"{name}.cs")
        run(r"C:\windows\Microsoft.NET\Framework64\v4.0.30319\csc.exe",
            "/nologo", "/platform:x64", f"/out:{name}.exe", f"{name}.cs", output=output)

    try:
        if args.check == "graphics":
            compile_probe("Graphics")
            if args.dxvk:
                for name in ("d3d11.dll", "d3d10core.dll"):
                    shutil.copyfile(args.dxvk / name, stage / name)
                existing = env.get("WINEDLLOVERRIDES", "")
                env["WINEDLLOVERRIDES"] = (existing + ";" if existing else "") + "d3d11,d3d10core=n,b"
            run(guest / "Graphics.exe")
        else:
            if args.check == "board":
                shutil.copyfile(args.board, stage / "Board.PcbDoc")
                procedure = "ReadFixture"
                expected = ["components=23", "vias=59"]
                success = f"Designer read {args.board.name}: 23 components, 59 vias"
            else:
                procedure = "CheckEditor"
                expected = ["scripting=ready", "pcb=installed"]
                success = "Designer ran a script and found the installed PCB editor"
            script = (HERE / "ReadBoard.pas").read_text(encoding="ascii")
            (stage / "ReadBoard.pas").write_bytes(
                script.replace("@RUN_DIRECTORY@", str(guest)).replace("\n", "\r\n").encode("ascii"))
            command = f"-RScriptingSystem:RunScriptFile(FileName={guest / 'ReadBoard.pas'}|ProcName={procedure})"
            guest_x2 = PureWindowsPath("C:/") / x2.relative_to(drive)
            log_path = stage / "wine.log"
            try:
                with log_path.open("wb") as log:
                    compile_probe("RunDesigner", output=log)
                    remaining = int((deadline - time.monotonic()) * 1000)
                    if remaining <= 0:
                        raise TimeoutError("Time expired before the Designer check could start.")
                    run(guest / "RunDesigner.exe", guest_x2, command, guest / "result.txt",
                        remaining, output=log, cleanup_time=5)
            except subprocess.CalledProcessError:
                for line in log_path.read_text(errors="replace").splitlines():
                    if line.startswith("Altium check: "):
                        raise ValueError(line) from None
                raise
            result = stage / "result.txt"
            data = result.read_bytes()
            encoding = "utf-16" if data.startswith((b"\xff\xfe", b"\xfe\xff")) else "utf-8-sig"
            lines = data.decode(encoding).splitlines()
            if lines != expected:
                raise ValueError(f"Designer returned {lines!r}, expected {expected!r}")
            print(f"PASS {success}")
    except (OSError, ValueError, subprocess.SubprocessError) as error:
        print(f"FAIL {error}\nRun files: {stage}", file=sys.stderr)
        return 1
    shutil.rmtree(stage)
    return 0


if __name__ == "__main__":
    sys.exit(main())
