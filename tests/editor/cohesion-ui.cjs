"use strict";
// Schematic ↔ PCB cohesion in the real editor DOM:
// one word per concept (Component, Comment, Rotation), the same Properties behaviour in both
// editors (Locked with the same guard, multi-object editing with <varies>, the Parameters grid),
// Tab while placing docks the placement form in the Properties pane, and click-only insight cards.
// Node: node tests/editor/cohesion-ui.cjs (LinkeDOM, as tests/integration/integration.cjs).
const assert = require("node:assert/strict");
const {setup} = require("../integration/integration.cjs");

async function run() {
  const {window, document} = await setup();
  const step = () => new Promise(done => setTimeout(done, 8));
  async function until(fn, what, timeout = 3500) { const end = Date.now() + timeout; while (!fn()) { if (Date.now() > end) assert.fail(what + "; status = " + document.getElementById("status").textContent); await step(); } }
  const H = globalThis.AtriumNavHost, $ = s => document.querySelector(s), inspector = () => $("#inspector");
  const label = text => inspector().querySelector('[aria-label="' + text + '"]');
  const change = (input, value) => { input.value = value; input.dispatchEvent(new window.Event("change", {bubbles: true})); };
  const sheet = () => H.project().documents.find(d => d.kind === "schematic"), board = () => H.project().documents.find(d => d.kind === "pcb");
  const parts = d => d.items.filter(i => i.kind === "part");
  let passed = 0;
  const test = async (name, fn) => { await fn(); passed++; console.log("ok - " + name); };

  await test("Place › Component is one menu item in both editors, and the context menu names it the same", async () => {
    const items = [...document.querySelectorAll('[data-menu="place"] [data-action="library"]')];
    assert.equal(items.length, 1); assert.equal(items[0].textContent, "Component"); assert.equal(items[0].dataset.scope, undefined);
    assert.ok(!document.querySelector('[data-menu="place"]').textContent.includes("Part…"));
    for (const kind of ["schematic", "pcb"]) {
      const place = globalThis.AtriumContextMenu.labels(kind).filter(e => e.type === "canvas" && e.action === "library");
      assert.deepEqual(place.map(e => e.label), ["Component"], kind + " context menu");
    }
    const button = $('#tools [data-action="library"]');
    assert.equal(button.getAttribute("aria-haspopup"), "menu");
    const bar = globalThis.AtriumActiveBarMenu.GROUPS[button.dataset.toolGroup];
    for (const a of ["sch-power", "sch-port", "sch-text"]) assert.ok(bar.some(([action, , scope]) => action === a && scope === "schematic"), a + " on the schematic Active Bar");
  });

  H.selectDocument(sheet().id);
  const [a, b] = parts(sheet());
  await test("a schematic component shows Comment, Rotation (°), Show comment and Locked, as on the board", async () => {
    H.select([a.id]);
    await until(() => label("Locked"), "Locked on a schematic component");
    assert.equal(label("Comment").value, a.value || "");
    assert.ok(label("Rotation (°)"), "Rotation (°)"); assert.ok(label("Show comment")); assert.equal(label("Value"), null); assert.equal(label("Show value"), null);
  });

  await test("locking a schematic component uses the board's guard: Delete asks first", async () => {
    H.select([a.id]); await until(() => label("Locked"), "Locked");
    label("Locked").checked = true; label("Locked").dispatchEvent(new window.Event("change", {bubbles: true}));
    assert.equal(sheet().items.find(i => i.id === a.id).locked, true);
    H.select([a.id]);
    $('[data-action="delete"]').click();
    const dlg = $("dialog.pcb-edit-lock[open]"); assert.ok(dlg, "the Locked objects dialog");
    assert.match(dlg.textContent, /Delete anyway/);
    dlg.close();
    assert.ok(sheet().items.some(i => i.id === a.id), "Cancel keeps the locked component");
    H.act("undo"); assert.notEqual(sheet().items.find(i => i.id === a.id).locked, true);
  });

  await test("a schematic multi-selection edits shared fields with <varies>, in one undo step", async () => {
    H.select([a.id, b.id]);
    await until(() => [...inspector().querySelectorAll("h3")].some(h => h.textContent.startsWith("Components · 2")), "Components · 2 section");
    const comment = label("Comment");
    if (a.value !== b.value) { assert.equal(comment.value, ""); assert.equal(comment.placeholder, "<varies>"); }
    assert.ok(label("Rotation (°)")); assert.ok(label("Locked")); assert.equal(label("Side"), null, "no board side on a sheet");
    const before = [a.value, b.value];
    change(comment, "SHARED");
    assert.deepEqual(parts(sheet()).filter(p => p.id === a.id || p.id === b.id).map(p => p.value), ["SHARED", "SHARED"]);
    H.act("undo");
    assert.deepEqual([a.id, b.id].map(id => sheet().items.find(i => i.id === id).value), before);
    // Mixed kinds: chips narrow the selection, as on the board.
    const wire = sheet().items.find(i => i.kind === "wire");
    if (wire) {
      H.select([a.id, wire.id]);
      await until(() => inspector().querySelector(".pcb-edit-chips"), "kind chips");
      assert.deepEqual([...inspector().querySelectorAll(".pcb-edit-chips .pcb-edit-chip")].map(c => c.textContent).sort(), ["Components (1)", "Wires (1)"]);
    }
  });

  await test("a board component shows the schematic's Parameters grid read-only, with Edit on Sheet", async () => {
    H.selectDocument(board().id);
    const p = parts(board())[0]; H.select([p.id]);
    await until(() => [...inspector().querySelectorAll("summary")].some(s => s.textContent.startsWith("Parameters")), "Parameters disclosure");
    const d = [...inspector().querySelectorAll("details")].find(x => x.querySelector("summary").textContent.startsWith("Parameters"));
    d.open = true; d.ontoggle?.(); d.dispatchEvent(new window.Event("toggle"));
    const editOnSheet = () => [...d.querySelectorAll("button")].find(button => button.textContent === "Edit on Sheet ↗");
    await until(editOnSheet, "Parameters body with Edit on Sheet");
    const grid = d.querySelector(".sch-param-grid");
    if (grid) for (const input of grid.querySelectorAll("input")) assert.ok(input.readOnly || input.disabled, "read-only " + input.getAttribute("aria-label"));
    assert.equal(editOnSheet().type, "button");
    assert.ok(label("Comment") && label("Rotation (°)") && label("Show comment"), "the same field names on the board");
  });

  await test("Tab while placing on a sheet docks the placement form at the top of Properties", async () => {
    H.selectDocument(sheet().id);
    const def = H.project().library.find(d => d.symbol);
    globalThis.AtriumSchPlace.beginPart(def);
    const ctx = {tool: () => "place", pending: () => def, project: () => H.project(), doc: () => H.doc(), draw() {}, info() {}, canvas: $("#canvas")};
    assert.equal(globalThis.AtriumSchPlace.popover(ctx), true);
    const form = inspector().firstElementChild;
    assert.ok(form.classList.contains("sp-docked"), "docked in #inspector");
    assert.equal(form.getAttribute("role"), "region");
    assert.ok(form.querySelector('[aria-label="Comment"]'));
    assert.equal(globalThis.AtriumSchPlace.isOpen(), true);
    H.select([]); // a Properties refresh replaces it
    assert.equal(globalThis.AtriumSchPlace.isOpen(), false);
    globalThis.AtriumSchPlace.closePopover();
  });

  await test("one List panel: SCH List on a sheet, PCB List on a board, with domain columns", async () => {
    H.selectDocument(sheet().id);
    globalThis.AtriumPCBList.open({scope: "all"});
    const panel = $(".pl-panel"), heads = () => [...panel.querySelectorAll("thead th")].map(th => th.textContent.replace(/ \(.*\)$/, ""));
    assert.equal(panel.querySelector("h2").textContent, "SCH List");
    assert.ok([...panel.querySelectorAll('[aria-label="Object kind"] option')].some(o => o.textContent === "Wires"));
    assert.ok(heads().includes("Comment") && !heads().includes("Layer") && !heads().includes("Net"), heads().join(","));
    assert.ok(panel.querySelectorAll("tbody tr").length > 0 || globalThis.AtriumPCBList.rows(H.doc(), H.defs()).length > 0);
    H.selectDocument(board().id);
    await until(() => panel.querySelector("h2").textContent === "PCB List", "PCB List title on the board");
    await until(() => heads().includes("Layer"), "board columns");
    globalThis.AtriumPCBList.toggle(false);
    assert.equal($('#sub-window-panels [data-action="pcb-list"]').dataset.scope, undefined, "Window › Panels › List serves both editors");
  });

  await test("Design Insights cards open on click only by default (no hover pop-ups)", async () => {
    assert.equal(globalThis.AtriumInsightsUI.expandOnHover(), false);
    globalThis.AtriumPref?.set?.("insights.expand", "hover");
    assert.equal(globalThis.AtriumInsightsUI.expandOnHover(), globalThis.AtriumPref ? true : false);
    globalThis.AtriumPref?.set?.("insights.expand", "click");
  });

  console.log("PASS cohesion-ui: " + passed + " checks");
  process.exit(0);
}
run().catch(e => { console.error(e); process.exit(1); });
