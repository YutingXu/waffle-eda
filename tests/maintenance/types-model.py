#!/usr/bin/env python3
"""types/model.d.ts agrees with the project validator and the generated JSON schema.

Checks, with no TypeScript needed:
  * the item kinds: ItemKind in model.d.ts, allowedItems in app/core/model.js and the schema's item
    "kind" enum are the same set, and every kind has exactly one interface in the Item union;
  * the document kinds: DocumentKind, model.js's document check and the schema's enum;
  * the path kinds (stored as `points`): PathItemKind, model.js and the schema;
  * required fields: for each item kind, what the schema requires is required in the d.ts, and
    the d.ts requires nothing beyond the schema except what app/schematic/sch-objects.js validateItem
    requires (the schema is a structural subset of the validators);
  * Project, Document, Definition, SymbolDef, FootprintDef, PinDef and PadDef required fields
    match the schema exactly.
Run: python3 tests/maintenance/types-model.py   (also run by scripts/typecheck.sh)
"""
import json
import os
import re
import sys

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "../.."))
DTS = open(os.path.join(ROOT, "types", "model.d.ts"), encoding="utf-8").read()
MODEL = open(os.path.join(ROOT, "app/core/model.js"), encoding="utf-8").read()
SCH = open(os.path.join(ROOT, "app/schematic/sch-objects.js"), encoding="utf-8").read()
SCHEMA = json.load(open(os.path.join(ROOT, "integrations", "vscode", "schema", "waffle.schema.json"), encoding="utf-8"))
failures = []


def check(ok, message):
    if not ok:
        failures.append(message)


def strip_comments(text):
    return re.sub(r'/\*.*?\*/|//[^\n]*', "", text, flags=re.S)


SRC = strip_comments(DTS)


def union(name):
    m = re.search(r'\btype\s+' + name + r'\s*=\s*([^;]+);', SRC)
    if not m:
        sys.exit(f"types-model: no type {name} in types/model.d.ts")
    return [x.strip() for x in m.group(1).split("|") if x.strip()]


def literals(name):
    return {x.strip('"') for x in union(name)}


def interface(name):
    """(bases, {field: required}) of a named interface, top-level fields only."""
    m = re.search(r'\binterface\s+' + name + r'(?:\s+extends\s+(\w+(?:\s*,\s*\w+)*))?\s*\{', SRC)
    if not m:
        sys.exit(f"types-model: no interface {name} in types/model.d.ts")
    i, depth, body = m.end(), 1, []
    while depth:
        c = SRC[i]
        depth += c == "{"
        depth -= c == "}"
        if depth:
            body.append(c if depth == 1 else ("" if c not in "\n" else "\n"))
        i += 1
    fields = {}
    for part in re.split(r'[;\n]', "".join(body)):
        f = re.match(r'\s*(?:readonly\s+)?([A-Za-z_$][\w$]*)(\?)?\s*:', part)
        if f:
            fields[f.group(1)] = not f.group(2)
    return re.split(r"\s*,\s*", m.group(1)) if m.group(1) else [], fields


def required(name):
    bases, fields = interface(name)
    out = {k for k, v in fields.items() if v}
    for base in bases:
        out |= {"id", "kind"} if base == "ItemCommon" else required(base)
    return out


# ------------------------------------------------------------------ item kinds
item_kinds = literals("ItemKind")
model_kinds = set(re.findall(r'"(\w+)"', re.search(r'allowedItems=new Set\(\[([^\]]*)\]\)', MODEL).group(1)))
schema_item = SCHEMA["definitions"]["item"]
schema_kinds = set(schema_item["properties"]["kind"]["enum"])
check(item_kinds == model_kinds, f"ItemKind {sorted(item_kinds)} != model.js allowedItems {sorted(model_kinds)}")
check(item_kinds == schema_kinds, f"ItemKind {sorted(item_kinds)} != schema item kinds {sorted(schema_kinds)}")

by_kind = {}
for iface in union("Item"):
    _, fields = interface(iface)
    k = re.search(r'\binterface\s+' + iface + r'\b[^{]*\{[^}]*?\bkind:\s*"(\w+)"', SRC)
    check(k is not None, f"{iface} in the Item union has no `kind: \"...\"`")
    if k:
        check(k.group(1) not in by_kind, f"two Item interfaces for kind {k.group(1)}")
        by_kind[k.group(1)] = iface
check(set(by_kind) == item_kinds, f"Item union covers {sorted(by_kind)}, ItemKind is {sorted(item_kinds)}")

# ------------------------------------------------------------------ document and path kinds
doc_kinds = literals("DocumentKind")
chain = re.search(r'if\(((?:d\.kind!=="\w+"&&)+d\.kind!=="\w+")\|\|!str\(d\.name\)', MODEL)
model_docs = set(re.findall(r'"(\w+)"', chain.group(1))) if chain else set()
schema_docs = set(SCHEMA["definitions"]["document"]["properties"]["kind"]["enum"])
check(doc_kinds == model_docs, f"DocumentKind {sorted(doc_kinds)} != model.js document kinds {sorted(model_docs)}")
check(doc_kinds == schema_docs, f"DocumentKind {sorted(doc_kinds)} != schema document kinds {sorted(schema_docs)} "
      "(regenerate it: python3 integrations/vscode/scripts/gen-schema.py)")

