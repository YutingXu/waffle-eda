"use strict";
// The library-management dialogs in the real editor (LinkeDOM, integration.cjs): Place › Placeholder…,
// Resolve…, the visual library update review and Library › Check…. Each opens, renders and applies one
// undo step without errors.
const assert = require("node:assert/strict");
const {setup} = require("../integration/integration.cjs");

async function run() {
  const {document} = await setup();
  const H = AtriumNavHost, GP = AtriumGenericParts, SW = AtriumSymbolWizard;
  const open = label => { const d = [...document.querySelectorAll("dialog[open]")].find(x => (x.getAttribute("aria-label") || "").startsWith(label)); assert.ok(d, "dialog " + label); return d; };
  const button = (d, text) => { const b = [...d.querySelectorAll("button")].find(x => x.textContent.trim() === text); assert.ok(b, "button " + text + " in " + d.getAttribute("aria-label")); return b; };
  const tick = () => new Promise(r => setTimeout(r, 10));

  // Place › Placeholder…: the dialog builds every family's form and preview.
  H.act("generic-placeholder"); await tick();
  const place = open("Place Placeholder");
  for (const tile of [...place.querySelectorAll(".gp-tile")]) { tile.click(); await tick(); assert.ok(!/Unknown|Cannot/.test(place.querySelector(".gp-status").textContent), tile.textContent + ": " + place.querySelector(".gp-status").textContent); }
  button(place, "Cancel").click();

  // A placeholder on the sheet, a real dual op-amp in the library, then Resolve….
  const p = H.project(), sch = p.documents.find(d => d.kind === "schematic");
  let part;
  H.edit(() => { part = GP.place(p, sch, [254, 254], {family: "opamp", params: {units: 2}, package: "SOIC-8"}).part; part.ref = "U77"; }, "Place placeholder");
  const table = SW.detect("Pin\tName\tType\tGate\n1\tOUTA\toutput\tA\n2\t-INA\tinput\tA\n3\t+INA\tinput\tA\n4\tV-\tpower\t\n5\t+INB\tinput\tB\n6\t-INB\tinput\tB\n7\tOUTB\toutput\tB\n8\tV+\tpower\t");
  const real = {...SW.build(SW.pinsOf(table).pins, {layout: "gates", name: "OPA2333", prefix: "U"}).def, id: "opa2333-ui", name: "OPA2333"};
  H.edit(() => { p.library.push(real); }, "Add part");
  AtriumPlaceholderUI.resolveDialog(H, part); await tick();
  const res = open("Resolve U77");
  const row = [...res.querySelectorAll(".ph-row")].find(r => /OPA2333/.test(r.textContent));
  assert.ok(row, "candidates listed: " + [...res.querySelectorAll(".ph-row")].map(r => r.textContent).join(" | "));
  row.click(); await tick();
  assert.ok(res.querySelector(".ph-map line"), "matched pins joined by lines");
  const apply = button(res, "Apply");
  assert.equal(apply.disabled, false);
  apply.click(); await tick();
  const live = H.project().documents.flatMap(d => d.items).find(i => i.ref === "U77");
  assert.equal(live.def, "opa2333-ui"); assert.equal(live.resolvedFrom.family, "opamp");

  // Visual update review: a library copy whose pad moved.
  const q = H.project(), def = q.library.find(d => d.id === live.def);
  const lib = {id: "lab-ui", name: "Lab", defs: [{...JSON.parse(JSON.stringify(def)), id: "lab-opa", rev: 2, value: "OPA2333A"}]};
  const ctx = {currentProject: () => H.project(), edit: (fn, label) => H.edit(fn, label), info() {}};
  AtriumLibraryDiff.review(ctx, [{def, lib, src: lib.defs[0]}]); await tick();
  const rev = open("Update OPA2333 from Lab");
  assert.ok(rev.querySelector("svg.ld-svg"), "the overlay is drawn");
  assert.match(rev.textContent, /U77/);
  button(rev, "Update all designators").click(); await tick();
  assert.equal(H.project().library.find(d => d.id === def.id).value, "OPA2333A");

  // Library › Check….
  AtriumLibrary.checkLibrary(ctx); await tick();
  const chk = open("Check project library");
  assert.match(chk.textContent, /error\(s\)/);
  button(chk, "Close").click();
  console.log("PASS library dialogs in the editor: Place Placeholder, Resolve, the visual update review and Check");
}
run().then(() => process.exit(0), e => { console.error(e); process.exit(1); });
