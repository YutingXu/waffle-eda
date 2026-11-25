"use strict";
// Compile Project / ERC and the Messages panel data model. Runs under Node
// (node tests/checks/erc.cjs) and under JavaScriptCore with a small require shim.
const assert = require("node:assert/strict");
require("../../app/core/model.js"); require("../../app/library/parts.js"); require("../../app/checks/erc.js"); require("../../app/editor/messages.js");
// ERC settings are the ERC rules of the project rule book (project-rules.js, with the rules engine).
for (const m of ["component-classes", "altium-rules", "pcb-draw", "net-intent", "signals", "rules", "project-rules"]) require(require("../support/app-source-paths.cjs").appFile(m + ".js"));
const ercRules = p => (p.rules?.list || []).filter(r => AtriumProjectRules.isErc(r.type));
const A = Atrium, E = AtriumERC, M = AtriumMessages;
const Scopes = AtriumDesignQueryRecord;
const defsFor = p => new Map(p.library.map(d => [d.id, d]));
const of = (result, check) => result.messages.filter(m => m.check === check);
const problems = result => result.messages.filter(m => m.class !== "Info");
const R = AtriumParts.catalogue.find(d => d.id === "std-r");
const u = 1.27;
function place(project, doc, def, ref, x, y, extra = {}) {
  const part = {id:A.id(), kind:"part", def:def.id, ref, value:def.value, link:A.id(), x, y, angle:0, pinNets:{}, ...extra};
  doc.items.push(part); return part;
}
const wire = (doc, ...points) => {const w = {id:A.id(), kind:"wire", points}; doc.items.push(w); return w;};
const label = (doc, text, x, y, type) => {const l = {id:A.id(), kind:"netlabel", text, x, y}; if (type) l.schPaint = {type}; doc.items.push(l); return l;};
const pinAt = (part, def, n) => A.pins(part, def, "schematic").find(p => p.number === String(n)).at;
function blank(name = "ERC") {
  const p = A.project(name, AtriumParts.catalogue);
  return {p, sch:p.documents[0], pcb:p.documents[1]};
}

// 1. The graph matches Atrium.connectivity on the sample and on crafted sheets.
function sameNets(doc, defs) {
  const a = A.connectivity(doc, defs), b = E.graph(doc, defs);
  assert.deepEqual([...b.byPin].sort(), [...a.byPin].sort());
  assert.deepEqual([...b.byWire].sort(), [...a.byWire].sort());
  assert.deepEqual(b.nets.map(n => [n.name, n.pins.length, n.wires.length, n.names.size > 1]),
    a.nets.map(n => [n.name, n.pins, n.wires, n.conflict]));
}
const sample = AtriumParts.example();
sameNets(sample.documents[0], defsFor(sample));

// 2. The sample project compiles cleanly.
let result = E.run(sample);
assert.deepEqual(problems(result).map(m => m.text), []);
assert.equal(result.passed, true);
assert.equal(result.messages.at(-1).class, "Info");
assert.match(result.summary, /Compiled 1 schematic sheet: no errors found/);

// 3. Duplicate and un-designated parts.
{
  const p = AtriumParts.example(), sch = p.documents[0];
  sch.items.find(i => i.ref === "R2").ref = "R1";
  sch.items.find(i => i.ref === "C2").ref = "C?";
  result = E.run(p);
  const dup = of(result, "duplicateDesignators");
  assert.equal(dup.length, 2);
  assert.ok(dup.every(m => m.class === "Error" && /Duplicate component designator R1/.test(m.text) && m.objectId && m.document === "Analog front end"));
  assert.equal(of(result, "unannotated").length, 1);
  assert.match(of(result, "unannotated")[0].text, /C\?/);
  assert.equal(result.passed, false);
  // Board links still match by link, so the renamed parts are not reported as missing from the board.
  assert.equal(of(result, "boardMismatch").length, 0);
}

