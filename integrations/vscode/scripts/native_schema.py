"""Build the public schema from the native row shapes and the shipping kind registry."""

import importlib.util
import json
from pathlib import Path
import re
import subprocess
import tempfile

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[2]
OUT = HERE.parent / "schema" / "waffle-folder-record.schema.json"

SAFE = 9007199254740991
TEXT = {"type": "string"}
STRING = {**TEXT, "minLength": 1}
BOOL = {"type": "boolean"}
NULL = {"type": "null"}
DIGEST = {**TEXT, "pattern": "^[a-f0-9]{64}$"}
BASE64 = {**TEXT, "pattern": "^[A-Za-z0-9+/]*={0,2}$"}
VERSION = {**TEXT, "pattern": r"^(0|[1-9][0-9]{0,3})\.(0|[1-9][0-9]{0,3})$"}
DECIMAL = {**TEXT, "pattern": r"^(?!-0$)-?(?:0|[1-9][0-9]*)(?:\.[0-9]*[1-9])?$"}
POINT = {"$ref": "#/$defs/pointNm"}
ID = {"$ref": "#/$defs/id"}


def r(name):
    return {"$ref": "#/$defs/" + name}


def integer(minimum=-SAFE, maximum=SAFE, description=None):
    value = {"type": "integer", "minimum": minimum, "maximum": maximum}
    if description:
        value["description"] = description
    return value


INT, NAT, POS = integer(), integer(0), integer(1)
NM, PNM, NNM = r("lengthNm"), r("positiveLengthNm"), r("nonnegativeLengthNm")
ANGLE, ROTATION = r("clockwiseAngle"), r("angleNdeg")
NUMERIC = {"anyOf": [INT, r("numberValue"), r("exactDecimal")]}
UV = integer(0, 1000000, "Millionths of the full oriented image.")
UV_POS = integer(1, 1000000)
PRESSURE = integer(0, 255)


def obj(properties=None, required=(), **keywords):
    out = {"type": "object"}
    if required:
        out["required"] = list(required)
    if properties:
        out["properties"] = properties
    return {**out, **keywords}


def seq(items, **keywords):
    return {"type": "array", "items": items, **keywords}


def tuple_of(*items):
    return {"type": "array", "prefixItems": list(items), "items": False, "minItems": len(items)}


def const(value):
    return {"const": value}


def choices(*values):
    return {"enum": list(values)}


def union(*schemas):
    return {"anyOf": list(schemas)}


def nullable(schema):
    return union(NULL, schema)


def when(field, test, yes, no=None):
    condition = {"if": {"required": [field], "properties": {field: test}}, "then": yes}
    if no is not None:
        condition["else"] = no
    return condition


def with_fields(base, props, required=(), **keywords):
    return {"allOf": [base, obj(props, required)], **keywords}


def kind_dispatch(mapping, envelope=None, description=None, appended=()):
    """Validate the discriminator before dispatching to the exact published row shape."""
    rules = [envelope] if envelope else []
    kinds = sorted(mapping.keys() - set(appended)) + [kind for kind in appended if kind in mapping]
    rules.extend(when("kind", const(kind), mapping[kind]) for kind in kinds)
    result = obj({"kind": choices(*sorted(mapping))}, ["kind"], allOf=rules)
    if description:
        result["description"] = description
    return result


def native_registry():
    """Read the actual codec and model registries, using either CI JavaScript engine."""
    helper = ROOT / "scripts/gen-shortcuts.py"
    spec = importlib.util.spec_from_file_location("gen_shortcuts", helper)
    gen_shortcuts = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(gen_shortcuts)
    kind, executable = gen_shortcuts.find_engine()
    prefix = ("var LOAD = load, PRINT = print;\n" if kind == "jsc" else
              "var fs = require('node:fs'), vm = require('node:vm');\n"
              "var LOAD = f => vm.runInThisContext(fs.readFileSync(f, 'utf8'), {filename:f});\n"
              "var PRINT = s => process.stdout.write(s + '\\n');\n")
    source = prefix + "var APP = " + json.dumps(str(ROOT / "app")) + ";\n" + """
      for (const file of ["formats/format-2-codec", "formats/format-2-units", "formats/format-2-values", "formats/format-2-model"]) {
        LOAD(APP + "/" + file + ".js");
      }
      const F = globalThis.AtriumFormat2, M = globalThis.AtriumFormat2Model;
      const rows = Object.fromEntries(F.headerKinds.map(kind =>
        [kind, Array.from(M.readOptions(kind).knownKinds ?? [])]));
      const project = {kind:"project", formatVersion:F.FORMAT, id:"schema", name:"Schema"};
      const table = {feature:F.tableFeature, version:F.withTable(project, true).formatVersion};
      const optionalRows = rows.project.filter(F.isOptionalManifestKind);
      const optionalVersion = F.create(project, optionalRows.map((kind, i) => ({kind, id:String(i)}))).header.formatVersion;
      PRINT(JSON.stringify({version:F.FORMAT, suffixes:F.documentSuffix, rows, table, optionalVersion}));
    """
    with tempfile.TemporaryDirectory(prefix="waffle-schema-") as directory:
        runner = Path(directory) / "registry.js"
        runner.write_text(source, encoding="utf-8")
        result = subprocess.run([executable, str(runner)], capture_output=True, text=True, timeout=60)
    if result.returncode:
        raise SystemExit("gen-schema: could not read native record kinds\n" + result.stderr)
    inventory = json.loads(result.stdout)
    sidecars = (ROOT / "app/formats/import-sidecars.js").read_text(encoding="utf-8")
    header = re.search(r'\bHEADER_KIND\s*=\s*"([^"]+)"', sidecars)
    writer = sidecars.split("function* prepareSteps(", 1)[1].split("\n  async function prepare(", 1)[0]
    rows = sorted(set(re.findall(r'\{\s*kind\s*:\s*"([^"]+)"', writer)))
    if not header or not rows:
        raise SystemExit("gen-schema: could not read the retained import serializer's header and row kinds")
    inventory["sidecar"] = header[1]
    inventory["rows"][header[1]] = rows
    return inventory


def primitives(version):
    return {
        "version": {**VERSION, "default": version},
        "id": {**STRING, "description": "Stable identifier. Existing opaque IDs survive reads and rewrites. Newly allocated native IDs use uuidV7."},
        "uuidV7": {**TEXT, "pattern": "^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$",
                   "description": "Lowercase RFC 9562 UUID version 7 assigned to newly allocated native identities."},
        "order": {**TEXT, "pattern": "^[0-9A-Za-z]*[1-9A-Za-z]$", "description": "Fractional base-62 order key. Equal keys sort by record ID."},
        "lengthNm": integer(description="Signed integer nanometres. One millimetre is 1,000,000 nm."),
        "nonnegativeLengthNm": integer(0, description="Nonnegative integer nanometres."),
        "positiveLengthNm": integer(1, description="Positive integer nanometres."),
        "pointNm": {**tuple_of(NM, NM), "description": "Point [x,y] in nanometres. X increases rightward, Y downward."},
        "angleNdeg": integer(description="Integer nanodegrees, positive counterclockwise unless a field says otherwise."),
        "clockwiseAngle": integer(0, 359999999999, "Stored nanodegrees in [0,360 degrees). The codec negates the editor's clockwise rotation."),
        "exactDecimal": {**DECIMAL, "description": "Exact decimal string without exponent, redundant zeros, leading plus or negative zero."},
        "numberValue": obj({"$number": r("exactDecimal")}, ["$number"], additionalProperties=False),
        "literalValue": obj({"$literal": obj(additionalProperties=r("nativeValue"))}, ["$literal"], additionalProperties=False),
        "nativeValue": {
            "description": "Interpreted native value encoding. Nonintegral author numbers use {$number: exactDecimal}; $literal escapes reserved keys. Unknown optional fields can retain arbitrary JSON without interpretation.",
            "anyOf": [NULL, BOOL, INT, TEXT, seq(r("nativeValue")), obj(additionalProperties=r("nativeValue"))],
        },
        "portablePath": {
            **STRING, "maxLength": 4096,
            "pattern": r"^(?!/)(?!.*(?:^|/)\.{1,2}(?:/|$))[^\\:\u0000-\u001f\u007f/]+(?:/[^\\:\u0000-\u001f\u007f/]+)*$",
            "description": "Root-relative slash-separated path. Filesystem portability, collision keys and allowed member locations are also checked by the reader.",
        },
        "assetRef": obj({"sha256": DIGEST, "mediaType": STRING, "byteLength": POS}, ["sha256", "mediaType", "byteLength"]),
        "modelRef": with_fields(r("assetRef"), {"mediaType": const("model/step")}),

    }


