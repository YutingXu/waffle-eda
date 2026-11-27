"use strict";

// Real Chromium layout checks. Run with NODE_PATH for Playwright Core and CHROME if needed.
const assert = require("node:assert/strict");
const {execFileSync} = require("node:child_process");
const fs = require("node:fs/promises");
const path = require("node:path");
const {pathToFileURL} = require("node:url");
const {chromium} = require("../support/playwright.cjs");
const G = require("../support/dialog-geometry.cjs");
const {fieldCoverage} = require("../support/field-coverage.cjs");
const {cases} = require("../support/dialog-geometry-fixtures.cjs");

const root = path.join(__dirname, "../..");
const profiles = [
  {id:"light", theme:"light", platform:"MacIntel", chord:"Ctrl+Alt+Shift+Meta+P", visible:"⌃⌥⇧⌘P", touch:false},
  {id:"dark", theme:"dark", platform:"Win32", chord:"Ctrl+Shift+P", visible:"Ctrl+Shift+P", touch:false},
  {id:"touch", theme:"light", platform:"Win32", chord:"Ctrl+Shift+P", visible:"Ctrl+Shift+P", touch:true},
];
const surfaces = '[data-geometry-surface]';
const modal = 'dialog[open]:visible';
const fixtureGroups = ["core", "native", "library", "canvas", "extensions", "review", "pcb-tools", "notebook", "automation", "workflows"];
const platformPanels = [
  {platform:"macOS", source:"native/macos/main.swift", flow:"Native save confirmation, imported first Save, stale member decision and system file/directory pickers"},
  {platform:"Linux", source:"native/linux/waffle.py", flow:"GTK confirmation and system file/directory pickers"},
  {platform:"Windows", source:"native/windows/src/Win/MainWindow.cs", flow:"System file/directory pickers"},
  {platform:"Windows", source:"native/windows/src/Win/Dialogs.cs", flow:"Native confirmation and recovery dialogs"},
].map(panel => ({...panel, status:"native-only", evidence:"OS-owned panel, outside Chromium app markup"}));
const macNetworkWorkflow = {source:"app/project/collab-presence.js", action:"Explain macOS local network permission before starting",
  platform:"MacIntel", unavailableOn:"Win32",
  reason:"explainLocalNetwork() returns immediately unless navigator.platform identifies a Mac. The subsequent system permission is owned by macOS."};

function argument(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : null;
}

function inventory() {
  const declarations = execFileSync("python3", ["-B", path.join(__dirname, "dialog-inventory.py"), "--json"], {encoding:"utf8"});
  return JSON.parse(declarations);
}

function matchesSite(site, surface) {
  if ((site.kind === "popover") !== (surface.kind === "popover")) return false;
  return surface.sites.some(frame => frame.source === site.source &&
    (site.template ? frame.template === site.template : frame.line === site.line));
}

function reconcile(sites, reports) {
  return sites.map(site => {
    const profiles = reports.map(({profile, dialogs}) => ({profile, surfaces:dialogs.filter(surface => matchesSite(site, surface))
      .map(({name, action, context, platform, attribution, fields, failures}) =>
        ({name, action, context, platform, attribution, fields, passed:!failures.length}))}));
    const observed = profiles.flatMap(profile => profile.surfaces);
    const status = observed.some(surface => !surface.attribution) ? "visually tested" :
      observed.length ? "direct export only" : "fixture needed";
    return {...site, status, profiles};
  });
}

async function checkpoint(file, receipt, complete) {
  if (!file) return;
  const temporary = `${file}.${process.pid}.tmp`;
  await fs.writeFile(temporary, JSON.stringify({complete, ...receipt}, null, 2) + "\n");
  await fs.rename(temporary, file);
}

async function openFixture(browser, profile) {
  const context = await browser.newContext({hasTouch:profile.touch, colorScheme:profile.theme,
    viewport:{width:1440, height:960}, reducedMotion:"reduce", acceptDownloads:false});
  const page = await context.newPage();
  page.setDefaultTimeout(5000);
  const errors = [];
  page.on("pageerror", error => errors.push(error.stack || error.message));
  page.on("dialog", dialog => dialog.dismiss());
  await context.route(/^https?:/, route => route.abort());
  await page.addInitScript(platform => {
    Object.defineProperty(navigator, "platform", {value:platform});
    Object.defineProperty(navigator, "userAgentData", {value:{platform}});
    const address = /\/app\/([\w./-]+\.js):(\d+):(\d+)/g;
    let next = 0;
    const log = window.geometrySurfaces = {}, constructors = new WeakMap();
    const frames = () => [...new Error().stack.matchAll(address)].map(([, name, line, column]) =>
      ({source:`app/${name}`, line:Number(line), column:Number(column)}));
    const observe = (element, kind) => {
      const sites = (constructors.get(element) || []).concat(frames());
      if (["palette", "library-dialog"].includes(element.id)) sites.unshift({source:"app/index.html", template:element.id});
      const sources = [...new Set(sites.map(site => site.source))];
      const id = element.dataset.geometrySurface ||= String(++next);
      log[id] = {id, kind, sources, sites};
    };
    const create = Document.prototype.createElement;
    Document.prototype.createElement = function (name, ...args) {
      const element = create.call(this, name, ...args);
      if (String(name).toLowerCase() === "dialog") constructors.set(element, frames());
      return element;
    };
    for (const name of ["show", "showModal"]) {
      const open = HTMLDialogElement.prototype[name];
      HTMLDialogElement.prototype[name] = function (...args) {
        observe(this, name === "showModal" ? "modal" : "modeless");
        return open.apply(this, args);
      };
    }
    const attribute = Element.prototype.setAttribute;
    Element.prototype.setAttribute = function (name, value) {
      if (name === "role" && value === "dialog" && this.tagName !== "DIALOG") observe(this, "popover");
      return attribute.call(this, name, value);
    };
  }, profile.platform);
  await page.goto(pathToFileURL(path.join(root, "app/index.html")).href);
  await page.waitForFunction(() => globalThis.AtriumTheme && globalThis.AtriumNavHost);
  await page.evaluate(profile => {
    AtriumTheme.set({preset:profile.theme, followSystem:false, motion:"reduce"});
  }, profile);
  assert.equal(await page.locator("html").getAttribute("data-theme"), profile.theme);
  assert.equal(await page.evaluate(() => matchMedia("(pointer: coarse)").matches), profile.touch);
  const session = await context.newCDPSession(page);
  await session.send("DOM.enable");
  return {context, page, session, errors};
}

function demoButton(page) {
  return page.locator("dialog.sp-dialog[open] [data-start-action=demo]");
}

async function ensureStartPage(page) {
  if (await page.locator("dialog.sp-dialog[open]").isVisible()) return;
  await page.evaluate(async () => {
    const start = await AtriumLazy.need("AtriumStartPage");
    if (!start.isOpen()) start.open();
  });
  await page.locator("dialog.sp-dialog[open]").waitFor();
}

