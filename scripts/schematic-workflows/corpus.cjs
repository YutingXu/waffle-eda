"use strict";

// Read the Round 4 preparation receipts and describe source eligibility without
// opening the editor or disclosing drawing names, coordinates or net names.
const assert = require("node:assert/strict");
const {createHash} = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const root = path.resolve(__dirname, "../..");
function readReceipts(inputs) {
  const [header, ...rows] = fs.readFileSync(inputs, "utf8").trim().split(/\r?\n/);
  const columns = header.split("\t");
  return new Map(rows.map(line => {
    const row = Object.fromEntries(line.split("\t").map((value, i) => [columns[i], value]));
    return [row.case, row];
  }));
}
const kinds = ["port", "offsheet", "label", "power"];
const digest = bytes => createHash("sha256").update(bytes).digest("hex");

function regular(file) {
  assert.ok(fs.lstatSync(file).isFile(), "Use regular snapshot and receipt files.");
  return fs.readFileSync(file);
}

function readCase(directory, id, receipts) {
  const receipt = receipts.get(id);
  assert.ok(receipt, "Choose a case from the published format baseline.");
  if (id === "approved") {
    const relative = path.relative(fs.realpathSync(os.tmpdir()), fs.realpathSync(directory));
    assert.ok(relative && !relative.startsWith("..") && !path.isAbsolute(relative),
      "Use the retained approved export in its own temporary directory.");
  }
  const file = path.join(directory, id + ".waffle");
  const prepared = JSON.parse(regular(path.join(directory, id + ".input.json")));
  const bytes = regular(file), sha = digest(bytes);
  assert.equal(prepared.sha256 === sha, true, "Snapshot and preparation receipt differ.");
  assert.equal(bytes.length, Number(receipt.file_bytes), "Snapshot size differs from the published baseline.");
  if (id !== "approved") {
    assert.equal(sha, receipt.snapshot_sha256, "Snapshot differs from the published public baseline.");
    assert.equal(prepared.revision || "", receipt.source_rev, "Source revision differs from the public receipt.");
  }
  const design = JSON.parse(bytes);
  assert.equal(design.formatVersion, receipt.format);
  assert.equal(design.documents.length, Number(receipt.documents));
  assert.equal(design.documents.reduce((n, d) => n + d.items.length, 0), Number(receipt.total_items));
  return {id, bytes, design, verify() {
    assert.equal(digest(regular(file)) === sha, true, "Snapshot bytes changed during verification.");
  }};
}

function objectKind(item) {
  if (item.kind === "label") return null; // Schematic text strings are graphical.
  if (item.kind !== "netlabel") return item.kind;
  if (item.schPaint?.offSheet) return "offsheet";
  if (item.schPaint?.type === "port") return "port";
  if (item.schPaint?.type === "power") return "power";
  return "label";
}

function sheetObjects(sheets) {
  const groups = Object.fromEntries(kinds.map(k => [k, new Map()]));
  for (const doc of sheets) for (const item of doc.items) {
    const kind = objectKind(item);
    if (!groups[kind] || !item.text) continue;
    if (!groups[kind].has(item.text)) groups[kind].set(item.text, []);
    groups[kind].get(item.text).push({doc, item});
  }
  return groups;
}

function survey(design) {
  const sheets = design.documents.filter(d => d.kind === "schematic");
  const sheetIds = new Set(sheets.map(d => d.id));
  const groups = sheetObjects(sheets);
  const counts = Object.fromEntries(kinds.map(k => [k, {
    objects: [...groups[k].values()].reduce((n, places) => n + places.length, 0),
    localNames: [...groups[k].values()].filter(places => new Set(places.map(p => p.doc.id)).size < places.length).length,
    crossNames: [...groups[k].values()].filter(places => new Set(places.map(p => p.doc.id)).size > 1).length,
  }]));
  const symbols = sheets.flatMap(d => d.items.filter(i => i.kind === "sheetsymbol").map(item => ({doc: d, item})));
  const links = symbols.filter(({doc, item}) => sheetIds.has(item.sheet) && item.sheet !== doc.id);
  const entryCount = symbols.reduce((n, {item}) => n + (item.entries?.length || 0), 0);
  const repeats = links.filter(({item}) => /^Repeat\(/i.test(item.name || "")).length;
  const parents = new Map();
  for (const {doc, item} of links) {
    if (!parents.has(item.sheet)) parents.set(item.sheet, new Set());
    parents.get(item.sheet).add(doc.id);
  }
  const siblingOffsheetNames = [...groups.offsheet.values()].filter(places => {
    const byParent = new Map();
    for (const {doc} of places) for (const parent of parents.get(doc.id) || [null]) {
      if (!byParent.has(parent)) byParent.set(parent, new Set());
      byParent.get(parent).add(doc.id);
    }
    return [...byParent.values()].some(ids => ids.size > 1);
  }).length;
  const scope = design.rules?.list?.find(rule => rule.type === "ercNetScope" && rule.enabled !== false)?.netScope || "global";
  const effective = scope === "automatic" ? entryCount ? "hierarchical" : counts.port.objects ? "flat" : "global" : scope;
  return {
    sheets: sheets.length,
    parts: sheets.reduce((n, d) => n + d.items.filter(i => i.kind === "part").length, 0),
    wires: sheets.reduce((n, d) => n + d.items.filter(i => i.kind === "wire").length, 0),
    symbols: symbols.length, links: links.length, entries: entryCount, repeats,
    frames: sheets.reduce((n, d) => n + d.items.filter(i => i.kind === "textframe" && i.role === "frame").length, 0),
    paper: sheets.filter(d => d.schDrawing?.width > 0 && d.schDrawing?.height > 0).length,
    infinite: sheets.filter(d => d.sheet?.infinite === true).length,
    scope, effective, siblingOffsheetNames, ...counts,
  };
}

module.exports = {root, readReceipts, readCase, objectKind, sheetObjects, survey};