// 4. Dangling wire, single-pin net, unconnected pin, floating label and power object.
{
  const {p, sch} = blank();
  const r1 = place(p, sch, R, "R1", 0, 0), a = pinAt(r1, R, 1), b = pinAt(r1, R, 2);
  wire(sch, a, [a[0] - 5, a[1]]);                       // pin 1 → open end
  label(sch, "LONELY", a[0] - 2.5, a[1]);               // on the wire mid-segment
  label(sch, "FLOAT", 40, 40);                          // nowhere
  label(sch, "VCC", 40, 50, "power");                   // nowhere
  wire(sch, [20, 20], [30, 20]);                        // both ends open
  sameNets(sch, defsFor(p));
  result = E.run(p);
  // The labelled stub's free end is a drawing style, not a fault; the unlabelled wire's ends are.
  const dangling = of(result, "danglingWires");
  assert.deepEqual(dangling.map(m => m.point.join(",")).sort(), ["20,20", "30,20"]);
  assert.ok(dangling.every(m => m.text === "Unconnected wire end" && m.class === "Warning"));
  assert.deepEqual(of(result, "singlePinNets").map(m => m.text), ["Net LONELY contains only one pin R1-1"]);
  assert.deepEqual(of(result, "unconnectedPins").map(m => m.text), ["Unconnected pin R1-2"]);
  assert.deepEqual(of(result, "unconnectedPins")[0].point, b);
  assert.deepEqual(of(result, "floatingLabels").map(m => m.text), ["Floating net label FLOAT"]);
  assert.deepEqual(of(result, "floatingPower").map(m => m.text), ["Floating power object VCC"]);
  // The empty board has not been populated, so no board mismatch is reported.
  assert.equal(of(result, "boardMismatch").length, 0);
  // A No ERC marker on the pin suppresses its report, and a wire end on a marker is not dangling.
  sch.items.push({id:A.id(), kind:"noerc", x:b[0], y:b[1]}, {id:A.id(), kind:"noerc", x:20, y:20});
  result = E.run(p);
  assert.equal(of(result, "unconnectedPins").length, 0);
  assert.deepEqual(of(result, "danglingWires").map(m => m.point.join(",")), ["30,20"]);
  // Removing the label from the stub exposes its free end.
  sch.items = sch.items.filter(i => i.text !== "LONELY");
  assert.ok(of(E.run(p), "danglingWires").some(m => m.point[0] === a[0] - 5));
}

// Unnamed-net spelling follows the sheet's naming mode without joining physical attachments.
{
  const {p, sch} = blank();
  const part = place(p, sch, R, "R12", 0, 0), at = pinAt(part, R, 1);
  const open = wire(sch, at, [at[0] - 5, at[1]]);
  const named = wire(sch, [0, 15], [5, 15]);
  label(sch, "SENSE", 0, 15);
  const floating = label(sch, "SENSE", 80, 80);
  for (const [sourceName, netNaming, name] of [
    [null, null, "Net-R12-1"], ["Imported.SchDoc", null, "NetR12_1"], [null, "first-pin", "NetR12_1"]
  ]) {
    sch.sourceName = sourceName; sch.netNaming = netNaming;
    const defs = defsFor(p);
    sameNets(sch, defs);
    const checked = E.run(p);
    assert.equal(A.connectivity(sch, defs).byWire.get(open.id), name);
    assert.equal(of(checked, "danglingWires").find(m => m.objectId === open.id).text, "Unconnected wire end on net " + name);
    assert.ok(of(checked, "floatingLabels").some(m => m.objectId === floating.id));
    assert.equal(A.connectivity(sch, defs).byWire.get(named.id), "SENSE");
  }
}

// 5. Wires that end on a junction, another wire's segment, or a pin are connected.
{
  const {p, sch} = blank();
  const r1 = place(p, sch, R, "R1", 0, 0), r2 = place(p, sch, R, "R2", 30, 0);
  const a = pinAt(r1, R, 2), b = pinAt(r2, R, 1);
  wire(sch, a, b);
  wire(sch, [(a[0] + b[0]) / 2, 0], [(a[0] + b[0]) / 2, 10]);   // T onto the middle of the first wire
  label(sch, "MID", (a[0] + b[0]) / 2, 10);
  result = E.run(p);
  assert.equal(of(result, "danglingWires").length, 0);
  assert.equal(of(result, "singlePinNets").length, 0);
  assert.deepEqual(of(result, "unconnectedPins").map(m => m.text).sort(), ["Unconnected pin R1-1", "Unconnected pin R2-2"]);
}

