"""MCP authoring v2, netlists and multi-routing for the Waffle MCP server and CLI.

Tools (all run in the server's one JavaScript engine under the same watchdog and memory guard as
every other tool; the JavaScript side is mcp/authoring.js):

  find_parts      search the project library, the starter library and the built-in parts
  place_part      (replaces v1) by def, or by query / match (value, footprint, part number)
  connect         put pins on a net: net labels or power ports on each pin (optionally on a stub), or wires
  export_netlist  KiCad .net, Protel-style .net or CSV into <project>-outputs/netlist/
  import_netlist  a KiCad, Protel or CSV netlist into a placeholder sheet, then Update PCB (ECO)
  multi_route     a bus of tracks routed together, parallel at the clearance gap

Editing tools finish like every other edit: a .waffle-ai proposal by default, or a write only with
mode "write" on a server started with --allow-write. Outputs stay inside <project>-outputs/.
Netlist files are read only from inside the project folder.

Pipelines may pass earlier results to later steps with {"$ref": "step1.result.ids[0]"} (or a step's
"id" instead of stepN); see resolve_refs.
"""
import copy
from pathlib import Path
import re

from board_runner import MODULES, APP, HERE

for _name, _spec in {
    "starter-library": (APP / "library/starter-library.js", ("headless", "library", "footprint-wizard"), True),
    "netlist-text": (APP / "schematic/netlist-text.js", ("netlist", "multichannel", "signals", "erc"), False),
    "multi-route": (APP / "pcb/multi-route.js", ("headless", "router"), True),
    "bus-route": (APP / "pcb/bus-route.js", ("headless", "router", "multi-route", "length", "pin-swap", "query"), True),
    "pin-swap": (APP / "pcb/pin-swap.js", ("headless", "connectivity"), True),
    "authoring": (HERE / "authoring.js", ("headless", "sch-author", "starter-library", "netlist", "eco"), False),
}.items():
    MODULES.setdefault(_name, _spec)

NEW_TOOLS = ("find_parts", "connect", "read_netlist", "validate_netlist", "export_netlist", "import_netlist", "multi_route", "route_bus")
NETLIST_FILE = re.compile(r"\.(net|csv|txt|frp)$", re.I)
MAX_NETLIST = 32 * 2**20


def _schemas():
    import automation as AU  # loaded already: the server imports it before building tools
    match = {"type": "object", "additionalProperties": False, "maxProperties": 8, "properties": {
        "value": {"type": "string", "maxLength": 128, "description": "Value or comment, e.g. 10k, 100 nF, Red."},
        "footprint": {"type": "string", "maxLength": 128, "description": "Footprint or package name (contains), e.g. 0603, SOT-23, R_0805."},
        "mpn": {"type": "string", "maxLength": 128, "description": "A manufacturer or supplier part number already in a part's parameters (MPN, LCSC #, ...). Never invented."},
        "category": {"type": "string", "maxLength": 64}, "prefix": {"type": "string", "maxLength": 16},
        "pins": {"type": "integer", "minimum": 1, "maximum": 4096, "description": "Exact count of schematic pins."}}}
    return AU, match


