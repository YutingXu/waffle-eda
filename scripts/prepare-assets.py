#!/usr/bin/env python3
"""Prepare ignored assets from source for local use, testing, and packaging."""
import argparse
from fnmatch import fnmatchcase
from pathlib import Path
import subprocess
import sys

ROOT = Path(__file__).resolve().parents[1]
SCRIPTS = ROOT / "scripts"


APP_ASSETS = (
    "app/worker-source.js", "app/folder-*-worker-source.js", "app/calculation-worker-source.js", "app/datasheet-worker-source.js",
    "app/translator-table.js", "app/translator-worker-modules.js",
    "app/extensions/bundled.js", "app/extensions/manifests.js", "app/extensions/packages/",
    "app/locales/*.js", "app/locales/en-XA.*",
    "app/engine-core.js", "app/engine-mvp.js", "app/engine-simd128.js",
    "app/extension-template.js", "app/fab-presets/*.js", "app/search-data.js",
    "app/getting-started-guide.js", "app/automation/command-catalog.js", "app/automation/legacy-command-contract.js",
    "app/vendor/notebook-fonts/faces.js",
)
DEPLOYMENT_ASSETS = ("deploy/collab-server/launch-script.sh", "deploy/collab-server/waffle-setup.sh")
TEST_ASSETS = ("tests/e2e/modules.cjs",)


def check_untracked():
    generated = APP_ASSETS + DEPLOYMENT_ASSETS + TEST_ASSETS
    ignore = set((ROOT / ".gitignore").read_text(encoding="utf-8").splitlines())
    missing = ["/" + path for path in generated if "/" + path not in ignore]
    if missing:
        sys.exit("Generated asset ignore rules are missing:\n  " + "\n  ".join(missing))
    tracked = subprocess.check_output(["git", "ls-files", "-z", "--", "app", "deploy/collab-server", *TEST_ASSETS], cwd=ROOT).decode().split("\0")
    patterns = [rule + "*" if rule.endswith("/") else rule for rule in generated]
    offenders = [name for name in tracked if name and any(fnmatchcase(name, pattern) for pattern in patterns)]
    if offenders:
        sys.exit("Generated assets are tracked by Git:\n  " + "\n  ".join(offenders))


def prepare(check=False, engine=True):
    from e2e_modules import prepare_modules

    steps = [
        ("bundle-extensions.py",),
        ("i18n-extract.py", "--assets"),
        ("gen-search-data.py",),
        ("butter-catalog.py",),
        ("legacy-command-catalog.py",),
        ("new-extension.py", "--bundle"),
        ("fab-presets.py",),
        ("notebook-fonts.py",),
        ("bundle-datasheet.py",),
    ]
    for name, *args in steps:
        if check:
            args = [arg for arg in args if arg != "--assets"] + ["--check"]
        subprocess.run([sys.executable, "-B", str(SCRIPTS / name), *args], cwd=ROOT, check=True)
    if engine:
        args = ["--check-assets"] if check else ["--no-test", "--ensure"]
        subprocess.run([sys.executable, "-B", str(SCRIPTS / "build-engine.py"), *args], cwd=ROOT, check=True)

    # The headless dependency resolver includes optional modules only after their files exist.
    # Build leaf assets such as the JLCPCB loader before discovering the worker dependency graph.
    option = "--check" if check else "--assets"
    subprocess.run([sys.executable, "-B", str(SCRIPTS / "bundle-worker.py"), option], cwd=ROOT, check=True)
    prepare_modules(check=check)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    mode = parser.add_mutually_exclusive_group()
    mode.add_argument("--check", action="store_true", help="fail when generated assets are missing or stale")
    mode.add_argument("--check-untracked", action="store_true", help="fail if a generated asset is tracked")
    parser.add_argument("--no-engine", action="store_true", help="skip the optional Rust/WebAssembly engine")
    args = parser.parse_args()
    try:
        if args.check_untracked:
            check_untracked()
        else:
            prepare(check=args.check, engine=not args.no_engine)
    except subprocess.CalledProcessError as error:
        sys.exit(error.returncode)


if __name__ == "__main__":
    main()
