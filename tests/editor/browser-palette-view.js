"use strict";

const assert = require("node:assert/strict");
const path = require("node:path");
const {pathToFileURL} = require("node:url");

const app = pathToFileURL(path.join(__dirname, "../../app/index.html")).href;
const axeScript = () => require.resolve("axe-core/axe.min.js", {paths:[__dirname, path.join(__dirname, "../../scripts/ci")]});
const focused = locator => locator.evaluate(node => node === document.activeElement);
const ready = page => page.waitForFunction(() => !!document.querySelector("#palette .nav-palette-preview-content"));
const tolerance = 1;

async function holdPalette(page) {
  let release;
  const loading = new Promise(resolve => {release = resolve;});
  await page.route("**/palette.js", async route => {await loading; await route.continue();});
  return release;
}

async function loadDemo(page, theme) {
  await require("../fixtures/notebook-labs.cjs").profile(page);
  await page.goto(app, {waitUntil:"domcontentloaded"});
  await page.locator("dialog.sp-dialog[open] [data-start-action=demo]").click();
  await page.locator('#document-tabs [data-kind="schematic"]').click();
  await page.evaluate(theme => AtriumTheme.setPreset(theme), theme);
}

async function audit(page, label) {
  if (!await page.evaluate(() => !!globalThis.axe?.run)) await page.addScriptTag({path:axeScript()});
  const violations = await page.evaluate(async () => {
    const {violations} = await axe.run("#palette", {runOnly:["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"]});
    return violations.map(rule => [rule.id, rule.nodes.map(node => [node.target, node.failureSummary])]);
  });
  assert.deepEqual(violations, [], label);
}

async function coldOpen(page, input, release) {
  await page.locator("#canvas").focus();
  await page.evaluate(() => window.addEventListener("keydown", e => {
    if (e.key !== "/") return;
    const dialog = document.getElementById("palette"), field = dialog.querySelector("input");
    let focusedInDispatch = false;
    field.addEventListener("focus", () => {focusedInDispatch = e.eventPhase !== Event.NONE;}, {once:true});
    requestAnimationFrame(() => {
      const {width, height} = dialog.getBoundingClientRect();
      window.paletteFirstFrame = {focusedInDispatch, open:dialog.open, focused:document.activeElement === field, visible:width > 0 && height > 0};
    });
  }, {capture:true, once:true}));
  await page.keyboard.press("/");
  await page.waitForFunction(() => !!window.paletteFirstFrame);
  assert.deepEqual(await page.evaluate(() => window.paletteFirstFrame), {focusedInDispatch:true, open:true, focused:true, visible:true});
  assert.equal(await page.evaluate(() => typeof AtriumPalette), "undefined");
  await page.keyboard.type("res 10k");
  await page.keyboard.insertText(" Ω");
  assert.equal(await input.inputValue(), "res 10k Ω");
  await input.evaluate(node => {window.originalPaletteInput = node;});
  release();
  await ready(page);
  assert.equal(await input.inputValue(), "res 10k Ω");
  assert.equal(await input.evaluate(node => node === window.originalPaletteInput && node === document.activeElement), true);
}

async function checkSelectionDuringTyping(page, dialog, input) {
  await input.fill("res");
  const options = dialog.getByRole("listbox");
  await options.getByRole("option", {selected:true}).waitFor();
  const probe = await options.evaluateHandle(list => {
    const counts = {updates:0, selectionResets:0};
    const observer = new MutationObserver(records => {
      counts.updates += records.length;
      counts.selectionResets += records.filter(record => record.oldValue === "false" && record.target.getAttribute("aria-selected") === "true").length;
    });
    observer.observe(list, {subtree:true, attributes:true, attributeOldValue:true, attributeFilter:["aria-selected"]});
    return {counts, observer};
  });
  try {
    await page.keyboard.type(" 10k");
    await options.getByRole("option", {name:/^Resistor · 10 kΩ/, selected:true}).waitFor();
    const counts = await probe.evaluate(({counts, observer}) => {observer.disconnect(); return counts;});
    assert.ok(counts.updates > 0);
    assert.equal(counts.selectionResets, 0, "each active row arrives with its selection already set");
  } finally {await probe.dispose();}
}

