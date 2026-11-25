"use strict";
// Problem hover card (app/checks/problem-hover.js): resting the pointer on an ERC marker on a sheet, and on a
// DRC marker and a Design Insight on a board, shows a small card beside the marker that says what it is
// (title, one line, the objects; every problem of a stacked marker). It never covers the marker or its
// objects, never takes the focus, never shows during a drag or another tool, and closes on pointer
// leave, pan, zoom, Escape and a press elsewhere. On touch, a tap on a marker shows it.
// Run: node tests/integration-browser.cjs --problem-hover-only [--snapshot DIR]
const assert = require("node:assert/strict");
const path = require("node:path");
const {pathToFileURL} = require("node:url");
const editor = pathToFileURL(path.join(__dirname, "../../app/index.html")).href;
const settled = page => page.waitForFunction(() => !globalThis.AtriumMotion?.active());
const screenshot = (page, shots, name) => shots && page.screenshot({path:path.join(shots, "problem-hover-" + name + ".png"), animations:"disabled"});

async function open(browser, {theme, touch}) {
  const context = await browser.newContext({viewport: {width: 1400, height: 900}, colorScheme: theme, hasTouch: !!touch});
  const page = await context.newPage(), errors = [];
  page.on("pageerror", error => errors.push(error.message));
  page.setDefaultTimeout(8000);
  await page.goto(editor);
  await page.locator("dialog.sp-dialog[open] [data-start-action=demo]").click();
  await page.waitForFunction(() => globalThis.AtriumNavHost?.doc()?.items.length);
  // Real problems: three wires gone on the sheet (unconnected pins, floating labels) and a track
  // dropped across other nets on the board (clearance, short); Check Design reports both.
  await page.evaluate(async () => {
    const h = AtriumNavHost, p = h.project();
    await AtriumLazy.need(["AtriumChecks", "AtriumDRCView", "AtriumDRCMarkers", "AtriumInsightsUI"]);
    const sch = p.documents.find(d => d.kind === "schematic"), pcb = p.documents.find(d => d.kind === "pcb");
    h.selectDocument(sch.id);
    h.edit(() => { for (const w of sch.items.filter(i => i.kind === "wire").slice(0, 3)) sch.items.splice(sch.items.indexOf(w), 1); });
    h.selectDocument(pcb.id);
    const tracks = pcb.items.filter(i => i.kind === "track"), t = tracks[0], other = tracks.find(x => x.net !== t.net);
    h.edit(() => { const dx = other.points[0][0] - t.points[0][0], dy = other.points[0][1] - t.points[0][1] + .15; t.points = t.points.map(q => [q[0] + dx, q[1] + dy]); });
    await AtriumChecks.checkDesign(h, {});
  });
  await page.waitForFunction(() => {
    const p = AtriumNavHost.project(), sch = p.documents.find(d => d.kind === "schematic"), pcb = p.documents.find(d => d.kind === "pcb");
    return AtriumSchMarkers.list(sch.id).length && AtriumDRCView.violations(pcb.id).length && AtriumInsightsUI.current().length;
  }, null, {timeout: 15000});
  return {context, page, errors};
}