def geometry_defs():
    position_xy = obj({"x": NM, "y": NM}, ["x", "y"])
    provision = {"w": PNM, "h": PNM, "drill": NNM, "drillX": NNM, "drillY": NNM, "slotLength": PNM,
                 "slotAngle": ANGLE, "layer": STRING, "shape": STRING, "number": TEXT,
                 "angle": nullable(ANGLE), "maskExpansion": nullable(NM), "pasteExpansion": nullable(NM),
                 "holeOnly": nullable(BOOL), "plated": BOOL, "fabTestpoint": nullable(choices("Top", "Bottom", "Both")),
                 "roundrectRadiusRatio": nullable(r("exactDecimal")), "tent": obj({"top": nullable(BOOL), "bottom": nullable(BOOL)})}
    position = union(obj({"at": POINT}, ["at"]), position_xy)
    arc = obj({"kind": const("arc"), "c": POINT, "r": PNM, "start": integer(0, 359999999999),
               "sweep": {"allOf": [integer(-360000000000, 360000000000), {"not": const(0)}]}},
              ["kind", "c", "r", "start", "sweep"])
    # Exact schematic curves beside a path's points (app/schematic/sch-curves.js), relative to the first point.
    ellipse = obj({"a": POINT, "b": POINT, "sweep": {"allOf": [integer(-360000000000, 360000000000), {"not": const(0)}]}},
                  ["a", "b", "sweep"], description="Ellipse c + a·cos t + b·sin t, t from 0 to sweep; c is the first point minus a.")
    bezier = obj({"controlPoints": seq(POINT, minItems=4)}, ["controlPoints"],
                 description="Cubic Bézier segments p0 c1 c2 p1 …, offsets from the path's first point.")
    symbol_arc = obj({"x": NM, "y": NM, "r": PNM, "start": NUMERIC, "end": NUMERIC}, ["x", "y", "r", "start", "end"],
                     description="Symbol editor arc: centre, radius and degrees turning clockwise on screen from start to end.")
    segment = union(arc, obj({"kind": const("line"), "a": POINT, "b": POINT}, ["kind", "a", "b"]))
    contour = seq(segment, minItems=1, maxItems=1000000)
    return {
        "positionXY": position_xy,
        "position": position,
        "padFields": obj({**provision, "padStack": obj(additionalProperties=obj(provision))}, ["w", "h"]),
        "geometryArc": arc,
        "schematicEllipse": ellipse,
        "schematicBezier": bezier,
        "symbolArc": symbol_arc,
        "contour": contour,
        "regionShape": obj({"version": const(1), "contour": r("contour"), "cutouts": seq(r("contour")), "sig": TEXT},
                           ["version", "contour", "cutouts"]),
        "boardShape": obj({"version": const(1), "contour": r("contour"), "cutouts": seq(r("contour")), "sig": TEXT,
                           "source": TEXT, "cutoutRegions": obj(additionalProperties=r("regionShape"))}, ["version", "contour"]),
        "shapeValue": kind_dispatch({
            "path": obj({"points": seq(POINT, minItems=1)}, ["points"]),
            "circle": with_fields(r("positionXY"), {"r": PNM}, ["r"]),
            "text": with_fields(r("positionXY"), {"text": TEXT, "size": PNM, "angle": ANGLE}, ["text"]),
        }, obj({"width": nullable(NNM), "layer": STRING, "net": TEXT, "closed": BOOL, "fill": union(BOOL, TEXT),
                "arc": union(BOOL, r("geometryArc"), r("symbolArc")), "ellipse": r("schematicEllipse"),
                "bezier": r("schematicBezier"), "regionShape": r("regionShape")})),
        "bodyValue": obj({"type": choices("extruded", "step", "unsupported"), "layer": TEXT,
                          "side": choices("Top", "Bottom"), "ownerSide": choices("Top", "Bottom"),
                          "sourceRecord": TEXT, "identifier": TEXT, "modelId": TEXT, "modelType": nullable(TEXT),
                          "shapeRecord": nullable(TEXT), "at": POINT, "angle": ANGLE,
                          "rotation": tuple_of(ROTATION, ROTATION, ROTATION), "dz": NM, "minZ": NM, "maxZ": NM,
                          "rings": seq(seq(POINT, minItems=3, maxItems=20000), maxItems=257), "contour": r("contour"),
                          "color": nullable(integer(0, 0xffffff)), "opacity": nullable(r("exactDecimal"))},
                         ["type", "layer", "side", "ownerSide", "sourceRecord", "identifier", "modelId", "at", "angle",
                          "rotation", "dz", "minZ", "maxZ", "rings"]),
        "modelAliasValue": obj({"id": ID, "file": TEXT, "model": r("modelRef"), "assetId": STRING,
                                "checksum": integer(0, 0xffffffff), "unresolved": BOOL}, ["id", "file"]),
        "layerValue": obj({"type": STRING, "name": TEXT, "material": TEXT, "thickness": NNM, "key": ID,
                           "dielectric": STRING, "dk": nullable(r("exactDecimal")), "df": nullable(r("exactDecimal"))},
                          ["type", "name", "thickness"]),
        "copperRegionValue": obj({"layer": STRING, "net": TEXT, "bounds": tuple_of(NM, NM, NM, NM),
                                  "count": integer(1, 65536), "data": BASE64}, ["layer", "net", "bounds", "count", "data"]),
    }


