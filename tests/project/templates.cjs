"use strict";
// Template QA (PARITY-3 task 5) and schematic ergonomics (task 9).
// Every template builds a project that is DRC- and ERC-clean; the 4-layer and rigid-flex
// templates carry impedance profiles that solve on every substack above the fab's minimum
// width; the rigid-flex bend meets IPC-2223; start-page thumbnails match their boards.
// Then: the power-port glyph follows the net name, No ERC on unused pins, and
// sheet symbols sized to their entries.
const assert = require("node:assert/strict");
for (const m of ["model", "connectivity", "parts", "library-panel", "footprint-wizard", "starter-library", "impedance", "stackup", "viastack", "polygon-pour", "rules",
  "rigid-flex", "flex-drc", "fab-presets", "fab-presets/jlcpcb", "fab-profiles", "messages", "erc", "sch-objects", "sch-place", "templates"]) require(require("../support/app-source-paths.cjs").appFile(m + ".js"));
const T = AtriumTemplates, R = AtriumRules, E = AtriumERC, S = AtriumStackup, RF = AtriumRigidFlex, SP = AtriumSchPlace, SO = AtriumSchObjects, A = Atrium;
const defsOf = p => new Map(p.library.map(d => [d.id, d]));
const problems = p => E.run(p).messages.filter(m => m.class !== "Info");

