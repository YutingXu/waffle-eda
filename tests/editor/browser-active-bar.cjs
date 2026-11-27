"use strict";
// The customisable Active Bar (docs/design/customisable-bars.md) in the editor:
//   - an uncustomised bar is the static markup and loads nothing; a stored bar equal to the default
//     draws identical markup, and the drawing path keeps the markup's DOM;
//   - Preferences › Toolbars adds, removes, reorders (keyboard, mouse, touch), groups, separates and resets;
//   - sticky flyouts survive a reload and a kind switch; overflow moves tools into "⋯" at the narrowest window;
//   - an extension's Active Bar button, macros with and without parameters, the notebook's Widgets
//     flyout (with an extension widget, and the notebook switched off under it), GND and VDD;
//   - settings export and import carry the bar; the tutorial still finds its tools.
// Optional: --shots DIR writes the owner's screenshots (light, dark, touch).
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const {pathToFileURL} = require("node:url");

const URL = pathToFileURL(path.join(__dirname, "../../app/index.html")).href;
const shotsAt = process.argv.indexOf("--shots"), SHOTS = shotsAt > 0 ? path.resolve(process.argv[shotsAt + 1]) : null;
const wait = ms => new Promise(r => setTimeout(r, ms));

// A fresh profile per page; reloads keep what the page stored.
function seed(values) {
  if (window !== window.top || sessionStorage.getItem("bar-test")) return;
  sessionStorage.setItem("bar-test", "1");
  localStorage.clear();
  localStorage.setItem("atrium.prefs", JSON.stringify({format:"atrium-prefs", version:1, values}));
}
async function open(browser, {viewport = {width:1440, height:900}, colorScheme = "light", hasTouch = false, prefs = {}} = {}) {
  const page = await browser.newPage({viewport, colorScheme, hasTouch, reducedMotion:"reduce"});
  await page.addInitScript(seed, {"general.efficiency":"always", "general.startPage":"always", ...prefs});
  await page.goto(URL);
  await demo(page);
  return page;
}
// The demo project: a schematic and a board.
async function demo(page) {
  await page.waitForFunction(() => document.querySelector("dialog[open] [data-start-action=demo]") || globalThis.AtriumNavHost?.project?.()?.documents?.length > 1, null, {timeout:30000});
  // The start page may still be wiring its buttons: press Try the Demo until the demo opens.
  await page.waitForFunction(() => {
    if (globalThis.AtriumNavHost?.project?.()?.documents?.some(d => d.kind === "pcb") && !document.querySelector("dialog.sp-dialog[open]")) return true;
    const now = Date.now();
    if (!(globalThis.__demoAt > now - 1500)) { globalThis.__demoAt = now; document.querySelector("dialog[open] [data-start-action=demo]")?.click(); }
    return false;
  }, null, {timeout:45000});
  await kind(page, "schematic");
}
const kind = (page, k) => page.evaluate(async k => {
  const H = AtriumNavHost, d = H.project().documents.find(x => x.kind === k);
  if (H.doc().id !== d.id) await H.selectDocument(d.id);
  await new Promise(r => setTimeout(r, 300));
  return document.body.dataset.kind;
}, k);
// The bar as a user sees it: visible children, a power key for power ports, "|" for separators.
const visible = page => page.evaluate(() => [...document.getElementById("tools").children].filter(n => n.getClientRects().length)
  .map(n => n.dataset.powerNet ? "power:" + n.dataset.powerNet : n.dataset.command || n.dataset.action || (n.classList.contains("tool-divider") ? "|" : n.dataset.toolGroup)));
const settle = page => page.evaluate(() => new Promise(r => requestAnimationFrame(() => setTimeout(r, 120))));

