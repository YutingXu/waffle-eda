"use strict";
// IPC-2581 rev B export (app/formats/ipc2581.js): well-formed XML, the structural
// checker, round trip against the Gerber and drill outputs, stack-up,
// drill spans, arcs, impedance specs and the XML reader's error handling.
const assert = require("node:assert/strict");
if (!globalThis.performance) globalThis.performance = {now: () => Date.now()};
for (const m of ["model", "parts", "spatial", "pcb-pours", "pcb-appearance", "zip", "vectorize", "pcb-text-rich", "pcb-text", "stackup", "impedance", "altium-rules", "rules", "viastack",
  "board-shape", "board-shape-editing", "rigid-flex", "polygon-pour", "bom", "fab-outputs", "ipc2581"]) require(require("../support/app-source-paths.cjs").appFile(m + ".js"));
const A = Atrium, F = AtriumFabOutputs, X = AtriumIPC2581, S = AtriumBoardShape, date = new Date(2026, 10, 18, 10, 30, 0);
const all = (node, name, out = []) => { if (node.name === name) out.push(node); for (const c of node.children) all(c, name, out); return out; };
const child = (node, name) => node.children.find(c => c.name === name);

// ---- Sample board: round trip against the Gerber and drill files -------------
const project = AtriumParts.example(), doc = project.documents.find(d => d.kind === "pcb"), frozen = JSON.stringify(project);
const r = X.build(project, doc, {date});
assert.equal(JSON.stringify(project), frozen, "export never modifies the design");
assert.equal(r.name, "Sensor board.ipc2581.xml");
assert.equal(r.revision, "B");
const tree = X.parse(r.content), c = X.check(r.content);
assert.deepEqual(c.errors, []); assert.ok(c.ok); assert.deepEqual(c.warnings, []);
assert.equal(tree.name, "IPC-2581"); assert.equal(tree.attrs.revision, "B"); assert.equal(tree.attrs.xmlns, "http://webstds.ipc.org/2581");
assert.deepEqual(tree.children.map(n => n.name), ["Content", "LogisticHeader", "HistoryRecord", "Bom", "Ecad"]);
assert.match(r.content, /^<\?xml version="1.0" encoding="UTF-8"\?>\n<IPC-2581 /);
assert.equal(X.build(project, doc, {date}).content, r.content, "deterministic for a fixed date");

const fab = F.build(project, doc, {date}), gerberOf = ext => fab.files.find(f => f.name.endsWith("." + ext));
const byLayer = c.counts.byLayer;
for (const [ext, layer] of [["GTL", "TOP"], ["GBL", "BOTTOM"], ["GTS", "SOLDERMASK_TOP"], ["GBS", "SOLDERMASK_BOTTOM"], ["GTP", "SOLDERPASTE_TOP"]])
  assert.equal(byLayer[layer].pads, gerberOf(ext).stats.flashes, ext + " flashes = " + layer + " pads");
