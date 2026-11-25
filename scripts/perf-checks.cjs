"use strict";
// Benchmark the released check engines on the built-in demo and deterministic public workloads.
const assert = require("node:assert/strict");
const {appFile} = require("../tests/support/app-source-paths.cjs");
for (const file of ["core/model.js", "library/parts.js", "schematic/sch-objects.js", "project/hierarchy.js", "editor/nav-common.js", "core/spatial.js", "lazy.js"])
  require(appFile(file));

const samples = 7;
function measure(run) {
  let result;
  const times = Array.from({length:samples}, () => {
    const start = performance.now();
    result = run();
    return performance.now() - start;
  }).sort((a, b) => a - b);
  return [{n:samples, min:times[0], p50:times[3], p95:times.at(-1), max:times.at(-1)}, result];
}

function boardChecks(doc, defs) {
  const rules = AtriumRules.create();
  const [batch, checked] = measure(() => AtriumRules.drc(doc, defs, rules, {limit:5000}));
  const [clearance] = measure(() => AtriumRules.drc(doc, defs, rules, {types:["clearance"], limit:5000}));
  const [onlineOpen, online] = measure(() => {
    const engine = AtriumDRCView.online();
    const check = engine.update(doc, defs, rules, {to:0});
    return {engine, check};
  });
  assert.equal(online.check.mode, "full");
  const part = doc.items.find(item => item.kind === "part"), x = part.x;
  let revision = 0;
  const [onlineEdit, edited] = measure(() => {
    part.x = revision % 2 ? x : x + .1;
    return online.engine.update(doc, defs, rules, {from:revision, to:++revision});
  });
  assert.equal(edited.mode, "incremental", edited.why);
  const ids = result => result.violations.filter(v => v.type === "clearance").map(v => [v.id, v.otherId].join("/")).sort();
  assert.deepEqual(ids(edited), ids(AtriumRules.drc(doc, defs, rules, {types:["clearance"], limit:5000})));
  return {items:doc.items.length, violations:checked.violations.length, timings:{batch, clearance, onlineOpen, onlineEdit}};
}

function drc() {
  require("../tests/pcb/dense-board.js");
  const {d, defs} = makeAtriumBenchmarkBoard();
  for (const [i, item] of d.items.entries()) {
    if (item.kind === "part") item.pinNets = {1:"N" + i % 64, 2:"GND"};
    else item.net = "N" + i % 64;
  }
  const demo = AtriumParts.example();
  return {demo:boardChecks(demo.documents.find(doc => doc.kind === "pcb"), new Map(demo.library.map(def => [def.id, def]))),
    "dense-netted":boardChecks(d, defs)};
}

function erc() {
  require("../tests/schematic/sch-bench-project.js");
  const {project, stats} = makeAtriumSchBenchProject({sheets:100});
  const [full, result] = measure(() => AtriumERC.run(project));
  const [connectivity] = measure(() => AtriumHierarchy.compile(project));
  const [netlistWrite, netlist] = measure(() => AtriumNetlistText.compile(project));
  const [netlistParse, parsed] = measure(() => AtriumNetlistText.validate(netlist.text));
  assert.equal(parsed.valid, true);
  assert.equal(stats.sheets, 100);
  return {sheets:stats.sheets, items:project.documents.reduce((n, doc) => n + doc.items.length, 0),
    messages:result.messages.length, netlistBytes:Buffer.byteLength(netlist.text), timings:{full, connectivity, netlistWrite, netlistParse}};
}

const suite = process.argv[2];
assert.ok(suite === "drc" || suite === "erc", "Choose drc or erc.");
for (const file of AtriumLazy.files(suite === "drc" ? ["AtriumDRC", "AtriumDRCView", "AtriumResolvedGeometry"] : ["AtriumNetlistText"])) require(appFile(file));
console.log(JSON.stringify(suite === "drc" ? drc() : erc()));