def query_defs():
    query_id = {**STRING, "maxLength": 512}
    target_id_fields = ["projectId", "docId", "itemId", "signalId", "entityId", "pinId",
                        "definitionId", "instanceId", "parameterId", "field", "kind"]
    target = obj({"scope": choices("project", "sheet", "item", "signal", "entity", "terminal"),
                  **dict.fromkeys(target_id_fields, r("queryId")), "detached": BOOL, "needsRebind": BOOL}, ["scope"], allOf=[
        when("scope", choices("sheet", "item", "terminal"), {"required": ["docId"]}),
        when("scope", choices("item", "terminal"), {"required": ["itemId"]}),
        when("scope", const("terminal"), {"required": ["pinId"]}),
        when("scope", const("entity"), {"required": ["entityId"]}),
        when("scope", const("signal"), {"required": ["signalId"]}),
    ])
    binding = obj({"id": r("queryId"), "name": r("queryId"), "span": tuple_of(NAT, NAT),
                   "target": nullable(r("queryTarget"))}, ["id", "name", "span"],
                  description="Half-open UTF-16 offsets in source. Exact token spelling, order and occurrence identity are validated by the query reader.")
    query = obj({"languageVersion": const(1), "source": {**STRING, "maxLength": 2000, "pattern": r"\S"},
                 "bindings": seq(r("queryBinding"), maxItems=600)}, ["languageVersion", "source"])
    rule = obj({"type": STRING, "id": ID,
                "presetKey": {**STRING, "maxLength": 256, "description": "Optional semantic slot of a fabrication preset or rule-set template. Record identity remains the id."},
                "name": TEXT, "enabled": BOOL, "priority": INT, "severity": STRING,
                "scope": r("queryScope"), "scope2": r("queryScope"), "origin": obj({"kind": STRING, "sheet": ID, "object": ID, "assertion": ID}),
                **dict.fromkeys(["gap", "width", "clearance"], NM),
                "min": {**NUMERIC, "description": "Rule-type-specific minimum in the rule's original unit."},
                **dict.fromkeys(["max", "preferred"], {**nullable(NUMERIC),
                    "description": "Rule-type-specific author quantity in the rule's original unit, or null for an unset optional value. Nonintegral values use the native $number wrapper."})},
               ["type", "scope"], allOf=[when("type", choices("clearance", "short", "creepage", "returnPathVia",
                                                               "parallelSegment", "componentClearance"),
                                               {"required": ["scope2"]}, {"not": {"required": ["scope2"]}})])
    return {"queryId": query_id, "queryTarget": target, "queryBinding": binding, "queryV1": query,
            "queryScope": union(r("queryV1"), obj({"languageVersion": integer(2), "source": STRING},
                                                 ["languageVersion", "source"],
                                                 description="Later query language, preserved for viewing. This reader must not evaluate its predicate.")),
            "ruleValue": rule}


def notebook_defs():
    bounds = obj({"at": POINT, "w": PNM, "h": PNM}, ["at", "w", "h"])
    font_asset = with_fields(r("assetRef"), {"mediaType": const("font/ttf"), "byteLength": integer(1, 8000000)})
    font = union(choices("sans", "serif", "mono", "hand"),
                 obj({"source": const("system"), "family": {**STRING, "maxLength": 80}}, ["source", "family"]),
                 obj({"source": const("asset"), "assetRef": font_asset, "license": const("OFL-1.1")},
                     ["source", "assetRef", "license"]))
    text_run = obj({"type": choices("text", "field", "math"), "text": TEXT,
                    "expression": {**TEXT, "maxLength": 512}, "tex": {**TEXT, "maxLength": 16384},
                    "binding": nullable(obj({"field": {**STRING, "maxLength": 512}}, ["field"])),
                    **dict.fromkeys(["bold", "italic", "underline", "strike", "code"], nullable(BOOL)),
                    "color": TEXT, "highlight": TEXT, "href": TEXT}, ["type"], allOf=[
        when("type", const("text"), {"required": ["text"]}),
        when("type", const("field"), {"required": ["expression"]}),
        when("type", const("math"), {"required": ["tex"]}),
    ])
    rich_block = obj({"style": choices("paragraph", "h1", "h2", "h3", "bullet", "number", "check"),
                      "runs": seq(text_run), "align": choices("left", "center", "right"), "checked": BOOL},
                     ["style", "runs"])
    rich = obj({"blocks": seq(rich_block, minItems=1, maxItems=4096), "font": nullable(font),
                "size": PNM}, ["blocks"])
    fallback = obj({"type": choices("text", "image")}, ["type"], allOf=[
        when("type", const("image"), obj({"assetRef": r("assetRef"), "assetId": DIGEST, "alt": TEXT}, ["alt"],
                                        anyOf=[{"required": ["assetRef"]}, {"required": ["assetId"]}]),
             obj({"text": TEXT}, ["text"])),
    ])
    widget = obj({"type": STRING, "state": obj(), "fallback": r("widgetFallback")},
                 ["type", "state", "fallback"], allOf=[
        when("type", const("table"), obj({"state": obj({
            "columns": seq(obj({"id": ID, "title": TEXT, "unit": STRING}, ["id", "title"])),
            "rows": seq(obj({"id": ID}, ["id"])),
        }, ["columns", "rows"])})),
        when("type", const("todo"), obj({"state": obj({"rows": seq(obj(
            {"id": ID, "text": TEXT, "done": BOOL, "threadId": ID}, ["id", "text", "done"]))}, ["rows"])})),
    ])
    calc = obj({"languageVersion": POS, "name": STRING, "source": TEXT, "displayUnit": STRING,
                "bindings": seq(r("queryBinding")), "assertions": seq(obj(
                    {"id": ID, "source": STRING, "bindings": seq(r("queryBinding"))}, ["id", "source"]))}, ["languageVersion"])
    ink = obj({"brush": choices("pen", "highlighter"), "colour": STRING, "width": PNM, "at": POINT,
               "p": PRESSURE, "path": seq(INT), "gesture": ID}, ["brush", "colour", "width", "at", "p", "path"])
    return {"notebookBounds": bounds, "richText": rich, "widgetFallback": fallback, "widgetState": widget,
            "calculationValue": calc, "inkValue": ink,
            "imageUVPoint": tuple_of(UV, UV), "imageUVRegion": tuple_of(UV, UV, UV, UV),
            "notesLayerValue": obj({"id": ID, "print": BOOL}, ["id", "print"])}