def tools(T, edit, author, page):
    """Add the v2 tools to the tool table T (a list of (name, description, props, required, kind)), replacing place_part."""
    AU, match = _schemas()
    note = AU.UNTRUSTED_NOTE
    query = {"type": "string", "maxLength": 256, "description": "Words that must all appear in the part's ID, name, family or chip label, value, footprint, category or parameters."}
    sources = {"type": "array", "items": {"enum": ["project", "starter", "builtin"]}, "minItems": 1, "uniqueItems": True,
               "description": "Where to look (default all): the project library, the starter library (about 40 generic parts) and the built-in parts."}
    out = [t for t in T if t[0] != "place_part"]
    out.append(("find_parts", "Search the parts that place_part can use: the project library, the starter library and the built-in parts, by query and "
                "match (value, footprint, category, prefix, pins, part number). Lists ID, source, footprint, count of schematic pins (zero for footprint-only entries), "
                "count of physical pads and any part numbers the library "
                "already holds. Generic parts carry no part number; Waffle never invents one." + note,
                dict(query=query, match=match, sources=sources, placeable_only={"type": "boolean", "description": "Only parts with a schematic symbol (default true)."}, **page),
                [], "read"))
    old = next(t for t in T if t[0] == "place_part")
    props = dict(old[2], query=query, match=match)
    out.append(("place_part", "Place a component on a schematic sheet. Name it with def (a library ID or name, a starter part such as starter-led-0603, "
                "or a built-in part std-r, std-c, std-opamp, std-j2, std-j3, std-tp), or find it with query and/or match (value, footprint, part number): "
                "the best match from the project library, then the starter library, then the built-in parts is copied into the project library and placed. "
                "Use an exact definition ID to choose between matching family packages. matched lists the chosen definition and the runners-up. Positions in mm snap to the sheet grid. Reusing a multi-gate part's designator "
                "places its next gate. Returns the designator and every pin's position. Writes a reviewable proposal unless mode is write; chain steps with "
                "pipeline and pass IDs on with $ref." + note, props, ["x", "y"], "edit"))
    pin_ref = {"type": "object", "additionalProperties": False, "required": ["designator", "pin"], "properties": {
        "designator": {"type": "string", "maxLength": 64}, "pin": {"type": ["string", "integer"], "maxLength": 64, "description": "Pin number or name."}}}
    out.append(("connect", "Put schematic pins on a net by name. style label (net labels), power (power ports), wire (wires pin to pin, plus one label or "
                "power port naming the net) or auto (default: power ports for names such as GND, VCC, +3V3, VBUS; labels otherwise). stub draws a short "
                "wire outward from each pin and puts the label at its end. Returns the new objects and any pin that ended on another name (a conflict)." + note,
                dict(sheet=AU.SHEET, net={"type": "string", "minLength": 1, "maxLength": 256},
                     pins={"type": "array", "items": pin_ref, "minItems": 1, "maxItems": 500},
                     style={"enum": ["auto", "label", "power", "wire"]}, stub={"type": "number", "minimum": 0, "maximum": 50, "description": "Stub length in mm (default 0: on the pin)."},
                     power_style={"enum": ["gnd", "signal", "earth", "bar", "arrow", "circle", "wave"]},
                     allow_join={"type": "boolean", "description": "Let wires connect objects they pass over (refused by default)."}, **author),
                ["net", "pins"], "edit"))
    out.append(("read_netlist", "Read the exact text shown in Design > Netlist: sorted parts and pins, nets, signals and tags. "
                "The default is the entire document. Optional zero-based line_offset and line_limit return a slice retaining its line endings. "
                "Compiled schematic pins take precedence; board-only projects use pad nets. With several boards, choose document_id for board-scoped signals and tags." + note,
                dict(document_id={"type": "string", "maxLength": 256, "description": "PCB document ID. Defaults to the first board by name, then ID."},
                     line_offset={"type": "integer", "minimum": 0}, line_limit={"type": "integer", "minimum": 1, "maximum": 100000}), [], "read"))
    out.append(("validate_netlist", "Check netlist v1 text for syntax, unknown names and pins, duplicate bindings, signal legs, bus cycles and electrical "
                "pin connections using the project's unscoped ERC matrix. Diagnostic line and column are one-based, endColumn is exclusive. "
                "Returns up to 100 diagnostics and the full error and warning counts." + note,
                dict(text={"type": "string", "maxLength": MAX_NETLIST}), ["text"], "read"))
    out.append(("export_netlist", "Write the design's netlist to <project>-outputs/netlist/: format kicad (.net s-expression, default), protel ([ ] component and "
                "( ) net blocks) or csv (Net, Designator, Pin, Pin Name). source schematic (compiled sheets), pcb (board pad nets) or auto. Returns the file's "
                "path, size and SHA-256 with component, net and connection counts.",
                dict(format={"enum": ["kicad", "protel", "csv"]}, source={"enum": ["auto", "schematic", "pcb"]},
                     document_id={"type": "string", "maxLength": 256, "description": "Board for source pcb (default the first)."},
                     output_dir=AU.OUTPUT, date=AU.DATE), [], "output"))
    out.append(("import_netlist", "Import a KiCad (.net), Protel or CSV netlist: its components are drawn on a new placeholder schematic sheet with a net "
                "label on every connected pin (library parts whose footprint and pins match, else starter parts by package, else a generic box symbol that "
                "names the footprint), then Update PCB creates the footprints and pad nets on the board (a board is added if there is none). Give the "
                "netlist as text, or path to a file inside the project folder. The sheet keeps the board linked, so later Update PCB, ERC and "
                "cross-probing work." + note,
                dict(path={"type": "string", "maxLength": 1024, "description": "Netlist file inside the project folder (.net, .csv, .txt)."},
                     text={"type": "string", "maxLength": MAX_NETLIST, "description": "Netlist text instead of a file."},
                     format={"enum": ["auto", "kicad", "protel", "csv"]}, sheet_name={"type": "string", "maxLength": 128},
                     document_id={"type": "string", "maxLength": 256, "description": "Board to update (default the first; one is added if there is none)."},
                     update_pcb={"type": "boolean", "description": "Run Update PCB after drawing the sheet (default true)."},
                     starter_parts={"type": "boolean", "description": "Match starter-library parts by package (default true)."}, **author),
                [], "edit"))
    point = AU.POINT
    xy = AU.XY
    out.append(("multi_route", "Interactive Multi-Routing, headless: route a bus of two to 32 nets together on one layer. The bus is walked round obstacles as "
                "one group (a wide centreline split into parallel members at the pitch: track width plus the clearance rule between the nets, or gap), "
                "falling back to routing members one by one so each hugs its neighbour. Starts are pads {component, pad} or points {x, y} (give nets for "
                "points). The ends fan out across to at the pitch, or are given one per start in ends." + note,
                dict(document_id=AU.DOC, starts={"type": "array", "items": point, "minItems": 2, "maxItems": 32},
                     nets={"type": "array", "items": {"type": "string", "maxLength": 256}, "maxItems": 32, "description": "Net per start, for starts given as points."},
                     to=xy, ends={"type": "array", "items": xy, "minItems": 2, "maxItems": 32}, layer={"type": "string", "maxLength": 64},
                     width={"type": "number", "exclusiveMinimum": 0, "maximum": 10}, gap={"type": "number", "minimum": 0, "maximum": 10},
                     require_all={"type": "boolean", "description": "Refuse unless every member routes (default false: keep the routed ones)."},
                     time_limit_ms={"type": "integer", "minimum": 50, "maximum": 30000}, **author), ["starts"], "edit"))
    out.append(("route_bus", "Interactive Bus Routing, headless: route a whole bus (a DDR byte lane, an address/command group) as one ribbon with the "
                "editor's engine. Members run parallel at the rule pitch (width + clearance; diff pairs at their pair gap), are walked round obstacles "
                "(or push other nets, conflict push) as a group, change layer through a via array (staggered or inline) after the waypoint index given "
                "in layer_changes, and with to fan into the destination pads, swapping swap-equivalent pins (e.g. DQ bits) to remove crossings. tune "
                "brings every member within the matched-length tolerance. Pick the bus by nets, net_class (also xSignal classes) or query; from is a "
                "point near the bus start (pads or fanout), waypoints are the ribbon's centreline clicks." + note,
                dict(document_id=AU.DOC, nets={"type": "array", "items": {"type": "string", "maxLength": 256}, "minItems": 2, "maxItems": 64},
                     net_class={"type": "string", "maxLength": 256}, query={"type": "string", "maxLength": 1024}, order={"type": "array", "items": {"type": "string", "maxLength": 256}, "maxItems": 64},
                     **{"from": xy}, waypoints={"type": "array", "items": xy, "minItems": 1, "maxItems": 64}, to=xy, layer={"type": "string", "maxLength": 64},
                     visits={"type": "array", "maxItems": 16, "description": "Fly-by: after waypoint index after, reach the next load (the topology's load order, else the pads nearest to) and carry on from its pads.",
                             "items": {"type": "object", "additionalProperties": False, "required": ["after", "to"], "properties": {"after": {"type": "integer", "minimum": 0, "maximum": 63}, "to": xy}}},
                     layer_changes={"type": "array", "maxItems": 16, "items": {"type": "object", "additionalProperties": False, "required": ["after", "layer"], "properties": {
                         "after": {"type": "integer", "minimum": 0, "maximum": 63}, "layer": {"type": "string", "maxLength": 64}, "pattern": {"enum": ["staggered", "inline"]}}}},
                     conflict={"enum": ["walkaround", "push", "hug", "stop", "ignore"]}, corner={"enum": ["45", "45arc", "90", "90arc", "any"]},
                     width={"type": "number", "exclusiveMinimum": 0, "maximum": 10}, gap={"type": "number", "minimum": 0, "maximum": 10}, via_pattern={"enum": ["staggered", "inline"]},
                     swap_pins={"type": "boolean", "description": "Swap swap-equivalent destination pins to remove crossings (default true)."},
                     tune={"type": "boolean", "description": "Tune the group to its matched-length tolerance after routing (default false)."},
                     require_finish={"type": "boolean", "description": "Refuse unless the bus reaches its destination pads."},
                     time_limit_ms={"type": "integer", "minimum": 50, "maximum": 30000}, **author), ["waypoints"], "edit"))
    T[:] = out


