"use strict";

const assert = require("node:assert/strict");
const path = require("node:path");
const fs = require("node:fs/promises");
const {pathToFileURL} = require("node:url");
const {fields, textBaselines} = require("../support/dialog-geometry.cjs");

const providers = ["AtriumCanvasGPUPref", "AtriumExtensionDev", "AtriumCollabPresence", "AtriumCamera", "AtriumChecks",
  "AtriumExternalTools", "AtriumInsightsUI", "AtriumRouteSuggest", "AtriumClipHistory", "AtriumHistoryPanel", "AtriumThemePicker"];
const routes = ["general", "schematic", "pcb", "routing", "checks", "insights", "appearance", "display", "mouse", "keyboard",
  "extensions", "library", "collaboration", "labs"];
const legacySections = {search:"keyboard", "route-suggestions":"routing", clipboard:"general", history:"general",
  energy:"display", "external-tools":"extensions", "extension-dev":"extensions"};
const closeEnough = (actual, expected, name) => assert.ok(Math.abs(actual - expected) < 0.6, `${name}: expected ${expected}px, got ${actual}px`);

async function openDemo(page) {
  const welcome = page.locator("dialog.sp-dialog[open]");
  await welcome.locator("[data-start-action=demo]").click();
  await page.locator("#doc-name", {hasText:"Sensor board"}).waitFor();
  await welcome.waitFor({state:"hidden"});
}

async function replaceNumber(page, input, value, {commit = false} = {}) {
  await input.click();
  await input.press("ControlOrMeta+a");
  await page.keyboard.type(String(value));
  if (commit) await input.press("Enter");
}

async function measureUnits(pane) {
  return pane.locator(".prf-stepper").evaluateAll(steppers => {
    const rect = element => element.getBoundingClientRect();
    const font = document.createElement("canvas").getContext("2d");
    function overlaps(a, b) {
      return Math.min(a.right, b.right) - Math.max(a.left, b.left) > .6 &&
        Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top) > .6;
    }
    return steppers.flatMap(stepper => {
      const unit = stepper.querySelector(".prf-unit");
      if (!unit) return [];
      const input = stepper.querySelector("input");
      const range = document.createRange();
      range.selectNodeContents(unit);
      const lines = [...range.getClientRects()];
      const style = getComputedStyle(input);
      font.font = style.fontSize + " " + style.fontFamily;
      const boundary = rect(stepper);
      const buttons = [...stepper.querySelectorAll("button")].map(rect);
      const description = document.getElementById(input.id + "-unit");
      const rtl = style.direction === "rtl";
      const inlineStart = r => rtl ? -r.right : r.left, inlineEnd = r => rtl ? -r.left : r.right;
      return [{id:input.id, unit:unit.textContent, description:description?.textContent,
        linksUnit:input.getAttribute("aria-describedby").split(/ +/).includes(input.id + "-unit"),
        width:boundary.width, fontSize:parseFloat(style.fontSize), buttons:buttons.map(button => button.width), lines:lines.length,
        inset:inlineStart(rect(input)) - inlineStart(boundary) - 1,
        numberToUnit:inlineStart(rect(unit)) - inlineEnd(rect(input)),
        unitToDecrement:inlineStart(buttons[0]) - inlineEnd(rect(unit)),
        visible:lines.length > 0 && lines.every(line => line.left >= boundary.left && line.right <= boundary.right &&
          line.top >= boundary.top && line.bottom <= boundary.bottom && !overlaps(line, rect(input)) &&
          buttons.every(button => !overlaps(line, button))),
        valueFits:font.measureText(input.value).width <= rect(input).width + .6,
        bounds:{stepper:boundary,input:rect(input),unit:lines,buttons}}];
    });
  });
}

function checkUnits(rows, profile) {
  for (const row of rows) {
    assert.ok(row.visible && row.valueFits && row.linksUnit, `${profile} ${JSON.stringify(row)}`);
    closeEnough(row.width,132,row.id + " stepper");
    assert.equal(row.fontSize,13,row.id + " readable system text size");
    closeEnough(row.inset,8,row.id + " value inset");
    if (row.lines === 1) {
      closeEnough(row.numberToUnit,6,row.id + " number to unit");
      closeEnough(row.unitToDecrement,8,row.id + " unit to decrement");
    }
    for (const width of row.buttons) closeEnough(width,24,row.id + " step target");
  }
}