async function contract(browser) {
  const page = await open(browser);
  try {
    // No stored bar: the static markup, and nothing loaded for it.
    assert.equal(await page.evaluate(() => !!globalThis.AtriumBars), false, "an uncustomised bar loads no bar code at a normal width");
    const sch = await visible(page);
    assert.deepEqual(sch, ["select", "pan", "|", "library", "route", "junction", "label", "power:GND", "power:VDD", "|", "measure", "comment-mode"],
      "the default schematic bar adds GND and VDD; Widgets waits for the notebook");
    const r = await page.evaluate(async () => {
      const bar = document.getElementById("tools"), k = document.body.dataset.kind, A = bar.innerHTML;
      const vis = () => [...bar.children].filter(n => n.getClientRects().length).map(n => n.outerHTML);
      const before = vis();
      await AtriumLazy.need("AtriumActiveBarMenu");
      const B = AtriumBars;
      B.render(); const drawn = bar.innerHTML;
      B.setList(k, B.defaultList(k)); await new Promise(r => setTimeout(r, 50));
      const stored = AtriumPrefs.get("workbench.bars") ?? null, same = bar.innerHTML;
      B.render(k, B.defaultList(k)); const custom = vis();
      B.render(); const back = bar.innerHTML;
      // Malformed stored values draw the default and never throw.
      const bad = [];
      for (const v of [3, "x", [], {version:9, active:{schematic:["pan"]}}, {active:{schematic:"pan"}}, {version:1, active:{schematic:[null, {}, 7]}}]) {
        AtriumPref.set("workbench.bars", v); B.render(); bad.push(vis().length);
      }
      AtriumPrefs.reset(["workbench.bars"]); B.render();
      const now = [...bar.children].map(n => n.outerHTML), was = new DOMParser().parseFromString("<div>" + A + "</div>", "text/html").body.firstChild;
      const diff = [...was.children].map(n => n.outerHTML).map((h, i) => h === now[i] ? null : [h.slice(0, 300), now[i]?.slice(0, 300)]).filter(Boolean)[0];
      return {diff, redrawn:drawn === A, equal:same === A, stored, custom:JSON.stringify(custom) === JSON.stringify(before), back:back === A, bad, last:bar.innerHTML === A};
    });
    const {bad, diff, ...rest} = r;
    if (!rest.last) console.log("first difference:", diff);
    assert.deepEqual(rest, {redrawn:true, equal:true, stored:null, custom:true, back:true, last:true}, "rendering contract");
    assert.equal(bad.slice(0, 5).every(n => n === sch.length), true, "malformed values draw the default");
    assert.equal(bad[5], 0, "a list of only junk draws an empty bar, without an error");
    // Board: the markup's PCB buttons, no power ports.
    await kind(page, "pcb");
    assert.deepEqual(await visible(page), ["select", "pan", "|", "library", "route", "via", "label", "|", "measure", "comment-mode"]);
    // The tutorial's bar highlights still resolve.
    assert.equal(await page.evaluate(() => ["library", "route"].every(a => document.querySelector('#tools [data-action="' + a + '"]')?.getClientRects().length)), true);
    assert.deepEqual(page.errors || [], []);
    console.log("PASS rendering contract: the default bar is the markup; a stored default draws it unchanged");
  } finally { await page.close(); }
}