path_kinds = literals("PathItemKind")
paths = re.search(r'if\(((?:i\.kind==="\w+"\|\|)+i\.kind==="\w+")\)\{points\(i\.points\)', MODEL)
model_paths = set(re.findall(r'"(\w+)"', paths.group(1))) if paths else set()
cond = [c for c in schema_item["allOf"] if "else" in c][0]
schema_paths = set(cond["if"]["properties"]["kind"]["enum"])
check(path_kinds == model_paths == schema_paths, f"PathItemKind {sorted(path_kinds)}, model.js {sorted(model_paths)}, schema {sorted(schema_paths)}")

# ------------------------------------------------------------------ required item fields
def schema_required(kind):
    out = set(schema_item["required"])
    for c in schema_item["allOf"]:
        p = c["if"]["properties"]["kind"]
        hit = kind == p.get("const") or kind in p.get("enum", [])
        out |= set(c["then"].get("required", [])) if hit else set(c.get("else", {}).get("required", []))
    return out


# What app/schematic/sch-objects.js validateItem requires beyond the schema; each needle must still be there.
SCH_REQUIRED = {
    "power": ({"text", "style", "direction"}, '!str(i.text) || !one(i.style, Object.hasOwn(POWER, i.style)) || !([0, 1, 2, 3].includes(i.direction)'),
    "port": ({"text", "io"}, '!str(i.text) || !one(i.io, IO.includes(i.io))'),
    "sheetsymbol": ({"w", "h", "name", "sheet", "entries"}, '!num(i.w) || i.w <= 0 || !num(i.h) || i.h <= 0 || !str(i.name) || !str(i.sheet)'),
    "textframe": ({"w", "h", "text"}, '!num(i.w) || !num(i.h) || !str(i.text)'),
    "image": ({"w", "h", "src"}, '!num(i.w) || !num(i.h) || !str(i.src)'),
}
for kind, (fields, needle) in SCH_REQUIRED.items():
    check(needle in SCH, f"app/schematic/sch-objects.js validateItem no longer contains {needle!r}; update tests/maintenance/types-model.py")
offsheet = re.search(r'case "offsheet":(.*?)break;', SCH.split("function validateItem(", 1)[1], re.S)
check(offsheet is not None and "!str(i.text)" in offsheet.group(1), "offsheet validation must require text")
offsheet_schema = next(c["then"] for c in schema_item["allOf"] if c["if"]["properties"]["kind"].get("const") == "offsheet")
check(literals("PortIO") == set(offsheet_schema["properties"]["io"]["examples"]), "OffSheetItem I/O choices differ from the schema")
netlabel_schema = next(c["then"] for c in schema_item["allOf"] if c["if"]["properties"]["kind"].get("const") == "netlabel")
auto_name = netlabel_schema["properties"]["autoName"]
check(set(auto_name["required"]) == {"part", "pin", "style"}, "Generated net label names need a stable part, pin and style")
check(literals("AutoNetNameStyle") == set(auto_name["properties"]["style"]["examples"]), "Generated net name styles differ from the schema")
check(interface("OffSheetItem")[1].get("io") is False, "OffSheetItem.io must remain optional")
for kind, iface in sorted(by_kind.items()):
    want, have = schema_required(kind), required(iface)
    extra_ok = SCH_REQUIRED.get(kind, (set(), ""))[0]
    check(want <= have, f"{iface} ({kind}) does not require {sorted(want - have)}, which the schema requires")
    check(have <= want | extra_ok, f"{iface} ({kind}) requires {sorted(have - want - extra_ok)}, which no validator requires")

# ------------------------------------------------------------------ project, documents, library
D = SCHEMA["definitions"]
fp = D["definition"]["properties"]
for iface, schema_req in [("Project", SCHEMA["required"]), ("DocumentBase", D["document"]["required"]),
                          ("Definition", D["definition"]["required"]),
                          ("SymbolDef", fp["symbol"]["required"]), ("FootprintDef", fp["footprint"]["required"]),
                          ("PinDef", fp["symbol"]["properties"]["pins"]["items"]["required"]),
                          ("PadDef", fp["footprint"]["properties"]["pads"]["items"]["required"]),
                          ("Shape", D["shape"]["required"])]:
    have = required(iface)
    check(have == set(schema_req), f"{iface} requires {sorted(have)}, the schema {sorted(schema_req)}")
check({"symbol", "footprint"} == {r["required"][0] for r in D["definition"]["anyOf"]}, "Definition: schema anyOf symbol/footprint changed")
check(literals("ShapeKind") == set(D["shape"]["properties"]["kind"]["enum"]) if re.search(r'\btype\s+ShapeKind\b', SRC) else True,
      "ShapeKind differs from the schema")

for f in failures:
    print("FAIL  " + f)
if failures:
    sys.exit(1)
print(f"types-model: ok ({len(item_kinds)} item kinds, {len(doc_kinds)} document kinds, required fields agree)")