async function checkGeneralRows(page, pane) {
  const rows = await pane.evaluate(node => {
    const cards = [...node.querySelectorAll(":scope > .prf-page-body > .prf-group > .prf-card")];
    const rect = node => node.getBoundingClientRect();
    const padding = cards.map(card => {
      const style = getComputedStyle(card);
      return [parseFloat(style.paddingBlockStart),parseFloat(style.paddingBlockEnd),style.borderTopStyle,style.backgroundColor];
    });
    const rows = cards.flatMap(card => [...card.querySelectorAll(".prf-row")]).filter(row => row.querySelector(".prf-label,[role=switch]"));
    return {padding, rows:rows.map(row => {
      const toggle = row.querySelector("[role=switch]"), field = row.querySelector(".prf-control");
      const caption = row.querySelector(".prf-label") || toggle.closest("label").querySelector("span");
      const control = toggle || field.firstElementChild, help = row.querySelector(".prf-help"), bounds = rect(row), copy = rect(caption);
      const knob = toggle && getComputedStyle(toggle.closest("label"),"::after");
      const position = rect(control), painted = [bounds,position,...[...control.querySelectorAll(".prf-step-button")].map(rect)];
      const integral = painted.every(({x,y,width,height}) => [x,y,width,height].every(Number.isInteger));
      return {integral,id:row.querySelector("input,select").id,height:bounds.height, before:copy.top - bounds.top,
        after:help ? bounds.bottom - rect(help).bottom : null, helpGap:help ? rect(help).top - copy.bottom : null,
        center: position.top + position.height / 2 - bounds.top - bounds.height / 2,
        toggle: !!toggle, knob:knob?.backgroundColor, knobShadow:knob?.boxShadow};
    })};
  });
  assert.ok(rows.padding.length > 1);
  for (const padding of rows.padding) assert.deepEqual(padding,[0,0,"none","rgba(0, 0, 0, 0)"],"rows sit on the page: no card box, border or fill");
  assert.equal(rows.rows.length,7);
  for (const {id,integral,height,before,after,helpGap,center,toggle,knob,knobShadow} of rows.rows) {
    assert.ok(integral,id + " visible row, field and button edges are whole pixels");
    assert.equal(height,helpGap === null ? 44 : 56,id + " row height");
    if (helpGap !== null) {
      assert.equal(before,10,id + " top padding");
      assert.equal(after,10,id + " bottom padding");
      assert.equal(helpGap,4,id + " caption to help");
    }
    assert.ok(Math.abs(center) <= .5,id + " whole-row control center " + center);
    if (toggle) {
      assert.equal(knob,"rgb(255, 255, 255)",id + " white knob in either state");
      assert.notEqual(knobShadow,"none",id + " soft knob shadow");
    }
  }
  const session = await page.context().newCDPSession(page);
  try {
    const samples = await textBaselines(page,session,pane);
    // Controls centre on their row (beta feedback), so only the stepper's own value and unit share a baseline.
    const row = samples.find(sample => sample.control === "prf-general-autosaveMinutes");
    assert.equal(row?.mode,"centred");
    assert.ok(Math.abs(row.centreOffset) <= .5,"the stepper centres on its row");
    assert.ok(Math.abs(row.valueBaseline - row.unit?.baseline) <= .5,"rendered unit baseline");
    const number = (await fields(page,session,pane)).find(field => field.name === "Autosave interval");
    assert.ok(number?.text, "the browser paints the native stepper value");
    const end = number.direction === "rtl" ? number.text.x : number.text.x + number.text.width;
    closeEnough(end,number.valueEnd,"painted number aligned to its unit");
  } finally { await session.detach(); }
}