const parts = doc.items.filter(i => i.kind === "part"), tracks = doc.items.filter(i => i.kind === "track");
assert.equal(c.counts.components, parts.length);
assert.equal(byLayer.TOP.lines + byLayer.BOTTOM.lines, tracks.length, "every track is a Line or Polyline");
const drills = fab.files.filter(f => f.kind === "drill").reduce((n, f) => n + f.stats.hits, 0);
assert.equal(c.counts.holes, drills, "every drill hit is a Hole");
assert.equal(byLayer.DRILL_PTH_TOP_BOTTOM.holes + byLayer.DRILL_NPTH_TOP_BOTTOM.holes, drills);
const pinNets = new Set();
for (const p of parts) for (const pad of project.library.find(d => d.id === p.def).footprint.pads) { const n = p.pinNets?.[pad.number] ?? pad.net; if (n) pinNets.add(n); }
assert.equal(c.counts.logicalNets, pinNets.size);
assert.equal(c.counts.packages, new Set(parts.map(p => p.def)).size);
// Component placement matches the pick-and-place file (same origin, Y up, CCW rotation).
const pnp = fab.files.find(f => f.kind === "pnp").content.split("\r\n"), comps = all(tree, "Component");
for (const comp of comps) {
  const row = pnp.find(l => l.startsWith("\"" + comp.attrs.refDes + "\"")).split(",").map(s => s.replace(/"/g, ""));
  const at = child(comp, "Location").attrs, rot = child(comp, "Xform")?.attrs.rotation ?? "0";
  assert.ok(Math.abs(+at.x - +row[4]) < 1e-4 && Math.abs(+at.y - +row[5]) < 1e-4, comp.attrs.refDes + " location");
  assert.equal(+rot, +row[6], comp.attrs.refDes + " rotation");
}
// Pads carry their pin and net; every PinRef resolves (the checker verifies the package pins).
const padsTop = all(all(tree, "LayerFeature").find(n => n.attrs.layerRef === "TOP"), "Pad");
assert.equal(padsTop.filter(p => child(p, "PinRef")).length, byLayer.TOP.pads - doc.items.filter(i => i.kind === "via").length - doc.items.filter(i => i.kind === "pad" && !(i.drill >= Math.min(i.w, i.h))).length);
const sets = all(tree, "Set");
assert.ok(sets.some(s => s.attrs.net === "GND" && s.attrs.padUsage === "VIA"));
assert.ok(sets.some(s => s.attrs.net === "GND" && s.attrs.padUsage === "TERMINATION"));
// Stack-up: copper and dielectric with Dk/Df, thickness sums.
const stackup = all(tree, "StackupLayer");
assert.deepEqual(stackup.map(s => s.attrs.layerOrGroupRef), ["SOLDERMASK_TOP", "TOP", "DIELECTRIC_1", "BOTTOM", "SOLDERMASK_BOTTOM"]);
const sum = stackup.reduce((s, l) => s + +l.attrs.thickness, 0);
assert.ok(Math.abs(sum - +all(tree, "Stackup")[0].attrs.overallThickness) < 1e-5);
const diel = all(tree, "Spec").find(s => s.attrs.name === "SPEC_DIELECTRIC_1");
assert.equal(all(diel, "Dielectric").find(d => d.attrs.type === "DIELECTRIC_CONSTANT").children[0].attrs.value, "4.8");
// BOM ties to the components.
assert.equal(all(tree, "RefDes").length, parts.length);
assert.deepEqual(new Set(comps.map(x => x.attrs.part)), new Set(all(tree, "BomItem").map(b => b.attrs.OEMDesignNumberRef)));
// Python's XML parser agrees it is well-formed (checked in development); here a second, independent reader:
assert.equal(r.content.match(/<[A-Za-z]/g).length, all(tree, "IPC-2581").length + tree.children.reduce(function n(s, x) { return s + 1 + x.children.reduce(n, 0); }, 0));

// ---- 4-layer board: inner planes, blind via, back-drill, arcs, escaping ---------
{
  const p = A.project("Four & <more>", AtriumParts.catalogue), pcb = p.documents.find(d => d.kind === "pcb");
  pcb.name = "Board \"4L\" & co";
  const shape = S.addCutout(S.rect({x: 0, y: 0, width: 50, height: 30, corners: {bl: {style: "radius", size: 3}, br: {style: "radius", size: 3}, tr: {style: "radius", size: 3}, tl: {style: "radius", size: 3}}}), S.circle(3, [20, -15]).contour);
  S.apply(pcb, shape);
  pcb.stackup = {version: 1, layers: AtriumStackup.preset("4").layers};
  pcb.items.push({id: "v1", kind: "via", x: 5, y: -5, diameter: .6, drill: .3, layer: "Multi", net: "GND"},
    {id: "v2", kind: "via", x: 8, y: -5, diameter: .5, drill: .2, net: "SIG", fromLayer: "Top", toLayer: "Inner 1"},
    {id: "v3", kind: "via", x: 11, y: -5, diameter: .6, drill: .3, net: "CLK", backdrill: {from: "bottom", toLayer: "Inner 1", stubMax: .15, diameter: .5}},
    {id: "t1", kind: "track", layer: "Inner 2", width: .15, net: "CLK", points: [[11, -5], [30, -5], [30, -20]]});
  const out = X.build(p, pcb, {date}), chk = X.check(out.content), t = X.parse(out.content);
  assert.deepEqual(chk.errors, []);
  const layers = all(t, "Layer").map(l => l.attrs.name + ":" + l.attrs.layerFunction);
  for (const l of ["TOP:SIGNAL", "INNER_1:PLANE", "INNER_2:PLANE", "BOTTOM:SIGNAL", "DIELECTRIC_1:DIELPREG", "DIELECTRIC_2:DIELCORE", "DIELECTRIC_3:DIELPREG"]) assert.ok(layers.includes(l), l + " in " + layers);
  const spans = all(t, "Layer").filter(l => l.attrs.layerFunction === "DRILL").map(l => l.attrs.name + " " + child(l, "Span").attrs.fromLayer + "-" + child(l, "Span").attrs.toLayer);
  assert.ok(spans.includes("DRILL_PTH_TOP_BOTTOM TOP-BOTTOM"), spans.join());
  assert.ok(spans.some(s => /^DRILL_PTH_TOP_INNER_1 TOP-INNER_1$/.test(s)), "blind via span " + spans.join());
  assert.ok(spans.some(s => /^DRILL_BACKDRILL_\w+ BOTTOM-INNER_2$/.test(s)), "back-drill from the bottom " + spans.join());
  assert.ok(out.warnings.some(w => /Back-drills/.test(w)));
  assert.equal(chk.counts.byLayer.INNER_2.lines, 1);
  const curves = all(child(all(t, "Step")[0], "Profile"), "PolyStepCurve");
  assert.equal(curves.length, 4 + 2, "four rounded corners and a circular cutout (two arcs or more)");
  assert.equal(all(child(all(t, "Step")[0], "Profile"), "Cutout").length, 1);
  assert.equal(all(t, "Step")[0].attrs.name, "Board_4L_co");
  assert.match(out.content, /<Ecad name="Board_4L_co">/);
  // Plane layers come from the stack even when empty; via lands are plotted on them.
  assert.equal(chk.counts.byLayer.INNER_1.pads, 3, "through, blind and back-drilled vias land on Inner 1");
  // Inches.
  const inch = X.build(p, pcb, {date, units: "in"});
  assert.ok(X.check(inch.content).ok);
  assert.match(inch.content, /<CadHeader units="INCH">/);
  assert.match(inch.content, /<Hole name="H1" diameter="0.011811[0-9]*"/);
  // Impedance specs (opt-in): controlled tracks reference an Impedance Spec.
  pcb.stackup.impedanceProfiles = [{id: "se50", name: "SE 50", type: "single", target: 50, tolerance: 10, layers: {"Inner 2": {enabled: true}}}];
  const rules = AtriumRules.create(); rules.list.find(x => x.type === "width").impedanceProfile = "se50"; AtriumRules.store(pcb, p, rules);
  const z = X.build(p, pcb, {date, impedance: true}), zt = X.parse(z.content);
  assert.ok(X.check(z.content).ok, X.check(z.content).errors.join("\n"));
  const spec = all(zt, "Spec").find(s => /^IMPEDANCE_se50_50_/.test(s.attrs.name));
  assert.ok(spec, "impedance spec");
  assert.equal(all(spec, "Impedance")[0].children[0].attrs.value, "50");
  assert.ok(all(zt, "Set").some(s => s.attrs.net === "CLK" && child(s, "SpecRef")?.attrs.id === spec.attrs.name));
  assert.ok(!/IMPEDANCE_/.test(X.build(p, pcb, {date}).content), "impedance specs are opt-in");
}

// ---- The reader rejects malformed XML -------------------------------------------
for (const [bad, why] of [["<a><b></a>", /does not match/], ["<a x=\"1\" x=\"2\"/>", /duplicate attribute/], ["<a x=1/>", /not quoted/], ["<a>&nbsp;</a>", /entity/],
  ["<a/><b/>", /more than one root/], ["<a>", /unclosed/], ["text<a/>", /outside the root/], ["<a x=\"<\"/>", /'<'/], ["", /no root/]]) {
  assert.throws(() => X.parse(bad), why, bad);
  assert.equal(X.check(bad).ok, false);
}
assert.deepEqual(X.parse("<a b='&amp;&#65;&#x42;'><!-- c --><d/></a>").attrs, {b: "&AB"});

// ---- The checker catches schema slips -------------------------------------------
const ipcProfile = '<IPC-2581 xmlns="http://webstds.ipc.org/2581" revision="B">\n<Content><DictionaryStandard units="MILLIMETER">\n<EntryStandard><Circle diameter="1"/></EntryStandard>\n</DictionaryStandard></Content>\n</IPC-2581>';
assert.ok(X.check(ipcProfile).errors.includes("line 3: <EntryStandard> needs the id attribute"));
assert.match(X.check(ipcProfile.replace("<EntryStandard>", '<EntryStandard id="&#12oops;">')).errors[0], /XML line 3: bad entity reference/);
const mutate = (from, to) => { assert.equal(r.content.split(from).length, 2, "unique anchor " + from); return X.check(r.content.replace(from, to)); };
assert.match(mutate("<FunctionMode mode=\"ASSEMBLY\" level=\"3\"/>", "<FunctionMode mode=\"BUILD\" level=\"3\"/>").errors[0], /mode="BUILD".*not one of/);
assert.match(mutate("<Role id=\"Owner\" roleFunction=\"SENDER\"/>", "<Role id=\"Owner\"/>").errors[0], /needs the roleFunction attribute/);
assert.match(mutate("<Datum x=\"0\" y=\"0\"/>", "").errors.join(), /needs a <Datum> child/);
assert.match(mutate("<LogisticHeader>", "<LogisticHeader><Bogus/>").errors.join(), /unexpected element <Bogus>/);
{
  const comp = r.content.match(/<Component refDes="R1" packageRef="[^"]+"/)[0];
  assert.match(mutate(comp, comp.replace(/packageRef="[^"]+"/, "packageRef=\"NOPE\"")).errors.join(), /unknown package "NOPE"/);
  assert.match(X.check(r.content.replace(/<PinRef componentRef="R1" pin="1"\/>/g, "<PinRef componentRef=\"R1\" pin=\"9\"/>")).errors.join(), /unknown component pin "R1 pin 9"/);
  const hole = r.content.match(/<Hole name="H1" diameter="[^"]+"/)[0];
  assert.match(mutate(hole, hole.replace(/diameter="[^"]+"/, "diameter=\"-1\"")).errors.join(), /diameter on <Hole> must be greater than zero/);
  const prof = r.content.match(/<Profile><Polygon><PolyBegin x="([^"]+)" y="([^"]+)"\/>/);
  assert.match(mutate(prof[0], prof[0].replace("x=\"" + prof[1] + "\"", "x=\"" + (+prof[1] + 1) + "\"")).errors.join(), /must end where it begins/);
  // Order: Component before Package is rejected.
  const step = r.content.slice(r.content.indexOf("<Step "), r.content.indexOf("</Step>"));
  const firstPkg = step.match(/<Package [\s\S]*?<\/Package>/)[0];
  const swapped = r.content.replace(firstPkg, "").replace(/(<\/Component>|<Component [^>]*\/>)(?![\s\S]*<Component )/, m => m + firstPkg);
  assert.match(X.check(swapped).errors.join(), /not allowed here in <Step>/);
}

