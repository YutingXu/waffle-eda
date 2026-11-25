#!/usr/bin/env python3
"""Compare the ODB++ and Gerber/Excellon exports of the six pinned public boards."""

import argparse
import json
from pathlib import Path
import subprocess
import sys


HERE = Path(__file__).resolve().parents[1]
ROOT = HERE.parent
sys.path.insert(0, str(HERE / "altium-fidelity"))
from fetch import DEFAULT_CACHE, manifest, verified

sys.path.insert(0, str(ROOT / "mcp"))
from board_runner import resolve


MODULES = ("core", "parts", "obsolete-project", "import-formats", "import-rules", "erc", "connectivity", "stackup", "pcb-appearance",
           "board-shape", "viastack", "via-stubs", "rule-sets", "dfa", "drc", "polygon-pour", "si", "fab-outputs")
TRANSLATORS = ("dxf", "translator-table", "translator-registry", "translator-provenance", "translator-adapters",
               "translator-exports", "translators")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--cache", type=Path, default=DEFAULT_CACHE)
    parser.add_argument("--project", action="append", help="Limit an investigative run to a pinned project ID")
    options = parser.parse_args()
    corpus = manifest()
    assert len(corpus) == 6
    assert not options.project or set(options.project) <= {row["id"] for row in corpus}
    modules = [(name, str(file)) for name, file in resolve(MODULES)]
    modules.extend((name, str(ROOT / "app" / (name + ".js"))) for name in TRANSLATORS)
    failed = []
    for fixture in corpus:
        if options.project and fixture["id"] not in options.project:
            continue
        directory, resources = verified(fixture, options.cache, offline=True)
        test = subprocess.run(["node", "--max-old-space-size=1536", str(HERE / "formats/odb-output.cjs"), "--public"],
                              cwd=ROOT, input=json.dumps({"modules":modules, "projects":[
                                  {"fixture":fixture, "directory":str(directory), "resources":resources}
                              ]}), text=True, timeout=240)
        if test.returncode:
            failed.append(fixture["id"])
    if failed:
        raise SystemExit("ODB++ mismatches in: " + ", ".join(failed))


if __name__ == "__main__":
    main()
