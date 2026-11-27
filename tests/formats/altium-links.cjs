"use strict";
// Web links in an imported Altium design (synthetic records; values are made up):
//  1. A schematic component's URL parameters (ComponentLink<N>URL with its Description, HelpURL, a
//     datasheet link) and a hyperlinked text (record 4 URL=) are kept on import.
//  2. The Links view lists them by description or name and opens only http(s) without credentials.
//  3. They survive a native save and reopen, and an Altium export and re-import, where the link
//     parameters take Altium's spelling and the text keeps its URL.
//  4. A binary PcbDoc's component parameters (PrimitiveParameters, including UNICODE__VALUE text) are
//     kept on the placement's footprint; System rows (vault GUIDs) and Footprint rows are not.
const assert = require("node:assert/strict"), fs = require("node:fs"), path = require("node:path");
if (!globalThis.performance) globalThis.performance = {now: () => Date.now()};
globalThis.CFB = require("../../app/vendor/cfb.min.js");
for (const f of ["model", "parts", "sch-objects", "hierarchy", "board-shape", "stackup", "polygon-pour", "import-link", "source-file", "altium-ids", "sch-import",
  "altium-rules", "pcb-pours", "pcb-import", "io", "import-worker-client", "altium-export", "sch-object-inspector"]) require(require("../support/app-source-paths.cjs").appFile(f + ".js"));
const {nativeRoundTrip} = require("../support/native-cad.cjs");
const A = Atrium, enc = new TextEncoder(), clone = v => JSON.parse(JSON.stringify(v));
const {linksOf, webURL} = AtriumSchObjectInspector;
function open(files) {
  const all = files.map(f => AtriumIO.read(f.name, f.bytes));
  return A.validate(clone(AtriumImport.assemble(all, files, A.project("x", AtriumParts.catalogue), null, false).after));
}
const imported = p => p.documents.filter(d => d.sourceName);

// ---------------------------------------------------------------- 1. schematic import
const DATASHEET = "https://example.com/parts/res-0603.pdf", HELP = "https://example.org/help/res", VENDOR = "http://vendor.example.net/item?id=42";
const TEXT_URL = "https://example.com/notes/power", HYPER_URL = "https://example.org/hyper", BARE_URL = "https://example.net/bare";
const line = f => "|" + Object.entries(f).map(([k, v]) => k + "=" + v).join("|");
const sch = "|HEADER=Protel for Windows - Schematic Capture Ascii File Version 5.0|WEIGHT=10\r\n" + [
  {RECORD: 31},
  {RECORD: 1, LIBREFERENCE: "RES", CURRENTPARTID: 1, PARTCOUNT: 2, "LOCATION.X": 100, "LOCATION.Y": 500, UNIQUEID: "PARTAAAA"},
  {RECORD: 2, OWNERINDEX: 1, OWNERPARTID: 1, PINCONGLOMERATE: 2, PINLENGTH: 20, "LOCATION.X": 90, "LOCATION.Y": 500, NAME: "1", DESIGNATOR: "1"},
  {RECORD: 34, OWNERINDEX: 1, OWNERPARTID: -1, TEXT: "R1", "LOCATION.X": 100, "LOCATION.Y": 520},
  {RECORD: 41, OWNERINDEX: 1, OWNERPARTID: -1, NAME: "Datasheet URL", TEXT: DATASHEET, ISHIDDEN: "T", "LOCATION.X": 100, "LOCATION.Y": 480},
  {RECORD: 41, OWNERINDEX: 1, OWNERPARTID: -1, NAME: "ComponentLink1URL", TEXT: VENDOR, ISHIDDEN: "T", "LOCATION.X": 100, "LOCATION.Y": 480},
  {RECORD: 41, OWNERINDEX: 1, OWNERPARTID: -1, NAME: "ComponentLink1Description", TEXT: "Vendor page", ISHIDDEN: "T", "LOCATION.X": 100, "LOCATION.Y": 480},
  {RECORD: 41, OWNERINDEX: 1, OWNERPARTID: -1, NAME: "HelpURL", TEXT: HELP, ISHIDDEN: "T", "LOCATION.X": 100, "LOCATION.Y": 480},
  {RECORD: 4, TEXT: "Power notes", URL: TEXT_URL, "LOCATION.X": 300, "LOCATION.Y": 300, UNIQUEID: "TEXTAAAA"},
  {RECORD: 4, TEXT: "Plain text", "LOCATION.X": 300, "LOCATION.Y": 200, UNIQUEID: "TEXTBBBB"},
  // A Hyperlink object (record 226), as KiCad's Altium reader knows it: a text with a URL, the URL shown
  // when it has no text. Neither the public corpus nor the user designs checked contain one.
  {RECORD: 226, TEXT: "Hyperlink object", URL: HYPER_URL, "LOCATION.X": 300, "LOCATION.Y": 100, FONTID: 1, UNIQUEID: "TEXTCCCC"},
  {RECORD: 226, URL: BARE_URL, "LOCATION.X": 300, "LOCATION.Y": 50, FONTID: 1, UNIQUEID: "TEXTDDDD"}
].map(line).join("\r\n") + "\r\n";
// Names keep the source's spelling, so a link without a ComponentLink title reads as Altium shows it.
const LINKS = [{name: "ComponentLink1URL", url: VENDOR, title: "Vendor page"}, {name: "HelpURL", url: HELP, title: "Help"},
  {name: "Datasheet URL", url: DATASHEET, title: "Datasheet URL"}];
