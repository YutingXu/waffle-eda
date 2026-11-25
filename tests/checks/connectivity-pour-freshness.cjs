"use strict";
const assert = require("node:assert/strict");
for (const f of ["model", "parts", "sch-objects", "hierarchy", "spatial", "pcb-pours", "pcb-appearance", "pcb-text-rich", "pcb-text",
  "vectorize", "stackup", "net-intent", "signals", "rules", "viastack", "board-shape", "undo-store",
  "component-classes", "rooms", "polygon-pour", "connectivity", "connectivity-live"]) require(require("../support/app-source-paths.cjs").appFile(f + ".js"));

const A = Atrium, P = AtriumPolygonPour, R = AtriumProjectRules, S = AtriumSignals, U = AtriumUndoStore;
const C = AtriumConnectivity, Q = AtriumDesignQueryRecord;
const clearance = book => book.list.find(rule => rule.type === "clearance" && Q.isAll(rule.scope));
const semantic = ({stats, ...result}) => ({...result, objects: stats.objects, features: stats.features});
const via = (id, x, y, net) => ({id, kind: "via", layer: "Multi", net, x, y, diameter: .8, drill: .3});

function fixture(name, prepare, fn) {
  const project = A.project(name), board = project.documents.find(doc => doc.kind === "pcb");
  const defs = new Map(), history = [], future = [];
  let revision = 0;
  U.reset();
  P.live.reset();
  P.live.setMode("manual");
  const host = {project: () => project, doc: () => board, defs: () => defs,
    revision: () => revision, derive(apply) { apply(); }};
  const previousHost = globalThis.AtriumNavHost;
  globalThis.AtriumNavHost = host;
  try {
    board.outline = [[0, 0], [50, 0], [50, 40], [0, 40]];
    board.items = [
      P.make([[1, 1], [30, 1], [30, 30], [1, 30]], {id: "fill", net: "GND", layer: "Top", removeDeadCopper: false}),
      via("a", 7, 7, "GND"), via("b", 12, 7, "GND"), via("foreign", 20, 14, "FOREIGN")
    ];
    prepare(project, board);
    for (const definition of project.library) defs.set(definition.id, definition);
    P.live.attach(host);
    P.apply(board, defs, {project});
    assert.ok(board.pcbDrawing.pours.some(region => region.links.length > 1));
    U.record(project);
    function check(label, airwires, journal = U) {
      const live = C.inspect(board, defs, journal);
      const full = C.inspectFull(board, defs);
      assert.equal(full.airwires.length, airwires, label + " full sweep");
      assert.deepEqual(semantic(live), semantic(full), label + " live and full connectivity");
      assert.equal(P.state(board, defs), airwires ? "stale" : "source", label + " pour freshness");
    }
    function edit(label, change, hint) {
      const before = U.mark(project);
      U.duringEdit(change);
      U.checkpoint(history, future, before, label);
      U.record(project, hint);
      revision++;
    }
    function jump(direction) {
      assert.ok(U.jump(history, future, U.mark(project), direction));
      U.touch(project);
      revision++;
    }
    check("initial fill", 0);
    fn({project, board, defs, check, edit, jump});
  } finally {
    globalThis.AtriumNavHost = previousHost;
    P.live.reset();
    U.reset();
  }
}

fixture("Inherited rule", project => R.edit(project, book => { clearance(book).gap = .2; }),
  ({project, check, edit, jump}) => {
    edit("Replace the rule book", () => R.edit(project, book => { clearance(book).gap = 1.4; }));
    check("inherited clearance edit", 1);
    jump(-1);
    check("inherited clearance undo", 0);
    jump(1);
    check("inherited clearance redo", 1);
    jump(-1);
    check("original book restored", 0);
    const book = project.rules, rule = clearance(book);
    edit("Patch the clearance rule in place", () => { rule.gap = 1.4; });
    for (const direction of [0, -1, 1]) {
      if (direction) jump(direction);
      assert.equal(project.rules, book);
      assert.equal(clearance(project.rules), rule);
      check("in-place clearance, direction " + direction, direction === -1 ? 0 : 1);
    }
  });

