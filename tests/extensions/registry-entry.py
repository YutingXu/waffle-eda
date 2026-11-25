#!/usr/bin/env python3
"""v1 registry entries publish an integer API major.

The editor accepts a manifest apiVersion of 1, "1", or the historical "^1".
The registry stores that major as a JSON number. This builds temporary
packages from the supplied example manifests and entry scripts, then runs
scripts/registry-entry.py as a subprocess.

    python3 tests/extensions/registry-entry.py
"""
import hashlib
import json
import re
import subprocess
import sys
import tempfile
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
PUBLISHER = ROOT / "scripts" / "registry-entry.py"
EXAMPLES = ROOT / "extensions" / "examples"

# The inspection counter is the notebook widget. The local provider declares
# ai:provider and an explicit hosts list. The rail widget is the third supplied example.
CASES = (
    {
        "dir": "widget-inspection",
        "role": "notebook widget",
        "marker": "inspection.view",
        "id": "example.inspection",
        "permissions": ["ui:command", "ui:widgets"],
        "capability": ("widgets", "counter"),
    },
    {
        "dir": "ai-provider",
        "role": "local AI provider",
        "marker": "approved rows",
        "id": "waffle.local-ai-example",
        "permissions": ["ai:provider"],
        "capability": ("aiProviders", "local"),
    },
    {
        "dir": "widget-rail",
        "role": "rail specification",
        "marker": "inputs.rail",
        "id": "example.rail",
        "permissions": ["ui:command", "ui:widgets", "read:project"],
        "capability": ("widgets", "supply"),
    },
)
# kind, registry major, how the package itself must still spell the declaration.
SPELLINGS = ("number", "string", "caret")
KINDS = (
    ("number", 1),
    ("string", 1),
    ("caret", 1),
    ("missing", 1),
    ("future", 2),
)

problems = []


def check(ok, what):
    print(("ok    " if ok else "FAIL  ") + what)
    if not ok:
        problems.append(what)


def spell(text, kind):
    needle = '"apiVersion": 1'
    if text.count(needle) != 1:
        raise SystemExit(f"manifest does not contain exactly one {needle}")
    if kind == "number":
        return text
    if kind == "string":
        return text.replace(needle, '"apiVersion": "1"', 1)
    if kind == "caret":
        return text.replace(needle, '"apiVersion": "^1"', 1)
    if kind == "missing":
        line = '  "apiVersion": 1,\n'
        if line not in text:
            raise SystemExit("manifest apiVersion line is not removable")
        return text.replace(line, "", 1)
    if kind == "future":
        return text.replace(needle, '"apiVersion": 2', 1)
    raise SystemExit(kind)


def without_api(manifest):
    body = dict(manifest)
    body.pop("apiVersion", None)
    return body


def integer_token(stdout, expected):
    return re.search(r'"apiVersion":\s*%s(?![\d.])' % expected, stdout) is not None