async function testDesktop(browser, theme, capture) {
  const page = await browser.newPage({viewport:{width:1440, height:920}, reducedMotion:"reduce", colorScheme:theme});
  page.setDefaultTimeout(8000);
  const errors = [];
  page.on("pageerror", error => errors.push(error.message));
  const release = theme === "dark" ? await holdPalette(page) : null;
  try {
    await loadDemo(page, theme);
    const centre = {click: () => page.locator('.work-menu[data-menu="view"] > summary').click().then(() => page.locator('.work-menu[data-menu="view"] [data-action="search"]').click())}, dialog = page.locator("#palette"), input = dialog.getByRole("combobox");
    if (release) {
      await coldOpen(page, input, release);
      await checkSelectionDuringTyping(page, dialog, input);
    }
    else {
      await centre.click();
      await ready(page);
      assert.equal(await focused(input), true);
      await input.fill("res 10k");
    }

    const symbol = dialog.getByRole("img", {name:/^Symbol for Resistor/});
    await symbol.waitFor();
    assert.ok(await symbol.evaluate(node => node.getContext("2d").getImageData(0, 0, node.width, node.height).data.some((v, i) => i % 4 === 3 && v > 0)), "the selected symbol is drawn");
    assert.equal(await dialog.getByRole("group", {name:"Top hit", exact:true}).getByRole("option", {selected:true}).count(), 1);
    assert.equal(await page.locator("dialog.nav-palette").count(), 1);
    const active = await input.getAttribute("aria-activedescendant");
    assert.ok(active && await dialog.locator(`#${active}`).getAttribute("aria-selected") === "true");
    assert.equal(await dialog.evaluate(node => getComputedStyle(node).getPropertyValue("--motion-move").trim()), "0", "Reduce Motion removes scale from the spring");
    const [list, preview] = await Promise.all([dialog.getByRole("listbox").boundingBox(), dialog.locator(".nav-palette-preview").boundingBox()]);
    assert.ok(preview.x >= list.x + list.width - tolerance && Math.abs(preview.y - list.y) <= tolerance, "wide preview is beside the list");
    const style = await dialog.evaluate(node => {
      const query = node.querySelector(".nav-palette-query input"), row = node.querySelector("[aria-selected=true]");
      const input = getComputedStyle(query), result = getComputedStyle(row), mark = getComputedStyle(row.querySelector("mark"));
      const panel = node.getBoundingClientRect();
      const shortcutLabels = [...node.querySelectorAll(".nav-palette-foot-btn:not([hidden]) .ui-shortcut-visual")].map(key => key.textContent);
      return {y:panel.top, panelHeight:panel.height, rowHeight:row.getBoundingClientRect().height, height:innerHeight,
        border:input.borderWidth, size:input.fontSize, shortcutLabels, mac:AtriumKeymap.mac, close:!!node.querySelector(".nav-palette-query [aria-label='Close palette']"), fill:result.backgroundColor,
        edge:result.borderTopColor, shadow:result.boxShadow, weight:mark.fontWeight, decoration:mark.textDecorationLine};
    });
    assert.ok(style.y > 0 && style.y < style.height / 3);
    assert.equal(style.size, "20px"); assert.equal(style.border, "0px"); assert.equal(style.close, false);
    assert.equal(style.fill, style.edge); assert.equal(style.shadow, "none");
    assert.equal(style.weight, "700"); assert.equal(style.decoration, "none");
    assert.deepEqual(style.shortcutLabels, style.mac ? ["⏎", "⌘", "K"] : ["Enter", "Ctrl", "K"]);
    assert.ok(style.rowHeight >= 28 && style.rowHeight < 44, "desktop result rows use compact spacing");
    await capture?.(page, `${theme}-palette`);
    await audit(page, `${theme} palette and real resistor symbol`);

    await page.keyboard.press("Tab");
    const resistance = dialog.getByLabel("Resistance", {exact:true});
    assert.equal(await focused(resistance), true, "Tab focuses actual insert options");
    assert.equal(await resistance.inputValue(), "10 kΩ", "the option preserves the recognized inline argument");
    await resistance.fill("12 kΩ");
    await audit(page, `${theme} palette options`);
    await page.keyboard.press("Escape");
    assert.equal(await focused(input), true);
    assert.equal(await input.getAttribute("aria-activedescendant"), active);
    const actionsKey = await page.evaluate(() => AtriumKeymap.mac ? "Meta+k" : "Control+k");
    const back = dialog.getByRole("button", {name:"Back to results", exact:true});
    await page.keyboard.press(actionsKey);
    const menu = dialog.getByRole("menu", {name:"Actions", exact:true});
    await menu.getByRole("menuitem", {name:"Options…", exact:true}).waitFor();
    assert.equal(await back.isVisible(), false);
    await page.keyboard.press("End");
    assert.ok(await focused(menu.getByRole("menuitem").last()));
    await audit(page, `${theme} palette actions menu`);
    await page.keyboard.press("Escape");
    assert.equal(await focused(input), true);
    await input.fill("@GND");
    await dialog.getByRole("button", {name:"Go to", exact:true}).waitFor();
    await page.keyboard.press(actionsKey);
    await menu.waitFor();
    assert.ok(await focused(menu.getByRole("menuitem").first()));
    await page.keyboard.press(actionsKey);
    await menu.waitFor({state:"hidden"});
    assert.equal(await focused(input), true);
    if (theme === "light") await testScreens(page, dialog, input, capture);
    await input.fill(">waffle-palette-view-no-command");
    await dialog.getByText("No matching commands.", {exact:true}).last().waitFor();
    const close = dialog.getByRole("button", {name:"Close palette", exact:true});
    await page.keyboard.press("Tab");
    assert.ok(await focused(close), "Tab from an empty result set reaches Close");
    await input.fill(">Fit Document");
    const fit = dialog.getByRole("option", {name:/^Fit Document/}).first();
    await fit.waitFor();
    assert.equal(await fit.locator("svg use").getAttribute("href"), "#i-fit");
    assert.ok(await dialog.getByRole("group", {name:"View",exact:true}).first().getByRole("option", {name:/^Fit Document/}).count());
    assert.doesNotMatch(await fit.textContent(), /Fit Document.*Fit Document/i);
    await input.fill(">Reset View Rotation");
    const rotation = dialog.getByRole("option", {name:/^Reset View Rotation/}).first();
    await rotation.waitFor();
    assert.doesNotMatch(await rotation.textContent(), /Reset View Rotation.*View/i);
    assert.equal(await dialog.locator(".nav-palette-preview").isVisible(), false);
    await page.keyboard.press(actionsKey);
    await menu.getByRole("menuitem", {name:"Run Reset View Rotation", exact:true}).waitFor();
    await page.keyboard.press("Escape");
    await input.fill(":10,20");
    await dialog.getByRole("option", {name:/10.*20/, selected:true}).waitFor();
    assert.equal(await dialog.getByRole("option").count(), 1);
    const single = await dialog.boundingBox();
    assert.ok(single.height + style.rowHeight < style.panelHeight, "a one-result palette uses its content height");
    await input.press("Escape");
    await page.waitForFunction(() => !document.getElementById("palette").open);
    assert.ok(await focused(page.locator("#canvas")), `${theme} palette returns focus to the canvas (its opener, a menu item, has closed)`);
    assert.equal(await dialog.locator('[role="listbox"] [role="option"]').count(), 0, "closing releases the query's active rows");
    assert.deepEqual(errors, []);
  } finally {
    release?.();
    await page.close();
  }
}

