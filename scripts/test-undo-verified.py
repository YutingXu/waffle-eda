#!/usr/bin/env python3
"""Run unchanged suites with strict undo verification in every process, VM and browser realm.

Examples (use the Node, NODE_PATH and CHROME from the CI instructions):
  python3 scripts/test-undo-verified.py
  python3 scripts/test-undo-verified.py --probe-only
  python3 scripts/test-undo-verified.py -- python3 path/to/gates.py '{checkout}' label
"""
import argparse
import os
from pathlib import Path
import shlex
import subprocess
import sys
import tempfile


def run(command, cwd, **options):
    print("+", shlex.join(map(str, command)), flush=True)
    return subprocess.run(command, cwd=cwd, check=True, **options)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--probe-only", action="store_true")
    parser.add_argument("command", nargs=argparse.REMAINDER)
    args = parser.parse_args()
    root = Path(__file__).resolve().parents[1]
    os.environ["ATRIUM_UNDO_VERIFY"] = "throw"
    with tempfile.TemporaryDirectory(prefix="waffle-undo-verify-") as directory:
        checkout = Path(directory) / "checkout"
        run(["git", "worktree", "add", "--quiet", "--detach", str(checkout), "HEAD"], root)
        try:
            diff = run(["git", "diff", "--binary", "HEAD"], root, stdout=subprocess.PIPE).stdout
            if diff:
                run(["git", "apply", "--binary", "-"], checkout, input=diff)
            # Engines with no environment API (including nested realms) execute this same store.
            # The existing negative-control/performance tests retain their explicit boolean override.
            store = checkout / "app/history/undo-store.js"
            source = store.read_text()
            anchor = 'globalThis.AtriumUndoStore = (() => {'
            assert source.count(anchor) == 1
            store.write_text(source.replace(anchor, 'globalThis.ATRIUM_UNDO_VERIFY ??= "throw";\n' + anchor))
            run([sys.executable, "-B", "scripts/prepare-assets.py"], checkout)
            probe = "scripts/undo-verify-fault.js"
            run(["node", probe], checkout)
            run(["node", "--expose-gc", "scripts/test-sheet-cache-lifetime.cjs"], checkout)
            jsc = "/System/Library/Frameworks/JavaScriptCore.framework/Versions/Current/Helpers/jsc"
            result = run([jsc, "tests/jsc-shim.js", "--", str(checkout / probe)], checkout,
                         stdout=subprocess.PIPE, text=True)
            print(result.stdout, end="", flush=True)
            if "SHIM-OK undo-verify-fault.js" not in result.stdout or "SHIM-FAIL" in result.stdout:
                raise RuntimeError("JavaScriptCore did not complete the verification probe.")
            run(["node", "scripts/test-undo-editor.cjs"], checkout)
            if args.probe_only:
                return
            if args.command:
                command = args.command[1:] if args.command[0] == "--" else args.command
                run([str(checkout) if a == "{checkout}" else a for a in command], checkout)
            else:
                for kind, command in (("jsc", ["zsh", "scripts/test-jsc.sh"]),
                                      ("node", ["sh", "scripts/ci/node-suites.sh"])):
                    log = Path(directory) / (kind + ".log")
                    with log.open("w") as out:
                        completed = subprocess.run(command, cwd=checkout, stdout=out, stderr=subprocess.STDOUT)
                    print(log.read_text(), flush=True)
                    run(["python3", "scripts/ci/check-results.py", kind, str(log)], checkout)
                    if completed.returncode and "FAIL " not in log.read_text():
                        raise RuntimeError(f"{kind} inventory exited {completed.returncode}")
        finally:
            run(["git", "worktree", "remove", "--force", str(checkout)], root)


if __name__ == "__main__":
    main()
