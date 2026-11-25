"use strict";
// Netlist export and import (app/schematic/netlist.js): KiCad, Protel and CSV round trips, import through a
// placeholder sheet and the ECO into an empty board, starter-part matching and malformed input.
const assert = require("node:assert/strict");
for (const f of ["model", "parts", "sch-objects", "hierarchy", "altium-rules", "rules", "pcb-appearance", "pcb-edit", "eco", "library-panel", "footprint-wizard", "starter-library", "netlist"])
  require(require("../support/app-source-paths.cjs").appFile(f + ".js"));
const A = Atrium, N = AtriumNetlist, E = AtriumECO;

// Nets as comparable sets: name -> sorted "REF-PIN" list.
const netSet = n => Object.fromEntries(n.nets.map(x => [x.name, x.nodes.map(y => y.ref + "-" + y.pin).sort()]));
const compSet = n => n.components.map(c => [c.ref, c.value, c.footprint].join("|"));

const p = AtriumParts.example();
const sch = N.extract(p, {source: "schematic"}), pcb = N.extract(p, {source: "pcb"});
assert.equal(sch.source, "schematic"); assert.equal(pcb.source, "pcb");
assert.ok(sch.components.length >= 4, "the example has components");
assert.ok(sch.nets.length >= 3, "the example has nets");
assert.deepEqual(netSet(sch), netSet(pcb), "the example's schematic and board agree");
assert.equal(N.extract(p).source, "schematic", "auto prefers the schematics");

// KiCad: export, detect, parse; the same components, values, footprints and nets.
const kt = N.kicad(sch, {name: "Example", date: "2026-01-01T00:00:00Z"});
assert.ok(kt.startsWith("(export (version \"E\")"));
assert.equal(N.detect(kt), "kicad");
assert.equal(N.sexpr(kt).length, 1, "one top-level list");
const kp = N.parse(kt);
assert.equal(kp.format, "kicad");
assert.deepEqual(compSet(kp), compSet(sch));
assert.deepEqual(netSet(kp), netSet(sch));
assert.deepEqual(kp.issues, []);
// Pin names travel through pinfunction / libparts.
const pinNames = n => n.components.flatMap(c => c.pins.map(x => c.ref + "-" + x.number + ":" + (x.name || ""))).sort();
assert.deepEqual(pinNames(kp).filter(s => !/:$/.test(s)).length > 0, true);
// Quoting: a value with quotes and backslashes survives.
const tricky = {...sch, components: sch.components.map((c, i) => i ? c : {...c, value: "say \"hi\" \\ ok"})};
assert.equal(N.parse(N.kicad(tricky)).components[0].value, "say \"hi\" \\ ok");

// Protel: export, detect, parse.
const pt = N.protel(sch);
assert.equal(N.detect(pt), "protel");
const pp = N.parse(pt);
assert.deepEqual(compSet(pp), compSet(sch));
assert.deepEqual(netSet(pp), netSet(sch));
// Designators with a hyphen still split on the longest known designator.
const hy = N.parse("[\r\nJ-1\r\nHDR\r\nX\r\n]\r\n[\r\nR1\r\n0603\r\n1k\r\n]\r\n(\r\nA\r\nJ-1-2\r\nR1-1\r\n)\r\n");
assert.deepEqual(netSet(hy), {A: ["J-1-2", "R1-1"]});

// CSV: nets and pins; formula-looking cells are neutralised on export and restored on import.
const ct = N.csv(sch);
assert.ok(ct.startsWith("Net,Designator,Pin,Pin Name"));
assert.equal(N.detect(ct), "csv");
assert.deepEqual(netSet(N.parse(ct)), netSet(sch));
const evil = N.csv({nets: [{name: "=CMD()", nodes: [{ref: "R1", pin: "1"}, {ref: "R2", pin: "1"}]}]});
assert.ok(evil.includes("\"'=CMD()\""), "a leading = is quoted");
assert.deepEqual(Object.keys(netSet(N.parse(evil))), ["=CMD()"]);

// Import into a project with the same library and no parts: a placeholder sheet, then Update PCB
// creates the footprints with the original pad nets.
const fresh = A.validate(JSON.parse(JSON.stringify(p)));
fresh.documents = [A.sheet("pcb", "Board")];
fresh.documents[0].outline = [[0, 0], [60, 0], [60, 40], [0, 40]];
const r = N.importInto(fresh, kp);
assert.equal(r.components, kp.components.length);
assert.equal(r.matched.generic, 0, "every component matched a library part: " + JSON.stringify(r));
assert.equal(r.board_added, false);
const sheet = fresh.documents.find(d => d.id === r.sheet_id);
assert.equal(sheet.kind, "schematic");
assert.equal(sheet.name, "Netlist import");
A.validate(fresh);
const plan = E.plan(fresh, {board: fresh.documents[0].id});
const report = E.execute(fresh, plan);
assert.equal(report.failed, 0, JSON.stringify(report.rows.filter(x => x.state === "failed")));
const back = N.extract(fresh, {source: "pcb"});
assert.deepEqual(compSet(back), compSet(sch), "footprints, values and designators");
assert.deepEqual(netSet(back), netSet(sch), "pad nets after the ECO");
assert.equal(E.plan(fresh, {board: fresh.documents[0].id}).changes.length, 0, "the sheet and the board are in sync");
// The imported sheet exports the same netlist again.
assert.deepEqual(netSet(N.extract(fresh, {source: "schematic"})), netSet(sch));
// Importing again names a second sheet and skips designators that are already drawn.
const again = N.importInto(fresh, kp);
assert.equal(again.components, 0);
assert.ok(again.issues.some(s => /already on sheet/.test(s)));
assert.equal(fresh.documents.find(d => d.id === again.sheet_id).name, "Netlist import 2");

