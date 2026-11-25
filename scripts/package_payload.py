#!/usr/bin/env python3
"""Python companions and MCP modules that ship beside the native editor.

The five helpers are the files the macOS app stage copies into Resources/native.
Flat MCP siblings are the top-level mcp/*.py and mcp/*.js modules. server.py
imports siblings such as commands.py and review.py lazily, so each sibling ships.

native/external_tools.py stays with the Linux host. Platform app trees, bridge.js,
legal notices, signing files, and installers stay with their packagers.
"""

from pathlib import Path
import argparse
import shutil

# Donor order from the macOS resource stage.
PYTHON_HELPERS = (
    "git_head.py",
    "obsolete_project.py",
    "project_archive.py",
    "import_sources.py",
    "import_export.py",
)

MAC_RESOURCES = "Waffle/Waffle.app/Contents/Resources"


def mcp_files(source):
    directory = Path(source) / "mcp"
    files = [path for path in directory.iterdir() if path.is_file() and path.suffix in {".py", ".js"}]
    files.sort(key=lambda path: path.name)
    return files


def helper_files(source):
    native = Path(source) / "native"
    return [native / name for name in PYTHON_HELPERS]


def companion_paths(source):
    """Preview order: sorted MCP siblings, then sorted helpers."""
    helpers = sorted(helper_files(source), key=lambda path: path.name)
    return [*mcp_files(source), *helpers]


def relative_companions(source):
    source = Path(source)
    return [path.relative_to(source).as_posix() for path in companion_paths(source)]


def stage(source, destination, *, preserve_times=False):
    """Copy the common inventory into destination/native and destination/mcp."""
    destination = Path(destination)
    native_dir = destination / "native"
    mcp_dir = destination / "mcp"
    native_dir.mkdir(parents=True, exist_ok=True)
    mcp_dir.mkdir(parents=True, exist_ok=True)
    copy = shutil.copy2 if preserve_times else shutil.copy
    for path in companion_paths(source):
        copy(path, destination / path.relative_to(source))


def check_packaged(source, read):
    """Stock macOS payload check. A missing member fails inside read()."""
    for path in companion_paths(source):
        relative = path.relative_to(source).as_posix()
        if read(MAC_RESOURCES + "/" + relative) != path.read_bytes():
            raise ValueError("Rebuild the macOS app after updating " + path.name)


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("command", choices=("stage",))
    parser.add_argument("destination", type=Path)
    parser.add_argument("--preserve-times", action="store_true")
    parser.add_argument("--source", type=Path, default=Path(__file__).resolve().parents[1])
    args = parser.parse_args(argv)
    stage(args.source, args.destination, preserve_times=args.preserve_times)


if __name__ == "__main__":
    main()