fixture("Signal scope", project => {
  R.edit(project, book => {
    const base = clearance(book);
    base.gap = .2;
    base.priority = 2;
    book.list.push({...base, id: "tag-clearance", name: "Tagged Clearance", priority: 1, gap: 1.4,
      scope: Q.selector("tag", "Wide"), scope2: Q.selector("all")});
  });
  S.edit(project, store => {
    store.tags.push({name: "Wide"});
    store.signals.push({id: "scoped", name: "Wide Signal", kind: "single", tags: ["Wide"],
      legs: [{nets: ["OTHER"]}]});
  });
}, ({project, check, edit, jump}) => {
  edit("Assign the signal", () => S.edit(project, store => { store.signals[0].legs[0].nets[0] = "FOREIGN"; }));
  check("signal edit", 1);
  jump(-1);
  check("signal undo", 0);
  jump(1);
  check("signal redo", 1);
  jump(-1);
  check("original signal store restored", 0);
  const store = project.signals, signal = store.signals[0];
  edit("Modify the signal in place", () => { signal.legs[0].nets[0] = "FOREIGN"; });
  for (const direction of [0, -1, 1]) {
    if (direction) jump(direction);
    assert.equal(project.signals, store);
    assert.equal(store.signals[0], signal);
    check("in-place signal, direction " + direction, direction === -1 ? 0 : 1);
  }
  signal.legs[0].nets[0] = "OTHER";
  U.touch(project);
  check("unrecorded signal edit at the same editor revision", 0);
  assert.ok(U.unrecorded(), "checking connectivity leaves the unrecorded edit alone");
});

fixture("Board rule overrides and library", (project, board) => {
  R.edit(project, book => { book.boardKeys = {[board.id]: {netCurrents: {GND: .4}}}; });
  project.library.push(A.clone(AtriumParts.catalogue.find(def => def.id === "std-r")));
  board.items.push({id: "r", kind: "part", def: "std-r", ref: "R1", x: 22, y: 22, angle: 0});
}, ({project, board, defs, check, edit, jump}) => {
  const overrides = project.rules.boardKeys[board.id].netCurrents;
  edit("Modify the board rule override", () => { overrides.GND = .8; });
  check("board-specific rule edit", 1);
  jump(-1);
  check("board-specific rule undo", 0);
  const pad = defs.get("std-r").footprint.pads[0];
  edit("Change the footprint pad", () => { pad.w += .5; });
  check("in-place library edit", 1);
  jump(-1);
  check("library undo", 0);
  jump(1);
  check("library redo", 1);
  P.live.setMode("live");
  check("automatic mode while the retained fill is stale", 1);
  edit("Publish a derived refill", () => { P.apply(board, defs, {project, derived: true}); },
    {doc: board, items: []});
  check("automatic mode with fresh copper", 0);
});

fixture("Unknown changes without an editor journal", project => R.edit(project, book => { clearance(book).gap = .2; }),
  ({project, check}) => {
    P.live.reset();
    U.reset();
    clearance(project.rules).gap = 1.4;
    check("script mutates a rule in place", 1, null);
    clearance(project.rules).gap = .2;
    check("script restores the original rule", 0, null);
  });

function scopedClearance(project, scope) {
  R.edit(project, book => {
    const base = clearance(book);
    base.gap = .2;
    base.priority = 2;
    book.list.push({...base, id: "scoped-clearance", name: "Scoped Clearance", priority: 1, gap: 1.4,
      scope, scope2: Q.selector("all")});
  });
}

