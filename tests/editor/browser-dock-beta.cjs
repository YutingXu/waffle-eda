"use strict";
// Docking, panels and editor tabs in real Chromium layout (beta findings):
//   1. Messages in a narrow side dock: a two-line list, a wrapping header with its actions in ⋯,
//      no horizontal overflow and no text clipped without an ellipsis. Wide, its table columns resize
//      (drag or double-click a divider) and show or hide from the header's context menu, per user.
//   2. Dragging a panel to the bottom edge: the drop preview is exactly the rectangle the panel takes.
//   3. Resizing docks and splits: every canvas is resized and redrawn in the frame of the layout change,
//      fills its pane, and the GPU board layer stays on its own canvas inside its own pane; Properties'
//      sections reflow with the dock. A costly pane pins during the drag and redraws on release.
//   4. Dragging a document tab to the left, top or bottom edge splits there; the preview is the pane it
//      fills; dragover handlers stay cheap.
// Run: node tests/editor/browser-dock-beta.cjs   (CHROME=/path/to/chrome to choose the browser)
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const {pathToFileURL} = require("node:url");

async function dockBeta(browser) {
  const page = await browser.newPage({viewport: {width: 1400, height: 900}});
  const errors = [];
  page.on("pageerror", e => errors.push(e.message));
  page.on("console", m => { if (m.type() === "error" && /ResizeObserver/.test(m.text())) errors.push(m.text()); });
  page.setDefaultTimeout(8000);
  const frames = (n = 2) => page.evaluate(n => new Promise(done => {const step = () => --n ? requestAnimationFrame(step) : done(); requestAnimationFrame(step);}), n);
  try {
    await page.goto(pathToFileURL(path.resolve(__dirname, "../../app/index.html")).href);
    await page.locator("dialog.sp-dialog[open] [data-start-action=demo]").click();
    await page.locator("#doc-name", {hasText: "Sensor board"}).waitFor();
    await page.evaluate(() => AtriumLazy.need(["AtriumDock", "AtriumMessages", "AtriumContextMenu", "AtriumSplitTabs", "AtriumSpatialMotion"]));

    // ---- 1. Messages in the right side dock (its default place), with an imported-rules prompt's actions
    await page.evaluate(() => {
      const messages = [];
      for (let i = 0; i < 40; i++) messages.push({class: ["Error", "Warning", "Info", "Fatal"][i % 4], document: "Sensor board.PcbDoc", source: "Imported rules",
        text: "Clearance between pad U1-" + i + " and the track on net GND is 0.12 mm; the rule asks for 0.15 mm"});
      AtriumMessages.show(AtriumNavHost, {title: "Imported design rules", group: "Import", messages, rerun: () => {}, rerunLabel: "Recheck",
        actions: [{label: "Use the board's rules", run: () => { window.usedBoardRules = true; }}, {label: "Keep Waffle defaults", run: () => {}}, {label: "Review…", run: () => {}}]});
    });
    await frames(3);
    const narrow = await page.evaluate(() => {
      const panel = document.querySelector(".msg-panel"), head = panel.querySelector(".msg-head"), box = panel.getBoundingClientRect();
      const visible = n => n.getClientRects().length && getComputedStyle(n).visibility !== "hidden";
      const out = {width: Math.round(box.width), right: box.right, list: panel.classList.contains("msg-list"), compact: panel.classList.contains("msg-compact"),
        pageOverflow: document.documentElement.scrollWidth - innerWidth, panelOverflow: panel.scrollWidth - panel.clientWidth,
        headOverflow: head.scrollWidth - head.clientWidth, gridOverflow: panel.querySelector(".msg-grid").scrollWidth - panel.querySelector(".msg-grid").clientWidth,
        outside: [], clipped: [], narrowText: [], actionsShown: [], more: visible(panel.querySelector(".msg-more"))};
      // Every visible control and cell sits inside the panel.
      for (const n of panel.querySelectorAll(".msg-head > *, .msg-head .msg-filter, tbody tr[data-no] td > *, tbody tr[data-no] td, .msg-foot > *")) {
        if (!visible(n)) continue;
        const r = n.getBoundingClientRect(); if (!r.width) continue;
        if (r.left < box.left - .5 || r.right > box.right + .5) out.outside.push((n.className.baseVal ?? n.className) + " " + Math.round(r.left) + "–" + Math.round(r.right));
      }
      // Text cut short ends in an ellipsis, never mid-word.
      for (const n of panel.querySelectorAll(".msg-head *, tbody td, tbody td > span, .msg-foot > *")) {
        if (!visible(n) || !n.textContent.trim() || n.children.length > 1) continue;
        if (n.scrollWidth > n.clientWidth + 1 && getComputedStyle(n).textOverflow !== "ellipsis") out.clipped.push(n.className + ": " + n.textContent.slice(0, 30));
      }
      for (const td of panel.querySelectorAll("tbody tr[data-no] td.msg-col-text")) if (td.getBoundingClientRect().width < 200) out.narrowText.push(Math.round(td.getBoundingClientRect().width));
      for (const b of panel.querySelectorAll(".msg-head > button:not(.msg-more,.msg-close,.msg-filter), .msg-extra > button, .msg-export")) if (visible(b)) out.actionsShown.push(b.textContent);
      const row = panel.querySelector("tbody tr[data-no]"), meta = row && [...row.querySelectorAll(".msg-col-class > span, .msg-col-document, .msg-col-source")].map(n => n.getBoundingClientRect().top);
      out.twoLines = !!meta && meta.every(t => t > row.querySelector(".msg-col-text").getBoundingClientRect().bottom - 1);
      out.counters = [...panel.querySelectorAll(".msg-filters:not(.msg-tabs,.msg-chips) .msg-filter")].map(b => visible(b) && b.getBoundingClientRect().right <= box.right);
      return out;
    });
    assert.ok(narrow.width < 400, "Messages sits in the right side dock: " + narrow.width);
    assert.ok(narrow.list && narrow.compact, "narrow Messages uses the list layout and the compact header: " + JSON.stringify(narrow));
    assert.ok(narrow.pageOverflow <= 0 && narrow.panelOverflow <= 0 && narrow.headOverflow <= 0 && narrow.gridOverflow <= 0, "no horizontal overflow: " + JSON.stringify(narrow));
    assert.deepEqual(narrow.outside, [], "everything visible fits inside the panel");
    assert.deepEqual(narrow.clipped, [], "nothing is clipped without an ellipsis");
    assert.deepEqual(narrow.narrowText, [], "the message line keeps the panel's width");
    assert.ok(narrow.twoLines, "class, document and source sit on the second line");
    assert.deepEqual(narrow.counters, [true, true, true, true], "the four severity counters are visible");
    assert.deepEqual(narrow.actionsShown, [], "the toolbar actions moved into ⋯");
    assert.ok(narrow.more, "the ⋯ menu button is visible");
    await page.locator(".msg-panel .msg-more").click();
    const menu = page.locator(".nav-menu.action-menu[role=menu]:not([inert])");
    await menu.waitFor();
    const labels = await menu.locator(":scope > [role^=menuitem], :scope > .nav-sub > [role^=menuitem]").allTextContents();
    for (const want of ["Locate", "Recheck", "Use the board's rules", "Keep Waffle defaults", "Review…", "Export Report (.html)…", "Export Spreadsheet (.csv)…", "Clear", "Sort By"])
      assert.ok(labels.some(l => l.startsWith(want)), "⋯ lists " + want + ": " + JSON.stringify(labels));
    await menu.locator("[role=menuitem]", {hasText: "Use the board's rules"}).click();
    assert.equal(await page.evaluate(() => window.usedBoardRules), true, "a ⋯ entry runs its action");
    // Wide again (the bottom dock): the table and the one-line header come back.
    await page.evaluate(() => AtriumDock.moveTo("messages", {area: "bottom", mode: "end"}));
    await frames(3);
    const wide = await page.evaluate(() => {const p = document.querySelector(".msg-panel"); return {list: p.classList.contains("msg-list"), compact: p.classList.contains("msg-compact"), thead: !!p.querySelector("thead").getClientRects().length};});
    assert.deepEqual(wide, {list: false, compact: false, thead: true}, "Messages at full width is the table");
    const exportSummary = page.locator(".msg-export > summary");
    await exportSummary.click();
    await frames(2);
    const exportFits = await page.locator(".msg-export-items").evaluate(menu => {
      const {left, top, right, bottom} = menu.getBoundingClientRect();
      return left >= 0 && top >= 0 && right <= innerWidth && bottom <= innerHeight;
    });
    assert.equal(exportFits, true, "the wide Messages Export menu fits inside the viewport");
    await exportSummary.click();
    // Columns: drag a divider, double-click to fit, hide and show from the header's context menu; kept per user.
    const widths = () => page.evaluate(() => Object.fromEntries([...document.querySelectorAll(".msg-grid thead th")].map(t => [t.className.replace("msg-col-", ""), Math.round(t.getBoundingClientRect().width)])));
    const before = await widths();
    const grip = await page.locator(".msg-grid th.msg-col-document .msg-col-grip").boundingBox();
    await page.mouse.move(grip.x + 3, grip.y + 5); await page.mouse.down();
    await page.mouse.move(grip.x + 63, grip.y + 5, {steps: 6}); await page.mouse.up(); await frames(2);
    const dragged = await widths();
    assert.equal(dragged.document, before.document + 60, "dragging the Document divider widens it: " + JSON.stringify(dragged));
    assert.equal(dragged.text, before.text - 60, "Message gives up the width");
    assert.equal(await page.evaluate(() => [...document.querySelectorAll(".msg-grid thead th")].reduce((n, t) => n + t.getBoundingClientRect().width, 0) <= document.querySelector(".msg-grid").clientWidth + .5), true, "the columns still fit");
    await page.locator(".msg-grid th.msg-col-document .msg-col-grip").dblclick(); await frames(2);
    const fitted = await page.evaluate(() => {const th = document.querySelector(".msg-grid th.msg-col-document"), cells = [...document.querySelectorAll(".msg-grid td.msg-col-document")];
      return {width: th.getBoundingClientRect().width, clipped: cells.filter(td => td.scrollWidth > td.clientWidth).length, cells: cells.length};});
    assert.ok(fitted.cells && !fitted.clipped && fitted.width < dragged.document, "double-click fits the column to its contents: " + JSON.stringify(fitted));
    await page.locator(".msg-grid th.msg-col-time").click({button: "right"});
    const columnMenu = page.locator(".nav-menu.action-menu[role=menu]:not([inert])");
    await columnMenu.waitFor();
    assert.deepEqual(await columnMenu.locator("[role=menuitemcheckbox]").evaluateAll(n => n.map(b => [b.textContent.trim(), b.getAttribute("aria-checked"), b.disabled])),
      [["Class", "true", false], ["Document", "true", false], ["Source", "true", false], ["Message", "true", true], ["Time", "true", false], ["No.", "true", false]], "the header menu lists every column");
    await columnMenu.locator("[role=menuitemcheckbox]", {hasText: "Time"}).click(); await frames(2);
    const hiddenTime = await page.evaluate(() => ({head: [...document.querySelectorAll(".msg-grid thead th")].map(t => t.className), row: [...document.querySelector(".msg-grid tbody tr[data-no]").children].map(t => t.className),
      pref: AtriumPref.get("messages.columns")}));
    assert.ok(!hiddenTime.head.includes("msg-col-time") && !hiddenTime.row.includes("msg-col-time"), "Time is hidden in the header and the rows: " + JSON.stringify(hiddenTime));
    assert.deepEqual(hiddenTime.pref.hidden, ["time"], "column visibility is a user preference");
    assert.equal(hiddenTime.pref.widths.document, Math.round(fitted.width), "column widths are a user preference");
    await page.locator(".msg-grid th.msg-col-text").click({button: "right"}); await columnMenu.waitFor();
    await columnMenu.locator("[role=menuitem]", {hasText: "Reset Columns"}).click(); await frames(2);
    assert.deepEqual(await widths(), before, "Reset Columns restores the defaults");
    await page.evaluate(() => AtriumDock.moveTo("messages", {area: "right", mode: "tab", group: 0}));
    await frames(2);

    // ---- 2. Drag the Messages tab to the bottom edge of the editor: preview == final panel rectangle
    const rect = sel => page.evaluate(sel => {const r = document.querySelector(sel).getBoundingClientRect(); return [r.left, r.top, r.width, r.height].map(Math.round);}, sel);
    const tab = await page.locator('.dock-tab[data-dock-tab="messages"]').boundingBox();
    const editor = await page.locator("#editor-area").boundingBox();
    await page.mouse.move(tab.x + 10, tab.y + 10); await page.mouse.down();
    const tx = editor.x + editor.width / 2, ty = editor.y + editor.height - 24;
    for (let i = 1; i <= 16; i++) await page.mouse.move(tab.x + 10 + (tx - tab.x - 10) * i / 16, tab.y + 10 + (ty - tab.y - 10) * i / 16);
    await frames(1);
    const preview = await rect(".dock-preview");
    await page.mouse.up(); await frames(3);
    const landed = await page.evaluate(() => {const r = document.querySelector("#dock-panel-messages").closest(".dock-group").getBoundingClientRect(); return [r.left, r.top, r.width, r.height].map(Math.round);});
    assert.equal(await page.evaluate(() => AtriumDock.current().areas.bottom.some(g => g.panels.includes("messages"))), true, "Messages docked at the bottom");
    assert.deepEqual(preview, landed, "the bottom drop preview is the rectangle the panel takes");
    assert.equal(landed[2], 1400, "the bottom dock spans the window");

    // ---- 3. Resize sequences: each canvas follows its pane in the same frame
    await page.evaluate(() => AtriumNavHost.act("split-right"));
    await frames(4);
    await page.evaluate(() => {
      window.resizeFaults = []; window.resizeChecks = 0;
      const fault = s => { if (resizeFaults.length < 20) resizeFaults.push(s); };
      // Created after the editor's observer, so it runs after it in the same frame, before paint.
      const check = new ResizeObserver(entries => {
        for (const e of entries) {
          const c = e.target, stage = c.parentElement, dpr = devicePixelRatio, r = c.getBoundingClientRect(), s = stage.getBoundingClientRect();
          resizeChecks++;
          if (c.width !== Math.round(e.contentRect.width * dpr) || c.height !== Math.round(e.contentRect.height * dpr))
            fault("bitmap " + c.width + "x" + c.height + " for " + e.contentRect.width + "x" + e.contentRect.height);
          if (r.left < s.left - .5 || r.right > s.right + .5 || r.bottom > s.bottom + .5) fault("canvas outside its pane");
          const gpu = stage.querySelector(":scope > .atrium-gpu-board");
          if (gpu && getComputedStyle(gpu).display !== "none") {
            const g = gpu.getBoundingClientRect();
            if (Math.abs(g.left - r.left) > .5 || Math.abs(g.top - r.top) > .5 || Math.abs(g.width - r.width) > .5 || Math.abs(g.height - r.height) > .5)
              fault("GPU board layer at " + [g.left, g.top, g.width, g.height].map(Math.round) + ", canvas at " + [r.left, r.top, r.width, r.height].map(Math.round));
          }
          // The schematic paints an opaque sheet: a cleared, undrawn bitmap reads transparent at its edge.
          const x = c.getContext("2d"), doc = AtriumNavHost.panes().find(p => p.canvas === c);
          if (x && doc && AtriumNavHost.project().documents.find(d => d.id === doc.docId)?.kind === "schematic" && c.width > 4 && c.height > 4) {
            if (x.getImageData(c.width - 2, c.height >> 1, 1, 1).data[3] !== 255) fault("schematic pane edge not drawn at " + c.width + "x" + c.height);
          }
        }
      });
      for (const p of AtriumNavHost.panes()) check.observe(p.canvas);
      window.fillCheck = () => {
        for (const p of AtriumNavHost.panes()) {
          const c = p.canvas.getBoundingClientRect(), s = p.canvas.parentElement.getBoundingClientRect();
          if (Math.abs(c.width - s.width) > .5 || Math.abs(c.bottom - s.bottom) > .5) fault("void: canvas " + Math.round(c.width) + " wide in a " + Math.round(s.width) + " px pane");
        }
        // Properties' sections (the Selection Filter, the sheet or board table, the disclosures) reflow with the dock.
        const props = document.querySelector("#properties .panel-properties"), box = props?.getBoundingClientRect();
        if (!box?.width) fault("Properties is not showing");
        else for (const n of props.querySelectorAll(".inspector-disclosure, .pcb-edit-filter, #inspector > *")) {
          const r = n.getBoundingClientRect(); if (!r.width) continue;
          if (r.left < box.left - .5 || r.right > box.right + .5 || r.width < box.width - 32) fault("Properties section " + (n.className || n.tagName) + " " + Math.round(r.width) + " px in a " + Math.round(box.width) + " px dock");
        }
      };
    });
    const sashDrag = async (selector, dx, dy) => {
      const b = await page.locator(selector).boundingBox(), x = b.x + b.width / 2, y = b.y + b.height / 2;
      await page.mouse.move(x, y); await page.mouse.down();
      for (let i = 1; i <= 14; i++) {
        const f = Math.sin(i / 14 * Math.PI);
        await page.mouse.move(x + dx * f, y + dy * f);
        await frames(1); await page.evaluate(() => fillCheck());
      }
      await page.mouse.up(); await frames(2); await page.evaluate(() => fillCheck());
    };
    await sashDrag(".dock-sash-right", -160, 0);
    await sashDrag(".dock-sash-left", 140, 0);
    await sashDrag("#canvas-sash", -180, 0);
    await sashDrag(".dock-sash-bottom", 0, -150);
    const resize = await page.evaluate(() => ({faults: resizeFaults, checks: resizeChecks}));
    assert.deepEqual(resize.faults, [], "every pane redraws in the frame its size changes, inside its own bounds");
    assert.ok(resize.checks >= 40, "the resize sequence resized the canvases: " + resize.checks);
    await page.evaluate(() => AtriumNavHost.act("split-close"));
    await frames(3);
    const original = await page.evaluate(() => {
      const host = AtriumNavHost, previous = host.currentId();
      host.selectDocument(host.project().documents.find(d => d.kind === "pcb").id);
      return previous;
    });
    await page.waitForFunction(() => {
      const h = AtriumNavHost, c = h.canvas(), rect = c.getBoundingClientRect();
      return h.doc().kind === "pcb" && h.panes().length === 1 && !document.body.classList.contains("dock-resizing") &&
        c.width === Math.round(rect.width * devicePixelRatio) && c.height === Math.round(rect.height * devicePixelRatio);
    });

    // A slow full Canvas2D paint followed by a cached tab return used to lose its resize cost.
    const pinnedState = () => page.evaluate(() => {
      const c = AtriumNavHost.canvas(), dock = document.getElementById("navigator");
      return {position:c.style.position,width:c.getBoundingClientRect().width,paneWidth:c.parentElement.getBoundingClientRect().width,
        dockWidth:dock.getBoundingClientRect().width,backingWidth:c.width,dpr:devicePixelRatio,paints:window.sashPaints.length};
    });
    const tabs = await page.evaluate(async () => {
      await AtriumLazy.need(["AtriumCanvasFast","AtriumPrefs"]);
      const host = AtriumNavHost, view = host.view(), render = view.render, ctx = view.internals().ctx, fill = ctx.fillRect;
      const renderer = AtriumPrefs.get("display.renderer");
      AtriumPrefs.set("display.renderer","2d");
      window.sashPaints = [];
      view.render = function(...args) {
        const started = performance.now(), reused = render.apply(this,args);
        sashPaints.push({reused,ms:performance.now() - started,id:args[0].id,width:host.canvas().width});
        return reused;
      };
      ctx.fillRect = function(...args) {
        // Delay one actual base paint so the renderer retains its copy even on the small demo board.
        ctx.fillRect = fill;
        const end = performance.now() + 18;
        while (performance.now() < end) {}
        return fill.apply(this,args);
      };
      window.restoreSashPaint = () => {view.render = render; ctx.fillRect = fill; AtriumPrefs.set("display.renderer",renderer || "auto");};
      view.pan(1,0); host.redraw();
      return {board:host.doc().id,sheet:host.project().documents.find(d => d.kind === "schematic").id};
    });
    await frames(3);
    assert.ok(await page.evaluate(id => sashPaints.some(p => p.id === id && !p.reused && p.ms >= 18),tabs.board),"the board had a costly full paint");
    await page.evaluate(id => AtriumNavHost.selectDocument(id),tabs.sheet);
    await frames(2);
    await page.evaluate(id => AtriumNavHost.selectDocument(id),tabs.board);
    await frames(2);
    const paints = await page.evaluate(() => sashPaints);
    const cached = paints.at(-1);
    assert.equal(cached.id,tabs.board);
    assert.ok(cached.reused && cached.ms < 12,"returning to the board painted its cached base cheaply: " + JSON.stringify(paints));

    const savedWidth = w => page.waitForFunction(w =>
      JSON.parse(localStorage.getItem("atrium.prefs"))?.values?.["workbench.layout"]?.sizes?.left === w,w);
    const beforePin = await pinnedState(), dragWidths = [];
    const leftSash = page.locator(".dock-sash-left");
    const sash = await leftSash.boundingBox(), x = sash.x + sash.width / 2, y = sash.y + sash.height / 2;
    await page.mouse.move(x,y); await page.mouse.down();
    try {
      for (const delta of [14,42,65]) {
        await page.mouse.move(x + delta,y);
        await frames(2);
        const pinned = await pinnedState();
        dragWidths.push(pinned.dockWidth);
        assert.equal(pinned.dockWidth,beforePin.dockWidth + delta,"the visible dock tracks every drag step");
        assert.equal(pinned.paneWidth,beforePin.paneWidth - delta,"the pane follows the dock");
        assert.equal(pinned.position,"absolute","a costly base stays pinned after a cached tab return");
        assert.equal(pinned.width,beforePin.width);
        assert.equal(pinned.backingWidth,beforePin.backingWidth);
        assert.equal(pinned.paints,beforePin.paints,"dragging avoids repainting the pinned canvas");
      }
    } finally {
      await page.mouse.up();
    }
    await frames(2);
    const thawed = await pinnedState();
    assert.equal(thawed.position,beforePin.position,"release restores the canvas layout");
    assert.equal(thawed.dockWidth,beforePin.dockWidth + 65,"release keeps the dragged width");
    assert.equal(thawed.width,thawed.paneWidth,"the costly canvas fills its resized pane on release");
    assert.equal(thawed.backingWidth,Math.round(thawed.paneWidth * thawed.dpr));
    assert.equal(thawed.paints,beforePin.paints + 1,"release paints the new viewport once");
    assert.ok(await page.evaluate(() => !sashPaints.at(-1).reused),"a resized canvas receives a full base paint");
    await savedWidth(thawed.dockWidth);

    // Keyboard moves still resize immediately. A cancelled touch drag commits its last visible size.
    await leftSash.press("ArrowRight");
    await frames(2);
    const keyed = await pinnedState();
    assert.equal(keyed.dockWidth,thawed.dockWidth + 10);
    assert.equal(keyed.width,keyed.paneWidth);
    const touch = await page.context().newCDPSession(page);
    const touchX = x + keyed.dockWidth - beforePin.dockWidth;
    await touch.send("Input.dispatchTouchEvent",{type:"touchStart",touchPoints:[{x:touchX,y}]});
    await touch.send("Input.dispatchTouchEvent",{type:"touchMove",touchPoints:[{x:touchX + 24,y}]});
    await frames(2);
    assert.equal((await pinnedState()).dockWidth,keyed.dockWidth + 24,"touch follows its real drag delta");
    await touch.send("Input.dispatchTouchEvent",{type:"touchCancel",touchPoints:[]});
    await frames(2);
    await touch.detach();
    const cancelled = await pinnedState();
    assert.equal(cancelled.dockWidth,keyed.dockWidth + 24);
    assert.equal(cancelled.position,beforePin.position);
    assert.equal(cancelled.width,cancelled.paneWidth);
    assert.equal(await page.locator("body").evaluate(body => body.classList.contains("dock-resizing")),false);
    await savedWidth(cancelled.dockWidth);
    await page.evaluate(id => {restoreSashPaint(); AtriumNavHost.selectDocument(id);},original);

    // ---- 4. Document tabs: left, top and bottom edges split there, and the preview is the pane it fills
    const names = () => page.evaluate(() => {const H = AtriumNavHost, docs = H.project().documents; return {down: document.getElementById("editor-panes").classList.contains("split-down"),
      docs: H.panes().map(p => docs.find(d => d.id === p.docId)?.name), rects: H.panes().map(p => {const r = p.canvas.parentElement.getBoundingClientRect(); return [r.left, r.top, r.width, r.height].map(Math.round);})};});
    const select = name => page.evaluate(name => AtriumNavHost.selectDocument(AtriumNavHost.project().documents.find(d => d.name === name).id), name);
    async function dragTab(name, fx, fy, scope = "") {
      const t = await page.locator(scope + " .document-tab[data-tab]:visible", {hasText: name}).first().boundingBox();
      const host = await page.locator("#editor-panes").boundingBox(), x = host.x + host.width * fx, y = host.y + host.height * fy;
      await page.mouse.move(t.x + 20, t.y + 10); await page.mouse.down();
      for (let i = 1; i <= 14; i++) await page.mouse.move(t.x + 20 + (x - t.x - 20) * i / 14, t.y + 10 + (y - t.y - 10) * i / 14);
      await frames(1);
      const shown = await page.evaluate(() => {const d = document.querySelector(".split-drop"), r = d.getBoundingClientRect(); return {on: d.classList.contains("is-drop"), zone: d.dataset.zone, rect: [r.left, r.top, r.width, r.height].map(Math.round)};});
      await page.mouse.up();
      await page.locator(".split-drop.is-drop").waitFor({state:"hidden"});
      await frames(3);
      return shown;
    }
    const cases = [["left", .04, .5, false, 0], ["top", .5, .04, true, 0], ["bottom", .5, .96, true, 1], ["right", .96, .5, false, 1]];
    for (const [side, fx, fy, down, k] of cases) {
      await select("Sensor board"); await frames(2);
      const shown = await dragTab("Analog front end", fx, fy), after = await names();
      assert.equal(shown.on && shown.zone, side, side + " edge shows its drop preview");
      assert.equal(after.docs.length, 2, side + " edge splits the editor");
      assert.equal(after.down, down, side + " edge splits " + (down ? "down" : "right"));
      assert.equal(after.docs[k], "Analog front end", side + " edge puts the tab in pane " + (k + 1) + ": " + JSON.stringify(after.docs));
      assert.equal(after.docs[1 - k], "Sensor board", side + " edge keeps the shown document beside it");
      assert.deepEqual(shown.rect, after.rects[k], side + " preview is the pane the document fills");
      await page.evaluate(() => AtriumNavHost.act("split-close")); await frames(2);
    }
    // Split: a pane's only tab dropped on the top edge turns the split and the panes trade places.
    await select("Sensor board");
    await dragTab("Analog front end", .96, .5);
    const turned = await dragTab("Analog front end", .5, .12, '.pane-tabs[data-pane="1"]'), after = await names();
    assert.deepEqual([after.down, after.docs], [true, ["Analog front end", "Sensor board"]], "the split turns, the dragged pane on top: " + JSON.stringify(after));
    assert.deepEqual(turned.rect, after.rects[0], "the preview is the top pane");
    await page.evaluate(() => AtriumNavHost.act("split-close")); await frames(2);

    // dragover does arithmetic only: synthetic drags over the editor, timed per event.
    const cost = await page.evaluate(() => {
      const host = document.getElementById("editor-panes"), canvas = AtriumNavHost.canvas(), b = host.getBoundingClientRect(), id = AtriumNavHost.project().documents[0].id;
      const dt = new DataTransfer(); dt.setData("application/x-atrium-document", id);
      const times = [];
      for (let i = 0; i < 300; i++) {
        const x = b.left + (i * 37 % 100) / 100 * b.width, y = b.top + (i * 53 % 100) / 100 * b.height;
        const t0 = performance.now();
        canvas.dispatchEvent(new DragEvent("dragover", {bubbles: true, cancelable: true, composed: true, dataTransfer: dt, clientX: x, clientY: y}));
        times.push(performance.now() - t0);
      }
      document.dispatchEvent(new DragEvent("dragend", {bubbles: true, dataTransfer: dt}));
      times.sort((a, c) => a - c);
      return {median: times[150], max: times[299]};
    });
    assert.ok(cost.median < 0.5 && cost.max < 4, "dragover stays cheap: " + JSON.stringify(cost));

    await page.evaluate(() => AtriumMessages.show(AtriumNavHost.messageContext(), {
      title:"Previous project report", group:"Import", messages:[{class:"Info",text:"Previous project result"}],
      rerun:() => {}, rerunLabel:"Recheck previous project", actions:[{label:"Use previous result",run:() => {}}],
    }));
    const previousActions = () => page.evaluate(() => [...document.querySelectorAll(".msg-panel button")]
      .filter(button => !button.hidden && /Recheck previous project|Use previous result/.test(button.textContent)).map(button => button.textContent));
    const beforeSwitch = await previousActions();
    assert.equal(beforeSwitch.length,2,"the project report supplies both actions");
    await page.evaluate(() => AtriumLazy.need("AtriumBoardShape"));
    await select("Analog front end");
    await select("Sensor board");
    await page.locator('#inspector details[data-disclosure-key$="/Board Shape"]').evaluate(shape => {shape.open = true;});
    await select("Analog front end");
    assert.deepEqual(await previousActions(),beforeSwitch,"switching tabs keeps the current project's report actions");
    await select("Sensor board");
    const retired = await page.evaluate(async () => {
      const host = AtriumNavHost, id = host.doc().id;
      const shape = document.querySelector('#inspector details[data-disclosure-key$="/Board Shape"]');
      const row = document.querySelector(`#documents [data-doc="${CSS.escape(id)}"]`);
      const handlers = typeof shape?.ontoggle === "function" && typeof row?.onclick === "function";
      const expanded = shape?.open === true;
      const replacement = Atrium.project("Replacement project", []);
      await host.replaceProject(replacement,{force:true,dirty:false});
      return {handlers,expanded,connected:shape?.isConnected || row?.isConnected,
        released:shape?.ontoggle === null && row?.onclick === null};
    });
    assert.deepEqual(retired,{handlers:true,expanded:true,connected:false,released:true},"retired controls release handlers and live tab controls preserve expansion");
    assert.deepEqual(await previousActions(),[],"replacing the project drops its previous report actions");
    assert.equal(await page.evaluate(() => AtriumMessages.messages().some(row => row.text === "Previous project result")),false);
    assert.deepEqual(errors, [], "no page errors");
    console.log("browser-dock-beta: ok (dragover median " + cost.median.toFixed(3) + " ms, max " + cost.max.toFixed(2) + " ms; " + resize.checks + " resize checks; sash widths " + [beforePin.dockWidth,...dragWidths,thawed.dockWidth,keyed.dockWidth,cancelled.dockWidth].join(" → ") + ")");
  } finally {
    await page.close();
  }
}

module.exports = dockBeta;

async function main() {
  let chromium;
  try { ({chromium} = require("playwright-core")); }
  catch { console.log("SKIP browser-dock-beta: Playwright Core is unavailable."); return; }
  const executablePath = process.env.CHROME || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
  if (!process.env.CHROME && !fs.existsSync(executablePath)) {
    console.log("SKIP browser-dock-beta: Google Chrome is not installed.");
    return;
  }
  const browser = await chromium.launch({headless: true, executablePath, args: ["--allow-file-access-from-files"]});
  try { await dockBeta(browser); }
  finally { await browser.close(); }
}

if (require.main === module) main().catch(error => { console.error(error); process.exitCode = 1; });
