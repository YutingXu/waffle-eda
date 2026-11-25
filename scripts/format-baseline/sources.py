"""Pinned release selections. Private data may only be read from a previously exported scratch folder."""
import base64
import hashlib
import json
from pathlib import Path
import stat
import sys
import tempfile

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "tests" / "real-design-tour"))
from fixtures import DESIGN_EXT, History, KICAD, altium_members, external, fidelity, kicad_set

PUBLIC = [p["id"] for p in fidelity.manifest()] + ["corne", "lily58"]
CASES = [*PUBLIC, "synthetic", "approved"]


def read_approved(directory):
    if not directory:
        raise ValueError("Choose an already exported temporary design with --approved-export.")
    base = external(directory)
    if not base.is_relative_to(Path(tempfile.gettempdir()).resolve()) or base == Path(tempfile.gettempdir()).resolve():
        raise ValueError("The approved design must already be exported into its own temporary directory.")
    design = {}
    for f in base.iterdir():
        if f.suffix.lower() in DESIGN_EXT | {".prjpcb"}:
            mode = f.lstat().st_mode
            if not stat.S_ISREG(mode) or f.stat().st_size > 256 * 1024 * 1024:
                raise ValueError("The temporary export contains an unsupported input.")
            design[f.name] = f.read_bytes()
    return design


def selection(case, args):
    if case == "synthetic":
        return {}, None
    if case in ("corne", "lily58"):
        name, head, stem, _, _ = KICAD[case]
        reader = History(args.history_cache.expanduser() / name)
        assert reader.revision(head) == head
        return kicad_set(reader, head, stem), head
    if case == "approved":
        design, head = read_approved(args.approved_export), None
    else:
        row = next(p for p in fidelity.manifest() if p["id"] == case)
        directory, resources = fidelity.verified(row, args.fidelity_cache, True)
        design = {f["name"]: (directory / f["name"]).read_bytes() for f in resources if f["role"] == "source"}
        head = row["revision"]
    manifest, = [p for p in design if p.lower().endswith(".prjpcb")]
    members, missing = altium_members(manifest, design[manifest], design, flat=True)
    if any(m in (".schdoc", ".pcbdoc") for m in missing):
        raise ValueError("An exported project is missing a selected drawing.")
    return {name: design[name] for name in members}, head


def materialize_choices(root, members, message):
    sources = Path(root) / "sources"
    sources.mkdir()
    destination = Path(root) / "project"
    destination.mkdir()
    choices = []
    for name, body in members.items():
        if Path(name).name != name:
            raise ValueError(message)
        selected = sources / name
        selected.write_bytes(body)
        choices.append({"name": name, "selectedPath": str(selected)})
    return choices, destination


def prepare(case, args, scratch, run):
    files, head = selection(case, args)
    source_hashes = {name: hashlib.sha256(content).digest() for name, content in files.items()}
    payload = {"synthetic": case == "synthetic", "files": [
        {"name": name, "bytes": base64.b64encode(data).decode()} for name, data in files.items()]}
    target = scratch / "project.waffle"
    proc = run(["node", str(ROOT / "scripts/format-baseline/prepare.cjs"), str(target)],
               input=json.dumps(payload).encode(), capture_output=True, timeout=240)
    if proc.returncode:
        if case == "approved":
            raise RuntimeError("The temporary approved design did not prepare.")
        raise RuntimeError(proc.stderr.decode(errors="replace")[-2000:])
    summary = json.loads(proc.stdout)
    if case == "approved":
        later, _ = selection(case, args)
        if source_hashes != {name: hashlib.sha256(data).digest() for name, data in later.items()}:
            raise RuntimeError("The approved export changed during preparation.")
    return {**summary, "sourceFiles": len(files), "sourceBytes": sum(map(len, files.values())), "bytes": target.stat().st_size, "allocatedBytes": target.stat().st_blocks * 512,
            **({"revision": head} if head else {})}
