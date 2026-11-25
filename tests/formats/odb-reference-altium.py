#!/usr/bin/env python3
"""Compare Waffle with the author's release-matched Altium ODB++ and IPC-D-356A."""

import argparse
from io import BytesIO
import json
from pathlib import Path
from re import findall, fullmatch
from runpy import run_path
import subprocess
import tarfile
import tempfile
import zipfile


HERE = Path(__file__).resolve().parents[1]
PUBLIC = run_path(str(HERE / "formats/odb-public.py"))
from fetch import HOSTS, MAX_FILE, checked, fetch

FIXTURE = json.loads((HERE / "fixtures" / "odb-reference-altium.json").read_text())
MEMBER_LIMIT = 8_000_000
ARTWORK = r"matrix/matrix|misc/info|steps/pcb/(?:profile|eda/data|netlists/cadnet/netlist|layers/[^/]+/(?:features|tools|components))"


def extract(scratch, release_data):
    files = {}
    with zipfile.ZipFile(BytesIO(checked(release_data, FIXTURE["releaseSha256"], FIXTURE["project"]))) as release:
        for member in FIXTURE["members"]:
            info = release.getinfo(member["path"])
            if info.file_size > MEMBER_LIMIT:
                raise ValueError(f"Fixture member {info.filename} exceeds the size limit")
            files[member["role"]] = checked(release.read(info), member["sha256"], member["path"])
    assert b"Creative Commons Attribution 4.0" in files["license"]
    assert ("v" + FIXTURE["hardwareRevision"]).encode() in files["changelog"]
    assert b"OutputType1=ODB" in files["outputJob"]
    config = next(line for line in files["outputJob"].splitlines() if line.endswith(b"|Record=ODBView"))
    include = findall(rb"\|IncludeUnconnectedMidLayerPads=(True|False)\|", config)
    assert include == [b"False"]

    vendor = {}
    with tarfile.open(fileobj=BytesIO(files["vendorOdb"]), mode="r:gz") as archive:
        for item in archive:
            key = item.name.removeprefix("odb/")
            if item.isfile() and item.name.startswith("odb/") and fullmatch(ARTWORK, key):
                if item.size > MEMBER_LIMIT or key in vendor:
                    raise ValueError("Invalid Altium ODB++ member: " + key)
                vendor[key] = archive.extractfile(item).read().decode("latin1")

    info = vendor["misc/info"]
    assert "ODB_SOURCE=Altium Designer" in info
    assert "SAVE_APP=Altium Designer " + FIXTURE["altiumVersion"] in info
    assert "CREATION_DATE=" + FIXTURE["exportCreated"] in info
    major, minor = FIXTURE["altiumOdbVersion"].split(".")
    assert f"ODB_VERSION_MAJOR={major}" in info and f"ODB_VERSION_MINOR={minor}" in info
    source = next(Path(m["path"]).name for m in FIXTURE["members"] if m["role"] == "source")
    (scratch / source).write_bytes(files["source"])
    return source, vendor, files["ipc356"].decode("ascii"), include[0] == b"True"


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--archive", type=Path, help="Read a local copy of the pinned Fraunhofer release ZIP")
    parser.add_argument("--retain-unconnected", action="store_true", help="Measure Waffle's default preservation of inner lands")
    args = parser.parse_args()
    if args.archive:
        with args.archive.expanduser().open("rb") as stream:
            release = stream.read(MAX_FILE + 1)
    else:
        HOSTS.add("iisb-foxbms.iisb.fraunhofer.de")
        release = fetch(FIXTURE["releaseUrl"])

    root = PUBLIC["ROOT"]
    modules = [(name, str(file)) for name, file in PUBLIC["resolve"]((*PUBLIC["MODULES"], "odb", "netlist"))]
    modules.extend((name, str(root / "app" / (name + ".js"))) for name in PUBLIC["TRANSLATORS"] if name != "translator-table")
    with tempfile.TemporaryDirectory(prefix="waffle-altium-reference-") as directory:
        source, vendor, ipc356, include = extract(Path(directory), release)
        payload = {"modules": modules, "source": str(Path(directory) / source), "vendor": vendor, "ipc356": ipc356,
                   "omitUnconnectedMidLayerPads": not include and not args.retain_unconnected}
        subprocess.run(["node", "--max-old-space-size=1536", str(HERE / "support" / "odb-reference-altium.cjs")],
                       cwd=root, input=json.dumps(payload), text=True, check=True, timeout=240)


if __name__ == "__main__":
    main()
