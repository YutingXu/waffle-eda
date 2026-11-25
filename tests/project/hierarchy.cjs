"use strict";
// Sheet hierarchy and project-wide connectivity (hierarchy.js): sheet symbols and entries,
// net identifier scopes, multi-channel repeats, bus-named ports, ERC hierarchy checks,
// ECO net names and the SchDoc importer's hierarchy, bus and No ERC records.
const assert = require("node:assert/strict");
for (const m of ["model", "parts", "sch-objects", "hierarchy", "erc", "messages", "eco", "import-link", "sch-import"]) require(require("../support/app-source-paths.cjs").appFile(m + ".js"));
const A = Atrium, S = AtriumSchObjects, H = AtriumHierarchy, E = AtriumERC;
const R = AtriumParts.catalogue.find(d => d.id === "std-r");
function place(doc, ref, x, y) {const part = {id:A.id(), kind:"part", def:R.id, ref, value:"10k", link:A.id(), x, y, angle:0, pinNets:{}}; doc.items.push(part); return part;}
const pin = (part, n) => A.pins(part, R, "schematic").find(p => p.number === String(n)).at;
const add = (doc, item) => {doc.items.push(item); return item;};
const wire = (doc, ...points) => add(doc, {id:A.id(), kind:"wire", points});
const label = (doc, text, at) => add(doc, {id:A.id(), kind:"netlabel", x:at[0], y:at[1], text});

// A top sheet with R1 driving a Power sheet (U_Power) through entries VIN and VOUT.
function design() {
  const p = A.project("Hier", AtriumParts.catalogue), top = p.documents[0];
  top.name = "Top";
  const child = A.sheet("schematic", "Power"); p.documents.push(child);
  const r1 = place(top, "R1", 0, 0), r2 = place(child, "R2", 0, 0);
  const sym = add(top, S.make("sheetsymbol", [40, -10], {name:"U_Power", sheet:child.id,
    entries:[{id:"vin", name:"VIN", side:"left", offset:5.08, io:"input"}, {id:"vout", name:"VOUT", side:"left", offset:10.16, io:"output"}]}));
  wire(top, pin(r1, 2), S.entryPoint(sym, sym.entries[0]));
  label(top, "SUPPLY", pin(r1, 2));
  add(child, S.make("port", pin(r2, 1), {text:"VIN", io:"input"}));
  add(child, S.make("port", pin(r2, 2), {text:"VOUT", io:"output"}));
  return {p, top, child, r1, r2, sym};
}

// 1. Instances, tree and navigation helpers.
{
  const {p, top, child, sym} = design();
  const inst = H.instances(p);
  assert.deepEqual(inst.instances.map(i => [i.doc.name, i.depth]), [["Top", 0], ["Power", 1]]);
  assert.deepEqual(H.tree(p).map(r => [r.doc.name, r.depth]), [["Top", 0], ["Power", 1]]);
  assert.deepEqual(H.parentOf(p, child.id), {doc:top, symbol:sym});
  assert.equal(H.parentOf(p, top.id), null);
  assert.equal(H.effectiveScope(p, "automatic"), "hierarchical");
  A.validate(p);
}

// 2. Hierarchical scope: entry VIN meets port VIN; the parent's label names the net.
{
  const {p, top, child, r1, r2} = design();
  const h = H.compile(p, {scope:"hierarchical"});
  assert.equal(h.netOf(top.id, r1.id, "2"), "SUPPLY");
  assert.equal(h.netOf(child.id, r2.id, "1"), "SUPPLY");
  assert.equal(h.netOf(child.id, r2.id, "2"), "VOUT", "a port names a net that reaches no label");
  // ERC compiles the design without reporting the sheet entries as floating.
  p.erc = {version:1, scope:"hierarchical", checks:{}, matrix:{}};
  const result = E.run(p);
  assert.equal(result.effectiveScope, "hierarchical");
  const net = [...result.messages].filter(m => /SUPPLY/.test(m.text) && /only one pin/.test(m.text));
  assert.equal(net.length, 0, "SUPPLY reaches R1 and R2 across the hierarchy");
}

