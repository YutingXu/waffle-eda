"use strict";
// Beta feedback regressions for editing, navigation and input (run by integration-browser.cjs with trusted
// Playwright input). The WKWebView counterparts are in native/tests/macos-harness/ui-probes.js.

const assert = require("node:assert/strict");
const path = require("node:path");
const {pathToFileURL} = require("node:url");

async function open(browser) {
  const page = await browser.newPage({viewport: {width: 1480, height: 950}}), errors = [];
  page.on("pageerror", err => errors.push(err.message));
  let releaseTextMenu;
  const menuLoad = new Promise(resolve => { releaseTextMenu = resolve; });
  await page.route("**/context-menu.js", async route => { await menuLoad; await route.continue(); });
  await page.goto(pathToFileURL(path.join(__dirname, "../../app/index.html")).href);
  await page.locator("dialog.sp-dialog[open] [data-start-action=demo]").click();
  await page.waitForFunction(() => !!globalThis.AtriumNavHost && AtriumNavHost.doc().kind === "pcb");
  return {page, errors, releaseTextMenu};
}
const act = (page, a) => page.evaluate(a => window.dispatchEvent(new CustomEvent("atrium-command", {detail: a})), a);
async function toKind(page, kind) {
  await page.evaluate(async k => {
    const h = AtriumNavHost;
    await h.selectDocument(h.project().documents.find(d => d.kind === k).id);
    h.setTool("select");
    await h.prepareLaunch();
  }, kind);
  return page.evaluate(() => { const r = AtriumNavHost.canvas().getBoundingClientRect(); return [r.left, r.top, r.width, r.height]; });
}

async function coldTextMenu(page, release) {
  try {
    await toKind(page, "schematic");
    await page.evaluate(() => AtriumNavHost.select(["s-R1"]));
    const field = page.getByRole("textbox", {name:"Comment", exact:true});
    await field.click();
    const original = await field.inputValue(), input = await field.elementHandle();
    await input.evaluate(node => node.select());
    assert.equal(await page.evaluate(() => Boolean(globalThis.AtriumContextMenu)), false, "the first text context menu starts cold");
    const requested = page.waitForRequest("**/context-menu.js");
    await page.keyboard.press("Shift+F10");
    await requested;
    assert.equal(await page.evaluate(() => Boolean(globalThis.AtriumContextMenu)), false, "the menu module is still held during composition");

    const cdp = await page.context().newCDPSession(page), text = "抵抗 Ω";
    await cdp.send("Input.imeSetComposition", {text, selectionStart:text.length, selectionEnd:text.length});
    release();
    await page.evaluate(() => AtriumLazy.need("AtriumContextMenu"));
    const menu = page.getByRole("menu", {name:"Text", exact:true});
    assert.equal(await menu.count(), 0, "a queued context menu does not interrupt active composition");
    assert.ok(await input.evaluate(node => node === document.activeElement));
    assert.equal(await input.inputValue(), text);
    await cdp.send("Input.insertText", {text});
    await page.keyboard.press("Tab");
    await page.waitForFunction(value => AtriumNavHost.doc().items.find(item => item.id === "s-R1")?.value === value, text);
    assert.equal(await field.inputValue(), text);
    await page.evaluate(() => AtriumNavHost.act("undo"));
    assert.equal(await field.inputValue(), original);

    await field.click(); await page.keyboard.press("Shift+F10");
    await menu.waitFor();
    await page.keyboard.press("Escape"); await menu.waitFor({state:"hidden"});
    assert.ok(await field.evaluate(node => node === document.activeElement));
  } finally {release();}
}

// Find Text and Find and Replace share a modeless dialog. Native closure must release it.
async function findReplaceReopening(page) {
  await toKind(page, "schematic");
  const menu = page.locator('details[data-menu="edit"]');
  const dialog = page.getByRole("dialog", {name:"Find and Replace Text"});
  const canvas = page.locator("canvas#canvas");
  async function clickEdit(action) {
    await menu.locator(":scope > summary").click();
    await menu.locator('[data-action="' + action + '"]').click();
  }
  const closeNative = () => dialog.evaluate(async node => {
    const closed = new Promise(resolve => node.addEventListener("close", resolve, {once:true}));
    node.close();
    await closed;
    return node.isConnected;
  });
  const findFocused = () => dialog.getByRole("textbox", {name:"Find", exact:true}).evaluate(node => node === document.activeElement);

  await clickEdit("find-text");
  const stillConnected = await closeNative();
  await clickEdit("find-replace");
  assert.ok(await dialog.isVisible(), "the warm Edit menu opens Find and Replace after native close");
  assert.equal(stillConnected, false, "native close detaches the previous dialog");
  assert.match(await page.locator("#status").textContent(), /^Find and replace:/);
  assert.ok(await findFocused(), "the warm Edit menu focuses Find");

  // Reopen within the same turn, before the old dialog's close event can be delivered.
  const reopened = await dialog.evaluate(node => {
    node.close();
    document.querySelector('details[data-menu="edit"] [data-action="find-replace"]').click();
    const next = document.querySelector("dialog.fr-dialog[open]");
    return next !== node && !!next?.getClientRects().length;
  });
  assert.ok(reopened, "the warm Edit command opens before the old close event is delivered");
  await page.waitForFunction(() => document.querySelectorAll("dialog.fr-dialog").length === 1);
  await closeNative();

  await canvas.focus();
  await page.keyboard.press("Control+h");
  assert.ok(await findFocused(), "the warm shortcut reopens the dialog and focuses Find");
  await page.keyboard.press("Escape");
  await page.locator("dialog.fr-dialog").waitFor({state:"detached"});
  assert.ok(await canvas.evaluate(node => node === document.activeElement), "Escape restores editor focus");
}

