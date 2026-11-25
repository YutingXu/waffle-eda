"""List the verified source documents in the optional local fidelity corpus."""
import json
from pathlib import Path
import sys

fidelity = Path(__file__).resolve().parents[1] / "altium-fidelity"
if not (fidelity / "fetch.py").is_file():
    sys.exit("The optional public run needs tests/altium-fidelity and its verified local cache.")
sys.path.insert(0, str(fidelity))
import fetch  # the fidelity manifest's own offline verifier

cases = []
for project in fetch.manifest():
    if not (fetch.DEFAULT_CACHE.expanduser() / project["id"] / project["revision"]).is_dir():
        sys.exit("Missing local fidelity cache for " + project["id"])
    directory, _ = fetch.verified(project, fetch.DEFAULT_CACHE, offline=True)
    for asset in project["assets"]:
        for name, item in fetch.entries(asset):
            suffix = Path(name).suffix.lower()
            if item["role"] == "source" and suffix in {".schdoc", ".pcbdoc", ".schlib", ".pcblib"}:
                p = directory / name
                cases.append({"project": project["id"], "name": name, "path": str(p),
                              "size": p.stat().st_size, "sha256": item["sha256"], "suffix": suffix[1:]})
print(json.dumps(cases))