// 6. Multiple names on one net and duplicate local nets across sheets.
{
  const {p, sch} = blank();
  const s2 = A.sheet("schematic", "Second"); p.documents.push(s2);
  const r1 = place(p, sch, R, "R1", 0, 0), r2 = place(p, s2, R, "R2", 0, 0);
  const a = pinAt(r1, R, 1), c = pinAt(r1, R, 2), b = pinAt(r2, R, 1), d = pinAt(r2, R, 2);
  wire(sch, a, [a[0] - 5, 0]); label(sch, "SIG", a[0] - 5, 0); label(sch, "ALIAS", a[0] - 2, 0);
  wire(s2, b, [b[0] - 5, 0]); label(s2, "SIG", b[0] - 5, 0);
  wire(sch, c, [c[0] + 5, 0]); label(sch, "GND", c[0] + 5, 0, "power");
  wire(s2, d, [d[0] + 5, 0]); label(s2, "GND", d[0] + 5, 0, "power");
  result = E.run(p);
  assert.equal(of(result, "multipleNames").length, 1);
  assert.match(of(result, "multipleNames")[0].text, /SIG, ALIAS|ALIAS, SIG/);
  // Global scope (the default) joins same-named net labels across sheets, as on the board.
  assert.equal(E.scopeOf(p), "global");
  assert.equal(of(result, "duplicateNets").length, 0);
  // Flat scope keeps net labels on their sheet, so same-named local labels are duplicates.
  const flat = E.settings(p); flat.scope = "flat"; E.save(p, flat);
  assert.deepEqual(ercRules(p).map(r => [r.type, r.netScope]), [["ercNetScope", "flat"]], "the setting is an ERC rule of the project rule book");
  assert.equal(E.scopeOf(p), "flat");
  let dupNets = of(E.run(p), "duplicateNets");
  assert.equal(dupNets.length, 2);
  assert.ok(dupNets.every(m => /Duplicate net SIG/.test(m.text) && m.class === "Error"));
  assert.deepEqual(new Set(dupNets.map(m => m.document)), new Set(["Schematic", "Second"]));
  // A port named like the net connects it across sheets.
  label(sch, "SIG", a[0] - 5, 0, "port");
  dupNets = of(E.run(p), "duplicateNets");
  assert.deepEqual(dupNets.map(m => m.document), ["Second"]);
  sch.items.pop();
  assert.equal(of(E.run(p), "duplicateNets").length, 2);
  // A power port with the name is global.
  label(s2, "SIG", b[0] - 5, 0, "power");
  assert.deepEqual(of(E.run(p), "duplicateNets").map(m => m.document), ["Schematic"]);
  E.save(p, E.defaults());
  // Power ports are global: GND reaches two pins across the sheets, and SIG does too by name.
  assert.equal(of(result, "singlePinNets").length, 0);
  assert.match(result.summary, /Compiled 2 schematic sheets/);
}

// 7. Footprints and schematic ↔ board differences.
{
  const p = AtriumParts.example(), [sch, pcb] = p.documents;
  const bare = {id:"no-fp", name:"Bare symbol", prefix:"X", value:"X", symbol:{pins:[{number:"1", name:"1", x:0, y:0}], shapes:[]}};
  p.library.push(bare);
  place(p, sch, bare, "X1", 200, 200);
  const extra = A.clone(pcb.items.find(i => i.ref === "R1")); extra.id = A.id(); extra.ref = "R9"; extra.link = A.id(); pcb.items.push(extra);
  result = E.run(p);
  assert.deepEqual(of(result, "missingFootprint").map(m => m.text), ["Component X1 Bare symbol has no footprint"]);
  const diff = of(result, "boardMismatch").map(m => m.text).sort();
  assert.deepEqual(diff, ["Board component R9 has no schematic component", "Component X1 is not on Sensor board"]);
  assert.equal(of(result, "boardMismatch").find(m => /R9/.test(m.text)).document, "Sensor board");
  // Imported symbols name their footprint without carrying a board geometry.
  bare.footprintName = "SOT-23";
  assert.equal(of(E.run(p), "missingFootprint").length, 0);
}