// Every page: trailing controls centre on their row, no two text boxes in a row overlap, no selected
// value is cut short, and section headings start at the page title's inline edge.
async function checkPageLayout(pane, title, narrow) {
  const problems = await pane.evaluate((node, narrow) => {
    const rect = n => n.getBoundingClientRect(), shown = n => n.getClientRects().length > 0, out = [];
    const titleX = rect(node.querySelector(".prf-page-title")).left;
    for (const heading of node.querySelectorAll(".prf-heading,.prf-appearance .thp-heading")) {
      if (shown(heading) && Math.abs(rect(heading).left - titleX) > .5) out.push("heading x " + heading.textContent + " " + (rect(heading).left - titleX));
    }
    const overlap = (a, b) => Math.min(a.right, b.right) - Math.max(a.left, b.left) > .5 && Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top) > .5;
    const rows = [...node.querySelectorAll(".prf-row,.prf-appearance :is(.thp-field,.thp-check)")].filter(shown);
    for (const row of rows) {
      const bounds = rect(row), middle = bounds.top + bounds.height / 2, name = (row.querySelector("label,.prf-button") || row).textContent.trim().slice(0, 40);
      const controls = [...row.querySelectorAll(":scope > .prf-control > *:not(.prf-unit), :scope > label > [role=switch], :scope > [role=switch]," +
        " :scope.prf-link > .prf-button:only-of-type, :scope.thp-field > :not(.thp-label,.thp-hint)")].filter(shown);
      if (!narrow) for (const control of controls) {
        const box = rect(control), offset = box.top + box.height / 2 - middle;
        if (Math.abs(offset) > .5) out.push("control off centre " + name + " " + offset);
      }
      const texts = [...row.querySelectorAll(":scope > :is(.prf-label,.prf-help,.thp-label,.thp-hint), :scope > label > span, :scope.thp-check > span")]
        .filter(shown).flatMap(text => [...text.getClientRects()].map(box => ({box, text})));
      for (let i = 0; i < texts.length; i++) for (let j = i + 1; j < texts.length; j++) {
        if (texts[i].text !== texts[j].text && overlap(texts[i].box, texts[j].box)) out.push("overlapping text " + texts[i].text.textContent + " / " + texts[j].text.textContent);
      }
    }
    const font = document.createElement("canvas").getContext("2d");
    for (const select of [...node.querySelectorAll("select")].filter(shown)) {
      const style = getComputedStyle(select), option = select.selectedOptions[0];
      if (!option) continue;
      font.font = style.fontWeight + " " + style.fontSize + " " + style.fontFamily;
      const room = select.clientWidth - parseFloat(style.paddingInlineStart) - parseFloat(style.paddingInlineEnd);
      const need = font.measureText(option.textContent).width;
      if (need > room + .5) out.push("select value cut short " + select.id + " " + option.textContent + " " + need + ">" + room);
    }
    return out;
  }, narrow);
  assert.deepEqual(problems, [], title + " layout");
}

async function checkExternalToolsFirstOpen(browser) {
  const page = await browser.newPage();
  page.setDefaultTimeout(6000);
  try {
    await page.goto(pathToFileURL(path.join(__dirname, "../../app/index.html")).href);
    await page.locator("dialog.sp-dialog[open]").waitFor();
    assert.equal(await page.evaluate(() => !!globalThis.AtriumExternalTools), false);
    await page.evaluate(() => {
      AtriumStartPage.close();
      AtriumPrefs.open("external-tools");
    });
    const section = page.getByRole("dialog", {name:"Preferences", exact:true}).getByRole("group", {name:"External Tools", exact:true});
    await section.getByText("Running external tools needs the Waffle desktop app.", {exact:true}).waitFor();
    assert.equal(await page.evaluate(() => AtriumLazy.has("AtriumExternalTools")), true);
    console.log("PASS opening External Tools directly loads its provider on first use");
  } finally { await page.close(); }
}

// The shared switch slides and crossfades over --motion-toggle, never on first paint, and changes at once under reduced motion.
async function checkSwitchMotion(browser) {
  const page = await browser.newPage({viewport:{width:1250,height:850}, reducedMotion:"no-preference"});
  page.setDefaultTimeout(6000);
  try {
    await page.goto(pathToFileURL(path.join(__dirname, "../../app/index.html")).href);
    await openDemo(page);
    await page.evaluate(async () => { await AtriumLazy.need("AtriumPrefs"); AtriumTheme.set({motion:"full"}, {persist:false}); AtriumPrefs.open("general"); });
    await page.waitForFunction(() => globalThis.AtriumPrefsControls);
    const toggle = page.getByRole("switch", {name:"Autosave recovery snapshots while editing",exact:true});
    const motion = () => toggle.evaluate(input => {
      const label = input.closest("label"), knob = getComputedStyle(label, "::after"), track = getComputedStyle(input);
      const running = document.getAnimations().filter(animation => [input, label].includes(animation.effect?.target))
        .map(animation => [animation.transitionProperty, animation.effect.pseudoElement || "", animation.effect.getTiming().duration]);
      return {knob:[knob.transitionProperty, knob.transitionDuration], track:[track.transitionProperty, track.transitionDuration], running};
    });
    const opened = await motion();
    assert.deepEqual(opened.knob, ["transform", "0.16s"], "the knob slides");
    assert.deepEqual(opened.track, ["background-color, border-color", "0.16s, 0.16s"], "the track crossfades");
    assert.deepEqual(opened.running, [], "no switch animates on first paint");
    await toggle.click();
    const moving = (await motion()).running;
    assert.ok(moving.some(([property, pseudo, ms]) => property === "transform" && pseudo === "::after" && ms === 160), "a click slides the knob: " + JSON.stringify(moving));
    assert.ok(moving.some(([property, pseudo, ms]) => property === "background-color" && !pseudo && ms === 160), "a click crossfades the track");
    await toggle.evaluate(node => Promise.all(node.getAnimations({subtree:true}).map(animation => animation.finished)));
    await page.emulateMedia({reducedMotion:"reduce"});
    const reduced = await motion();
    assert.deepEqual([reduced.knob[1], reduced.track[1]], ["0s", "0s, 0s"], "reduced motion changes a switch at once");
    await toggle.click();
    assert.deepEqual((await motion()).running, [], "no switch transition under reduced motion");
    console.log("PASS shared switch: 160ms slide and crossfade, none on first paint or under reduced motion");
  } finally { await page.close(); }
}