async function demo(page) {
  await ensureStartPage(page);
  await demoButton(page).click();
  await page.locator("#doc-name", {hasText:"Sensor board"}).waitFor();
}

async function readyPreferences(page) {
  await page.evaluate(async () => {
    await AtriumLazy.need("AtriumPrefs");
    const names = ["AtriumRoutingPrefs", "AtriumRouteSuggest", "AtriumChecks", "AtriumInsightsUI", "AtriumCanvasGPUPref",
      "AtriumCamera", "AtriumClipHistory", "AtriumHistoryPanel", "AtriumExtensionDev", "AtriumExternalTools", "AtriumCollabPresence"];
    for (const name of names) if (AtriumLazy.modules().includes(name)) await AtriumLazy.need(name);
    AtriumPrefs.open();
  });
  await page.locator(".prf-dialog[open]").waitFor();
}

async function preferences(page, session, profile, report, save) {
  if (!await page.locator("#doc-name", {hasText:"Sensor board"}).isVisible()) await demo(page);
  await readyPreferences(page);
  const seen = new Set(), dialog = page.locator(".prf-dialog[open]"), scope = dialog.locator(".prf-page");
  const surface = (await snapshotSurfaces(page)).find(item => item.sources.includes("app/editor/prefs.js"));
  if (surface) report.dialogs.push({...surface, action:"Preferences", context:"preferences", fields:0, sections:0, failures:[]});
  const builtIn = ["general", "schematic", "pcb", "routing", "checks", "insights", "appearance", "display", "mouse", "keyboard",
    "extensions", "library", "collaboration", "labs"];
  for (const state of ["preview", "labs"]) {
    if (state === "labs") await page.evaluate(() => AtriumPrefs.set("labs.notebook", true));
    const pages = await page.evaluate(() => AtriumPrefs.pages());
    for (const entry of pages) {
      const repeat = seen.has(entry.id);
      if (repeat && !(state === "labs" && ["keyboard","mouse"].includes(entry.id))) continue;
      const button = dialog.getByRole("button", {name:entry.title, exact:true}).first();
      if (await button.isVisible()) await button.click();
      else await page.evaluate(id => { AtriumPrefs.open(id); }, entry.id);
      await scope.locator(".prf-page-body").waitFor();
      if (entry.id === "keyboard") await page.waitForFunction(() => !/Loading search preferences/.test(document.querySelector(".prf-page-body")?.textContent));
      if (entry.id === "appearance") await scope.locator(".thp-group").first().waitFor();
      assert.equal(await scope.getAttribute("data-shown"), entry.id);
      const title = scope.locator(".prf-page-title:visible");
      assert.equal(await title.count(), 1, "The selected Preferences page has one visible title.");
      assert.equal(await title.textContent(), entry.title);
      const restore = scope.getByRole("button", {name:"Restore Defaults…", exact:true});
      const quiet = await restore.evaluate(node => {
        const style = getComputedStyle(node);
        return style.backgroundColor === "rgba(0, 0, 0, 0)" && parseFloat(style.borderLeftWidth) === 0;
      });
      assert.ok(quiet, "Restore Defaults is a quiet action.");
      const renderProblems = await scope.getByText(/^This page failed to load:/).allTextContents();
      if (renderProblems.length) report.errors.push(...renderProblems.map(problem => `${entry.title}: ${problem}`));
      const items = await G.fields(page, session, scope), geometry = await G.preferenceGeometry(page);
      const textBaselines = await G.textBaselines(page, session, scope);
      const {census, metrics:coverage} = await fieldCoverage(scope,textBaselines);
      const measurements = [...G.fieldResults(items), ...G.baselineResults(textBaselines), ...coverage, ...geometry.result, ...await G.keyListGeometry(scope)];
      const visit = repeat ? (report.preferenceStates ||= []) : report.preferences;
      visit.push({id:entry.id, name:entry.title, state, fields:items.length, rows:geometry.rows, groups:geometry.groups,
        renderProblems, textBaselines, census, measurements, failures:G.failures(measurements)});
      if (surface) {
        const coverage = report.dialogs.find(item => item.id === surface.id);
        coverage.fields += items.length;
        coverage.sections += geometry.groups;
      }
      report.strays.push(...(await strayShortcuts(scope)).map(issue => ({...issue, surface:entry.title})));
      if (entry.id === "general") await preferenceMutationControls(page, session, dialog, scope, report);
      seen.add(entry.id);
      if (seen.size % 5 === 0) await save();
    }
  }
  assert.deepEqual([...seen].sort(), builtIn.sort(), "The merged Preferences navigation exposes each of the 14 real pages once.");
  assert.equal(await dialog.getByRole("button", {name:"Done", exact:true}).count(), 0, "Preferences changes apply without a Done button.");
  await appearanceSystemFields(page, session, scope, report);
  if (profile.touch) await narrowPreferences(page, session, dialog, scope, report);
  await dialog.getByRole("button", {name:"Close Preferences", exact:true}).click();
  await dialog.waitFor({state:"hidden"});
}

async function appearanceSystemFields(page, session, scope, report) {
  await page.evaluate(() => { AtriumPrefs.open("appearance"); });
  const follow = scope.getByRole("switch", {name:/^Follow the operating system/});
  const themes = scope.locator(".thp-follow");
  await follow.waitFor();
  assert.equal(await follow.isChecked(), false);
  await follow.check();
  try {
    for (const name of ["Preferred light theme","Preferred dark theme"])
      await themes.getByRole("combobox", {name, exact:true}).waitFor();
    const items = await G.fields(page, session, themes);
    const textBaselines = await G.textBaselines(page, session, themes);
    const {census, metrics:coverage} = await fieldCoverage(themes,textBaselines);
    assert.equal(textBaselines.length, 2);
    assert.ok(textBaselines.every(field => field.mode === "inline" && field.disposition === "measured"));
    const measurements = [...G.fieldResults(items), ...G.baselineResults(textBaselines), ...coverage];
    report.preferenceStates.push({id:"appearance", name:"Appearance (system themes)", state:"system-theme",
      fields:items.length, textBaselines, census, measurements, failures:G.failures(measurements)});
  } finally {
    await follow.uncheck();
  }
}