// 8. Pin electrical types: connection matrix, floating inputs, nets without a driver.
{
  const {p, sch} = blank();
  const typed = {id:"typed", name:"Typed", prefix:"U", value:"Logic", footprint:R.footprint,
    symbol:{shapes:[], pins:[{number:"1", name:"IN", x:-5, y:0, electrical:0}, {number:"2", name:"OUT", x:5, y:0, electrical:2},
      {number:"3", name:"EN", x:0, y:5, electrical:"input"}]}};
  p.library.push(typed);
  const u1 = place(p, sch, typed, "U1", 0, 0), u2 = place(p, sch, typed, "U2", 20, 0);
  wire(sch, pinAt(u1, typed, 2), [5, -10], [25, -10], pinAt(u2, typed, 2));   // two outputs joined
  wire(sch, pinAt(u1, typed, 1), [-5, 10], [15, 10], pinAt(u2, typed, 1));    // two inputs, nothing driving them
  result = E.run(p);
  const matrix = of(result, "matrix");
  assert.equal(matrix.length, 1);
  assert.equal(matrix[0].class, "Error");
  assert.match(matrix[0].text, /contains multiple Output pins \(Output pin U1-2 \(OUT\), Output pin U2-2 \(OUT\)\)/);
  assert.deepEqual(of(result, "floatingInputs").map(m => m.text).sort(), ["Floating input pin U1-3 (EN)", "Floating input pin U2-3 (EN)"]);
  assert.ok(of(result, "floatingInputs").every(m => m.class === "Error"));
  assert.equal(of(result, "noDriver").length, 1);
  assert.match(of(result, "noDriver")[0].text, /no driving source \(Input pin U1-1 \(IN\), Input pin U2-1 \(IN\)\)/);
  // With floating inputs turned off, the inputs are reported as unconnected pins instead.
  const cfg = E.settings(p); cfg.checks.floatingInputs = "No Report"; cfg.checks.noDriver = "No Report"; cfg.matrix["2,2"] = "Fatal";
  E.save(p, cfg);
  result = E.run(A.validate(JSON.parse(JSON.stringify(p))));
  assert.equal(of(result, "floatingInputs").length, 0);
  assert.equal(of(result, "noDriver").length, 0);
  assert.equal(of(result, "unconnectedPins").length, 2);
  assert.equal(of(result, "matrix")[0].class, "Fatal");
  assert.equal(result.counts.Fatal, 1);
  assert.match(result.summary, /1 fatal error/);
}

// 9. Settings: defaults, overrides only, invalid values ignored, round trip through project JSON.
{
  const p = AtriumParts.example();
  assert.deepEqual(E.settings(p), E.defaults());
  assert.equal(E.stored(E.defaults()), null);
  // Only values that differ from the defaults are kept; invalid values are ignored.
  const raw = {version:1, checks:{duplicateDesignators:"Fatal", unknown:"Error", danglingWires:"Loud"}, matrix:{"7,2":"No Report", "9,9":"Error"}};
  assert.deepEqual(E.stored({...E.defaults(), checks:{...E.defaults().checks, ...raw.checks}, matrix:{...E.defaults().matrix, "2,7":"No Report", "9,9":"Error"}}), {version:1, checks:{duplicateDesignators:"Fatal"}, matrix:{"2,7":"No Report"}});
  const s = E.defaults(); s.checks.duplicateDesignators = "Fatal"; s.matrix["2,7"] = "No Report";
  E.save(p, s);
  const overrides = ercRules(p).map(rule => [rule.type, rule.id]);
  assert.deepEqual(overrides.map(([type]) => type), ["ercDuplicateDesignators", "ercPinMatrix"]);
  assert.ok(overrides.every(([, id]) => AtriumUUID.isV7(id)));
  E.save(p, s);
  assert.deepEqual(ercRules(p).map(rule => [rule.type, rule.id]), overrides, "saving the same options preserves override identity");
  assert.deepEqual(E.stored(E.settings(p)), {version:1, checks:{duplicateDesignators:"Fatal"}, matrix:{"2,7":"No Report"}});
  const loaded = A.validate(JSON.parse(JSON.stringify(p)));
  assert.deepEqual(E.stored(E.settings(loaded)), {version:1, checks:{duplicateDesignators:"Fatal"}, matrix:{"2,7":"No Report"}}, "the rule book round-trips through project JSON");
  loaded.documents[0].items.find(i => i.ref === "R2").ref = "R1";
  assert.deepEqual(of(E.run(loaded), "duplicateDesignators").map(m => m.class), ["Fatal", "Fatal"]);
  E.save(loaded, E.defaults());
  assert.equal(ercRules(loaded).length, 0, "defaults need no ERC rules");
  assert.deepEqual(E.settings(loaded), E.defaults());
  assert.deepEqual(of(E.run(loaded), "duplicateDesignators").map(m => m.class), ["Error", "Error"]);
  // Turning a check off removes its messages.
  const quiet = E.defaults(); quiet.checks.duplicateDesignators = "No Report";
  assert.equal(of(E.run(loaded, {settings:quiet}), "duplicateDesignators").length, 0);
}

