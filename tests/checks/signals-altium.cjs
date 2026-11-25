"use strict";
// Altium and KiCad classes, pairs and xSignal classes through the signal model: the importers keep the records (doc.sourceClasses), the rule engine and the model read them, Use the
// board's rules converts the rules scoped to them (into the project rule book), and the Altium exporter writes
// them back with their UNIQUEIDs.
// Fixtures: a PcbDoc saved by Altium Designer 26.12 with pairs, a pair class, xSignals through series caps and
// xSignal classes (tests/fixtures/altium/pairs-xsignals), a
// synthetic ASCII PcbDoc (tests/fixtures/altium/signals-ascii), the real PiDP-11 board (one net class) and the
// KiCad demo project (classes Default and Power).
const assert = require("node:assert/strict"), fs = require("node:fs"), path = require("node:path");
globalThis.CFB = require("../../app/vendor/cfb.min.js");
for (const f of ["model", "parts", "sch-objects", "hierarchy", "board-shape", "stackup", "query", "viastack", "rooms", "component-classes", "pcb-pours", "polygon-pour", "net-intent",
  "rules", "signals", "pcb-text-rich", "pcb-text", "pcb-draw", "zip", "import-link", "source-file", "sch-import", "altium-rules", "pcb-import", "io", "altium-export", "import-rules",
  "sexpr", "kicad-export", "kicad-schematic", "import-kicad"]) require(require("../support/app-source-paths.cjs").appFile(f + ".js"));
const A = Atrium, S = AtriumSignals, R = AtriumRules, X = AtriumAltiumExport;
const read = (dir, name) => AtriumIO.read(name, new Uint8Array(fs.readFileSync(path.join(__dirname, "../fixtures", dir, name))));
function project(results) {
  const p = A.project("Imported"); p.documents = []; p.library = [];
  for (const r of results) { p.documents.push(...(r.documents || [])); p.library.push(...(r.library || [])); }
  A.validate(p);
  return p;
}
const boardOf = p => p.documents.find(d => d.kind === "pcb");

