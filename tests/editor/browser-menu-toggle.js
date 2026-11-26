"use strict";

// Every button that opens a menu toggles it: a second press on the same button closes the menu and it
// stays closed (no close-then-reopen flash), Escape closes it and gives the keyboard back to the button,
// and a press on another menu button switches menus. Panel toggles (Window › Panels, their shortcuts and
// the status bar's Problems count) close an open panel the same way.
//
// The check enumerates the menu buttons on the main surfaces (menu bar, toolbars, panel headers, the
// PCB and schematic editors, Preferences and Release), so a new menu button is covered without listing it.
// It runs with the mouse, with the mouse as WebKit (the Mac app) handles it, and with touch. WebKit does
// not focus a pressed button: focus leaves an open menu for the body before the click, which is what made
// every dropdown flash in the Mac app. Run standalone or with integration-browser.cjs --menu-toggle-only.
const assert = require("node:assert/strict");
const path = require("node:path");
const {pathToFileURL} = require("node:url");

const APP = path.join(__dirname, "../../app");
const PROFILES = [
  {name:"mouse"},
  {name:"mouse (WebKit focus)", webkit:true},
  {name:"touch (WebKit focus)", touch:true, webkit:true},
];

// WebKit on macOS: a press on a button or summary does not focus it, and focus leaves for the body.
function webkitFocus() {
  addEventListener("mousedown", e => {
    const b = e.target.closest?.("button, summary, [role=button], [role=tab]");
    if (!b) return;
    e.preventDefault();
    const a = document.activeElement;
    if (a && a !== document.body && !b.contains(a)) a.blur();
  }, true);
}

// Tag every menu button on screen (or in the open modal dialog) that a press can reach.
function tagTriggers({within, selects}) {
  const scope = within ? document.querySelector(within) : document;
  const sel = '[aria-haspopup]:not([aria-haspopup=false]):not([role=menuitem])' + (selects ? ", select" : "");
  const out = [];
  let selectCount = 0;
  for (const n of scope.querySelectorAll(sel)) {
    if (n.closest(".nav-menu, .menu-items, .ui-select-list") || n.disabled) continue;
    if (!within && n.closest("dialog")) continue;
    // A tool with a group opens it on a long press or a right-click; a click chooses the tool.
    if (n.matches(".tool.has-flyout")) continue;
    if (n.tagName === "SELECT" && (n.multiple || n.size > 1 || n.closest("[data-native-select]") || ++selectCount > 4)) continue;
    const r = n.getBoundingClientRect();
    if (r.width < 2 || r.height < 2) continue;
    const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
    if (!hit || !(n === hit || n.contains(hit))) continue;
    const key = keyOf(n);
    n.dataset.menuProbe = String(globalThis.__menuProbe = (globalThis.__menuProbe || 0) + 1);
    out.push({probe:n.dataset.menuProbe, label:key.split("|")[3], key});
  }
  return out;
  function keyOf(n) {
    const panel = n.closest("[data-dock-panel]")?.dataset.dockPanel || n.closest("dialog")?.className || "";
    const label = (n.getAttribute("aria-label") || n.textContent || "").trim().replace(/\s+/g, " ").slice(0, 40);
    return [n.tagName, panel, n.className, label].join("|");
  }
}

// A panel that re-renders replaces its controls: find the button again by what it is, and tag it anew.
function retag({probe, key}) {
  if (document.querySelector('[data-menu-probe="' + probe + '"]')) return true;
  for (const n of document.querySelectorAll("[aria-haspopup], select")) {
    const panel = n.closest("[data-dock-panel]")?.dataset.dockPanel || n.closest("dialog")?.className || "";
    const label = (n.getAttribute("aria-label") || n.textContent || "").trim().replace(/\s+/g, " ").slice(0, 40);
    if ([n.tagName, panel, n.className, label].join("|") === key) { n.dataset.menuProbe = probe; return true; }
  }
  return false;
}