async function contextSelectNet(page) {
  await toKind(page, "pcb");
  const fixture = await page.evaluate(() => {
    const h = AtriumNavHost, doc = h.doc(), canvas = h.canvas(), rect = canvas.getBoundingClientRect();
    const points = [];
    for (let y = 90; y < rect.height - 60 && points.length < 3; y += 75) {
      for (let x = 48; x < rect.width - 55 && points.length < 3; x += 90) {
        if (!h.hit(canvas, rect.left + x, rect.top + y)?.item) points.push([x,y]);
      }
    }
    if (points.length !== 3) throw Error("Expected room for three isolated test tracks.");
    const vcc = "VCC-CONTEXT", gnd = "GND-CONTEXT", before = h.selection();
    const tracks = points.map(([x,y],index) => ({
      id:Atrium.id(), kind:"track", layer:"Top", net:index === 0 ? vcc : gnd, width:.25,
      points:[h.view().screenToWorld([x-12,y]), h.view().screenToWorld([x+12,y])]
    }));
    h.edit(() => doc.items.push(...tracks));
    h.select(tracks.slice(0,2).map(item => item.id));
    const [x,y] = points[1], at = [rect.left+x,rect.top+y];
    if (h.hit(canvas,...at)?.item?.id !== tracks[1].id) throw Error("Expected the clicked track on "+gnd);
    return {at, before, ids:tracks.map(item => item.id)};
  });
  try {
    await page.mouse.click(...fixture.at, {button:"right"});
    const action = page.locator('.nav-menu-portal [data-menu-action="select-net"]');
    assert.match(await action.innerText(), /GND-CONTEXT/);
    await action.click();
    const selection = await page.evaluate(() => Array.from(AtriumNavHost.selection()));
    assert.deepEqual(selection.sort(), fixture.ids.slice(1).sort(), "Select Net expands the clicked GND track");
  } finally {
    await page.evaluate(({before,ids}) => {
      const h=AtriumNavHost;
      h.edit(() => {h.doc().items=h.doc().items.filter(item=>!ids.includes(item.id));});
      h.select(before);
    }, fixture);
  }
}

// A stationary right click presents the menu without repainting an unchanged canvas.
async function canvasContextMenu(page) {
  await toKind(page, "pcb");
  await page.waitForFunction(() => {
    const checks = globalThis.AtriumChecks?.live();
    return checks?.project === AtriumNavHost.project() && checks.result && !globalThis.AtriumDRCView?.status();
  });
  const {parts, empty, markersVisible} = await page.evaluate(async () => {
    const h = AtriumNavHost;
    await AtriumLazy.need(["AtriumCrossProbe", "AtriumDRCMarkers"]);
    const markersVisible = AtriumDRCMarkers.visible();
    AtriumDRCMarkers.setVisible(false, h);
    const c = h.canvas(), r = c.getBoundingClientRect(), parts = [];
    for (const item of h.doc().items) {
      if (item.kind !== "part") continue;
      const [x, y] = h.view().worldToScreen([item.x, item.y]);
      if (x < 30 || y < 30 || x > r.width - 30 || y > r.height - 30) continue;
      const at = [r.left + x, r.top + y];
      if (h.hit(c, ...at)?.item === item) parts.push({id:item.id, ref:item.ref, at});
      if (parts.length === 2) break;
    }
    if (parts.length !== 2) throw Error("Expected two components on the canvas");
    const empty = [r.left + 20, r.top + 20];
    if (h.hit(c, ...empty)?.item) throw Error("Expected a blank corner of the canvas");
    h.select([parts[0].id]); c.focus();
    await h.prepareLaunch();
    return {parts, empty, markersVisible};
  });
  const [first, second] = parts;
  async function show(at) {
    await page.mouse.move(...at);
    await page.evaluate(async () => {
      const nextPaint = () => new Promise(resolve => requestAnimationFrame(() => {
        const {port1, port2} = new MessageChannel();
        port1.onmessage = () => {port1.close(); port2.close(); resolve();};
        port2.postMessage(0);
      }));
      await nextPaint();
      await nextPaint();
      const h = AtriumNavHost, v = h.view(), panel = document.getElementById("inspector");
      const render = v.render, content = panel.firstElementChild;
      let draws = 0;
      v.render = (...args) => {draws++; return render.apply(v, args);};
      window.menuFirstFrame = new Promise(resolve => {
        document.addEventListener("contextmenu", async () => {
          await nextPaint();
          const first = {draws, selection:h.selection(), rebuilt:content !== panel.firstElementChild};
          await nextPaint();
          v.render = render;
          resolve({...first, finalDraws:draws});
        }, {capture:true, once:true});
      });
    });
    await page.mouse.down({button:"right"});
    await page.mouse.up({button:"right"});
    await menu.waitFor();
    return page.evaluate(() => window.menuFirstFrame);
  }
  const menu = page.locator(".nav-menu-portal > .nav-menu");
  try {
    assert.deepEqual(await show(first.at), {draws:0, selection:[first.id], rebuilt:false, finalDraws:0});
    await menu.filter({hasText:first.ref}).waitFor();
    await page.keyboard.press("ArrowDown");
    assert.equal(await menu.locator("[role=menuitem]:focus").count(), 1);
    await page.keyboard.press("Escape");
    await menu.waitFor({state:"hidden"});
    assert.equal(await page.evaluate(() => document.activeElement === AtriumNavHost.canvas()), true);

    const changed = await show(second.at);
    assert.deepEqual(changed, {draws:0, selection:[second.id], rebuilt:true, finalDraws:1});
    const lock = menu.locator("[data-menu-action=lock]");
    await lock.click();
    await page.waitForFunction(id => AtriumNavHost.doc().items.find(i => i.id === id)?.locked, second.id);
    await menu.waitFor({state:"hidden"});
    await page.keyboard.press("Shift+F10");
    await menu.locator("[data-menu-action=unlock]").click();
    await page.waitForFunction(id => !AtriumNavHost.doc().items.find(i => i.id === id)?.locked, second.id);
    await menu.waitFor({state:"hidden"});

    assert.deepEqual(await show(empty), {draws:0, selection:[second.id], rebuilt:false, finalDraws:0});
    await page.keyboard.press("Escape");
    await menu.waitFor({state:"hidden"});

    await page.evaluate(() => AtriumNavHost.setTool("measure"));
    await page.mouse.click(...empty, {button:"right"});
    await menu.waitFor();
    assert.equal(await page.evaluate(() => AtriumNavHost.tool()), "select");
    await page.keyboard.press("Escape");
    await menu.waitFor({state:"hidden"});

    const camera = () => page.evaluate(() => AtriumNavHost.view().camera());
    const initial = await camera();
    const pan = async () => {
      await page.mouse.move(...empty);
      await page.mouse.down({button:"right"});
      await page.mouse.move(empty[0] + 30, empty[1] + 20, {steps:4});
      await page.mouse.up({button:"right"});
      assert.equal(await menu.isVisible(), false);
      return camera();
    };
    const plain = await pan();
    assert.notEqual(plain.cx, initial.cx);
    assert.notEqual(plain.cy, initial.cy);
    assert.equal(plain.scale, initial.scale);
    await page.evaluate(pose => {
      const h = AtriumNavHost;
      h.view().restoreCamera(pose);
      h.redraw();
    }, initial);
    const selection = await page.evaluate(() => AtriumNavHost.selection());
    await page.keyboard.down("Control");
    try {
      assert.deepEqual(await show(empty), {draws:0, selection, rebuilt:false, finalDraws:0});
      assert.deepEqual(await camera(), initial, "Ctrl+secondary click opens the same menu at the same zoom");
      await page.keyboard.press("Escape");
      await menu.waitFor({state:"hidden"});
      assert.deepEqual(await pan(), plain, "Ctrl+secondary drag pans exactly like secondary drag");
    } finally {
      await page.keyboard.up("Control");
    }
  } finally {
    await page.evaluate(visible => AtriumDRCMarkers.setVisible(visible, AtriumNavHost), markersVisible);
  }
}

