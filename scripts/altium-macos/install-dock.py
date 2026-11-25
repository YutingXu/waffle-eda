#!/usr/bin/env python3
"""Install the Altium Dock app for an Apple silicon Mac with a configured altium-wine kit."""
import argparse
import hashlib
import os
from pathlib import Path
import plistlib
import re
import shlex
import shutil
import subprocess
import tempfile

HERE = Path(__file__).resolve().parent
LSREGISTER = "/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister"


def run(*args, **kwargs):
    return subprocess.run(args, check=True, **kwargs)


def package_intel_loader(stock, target, info):
    # A command-line Wine process also advertises the bundle identity embedded
    # in its executable. Keep the kit's special virtual-memory segments intact.
    layout = run("/usr/bin/otool", "-l", stock, capture_output=True, text=True).stdout
    section = re.search(r"sectname __info_plist\s+segname __TEXT\s+addr \S+\s+size (0x[0-9a-f]+)\s+offset (\d+)", layout)
    if not section:
        raise ValueError("The x86_64 Wine loader has no embedded application metadata.")
    length, offset = int(section[1], 16), int(section[2])
    data = bytearray(stock.read_bytes())
    embedded = plistlib.loads(data[offset:offset+length].rstrip(b"\0"))
    if embedded.get("CFBundleIdentifier") != "org.winehq.wine":
        raise ValueError("Unexpected application identity in the kit's original Wine loader.")
    for key in ("CFBundleIdentifier", "CFBundleName", "CFBundleIconFile"):
        embedded[key] = info[key]
    contents = re.sub(rb">\s+<", b"><", plistlib.dumps(embedded))
    if len(contents) > length:
        raise ValueError("Altium's embedded identity exceeds the original Wine metadata section.")
    assert plistlib.loads(contents) == embedded
    data[offset:offset+length] = contents.ljust(length, b" ")
    target.write_bytes(data)
    shutil.copymode(stock, target)


def build(work, destination, kit_launcher, runtime, wine_dir, stock, drive):
    app = work / destination.name
    contents = app / "Contents"
    binaries = contents / "MacOS"
    binaries.mkdir(parents=True)
    resources = contents / "Resources"
    shutil.copytree(runtime / "Contents/Resources", resources)
    info = plistlib.loads((runtime / "Contents/Info.plist").read_bytes())
    info.update(CFBundleExecutable="wine", CFBundleIconFile="AppIcon.icns", LSMinimumSystemVersion="13.0",
                NSHighResolutionCapable=True, AltiumKitLauncher=str(kit_launcher),
                AltiumWineLibrary=str(wine_dir / "ntdll.so"),
                AltiumFileOpener=str(destination.with_name("Open in Altium.app")),
                AltiumOpenNotification="local.atrium.altium.open." + hashlib.sha256(os.fsencode(drive.parent)).hexdigest()[:16])
    (contents / "Info.plist").write_bytes(plistlib.dumps(info))

    cache = work / "modules"
    iconset = work / "AppIcon.iconset"
    iconset.mkdir()
    run("/usr/bin/xcrun", "swiftc", "-O", "-module-cache-path", cache,
        HERE / "IconCanvas.swift", "-o", work / "compose-icon")
    run(work / "compose-icon", kit_launcher / "Contents/Resources/AppIcon.icns", iconset)
    run("/usr/bin/iconutil", "-c", "icns", iconset, "-o", resources / "AppIcon.icns")

    run("/usr/bin/xcrun", "swiftc", "-O", "-target", "arm64-apple-macos13.0", "-module-cache-path", cache,
        HERE / "DockLauncher.swift", "-o", work / "arm-launcher")
    intel = work / "intel-runtime"
    package_intel_loader(stock, intel, info)
    run("/usr/bin/lipo", "-create", work / "arm-launcher", intel, "-output", binaries / "wine")
    adapter = binaries / "ntdll.so"
    run("/usr/bin/xcrun", "clang", "-arch", "x86_64", "-dynamiclib", "-fobjc-arc", "-fblocks",
        "-framework", "AppKit", "-Wl,-install_name,@loader_path/ntdll.so",
        HERE / "WineApp.m", HERE / "DesignerFilePanel.m", "-o", adapter)
    run("/usr/bin/codesign", "--force", "--sign", "-", adapter)
    run("/usr/bin/codesign", "--force", "--sign", "-", app)
    run("/usr/bin/codesign", "--verify", "--strict", app)
    # Test the Intel slice through its actual loader before switching the editor.
    with (work / "runtime-check.txt").open("w+b") as log:
        run("/usr/bin/arch", "-x86_64", binaries / "wine", "cmd.exe", "/d", "/c", "ver",
            cwd=drive, env=dict(os.environ, WINEPREFIX=str(drive.parent), WINEDEBUG="-all"),
            stdin=subprocess.DEVNULL, stdout=log, stderr=log, timeout=30)
        log.seek(0)
        report = log.read().replace(b"\0", b"").lower()
        if b"windows" not in report:
            raise RuntimeError("The packaged Wine loader did not report a Windows version.")
    return app