async function toolbarsPage(browser) {
  const page = await open(browser);
  try {
    await page.evaluate(() => AtriumNavHost.act("customise-active-bar"));
    await page.waitForFunction(() => document.querySelector(".prf-page [role=tree] .ui-row"), null, {timeout:15000});
    const rows = () => page.evaluate(() => [...document.querySelectorAll(".prf-page [role=tree] > .ui-row .ui-row-title")].map(n => n.textContent));
    const stored = () => page.evaluate(() => AtriumPrefs.get("workbench.bars")?.active?.schematic ?? null);
    const press = (title, key, mods = {}) => page.evaluate(({title, key, mods}) => {
      const r = [...document.querySelectorAll(".prf-page [role=tree] > .ui-row")].find(x => x.querySelector(".ui-row-title").textContent === title);
      r.focus(); r.dispatchEvent(new KeyboardEvent("keydown", {key, bubbles:true, ...mods}));
    }, {title, key, mods});
    const first = await rows();
    assert.deepEqual(first.slice(0, 3), ["Select", "Pan", "Separator"]);
    // Drawing: only the tools drawings show (style.css hides the schematic and board ones there).
    await page.evaluate(() => [...document.querySelectorAll(".prf-page .ui-segment")].find(b => b.textContent === "Drawing").click());
    await settle(page);
    assert.deepEqual(await rows(), ["Select", "Pan", "Separator", "Drawing view", "Dimension", "Note callout", "Table", "Text", "Line", "Separator", "Annotate"]);
    await page.evaluate(() => [...document.querySelectorAll(".prf-page .ui-segment")].find(b => b.textContent === "Schematic").click());
    await settle(page);
    // Keyboard: Alt+↑ moves Pan above Select, and focus stays on it.
    await press("Pan", "ArrowUp", {altKey:true}); await settle(page);
    assert.deepEqual((await stored()).slice(0, 2), ["pan", "select"]);
    assert.equal(await page.evaluate(() => document.activeElement.querySelector(".ui-row-title")?.textContent), "Pan");
    assert.deepEqual((await visible(page)).slice(0, 2), ["pan", "select"], "the real bar follows at once");
    // Delete removes the focused button.
    await press("Junction", "Delete"); await settle(page);
    assert.equal((await stored()).includes("junction"), false);
    // The row menu moves too (touch and screen-reader users): Move Down, then Move Up.
    const menuMove = (title, label) => page.evaluate(async ({title, label}) => {
      const r = [...document.querySelectorAll(".prf-page [role=tree] > .ui-row")].find(x => x.querySelector(".ui-row-title").textContent === title);
      r.querySelector('[aria-label^="More actions"]').click();
      for (let i = 0; i < 40 && ![...document.querySelectorAll(".nav-menu [role=menuitem]")].some(b => b.textContent.startsWith(label)); i++) await new Promise(r => setTimeout(r, 50));
      [...document.querySelectorAll(".nav-menu [role=menuitem]")].find(b => b.textContent.startsWith(label)).click();
      await new Promise(r => setTimeout(r, 100));
    }, {title, label});
    await menuMove("Pan", "Move Down");
    assert.deepEqual((await stored()).slice(0, 2), ["select", "pan"]);
    await menuMove("Pan", "Move Up");
    assert.deepEqual((await stored()).slice(0, 2), ["pan", "select"]);
    // Search adds a command; a separator joins the end.
    await page.evaluate(() => { const s = document.querySelector(".prf-page input[type=search]"); s.value = "zoom in"; s.dispatchEvent(new Event("input", {bubbles:true})); });
    await page.waitForFunction(() => [...document.querySelectorAll(".prf-page .ui-list:not([role=tree]) .ui-row")].length);
    await page.evaluate(() => [...document.querySelectorAll(".prf-page .ui-list:not([role=tree]) .ui-row")].find(r => /Zoom In/i.test(r.textContent)).click());
    await page.evaluate(() => [...document.querySelectorAll(".prf-page button")].find(b => b.textContent === "Add Separator").click());
    await settle(page);
    assert.deepEqual((await stored()).slice(-2), ["zoom-in", "|"]);
    // Mouse: drag Zoom In by its handle above Pan.
    const box = await page.evaluate(() => {
      const row = t => [...document.querySelectorAll(".prf-page [role=tree] > .ui-row")].find(x => x.querySelector(".ui-row-title").textContent === t);
      const h = row("Zoom In").querySelector(".ui-drag-handle").getBoundingClientRect(), p = row("Pan").getBoundingClientRect();
      return {x:h.x + h.width / 2, y:h.y + h.height / 2, to:p.y + 2};
    });
    await page.mouse.move(box.x, box.y); await page.mouse.down();
    await page.mouse.move(box.x, box.to, {steps:8}); await page.mouse.up(); await settle(page);
    assert.deepEqual((await stored()).slice(0, 2), ["zoom-in", "pan"], "a mouse drag on the handle reorders");
    // Touch: the same handle with a finger (pointer events from a touch screen).
    await page.evaluate(async () => {
      const row = t => [...document.querySelectorAll(".prf-page [role=tree] > .ui-row")].find(x => x.querySelector(".ui-row-title").textContent === t);
      const h = row("Zoom In").querySelector(".ui-drag-handle"), from = h.getBoundingClientRect(), to = row("Select").getBoundingClientRect();
      const ev = (type, y) => h.dispatchEvent(new PointerEvent(type, {bubbles:true, pointerId:7, pointerType:"touch", isPrimary:true, button:0, buttons:type === "pointerup" ? 0 : 1, clientX:from.x + 4, clientY:y}));
      ev("pointerdown", from.y + 4);
      for (let i = 1; i <= 6; i++) ev("pointermove", from.y + (to.y + to.height - 2 - from.y) * i / 6);
      ev("pointerup", to.y + to.height - 2);
    });
    await settle(page);
    assert.deepEqual((await stored()).slice(0, 3), ["pan", "select", "zoom-in"], "a touch drag on the handle reorders");
    // Group: Annotate goes into Measure's flyout through the row's menu (the touch path for grouping).
    await page.evaluate(() => {
      const r = [...document.querySelectorAll(".prf-page [role=tree] > .ui-row")].find(x => x.querySelector(".ui-row-title").textContent === "Annotate");
      r.querySelector('[aria-label^="More actions"]').click();
    });
    await page.waitForFunction(() => [...document.querySelectorAll(".nav-menu [role=menuitem]")].some(b => /Flyout of Previous/.test(b.textContent)));
    await page.evaluate(() => [...document.querySelectorAll(".nav-menu [role=menuitem]")].find(b => /Flyout of Previous/.test(b.textContent)).click());
    await settle(page);
    const group = (await stored()).find(x => typeof x === "object");
    assert.deepEqual(group, {face:"measure", more:["measure", "goto-location", "goto-object", "comment-mode"]});
    assert.equal(await page.evaluate(() => document.querySelector('#tools [data-action="measure"]').dataset.toolGroup.startsWith("bar-")), true);
    const fly = await page.evaluate(async () => {
      AtriumActiveBar.open(document.querySelector('#tools [data-action="measure"]'));
      await new Promise(r => setTimeout(r, 300));
      const out = [...document.querySelectorAll("#active-bar-flyout [role=menuitem]")].map(b => b.getAttribute("aria-label"));
      AtriumActiveBar.close(false); return out;
    });
    assert.equal(fly.length, 4, "the user's flyout: " + fly.join(", "));
    // Limits: the 25th button is refused with a reason.
    const full = await page.evaluate(async () => {
      const k = "schematic", list = AtriumBars.effective(k);
      while (list.length < AtriumBars.LIMITS.bar) list.push("|");
      AtriumBars.setList(k, list); await new Promise(r => setTimeout(r, 100));
      [...document.querySelectorAll(".prf-page button")].find(b => b.textContent === "Add Separator").click();
      return {count:AtriumPrefs.get("workbench.bars").active.schematic.length, status:document.querySelector(".prf-page [role=status]")?.textContent};
    });
    assert.equal(full.count, 24); assert.match(full.status, /at most 24/);
    // Reset puts this kind back; Restore Defaults clears every bar and the remembered faces.
    await page.evaluate(() => [...document.querySelectorAll(".prf-page button")].find(b => b.textContent === "Reset").click());
    await settle(page);
    assert.equal(await stored(), null);
    await page.evaluate(() => { AtriumBars.setList("pcb", ["select", "via"]); localStorage.setItem("atrium.bar-faces", JSON.stringify({schematic:{select:"pan"}})); AtriumBars.render(); });
    await page.evaluate(() => [...document.querySelectorAll(".prf-page button")].find(b => /Restore Defaults/.test(b.textContent)).click());
    await page.waitForFunction(() => [...document.querySelectorAll("dialog[open] button")].some(b => b.textContent === "Restore Defaults"));
    await page.evaluate(() => [...document.querySelectorAll("dialog[open] button")].find(b => b.textContent === "Restore Defaults").click());
    await settle(page);
    assert.deepEqual(await page.evaluate(() => [AtriumPrefs.get("workbench.bars") ?? null, localStorage.getItem("atrium.bar-faces")]), [null, null]);
    assert.equal((await visible(page))[0], "select");
    console.log("PASS Toolbars page: add, remove, reorder by keyboard, mouse and touch, group, separator, limits, reset, restore");
  } finally { await page.close(); }
}