function check(p, label) {
  const doc = p.documents.find(d => d.kind === "schematic" && d.items.some(i => i.ref === "R1")), defs = new Map(p.library.map(d => [d.id, d]));
  const part = doc.items.find(i => i.kind === "part"), texts = doc.items.filter(i => i.kind === "label");
  assert.deepEqual(texts.map(t => [t.text, t.url ?? null]), [["Power notes", TEXT_URL], ["Plain text", null], ["Hyperlink object", HYPER_URL], [BARE_URL, BARE_URL]],
    label + ": the hyperlinked texts keep their URLs");
  const links = linksOf(part.parameters, defs.get(part.def).parameters);
  assert.deepEqual(links, LINKS, label + ": the part's links");
  return {doc, part};
}
const first = open([{name: "Links.SchDoc", bytes: enc.encode(sch)}]);
check(first, "import");

// ---------------------------------------------------------------- 2. the Links view
assert.deepEqual(linksOf({"ComponentLink2URL": "https://a.example/x", "ComponentLink2Description": "Second", "componentlink 3 url": "https://b.example/"}, null),
  [{name: "ComponentLink2URL", url: "https://a.example/x", title: "Second"}, {name: "componentlink 3 url", url: "https://b.example/", title: "Link 3"}]);
assert.deepEqual(linksOf([{name: "Datasheet", value: "https://c.example/d.pdf"}], {Datasheet: "https://c.example/d.pdf", Octopart: "https://d.example/r"}),
  [{name: "Datasheet", url: "https://c.example/d.pdf", title: "Datasheet"}, {name: "Octopart", url: "https://d.example/r", title: "Octopart"}], "one row per address");
assert.deepEqual(linksOf({Zeta: "https://z.example/", HelpURL: "https://h.example/", ComponentLink2URL: "https://2.example/", Alpha: "https://a.example/", ComponentLink1URL: "https://1.example/"}).map(l => l.title),
  ["Link 1", "Link 2", "Help", "Alpha", "Zeta"], "Altium's Links, Help, then by name");
for (const bad of ["javascript:alert(1)", "file:///etc/passwd", "https://user:pw@example.com/", "ftp://example.com/", "example.com", "", "x".repeat(3000)])
  assert.equal(webURL(bad), "", "not opened: " + bad.slice(0, 30));
assert.equal(webURL(" https://example.com/a b "), "https://example.com/a%20b");