// The selection marquee has a solid, opaque edge in the palette's marquee ink on sheets and boards, in light and dark UI.
async function marquee(page) {
  for (const theme of ["theme-light", "theme-dark"]) {
    await act(page, theme);
    // Measure the themed canvas after the browser has removed its snapshot layer.
    await page.waitForFunction(theme => document.documentElement.dataset.theme === theme.slice(6) &&
      !document.documentElement.hasAttribute("data-theme-fading"), theme);
    for (const kind of ["schematic", "pcb"]) {
      const [x, y] = await toKind(page, kind);
      await page.mouse.move(x + 40, y + 120); await page.mouse.down(); await page.mouse.move(x + 400, y + 330, {steps: 4});
      const edge = await page.evaluate(([kind]) => {
        const c = AtriumNavHost.canvas(), k = c.width / c.getBoundingClientRect().width, ink = kind === "pcb" ? AtriumPCBAppearance.system.marquee : AtriumSchAppearance.marquee;
        const want = [1, 3, 5].map(i => parseInt(ink.slice(i, i + 2), 16));
        // Along the top edge (y = 120 CSS px), the row nearest the edge must carry the ink exactly.
        const rows = [];
        for (let dy = -2; dy <= 2; dy++) {
          const a = c.getContext("2d").getImageData(Math.round(220 * k), Math.round(120 * k) + dy, 1, 1).data;
          rows.push(Math.max(...want.map((v, n) => Math.abs(v - a[n]))));
        }
        return Math.min(...rows);
      }, [kind]);
      await page.mouse.up(); await page.keyboard.press("Escape");
      assert.ok(edge <= 2, `${theme} ${kind} marquee edge is drawn in its marquee ink (off by ${edge})`);
    }
  }
}