// 10. Multi-part components (one designator, several symbols from one library reference) are not duplicates.
{
  const {p, sch} = blank();
  const partA = {id:"ua", name:"LM358", prefix:"U", value:"LM358", sourceName:"amps.SchDoc", footprintName:"SOIC-8", symbol:{shapes:[], pins:[{number:"1", name:"A", x:0, y:0}]}};
  const partB = {...A.clone(partA), id:"ub", symbol:{shapes:[], pins:[{number:"7", name:"B", x:0, y:0}]}};
  p.library.push(partA, partB);
  place(p, sch, partA, "U1", 0, 0); place(p, sch, partB, "U1", 50, 0);
  assert.equal(of(E.run(p), "duplicateDesignators").length, 0);
  place(p, sch, partA, "U1", 100, 0);
  assert.equal(of(E.run(p), "duplicateDesignators").length, 3);
}

// 11. Sheets imported without No ERC markers or buses say so.
{
  const p = AtriumParts.example();
  p.documents[0].notes = ["Omitted 1 × template images, 8 × No ERC markers, 3 × bus connectivity.", "Curves use line segments."];
  const info = of(E.run(p), "importNotice");
  assert.deepEqual(info.map(m => [m.class, m.text]), [["Info", "Imported without 8 No ERC markers, 3 bus connectivity. Related pins and nets may be reported."]]);
}

// 12. Messages panel data: grouping, numbering, filtering, sorting, export.
{
  const t = new Date(2026, 10, 18, 9, 5, 7);
  M.set("Compiler", [{class:"Error", source:"Compiler", text:"B", document:"Sheet"}, {class:"Warning", source:"Compiler", text:"a, \"quoted\"", document:"Sheet"}], t);
  M.set("DRC", [{class:"Fatal", source:"DRC", text:"=1+1", document:"Board"}, {class:"bogus", text:"<b>x</b>"}], t);
  let all = M.messages();
  assert.deepEqual(all.map(m => [m.no, m.class, m.group]), [[1, "Error", "Compiler"], [2, "Warning", "Compiler"], [3, "Fatal", "DRC"], [4, "Info", "DRC"]]);
  M.set("Compiler", [{class:"Info", text:"Again"}], t);
  all = M.messages();
  assert.deepEqual(all.map(m => [m.no, m.text]), [[1, "=1+1"], [2, "<b>x</b>"], [3, "Again"]]);
  assert.equal(M.summarize(all).text, "3 messages · 1 fatal error, 2 info");
  assert.deepEqual(M.filter(all, {classes:new Set(["Info"]), query:"again"}).map(m => m.no), [3]);
  assert.deepEqual(M.sort(all, "class").map(m => m.class), ["Fatal", "Info", "Info"]);
  assert.deepEqual(M.sort(all, "text", -1).map(m => m.text), ["Again", "=1+1", "<b>x</b>"]);
  const csv = M.toCSV(all).split("\r\n");
  assert.equal(csv[0], "Class,Document,Source,Message,Date,Time,No.");
  assert.equal(csv[1], "Fatal Error,Board,DRC,\"'=1+1\",2026-11-18,09:05:07,1");
  const html = M.toHTML(all, {title:"Compile <x>"});
  assert.ok(html.includes("&lt;b&gt;x&lt;/b&gt;") && html.includes("<title>Compile &lt;x&gt;</title>") && !html.includes("<b>x</b>"));
  M.clear("DRC"); assert.deepEqual(M.messages().map(m => m.no), [1]);
  M.clear(); assert.equal(M.messages().length, 0);
  // ERC results feed the panel directly.
  const bad = AtriumParts.example(); bad.documents[0].items.find(i => i.ref === "R2").ref = "R1";
  M.show(null, {title:"Compile", group:"Compiler", messages:E.run(bad).messages});
  assert.equal(M.summarize(M.messages()).counts.Error, 2);
  // Locate switches documents through ctx.select and pans with ctx.locate.
  const calls = [], ctx = {project:bad, select:id => calls.push(["select", id]), locate:(id, at) => calls.push(["locate", id, at]), info:text => calls.push(["info", text])};
  const target = M.messages().find(m => m.check === "duplicateDesignators");
  assert.equal(M.locate(target), false); // no ctx yet
  M.show(ctx, {group:"Compiler", messages:E.run(bad).messages});
  assert.equal(M.locate(M.messages().find(m => m.check === "duplicateDesignators")), true);
  assert.equal(calls[0][0], "select"); assert.equal(calls[1][0], "locate"); assert.equal(calls[1][2].length, 2);
  assert.equal(M.locate({objectId:"gone"}), false);
  assert.match(calls.at(-1)[1], /no longer exists/);
  M.clear();
}

