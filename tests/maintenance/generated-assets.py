#!/usr/bin/env python3
"""Verify worker discovery in a clean tree and enforce generated asset Git rules."""
from fnmatch import fnmatchcase
import json
from pathlib import Path
from runpy import run_path
import shutil
import subprocess
import sys
import tempfile

ROOT = Path(__file__).resolve().parents[2]
PREPARE = "scripts/prepare-assets.py"
WORKERS = (
    "translator-table.js", "translator-worker-modules.js", "worker-source.js",
    "folder-copper-worker-source.js", "folder-project-worker-source.js", "calculation-worker-source.js",
)
FAB_PRESET = "fab-presets/jlcpcb.js"
GUIDE = "getting-started-guide.js"
LEGACY_COMMAND_CONTRACT = "automation/legacy-command-contract.js"
FIDELITY_MANIFEST = "tests/e2e/modules.cjs"


def check_tracking():
    with tempfile.TemporaryDirectory(prefix="waffle-asset-tracking-") as temp:
        checkout = Path(temp)
        (checkout / "scripts").mkdir()
        shutil.copyfile(ROOT / PREPARE, checkout / PREPARE)
        ignore = checkout / ".gitignore"
        rules = (ROOT / ".gitignore").read_text(encoding="utf-8")
        ignore.write_text(rules, encoding="utf-8")
        subprocess.run(["git", "init", "--quiet"], cwd=checkout, check=True)
        args = [sys.executable, "-B", PREPARE, "--check-untracked"]
        subprocess.run(args, cwd=checkout, check=True)

        lost = "/app/worker-source.js"
        ignore.write_text(rules.replace(lost + "\n", ""), encoding="utf-8")
        result = subprocess.run(args, cwd=checkout, capture_output=True, text=True)
        assert result.returncode and lost in result.stderr, "the missing worker ignore rule was accepted"
        ignore.write_text(rules, encoding="utf-8")

        forced = ("app/folder-copper-worker-source.js", "app/extensions/packages/test.package.js",
                  "app/locales/en-XA.json", "app/" + GUIDE, "app/" + LEGACY_COMMAND_CONTRACT, FIDELITY_MANIFEST)
        for name in forced:
            path = checkout / name
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text("generated", encoding="utf-8")
        subprocess.run(["git", "add", "--force", "--", *forced], cwd=checkout, check=True)
        result = subprocess.run(args, cwd=checkout, capture_output=True, text=True)
        assert result.returncode and all(name in result.stderr for name in forced), "tracked outputs were accepted"


def check_first_build():
    patterns = [path.rstrip("/") for path in run_path(str(ROOT / PREPARE))["APP_ASSETS"]]

    def ignored(directory, names):
        relative = Path(directory).relative_to(ROOT)
        return [name for name in names if name in {".DS_Store", "__pycache__", "node_modules"}
                or any(fnmatchcase((relative / name).as_posix(), pattern) for pattern in patterns)]

    with tempfile.TemporaryDirectory(prefix="waffle-clean-assets-") as temp:
        checkout = Path(temp)
        for name in ("app", "docs", "extensions", "mcp", "scripts"):
            shutil.copytree(ROOT / name, checkout / name, ignore=ignored)
        shutil.copyfile(ROOT / "README.md", checkout / "README.md")
        app = checkout / "app"
        fidelity = checkout / FIDELITY_MANIFEST
        generated = (*WORKERS, GUIDE, LEGACY_COMMAND_CONTRACT)
        assert not any((app / name).exists() for name in (*generated, FAB_PRESET))
        assert not fidelity.exists()
        command = [sys.executable, "-B", PREPARE, "--no-engine"]

        subprocess.run(command, cwd=checkout, check=True)
        first = {name: (app / name).read_bytes() for name in generated}
        manifest = fidelity.read_bytes()
        assert b'["headless", "mcp/headless.js"]' in manifest
        assert b"run_output_job" in first[GUIDE], "the offline guide changed the command name"
        registry = first["translator-worker-modules.js"].decode("utf-8").split(" = ", 1)[1].rstrip(";\n")
        assert FAB_PRESET in json.loads(registry)["panel"], "first build omitted the generated JLCPCB module"
        assert f'"{FAB_PRESET}"' in json.loads(first["worker-source.js"].decode("utf-8").split(" = ", 1)[1].rstrip(";\n"))
        subprocess.run([*command, "--check"], cwd=checkout, check=True)
        # Changing the Python source must invalidate the existing worker projection.
        registry = checkout / "mcp/commands.py"
        source = registry.read_text(encoding="utf-8")
        registry.write_text(source + '\nCOMMANDS["align"]["kind"] = "read"\n', encoding="utf-8")
        check = [sys.executable, "-B", "scripts/legacy-command-catalog.py", "--check"]
        result = subprocess.run(check, cwd=checkout, capture_output=True, text=True)
        assert result.returncode and "legacy command contract is missing or stale" in result.stderr
        registry.write_text(source, encoding="utf-8")
        subprocess.run(command, cwd=checkout, check=True)
        assert first == {name: (app / name).read_bytes() for name in generated}, "products changed on the second build"
        assert fidelity.read_bytes() == manifest, "fidelity module manifest changed on the second build"
    print("Generated worker and fidelity assets are current and identical on both source builds.")


if __name__ == "__main__":
    check_tracking()
    check_first_build()