// 3. Flat scope: entries are ignored and ports join by name; global: labels join too.
{
  const {p, top, child, r1, r2} = design();
  let h = H.compile(p, {scope:"flat"});
  assert.notEqual(h.netOf(top.id, r1.id, "2"), h.netOf(child.id, r2.id, "1"), "flat ignores sheet entries");
  const third = A.sheet("schematic", "Other"); p.documents.push(third);
  const r3 = place(third, "R3", 0, 0);
  add(third, S.make("port", pin(r3, 1), {text:"VOUT", io:"input"}));
  label(third, "SUPPLY", pin(r3, 2));
  h = H.compile(p, {scope:"flat"});
  assert.equal(h.netOf(third.id, r3.id, "1"), h.netOf(child.id, r2.id, "2"), "ports join by name");
  assert.notEqual(h.netOf(third.id, r3.id, "2"), h.netOf(top.id, r1.id, "2"), "labels are local in flat scope");
  assert.match(h.netOf(third.id, r3.id, "2"), /^SUPPLY_/, "a duplicate local name is made unique");
  h = H.compile(p, {scope:"global"});
  assert.equal(h.netOf(third.id, r3.id, "2"), h.netOf(top.id, r1.id, "2"), "labels join in global scope");
  // ERC reports the duplicate label in flat scope.
  p.erc = {version:1, scope:"flat", checks:{}, matrix:{}};
  assert.ok(E.run(p).messages.some(m => m.check === "duplicateNets" && /SUPPLY/.test(m.text)));
}

// 4. Multi-channel: Repeat(CH,1,2) instantiates the child twice; Repeat(SIG) fans out.
{
  const p = A.project("Multi", AtriumParts.catalogue), top = p.documents[0];
  const child = A.sheet("schematic", "Channel"); p.documents.push(child);
  const r = place(child, "R5", 0, 0);
  add(child, S.make("port", pin(r, 1), {text:"SIG", io:"input"}));
  label(child, "LOCAL", pin(r, 2));
  const sym = add(top, S.make("sheetsymbol", [40, 0], {name:"Repeat(CH,1,2)", sheet:child.id,
    entries:[{id:"s", name:"Repeat(SIG)", side:"left", offset:5.08, io:"input"}]}));
  const a = place(top, "R1", 0, 0), b = place(top, "R2", 0, 20);
  label(top, "SIG1", pin(a, 2)); label(top, "SIG2", pin(b, 2));
  A.validate(p);
  const h = H.compile(p, {scope:"hierarchical"});
  const channels = h.instances.filter(i => i.channel);
  assert.deepEqual(channels.map(i => i.channel.label), ["CH1", "CH2"]);
  const net = name => h.nets.find(n => n.name === name);
  assert.deepEqual(net("SIG1").pins.map(x => x.ref).sort(), ["R1", "R5_CH1"]);
  assert.deepEqual(net("SIG2").pins.map(x => x.ref).sort(), ["R2", "R5_CH2"]);
  assert.ok(net("LOCAL_CH1") && net("LOCAL_CH2"), "channel-local labels are per channel");
  assert.deepEqual(H.tree(p).map(r => [r.doc.name, r.channels]), [[top.name, 0], ["Channel", 2]]);
  void sym;
}

// 5. Bus-named ports and entries expand to members that meet net labels.
{
  const p = A.project("Bus", AtriumParts.catalogue), top = p.documents[0];
  const child = A.sheet("schematic", "Mem"); p.documents.push(child);
  const c0 = place(child, "R10", 0, 0), c1 = place(child, "R11", 0, 20);
  label(child, "D0", pin(c0, 1)); label(child, "D1", pin(c1, 1));
  add(child, S.make("bus", [0, 0], {points:[[-20, -10], [-20, 30]]}));
  add(child, S.make("port", [-20, -10], {text:"D[0..1]", io:"bidirectional"}));
  add(top, S.make("sheetsymbol", [40, 0], {name:"U_Mem", sheet:child.id, entries:[{id:"d", name:"D[0..1]", side:"left", offset:5.08, io:"bidirectional"}]}));
  const t0 = place(top, "R1", 0, 0), t1 = place(top, "R2", 0, 20);
  label(top, "D0", pin(t0, 2)); label(top, "D1", pin(t1, 2));
  const h = H.compile(p, {scope:"hierarchical"});
  assert.equal(h.netOf(child.id, c0.id, "1"), h.netOf(top.id, t0.id, "2"));
  assert.equal(h.netOf(child.id, c1.id, "1"), h.netOf(top.id, t1.id, "2"));
  assert.notEqual(h.netOf(top.id, t0.id, "2"), h.netOf(top.id, t1.id, "2"));
  assert.equal(h.issues.filter(i => i.kind.startsWith("unmatched")).length, 0);
}