# ---------------------------------------------------------------- tool bodies
def _edit(au, name, op, a, modules=("authoring",), body=None):
    if a.get("mode") == "write":
        au.check_source(a)
    result = au.js(op, au.args(a), body, modules)[0]
    return au.edited(name, dict(a, mode=a.get("mode", "proposal")), result)


def find_parts(au, a):
    return dict(au.js("find_parts", a, modules=("authoring",))[0], file_revision=au.server.digest)


def place_part(au, a):
    if "def" not in a and "query" not in a and "match" not in a:
        raise ValueError("Name the part with def, or find it with query or match.")
    return _edit(au, "place_part", "place_part_v2", a)


def connect(au, a):
    return _edit(au, "connect", "connect", a)


def multi_route(au, a):
    if ("to" in a) == ("ends" in a):
        raise ValueError("Give either to (the bus end point) or ends (one per start).")
    if "ends" in a and len(a["ends"]) != len(a["starts"]):
        raise ValueError("Give one end per start.")
    return _edit(au, "multi_route", "multi_route", a, modules=("authoring", "multi-route"))


def route_bus(au, a):
    return _edit(au, "route_bus", "route_bus", a, modules=("authoring", "bus-route"))


def read_netlist(au, a):
    head, body = au.js("read_netlist", a, modules=("netlist-text",))
    head["untrusted_design_text"]["text"] = body
    return dict(head, file_revision=au.server.digest)


