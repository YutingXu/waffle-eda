#!/usr/bin/env python3
"""Compare pinned public KiCad source boards with author-supplied fabrication data."""

import argparse
from io import BytesIO
import json
from pathlib import Path
from runpy import run_path
import subprocess
import tempfile
from urllib.parse import quote
from zipfile import ZipFile


HERE = Path(__file__).resolve().parents[1]
PUBLIC = run_path(str(HERE / "formats/odb-public.py"))
REVISION = "407749df81dd813d16451a36ca78c07cfbc6ab6f"
UPSTREAM = "FixturFab/ODB2kicad"
FILES = {
    "samples/test.kicad_pcb": "fb2b7dc5448d7a7da10e05b8d215dff42a6c034a6c301889ce3f4167aa18a1b6",
    "samples/test-odb.zip": "fd59fa2e39bdef4fdfbbbb31e16c5097b64a0e39820bb6d2557fc3d2884800ed",
}
MEMBERS = (
    "misc/info",
    "steps/pcb/profile",
    "steps/pcb/eda/data",
    "steps/pcb/netlists/cadnet/netlist",
    "steps/pcb/layers/comp_+_top/components",
    "steps/pcb/layers/f.cu/features",
    "steps/pcb/layers/b.cu/features",
    "steps/pcb/layers/f.mask/features",
    "steps/pcb/layers/b.mask/features",
    "steps/pcb/layers/f.paste/features",
    "steps/pcb/layers/b.paste/features",
    "steps/pcb/layers/f.silkscreen/features",
)


CANARY_UPSTREAM = "stoatworks-labs/canary"
CANARY_REVISION = "f781ddc2b9e96b6f537491b73aa3d169265bd59e"
CANARY_FILES = {
    "hardware/canary.kicad_pcb": "a208790fa83dc24ddbd24b99e697b8f6dd3b206db3ab73e97be3b6a33de5ecb9",
    "hardware/canary.kicad_pro": "1db8fe198e052de1c65687708857d3c543a9ededa3c44f111a5522768aff981b",
    "hardware/fab/test/canary-ODB++.zip": "a89725a097a9dcc1ba502a8e89bc88da8a31033aa7369461aa838fb4395d6c74",
    "hardware/fab/generic/canary-gerbers.zip": "b93ee8d6fbfbb6f6fe7d2afc6e2d37fa7588961d8a935dc7febe1969e1f69a94",
}
CANARY_ODB_MEMBERS = (
    "misc/info",
    "matrix/matrix",
    "steps/pcb/profile",
    "steps/pcb/layers/drill_plated_f.cu-b.cu/features",
)
CANARY_GERBER_MEMBERS = (
    "dbcanary-PTH.drl",
    "dbcanary-NPTH.drl",
    "dbcanary-F_Mask.gts",
    "dbcanary-B_Mask.gbs",
    "dbcanary-F_Paste.gtp",
    "dbcanary-F_Silkscreen.gto",
)


def verified_inputs(cache, offline, upstream, revision, files):
    from fetch import checked, fetch

    source = f"https://raw.githubusercontent.com/{upstream}/{revision}/"
    inputs = {}
    for filename, digest in files.items():
        name = Path(filename).name
        local = cache / name
        if local.is_file():
            inputs[name] = checked(local.read_bytes(), digest, name)
        else:
            if offline:
                raise FileNotFoundError(f"Missing pinned reference input: {local}")
            inputs[name] = checked(fetch(source + quote(filename)), digest, name)
            local.write_bytes(inputs[name])
    return inputs


def zip_members(data, names):
    with ZipFile(BytesIO(data)) as archive:
        return {name: archive.read(name).decode("ascii") for name in names}


def compare(cache, offline, canary):
    if canary:
        upstream, revision, folder = CANARY_UPSTREAM, CANARY_REVISION, "hardware"
        inputs = verified_inputs(cache, offline, upstream, revision, CANARY_FILES)
        sources = ["canary.kicad_pcb", "canary.kicad_pro"]
        entries = zip_members(inputs["canary-ODB++.zip"], CANARY_ODB_MEMBERS)
        entries.update(zip_members(inputs["canary-gerbers.zip"], CANARY_GERBER_MEMBERS))
    else:
        upstream, revision, folder = UPSTREAM, REVISION, "samples"
        inputs = verified_inputs(cache, offline, upstream, revision, FILES)
        sources = ["test.kicad_pcb"]
        entries = zip_members(inputs["test-odb.zip"], MEMBERS)

    repo = PUBLIC["ROOT"]
    modules = [(name, str(file)) for name, file in PUBLIC["resolve"](PUBLIC["MODULES"])]
    modules.extend((name, str(repo / "app" / (name + ".js"))) for name in PUBLIC["TRANSLATORS"])
    repository = f"https://github.com/{upstream}"
    payload = {
        "modules": modules,
        "entries": entries,
        "sources": {name: inputs[name].decode("utf8") for name in sources},
        "fixture": {
            "source": f"{repository}/tree/{revision}/{folder}",
            "license": f"{repository}/blob/{revision}/LICENSE",
            "licenseId": "CERN-OHL-S-2.0" if canary else "GPL-3.0",
        },
        "canary": canary,
    }
    subprocess.run(["node", str(HERE / "support" / "odb-reference-kicad.cjs")],
                   cwd=repo, check=True, text=True, input=json.dumps(payload), timeout=120)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--cache", type=Path, help="Reuse verified fixture files in this external directory")
    parser.add_argument("--offline", action="store_true", help="Require all reference files in the supplied cache")
    parser.add_argument("--canary", action="store_true", help="Compare CANary instead of the FixturFab sample")
    args = parser.parse_args()
    if args.cache:
        cache = args.cache.resolve()
        if cache.is_relative_to(PUBLIC["ROOT"]):
            parser.error("--cache must be outside the repository")
        cache.mkdir(parents=True, exist_ok=True)
        compare(cache, args.offline, args.canary)
    elif args.offline:
        parser.error("--offline requires --cache")
    else:
        with tempfile.TemporaryDirectory(prefix="waffle-odb-reference-kicad-") as scratch:
            compare(Path(scratch), False, args.canary)


if __name__ == "__main__":
    main()
