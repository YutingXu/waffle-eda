"use strict";

// Nothing draws under the window controls (docs/ui-library.md, Window safe area).
// The macOS host draws the page under a transparent title bar (native/macos/main.swift); this
// test simulates it (a 28 px caption, traffic lights in the first 78 px). With --windows it loads
// the page as the Windows host does instead, with the caption Waffle draws there
// (native/windows/window-caption.js; the window controls at the top right). It then opens every
// surface it can reach generically: every action in the headless inventory
// (docs/headless-parity.json) plus every runtime menu, palette and keymap action, in the
// schematic and the board editor; every menu-bar menu and submenu; the canvas, object, project
// and document-tab context menus; the command bar; a toast; and the app-bar tooltips. It runs in a
// roomy window and in the smallest one the macOS host allows, where popovers run out of room. After each one it checks that
//   - no visible element outside a title-bar row (the app bar, a full-window surface's
//     .ui-fullwindow-bar, or the caption Waffle draws on Windows) has a box inside the caption band, and
//   - nothing at all, title-bar rows' own content included, sits on the traffic lights.
// Boxes are clipped by their scroll containers; hit testing over the band also catches
// pseudo-elements. A modal dialog's ::backdrop may tint the band (it carries no content).
// Actions that would replace the project, leave the page or need a native-only path are skipped
// by name below; actions that reach a file chooser or save panel are stubbed and listed.
// Run: node tests/editor/browser-titlebar-safe-area.cjs [--windows] [--only action,action] [--viewport 770x500] [--verbose]
// (NODE_PATH for Playwright Core, CHROME for a Chromium binary).
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const {pathToFileURL} = require("node:url");

const ROOT = path.join(__dirname, "../..");
const CAPTION = 28, LIGHTS = 78;
const WINDOWS_CAPTION = fs.readFileSync(path.join(ROOT, "native/windows/window-caption.js"), "utf8");

// Skipped by name, with the reason. Everything else in the inventory runs.
const SKIP = {
  "new": "replaces the project with an empty one",
  "new-from-template": "replaces the project",
  "open": "native file chooser, then replaces the project",
  "close-project": "closes the project",
  "recover": "replaces the project from autosave",
  "quick-open": "opens another project",
  "reopen-document": "reopens from the native file system",
  "reveal-project": "native-only (Finder)",
  "git-merge-driver": "native-only (installs a Git driver)",
  "check-updates": "network only; its notice is a status-bar line",
  "component-stress": "a stress generator that fills the board for minutes",
  "autoroute-all": "runs the autorouter for the whole board (minutes)",
  "autoplace-proposal": "runs the placer for the whole board",
  "close-document": "closes the active document (the next actions need it)",
  "crash-diagnostics": "writes a crash report and reloads",
  "context-menu": "needs a pointer position; the context menus are opened below",
  "command-bar": "covered below by the opened command bar",
  "command-palette": "covered below by the opened command bar",
};
// Parameter families (camera-pan-, selmem-add-…) run through their numbered members.
const FAMILY = /-$/;

function inventory() {
  const json = JSON.parse(fs.readFileSync(path.join(ROOT, "docs/headless-parity.json"), "utf8"));
  return json.actions.map(a => a.action);
}