async function preferenceMutationControls(page, session, dialog, scope, report) {
  const rect = (locator, dimension) => locator.evaluate((node, key) => node.getBoundingClientRect()[key], dimension);
  const number = scope.getByRole("spinbutton", {name:"Autosave interval", exact:true});
  const stepper = number.locator("xpath=ancestor::*[contains(concat(' ',normalize-space(@class),' '),' prf-stepper ')][1]");
  const rows = scope.locator(".prf-row:has(.prf-control select)");
  const firstSelect = rows.nth(0).locator(".prf-control select"), secondSelect = rows.nth(1).locator(".prf-control select");
  const firstControl = rows.nth(0).locator(".prf-control"), secondControl = rows.nth(1).locator(".prf-control");
  const helpRow = scope.locator(".prf-row:has(.prf-help):has(.prf-label)").first(), help = helpRow.locator(".prf-help");
  const secondGroup = scope.locator(".prf-group").nth(1), heading = secondGroup.locator(".prf-heading");
  const list = secondGroup.locator(".prf-card"), secondRow = secondGroup.locator(".prf-row").nth(1);
  const measure = (kind, label) => async () => (await G.preferenceGeometry(page)).result.find(metric => metric.kind === kind && metric.label === label)?.actual;
  const helpLabel = (await helpRow.locator(".prf-label").textContent()).trim();
  const groupName = (await heading.textContent()).trim();
  const field = async locator => {
    const label = await locator.getAttribute("id");
    const caption = (await scope.locator(`label[for="${label}"]`).textContent()).trim();
    return (await G.fields(page, session, scope)).find(item => item.name === caption);
  };
  const probes = [
    () => G.changesByPixel(firstSelect, "height", () => rect(firstSelect, "height"), "field height"),
    () => G.changesByPixel(firstSelect, "padding-left", async () => {
      const item = await field(firstSelect);
      return item.text.x - item.x - item.leftBorder;
    }, "field text inset"),
    () => G.shiftsByPixel(secondSelect, "X", async () => (await field(secondSelect)).text.x, "field text column"),
    () => G.changesByPixel(stepper, "height", () => rect(stepper, "height"), "numeric compound field height"),
    () => G.changesByPixel(firstControl, "width", () => rect(firstControl, "width"), "preference control column width"),
    () => G.shiftsByPixel(secondControl, "X", () => rect(secondControl, "right"), "right-aligned preference control"),
    () => G.shiftsByPixel(help, "X", measure("preference help starts at its left label", helpLabel), "help aligns to left label"),
    () => G.shiftsByPixel(heading, "Y", measure("preference section gap", groupName), "preference section gap"),
    () => G.shiftsByPixel(list, "Y", measure("preference heading to list", groupName), "preference heading to list"),
    () => G.shiftsByPixel(heading, "X", measure("preference heading starts at the page title", groupName), "preference heading starts at the page title"),
    () => G.shiftsByPixel(secondRow, "Y", measure("preference row gap", groupName), "preference row gap"),
  ];
  for (const probe of probes) {
    try { report.controls.push(await probe()); }
    catch (error) { report.errors.push(`One-pixel Preferences control: ${error.message}`); }
  }
  const autosaveText = async () => (await G.textBaselines(page,session,scope))
    .find(item => item.control === "prf-general-autosaveMinutes");
  try { report.controls.push(...await G.assertBaselinePerturbations(number, autosaveText)); }
  catch (error) { report.errors.push(`Preferences compound field text mutation: ${error.message}`); }
  const original = Number(await number.inputValue());
  const unit = stepper.locator(".prf-unit");
  assert.equal(await unit.textContent(), "min");
  assert.ok((await number.getAttribute("aria-describedby"))?.split(/\s+/).includes(await unit.getAttribute("id")));
  await number.press("ArrowUp");
  assert.equal(Number(await number.inputValue()), original + 1);
  await number.press("ArrowDown");
  assert.equal(Number(await number.inputValue()), original);
  await number.press("Shift+Equal");
  assert.equal(Number(await number.inputValue()), original + 1);
  await number.press("Minus");
  assert.equal(Number(await number.inputValue()), original);
  await stepper.getByRole("button", {name:"Increase Autosave interval", exact:true}).click();
  assert.equal(Number(await number.inputValue()), original + 1);
  await stepper.getByRole("button", {name:"Decrease Autosave interval", exact:true}).click();
  assert.equal(Number(await number.inputValue()), original);
  await number.click();
  assert.ok(await number.evaluate(input => input.selectionStart !== null && input.selectionStart === input.selectionEnd),
    "Clicking a Preferences stepper places a caret in the value.");
  await number.press("ControlOrMeta+a");
  await page.keyboard.type(String(original + 2));
  await number.press("Enter");
  assert.equal(await page.evaluate(() => AtriumPrefs.get("general.autosaveMinutes")), original + 2);
  const before = new Set((await snapshotSurfaces(page)).map(surface => surface.id));
  await scope.getByRole("button", {name:"Restore Defaults…", exact:true}).click();
  const warning = page.getByRole("dialog", {name:"Restore defaults for General?", exact:true});
  await warning.waitFor();
  await auditDialogs(page, session, report, "Restore Preferences defaults", "preferences", before);
  await warning.getByRole("button", {name:"Cancel", exact:true}).click();
  assert.equal(Number(await number.inputValue()), original + 2, "Cancelling Restore Defaults preserves the edited value.");
  await scope.getByRole("button", {name:"Restore Defaults…", exact:true}).click();
  await warning.getByRole("button", {name:"Restore Defaults", exact:true}).click();
  await page.waitForFunction(expected => AtriumPrefs.get("general.autosaveMinutes") === expected, original);
  assert.equal(Number(await number.inputValue()), original, "Confirming Restore Defaults restores the page's value.");

  await dialog.evaluate(dialog => {
    const node = document.createElement("kbd"); node.dataset.geometryStray = "true";
    node.textContent = "Ctrl+Shift+P"; dialog.append(node);
  });
  try {
    const stray = await strayShortcuts(dialog);
    assert.ok(stray.some(issue => issue.kind === "bare kbd" && issue.label === "Ctrl+Shift+P"));
    assert.ok(stray.some(issue => issue.kind === "shortcut string" && issue.label === "Ctrl+Shift+P"));
    report.controls.push({label:"visible shortcut outside the component", rejected:true});
  } finally {
    await dialog.locator("[data-geometry-stray]").evaluate(node => node.remove());
  }
}