def item_shapes():
    position = r("position")
    framed = {"w": PNM, "h": PNM}
    text = {"text": TEXT}
    path = {"points": seq(POINT, minItems=2)}
    shape = {"shape": STRING, "fill": nullable(union(BOOL, TEXT)), "closed": BOOL}
    part = {
        "def": ID, "ref": TEXT, "value": TEXT, "layer": STRING, "side": STRING, "link": ID,
        "pinNets": obj(additionalProperties=TEXT), "parameters": obj(additionalProperties=union(TEXT, INT, r("numberValue"))),
        "paramShow": obj(additionalProperties=BOOL), "mirror": BOOL, "channel": ID, "groupId": ID,
        "refAt": POINT, "valueAt": POINT, "bodies3d": seq(r("bodyValue")),
    }
    label = {**text, "size": PNM, "layer": STRING, "justify": STRING, "mirrored": BOOL,
             "autoName": obj({"part": ID, "pin": STRING, "style": STRING}, ["part", "pin", "style"])}
    # Signal and tag directive fields (app/core/signals.js directives), with the older netClass and diffPair.
    directive = {"signal": TEXT, "polarity": INT, "tags": seq(STRING), "netClass": TEXT, "diffPair": TEXT}
    letter = {**text, "io": STRING, "width": PNM, "net": TEXT, **directive}
    sheet_entry = obj({"id": ID, "name": TEXT, "io": STRING, "side": STRING, "offset": NM},
                      ["id", "name", "io", "side", "offset"])
    clip = obj({
        "source": with_fields(r("assetRef"), {"mediaType": const("application/pdf")}),
        "name": STRING, "page": integer(1, 100000), "region": r("imageUVRegion"),
    }, ["source", "name", "page", "region"])
    note = {
        "sticky": obj({"colour": STRING}), "callout": obj({"colour": STRING, "anchor": obj(
            {"docId": ID, "itemId": ID, "at": POINT}, ["at"])}), "ink": r("inkValue"),
        "note": BOOL, "font": STRING, "size": PNM, "border": nullable(BOOL), "fill": nullable(TEXT),
        "richText": r("richText"),
    }
    return {
        "part": with_fields(position, part, ["def", "ref", "value"]),
        "wire": obj({**path, "width": NNM, "net": TEXT, **directive}, ["points"]),
        "track": obj({**path, "width": NNM, "layer": STRING, "net": TEXT, "teardrop": BOOL},
                     ["points"]),
        "graphic": obj({**path, **shape, "width": NNM, "layer": STRING, "text": TEXT}, ["points"]),
        "polygon": obj({"points": seq(POINT, minItems=3), "layer": STRING, "net": TEXT,
                        "width": NNM, "pour": BOOL, "planeVoid": BOOL, "powerPlane": obj({
                            "sourceLayer": STRING,
                            "pad": r("planeRelief"), "via": r("planeRelief"),
                        }, ["sourceLayer"])}, ["points"]),
        "label": with_fields(position, label, ["text"]),
        "netlabel": with_fields(position, {**label, "scope": STRING, **letter}, ["text"]),
        "junction": with_fields(position, {"net": TEXT}),
        "via": with_fields(position, {"diameter": PNM, "drill": NNM, "net": TEXT,
                                      "startLayer": STRING, "endLayer": STRING, "layers": seq(STRING),
                                      "fabTestpoint": nullable(choices("Top", "Bottom", "Both"))}, ["diameter"]),
        "pad": {"allOf": [position, r("padFields")], "properties": {"net": TEXT, "ref": TEXT}},
        "power": with_fields(position, {**letter, "style": STRING, "direction": INT, "showName": nullable(BOOL)},
                             ["text", "style", "direction"]),
        "port": with_fields(position, letter, ["text", "io"]),
        "offsheet": with_fields(position, letter, ["text"]),
        "sheetsymbol": with_fields(position, {**framed, "name": TEXT, "sheet": ID, "file": nullable(TEXT),
                                             "entries": seq(sheet_entry), "repeat": obj({"name": TEXT, "from": INT, "to": INT},
                                                                                      ["from", "to"])},
                                   ["w", "h", "name", "sheet", "entries"]),
        "bus": obj({**path, "width": PNM}, ["points"]),
        "busentry": with_fields(position, {"size": nullable(PNM)}),
        "noerc": with_fields(position, {"type": STRING}),
        "textframe": with_fields(position, {"w": NM, "h": NM, **text, **note}, ["w", "h", "text"]),
        "image": with_fields(r("positionXY"), {**framed, "asset": r("imageAssetRef"), "crop": r("imageUVRegion"),
                                               "extent": tuple_of(integer(1, 100000), integer(1, 100000)),
                                               "name": {**STRING, "maxLength": 255}, "alt": nullable(TEXT),
                                               "caption": nullable(TEXT), "clip": clip}, ["asset", "name", "w", "h"]),
        "frame": with_fields(r("notebookBounds"), {"name": {**STRING, "pattern": r"\S", "maxLength": 300}}, ["name"]),
        "richtext": with_fields(r("notebookBounds"), {**text, **note}, ["text", "richText"]),
        "math": with_fields(r("notebookBounds"), {"tex": {**STRING, "maxLength": 8192, "pattern": r"\S"},
                                                "em": PNM}, ["tex"]),
        "calculation": with_fields(r("notebookBounds"), {"text": STRING, "calculation": r("calculationValue")},
                                   ["text", "calculation"]),
        "widget": with_fields(r("notebookBounds"), {**text, "widget": r("widgetState")}, ["text", "widget"]),
        "imageMarkup": obj({"imageId": ID, "shape": choices("arrow", "ellipse", "box", "highlight", "text"),
                            "at": r("imageUVPoint"), "to": r("imageUVPoint"), "width": UV_POS,
                            "colour": {**TEXT, "pattern": "^#[A-Fa-f0-9]{6}$"},
                            "points": seq(tuple_of(UV, UV, PRESSURE), maxItems=100000),
                            "richText": nullable(union(TEXT, r("richText")))},
                           ["imageId", "shape", "at", "to", "width", "colour"]),
        "notesLayer": r("notesLayerValue"),
        "sticky": with_fields(r("notebookBounds"), {**text, **note}, ["text"]),
        "callout": with_fields(r("notebookBounds"), {**text, **note}, ["text"]),
        "reviewItem": obj({"at": POINT, "parentId": ID, "threadId": ID, "text": TEXT, "done": BOOL}, ["parentId"]),
        "inkStroke": union(obj({"points": seq(tuple_of(NM, NM, PRESSURE), minItems=1),
                                "brush": STRING, "colour": STRING, "width": PNM}, ["points"]),
                           obj({"at": POINT, "brush": STRING, "colour": STRING, "width": PNM, "ink": r("inkValue")},
                               ["ink"])),
    }


