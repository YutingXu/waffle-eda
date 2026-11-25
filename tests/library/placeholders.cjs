"use strict";
// Placeholder components (app/library/placeholder-parts.js): deterministic
// definitions with function-tagged pins, provisional footprints, Resolve by function with nets kept,
// Revert, the BOM status and the Design Insight; a build without the placeholder module keeps them.
const assert = require("node:assert/strict");
for (const m of ["model", "parts", "component-families", "library-store", "library-panel", "footprint-wizard", "symbol-wizard", "generic-parts", "placeholder-parts"]) require(require("../support/app-source-paths.cjs").appFile(m));
const A = Atrium, GP = AtriumGenericParts, PH = AtriumPlaceholders, L = AtriumLibrary, SW = AtriumSymbolWizard;
const clone = v => JSON.parse(JSON.stringify(v));

{
  // Every family and offered package builds; ids are deterministic; pins carry function tags.
  let n = 0;
  for (const family of PH.ORDER) {
    const F = PH.FAMILIES[family];
    for (const params of [{}, {units: 2}, {units: 4}, {shutdown: true}, {pg: true, fb: true}, {bus: "spi"}, {bus: "qspi"}, {function: "nand", units: 4}, {function: "not", units: 6}, {type: "spdt"}]) {
      const p = F.params(params);
      for (const pkg of ["", ...F.packages(p)]) {
        const def = GP.make({family, params, package: pkg});
        assert.ok(L.validateDef(def).ok, family + " " + pkg + ": " + L.validateDef(def).errors[0]);
        assert.equal(def.generic.role, "placeholder");
        assert.equal(GP.make({family, params, package: pkg}).id, def.id, "deterministic id");
        assert.deepEqual(GP.make({family, params, package: pkg}), def, "byte for byte");
        const tagged = def.symbol.pins.filter(q => q.fn);
        assert.ok(tagged.length >= 2, family + ": function tags");
        if (pkg) {
          assert.ok(def.footprint.provisional, "provisional footprint");
          const pads = new Set(def.footprint.pads.map(q => String(q.number))), pins = new Set(def.symbol.pins.map(q => String(q.number)));
          for (const k of pads) assert.ok(pins.has(k), family + " " + pkg + ": pad " + k + " has a pin");
        } else assert.equal(def.footprint, undefined, "symbol only");
        n++;
      }
    }
  }
  const dual = GP.make({family: "opamp", params: {units: 2}, package: "SOIC-8"});
  assert.equal(dual.symbol.parts, 2, "one gate per unit, power shared");
  assert.deepEqual(dual.symbol.pins.filter(q => q.fn === "OUT").map(q => q.number).sort(), ["1", "7"], "LM358 pinout");
  const separate = GP.make({family: "opamp", params: {units: 2, power: "separate"}, package: "SOIC-8"});
  assert.equal(separate.symbol.parts, 3, "a separate power unit");
  const mem = GP.make({family: "memory", params: {bus: "parallel", address: 16, data: 8}, package: ""});
  assert.deepEqual(mem.symbol.pins.map(q => q.fn).filter(f => /^A\d/.test(f)).length, 16);
  assert.ok(["CS#", "WE#", "OE#", "V+", "GND"].every(f => mem.symbol.pins.some(q => q.fn === f)));
  assert.throws(() => GP.make({family: "opamp", params: {units: 2}, package: "SOT-23-5"}), /no package/);
  console.log("PASS " + n + " placeholder definitions: deterministic, function-tagged, provisional or symbol-only footprints");
}
{
  // Function inference from library pin names.
  const f = (name, family) => { const r = PH.infer(name, family); return r ? r.fn + "/" + r.unit : null; };
  assert.equal(f("+INA", "opamp"), "IN+/1"); assert.equal(f("INB-", "opamp"), "IN-/2"); assert.equal(f("1IN+", "opamp"), "IN+/1"); assert.equal(f("OUT2", "opamp"), "OUT/2");
  assert.equal(f("OUTA", "opamp"), "OUT/1"); assert.equal(f("VCC", "opamp"), "V+/0"); assert.equal(f("GND", "opamp"), "V-/0");
  assert.equal(f("~{SHDN}", "opamp"), "EN/0"); assert.equal(f("2Y", "logic"), "OUT/2"); assert.equal(f("A", "logic"), "IN1/1");
  assert.equal(f("ADJ", "ldo"), "FB/0"); assert.equal(f("PA7", "mcu"), "GPIO/0"); assert.equal(f("A12", "memory"), "A12/0"); assert.equal(f("CS#", "memory"), "CS#/0");
  console.log("PASS function inference: channel forms, active-low marks, supply aliases");
}

