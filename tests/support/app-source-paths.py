#!/usr/bin/env python3
"""Check one checkout walk, the historical aliases, a basename collision and an alias mutant."""
import subprocess
import sys
import tempfile
import textwrap
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
MODULE = ROOT / "tests/support/app-source-paths.cjs"
CHECK = textwrap.dedent(
    r"""
    "use strict";
    const assert = require("node:assert/strict");
    const fs = require("node:fs");
    const path = require("node:path");
    const vm = require("node:vm");
    const [modulePath, fixture] = process.argv.slice(1);
    const source = fs.readFileSync(modulePath, "utf8");
    assert.equal(source.includes("const moved"), false);
    const real = require(modulePath);
    const bases = ["/first app root", "/second app root"];
    const table = real.inventoryFrom();
    assert.equal(real.inventoryFrom(), table, "one walk per checkout");
    assert.equal(table.get("motion.js"), "ui/motion.js");
    for (const base of bases) {
      assert.equal(real.appFileFrom(base, "zip.js"), real.appFileFrom(base, "zip"));
      assert.equal(real.appFileFrom(base, "zip.js"), path.join(base, "core/zip.js"));
      assert.equal(real.appFileFrom(base, "motion.js"), path.join(base, "editor/editor-motion.js"));
      assert.notEqual(real.appFileFrom(base, "motion.js"), path.join(base, table.get("motion.js")));
      assert.equal(real.appFileFrom(base, "butter-catalog.js"), path.join(base, "automation/command-catalog.js"));
      assert.equal(real.appFileFrom(base, "butter-ai-ui"), path.join(base, "automation/ai-ui.js"));
      assert.equal(real.appFileFrom(base, "butter-intel-ui.css"), path.join(base, "editor/workspace-tools.css"));
      assert.equal(real.appFileFrom(base, "vendor", "cfb.min.js"), path.join(base, "vendor/cfb.min.js"));
      assert.equal(real.appFileFrom(base, "ui", "motion.js"), path.join(base, "ui/motion.js"));
      assert.equal(real.appFileFrom(base, "editor", "unknown.js"), path.join(base, "editor/unknown.js"));
    }
    assert.equal(fs.existsSync(real.appFile("zip.js")), true);
    assert.equal(fs.existsSync(real.appFile("editor-motion.js")), true);

    function load(text, support) {
      const exports = {};
      vm.runInNewContext(text, {require, exports, __dirname: support}, {filename: modulePath});
      return exports;
    }
    function emptyFile(root, relative) {
      const file = path.join(root, relative);
      fs.mkdirSync(path.dirname(file), {recursive: true});
      fs.writeFileSync(file, "");
    }

    const workspace = path.join(fixture, "collision");
    emptyFile(workspace, "a/sample.js");
    emptyFile(workspace, "b/sample.js");
    assert.throws(() => real.inventoryFrom(workspace), /app source basename collision: sample\.js/);

    const app = path.join(fixture, "app");
    const support = path.join(fixture, "tests/support");
    for (const relative of ["ui/motion.js", "editor/editor-motion.js", "core/zip.js"])
      emptyFile(app, relative);
    const clean = load(source, support);
    assert.equal(clean.inventoryFrom().has("command-catalog.js"), false, "clean fixture has no generated catalog");
    assert.equal(clean.appFileFrom(bases[0], "butter-catalog.js"), path.join(bases[0], "automation/command-catalog.js"));

    emptyFile(app, "automation/command-catalog.js");
    const prepared = load(source, support);
    assert.equal(prepared.inventoryFrom().get("command-catalog.js"), "automation/command-catalog.js");
    assert.equal(prepared.appFileFrom(bases[0], "butter-catalog.js"), path.join(bases[0], "automation/command-catalog.js"));
    assert.equal(prepared.appFileFrom(bases[0], "motion.js"), path.join(bases[0], "editor/editor-motion.js"));

    const mutatedSource = source.replace(JSON.stringify("automation/ai-ui.js"), JSON.stringify("butter-ai-ui.js"));
    assert.notEqual(mutatedSource, source);
    const mutant = load(mutatedSource, path.dirname(modulePath));
    const actual = mutant.appFileFrom(bases[0], "butter-ai-ui.js");
    assert.equal(actual, path.join(bases[0], "butter-ai-ui.js"));
    assert.notEqual(actual, path.join(bases[0], "automation/ai-ui.js"));
    console.log("app source paths: aliases, two roots, clean and prepared trees, collision, alias mutant");
    """
)


def main():
    if not MODULE.is_file():
        raise SystemExit(f"missing {MODULE}")
    with tempfile.TemporaryDirectory(prefix="app-source-paths-") as fixture:
        run = subprocess.run(["node", "-e", CHECK, "--", str(MODULE), fixture], text=True, capture_output=True)
    if run.returncode:
        sys.stderr.write(run.stdout + run.stderr)
        raise SystemExit(run.returncode or 1)
    print(run.stdout.strip())


if __name__ == "__main__":
    main()