// Show a document fitted to its pane, then the screen points of markers of one kind with what the card should say.
async function markers(page, kind) {
  await page.evaluate(async kind => {
    const h = AtriumNavHost, d = h.project().documents.find(x => x.kind === (kind === "erc" ? "schematic" : "pcb"));
    if (h.doc() !== d) h.selectDocument(d.id);
    h.zoomTo(AtriumNavCommon.itemBox ? d.items.map(i => AtriumNavCommon.itemBox(d, h.defs(), i)).filter(Boolean).reduce(AtriumNavCommon.union) : null);
    await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
  }, kind);
  await settled(page);
  return page.evaluate(kind => {
    const h = AtriumNavHost, d = h.doc(), pane = h.panes().find(p => p.active), rect = pane.canvas.getBoundingClientRect();
    const P = AtriumProblemMarks, r = P.size(P.scaleOf(pane.view), d.kind, "hint").r;
    const points = kind === "erc" ? AtriumSchMarkers.list(d.id).map(v => v.at[0].point)
      : kind === "drc" ? AtriumDRCView.violations(d.id).map(v => v.at || v.otherAt)
      : AtriumInsightsUI.current().map(x => AtriumInsightsUI._markAt(x, r));
    const out = [];
    for (const at of points) {
      if (!at) continue;
      const s = pane.view.worldToScreen(at), x = rect.left + s[0], y = rect.top + s[1];
      if (x < rect.left + 60 || y < rect.top + 60 || x > rect.right - 60 || y > rect.bottom - 60) continue;
      const hit = AtriumProblemHover._find(pane, x, y);
      if (!hit || hit.entries[0].kind !== {erc: "check", drc: "drc", insight: "insight"}[kind]) continue;
      if (out.some(o => Math.hypot(o.x - x, o.y - y) < 2)) continue;
      const c = pane.view.worldToScreen(hit.at);
      out.push({x: rect.left + c[0], y: rect.top + c[1], radius: hit.radius, count: hit.entries.length, titles: hit.entries.map(e => e.title),
        objects: [...new Set(hit.entries.flatMap(e => e.objects))], text: hit.entries[0].text,
        boxes: hit.boxes.map(b => [[b[0], b[1]], [b[2], b[3]]].map(q => { const z = pane.view.worldToScreen(q); return [rect.left + z[0], rect.top + z[1]]; }))});
    }
    return out;
  }, kind);
}
// An empty spot of the canvas: no marker and no object under it.
const empty = page => page.evaluate(() => {
  const h = AtriumNavHost, pane = h.panes().find(p => p.active), r = pane.canvas.getBoundingClientRect();
  for (let y = r.top + 40; y < r.bottom - 40; y += 23) for (let x = r.left + 40; x < r.right - 40; x += 31) {
    const hit = h.hit(pane.canvas, x, y);
    if (!hit?.item && !AtriumProblemHover._find(pane, x, y)) return {x, y};
  }
  throw Error("No empty spot on the canvas");
});
const card = page => page.evaluate(() => {
  const c = document.getElementById("waffle-problem-card");
  if (!c || c.hidden) return null;
  const r = c.getBoundingClientRect();
  return {left: r.left, top: r.top, right: r.right, bottom: r.bottom, title: c.querySelector(".ui-tooltip-head strong")?.textContent,
    meta: c.querySelector(".ui-tooltip-meta")?.textContent, dot: c.querySelector(".ui-tooltip-head .ui-dot")?.dataset.tone || "",
    rows: [...c.querySelectorAll(".ui-tooltip-list > li strong")].map(n => n.textContent), text: c.textContent,
    values: [...c.querySelectorAll(".ui-tooltip-value")].map(n => n.textContent),
    // Text the card cuts off: a value, title or detail wider or taller than its box, or past the card's edge.
    clipped: [...c.querySelectorAll(".ui-tooltip-list strong, .ui-tooltip-value, .ui-tooltip-list .ui-tooltip-detail")].filter(n => {
      const b = n.getBoundingClientRect();
      return n.scrollWidth > n.clientWidth + 1 || n.scrollHeight > n.clientHeight + 1 || b.right > r.right + .5 || b.bottom > r.bottom + .5;
    }).map(n => n.textContent),
    actions: [...c.querySelectorAll(".ui-tooltip-actions button")].map(b => b.textContent),
    caption: parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--window-caption-height")) || 0,
    tooltip: (t => !!t && !t.hidden && t.textContent)(document.getElementById("waffle-tooltip")), active: document.activeElement?.id || document.activeElement?.tagName,
    preview: !!document.querySelector(".sheet-connection-card")};
});
const hidden = (page, why, timeout = 900) => page.locator("#waffle-problem-card").waitFor({state:"hidden", timeout})
  .catch(() => assert.fail("the problem card stays after " + why));
async function hover(page, m) {
  const away = await empty(page);
  await page.mouse.move(away.x, away.y);
  await hidden(page, "moving away");
  const before = await page.evaluate(() => document.activeElement?.id || document.activeElement?.tagName);
  await page.mouse.move(m.x + 1, m.y + 1, {steps: 4});
  await page.waitForTimeout(120);
  assert.equal(await card(page), null, "the card waits for the pointer to rest");
  await page.waitForFunction(() => { const c = document.getElementById("waffle-problem-card"); return c && !c.hidden; }, null, {timeout: 1500});
  return {...await card(page), before};
}
const meets = (a, b) => a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;
function placed(c, m, label) {
  const mark = {left: m.x - m.radius, top: m.y - m.radius, right: m.x + m.radius, bottom: m.y + m.radius};
  assert.ok(!meets(c, mark), label + ": the card covers its marker " + JSON.stringify({c, mark}));
  assert.ok(c.top >= c.caption, label + ": the card stays below the title bar");
  assert.ok(Math.hypot((c.left + c.right) / 2 - m.x, (c.top + c.bottom) / 2 - m.y) < 420, label + ": the card sits next to its marker");
  for (const [[ax, ay], [bx, by]] of m.boxes) {
    const o = {left: Math.min(ax, bx), top: Math.min(ay, by), right: Math.max(ax, bx), bottom: Math.max(ay, by)};
    if (o.right - o.left > 500 || o.bottom - o.top > 400) continue; // too large to keep clear of
    assert.ok(!meets(c, o), label + ": the card covers an object of the problem");
  }
}

