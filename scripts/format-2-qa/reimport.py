#!/usr/bin/env python3
"""Stage immutable native Open inputs from pinned EDA sources using the shipping import and Save As."""

import argparse
import hashlib
import json
import os
from pathlib import Path
import stat
import subprocess
import sys
import tempfile
import zipfile
from contextlib import contextmanager

from cohort import input_table

HERE = Path(__file__).resolve().parent
SYNTHETIC_LEDGER = "7af9fe7ad4093a3b0dd7d913e7156fee14bd844080262a8376cd1058d877fa8c"
sys.path.insert(0, str(HERE.parent / "format-baseline"))
from sources import History, fidelity, selection
from fixtures import altium_set, external


class ResourceLimit(RuntimeError):
    pass


class EditorPreparationError(RuntimeError):
    pass


@contextmanager
def protected(case):
    try:
        yield
    except EditorPreparationError:
        raise
    except Exception:
        if case == "approved":
            raise RuntimeError("The approved design preparation or identity check failed") from None
        raise


def digest(data):
    return hashlib.sha256(data).hexdigest()


def read_private(config):
    if config is None:
        raise ValueError("The approved design requires an explicit protected local source grant")
    grant = json.loads(config.read_text())
    directory = Path(grant["repo"]).resolve(strict=True)
    reader = History(directory)
    pin = reader.revision(grant["revision"])
    files, missing = altium_set(reader, pin)
    if missing:
        raise ValueError("The approved original is missing a selected source member")
    return files, reader, pin, directory


def original(case, args):
    if case != "approved":
        files, pin = selection(case, args)
        return files, pin, None
    if args.approved_config:
        files, reader, pin, directory = read_private(args.approved_config)
        # The production read-only Git reader never refreshes the index. Check both its
        # namespace and the exact selected original blobs again after the run.
        commands = [["rev-parse", "--verify", "HEAD"], ["ls-files", "--stage", "-z"],
                    ["ls-files", "--modified", "--others", "--exclude-standard", "-z"]]
        command_hashes = [digest(reader.read(command, 8 * 1024 * 1024)) for command in commands]
        tracked = reader.read(["ls-files", "-z"], 8 * 1024 * 1024).split(b"\0")
        selected = {name.casefold() for name in files}
        working_files = {}
        for raw in tracked:
            if not raw:
                continue
            relative = Path(os.fsdecode(raw))
            if relative.name.casefold() not in selected:
                continue
            candidate = directory / relative
            if not candidate.resolve().is_relative_to(directory) or candidate.is_symlink():
                raise ValueError("The private working file does not resolve to a regular file in the approved repository")
            working_files[relative.as_posix()] = digest(candidate.read_bytes()) if candidate.is_file() else None
        state = {"git": command_hashes, "workingFiles": working_files}
        return files, pin, state
    files, _ = selection(case, args)
    return files, None, None


def source_state(files, pin, repo_state):
    return {"revision":pin, "members":{name:digest(data) for name, data in files.items()},
            "repositoryState":repo_state}


def file_inventory(folder):
    rows = {}
    for member in sorted(folder.rglob("*")):
        relative = member.relative_to(folder).as_posix()
        if member.is_symlink():
            raise ValueError("A prepared project contains a symbolic link")
        if member.is_file() and not relative.startswith(".waffle/local/"):
            content = member.read_bytes()
            rows[relative] = {"sha256":digest(content), "bytes":len(content)}
    return rows


def historical_dense(args):
    frozen = args.synthetic.resolve(strict=True) / "design"
    inventory = file_inventory(frozen)
    ledger = [[name, row["bytes"], row["sha256"]] for name, row in inventory.items()]
    if digest(json.dumps(ledger, separators=(",", ":")).encode()) != SYNTHETIC_LEDGER:
        raise ValueError("The synthetic control does not match its published member ledger")
    return frozen, inventory


def preparation_runtime(product):
    def ledger(directory):
        rows = [[file.relative_to(product).as_posix(), file.stat().st_size, digest(file.read_bytes())]
                for file in sorted(directory.rglob("*")) if file.is_file() and "__pycache__" not in file.parts]
        if not rows:
            raise ValueError("The preparation runtime is missing required files")
        return {"members":len(rows), "sha256":digest(json.dumps(rows, separators=(",", ":")).encode())}
    return {"app":ledger(product / "app"), "mcp":ledger(product / "mcp"),
            "bridgeSHA256":digest((product / "native/bridge.js").read_bytes()), "macOSSource":ledger(product / "native/macos")}


