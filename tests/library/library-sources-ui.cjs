"use strict";
// Library panel with folder libraries (app/library/library-sources-ui.js) in the LinkeDOM editor: a folder library
// next to the project library in the source list, search across it, a stub row read on selection and
// added to the project with its provenance, the folder detail (Rescan, Remove folder), the import review
// for KiCad files (pairing table, Add), and Get KiCad libraries… (an explicit download with no credentials,
// referrer or custom headers, kept outside the project; Esc closes it).
const assert = require("node:assert/strict"), fs = require("node:fs");
const {setup} = require("../integration/integration.cjs");
const dir = __dirname + "/../fixtures/kicad/";
const FILES = ["Lab_Amp.kicad_sym", "Lab_Package.pretty/SOIC-8_Test.kicad_mod", "Lab_Package.pretty/R_0603_Test.kicad_mod", "Lab_Package.pretty/SOT-223_Test.kicad_mod",
  "Lab_Package.pretty/TestPad_Test.kicad_mod", "Legacy.pretty/DIP-4_Legacy.kicad_mod", "Lab_Logic.kicad_symdir/BUF_Test.kicad_sym", "Lab_Logic.kicad_symdir/BUF_Test_Alt.kicad_sym"];
const text = p => fs.readFileSync(dir + p, "utf8");

