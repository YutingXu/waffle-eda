#!/usr/bin/env python3
"""Package the verified macOS bundle alongside the portable editor and sources."""
from pathlib import Path
import plistlib
import stat
import subprocess
import sys
from zipfile import ZIP_DEFLATED, ZipFile, ZipInfo
from asset_files import staged_output
from package_payload import check_packaged

ROOT = Path(__file__).resolve().parents[1]
DIST = ROOT / "dist"
BUNDLE = DIST / "Waffle.app"
SOURCES = ("README.md", "LICENSE", "THIRD_PARTY_NOTICES.md", "app", "native", "mcp", "scripts", "tests", "engine", "extensions", "docs", "brand", "collab", "deploy", "dist/.engine-assets.sha256")
IGNORED = {"__pycache__", ".DS_Store", "node_modules", "target", "bin", "obj", ".git"}
GENERATED_INSTALLERS = {ROOT / "deploy/collab-server" / name for name in ("launch-script.sh", "waffle-setup.sh")}


def files(path):
    if path.is_file():
        yield path
    else:
        for item in sorted(path.rglob("*")):
            if item.is_file() and item not in GENERATED_INSTALLERS and item.suffix != ".pyc":
                if not IGNORED.intersection(item.relative_to(path).parts):
                    yield item


def main():
    if not (BUNDLE / "Contents/MacOS/Waffle").is_file():
        raise SystemExit("Build the macOS app with scripts/build-mac.sh first.")
    version = (ROOT / "app/VERSION").read_text(encoding="ascii").strip()
    bundle_version = plistlib.loads((BUNDLE / "Contents/Info.plist").read_bytes())["CFBundleShortVersionString"]
    if bundle_version != version:
        raise SystemExit(f"Rebuild the macOS app for Waffle {version}; the bundle is {bundle_version}.")
    deb_builder = [sys.executable, str(ROOT / "scripts/build-deb.py")]
    deb = DIST / subprocess.check_output([*deb_builder, "--filename"], text=True).strip()
    subprocess.run([*deb_builder, "--output", str(deb)], check=True)
    dest = DIST / f"Waffle-{version}-with-sources.zip"
    with staged_output(dest) as tmp:
        # The Windows portable zip (scripts/build-windows.sh dist) is included when it was built.
        windows = DIST / f"Waffle-{version}-windows.zip"
        sources = [(BUNDLE, "Waffle.app"), (deb, deb.name)]
        if windows.is_file():
            sources.append((windows, windows.name))
        else:
            print(f"note: no {windows.name}; run scripts/build-windows.sh to include Windows", file=sys.stderr)
        sources.extend((ROOT / p, p) for p in SOURCES if (ROOT / p).exists())
        with ZipFile(tmp, "w", compression=ZIP_DEFLATED, compresslevel=7) as archive:
            for base, name in sources:
                for item in files(base):
                    relative = Path("Waffle") / name / item.relative_to(base)
                    info = ZipInfo.from_file(item, str(relative))
                    info.create_system, info.compress_type = 3, ZIP_DEFLATED
                    archive.writestr(info, item.read_bytes())
        with ZipFile(tmp) as archive:
            if archive.testzip():
                raise ValueError("Archive failed its CRC check")
            for item in files(ROOT / "app"):
                path = str(item.relative_to(ROOT / "app"))
                if archive.read("Waffle/Waffle.app/Contents/Resources/app/" + path) != item.read_bytes():
                    raise ValueError("Rebuild the macOS app after updating " + path)
            check_packaged(ROOT, archive.read)
            for name in ("Waffle.app/Contents/MacOS/Waffle", "scripts/launch-linux.sh"):
                if not archive.getinfo("Waffle/" + name).external_attr >> 16 & stat.S_IXUSR:
                    raise ValueError("Missing executable permission for " + name)
    print(dest)


if __name__ == "__main__":
    main()