async function narrowPreferences(page, session, dialog, scope, report) {
  const size = page.viewportSize(), locale = "en-XA";
  let expanded = 0;
  try {
    await page.setViewportSize({width:390,height:844});
    await page.evaluate(locale => AtriumI18n.setLocale(locale), locale);
    assert.equal(await page.evaluate(() => document.documentElement.lang), locale);
    for (const id of ["general", "keyboard", "insights"]) {
      await page.evaluate(id => { AtriumPrefs.open(id); }, id);
      await scope.locator(".prf-page-title:visible").waitFor();
      assert.equal(await scope.getAttribute("data-shown"), id);
      expanded += await scope.locator(".prf-page-title,.prf-label,.prf-help").evaluateAll(nodes =>
        nodes.filter(node => /^\[[^\]]+\]$/.test(node.textContent.trim())).length);
      const items = await G.fields(page, session, scope), geometry = await G.preferenceGeometry(page, {narrow:true});
      const textBaselines = await G.textBaselines(page, session, scope);
      const {census, metrics:coverage} = await fieldCoverage(scope,textBaselines);
      const measurements = [...G.fieldResults(items), ...G.baselineResults(textBaselines), ...coverage, ...geometry.result];
      const accessibleHelp = await scope.locator(".prf-row:has(.prf-help)").evaluateAll(rows => rows.flatMap(row => {
        const help = row.querySelector(".prf-help");
        const input = row.querySelector("input[aria-describedby],select[aria-describedby]");
        if (!input || !help.getClientRects().length) return [];
        return [{id:input.id, complete:input.getAttribute("aria-describedby").split(/\s+/).includes(help.id) &&
          !!help.textContent.trim()}];
      }));
      assert.ok(accessibleHelp.length && accessibleHelp.every(item => item.complete), "The full narrow-layout help stays available to its control.");
      report.narrowPreferences ||= [];
      report.narrowPreferences.push({id, name:`${id} (390px pseudo-locale)`, locale, width:390, fields:items.length, accessibleHelp:accessibleHelp.length, textBaselines, census,
        measurements, failures:G.failures(measurements)});
      if (id === "general") {
        const caption = scope.locator('label[for="prf-general-language"]');
        const languageText = async () => (await G.textBaselines(page,session,scope))
          .find(item => item.control === "prf-general-language");
        report.controls.push(await G.assertStackedCaptionPerturbation(caption,languageText));
      }
    }
    const windowBox = await dialog.boundingBox();
    assert.ok(windowBox.x >= 0 && windowBox.x + windowBox.width <= 390.5, "The narrowed Preferences dialog stays inside the viewport.");
    assert.ok(expanded > 0, "The shipped pseudo-locale visibly expands real text in the narrow form.");
  } finally {
    await page.evaluate(() => AtriumI18n.setLocale("en"));
    await page.setViewportSize(size);
  }
}

async function renderedShortcut(locator, label) {
  await locator.waitFor();
  return locator.evaluate((node, label) => {
    const caps = [...node.querySelectorAll(".ui-shortcut-cap")];
    const rect = element => {
      const b = element.getBoundingClientRect();
      return {left:b.left, top:b.top, width:b.width, height:b.height, right:b.right, bottom:b.bottom};
    };
    const glyphs = caps.map(cap => {
      const range = cap.ownerDocument.createRange(); range.selectNodeContents(cap);
      const box = range.getBoundingClientRect(), style = getComputedStyle(cap);
      return {text:cap.textContent.trim(), rect:rect(cap), glyph:{width:box.width, height:box.height}, font:style.fontFamily};
    });
    const steps = [...node.querySelectorAll(".ui-shortcut-step")].map(rect);
    return {label, variant:node.dataset.variant, rect:rect(node), steps, glyphs};
  }, label);
}

async function strayShortcuts(scope) {
  return scope.evaluate(root => {
    const visible = node => node.getClientRects().length > 0 && getComputedStyle(node).visibility === "visible";
    const result = [...root.querySelectorAll("kbd")].filter(node => visible(node) && !node.closest(".ui-shortcut"))
      .map(node => ({kind:"bare kbd", label:node.textContent.trim()}));
    const grammar = /(?:[⌃⌥⇧⌘]{1,4}[\w,.;/]|\b(?:Ctrl|Control|Cmd|Command|Alt|Option|Shift|Meta|Super|Win|Mod)\+(?:[\w,.;/]+\+)*(?:[a-z0-9]|F(?:[1-9]|1[0-9]|2[0-4])|Space|Tab|Enter|Return|Esc(?:ape)?|Backspace|Del(?:ete)?|Home|End|Page(?:Up|Down)|Arrow(?:Up|Down|Left|Right))\b)/i;
    for (const node of root.querySelectorAll("[data-hint]")) {
      if (!node.closest(".ui-shortcut") && visible(node) && ["::before", "::after"].some(pseudo => {
        const text = getComputedStyle(node, pseudo).content;
        return grammar.test(text) && getComputedStyle(node, pseudo).display !== "none";
      })) result.push({kind:"shortcut in a pseudo-element", label:node.getAttribute("data-hint")});
    }
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    while (walker.nextNode()) {
      const text = walker.currentNode, parent = text.parentElement;
      if (!parent || parent.closest(".ui-shortcut,script,style,.visually-hidden,.sr-only") || !grammar.test(text.data)) continue;
      const range = document.createRange(); range.selectNodeContents(text);
      if (visible(parent) && range.getBoundingClientRect().width > 0) result.push({kind:"shortcut string", label:text.data.trim().slice(0,120)});
    }
    return result;
  });
}

function shortcutGeometry(samples, profile) {
  const baseline = new Map(), metrics = [], unsupported = [];
  for (const sample of samples) {
    const glyphs = sample.glyphs.map(glyph => glyph.text);
    const displayed = glyphs.join(sample.variant === "keycap" && profile.platform !== "MacIntel" ? "+" : "");
    if (sample.steps.length !== 1 || displayed !== profile.visible) {
      unsupported.push({kind:"shortcut glyph", label:sample.label, actual:displayed, expected:profile.visible});
      continue;
    }
    if (!["inline","keycap"].includes(sample.variant)) {
      unsupported.push({kind:"shortcut variant", label:sample.label, actual:sample.variant, expected:"inline or keycap"});
    }
    if (sample.glyphs.some(glyph => !/(system-ui|-apple-system|BlinkMacSystemFont|Segoe UI)/i.test(glyph.font))) {
      unsupported.push({kind:"shortcut font", label:sample.label, actual:sample.glyphs.map(glyph => glyph.font), expected:"system font"});
    }
    const original = baseline.get(sample.variant);
    if (!original) baseline.set(sample.variant, sample);
    else for (const dimension of ["width", "height"]) {
      metrics.push({kind:`shortcut ${dimension}`, label:sample.label, actual:sample.rect[dimension], expected:original.rect[dimension]});
      for (const [index,glyph] of sample.glyphs.entries()) metrics.push({kind:`shortcut glyph ${dimension}`, label:sample.label,
        actual:glyph.glyph[dimension], expected:original.glyphs[index]?.glyph[dimension]});
    }
  }
  return [...unsupported, ...G.failures(metrics)];
}