// ---------------------------------------------------------------- 3. save and reopen; Altium round trip
check(A.validate(nativeRoundTrip(first)), "native save and reopen");
const out = AtriumAltiumExport.exportProject(first);
const sheet = out.files.find(f => /\.SchDoc$/i.test(f.name)), content = new TextDecoder().decode(sheet.bytes);
assert.match(content, /\|RECORD=4\|[^\r\n]*\|TEXT=Power notes\|URL=https:\/\/example\.com\/notes\/power/, "Altium text record carries URL");
assert.match(content, /\|TEXT=Hyperlink object\|URL=https:\/\/example\.org\/hyper/, "a Hyperlink object exports as a text with its URL");
assert.match(content, /\|NAME=ComponentLink1URL(\||\r)/, "ComponentLink1URL in Altium's spelling");
assert.match(content, /\|NAME=ComponentLink1Description(\||\r)/);
assert.match(content, /\|NAME=HelpURL(\||\r)/);
check(open(out.files.filter(f => /\.SchDoc$/i.test(f.name)).map(f => ({name: f.name, bytes: f.bytes}))), "Altium export and re-import");

// ---------------------------------------------------------------- 4. PcbDoc component parameters
{
  const source = path.join(__dirname, "../fixtures/altium/pidp11-io-expander/PiDP11IOExpander.PcbDoc");
  const c = CFB.read(fs.readFileSync(source), {type: "buffer"});
  const at = c.FullPaths.findIndex(n => /\/primitiveparameters\/data$/i.test(n));
  assert.ok(at >= 0, "the fixture has PrimitiveParameters");
  const framed = s => { const data = Buffer.from(s + "\0", "latin1"), head = Buffer.alloc(4); head.writeUInt32LE(data.length); return Buffer.concat([head, data]); };
  const rows = [
    "|PRIMITIVEID=AAAA|ID=Component#0|APPURTENANCE=System|VARIANTGUID=System|COUNT=1", "|NAME=Component.VaultGUID|VALUE={0000}|ISIMPORTED=TRUE",
    "|PRIMITIVEID=AAAA|ID=Component#0|VARIANTGUID={1111}|COUNT=3", "|NAME=Datasheet URL|VALUE=" + DATASHEET + "|ISIMPORTED=TRUE",
    "|NAME=ComponentLink1URL|VALUE=" + VENDOR + "|ISIMPORTED=TRUE", "|UNICODE=EXISTS|NAME=Temperature|VALUE=125?C|ISIMPORTED=TRUE|UNICODE__VALUE=49,50,53,176,67|UNICODE=EXISTS",
    "|PRIMITIVEID=BBBB|ID=Component#1|APPURTENANCE=Footprint|VARIANTGUID=Footprint|COUNT=1", "|NAME=Footprint only|VALUE=https://example.com/fp|ISIMPORTED=TRUE"];
  const e = c.FileIndex[at]; e.content = Buffer.concat(rows.map(framed)); e.size = e.content.length;
  const p = open([{name: "Links.PcbDoc", bytes: new Uint8Array(CFB.write(c, {type: "buffer"}))}]);
  const board = imported(p).find(d => d.kind === "pcb"), defs = new Map(p.library.map(d => [d.id, d]));
  const parts = board.items.filter(i => i.kind === "part").sort((a, b) => Number(a.sourceRecord.split("#")[1]) - Number(b.sourceRecord.split("#")[1]));
  assert.deepEqual(defs.get(parts[0].def).parameters, {"Datasheet URL": DATASHEET, ComponentLink1URL: VENDOR, Temperature: "125°C"}, "the component's own parameters");
  assert.equal(defs.get(parts[1].def).parameters, undefined, "Footprint rows are not the component's");
  assert.equal(parts[0].parameters, undefined, "kept on the footprint, so the ECO sees no placement edit");
  assert.deepEqual(linksOf(parts[0].parameters, defs.get(parts[0].def).parameters).map(l => l.title), ["Link 1", "Datasheet URL"]);
}
console.log("altium-links: ok");