// What the press opened: the button's expanded state, its <details>, or a visible menu, list or popover.
// A surface on its way out (inert while it fades) counts as closed.
function stateOf(input) {
  const {probe, waitFor, before} = typeof input === "string" ? {probe:input} : input;
  const t = document.querySelector('[data-menu-probe="' + probe + '"]');
  if (!t) return waitFor ? false : {gone:true, open:false, surfaces:0};
  const live = n => n.getClientRects().length && getComputedStyle(n).visibility !== "hidden" && !n.closest("[inert]");
  const surfaces = [...document.querySelectorAll(".nav-menu:not(.nav-submenu), .ui-select-list, .ui-popover")].filter(live).length;
  const det = t.tagName === "SUMMARY" ? t.parentElement : null, list = det?.querySelector(":scope > .menu-items");
  const details = !!det?.open && !list?.inert;
  const open = t.getAttribute("aria-expanded") === "true" || details, focus = document.activeElement === t;
  if (waitFor === "open") return open || surfaces > before;
  if (waitFor === "switched") return open && surfaces === 1;
  if (waitFor === "focus") return !open && !surfaces && focus;
  return {open, surfaces, focus};
}

async function frames(page, n) {
  await page.evaluate(n => new Promise(done => {let k = 0; const f = () => ++k >= n ? done() : requestAnimationFrame(f); requestAnimationFrame(f);}), n);
}

async function settleClosed(page, {keys = true} = {}) {
  // In a dialog, Escape would close the dialog too: close the menus directly.
  if (keys) for (let i = 0; i < 3; i++) await page.keyboard.press("Escape");
  await page.evaluate(() => { globalThis.AtriumContextMenu?.close?.(false, true); globalThis.AtriumSelectPopup?.close?.(false); });
  const menus = ".work-menu[open] > .menu-items, .nav-menu, .ui-select-list";
  await page.locator(`:is(${menus}):not([inert], [inert] *):visible`).first().waitFor({state:"hidden"});
}

async function boot(browser, profile, beforeOpen) {
  const context = await browser.newContext({viewport:{width:1400, height:900}, reducedMotion:"reduce", hasTouch:!!profile.touch});
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", error => errors.push(error.message));
  page.setDefaultTimeout(8000);
  if (profile.webkit) await page.addInitScript(webkitFocus);
  await beforeOpen?.(page);
  await page.goto(pathToFileURL(path.join(APP, "index.html")).href);
  const demo = page.locator("dialog.sp-dialog[open]").getByRole("button", {name:"Try the Demo", exact:true});
  await demo.waitFor(); await demo.click();
  await page.locator("#doc-name", {hasText:"Sensor board"}).waitFor();
  await page.locator("dialog.sp-dialog[open]").waitFor({state:"hidden"});
  await page.locator(".layer-menu-button").click({trial:true});
  return {context, page, errors};
}

async function fileMenuFocus(browser) {
  for (const touch of [false, true]) {
    let release;
    const held = new Promise(resolve => {release = resolve;});
    const {context, page, errors} = await boot(browser, {webkit:true, touch}, page => page.route("**/context-menu.js", async route => {
      await held;
      await route.continue().catch(() => {});
    }));
    try {
      const file = page.locator('details[data-menu="file"] > summary');
      const press = () => touch ? file.tap() : file.click();
      await press();
      assert.equal(await file.getAttribute("aria-expanded"), "true");
      assert.equal(await page.evaluate(() => !!globalThis.AtriumContextMenu), false, "the lazy menu module is still held");
      await page.keyboard.press("Escape");
      assert.equal(await file.getAttribute("aria-expanded"), "false", "Escape closes File on its first open");
      assert.ok(await file.evaluate(node => node === document.activeElement), "Escape gives focus back to File");
      await press();
      assert.equal(await file.getAttribute("aria-expanded"), "true");
      await press();
      await frames(page, 10);
      assert.equal(await file.getAttribute("aria-expanded"), "false", "the second press closes File and it stays closed");
      assert.deepEqual(errors, []);
    } finally {
      release();
      await context.close();
    }
  }
  console.log("PASS cold File menu focus, Escape and repeated presses with mouse and touch");
}