// In-page: the caption check and the action runner. Installed once per page.
function install() {
  const root = document.documentElement;
  const px = name => parseFloat(getComputedStyle(root).getPropertyValue(name)) || 0;
  const meet = (a, b) => a.l < b.r && a.r > b.l && a.t < b.b && a.b > b.t;
  const cut = (a, b) => ({l:Math.max(a.l, b.l), t:Math.max(a.t, b.t), r:Math.min(a.r, b.r), b:Math.min(a.b, b.b)});
  const box = r => ({l:r.left, t:r.top, r:r.right, b:r.bottom});
  const name = el => {
    let s = el.tagName.toLowerCase();
    if (el.id) s += "#" + el.id;
    for (const c of [...el.classList].slice(0, 3)) s += "." + c;
    const text = (el.getAttribute("aria-label") || el.textContent || "").trim().replace(/\s+/g, " ").slice(0, 40);
    return text ? s + " “" + text + "”" : s;
  };
  // A fixed element escapes its ancestors' clipping unless one of them is its containing block.
  const containing = cs => cs.transform !== "none" || cs.filter !== "none" || cs.perspective !== "none" ||
    /paint|layout|strict|content/.test(cs.contain) || /transform|filter/.test(cs.willChange);
  function visibleBox(el, rect) {
    let b = box(rect), escapes = getComputedStyle(el).position === "fixed" || el.matches(":modal, :popover-open");
    if (el.matches(":modal, :popover-open")) return b;
    for (let p = el.parentElement; p && p !== document.body && p !== root; p = p.parentElement) {
      const cs = getComputedStyle(p);
      if (p.matches(":modal, :popover-open")) { if (!escapes) b = cut(b, box(p.getBoundingClientRect())); break; }
      if (escapes) { if (containing(cs)) escapes = false; else continue; }
      if (cs.overflowX !== "visible" || cs.overflowY !== "visible") b = cut(b, box(p.getBoundingClientRect()));
      if (b.r <= b.l || b.b <= b.t) return null;
      if (cs.position === "fixed") escapes = !containing(cs);
    }
    return b.r > b.l && b.b > b.t ? b : null;
  }
  function check() {
    const caption = px("--window-caption-height"), W = innerWidth;
    if (!caption) return [];
    const band = {l:0, t:0, r:W, b:caption};
    // The macOS traffic lights (left or right inset), or the window controls Waffle draws on Windows.
    const drawn = document.querySelector(".window-controls");
    const lights = [{l:0, t:0, r:px("--macos-caption-inset"), b:caption}, {l:W - px("--macos-caption-right-inset"), t:0, r:W, b:caption},
      ...(drawn?.checkVisibility() ? [box(drawn.getBoundingClientRect())] : [])].filter(z => z.r > z.l);
    const bars = [...document.querySelectorAll(".appbar, .ui-fullwindow-bar")];
    const holds = el => bars.some(b => el === b || el.contains(b)) || el.matches(".ui-fullwindow") || !!el.closest(".window-caption");
    const out = new Map(), flagged = [];
    // Report the outermost offending element of each surface.
    const flag = (el, b, where) => {
      if (flagged.some(f => f.contains(el))) return;
      flagged.push(el);
      const k = name(el); if (!out.has(k)) out.set(k, where + " " + JSON.stringify([b.l, b.t, b.r, b.b].map(Math.round)));
    };
    for (const el of document.body.querySelectorAll("*")) {
      const rect = el.getBoundingClientRect();
      if (rect.top >= caption || rect.width <= 0 || rect.height <= 0 || !meet(box(rect), band)) continue;
      if (holds(el) || el.closest("[hidden], template, head")) continue;
      if (!el.checkVisibility({opacityProperty:true, visibilityProperty:true})) continue;
      const b = visibleBox(el, rect);
      if (!b || !meet(b, band)) continue;
      const bar = bars.find(r => r.contains(el));
      if (bar) { if (lights.some(z => meet(b, z))) flag(el, cut(b, band), "on the window controls"); }
      else flag(el, cut(b, band), "in the title bar");
    }
    // Hit testing catches pseudo-elements and painted overflow that boxes miss.
    for (let y = 1; y < caption; y += Math.max(1, Math.floor((caption - 2) / 3))) for (let x = 1; x < W; x += 6) {
      const top = document.elementFromPoint(x, y);
      if (!top || top === root || top === document.body) continue;
      const onLights = lights.some(z => x >= z.l && x < z.r);
      if (top.matches(":modal") && !meet({l:x, t:y, r:x + 1, b:y + 1}, box(top.getBoundingClientRect()))) continue; // ::backdrop
      if (holds(top)) continue;
      const bar = bars.find(r => r.contains(top));
      if (bar && !onLights) continue;
      flag(top, {l:x, t:y, r:x + 1, b:y + 1}, onLights ? "hit on the window controls at" : "hit in the title bar at");
    }
    return [...out].map(([k, v]) => k + " " + v);
  }

  const frame = () => new Promise(r => requestAnimationFrame(r));
  const frames = () => frame().then(frame);
  let pickers = [];
  // File choosers, save panels and print are native; record and resolve them with nothing.
  HTMLInputElement.prototype.showPicker = function () { if (this.type === "file") pickers.push("file chooser"); };
  const click = HTMLInputElement.prototype.click;
  HTMLInputElement.prototype.click = function () { if (this.type === "file") pickers.push("file chooser"); else click.call(this); };
  window.print = () => pickers.push("print");
  window.open = () => { pickers.push("new browser window"); return null; };
  const stub = (o, k, tag) => { if (o && typeof o[k] === "function") o[k] = () => { pickers.push(tag); return Promise.resolve(null); }; };
  for (const k of ["pickFile", "pickFiles", "openFile"]) stub(globalThis.AtriumIO, k, "file chooser");
  for (const k of ["exportFile", "exportBinaryCopy", "save", "download"]) stub(globalThis.AtriumIO, k, "save panel");
  stub(globalThis.AtriumHost, "open", "file chooser");
  if ("showOpenFilePicker" in globalThis) globalThis.showOpenFilePicker = async () => { pickers.push("file chooser"); throw new DOMException("", "AbortError"); };
  if ("showSaveFilePicker" in globalThis) globalThis.showSaveFilePicker = async () => { pickers.push("save panel"); throw new DOMException("", "AbortError"); };
  if ("showDirectoryPicker" in globalThis) globalThis.showDirectoryPicker = async () => { pickers.push("folder chooser"); throw new DOMException("", "AbortError"); };
  const host = () => globalThis.AtriumNavHost;
  const original = host().project();

  function settle() {
    for (const d of document.querySelectorAll("dialog[open]")) {
      try { d.dispatchEvent(new KeyboardEvent("keydown", {key:"Escape", bubbles:true, cancelable:true})); if (d.open) d.close(); } catch {}
    }
    for (const d of document.querySelectorAll("details[open]")) d.open = false;
    for (const p of document.querySelectorAll(":popover-open")) try { p.hidePopover(); } catch {}
    globalThis.AtriumContextMenu?.close?.(false);
    for (const n of document.querySelectorAll('[role="dialog"]:not(dialog), .ui-fullwindow')) if (n.isConnected && n.getClientRects().length)
      n.dispatchEvent(new KeyboardEvent("keydown", {key:"Escape", bubbles:true}));
    globalThis.AtriumUIGallery?.unmount?.();
    document.getElementById("canvas")?.dispatchEvent(new KeyboardEvent("keydown", {key:"Escape", code:"Escape", bubbles:true}));
    try { host().act("select"); } catch {}
  }
  async function selectEditor(kind) {
    if (host().project() !== original && !host().project()?.documents?.some(d => d.kind === kind))
      await host().replaceProject(original, {force:true, dirty:false});
    const doc = host().project().documents.find(d => d.kind === kind);
    if (doc && host().doc()?.id !== doc.id) host().selectDocument(doc.id);
  }
  async function run(action) {
    pickers = [];
    const cmds = globalThis.AtriumKeymap?.commands?.() || [];
    const button = document.querySelector('.menubar [data-action="' + action + '"]'), cmd = cmds.find(c => c.action === action && c.run);
    let error = null;
    try {
      const need = globalThis.AtriumLazy.forAction(action, host().doc()?.kind);
      if (need) await globalThis.AtriumLazy.need(need);
      if (button && !button.disabled) button.click();
      else if (cmd) cmd.run(cmd.param);
      else window.dispatchEvent(new CustomEvent("atrium-command", {detail:action}));
    } catch (e) { error = String(e?.message || e); }
    const deadline = performance.now() + 2000;
    while (/^Loading/.test(document.getElementById("status")?.textContent || "") && performance.now() < deadline) await frame();
    await frames();
    return {pickers:[...new Set(pickers)], error};
  }
  // One round trip per action: open it, check the band, close it again.
  async function step(kind, action) {
    await selectEditor(kind);
    const result = await run(action);
    let found;
    try { found = check(); } catch (e) { found = ["check failed: " + e.message]; }
    settle();
    return {...result, found};
  }
  function actions(kind) {
    const out = new Set();
    for (const b of document.querySelectorAll(".work-menu .menu-items [data-action]")) out.add(b.dataset.action);
    for (const e of globalThis.AtriumPalette?.entries?.(">") || []) {
      const id = e.key.replace(/^(cmd|menu):/, ""), c = e.key.startsWith("cmd:") ? globalThis.AtriumKeymap.command(id) : null;
      out.add(c ? c.action : id);
    }
    for (const c of globalThis.AtriumKeymap?.commands?.() || []) out.add(c.action);
    for (const a of globalThis.AtriumLazy?.actions?.() || []) out.add(a);
    return [...out].filter(a => typeof a === "string" && a);
  }
  globalThis.__titlebar = {check, run, step, settle, selectEditor, actions, frames};
}