async function sticky(browser) {
  const page = await open(browser);
  try {
    // Choosing Move Object from Select's flyout makes it the face; a click then runs it.
    const chosen = await page.evaluate(async () => {
      const b = document.querySelector('#tools [data-action="select"]');
      b.focus(); b.dispatchEvent(new KeyboardEvent("keydown", {key:"ArrowDown", bubbles:true}));
      await new Promise(r => setTimeout(r, 400));
      [...document.querySelectorAll("#active-bar-flyout [role=menuitem]")].find(x => x.getAttribute("aria-label") === "Move Object").click();
      await new Promise(r => setTimeout(r, 200));
      return {tool:AtriumNavHost.tool(), faces:JSON.parse(localStorage.getItem("atrium.bar-faces"))};
    });
    assert.equal(chosen.tool, "move-object");
    assert.deepEqual(chosen.faces, {schematic:{select:"move-object"}}, "view state, not an edit to the stored bar");
    assert.equal(await page.evaluate(() => AtriumPrefs.get("workbench.bars") ?? null), null);
    assert.deepEqual((await visible(page)).slice(0, 2), ["move-object", "pan"]);
    // It survives a reload: the bar waits hidden until it is drawn with the face (no flash of Select).
    await page.reload();
    await page.waitForFunction(() => globalThis.AtriumNavHost?.project?.()?.documents?.length && document.getElementById("tools"));
    await demo(page);
    assert.deepEqual((await visible(page)).slice(0, 2), ["move-object", "pan"]);
    assert.equal(await page.evaluate(() => document.getElementById("tools").hasAttribute("data-pending")), false);
    // Per kind: the board keeps Select; back on the sheet the face returns.
    await kind(page, "pcb");
    assert.equal((await visible(page))[0], "select");
    await kind(page, "schematic");
    assert.equal((await visible(page))[0], "move-object");
    // Choosing the button's own tool again forgets the face.
    await page.evaluate(async () => {
      const b = document.querySelector('#tools [data-action="move-object"]');
      AtriumActiveBar.open(b); await new Promise(r => setTimeout(r, 300));
      [...document.querySelectorAll("#active-bar-flyout [role=menuitem]")].find(x => x.getAttribute("aria-label") === "Select").click();
      await new Promise(r => setTimeout(r, 100));
    });
    assert.equal(await page.evaluate(() => localStorage.getItem("atrium.bar-faces")), null);
    console.log("PASS sticky flyouts: the choice is the face per kind, survives a reload, and is view state");
  } finally { await page.close(); }
}

async function overflow(browser) {
  // The macOS host's narrowest window (native/macos/main.swift minSize).
  const page = await open(browser, {viewport:{width:770, height:600}});
  try {
    const def = await page.evaluate(() => [!!document.querySelector("#tools [data-tool-group=overflow]"), document.getElementById("tools").scrollWidth <= document.getElementById("tools").clientWidth + 1]);
    assert.deepEqual(def, [false, true], "the default schematic bar, with GND and VDD, fits the narrowest window");
    const r = await page.evaluate(async () => {
      await AtriumLazy.need("AtriumActiveBarMenu");
      AtriumBars.setList("schematic", [...AtriumBars.defaultList("schematic"), "|", "fit", "zoom-in", "zoom-out", "undo", "redo", "sch-port", "sch-text", "grid"]);
      await new Promise(r => setTimeout(r, 300));
      const bar = document.getElementById("tools"), more = bar.querySelector("[data-tool-group=overflow]");
      const hidden = [...bar.querySelectorAll("[data-overflow]")].filter(n => !n.classList.contains("tool-divider")).map(n => n.dataset.action);
      more.click(); await new Promise(r => setTimeout(r, 300));
      const rows = [...document.querySelectorAll("#active-bar-flyout [role=menuitem]")].map(b => b.getAttribute("aria-label"));
      // The last tool (Toggle Visible Grid) runs from the flyout.
      const grid = () => document.querySelector('.menubar [data-action="grid"][role=menuitemcheckbox]').getAttribute("aria-checked");
      const was = grid();
      [...document.querySelectorAll("#active-bar-flyout [role=menuitem]")].at(-1).click();
      await new Promise(r => setTimeout(r, 300));
      return {hidden, rows, fits:bar.scrollWidth <= bar.clientWidth + 1, zoomed:grid() !== was, last:bar.lastElementChild === more};
    });
    assert.ok(r.hidden.length >= 2 && r.hidden.includes("grid"), "trailing tools move out: " + r.hidden);
    assert.equal(r.rows.length, r.hidden.length);
    assert.deepEqual([r.fits, r.zoomed, r.last], [true, true, true]);
    console.log("PASS overflow: trailing tools move into the ⋯ flyout and run from there");
  } finally { await page.close(); }
}