async function shortcuts(page, session, profile, report) {
  const shortcut = ".ui-shortcut:visible", samples = report.shortcuts, size = page.viewportSize();
  try {
    if (profile.touch) await page.setViewportSize({width:390,height:844});
    await ensureStartPage(page);
    await demoButton(page).waitFor();
    await page.evaluate(chord => {
      AtriumKeymap.setBindings("command-palette", []);
      AtriumKeymap.setBindings("new", [chord]);
    }, profile.chord);
    const home = page.locator(".sp-dialog[open] [data-start-action=new]");
    samples.push(await renderedShortcut(home.locator(shortcut), "Start page"));
    await auditDialogs(page, session, report, "Start page", "shortcuts", new Set());
    if (profile.touch) {
      report.touchWelcome = await page.locator(".sp-dialog[open] :is([data-start-action=new],[data-start-action=open])").evaluateAll(buttons =>
        buttons.map(button => {
          const label = button.querySelector(".sp-action-label"), range = document.createRange();
          range.selectNodeContents(label);
          const chip = button.querySelector(".ui-shortcut").getBoundingClientRect(), box = button.getBoundingClientRect();
          return {name:label.textContent, height:box.height, left:box.left, right:box.right,
            labelEnd:range.getBoundingClientRect().right, chipStart:chip.left, chipEnd:chip.right};
        }));
      assert.equal(report.touchWelcome.length, 2);
      for (const row of report.touchWelcome) {
        assert.ok(row.height >= 44 && row.left >= -.5 && row.right <= 390.5, `${row.name} remains a full touch target.`);
        assert.ok(row.chipStart >= row.labelEnd - .5 && row.chipEnd <= row.right + .5, `${row.name} shortcut fits beside its text.`);
      }
    }
  } finally {
    if (profile.touch) await page.setViewportSize(size);
  }
  await demo(page);
  await page.evaluate(chord => {
    AtriumKeymap.setBindings("new", []);
    AtriumKeymap.setBindings("save", [chord]);
  }, profile.chord);

  await page.locator('.work-menu[data-menu="file"] > summary').press("ArrowDown");
  const fileMenu = page.locator('.work-menu[data-menu="file"][open]');
  const command = fileMenu.locator('[data-action="save"]');
  samples.push(await renderedShortcut(command.locator(shortcut), "File menu"));
  report.strays.push(...await strayShortcuts(fileMenu));
  await page.keyboard.press("Escape");

  const quickSave = page.locator('.quick-access [data-action="save"]');
  if (profile.touch) {
    const box = await quickSave.boundingBox();
    await session.send("Input.dispatchTouchEvent", {type:"touchStart", touchPoints:[{x:box.x + box.width/2, y:box.y + box.height/2, id:1}]});
  } else await quickSave.hover();
  const tip = page.locator('#waffle-tooltip:visible').filter({has:page.locator(shortcut)});
  try {
    samples.push(await renderedShortcut(tip.locator(shortcut), "App tooltip"));
    report.strays.push(...await strayShortcuts(tip));
  } finally {
    if (profile.touch) await session.send("Input.dispatchTouchEvent", {type:"touchEnd", touchPoints:[]});
  }
  await page.locator('.work-menu[data-menu="view"] > summary').click(); await page.locator('.work-menu[data-menu="view"] [data-action="search"]').click();
  const palette = page.locator("#palette[open]");
  await palette.getByRole("combobox").fill(">save");
  const result = palette.locator('[role=option]').filter({has:page.locator(".nav-palette-label", {hasText:/^Save Project$/})}).first();
  samples.push(await renderedShortcut(result.locator(shortcut), "Command palette"));
  await auditDialogs(page, session, report, "Command palette", "shortcuts", new Set());
  await page.keyboard.press("Escape");

  // The reference is another real surface using the keycap variant of the tooltip.
  await page.evaluate(() => AtriumNavHost.act("shortcuts"));
  const reference = page.getByRole("dialog", {name:"Keyboard shortcuts", exact:true});
  const saveDescription = reference.locator("dt").filter({hasText:/^Save(?: project)?$/i}).first();
  await saveDescription.scrollIntoViewIfNeeded();
  samples.push(await renderedShortcut(saveDescription.locator("xpath=following-sibling::dd[1]").locator(shortcut).first(), "Shortcut reference"));
  await auditDialogs(page, session, report, "Shortcut reference", "shortcuts", new Set());
  // The cheat sheet has no action footer, so it closes with its heading's Close button (docs/ui-library.md#close).
  await reference.getByRole("button", {name:"Close keyboard shortcuts", exact:true}).click();
  await reference.waitFor({state:"hidden"});

  await page.evaluate(() => AtriumNavHost.act("keyboard-shortcuts"));
  const editor = page.getByRole("dialog", {name:"Keyboard shortcuts editor"});
  await editor.waitFor();
  const row = editor.locator('[data-command="save"]');
  await row.scrollIntoViewIfNeeded();
  samples.push(await renderedShortcut(row.locator(shortcut).first(), "Keyboard shortcuts editor"));
  await auditDialogs(page, session, report, "Keyboard shortcuts editor", "shortcuts", new Set());
  report.columns = await editor.locator(".km-table").evaluate(table => {
    const rows = [...table.querySelectorAll("tbody tr[data-command]")].filter(row => row.getClientRects().length);
    return rows.flatMap(row => {
      const label = row.querySelector(".km-name > span"), key = row.querySelector(".km-key .ui-shortcut");
      if (!label || !key) return [];
      const range = document.createRange(); range.selectNodeContents(label);
      return [{name:row.dataset.command, description:range.getBoundingClientRect().x, key:key.getBoundingClientRect().x}];
    });
  });
  const first = report.columns[0];
  assert.ok(first, "The editor has rendered bindings to measure.");
  report.shortcutFailures.push(...G.failures(report.columns.flatMap(row => ["key", "description"].map(column => ({
    kind:`shortcut ${column} column`, label:row.name, actual:row[column], expected:first?.[column],
  })))));
  report.shortcutFailures.push(...shortcutGeometry(samples, profile));
  report.shortcuts = samples;
  const binding = row.locator(shortcut).first();
  report.controls.push(await G.changesByPixel(binding.locator(".ui-shortcut-cap").first(), "padding-right",
    async () => (await renderedShortcut(binding, "Perturbed shortcut width")).rect.width, "shortcut width"));
  report.controls.push(await G.changesByPixel(binding.locator(".ui-shortcut-cap").first(), "padding-bottom",
    async () => (await renderedShortcut(binding, "Perturbed shortcut height")).rect.height, "shortcut height"));
  for (const [selector, name] of [[".km-name > span", "description"], [".km-key", "key"]]) {
    const column = row.locator(selector);
    const position = () => column.evaluate((node, name) => {
      if (name === "key") return node.querySelector(".ui-shortcut").getBoundingClientRect().x;
      const range = document.createRange(); range.selectNodeContents(node);
      return range.getBoundingClientRect().x;
    }, name);
    report.controls.push(await G.shiftsByPixel(column, "X", position, `shortcut ${name} column`));
  }

  await page.evaluate(chord => AtriumKeymap.setBindings("save", [chord + " F7"]), profile.chord);
  const sequence = await renderedShortcut(row.locator(shortcut).first(), "Keyboard shortcut sequence");
  assert.equal(sequence.steps.length, 2, "a two-chord binding renders two steps");
  const distance = (sample) => sample.steps[1].left - sample.steps[0].right;
  report.shortcutFailures.push(...G.failures([{kind:"shortcut sequence gap", label:sequence.label, actual:distance(sequence), expected:8}]));
  report.sequence = sequence;
  report.controls.push(await G.changesByPixel(row.locator(shortcut).first(), "column-gap",
    async () => distance(await renderedShortcut(row.locator(shortcut).first(), "Perturbed gap")), "shortcut sequence gap"));
  await editor.getByRole("button", {name:"Done", exact:true}).click();
}