def validate_netlist(au, a):
    return dict(au.js("validate_netlist", {}, body=a["text"], modules=("netlist-text",))[0], file_revision=au.server.digest)


def export_netlist(au, a):
    options = {k: a[k] for k in ("source", "date") if k in a}
    options.update(documentId=a.get("document_id"), nameStyle="command")
    with au.translated_output("netlist-" + a.get("format", "kicad"), options) as (head, payload):
        folder = au.output_dir(a, "netlist")
        f, = head["files"]
        saved = au.save_file(folder, f["name"], payload(f))
        fields = ("format", "source", "document_id", "components", "nets", "connections", "untrusted_design_text")
        details = {key: head["details"][key] for key in fields}
        return dict(saved, **details, output_dir=str(folder), file_revision=au.server.digest, report=head["report"])


def import_netlist(au, a):
    if ("path" in a) == ("text" in a):
        raise ValueError("Give the netlist as path (a file inside the project folder) or as text.")
    if "path" in a:
        root, rel = au.server.path.parent.resolve(), a["path"]
        if Path(rel).is_absolute() or any(p == ".." for p in re.split(r"[\\/]+", rel)):
            raise ValueError("Choose a netlist file inside " + str(root) + ".")
        source = (root / rel).resolve()
        if root not in source.parents:
            raise ValueError("Choose a netlist file inside " + str(root) + ".")
        if not NETLIST_FILE.search(source.name):
            raise ValueError("Unsupported netlist file " + rel + ". Choose a .net, .csv or .txt file.")
        if not source.is_file():
            raise ValueError("Netlist file not found: " + rel + ".")
        if source.stat().st_size > MAX_NETLIST:
            raise ValueError("The netlist is larger than 32 MB.")
        raw = source.read_bytes()
        try:
            text = raw.decode("utf-8-sig")
        except UnicodeDecodeError:
            text = raw.decode("latin-1")
    else:
        text = a["text"]
    args = {k: v for k, v in a.items() if k not in ("path", "text")}
    return _edit(au, "import_netlist", "import_netlist", args, body=text)


RUN = {"read_netlist": read_netlist, "validate_netlist": validate_netlist, "find_parts": find_parts, "place_part": place_part, "connect": connect, "multi_route": multi_route, "route_bus": route_bus,
       "export_netlist": export_netlist, "import_netlist": import_netlist}