async function icons(browser) {
  const page = await open(browser);
  try {
    const r = await page.evaluate(async () => {
      await AtriumLazy.need("AtriumActiveBarMenu");
      await AtriumBars.sync();
      AtriumBars.setList("schematic", ["select", "undo", "redo", "fit", "zoom-in", "zoom-out", "grid", "delete", "rotate", "paste", "move-object"]);
      await AtriumBars.loadIcons(); AtriumBars.render();
      const face = a => { const b = document.querySelector('#tools [data-action="' + a + '"]'); return b?.querySelector("use")?.getAttribute("href") || b?.querySelector(".tool-text")?.textContent || null; };
      const out = {};
      for (const a of ["undo", "redo", "fit", "zoom-in", "zoom-out", "grid", "delete", "rotate", "paste", "move-object"]) out[a] = face(a);
      out.count = AtriumKeymap.commands().filter(c => c.builtin && c.icon).length;
      // A text face: the 28 px tool, wider, one line, ellipsis past four tool widths; the full name stays in the tooltip.
      const paste = document.querySelector('#tools [data-action="paste"]'), icon = document.querySelector('#tools [data-action="undo"]');
      const box = paste.getBoundingClientRect(), text = paste.querySelector(".tool-text"), style = getComputedStyle(paste);
      out.text = {height:box.height === icon.getBoundingClientRect().height, wider:box.width > icon.getBoundingClientRect().width,
        radius:style.borderRadius === getComputedStyle(icon).borderRadius, oneLine:text.getBoundingClientRect().height < box.height,
        tooltip:paste.dataset.tooltip || paste.title};
      const iconWidth = icon.getBoundingClientRect().width;
      AtriumBars.setList("schematic", ["select", "sch-sync-entries"]);
      const long = document.querySelector('#tools [data-action="sch-sync-entries"]');
      out.capped = long.getBoundingClientRect().width <= 4 * iconWidth + 1 &&long.querySelector(".tool-text").scrollWidth > long.querySelector(".tool-text").clientWidth;
      AtriumBars.reset();
      return out;
    });
    const {count, text, capped, ...faces} = r;
    assert.deepEqual(text, {height:true, wider:true, radius:true, oneLine:true, tooltip:"Paste"}, "the text face keeps the tool's height, radius and tooltip");
    assert.equal(capped, true, "a long title is cut with an ellipsis at four tool widths");
    assert.deepEqual(faces, {undo:"#i-undo", redo:"#i-redo", fit:"#i-fit", "zoom-in":"#i-plus", "zoom-out":"#i-minus", grid:"#i-grid", delete:"#i-delete", rotate:"#i-rotate",
      paste:"Paste", "move-object":"Move Object"}, "faces reuse the symbols the chrome and the palette draw; Paste does not borrow Zoom In's plus");
    console.log("PASS command icons: " + count + " built-in commands draw an existing symbol");
  } finally { await page.close(); }
}