async function run() {
  const {window, document} = await setup();
  const step = () => new Promise(r => setTimeout(r, 8));
  async function until(fn, what, ms = 4000) { const end = Date.now() + ms; while (!fn()) { if (Date.now() > end) assert.fail(what); await step(); } }
  const S = AtriumLibrarySources, UI = AtriumLibrarySourcesUI, host = AtriumNavHost;
  const project = () => host.project();
  // A registered folder (a memory provider stands in for the folder the user chose).
  const map = new Map(FILES.map(p => [p, {data: text(p), mtime: 1}])), provider = S.providers.memory(map);
  const rec = {id: "f-ui", name: "Lab KiCad", kind: "memory", root: "Lab KiCad"};
  S.addFolder(rec);
  const scanned = await S.scan(rec, {provider});
  assert.equal(scanned.library.defs.length, 7);
  host.act("library");
  await until(() => document.querySelector(".panel-library select.lib-source"), "Library panel");
  const panel = document.querySelector(".panel-library"), sel = panel.querySelector("select.lib-source");
  await until(() => [...sel.querySelectorAll("option")].some(o => /Lab KiCad \(7\) · folder/.test(o.textContent)), "the folder library in the source list");
  assert.ok([...sel.querySelectorAll("option")].some(o => o.textContent === "Add library folder…"));
  assert.ok([...sel.querySelectorAll("option")].some(o => o.textContent === "Get KiCad libraries…"));
  assert.ok([...sel.querySelectorAll("option")].some(o => o.textContent === "Import library files…"));
  sel.value = scanned.library.id; sel.dispatchEvent(new window.Event("change", {bubbles: true}));
  // The folder detail before a selection: what was scanned, Rescan and Remove folder (outlined buttons).
  await until(() => [...panel.querySelectorAll(".lib-folder button")].length === 2, "folder actions");
  const folderButtons = [...panel.querySelectorAll(".lib-folder button")];
  assert.deepEqual(folderButtons.map(b => [b.textContent, b.type]), [["Rescan", "button"], ["Remove folder", "button"]]);
  for (const button of folderButtons) {
    assert.ok(button.matches(".lib-mini.ui-button[data-size=sm]"), button.textContent + " uses the compact shared button style");
  }
  assert.match(panel.querySelector(".lib-folder").textContent, /5 symbols with footprints/);
  // Search across the folder; select a stub row: its files are read, then it can join the project.
  const search = panel.querySelector('input[type="search"]');
  search.value = "OPA_DUAL"; search.dispatchEvent(new window.Event("input", {bubbles: true}));
  const rowOf = n => [...panel.querySelectorAll(".lib-row")].find(r => r.querySelector("strong")?.textContent === n);
  await until(() => rowOf("OPA_DUAL"), "the OPA_DUAL row");
  assert.ok(!rowOf("R_Test"), "search filters the folder's rows");
  rowOf("OPA_DUAL").click();
  const add = () => [...panel.querySelectorAll(".lib-detail-actions button")].find(b => b.textContent === "Add to project");
  await until(add, "Add to project after the row is read");
  assert.ok(!scanned.library.defs.find(d => d.name === "OPA_DUAL").stub, "the row is now the complete definition");
  const before = project().library.length;
  add().click();
  await until(() => project().library.length === before + 1, "added to the project");
  const def = project().library.at(-1);
  assert.equal(def.name, "OPA_DUAL"); assert.equal(def.libraryRef.library, scanned.library.id); assert.equal(def.footprint.pads.length, 8);
  assert.equal(def.source.kind, "kicad-symbol");
  assert.equal(map.size, FILES.length, "nothing was written into the folder");
  console.log("PASS Library panel: a folder library beside the project, search, a row read on selection and added with its provenance");

  // Import library files…: the pairing review; only ticked components join the project, as drafts.
  const ctx = AtriumLibrary.mountPanel().ctx;
  const files = ["Lab_Amp.kicad_sym", "Lab_Package.pretty/SOT-223_Test.kicad_mod", "Lab_Package.pretty/R_0603_Test.kicad_mod"].map(p => ({name: p.split("/").pop(), path: p, bytes: new TextEncoder().encode(text(p))}));
  const dialog = await UI.importFiles(ctx, {files});
  assert.ok(dialog.open);
  const rows = [...dialog.querySelectorAll("tbody tr")];
  assert.equal(rows.length, 3, "OPA_DUAL from the same file is already in the project");
  assert.match(dialog.textContent, /already in the project from the same files/);
  assert.match(dialog.textContent, /pads without pins 4/, "the SOT-223 tab is reported");
  const box = rows.find(r => r.textContent.includes("OPA_DUAL_DFN")).querySelector("input[type=checkbox]");
  box.checked = false; box.dispatchEvent(new window.Event("change"));
  const addBtn = [...dialog.querySelectorAll(".lib-actions button")].find(b => /^Add /.test(b.textContent));
  assert.equal(addBtn.textContent, "Add 2 components");
  assert.ok(addBtn.matches('button[type="button"].ui-button[data-variant="primary"]'), "Add remains the primary shared button");
  const n0 = project().library.length;
  addBtn.click();
  assert.equal(project().library.length, n0 + 2); assert.ok(!dialog.open);
  const chosen = new Set(project().library.slice(-2).map(d => d.id));
  assert.ok(project().library.slice(-2).every(d => d.state === "draft" && d.source === undefined));
  const group = () => globalThis.AtriumImportReports?.provenance().find(g => g.files?.some(f => f.name === "Lab_Amp.kicad_sym"));
  await until(group,"adopted library provenance");
  assert.ok(group().fields.some(r => r.values.source?.sha256));
  assert.ok(group().fields.every(r => chosen.has(r.id)));
  assert.deepEqual(new Set(group().files.flatMap(f => f.library)),chosen);
  console.log("PASS Import library files…: pairing table with mismatches, unticked rows left out, drafts added in one step");

  // Get KiCad libraries…: only on request; the request carries no credentials, referrer or headers.
  const calls = [];
  const licence = "KiCad test fixture licence notice";
  const zipOf = (prefix, paths) => AtriumZip.create(
    [["LICENSE.md", licence], ...paths.map(p => [p, text(p)])].map(([p, data]) => ({name: prefix + "-master-0abc/" + p, data})));
  const archives = {symbols: zipOf("kicad-symbols", ["Lab_Amp.kicad_sym"]), footprints: zipOf("kicad-footprints", FILES.filter(p => p.endsWith(".kicad_mod")))};
  globalThis.fetch = async (url, init) => {
    calls.push({url, init});
    const bytes = /kicad-symbols/.test(url) ? archives.symbols : archives.footprints;
    return {ok: true, status: 200, headers: {get: k => k === "content-length" ? String(bytes.length) : null}, body: null, arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)};
  };
  const esc = UI.getKiCad(ctx);
  assert.ok(esc.open); assert.equal(calls.length, 0, "nothing is downloaded until Download");
  esc.dispatchEvent(new window.Event("cancel", {cancelable: true}));
  assert.ok(!esc.open, "Esc closes the dialog");
  const d = UI.getKiCad(ctx);
  const go = [...d.querySelectorAll(".lib-actions button")].find(b => b.textContent === "Download");
  assert.match(d.textContent, /CC-BY-SA 4.0 with the KiCad libraries exception/);
  go.click();
  await until(() => !d.open && S.library("kicad-official")?.stats, "download and index");
  assert.equal(calls.length, 2);
  for (const c of calls) {
    assert.match(c.url, /^https:\/\/gitlab\.com\/api\/v4\/projects\/kicad%2Flibraries%2Fkicad-(symbols|footprints)\/repository\/archive\.zip\?sha=master$/);
    assert.equal(c.init.credentials, "omit"); assert.equal(c.init.referrerPolicy, "no-referrer"); assert.equal(c.init.headers, undefined);
  }
  const kicad = S.library("kicad-official");
  assert.ok(kicad && kicad.defs.length === 6, "the downloaded libraries are a folder library (" + kicad?.defs.length + ")");
  assert.ok(S.folders().some(f => f.id === "kicad-official" && f.kind === "zip"));
  assert.equal(kicad.attribution.symbols.licenceText, licence);
  const downloaded = await S.load(kicad, kicad.defs.find(d => d.name === "OPA_DUAL").id);
  assert.equal(downloaded.source.attribution.credit, "KiCad library contributors");
  assert.equal(downloaded.source.attribution.licenceText, licence);
  assert.match(downloaded.source.footprint.attribution.sourceUrl, /kicad-footprints/);
  const shared = AtriumLibrary.readLibraryFile(AtriumLibrary.libraryFile({defs: [downloaded]}).text);
  assert.deepEqual(shared.defs[0].source.attribution, downloaded.source.attribution);
  assert.equal(d.querySelector("a").href, UI.KICAD.licenceUrl);
  // Remove folder takes it out of the panel; its files are untouched.
  await S.removeFolder("f-ui");
  assert.ok(!S.folders().some(f => f.id === "f-ui"));
  console.log("PASS Get KiCad libraries…: explicit download (no credentials, referrer or headers), Esc closes, indexed as a folder library; Remove folder");
}
globalThis.__testDone = run().then(() => process.exit(0), e => { console.error(e); process.exit(1); });