// Escape dismisses the Library picker, dialogs and floating panels, and gives the keyboard back to
// the canvas. Nets stays open, while Messages dismisses from its focused list.
async function escape(page) {
  const closed = () => {
    const dialogs = [...document.querySelectorAll("dialog[open]")].map(d => d.id || d.className);
    const floats = [...document.querySelectorAll(".vc-panel, .dock-float")].filter(e => e.getClientRects().length).length;
    const library = !!document.querySelector(".panel-library")?.getClientRects().length;
    const focus = document.activeElement === AtriumNavHost.canvas();
    return !dialogs.length && !floats && !library && focus && {dialogs, floats, library, focus};
  };
  const common = [
    ["library", '[data-dock-panel="library"]', "library"], ["library-panel", '[data-dock-panel="library"]', "library"],
    ["nets-panel", '[data-dock-panel="nets"]', "nets", ".nets-table"], ["messages", '[data-dock-panel="messages"]', "messages", ".msg-grid"],
    ["find-replace", "dialog.fr-dialog[open]"], ["command-palette", "dialog#palette[open]"],
    ["preferences", "dialog.prf-dialog[open]"], ["shortcuts", "dialog.kcs-dialog[open]"], ["bom", "dialog.bom-dialog[open]"],
  ];
  for (const kind of ["schematic", "pcb"]) {
    await toKind(page, kind);
    const cases = kind === "pcb" ? [...common, ["view-config", ".vc-panel"], ["stackup", "dialog.stk-dialog[open]"]] : common;
    for (const [a, selector, dock, reference] of cases) {
      const target = page.locator(selector);
      // An inactive tab can still be open. Close it before exercising the command's open path.
      if (dock) {
        await page.evaluate(id => { if (AtriumDock.reveal(id)) AtriumDock.toggle(id); }, dock);
        await page.waitForFunction(id => !AtriumDock.panels().find(p => p.id === id)?.open, dock);
      }
      await target.waitFor({state:"hidden"});
      await page.evaluate(() => AtriumNavHost.canvas().focus());
      await act(page, a);
      await target.waitFor();
      if (reference) await target.locator(reference).focus();
      if (a === "library-panel") {
        const search = target.getByRole("searchbox");
        const focus = await search.evaluate(async input => {
          const panel = input.closest("[data-dock-panel]");
          input.focus();
          AtriumDock.toggle("library");
          const closed = panel.hidden;
          await AtriumNavHost.act("library-panel");
          input.focus();
          const reopened = !panel.hidden && document.activeElement === input;
          // The earlier close has queued its focus restore for this frame.
          await new Promise(resolve => requestAnimationFrame(resolve));
          return {closed, reopened, searchFocused: document.activeElement === input};
        });
        assert.deepEqual(focus, {closed: true, reopened: true, searchFocused: true},
          "reopening Library before the close frame preserves search focus");
        await page.keyboard.type("res");
        assert.equal(await search.inputValue(), "res", "The Library search receives the typed text");
        await page.keyboard.press("Escape");
        assert.equal(await search.inputValue(), "", "Escape clears the Library search first");
        assert.ok(await search.evaluate(n => n === document.activeElement), "The first Escape keeps focus in the Library");
      }
      await target.and(page.locator(":focus-within")).waitFor();
      await page.keyboard.press("Escape");
      const s = await (await page.waitForFunction(closed)).jsonValue();
      assert.deepEqual(s, {dialogs: [], floats: 0, library: false, focus: true}, `${kind} ${a}: Escape dismisses it and focuses the canvas`);
      if (dock === "nets") assert.ok(await target.isVisible(), `${kind} ${a}: Escape leaves Nets visible`);
      if (dock === "messages") await target.waitFor({state:"hidden"});
    }
  }
}

