#!/usr/bin/env python3
"""Exercise the published calculation and editor-query commands on the native query fixture."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile


HERE = Path(__file__).resolve().parents[1]
FIXTURE = HERE / "fixtures/design-query/query-proof"


def member_hashes(directory):
    return {
        p.relative_to(directory).as_posix(): hashlib.sha256(p.read_bytes()).hexdigest()
        for p in sorted(directory.rglob("*"))
        if p.is_file() and p.name != "README.md"
        and not p.relative_to(directory).as_posix().startswith((".waffle/journal/", ".waffle/local/"))
    }


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("product", type=Path, nargs="?", default=HERE.parent)
    parser.add_argument("--only", choices=("calculate", "query"))
    args = parser.parse_args()
    product = args.product.resolve()
    sys.dont_write_bytecode = True
    sys.path.insert(0, str(product / "tests"))
    import sys as _test_sys
    from pathlib import Path as _TestPath
    _test_sys.path.insert(0, str((_TestPath(__file__).resolve().parent / "../support").resolve()))
    from native_sample import ensure_native_host
    ensure_native_host()
    result = {}

    with tempfile.TemporaryDirectory(prefix="waffle-native-query-cli-") as tmp:
        folder = Path(tmp)
        shutil.copytree(FIXTURE, folder, dirs_exist_ok=True)
        before = member_hashes(folder)
        assert len(before) == 10

        def call(command, options, read_only=False):
            cli = [sys.executable, str(product / "mcp/server.py"), "--project", str(folder / "Query proof.waffle")]
            if read_only:
                cli.append("--read-only")
            cli.extend(["--cli", command, "--args", json.dumps(options)])
            run = subprocess.run(cli, capture_output=True, text=True, timeout=30,
                                 env={**os.environ, "PYTHONDONTWRITEBYTECODE": "1"})
            assert run.returncode == 0, run.stderr + run.stdout
            assert member_hashes(folder) == before
            return json.loads(run.stdout)

        if args.only != "calculate":
            def query(document, source):
                reply = call("run_command", {"command": "query", "args": {"document_id": document, "expression": source}})
                assert reply["changes"] == 0 and reply["complete"] and not reply["truncated"], reply
                assert reply["unknown"] == 0, reply
                return reply

            searches = {
                "top": ("pad on layer Top near U3 within 1 mm", "probe-edge/1/1"),
                "bottom": ("pad on layer Bottom near U3 within 1 mm", "probe-edge/1/1"),
                "origin": ("pad near origin of U3 within 1 mm", "probe-origin/1"),
            }
            result["query"] = {}
            for name, (source, expected) in searches.items():
                reply = query("analog", source)
                assert reply["count"] == 1, reply
                pins = reply["pins"] if "pins" in reply else reply["untrusted_design_text"]["pins"]
                assert [pin["id"] for pin in pins] == [expected], reply
                result["query"][name] = {"source": source, "pin": pins[0]["id"]}

            result["fields"] = {}
            for key, document, source, expected in (
                ("width", "analog", 'track where width <= 0.2 and net.name = "Rail"', ["rail-at-limit", "rail-thin"]),
                ("resistance", "power", "resistor where value < 1k and sheet = Power", ["r-small"]),
            ):
                reply = query(document, source)
                assert reply["count"] == len(expected) and sorted(reply["ids"]) == expected, reply
                result["fields"][key] = {"source": source, "ids": expected}

        if args.only != "query":
            saved = call("calculate", {"document_id": "power", "block_id": "count-resistors"}, read_only=True)
            record = saved["records"][0]
            assert record["result"].get("display") == "1 ea", record
            assert [row["status"] for row in record["assertions"]] == ["pass"]
            bad = call("calculate", {"document_id": "power", "expression": "count(resistor where value < 1 V)"}, read_only=True)
            diagnostic = bad["result"]["diagnostic"]
            assert diagnostic["code"] == "dimension" and diagnostic["span"] == [29, 32], diagnostic
            result["calculate"] = {"saved": record["result"]["display"], "assertion": "pass", "badUnit": diagnostic}

        result["unchangedMemberSha256"] = before
    print(json.dumps(result, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