// A schematic drawn with placeholders, then resolved to a real dual op-amp.
const p = A.project("Sketch", []);
const sch = p.documents.find(d => d.kind === "schematic"), pcb = p.documents.find(d => d.kind === "pcb");
const ua = GP.place(p, sch, [50.8, 50.8], {family: "opamp", params: {units: 2}, package: "SOIC-8"}).part;
ua.ref = "U1";
const ub = A.instantiate(p, p.library.find(d => d.id === ua.def), [101.6, 50.8]); ub.ref = "U1"; ub.unit = 2; ub.link = ua.link; ub.value = ua.value; sch.items.push(ub);
const phDef = p.library.find(d => d.id === ua.def);
const tip = (item, fn) => A.pins(item, phDef, "schematic").find(q => phDef.symbol.pins.find(x => x.number === q.number && (x.part || 0) === (q.part ?? x.part ?? 0))?.fn === fn)?.at;
const label = (at, text) => { sch.items.push({id: A.id(), kind: "wire", points: [at, [at[0] - 5.08, at[1]]]}, {id: A.id(), kind: "netlabel", text, x: at[0] - 5.08, y: at[1]}); };
const pinAt = (item, fn) => { const pin = phDef.symbol.pins.find(x => x.fn === fn && ((x.part || 0) === (item.unit || 1) || !x.part)); return A.pins(item, phDef, "schematic").find(q => String(q.number) === String(pin.number)).at; };
label(pinAt(ua, "IN+"), "SIG_IN"); label(pinAt(ua, "OUT"), "SIG_MID"); label(pinAt(ub, "IN+"), "SIG_MID"); label(pinAt(ub, "OUT"), "SIG_OUT");
void tip;
pcb.items.push({...A.instantiate(p, phDef, [10, 10]), ref: "U1", link: ua.link, pinNets: {"3": "SIG_IN", "1": "SIG_MID", "5": "SIG_MID", "7": "SIG_OUT"}});

// The real part: OPA2333-style dual op-amp with channel-named pins and no function tags, two gates.
const table = SW.detect("Pin\tName\tType\tGate\n1\tOUTA\toutput\tA\n2\t-INA\tinput\tA\n3\t+INA\tinput\tA\n4\tV-\tpower\t\n5\t+INB\tinput\tB\n6\t-INB\tinput\tB\n7\tOUTB\toutput\tB\n8\tV+\tpower\t");
const built = SW.build(SW.pinsOf(table).pins, {layout: "gates", name: "OPA2333", prefix: "U", footprint: GP.make({family: "opamp", params: {units: 2}, package: "SOIC-8"}).footprint});
const real = {...built.def, id: "opa2333", name: "OPA2333 · SOIC-8", parameters: {Manufacturer: "TI", MPN: "OPA2333AIDR"}};
delete real.footprint.provisional;
p.library.push(real);