// Press a button twice: the first press opens its menu, the second closes it for good.
async function pressTwice(page, profile, t, failures) {
  // Press where the user pressed the first time: a select's list may now cover its field, as on the Mac.
  if (!await page.evaluate(retag, t)) return false;
  const node = page.locator('[data-menu-probe="' + t.probe + '"]');
  await node.click({trial:true, timeout:3000});
  const box = await node.boundingBox(), x = box.x + box.width / 2, y = box.y + box.height / 2;
  const press = () => profile.touch ? page.touchscreen.tap(x, y) : page.mouse.click(x, y);
  const before = await page.evaluate(stateOf, t.probe);
  await press();
  // Some discovered controls are valid press targets but do not open menus by default.
  const opened = await page.waitForFunction(stateOf, {probe:t.probe, waitFor:"open", before:before.surfaces}, {timeout:200}).catch(error => {
    if (error.name !== "TimeoutError") throw error;
    return false;
  });
  if (!opened) return false;
  await press();
  const samples = [];
  for (let k = 0; k < 6; k++) { await frames(page, 2); samples.push(await page.evaluate(stateOf, t.probe)); }
  await page.waitForTimeout(250); // Observe delayed reopening after the per-frame samples.
  samples.push(await page.evaluate(stateOf, t.probe));
  const reopened = samples.findIndex(s => s.open || s.surfaces > before.surfaces);
  if (reopened >= 0) failures.push(profile.name + ": " + t.label + " (" + t.key + ") is open again " + (reopened + 1) + " samples after its second press");
  return true;
}

// Escape closes the menu and the keyboard returns to its button.
async function escapeCloses(page, t, failures) {
  const node = page.locator('[data-menu-probe="' + t.probe + '"]');
  assert.ok(await page.evaluate(retag, t), "ready to press " + t.label);
  await node.click({timeout:3000});
  await page.waitForFunction(stateOf, {probe:t.probe, waitFor:"open", before:0});
  await page.keyboard.press("Escape");
  await page.waitForFunction(stateOf, {probe:t.probe, waitFor:"focus"});
  const after = await page.evaluate(stateOf, t.probe);
  if (after.open) failures.push("Escape leaves " + t.label + " (" + t.key + ") open");
  else if (!after.focus) failures.push("Escape on " + t.label + " (" + t.key + ") does not return focus to its button");
}

async function sweep(page, profile, scope, seen, failures, stats) {
  const triggers = await page.evaluate(tagTriggers, {within:scope, selects:!profile.touch});
  for (const t of triggers) {
    if (seen.has(t.key)) continue;
    seen.add(t.key);
    try {
      if (await pressTwice(page, profile, t, failures)) stats.menus++;
      await settleClosed(page, {keys:!scope});
      if (scope) await page.locator(scope).waitFor();
    } catch (error) {
      failures.push(profile.name + ": " + t.label + " (" + t.key + "): " + error.message.split("\n")[0]);
      await settleClosed(page, {keys:!scope});
    }
  }
}