def write_json(path, record, *, exclusive=False):
    mode = os.O_WRONLY | os.O_CREAT | (os.O_EXCL if exclusive else os.O_TRUNC)
    with os.fdopen(os.open(path, mode, 0o600), "w") as stream:
        json.dump(record, stream, indent=2)
        stream.write("\n")


def call(args, argv, *, private=False):
    run = subprocess.run(argv, cwd=args.product, stdin=subprocess.DEVNULL, capture_output=True, timeout=300)
    if run.returncode:
        if b"exceeded its memory limit" in run.stderr:
            raise ResourceLimit("The headless import exceeded its memory limit")
        if private:
            raise RuntimeError("The private production import or verification failed")
        raise RuntimeError(run.stderr.decode(errors="replace")[-2000:])
    return json.loads(run.stdout)


def cli(args, manifest, command, settings, *flags, private=False):
    return call(args, [sys.executable, "-B", str(args.product / "mcp/server.py"), "--project", str(manifest),
                       *flags, "--cli", command, "--args", json.dumps(settings)], private=private)


def editor_save(args, prepared, original_dir, names, *, private):
    archive = original_dir / "native-archive.zip"
    payload = {"product":str(args.product), "sources":[str(original_dir / name) for name in names], "archive":str(archive), "private":private}
    run = subprocess.run([args.node, str(HERE / "open-reimport.cjs")], input=json.dumps(payload).encode(),
                         capture_output=True, cwd=args.product, timeout=350)
    if run.returncode:
        message = run.stderr.decode(errors="replace").strip()
        if not private and message:
            raise EditorPreparationError(message[-2000:])
        for phase in ("launch", "source open", "opening first Save", "selecting native Save As", "native ZIP download"):
            if message == f"The isolated editor did not complete {phase}.":
                raise EditorPreparationError(message)
        raise EditorPreparationError("The isolated editor did not complete the native import.")
    temporary = original_dir / "native-archive"
    temporary.mkdir()
    with zipfile.ZipFile(archive) as source:
        for entry in source.infolist():
            name = Path(entry.filename)
            if name.is_absolute() or ".." in name.parts or "\\" in entry.filename or stat.S_ISLNK(entry.external_attr >> 16):
                raise ValueError("The editor ZIP contained a nonportable member")
        source.extractall(temporary)
    manifests = [path for path in temporary.rglob("*.waffle") if path.is_file()]
    if len(manifests) != 1 or (prepared / "design").exists():
        raise ValueError("The editor ZIP did not contain a single native project")
    manifest = manifests[0]
    target = prepared / "design"
    manifest.parent.rename(target)
    return target / manifest.name


def stage_foreign(case, args, prepared, files):
    private = case == "approved"
    is_kicad = case in ("corne", "lily58")
    extension = ".kicad_pro" if is_kicad else ".prjpcb"
    primary, = (name for name in files if name.casefold().endswith(extension))
    with tempfile.TemporaryDirectory(prefix="original-", dir=prepared) as scratch:
        original_dir = Path(scratch)
        companions = []
        for name, data in files.items():
            if Path(name).name != name or not name or name in (".", ".."):
                raise ValueError("The source set contains a nonportable filename")
            with os.fdopen(os.open(original_dir / name, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600), "wb") as stream:
                stream.write(data)
            if name != primary:
                companions.extend(("--source-file", name))
        try:
            if case in args.editor_import:
                raise ResourceLimit("The editor was selected for this source set")
            saved = cli(args, original_dir / primary, "import_design",
                        {"mode":"save-as", "destination":"design", "translator":"kicad" if is_kicad else "altium"},
                        "--output-root", str(prepared), *companions, private=private)
            manifest = Path(saved["path"]).resolve(strict=True)
            if manifest.parent != prepared / "design" or saved["format"] != "2.0" or saved["retained_inputs"] != len(files):
                raise ValueError("The production import did not return a verified native folder and source count")
            writer = "production-cli-save-as"
        except ResourceLimit:
            manifest = editor_save(args, prepared, original_dir, [primary, *(name for name in files if name != primary)], private=private)
            writer = "editor-open-save-as-format-2-zip"
        for name, data in files.items():
            copy = (original_dir / name).read_bytes()
            retained = (manifest.parent / ".waffle/imports" / digest(data) / "source").read_bytes()
            if data != copy or data != retained:
                raise ValueError("An original or retained input differs from the pinned source")
    return manifest, writer


