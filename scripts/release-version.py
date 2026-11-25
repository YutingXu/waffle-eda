#!/usr/bin/env python3
"""Report the package version and check the native and browser mirrors."""
import argparse
from pathlib import Path
import plistlib
import re
import subprocess
import sys
import xml.etree.ElementTree as ET


ROOT = Path(__file__).resolve().parents[1]


def release_flavour(name):
    return name.removesuffix(" Preview")


def release_notes(name):
    return "docs/preview-notes.md" if name.endswith(" Preview") else "docs/release-notes.md"


def release_name(version):
    about = (ROOT / "app/editor/about.js").read_text(encoding="utf-8")
    match = re.search(r'^  const CODENAME = "([A-Za-z]+(?: [A-Za-z]+)*)";$', about, re.M)
    if not match:
        raise SystemExit("app/editor/about.js: expected a release name")
    name = match[1]
    if version.startswith("0.6.") and release_flavour(name) == "Apricot":
        raise SystemExit("Waffle 0.6 builds are internal QA only")
    return name


def check(version, name):
    notes = release_notes(name)
    heading = (ROOT / notes).read_text(encoding="utf-8").splitlines()[0]
    if heading != f"# Waffle EDA {version} · {name}":
        raise SystemExit(f"{notes}: expected the current version and full release name")
    identifier = name.lower().replace(" ", "-")
    if not name.endswith(" Preview"):
        identifier += "-official"
    page = (ROOT / "app/index.html").read_text(encoding="utf-8")
    if not re.search(rf'\bdata-release="{re.escape(identifier)}"', page):
        raise SystemExit(f"app/index.html: expected release identity {identifier}")
    flavour = release_flavour(name).lower().replace(" ", "-")
    if not (ROOT / "brand/macos" / f"Waffle-{flavour}.icns").is_file():
        raise SystemExit(f"Missing macOS artwork for {name}")
    mirrors = {
        "app/index.html": r'name="application-version" content="([^"]+)"',
        "app/editor/about.js": r'const VERSION = "([^"]+)"',
        "app/editor/update-check.js": r'const APP_VERSION = "([^"]+)"',
    }
    for name, pattern in mirrors.items():
        value = re.search(pattern, (ROOT / name).read_text(encoding="utf-8"))
        if not value or value[1] != version:
            raise SystemExit(f"{name}: expected release version {version}")
    name = "native/macos/Info.plist"
    mac = plistlib.loads((ROOT / name).read_bytes())
    if mac["CFBundleShortVersionString"] != version:
        raise SystemExit(f"{name}: expected CFBundleShortVersionString {version}")
    name = "native/windows/app.manifest"
    win = ET.parse(ROOT / name).getroot().find("{urn:schemas-microsoft-com:asm.v1}assemblyIdentity")
    if win is None or win.get("version") != f"{version}.0":
        raise SystemExit(f"{name}: expected assembly version {version}.0")
    deb = subprocess.check_output([sys.executable, "-B", ROOT / "scripts/build-deb.py", "--filename"], text=True).strip()
    if deb != f"waffle-eda_{version}_all.deb":
        raise SystemExit(f"scripts/build-deb.py: expected Debian package version {version}")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--check", action="store_true", help="Check the versions shipped in platform metadata")
    output = parser.add_mutually_exclusive_group()
    output.add_argument("--name", action="store_true", help="Print the full name displayed in About")
    output.add_argument("--flavour", action="store_true", help="Print the flavour that selects the release artwork")
    output.add_argument("--notes", action="store_true", help="Print the release notes file relative to the source root")
    args = parser.parse_args()
    version = (ROOT / "app/VERSION").read_text(encoding="ascii").strip()
    if not re.fullmatch(r"(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)", version):
        raise SystemExit("app/VERSION must contain three numeric version components")
    name = release_name(version)
    if args.check:
        check(version, name)
    if args.flavour:
        print(release_flavour(name))
    elif args.notes:
        print(release_notes(name))
    elif args.name:
        print(name)
    else:
        print(version)