async function profileRun(browser, profile) {
  const {context, page, errors} = await boot(browser, profile);
  const failures = [], seen = new Set(), stats = {menus:0};
  try {
    // The board editor with the docked panels that carry header menus.
    await sweep(page, profile, null, seen, failures, stats);
    for (const [action, id] of [["messages", "messages"], ["nets-panel", "nets"], ["library-panel", "library"], ["comments-panel", "comments"]]) {
      const wasOpen = await page.evaluate(id => !!globalThis.AtriumDock?.panels().find(p => p.id === id)?.open, id);
      await page.evaluate(a => globalThis.AtriumNavHost.act(a), action);
      await page.waitForFunction(({id, wasOpen}) => !!globalThis.AtriumDock?.panels().find(p => p.id === id)?.open !== wasOpen, {id, wasOpen});
      if (!wasOpen) await page.locator(`[data-dock-panel="${id}"]`).waitFor();
      await sweep(page, profile, null, seen, failures, stats);
    }
    // The schematic editor.
    await page.locator('#document-tabs [data-kind="schematic"]').first().click();
    await page.locator("#doc-name", {hasText:"Analog front end"}).waitFor();
    await sweep(page, profile, null, seen, failures, stats);
    // Dialogs: Preferences and Release.
    for (const open of [async () => { await AtriumLazy.need("AtriumPrefs"); AtriumPrefs.open("general"); }, () => AtriumNavHost.act("output-jobs")]) {
      await page.evaluate(open);
      const dialog = page.locator("dialog[open]").last();
      await dialog.locator("button:enabled").first().click({trial:true});
      const scope = await dialog.evaluate(d => { d.dataset.menuScope = "1"; return "dialog[data-menu-scope]"; });
      await sweep(page, profile, scope, seen, failures, stats);
      await page.keyboard.press("Escape");
      await page.locator("dialog[data-menu-scope][open]").waitFor({state:"detached"}).catch(() => page.evaluate(() => document.querySelector("dialog[data-menu-scope]")?.close()));
      await page.evaluate(() => document.querySelector("dialog[data-menu-scope]")?.removeAttribute("data-menu-scope"));
    }
    assert.ok(stats.menus >= 15, profile.name + ": the sweep reached the menu buttons (" + stats.menus + ")");
    assert.deepEqual(failures, [], profile.name + ": every menu button toggles its menu");
    assert.deepEqual(errors, [], profile.name + ": no page errors");
  } finally {
    await context.close();
  }
  return stats.menus;
}

// Escape, switching, and the panel toggles: with the mouse as WebKit handles it.
async function details(browser) {
  const profile = {name:"mouse (WebKit focus)", webkit:true};
  const {context, page, errors} = await boot(browser, profile);
  const failures = [];
  try {
    const triggers = await page.evaluate(tagTriggers, {within:null, selects:false});
    const pick = key => triggers.find(t => t.key.includes(key));
    for (const key of ["|File", "|Add to Sensor interface", "|Project actions", "dock-tab-more", "layer-menu-button"]) {
      const t = pick(key); assert.ok(t, "a menu button matching " + key);
      await escapeCloses(page, t, failures);
      await settleClosed(page);
    }
    // A press on another menu button switches menus: the first closes, the second opens.
    for (const [a, b] of [["|Add to Sensor interface", "|Project actions"], ["|Project actions", "dock-tab-more"]]) {
      const ta = pick(a), tb = pick(b);
      assert.ok(await page.evaluate(retag, ta), "ready to press " + ta.label);
      await page.locator('[data-menu-probe="' + ta.probe + '"]').click();
      await page.waitForFunction(stateOf, {probe:ta.probe, waitFor:"open", before:0});
      assert.ok(await page.evaluate(retag, tb), "ready to press " + tb.label);
      await page.locator('[data-menu-probe="' + tb.probe + '"]').click();
      await page.waitForFunction(stateOf, {probe:tb.probe, waitFor:"switched"});
      const [sa, sb] = [await page.evaluate(stateOf, ta.probe), await page.evaluate(stateOf, tb.probe)];
      assert.ok(!sa.open && sb.open && sb.surfaces === 1, "pressing " + tb.label + " while " + ta.label + " is open switches menus");
      await settleClosed(page);
    }
    // Panel toggles: each Window › Panels command and the Problems count close an open panel for good.
    const isOpen = id => page.evaluate(id => !!globalThis.AtriumDock.panels().find(p => p.id === id)?.open, id);
    for (const [action, id] of [["messages", "messages"], ["nets-panel", "nets"], ["library-panel", "library"], ["pcb-list", "pcb-list"],
      ["navigator-panel", "navigator"], ["query-panel", "filter"], ["calculators", "calculators"], ["scripting-console", "scripting"]]) {
      if (await isOpen(id)) await page.evaluate(a => globalThis.AtriumNavHost.act(a), action);
      await page.evaluate(a => globalThis.AtriumNavHost.act(a), action);
      await page.waitForFunction(id => globalThis.AtriumDock.panels().find(p => p.id === id)?.open, id);
      await page.evaluate(a => globalThis.AtriumNavHost.act(a), action);
      for (let k = 0; k < 5; k++) { await frames(page, 2); assert.equal(await isOpen(id), false, action + " closes its open panel and it stays closed"); }
    }
    const problems = page.locator("#status-problems");
    await problems.click();
    await page.waitForFunction(() => globalThis.AtriumMessages?.isOpen?.());
    await problems.click();
    for (let k = 0; k < 5; k++) { await frames(page, 2); assert.equal(await isOpen("messages"), false, "a second press on the Problems count closes Messages"); }
    await problems.click();
    await page.waitForFunction(() => globalThis.AtriumMessages?.isOpen?.());
    assert.deepEqual(failures, [], "Escape closes each menu and returns focus to its button");
    assert.deepEqual(errors, [], "no page errors");
  } finally {
    await context.close();
  }
}