async function extensionsAndMacros(browser) {
  const page = await open(browser, {prefs:{"butter.macros":true}});
  try {
    // A customised bar first: an extension installed later still reaches it, once, at the end.
    await page.evaluate(async () => {
      await AtriumLazy.need("AtriumActiveBarMenu");
      AtriumBars.setList("schematic", ["select", "pan", "|", "route", "fit"]);
    });
    // An extension's Active Bar button (api.ui.addActiveBarButton, unchanged) is an ordinary item.
    await page.evaluate(() => {
      const manifest = {id:"test.barbutton", name:"Bar Button", version:"1.0.0", apiVersion:1, main:"main.js", activationEvents:["onStartup"], permissions:["ui:command"],
        contributes:{commands:[{command:"bar.hello", title:"Say Hello"}]}};
      const files = {"waffle-extension.json":JSON.stringify(manifest),
        "main.js":'exports.activate = api => {api.commands.register("bar.hello", () => api.ui.showMessage("Bar hello ran")); api.ui.addActiveBarButton({command:"bar.hello", title:"Say Hello"});};'};
      globalThis.__install = AtriumLazy.need("AtriumExtensions").then(() => AtriumExtensions.install(files));
    });
    await page.waitForFunction(() => document.querySelector("dialog.ext-prompt[open]"), null, {timeout:20000});
    await page.evaluate(() => [...document.querySelectorAll("dialog.ext-prompt[open] button")].find(b => b.textContent === "Install").click());
    await page.waitForFunction(() => document.querySelector('#tools .ext-tool[data-command="bar.hello"]'), null, {timeout:20000});
    await settle(page);
    assert.equal((await visible(page)).at(-1), "bar.hello", "a new extension button joins the customised bar at its end");
    assert.deepEqual(await page.evaluate(() => [AtriumPrefs.get("workbench.bars").active.schematic, AtriumPrefs.get("workbench.bars").seen]),
      [["select", "pan", "|", "route", "fit", "bar.hello"], {schematic:["bar.hello"]}]);
    // Removed, it stays removed, also after a reload.
    await page.evaluate(() => AtriumBars.setList("schematic", ["select", "pan", "|", "route", "fit"]));
    await page.reload();
    await demo(page);
    // The extension starts again (onStartup) and adds its button; the bar must leave it out.
    await page.evaluate(() => AtriumLazy.need("AtriumExtensions"));
    await page.waitForFunction(() => document.querySelector('.ext-tool[data-command="bar.hello"]') || AtriumExtensions.list().some(r => r.id === "test.barbutton" && r.status === "active"), null, {timeout:60000})
      .catch(async e => { throw Error(e.message + " " + JSON.stringify(await page.evaluate(() => AtriumExtensions.list().map(r => [r.id, r.status])))); });
    await settle(page); await wait(500);
    assert.equal((await visible(page)).includes("bar.hello"), false, "a removed extension button stays removed");
    assert.deepEqual(await page.evaluate(() => AtriumPrefs.get("workbench.bars").active.schematic), ["select", "pan", "|", "route", "fit"]);
    await page.evaluate(() => AtriumBars.reset());
    await settle(page);
    assert.equal((await visible(page)).at(-1), "bar.hello", "the default bar takes extension buttons at its end");
    const ext = await page.evaluate(async () => {
      const k = "schematic";
      AtriumBars.setList(k, ["bar.hello", "select", "route"]); await new Promise(r => setTimeout(r, 100));
      const moved = [...document.getElementById("tools").children].map(n => n.dataset.command || n.dataset.action);
      document.querySelector('#tools .ext-tool[data-command="bar.hello"]').click();
      let ran = 0;
      for (let i = 0; i < 40 && !ran; i++) { await new Promise(r => setTimeout(r, 100)); ran = document.body.innerText.includes("Bar hello ran") ? 1 : 0; }
      AtriumBars.setList(k, ["select", "route"]); await new Promise(r => setTimeout(r, 100));
      const parked = !document.querySelector('#tools .ext-tool[data-command="bar.hello"]');
      AtriumBars.reset(); await new Promise(r => setTimeout(r, 100));
      return {moved, ran, parked, back:!!document.querySelector('#tools .ext-tool[data-command="bar.hello"]')};
    });
    assert.deepEqual(ext, {moved:["bar.hello", "select", "route"], ran:1, parked:true, back:true}, "an extension button is an ordinary item");
    // Macros: one without parameters runs at once; one with parameters opens Run….
    await page.waitForFunction(() => globalThis.AtriumButterEditor && globalThis.AtriumMacros, null, {timeout:20000});
    const macros = await page.evaluate(async () => {
      const save = macro => AtriumButterEditor.apply("butter.macros.save", {macro:{format:"waffle-macro", version:1, ...macro}});
      await save({name:"Thin tracks", alias:"thin", steps:[{command:"butter.macros.set-track-width", args:{width:0.2}}]});
      await save({name:"Set width", alias:"width", parameters:[{name:"w", type:"number"}], steps:[{command:"butter.macros.set-track-width", args:{width:{$parameter:"w"}}}]});
      for (let i = 0; i < 50 && !AtriumKeymap.command("butter.macros.alias.width"); i++) await new Promise(r => setTimeout(r, 100));
      // Without parameters the command itself asks for them through a status message only.
      await AtriumKeymap.command("butter.macros.alias.width").run();
      const bare = document.getElementById("status").textContent;
      AtriumBars.setList("schematic", [...AtriumBars.defaultList("schematic"), "butter.macros.alias.thin", "butter.macros.alias.width"]);
      await new Promise(r => setTimeout(r, 100));
      const thin = document.querySelector('#tools [data-bar-run="butter.macros.alias.thin"]'), width = document.querySelector('#tools [data-bar-run="butter.macros.alias.width"]');
      const face = thin.querySelector(".tool-text")?.textContent;
      thin.click(); await new Promise(r => setTimeout(r, 1200));
      const ranThin = document.getElementById("status").textContent, dialogsAfterThin = document.querySelectorAll("dialog[open]").length;
      width.click();
      for (let i = 0; i < 40 && ![...document.querySelectorAll("dialog[open]")].some(d => /Run Set width/.test(d.textContent)); i++) await new Promise(r => setTimeout(r, 100));
      const run = [...document.querySelectorAll("dialog[open]")].find(d => /Run Set width/.test(d.textContent));
      [...(run?.querySelectorAll("button") || [])].find(b => b.textContent === "Cancel")?.click();
      return {bare, face, label:thin.getAttribute("aria-label"), ranThin, dialogsAfterThin, run:!!run};
    });
    assert.equal(macros.bare, "Provide macro parameter w.", "a parameterised macro's command, run bare, only reports the missing parameter");
    assert.equal(macros.label, "Thin tracks"); assert.equal(macros.face, "Thin tracks", "a macro's text face is its name");
    assert.match(macros.ranThin, /PCB|track|changes/i, "a macro without parameters runs at once");
    assert.equal(macros.run, true, "a macro with parameters opens Run…");
    // Macros switched off: the button is not drawn, the stored id stays.
    await page.evaluate(() => AtriumPrefs.set("butter.macros", false));
    await page.waitForFunction(() => !AtriumKeymap.command("butter.macros.alias.thin"), null, {timeout:10000});
    await settle(page);
    assert.equal(await page.evaluate(() => !!document.querySelector('#tools [data-bar-run="butter.macros.alias.thin"]')), false);
    assert.equal(await page.evaluate(() => AtriumPrefs.get("workbench.bars").active.schematic.includes("butter.macros.alias.thin")), true, "unknown ids are kept");
    // Switched on again, the macros register and their buttons return without another edit.
    await page.evaluate(() => AtriumPrefs.set("butter.macros", true));
    await page.waitForFunction(() => document.querySelector('#tools [data-bar-run="butter.macros.alias.thin"]'), null, {timeout:15000});
    console.log("PASS extension buttons and macros are ordinary bar items; Run… opens for parameters");
  } finally { await page.close(); }
}

