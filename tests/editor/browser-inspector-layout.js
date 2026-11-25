"use strict";

// Beta feedback 0.5.0: library buttons ("New component…", "Symbol wizard…", "IPC wizard…") had no
// visible box, and a long MPN squeezed the other values in the part's Properties. In both themes:
// every text button in the library dialog, Library panel and Nets panel reads as a button, and
// Properties keeps one label/value grid where long labels and values wrap in their own column.
const assert = require("node:assert/strict");
const path = require("node:path");
const {pathToFileURL} = require("node:url");
const {audit} = require("./browser-button-audit.js");

const MPN = "TPS7A4700RGWR-LONG-ORDERING-CODE-0123456789ABCDEF0123456789";
const URL_PARAM = "https://www.example.com/a/very/long/path/to/the/datasheet/tps7a4700-revision-c-final.pdf";

function buttonFace(button) {
  const style = getComputedStyle(button);
  return {height:button.getBoundingClientRect().height, radius:style.borderTopLeftRadius,
    border:style.borderTop, padding:style.paddingInlineStart, fill:style.backgroundColor};
}

async function inspectorControls(page, {touch = false} = {}) {
  const inspector = page.locator("#inspector");
  // The board's Properties keep the Board Shape controls in their own disclosure (ce384db9), with the
  // origin actions as shared Buttons.
  const board = inspector.locator("details.inspector-disclosure > summary[data-t='Board Shape']");
  const pick = inspector.getByRole("button", {name:"Pick point…", exact:true});
  const filter = inspector.getByRole("combobox", {name:"Component class filter"});
  const classes = page.getByRole("dialog", {name:"Component Classes", exact:true});
  const fixture = await page.evaluate(async () => {
    await AtriumLazy.need("AtriumComponentClasses");
    const host = AtriumNavHost, board = host.doc();
    const group = AtriumComponentClasses.list(board, host.project()).find(c => c.name === "Analog front end");
    const [included, excluded] = board.items.filter(item => item.kind === "part" && group.members.includes(item.ref));
    host.select([included.id]);
    await host.act("component-classes");
    return {board:board.name, included:included.id, excluded:excluded.id};
  });
  assert.equal(fixture.board, "Sensor board");
  await classes.getByLabel("New class name").fill("Fixture members");
  await classes.getByRole("button", {name:"Add class", exact:true}).click();
  assert.match(await classes.getByRole("status").textContent(), /1 selected components/);
  await classes.getByRole("button", {name:"Done", exact:true}).click();
  await page.evaluate(({included, excluded}) => AtriumNavHost.select([included, excluded]), fixture);
  const filterToggle = inspector.locator(".pcb-edit-filter-section .section-toggle");
  if (await filterToggle.getAttribute("aria-expanded") === "false") await filterToggle[touch ? "tap" : "click"]();
  await filter.waitFor();

  // A real pointer opens the app's own option list (ui/select-popup.js) below the field; touch keeps
  // the platform picker. Escape closes either and returns focus to the field, where type-to-select works.
  if (touch) await filter.tap(); else await filter.click();
  if (touch) {
    assert.ok(await filter.evaluate(node => node === document.activeElement));
    await inspector.locator("select[aria-label='Component class filter']:open").waitFor();
  } else {
    const list = page.getByRole("listbox", {name:"Component class filter", exact:true});
    await list.waitFor();
    assert.equal(await filter.getAttribute("aria-expanded"), "true", "the field reports its open list");
  }
  await page.keyboard.press("Escape");
  if (!touch) await page.locator("#ui-select-list").waitFor({state:"detached"});
  assert.ok(await filter.evaluate(node => node === document.activeElement), "Escape returns focus to the class field");
  await filter.press("f");
  assert.equal(await filter.inputValue(), "Fixture members");
  assert.ok(await filter.evaluate(node => node === document.activeElement), "class keeps keyboard focus after the inspector refresh");
  const selected = () => page.evaluate(() => AtriumNavHost.selection());
  assert.deepEqual(await selected(), [fixture.included], "member remains selected and the real selection filter prunes its nonmember");
  await filter.selectOption({value:""});
  assert.equal(await filter.inputValue(), "");
  await page.evaluate(({included, excluded}) => AtriumNavHost.select([included, excluded]), fixture);
  assert.deepEqual(new Set(await selected()), new Set([fixture.included, fixture.excluded]), "Any permits both components again");

  await page.evaluate(() => AtriumNavHost.select([]));
  await board.waitFor();
  const original = await board.elementHandle();
  await page.evaluate(id => AtriumNavHost.select([id]), fixture.included);
  await inspector.getByRole("button", {name:"Show in schematic", exact:true}).waitFor();
  assert.equal(await original.evaluate(node => node.isConnected), false, "refresh replaces the genuine Board Shape disclosure");
  assert.equal(await board.count(), 0, "selection leaves no hidden Board Shape disclosure behind");

  const ordinaryActions = async () => inspector.evaluate(panel => [...panel.querySelectorAll("button")]
    .filter(button => button.getClientRects().length && button.textContent.trim() &&
      !button.matches("[aria-expanded],[aria-pressed],[role=tab],.icon-button,.ui-icon-button,.layer-eye,.layer-btn"))
    .map(button => ({name:button.textContent.trim(), shared:button.classList.contains("ui-button"),
      focusable:button.disabled || button.tabIndex >= 0})));
  const actions = await ordinaryActions();
  assert.ok(actions.some(action => action.name === "Show in schematic"), "the selected part renders its normal inspector action");
  assert.deepEqual(actions.filter(action => !action.shared || !action.focusable), [], "selected inspector actions use the shared Button");
  await page.evaluate(() => AtriumNavHost.select([]));
  await board.waitFor();
  assert.equal(await board.count(), 1);
  if (touch) {
    await board.scrollIntoViewIfNeeded();
    const box = await board.boundingBox();
    assert.ok(box.height >= 32, "the Board Shape disclosure is a full-height touch row");
    await page.touchscreen.tap(box.x + box.width / 2, box.y + box.height / 2);
  } else {
    await board.focus();
    await page.keyboard.press("Tab");
    await page.keyboard.press("Shift+Tab");
    assert.ok(await board.evaluate(node => {
      const style = getComputedStyle(node);
      return node === document.activeElement && node.matches(":focus-visible") &&
        style.outlineStyle !== "none" && parseFloat(style.outlineWidth) >= 1;
    }), "Board Shape is reachable with Tab and shows its focus ring");
    await page.keyboard.press("Enter");
  }
  await pick.waitFor();
  assert.equal(await board.evaluate(node => node.parentElement.open), true, "the Board Shape disclosure opens");
  const boardActions = await ordinaryActions();
  assert.ok(boardActions.some(action => action.name === "Pick point…"), "the board renders its Board Shape actions");
  assert.deepEqual(boardActions.filter(action => !action.shared || !action.focusable), [], "board inspector actions use the shared Button");
  if (!touch) {
    await pick.focus();
    await page.keyboard.press("Shift+Tab");
    await page.keyboard.press("Tab");
    assert.ok(await pick.evaluate(node => node === document.activeElement && node.matches(":focus-visible") &&
      getComputedStyle(node).outlineStyle !== "none"), "Board Shape actions are reachable with Tab and show their focus ring");
  }

  await page.evaluate(() => AtriumNavHost.act("component-classes"));
  const reference = classes.getByRole("button", {name:"Add class", exact:true});
  await reference.waitFor();
  // Compare settled faces: the sheet's opening transition scales it for a moment.
  await classes.evaluate(dialog => Promise.allSettled(dialog.getAnimations({subtree:true}).map(animation => animation.finished)));
  const compare = async () => assert.deepEqual(await pick.evaluate(buttonFace), await reference.evaluate(buttonFace),
    "Board Shape actions use the same face as an existing secondary Button");
  await compare();
  const oldToken = await page.evaluate(() => {
    const style = document.documentElement.style, value = style.getPropertyValue("--button-face");
    style.setProperty("--button-face", "rgb(37, 117, 177)");
    return value;
  });
  const settled = locator => locator.evaluate(node => Promise.allSettled(node.getAnimations().map(animation => animation.finished)));
  try {
    await settled(pick);
    assert.equal((await pick.evaluate(buttonFace)).fill, "rgb(37, 117, 177)", "changing the shared button token updates the inspector");
    await compare();
    await pick.evaluate(node => { node.style.borderTopLeftRadius = `calc(${getComputedStyle(node).borderTopLeftRadius} + 1px)`; });
    await assert.rejects(compare, /same face/, "the shared face check detects a one-pixel local override");
  } finally {
    await pick.evaluate(node => { node.style.borderTopLeftRadius = ""; });
    await page.evaluate(value => {
      const style = document.documentElement.style;
      if (value) style.setProperty("--button-face", value); else style.removeProperty("--button-face");
    }, oldToken);
  }
  await classes.getByRole("button", {name:"Done", exact:true}).click();
}