// A KiCad netlist from another tool: unknown footprints become generic box parts that name the
// footprint, starter parts match by package and prefix, and a project with no board gets one.
const foreign = `(export (version "E")
  (components
    (comp (ref "R1") (value "330") (footprint "Resistor_SMD:R_0603_1608Metric") (libsource (lib "Device") (part "R") (description "Resistor")))
    (comp (ref "D1") (value "Red") (footprint "LED_SMD:LED_0805_2012Metric") (libsource (lib "Device") (part "LED") (description "LED")))
    (comp (ref "U1") (value "MCU") (footprint "Package_QFP:Odd-44") (libsource (lib "MCU") (part "X") (description "")) (property (name "MPN") (value "ABC-123"))))
  (libparts (libpart (lib "MCU") (part "X") (pins (pin (num "1") (name "VDD") (type "power_in")) (pin (num "2") (name "PA0") (type "bidirectional")))))
  (nets
    (net (code "1") (name "/LED_K") (node (ref "D1") (pin "1") (pinfunction "K") (pintype "passive")) (node (ref "R1") (pin "2") (pintype "passive")))
    (net (code "2") (name "VDD") (node (ref "U1") (pin "1")) (node (ref "D1") (pin "2")))
    (net (code "3") (name "IO") (node (ref "U1") (pin "2")) (node (ref "R1") (pin "1")))
    (net (code "4") (name "unconnected-(U1-Pad3)") (node (ref "U1") (pin "3")))))`;
const fp = N.parse(foreign);
assert.equal(fp.components.length, 3);
assert.equal(fp.components.find(c => c.ref === "U1").parameters.MPN, "ABC-123");
const empty = {format: "atrium", version: 1, name: "Empty", library: [], documents: [A.sheet("schematic", "Main")]};
const fr = N.importInto(empty, fp, {starter: AtriumStarterLibrary.defs()});
assert.equal(fr.board_added, true);
assert.deepEqual(fr.matched, {library: 0, starter: 2, generic: 1});
assert.ok(empty.library.some(d => d.id === "starter-r-0603"));
assert.ok(empty.library.some(d => d.id === "starter-led-0805"));
const generic = empty.library.find(d => d.source === "netlist-import");
assert.equal(generic.footprintName, "Odd-44");
assert.deepEqual(generic.symbol.pins.map(x => x.number), ["1", "2", "3"]);
assert.equal(generic.symbol.pins[0].electrical, 7, "power_in pins are Power");
const u1 = empty.documents.find(d => d.id === fr.sheet_id).items.find(i => i.ref === "U1");
assert.equal(u1.parameters.MPN, "ABC-123", "part numbers come only from the netlist");
for (const d of empty.library) for (const v of Object.values(d.parameters || {})) assert.ok(!/^C\d{3,}$/.test(v), "no invented LCSC numbers");
A.validate(empty);
const ep = E.plan(empty, {});
assert.ok(ep.issues.some(s => /Odd-44/.test(s)), "the missing footprint is reported by the ECO: " + ep.issues.join(" | "));
E.execute(empty, ep);
const eb = N.extract(empty, {source: "pcb"});
assert.deepEqual(eb.components.map(c => c.ref), ["D1", "R1"], "footprints for the parts the library could place");
assert.deepEqual(netSet(eb)["/LED_K"], ["D1-1", "R1-2"]);

// Malformed input is refused with a message, never half-imported.
assert.throws(() => N.parse("(export (components"), /unbalanced/);
assert.throws(() => N.parse("hello world"), /not a KiCad/);
assert.throws(() => N.parse("[\nR1\n"), /not closed/);
assert.throws(() => N.parse("(export (version \"E\") (x \"open)"), /unterminated/);
assert.throws(() => N.parse("(export " + "((((".repeat(60) + "))))".repeat(60)), /nested too deeply/);
const twice = N.parse("[\nR1\nX\n1\n]\n[\nR2\nX\n1\n]\n(\nA\nR1-1\nR2-1\n)\n(\nB\nR1-1\nR2-2\n)\n");
assert.ok(twice.issues.some(s => /is on A and B/.test(s)));
assert.deepEqual(netSet(twice), {A: ["R1-1", "R2-1"], B: ["R2-2"]});
assert.throws(() => N.importInto(p, kp, {board: "nope"}), /No board/);

console.log("SHIM-OK netlist");