def write_dispatch(path, content):
    with tempfile.NamedTemporaryFile(dir=path.parent, prefix="wine.dock-", delete=False) as out:
        staged = Path(out.name)
    try:
        staged.write_bytes(content)
        shutil.copymode(path, staged)
        os.replace(staged, path)
    finally:
        staged.unlink(missing_ok=True)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--kit", type=Path, required=True)
    parser.add_argument("--launcher", type=Path, default=Path.home() / "Applications/Altium Designer (Wine).app")
    parser.add_argument("--destination", type=Path, default=Path.home() / "Applications")
    args = parser.parse_args()
    kit, launcher, parent = (p.expanduser().resolve() for p in (args.kit, args.launcher, args.destination))
    runtime = kit / "Altium Designer Runtime.app"
    wine_dir = kit / "wine-patched/Wine Staging.app/Contents/Resources/wine/lib/wine/x86_64-unix"
    stock = wine_dir / "wine.before-app-control"
    dispatch = wine_dir / "wine"
    drive = kit / "volume/prefix/drive_c"
    icon = launcher / "Contents/Resources/AppIcon.icns"
    if not (stock.is_file() and icon.is_file() and drive.is_dir() and runtime.is_dir()):
        parser.error("The mounted prefix, original Wine loader, app-control runtime and kit launcher are required.")
    before = dispatch.read_bytes()
    if not before.startswith(b"#!/bin/sh\n# altium-wine app-control loader\n") or str(stock).encode() not in before:
        parser.error("The installed Altium dispatch differs from the kit's app-control setup.")
    parent.mkdir(exist_ok=True, parents=True)
    destination = parent / "Altium Designer.app"
    if destination.exists():
        existing = plistlib.loads((destination / "Contents/Info.plist").read_bytes())
        if existing.get("AltiumKitLauncher") != str(launcher):
            parser.error("Another application is already installed at the destination.")
    executable = shlex.quote(str(destination / "Contents/MacOS/wine"))
    updated = f"""#!/bin/sh
# altium-wine app-control loader
case "$1" in
  *[Xx]2.[Ee][Xx][Ee])
    if [ -x {executable} ]; then
      exec /usr/bin/arch -x86_64 {executable} "$@"
    fi ;;
esac
exec {shlex.quote(str(stock))} "$@"
""".encode()
    with tempfile.TemporaryDirectory(dir=parent, prefix=".altium-dock-") as temp:
        work = Path(temp)
        app = build(work, destination, launcher, runtime, wine_dir, stock, drive)
        previous = work / "previous.app"
        if destination.exists():
            destination.rename(previous)
        try:
            app.rename(destination)
            write_dispatch(dispatch, updated)
            run(LSREGISTER, "-f", destination)
        except BaseException:
            write_dispatch(dispatch, before)
            if destination.exists():
                destination.rename(app)
            if previous.exists():
                previous.rename(destination)
            raise
    print(destination)


if __name__ == "__main__":
    main()