async function openApp(browser, viewport, platform) {
  const context = await browser.newContext({viewport, reducedMotion:"reduce", acceptDownloads:false});
  if (platform === "windows") {
    // As the Windows host loads the page (MainWindow.StartWebView): its message channel, then the caption script.
    await context.addInitScript(() => {
      window.chrome = {webview:{postMessage:() => {}}};
      window.__waffleWindowCaptionState = {maximized:false, active:true, fullScreen:false};
    });
    await context.addInitScript(WINDOWS_CAPTION);
  }
  await context.route(/^https?:/, route => route.abort());
  const page = await context.newPage();
  context.on("page", other => { if (other !== page) other.close().catch(() => {}); });
  page.setDefaultTimeout(10000);
  const errors = [];
  page.on("pageerror", error => errors.push(error.message));
  page.on("dialog", dialog => dialog.dismiss().catch(() => {}));
  page.on("filechooser", () => {});
  await page.clock.install();
  await page.goto(pathToFileURL(path.join(ROOT, "app/index.html")).href);
  await page.waitForFunction(() => globalThis.AtriumNavHost && globalThis.AtriumLazy);
  await page.locator("dialog.sp-dialog[open] [data-start-action=demo]").click();
  await page.locator("#doc-name", {hasText:"Sensor board"}).waitFor();
  // The values the macOS host publishes (native/macos/main.swift installCaptionScript).
  if (platform !== "windows") await page.evaluate(([caption, lights]) => {
    const root = document.documentElement;
    root.dataset.atriumNativeTitlebar = "macos";
    root.style.setProperty("--macos-caption-inset", lights + "px");
    root.style.setProperty("--macos-caption-right-inset", "0px");
    root.style.setProperty("--macos-caption-height", caption + "px");
  }, [CAPTION, LIGHTS]);
  return {context, page, errors};
}