async function actions(page, kind) {
  return page.evaluate(kind => {
    const state = {kind, tool:"select", interactive:false, selected:true, selectionCount:1, canvas:true, __assume:true};
    const dialogCommand = title => /(?:…|\.{3})$/.test(title.trim());
    const menu = [...document.querySelectorAll(".menu-items [data-action]")]
      .filter(node => (dialogCommand(node.textContent) || node.getAttribute("aria-haspopup") === "dialog") &&
        (!node.dataset.scope || node.dataset.scope === kind))
      .map(node => node.dataset.action);
    const commands = AtriumKeymap.commands().filter(command => dialogCommand(command.title) &&
      (!command.whenTest || command.whenTest(state, true))).map(command => command.action || command.id);
    const related = {
      pcb:["board-shape", "view-config", "polygon-pour", "swap-optimise", "pdn-analysis", "thermal-map", "si-analysis",
        "via-fence", "panelize", "footprint-editor", "xsignal-wizard", "selection-memory", "drc-waivers"],
      schematic:["symbol-editor"],
      drawing:["drawing-view", "drawing-table", "drawing-text"],
    };
    return [...new Set(menu.concat(commands, ["about", "grid-picker", "grid-custom", "library-catalogue", "shortcuts", "find-replace",
      "library-sources", "rule-sets", "collab-status", "collab-live", "clipboard-picker", "project-connections", "check-updates", "customise-waffle"],
      related[kind] || []))].filter(Boolean);
  }, kind);
}

async function snapshotSurfaces(page) {
  return page.locator(`${surfaces}:visible`).evaluateAll(nodes => nodes.map(node => {
    const references = node.getAttribute("aria-labelledby")?.split(/\s+/) || [];
    const label = references.map(id => document.getElementById(id)?.textContent.trim()).filter(Boolean).join(" ");
    return {...window.geometrySurfaces[node.dataset.geometrySurface],
      platform:navigator.platform,
      name:node.getAttribute("aria-label") || label || node.querySelector("h1,h2,h3,.ui-dialog-title")?.textContent.trim() || node.className};
  }));
}

async function dismiss(page) {
  await page.keyboard.press("Escape");
  await page.locator(modal).evaluateAll(dialogs => dialogs.reverse().forEach(dialog => dialog.close()));
}

async function auditDialogs(page, session, report, action, context, original) {
  const opened = (await snapshotSurfaces(page)).filter(surface => !original.has(surface.id));
  const first = report.dialogs.length;
  for (const surface of opened) {
    const locator = page.locator(`${surfaces}[data-geometry-surface="${surface.id}"]`);
    if (!await locator.isVisible()) continue;
    try {
      const items = await G.fields(page, session, locator), sections = await G.dialogSections(locator);
      const textBaselines = await G.textBaselines(page, session, locator);
      const {census, metrics:coverage} = await fieldCoverage(locator,textBaselines);
      const measurements = [...G.fieldResults(items), ...G.baselineResults(textBaselines), ...coverage, ...sections, ...await G.keyListGeometry(locator)];
      const strays = await strayShortcuts(locator);
      report.dialogs.push({...surface, action, context, fields:items.length, sections:sections.length,
        textBaselines, census, measurements, failures:G.failures(measurements)});
      if (surface.name === "Insert palette" && !report.controls.some(probe => probe.label === "Insert palette provider refresh")) {
        const refresh = await locator.evaluate(async dialog => {
          const input = dialog.querySelector("input[role=combobox]");
          const results = document.getElementById(input.getAttribute("aria-controls"));
          const before = input.placeholder, records = [];
          const observer = new MutationObserver(changes => records.push(...changes));
          observer.observe(input,{attributes:true,attributeFilter:["placeholder"]});
          observer.observe(results,{childList:true});
          try {
            AtriumPalette.invalidateProvider("extensions");
            await new Promise(resolve => requestAnimationFrame(resolve));
            records.push(...observer.takeRecords());
            return {before, after:input.placeholder, rendered:records.some(record => record.target === results),
              writes:records.filter(record => record.target === input).length};
          } finally { observer.disconnect(); }
        });
        assert.ok(refresh.rendered, "The open Insert palette rendered the provider refresh.");
        assert.ok(refresh.before, "The Insert palette has a visible search hint.");
        assert.equal(refresh.after, refresh.before);
        assert.equal(refresh.writes, 0, "Refresh keeps Chromium's existing rendered placeholder text.");
        report.controls.push({label:"Insert palette provider refresh", ...refresh});
      }
      if (surface.name === "Add Comment" && !report.controls.some(probe => probe.label.startsWith("Comment caption text"))) {
        const readComment = async () => (await G.textBaselines(page,session,locator)).find(item => item.control === "Comment");
        const comment = textBaselines.find(item => item.control === "Comment");
        assert.equal(comment?.mode,"multiline","The review form pairs its caption with its first visible textarea line.");
        const field = locator.getByRole("textbox",{name:"Comment",exact:true}), originalValue = await field.inputValue();
        const caption = locator.locator("label > span", {hasText:/^Comment$/});
        await field.fill("Review this connection.\nConfirm before release.");
        try {
          assert.deepEqual(G.failures(G.baselineResults([await readComment()])),[]);
          report.controls.push(...await G.assertBaselinePerturbations(caption,readComment,{captionOnly:true}));
        } finally { await field.fill(originalValue); }
      }
      if (surface.name === "Auto Place (Proposal)" && report.profile === "touch") {
        // The draft opens before the proposal arrives. Check the enlarged, settled form as well.
        await locator.locator(".autoplace-alt").first().waitFor();
        const current = () => G.textBaselines(page,session,locator);
        const prepared = (await current()).filter(row => ["Place","Strategy","Seed"].includes(row.label));
        assert.equal(prepared.length,3);
        assert.deepEqual(G.failures(G.baselineResults(prepared)),[]);
        const readPlace = async () => (await current()).find(item => item.label === "Place");
        const caption = locator.locator("label.autoplace-field > span",{hasText:/^Place$/});
        report.controls.push(...await G.assertBaselinePerturbations(caption,readPlace,{captionOnly:true}));
      }
      report.strays.push(...strays.map(issue => ({...issue, surface:surface.name})));
    } catch (error) {
      if (await locator.isVisible()) throw error;
    }
  }
  return report.dialogs.length - first;
}

