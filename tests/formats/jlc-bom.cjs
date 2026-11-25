"use strict";
// JLC-ready BOM (PARITY-3 task 7): the BOM optimiser's opt-in supplier lookup fills "LCSC #"
// and "JLC Part Type" from what a lookup really returned, never from made-up numbers; the JLC
// BOM output names every line still without a part number and adds a Basic/Extended column.
// The supplier is mocked (no network): a registered provider behind a fake fetch, plus the
// offline JLC parts CSV importer. Part codes below are test fixtures, not real LCSC parts.
const assert = require("node:assert/strict");
if (!globalThis.performance) globalThis.performance = {now: () => Date.now()};
for (const m of ["model", "altium-rules", "rules", "connectivity", "drc", "messages", "erc", "parts", "spatial", "pcb-appearance", "pcb-pours", "stackup", "board-shape",
  "rigid-flex", "zip", "fab-outputs", "fab-presets", "fab-presets/jlcpcb", "fab-profiles", "bom", "bom-optimiser", "step-export", "kicad-export", "kicad-schematic", "ipc2581", "panel", "output-jobs",
  "library-panel", "footprint-wizard", "starter-library"]) require(require("../support/app-source-paths.cjs").appFile(m + ".js"));
const O = AtriumBOMOptimiser, J = AtriumOutputJobs, A = Atrium;
const text = d => typeof d === "string" ? d : new TextDecoder().decode(d);
const date = new Date(Date.UTC(2026, 10, 18, 12, 0, 0));