async function loadEverything(page) {
  await page.evaluate(async () => {
    const L = globalThis.AtriumLazy, skip = new Set(["AtriumExtensions"]);
    for (const n of L.modules()) { if (skip.has(n)) continue; try { await L.need(n); } catch {} }
    await AtriumNavHost.prepareLaunch();
    for (const d of document.querySelectorAll("dialog[open]")) try { d.close(); } catch {}
  });
}

// Every action in the inventory and on the live menus, in the schematic and the board editor.
async function sweepActions(page, problems, report, only) {
  const listed = inventory();
  for (const kind of ["schematic", "pcb"]) {
    await page.evaluate(kind => __titlebar.selectEditor(kind), kind);
    const live = await page.evaluate(kind => __titlebar.actions(kind), kind);
    const all = [...new Set([...listed, ...live])].filter(a => !only || only.includes(a)).sort();
    for (const action of all) {
      if (SKIP[action]) { report.skipped.set(action, SKIP[action]); continue; }
      if (FAMILY.test(action)) { report.skipped.set(action, "parameter family; its numbered members run"); continue; }
      const t0 = Date.now();
      const result = await page.evaluate(([kind, action]) => __titlebar.step(kind, action), [kind, action])
        .catch(error => ({pickers:[], found:["action failed: " + error.message.split("\n")[0]]}));
      if (result.pickers.length) report.pickers.set(action, result.pickers.join(", "));
      for (const f of result.found) problems.add(`${action} (${kind}): ${f}`);
      report.ran++;
      if (report.verbose) console.log(`  ${kind} ${action} ${Date.now() - t0} ms${result.found.length ? " ✗ " + result.found.length : ""}`);
    }
  }
}