async function testScreens(page, dialog, input, capture) {
  // Exercise the real palette's declarative host boundary. Sandboxed extension dispatch is tested separately.
  await page.evaluate(() => {
    const canvas = document.createElement("canvas"); canvas.width = canvas.height = 24;
    const ctx = canvas.getContext("2d"); ctx.fillStyle = "#5795cf"; ctx.fillRect(0, 0, 24, 24);
    const image = {kind:"png", data:canvas.toDataURL(), alt:"Fixture thumbnail"};
    const recordings = [], unsafe = "<img src=unsafe onerror=alert(1)>";
    const list = () => AtriumPalette.present({kind:"list", title:"Worksheet tools", items:[
      {id:"grid", label:"Browse cards", detail:"Examples", accessory:"2 cards", thumbnail:image, actions:[{id:"pin", label:"Pin"}]},
      {id:"form", label:"Board fields"}
    ]}, {run(id, item) {
      if (id === "grid") grid();
      if (id === "form") form();
      if (id === "pin") recordings.push([id, item]);
    }});
    const grid = () => AtriumPalette.present({kind:"grid", title:"Worksheet cards", items:[{id:"detail", label:"Ohm’s Law", thumbnail:image},
      {id:"external", label:"Remote thumbnail", thumbnail:{kind:"png", data:"https://invalid.example/preview.png", alt:"Remote image"}}]},
    {run:detail, back:list});
    const detail = () => AtriumPalette.present({kind:"detail", title:"Ohm’s Law", blocks:[{kind:"math", text:"V = IR"},
      {kind:"text", text:unsafe}, {kind:"image", image}]}, {back:grid});
    const form = () => AtriumPalette.present({kind:"form", title:"Board fields", primary:{id:"store", label:"Apply"}, fields:[
      {id:"count", type:"number", label:"Count", min:1, max:3, required:true},
      {id:"side", type:"select", label:"Side", choices:[{id:"top", label:"Top"}, {id:"bottom", label:"Bottom"}]}
    ]}, {back:list, submit:(values, id) => recordings.push([id, values])});
    window.paletteViewRecordings = recordings;
    window.releasePaletteViewStream = null;
    const delay = new Promise(resolve => {window.releasePaletteViewStream = resolve;});
    AtriumPalette.registerProvider("browser-palette-view", {label:"Worksheet extension", stream:async ({query}) => {
      if (query !== "fit") return [];
      await delay;
      return [{key:"browser-fixture:worksheet", label:"Worksheet tools", source:"Worksheet extension", kind:"command", icon:"book", keepOpen:true, run:list}];
    }});
  });
  await input.fill("fit");
  const local = dialog.getByRole("group", {name:"Top hit", exact:true}).getByRole("option").first();
  const top = await local.getAttribute("id");
  await page.evaluate(() => window.releasePaletteViewStream());
  const remoteGroup = dialog.getByRole("group", {name:"Worksheet extension", exact:true});
  const worksheet = remoteGroup.getByRole("option", {name:"Worksheet tools", exact:true});
  await worksheet.waitFor();
  assert.equal(await input.getAttribute("aria-activedescendant"), top, "remote results preserve local active descendant");
  assert.equal(await dialog.getByRole("group").last().getAttribute("aria-labelledby"), await remoteGroup.getAttribute("aria-labelledby"));
  await worksheet.click();
  const screen = dialog.locator(".nav-palette-screen");
  const cards = screen.getByRole("button", {name:/Browse cards/}), pin = screen.getByRole("button", {name:"Pin", exact:true});
  assert.equal(await focused(cards), true);
  await pin.click();
  assert.deepEqual(await page.evaluate(() => window.paletteViewRecordings), [["pin", "grid"]]);
  await cards.click();
  await screen.getByRole("button", {name:/Ohm’s Law/}).waitFor();
  assert.equal(await screen.getByRole("img").count(), 1, "only the approved PNG is rendered");
  await capture?.(page, "light-palette-extension-grid");
  await page.keyboard.press("Enter");
  await screen.getByText("V = IR", {exact:true}).waitFor();
  await screen.getByText("<img src=unsafe onerror=alert(1)>", {exact:true}).waitFor();
  assert.equal(await screen.locator("img").count(), 1);
  await audit(page, "extension Detail preview");
  await page.keyboard.press("Escape");
  assert.ok(await focused(screen.getByRole("button", {name:/Ohm’s Law/})), "Escape restores the previous screen");
  await page.keyboard.press("Escape");
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("Enter");
  const count = screen.getByRole("spinbutton", {name:"Count", exact:true});
  assert.equal(await focused(count), true);
  const side = screen.getByRole("combobox", {name:"Side", exact:true});
  await side.selectOption("bottom");
  await count.fill("4");
  await screen.getByRole("button", {name:"Apply", exact:true}).click();
  assert.equal(await page.evaluate(() => window.paletteViewRecordings.length), 1, "the renderer enforces native field constraints");
  await count.fill("2");
  await screen.getByRole("button", {name:"Apply", exact:true}).click();
  assert.deepEqual(await page.evaluate(() => window.paletteViewRecordings.at(-1)), ["store", {count:"2", side:"bottom"}]);
  await audit(page, "extension Form");
  await page.keyboard.press("Escape");
  await page.keyboard.press("Escape");
  assert.equal(await focused(input), true);
  assert.equal(await input.inputValue(), "fit");
}