{
  const m = PH.mapping(p, ua, real);
  assert.deepEqual(m.missing, [], "every connected function is covered");
  assert.equal(m.map["3"], "3"); assert.equal(m.map["7"], "7"); assert.ok(m.inferred.length >= 6, "tags inferred from names");
  const c = PH.candidates(p, ua, {sources: false});
  assert.equal(c[0].def_id, "opa2333");
  assert.ok(!PH.candidates(p, ua, {sources: false}).some(x => x.def_id === ua.def), "placeholders are never candidates");
  // A single op-amp cannot serve unit 2's connections.
  const single = {...GP.make({family: "opamp", params: {}, package: "SOT-23-5"}), id: "lmv321", name: "LMV321", generic: undefined};
  delete single.generic; single.symbol.pins.forEach(q => delete q.fn);
  const sm = PH.mapping(p, ua, single);
  assert.ok(sm.missing.length > 0, "unit 2 has nowhere to go");
  console.log("PASS mapping by function: units in order, inferred tags, coverage of connected pins, candidates ranked");
}
{
  const nets = () => { const c = A.connectivity(sch, new Map(p.library.map(d => [d.id, d]))).byPin; return [ua, ub].map(i => [...c].filter(([k]) => k.startsWith(i.id + "/")).map(([k, v]) => k.slice(i.id.length + 1) + "=" + v).sort()); };
  const before = nets(), snapshot = clone(p);
  const r = PH.resolve(p, ua, "opa2333");
  assert.ok(!r.refused, r.message); assert.equal(ua.def, "opa2333"); assert.equal(ub.def, "opa2333");
  // AtriumDiff: one semantic library.resolved change per placed unit, not "symbol changed".
  for (const m of ["sch-objects", "hierarchy", "altium-rules", "pcb-draw", "component-classes", "rules", "diff"]) require(require("../support/app-source-paths.cjs").appFile(m + ".js"));
  const diff = AtriumDiff.compare(snapshot, clone(p)), kinds = diff.changes.map(c => c.kind);
  assert.ok(kinds.filter(k => k === "library.resolved").length >= 2, kinds.join(", "));
  assert.ok(!kinds.includes("part.symbol") && !kinds.includes("part.footprint"), kinds.join(", "));
  assert.match(diff.changes.find(c => c.kind === "library.resolved").text, /U1 opamp placeholder → OPA2333 · SOIC-8, \d+ pins mapped/);
  assert.deepEqual(nets(), before, "every pin keeps its net");
  assert.equal(ua.resolvedFrom.family, "opamp"); assert.equal(ua.resolvedFrom.map["7"], "7");
  const board = pcb.items.find(i => i.ref === "U1");
  assert.equal(board.def, "opa2333"); assert.equal(board.pinNets["7"], "SIG_OUT");
  assert.ok(!p.library.some(d => PH.isPlaceholder(d)), "the unused placeholder definition is pruned");
  assert.ok(!Object.keys(ua.parameters || {}).some(k => /mpn/i.test(k)), "nothing is written onto the part's parameters");
  assert.equal(PH.unresolved(p).length, 0);
  // Revert to placeholder and back.
  const back = PH.revert(p, ua);
  assert.ok(PH.isPlaceholder(p.library.find(d => d.id === back.def_id)));
  assert.deepEqual(nets(), before, "revert keeps the nets");
  assert.equal(PH.unresolved(p)[0].ref, "U1");
  assert.equal(pcb.items.find(i => i.ref === "U1").pinNets["7"], "SIG_OUT");
  console.log("PASS resolve keeps every net on sheet and board, records resolvedFrom, prunes the placeholder; revert restores it");
}
{
  // BOM status and the Design Insight list unresolved placeholders.
  for (const m of ["variants", "multichannel", "zip", "bom"]) require(require("../support/app-source-paths.cjs").appFile(m));
  const rows = AtriumBOM.build(AtriumBOM.collect(p, {}), {});
  const line = rows.find(r => r.refs.includes("U1"));
  assert.ok(line.status.includes("placeholder") && !line.status.includes("missing-mpn"), JSON.stringify(line.status));
  assert.match(line.values.status, /Placeholder/);
  for (const m of ["sch-objects", "erc", "insights", "insights-sch"]) require(require("../support/app-source-paths.cjs").appFile(m));
  const ins = AtriumInsights.analyze(p, sch);
  const hit = (ins.insights || ins).filter(x => x.check === "placeholder");
  assert.equal(hit.length, 1, JSON.stringify((ins.insights || ins).map(x => x.check)));
  assert.match(hit[0].message, /U1/);
  console.log("PASS BOM Placeholder status (not No MPN) and the unresolved-placeholder Insight");
}
{
  // A build without the placeholder module (the 1.3 generic-parts code) keeps the definitions: check()
  // reports them as unknown instead of throwing, prune keeps them while placed, the file validates.
  const saved = JSON.parse(JSON.stringify(p));
  delete globalThis.AtriumGenericParts; delete require.cache[require.resolve("../../app/library/generic-parts.js")];
  require("../../app/library/generic-parts.js");
  const old = globalThis.AtriumGenericParts;
  assert.notEqual(old, GP);
  const states = old.check(saved).map(x => x.state);
  assert.ok(states.every(s => s === "unknown" || s === "customised"), states.join(","));
  assert.equal(old.prune(saved), 0);
  A.validate(clone(saved));
  globalThis.AtriumGenericParts = GP;
  console.log("PASS older generic-parts code keeps placeholders (unknown family: no throw, not pruned)");
}
{
  // Release pre-flight: an unresolved placeholder warns (a provisional footprint fabricates); one with
  // no footprint fails; the "Release (placeholders resolved)" set fails on any.
  if (!globalThis.performance) globalThis.performance = {now: () => Date.now()};
  for (const m of ["altium-rules", "rules", "connectivity", "drc", "messages", "spatial", "pcb-appearance", "pcb-pours", "stackup", "board-shape", "rigid-flex", "fab-outputs", "fab-presets",
    "fab-presets/jlcpcb", "fab-profiles", "step-export", "kicad-export", "kicad-schematic", "ipc2581", "panel", "waivers", "drc-waivers", "output-jobs", "release"]) require(require("../support/app-source-paths.cjs").appFile(m + ".js"));
  const gate = (proj, set) => AtriumRelease.preflight(proj, set).checks.find(c => c.id === "placeholders");
  assert.equal(gate(p, "Generic fab + assembly").status, "warn", "a provisional footprint only warns");
  assert.equal(gate(p, "Release (placeholders resolved)").status, "fail", "the release set blocks");
  const bare = clone(p), s = bare.documents.find(d => d.kind === "schematic");
  GP.place(bare, s, [150, 50], {family: "memory", params: {bus: "parallel"}, package: null}).part.ref = "U7";
  const g = gate(bare, "Generic fab + assembly");
  assert.equal(g.status, "fail"); assert.match(g.items.find(i => /^U7/.test(i.text)).text, /no footprint/);
  console.log("PASS release gate: provisional placeholders warn, footprint-less ones fail, the release set blocks on any");
}