async function probeDialog(page, session, report, action, context, open, required = false, finish) {
  const original = new Set((await snapshotSurfaces(page)).map(surface => surface.id));
  let opened = false;
  try {
    const result = await open();
    if (result?.unavailable) {
      report.unopened.push({action, context, reason:result.unavailable});
      if (required) report.errors.push(`${context}/${action}: ${result.unavailable}`);
      return;
    }
    // Commands that open a feature for the first time resolve local scripts or render a frame.
    opened = await page.waitForFunction(known => [...document.querySelectorAll('[data-geometry-surface]')].some(node =>
      !known.includes(node.dataset.geometrySurface) && node.getClientRects().length), [...original], {timeout:required ? 1500 : 80}).then(() => true, () => false);
    if (!opened) {
      report.unopened.push({action, context, reason:"No app-owned dialog opened in this state"});
      if (required) report.errors.push(`${context}/${action}: the declared fixture opened no dialog`);
      return;
    }
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(resolve)));
    if (!await auditDialogs(page, session, report, action, context, original)) {
      report.unopened.push({action, context, reason:"App closed the surface before layout settled"});
      if (required) report.errors.push(`${context}/${action}: the declared fixture ended before layout settled`);
    }
  } catch (error) {
    report.errors.push(`${context}/${action}: ${error.message}`);
  } finally {
    try {
      if (opened && finish) await finish();
    } catch (error) {
      report.errors.push(`${context}/${action} cleanup: ${error.message}`);
    } finally {
      if (opened || required) await dismiss(page);
      else await page.evaluate(() => {
        for (const dialog of document.querySelectorAll("dialog[open]")) dialog.close();
        if (AtriumNavHost.tool?.() !== "select") AtriumNavHost.act("select");
      });
    }
  }
}

async function prepareDialogProject(page) {
  await page.evaluate(async () => {
    await AtriumLazy.need(["AtriumDrawing", "AtriumPanel"]);
    const host = AtriumNavHost, project = structuredClone(host.project());
    const board = project.documents.find(document => document.kind === "pcb");
    project.documents.push(AtriumDrawing.create(project, {board:board.id, preset:"blank"}), AtriumPanel.create(project, {board:board.id}));
    globalThis.geometryDemoProject = structuredClone(project);
    await host.replaceProject(project, {force:true, dirty:false});
  });
}

async function dialogs(page, session, report, options, replay, save) {
  await prepareDialogProject(page);
  const contexts = options.fixturesOnly ? [] : options.context ? [options.context] : ["pcb", "schematic", "drawing", "panel"];
  for (const [index, kind] of contexts.entries()) {
    await page.evaluate(async ({index,kind}) => {
      const host = AtriumNavHost;
      if (index) await host.replaceProject(structuredClone(globalThis.geometryDemoProject), {force:true, dirty:false});
      const document = host.project().documents.find(d => d.kind === kind);
      if (!document) throw Error(`The project fixture has no ${kind} document.`);
      host.selectDocument(document.id);
      const chosen = document.items?.find(item => item.kind === "part") || document.items?.[0];
      if (chosen) host.select([chosen.id]);
    }, {index,kind});
    const candidates = replay ? [...(replay.get(kind) || [])] : await actions(page, kind);
    const start = options.actionStart || 0;
    const catalogue = candidates.slice(start, options.actionCount == null ? undefined : start + options.actionCount);
    console.log(`${report.profile} ${kind} dialog actions ${start + 1}–${start + catalogue.length} of ${candidates.length}`);
    const progress = {context:kind, start, total:candidates.length, attempted:[]};
    report.actionBatches.push(progress);
    await save();
    for (const action of catalogue) {
      await probeDialog(page, session, report, action, kind, () => page.evaluate(async ({action,kind}) => {
        const dependencies = AtriumLazy.forAction(action, kind);
        if (dependencies) await AtriumLazy.need(dependencies);
        if (action === "sch-calculation" && globalThis.AtriumCalculationActions &&
            !AtriumCalculationActions.writable(AtriumNavHost.project(),AtriumNavHost.doc(),AtriumNavHost)) {
          return {unavailable:"Place calculation requires a writable schematic. The notebook fixture covers the legal path."};
        }
        AtriumNavHost.act(action);
      }, {action,kind}));
      progress.attempted.push(action);
      if (progress.attempted.length % 5 === 0) await save();
    }
    await save();
  }
  if (options.actionCount == null) {
    if (contexts.length) await page.evaluate(() => AtriumNavHost.replaceProject(structuredClone(globalThis.geometryDemoProject), {force:true, dirty:false}));
    await dialogFixtures(page, session, report, "core", save);
  }
}

async function dialogFixtures(page, session, report, group, save, {macOnly = false} = {}) {
  const registered = group === "core" ? cases : require(`../support/dialog-geometry-${group}.cjs`).cases;
  const tests = registered(page, macOnly ? "light" : report.profile).filter(test => !macOnly || test.macOnly);
  if (macOnly) assert.ok(tests.some(test => test.name === macNetworkWorkflow.action), "The Mac-only permission workflow has an explicit fixture.");
  for (const test of tests) {
    const context = `fixture:${group}${macOnly ? ":macOS" : ""}`;
    const first = report.dialogs.length;
    await probeDialog(page, session, report, test.name, context, test.open, true, test.finish);
    if (test.attribution) for (const dialog of report.dialogs.slice(first)) dialog.attribution = test.attribution;
    await save();
  }
}