// Reproduce visual viewport resize/scroll from an on-screen keyboard in desktop Chrome.
async function keyboardViewport(page, height, offsetTop) {
  await page.evaluate(([height, offsetTop]) => {
    for (const [key, value] of Object.entries({height, offsetTop})) {
      if (value == null) delete visualViewport[key];
      else Object.defineProperty(visualViewport, key, {value, configurable:true});
    }
    visualViewport.dispatchEvent(new Event("resize"));
    visualViewport.dispatchEvent(new Event("scroll"));
    // The touch geometry watcher runs in the first frame and list resize is delivered before the next.
    return new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  }, [height, offsetTop]);
}

async function testTouch(browser, capture) {
  const page = await browser.newPage({viewport:{width:430, height:760}, hasTouch:true, reducedMotion:"reduce", colorScheme:"light"});
  page.setDefaultTimeout(8000);
  const release = await holdPalette(page);
  try {
    await loadDemo(page, "light");
    await page.evaluate(() => AtriumLazy.need("AtriumTouchPrecision"));
    const plus = page.getByRole("button", {name:"Insert at pointer", exact:true}), dialog = page.locator("#palette"), input = dialog.getByRole("combobox");
    const target = await plus.boundingBox();
    assert.ok(target.width >= 44 && target.height >= 44);
    await keyboardViewport(page, 363, 8);
    await plus.tap();
    const cold = await dialog.boundingBox();
    assert.ok(cold.y >= 8 && cold.y + cold.height <= 371, "the first palette uses the existing keyboard viewport");
    assert.equal(await page.evaluate(() => typeof AtriumPalette), "undefined");
    await keyboardViewport(page, 316, 21);
    const resized = await dialog.boundingBox();
    assert.ok(resized.y >= 21 && resized.y + resized.height <= 337, "the touch keyboard keeps the unloaded palette inside the visible viewport");
    assert.equal(await focused(input), true);
    await keyboardViewport(page);
    release();
    await ready(page);
    assert.equal(await focused(input), true);
    await input.fill("port");
    const option = dialog.getByRole("option", {name:/^Power Port\b/}).first();
    await option.tap();
    assert.equal(await option.getAttribute("aria-selected"), "true");
    assert.equal(await dialog.evaluate(node => node.open), true, "touch selection offers a preview and action");
    assert.equal(await dialog.evaluate(node => node.getAnimations({subtree:true}).length),0,"touch selection has no palette animation");

    await keyboardViewport(page, 316, 21);
    await page.waitForFunction(() => document.querySelector("#palette").hasAttribute("data-palette-short"));
    const [panel, list, preview, action] = await Promise.all([
      dialog.boundingBox(), dialog.getByRole("listbox").boundingBox(), dialog.locator(".nav-palette-preview").boundingBox(),
      dialog.getByRole("button", {name:"Insert", exact:true}).boundingBox()
    ]);
    assert.ok(panel.y >= 21 && panel.y + panel.height <= 337, "palette stays above the simulated keyboard");
    assert.ok(preview.y >= list.y + list.height - tolerance, "narrow preview sits below results");
    assert.ok(action.width >= 44 && action.height >= 44);
    const selected = await option.boundingBox();
    assert.ok(selected.height >= 44, "touch result rows retain a full-size target");
    assert.ok(selected.y >= list.y - tolerance && selected.y + selected.height <= list.y + list.height + tolerance, "the active touch result stays on screen");
    await capture?.(page, "light-palette-touch-keyboard");
    await audit(page, "touch palette with an emulated on-screen keyboard");

    await input.fill("res 10k");
    await dialog.getByRole("option", {name:/^Resistor · 10 kΩ/, selected:true}).waitFor();
    const menuButton = dialog.getByRole("button", {name:"Actions", exact:true});
    assert.ok((await menuButton.boundingBox()).height >= 44);
    await menuButton.tap();
    const edit = dialog.getByRole("menuitem", {name:"Options…", exact:true});
    assert.ok((await edit.boundingBox()).height >= 44);
    await edit.tap();
    const resistance = dialog.getByLabel("Resistance", {exact:true});
    assert.equal(await resistance.inputValue(), "10 kΩ");
    await dialog.getByRole("button", {name:"Back to results", exact:true}).tap();

    const hold = await dialog.locator(".nav-palette-grip").boundingBox();
    assert.ok(hold.height >= 44);
    const cdp = await page.context().newCDPSession(page);
    const x = hold.x + hold.width / 2, y = hold.y + hold.height / 2;
    await cdp.send("Input.dispatchTouchEvent", {type:"touchStart", touchPoints:[{x, y}]});
    await cdp.send("Input.dispatchTouchEvent", {type:"touchMove", touchPoints:[{x, y:y + 94}]});
    await cdp.send("Input.dispatchTouchEvent", {type:"touchEnd", touchPoints:[]});
    await page.waitForFunction(() => !document.getElementById("palette").open);
    assert.ok(await focused(plus), "swiping restores focus to the initiating touch button");
  } finally {release(); await page.close();}
}