async function desktop(browser, {theme, shots}) {
  const {context, page, errors} = await open(browser, {theme});
  try {
    // ---------------- a sheet: ERC
    const erc = await markers(page, "erc");
    assert.ok(erc.length, "ERC markers on screen");
    const m = erc.find(x => x.count === 1) || erc[0];
    let c = await hover(page, m);
    assert.equal(c.title, m.count > 1 ? m.count + " problems here" : m.titles[0]);
    assert.equal(c.dot, "warning", "the severity dot uses the warning tone");
    assert.match(c.meta, /Warning/);
    assert.ok(c.text.includes(m.text), "the card says what is wrong: " + m.text);
    for (const name of m.objects) assert.ok(c.text.includes(name), "the card names " + name);
    assert.ok(c.actions.includes("Show in Messages"));
    assert.equal(c.tooltip, false, "no object hover card on top of it");
    assert.equal(c.preview, false, "no connection preview card on top of it");
    assert.equal(c.active, c.before, "the card takes no focus");
    placed(c, m, "ERC");
    await screenshot(page, shots, "erc-" + theme);
    // Leave.
    const away = await empty(page);
    await page.mouse.move(away.x, away.y, {steps: 3});
    await hidden(page, "the pointer left the marker");
    // Escape.
    c = await hover(page, m);
    await page.keyboard.press("Escape");
    await hidden(page, "Escape", 200);
    // Zoom (wheel).
    await hover(page, m);
    await page.mouse.wheel(0, -120);
    await hidden(page, "a zoom", 400);
    await settled(page);
    // Pan (the camera moves without the pointer).
    const n = (await markers(page, "erc")).find(x => x.titles[0] === m.titles[0] && x.count === m.count) || (await markers(page, "erc"))[0];
    await hover(page, n);
    await page.evaluate(() => { const p = AtriumNavHost.panes().find(q => q.active); p.view.pan(40, 25); AtriumNavHost.redraw(); });
    await hidden(page, "a pan", 400);
    // A press elsewhere.
    const o = (await markers(page, "erc"))[0];
    await hover(page, o);
    const spot = await empty(page);
    await page.mouse.click(spot.x, spot.y);
    await hidden(page, "a click elsewhere", 300);
    // Never during a drag (a rubber band crossing the marker) or with another tool.
    await page.mouse.move(spot.x, spot.y);
    await page.mouse.down();
    await page.mouse.move(o.x, o.y, {steps: 6});
    await page.waitForTimeout(700);
    assert.equal(await card(page), null, "no card during a drag");
    await page.mouse.up();
    await page.keyboard.press("Escape");
    await page.evaluate(() => AtriumNavHost.setTool("wire"));
    await page.mouse.move(spot.x, spot.y);
    await page.mouse.move(o.x, o.y, {steps: 3});
    await page.waitForTimeout(700);
    assert.equal(await card(page), null, "no card while placing a wire");
    await page.evaluate(() => AtriumNavHost.setTool("select"));

    // ---------------- a board: DRC (a stacked marker when there is one) and a Design Insight
    const drc = await markers(page, "drc");
    assert.ok(drc.length, "DRC markers on screen");
    const stack = drc.find(x => x.count > 1), d = stack || drc[0];
    c = await hover(page, d);
    if (stack) {
      assert.equal(c.title, stack.count + " problems here");
      assert.deepEqual(c.rows, stack.titles.slice(0, 6), "a stacked marker lists every problem in it");
      assert.ok(c.values.some(v => /required/.test(v)), "the stacked rows carry the measured and required values");
      assert.deepEqual(c.clipped, [], "no value, title or net name in the stacked list is cut off");
    } else assert.equal(c.title, d.titles[0]);
    assert.equal(c.dot, "danger");
    for (const name of d.objects.slice(0, 6)) assert.ok(c.text.includes(name), "the card names " + name);
    assert.equal(c.active, c.before, "the card takes no focus");
    placed(c, d, "DRC");
    await screenshot(page, shots, "drc-" + theme);
    const markerTitle = await page.evaluate(({x, y}) => {
      const h = AtriumNavHost, pane = h.panes().find(p => p.active);
      const {v} = AtriumDRCView.groupAt(pane, x, y);
      return "DRC · " + (v.ruleName || AtriumRules.types[v.type]?.title || v.type);
    }, d);
    await page.mouse.click(d.x, d.y, {button:"right"});
    const menu = page.getByRole("menu", {name:markerTitle, exact:true});
    await menu.getByRole("menuitem", {name:"Explain", exact:true}).waitFor();
    await page.keyboard.press("Escape");
    await menu.waitFor({state:"hidden"});
    await hover(page, d);
    await page.mouse.wheel(0, 120);
    await hidden(page, "a zoom on the board", 400);
    await settled(page);
    const single = (await markers(page, "drc")).find(x => x.count === 1);
    if (single) {
      c = await hover(page, single);
      assert.equal(c.title, single.titles[0]);
      assert.match(c.text, /Measured|required|Short|short/i, "the DRC card says what was measured");
      placed(c, single, "DRC single");
      await page.keyboard.press("Escape");
      await hidden(page, "Escape on the board", 200);
    }
    const ins = await markers(page, "insight");
    assert.ok(ins.length, "Insight markers on screen");
    c = await hover(page, ins[0]);
    assert.equal(c.title, ins[0].titles[0]);
    assert.equal(c.dot, "insight");
    assert.match(c.meta, /Tip|Advice/);
    placed(c, ins[0], "Insight");
    await screenshot(page, shots, "insight-" + theme);
    const away2 = await empty(page);
    await page.mouse.move(away2.x, away2.y, {steps: 3});
    await hidden(page, "leaving the Insight");
    assert.deepEqual(errors, []);
  } finally { await context.close(); }
}