def metadata_defs():
    dimension = obj({
        "id": ID, "sheet": ID, "view": nullable(ID), "type": STRING, "axis": STRING, "kind": STRING,
        "a": r("drawingAnchor"), "b": r("drawingAnchor"), "points": seq(r("drawingAnchor")),
        "offset": NM, "angle": ANGLE, "precision": integer(0, 4), "text": TEXT,
    }, ["id", "sheet", "type"], allOf=[
        when("type", choices("linear", "radial", "ordinate"), {"required": ["a", "view"]}),
        when("type", const("linear"), {"required": ["b"]}),
    ])
    drawing_view = obj({"id": ID, "sheet": ID, "type": STRING, "x": NM, "y": NM, "scale": NUMERIC,
                        "side": choices("Top", "Bottom"), "board": ID, "parent": ID, "label": TEXT,
                        "title": TEXT, "a": POINT, "b": POINT, "center": POINT, "radius": PNM,
                        "options": obj({"rows": POS, "width": PNM, "zscale": NUMERIC})},
                       ["id", "sheet", "type"], allOf=[
        when("type", choices("board", "assembly", "isometric", "drill-table", "layer-stack", "bom", "notes",
                             "revisions", "section", "detail"), {"required": ["x", "y"]}),
        when("type", const("section"), {"required": ["parent", "a", "b"]}),
        when("type", const("detail"), {"required": ["parent", "center", "radius"]}),
    ])
    drawing = obj({
        "version": POS, "board": nullable(TEXT),
        "sheets": seq(obj({"id": ID, "name": TEXT, "size": STRING, "orientation": STRING,
                          "titleBlock": BOOL}, ["id", "name", "size"]), minItems=1),
        "views": seq(r("drawingViewValue")), "dimensions": seq(r("drawingDimensionValue")),
        "notes": seq(obj({"id": ID, "text": TEXT}, ["id", "text"])),
        "parameters": obj(additionalProperties=TEXT),
    })
    panel_cell = obj({"board": ID, "rotation": NUMERIC, "skip": BOOL, "row": NAT, "column": NAT})
    panel = obj({"version": POS, "board": TEXT, "rows": POS, "cols": POS, "spacing": NM, "spacingY": NUMERIC,
                 "rotation": NUMERIC, "separation": STRING, "alternate": STRING, "preset": STRING,
                 "cells": union(obj(additionalProperties=r("panelCellValue")), seq(r("panelCellValue"))),
                 **dict.fromkeys(["rails", "tabs", "fiducials", "tooling", "text", "thieving", "mill"], obj())}, ["board"])
    license_value = obj({"credit": TEXT, "licence": TEXT, "licenceText": TEXT, "sourceUrl": TEXT,
                         "licenceUrl": TEXT, "modified": BOOL, "attribution": obj()})
    model_link = obj({"file": TEXT, "name": TEXT, "model": r("modelRef"), "offset": POINT,
                      "position": POINT, "rotation": tuple_of(ROTATION, ROTATION, ROTATION), "scale": NUMERIC})
    library = obj({
        "symbol": obj({"pins": seq(r("pinValue")), "shapes": seq(r("shapeValue")), "name": TEXT}),
        "footprint": obj({"pads": seq(r("libraryPadValue")), "shapes": seq(r("shapeValue")),
                          "bodies3d": seq(r("bodyValue")), "bodyModels": seq(r("modelAliasValue")),
                          "model3d": r("modelLink"), "name": TEXT}),
        "model3d": r("modelLink"), "mirrorOf": nullable(ID), "prefix": TEXT, "value": TEXT, "category": TEXT,
        "source": license_value, "attribution": license_value,
        "parameters": obj(additionalProperties=r("nativeValue")), "family": r("nativeValue"),
    }, anyOf=[{"required": ["symbol"]}, {"required": ["footprint"]}])
    document = obj({
        "grid": PNM, "outline": seq(POINT), "notes": seq(TEXT), "origin": POINT, "thickness": PNM,
        "notesLayer": r("notesLayerValue"), "hopOvers": BOOL, "boardShape": r("boardShape"),
        "stackup": obj({"version": POS, "layers": seq(r("layerValue")), "drillPairs": seq(obj())}),
        "pcbDrawing": obj({"pours": seq(r("copperRegionValue")), "annotations": obj(), "nativeText": BOOL}),
        "bodyModels": seq(r("modelAliasValue")), "bodies3d": seq(r("bodyValue")),
        "panel": panel, "drawing": drawing, "sheet": r("sheetSettings"), "parameters": obj(),
    })
    return {
        "itemCommon": obj({"angle": nullable(ANGLE), "locked": nullable(BOOL), "at": POINT,
                           "x": NM, "y": NM, "arc": nullable(union(BOOL, r("geometryArc"))),
                           "ellipse": nullable(r("schematicEllipse")), "bezier": nullable(r("schematicBezier")),
                           "regionShape": nullable(r("regionShape")), "keepoutRestrictions": integer(0, 31)}),
        "sheetSettings": obj({"infinite": BOOL, "size": STRING, "orientation": STRING, "titleBlock": STRING,
                              "width": PNM, "height": PNM}),
        "documentSettingsValue": document,
        "drawingAnchor": union(POINT, obj({"k": STRING, "id": ID, "i": NAT, "j": NAT, "ref": TEXT,
                                           "where": union(NAT, STRING), "point": POINT}, ["k"])),
        "drawingViewValue": drawing_view,
        "drawingDimensionValue": dimension,
        "panelCellValue": panel_cell,
        "librarySettingsValue": library,
        "modelLink": model_link,
        "pinValue": with_fields(r("positionXY"), {
            "id": ID, "number": TEXT, "name": TEXT, "type": STRING, "direction": union(TEXT, INT),
            "angle": nullable(ANGLE), "length": NNM, "hidden": BOOL, "gate": union(ID, INT),
        }, ["number"]),
        "libraryPadValue": {"allOf": [r("positionXY"), r("padFields")], "properties": {"id": ID}},
        "planeRelief": obj({"expansion": NNM, "airGap": NNM, "width": NNM, "entries": choices(2, 4)},
                           ["expansion", "airGap", "width", "entries"]),
        "imageAssetRef": with_fields(r("assetRef"), {"mediaType": choices(
            "image/heic", "image/jpeg", "image/png", "image/webp", "image/svg+xml", "image/gif")}),
    }


def optional_project_shapes():
    """Physical 2.1 metadata. Known fields are checked and retained extensions stay open."""
    uuid = r("butterRowId")
    view_text = r"^[^\u0000-\u001f\u007f\ud800-\udfff]+$"

    def text(limit, *, pattern=view_text):
        return {**STRING, "maxLength": limit, "pattern": pattern}

    def named(limit, pattern=view_text):
        return {**text(limit, pattern=pattern), "allOf": [{"pattern": r"\S"}]}

    def metadata(payload, *, ordered=False, repeated_identity=True):
        props = {**({"id": uuid} if repeated_identity else {}), **payload["properties"]}
        required = (["id"] if repeated_identity else []) + payload.get("required", [])
        value = {**payload, "properties": props, "required": required}
        return obj({"id": uuid, "value": value, **({"order": r("order")} if ordered else {})},
                   ["value"] + (["order"] if ordered else []))

    project_name = named(200)
    view_id = text(512)
    source = obj({"objectId": uuid, "documentId": uuid,
                  "kind": text(40, pattern=r"^[a-z][a-zA-Z0-9-]{0,39}$")}, ["objectId"])
    address = obj({"projectId": uuid, "objectId": uuid,
                   "fragment": {**TEXT, "pattern": r"^datasheet:page=[1-9][0-9]{0,15}$",
                                "description": "One-based page as a safe integer. The reader checks the bound and the referenced datasheet."}},
                  ["projectId", "objectId"])
    terminal = text(1024, pattern=r"^[^\u0000-\u001f\u007f-\u009f\ud800-\udfff]+$")
    anchor = obj({"kind": choices("pin", "net"), "documentId": uuid, "ownerId": uuid,
                  "terminal": {**STRING, "maxLength": 160}, "terminalId": terminal},
                 ["kind", "documentId", "ownerId"], allOf=[
        when("kind", const("pin"), {"required": ["terminal"]},
             {"not": union({"required": ["terminal"]}, {"required": ["terminalId"]})}),
    ])
    saved_query = obj({"name": named(512, r"^[^\u0000-\u001f\ud800-\udfff]+$"),
                       "query": r("queryScope"),
                       "scope": obj({"documentId": r("queryId"), "instanceId": r("queryId")}, allOf=[
                           when("instanceId", True, {"required": ["documentId"]}),
                       ]),
                       "columns": seq(r("queryId"), uniqueItems=True, maxItems=48)}, ["name", "query", "scope"])
    scale_decimal = with_fields(r("numberValue"), {
        "$number": {"pattern": r"^(?:0\.[0-9]{0,8}[1-9][0-9]*|[1-9][0-9]{0,5}(?:\.[0-9]+)?|1000000)$"},
    })
    scale = union(integer(1, 1000000), scale_decimal)
    coordinate = integer(-10**15, 10**15, "Integer nanometres.")
    camera = obj({"center": tuple_of(coordinate, coordinate),
                  "scale": scale, "referenceScale": scale,
                  "rotationRadians": union(integer(-3, 3), r("numberValue")), "flipped": BOOL},
                 ["center", "scale", "referenceScale", "rotationRadians", "flipped"],
                 description="Center is in integer nanometres. Nonintegral scales and radians use the native $number wrapper. The native reader checks decoded bounds.")
    viewport = obj(dict.fromkeys(["pixelWidth", "pixelHeight"], integer(1, 32768)), ["pixelWidth", "pixelHeight"])
    layers = obj({"active": view_id, "hidden": seq(view_id, uniqueItems=True, maxItems=4096),
                  "mode": choices("all", "dim", "single")}, ["active", "hidden", "mode"])
    query_reference = obj({"savedQueryId": uuid}, ["savedQueryId"], additionalProperties=False)
    inline_query = {"allOf": [r("queryScope"), {"not": {"required": ["savedQueryId"]}}]}
    view_filter = obj({"scope": union(query_reference, inline_query), "mask": BOOL, "highlight": BOOL},
                      ["scope", "mask", "highlight"])
    saved_view = obj({"name": project_name, "documentId": view_id, "camera": camera,
                      "viewport": viewport, "selection": seq(view_id, uniqueItems=True, maxItems=10000),
                      "layers": layers, "filter": view_filter, "netHighlight": view_id},
                     ["name", "documentId", "camera", "viewport", "selection"])
    display_text = r"^[^\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f\ud800-\udfff]*$"
    slide_source = kind_dispatch({
        "frame": obj({"documentId": view_id, "frameId": view_id}, ["documentId", "frameId"]),
        "savedView": obj({"savedViewId": uuid}, ["savedViewId"]),
    })
    slide = obj({"name": project_name, "aspect": choices("16:9", "4:3"),
                 "notes": {**TEXT, "maxLength": 16384, "pattern": display_text}, "source": slide_source},
                ["name", "aspect", "notes", "source"])
    size, page = integer(1, 128 * 1024**2), integer(1, 100000)
    asset = obj({"sha256": DIGEST, "byteLength": size, "mediaType": const("application/pdf")},
                ["sha256", "byteLength", "mediaType"],
                description="An embedded PDF. The native reader checks that the digest and length equal the outer reference.")
    https = text(2048, pattern=r"^https://(?:\[[a-f0-9:]+\]|[a-z0-9._~-]+)(?::[0-9]{1,5})?/[^\u0000-\u0020\u007f#\\]*$")
    datasheet = obj({"sha256": DIGEST, "title": named(255, display_text), "byteLength": size,
                     "version": named(96, display_text), "sourceURL": https, "pageCount": page, "asset": asset},
                    ["sha256", "title", "byteLength"])
    annotation = obj({"datasheetId": uuid, "page": page, "region": r("imageUVRegion"),
                       "type": choices("highlight", "note", "ink"), "text": named(8192, display_text),
                       "points": seq(r("imageUVPoint"), minItems=2, maxItems=4096)},
                      ["datasheetId", "page", "region", "type"], allOf=[
        when("type", const("note"), {"required": ["text"]}, {"not": {"required": ["text"]}}),
        when("type", const("ink"), {"required": ["points"]}, {"not": {"required": ["points"]}}),
    ])
    return {
        "savedQuery": metadata(saved_query, ordered=True),
        "link": metadata(obj({"source": source, "target": address, "label": {**TEXT, "maxLength": 160}},
                             ["source", "target"])),
        "linkAnchor": metadata(anchor),
        "savedView": metadata(saved_view, ordered=True),
        "slide": metadata(slide, ordered=True),
        "datasheetRef": metadata(datasheet, repeated_identity=False),
        "datasheetAnnotation": metadata(annotation, repeated_identity=False),
    }