// Every menu-bar menu and submenu, the context menus, the command bar, a toast and the tooltips.
async function sweepChrome(page, problems, report) {
  const check = async what => {
    for (const f of await page.evaluate(() => __titlebar.check())) problems.add(`${what}: ${f}`);
    report.ran++;
  };
  await page.evaluate(() => { __titlebar.settle(); return __titlebar.selectEditor("pcb"); });
  const menus = await page.locator(".menubar .work-menu > summary:visible").count();
  assert.ok(menus >= 5, "the menu bar has its menus");
  for (let i = 0; i < menus; i++) {
    const summary = page.locator(".menubar .work-menu > summary:visible").nth(i), label = (await summary.innerText()).trim();
    await summary.click();
    await page.evaluate(() => __titlebar.frames());
    await check(`menu ${label}`);
    const triggers = page.locator(".menubar .work-menu[open] .submenu-trigger:visible");
    for (let j = 0, n = await triggers.count(); j < n; j++) {
      const trigger = triggers.nth(j);
      await trigger.hover().catch(() => {});
      await trigger.click().catch(() => {});
      await page.evaluate(() => __titlebar.frames());
      await check(`menu ${label} › ${(await trigger.innerText().catch(() => "")).trim()}`);
    }
    await page.keyboard.press("Escape");
    await page.evaluate(() => __titlebar.settle());
  }
  // Context menus: on the canvas just below the app bar, on the project and on a document tab.
  for (const kind of ["schematic", "pcb"]) {
    await page.evaluate(kind => __titlebar.selectEditor(kind), kind);
    const canvas = await page.locator("#canvas").boundingBox();
    for (const [x, y] of [[canvas.x + 6, canvas.y + 4], [canvas.x + canvas.width - 6, canvas.y + 4], [canvas.x + canvas.width / 2, canvas.y + canvas.height - 6]]) {
      await page.mouse.click(x, y, {button:"right"});
      await page.evaluate(() => __titlebar.frames());
      await check(`${kind} canvas context menu at ${Math.round(x)},${Math.round(y)}`);
      await page.keyboard.press("Escape");
      await page.evaluate(() => __titlebar.settle());
    }
    // An object's menu is the longest; in a short window it runs out of room and moves up.
    const part = await page.evaluate(() => {
      const h = globalThis.AtriumNavHost, item = h.doc().items.find(i => i.kind === "part"), c = h.canvas().getBoundingClientRect();
      if (!item) return null;
      const s = h.view().worldToScreen([item.x, item.y]);
      return [c.left + s[0], c.top + s[1]];
    });
    if (!part) { report.skipped.set(`${kind} object context menu`, "the demo has no part here"); continue; }
    await page.mouse.click(part[0], part[1], {button:"right"});
    await page.evaluate(() => __titlebar.frames());
    await check(`${kind} object context menu`);
    await page.keyboard.press("Escape");
    await page.evaluate(() => __titlebar.settle());
  }
  for (const [what, selector] of [["project context menu", ".project-tree summary"], ["document tab context menu", "#document-tabs [data-tab]"]]) {
    const target = page.locator(selector + ":visible").first();
    if (!await target.count()) { report.skipped.set(what, "not visible in this layout"); continue; }
    await target.click({button:"right"});
    await page.evaluate(() => __titlebar.frames());
    await check(what);
    await page.keyboard.press("Escape");
    await page.evaluate(() => __titlebar.settle());
  }
  await page.evaluate(() => { globalThis.AtriumNavHost.canvas().focus(); });
  await page.keyboard.press(process.platform === "darwin" ? "Meta+Shift+P" : "Control+Shift+P");
  await page.evaluate(() => __titlebar.frames());
  await check("command bar");
  await page.evaluate(() => __titlebar.settle());
  await page.evaluate(() => globalThis.AtriumToast.show("Caption check", {kind:"info"}));
  await page.evaluate(() => __titlebar.frames());
  await check("toast");
  for (const button of await page.locator(".appbar [title]:visible, .appbar [data-tooltip]:visible").all()) {
    await button.hover().catch(() => {});
    await page.clock.runFor(700);
    await check(`tooltip on ${await button.getAttribute("aria-label") || await button.getAttribute("title") || "app bar control"}`);
  }
  await page.mouse.move(700, 500);
}

