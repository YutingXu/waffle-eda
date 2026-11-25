"""ECAD-MCAD exchange tools for the Waffle MCP server (docs/mcad.md; the JavaScript side is mcp/mcad.js
over app/mcad*.js):

  mcad_status          read-only: the board's IDX baseline, changes since it, pending MCAD proposals,
                       the identity map size and, given an enclosure STEP, the enclosure clearance
  import_mcad_changes  read an IDX (.idx/.xml), IDF (.emn) or STEP board file from MCAD and return its
                       proposals; accept / reject some or all. Finishes like every edit: a .waffle-ai
                       proposal by default, a write only with mode "write" on a --allow-write server
  export_idx           an IDX baseline, IDX changes, an IDX response or IDF 3.0 into <project>-outputs/mcad/;
                       recording the baseline in the project is itself a proposal (or a write)

Input files are read only from inside the project folder, with size caps; XML is read by the safe
reader in app/formats/mcad-xml.js (no DTD, no entities) and STEP by the bounded reader in app/step-import.js.
Nothing referenced by a file (3D models, schema locations) is fetched.
"""
from pathlib import Path
import re

from board_runner import MODULES, HERE

MODULES.setdefault("mcad-headless", (HERE / "mcad.js", ("headless", "mcad", "mcad-idx", "mcad-idf"), False))

TOOLS = ("mcad_status", "import_mcad_changes", "export_idx")
FILES = {"idx": re.compile(r"\.(idx|xml)$", re.I), "idf": re.compile(r"\.(emn|idf|brd)$", re.I), "step": re.compile(r"\.(step|stp)$", re.I)}
CAPS = {"idx": 64 * 2**20, "idf": 32 * 2**20, "step": 32 * 2**20}
COVERAGE = {"export-idx-baseline": ("tool", "export_idx"), "export-idx-changes": ("tool", "export_idx"), "export-idx-response": ("tool", "export_idx"),
            "export-idf": ("tool", "export_idx"), "import-idx": ("tool", "import_mcad_changes"), "import-step-outline": ("tool", "import_mcad_changes"),
            "import-enclosure": ("tool", "mcad_status"), "mcad-panel": ("tool", "mcad_status")}


def tools(T, edit, page):
    import automation as AU
    note = AU.UNTRUSTED_NOTE
    doc = {"type": "string", "maxLength": 256, "description": "PCB document ID. Defaults to the first PCB layout."}
    path = {"type": "string", "maxLength": 1024, "description": "A file inside the project folder."}
    ids = {"type": ["string", "array"], "pattern": "^all$", "maxLength": 3, "items": {"type": "string", "maxLength": 32}, "maxItems": 5000,
           "description": "Proposal IDs (p1, p2, ...) or \"all\"."}
    T.append(("mcad_status", "ECAD-MCAD status of a board (read-only): the IDX baseline and what changed since it, pending MCAD proposals with their "
              "before/after, the received files and the IDX identity map. With enclosure (a STEP file inside the project folder), the 3D clearance "
              "between every component body and the enclosure (gap mm, default the board's setting or 1); derive also lists the outline and keep-out "
              "proposals a section or face of the enclosure would make." + note,
              dict(document_id=doc, enclosure=path, gap={"type": "number", "minimum": 0, "maximum": 100},
                   offset={"type": "array", "items": {"type": "number", "minimum": -10000, "maximum": 10000}, "minItems": 3, "maxItems": 3},
                   rz={"type": "number", "minimum": -360, "maximum": 360},
                   derive={"type": "object", "additionalProperties": False, "properties": {"mode": {"enum": ["section", "face"]}, "z": {"type": "number", "minimum": -10000, "maximum": 10000},
                                                                                         "up": {"type": "boolean"}, "inset": {"type": "number", "minimum": 0, "maximum": 50}}},
                   list={"type": "boolean", "description": "List pending proposals (default true)."}), [], "read"))
    T.append(("import_mcad_changes", "Read an MCAD file and return its changes as proposals: IDX (.idx, .xml; SendInformation, SendChanges or a response), "
              "IDF 3.0 (.emn) or a STEP board (.step: outline, cutouts, holes). Components moved, rotated or flipped, the board outline, new or changed "
              "holes and keep-outs (with heights) are matched to Waffle objects by IDX identifier, then designator or position. The proposals are stored "
              "with the board (the MCAD panel lists them); accept and reject take proposal IDs or \"all\". Applying them finishes like every edit." + note,
              dict(path=path, text={"type": "string", "maxLength": 64 * 2**20, "description": "The file's text instead of path."},
                   format={"enum": ["auto", "idx", "idf", "step"]}, document_id=doc, accept=ids, reject=ids,
                   comment={"type": "string", "maxLength": 500, "description": "Reason sent with rejected changes in the IDX response."}, date=AU.DATE, **edit), [], "edit"))
    T.append(("export_idx", "Write an ECAD-MCAD exchange file into <project>-outputs/mcad/: kind baseline (IDX SendInformation: board outline with cutouts "
              "and thickness, components with height, designator and 3D model name, plated and non-plated holes, keep-outs and keep-ins with heights, "
              "bend regions, mechanical constraints), changes (IDX SendChanges since the last baseline), response (accepted / rejected answers to the "
              "last received file) or idf (IDF 3.0 .emn and .emp). baseline and changes also record what was sent in the board (record, default true), "
              "which finishes as a proposal or write like an edit.",
              dict(kind={"enum": ["baseline", "changes", "response", "idf"]}, document_id=doc, record={"type": "boolean"},
                   batch={"type": "string", "maxLength": 32, "description": "Response: the received batch (default the last decided one)."},
                   pin_holes={"type": "boolean", "description": "Also every plated footprint hole (default false: free holes and non-plated footprint holes)."},
                   vias={"type": "boolean", "description": "Also via holes (default false)."}, output_dir=AU.OUTPUT, date=AU.DATE, **edit), ["kind"], "edit"))