def table_shapes():
    widget = obj({"type": const("table"), "fallback": r("widgetFallback"), "state": obj({
        "tableVersion": const(1), "banded": BOOL, "headerRows": integer(0, 8192), "headerColumns": integer(0, 256),
    }, ["tableVersion", "banded", "headerRows", "headerColumns"])}, ["type", "fallback", "state"])
    child = {"localId": ID, "tableId": ID}
    return {
        "notebookTable": with_fields(r("notebookBounds"), {"widget": widget}, ["widget"]),
        "tableRow": obj({**child, "order": r("order"), "heightNm": PNM}, [*child, "order"]),
        "tableColumn": obj({**child, "order": r("order"), "title": {**TEXT, "maxLength": 512}, "widthNm": PNM},
                           [*child, "order", "title"]),
        "tableCell": obj({**child, "rowId": ID, "columnId": ID, "content": obj(), "style": obj()},
                         [*child, "rowId", "columnId"], anyOf=[{"required": ["content"]}, {"required": ["style"]}]),
        "tableMerge": obj({**child, "rows": seq(ID, minItems=1, uniqueItems=True),
                           "columns": seq(ID, minItems=1, uniqueItems=True)}, [*child, "rows", "columns"]),
    }


def project_shapes(suffixes, optional):
    document = obj({"docKind": STRING, "name": STRING, "path": r("portablePath")}, ["docKind", "name", "path"],
                   allOf=[
                       when("docKind", const(kind), obj({"path": {"pattern": re.escape(suffix) + "$"}}))
                       for kind, suffix in sorted(suffixes.items())
                   ], description="The owner file carries the same ID. For recognized document kinds, name is the path's filename stem. Unknown document kinds follow opaque-owner policy.")
    settings = obj({"key": STRING, "value": True}, ["key", "value"], allOf=[
        when("key", const("rules"), obj({"value": obj({"version": POS, "format": TEXT, "units": TEXT,
                                                     "calculationTolerances": obj()})})),
        when("key", const("ruleSets"), obj({"value": obj({"version": POS, "sets": seq(obj({
            "name": STRING, "rules": obj({"list": seq(r("ruleValue"))}),
        }, ["name"]))})})),
        when("key", choices("signals", "review", "projectExtensions"), obj({"value": obj()})),
    ])
    member = {"path": r("portablePath")}
    output = obj({"kind": STRING, "enabled": BOOL, "folder": TEXT, "format": TEXT, "options": obj({
                    "infiniteLayout": STRING, "infiniteScale": r("exactDecimal"),
                })}, ["kind"])
    reviewer = {"id": ID, "author": TEXT, "text": TEXT, "created": TEXT, "modified": TEXT, "type": STRING}
    end = obj({"part": ID, "ref": ID, "pin": STRING}, ["pin"],
              anyOf=[{"required": ["part"]}, {"required": ["ref"]}])
    signal_path = obj({"name": STRING, "from": end, "to": end,
                       **dict.fromkeys(["through", "nets", "tags"], seq(STRING))}, ["name", "from", "to"])
    leg = obj({"nets": seq(STRING, minItems=1, maxItems=64), "polarity": choices(-1, 1)}, ["nets"])
    signal = obj({
        "id": ID, "kind": STRING, "name": STRING, "legs": seq(leg), "paths": seq(signal_path), "span": BOOL,
        **dict.fromkeys(["boards", "tags", "exclude", "through", "stages", "members"], seq(ID)),
        **dict.fromkeys(["intent", "impedance", "params", "altium"], obj()),
        "origin": union(TEXT, obj()), "comment": {**TEXT, "maxLength": 4000},
    }, ["id", "kind", "name"], allOf=[
        when("kind", const("bus"), {"required": ["members"], "not": {"required": ["legs"]}}),
        when("kind", const("single"), obj({"legs": seq(leg, minItems=1, maxItems=1)}, ["legs"])),
        when("kind", const("diff"), obj({"legs": tuple_of(
            obj({"polarity": choices(1, -1)}, ["polarity"]),
            obj({"polarity": choices(1, -1)}, ["polarity"])
        )}, ["legs"])),
    ])
    return {
        "document": document,
        "library": obj({"path": {"allOf": [member["path"], {"pattern": r"^libraries/.+\.wlib$"}]}}, ["path"]),
        "layoutBlock": obj({"path": {"allOf": [member["path"], {"pattern": r"^libraries/.+\.wblock$"}]}}, ["path"]),
        "importIndex": obj({"path": {"allOf": [member["path"], {"pattern": r"^\.waffle/imports/.+"}]}}, ["path"]),
        "release": obj({
            "snapshot": with_fields(r("assetRef"), {"mediaType": const("application/vnd.waffle.snapshot+jsonl")}),
            "value": obj({"id": ID, "letter": STRING, "status": STRING, "date": TEXT, "released": TEXT,
                          "description": TEXT, "notes": union(TEXT, seq(TEXT)), "stored": obj({"chunks": NAT, "bytes": NAT})})
        }, ["snapshot", "value"]),
        "projectSetting": settings,
        "rule": obj({"value": r("ruleValue")}, ["value"]),
        "signal": obj({"value": signal}, ["value"]),
        "tag": obj({"value": obj({"name": STRING, "color": {**TEXT, "pattern": "^#[A-Fa-f0-9]{6}$"},
                                 "comment": {**TEXT, "maxLength": 4000},
                                 "as": obj(additionalProperties=nullable(STRING)),
                                 "altium": obj(), "impedance": obj(), "params": obj()}, ["name"])}, ["value"]),
        "variant": obj({"value": obj({"id": ID, "name": STRING, "description": TEXT, "parts": obj()}, ["id", "name"])}, ["value"]),
        "bomView": obj({"value": obj({"id": ID, "name": TEXT, "columns": seq(TEXT), "groupBy": seq(TEXT),
                                     "source": STRING, "board": nullable(ID), "variant": nullable(ID)}, ["name"])}, ["value"]),
        "outputJob": obj({"value": obj({"id": ID, "name": STRING, "outputs": seq(output, maxItems=64),
                                       "stopOnFailure": BOOL, "fabProfile": TEXT, "variant": nullable(ID)},
                                       ["name", "outputs"])}, ["value"]),
        "reviewThread": obj({"value": obj({**reviewer, "type": const("thread"), "doc": ID, "status": STRING,
                                          "anchor": obj({"kind": STRING, "id": ID, "at": POINT}, ["kind"]),
                                          "resolved": nullable(obj({"at": TEXT, "by": TEXT}))},
                                         ["id", "type", "doc", "anchor", "author", "text", "created"])}, ["value"]),
        "reviewReply": obj({"value": obj({**reviewer, "type": const("reply"), "thread": ID},
                                        ["id", "type", "thread", "author", "text", "created"])}, ["value"]),
        **optional,
    }