// 6. ERC hierarchy checks: unmatched entries and ports, missing sheets, loops.
{
  const {p, top, child, sym} = design();
  sym.entries.push({id:"x", name:"EN", side:"left", offset:15.24, io:"input"});
  add(child, S.make("port", [80, 80], {text:"PG", io:"output"}));
  add(top, S.make("sheetsymbol", [100, 0], {name:"U_Lost", sheet:"nope"}));
  add(child, S.make("sheetsymbol", [100, 0], {name:"U_Loop", sheet:top.id}));
  p.erc = {version:1, scope:"automatic", checks:{}, matrix:{}};
  const m = E.run(p).messages;
  assert.ok(m.some(x => x.check === "unmatchedEntries" && /EN on U_Power has no port/.test(x.text)));
  assert.ok(m.some(x => x.check === "unmatchedEntries" && /Port PG on Power has no sheet entry/.test(x.text)));
  assert.ok(m.some(x => x.check === "missingSheet" && /U_Lost/.test(x.text)));
  assert.ok(m.some(x => x.check === "hierarchyLoop" && /U_Loop/.test(x.text)));
  // Scope options round-trip through the stored ERC settings.
  assert.equal(E.settings({erc:{scope:"hierarchical"}}).scope, "hierarchical");
  assert.equal(E.stored({...E.defaults(), scope:"automatic"}).scope, "automatic");
}

// 7. ECO: the board receives hierarchy net names.
{
  const {p, top, child, r1, r2} = design();
  const board = p.documents.find(d => d.kind === "pcb");
  for (const s of [r1, r2]) board.items.push({id:A.id(), kind:"part", def:R.id, ref:s.ref, value:s.value, link:s.link, x:0, y:0, angle:0, pinNets:{}});
  p.erc = {version:1, scope:"hierarchical", checks:{}, matrix:{}};
  const rows = AtriumECO.preview(p, "*", board.id).eco.rows.filter(r => r.field === "net");
  const net = (ref, n) => rows.find(r => r.component === ref && r.pin === n)?.after;
  assert.equal(net("R1", "2"), "SUPPLY"); assert.equal(net("R2", "1"), "SUPPLY"); assert.equal(net("R2", "2"), "VOUT");
  void top; void child;
}