async function keyboardThenPointer(browser) {
  const {context, page, errors} = await boot(browser, {name:"keyboard then mouse"});
  try {
    await page.evaluate(async () => {
      await AtriumLazy.need("AtriumPolygonPour");
      const host = AtriumNavHost, board = host.doc();
      const pour = AtriumPolygonPour.make([[4,4],[8,4],[8,8],[4,8]], {layer:"Top", net:"GND"});
      host.edit(() => board.items.push(pour));
      await host.act("pour-manager");
    });
    const trigger = page.getByRole("button", {name:"More pour actions"});
    await trigger.focus();
    await page.keyboard.press("Enter");
    const menu = page.getByRole("menu", {name:"More pour actions"});
    const choices = menu.locator(".nav-menu-item:not(:disabled)");
    await choices.first().and(page.locator(":focus-visible")).waitFor();
    const next = choices.nth(1);
    await next.evaluate(row => {
      const focus = row.focus.bind(row);
      let calls = 0;
      row.focus = options => {
        row.dataset.focusCalls = String(++calls);
        focus(options);
      };
    });
    await next.hover();
    const states = await choices.evaluateAll(rows => rows.map(row => ({
      focused: row === document.activeElement,
      highlighted: getComputedStyle(row).backgroundColor !== "rgba(0, 0, 0, 0)"
    })));
    assert.deepEqual(states.map(row => row.highlighted), states.map((_, index) => index === 1),
      "only the row under the pointer is highlighted after keyboard opening");
    assert.ok(states[1].focused, "keyboard navigation continues from the pointer row");
    const box = await next.boundingBox();
    await page.mouse.move(box.x + box.width / 2 + 8, box.y + box.height / 2, {steps:4});
    assert.equal(await next.getAttribute("data-focus-calls"), "1", "moving within a focused row does not refocus it");
    await page.keyboard.press("Escape");
    await menu.waitFor({state:"hidden"});
    await trigger.and(page.locator(":focus")).waitFor();
    assert.deepEqual(errors, []);
  } finally {
    await context.close();
  }
  console.log("PASS action-menu focus follows the mouse after keyboard opening");
}

module.exports = async function menuToggle(browser) {
  if (process.argv.includes("--file-focus-only")) { await fileMenuFocus(browser); return; }
  await keyboardThenPointer(browser);
  if (process.argv.includes("--pointer-focus-only")) return;
  await fileMenuFocus(browser);
  const counts = [];
  for (const profile of PROFILES) counts.push(profile.name + " " + await profileRun(browser, profile));
  await details(browser);
  console.log("menu toggle: ok (" + counts.join(", ") + " menu buttons)");
};

if (require.main === module) {
  require("../support/standalone-chromium.cjs")(
    () => {
      const at = process.argv.indexOf("--executable");
      return {headless:true, ...(at > 0 ? {executablePath:process.argv[at + 1]} : {channel:"chrome"})};
    },
    browser => module.exports(browser),
    error => { console.error(error); process.exit(1); });
}