def packed_source_defs():
    """Physical projection table. Lengths and dictionary references are validated on decode."""
    def tagged(tag, *items):
        return tuple_of(const(tag), *items)

    count = integer(0, 4000000)
    packed = r("packedSourceValue")
    indices = r("packedSourceIntegers")
    strings = seq(TEXT)
    group = tuple_of(seq(STRING, uniqueItems=True), nullable(indices), seq(packed))
    return {
        "packedSourceIntegers": union(
            {"type": "array", "prefixItems": [const("a")], "items": INT, "minItems": 1, "maxItems": 4000001},
            tagged("i", count, choices(0, 1, 2, 3), BASE64),
        ),
        "packedSourceValue": union(
            NULL, BOOL, {"type": "number"}, TEXT, obj(additionalProperties=packed),
            {"type": "array", "prefixItems": [const("a")], "items": packed, "minItems": 1, "maxItems": 4000001},
            tagged("s", count), tagged("i", count, choices(0, 1, 2, 3), BASE64),
            tagged("w", indices), tagged("l", packed, indices), tagged("m", packed, indices),
            tagged("d", packed), tagged("f", indices, strings), tagged("p", strings, indices, indices),
            tagged("t", count, seq(group)),
        ),
        "packedSourceTable": obj({"version": const(1), "strings": {"allOf": [{"type": "array"}, packed]},
                                  "values": obj(additionalProperties=packed)}, ["version", "strings", "values"],
                                 description="Packed retained-source projection. Column arity is structural; dictionary indexes, decoded alignment and aggregate resource bounds are checked by the reader."),
    }


def sidecar_shapes():
    git = obj({"algorithm": choices("sha1", "sha256"), "commit": DIGEST, "path": r("portablePath")},
              ["algorithm", "commit", "path"], additionalProperties=False)
    git["properties"]["commit"] = {**TEXT, "pattern": "^[a-f0-9]+$"}
    git["allOf"] = [
        when("algorithm", const("sha1"), obj({"commit": {"minLength": 40, "maxLength": 40}}),
             obj({"commit": {"minLength": 64, "maxLength": 64}})),
    ]
    input_row = obj({"id": {**TEXT, "pattern": "^input-[0-9]{6}$"}, "name": {**STRING, "pattern": r"^[^/\\:\u0000-\u001f\u007f]+$"},
                     "path": r("portablePath"), "sha256": DIGEST, "byteLength": integer(0, 256 * 1048576),
                     "git": nullable(git), "metadata": obj()}, ["name", "sha256", "byteLength"])
    raw = obj({"report": obj({"translator": STRING, "kinds": seq(obj())}, ["translator", "kinds"]),
               "provenance": obj(**{"not": {"required": ["files"]}}), "binding": obj(), "residuals": seq(obj()), "ruleRows": seq(obj())},
              ["report", "provenance"])
    projection = obj({"id": const("projection"), "documents": seq(ID), "names": seq(STRING)},
                     ["documents", "names"], oneOf=[obj({"table": r("packedSourceTable")}, ["table"]), raw])
    return {"input": input_row, "projection": projection}


def key_name(kind, suffix):
    return ("importIndex" if kind == "import-index" else kind) + suffix


