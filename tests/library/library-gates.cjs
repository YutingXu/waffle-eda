"use strict";
// Library follow-ups: gate-aware annotation (U1A/U1B), ECO with shared gate footprints, ERC gate
// checks, and fab-output fidelity for custom polygon pads, EP paste windows and pad stacks.
// Each block checks a patch from library-followups.py and says SKIP until that patch is applied.
const assert = require("node:assert/strict");
if (!globalThis.performance) globalThis.performance = {now: () => Date.now()};
for (const m of ["model", "parts", "spatial", "pcb-pours", "pcb-appearance", "zip", "vectorize", "pcb-text-rich", "pcb-text", "stackup", "impedance", "altium-rules", "rules", "viastack",
  "board-shape", "rigid-flex", "polygon-pour", "bom", "fab-outputs", "ipc2581", "eco", "annotate", "messages", "erc", "library-panel", "footprint-wizard"]) require(require("../support/app-source-paths.cjs").appFile(m + ".js"));
const A = Atrium, L = AtriumLibrary, N = AtriumAnnotate, E = AtriumECO, R = AtriumERC, F = AtriumFabOutputs, X = AtriumIPC2581;
const date = new Date(2026, 10, 18, 10, 30, 0);

// A dual op amp with a separate power gate C (V+ and V−).
function dualOpAmp(p) {
  const fp = L.createFootprint(p, {family: "gullwing", preset: "SOIC-8", add_symbol: false}).def;
  return L.createSymbol(p, {name: "Dual op amp", prefix: "U", value: "LM358", gates: 3, footprint_def_id: fp.id, pins: [
    {number: "1", name: "OUTA", type: "output", part: 1}, {number: "2", name: "-INA", type: "input", part: 1}, {number: "3", name: "+INA", type: "input", part: 1},
    {number: "7", name: "OUTB", type: "output", part: 2}, {number: "6", name: "-INB", type: "input", part: 2}, {number: "5", name: "+INB", type: "input", part: 2},
    {number: "8", name: "V+", type: "power", part: 3}, {number: "4", name: "V-", type: "power", part: 3}]}).def;
}
const gatePatched = !!A.gateLabel && /autoUnit/.test(String(N.plan));
{
  if (!gatePatched) console.log("SKIP gate-aware annotation (apply library-followups.py --only gates)");
  else {
    const p = A.project("Gates", AtriumParts.catalogue), [sch, pcb] = p.documents, def = dualOpAmp(p);
    const a = A.instantiate(p, def, [20, 20]), b = A.instantiate(p, def, [60, 20]);
    a.ref = b.ref = "U?"; sch.items.push(a, b);
    // Annotate: the second placement becomes gate B of the same package.
    const plan = N.plan(p, {action: "update"});
    const rows = new Map(plan.rows.map(r => [r.id, r]));
    assert.equal(rows.get(a.id).proposed, "U1"); assert.equal(rows.get(b.id).proposed, "U1");
    assert.deepEqual([rows.get(a.id).display, rows.get(b.id).display], ["U1A", "U1B"]);
    assert.ok(rows.get(b.id).unitChanged); assert.deepEqual(plan.duplicates, []);
    N.apply(p, plan, {boards: null});
    assert.deepEqual([a.ref, a.unit, b.ref, b.unit], ["U1", undefined, "U1", 2]);
    assert.equal(A.gateLabel(b, def).ref, "U1B"); assert.equal(A.gateLabel({ref: "R1"}, p.library[0]).ref, "R1");
    assert.deepEqual(A.pins(b, def, "schematic").map(x => x.number).sort(), ["5", "6", "7"]);
    // A third placement with a gate already chosen keeps it; a duplicate gate is reported by ERC.
    const c = A.instantiate(p, def, [100, 20]); c.ref = "U1"; c.unit = 2; sch.items.push(c);
    let erc = R.run(p).messages;
    assert.ok(erc.some(m => m.check === "duplicateGate" && /Gate B of U1/.test(m.text)), "gate used twice");
    assert.ok(erc.some(m => m.check === "missingPowerGate" && /Power gate C of U1/.test(m.text)), "power gate missing");
    assert.ok(!erc.some(m => m.check === "duplicateDesignators"), "gates are not duplicate designators");
    c.unit = 3;
    erc = R.run(p).messages;
    assert.ok(!erc.some(m => m.check === "duplicateGate" || m.check === "missingPowerGate"));
    // ECO: all three gates sync one footprint; nets come from whichever gate owns the pin.
    const fp = A.instantiate(p, def, [10, 10], 0, a); pcb.items.push(fp);
    sch.items.push({id: "l1", kind: "netlabel", text: "OUT_B", x: A.pins(b, def, "schematic").find(x => x.number === "7").at[0], y: A.pins(b, def, "schematic").find(x => x.number === "7").at[1]});
    sch.items.push({id: "l2", kind: "netlabel", text: "VCC", x: A.pins(c, def, "schematic").find(x => x.number === "8").at[0], y: A.pins(c, def, "schematic").find(x => x.number === "8").at[1]});
    const eco = E.preview(p, "*", pcb.id);
    assert.ok(!eco.issues.some(i => /Ambiguous|no linked footprint/.test(i)), eco.issues.join("; "));
    const nets = Object.fromEntries(eco.eco.rows.filter(r => r.field === "net").map(r => [r.pin, r.after]));
    assert.equal(nets["7"], "OUT_B"); assert.equal(nets["8"], "VCC");
    console.log("PASS gates: annotation fills free gates (U1A/U1B), ERC duplicate/missing power gate, ECO syncs all gates to one footprint");
  }
}
const fabPatched = F.padShape("custom", 1, 1) === "custom";
{
  if (!fabPatched) console.log("SKIP fab-output fidelity (apply library-followups.py --only fab)");
  else {
    const p = A.project("Fab", []), pcb = p.documents[1];
    pcb.outline = [[-10, -10], [10, -10], [10, 10], [-10, 10]];
    // A QFN-32 (EP with 60 % paste windows) plus a custom polygon pad and a T/M/B pad stack.
    const qfn = L.createFootprint(p, {family: "nolead", preset: "QFN-32 5×5", add_symbol: false}).def;
    const ep = qfn.footprint.pads.find(x => x.thermal);
    qfn.footprint.pads.push({number: "34", x: 4, y: 4, w: 1.2, h: 1, shape: "custom", angle: 0, drill: 0, poly: [[-.6, -.5], [.6, -.5], [.6, .5], [0, .8], [-.6, .5]]});
    qfn.footprint.pads.push({number: "35", x: -4, y: 4, w: 1.6, h: 1.6, shape: "round", drill: .8, layer: "Multi", plated: true, stackMode: "tmb",
      padStack: {Top: {w: 1.6, h: 1.6, shape: "round"}, Mid: {w: 1.2, h: 1.2, shape: "round"}, Bottom: {w: 2, h: 2, shape: "rect"}}});
    const part = A.instantiate(p, qfn, [0, 0], 90); pcb.items.push(part);
    const out = F.build(p, pcb, {date}), file = s => out.files.find(f => f.name.endsWith(s))?.content || "";
    const paste = out.model.layers.get("Top paste") || [];
    const windows = paste.filter(f => f.expandBy === 0);
    assert.equal(windows.length, ep.pasteApertures.length, "one paste flash per EP window");
    const area = windows.reduce((s, f) => s + f.pad.w * f.pad.h, 0);
    assert.ok(Math.abs(area / (ep.w * ep.h) - .6) < 1e-6, "windows cover 60 % of the exposed pad");
    assert.ok(windows.every(f => f.pad.angle === 90), "windows turn with the part");
    // Custom pad: an outline macro on copper, offset (not scaled) on the mask.
    const cu = (out.model.layers.get("Top") || []).find(f => f.pin === "34");
    assert.equal(cu.pad.shape, "custom"); assert.equal(cu.pad.poly.length, 5);
    const gtl = file(".GTL"); assert.match(gtl, /%AMATR\d+\*\n4,1,5,/, "outline macro with 5 vertices");
    for (const ext of [".GTL", ".GTS", ".GTP", ".GBL", ".G1"]) if (file(ext)) assert.deepEqual(require("../formats/gerber-check.cjs").check(file(ext)).issues, [], ext);
    const mask = (out.model.layers.get("Top mask") || []).find(f => f.pad?.shape === "custom");
    const grown = F.expandPad(mask.pad, .05);
    assert.equal(grown.poly.length, 5); assert.ok(grown.poly[0][0] < -.6 && grown.poly[0][1] < -.5, "mask grows outward");
    assert.equal(F.expandPad(mask.pad, -2), null, "a shrink past the pad leaves nothing");
    // Pad stack: inner and bottom copper use their own lands.
    const land = layer => (out.model.layers.get(layer) || []).find(f => f.pin === "35")?.pad;
    assert.equal(land("Top").w, 1.6); assert.equal(land("Bottom").shape, "rect"); assert.equal(land("Bottom").w, 2);
    assert.equal((out.model.layers.get("Bottom mask") || []).find(f => f.pad?.shape === "rect" && f.pad.w === 2) ? 1 : 0, 1, "bottom mask follows the bottom land");
    // IPC-2581: the custom pad is a Contour primitive and the file still checks.
    const x = X.build(p, pcb, {date});
    assert.match(x.content, /<EntryStandard id="CONTOUR_5_[0-9a-f]+"><Contour><Polygon><PolyBegin/);
    assert.deepEqual(X.check(x.content).errors, []);
    console.log("PASS fab outputs: EP paste windows, custom polygon pads (Gerber macro, mask offset, IPC-2581 Contour), per-layer pad stacks");
  }
}