module.exports = async function inspectorLayout(browser) {
  for (const theme of ["dark", "light"]) {
    const page = await browser.newPage({viewport: {width: 1280, height: 860}}), errors = [];
    page.on("pageerror", error => errors.push(error.message));
    page.setDefaultTimeout(6000);
    try {
      await page.goto(pathToFileURL(path.join(__dirname, "../../app/index.html")).href);
      await page.locator("dialog.sp-dialog[open] [data-start-action=demo]").click();
      await page.waitForFunction(() => !!globalThis.AtriumNavHost && AtriumNavHost.doc().kind === "pcb");
      await page.evaluate(t => document.documentElement.setAttribute("data-theme", t), theme);
      await inspectorControls(page);
      const buttons = async where => {
        const bad = await page.evaluate(audit);
        assert.deepEqual(bad, [], theme + ": every text button in " + where + " has a visible box");
      };
      // Properties of a placed part with long parameter names and values, on the board and the sheet.
      await page.evaluate(({MPN, URL_PARAM}) => {
        const H = AtriumNavHost, board = H.project().documents.find(d => d.kind === "pcb");
        H.selectDocument(board.id);
        const part = H.doc().items.find(i => i.kind === "part"), def = H.project().library.find(d => d.id === part.def);
        def.parameters = {...def.parameters, "Manufacturer Part Number": MPN, Datasheet: URL_PARAM};
        H.select([part.id]);
      }, {MPN, URL_PARAM});
      await page.waitForFunction(() => [...document.querySelectorAll("#inspector .property-row > span")].some(n => n.textContent === "Library") && document.querySelector("#inspector details"));
      await page.evaluate(() => {
        // A selection or lazy inspector extension can redraw the panel before the toggle event.
        for (const d of document.querySelectorAll("#inspector details")) if (!d.open) d.querySelector("summary").click();
        const h = AtriumNavHost;
        h.select([h.doc().items.find(i => i.kind === "part").id]);
      });
      const rows = await page.evaluate(() => {
        const box = document.getElementById("inspector").getBoundingClientRect();
        return [...document.querySelectorAll("#inspector .property-row")].filter(r => r.getClientRects().length).map(r => {
          const [label, value] = [r.children[0], r.children[1]], a = label.getBoundingClientRect(), b = value?.getBoundingClientRect();
          return {label: label.textContent, value: value?.textContent, labelW: a.width, valueX: b?.left, valueW: b?.width, rowW: r.getBoundingClientRect().width,
            inside: (b?.right ?? 0) <= box.right + 1 && a.right <= box.right + 1, overflow: value ? value.scrollWidth > value.clientWidth + 1 : false,
            selectable: value ? getComputedStyle(value).userSelect !== "none" : true};
        });
      });
      const lib = rows.find(r => r.label === "Library");
      assert.ok(lib, theme + ": the board inspector lists the library " + JSON.stringify(rows.map(r => r.label)));
      for (const r of rows) {
        assert.ok(r.inside && !r.overflow, theme + ": " + r.label + " stays inside Properties");
        assert.ok(r.labelW <= r.rowW * .45 && r.valueW >= r.rowW * .5, theme + ": " + r.label + " keeps the label/value grid " + JSON.stringify(r));
        assert.ok(r.selectable, theme + ": " + r.label + "'s value can be selected and copied");
      }
      // The board shows the schematic's Parameters grid read-only (cohesion): the long MPN is there,
      // its name wraps, and the grid stays inside Properties.
      await page.waitForFunction(() => !!document.querySelector("#inspector .part-params .sch-param-grid"));
      const grid = await page.evaluate(() => {
        const box = document.getElementById("inspector").getBoundingClientRect(), g = document.querySelector("#inspector .part-params .sch-param-grid");
        if (!g) return null;
        const names = [...g.querySelectorAll(".sch-param-name")], values = [...g.querySelectorAll("input:not([type=checkbox])")];
        return {values: values.map(v => v.value), readOnly: values.every(v => v.readOnly), inside: g.getBoundingClientRect().right <= box.right + 1,
          clipped: names.filter(n => n.scrollWidth > n.clientWidth + 1).map(n => n.textContent)};
      });
      assert.ok(grid && grid.values.includes(MPN), theme + ": the board inspector lists the MPN " + JSON.stringify(grid));
      assert.ok(grid.readOnly && grid.inside && !grid.clipped.length, theme + ": the board's Parameters grid is read-only, inside Properties, names unclipped " + JSON.stringify(grid));

      await page.evaluate(() => {
        const H = AtriumNavHost, sheet = H.project().documents.find(d => d.kind === "schematic");
        H.selectDocument(sheet.id);
        H.select([H.doc().items.find(i => i.kind === "part").id]);
      });
      await page.locator("#inspector .sch-param-name").first().waitFor();
      const names = await page.evaluate(() => [...document.querySelectorAll("#inspector .sch-param-name")].map(n => ({
        text:[...n.childNodes].filter(node=>node.nodeType===Node.TEXT_NODE).map(node=>node.textContent).join("").trim(),
        clipped:n.scrollWidth > n.clientWidth + 1 || getComputedStyle(n).textOverflow === "ellipsis" && n.scrollWidth > n.clientWidth
      })));
      assert.ok(names.some(n => n.text === "Manufacturer Part Number") && names.every(n => !n.clipped), theme + ": schematic parameter names wrap instead of hiding behind an ellipsis " + JSON.stringify(names));
      await page.evaluate(() => AtriumNavHost.act("library-catalogue")); // Place › Component Catalogue… (Place › Component opens the Library dock)
      await page.locator("#library-dialog[open] #new-library-component").waitFor();
      await buttons("the component library");
      const heading = await page.evaluate(() => [...document.querySelectorAll("#library-dialog .dialog-heading button:not(.ui-icon-button)")].map(b => {
        const s = getComputedStyle(b);
        return {text: b.textContent.trim(), border: parseFloat(s.borderTopWidth), style: s.borderTopStyle};
      }));
      assert.ok(heading.length >= 4 && heading.every(b => b.border >= 1 && b.style === "solid"), theme + ": library heading buttons are outlined " + JSON.stringify(heading));
      await page.locator("#new-library-component").focus();
      await page.keyboard.press("Tab");
      const ring = await page.evaluate(() => { const s = getComputedStyle(document.activeElement); return s.outlineStyle !== "none" && parseFloat(s.outlineWidth) >= 1; });
      assert.ok(ring, theme + ": a keyboard-focused library button shows a focus ring");
      await page.keyboard.press("Escape");
      await page.evaluate(() => AtriumNavHost.act("library-panel"));
      await page.locator("#properties .panel-library .lib-row").first().waitFor();
      await buttons("the Library panel");
      await page.evaluate(() => AtriumNavHost.act("nets-panel"));
      await page.getByRole("grid", {name:"Nets", exact:true}).waitFor();
      await buttons("the Nets panel");

      assert.deepEqual(errors, []);
    } finally { await page.close(); }
  }
  const touch = await browser.newPage({viewport:{width:820,height:800},hasTouch:true}), touchErrors = [];
  touch.on("pageerror", error => touchErrors.push(error.message));
  touch.setDefaultTimeout(6000);
  try {
    await touch.goto(pathToFileURL(path.join(__dirname, "../../app/index.html")).href);
    await touch.locator("dialog.sp-dialog[open] [data-start-action=demo]").tap();
    await touch.waitForFunction(() => globalThis.AtriumNavHost?.doc()?.kind === "pcb");
    await inspectorControls(touch, {touch:true});
    assert.deepEqual(touchErrors, []);
  } finally { await touch.close(); }
  console.log("PASS Sensor board Class filtering and shared inspector Buttons in both themes and on touch; Properties keeps long values aligned");
};