def inspect(args, manifest, inventory, *, private=False):
    members = call(args, [args.node, str(HERE / "open-inventory.cjs"), str(args.product), str(manifest)], private=private)
    summary = cli(args, manifest, "project_summary", {}, "--read-only", private=private)
    items = {doc["id"]:sum(doc["counts"].values()) for doc in summary["documents"]}
    active = members.pop("activeId")
    if len(items) != members["documents"] or not items.get(active) or summary.get("opaque_documents"):
        raise ValueError("The prepared project did not reopen with all required editable documents")
    files = list(inventory.items())
    models = [row for name, row in files if name.startswith("models/") and name.endswith(".gz")]
    asset_bytes = sum(row["bytes"] for name, row in files if name.startswith("assets/"))
    core_bytes = sum(row["bytes"] for name, row in files if not name.startswith(".waffle/imports/"))
    return {**members, "manifest":manifest.name, "activeId":active, "itemsByDocument":items,
            "items":[items[active], *[count for key, count in items.items() if key != active]],
            "models":len(models), "assetBytes":asset_bytes, "compressedBytes":sum(row["bytes"] for row in models),
            "coreBytes":core_bytes, "memberCount":len(files),
            "memberLedgerSHA256":digest(json.dumps(inventory, sort_keys=True, separators=(",", ":")).encode())}


def stage_one(args, case, prepared):
    corpus = input_table(args.baseline_inputs)
    private = case == "approved"
    files, pin, repo_state = original(case, args)
    guard = source_state(files, pin, repo_state)
    source_bytes = sum(map(len, files.values()))
    baseline = corpus[case]
    same_cohort = (len(files), source_bytes) == (int(baseline["sources"]), int(baseline["source_bytes"]))
    if not same_cohort and not (private and args.allow_updated_approved):
        raise ValueError("The pinned source count or byte total differs from the documented benchmark cohort")
    if case == "synthetic":
        frozen, frozen_inventory = historical_dense(args)
        geometry = call(args, [args.node, str(HERE / "open-dense.cjs"), str(args.product), str(frozen), str(prepared / "design")])
        if file_inventory(frozen) != frozen_inventory:
            raise ValueError("The historical dense control changed during re-authoring")
        inventory = file_inventory(prepared / "design")
        manifest = prepared / "design" / "project.waffle"
        writer = "amended-editor-writer-from-verified-dense-control"
    else:
        manifest, writer = stage_foreign(case, args, prepared, files)
        inventory = file_inventory(prepared / "design")
    meta = inspect(args, manifest, inventory, private=private)
    if file_inventory(prepared / "design") != inventory:
        raise ValueError("The prepared design changed during read-only reopen")
    if case == "synthetic" and (meta["items"] != [25600, 2] or len(inventory) != 4):
        raise ValueError("The synthetic control differs from the verified dense workload")
    write_json(prepared / "options.json", meta, exclusive=True)
    receipt = {"sourceFiles":len(files), "sourceBytes":source_bytes, "matchesHistoricalSourceCounts":same_cohort,
               "documents":meta["documents"], "items":sum(meta["items"]), "activeKind":meta["activeKind"],
               "activeItems":meta["items"][0], "memberCount":len(inventory), "nativeFolderVerified":True, "preparedWith":writer}
    if not private:
        receipt.update(sourceRevision=pin, sourceSHA256=guard["members"], memberLedgerSHA256=meta["memberLedgerSHA256"])
        memory_mib = os.environ.get("ATRIUM_MCP_MEMORY_MB", "")
        if writer == "production-cli-save-as" and memory_mib.isascii() and memory_mib.isdecimal():
            receipt["preparationCliMemoryMiB"] = int(memory_mib)
    if case == "synthetic":
        receipt.update(historicalDenseLedgerSHA256=SYNTHETIC_LEDGER, **geometry)
    return guard, receipt