async function propertiesChrome(page) {
  // The wire-drag fixture uses an empty PCB. Start the selection filter with the
  // stock demo so it has both real board tracks and schematic wires to deselect.
  await page.evaluate(() => AtriumNavHost.replaceProject(AtriumParts.example(), {force:true, dirty:false}));
  const tabs = page.locator("#properties .editor-chrome-tabs");
  const props = page.getByRole("tab", {name:"Properties",exact:true});
  const components = page.getByRole("tab", {name:"Components",exact:true});
  await props.click();
  for (const [kind, object, label] of [["pcb","track","Tracks"],["schematic","wire","Wires"]]) {
    await toKind(page,kind);
    const metrics = await tabs.evaluate(strip => {
      const selected = getComputedStyle(strip.querySelector(".dock-tab-wrap.is-active"),"::after");
      const header = document.querySelector(".pcb-edit-filter-section > .inspect-section-heading");
      return [strip.getBoundingClientRect().height,selected.height,selected.insetInlineStart,header.getBoundingClientRect().height];
    });
    assert.deepEqual(metrics,[32,"2px","8px",32],kind + " exposes matching tab and section metrics");
    const selected = await page.evaluate(object => {
      const h = AtriumNavHost, fixture = h.doc().items.find(item => item.kind === object);
      if (!fixture) throw Error("The demo has no " + object + " to select.");
      h.select([fixture.id]);
      return h.selection().includes(fixture.id);
    },object);
    assert.equal(selected,true,"the selection contains the object that the filter will exclude");
    const filters = page.getByRole("group", {name:"Selection filter",exact:true});
    const header = page.locator(".pcb-edit-filter-section > .inspect-section-heading");
    const toggle = header.locator(".section-toggle");
    if (await toggle.getAttribute("aria-expanded") === "false") await toggle.click();
    const chip = filters.getByRole("button", {name:label,exact:true});
    const width = (await chip.boundingBox()).width;
    await chip.focus();
    await page.keyboard.press("Space");
    assert.equal(await chip.getAttribute("aria-pressed"),"false");
    assert.equal((await chip.boundingBox()).width,width,"filter state does not resize its chip");
    assert.ok(await chip.evaluate(element => element === document.activeElement),"filter retains focus after pruning the selection");
    assert.deepEqual(await page.evaluate(() => AtriumNavHost.selection()),[]);
    const all = header.getByRole("link", {name:"Select all",exact:true});
    await all.hover();
    assert.equal(await all.evaluate(element => getComputedStyle(element).textDecorationLine),"underline");
    await all.focus();
    await page.keyboard.press("Enter");
    assert.equal(await filters.getByRole("button", {pressed:false}).count(),0);
    assert.ok(await all.evaluate(element => element === document.activeElement),"restoring every kind retains link focus");
    const disclosure = header.getByRole("button", {name:"Selection Filter",exact:true});
    assert.equal(await disclosure.getAttribute("aria-expanded"),"true","Select all leaves the disclosure open");
    await disclosure.focus();
    await page.keyboard.press("Space");
    assert.equal(await disclosure.getAttribute("aria-expanded"),"false");
    assert.ok(await all.isVisible(),"the header link stays independently available while the chips are collapsed");
    await page.keyboard.press("Space");
    assert.equal(await disclosure.getAttribute("aria-expanded"),"true");
    const labelMetrics = () => tabs.getByRole("tab").evaluateAll(nodes=>nodes.map(node=>[
      getComputedStyle(node).fontWeight,node.getBoundingClientRect().width,
    ]));
    const before = await labelMetrics();
    assert.equal(new Set(before.map(([weight])=>weight)).size,1,"active and inactive panel tabs use one weight");
    await components.click();
    assert.ok(await page.getByRole("listbox", {name:"Components",exact:true}).isVisible());
    assert.deepEqual(await labelMetrics(),before,"selecting a panel leaves both label weights and widths fixed");
    await components.focus();
    await page.keyboard.press("ArrowLeft");
    assert.equal(await props.getAttribute("aria-selected"),"true");
    assert.deepEqual(await labelMetrics(),before,"keyboard selection leaves both label weights and widths fixed");
    assert.ok(await props.evaluate(element => element === document.activeElement),"keyboard tab navigation focuses the exposed panel tab");
  }
  await toKind(page,"pcb");
  const inspector = page.locator("#inspector");
  assert.equal(await inspector.getByRole("button", {name:"Board Shape…",exact:true}).count(),0);
  const shape = inspector.locator('summary[data-t="Board Shape"]');
  assert.equal(await shape.count(),1,"Board Shape occurs once in Properties");
  await shape.focus();
  await page.keyboard.press("Enter");
  await inspector.getByRole("textbox", {name:/^Width \(/}).waitFor();
  const design = page.locator('.work-menu[data-menu="design"]');
  await design.locator("summary").click();
  await design.getByRole("menuitem", {name:"Board Shape",exact:true}).hover();
  await design.getByRole("menuitem", {name:"Edit Dimensions…",exact:true}).click();
  const dialog = page.getByRole("dialog", {name:"Board Shape",exact:true});
  await dialog.waitFor();
  await page.keyboard.press("Escape");
  await dialog.waitFor({state:"hidden"});
}

// One docking convention: every browse panel opened from a rail button, menu or key docks in the right side
// bar (with Properties), never a dialog or the left bar; the project tree and Navigator stay on the left.
async function docking(page) {
  await page.waitForFunction(() => !!globalThis.AtriumDock?.current?.());
  for (const kind of ["schematic", "pcb"]) {
    await toKind(page, kind);
    for (const a of ["nets-panel", "library-panel", "query-panel", "comments-panel", "signals-panel", "navigator-panel"]) {
      await act(page, a);
      await page.waitForFunction(a => AtriumLazy.has(AtriumLazy.forAction(a, AtriumNavHost.doc().kind) || []), a);
      const where = await page.evaluate(() => {
        const L = AtriumDock.current(), out = {}, dialogs = document.querySelectorAll("dialog[open]").length;
        for (const [area, groups] of Object.entries(L.areas)) for (const g of groups) for (const id of g.panels) out[id] = area;
        return {out, dialogs};
      });
      assert.equal(where.dialogs, 0, a + " opens no dialog");
      for (const id of ["properties", "components", "library", "nets", "filter", "comments", "signals"]) if (where.out[id]) assert.equal(where.out[id], "right", `${kind} ${a}: ${id} docks right`);
      for (const id of ["projects", "navigator"]) if (where.out[id]) assert.equal(where.out[id], "left", `${kind} ${a}: ${id} docks left`);
    }
  }
}

// Grid level of detail: lines stay one device pixel wide at every zoom, and zooming across a pitch doubling
// changes nothing on screen (the odd lines have faded out by then), on boards and on sheets.
async function gridLod(page) {
  const r = await page.evaluate(() => {
    const c = document.createElement("canvas"); c.style.cssText = "position:fixed;left:-500px;top:0;width:300px;height:200px"; document.body.append(c);
    try {
      const v = AtriumCanvas.create(c), g = c.getContext("2d"), defs = new Map(), out = {};
      for (const kind of ["pcb", "schematic"]) {
        const d = {id: "lod-" + kind, kind, grid: 1, items: [], outline: []}, opts = {grid: true, origin: false, noReuse: true};
        // The pitch doubles below 12 px on boards and below 8 px (sheet grid 2.54 mm) on sheets.
        const pitch = kind === "pcb" ? 12 : 8 / 2.54, shot = s => { v.restoreCamera({...v.camera(), cx: 3.3, cy: kind === "pcb" ? 2.1 : -40.1, scale: s}); v.render(d, defs, opts); return g.getImageData(0, 0, c.width, c.height).data; };
        const above = shot(pitch * 1.00001), below = shot(pitch * .99999);
        let worst = 0; for (let i = 0; i < above.length; i++) worst = Math.max(worst, Math.abs(above[i] - below[i]));
        // Widest run of grid-coloured columns along one row between line crossings (hairline: 1 px).
        const mid = shot(pitch * 1.6), row = 7, bg = [...mid.slice((row * c.width + 1) * 4 - 4, (row * c.width + 1) * 4 - 1)];
        let run = 0, widest = 0;
        for (let x = 0; x < c.width; x++) {
          const i = (row * c.width + x) * 4, line = Math.abs(mid[i] - bg[0]) + Math.abs(mid[i + 1] - bg[1]) + Math.abs(mid[i + 2] - bg[2]) > 6;
          run = line ? run + 1 : 0; widest = Math.max(widest, run);
        }
        out[kind] = {worst, widest};
      }
      return out;
    } finally { c.remove(); }
  });
  for (const [kind, m] of Object.entries(r)) {
    assert.ok(m.worst <= 3, `${kind} grid: zooming across the pitch doubling changes nothing visible (${m.worst})`);
    assert.ok(m.widest <= 2, `${kind} grid lines stay hairline (${m.widest} px)`);
  }
}

// Schematic wire ends and net labels with trusted mouse drags: an end grabbed directly (selected or not) drags,
// wires joined at that end follow so the joint holds, and a net label dragged by its text lands with its
// anchor (the lower-left hotspot) on the wire it is dropped on and joins that net.
async function wireEnds(page) {
  const setup = () => page.evaluate(async () => {
    const h = AtriumNavHost, p = Atrium.project("Wire ends"), d = p.documents[0];
    d.grid = 2.54;
    d.items = [{id: "a", kind: "wire", points: [[0, 0], [25.4, 0]]}, {id: "b", kind: "wire", points: [[25.4, 0], [25.4, 10.16]]},
      {id: "c", kind: "wire", points: [[0, 15.24], [25.4, 15.24]]}, {id: "L", kind: "netlabel", text: "SIG", x: 5.08, y: 0}];
    await h.replaceProject(p, {force: true, dirty: false}); h.selectDocument(d.id); h.setTool("select"); h.select([]);
    // Commit the replacement's fitted frame before selecting the test camera.
    await h.prepareLaunch();
    h.view().restoreCamera({...h.view().camera(), cx: 12.7, cy: 7, scale: 18}); h.redraw();
  });
  const at = w => page.evaluate(w => { const c = AtriumNavHost.canvas().getBoundingClientRect(), s = AtriumNavHost.view().worldToScreen(w); return [c.left + s[0], c.top + s[1]]; }, w);
  const drag = async (from, to) => { await page.mouse.move(...await at(from)); await page.mouse.down(); const b = await at(to); await page.mouse.move(b[0], b[1], {steps: 6}); await page.mouse.up(); };
  const state = () => page.evaluate(() => {
    const h = AtriumNavHost, items = h.doc().items, nets = Atrium.connectivity(h.doc(), h.defs()).byWire, L = items.find(i => i.id === "L");
    return {a: items.find(i => i.id === "a").points, b: items.find(i => i.id === "b").points, nets: Object.fromEntries(["a", "b", "c"].map(id => [id, nets.get(id)])), label: [L.x, L.y]};
  });
  for (const selected of [false, true]) {
    await setup(); if (selected) await page.evaluate(() => AtriumNavHost.select(["a"]));
    await drag([25.4, 0], [30.48, -5.08]);
    const s = await state();
    assert.deepEqual([s.a.at(-1), s.b[0]], [[30.48, -5.08], [30.48, -5.08]], `the joint follows a ${selected ? "selected" : "directly grabbed"} wire end`);
    assert.equal(s.nets.b, s.nets.a, "the joined wires stay one net");
    await page.evaluate(() => AtriumNavHost.act("undo"));
    const u = await state();
    assert.deepEqual([u.a, u.b], [[[0, 0], [25.4, 0]], [[25.4, 0], [25.4, 10.16]]], "one undo step restores both wires");
  }
  await setup();
  await drag([6.6, -0.8], [11.68, 15.24 - 0.8]);
  const s = await state();
  assert.deepEqual(s.label, [10.16, 15.24], "the label's anchor snaps onto the wire it is dropped on");
  assert.equal(s.nets.c, "SIG"); assert.notEqual(s.nets.a, "SIG");
}

// A bend made by a component drag remains elastic across committed edits.
async function wireStretch(page) {
  await page.evaluate(async () => {
    const A = Atrium, h = AtriumNavHost, def = AtriumParts.catalogue.find(d => d.id === "std-c");
    const p = A.project("Stretchable wires", [def]), d = p.documents[0];
    d.grid = 1;
    const part = A.instantiate(p, def, [0, 0], 90);
    part.id = "movable";
    const [top, bottom] = A.pins(part, def, d.kind).map(pin => pin.at);
    d.items = [part,
      {id:"straight", kind:"wire", points:[top, [0, -11]], net:"HIGH"},
      {id:"bent", kind:"wire", points:[[8, 12], [0, 12], bottom], net:"LOW"},
      {id:"branch", kind:"wire", points:[[0, 12], [-7, 12]]},
      {id:"tap", kind:"junction", x:0, y:12},
      {id:"unrelated", kind:"wire", points:[[-11, -8], [-6, -8]], net:"INDEPENDENT"}];
    await h.replaceProject(p, {force:true, dirty:false}); h.selectDocument(d.id); h.setTool("select"); h.select([]);
    await h.prepareLaunch();
    h.view().restoreCamera({...h.view().camera(), cx:0, cy:0, scale:23}); h.redraw();
  });
  const state = () => page.evaluate(() => {
    const h = AtriumNavHost, d = h.doc(), nets = Atrium.connectivity(d, h.defs());
    return {items:d.items, nets:[...nets.byPin, ...nets.byWire].sort(), selection:h.selection(), steps:h.undoSteps().history.length};
  });
  const move = async at => {
    const [x, y] = await page.evaluate(at => {
      const h = AtriumNavHost, r = h.canvas().getBoundingClientRect(), [x, y] = h.view().worldToScreen(at);
      return [r.left + x, r.top + y];
    }, at);
    await page.mouse.move(x, y, {steps:6});
  };
  const drag = async (from, ...via) => {
    await move(from); await page.mouse.down();
    for (const at of via) await move(at);
    await page.mouse.up();
    return state();
  };
  const item = (state, id) => state.items.find(i => i.id === id);
  const origin = [0, -2], right = [3, -2];
  await move(origin); await page.mouse.down(); await page.mouse.up();
  const before = await state();
  assert.deepEqual(before.selection, ["movable"]);
  assert.deepEqual(await drag(origin, right, origin), before, "a return within a single drag preserves every item and creates no undo step");
  const away = await drag(origin, right);
  assert.equal(item(away, "movable").x, 3);
  assert.equal(away.steps, before.steps + 1);
  assert.deepEqual(away.nets, before.nets, "the pin connections and the stationary branch survive stretching");
  assert.deepEqual(item(away, "branch"), item(before, "branch"));
  assert.deepEqual(item(away, "tap"), item(before, "tap"));
  assert.deepEqual(item(away, "straight").points.at(-1), item(before, "straight").points.at(-1));
  assert.deepEqual(item(away, "bent").points.slice(0, 2), item(before, "bent").points.slice(0, 2));
  await page.evaluate(() => AtriumNavHost.act("undo"));
  assert.deepEqual(await state(), before);
  await page.evaluate(() => AtriumNavHost.act("redo"));
  assert.deepEqual(await state(), away);
  const edited = await drag([-8, -8], [-8, -10]);
  assert.notDeepEqual(item(edited, "unrelated"), item(before, "unrelated"));
  const back = await drag(right, origin);
  assert.deepEqual(back.items.filter(i => i.id !== "unrelated"), before.items.filter(i => i.id !== "unrelated"), "a separate return drag restores all authored routing");
  assert.deepEqual(item(back, "unrelated"), item(edited, "unrelated"), "a manual edit elsewhere is preserved");
  assert.deepEqual(back.nets, before.nets);
  assert.deepEqual(back.selection, before.selection);
  assert.equal(back.steps, edited.steps + 1);
  await page.evaluate(() => AtriumNavHost.act("undo"));
  assert.deepEqual((await state()).items, edited.items);
  await page.evaluate(() => AtriumNavHost.act("redo"));
  assert.deepEqual(await state(), back);
}

async function fitDocument(page) {
  await page.evaluate(async () => {
    await AtriumLazy.need(["AtriumCamera", "AtriumContextMenu"]);
    AtriumCamera.setPref("camera.animate", false);
    const host = AtriumNavHost, project = Atrium.project("Document fit");
    const board = project.documents.find(d => d.kind === "pcb");
    board.outline = [[0, 0], [20, 0], [20, 10], [0, 10]];
    board.items = [{id: "outlying-silk", kind: "graphic", layer: "Silk", width: 10, points: [[39, 4], [40, 4]]}];
    await host.replaceProject(project, {force: true, dirty: false});
    host.selectDocument(board.id);
  });
  const read = () => page.evaluate(() => AtriumNavHost.view().camera());
  const reset = () => page.evaluate(() => {
    const host = AtriumNavHost, view = host.view();
    view.restoreCamera({...view.camera(), cx: 0, cy: 0, scale: 8});
    host.redraw();
  });
  const call = async action => {
    await reset();
    await page.evaluate(action => globalThis.dispatchEvent(new CustomEvent("atrium-command", {detail: action})), action);
    return read();
  };
  const expected = await call("fit-document");
  const board = await call("fit-objects");
  assert.equal(expected.cx, 22.5, "document bounds include the painted extension over the authored points");
  assert.equal(board.cx, 10, "board fit remains the outline");
  assert.equal((await call("fit")).cx, 20, "generic fit uses authored bounds");
  await reset();
  const menu = page.locator('[data-menu="view"]');
  await menu.locator(":scope > summary").click();
  await menu.getByRole("menuitem", {name: "Fit Document", exact: true}).click();
  assert.deepEqual(await read(), expected);
  await reset();
  const canvas = await page.evaluate(() => {
    const rect = AtriumNavHost.canvas().getBoundingClientRect();
    return [rect.left + 20, rect.top + 20];
  });
  await page.mouse.click(...canvas, {button: "right"});
  await page.locator(".nav-menu-portal").getByRole("menuitem", {name: "View", exact: true}).click();
  await page.locator('.nav-menu-portal [data-menu-action="fit-document"]').click();
  assert.deepEqual(await read(), expected);
  await reset();
  await page.evaluate(() => AtriumNavHost.act("command-palette"));
  const palette = page.getByRole("dialog", {name: "Command palette"});
  await palette.getByRole("combobox").fill("Fit Document");
  await palette.getByRole("option").filter({hasText: "Fit Document"}).click();
  await palette.waitFor({state: "hidden"});
  assert.deepEqual(await read(), expected);

  const registration = await page.evaluate(() => AtriumKeymap.documentFitRegistration());
  assert.deepEqual(registration, {title: "Fit Document", key: "0", action: "fit-document"});
  assert.deepEqual(await call(registration.action), expected, "the native bridge action reaches the document camera");

  await page.evaluate(() => AtriumLazy.need("AtriumKeymapPresets"));
  const shortcut = async preset => {
    await reset();
    await page.evaluate(preset => {
      const keymap = AtriumKeymap, canvas = AtriumNavHost.canvas();
      keymap.setPlatform(true);
      keymap.setPreset(preset);
      canvas.focus();
      canvas.dispatchEvent(new KeyboardEvent("keydown", {key: "0", code: "Digit0", metaKey: true, bubbles: true, cancelable: true}));
    }, preset);
    return read();
  };
  for (const preset of ["altium", "classic", "kicad", "vscode", "allegro", "modern"])
    assert.deepEqual(await shortcut(preset), expected, preset + " uses the document camera");
  await page.evaluate(() => AtriumKeymap.setBindings("fit", ["Meta+0"]));
  try {
    assert.equal((await shortcut("altium")).cx, 20, "the native keyboard equivalent still honors user bindings");
  } finally {
    await page.evaluate(() => AtriumKeymap.resetCommand("fit"));
  }
}

async function regionDrag(page) {
  await page.evaluate(async () => {
    const host = AtriumNavHost, project = Atrium.project("Curved region drag");
    const board = project.documents.find(d => d.kind === "pcb");
    const shape = AtriumBoardShape;
    const outline = [shape.arc([0, 0], 2, 0, 0, true)];
    const holes = [[shape.arc([0, 0], .5, 0, 0, false)]];
    const points = shape.flattenContour(outline);
    board.outline = [[-10, -8], [10, -8], [10, 8], [-10, 8]];
    board.items = [{id: "region", kind: "graphic", layer: "Top", fill: true, points, width: 0,
      regionShape: {version: 1, contour: outline, cutouts: holes, sig: shape.signature(points)}}];
    await host.replaceProject(project, {force: true, dirty: false});
    host.selectDocument(board.id);
    host.setPref("pcb.smartGuides", false);
    await AtriumLazy.need("AtriumPCBEdit");
    AtriumPCBEdit.setSnap("grid", true);
    AtriumPCBEdit.setSnap("objects", false);
    host.select(["region"]);
  });

  const state = () => page.evaluate(() => {
    const host = AtriumNavHost, region = host.doc().items[0];
    return {region, exact: AtriumBoardShape.regionOf(region), steps: host.undoSteps().history.length};
  });
  const move = async at => {
    const [x, y] = await page.evaluate(at => {
      const host = AtriumNavHost, box = host.canvas().getBoundingClientRect();
      const [x, y] = host.view().worldToScreen(at);
      return [box.left + x, box.top + y];
    }, at);
    await page.mouse.move(x, y, {steps: 6});
  };
  const before = await state(), from = [1.25, 0], to = [4.25, 2];
  assert.equal(before.exact.cutouts.length, 1);
  await move(from);
  await page.mouse.down();
  await move(to);
  await move(from);
  await page.mouse.up();
  assert.deepEqual(await state(), before, "returning to the mark preserves the exact region without an undo step");

  await move(from);
  await page.mouse.down();
  await move(to);
  await page.mouse.up();
  const after = await state();
  const authored = await page.evaluate(({region}) => {
    Atrium.moveItem(region, 3, 2);
    return region;
  }, before);
  assert.equal(after.steps, before.steps + 1);
  assert.deepEqual(after.region.points, authored.points);
  await page.evaluate(() => AtriumNavHost.act("undo"));
  assert.deepEqual(await state(), before, "Undo restores the entire exact region");
  assert.deepEqual(after.exact, authored.regionShape, "the dragged arc and cutout match the one-shot move");
}

async function findSimilarProjection(page) {
  await page.evaluate(async () => {
    const host = AtriumNavHost, project = Atrium.project("Find Similar");
    const board = project.documents.find(d => d.kind === "pcb");
    board.outline = [[-10, -10], [10, -10], [10, 10], [-10, 10]];
    board.items = [
      {id: "layerless", kind: "graphic", points: [[-4, 0], [-3, 0]]},
      {id: "top", kind: "graphic", layer: "Top", points: [[-2, 0], [-1, 0]]},
      {id: "silk", kind: "graphic", layer: "Silk", points: [[0, 0], [1, 0]]},
      ...[["absent", {}], ["zero", {drill: 0}], ["positive", {drill: .8}]].map(([id, drill], i) =>
        ({id, kind: "pad", layer: "Top", number: String(i + 1), x: i * 3, y: 4, w: 1, h: 1, ...drill})),
    ];
    await host.replaceProject(project, {force: true, dirty: false});
    host.selectDocument(board.id);
  });
  const dialog = page.getByRole("dialog", {name: "Find Similar Objects"});
  async function open(id) {
    await page.evaluate(id => { AtriumNavHost.select([id]); AtriumNavHost.act("find-similar"); }, id);
    await dialog.waitFor();
  }
  async function choose() {
    await dialog.getByRole("button", {name: "Select", exact: true}).click();
    return page.evaluate(() => AtriumNavHost.selection());
  }
  await open("layerless");
  const layer = dialog.getByRole("combobox", {name: "Layer match"});
  assert.equal(await layer.evaluate(node => node.previousElementSibling.textContent), "Top");
  assert.deepEqual(await choose(), ["layerless", "top"]);
  await open("absent");
  const drill = dialog.getByRole("combobox", {name: "Drill match"});
  assert.equal(await drill.evaluate(node => node.previousElementSibling.textContent), "—");
  await drill.selectOption("same");
  assert.deepEqual(await choose(), ["absent"]);
  await open("zero");
  assert.match(await drill.evaluate(node => node.previousElementSibling.textContent), /^0/);
  await drill.selectOption("same");
  assert.deepEqual(await choose(), ["zero"]);
}

module.exports = async function editingInput(browser) {
  const {page, errors, releaseTextMenu} = await open(browser);
  try {
    await coldTextMenu(page, releaseTextMenu);
    await findReplaceReopening(page);
    await contextSelectNet(page);
    await canvasContextMenu(page);
    await gridLod(page);
    await wireEnds(page);
    await wireStretch(page);
    await marquee(page);
    await escape(page);
    await propertiesChrome(page);
    await docking(page);
    await findSimilarProjection(page);
    await regionDrag(page);
    await fitDocument(page);
    assert.deepEqual(errors, []);
    console.log("PASS editing and input: hairline grid with level-of-detail fading, wire-end joints and net-label anchors, visible selection marquee, Escape everywhere, one docking convention");
  } finally { await page.close(); }
};