async function run(browser, options = {}) {
  const {rows:manifest, sites} = inventory(), reports = [];
  assert.ok(!options.profile || profiles.some(profile => profile.id === options.profile), "Unknown Chromium profile.");
  assert.ok(!options.context || ["pcb","schematic","drawing","panel"].includes(options.context), "Unknown editor context.");
  assert.ok(!options.fixtureGroup || (options.fixturesOnly && fixtureGroups.includes(options.fixtureGroup)),
    "Choose a listed --fixture-group with --fixtures-only.");
  assert.ok(options.actionStart == null || options.actionCount != null, "An action offset requires --action-count.");
  if (options.actionCount != null) {
    assert.ok(options.context && options.profile && !options.fixturesOnly, "An action batch requires --profile and --context.");
    assert.ok(Number.isInteger(options.actionCount) && options.actionCount > 0, "--action-count must be a positive integer.");
    assert.ok(options.actionStart == null || (Number.isInteger(options.actionStart) && options.actionStart >= 0),
      "--action-start must be a nonnegative integer.");
  }
  const exhaustive = !options.preferencesOnly && !options.shortcutsOnly && !options.fixturesOnly &&
    !options.dialogsOnly && !options.context && options.actionCount == null;
  const request = {exhaustive, profile:options.profile || "all",
    area:options.preferencesOnly ? "preferences" : options.shortcutsOnly ? "shortcuts" : options.fixturesOnly ? "fixtures" :
    options.dialogsOnly ? "dialogs" : "all", context:options.context || null, fixtureGroup:options.fixtureGroup || null,
    actionStart:options.actionStart || 0, actionCount:options.actionCount ?? null};
  const receipt = {request, inventory:manifest, platformPanels, profiles:reports};
  const checkpointOutput = (complete = false) => checkpoint(options.output, receipt, complete);
  let replay;
  for (const profile of profiles.filter(profile => !options.profile || profile.id === options.profile)) {
    const {context, page, session, errors} = await openFixture(browser, profile);
    const report = {profile:profile.id, preferences:[], dialogs:[], shortcuts:[], shortcutFailures:[],
      unopened:[], actionBatches:[], strays:[], controls:[], timings:{}, errors};
    reports.push(report);
    const runArea = async (name, action) => {
      const start = performance.now();
      try { await action(); }
      catch (error) { errors.push(`${name}: ${error.message}`); }
      finally {
        await dismiss(page);
        report.timings[name] = Math.round(performance.now() - start);
      }
      await checkpointOutput();
    };
    try {
      if (!options.preferencesOnly && !options.dialogsOnly && !options.fixturesOnly) await runArea("Shortcut", () => shortcuts(page, session, profile, report));
      if (!options.shortcutsOnly && !options.dialogsOnly && !options.fixturesOnly) await runArea("Preferences", () =>
        preferences(page, session, profile, report, checkpointOutput));
      if (!options.preferencesOnly && !options.shortcutsOnly && (!options.fixtureGroup || options.fixtureGroup === "core")) await runArea("Dialogs", async () => {
        if (!await page.locator("#doc-name", {hasText:"Sensor board"}).isVisible()) await demo(page);
        await dialogs(page, session, report, options, replay, checkpointOutput);
      });
      if (!replay && report.dialogs.length && !options.fixturesOnly) {
        replay = new Map();
        for (const surface of report.dialogs.filter(surface => ["pcb","schematic","drawing","panel"].includes(surface.context))) {
          if (!replay.has(surface.context)) replay.set(surface.context, new Set());
          replay.get(surface.context).add(surface.action);
        }
      }
    } finally {
      await context.close();
    }
    const groups = options.preferencesOnly || options.shortcutsOnly || options.actionCount != null ? [] :
      fixtureGroups.slice(1).filter(group => !options.fixtureGroup || options.fixtureGroup === group);
    const additional = groups.flatMap(group => group === "review" && profile.platform !== "MacIntel" ?
      [{group, profile}, {group, profile:{...profile, platform:"MacIntel"}, macOnly:true}] : [{group, profile}]);
    for (const fixtureMode of additional) {
      const {group, macOnly} = fixtureMode;
      const start = performance.now();
      const fixture = await openFixture(browser, fixtureMode.profile);
      try {
        await demo(fixture.page);
        await prepareDialogProject(fixture.page);
        await dialogFixtures(fixture.page, fixture.session, report, group, checkpointOutput, fixtureMode);
      } catch (error) {
        errors.push(`Dialog fixture group ${group}${macOnly ? " (macOS)" : ""}: ${error.message}`);
      } finally {
        await fixture.context.close();
        errors.push(...fixture.errors);
        report.timings[`fixture:${group}${macOnly ? ":macOS" : ""}`] = Math.round(performance.now() - start);
      }
    }
    report.unreachedInventory = manifest.filter(site => !report.dialogs.some(dialog =>
      dialog.sources.includes(site.source) && (dialog.kind === site.kind || ["library", "shell", "factory"].includes(site.kind))));
    report.unreachedSites = sites.filter(site => !report.dialogs.some(surface => matchesSite(site, surface)));
    await checkpointOutput();
  }
  receipt.reconciliation = reconcile(sites, reports);
  receipt.platformWorkflows = [{...macNetworkWorkflow, observations:reports.flatMap(report =>
    report.dialogs.filter(dialog => dialog.action === macNetworkWorkflow.action)
      .map(dialog => ({profile:report.profile, platform:dialog.platform, name:dialog.name, failures:dialog.failures})))}];
  await checkpointOutput(true);
  let failures = 0, firstFailure;
  for (const report of reports) {
    const metrics = [...report.preferences, ...(report.preferenceStates || []), ...(report.narrowPreferences || []), ...report.dialogs]
      .flatMap(row => row.failures.map(metric => ({...metric, surface:row.name, action:row.action, context:row.context})));
    const [metric] = [...metrics, ...report.shortcutFailures, ...report.strays];
    const [unreached] = exhaustive ? report.unreachedSites : [];
    // The inventory runner retains only the assertion's first line on failure.
    const detail = report.errors[0] || (metric &&
      [metric.context, metric.action || metric.surface, metric.kind, metric.label].filter(Boolean).join(" / ")) ||
      (unreached && `unprobed site ${unreached.source}:${unreached.line}`);
    if (detail && !firstFailure) firstFailure = `${report.profile} ${detail.split("\n")[0]}`;
    const count = metrics.length + report.errors.length + report.shortcutFailures.length + report.strays.length;
    const duration = Object.values(report.timings).reduce((total, milliseconds) => total + milliseconds, 0) / 1000;
    console.log(`${report.profile}: ${report.preferences.length} Preferences pages, ${report.dialogs.length} opened surfaces, ${count} geometry or runtime failures, ${sites.length - report.unreachedSites.length}/${sites.length} construction sites observed, ${duration.toFixed(1)} s`);
    for (const error of report.errors) console.error(`${report.profile}: ${error}`);
    for (const issue of [...metrics, ...report.shortcutFailures, ...report.strays].slice(0, 20)) console.error(JSON.stringify(issue));
    failures += count;
    if (exhaustive) {
      failures += report.unreachedSites.length;
      if (report.unreachedSites.length) console.error(`Unprobed ${report.profile} sites: ${report.unreachedSites.map(site =>
        `${site.source}:${site.line}`).join(", ")}`);
    }
  }
  assert.equal(failures, 0, `dialog geometry ${firstFailure || "shortcuts and inventory coverage"}`);
}

module.exports = run;
if (require.main === module) {
  (async () => {
    const browser = await chromium.launch({...(process.env.CHROME ? {executablePath:process.env.CHROME} : {channel:"chrome"}),
      args:["--allow-file-access-from-files"]});
    const actionStart = argument("--action-start"), actionCount = argument("--action-count");
    try { await run(browser, {profile:argument("--profile"), output:argument("--output"), preferencesOnly:process.argv.includes("--preferences-only"),
      shortcutsOnly:process.argv.includes("--shortcuts-only"), dialogsOnly:process.argv.includes("--dialogs-only"),
      fixturesOnly:process.argv.includes("--fixtures-only"), fixtureGroup:argument("--fixture-group"), context:argument("--context"),
      actionStart:actionStart === null ? null : Number(actionStart), actionCount:actionCount === null ? null : Number(actionCount)}); }
    finally { await browser.close(); }
  })().catch(error => {console.error(error); process.exitCode = 1;});
}