def write_bundle(path, manifest_text, files):
    bundle = {"manifest": json.loads(manifest_text), "files": files}
    path.write_text(json.dumps(bundle, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")


def write_zip(path, folder, manifest_text, files):
    with zipfile.ZipFile(path, "w", compression=zipfile.ZIP_DEFLATED) as archive:
        archive.writestr(folder + "/", "")
        archive.writestr(folder + "/waffle-extension.json", manifest_text)
        for name, body in files.items():
            archive.writestr(folder + "/" + name, body)


def read_manifest(path):
    data = path.read_bytes()
    if data[:2] == b"PK":
        with zipfile.ZipFile(path) as archive:
            names = [name for name in archive.namelist()
                     if name == "waffle-extension.json" or name.endswith("/waffle-extension.json")]
            if len(names) != 1:
                raise AssertionError(f"{path.name} has {len(names)} manifests")
            return json.loads(archive.read(names[0]))
    return json.loads(data)["manifest"]


def publish(path, download):
    before = path.read_bytes()
    proc = subprocess.run(
        [sys.executable, str(PUBLISHER), str(path), "--download", download],
        capture_output=True, text=True,
    )
    after = path.read_bytes()
    if proc.returncode != 0:
        detail = (proc.stderr or proc.stdout).strip() or f"exited {proc.returncode}"
        raise AssertionError(detail)
    return json.loads(proc.stdout), proc.stdout, before, after


def comparable(entry):
    body = dict(entry)
    body.pop("sha256", None)
    body.pop("size", None)
    return body


def differing(left, right):
    keys = sorted(set(left) | set(right))
    return ", ".join(f"{key}: {left.get(key)!r} vs {right.get(key)!r}" for key in keys if left.get(key) != right.get(key))


def load_examples():
    loaded = []
    for case in CASES:
        folder = EXAMPLES / case["dir"]
        manifest_path = folder / "waffle-extension.json"
        text = manifest_path.read_text(encoding="utf-8")
        manifest = json.loads(text)
        script_path = folder / manifest["main"]
        script = script_path.read_text(encoding="utf-8")
        if case["marker"] not in script:
            raise SystemExit(f"{case['dir']} entry script is not the supplied example")
        if manifest.get("id") != case["id"] or manifest.get("permissions") != case["permissions"]:
            raise SystemExit(f"{case['dir']} manifest is not the supplied example")
        if manifest.get("version") != "1.0.0":
            raise SystemExit(f"{case['dir']} version changed")
        group, capability = case["capability"]
        contributed = manifest.get("contributes", {}).get(group, [])
        if not any(item.get("id") == capability for item in contributed):
            raise SystemExit(f"{case['dir']} is missing {group} {capability}")
        loaded.append({
            **case,
            "text": text,
            "manifest": manifest,
            "script": script,
            "manifest_bytes": manifest_path.read_bytes(),
            "script_bytes": script_path.read_bytes(),
            "manifest_path": manifest_path,
            "script_path": script_path,
        })
    roles = {item["role"] for item in loaded}
    if "notebook widget" not in roles or "local AI provider" not in roles:
        raise SystemExit("notebook widget and local AI provider examples are required")
    return loaded


def check_other_versions(root, item):
    values = (True, False, 1.0, "01", "1.0", "^1 ", "2", "^2", [], {}, None)
    manifest = dict(item["manifest"])
    files = {manifest["main"]: item["script"]}
    for index, value in enumerate(values):
        manifest["apiVersion"] = value
        path = root / f"other-version-{index}.waffle-extension"
        write_bundle(path, json.dumps(manifest), files)
        entry, _, _, _ = publish(path, "https://example.org/package.waffle-extension")
        if value is None:
            check("apiVersion" not in entry, "null apiVersion remains omitted from the index")
        else:
            published = entry.get("apiVersion")
            check(type(published) is type(value) and published == value,
                  f"apiVersion {value!r} ({type(value).__name__}) passes through unchanged")


def package_spelling_ok(kind, packed):
    api = packed.get("apiVersion", None)
    if kind == "number":
        return type(api) is int and api == 1
    if kind == "string":
        return api == "1"
    if kind == "caret":
        return api == "^1"
    if kind == "missing":
        return "apiVersion" not in packed
    if kind == "future":
        return type(api) is int and api == 2
    return False


def main():
    if not PUBLISHER.is_file():
        raise SystemExit(f"missing publisher: {PUBLISHER}")
    loaded = load_examples()
    provider = next(item for item in loaded if item["role"] == "local AI provider")
    hosts = provider["manifest"]["contributes"]["aiProviders"][0]["hosts"]
    check(isinstance(hosts, list), f"local AI provider host declaration is {hosts!r}")

    digests = []
    with tempfile.TemporaryDirectory(prefix="registry-entry-") as temp:
        root = Path(temp)
        check_other_versions(root, provider)
        for item in loaded:
            files = {item["manifest"]["main"]: item["script"]}
            published = {kind: {} for kind in ("bundle", "zip")}
            for kind, expected in KINDS:
                spelled = spell(item["text"], kind)
                spelled_manifest = json.loads(spelled)
                check(without_api(spelled_manifest) == without_api(item["manifest"]),
                      f"{item['role']} {kind}: fixture keeps version, capabilities and hosts")
                for package_kind, suffix in (("bundle", "waffle-extension"), ("zip", "zip")):
                    download = f"https://example.org/packages/{item['id']}-{item['manifest']['version']}.{suffix}"
                    path = root / f"{item['dir']}-{kind}.{suffix}"
                    if package_kind == "bundle":
                        write_bundle(path, spelled, files)
                    else:
                        write_zip(path, item["dir"], spelled, files)
                    label = f"{item['role']} {kind} {package_kind}"
                    try:
                        entry, stdout, before, after = publish(path, download)
                    except AssertionError as exc:
                        check(False, f"{label}: publisher failed: {exc}")
                        continue
                    digest = hashlib.sha256(before).hexdigest()
                    digests.append((before, digest))
                    packed = read_manifest(path)
                    api = entry.get("apiVersion")
                    publisher_name = item["manifest"].get("publisher") or item["id"].split(".")[0]
                    notes = []
                    if type(api) is not int or api != expected:
                        notes.append(f"apiVersion {api!r} ({type(api).__name__}), expected integer {expected}")
                    elif not integer_token(stdout, expected):
                        notes.append(f"apiVersion JSON token is not the integer {expected}")
                    if entry.get("permissions") != item["permissions"]:
                        notes.append(f"permissions {entry.get('permissions')!r}")
                    if entry.get("version") != item["manifest"]["version"]:
                        notes.append(f"version {entry.get('version')!r}")
                    if entry.get("id") != item["id"] or entry.get("name") != item["manifest"]["name"]:
                        notes.append(f"id/name {entry.get('id')!r} {entry.get('name')!r}")
                    if entry.get("publisher") != publisher_name:
                        notes.append(f"publisher {entry.get('publisher')!r}")
                    if entry.get("download") != download:
                        notes.append(f"download {entry.get('download')!r}")
                    if entry.get("description") != item["manifest"].get("description", ""):
                        notes.append(f"description {entry.get('description')!r}")
                    if entry.get("sha256") != digest or type(entry.get("size")) is not int or entry["size"] != len(before):
                        notes.append(f"digest/size {entry.get('sha256')} {entry.get('size')} != {digest} {len(before)}")
                    if before != after:
                        notes.append("package bytes changed")
                    if without_api(packed) != without_api(item["manifest"]) or not package_spelling_ok(kind, packed):
                        notes.append(f"package manifest apiVersion {packed.get('apiVersion', '<missing>')!r}")
                    if item["role"] == "local AI provider":
                        packed_hosts = packed["contributes"]["aiProviders"][0]["hosts"]
                        if packed_hosts != hosts:
                            notes.append(f"hosts {packed_hosts!r}")
                    check(not notes, label + (": " + "; ".join(notes) if notes else
                          f": apiVersion {expected} (int), permissions {item['permissions']!r}, digest {digest[:12]}"))
                    if not notes:
                        published[package_kind][kind] = entry
            for package_kind, entries in published.items():
                if not all(name in entries for name in SPELLINGS):
                    check(False, f"{item['role']} {package_kind}: could not compare the three spellings")
                    continue
                base = comparable(entries["number"])
                same = all(comparable(entries[name]) == base for name in SPELLINGS)
                detail = "same entry aside from digest and size"
                if not same:
                    detail = "; ".join(f"{name} differs ({differing(base, comparable(entries[name]))})" for name in SPELLINGS if comparable(entries[name]) != base)
                check(same, f"{item['role']} {package_kind}: three spellings publish the {detail}")
                hashes = {entries[name]["sha256"] for name in SPELLINGS}
                check(len(hashes) == 3, f"{item['role']} {package_kind}: three spellings have three digests ({len(hashes)})")

    check(len({blob for blob, _digest in digests}) == len(digests) and len({digest for _blob, digest in digests}) == len(digests),
          f"different package bytes have different digests ({len(digests)} packages)")
    check(all(hashlib.sha256(blob).hexdigest() == digest for blob, digest in digests),
          "each digest was calculated again from the original package bytes")
    for item in loaded:
        check(item["manifest_path"].read_bytes() == item["manifest_bytes"], f"{item['dir']} manifest on disk unchanged")
        check(item["script_path"].read_bytes() == item["script_bytes"], f"{item['dir']} entry script on disk unchanged")

    if problems:
        print(f"registry-entry: {len(problems)} failed")
        return 1
    print("registry-entry: ok")
    return 0


if __name__ == "__main__":
    sys.exit(main())