// A roomy window and the smallest one the macOS host allows (window.minSize), where the app bar
// collapses and menus and popovers run out of room.
const VIEWPORTS = [{width:1440, height:900}, {width:770, height:500}];

async function titlebarSafeArea(browser, options = {}) {
  const problems = [];
  for (const viewport of options.viewports || VIEWPORTS) problems.push(...await sweep(browser, viewport, options));
  assert.deepEqual(problems, [], options.platform === "windows" ? "Surfaces drawn under the caption Waffle draws on Windows"
    : `Surfaces drawn under the macOS title bar (${CAPTION} px caption, window controls in the first ${LIGHTS} px)`);
  console.log("ok titlebar safe area" + (options.platform === "windows" ? " (Windows)" : ""));
}

async function sweep(browser, viewport, options) {
  const started = Date.now();
  const {context, page, errors} = await openApp(browser, viewport, options.platform);
  const problems = new Set(), report = {ran:0, skipped:new Map(), pickers:new Map(), verbose:!!options.verbose};
  try {
    await loadEverything(page);
    await page.evaluate(install);
    const rest = await page.evaluate(() => __titlebar.check());
    assert.deepEqual(rest, [], "the app at rest keeps the caption band to the app bar");
    await sweepActions(page, problems, report, options.only);
    if (!options.only) await sweepChrome(page, problems, report);
  } finally { await context.close(); }
  const where = options.platform === "windows" ? `${viewport.width}×${viewport.height}, Windows caption`
    : `${viewport.width}×${viewport.height}, ${CAPTION} px caption, window controls in the first ${LIGHTS} px`;
  console.log(`titlebar safe area (${where}): ${report.ran} surfaces checked in ${Math.round((Date.now() - started) / 1000)} s`);
  console.log(`  skipped by name: ${[...report.skipped].map(([a, why]) => a + " (" + why + ")").join("; ")}`);
  if (report.pickers.size) console.log(`  reached a native picker (stubbed; the surface before it was checked): ${[...report.pickers].map(([a, p]) => a + " → " + p).join("; ")}`);
  if (errors.length && options.verbose) console.log(`  page errors while sweeping (not a failure here): ${[...new Set(errors)].slice(0, 10).join(" | ")}`);
  return [...problems].map(p => `${viewport.width}×${viewport.height} ${p}`);
}

module.exports = titlebarSafeArea;

async function main() {
  let chromium;
  try { ({chromium} = require("playwright-core")); }
  catch { console.log("SKIP titlebar safe area: Playwright Core is unavailable."); return; }
  const executablePath = process.env.CHROME;
  const browser = await chromium.launch({headless:true, args:["--allow-file-access-from-files"], ...(executablePath ? {executablePath} : {channel:"chrome"})});
  const at = process.argv.indexOf("--only"), size = process.argv.indexOf("--viewport");
  const viewports = size < 0 ? undefined : [process.argv[size + 1].split("x").map(Number)].map(([width, height]) => ({width, height}));
  try { await titlebarSafeArea(browser, {viewports, platform:process.argv.includes("--windows") ? "windows" : "macos",
    verbose:process.argv.includes("--verbose"), only:at < 0 ? null : process.argv[at + 1].split(",")}); }
  finally { await browser.close(); }
}

if (require.main === module) main().catch(error => { console.error(error); process.exitCode = 1; });