// The window safe area every modal centres in: below the app bar (and the macOS caption), and
// --dialog-margin clear of the window edges.
const safeArea = page => page.evaluate(() => {
  const probe = document.createElement("div");
  probe.style.cssText = "position:fixed;left:0;top:var(--dialog-safe-top);block-size:var(--dialog-avail-h)";
  document.body.append(probe);
  const {top, height} = probe.getBoundingClientRect();
  probe.remove();
  return {top, height};
});

async function checkDrag(page, dialog) {
  await page.setViewportSize({width:1251,height:851});
  const heading = dialog.locator(".prf-window-head .prf-title"), target = await heading.boundingBox();
  const initial = await dialog.boundingBox(), safe = await safeArea(page);
  assert.deepEqual(initial,{x:Math.round((1251 - 960) / 2),y:Math.round(safe.top + (safe.height - 640) / 2),width:960,height:640},
    "odd viewport snaps the window, centred in the dialog safe area, to CSS pixels");
  assert.ok(initial.y >= safe.top,"the centred window stays below the app bar and window controls");
  const input = dialog.getByRole("spinbutton",{name:"Autosave interval",exact:true});
  await input.focus();
  const elevation = await dialog.evaluate(el => getComputedStyle(el).boxShadow);
  assert.notEqual(elevation,"none","the open window has elevation");
  const x = target.x + Math.round(target.width/2), y = target.y + Math.round(target.height/2);
  await page.mouse.move(x,y);
  await page.mouse.down();
  await page.mouse.move(x+24,y+18,{steps:4});
  await page.mouse.up();
  const moved = await dialog.boundingBox();
  closeEnough(moved.x-initial.x,24,"title drag moves the complete window horizontally");
  closeEnough(moved.y-initial.y,18,"title drag moves the complete window vertically");
  assert.equal(await input.evaluate(el => document.activeElement === el),true,"title drag preserves the focused field");
  await page.setViewportSize({width:1253,height:853});
  await page.waitForFunction(() => !document.querySelector(".prf-dialog").style.getPropertyValue("--prf-window-x"));
  const restored = await dialog.boundingBox();
  assert.ok([restored.x,restored.y].every(Number.isInteger),"resize restores a whole-pixel viewport center");
  const restoredSafe = await safeArea(page);
  assert.equal(Math.abs(2 * restored.x + restored.width - 1253),1);
  assert.ok(Math.abs(2 * restored.y + restored.height - (2 * restoredSafe.top + restoredSafe.height)) <= 1,
    "resize restores the window to the centre of the dialog safe area");
  await page.setViewportSize({width:1250,height:850});
}