def run(au, name, a):
    return RUN[name](au, a)


# ---------------------------------------------------------------- pipeline references
# {"$ref": "step2.result.ids[0]"} or {"$ref": "led.result.untrusted_design_text.ref"}: the value at that
# path in an earlier step's result. Only earlier steps can be named, a reference is the whole value
# (no string templating), and nothing but step results can be read.
STEP_ID = re.compile(r"^[A-Za-z_][A-Za-z0-9_]{0,31}$")
REF = re.compile(r"^(?:step([1-9][0-9]?)|([A-Za-z_][A-Za-z0-9_]{0,31}))\.result((?:\.[A-Za-z_][A-Za-z0-9_]{0,63}|\[[0-9]{1,6}\])*)$")
PART = re.compile(r"\.([A-Za-z_][A-Za-z0-9_]*)|\[([0-9]+)\]")


def _walk(value, where, found, depth=0):
    if depth > 32:
        raise ValueError(where + " is nested too deeply.")
    if isinstance(value, dict):
        if "$ref" in value:
            if len(value) != 1 or not isinstance(value["$ref"], str):
                raise ValueError(where + ": a reference is exactly {\"$ref\": \"stepN.result.path\"}.")
            found.append((where, value["$ref"]))
            return
        for k, v in value.items():
            _walk(v, where + "." + k, found, depth + 1)
    elif isinstance(value, list):
        for i, v in enumerate(value):
            _walk(v, "%s[%d]" % (where, i), found, depth + 1)


def check_refs(steps):
    """Validate step ids and every reference before anything runs. Returns {step index: has references}."""
    ids, has = {}, {}
    for i, step in enumerate(steps):
        sid = step.get("id")
        if sid is not None:
            if not isinstance(sid, str) or not STEP_ID.match(sid) or re.match(r"^step[0-9]+$", sid):
                raise ValueError("Step %d: id must be a short name (letters, digits, _), not stepN." % (i + 1))
            if sid in ids:
                raise ValueError("Step %d: the id %s is already used by step %d." % (i + 1, sid, ids[sid] + 1))
        args = step.get("args", {})
        if isinstance(args, dict) and set(args) == {"$ref"}:
            raise ValueError("Step %d: args cannot be a reference; reference single values." % (i + 1))
        found = []
        _walk(args, "steps[%d].args" % i, found)
        for where, ref in found:
            m = REF.match(ref)
            if not m:
                raise ValueError("Step %d: bad $ref %s at %s. Use stepN.result.path or <id>.result.path, e.g. step1.result.ids[0]." % (i + 1, _q(ref), where))
            target = int(m.group(1)) - 1 if m.group(1) else ids.get(m.group(2))
            if target is None:
                raise ValueError("Step %d: $ref %s names no earlier step." % (i + 1, _q(ref)))
            if target >= i:
                raise ValueError("Step %d: $ref %s must name an earlier step." % (i + 1, _q(ref)))
        if sid is not None:
            ids[sid] = i
        has[i] = bool(found)
    return has, ids


def _q(text):
    return '"' + str(text)[:120].replace('"', "'") + '"'


def resolve_refs(args, i, results, ids):
    """A copy of step i's args with every reference replaced by the value it names."""
    def lookup(ref):
        m = REF.match(ref)
        target = int(m.group(1)) - 1 if m.group(1) else ids[m.group(2)]
        value, path = results[target]["result"], "result"
        for name, index in PART.findall(m.group(3)):
            if name:
                if not isinstance(value, dict) or name not in value:
                    raise ValueError("Step %d: $ref %s: %s has no field %s." % (i + 1, _q(ref), path, name))
                value, path = value[name], path + "." + name
            else:
                k = int(index)
                if not isinstance(value, list) or k >= len(value):
                    raise ValueError("Step %d: $ref %s: %s has no entry [%d]." % (i + 1, _q(ref), path, k))
                value, path = value[k], "%s[%d]" % (path, k)
        return copy.deepcopy(value)

    def sub(value):
        if isinstance(value, dict):
            if set(value) == {"$ref"} and isinstance(value["$ref"], str):
                return lookup(value["$ref"])
            return {k: sub(v) for k, v in value.items()}
        if isinstance(value, list):
            return [sub(v) for v in value]
        return value
    return sub(args)
