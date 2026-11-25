#!/usr/bin/env python3
"""Lock native format contracts, released examples, independent stores and immutable negative fixtures."""
import argparse
import ast
import hashlib
import json
from pathlib import Path
import re
import sys

ROOT = Path(__file__).resolve().parents[1]
DESKTOP_RELEASE = ROOT / "app/editor/update-check.js"
CORPUS = ROOT / "tests" / "fixtures" / "compat"
GUARD = CORPUS / "guard.json"
NATIVE_CORPUS = ROOT / "tests/fixtures/format-2"
NATIVE_VECTOR = ROOT / "native/tests/folder-transaction/additive.json"
NATIVE_SCHEMA = ROOT / "integrations/vscode/schema/waffle-folder-record.schema.json"


def sha(data):
    return hashlib.sha256(data if isinstance(data, bytes) else data.encode("utf-8")).hexdigest()


def corpus_files():
    """Every corpus file (projects/ and stores/), by its path under tests/fixtures/compat."""
    out = {p.name: sha(p.read_bytes()) for p in sorted((CORPUS / "projects").iterdir()) if p.suffix in (".waffle", ".atrium")}
    out.update({"stores/" + p.name: sha(p.read_bytes()) for p in sorted((CORPUS / "stores").iterdir()) if p.is_file()})
    return out


def corpus_digest():
    parts = [sha(json.dumps(corpus_files(), sort_keys=True))]
    for name in ("index.json", "snapshots.json", "files.json"):
        path = CORPUS / name
        parts.append(sha(path.read_bytes()) if path.exists() else "-")
    return sha("|".join(parts))


def folder_state():
    codec = (ROOT / "app/formats/format-2-codec.js").read_text()
    model = (ROOT / "app/formats/format-2-model.js").read_text()
    query_record = (ROOT / "app/checks/design-query-record.js").read_text()
    upgrades = (ROOT / "app/formats/format-2-upgrades.js").read_text()
    version = re.search(r'const FORMAT = "(\d+\.\d+)"', codec)
    if not version:
        raise SystemExit("The native codec must declare its current FORMAT.")
    # Digest the registered kinds and the accepted header/member contract. The row index,
    # projection, transport and storage code may be refactored independently.
    contract = [codec[codec.index("const documentSuffix"):codec.index("const digestRE")],
                codec[codec.index("function readVersion"):codec.index("function byteLength")],
                model[model.index("const ITEM_KINDS"):model.index("const SOURCE_DOCUMENT")],
                query_record[query_record.index("const languageVersion"):query_record.index("const quote")],
                model[model.index("const scopeFields"):model.index("function outputDefaults(")],
                model[model.index("function manifest(file)"):model.index("function archiveDesign(")], upgrades]
    source = re.sub(r"//[^\n]*", "", "\n".join(contract))
    files = sorted(p for p in NATIVE_CORPUS.rglob("*") if p.is_file()) + [NATIVE_VECTOR]
    return {"version": version.group(1), "contract": sha(re.sub(r"\s+", "", source)),
            "schema": sha(NATIVE_SCHEMA.read_bytes()),
            "files": {p.relative_to(ROOT).as_posix(): sha(p.read_bytes()) for p in files}}


def folder_problems(recorded, now):
    errors = []
    version = now["version"]
    declared = re.search(r"const FORMATS = (\[\[.*?\]\]);", DESKTOP_RELEASE.read_text())
    desktop = json.loads(declared.group(1)) if declared else []
    definitions = json.loads(NATIVE_SCHEMA.read_text())["$defs"]
    schema_version = definitions["version"]["default"]
    binding = re.search(r'const FORMAT = "(\d+\.\d+)", HEADER_KIND = "([^"]+)"', (ROOT / "app/formats/import-sidecars.js").read_text())
    registered_kinds = definitions["header"]["properties"]["kind"]["enum"]
    if not binding or binding.group(1) != version or binding.group(2) not in registered_kinds:
        errors.append("The retained-source binding stamp and header kind must match the folder registry and schema.")
    if not desktop or desktop[-1][0] != version or any(int(v.split(".")[0]) < 2 for v, _ in desktop) or schema_version != version:
        errors.append("The released desktop format, native record schema and codec must declare the same native version.")
    automation = ast.parse((ROOT / "mcp/automation.py").read_text())
    registry = next((ast.literal_eval(n.value) for n in automation.body if isinstance(n, ast.Assign)
                     and any(isinstance(t, ast.Name) and t.id == "PROJECT_FORMATS" for t in n.targets)), {})
    if registry != {"folder": version}:
        errors.append("The headless project registry must advertise the native folder writer.")
    index = json.loads((NATIVE_CORPUS / "projects.json").read_text())
    registered = [Path(row["directory"]) / row["manifest"] for row in index]
    available = {path.relative_to(NATIVE_CORPUS) for path in NATIVE_CORPUS.rglob("*.waffle") if path.is_file()}
    if len(registered) != len(set(registered)) or set(registered) != available:
        errors.append("The native compatibility index must name every fixture manifest exactly once.")
    if any(not re.fullmatch(r"[0-9a-f]{64}", row["sha256"]) for row in index):
        errors.append("The native compatibility index needs a complete closure digest for every fixture.")
    for name, digest in recorded.get("files", {}).items():
        if name == "tests/fixtures/format-2/projects.json":
            # A new immutable design may be appended without redefining an earlier row.
            entries = json.loads((NATIVE_CORPUS / "projects.json").read_text())
            if any(sha(json.dumps(entries[:n], indent=2) + "\n") == digest for n in range(len(entries)+1)):
                continue
        if now["files"].get(name) != digest:
            errors.append(name + " is an immutable native fixture. Restore its bytes and add a new fixture.")
    return errors


def main(argv):
    parser = argparse.ArgumentParser(description=__doc__)
    mode = parser.add_mutually_exclusive_group()
    mode.add_argument("--check", action="store_true")
    mode.add_argument("--update", action="store_true")
    parser.add_argument("--refactor", metavar="REASON")
    args = parser.parse_args(argv)
    recorded = json.loads(GUARD.read_text())
    folder, files = folder_state(), corpus_files()
    previous = recorded["folder"]
    errors = folder_problems(previous, folder)
    for name, expected in recorded["files"].items():
        if files.get(name) != expected:
            errors.append("Immutable compatibility fixture changed or disappeared: " + name)
    now = {"folder": folder, "files": files, "corpus": corpus_digest()}
    if args.update:
        contract = (previous["contract"], previous["schema"]) != (folder["contract"], folder["schema"])
        if contract and previous["version"] == folder["version"] and previous["files"] == folder["files"] and not args.refactor:
            errors.append("The native contract changed. Add a native fixture, bump its version or record a behavior-preserving --refactor.")
    elif any(recorded.get(k) != v for k, v in now.items()):
        errors.append("The native contract or compatibility corpus changed. Review the change and run --update.")
    if errors:
        print("\n".join("FAIL  " + e for e in errors))
        return 1
    if args.update:
        history = list(recorded.get("folderHistory", []))
        if folder != previous:
            history.append({"version": folder["version"], "contract": folder["contract"][:16],
                            "why": args.refactor or "native compatibility corpus updated"})
        now["folderHistory"] = history
        # Retain the historical audit trail. Its version numbers describe retired preview builds.
        now["history"] = recorded.get("history", [])
        GUARD.write_text(json.dumps(now, indent=1, sort_keys=True) + "\n")
    print("ok: %d immutable negative designs and native folder %s (%d physical fixtures)" %
          (len([name for name in files if not name.startswith("stores/")]), folder["version"], len(folder["files"])))
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