async function testNativeShortcutBridge(browser) {
  const page = await browser.newPage({viewport:{width:1440,height:920}, reducedMotion:"reduce"});
  try {
    await loadDemo(page, "dark");
    await page.evaluate(() => {
      AtriumKeymap.setPlatform(true);
      const canvas = document.createElement("canvas");
      canvas.width = canvas.height = 2;
      canvas.getContext("2d").fillRect(0, 0, 2, 2);
      const glyph = {png:canvas.toDataURL().split(",")[1],width:1.25,height:1.25,descent:.25};
      const requests = window.nativeShortcutRequests = [];
      let release;
      const wait = new Promise(resolve => {release = resolve;});
      window.releaseShortcuts = release;
      document.documentElement.dataset.atriumNativeTitlebar = "macos";
      window.webkit = {messageHandlers:{atriumHost:{postMessage(message) {
        const {action, labels, id} = JSON.parse(message);
        if (action !== "macShortcutGlyphs") {window.__atriumReceive(id, null, null); return;}
        requests.push(labels);
        wait.then(() => window.__atriumReceive(id, Object.fromEntries(labels.map(label => [label, glyph])), null));
      }}}};
    });
    await page.addScriptTag({path:path.join(__dirname,"../../native/bridge.js")});
    await page.evaluate(() => AtriumKeymap.setBindings("command-palette", ["Mod+Alt+P"]));
    assert.deepEqual(await page.evaluate(() => window.nativeShortcutRequests), []);
    await page.locator('.work-menu[data-menu="view"] > summary').click(); await page.locator('.work-menu[data-menu="view"] [data-action="search"]').click();
    const dialog = page.locator("#palette"), input = dialog.getByRole("combobox");
    const primary = dialog.locator("button[aria-keyshortcuts=Enter]");
    const actions = dialog.getByRole("button", {name:"Actions", exact:true});
    await input.fill(">Fit Document");
    await actions.waitFor();
    assert.match(await input.evaluate(el => document.getElementById(el.getAttribute("aria-describedby")).textContent), /Return to act/);
    const width = (await primary.boundingBox()).width;
    await page.evaluate(() => window.releaseShortcuts());
    for (const label of ["⏎", "⌘", "K"]) {
      await dialog.locator(`.nav-palette-foot-btn .ui-shortcut-cap[data-native-shortcut="${label}"][data-native-rendered] .native-shortcut-ink`).waitFor();
    }
    assert.equal((await primary.boundingBox()).width, width, "native shortcuts leave the footer width stable");
    const batches = await page.evaluate(() => window.nativeShortcutRequests);
    const requested = new Set(batches.flat());
    assert.ok(["⏎","⌘","K"].every(label=>requested.has(label)), "the native provider receives each visible physical key");
    assert.ok(batches.every(labels => labels.length <= 32 && labels.every(label => !label.includes("↩"))));
    assert.deepEqual(await actions.locator(".ui-shortcut-cap").evaluateAll(caps => caps.map(cap => cap.dataset.nativeShortcut)), ["⌘","K"]);
    assert.equal(await actions.locator(".ui-shortcut").getAttribute("data-variant"), "keycap");
    await input.press("Meta+k");
    await dialog.getByRole("menuitem", {name:"Run Fit Document", exact:true}).locator(".ui-shortcut-cap[data-native-rendered]").waitFor();
    await page.keyboard.press("Escape");
    assert.ok(await focused(input));
    await input.press("Escape");
    // The command palette's key on its View menu item (the app bar has no Search field since 2026-11-23).
    const viewMenu = page.locator('.work-menu[data-menu=view]');
    await viewMenu.locator("summary").click();
    const centre = viewMenu.locator('[data-action="command-palette"]');
    assert.equal(await centre.getAttribute("data-hint"), await page.evaluate(() => AtriumKeymap.display("Mod+Alt+P")));
    assert.equal(await centre.getAttribute("aria-description"), await page.evaluate(() => AtriumKeymap.display("Mod+Alt+P",true)));
    await page.keyboard.press("Escape");
    const file = page.locator('.work-menu[data-menu=file]');
    await file.locator("summary").click();
    await file.locator(".ui-shortcut-cap[data-native-rendered]").first().waitFor();
    const save = file.locator('[data-action="save"]').first();
    assert.equal(await save.locator(".ui-shortcut-visual").textContent(), "⌘S");
    assert.doesNotMatch(await save.evaluate(node => [...node.childNodes].filter(child => child.nodeType === Node.TEXT_NODE).map(child => child.textContent).join("")), /⌘/);
  } finally {await page.close();}
}