function roomClassDesign(project, board, source) {
  const definition = {id: "def", name: "Class fixture", prefix: "U", footprint: {shapes: [], pads: [
    {number: "1", x: 0, y: 0, w: 1, h: 1, shape: "rect", layer: "Top"}
  ]}};
  project.library.push(definition);
  board.items.push({id: "anchor", kind: "part", ref: "U3", value: "", def: "def", link: "link", x: 20, y: 14,
    angle: 0, pinNets: {"1": "FOREIGN"}});
  const parameter = {ComponentClass: "Automatic Source"};
  if (source === "library") definition.parameters = parameter;
  else project.documents.find(doc => doc.kind === "schematic").items.push({
    id: "symbol", kind: "part", ref: "U3", def: "def", link: "link", x: 0, y: 0, parameters: parameter
  });
  board.rooms = [{id: "room", name: "Wide", componentClass: "Automatic Source",
    points: [[16, 10], [24, 10], [24, 18], [16, 18]]}];
  scopedClearance(project, Q.selector("componentclass", "Wide"));
}

for (const source of ["library", "schematic"]) {
  fixture("Automatic room class from " + source, (project, board) => roomClassDesign(project, board, source),
    ({project, board, defs, check, edit, jump}) => {
    const owner = source === "library" ? defs.get("def") :
      project.documents.find(doc => doc.kind === "schematic").items.find(item => item.id === "symbol");
    const regions = () => P.repourAll(board, defs, {project, reuse: false}).regions.map(region => region.data);
    const original = regions();
    edit("Remove automatic class membership", () => { owner.parameters.ComponentClass = "Other"; });
    assert.notDeepEqual(regions(), original, "the changed membership alters the physical fill");
    check(source + " automatic class edit", 1);
    jump(-1);
    assert.deepEqual(regions(), original);
    check(source + " automatic class undo", 0);
    jump(1);
    assert.notDeepEqual(regions(), original);
    check(source + " automatic class redo", 1);
  });
}

function historicalRoom(project, board) {
  roomClassDesign(project, board, "library");
  board.id = "historical-board";
  project.rules.list.forEach((rule, index) => { rule.id = "historical-rule-" + index; });
}

fixture("Reopened class-scoped copper from the old signature", historicalRoom, ({project, board, defs}) => {
  // Baseline 8f938d5 published this exact stamp both with and without the automatic member.
  const legacy = "4:a017454b3c0aec79";
  board.pcbDrawing.pourSignatures.fill = legacy;
  board.items[0].copperBasis.inputs = legacy;
  defs.get("def").parameters.ComponentClass = "Other";
  const reopened = A.validate(JSON.parse(JSON.stringify(project)));
  const saved = reopened.documents.find(doc => doc.id === board.id);
  const library = new Map(reopened.library.map(def => [def.id, def]));
  assert.equal(saved.pcbDrawing.pourSignatures.fill, legacy);
  assert.equal(P.state(saved, library), "stale", "the old stamp does not prove empty membership");
  assert.equal(C.inspectFull(saved, library).airwires.length, 1);
  assert.deepEqual(semantic(C.inspect(saved, library)), semantic(C.inspectFull(saved, library)));
  P.apply(saved, library, {project: reopened, reuse: false});
  assert.equal(P.state(saved, library), "source");
  assert.equal(C.inspectFull(saved, library).airwires.length, 0);
  assert.deepEqual(semantic(C.inspect(saved, library)), semantic(C.inspectFull(saved, library)));
});

for (const kind of ["signal", "tag"]) {
  fixture("Native-only " + kind + " scope", project => {
    scopedClearance(project, Q.selector(kind, "Native"));
    S.edit(project, store => {
      if (kind === "tag") store.tags.push({name: "Native", as: {net: null, pair: null, xsignal: null}});
      store.signals.push({id: "native", name: "Native", kind: "single", legs: [{nets: ["OTHER"]}],
        ...(kind === "tag" ? {tags: ["Native"]} : {})});
    });
  }, ({project, board, defs, check, edit, jump}) => {
    const before = AtriumPCBPours.signalScope(board, project);
    edit("Change native membership", () => { project.signals.signals[0].legs[0].nets[0] = "FOREIGN"; });
    assert.deepEqual(AtriumPCBPours.signalScope(board, project), before, "the legacy signal mirror stays unchanged");
    check("native " + kind + " edit", 1);
    jump(-1);
    check("native " + kind + " undo", 0);
    jump(1);
    check("native " + kind + " redo", 1);
  });
}