{
  const p = project([read("altium/signals-ascii", "Signals.PcbDoc")]), b = boardOf(p);
  assert.ok(Array.isArray(b.sourceClasses), "class records are kept");
  const want = {netClasses: {Empty: [], HS: ["CLK", "TX_N", "TX_P"]}, diffPairs: [{name: "TX", positive: "TX_P", negative: "TX_N"}], diffPairClasses: {Lanes: ["TX"]}};
  // The rule engine and the model read them while the board has no rules of its own.
  assert.deepEqual(R.netClasses(b, {project: p}), {HS: ["TX_P", "TX_N", "CLK"], Empty: []});
  assert.deepEqual(R.diffPairs(b, {project: p}).map(x => [x.name, x.positive, x.negative, x.classes.join()]), [["TX", "TX_P", "TX_N", "Lanes"]]);
  const L = S.model(p, b).legacy();
  assert.deepEqual({netClasses: L.netClasses, diffPairs: L.diffPairs, diffPairClasses: L.diffPairClasses}, want);
  assert.deepEqual(L.xSignalClasses, {Clocks: ["CLK_U1_U2"]}, "an xSignal class whose xSignals are not imported keeps its members");
  // Use the board's rules: the converted rules scope to the classes, which stay the model's.
  AtriumImportRules.apply(b, p);
  assert.deepEqual(R.netClasses(b, {project: p}).HS, ["TX_P", "TX_N", "CLK"]);
  assert.equal(R.query(b, "width", {net: "CLK"}, {project: p}).ruleName, "HS_Width");
  // Export and read back: the same classes, pairs and UNIQUEIDs.
  const out = X.exportBoard(p, b), back = AtriumIO.read(out.name, out.bytes).documents[0];
  const ids = AtriumAltiumRules.classes(back.sourceClasses).ids;
  assert.equal(ids["0:HS"], "HSCLASSX"); assert.equal(ids["pair:TX"], "PAIRIDXX"); assert.equal(ids["6:Lanes"], "LANESIDX"); assert.equal(ids["10:Clocks"], "XSCLASSX");
  const c = S.canonicalLegacy(AtriumAltiumRules.classes(back.sourceClasses));
  assert.deepEqual({netClasses: c.netClasses, diffPairs: c.diffPairs, diffPairClasses: c.diffPairClasses}, {netClasses: {Empty: [], HS: ["CLK", "TX_N", "TX_P"]}, diffPairs: want.diffPairs, diffPairClasses: want.diffPairClasses});
  // Signals and tags export as Altium classes and scopes.
  S.edit(p, st => { const s = st.signals.find(x => x.name === "TX"); s.tags = [...(s.tags || []), "Serial"]; st.tags.push({name: "Serial"}); });
  const set = R.effective(b, p);
  set.list.push({...set.list.find(r => r.type === "width"), id: "w-tag", name: "SerialWidth", priority: 0.5, scope: AtriumDesignQueryRecord.selector("tag","Serial")});
  set.list.push({...set.list.find(r => r.type === "width"), id: "w-sig", name: "TxWidth", priority: 0.6, scope: AtriumDesignQueryRecord.create('object in signal "TX" on layer "Top"')});
  R.store(b, p, set);
  const text = X.exportBoard(p, b).content;
  assert.match(text, /RECORD=Class\|NAME=Serial\|KIND=0\|SUPERCLASS=FALSE\|M0=TX_N\|M1=TX_P/);
  assert.match(text, /RECORD=Class\|NAME=Serial\|KIND=6\|SUPERCLASS=FALSE\|M0=TX\|/);
  assert.match(text, /NAME=SerialWidth\|.*SCOPE1EXPRESSION=InNetClass\('Serial'\)/);
  const reimport=AtriumIO.read("Signals.PcbDoc",new TextEncoder().encode(text));
  const reopened=reimport.documents[0].sourceRules.map(line=>AtriumAltiumRules.describe(line)).filter(r=>r.name==="TxWidth");
  assert.equal(reopened.length,1);assert.equal(reopened[0].second,"All");
  const exchanged=AtriumQueryExchange.fromAltium(reopened[0].first);
  assert.ok(exchanged.ok,JSON.stringify(exchanged.diagnostics));
  const ctx=AtriumDesignQuery.context(p,b);
  const authored=AtriumDesignQuery.compile(set.list.find(r=>r.id==="w-sig").scope,ctx).plan;
  const returned=AtriumDesignQuery.compile(exchanged.scope,ctx).plan;
  for(const net of ["TX_N","TX_P","CLK","NC"])for(const layer of ["Top","Inner 1","Bottom"]){
    const subject={kind:"track",net,layer}, expected=(net==="TX_N" || net==="TX_P") && layer==="Top";
    assert.equal(authored.test(subject),expected,net+" "+layer);
    assert.equal(returned.test(subject),expected,net+" "+layer+" through actual PcbDoc");
  }
}
{
  // Saved by Altium: every class, pair, xSignal (with its series parts) and the rules scoped to them.
  const p = project([read("altium/pairs-xsignals", "PairsXSignals.PcbDoc")]), b = boardOf(p);
  const L = S.model(p, b).legacy();
  assert.deepEqual(L.netClasses, {HS_NETS: ["PCIE_TX_C_N", "PCIE_TX_C_P", "PCIE_TX_N", "PCIE_TX_P", "USB_DM", "USB_DP"], POWER: ["+3V3", "GND"]});
  assert.deepEqual(L.diffPairs, [{name: "PCIE_TX", positive: "PCIE_TX_P", negative: "PCIE_TX_N"}, {name: "USB", positive: "USB_DP", negative: "USB_DM"}], "USB_DP/USB_DM: no suffix convention");
  assert.deepEqual(L.diffPairClasses, {HS_PAIRS: ["PCIE_TX", "USB"]});
  assert.deepEqual(L.xSignals.map(x => [x.name, x.from.ref + "-" + x.from.pin, x.to.ref + "-" + x.to.pin, (x.through || []).join()]),
    [["PCIE_TX_N_XS", "U1-4", "J1-4", "C2"], ["PCIE_TX_P_XS", "U1-3", "J1-3", "C1"], ["USB_DM_XS", "U1-2", "J1-2", ""], ["USB_DP_XS", "U1-1", "J1-1", ""]]);
  assert.deepEqual(L.xSignalClasses, {PCIE_TX_XSIGNALS: ["PCIE_TX_N_XS", "PCIE_TX_P_XS"], USB_XSIGNALS: ["USB_DM_XS", "USB_DP_XS"]});
  // The xSignal through C1 spans both of its nets for InxSignal.
  const X = AtriumQuery.ruleMatcher("InxSignal('PCIE_TX_P_XS')", {doc: () => b});
  assert.ok(X({net: "PCIE_TX_P"}) && X({net: "PCIE_TX_C_P"}) && !X({net: "PCIE_TX_N"}));
  // Use the board's rules: the pair-class and xSignal-class scopes resolve.
  AtriumImportRules.apply(b, p);
  const C = R.compiled(b, {project: p});
  const dp = C.byType.diffPairsRouting.find(r => /HS_PAIRS/.test(JSON.stringify(r.scope)));
  assert.ok(dp && dp.m1({net: "USB_DP", pair: "USB"}) && dp.m1({net: "PCIE_TX_N", pair: "PCIE_TX"}) && !dp.m1({net: "GND"}), "InDifferentialPairClass('HS_PAIRS')");
  const ml = C.byType.matchedLengths.find(r => /PCIE_TX_XSIGNALS/.test(JSON.stringify(r.scope)));
  assert.ok(ml && ml.m1({net: "PCIE_TX_P", xSignal: "PCIE_TX_P_XS"}) && !ml.m1({net: "USB_DP", xSignal: "USB_DP_XS"}), "InxSignalClass('PCIE_TX_XSIGNALS')");
  // Export and read back: the xSignals as pin pairs (series pads included), their GUIDs and pad UNIQUEIDs kept.
  const out = X0 => X0;
  const text = AtriumAltiumExport.exportBoard(p, b).content;
  assert.match(text, /PINPAIRCOUNT=4/);
  assert.match(text, /PINPAIRNAME\d=PCIE_TX_P_XS\|[^\r\n]*PINPAIRPINS\d=U1-3,C1-1,C1-2,J1-3\|PINPAIRPINUNIQUEIDS\d=PHWGSKKT,KTPEBONA,CEXTXDLH,OSCNRRQO\|PINPAIRGUID\d=\{505FF14D-1DF0-4BFE-924F-31F3894569A9\}/);
  const back = AtriumIO.read("Back.PcbDoc", new TextEncoder().encode(text)).documents[0];
  assert.equal(back.lengthTuning, undefined, "xSignals are the signal model's (from the board's records)");
  assert.deepEqual(S.xsView(back, {documents: [back]}).xSignals.map(x => x.name).sort(), ["PCIE_TX_N_XS", "PCIE_TX_P_XS", "USB_DM_XS", "USB_DP_XS"]);
  void out;
}
{
  // The real Altium board: its net class 1A (VCC_5V) is no longer lost.
  const dir = "altium/pidp11-io-expander", p = project(["PiDP11IOExpander.SchDoc", "PiDP11IOExpander.PcbDoc"].map(n => read(dir, n)));
  assert.deepEqual(R.netClasses(boardOf(p), {project: p}), {"1A": ["VCC_5V"]});
  assert.deepEqual(S.model(p, boardOf(p)).legacy().netClasses, {"1A": ["VCC_5V"]});
}
{
  // KiCad: the project keeps named classes and the same per-net routing limits when the board adds a mask rule.
  const I = AtriumImportFormats, enc = new TextEncoder(), text = n => fs.readFileSync(path.join(__dirname, "../fixtures/import", n), "utf8");
  const file = (name, data = text(name)) => ({name, bytes: enc.encode(data)});
  const inputs = ["demo.kicad_pro", "demo.kicad_pcb", "root.kicad_sch", "child.kicad_sch"].map(name => file(name));
  const importedBoard = files => I.readSet(files).flatMap(r => r.documents || []).find(d => d.kind === "pcb");
  const board = importedBoard(inputs);
  const classes = AtriumAltiumRules.classes(board.sourceClasses).netClasses;
  assert.ok(classes.Power?.includes("GND"), JSON.stringify(classes));
  assert.equal(board.rules.version, 2);
  const mask = board.rules.list.find(rule => rule.type === "solderMask");
  assert.equal(mask.expansion, 0);
  assert.ok(R.kit.allScope(mask.scope));
  inputs[1] = file("demo.kicad_pcb", text("demo.kicad_pcb").replace("(pad_to_mask_clearance 0)", ""));
  const withoutExpansion = importedBoard(inputs);
  assert.equal(withoutExpansion.rules.list.find(rule => rule.type === "solderMask").expansion, .1016,
    "an absent expansion uses the native mask default");
  assert.deepEqual(R.netClasses(withoutExpansion), R.netClasses(board));
  const routing = rules => R.migrate(rules).list.filter(rule => ["clearance","width","viaStyle"].includes(rule.type));
  assert.deepEqual(routing(board.rules), routing(withoutExpansion.rules));
}
console.log("signals-altium ok");