async function widgetsAndPower(browser) {
  const page = await open(browser, {prefs:{"labs.notebook":true}});
  try {
    assert.equal((await visible(page)).includes("insert-palette"), true, "Widgets shows with the notebook on");
    const w = await page.evaluate(async () => {
      const E = await AtriumLazy.need("AtriumExtensionWidgetDeclarations");
      E.install({id:"test.counter", manifest:{id:"test.counter", permissions:["ui:widgets"], contributes:{commands:[{command:"c.render", title:"Render"}],
        widgets:[{id:"counter", name:"Counter Widget", render:"c.render", inputs:[], state:{count:{type:"number", min:0, max:100, default:0}},
          fallback:{type:"text", text:"Counter"}, size:{min:[10, 10], preferred:[20, 20], max:[80, 40]}}]}}}, {current:() => true, async invoke() { return {state:{}}; }});
      const button = () => document.querySelector('#tools [data-tool-group="widgets"]');
      AtriumActiveBar.open(button());
      for (let i = 0; i < 60 && !document.querySelector("#active-bar-flyout [role=menuitem]"); i++) await new Promise(r => setTimeout(r, 100));
      const items = [...document.querySelectorAll("#active-bar-flyout [role=menuitem]")].map(b => b.getAttribute("aria-label"));
      const n = AtriumNavHost.doc().items.length;
      [...document.querySelectorAll("#active-bar-flyout [role=menuitem]")].find(b => b.getAttribute("aria-label") === "Rich Text").click();
      for (let i = 0; i < 40 && AtriumNavHost.doc().items.length === n; i++) await new Promise(r => setTimeout(r, 100));
      const added = AtriumNavHost.doc().items.length - n, face = button().dataset.barRun;
      AtriumNavHost.executeKey("escape");
      // The notebook switched off while the flyout is open: it closes and the button hides.
      AtriumActiveBar.open(button()); await new Promise(r => setTimeout(r, 600));
      const opened = !!document.getElementById("active-bar-flyout");
      AtriumPrefs.set("labs.notebook", false); await new Promise(r => setTimeout(r, 300));
      return {items, added, face, opened, closed:!document.getElementById("active-bar-flyout"), hidden:!button().getClientRects().length};
    });
    for (const name of ["Rich Text", "Calculation", "Table", "To-do list", "Counter Widget"]) assert.ok(w.items.includes(name), name + " is in Widgets: " + w.items.join(", "));
    const {items, ...state} = w;
    assert.deepEqual(state, {added:1, face:"insert:rich-text", opened:true, closed:true, hidden:true});
    // GND and VDD arm Place › Power Port with their nets and place them.
    const power = await page.evaluate(async () => {
      const out = [];
      for (const net of ["GND", "VDD"]) {
        document.querySelector('#tools [data-power-net="' + net + '"]').click();
        for (let i = 0; i < 40 && AtriumNavHost.tool() !== "sch-place"; i++) await new Promise(r => setTimeout(r, 100));
        const n = AtriumNavHost.doc().items.length;
        AtriumNavHost.executeKey("place-at-pointer", [20 + out.length * 10, 20]);
        await new Promise(r => setTimeout(r, 200));
        const item = AtriumNavHost.doc().items.slice(n).find(i => i.kind === "power");
        out.push([item?.text, item?.style]);
        AtriumNavHost.executeKey("escape"); AtriumNavHost.executeKey("escape");
      }
      return out;
    });
    assert.deepEqual(power, [["GND", "gnd"], ["VDD", "bar"]]);
    console.log("PASS Widgets is the notebook's insert catalogue (extension widgets too); GND and VDD place their nets");
  } finally { await page.close(); }
}

