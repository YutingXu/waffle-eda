"""Check standalone suite discovery and the JavaScriptCore runner's final verdict."""

from pathlib import Path
from shutil import copy2, which
import subprocess
import sys
import tempfile


ROOT = Path(__file__).resolve().parents[1]
SUPPORT_SUITES = (
    "app-source-paths.py", "browser-app-server-test.cjs", "chrome_cdp_test.py",
    "mcp_stdio.py", "playwright-test.cjs", "standalone-chromium-test.cjs", "stdio-frames.cjs",
)


def write(root, name, content):
    path = root / name
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(content, encoding="utf-8")


def check_discovery(root):
    for name in ("scripts/test-jsc.sh", "scripts/ci/node-suites.sh", "tests/jsc-shim.js", "tests/support/suite-paths.py"):
        (root / name).parent.mkdir(parents=True, exist_ok=True)
        copy2(ROOT / name, root / name)
    write(root, "scripts/prepare-assets.py", "pass\n")
    write(root, "tests/support/suite-paths.tsv", "tests/existing.cjs\ttests/core/existing.cjs\n")
    for name in ("tests/core/existing.cjs", "tests/new-feature/new-standalone.cjs", "native/tests/new-native.cjs"):
        write(root, name, 'require("node:assert/strict").ok(true);\n')
    for name in ("tests/existing.cjs", "tests/support/new-standalone.cjs", "tests/new-feature/support/helper.cjs",
                 "tests/real-history/new-standalone.cjs", "tests/notebook/review-link.cjs"):
        write(root, name, 'throw new Error("a specialized script or historical path was executed");\n')

    for name in SUPPORT_SUITES:
        body = 'assert __name__ == "__main__"\n' if name.endswith(".py") else 'require("node:assert/strict").ok(true);\n'
        write(root, "tests/support/" + name, body)

    runs = [("scripts/test-jsc.sh", ["existing", "new-standalone"])]
    if which("node") and which("timeout"):
        support_ids = [Path(name).stem for name in SUPPORT_SUITES]
        runs.append(("scripts/ci/node-suites.sh", ["existing", "new-standalone", *support_ids, "native-new-native"]))
    for script, ids in runs:
        run = subprocess.run([root / script], cwd=root.parent, text=True, capture_output=True)
        if run.returncode or run.stdout.splitlines() != [f"ok    {name}" for name in ids]:
            raise AssertionError(f"{script} exited {run.returncode}\n{run.stdout}{run.stderr}")

    for runner, suite, target in (
        ("jsc", "new-standalone", "tests/new-feature/new-standalone.cjs"),
        ("node", "mcp_stdio", "tests/support/mcp_stdio.py"),
    ):
        duplicate = f"tests/other/{suite}.cjs"
        write(root, duplicate, "")
        run = subprocess.run([sys.executable, root / "tests/support/suite-paths.py", runner], cwd=root.parent,
                             text=True, capture_output=True)
        if (run.returncode != 2 or run.stdout or f"Duplicate suite ID {suite}" not in run.stderr
                or target not in run.stderr or duplicate not in run.stderr):
            raise AssertionError(f"duplicate discovery exited {run.returncode}\n{run.stdout}{run.stderr}")
        (root / duplicate).unlink()


def check_suite_scope():
    for runner in ("jsc", "node"):
        output = subprocess.check_output([sys.executable, "-B", ROOT / "tests/support/suite-paths.py", runner], text=True)
        paths = output.splitlines()
        assert len(paths) == len(set(paths)), runner
        assert not any(Path(path).stem == "browser-drc-messages" for path in paths), runner
        for name in SUPPORT_SUITES:
            assert paths.count("tests/support/" + name) == int(runner == "node"), (runner, name)
    integration = (ROOT / "tests/integration-browser.cjs").read_text(encoding="utf-8")
    scenario = 'await require("./checks/browser-drc-messages.js")(browser)'
    interaction = integration.split("async function editorInteractionChecks()", 1)[1].split("async function editorGpuChecks()", 1)[0]
    assert '{name:"editor-interaction", run:editorInteractionChecks}' in integration and scenario in interaction
    assert any("--drc-messages-only" in line and scenario in line for line in integration.splitlines())


def main():
    check_suite_scope()
    cases = [
        ("late-assertion", 1, "deliberate late assertion", """
            setTimeout(() => Promise.resolve().then(() => {
              require("node:assert/strict").equal(3, 4, "deliberate late assertion");
            }).catch(error => { console.error(error); process.exitCode = 1; }), 12);
        """),
        ("cleared-exit-code", 0, "ok    cleared-exit-code", """
            process.exitCode = 1;
            setTimeout(() => { process.exitCode = 0; }, 12);
        """),
        ("unfinished-promise", 1, "test did not finish", """
            console.log("SHIM-OK");
            globalThis.__testDone = new Promise(() => {});
        """),
    ]
    with tempfile.TemporaryDirectory(prefix="atrium-jsc-runner-") as directory:
        root = Path(directory)
        check_discovery(root / "standalone archive")
        for name in ("scripts/test-jsc.sh", "tests/jsc-shim.js", "tests/support/suite-paths.py"):
            (root / name).parent.mkdir(parents=True, exist_ok=True)
            copy2(ROOT / name, root / name)
        runner = root / "scripts/test-jsc.sh"
        prepare = root / "scripts/prepare-assets.py"
        # The synthetic JavaScript cases need no app assets.
        prepare.write_text("pass\n", encoding="utf-8")
        suites = [case[0] for case in cases] + ["preparation-failure"]
        (root / "tests/support/suite-paths.tsv").write_text("".join(
            f"tests/{suite}.cjs\ttests/core/{suite}.cjs\n" for suite in suites), encoding="utf-8")
        (root / "tests/core").mkdir()
        for suite, expected, message, body in cases:
            (root / "tests/core" / f"{suite}.cjs").write_text(body, encoding="utf-8")
            run = subprocess.run([runner, suite], text=True, capture_output=True)
            if run.returncode != expected or message not in run.stdout:
                raise AssertionError(f"{suite} exited {run.returncode}\n{run.stdout}{run.stderr}")

        prepare.write_text('import sys\nprint("deliberate asset preparation failure", file=sys.stderr)\n'
                           'raise SystemExit(19)\n', encoding="utf-8")
        (root / "tests/core/preparation-failure.cjs").write_text(
            'throw new Error("JavaScript ran after preparation failed");\n', encoding="utf-8")
        run = subprocess.run([runner, "preparation-failure"], text=True, capture_output=True)
        if (run.returncode != 2 or run.stdout or "deliberate asset preparation failure" not in run.stderr
                or "JavaScript ran after preparation failed" in run.stderr):
            raise AssertionError(f"preparation-failure exited {run.returncode}\n{run.stdout}{run.stderr}")
    print("PASS standalone suite discovery, JavaScriptCore late assertion, cleared exit code, unfinished promise and preparation failure")


if __name__ == "__main__":
    main()
