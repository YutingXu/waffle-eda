"use strict";
// Document tab context menu (app/project/doc-tabs.js, context-menu.js explorer) in the real editor DOM (LinkeDOM, as
// tests/integration/integration.cjs): Close, Close Others, Close Documents to the Right / Left, Close All, Close All <type>
// Documents and Close Saved Documents; one unsaved-changes prompt per batch (Save All / Save Selected, Don't
// Save, Cancel); split panes (Left and Right count in the strip that was clicked); the keyboard Close Document;
// the web view's own menu never appears; and Preferences › Schematic › General › Single "\" negation
// redrawing the open sheets. Node: node tests/editor/doc-tabs-ui.cjs
const assert = require("node:assert/strict");
const {setup} = require("../integration/integration.cjs");

async function run() {
  const {window, document, folders, onCanvasCall} = await setup({demo:false});
  globalThis.getSelection ??= () => ({toString: () => "", containsNode: () => false}); // LinkeDOM has no selection
  const A = globalThis.Atrium, H = globalThis.AtriumNavHost, L = globalThis.AtriumLazy;
  const step = () => new Promise(done => setTimeout(done, 8));
  async function until(fn, what, timeout = 3000) { const end = Date.now() + timeout; while (!fn()) { if (Date.now() > end) assert.fail(what); await step(); } }
  const $ = s => document.querySelector(s), $$ = s => [...document.querySelectorAll(s)];
  let passed = 0;
  const test = async (name, fn) => { await fn(); passed++; console.log("ok - " + name); };
  const T = await L.need("AtriumDocTabs"), K = await L.need("AtriumVSKeys");
  await L.need("AtriumContextMenu");

  // Five documents: four sheets and the board, saved (clean).
  const p = AtriumParts.example();
  for (const n of ["Power", "MCU", "Connectors"]) { const s = A.sheet("schematic", n); s.items.push({id: A.id(), kind: "netlabel", x: 0, y: 0, text: n.toUpperCase()}); p.documents.push(s); }
  await folders.openModel(p);
  for (const d of p.documents) await H.selectDocument(d.id);
  await step(); T.capture();
  const docs = () => H.project().documents, byName = n => docs().find(d => d.name === n), name = id => H.docById(id)?.name;
  const visible = () => $$("#document-tabs [data-tab]").filter(t => !t.hidden).map(t => name(t.dataset.tab));
  const ALL = docs().map(d => d.name);
  const originalTabs = $$("#document-tabs [data-tab]").map(t=>t.dataset.tab);
  assert.equal(originalTabs.length,ALL.length,"Every opened document has a tab: "+JSON.stringify(visible()));
  const reset = () => {
    const active=H.currentId();
    H.folderProject().setView({openTabs:originalTabs.slice()});
    H.selectDocument(originalTabs.find(id=>id!==active));H.selectDocument(active);
    for (const id of originalTabs) K.show(id);
  };
  const tab = (n, strip = "#document-tabs") => { const t = $(strip + ' [data-tab="' + byName(n).id + '"]'); assert.ok(t, "tab " + n); return t; };
  function rightClick(node) {
    const e = new window.Event("contextmenu", {bubbles: true, cancelable: true});
    Object.assign(e, {clientX: 40, clientY: 20, button: 2}); node.dispatchEvent(e); return e;
  }
  const menu = () => $(".nav-menu:not(.nav-submenu)");
  const labels = () => [...menu().querySelectorAll(":scope > .nav-menu-item, :scope > .nav-sub > .nav-menu-item")].map(b => b.querySelector("span")?.textContent.trim());
  async function choose(node, label) {
    rightClick(node);
    await until(() => menu(), "the tab menu opens");
    const b = [...menu().querySelectorAll(".nav-menu-item")].find(x => x.querySelector("span")?.textContent === label);
    assert.ok(b, label + " in " + labels().join(" | ")); assert.equal(b.disabled, false, label + " is enabled");
    b.click(); await step(); await step();
  }
  const dialog = () => $("dialog.doc-tabs-dialog[open]");
  const press = async label => { const b = [...dialog().querySelectorAll(".work-actions button")].find(x => x.textContent === label); assert.ok(b, label); b.click(); await step(); await step(); };

  await test("right-clicking a tab opens Waffle's menu with the Close commands, then the document entries; the web view's menu never shows", async () => {
    H.selectDocument(byName("Power").id); await step();
    const e = rightClick(tab("Power"));
    assert.equal(e.defaultPrevented, true, "the native menu (Reload …) is suppressed");
    await until(() => menu(), "menu");
    const l = labels();
    assert.deepEqual(l.slice(0, 7), ["Close", "Close Others", "Close Documents to the Right", "Close Documents to the Left", "Close All",
      "Close All Schematic Documents", "Close Saved Documents"]);
    for (const x of ["Open Document", "Rename Document…", "Save Project", "Compare With…", "Validate Project (ERC)"]) assert.ok(l.includes(x), x + " is kept");
    assert.ok(!l.some(x => /reload|inspect/i.test(x)));
    menu().dispatchEvent(Object.assign(new window.Event("keydown", {bubbles: true}), {key: "Escape"}));
    globalThis.AtriumContextMenu.close();
    rightClick(tab("Sensor board"));
    await until(() => menu(), "board menu");
    assert.ok(labels().includes("Close All PCB Documents"));
    const first = [...menu().querySelectorAll(".nav-menu-item")].find(b => b.textContent.startsWith("Close Documents to the Left"));
    assert.equal(first.disabled, visible()[0] === "Sensor board", "Left is disabled on the first tab");
    globalThis.AtriumContextMenu.close();
  });

  await test("pick: each command's documents, in tab order", async () => {
    const ids = ["a", "b", "c", "d", "e"], kind = x => x === "c" || x === "e" ? "pcb" : "schematic";
    assert.deepEqual(T.pick("close", "c", ids), ["c"]);
    assert.deepEqual(T.pick("others", "c", ids), ["a", "b", "d", "e"]);
    assert.deepEqual(T.pick("right", "c", ids), ["d", "e"]);
    assert.deepEqual(T.pick("left", "c", ids), ["a", "b"]);
    assert.deepEqual(T.pick("all", "c", ids), ids);
    assert.deepEqual(T.pick("kind", "c", ids, kind), ["c", "e"]);
    assert.deepEqual(T.pick("saved", "c", ids, kind, x => x !== "b"), ["a", "c", "d", "e"]);
    assert.deepEqual(T.pick("right", "e", ids), []); assert.deepEqual(T.pick("left", "a", ids), []);
  });

  await test("each command on a saved project hides the right tabs; documents stay in the project", async () => {
    const order = visible(), at = order.indexOf("Power");
    H.selectDocument(byName("Power").id); await step();
    await choose(tab("Power"), "Close"); assert.ok(!visible().includes("Power")); assert.equal(docs().length, ALL.length); reset();
    await choose(tab("Power"), "Close Others"); assert.deepEqual(visible(), ["Power"]); reset();
    await choose(tab("Power"), "Close Documents to the Right"); assert.deepEqual(visible(), order.slice(0, at + 1)); reset();
    await choose(tab("Power"), "Close Documents to the Left"); assert.deepEqual(visible(), order.slice(at)); reset();
    await choose(tab("Power"), "Close All Schematic Documents"); assert.deepEqual(visible(), ["Sensor board"]); reset();
    await choose(tab("Power"), "Close Saved Documents"); assert.deepEqual(visible(), [], "all saved tabs close: "+JSON.stringify({current:H.doc().name,local:H.folderProject().localState.openTabs,dialogs:$$("dialog[open]").map(d=>d.className),dirty:H.isDirty()})); reset();
    await until(() => !$("dialog[open]") || ($("dialog[open]").close(), true), "start page");
    await choose(tab("Power"), "Close All"); assert.deepEqual(visible(), []);
    assert.ok($("dialog.start-page[open], dialog[open]"), "the Start Page opens when every tab is closed");
    $("dialog[open]").close(); await step();
    assert.deepEqual(visible(), [name(H.currentId())], "closing the Start Page brings back the shown document's tab");
    reset();
    H.act("reopen-document"); assert.equal(docs().length, ALL.length);
  });

  await test("one unsaved document: Cancel keeps everything; Don't Save goes back to the saved state (undoable); Save writes the project", async () => {
    reset(); H.selectDocument(byName("Power").id); await step();
    const mcu = byName("MCU"), saved = JSON.stringify(mcu);
    H.edit(() => mcu.items.push({id: A.id(), kind: "netlabel", x: 5, y: 5, text: "NEW"}));
    assert.equal(T.modified(mcu.id), true); assert.equal(T.modified(byName("Power").id), false, "only the edited document counts as changed");
    await choose(tab("Power"), "Close Others");
    assert.ok(dialog(), "the prompt"); assert.match(dialog().querySelector("h2").textContent, /MCU/);
    await press("Cancel");
    assert.equal(visible().length, ALL.length, "Cancel: nothing closed"); assert.ok(byName("MCU").items.some(i => i.text === "NEW"), "and nothing reverted");
    await choose(tab("Power"), "Close Others"); await press("Don’t Save");
    assert.deepEqual(visible(), ["Power"]); assert.equal(JSON.stringify(byName("MCU")), saved, "MCU is back to its saved state");
    H.act("undo"); assert.ok(byName("MCU").items.some(i => i.text === "NEW"), "Undo brings the change back");
    reset(); const before = folders.commits.length;
    await choose(tab("Power"), "Close Documents to the Right");
    assert.ok(dialog(), "MCU (to the right) asks again"); await press("Save");
    await until(() => !H.isDirty(), "saved");
    assert.ok(folders.commits.length > before, "a native owner was committed"); assert.ok(byName("MCU").items.some(i => i.text === "NEW"), "Save keeps the change");
    reset(); await step(); await step();
  });

  await test("several unsaved documents: one dialog for the batch; Save Selected saves the ticked ones and reverts the others", async () => {
    T.capture();
    const mcu = byName("MCU"), con = byName("Connectors"), savedCon = JSON.stringify(con);
    H.edit(() => { mcu.items.push({id: A.id(), kind: "netlabel", x: 9, y: 9, text: "M2"}); con.items.push({id: A.id(), kind: "netlabel", x: 9, y: 9, text: "C2"}); });
    let opened = 0; const S = globalThis.AtriumShell, dlgFn = S.dialog; S.dialog = (...a) => { opened++; return dlgFn(...a); };
    await choose(tab("Analog front end"), "Close All Schematic Documents");
    S.dialog = dlgFn;
    assert.equal(opened, 1, "asked once for the whole batch");
    const boxes = [...dialog().querySelectorAll("input[type=checkbox]")];
    assert.deepEqual(boxes.map(b => name(b.dataset.doc)).sort(), ["Connectors", "MCU"]);
    boxes.find(b => name(b.dataset.doc) === "Connectors").checked = false;
    boxes.find(b => name(b.dataset.doc) === "Connectors").dispatchEvent(new window.Event("change"));
    const primary = dialog().querySelector(".work-actions .is-primary"); assert.equal(primary.textContent, "Save Selected");
    primary.click(); await until(() => !H.isDirty(), "saved");
    assert.deepEqual(visible(), ["Sensor board"]);
    assert.ok(byName("MCU").items.some(i => i.text === "M2"), "MCU saved with its change");
    assert.equal(JSON.stringify(byName("Connectors")), savedCon, "Connectors reverted");
    reset(); await step();
    // Close Saved Documents leaves the changed ones.
    T.capture(); H.edit(() => byName("Power").items.push({id: A.id(), kind: "netlabel", x: 1, y: 1, text: "P2"}));
    await choose(tab("MCU"), "Close Saved Documents"); assert.deepEqual(visible(), ["Power"]);
    reset(); await H.saveProject(); await step(); T.capture();
  });

  await test("split panes: Right and Left count in the strip that was clicked; a document open in the other pane does not ask", async () => {
    reset(); H.selectDocument(byName("Analog front end").id); await step();
    H.openSplit("right", byName("Sensor board").id); await step(); await step();
    await until(() => $$(".pane-tabs").length === 2, "two pane strips");
    const strips = $$(".pane-tabs"), ids = k => [...strips[k].querySelectorAll(".pane-tab")].map(t => name(t.dataset.tab));
    const one = ids(1), zero = ids(0);
    assert.ok(zero.length >= 4, "the first pane keeps every document: " + zero.join(", "));
    const pane0 = n => strips[0].querySelector('[data-tab="' + byName(n).id + '"]');
    const at = zero.indexOf("Power");
    await choose(pane0("Power"), "Close Documents to the Right");
    assert.deepEqual(ids(0), zero.slice(0, at + 1)); assert.deepEqual(ids(1), one, "the other pane is untouched");
    assert.ok(!dialog());
    await step(); assert.deepEqual(ids(0), zero.slice(0, at + 1), "closed tabs do not come back on the next refresh");
    // An unsaved document still open in the other pane closes here without a prompt.
    const board = byName("Sensor board"); if (!ids(0).includes("Sensor board")) globalThis.AtriumSplitTabs.moveTab(null, 0, board.id);
    await step(); T.capture(); H.edit(() => board.items.push({id: A.id(), kind: "graphic", layer: "Top Overlay", points: [[0, 0], [1, 1]], width: .2}));
    const p0 = n => $$(".pane-tabs")[0].querySelector('[data-tab="' + byName(n).id + '"]');
    await choose(p0("Sensor board"), "Close"); assert.ok(!dialog(), "no prompt: the board is still open in the other pane");
    H.act("split-close"); await step(); H.act("undo"); await H.saveProject(); await step(); T.capture();
  });

  await test("keyboard: Close Document (Ctrl/⌘+F4) closes the active tab through the same path; Ctrl+W stays Altium's wire and route", async () => {
    reset(); H.selectDocument(byName("Power").id); await step();
    await H.act("close-document"); await step(); await step();
    assert.ok(!visible().includes("Power")); assert.notEqual(name(H.currentId()), "Power");
    const KM = globalThis.AtriumKeymap;
    assert.equal(KM.resolve("Mod+F4", {kind: "schematic", tool: "select", canvas: true, documentId: "d"}), "close-document");
    assert.equal(KM.resolve("Ctrl+W", {kind: "schematic", tool: "select", canvas: true, documentId: "d"}), "start-wire");
    assert.equal(KM.resolve("Ctrl+W", {kind: "pcb", tool: "select", canvas: true, documentId: "d"}), "route");
    reset();
  });

  await test("Single \\ negation: the preference redraws every open sheet", async () => {
    const P = await L.need("AtriumPrefs"), S = globalThis.AtriumSchAppearance;
    H.selectDocument(byName("Power").id); await step();
    H.edit(() => { for (let k = 0; k < 6; k++) byName("Power").items.push({id: A.id(), kind: "netlabel", x: 10, y: 2 * k, text: "\\RST" + k}); });
    H.act("fit");
    const frame=()=>new Promise(resolve=>{
      const bars=new Map(),labels=new WeakMap();
      const stop=onCanvasCall((canvas,op,args)=>{
        if(op==="fillText"){
          const text=String(args[0]).replace(/^\\/,"");
          if(/^RST[0-5]$/.test(text)){labels.set(canvas,text);bars.set(text,0);}
          else labels.delete(canvas);
        }
        if(op==="fillRect"&&labels.has(canvas)){const label=labels.get(canvas);bars.set(label,bars.get(label)+1);}
        if(op==="restore")labels.delete(canvas);
      });
      const off=H.on("frame",()=>{off();stop();resolve(bars);});
      H.redraw(true);
    });
    const orig = H.redraw; let redraws = 0; H.redraw = (...a) => { redraws += a[0] === true; return orig(...a); };
    const on = await frame();
    P.set("schematic.singleNegation", false);
    assert.equal(S.singleNegation(), false); assert.equal(redraws, 2, "the toggle redraws every pane");
    const off = await frame();
    P.set("schematic.singleNegation", true); H.redraw = orig;
    for(let k=0;k<6;k++){assert.equal(on.get("RST"+k),1,"one visible negation bar");assert.equal(off.get("RST"+k),0,"the same label without its bar");}
    H.act("undo");
  });

  console.log("PASS doc-tabs-ui: " + passed + " groups");
}
run().then(() => process.exit(0), e => { console.error(e); process.exit(1); });
