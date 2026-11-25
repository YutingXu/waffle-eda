"use strict";
// Synthetic hierarchical schematic projects for the schematic performance benchmarks
// (scripts/perf-sch.sh, tests/integration/perf-sch.js, tests/schematic/sch-perf.cjs). Deterministic: the same options give
// the same project, ids included.
//
// makeAtriumSchBenchProject({sheets: 30 | 100, cells: 30, channels: 8}) returns {project, stats}:
//   Top            sheet symbols for every module, each with a bus entry DATA[0..7] and an OUT entry
//   Module m       sheet symbols for its sub-sheets plus its own cells; DATA[0..7] bus to every child
//   Sub-sheet      a grid of gain cells (op amp, input and feedback resistors, decoupling capacitor,
//                  wires, a junction, net labels and VCC/GND power ports), a bus D[0..7] with bus
//                  entries and a D[0..7] port, and an OUT port
//   Channel        one sub-sheet is instantiated `channels` times by Repeat(CH,1,n) (multi-channel)
// Net identifier scope is automatic, so the sheet entries make it hierarchical. Waffle has no
// signal harness object yet, so buses stand in for harnesses.
// Works in a page (after model.js, parts.js, sch-objects.js) and under Node/JSC (require those first).
globalThis.makeAtriumSchBenchProject = function makeAtriumSchBenchProject(opts = {}) {
  const A = globalThis.Atrium, S = globalThis.AtriumSchObjects, P = globalThis.AtriumParts;
  const SHEETS = Math.max(3, opts.sheets || 30), CELLS = opts.cells || 30, CHANNELS = opts.channels ?? 8;
  const lib = P.catalogue.filter(d => ["std-r", "std-c", "std-opamp", "std-j3", "std-j2"].includes(d.id));
  const project = A.project(opts.name || "Bench " + SHEETS + " sheets", lib);
  project.id = "sch-bench-" + SHEETS + "-" + CELLS + "-" + CHANNELS;
  const board = project.documents.find(d => d.kind === "pcb"); board.id = "board"; board.name = "Board";
  project.documents = [];
  let uid = 0, refs = {R:0, C:0, U:0};
  const id = t => t + (++uid).toString(36);
  const q = v => Math.round(v * 1e4) / 1e4;
  const pt = (x, y) => [q(x), q(y)];
  const ref = p => p + (++refs[p]);
  const g = 2.54;

  // One gain cell centred on (cx, cy): about 17 items, 4 parts.
  function cell(items, cx, cy, inName, outName) {
    const part = (def, x, y, angle, prefix, value) => items.push({id:id("p"), kind:"part", def, ref:ref(prefix), value, x:q(x), y:q(y), angle, pinNets:{}});
    const wire = (...pts) => items.push({id:id("w"), kind:"wire", points:pts.map(([x, y]) => pt(x, y))});
    const label = (text, x, y) => items.push({id:id("l"), kind:"netlabel", text, x:q(x), y:q(y)});
    const power = (text, x, y, style) => items.push({...S.make("power", pt(x, y), {text, style}), id:id("v")});
    part("std-opamp", cx, cy, 0, "U", "OPA");
    part("std-r", cx - 6 * g, cy - g, 0, "R", "10k");                 // input: pins at cx-8g, cx-4g
    part("std-r", cx, cy + 5 * g, 0, "R", "100k");                    // feedback: pins at cx-2g, cx+2g
    part("std-c", cx + 3 * g, cy - 3 * g, 0, "C", "100n");            // decoupling: pins at cx+g, cx+5g
    wire([cx - 4 * g, cy - g], [cx - 3 * g, cy - g]);                 // R in -> +IN
    wire([cx - 8 * g, cy - g], [cx - 9 * g, cy - g]); label(inName, cx - 9 * g, cy - g);
    wire([cx - 3 * g, cy + g], [cx - 4 * g, cy + g], [cx - 4 * g, cy + 5 * g], [cx - 2 * g, cy + 5 * g]);
    wire([cx + 3 * g, cy], [cx + 6 * g, cy]);                         // OUT
    wire([cx + 4 * g, cy], [cx + 4 * g, cy + 5 * g], [cx + 2 * g, cy + 5 * g]);
    items.push({id:id("j"), kind:"junction", x:q(cx + 4 * g), y:q(cy)});
    label(outName, cx + 6 * g, cy);
    wire([cx, cy - 3 * g], [cx + g, cy - 3 * g]);
    power("VCC", cx, cy - 3 * g, "bar");
    power("GND", cx + 5 * g, cy - 3 * g, "gnd");
    power("GND", cx, cy + 3 * g, "gnd");
  }
  // A grid of cells starting at (x0, y0); returns the grid's bottom edge.
  function cells(doc, n, x0, y0, tag) {
    const cols = Math.ceil(Math.sqrt(n * 1.5));
    for (let k = 0; k < n; k++) {
      const c = k % cols, r = Math.floor(k / cols);
      cell(doc.items, x0 + c * 17 * g, y0 + r * 12 * g, k < 8 ? "D" + k : tag + "OUT" + (k - 1), k === 0 ? "OUT_A" : tag + "OUT" + k);
    }
    return y0 + Math.ceil(n / cols) * 12 * g;
  }
  // A D[0..7] bus down the left with an entry per member, a bus port, and an OUT port.
  function busAndPorts(doc, x, y) {
    const items = doc.items;
    items.push({id:id("b"), kind:"bus", points:[pt(x, y), pt(x, y + 9 * g)]});
    items.push({id:id("l"), kind:"netlabel", text:"D[0..7]", x:q(x), y:q(y + 9 * g)});
    for (let k = 0; k < 8; k++) {
      items.push({...S.make("busentry", pt(x, y + (k + 1) * g)), id:id("e")});
      const end = [x + g, y + k * g];
      items.push({id:id("w"), kind:"wire", points:[pt(end[0], end[1]), pt(end[0] + 2 * g, end[1])]});
      items.push({id:id("l"), kind:"netlabel", text:"D" + k, x:q(end[0] + 2 * g), y:q(end[1])});
    }
    items.push({...S.make("port", pt(x - 2 * g, y), {text:"D[0..7]", io:"bidirectional"}), id:id("o")});
    items.push({id:id("b"), kind:"bus", points:[pt(x - 2 * g, y), pt(x, y)]});
    items.push({...S.make("port", pt(x - 2 * g, y - 3 * g), {text:"OUT_A", io:"output"}), id:id("o")});
    items.push({id:id("l"), kind:"netlabel", text:"OUT_A", x:q(x - 2 * g), y:q(y - 3 * g)});
  }
  // A sheet symbol for child `doc` at (x, y) with DATA and OUT entries wired to the parent's nets.
  function symbol(parent, child, x, y, name, outNet) {
    const w = 16 * g, h = 8 * g;
    const s = {...S.make("sheetsymbol", pt(x, y), {name, sheet:child.id, w, h,
      entries:[{id:id("n"), name:"D[0..7]", side:"left", offset:2 * g, io:"bidirectional"}, {id:id("n"), name:"OUT_A", side:"right", offset:2 * g, io:"output"}]}), id:id("s")};
    parent.items.push(s);
    parent.items.push({id:id("b"), kind:"bus", points:[pt(x - 4 * g, y + 2 * g), pt(x, y + 2 * g)]});
    parent.items.push({id:id("l"), kind:"netlabel", text:"DATA[0..7]", x:q(x - 4 * g), y:q(y + 2 * g)});
    parent.items.push({id:id("w"), kind:"wire", points:[pt(x + w, y + 2 * g), pt(x + w + 4 * g, y + 2 * g)]});
    parent.items.push({id:id("l"), kind:"netlabel", text:outNet, x:q(x + w + 4 * g), y:q(y + 2 * g)});
  }

  const top = A.sheet("schematic", "Top"); top.id = "sheet-top";
  project.documents.push(top);
  // Modules and their sub-sheets: top + M modules + the rest as sub-sheets.
  const rest = SHEETS - 1, M = Math.max(1, Math.round(Math.sqrt(rest))), subs = rest - M;
  const modules = [];
  for (let m = 0; m < M; m++) {
    const d = A.sheet("schematic", "Module " + (m + 1)); d.id = "sheet-m" + (m + 1); modules.push(d); project.documents.push(d);
    symbol(top, d, 20, 20 + m * 12 * g, "U_Module" + (m + 1), "M" + (m + 1) + "_OUT");
    busAndPorts(d, 10, 10);
  }
  let channelSheet = null;
  for (let k = 0; k < subs; k++) {
    const m = k % M, parent = modules[m], d = A.sheet("schematic", "Sheet " + (k + 1)); d.id = "sheet-s" + (k + 1);
    project.documents.push(d);
    const n = parent.items.filter(i => i.kind === "sheetsymbol").length;
    const repeat = k === 0 && CHANNELS > 1;
    if (repeat) channelSheet = d;
    symbol(parent, d, 40, 20 + n * 12 * g, repeat ? "Repeat(CH,1," + CHANNELS + ")" : "U_Sub" + (k + 1), "S" + (k + 1) + "_OUT");
    busAndPorts(d, 10, 10);
    cells(d, CELLS, 40, 20, "S" + (k + 1) + "_");
  }
  for (const [m, d] of modules.entries()) cells(d, Math.max(4, CELLS >> 2), 120, 20, "M" + (m + 1) + "_");
  cells(top, 6, 120, 20, "T_");
  project.documents.push(board);
  // Stable defaults: automatic scope (hierarchical here) and index naming for channels. The scope is the
  // project rule book's Net Identifier Scope rule (project-rules.js; project.erc is gone).
  const scopeRule = {id:"erc-scope", type:"ercNetScope", name:"NetIdentifierScope", enabled:true, priority:1,
    scope:{languageVersion:1,source:"object"}, where:"schematic", netScope:"automatic"};
  const PR = globalThis.AtriumProjectRules;
  if (PR?.edit) PR.edit(project, b => PR.setErc(b, [...b.list.filter(r => PR.isErc(r.type) && r.type !== "ercNetScope"), scopeRule]));
  else project.rules = {format:"atrium-rules", version:3, units:"mm", list:[...(project.rules?.list || []).filter(r => r.type !== "ercNetScope"), scopeRule]};
  for (const [index, rule] of project.rules.list.entries()) rule.id = "sch-bench-rule-" + (index + 1);
  const sheets = project.documents.filter(d => d.kind === "schematic");
  const stats = {sheets:sheets.length, items:sheets.reduce((a, d) => a + d.items.length, 0),
    parts:sheets.reduce((a, d) => a + d.items.filter(i => i.kind === "part").length, 0),
    maxSheetItems:Math.max(...sheets.map(d => d.items.length)), channelSheet:channelSheet?.id || null, channels:CHANNELS};
  return {project, stats};
};
