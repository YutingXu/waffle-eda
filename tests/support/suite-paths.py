#!/usr/bin/env python3
"""Find standalone suites and preserve the original paths as selector aliases."""
from pathlib import Path
import sys

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[1]

# These suites and probes have dedicated invocations. Per-feature helpers for
# new suites belong in a support subdirectory below the feature.
SPECIALIZED_DIRS = frozenset({
    "altium-fidelity", "connection-preview", "e2e", "fixed-placement-routing",
    "fixtures", "importer-robustness", "motion", "real-history", "support",
})
SPECIALIZED_NOTEBOOK = frozenset({
    "image-drop-browser.cjs", "ink-browser.cjs", "review-foreign.cjs", "review-link.cjs",
    "review-pan.cjs", "review-peers.cjs", "sketch-hold-browser.cjs", "sketch-hold-roundtrip.cjs",
})


# The Node CI lane runs these standalone harness checks with Node or Python.
# Keep the other files in tests/support out of both inventories.
NODE_SUPPORT_SUITES = (
    "tests/support/app-source-paths.py",
    "tests/support/browser-app-server-test.cjs",
    "tests/support/chrome_cdp_test.py",
    "tests/support/mcp_stdio.py",
    "tests/support/standalone-chromium-test.cjs",
    "tests/support/stdio-frames.cjs",
)


def standalone_paths():
    tests = ROOT / "tests"
    directories = [tests, ROOT / "native/tests"]
    directories.extend(folder for folder in tests.iterdir()
                       if folder.is_dir() and not folder.is_symlink()
                       and not folder.name.startswith(".") and folder.name not in SPECIALIZED_DIRS)
    for folder in directories:
        for path in folder.glob("*.cjs"):
            if path.name.startswith(".") or not path.is_file():
                continue
            if folder == tests / "notebook" and path.name in SPECIALIZED_NOTEBOOK:
                continue
            yield path.relative_to(ROOT).as_posix()


def suites():
    pairs = [line.split("\t") for line in (HERE / "suite-paths.tsv").read_text(encoding="utf-8").splitlines()]
    # An old physical path remains an alias of its mapped suite if a stale copy exists.
    registered = {path for pair in pairs for path in pair}
    pairs.extend((path, path) for path in NODE_SUPPORT_SUITES if path not in registered)
    for target in standalone_paths():
        if target not in registered:
            source = target if target.startswith("native/tests/") else "tests/" + Path(target).name
            pairs.append((source, target))

    seen = {}
    for source, target in sorted(pairs, key=lambda row: (row[0].startswith("native/tests/"), *row)):
        native = source.startswith("native/tests/")
        suite = Path(source).stem
        report = "native-" + suite if native else suite
        if Path(target).stem != suite:
            raise ValueError(f"Suite {report} has a changed basename: {target}")
        if report in seen:
            raise ValueError(f"Duplicate suite ID {report}: {seen[report]} and {target}")
        seen[report] = target
        yield source, target, report, native


def select(runner, requested):
    rows = [row for row in suites() if runner == "node" or (not row[3] and row[1] not in NODE_SUPPORT_SUITES)]
    if not rows:
        raise ValueError("No " + runner + " standalone suites found")
    if not requested:
        return [row[1] for row in rows]
    by_name = {name: current for source, current, report, _ in rows for name in (source, current, report)}
    result = []
    for name in requested:
        lookup = name.removeprefix("./")
        if lookup in by_name:
            result.append(by_name[lookup])
        elif runner == "node" and name.endswith(".cjs"):
            result.append(name)
        else:
            raise ValueError("Unknown " + runner + " suite: " + name)
    return result


def main(argv):
    if not argv or argv[0] not in ("jsc", "node"):
        raise ValueError("Usage: suite-paths.py jsc|node [suite ...]")
    paths = select(argv[0], argv[1:])
    for path in paths:
        if not (ROOT / path).is_file():
            raise ValueError("Missing suite file: " + path)
    print("\n".join(paths))


if __name__ == "__main__":
    try:
        main(sys.argv[1:])
    except (OSError, ValueError) as error:
        print("Suite inventory: " + str(error), file=sys.stderr)
        sys.exit(2)