const run = async () => {
  // ---- Starter parts are generic: no part numbers, and they say they need sourcing.
  for (const d of AtriumStarterLibrary.defs()) {
    assert.equal(d.parameters["LCSC #"], "", d.id + " ships without an LCSC number");
    assert.match(d.description, /^Generic .*Not a specific part: choose one and fill in its LCSC # \(or MPN\) before ordering\./, d.id);
  }

  // ---- A mocked network supplier. It records every request so the test can check what leaves.
  const calls = [];
  const fetch = async (url, init) => {
    calls.push({url, body: String(init?.body || "")});
    const q = JSON.parse(init.body), parts = [];
    const part = (mpn, description, sku, basic, supplier = "LCSC") => ({mpn, manufacturer: "Mockfab", description, package: "0603", lifecycle: "active",
      offers: [{supplier, sku, stock: 10000, moq: 1, mult: 1, currency: "USD", lifecycle: "active", basic, priceBreaks: [{qty: 1, price: .002}]}]});
    if (q.valueKey === "R10000" && q.package === "0603") parts.push(part("MOCK-R-10K", "10kΩ ±1% 1/10W 0603 thick film resistor", "C900001", true));
    if (q.valueKey === "C1e-7" && q.package === "0603") parts.push(part("MOCK-C-100N", "100nF 50V X7R 0603 ceramic capacitor", "C900002", false, "JLCPCB"));
    if (q.valueKey === "R100" && q.package === "0603") parts.push(part("MOCK-R-100R", "100Ω 1% 0603 resistor", "MOCK-SKU-100R", null, "Mockparts"));
    return {ok: true, status: 200, json: async () => ({parts})};
  };
  O.register({id: "mock-supplier", name: "Mock supplier", network: true, fields: [{key: "apiKey", label: "API key"}], configured: s => !!s?.apiKey,
    async search(q, ctx) { return (await (await ctx.fetch("https://mock.invalid/search", {method: "POST", body: JSON.stringify(q)})).json()).parts; }});

  const p = AtriumParts.example(), before = JSON.stringify(p);
  const analysis = O.analyse(p, {source: "schematic"});
  const lines = O.optimisedLines(analysis, []);

  // Consent: no enabled provider, no request. An unconfigured provider is not offered by the panel.
  const none = await O.price(lines, {providers: [], session: null});
  assert.equal(none.requests, 0); assert.equal(calls.length, 0, "nothing leaves without an enabled supplier");
  assert.equal(O.providers.get("mock-supplier").configured({}), false);
  assert.equal(O.providers.get("lcsc").stub, true, "LCSC's own API stays a documented stub");

  // The lookup: only MPN / supplier code / value text reach the supplier, never designators or nets.
  const pv = O.provider("mock-supplier", {fetch, settings: {apiKey: "k"}});
  const priced = await O.price(lines, {providers: [pv], session: null, interval: 0});
  assert.ok(calls.length > 0);
  for (const c of calls) {
    assert.deepEqual(Object.keys(JSON.parse(c.body)).sort(), ["lcsc", "mpn", "package", "text", "valueKey"]);
    assert.doesNotMatch(c.body, /"R1"|"C2"|FILTER|VOUT|Sensor interface/, "no designators, nets or project name");
  }
  const costing = O.cost(lines, priced, {boards: 10});
  const plan = O.assignments(p, analysis, costing);
  assert.equal(JSON.stringify(p), before, "planning changes nothing");
  assert.deepEqual(plan.lines.map(l => [l.refs, l.supplier, l.sku, l.basic]).sort(),
    [["C2", "JLCPCB", "C900002", false], ["R1", "LCSC", "C900001", true], ["R2", "Mockparts", "MOCK-SKU-100R", null]]);
  assert.ok(plan.skipped.some(s => /C1/.test(s.refs) && s.reason === "no match"), "10 nF had no offer and gets nothing");

  // Applying: both documents' R1 get the same LCSC # and Basic type; R2 (not LCSC) a supplier PN.
  const r = O.assign(p, plan);
  assert.equal(r.lines, 3);
  const on = ref => p.documents.flatMap(d => d.items.filter(i => i.kind === "part" && i.ref === ref));
  for (const i of on("R1")) assert.deepEqual([i.parameters["LCSC #"], i.parameters["JLC Part Type"], i.parameters["Manufacturer Part Number"]], ["C900001", "Basic", "MOCK-R-10K"]);
  for (const i of on("C2")) assert.deepEqual([i.parameters["LCSC #"], i.parameters["JLC Part Type"]], ["C900002", "Extended"]);
  for (const i of on("R2")) assert.deepEqual([i.parameters["Supplier"], i.parameters["Supplier Part Number"], i.parameters["LCSC #"]], ["Mockparts", "MOCK-SKU-100R", undefined]);
  for (const ref of ["C1", "U1", "J1", "J2"]) for (const i of on(ref)) assert.equal(i.parameters?.["LCSC #"], undefined, ref + " keeps no number");
  A.validate(JSON.parse(JSON.stringify(p)));
  // A second plan has nothing left to do; a stale plan is refused.
  assert.equal(O.assignments(p, O.analyse(p, {source: "schematic"}), costing).changes.length, 0);
  assert.throws(() => O.assign(p, plan), /changed since the lookup/);
  // Existing numbers are never overwritten unless asked.
  const q = AtriumParts.example();
  for (const i of q.documents.flatMap(d => d.items)) if (i.ref === "R1") i.parameters = {"LCSC #": "C123"};
  const keep = O.assignments(q, O.analyse(q, {source: "schematic"}), costing);
  assert.ok(!keep.changes.some(c => c.ref === "R1" && c.key === "LCSC #"));

  // ---- The JLC BOM output: LCSC Part # filled where found, Basic/Extended column, the rest named.
  const job = {name: "JLC BOM", outputs: [{kind: "bom", id: "bom", options: {style: "jlc", format: "csv", name: "BOM"}}]};
  const out = J.run(p, job, {date}), csv = text(out.files.find(f => /BOM\.csv$/.test(f.name)).data).split("\r\n").filter(Boolean);
  assert.equal(csv[0], "Comment,Designator,Footprint,LCSC Part #,Basic/Extended Part");
  assert.ok(csv.some(l => /"?R1"?,.*C900001.*Basic/.test(l)), csv.join("\n"));
  assert.ok(csv.some(l => /C2.*C900002.*Extended/.test(l)), csv.join("\n"));
  const warn = out.report.outputs[0].warnings.find(w => /no LCSC part number/.test(w));
  assert.ok(warn, "warns about lines without a part number");
  assert.match(warn, /^5 of 7 BOM lines have no LCSC part number, so JLCPCB cannot assemble them: /);
  for (const ref of ["C1", "U1", "J1", "J2", "R2"]) assert.ok(warn.includes(ref), ref + " named in: " + warn);
  assert.match(warn, /Starter parts are generic/);
  // Without any lookup data: no Basic/Extended column, every line named.
  const plain = J.run(AtriumParts.example(), job, {date});
  assert.equal(text(plain.files.find(f => /BOM\.csv$/.test(f.name)).data).split("\r\n")[0], "Comment,Designator,Footprint,LCSC Part #");
  assert.match(plain.report.outputs[0].warnings.find(w => /no LCSC/.test(w)), /^7 of 7 BOM lines/);

  // ---- Offline source: the user's JLC parts CSV (no network at all).
  const csvText = "LCSC Part,First Category,MFR.Part,Package,Solder Joint,Manufacturer,Library Type,Description,Stock,Price\n" +
    "C900010,Resistors,MOCK-RC0603-10K,0603,2,Mockfab,Basic,10kΩ ±1% 100mW 0603 Thick Film Resistor,500000,1-199:0.0005\n" +
    "C900011,Capacitors,MOCK-CC0603-10N,0603,2,Mockfab,Extended,10nF 50V X7R 0603 MLCC,20000,1-199:0.002\n";
  const fresh = AtriumParts.example(), fa = O.analyse(fresh, {source: "schematic"}), fl = O.optimisedLines(fa, []);
  const cat = O.jlcCatalogue(csvText);
  const offline = O.provider("jlc-library", {settings: {catalogue: cat}});
  assert.equal(offline.network, false);
  const fp = await O.price(fl, {providers: [offline], session: null});
  const fplan = O.assignments(fresh, fa, O.cost(fl, fp, {boards: 5, jlc: {enabled: true, extendedFee: 3}}));
  assert.deepEqual(fplan.lines.map(l => [l.refs, l.sku, l.basic]).sort(), [["C1", "C900011", false], ["R1", "C900010", true]]);
  O.assign(fresh, fplan);
  assert.deepEqual(fresh.documents.flatMap(d => d.items.filter(i => i.ref === "R1")).map(i => [i.parameters["LCSC #"], i.parameters["JLC Part Type"]]), [["C900010", "Basic"], ["C900010", "Basic"]]);

  // The report's own default columns are unchanged (the BOM grid adds Supplier Part Number when parts carry an LCSC #).
  assert.ok(!AtriumBOM.defaults.columns.includes("supplierPn"));
  console.log("SHIM-OK jlc-bom");
};
run().catch(e => { console.log("SHIM-FAIL " + e.message + "\n" + e.stack); });