def stage(args, cases):
    guard_file = args.prepared / "originals.local.json"
    receipt_file = args.prepared / "receipts.json"
    guards = json.loads(guard_file.read_text()) if args.append else {}
    receipts = json.loads(receipt_file.read_text()) if args.append else {}
    for case in cases:
        with protected(case):
            target = args.prepared / case
            if case in guards or case in receipts or target.exists():
                raise ValueError("The prepared case already exists")
            with tempfile.TemporaryDirectory(prefix="stage-", dir=args.prepared) as scratch:
                temporary = Path(scratch)
                guards[case], receipts[case] = stage_one(args, case, temporary)
                temporary.rename(target)
        write_json(guard_file, guards)
        write_json(receipt_file, receipts)
        print(case, "verified native fixture", flush=True)
    return receipts


def verify(args, cases):
    guards = json.loads((args.prepared / "originals.local.json").read_text())
    checks = {}
    for case in cases:
        with protected(case):
            files, pin, repo_state = original(case, args)
            unchanged = source_state(files, pin, repo_state) == guards[case]
            if case == "synthetic":
                historical_dense(args)
            options = json.loads((args.prepared / case / "options.json").read_text())
            inventory = file_inventory(args.prepared / case / "design")
            stable = digest(json.dumps(inventory, sort_keys=True, separators=(",", ":")).encode()) == options["memberLedgerSHA256"]
            checks[case] = {"originalBytesUnchanged":unchanged, "nativeSampleUnchanged":stable}
    write_json(args.prepared / "identity-check.json", checks)
    if not all(all(row.values()) for row in checks.values()):
        raise ValueError("An original source or prepared sample changed")
    return checks


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--product", type=Path, required=True)
    parser.add_argument("--prepared", type=Path, required=True)
    parser.add_argument("--baseline-inputs", type=Path, required=True, help="Pinned input TSV supplied by the caller")
    parser.add_argument("--synthetic", type=Path, required=True)
    parser.add_argument("--approved-config", type=Path, help="Protected temporary JSON with an authorized repo and revision")
    parser.add_argument("--approved-export", type=Path, help="Existing private export outside all checkouts")
    parser.add_argument("--allow-updated-approved", action="store_true", help="Use an explicitly pinned replacement approved cohort")
    parser.add_argument("--fidelity-cache", type=Path, default=fidelity.DEFAULT_CACHE)
    parser.add_argument("--history-cache", type=Path, default=Path.home() / ".cache/waffle/project-history")
    parser.add_argument("--node", default="node")
    parser.add_argument("--editor-import", action="append", default=[],
                        help="Prepare the selected case through the ordinary editor's first Save")
    mode = parser.add_mutually_exclusive_group()
    mode.add_argument("--verify", action="store_true")
    mode.add_argument("--append", action="store_true", help="Append selected cases to a verified protected scratch set")
    parser.add_argument("--case", action="append")
    args = parser.parse_args()
    args.product = args.product.resolve(strict=True)
    args.prepared = external(args.prepared)
    if args.approved_config:
        args.approved_config = external(args.approved_config)
        if args.approved_config.stat().st_mode & 0o077:
            raise ValueError("The optional private input grant must have private file permissions")
    corpus = input_table(args.baseline_inputs)
    cases = args.case or list(corpus)
    if any(case not in corpus for case in [*cases, *args.editor_import]):
        parser.error("Choose cases present in the pinned input TSV.")
    if len(cases) != len(set(cases)):
        parser.error("Choose each case at most once")
    old_mask = os.umask(0o077)
    try:
        args.prepared.mkdir(mode=0o700, parents=True, exist_ok=args.verify or args.append)
        if args.prepared.stat().st_mode & 0o077:
            raise ValueError("Prepared samples require a private scratch directory")
        runtime_receipt = args.prepared / "preparation-runtime.json"
        runtime = preparation_runtime(args.product)
        if args.verify:
            if runtime != json.loads(runtime_receipt.read_text()):
                raise ValueError("The frozen preparation runtime changed")
            verify(args, cases)
        else:
            if args.append and runtime != json.loads(runtime_receipt.read_text()):
                raise ValueError("The staged cohort uses a different preparation runtime")
            if not args.append:
                write_json(runtime_receipt, runtime, exclusive=True)
            if sys.platform == "darwin" and not os.environ.get("WAFFLE_FOLDER_MCP_HOST"):
                sys.path.insert(0, str(args.product / "tests"))
                from native_sample import ensure_native_host
                ensure_native_host()
            stage(args, cases)
            if preparation_runtime(args.product) != runtime:
                raise ValueError("Production resources changed while staging the exact cohort")
            verify(args, cases)
    finally:
        os.umask(old_mask)


if __name__ == "__main__":
    main()