// A saved formula is an annotation. An active authored assertion uses the same
// electrical findings and frozen evaluation in the synchronous host.
{
  const p = AtriumParts.example(), [sch] = p.documents, options = {time:new Date(0), revision:"frozen"};
  p.signals = {version:1, tags:[], signals:[{id:"assertion-rail", name:"48V", kind:"single", legs:[{nets:["48V"]}],
    intent:{confirmed:true, voltage:48}}]};
  const baseline = E.run(p, options).messages;
  const block = {id:"formula", kind:"textframe", x:10, y:20, w:50, h:20, text:"2 V + 2 V",
    calculation:{languageVersion:1, bindings:[], assertions:[]}};
  sch.items.push(block);
  assert.deepEqual(E.run(p, options).messages, baseline);
  assert.equal(globalThis.AtriumCalculations, undefined);

  const name = "net 48V.voltage", source = "assert " + name + " <= 24 V";
  const target = {scope:"signal", signalId:"assertion-rail", field:"voltage"};
  block.calculation.assertions.push({id:"limit", source, bindings:[{id:"rail-binding", name, span:[7, 7 + name.length], target}]});
  const setOptions = (enabled, severity) => AtriumProjectRules.edit(p, book => {
    book.list = [...book.list.filter(r => r.id !== "formula-rule"), {id:"formula-rule", type:"ercCalculationAssertion", name:"Rail limit",
      enabled, severity, priority:1, scope:Scopes.selector("all"), where:"schematic", sheets:[sch.id],
      origin:{kind:"calculation", sheet:sch.id, object:block.id, assertion:"limit"}}];
  });
  setOptions(false, "error");
  assert.deepEqual(E.run(p, options).messages, baseline);
  setOptions(true, "off");
  assert.deepEqual(E.run(p, options).messages, baseline);
  assert.equal(globalThis.AtriumCalculationCore, undefined);

  require("../../app/lazy.js");
  for (const file of AtriumLazy.files("AtriumCalculationDesign")) require(require("../support/app-source-paths.cjs").appFile(file));
  require("../../app/notebook/calculations.js");
  setOptions(true, "error");
  p.signals.signals[0].name = "Renamed rail";
  const reopened = A.validate(JSON.parse(JSON.stringify(p))), checked = E.run(reopened, options);
  const [finding] = of(checked, "calculationAssertion");
  assert.equal(of(checked, "calculationAssertion").length, 1);
  assert.equal(finding.ruleId, "formula-rule");
  assert.equal(finding.objectId, block.id);
  assert.equal(finding.detail.status, "fail");
  assert.deepEqual(finding.detail.span, [0, source.length]);
  assert.deepEqual(finding.detail.actual, {min:48, max:48});
  assert.deepEqual(finding.detail.inputs, [target]);
  const calculationSnapshot = AtriumCalculations.evaluateSnapshot(reopened, {revision:options.revision});
  assert.deepEqual(E.run(reopened, {...options, calculationSnapshot}).messages, checked.messages);
  assert.equal(globalThis.AtriumWorkerPool, undefined);
}

// Changing global Options retains the rules authored for a specific object or sheet.
{
  const p = AtriumParts.example(), [sch] = p.documents;
  sch.items.find(i => i.ref === "R2").ref = "R1";
  const onlyR1 = {id:"local-r1", type:"ercDuplicateDesignators", name:"R1", enabled:true, priority:1,
    scope:Scopes.selector("component", "R1"), severity:"warning", where:"schematic"};
  const sheetRule = {...onlyR1, id:"sheet-rule", type:"ercUnannotated", name:"Sheet only", scope:Scopes.selector("all"), sheets:[sch.id]};
  AtriumProjectRules.edit(p, book => book.list.push(onlyR1, sheetRule));
  const override = E.defaults(); override.checks.duplicateDesignators = "Fatal";
  E.save(p, override);
  E.save(p, E.defaults());
  assert.deepEqual(ercRules(p), [onlyR1, sheetRule]);
  assert.deepEqual(of(E.run(p), "duplicateDesignators").map(m => m.class), ["Warning", "Warning"]);
}

if (typeof print === "function") print("erc: ok"); else console.log("erc: ok");