def build():
    registry = native_registry()
    version, suffixes, owner_rows = registry["version"], registry["suffixes"], registry["rows"]
    sidecar = registry["sidecar"]
    defs = {**primitives(version), **geometry_defs(), **query_defs(), **notebook_defs(), **metadata_defs(), **packed_source_defs()}
    # A historic ID and omitted requires remain readable. Use this extra profile only
    # when checking output of the amended writer, not when checking an existing file.
    defs["featureList"] = seq(STRING, uniqueItems=True, **{
        "not": {"contains": const("continuation-parts-v1")},
    })
    defs["readerRequires"] = obj(propertyNames=STRING, additionalProperties=r("version"))
    defs["opaqueRecord"] = obj({"kind": STRING, "id": ID}, ["kind", "id"],
        description="Opaque optional body row or body of an opaque owner, admitted by the file compatibility policy. Retain its exact physical JSON bytes and do not interpret additional fields.")
    defs["rowIdentity"] = with_fields(r("opaqueRecord"), {"order": r("order"), "formatVersion": r("version")})
    defs["opaqueHeader"] = with_fields(r("opaqueRecord"), {
        "formatVersion": r("version"), "compatibleWith": r("version"),
        "requires": r("featureList"), "readerRequires": r("readerRequires"),
    }, ["formatVersion"], description="First row of an opaque owner. Its required features and version determine whether the file can be represented safely.")

    header_shapes = {
        "project": obj({"name": STRING, "entryDocument": ID}, ["name"]),
        "schematic": obj({"sheet": r("sheetSettings")}),
        "pcb": obj(),
        "drawing": obj(),
        "panel": obj(),
        "library": obj({"name": TEXT}, ["name"]),
        "block": obj({"name": TEXT}, ["name"]),
        "snapshot": obj(),
        "import-index": obj(description="Reserved codec kind. Retained source indexes are written as importBindings."),
        sidecar: obj({"kind": const(sidecar), "id": {**TEXT, "pattern": "^[A-Za-z0-9_-]{1,100}$"},
                      "formatVersion": const(version)}, ["kind", "id", "formatVersion"], additionalProperties=False),
    }
    if set(header_shapes) != set(owner_rows):
        raise SystemExit("gen-schema: native header coverage differs from the codec: " +
                         ", ".join(sorted(set(header_shapes).symmetric_difference(owner_rows))))
    for kind, body in header_shapes.items():
        defs[key_name(kind, "Header")] = {"allOf": [
            r("opaqueHeader"), obj({"kind": const(kind)}, ["kind"]), body,
        ]}
    defs["header"] = kind_dispatch({kind: r(key_name(kind, "Header")) for kind in header_shapes})
    table, optional_version = registry["table"], registry["optionalVersion"]
    defs["tableProjectBase"] = obj({
        "kind": const("project"), "formatVersion": const(table["version"]),
        "requires": seq(const(table["feature"]), minItems=1, maxItems=1),
        "tableBaseVersion": const(optional_version), "compatibleWith": False,
        "readerRequires": obj({table["feature"]: const(table["version"])}),
    }, ["kind", "formatVersion", "requires", "tableBaseVersion"])
    defs["header"]["allOf"].append(when("tableBaseVersion", True, r("tableProjectBase")))
    defs["butterRowId"] = r("uuidV7")
    defs["butterOptionalProjectHeader"] = with_fields(r("header"), {
        "kind": const("project"), "formatVersion": const(optional_version),
        "requires": seq(STRING, maxItems=0), "readerRequires": obj(additionalProperties=False),
    }, description="Optional metadata manifest. Existing document and library owners keep their native version.")
    amended = set(suffixes) | {"library"}
    defs["amendedOwnerHeader"] = kind_dispatch({kind: with_fields(r(key_name(kind, "Header")),
                                                                   {"requires": r("featureList")}, ["requires"])
                                                for kind in amended},
                                               description="Header produced for a schematic, PCB, drawing, panel or library by the amended 2.0 writer.")

    def value(name):
        return obj({"value": r(name)}, ["value"])

    document_members = {
        "documentSettings": value("documentSettingsValue"),
        "panelCell": value("panelCellValue"),
        "drawingView": value("drawingViewValue"),
        "drawingDimension": value("drawingDimensionValue"),
        "boardBody": value("bodyValue"),
        "modelAlias": value("modelAliasValue"),
        "layer": value("layerValue"),
        "copperRegion": value("copperRegionValue"),
    }
    items = item_shapes()
    for kind, shape in items.items():
        name = key_name(kind, "Item")
        defs[name] = {"allOf": [r("itemCommon"), shape]} if kind not in {"imageMarkup", "notesLayer"} else shape
        document_members[kind] = r(name)
    library = {
        "librarySettings": value("librarySettingsValue"),
        "pin": value("pinValue"),
        "pad": value("libraryPadValue"),
        "shape": obj({"side": choices("symbol", "footprint"), "value": r("shapeValue")}, ["side", "value"]),
        "boardBody": document_members["boardBody"],
        "modelAlias": document_members["modelAlias"],
    }
    block = {kind: document_members[kind] for kind in items}
    block.update({
        "blockSettings": obj({"value": obj(), "size": tuple_of(PNM, PNM)}, ["value", "size"]),
        "blockLibrary": obj({"header": r("libraryHeader"), "records": seq(r("libraryRecord"))}, ["header", "records"]),
    })
    snapshot = {
        "snapshotMember": obj({
            "path": r("portablePath"), "fileKind": choices("project", "library", "block", *suffixes),
            "ownerId": ID, "asset": with_fields(r("assetRef"), {"mediaType": const("application/vnd.waffle.records+jsonl")}),
        }, ["path", "fileKind", "ownerId", "asset"]),
        "snapshotModel": r("modelRef"),
    }
    optional, tables = optional_project_shapes(), table_shapes()
    appended = (*optional, *tables)
    groups = {
        "project": project_shapes(suffixes, optional),
        **dict.fromkeys(suffixes, document_members),
        "schematic": {**document_members, **tables},
        "library": library, "block": block, "snapshot": snapshot, "import-index": {}, sidecar: sidecar_shapes(),
    }
    combined = {}
    owner_dispatch = {}
    for owner, owner_kinds in owner_rows.items():
        declared, expected = groups[owner], set(owner_kinds)
        if set(declared) != expected:
            missing = sorted(expected.difference(declared))
            extra = sorted(set(declared).difference(expected))
            raise SystemExit(f"gen-schema: {owner} native row schema coverage differs; missing {missing}; extra {extra}")
        owner_name = key_name(owner, "Record")
        if not expected:
            defs[owner_name] = False
            continue
        envelope = r("rowIdentity")
        owner_refs = {}
        for kind, definition in declared.items():
            name = ("libraryPadRecord" if kind == "pad" and owner == "library"
                    else "documentReferenceRecord" if kind == "document" and owner == "project"
                    else "libraryReferenceRecord" if kind == "library" and owner == "project"
                    else "tableOwnerRecord" if kind == "notebookTable"
                    else key_name(kind, "Record") if kind in tables
                    else key_name(kind, "RecordShape"))
            leaf = {"allOf": [envelope, obj({"kind": const(kind)}, ["kind"]), definition]}
            if name in defs and defs[name] != leaf:
                raise SystemExit(f"gen-schema: {owner}/{kind} conflicts with {name}; give it its own schema")
            defs[name] = leaf
            pointer = owner_refs[kind] = r(name)
            variants = combined.setdefault(kind, [])
            if pointer not in variants:
                variants.append(pointer)
        signature = tuple(sorted((kind, ref["$ref"]) for kind, ref in owner_refs.items()))
        if signature in owner_dispatch:
            defs[owner_name] = r(owner_dispatch[signature])
        else:
            owner_dispatch[signature] = owner_name
            defs[owner_name] = kind_dispatch(owner_refs, appended=appended)
    defs["record"] = kind_dispatch({kind: refs[0] if len(refs) == 1 else union(*refs) for kind, refs in combined.items()},
                                   appended=appended)
    defs["notebookRecord"] = kind_dispatch({kind: document_members[kind] for kind in [
        "frame", "richtext", "math", "calculation", "widget", "image", "imageMarkup", "notesLayer",
        "sticky", "callout", "reviewItem", "inkStroke", "textframe", "documentSettings",
    ]}, r("rowIdentity"))
    # Keep added definitions after the original profiles, in publication order.
    for name in ["butterRowId", "butterOptionalProjectHeader", *(key_name(kind, "RecordShape") for kind in optional),
                 "tableProjectBase", "tableOwnerRecord", *(key_name(kind, "Record") for kind in tables if kind != "notebookTable")]:
        defs[name] = defs.pop(name)
    return {
        "$schema": "https://json-schema.org/draft/2020-12/schema",
        "$id": "urn:waffle:native:folder-record:" + version,
        "title": "Waffle native folder record",
        "description": "Schema for one JSONL row of a Waffle native design. Validate the first row against header, then each recognized body row against the owning file's *Record schema. Use opaqueHeader/opaqueRecord only after applying the file's compatibility policy. Canonical bytes, encoding limits, identity, row order, required-feature support, file membership and digests require file-level validation.",
        "anyOf": [r("header"), r("record")],
        "$defs": defs,
    }