{
  let parentLabel, parentWire, childWire, child, wireReads = 0;
  fixture("Wire tags in a child sheet", project => {
    scopedClearance(project, Q.selector("tag", "Wide"));
    const parent = project.documents.find(doc => doc.kind === "schematic"), objects = AtriumSchObjects;
    child = A.sheet("schematic", "Child");
    project.documents.push(child);
    const symbol = objects.make("sheetsymbol", [40, -10], {name: "Child Channel", sheet: child.id,
      entries: [{id: "entry", name: "SIGNAL", side: "left", offset: 5.08, io: "input"}]});
    const endpoint = objects.entryPoint(symbol, symbol.entries[0]), start = [endpoint[0] - 12, endpoint[1]];
    parentLabel = {id: "label", kind: "netlabel", x: start[0], y: start[1], text: "OTHER"};
    parentWire = {id: "parent-wire", kind: "wire", points: [start, endpoint]};
    parent.items.push(parentLabel, symbol, parentWire);
    let points = [[0, 0], [12, 0]];
    childWire = {id: "child-wire", kind: "wire", tags: ["Wide"],
      get points() { wireReads++; return points; },
      set points(value) { points = value; }};
    child.items.push(objects.make("port", [0, 0], {text: "SIGNAL", io: "input"}), childWire);
  }, ({project, board, check, edit, jump}) => {
    const directive = () => S.directives(project).records.find(row => row.item === childWire.id);
    const initial = directive();
    assert.equal(initial.net, "OTHER");
    edit("Change an unrelated project parameter", () => { project.parameters = {Title: "Unrelated"}; });
    wireReads = 0;
    assert.equal(directive(), initial);
    assert.equal(wireReads, 0, "unchanged hierarchy inputs skip schematic wire geometry");
    function verify(label, net, airwires) {
      assert.equal(directive().net, net, label);
      const fresh = A.clone(project), detached = fresh.documents.find(doc => doc.id === board.id);
      S.attach(fresh);
      assert.equal(C.inspectFull(detached, new Map(fresh.library.map(def => [def.id, def]))).airwires.length,
        airwires, label + " detached full sweep");
      check(label, airwires);
    }
    edit("Rename the parent net", () => { parentLabel.text = "FOREIGN"; });
    verify("parent rename", "FOREIGN", 1);
    jump(-1);
    verify("parent rename undo", "OTHER", 0);
    jump(1);
    verify("parent rename redo", "FOREIGN", 1);
    jump(-1);
    edit("Rewire both sheets and rename the parent net", () => {
      const [start, end] = parentWire.points;
      parentWire.points = [start, [start[0] + 6, start[1] + 1], end];
      parentLabel.text = "FOREIGN";
      childWire.points = [[0, 0], [6, 1], [12, 0]];
    });
    verify("parent and child rewired", "FOREIGN", 1);
    jump(-1);
    verify("rewire undo", "OTHER", 0);
    jump(1);
    verify("rewire redo", "FOREIGN", 1);
  });
}

{
  let visits = 0;
  fixture("Unchanged pour inputs", (project, board) => {
    R.edit(project, book => { clearance(book).gap = .2; });
    for (let i = 0; i < 256; i++) {
      const points = [[1, 35 + i], [2, 35 + i]];
      board.items.push({id: "track-" + i, kind: "track", width: .2, layer: "Top",
        get points() { visits++; return points; }});
    }
  }, ({project, board, defs, check, edit}) => {
    edit("Create component browsing metadata", () => { project.componentFamilies = []; });
    visits = 0;
    assert.equal(C.inspect(board, defs, U).airwires.length, 0);
    assert.equal(visits, 0, "the unchanged edit skips all copper geometry reads");
    check("component browsing metadata", 0);
    edit("Change clearance", () => { clearance(project.rules).gap = 1.4; });
    visits = 0;
    assert.equal(C.inspect(board, defs, U).airwires.length, 1);
    assert.ok(visits >= 256, "a changed pour input needs to read copper geometry");
  });
}

console.log("PASS pour connectivity through rule, signal, room membership and hierarchy edits, undo and redo");