async function testMotion(browser) {
  const page = await browser.newPage({viewport:{width:1440,height:920},reducedMotion:"no-preference"});
  page.setDefaultTimeout(8000);
  try {
    await loadDemo(page,"light");
    await page.locator("html[data-theme-fading]").waitFor({state:"detached"});
    const centre = {click: () => page.locator('.work-menu[data-menu="view"] > summary').click().then(() => page.locator('.work-menu[data-menu="view"] [data-action="search"]').click())}, dialog = page.locator("#palette"), input = dialog.getByRole("combobox");
    await centre.click();
    await ready(page);
    assert.equal(await dialog.evaluate(node=>node.getAnimations().length),0,"pointer opening is immediate");
    assert.equal(await focused(input),true);
    await page.evaluate(() => {
      window.motionPreviewCalls = [];
      AtriumPalette.registerProvider("motion-fixture",{entries:() => ["A","B","C"].map(letter => ({
        key:"motion-fixture:"+letter,label:"Motion Fixture "+letter,
        preview() {
          window.motionPreviewCalls.push(letter);
          if (window.pointerPreviewTiming) window.pointerPreviewTiming.providerAt = performance.now();
          return {text:"Preview "+letter};
        },
        run(){}
      }))});
    });
    await input.fill("Motion Fixture");
    const art = dialog.locator(".nav-palette-plain");
    await art.filter({hasText:"Preview A"}).waitFor();
    const state = await input.evaluate(node => {
      const root = node.closest("dialog"), title = root.querySelector(".nav-palette-preview-title");
      const targets = [];
      for (let i=0; i<2; i++) {
        node.dispatchEvent(new KeyboardEvent("keydown",{key:"ArrowDown",bubbles:true}));
        targets.push(document.getElementById(node.getAttribute("aria-activedescendant")).querySelector(".nav-palette-label").textContent);
      }
      return {preview:title.textContent,targets,transition:getComputedStyle(root.querySelector("[aria-selected=true]")).transitionProperty};
    });
    assert.equal(state.preview,state.targets[1],"keyboard selection updates the preview title in the same dispatch");
    assert.notEqual(state.targets[0],state.targets[1]);
    assert.equal(state.transition,"none");
    await art.filter({hasText:"Preview C"}).waitFor();
    assert.equal(await dialog.locator(".nav-palette-preview-title").textContent(),state.targets[1]);
    assert.deepEqual(await page.evaluate(()=>window.motionPreviewCalls),["A","C"],"intermediate providers are cancelled");
    assert.equal(await art.evaluate(node=>getComputedStyle(node).transitionDuration),"0s","keyboard previews do not fade");
    await page.evaluate(async () => {
      await AtriumLazy.need("AtriumMotionUI");
      document.addEventListener("pointermove", function measure(event) {
        if (!event.target.closest?.("[role=option]")?.textContent.includes("Motion Fixture B")) return;
        document.removeEventListener("pointermove",measure,true);
        const started = performance.now();
        queueMicrotask(() => {
          window.pointerPreviewTiming = {started, oldTitle:document.querySelector(".nav-palette-preview-title").textContent};
        });
      },true);
    });
    await dialog.getByRole("option",{name:"Motion Fixture B",exact:true}).hover();
    await art.filter({hasText:"Preview B"}).waitFor();
    const timing = await page.evaluate(()=>window.pointerPreviewTiming);
    assert.equal(timing.oldTitle,"Motion Fixture C","a pointer highlight settles before updating the preview");
    assert.ok(timing.providerAt - timing.started >= 55,"the pointer preview waits about 60 ms");
    assert.equal(await art.filter({hasText:"Preview B"}).evaluate(node=>node.parentElement.getAnimations({subtree:true}).length),0,"pointer previews replace content without animation");
    const exit = await input.evaluate(node => {
      const root = node.closest("dialog");
      node.dispatchEvent(new KeyboardEvent("keydown",{key:"Escape",bubbles:true,cancelable:true}));
      return {open:root.open, focused:!root.contains(document.activeElement) && document.activeElement !== document.body,
        display:getComputedStyle(root).display, animations:root.getAnimations().length};
    });
    assert.deepEqual(exit,{open:false,focused:true,display:"none",animations:0});
    await page.keyboard.press("F1");
    assert.equal(await dialog.evaluate(node=>node.getAnimations().length),0,"keyboard opening is immediate");
    assert.equal(await focused(input),true);
    await input.fill("no such palette command fixture");
    await dialog.getByRole("button",{name:"Close palette",exact:true}).click();
    assert.deepEqual(await dialog.evaluate(node=>({open:node.open,display:getComputedStyle(node).display,
      animations:node.getAnimations().length})),{open:false,display:"none",animations:0});
  } finally {await page.close();}
}

