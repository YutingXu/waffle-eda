#!/usr/bin/env python3
"""Copy the editor's renderer (app/*.js) into media/app/ for the read-only preview.

    python3 integrations/vscode/scripts/bundle-viewer.py          # copy
    python3 integrations/vscode/scripts/bundle-viewer.py --check  # fail if a source is missing or media/app is stale

The webview draws with Waffle's renderer. Its extension host uses the same
Format 2 modules as the editor and follows their local CommonJS dependencies.
media/app/ is generated (see .gitignore); package-vsix.py runs this first.
"""
import json
import re
import shutil
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
EXT = HERE.parent
ROOT = EXT.parents[1]
sys.path.insert(0, str(ROOT / "mcp"))
from board_runner import APP, resolve

FORMAT_ROOTS = ("obsolete-project", "format-2-model", "table-format")
VIEWER_ROOTS = ("board-shape", "sch-objects", "pcb-net-labels", "canvas")
HISTORY_FILES = ("checks/waivers.js", "checks/net-intent.js", "core/signals.js", "library/component-match.js", "pcb/pour-marker.js", "history/diff.js")
REQUIRE = re.compile(r"\brequire\s*\(\s*(['\"])(\.{1,2}/[\w./-]+)\1\s*\)")
OUT = EXT / "media" / "app"
ORDER = OUT / "viewer-scripts.json"
EXTRA = {ROOT / "LICENSE": EXT / "LICENSE.txt"}


def sources(viewer):
    files = set(viewer) | {APP / name for name in HISTORY_FILES}
    files.update(path for _, path in resolve(FORMAT_ROOTS) if APP in path.parents)
    pending = list(files)
    while pending:
        source = pending.pop()
        if not source.is_file():
            sys.exit(f"bundle-viewer: missing source {source.relative_to(ROOT)}")
        for _, name in REQUIRE.findall(source.read_text(encoding="utf-8")):
            dependency = (source.parent / name).resolve()
            if not dependency.suffix:
                dependency = dependency.with_suffix(".js")
            if APP not in dependency.parents:
                sys.exit(f"bundle-viewer: dependency outside app in {source.relative_to(ROOT)}")
            if dependency.suffix not in (".js", ".cjs", ".json"):
                sys.exit(f"bundle-viewer: unsupported dependency type in {source.relative_to(ROOT)}")
            if dependency not in files:
                files.add(dependency)
                pending.append(dependency)
    return sorted(files)


def main():
    # The webview uses the JS renderer under a CSP that disallows WASM.
    viewer = [path for name, path in resolve(VIEWER_ROOTS) if APP in path.parents and name != "engine-core"]
    order = (json.dumps([path.relative_to(APP).as_posix() for path in viewer]) + "\n").encode("utf-8")
    app_files = {source:OUT / source.relative_to(APP) for source in sources(viewer)}
    pairs = {**app_files, **EXTRA}
    stale = [str(dst.relative_to(ROOT)) for src, dst in pairs.items() if not dst.is_file() or dst.read_bytes() != src.read_bytes()]
    if not ORDER.is_file() or ORDER.read_bytes() != order:
        stale.append(str(ORDER.relative_to(ROOT)))
    extras = {p for p in OUT.rglob("*") if p.is_file()} - set(app_files.values()) - {ORDER}
    if "--check" in sys.argv[1:]:
        # media/app is gitignored: a fresh checkout (CI) has none, and package-vsix.py builds it.
        # Once generated, every copy must match app/ byte for byte.
        if not OUT.exists():
            print("bundle-viewer: ok (media/app not generated; sources present)")
            return
        if stale or extras:
            paths = stale + sorted(str(file.relative_to(ROOT)) for file in extras)
            sys.exit("bundle-viewer: stale, missing or extra: " + ", ".join(paths) + "; run python3 integrations/vscode/scripts/bundle-viewer.py")
        print("bundle-viewer: ok")
        return
    for src, dst in pairs.items():
        dst.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(src, dst)
    ORDER.write_bytes(order)
    for old in extras:
        old.unlink()
    size = sum(file.stat().st_size for file in app_files.values())
    print(f"bundle-viewer: copied {len(app_files)} files ({size / 1024:.0f} KB) into {OUT.relative_to(ROOT)}")


if __name__ == "__main__":
    main()
