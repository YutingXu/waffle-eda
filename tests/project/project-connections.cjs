"use strict";
// The project scope uses one rule across ERC, compilation, the panel and the source translator.
const assert = require("node:assert/strict");
for (const f of ["model", "parts", "sch-objects", "hierarchy", "multichannel", "rules", "project-rules", "erc", "undo-store", "project-tree", "import-link", "altium-export"])
  require(require("../support/app-source-paths.cjs").appFile(f + ".js"));
const A = Atrium, H = AtriumHierarchy, P = AtriumProjectRules, U = AtriumUndoStore, T = AtriumProjectTree, S = AtriumSchObjects;
const project = A.project("Project tree"), [top, board] = project.documents;
const child = A.sheet("schematic", "Filter"), leaf = A.sheet("schematic", "Input"), other = A.sheet("schematic", "Other root");
project.documents.push(child, leaf, other);
const symbol = (doc, name) => S.make("sheetsymbol", [0,0], {name, sheet:doc.id});
const repeat = symbol(child, "Repeat(Left,2,1)"), plain = symbol(child, "Right");
top.items.push(repeat, plain); other.items.push(symbol(child, "Auxiliary")); child.items.push(symbol(leaf, "Front"));
const port = S.make("port", [0,0], {text:"SIG", io:"input"});
child.items.push(port, {...port, id:"second", io:"output"}, {id:"imported", kind:"netlabel", text:"IMPORTED", x:5, y:5, schPaint:{type:"port"}});
P.setNetScope(project, "automatic");
const valid = H.scopeRule(project.rules);
project.rules.list.unshift({...valid, id:"disabled", enabled:false, netScope:"global"}, {...valid, id:"scoped", sheets:[child.id], netScope:"global"},
  {...valid, id:"later", priority:200, netScope:"global"});
P.setNetScope(project, "automatic");
assert.equal(H.scopeSetting(project), "automatic"); assert.equal(AtriumERC.settings(project).scope, "automatic");
assert.equal(H.effectiveScope(project, "automatic"), "flat");
const entry = {id:"entry", name:"SIG", side:"left", offset:2.54, io:"input"};
repeat.entries.push(entry);
assert.equal(H.effectiveScope(project, "automatic"), "hierarchical");
const expanded = new Map(), roots = T.model(project);
let rows = T.visible(roots, expanded);
const group = rows.find(r => r.channels);
assert.equal(group.channels, 3, "non-contiguous and repeated symbols belong to the same parent's child");
assert.equal(group.depth, 1);
assert.equal(rows.filter(r => r.doc === child && !r.item).length, 2, "two parents each own an occurrence");
expanded.set(group.key, true); rows = T.visible(roots, expanded);
const channels = rows.filter(r => r.depth === 2 && r.doc === child && !r.item);
assert.deepEqual(channels.map(r => r.label), ["Left2", "Left1", "Right"]);
assert.deepEqual(channels.map(r => [r.pos,r.size]), [[1,3],[2,3],[3,3]]);
expanded.set(channels[1].key, true); rows = T.visible(roots, expanded);
assert.deepEqual(rows.filter(r => r.item && r.inst === channels[1].inst).map(r => [r.label,r.io,r.depth]),
  [["SIG","input",3],["SIG","output",3],["IMPORTED","unspecified",3]]);
assert.equal(rows.at(-1).doc, board);
assert.equal(new Set(rows.map(r => r.key)).size, rows.length, "every occurrence, port duplicate and aggregate has its own key");

// No stale tree/port metadata after an incremental edit, rollback, undo or redo.
U.reset(); U.mark(project); U.sync(project);
const history = [], future = [];
function compare() {
  const defs = new Map(project.library.map(d => [d.id,d]));
  const summary = h => [h.scope,h.effective,h.instances.map(i => [i.id,i.channel?.label]),h.issues.map(i => [i.kind,i.text]),
    h.nets.map(n => [n.name,n.local.map(m => m.inst.id),n.pins.map(p => [p.instance,p.pin.number])])];
  assert.deepEqual(summary(H.compileCached(project,{defs})), summary(H.compile(project,{defs})));
}
const stamp = () => U.hierarchyVersion(project);
const first = stamp(), structure = H.instancesCached(project);
assert.equal(H.instancesCached(project), structure);
const before = U.mark(project); U.checkpoint(history, future, before);
port.io = "output"; repeat.entries = []; U.record(project, [{doc:child,items:[port]}, {doc:top,items:[repeat]}]);
assert.notEqual(stamp(), first); assert.equal(H.compileCached(project).effective,"flat"); compare();
U.jump(history, future, U.mark(project), -1); assert.equal(H.compileCached(project).effective,"hierarchical"); compare();
U.jump(history, future, U.mark(project), 1); assert.equal(H.compileCached(project).effective,"flat"); compare();
const unchanged = stamp(); port.x += 1; U.record(project, {doc:child,items:[port]});
assert.equal(stamp(), unchanged, "moving a port does not invalidate the Projects tree");
const mark = U.mark(project); port.text = "renamed"; U.rollback(mark); assert.equal(port.text, "SIG"); compare();

// Real manifest section and BOM, source-specific scope, and a native → Altium ASCII → native round trip.
for (const [ordinal, mode] of ["automatic","flat","hierarchical","global"].entries()) {
  P.setNetScope(project, mode);
  const f = AtriumAltiumExport.exportProject(project).files[0];
  assert.ok(f.content.includes("HierarchyMode=" + ordinal));
  const parsed = {manifest:{},notes:[]};
  AtriumImportLink.manifestScope(parsed, f.bytes); assert.equal(parsed.manifest.netScope, mode);
}
const marked = new Uint8Array(Buffer.from("\uFEFF[Design]\r\nHierarchyMode=4\r\n[Document1]\r\nHierarchyMode=1","utf16le"));
const strict = AtriumImportLink.manifestScope({manifest:{}, notes:[]}, marked);
assert.equal(strict.manifest.netScope,"hierarchical"); assert.match(strict.notes[0], /Power ports/);
console.log("PASS project scope, occurrence levels and positions, directed ports, incremental/full hierarchy, undo and source scopes");