def _read(au, rel, kinds):
    root = au.server.path.parent.resolve()
    if Path(rel).is_absolute() or any(p == ".." for p in re.split(r"[\\/]+", rel)):
        raise ValueError("Choose a file inside " + str(root) + ".")
    source = (root / rel).resolve()
    if root not in source.parents:
        raise ValueError("Choose a file inside " + str(root) + ".")
    kind = next((k for k in kinds if FILES[k].search(source.name)), None)
    if not kind:
        raise ValueError("Unsupported file " + rel + ". Choose " + ", ".join(sorted({e for k in kinds for e in re.findall(r"\w+", FILES[k].pattern[3:-2])})) + ".")
    if not source.is_file():
        raise ValueError("File not found: " + rel + ".")
    if source.stat().st_size > CAPS[kind]:
        raise ValueError("The file is larger than " + str(CAPS[kind] // 2**20) + " MB.")
    raw = source.read_bytes()
    try:
        return raw.decode("utf-8-sig"), kind, source.name
    except UnicodeDecodeError:
        return raw.decode("latin-1"), kind, source.name


def mcad_status(au, a):
    body, modules = None, ("mcad-headless",)
    if "enclosure" in a:
        body, _, _ = _read(au, a["enclosure"], ("step",))
        modules = ("mcad-headless", "mcad-step")
    args = {k: v for k, v in a.items() if k != "enclosure"}
    return dict(au.js("mcad_status", args, body, modules)[0], file_revision=au.server.digest)


def import_mcad_changes(au, a):
    if ("path" in a) == ("text" in a):
        raise ValueError("Give the MCAD file as path (inside the project folder) or as text.")
    if "path" in a:
        text, kind, name = _read(au, a["path"], ("idx", "idf", "step"))
    else:
        text, kind, name = a["text"], None, "text"
    fmt = a.get("format", "auto")
    modules = ("mcad-headless",) + (("mcad-step",) if fmt == "step" or kind == "step" or text.lstrip()[:12] == "ISO-10303-21" else ())
    if a.get("mode") == "write":
        au.check_source(a)
    args = dict(au.args({k: v for k, v in a.items() if k not in ("path", "text")}), file=name)
    result = au.js("mcad_import", args, text, modules)[0]
    return au.edited("import_mcad_changes", dict(a, mode=a.get("mode", "proposal")), result)


def export_idx(au, a):
    folder = au.output_dir(a, "mcad")
    args = au.args({k: v for k, v in a.items() if k != "output_dir"})
    files = []
    head, body = au.js("mcad_export", args, None, ("mcad-headless",))
    files.append(au.save_file(folder, head["name"], au.payload(head, body)))
    if a["kind"] == "idf":
        h2, b2 = au.js("mcad_export", dict(args, index=1), None, ("mcad-headless",))
        files.append(au.save_file(folder, h2["name"], au.payload(h2, b2)))
    result = dict(head, files=files, output_dir=str(folder), file_revision=au.server.digest)
    if head.get("recorded"):
        if a.get("mode") == "write":
            au.check_source(a)
        return au.edited("export_idx", dict(a, mode=a.get("mode", "proposal")), result)
    return result


RUN = {"mcad_status": mcad_status, "import_mcad_changes": import_mcad_changes, "export_idx": export_idx}


def run(au, name, a):
    return RUN[name](au, a)