async function touch(browser, {shots}) {
  const {context, page, errors} = await open(browser, {theme: "light", touch: true});
  try {
    const erc = await markers(page, "erc");
    const m = erc.find(x => x.count === 1) || erc[0];
    await page.touchscreen.tap(m.x, m.y);
    await page.waitForFunction(() => { const c = document.getElementById("waffle-problem-card"); return c && !c.hidden; }, null, {timeout: 1500});
    const c = await card(page);
    assert.equal(c.title, m.count > 1 ? m.count + " problems here" : m.titles[0]);
    placed(c, m, "touch ERC");
    await screenshot(page, shots, "erc-touch");
    const spot = await empty(page);
    await page.touchscreen.tap(spot.x, spot.y);
    await hidden(page, "a tap elsewhere", 400);
    const drc = await markers(page, "drc");
    await page.touchscreen.tap(drc[0].x, drc[0].y);
    await page.waitForFunction(() => { const c = document.getElementById("waffle-problem-card"); return c && !c.hidden; }, null, {timeout: 1500});
    placed(await card(page), drc[0], "touch DRC");
    await screenshot(page, shots, "drc-touch");
    await page.evaluate(() => { const p = AtriumNavHost.panes().find(q => q.active); p.view.pan(30, 0); AtriumNavHost.redraw(); });
    await hidden(page, "a pan on touch", 400);
    const secondary = await page.evaluate(async () => {
      const h = AtriumNavHost, d = h.doc();
      await h.openSplit("right", d.id, {focus: false});
      const pane = h.panes().find(p => !p.active);
      const marker = AtriumDRCView.violations(d.id).find(v => v.type === "clearance" && v.at);
      if (!marker) throw Error("Expected a clearance marker for the split touch fixture");
      pane.view.restoreCamera({cx: marker.at[0], cy: marker.at[1], scale: 22, referenceScale: 22});
      h.repaintPane(pane);
      const rect = pane.canvas.getBoundingClientRect(), [sx, sy] = pane.view.worldToScreen(marker.at);
      const x = rect.left + sx, y = rect.top + sy;
      if (document.elementFromPoint(x, y) !== pane.canvas || !AtriumProblemHover._find(pane, x, y)) {
        throw Error("Expected the clearance marker in the secondary pane");
      }
      return {x, y, published: !!AtriumDRCView.groupAt};
    });
    await page.touchscreen.tap(secondary.x, secondary.y);
    await page.locator("#waffle-problem-card").waitFor({state: "visible", timeout: 1500});
    if (secondary.published) {
      assert.equal(await page.evaluate(({x, y}) => document.elementFromPoint(x, y) === AtriumNavHost.canvas(), secondary), true,
        "a secondary pane touch activates that pane and still opens its problem card");
    }
    assert.deepEqual(errors, []);
  } finally { await context.close(); }
}

module.exports = async function problemHover(browser, {screenshotDir} = {}) {
  for (const theme of ["light", "dark"]) await desktop(browser, {theme, shots: screenshotDir});
  await touch(browser, {shots: screenshotDir});
  console.log("PASS problem hover card: ERC, DRC and Insight markers in light, dark and touch; placement, focus and dismissal");
};