// 8. Importer: sheet symbols with entries and file names, buses, bus entries, No ERC.
{
  const records = [
    "|HEADER=Protel for Windows - Schematic Capture Ascii File Version 5.0",
    "|RECORD=31|SHEETSTYLE=0",
    "|RECORD=15|LOCATION.X=100|LOCATION.Y=500|XSIZE=100|YSIZE=60|INDEXINSHEET=-1|OWNERPARTID=-1",
    "|RECORD=16|OWNERINDEX=1|SIDE=0|DISTANCEFROMTOP=2|NAME=VIN|IOTYPE=2|OWNERPARTID=-1",
    "|RECORD=16|OWNERINDEX=1|SIDE=1|DISTANCEFROMTOP=3|NAME=VOUT|IOTYPE=1|OWNERPARTID=-1",
    "|RECORD=32|OWNERINDEX=1|TEXT=U_Power|OWNERPARTID=-1",
    "|RECORD=33|OWNERINDEX=1|TEXT=Power.SchDoc|OWNERPARTID=-1",
    "|RECORD=26|LOCATIONCOUNT=2|X1=0|Y1=0|X2=200|Y2=0|OWNERPARTID=-1",
    "|RECORD=37|LOCATION.X=50|LOCATION.Y=-10|CORNER.X=60|CORNER.Y=0|OWNERPARTID=-1",
    "|RECORD=22|LOCATION.X=300|LOCATION.Y=300|OWNERPARTID=-1"
  ].join("\n");
  const top = AtriumSCH.read("Top.SchDoc", null, records).documents[0];
  const sym = top.items.find(i => i.kind === "sheetsymbol");
  assert.equal(sym.name, "U_Power"); assert.equal(sym.file, "Power.SchDoc");
  assert.deepEqual([sym.x, sym.y, sym.w, sym.h].map(v => +v.toFixed(3)), [25.4, -127, 25.4, 15.24]);
  assert.deepEqual(sym.entries.map(e => [e.name, e.side, +e.offset.toFixed(2), e.io]), [["VIN", "left", 5.08, "input"], ["VOUT", "right", 7.62, "output"]]);
  assert.equal(top.items.filter(i => i.kind === "bus").length, 1);
  const be = top.items.find(i => i.kind === "busentry");
  assert.deepEqual(S.busEntryEnd(be).map(v => +v.toFixed(3)), [15.24, 0]);
  assert.ok(top.items.some(i => i.kind === "noerc" && Math.abs(i.x - 76.2) < 1e-9));
  assert.ok(!top.notes.join(" ").match(/No ERC markers|bus connectivity|hierarchical sheet symbols|sheet entries/));
  // Linking imported sheets resolves the symbol's file name to the child document.
  const childDoc = AtriumSCH.read("Power.SchDoc", null, "|RECORD=31|SHEETSTYLE=0\n|RECORD=18|LOCATION.X=0|LOCATION.Y=0|NAME=VIN|WIDTH=50|STYLE=0").documents[0];
  const p = A.project("Imported", []); p.documents = [top, childDoc];
  AtriumImportLink.reconcile(p, [top, childDoc]);
  assert.equal(sym.sheet, childDoc.id);
  A.validate(p);
  const h = H.compile(p, {scope:"automatic"});
  assert.equal(h.effective, "hierarchical");
  assert.equal(h.instances.length, 2);
}
{
  const {p, sym}=design();
  sym.name="Repeat(CH,1,257)";
  const rejected=H.compile(p,{scope:"hierarchical"});
  assert.equal(rejected.instances.filter(i=>i.channel).length,0,"the compiler must refuse a partial channel list");
  const issue=rejected.issues.find(i=>i.kind==="channelLimit");
  assert.equal(issue?.item,sym);
  assert.match(issue.text,/256/);
  assert.ok(E.run(p).messages.some(m=>m.class==="Error"&&m.check==="hierarchy"&&m.text.includes(sym.name)));
  sym.name="Repeat(CH,256,1)";
  const allowed=H.compile(p,{scope:"hierarchical"});
  assert.deepEqual(allowed.instances.filter(i=>i.channel).map(i=>i.channel.number),
    Array.from({length:256},(_,i)=>256-i));
  assert.ok(!allowed.issues.some(i=>i.kind==="channelLimit"));
}
{
  require(require("../support/app-source-paths.cjs").appFile("multichannel.js"));
  const {p, sym}=design(), board=p.documents.find(doc=>doc.kind==="pcb");
  const opts={board:board.id,removeExtras:true};
  sym.name="Repeat(CH,1,256)";
  AtriumECO.update(p,opts);
  const channels=board.items.filter(i=>i.kind==="part" && i.ref.startsWith("R2_CH"));
  assert.equal(channels.length,256,"the board already contains the complete valid repeat");
  const earlier=AtriumECO.plan(p,opts);
  sym.name="Repeat(CH,1,257)";
  const before=JSON.stringify(board);
  assert.throws(()=>AtriumECO.plan(p,opts),/Cannot expand .*256 channels/,"comparison stops before proposing removals");
  assert.throws(()=>AtriumECO.execute(p,earlier),/Cannot expand .*256 channels/,"an already opened ECO also stops");
  assert.equal(JSON.stringify(board),before);
}
console.log("hierarchy: all checks passed");