const run = async () => {
  // ---- Every template, with and without the starter library: DRC and ERC clean.
  const ids = T.list().map(t => t.id);
  assert.deepEqual(ids, ["blank", "sheet-a4", "sheet-a3", "sheet-letter", "sheet-infinite", "2l-100x80-jlc", "4l-impedance", "shield", "rigid-flex"]);
  const built = {};
  for (const id of ids) for (const starter of [false, true]) {
    const p = await T.build(id, {name: id, starter});
    A.validate(JSON.parse(JSON.stringify(p)));
    const pcb = p.documents.find(d => d.kind === "pcb"), drc = R.drc(pcb, defsOf(p), R.stored(pcb, p), {project: p});
    assert.deepEqual(drc.violations.map(v => v.type + ": " + v.title), [], id + " is DRC-clean");
    assert.deepEqual(problems(p).map(m => m.text), [], id + " is ERC-clean");
    if (!starter) built[id] = p;
  }

  // ---- Rigid-flex: the bend meets the IPC-2223 minimum for its flex build-up (bug 5: 1.5 < 1.95 mm).
  const rf = built["rigid-flex"].documents[1], bend = rf.stackup.bends[0];
  const flex = S.substacks(S.stored(rf)).find(s => s.flex), thick = flex.layers.reduce((t, l) => t + (l.thickness || 0), 0);
  assert.ok(bend.radius >= RF.minBendRadius(thick, flex.layers.filter(S.isCopper).length, false).radius && bend.radius >= 1.95, "bend radius " + bend.radius + " vs " + thick);
  assert.deepEqual(RF.regions(rf).map(g => g.name).sort(), ["Flex tail", "Left rigid", "Right rigid"]);

  // ---- Impedance profiles: 50 Ω and 90 Ω on both outer layers, solved on every substack.
  for (const id of ["4l-impedance", "rigid-flex"]) {
    const pcb = built[id].documents[1], st = S.stored(pcb), minWidth = R.stored(pcb, built[id]).list.find(r => r.type === "width")?.min ?? .09;
    const profiles = S.impedanceProfiles(pcb);
    assert.ok(profiles.some(p => p.type === "single" && p.target === 50) && profiles.some(p => p.type === "diff" && p.target === 90), id + " has 50 Ω and 90 Ω profiles");
    for (const p of profiles) for (const key of ["Top", "Bottom"]) for (const sub of S.substacks(st)) {
      const v = S.profileValues(pcb, p.id, key, null, sub.id);
      assert.ok(v && !v.error, id + " " + p.id + " " + key + " on " + sub.id + ": " + v?.error);
      assert.ok(v.solved && v.within, id + " " + p.id + " solves to its target");
      assert.ok(Math.abs(v.z - p.target) < p.target * .01, id + " " + p.id + " z " + v.z);
      assert.ok(v.width >= minWidth, id + " " + p.id + " " + key + " " + sub.id + " width " + v.width + " >= " + minWidth);
      if (p.type === "diff") assert.ok(v.gap >= minWidth);
    }
  }

  // Every card, including the three fab presets, matches the geometry of the actual project.
  require("../../app/formats/fab-presets-start.js");
  for (const t of T.list()) {
    const p = built[t.id] || await T.build(t.id), pcb = p.documents.find(d => d.kind === "pcb"), st = pcb.stackup;
    const flexStacks = new Set(st?.substacks?.filter(s => s.flex).map(s => s.id));
    const defs = defsOf(p);
    const expected = pcb.outline.length ? {
      outline: pcb.outline, layers: st.layers.filter(S.isCopper).length, profiles: st.impedanceProfiles?.length || 0,
      regions: st.regions?.length ? RF.regions(pcb).map(g => ({points: g.points, flex: flexStacks.has(g.stack)})) : [],
      bends: (st.bends || []).map(b => [b.a, b.b]),
      parts: pcb.items.filter(i => i.kind === "part").map(i => A.bounds(A.itemPoints(i, defs.get(i.def), "pcb")).map(v => Math.round(v * 100) / 100))
    } : null;
    assert.deepEqual(t.thumbnail, expected, t.id + " card geometry");
    assert.equal(await T.preview(t.id), t.thumbnail, t.id + " reuses the registered thumbnail");
  }
  let previewBuilds = 0;
  const outline = [[0, 0], [8, 0], [0, 6]];
  const registration = T.register({id: "contributed", outline, build() {previewBuilds++; return A.project("Contributed");}});
  assert.deepEqual((await T.preview("contributed")).outline, outline, "a contributed outline needs no board model");
  assert.equal(previewBuilds, 0);
  registration.dispose();
  assert.equal(await T.preview("contributed"), null, "disposed templates have no stale thumbnail");

  // ---- Power-port glyph from the net name (the MCP add_power_port convention).
  const f = SP.powerStyleFor;
  for (const [n, s] of [["GND", "gnd"], ["gnd", "gnd"], ["VSS", "gnd"], ["DGND", "gnd"], ["PGND", "gnd"], ["AGND", "signal"], ["GNDA", "signal"], ["EARTH", "earth"],
    ["CHASSIS", "earth"], ["+3V3", "bar"], ["+5V", "bar"], ["+12V", "bar"], ["VCC", "bar"], ["VDD", "bar"], ["VBUS", "bar"], ["3V3", "bar"], ["VIN", "bar"],
    ["-5V", "arrow"], ["−12V", "arrow"], ["VEE", "arrow"], ["USB_DP", null], ["", null]]) assert.equal(f(n), s, n);
  // The popover's choice sticks: placed() remembers styleChosen, so the next port keeps it.
  SP.placed("power", {text: "GND", style: "circle", styleChosen: true});
  assert.deepEqual(SP.power(), {text: "GND", style: "circle", styleChosen: true});
  SP.placed("power", {text: "+3V3", style: "bar"});
  assert.deepEqual(SP.power(), {text: "+3V3", style: "bar"});

  // ---- No ERC on unused pins: a fresh MCU sheet goes from dozens of messages to none.
  const lib = [...AtriumParts.catalogue, ...AtriumStarterLibrary.defs()], p = A.project("MCU", lib), sch = p.documents[0], defs = defsOf(p);
  const place = (def, ref, x, y) => { const i = {id: A.id(), kind: "part", def, ref, value: "", link: "l-" + ref, x, y, angle: 0, pinNets: {}}; sch.items.push(i); return i; };
  const u1 = place("starter-mcu-qfp48", "U1", 100, 100), c1 = place("starter-c-0402", "C1", 40, 40);
  // C1 pin 1 wired to U1's first VDD: those two pins are used and keep no marker.
  const vdd = A.pins(u1, defs.get(u1.def), "schematic").find(q => q.name === "VDD"), c1p1 = A.pins(c1, defs.get(c1.def), "schematic")[0];
  sch.items.push({id: A.id(), kind: "wire", points: [c1p1.at, [c1p1.at[0], 30], [vdd.at[0], 30], vdd.at]});
  const noisy = problems(p).length;
  assert.ok(noisy >= 45, "a fresh MCU sheet is noisy (" + noisy + ")");
  assert.equal(SP.unusedPins(sch, defs, [c1.id]).length, 1, "C1 pin 2 only");
  const onU1 = SP.noErcUnused(sch, defs, [u1.id]);
  assert.equal(onU1.length, 47, "every U1 pin but the wired VDD");
  assert.ok(!onU1.some(m => A.same([m.x, m.y], vdd.at)));
  assert.deepEqual(problems(p).map(m => m.text), ["Unconnected pin C1-2"], "only C1 is left");
  assert.equal(SP.noErcUnused(sch, defs, [u1.id]).length, 0, "idempotent");
  assert.equal(SP.noErcUnused(sch, defs).length, 1, "the whole sheet");
  assert.deepEqual(problems(p), []);
  // The fallback without erc.js agrees on a simple sheet.
  const q = A.project("Q", lib), qs = q.documents[0]; qs.items.push({id: "r", kind: "part", def: "starter-r-0603", ref: "R1", value: "", x: 0, y: 0, angle: 0, pinNets: {}});
  const keepE = globalThis.AtriumERC; globalThis.AtriumERC = null;
  try { assert.equal(SP.unusedPins(qs, defsOf(q)).length, 2); } finally { globalThis.AtriumERC = keepE; }
  // The editor command: one undo step on the selection, a message, nothing when there is nothing to do.
  const msgs = [], edits = [];
  const host = {doc: () => sch, defs: () => defs, selection: () => [], info: m => msgs.push(m), edit: fn => { edits.push(1); fn(); }};
  assert.equal(SP.noErcCommand(host), 0); assert.equal(edits.length, 0); assert.match(msgs.at(-1), /^No unused pins on Schematic/);
  const c2 = place("starter-c-0402", "C2", 60, 40);
  assert.equal(SP.noErcCommand({...host, selection: () => [c2.id]}), 2); assert.equal(edits.length, 1); assert.match(msgs.at(-1), /^Placed 2 No ERC markers on unused pins of C2\./);

  // ---- Sheet symbols are sized to their entries.
  const ports = ["USB_DP", "USB_DN", "VBUS_SENSE", "I2C_SCL", "I2C_SDA", "INT"].map((name, i) => ({name, io: i === 5 ? "output" : "input"}));
  const sym = SO.make("sheetsymbol", [0, 0], {name: "U_USB", sheet: "x"});
  assert.deepEqual([sym.w, sym.h], [20.32, 15.24], "default size");
  sym.entries = SO.layoutEntries(ports);
  SO.fitSymbol(sym, {snug: true});
  const rows = Math.max(...sym.entries.map(e => e.offset));
  assert.ok(sym.h >= rows + 2.54 && sym.h <= rows + 5.08 + 1e-9, "height follows the entry rows (" + sym.h + ")");
  assert.ok(Math.abs(sym.w / 2.54 - Math.round(sym.w / 2.54)) < 1e-9 && Math.abs(sym.h / 2.54 - Math.round(sym.h / 2.54)) < 1e-9, "on the grid");
  const few = SO.make("sheetsymbol", [0, 0], {}); few.entries = SO.layoutEntries([{name: "A", io: "input"}]); SO.fitSymbol(few, {snug: true});
  assert.ok(few.w < 20.32 && few.h < 15.24 && few.w >= 10.16 && few.h >= 7.62, "a small sheet shrinks to its entries, not below 4 x 3 grid");
  const grown = SO.make("sheetsymbol", [0, 0], {w: 40, h: 40}); grown.entries = SO.layoutEntries(ports); SO.fitSymbol(grown);
  assert.deepEqual([grown.w, grown.h], [40, 40], "growing never shrinks a symbol the user enlarged");
  const empty = SO.make("sheetsymbol", [0, 0], {}); SO.fitSymbol(empty, {snug: true});
  assert.deepEqual([empty.w, empty.h], [20.32, 15.24], "no entries: size kept");
  console.log("SHIM-OK templates");
};
run().catch(e => { console.log("SHIM-FAIL " + e.message + "\n" + e.stack); });