module.exports = async function preferencesLayout(browser) {
  await checkExternalToolsFirstOpen(browser);
  await checkSwitchMotion(browser);
  const evidence = process.env.WAFFLE_PREFS_SHOTS;
  if (evidence) await fs.mkdir(evidence, {recursive:true});
  const modes = [
    {name:"light", viewport:{width:1250,height:850}},
    {name:"dark", viewport:{width:1250,height:850}},
    {name:"touch", viewport:{width:390,height:790}, isMobile:true, hasTouch:true}
  ];
  for (const {name, ...options} of modes) {
    const page = await browser.newPage({reducedMotion:"reduce", ...options}), errors = [];
    page.on("pageerror", error => errors.push(error.message));
    page.setDefaultTimeout(6000);
    try {
      await page.goto(pathToFileURL(path.join(__dirname, "../../app/index.html")).href);
      await openDemo(page);
      await page.evaluate(async ({providers,name}) => {
        await AtriumLazy.need("AtriumPrefs");
        await Promise.all(providers.map(module => AtriumLazy.need(module)));
        AtriumTheme.set({preset:name === "dark" ? "dark" : "light", followSystem:false, motion:"off"});
        AtriumPrefs.set("labs.notebook", true);
      }, {providers,name});
      assert.equal(await page.evaluate(() => !!globalThis.AtriumPrefsControls), false, "opening the editor does not load Settings controls");
      const file = page.locator('.work-menu[data-menu="file"]');
      await file.locator("summary").click();
      assert.equal(await file.locator('[data-action="preferences"]').count(), 1);
      assert.equal(await file.locator("#sub-file-settings").count(), 0);
      await file.locator('[data-action="preferences"]').click();
      await page.waitForFunction(() => globalThis.AtriumPrefsControls);
      const dialog = page.getByRole("dialog", {name:"Preferences",exact:true});
      const nav = dialog.getByRole("navigation", {name:"Preference pages"});
      const picker = nav.getByRole("combobox", {name:"Preference page",exact:true});
      assert.equal(await dialog.evaluate(node => node.matches(":modal")), false);
      assert.equal(await dialog.getByRole("button", {name:"Done",exact:true}).count(), 0);
      const catalog = await page.evaluate(() => AtriumPrefs.pages());
      assert.deepEqual(catalog.map(x => x.id), routes);
      const touch = name === "touch";
      const show = title => touch ? picker.selectOption({label:title}) : nav.getByRole("button", {name:title,exact:true}).click();
      const pane = dialog.locator(".prf-page"), units = new Map();
      for (const {id,title} of catalog) {
        await show(title);
        await dialog.locator(`.prf-page[data-shown="${id}"]`).waitFor();
        assert.deepEqual(await pane.locator(".prf-page-title").allTextContents(), [title]);
        if (id === "appearance") await pane.getByRole("switch", {name:"Follow the operating system's light/dark setting",exact:true}).waitFor();
        assert.equal(await pane.locator("fieldset,legend").count(), 0, title);
        assert.doesNotMatch(await pane.innerText(), /This page failed to load/, title);
        assert.ok(await pane.evaluate(el => el.clientWidth >= el.scrollWidth - 1), `${title} fits ${name}`);
        await checkPageLayout(pane, `${name} ${title}`, touch);
        if (evidence) {
          if (id === "appearance") await page.waitForFunction(() => {
            const thumbnails = [...document.querySelectorAll(".prf-page .thg-grid img")];
            return thumbnails.length > 0 && thumbnails.every(image => image.complete && image.naturalWidth);
          });
          await dialog.screenshot({path:path.join(evidence,`${name}-${id}.png`)});
        }
        const measured = await measureUnits(pane);
        checkUnits(measured,name);
        for (const row of measured) units.set(row.id,row);
      }
      for (const [id,visible,accessible] of [
        ["prf-general-autosaveMinutes","min","min"], ["prf-pcb-grid","mm","mm"],
        ["prf-routing-dragRerouteCap","conn.","connections"], ["prf-routing-dragRerouteDepth","mm","mm"]
      ]) {
        assert.equal(units.get(id)?.unit,visible);
        assert.equal(units.get(id)?.description,accessible);
        assert.equal(units.get(id)?.lines,1);
      }
      await show("PCB");
      const stepInput = pane.locator("#prf-pcb-grid");
      const face = () => stepInput.evaluate(input => {
        const stepper = input.closest(".prf-stepper"), bounds = element => element.getBoundingClientRect();
        const row = bounds(stepper.closest(".prf-row")), control = bounds(stepper);
        const value = getComputedStyle(input), surface = getComputedStyle(stepper);
        return {type:input.type, font:value.font, align:value.textAlign, background:surface.backgroundColor,
          border:surface.border, width:control.width, height:control.height,
          centerOffset:control.y + control.height / 2 - (row.y + row.height / 2)};
      });
      const {type:nativeType, ...unfocusedFace} = await face();
      await replaceNumber(page, stepInput, 0.005);
      assert.equal(await stepInput.inputValue(), "0.005");
      if (await page.evaluate(() => typeof AtriumLazy.numericField === "function")) {
        await page.waitForFunction(() => Boolean(globalThis.AtriumNumericFields));
        const {type:editingType, ...focusedFace} = await face();
        assert.equal(nativeType,"number");
        assert.equal(editingType,"text","expressions use the existing stepper's editor");
        assert.deepEqual(focusedFace,unfocusedFace,"expression entry keeps the settled number face");
      }
      checkUnits(await measureUnits(pane), name + " precise focused");
      if (touch) {
        const long = "International millimetres";
        await pane.locator("#prf-pcb-grid-unit").evaluate((el,value) => {el.textContent = value;}, long);
        const wrapped = (await measureUnits(pane)).find(row => row.id === "prf-pcb-grid");
        assert.equal(wrapped.unit,long);
        assert.ok(wrapped.lines > 1);
        checkUnits([wrapped], "narrow translated unit");
        const scale = fontSize => page.evaluate(value => AtriumTheme.set({fontSize:value},{persist:false}),fontSize);
        await scale(14);
        try {
          const scaled = (await measureUnits(pane)).find(row => row.id === "prf-pcb-grid");
          assert.ok(scaled.fontSize > 15 && scaled.valueFits && scaled.visible,
            "large system text and wrapped units remain readable: " + JSON.stringify(scaled));
          assert.ok(await pane.evaluate(el => el.clientWidth >= el.scrollWidth - 1),"larger fields fit the compact page");
        } finally { await scale(12); }
      }
      await stepInput.press("Enter");
      assert.equal(await page.evaluate(() => AtriumPrefs.get("pcb.grid")), 0.005);
      if (name === "light") for (const [alias,parent] of Object.entries(legacySections)) {
        await page.evaluate(id => AtriumPrefs.open(id), alias);
        await pane.locator(`[data-prf-section="${alias}"]`).waitFor();
        assert.equal(await pane.getAttribute("data-shown"), parent);
        await page.waitForFunction(id => document.activeElement?.closest("[data-prf-section]")?.dataset.prfSection === id, alias);
      }
      await show("General");
      const geometry = await dialog.evaluate(el => {
        const rect = node => node.getBoundingClientRect();
        const [first,second] = el.querySelectorAll(".prf-group");
        const title = el.querySelector(".prf-page-title"), card = first.querySelector(".prf-card"), heading = first.querySelector(".prf-heading");
        const [row,next] = card.querySelectorAll(".prf-row");
        const number = el.querySelector("#prf-general-autosaveMinutes"), stepper = number.closest(".prf-stepper");
        const select = el.querySelector("#prf-general-language"), label = el.querySelector('label[for="prf-general-language"]');
        const help = el.querySelector("#prf-general-language-help");
        const check = el.querySelector("#prf-general-autosave"), sidebar = el.querySelector(".prf-nav");
        return {width:rect(el).width,height:rect(el).height,sidebar:rect(sidebar).width,body:rect(first.parentElement).width,
          afterTitle:rect(heading).top-rect(title).bottom, titleSize:parseFloat(getComputedStyle(title).fontSize),
          afterSection:rect(second).top-rect(card).bottom,beforeRow:rect(row).top-rect(heading).bottom,rowGap:rect(next).top-rect(row).bottom,
          stepper:rect(stepper).width, unitInside:stepper.contains(el.querySelector("#prf-general-autosaveMinutes-unit")),
          select:rect(select).width,fieldHeight:rect(select).height,fieldInset:parseFloat(getComputedStyle(select).paddingInlineStart),
          helpX:rect(help).left-rect(label).left,helpLine:rect(help).height,
          switchWidth:rect(check).width,switchHeight:rect(check).height,
          rightEdge:rect(select).right-rect(stepper).right, switchEdge:rect(select).right-rect(check).right};
      });
      if (!touch) {
        for (const [key,value] of Object.entries({width:960,height:640,sidebar:220,body:600,select:240,rightEdge:0,switchEdge:0})) closeEnough(geometry[key],value,key);
      }
      for (const [key,value] of Object.entries({afterTitle:24,titleSize:22,afterSection:32,beforeRow:8,rowGap:0,stepper:132,
        fieldHeight:28,fieldInset:8,helpX:0,helpLine:14,switchWidth:34,switchHeight:20})) closeEnough(geometry[key],value,key);
      if (!touch) {
        await checkGeneralRows(page,pane);
        await checkDrag(page,dialog);
        if (name === "dark") {
          await page.evaluate(() => document.documentElement.dir = "rtl");
          try {
            await checkGeneralRows(page,pane);
            checkUnits(await measureUnits(pane),"right-to-left");
          } finally { await page.evaluate(() => document.documentElement.removeAttribute("dir")); }
        }
      }
      assert.equal(geometry.unitInside,true);
      if (!touch) {
        const language = dialog.getByRole("combobox", {name:"Language",exact:true});
        await language.press("Space");
        const popup = page.getByRole("listbox", {name:"Language",exact:true});
        await popup.waitFor();
        const field = await language.boundingBox(), list = await popup.boundingBox();
        closeEnough(list.x,field.x,"dropdown aligns with its field");
        closeEnough(list.y,field.y + field.height + 2,"dropdown uses the shared 2px menu gap");
        await page.keyboard.press("Escape");
        await popup.waitFor({state:"hidden"});
        assert.equal(await dialog.isVisible(), true, "Escape dismisses the dropdown before Preferences");
      }
      const number = dialog.getByRole("spinbutton", {name:"Autosave interval",exact:true});
      const interval = () => page.evaluate(() => AtriumPrefs.get("general.autosaveMinutes"));
      await replaceNumber(page, number, 7, {commit:true}); assert.equal(await interval(), 7);
      await number.press("+"); assert.equal(await interval(), 8);
      await number.press("-"); assert.equal(await interval(), 7);
      await dialog.getByRole("button", {name:"Increase Autosave interval",exact:true}).click(); assert.equal(await interval(), 8);
      await dialog.getByRole("button", {name:"Decrease Autosave interval",exact:true}).click(); assert.equal(await interval(), 7);
      await replaceNumber(page, number, 1, {commit:true}); await number.press("ArrowDown"); assert.equal(await interval(), 1);
      await replaceNumber(page, number, 121, {commit:true}); await number.press("ArrowUp"); assert.equal(await interval(), 120);
      const toggle = dialog.getByRole("switch", {name:"Autosave recovery snapshots while editing",exact:true});
      if (touch) {
        const row = toggle.locator("xpath=../..");
        await row.scrollIntoViewIfNeeded();
        const hit = await row.boundingBox();
        assert.ok(hit.height >= 56, "a helped switch keeps the whole row tappable");
        await page.touchscreen.tap(hit.x+8,hit.y+hit.height-3); assert.equal(await toggle.isChecked(),false);
        await page.touchscreen.tap(hit.x+8,hit.y+hit.height-3); assert.equal(await toggle.isChecked(),true);
      }
      await toggle.press("Space"); assert.equal(await toggle.isChecked(), false);
      const offKnob = await toggle.evaluate(node => getComputedStyle(node.closest("label"),"::after").backgroundColor);
      assert.equal(offKnob,"rgb(255, 255, 255)","the unchecked switch also has a white knob");
      await page.evaluate(() => AtriumPrefs.set({
        "pcb.snapObjects":false, "general.efficiency":"always",
        "clipboard.historySize":45, "clipboard.keepHistory":true, "history.undoBudgetMB":128
      }));
      await dialog.getByRole("button", {name:"Restore Defaults…",exact:true}).click();
      let confirmation = page.getByRole("dialog", {name:"Restore defaults for General?",exact:true});
      await confirmation.getByRole("button", {name:"Cancel",exact:true}).click();
      await confirmation.waitFor({state:"hidden"}); assert.equal(await interval(), 120);
      await dialog.getByRole("button", {name:"Restore Defaults…",exact:true}).click();
      confirmation = page.getByRole("dialog", {name:"Restore defaults for General?",exact:true});
      await confirmation.getByRole("button", {name:"Restore Defaults",exact:true}).click();
      await page.waitForFunction(() => AtriumPrefs.get("general.autosaveMinutes") === 5);
      assert.equal(await toggle.isChecked(), true);
      assert.equal(await page.evaluate(() => AtriumPrefs.get("pcb.snapObjects")), false);
      const savedSettings = await page.evaluate(() => AtriumPrefs.changed());
      for (const key of ["clipboard.historySize","clipboard.keepHistory","history.undoBudgetMB"])
        assert.equal(savedSettings[key], undefined, key + " restores with General");
      assert.equal(savedSettings["general.efficiency"], "always", "efficiency restores with its Display page");
      if (!touch) {
        await file.locator("summary").click();
        assert.equal(await file.getAttribute("open"), "");
        assert.equal(await dialog.isVisible(), true, "the editor menu remains interactive without closing Preferences");
        await file.locator("summary").click();
      }
      await show("PCB");
      const visibleConnections = () => page.evaluate(() => AtriumNavHost.showUnrouted());
      const connections = dialog.getByRole("switch", {name:"Show connection lines (ratsnest)",exact:true});
      const beforeConnections = await visibleConnections();
      await connections.press("Space");
      assert.equal(await visibleConnections(), !beforeConnections, "the workbench previews a setting while Preferences is open");
      await connections.press("Space");
      await show("Keyboard");
      const keyboardEdge = await dialog.locator("#prf-key-preset").evaluate(pick => {
        const row = pick.closest(".prf-row");
        return row.getBoundingClientRect().right - pick.getBoundingClientRect().right;
      });
      closeEnough(keyboardEdge,0,"Keyboard right control edge");
      for (const name of ["Keyboard shortcuts…", "Import VS Code keybindings…"]) {
        const edge = await dialog.getByRole("button", {name,exact:true}).evaluate(action => {
          const row = action.closest(".prf-row");
          return row.getBoundingClientRect().right - action.getBoundingClientRect().right;
        });
        closeEnough(edge,0,name + " right edge");
      }
      await show("Routing");
      const routeGap = await dialog.locator('[data-prf-section="route-suggestions"]').evaluate(section => {
        const preceding = section.previousElementSibling.querySelector(".prf-card");
        return section.querySelector(".prf-heading").getBoundingClientRect().top - preceding.getBoundingClientRect().bottom;
      });
      closeEnough(routeGap,32,"Route Suggestions section gap");
      const search = dialog.getByRole("searchbox", {name:"Search preferences"});
      await search.fill("learn my routing habits");
      await dialog.locator("#prf-routing-habits").waitFor();
      assert.equal(await pane.getAttribute("data-shown"), "routing");
      await search.fill("open sheet to-do");
      await dialog.getByRole("switch", {name:"Open sheet to-do",exact:true}).waitFor();
      assert.equal(await pane.getAttribute("data-shown"), "insights");
      await search.fill("");
      const close = dialog.getByRole("button", {name:"Close Preferences",exact:true});
      if (touch) await close.tap(); else await close.click();
      await dialog.waitFor({state:"hidden"});
      await page.evaluate(() => { AtriumNavHost.canvas().focus(); AtriumPrefs.open("general"); });
      await search.focus(); await search.press("Escape");
      await dialog.waitFor({state:"hidden"});
      assert.equal(await page.evaluate(() => document.activeElement === AtriumNavHost.canvas()), true);
      if (!touch) {
        const appearance = dialog.getByRole("radiogroup", {name:"Color theme",exact:true});
        for (const action of ["theme-preferences", "theme-gallery"]) {
          await page.evaluate(action => {
            const item = document.querySelector(`[data-action="${action}"]`);
            if (item) item.click(); else AtriumNavHost.act(action);
          }, action);
          await appearance.waitFor();
          await close.click();
        }
        await page.evaluate(() => { AtriumTheme.setPreset("dark"); AtriumNavHost.act("theme-picker"); });
        const picker = page.locator("dialog.thq-dialog[open]");
        const theme = () => page.evaluate(() => AtriumTheme.get().preset);
        const stored = () => page.evaluate(() => localStorage.getItem(AtriumTheme.STORE));
        const before = await stored(), input = picker.getByRole("combobox");
        await input.press("ArrowUp");
        const preview = await theme();
        assert.notEqual(preview, "dark");
        assert.equal(await stored(), before, "preview does not persist");
        await input.press("Escape");
        await picker.waitFor({state:"hidden"});
        assert.equal(await theme(), "dark");
        await page.evaluate(() => AtriumNavHost.act("theme-picker"));
        await input.press("ArrowUp");
        await input.press("Enter");
        assert.equal(await theme(), preview);
        assert.equal(JSON.parse(await stored()).preset, preview);
        await page.evaluate(() => AtriumNavHost.act("theme-picker"));
        await picker.getByRole("button", {name:"Appearance Settings…",exact:true}).click();
        await picker.waitFor({state:"hidden"});
        await appearance.waitFor();
        await close.click();
        await page.evaluate(() => AtriumNavHost.act("theme-editor"));
        const editor = page.locator("dialog.the-dialog[open]");
        await editor.getByRole("heading", {name:"Customize Theme",exact:true}).waitFor();
        await page.keyboard.press("Escape");
        await editor.waitFor({state:"hidden"});
        await page.evaluate(async () => {
          const loader = AtriumLazy, prefs = AtriumPrefs;
          globalThis.AtriumPrefs = undefined;
          globalThis.AtriumLazy = {...loader, need: name => name === "AtriumPrefs"
            ? Promise.reject(Error("Preferences load test")) : loader.need(name)};
          try { await AtriumTheme.open(); }
          finally { globalThis.AtriumLazy = loader; globalThis.AtriumPrefs = prefs; }
        });
        assert.match(await page.locator("#status").innerText(), /Preferences load test/);
        assert.equal(await page.locator("dialog[open]").count(), 0);
      }
      assert.deepEqual(errors, [], name);
      console.log(`PASS ${name} modeless Preferences: all ${routes.length} pages, aligned fields, real steppers and focused close`);
    } finally { await page.close(); }
  }
};

if (require.main === module) {
  require("../support/standalone-chromium.cjs")(
    () => ({channel:"chrome",headless:true}),
    browser => module.exports(browser),
    error => { console.error(error); process.exitCode = 1; });
}