async function settings(browser) {
  const page = await open(browser);
  try {
    const r = await page.evaluate(async () => {
      await AtriumLazy.need("AtriumActiveBarMenu");
      AtriumBars.setList("pcb", ["select", "|", {face:"route", more:["route-diffpair", "via"]}, "unknown.cmd"]);
      localStorage.setItem("atrium.bar-faces", JSON.stringify({schematic:{select:"pan"}}));
      const text = AtriumPrefs.exportSettings(), data = JSON.parse(text);
      AtriumPrefs.reset(["workbench.bars"]); AtriumBars.clearFaces();
      const cleared = [AtriumPrefs.get("workbench.bars") ?? null, localStorage.getItem("atrium.bar-faces")];
      const result = AtriumPrefs.importSettings(text);
      await new Promise(r => setTimeout(r, 100));
      return {exported:[data.prefs["workbench.bars"], data.layout.barFaces], cleared, applied:result.applied,
        back:[AtriumPrefs.get("workbench.bars"), JSON.parse(localStorage.getItem("atrium.bar-faces"))], face:document.querySelector("#tools > :first-child").dataset.action};
    });
    assert.deepEqual(r.exported, [{version:1, active:{pcb:["select", "|", {face:"route", more:["route-diffpair", "via"]}, "unknown.cmd"]}}, {schematic:{select:"pan"}}]);
    assert.deepEqual(r.cleared, [null, null]);
    assert.deepEqual(r.back, r.exported, "export and import carry the bars and the faces");
    assert.equal(r.face, "pan", "an imported face applies at once");
    console.log("PASS settings export and import carry the bars and the remembered faces");
  } finally { await page.close(); }
}

// Screenshots for the owner: the default bar, a customised bar with a macro and an overflow, the
// Toolbars page; light, dark and touch.
async function shots(browser) {
  if (!SHOTS) return;
  fs.mkdirSync(SHOTS, {recursive:true});
  for (const profile of [{name:"light"}, {name:"dark", colorScheme:"dark"}, {name:"touch", hasTouch:true, viewport:{width:1280, height:800}}]) {
    const page = await open(browser, {colorScheme:profile.colorScheme || "light", hasTouch:!!profile.hasTouch, viewport:profile.viewport,
      prefs:{"labs.notebook":true, "butter.macros":true}});
    try {
      await page.evaluate(theme => { document.documentElement.dataset.theme = theme; }, profile.colorScheme || "light");
      await settle(page);
      await page.screenshot({path:path.join(SHOTS, profile.name + "-1-default-bar.png")});
      await page.waitForFunction(() => globalThis.AtriumButterEditor && globalThis.AtriumMacros, null, {timeout:20000});
      await page.evaluate(async () => {
        await AtriumButterEditor.apply("butter.macros.save", {macro:{format:"waffle-macro", version:1, name:"Thin tracks", alias:"thin", steps:[{command:"butter.macros.set-track-width", args:{width:0.2}}]}});
        for (let i = 0; i < 50 && !AtriumKeymap.command("butter.macros.alias.thin"); i++) await new Promise(r => setTimeout(r, 100));
        await AtriumLazy.need("AtriumActiveBarMenu");
        AtriumBars.setList("schematic", ["select", "pan", "|", {face:"library", more:["sch-port", "power:+5V", "sch-text"]}, "route", "power:GND", "power:VDD", "insert-palette", "|",
          "butter.macros.alias.thin", "fit", "|", "measure", "comment-mode", "zoom-in", "zoom-out", "undo", "redo", "grid", "split-wire", "sch-bus"]);
      });
      await page.setViewportSize({width:900, height:profile.viewport?.height || 900});
      await settle(page);
      await page.evaluate(() => document.querySelector("#tools [data-tool-group=overflow]")?.click());
      await settle(page); await wait(300);
      await page.screenshot({path:path.join(SHOTS, profile.name + "-2-customised-bar-macro-overflow.png")});
      await page.evaluate(() => AtriumActiveBar.close(false));
      await page.setViewportSize(profile.viewport || {width:1440, height:900});
      await page.evaluate(() => AtriumNavHost.act("customise-active-bar"));
      await page.waitForFunction(() => document.querySelector(".prf-page [role=tree] .ui-row"));
      await page.evaluate(() => { const r = [...document.querySelectorAll(".prf-page [role=tree] > .ui-row")].find(x => x.getAttribute("aria-expanded") === "false"); r?.click(); });
      await settle(page); await wait(300);
      await page.screenshot({path:path.join(SHOTS, profile.name + "-3-toolbars-page.png")});
    } finally { await page.close(); }
  }
  console.log("wrote screenshots to " + SHOTS);
}

async function run(browser) {
  await contract(browser);
  await toolbarsPage(browser);
  await sticky(browser);
  await overflow(browser);
  await icons(browser);
  await extensionsAndMacros(browser);
  await widgetsAndPower(browser);
  await settings(browser);
  await shots(browser);
}
if (require.main === module)
  require("../support/standalone-chromium.cjs")(() => process.env.CHROME ? {executablePath:process.env.CHROME} : {channel:"chrome"}, run, error => {console.error(error); process.exitCode = 1;});
module.exports = run;