// ---- Speed: a dense board ---------------------------------------------------------
{
  const p = A.project("Dense", AtriumParts.catalogue), pcb = p.documents.find(d => d.kind === "pcb");
  pcb.outline = [[0, 0], [200, 0], [200, 200], [0, 200]];
  for (let i = 0; i < 4000; i++) pcb.items.push({id: "v" + i, kind: "via", x: 1 + (i % 100) * 2, y: 1 + Math.floor(i / 100) * 2, diameter: .5, drill: .25, layer: "Multi", net: "N" + (i % 40)});
  for (let i = 0; i < 6000; i++) pcb.items.push({id: "t" + i, kind: "track", layer: i % 2 ? "Top" : "Bottom", width: .15, net: "N" + (i % 40), points: [[1 + (i % 100) * 2, 1.5 + Math.floor(i / 100) * 2], [2 + (i % 100) * 2, 1.5 + Math.floor(i / 100) * 2]]});
  let t0 = Date.now();
  const big = X.build(p, pcb, {date});
  const ms = Date.now() - t0;
  t0 = Date.now();
  const bc = X.check(big.content);
  const checkMs = Date.now() - t0;
  assert.ok(bc.ok, bc.errors.slice(0, 3).join("\n"));
  assert.equal(bc.counts.holes, 4000);
  assert.ok(ms < 4000 && checkMs < 4000, "build " + ms + " ms, check " + checkMs + " ms");
  console.log("PASS ipc2581: sample round trip, 4-layer stack, spans, arcs, impedance, reader and checker errors; 10k objects build " + ms + " ms, check " + checkMs + " ms, " + (big.content.length / 1048576).toFixed(1) + " MB");
}
