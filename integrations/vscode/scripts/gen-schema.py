#!/usr/bin/env python3
"""Generate the internal project schema and the public JSONL native record schema.

    python3 integrations/vscode/scripts/gen-schema.py          # write the schema
    python3 integrations/vscode/scripts/gen-schema.py --check  # fail if it is stale

The constants for the editor's in-memory project projection (the format tag and version, the
document kinds, the item kinds, which kinds are paths and their minimum vertex counts, the
coordinate bound and the collection limits) are read out of `validationSteps` in
app/model.js. Every pattern must match exactly once, so a change to the validator that
this script does not understand fails loudly instead of producing a stale schema.

The schema is a structural subset: Waffle's validator stays the authority (the extension
also runs it), but the schema gives VS Code completion, hovers and precise locations.
"""
import json
import re
import sys
from pathlib import Path

import native_schema

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[2]
MODEL = ROOT / "app" / "core/model.js"
OUT = HERE.parent / "schema" / "waffle.schema.json"


def one(pattern, text, what):
    found = re.findall(pattern, text)
    if len(found) != 1:
        sys.exit(f"gen-schema: expected one match for {what} in app/core/model.js, found {len(found)}; update gen-schema.py")
    return found[0]


def extract(src):
    c = {}
    c["format"], c["version"] = one(r'p\.format!=="(\w+)"\|\|p\.version!==(\d+)', src, "format/version")
    c["version"] = int(c["version"])
    # Format version major.minor that new projects carry (app/compat.js CURRENT).
    c["formatVersion"] = one(r'version:\d+,formatVersion:"(\d+\.\d+)"', src, "project() formatVersion")
    items = one(r'allowedItems=new Set\(\[([^\]]*)\]\)', src, "allowedItems")
    c["items"] = re.findall(r'"(\w+)"', items)
    text_justify = one(r'pcbTextJustifications=new Set\(\[([^\]]*)\]\)', src, "PCB text justifications")
    c["pcbTextJustifications"] = re.findall(r'"([\w-]+)"', text_justify)
    # Every kind in the chain (it grew from three to four with drawing documents).
    kinds = one(r'if\(((?:d\.kind!=="\w+"&&)+d\.kind!=="\w+")\|\|!str\(d\.name\)', src, "document kinds")
    c["docKinds"] = re.findall(r'"(\w+)"', kinds)
    paths = one(r'if\(((?:i\.kind==="\w+"\|\|)+i\.kind==="\w+")\)\{points\(i\.points\)', src, "path item kinds")
    c["pathKinds"] = re.findall(r'"(\w+)"', paths)
    poly, more, fewer = one(r'i\.points\.length<\(i\.kind==="(\w+)"\?(\d+):(\d+)\)', src, "minimum vertices")
    c["polyKind"], c["polyMin"], c["pathMin"] = poly, int(more), int(fewer)
    c["bound"] = float(one(r'const xy = v => typeof v==="number" && Number\.isFinite\(v\) && Math\.abs\(v\)<([0-9e.]+);', src, "coordinate bound"))
    c["variants"] = int(one(r'p\.variants\.length>(\d+)', src, "variants limit"))
    c["activeVariant"] = int(one(r'p\.activeVariant\.length>(\d+)', src, "activeVariant length"))
    c["outputJobs"] = int(one(r'p\.outputJobs\.length>(\d+)', src, "outputJobs limit"))
    c["bomViews"] = int(one(r'p\.bomViews\.length>(\d+)', src, "bomViews limit"))
    c["sha"] = one(r'd\.sourceSha256!=="string" \|\| !/(\^\[0-9a-f\]\{64\}\$)/', src, "sourceSha256 pattern")
    # Sanity: the checks the schema encodes by hand still exist in the validator.
    for needle in ['if(!xy(v.w)||v.w<=0||!xy(v.h)||v.h<=0)invalid();', '!str(i.ref)||!str(i.value)',
                   '(i.kind==="label"||i.kind==="netlabel")&&!str(i.text)', 'if(!xy(i.diameter)||i.diameter<=0)invalid();',
                   '!xy(d.grid)||d.grid<=0', 'if(!str(d.name)||(!d.symbol&&!d.footprint))invalid();']:
        if needle not in src:
            sys.exit("gen-schema: app/core/model.js no longer contains " + needle + "; update gen-schema.py")
    return c


def ref(name):
    return {"$ref": "#/definitions/" + name}


