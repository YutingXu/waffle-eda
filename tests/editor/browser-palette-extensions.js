"use strict";
// Run on the combined palette, Preferences, calculation, notebook and equation build. --app selects a review worktree.
// Optional --screenshots writes captures and the measured results to the chosen directory.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const {pathToFileURL} = require("node:url");
const {chromium} = require("playwright-core");
const argument = key => { const at = process.argv.indexOf(key); return at < 0 ? null : process.argv[at + 1]; };
const root = path.resolve(argument("--app") || path.resolve(__dirname, "../.."));
const output = argument("--screenshots"), key = "command:ext:example.divider:divider", chord = "Control+Alt+Shift+G", alias = "vdivideqa";

async function install(page, name) {
  const folder = path.join(root, "extensions/examples", name);
  const files = Object.fromEntries(fs.readdirSync(folder).filter(f => /\.(json|js)$/.test(f)).map(f => [f, fs.readFileSync(path.join(folder, f), "utf8")]));
  const installing = page.evaluate(data => AtriumExtensions.install(data).then(record => record.id), files);
  const prompt = page.locator("dialog.ext-prompt[open]"); await prompt.waitFor();
  if (name === "palette-distributor") assert.equal(await prompt.getByLabel(/Contact https:\/\/catalog\.example/).isChecked(), false);
  await prompt.getByRole("button", {name: "Install", exact: true}).click();
  return installing;
}
async function search(page, query) {
  await page.evaluate(() => globalThis.AtriumPalette?.close(false));
  await page.keyboard.press("/");
  const input = page.locator("#palette[open] [role=combobox]"); await input.fill(query); return input;
}
const row = (page, label) => page.locator("#palette [role=option]").filter({has: page.locator(".nav-palette-label", {hasText: label})}).first();
async function capture(page, theme, name) {
  if (!output) return;
  const image = await page.locator("#palette").screenshot({path: path.join(output, theme + "-" + name + ".png"), animations: "disabled"});
  return crypto.createHash("sha256").update(image).digest("hex");
}
async function setupShortcut(page) {
  await page.evaluate(() => AtriumPalette.close(false));
  const file = page.locator(".menubar [data-menu=file]"); await file.locator(":scope > summary").click();
  await file.locator("[data-action=preferences]:visible").first().click();
  const prefs = page.getByRole("dialog", {name: "Preferences"}); await prefs.getByRole("button", {name: "Keyboard", exact: true}).click();
  const target = prefs.getByRole("combobox", {name: "Command", exact: true}), aliases = prefs.getByRole("textbox", {name: "Aliases", exact: true});
  await target.selectOption(key); assert.equal(await target.locator("option").filter({hasText: "Calculate voltage divider"}).count(), 1);
  await aliases.fill(alias); await prefs.getByRole("button", {name: "Save aliases"}).click();
  await target.selectOption("cmd:grid"); await aliases.fill(alias); await prefs.getByRole("button", {name: "Save aliases"}).click();
  await prefs.getByText(alias + " already belongs to another command.").waitFor(); await target.selectOption(key);
  await prefs.getByRole("button", {name: "Edit shortcut…"}).click();
  const keys = page.getByRole("dialog", {name: "Keyboard shortcuts editor"});
  await keys.locator('tr[data-command="' + key + '"]').getByRole("button", {name: /Add a key/}).click();
  await page.keyboard.press(chord); await page.keyboard.press("Enter"); await keys.getByRole("button", {name: "Done"}).click();
}
async function checkShortcuts(page) {
  const form = page.locator(".nav-palette-screen form");
  await setupShortcut(page); await search(page, alias);
  await row(page, "Calculate voltage divider").waitFor();
  assert.equal(await page.locator("#palette .nav-palette-label").filter({hasText: "Calculate voltage divider"}).count(), 1);
  await row(page, "Calculate voltage divider").click(); await form.waitFor();
  const editors = [];
  for (const kind of ["pcb", "schematic"]) {
    await page.evaluate(kind => { AtriumPalette.close(false); AtriumNavHost.selectDocument(AtriumNavHost.project().documents.find(d => d.kind === kind).id); AtriumNavHost.canvas().focus(); }, kind);
    await page.keyboard.press(chord); await form.waitFor(); editors.push(await page.evaluate(() => AtriumPalette.context().kind));
  }
  await page.evaluate(async () => {
    AtriumPalette.close(false); await AtriumLazy.need("AtriumLibrary"); await AtriumLazy.need("AtriumSymbolEditor");
    const library = AtriumNavHost.project().library; AtriumSymbolEditor.open({def: library[0], library});
  });
  await page.waitForFunction(() => [...document.querySelectorAll("dialog[open]")].some(d => d.paletteSurface?.kind === "symbol"));
  await page.evaluate(() => [...document.querySelectorAll("dialog[open]")].find(d => d.paletteSurface?.kind === "symbol").paletteSurface.canvas.focus());
  await page.keyboard.press(chord); await form.waitFor(); editors.push(await page.evaluate(() => AtriumPalette.context().kind));
  assert.deepEqual(editors, ["pcb", "schematic", "symbol"]);
  await page.evaluate(() => { AtriumPalette.close(false); [...document.querySelectorAll("dialog[open]")].find(d => d.paletteSurface?.kind === "symbol").close(); });
  await page.evaluate(async () => { await AtriumExtensions.setEnabled("example.divider", false); AtriumNavHost.canvas().focus(); });
  await page.keyboard.press(chord); assert.equal(await page.locator("#palette[open]").count(), 0);
  await page.evaluate(async () => { await AtriumExtensions.setEnabled("example.divider", true); AtriumNavHost.canvas().focus(); });
  await page.keyboard.press(chord); await form.waitFor();
  const shortcutState = await page.evaluate(key => {
    const K = AtriumKeymap, h = K.registerCommand({id: "local-conflict-proof", title: "Local conflict proof", run() {}});
    K.setBindings("local-conflict-proof", K.bindingsFor(key).map(b => b.key));
    const conflict = K.conflicts().some(c => [c.a.command, c.b.command].includes(key) && [c.a.command, c.b.command].includes("local-conflict-proof"));
    h.dispose(); return {conflict, commands: K.commands().filter(c => c.id === key).length, bindings: K.bindingsFor(key).filter(b => b.source === "user").length};
  }, key);
  assert.deepEqual(shortcutState, {conflict: true, commands: 1, bindings: 1});
  await page.evaluate(async () => { AtriumPalette.close(false); await AtriumExtensions.uninstall("example.divider"); AtriumNavHost.canvas().focus(); });
  await page.keyboard.press(chord); assert.equal(await page.locator("#palette[open]").count(), 0);
  return {editors, ...shortcutState};
}
async function sharedMath(page) {
  const measured = await page.evaluate(async () => {
    const C = AtriumCalculations, host = AtriumNavHost, fn = "example.divider.vout", source = fn + "(5V,1kΩ,2kΩ)";
    const project = structuredClone(host.project()), sheet = project.documents.find(d => d.kind === "schematic");
    sheet.items.push(AtriumCalculationRecords.backing({id: "divider-proof", x: 4, y: 6, source, functions: {[fn]: "1.0.0"}}));
    const snapshot = await C.evaluate(project, {documentId: sheet.id, blockId: "divider-proof", revision: "private-proof"});
    const answer = await C.answer({queryId: 113, text: source, projectRevision: host.revision(), documentId: host.currentId()}, {project: host.project(), host});
    const args = [{value: 5, dimension: "voltage"}, {value: 1000, dimension: "resistance"}, {value: 0, dimension: "resistance"}];
    let diagnostic; try { await AtriumExtensionPalette.evaluateMath(fn, "1.0.0", args); } catch (e) { diagnostic = e.message; }
    return {sheet: snapshot.records[0]?.result?.display, answer: answer?.display, pinnedVersion: answer?.functions?.[fn], diagnostic, worker: C.stats()};
  });
  assert.equal(measured.sheet, "3.333 V"); assert.equal(measured.answer, "3.333 V"); assert.equal(measured.pinnedVersion, "1.0.0");
  assert.match(measured.diagnostic, /domain/); assert.ok(measured.worker.started >= 1 && measured.worker.jobs >= 4); assert.equal(measured.worker.local, 0);
  return measured;
}
async function renderedDetail(page, detail) {
  const equation = detail.getByRole("math");
  await equation.locator("canvas").waitFor();
  const outline = await equation.evaluate(el => {
    const c = el.querySelector("canvas"), rgba = c.getContext("2d").getImageData(0, 0, c.width, c.height).data;
    let inkPixels = 0;
    for (let i = 3; i < rgba.length; i += 4) if (rgba[i]) inkPixels++;
    return {description:el.getAttribute("aria-label"), width:c.width, height:c.height, inkPixels};
  });
  assert.ok(outline.width > 60 && outline.height > 20 && outline.inkPixels > 60);
  assert.match(outline.description, /V/); assert.ok(!outline.description.includes("\\frac"));
  const paragraph = detail.locator(".nav-palette-rich-text p");
  await paragraph.locator("strong").first().waitFor();
  assert.deepEqual((await paragraph.locator("strong").allTextContents()).map(s => s.trim()), ["Input", "Upper", "Lower"]);
  assert.match(await paragraph.innerText(), /5 V.+1000 Ω.+2000 Ω/);
  return outline;
}
async function liveEquationTheme(page, theme) {
  return page.evaluate(async theme => {
    const color = () => {
      const canvas = document.querySelector("#palette [role=math] canvas"), ctx = canvas.getContext("2d");
      const rgba = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
      for (let i = 0; i < rgba.length; i += 4) if (rgba[i + 3] === 255) return rgba[i];
    };
    const set = next => new Promise(resolve => {
      addEventListener("atrium-theme", () => requestAnimationFrame(resolve), {once:true});
      AtriumTheme.setPreset(next);
    });
    const start = color(); await set(theme === "light" ? "dark" : "light"); const changed = color();
    await set(theme); return [start, changed, color()];
  }, theme);
}
async function detailFallback(page, detail) {
  const expression = "\\unlistednotation{x}";
  const presented = await page.evaluate(tex => AtriumPalette.present({kind:"detail",title:"Notes",blocks:[
    {kind:"math",text:tex}, {kind:"richText",body:{blocks:[
      {style:"h2",runs:[{type:"text",text:"Reading"}]}, {style:"bullet",runs:[{type:"text",text:"<b>cost</b>",code:true,href:"https://example.invalid"}]},
      {style:"paragraph",runs:[{type:"math",tex:"x^2"},{type:"field",expression:"project.title"}]}]}}
  ]}, {}), expression);
  assert.equal(presented,true);
  const fallback = detail.getByRole("math",{name:expression});
  await fallback.getByText(expression,{exact:true}).waitFor();
  await detail.locator("p [role=math] canvas").waitFor();
  assert.equal(await fallback.locator("canvas").count(),0);
  assert.equal(await detail.getByRole("heading",{level:2}).innerText(),"Reading");
  assert.equal(await detail.locator("ul li code").innerText(),"<b>cost</b>");
  assert.equal(await detail.locator("a, b, iframe, script").count(),0);
  assert.equal(await detail.getByText("project.title").count(),0);
}
async function themeRun(browser, theme) {
  const page = await browser.newPage({viewport: {width: 1280, height: 900}, deviceScaleFactor: 1}); page.setDefaultTimeout(12000);
  await require("../fixtures/notebook-labs.cjs").profile(page,{"general.startPage":"never"});
  const errors = [], external = [], pictures = {};
  await page.context().setOffline(true);
  page.on("pageerror", e => errors.push(e.message)); page.on("request", r => { if (!/^(file|data|blob):/.test(r.url())) external.push(r.url()); });
  try {
    await page.goto(pathToFileURL(path.join(root, "app/index.html")).href);
    await page.waitForFunction(() => !!globalThis.AtriumNavHost && globalThis.AtriumExtensions?.attached);
    const mathAtStartup = await page.evaluate(() => !!globalThis.AtriumMath);
    assert.equal(mathAtStartup, false, "equation fonts and parser stay off the native startup path");
    await page.evaluate(async theme => { const h = AtriumNavHost, p = AtriumParts.example(); await h.replaceProject(p, {force: true, dirty: false}); h.selectDocument(p.documents.find(d => d.kind === "pcb").id); h.setTool("select"); AtriumTheme.setPreset(theme); }, theme);
    for (const name of ["palette-distributor", "palette-footprints", "palette-calculator"]) await install(page, name);
    const before = await page.evaluate(() => AtriumNavHost.doc().items.length), detail = page.locator("#palette .nav-palette-screen");
    await search(page, "0603"); const stock = row(page, "RC0603 · 10 kΩ"); await stock.waitFor();
    await row(page, "CC0603 · 100 nF").waitFor(); const labels = await page.locator("#palette .nav-palette-label").allTextContents();
    assert.deepEqual(labels.slice(-2), ["RC0603 · 10 kΩ", "CC0603 · 100 nF"]); assert.ok(labels.length > 2);
    const group = await stock.evaluate(e => { const g = e.closest('[role=group]'); return g?.getAttribute("aria-label") || document.getElementById(g?.getAttribute("aria-labelledby"))?.textContent || g?.firstElementChild?.textContent; });
    assert.equal(group, "Benchstock"); await stock.click(); await detail.getByText("8200 available · $0.02").waitFor(); pictures.stock = await capture(page, theme, "stock");
    await detail.getByRole("button", {name: "Warehouse stock"}).click(); await detail.getByText("6000 available").waitFor();
    const query = await search(page, "zzunmatchedpublicfixture73"); await row(page, "Search Extension Providers").click(); await query.fill("0603");
    await row(page, "RC0603 · 10 kΩ").waitFor(); await row(page, "CC0603 · 100 nF").waitFor();
    const fallback = await page.locator("#palette .nav-palette-label").allTextContents(); assert.deepEqual(fallback, labels.slice(-2));
    await search(page, "Choose footprint"); await row(page, "Choose footprint").click(); const grid = detail.locator('[data-kind="grid"]'); await grid.waitFor();
    await page.waitForFunction(() => { const imgs = [...document.querySelectorAll(".nav-palette-screen img")]; return imgs.length >= 5 && imgs.every(i => i.complete && i.naturalWidth === 96 && i.naturalHeight === 64); });
    const thumbnails = await grid.locator("img").count(); pictures.footprints = await capture(page, theme, "footprints"); await grid.getByRole("button").first().click();
    await detail.getByRole("button", {name: "Place footprint"}).click(); await page.locator("dialog.ext-prompt[open]").getByRole("button", {name: "Apply selected"}).click();
    await page.waitForFunction(n => AtriumNavHost.doc().items.length === n, before + 1);
    await page.evaluate(() => { AtriumPalette.close(false); AtriumNavHost.executeKey("undo"); }); await page.waitForFunction(n => AtriumNavHost.doc().items.length === n, before);
    await search(page, "Calculate voltage divider"); await row(page, "Calculate voltage divider").click(); const form = detail.locator("form"); await form.waitFor(); pictures.form = await capture(page, theme, "form");
    const upper = form.getByLabel("Upper resistor (Ω)"), submit = form.getByRole("button", {name: "Calculate"});
    await upper.fill("-1"); await submit.click(); assert.equal(await upper.evaluate(el => el.validity.rangeUnderflow), true);
    assert.equal(await page.evaluate(() => !!globalThis.AtriumMath), false, "search and form controls do not demand equation typesetting");
    await upper.fill("1000"); await submit.click(); await detail.getByText("3.333 V", {exact: true}).waitFor();
    const equation = await renderedDetail(page, detail);
    pictures.answer = await capture(page, theme, "answer");
    const inkChanges = await liveEquationTheme(page, theme);
    assert.equal(inkChanges[0], inkChanges[2]); assert.ok(Math.abs(inkChanges[0] - inkChanges[1]) > 100);
    await detailFallback(page, detail);
    const math = await sharedMath(page), shortcut = await checkShortcuts(page);
    const isolated = await page.locator("iframe[sandbox]").evaluateAll(frames => frames.some(f => f.sandbox.value === "allow-scripts" && f.srcdoc.includes("default-src 'none'")));
    assert.equal(isolated, true); assert.deepEqual(errors, []); assert.deepEqual(external, []);
    return {theme, mathAtStartup, equation, inkChanges, localHits: labels.length - 2, streamedHits: 2, provider: group, explicitProviderHits: fallback.length, thumbnails, placement: [before, before + 1, before], math, shortcut, pictures};
  } finally { await page.close(); }
}
(async () => {
  if (output) fs.mkdirSync(output, {recursive: true});
  const browser = await chromium.launch({headless: true, ...(process.env.CHROME ? {executablePath: process.env.CHROME} : {channel: "chrome"}), args: ["--allow-file-access-from-files"]});
  try {
    const results = [];
    for (const theme of ["light", "dark"]) results.push(await themeRun(browser, theme));
    if (output) fs.writeFileSync(path.join(output, "results.json"), JSON.stringify(results, null, 2) + "\n");
    console.log(JSON.stringify(results));
  } finally { await browser.close(); }
})().catch(e => {console.error(e); process.exitCode = 1;});