async function testCommandIconsAndFade(browser) {
  const page = await browser.newPage({viewport:{width:1280,height:720}});
  try {
    await loadDemo(page,"dark");
    await page.locator('#document-tabs [data-kind="pcb"]').click();
    await page.locator("#canvas").focus();
    await page.keyboard.press("F1");
    const dialog = page.locator("#palette"), input = dialog.getByRole("combobox"), list = dialog.getByRole("listbox");
    await dialog.locator(".nav-palette-results[data-more-below]").waitFor();
    const fadeStyle = () => dialog.locator(".nav-palette-results").evaluate(region => {
      const mask = getComputedStyle(region,"::after");
      return {gradient:mask.backgroundImage,surface:getComputedStyle(region.closest("dialog")).backgroundColor,events:mask.pointerEvents};
    });
    const dark = await fadeStyle();
    assert.ok(dark.gradient.includes(dark.surface) && dark.events === "none");
    await page.evaluate(() => AtriumTheme.setPreset("light"));
    await page.waitForFunction(previous=>getComputedStyle(document.getElementById("palette")).backgroundColor!==previous,dark.surface);
    const light = await fadeStyle();
    assert.ok(light.gradient.includes(light.surface) && light.surface !== dark.surface && light.events === "none");
    for (let n = 0; n < 8; n++) {
      await input.press("PageDown");
      if (await list.evaluate(n=>n.scrollHeight-n.clientHeight-n.scrollTop<=1)) break;
    }
    await dialog.locator(".nav-palette-results[data-more-below]").waitFor({state:"hidden"});
    assert.equal(await dialog.getByRole("option").last().getAttribute("aria-selected"),"true");
    await input.press("PageUp");
    await dialog.locator(".nav-palette-results[data-more-below]").waitFor();
    for (const [query, expected] of [
      ["Save as Zip","#i-folder"],["Duplicate","#i-select"],["Previous View","#i-dview"],["Interactive Differential Pair Routing","#i-route"]
    ]) {
      await input.fill(query);
      const option = dialog.getByRole("option",{name:new RegExp("^"+query,"i")}).first();
      await option.waitFor();
      assert.equal(await option.locator("svg use").getAttribute("href"),expected,query);
      assert.ok(await page.locator(expected).count(),"the symbol is in the shipped registry");
      await dialog.locator(".nav-palette-results[data-more-below]").waitFor({state:"hidden"});
    }
  } finally {await page.close();}
}

module.exports = async function paletteView(browser, {capture} = {}) {
  for (const theme of ["dark", "light"]) await testDesktop(browser, theme, capture);
  await testTouch(browser, capture);
  await testNativeShortcutBridge(browser);
  await testMotion(browser);
  await testCommandIconsAndFade(browser);
  console.log("PASS shared palette cold focus, rendered previews, actions and options, declarative screens, Light/Dark accessibility, touch and keyboard viewport");
};

if (require.main === module) {
  require("../support/standalone-chromium.cjs")(
    () => process.env.CHROME ? {executablePath:process.env.CHROME} : {channel:"chrome"},
    browser => {
      const capture = process.env.ATRIUM_PALETTE_CAPTURES && ((page, name) => page.screenshot({path:path.join(process.env.ATRIUM_PALETTE_CAPTURES, `${name}.png`), animations:"disabled"}));
      return module.exports(browser, {capture});
    },
    error => {console.error(error); process.exitCode = 1;});
}