def pcb_geometry(num, positive, text_justifications):
    string = {"type": "string"}
    side = {"enum": ["Top", "Bottom"]}
    encoded = {"type": "string", "pattern": "^[A-Za-z0-9+/]+={0,2}$"}
    arc = {"type": "object", "required": ["kind", "c", "r", "start", "end", "ccw"],
           "properties": {"kind": {"const": "arc"}, "c": ref("point"), "r": positive,
                          "start": num, "end": num, "ccw": {"type": "boolean"}}}
    contour = {"type": "array", "minItems": 1, "maxItems": 1000000, "items": {"oneOf": [
        ref("pcbArc"),
        {"type": "object", "required": ["kind", "a", "b"],
         "properties": {"kind": {"const": "line"}, "a": ref("point"), "b": ref("point")}},
    ]}}
    region = {"version": {"const": 1}, "contour": ref("pcbContour"),
              "cutouts": {"type": "array", "items": ref("pcbContour")}, "sig": string}
    source_text = {"type": "object", "properties": {"letterSet": {"type": "integer", "minimum": 0},
                   "writingOffset": ref("point"), "sourceJustify": {"enum": text_justifications}}}
    corner_ratio = {"type": "number", "minimum": 0, "maximum": 0.5}
    pad = {"fabTestpoint": {"enum": ["Top", "Bottom", "Both"]}, "holeOnly": {"type": "boolean"}, "slotLength": positive, "slotAngle": num,
           "sourceDrillTool": ref("pcbDrillToolIndex"),
           "roundrectRadiusRatio": corner_ratio,
           "padStack": {"additionalProperties": {"properties": {"roundrectRadiusRatio": corner_ratio}}},
           "tent": {"type": "object", "properties": {"top": {"type": "boolean"}, "bottom": {"type": "boolean"}}},
           "maskExpansion": num, "pasteExpansion": num}
    plane_length = {"type": "number", "minimum": 0, "maximum": 1000}
    relief = {"type": "object", "required": ["expansion", "airGap", "width", "entries"],
              "properties": {"expansion": plane_length, "airGap": plane_length, "width": plane_length, "entries": {"enum": [2, 4]}}}
    asset_bytes = 32 * 1048576
    return {
        "pcbArc": arc,
        "pcbContour": contour,
        "pcbRegionShape": {"type": "object", "required": ["version", "contour", "cutouts"], "properties": region},
        "pcbBoardShape": {"type": "object", "required": ["version", "contour"], "properties": {
            "source": string, **region,
            "cutoutRegions": {"type": "object", "patternProperties": {"^(0|[1-9][0-9]*)$": ref("pcbRegionShape")},
                              "additionalProperties": False},
        }},
        "pcbPad": {"type": "object", "properties": pad},
        "pcbSourceTextBox": source_text,
        "pcbBoardLabel": {"type": "object", "required": ["field", "at", "angle", "size", "layer", "mirrored"],
                          "properties": {"field": {"enum": ["ref", "value"]}, "at": ref("point"), "angle": num,
                                         "size": positive, "layer": {"type": "string", "minLength": 1},
                                         "mirrored": {"type": "boolean"}, "sourceTextBox": ref("pcbSourceTextBox")}},
        "pcbDrillToolIndex": {"type": "integer", "minimum": 0, "maximum": 9007199254740991},
        "pcbSourceDrillDrawing": {"type": "object", "required": ["tools"], "properties": {
            "tools": {"type": "array", "minItems": 1, "items": {"type": "object",
                      "required": ["mark", "diameter", "slot", "plated", "hits"], "properties": {
                          "mark": {"anyOf": [{"type": "null"}, ref("pcbDrillToolIndex")]},
                          "diameter": {"type": "number", "exclusiveMinimum": 0}, "slot": {"type": "number", "minimum": 0},
                          "hits": ref("pcbDrillToolIndex"), "plated": {"type": "boolean"}, "slotted": {"type": "boolean"}}}},
        }},
        "pcbSourceDrillPlot": {"type": "object", "required": ["board", "size"], "properties": {
            "board": string, "size": {"type": ["number", "null"], "exclusiveMinimum": 0},
        }},
        "pcbBody": {"type": "object",
                    "required": ["type", "layer", "side", "ownerSide", "sourceRecord", "identifier", "modelId",
                                 "rings", "at", "angle", "rotation", "dz", "minZ", "maxZ"],
                    "properties": {"type": {"enum": ["extruded", "step", "unsupported"]}, "layer": string,
                                   "side": side, "ownerSide": side, "sourceRecord": string, "shapeRecord": string,
                                   "identifier": string, "modelId": string, "modelType": string,
                                   "rings": {"type": "array", "maxItems": 257, "items": {"type": "array", "minItems": 3,
                                             "maxItems": 20000, "items": ref("point")}},
                                   "contour": ref("pcbContour"), "at": ref("point"), "angle": num,
                                   "rotation": {"type": "array", "items": num, "minItems": 3, "maxItems": 3},
                                   "dz": num, "minZ": num, "maxZ": num,
                                   "color": {"type": "integer", "minimum": 0, "maximum": 0xffffff},
                                   "opacity": {"type": "number", "minimum": 0, "maximum": 1}}},
        "pcbBodyModel": {"type": "object", "required": ["id", "file"], "not": {"anyOf": [
                             {"required": ["zlib", "stepText"]}, {"required": ["zlib", "assetId"]},
                             {"required": ["stepText", "assetId"]}]},
                         "properties": {"id": ref("id"), "file": string, "assetId": {"type": "string", "minLength": 1},
                                        "checksum": {"type": "integer", "minimum": 0, "maximum": 0xffffffff},
                                        "zlib": {**encoded, "maxLength": ((asset_bytes + 2) // 3) * 4},
                                        "stepText": {"type": "string", "minLength": 1, "maxLength": asset_bytes}}},
        "pcbPowerPlane": {"type": "object", "required": ["sourceLayer"],
                          "properties": {"sourceLayer": {"type": "string", "pattern": "^PLANE([1-9]|1[0-6])$"},
                                         "pad": relief, "via": relief}},
        "pcbDrawing": {"type": "object", "required": ["annotations"], "properties": {
            "pourUnverified": {"description": "An array of owner IDs records retained copper that needs a refill. "
                                  "Other values from earlier native readers are opaque."},
            "sourceHatchSignature": {"type": "string", "pattern": "^[0-9a-f]{16}$"},
            "nativeText": {"const": True},
            "annotations": {"type": "object", "additionalProperties": {"type": "array", "items": ref("pcbBoardLabel")}},
            "letterSets": {"type": "array", "items": {"type": "object",
                           "propertyNames": {"pattern": "^(0|[1-9][0-9]{0,6})$"}, "additionalProperties": {
                               "type": "array", "items": [{"type": "integer", "minimum": -2147483648, "maximum": 2147483647}, encoded],
                               "minItems": 2, "maxItems": 2}}},
        }},
    }


def schema(c):
    b = c["bound"]
    num = {"type": "number", "exclusiveMinimum": -b, "exclusiveMaximum": b}
    point = {"type": "array", "items": {"$ref": "#/definitions/coordinate"}, "minItems": 2, "maxItems": 2}
    # Inline rather than "$ref" plus siblings: draft-07 ignores keywords beside a $ref.
    positive = {"type": "number", "exclusiveMinimum": 0, "exclusiveMaximum": b}
    nonneg = {"type": "number", "minimum": 0, "exclusiveMaximum": b}
    geometry = pcb_geometry(num, positive, c["pcbTextJustifications"])
    pad = geometry.pop("pcbPad")["properties"]
    arc = {"oneOf": [{"type": "boolean"}, ref("pcbArc")]}
    keepout = {"keepoutRestrictions": {"type": "integer", "minimum": 0, "maximum": 31},
               "planeVoid": {"type": "boolean"}}
    body_list = {"type": "array", "items": ref("pcbBody")}
    body_geometry = {"bodyModelVersion": {"const": 1}, "bodies3d": body_list,
                     "bodyModels": {"type": "array", "items": ref("pcbBodyModel")}}
    path_cond = {"if": {"properties": {"kind": {"enum": c["pathKinds"]}}, "required": ["kind"]},
                 "then": {"required": ["points"], "properties": {"points": {"minItems": c["pathMin"]}}},
                 "else": {}}
    positioned = [k for k in c["items"] if k not in c["pathKinds"] and k != "imageMarkup"]
    position_cond = {"if": {"properties": {"kind": {"enum": positioned}}}, "then": {"required": ["x", "y"]}}
    uv = {"type": "integer", "minimum": 0, "maximum": 1000000}
    uv_point = {"type": "array", "minItems": 2, "maxItems": 2, "items": uv}
    mark_cond = {"if": {"properties": {"kind": {"const": "imageMarkup"}}},
                 "then": {"required": ["imageId", "shape", "at", "to", "width", "colour"],
                          "properties": {"imageId": {"type": "string", "minLength": 1},
                            "shape": {"enum": ["arrow", "ellipse", "box", "highlight", "text"]},
                            "at": uv_point, "to": uv_point,
                            "width": {**uv, "minimum": 1}, "colour": {"type": "string", "pattern": "^#[0-9a-fA-F]{6}$"}}}}
    poly_cond = {"if": {"properties": {"kind": {"const": c["polyKind"]}}, "required": ["kind"]},
                 "then": {"properties": {"points": {"minItems": c["polyMin"]}}}}
    # Known choices are examples here. The project reader validates the enum against the file's minor version.
    offsheet_io = {"type": "string", "maxLength": 64, "examples": ["unspecified", "input", "output", "bidirectional"],
                   "description": "Connector I/O direction. Omission means unspecified."}
    auto_name = {"type": "object", "required": ["part", "pin", "style"],
                 "properties": {"part": {"type": "string", "pattern": r"\S"}, "pin": {"type": "string", "pattern": r"\S"},
                                "style": {"type": "string", "pattern": r"\S", "maxLength": 64, "examples": ["hyphen", "underscore"]}},
                 "description": "Generated net name based on a connected part ID and pin number in the current channel. The label text is its fallback."}
    frame = {"if": {"properties": {"kind": {"const": "textframe"}}, "required": ["kind"]},
             "then": {"required": ["w", "h", "text"],
                      "properties": {"role": {"type": "string", "maxLength": 64, "examples": ["frame"]}},
                      "if": {"properties": {"role": {"const": "frame"}}, "required": ["role"]},
                      "then": {"properties": {"w": positive, "h": positive, "text": {"type": "string", "pattern": r"\S", "maxLength": 300}}}}}
    pdf = {"if": {"properties": {"kind": {"const": "pdf"}}, "required": ["kind"]},
           "then": {"properties": {"options": {"type": "object", "properties": {
               "infiniteLayout": {"type": "string", "maxLength": 64, "examples": ["fit", "frames", "tile"],
                                  "description": "PDF layout for infinite schematic sheets. Omission fits the drawing on one page."},
               "infiniteScale": {"type": "number", "exclusiveMinimum": 0,
                                 "description": "Printed length divided by drawing length when tiling an infinite schematic. Omission means 1:1."}}}}}}
    return {
        "$schema": "http://json-schema.org/draft-07/schema#",
        "title": "Waffle internal editor project projection",
        "description": "Internal data model used by the editor and type checks. Use waffle-folder-record.schema.json for native disk records.",
        "type": "object",
        "required": ["format", "version", "name", "library", "documents"],
        "properties": {
            "format": {"const": c["format"], "description": "Always \"%s\"." % c["format"]},
            "version": {"const": c["version"], "description": "The format's major version (the major part of formatVersion)."},
            "formatVersion": {"type": "string", "pattern": "^%d\\.\\d+$" % c["version"], "default": c["formatVersion"],
                              "description": "Format version major.minor (docs/format-versioning.md). The single-file writer uses %s. A newer minor version may add fields and kinds." % c["formatVersion"]},
            "name": {"type": "string", "description": "Project name."},
            "library": {"type": "array", "items": {"$ref": "#/definitions/definition"}, "description": "Symbol and footprint definitions."},
            "componentFamilies": {"type": "array", "description": "Optional families of exact library definitions and their part labels.",
                                  "items": {"type": "object", "required": ["id", "name", "members"],
                                            "properties": {"id": {"type": "string", "minLength": 1}, "name": {"type": "string", "minLength": 1},
                                                "members": {"type": "array", "items": {"type": "object", "required": ["defId", "part"],
                                                    "properties": {"defId": {"type": "string", "minLength": 1, "description": "Exact package definition ID."},
                                                                   "part": {"type": "string", "minLength": 1, "description": "Part label within the family."}}}}}}},
            "documents": {"type": "array", "minItems": 1, "items": {"$ref": "#/definitions/document"}},
            "importNotes": {"type": "array", "items": {"type": "string"}},
            "sourceDrillPlots": {"type": "array", "items": ref("pcbSourceDrillPlot")},
            "multichannel": {"type": "object"},
            "layoutBlocks": {"type": "array"},
            "outputJobs": {"type": "array", "maxItems": c["outputJobs"], "items": {"type": "object", "required": ["name", "outputs"],
                           "properties": {"name": {"type": "string", "minLength": 1, "maxLength": 80}, "outputs": {"type": "array", "maxItems": 64, "items": pdf}}}},
            "bomViews": {"type": "array", "maxItems": c["bomViews"], "items": {"type": "object", "required": ["name"],
                         "properties": {"name": {"type": "string", "maxLength": 80}}}},
            "variants": {"type": "array", "maxItems": c["variants"], "items": {"type": "object", "required": ["id", "name"],
                         "properties": {"id": {"type": "string"}, "name": {"type": "string"}}}},
            "activeVariant": {"type": "string", "maxLength": c["activeVariant"]},
            "extensions": {"type": "array", "description": "Extensions saved with the project. Waffle blocks them until you trust the exact bundle.",
                           "items": {"type": "object", "required": ["manifest"], "properties": {"manifest": {"type": "object"}, "files": {"type": "object"}}}},
        },
        "definitions": {
            **geometry,
            "coordinate": num,
            "point": point,
            "points": {"type": "array", "items": {"$ref": "#/definitions/point"}},
            "id": {"type": "string", "minLength": 1, "description": "Unique across the library, documents and items."},
            "shape": {"type": "object", "required": ["kind"], "properties": {
                "kind": {"enum": ["path", "circle", "text"]}, "width": nonneg,
                "points": {"$ref": "#/definitions/points"}, "x": {"$ref": "#/definitions/coordinate"}, "y": {"$ref": "#/definitions/coordinate"},
                "r": positive, "text": {"type": "string"}}},
            "pcbShape": {"allOf": [ref("shape"), {"properties": {"arc": arc,
                "regionShape": ref("pcbRegionShape"), **keepout,
                "sourceTextBox": ref("pcbSourceTextBox"), "keepout": {"type": "boolean"}, "cutout": {"type": "boolean"}}}]},
            "definition": {"type": "object", "required": ["id", "name"],
                           "anyOf": [{"required": ["symbol"]}, {"required": ["footprint"]}],
                           "properties": {
                               "id": {"$ref": "#/definitions/id"}, "name": {"type": "string"}, "mirrorOf": {"type": "string"},
                               "symbol": {"type": "object", "required": ["pins", "shapes"], "properties": {
                                   "pins": {"type": "array", "items": {"type": "object", "required": ["number", "x", "y"], "properties": {
                                       "number": {"type": "string"}, "x": {"$ref": "#/definitions/coordinate"}, "y": {"$ref": "#/definitions/coordinate"}}}},
                                   "shapes": {"type": "array", "items": {"$ref": "#/definitions/shape"}}}},
                               "footprint": {"type": "object", "required": ["pads", "shapes"], "properties": {
                                   "pads": {"type": "array", "items": {"type": "object", "required": ["x", "y", "w", "h"], "properties": {
                                       "x": ref("coordinate"), "y": ref("coordinate"), "w": positive, "h": positive,
                                       **pad}}},
                                   "shapes": {"type": "array", "items": ref("pcbShape")}, **body_geometry}}}},
            "document": {"type": "object", "required": ["id", "kind", "name", "grid", "items", "outline", "notes"],
                "allOf": [{"if": {"properties": {"kind": {"not": {"const": "schematic"}}}, "required": ["kind"]},
                    "then": {"properties": {"items": {"items": {"not": {"properties": {"kind": {"const": "textframe"}, "math": {"const": True}},
                        "required": ["kind", "math"]}}}}}}], "properties": {
                "id": {"$ref": "#/definitions/id"}, "kind": {"enum": c["docKinds"]}, "name": {"type": "string"},
                "grid": positive, "items": {"type": "array", "items": {"$ref": "#/definitions/item"}},
                "outline": {"$ref": "#/definitions/points"}, "notes": {"type": "array", "items": {"type": "string"}},
                "origin": {"$ref": "#/definitions/point"}, "hopOvers": {"type": "boolean"},
                "sheet": {"type": "object", "properties": {"infinite": {"type": "boolean",
                    "description": "Use the drawing bounds on this schematic sheet. Fixed paper is the default."}}},
                "sourceSha256": {"type": "string", "pattern": c["sha"]}, "rooms": {"type": "array"}, "sourceRules": {"type": "array", "items": {"type": "string"}},
                "boardShape": ref("pcbBoardShape"), "pcbDrawing": ref("pcbDrawing"),
                "sourceDrillDrawing": ref("pcbSourceDrillDrawing"),
                "appliedSourceRuleRecords": {"type": "array", "uniqueItems": True, "items": {"type": "integer", "minimum": 1}},
                "sourceRuleChecks": {"type": "object", "properties": {key: {"type": "array", "items": {"type": "integer", "minimum": 0, "maximum": 65535}}
                    for key in ("kinds", "batch", "online")}},
                "ruleCheckSelection": {"type": "object", "required": ["batch", "online"], "additionalProperties": False,
                    "properties": {key: {"type": "array", "uniqueItems": True, "items": {"type": "string", "pattern": "^[A-Za-z][A-Za-z0-9]{0,63}$"}}
                        for key in ("batch", "online")}},
                "sourceRulesReplaced": {"const": True},
                "sourceRuleLayers": {"type": "object", "additionalProperties": {"type": ["string", "null"]}},
                "sourceArcVersion": {"const": 1}, **body_geometry}},
            "item": {"type": "object", "required": ["id", "kind"], "allOf": [path_cond, position_cond, mark_cond, poly_cond, frame,
                {"if": {"properties": {"kind": {"const": "netlabel"}}, "required": ["kind"]}, "then": {"properties": {"autoName": auto_name}}},
                {"if": {"properties": {"kind": {"const": "offsheet"}}, "required": ["kind"]}, "then": {"required": ["text"], "properties": {"io": offsheet_io}}},
                {"if": {"properties": {"kind": {"const": "textframe"}}, "required": ["kind"]},
                 "then": {"properties": {"math": {"type": "boolean", "description": "Display the TeX source in text as a non-electrical equation."}}}},
                {"if": {"properties": {"kind": {"const": "textframe"}, "math": {"const": True}}, "required": ["kind", "math"]},
                 "then": {"required": ["text", "x", "y", "w", "h"], "properties": {"role": {"not": {"const": "frame"}}, "size": positive,
                         "text": {"type": "string", "minLength": 1, "maxLength": 8192, "pattern": r"\S"}}}},
                {"if": {"properties": {"kind": {"const": "part"}}, "required": ["kind"]}, "then": {"required": ["def", "ref", "value"]}},
                {"if": {"properties": {"kind": {"enum": ["label", "netlabel"]}}, "required": ["kind"]}, "then": {"required": ["text"]}},
                {"if": {"properties": {"kind": {"const": "pad"}}, "required": ["kind"]}, "then": {"required": ["w", "h"]}},
                {"if": {"properties": {"kind": {"const": "via"}}, "required": ["kind"]}, "then": {"required": ["diameter"]}}],
                "properties": {
                    "id": {"$ref": "#/definitions/id"}, "kind": {"enum": c["items"]},
                    "x": {"$ref": "#/definitions/coordinate"}, "y": {"$ref": "#/definitions/coordinate"}, "angle": {"$ref": "#/definitions/coordinate"},
                    "points": {"$ref": "#/definitions/points"}, "width": nonneg,
                    "w": positive, "h": positive, "diameter": positive,
                    "def": {"type": "string", "description": "Library definition id."}, "ref": {"type": "string"}, "value": {"type": "string"},
                    "text": {"type": "string"}, "net": {"type": "string"}, "layer": {"type": "string"},
                    "pinNets": {"type": "object", "additionalProperties": {"type": "string"}},
                    "groupId": {"type": "string"}, "channel": {"type": "string"}, "sourceLink": {"type": "string"},
                    "locked": {"type": "boolean"}, "teardrop": {"type": "boolean"},
                    "arc": arc, "regionShape": ref("pcbRegionShape"), **keepout,
                    "sourceTextBox": ref("pcbSourceTextBox"), "bodies3d": body_list, "powerPlane": ref("pcbPowerPlane"),
                    "boardLabels": {"type": "array", "items": ref("pcbBoardLabel")},
                    "hiddenBoardLabels": {"type": "array", "items": ref("pcbBoardLabel")},
                    **pad}},
        },
    }


def main():
    schemas = {
        OUT: schema(extract(MODEL.read_text(encoding="utf-8"))),
        native_schema.OUT: native_schema.build(),
    }
    checking = "--check" in sys.argv[1:]
    for output, value in schemas.items():
        text = json.dumps(value, indent=2, sort_keys=False) + "\n"
        if checking:
            if not output.exists() or output.read_text(encoding="utf-8") != text:
                sys.exit("gen-schema: " + str(output.relative_to(ROOT)) + " is stale; run python3 integrations/vscode/scripts/gen-schema.py")
        else:
            output.write_text(text, encoding="utf-8")
            print("gen-schema: wrote " + str(output.relative_to(ROOT)))
    if checking:
        print("gen-schema: ok")


if __name__ == "__main__":
    main()
