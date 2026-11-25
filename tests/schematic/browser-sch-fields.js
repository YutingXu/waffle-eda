"use strict";
// Part text and pens on an imported Altium schematic (run by integration-browser.cjs, --fields-only):
// pressing a Designator or a visible parameter drags that text only, with its part outlined, in one
// undo step; Space turns the text. Pin numbers sit above their pin lines with Altium's gap. On the
// imported board, a component's designator silkscreen moves without the component.

const assert = require("node:assert/strict");
const path = require("node:path");
const {pathToFileURL} = require("node:url");

async function openFixture(browser) {
  const page = await browser.newPage({viewport: {width: 1400, height: 900}}), errors = [];
  page.on("pageerror", err => errors.push(err.message));
  await page.goto(pathToFileURL(path.join(__dirname, "../../app/index.html")).href);
  const chooser = page.waitForEvent("filechooser");
  await page.locator('dialog.sp-dialog[open] [data-start-action="import"]').click();
  await (await chooser).setFiles(path.join(__dirname, "../fixtures/altium/pidp11-io-expander/PiDP11IOExpander.SchDoc"));
  await page.waitForFunction(() => AtriumNavHost.project().documents.some(d => d.kind === "schematic" && d.items.length > 10));
  await page.locator("button.document-tab", {hasText: "PiDP11IOExpander"}).first().click();
  await page.waitForFunction(() => AtriumNavHost.doc().kind === "schematic" && !!globalThis.AtriumSchFields);
  return {page, errors};
}
// The screen point at the middle of a field's glyph box.
function fieldPoint(page, ref, key) {
  return page.evaluate(([ref, key]) => {
    const H = AtriumNavHost, d = H.doc(), part = d.items.find(i => i.kind === "part" && i.ref === ref);
    const f = AtriumSchFields.find(d, H.defs(), {id: part.id, key}), q = AtriumSchFields.quad(f);
    const c = [(q[0][0] + q[2][0]) / 2, (q[0][1] + q[2][1]) / 2], s = H.view().worldToScreen(c), r = H.canvas().getBoundingClientRect();
    return {x: s[0] + r.left, y: s[1] + r.top, id: part.id, anchor: f.at, px: H.view().scale(), grid: d.grid};
  }, [ref, key]);
}
const partState = (page, id) => page.evaluate(id => {
  const p = AtriumNavHost.doc().items.find(i => i.id === id);
  return JSON.parse(JSON.stringify({x: p.x, y: p.y, angle: p.angle || 0, refAt: p.refAt, ref: p.schPaint?.ref, parameters: p.schPaint?.parameters}));
}, id);

async function designatorDrag(page) {
  const box = await page.evaluate(() => {const u = AtriumNavHost.doc().items.find(i => i.ref === "U1"); return [u.x - 18, u.y - 14, u.x + 26, u.y + 22];});
  await page.evaluate(b => AtriumNavHost.zoomTo(b, {margin: .02}), box);
  await page.waitForFunction(() => !globalThis.AtriumMotion?.active());
  const at = await fieldPoint(page, "U1", "ref"), before = await partState(page, at.id);
  // Hovering the Designator outlines U1 without selecting it.
  await page.mouse.move(at.x, at.y);
  assert.deepEqual(await page.evaluate(() => AtriumNavHost.fieldFocus()), {id: at.id, key: "ref", mode: "hover"});
  assert.deepEqual(await page.evaluate(() => AtriumNavHost.selection()), []);
  // Two grid steps right and one up, in small moves.
  const dx = 2 * at.grid * at.px, dy = -at.grid * at.px;
  await page.mouse.down();
  for (let k = 1; k <= 8; k++) await page.mouse.move(at.x + dx * k / 8, at.y + dy * k / 8);
  assert.deepEqual(await page.evaluate(() => AtriumNavHost.fieldFocus()), {id: at.id, key: "ref", mode: "drag"}, "the owner is outlined while its text moves");
  const tinted = await page.locator("#canvas").screenshot();
  await page.mouse.up();
  const after = await partState(page, at.id);
  assert.deepEqual([after.x, after.y, after.angle], [before.x, before.y, before.angle], "the component stays where it was");
  assert.notDeepEqual(after.refAt, before.refAt, "the Designator offset changed");
  const moved = await page.evaluate(id => {const H = AtriumNavHost, d = H.doc(), p = d.items.find(i => i.id === id); return AtriumSchFields.find(d, H.defs(), {id, key: "ref"}).at;}, at.id);
  const snapped = at.anchor.map((v, k) => Math.round((v + [2 * at.grid, -at.grid][k]) / at.grid) * at.grid);
  for (let k = 0; k < 2; k++) assert.ok(Math.abs(moved[k] - snapped[k]) < 1e-6, "the Designator anchor snaps to the grid: " + moved + " vs " + snapped);
  assert.deepEqual(await page.evaluate(() => AtriumNavHost.selection()), [], "the part is not selected");
  assert.deepEqual(await page.evaluate(() => AtriumNavHost.fieldFocus()), {id: at.id, key: "ref", mode: "selected"});
  assert.match(await page.locator("#inspector").innerText(), /Designator · U1/, "Properties shows the Designator");
  // One undo step restores the offset; redo moves it again.
  await page.evaluate(() => AtriumNavHost.act("undo"));
  assert.deepEqual(await partState(page, at.id), before, "one undo restores the Designator");
  await page.evaluate(() => AtriumNavHost.act("redo"));
  assert.deepEqual((await partState(page, at.id)).refAt, after.refAt);
  // Space while dragging turns the text a quarter anticlockwise; the part does not turn.
  const again = await fieldPoint(page, "U1", "ref");
  await page.mouse.move(again.x, again.y);
  await page.mouse.down();
  await page.mouse.move(again.x + 10, again.y + 2);
  await page.mouse.move(again.x + 20, again.y + 4);
  await page.keyboard.press("Space");
  await page.mouse.up();
  const turned = await partState(page, at.id);
  assert.equal(turned.angle, before.angle);
  assert.equal(((turned.ref.angle - (before.ref?.angle || 0)) % 360 + 360) % 360, 270, "the Designator turned, the part did not");
  return tinted;
}

async function parameterDrag(page) {
  const target = await page.evaluate(() => {
    const H = AtriumNavHost, d = H.doc();
    for (const p of d.items.filter(i => i.kind === "part")) {
      const name = AtriumSchObjects.shownParams(p).find(k => p.schPaint?.parameters?.[k]);
      if (name) return {ref: p.ref, key: "param:" + name, name, box: [p.x - 12, p.y - 12, p.x + 12, p.y + 12]};
    }
    return null;
  });
  assert.ok(target, "the fixture shows an imported parameter");
  await page.evaluate(b => AtriumNavHost.zoomTo(b, {margin: .02}), target.box);
  await page.waitForFunction(() => !globalThis.AtriumMotion?.active());
  const at = await fieldPoint(page, target.ref, target.key), before = await partState(page, at.id);
  await page.mouse.move(at.x, at.y);
  await page.mouse.down();
  for (let k = 1; k <= 6; k++) await page.mouse.move(at.x - k * at.grid * at.px / 3, at.y + k * at.grid * at.px / 3);
  await page.mouse.up();
  const after = await partState(page, at.id);
  assert.deepEqual([after.x, after.y, after.angle], [before.x, before.y, before.angle]);
  assert.notDeepEqual(after.parameters[target.name].at, before.parameters[target.name].at, "the parameter moved relative to its part");
  assert.deepEqual(after.refAt, before.refAt, "only the pressed text moved");
  await page.evaluate(() => AtriumNavHost.act("undo"));
  assert.deepEqual(await partState(page, at.id), before);
}

// Pin numbers in Chrome's own glyphs, all four pin directions: ink above a horizontal pin (left of a
// vertical one) with the font's descent as the gap, starting 80 mil from the body. Altium's print of a
// 10 pt pin number: 82 mil from the body, digits 0.47 mm above the pin's centre line.
function pinNumberInk(page) {
  return page.evaluate(() => {
    const S = AtriumSchAppearance, k = 40, out = [];
    for (const direction of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const c = document.createElement("canvas"); c.width = c.height = 600; const ctx = c.getContext("2d");
      ctx.fillStyle = "#fff"; ctx.fillRect(0, 0, 600, 600); ctx.setTransform(k, 0, 0, k, 300, 300);
      const def = {schDrawing: {pinFont: {family: "Times New Roman", size: 2.032}, pins: [{start: [0, 0], end: [direction[0] * 7.62, direction[1] * 7.62], direction, name: "", number: "22"}]}};
      S.pinText(ctx, {x: 0, y: 0, angle: 0}, def, k, false);
      const d = ctx.getImageData(0, 0, 600, 600).data;let x0 = 1e9, y0 = 1e9, x1 = -1, y1 = -1;
      for (let y = 0; y < 600; y++) for (let x = 0; x < 600; x++) if (d[(y * 600 + x) * 4] < 140) {x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y);}
      out.push({direction, box: [x0, y0, x1 + 1, y1 + 1].map(v => (v - 300) / k)});
    }
    return out;
  });
}

async function boardLabelDrag(browser) {
  const page = await browser.newPage({viewport: {width: 1400, height: 900}}), errors = [];
  page.on("pageerror", err => errors.push(err.message));
  try {
    await page.goto(pathToFileURL(path.join(__dirname, "../../app/index.html")).href);
    const dir = path.join(__dirname, "../fixtures/altium/pidp11-io-expander"), chooser = page.waitForEvent("filechooser");
    await page.locator('dialog.sp-dialog[open] [data-start-action="import"]').click();
    await (await chooser).setFiles(["PCB-PiDP11IOExpander.PrjPcb", "PiDP11IOExpander.SchDoc", "PiDP11IOExpander.PcbDoc"].map(n => path.join(dir, n)));
    await page.waitForFunction(() => AtriumNavHost.project().documents.some(d => d.kind === "pcb" && d.items.length > 10));
    await page.evaluate(() => AtriumNavHost.selectDocument(AtriumNavHost.project().documents.find(d => d.kind === "pcb").id));
    await page.waitForFunction(() => AtriumNavHost.doc().kind === "pcb");
    await page.evaluate(() => AtriumLazy.need("AtriumSchFields"));
    const u = await page.evaluate(() => {const u = AtriumNavHost.doc().items.find(i => i.kind === "part" && i.ref === "U1"); return {x: u.x, y: u.y};});
    await page.evaluate(u => AtriumNavHost.zoomTo([u.x - 8, u.y - 8, u.x + 8, u.y + 8], {margin: .02}), u);
    await page.waitForFunction(() => !globalThis.AtriumMotion?.active());
    // A point on U1's imported Designator glyphs.
    const at = await page.evaluate(() => {
      const H = AtriumNavHost, d = H.doc(), v = H.view(), u = d.items.find(i => i.kind === "part" && i.ref === "U1"), r = H.canvas().getBoundingClientRect();
      for (let x = u.x - 8; x < u.x + 8; x += .1) for (let y = u.y - 8; y < u.y + 8; y += .1) {
        const l = AtriumSchFields.pick(v, d, H.defs(), [x, y], {hidden: H.hiddenLayers(), layer: "Top"});
        if (l?.item === u) {const s = v.worldToScreen([x, y]); return {x: s[0] + r.left, y: s[1] + r.top, kind: l.label.kind, at: u.boardLabels?.[l.label.index]?.at};}
      }
      return null;
    });
    assert.equal(at?.kind, "annotation", "U1's imported Designator is found under the pointer");
    await page.mouse.move(at.x, at.y);
    await page.mouse.down();
    for (let k = 1; k <= 8; k++) await page.mouse.move(at.x + k * 8, at.y + k * 5);
    await page.mouse.up();
    const after = await page.evaluate(() => {const u = AtriumNavHost.doc().items.find(i => i.kind === "part" && i.ref === "U1"); return {x: u.x, y: u.y, at: u.boardLabels[0].at};});
    assert.deepEqual([after.x, after.y], [u.x, u.y], "the component stays where it was");
    assert.notDeepEqual(after.at, at.at, "the Designator moved");
    await page.evaluate(() => AtriumNavHost.act("undo"));
    assert.deepEqual(await page.evaluate(() => AtriumNavHost.doc().items.find(i => i.kind === "part" && i.ref === "U1").boardLabels[0].at), at.at, "one undo");
    assert.deepEqual(errors, []);
  } finally { await page.close(); }
}

// Drawn pens on the imported sheet at a fixed zoom: Altium draws pin legs, Small wires and Small
// body lines with the same 10 mil pen. Each stroke's width is its summed ink coverage across the
// line, in device pixels: the least of five places along it, so that pin numbers and crossings beside the
// line do not count. The median over every pin leg with a wire on its tip is compared.
async function penWidths(page) {
  return page.evaluate(() => {
    const H = AtriumNavHost, doc = H.doc(), defs = H.defs(), scale = 8, W = 600, Hgt = 400;
    const canvas = document.createElement("canvas");
    canvas.style.cssText = `position:fixed;left:0;top:0;width:${W}px;height:${Hgt}px`;
    document.body.append(canvas);
    const view = AtriumCanvas.create(canvas), hex = h => [1, 3, 5].map(i => parseInt(h.slice(i, i + 2), 16));
    const near = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]) < .01, median = v => v.sort((a, b) => a - b)[v.length >> 1];
    const wires = doc.items.filter(i => i.kind === "wire"), rows = {pin: [], wire: [], body: []};
    function coverage(a, b, ink, from = .2, to = .8) {
      return Math.min(...[0, .25, .5, .75, 1].map(f => across(a, b, from + (to - from) * f, ink)));
    }
    function across(a, b, t, ink) {
      const dpr = canvas.width / W, len = Math.hypot(b[0] - a[0], b[1] - a[1]), d = [(b[0] - a[0]) / len, (b[1] - a[1]) / len];
      const at = view.worldToScreen([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]).map(v => v * dpr);
      const data = canvas.getContext("2d").getImageData(0, 0, canvas.width, canvas.height).data;
      const px = (x, y) => { const o = (Math.round(y) * canvas.width + Math.round(x)) * 4; return [data[o], data[o + 1], data[o + 2]]; };
      const paper = px(at[0] - d[1] * 12 * dpr, at[1] + d[0] * 12 * dpr), pen = hex(ink);
      let sum = 0;
      for (let k = -5 * dpr; k <= 5 * dpr; k++) {
        const v = px(at[0] - d[1] * k, at[1] + d[0] * k);
        sum += Math.max(0, ...[0, 1, 2].map(c => Math.abs(paper[c] - pen[c]) > 60 ? Math.min(1, Math.max(0, (paper[c] - v[c]) / (paper[c] - pen[c]))) : 0));
      }
      return sum / dpr / scale;
    }
    for (const part of doc.items.filter(i => i.kind === "part")) {
      const def = defs.get(part.def);
      for (const s of def?.symbol?.shapes || []) {
        const leg = s.schPaint?.ink === "#000000"; // pin legs are drawn in Altium's black pin colour, whatever their stored pen
        if (s.kind !== "path" || s.points.length !== 2 || !leg && s.schPaint?.width !== .254) continue;
        const [a, b] = s.points.map(q => Atrium.world(q, part));
        const wire = leg && wires.find(w => w.points.some(q => near(q, a) || near(q, b)));
        view.restoreCamera({cx: a[0], cy: a[1], scale, referenceScale: scale});
        view.render(doc, defs, {});
        if (!wire) { if (!leg) rows.body.push(coverage(a, b, s.schPaint.ink)); continue; }
        const tip = wire.points.find(q => near(q, a) || near(q, b)), other = wire.points[wire.points.indexOf(tip) ? wire.points.indexOf(tip) - 1 : 1];
        const len = Math.hypot(other[0] - tip[0], other[1] - tip[1]);
        rows.pin.push(coverage(a, b, s.schPaint.ink));
        rows.wire.push(coverage(tip, other, wire.schPaint?.ink || "#000080", Math.min(.5, len / 4) / len, Math.min(1.5, len / 2) / len));
      }
    }
    canvas.remove();
    return {count: rows.pin.length, pin: median(rows.pin), wire: median(rows.wire), body: median(rows.body)};
  });
}

module.exports = async function schFields(browser) {
  const {page, errors} = await openFixture(browser);
  try {
    const pens = await penWidths(page);
    assert.ok(pens.count >= 10, "pin legs with wires measured: " + pens.count);
    for (const kind of ["pin", "wire", "body"])
      assert.ok(Math.abs(pens[kind] - .254) < .03, kind + " is drawn " + pens[kind].toFixed(3) + " mm wide, Altium's Small pen is 0.254 mm");
    for (const {direction: [dx, dy], box: [x0, y0, x1, y1]} of await pinNumberInk(page)) {
      const name = "pin pointing " + [dx, dy];
      if (dx) {
        assert.ok(-y1 >= .3 && -y1 <= .65, name + ": digits clear the line by " + (-y1).toFixed(3) + " mm");
        const near = dx > 0 ? x0 : -x1;
        assert.ok(near >= 1.9 && near <= 2.4, name + ": number starts " + near.toFixed(3) + " mm from the body");
      } else {
        assert.ok(-x1 >= .3 && -x1 <= .65, name + ": digits clear the line by " + (-x1).toFixed(3) + " mm");
        const near = dy > 0 ? y0 : -y1;
        assert.ok(near >= 1.9 && near <= 2.4, name + ": number starts " + near.toFixed(3) + " mm from the body");
      }
    }
    await designatorDrag(page);
    await parameterDrag(page);
    assert.deepEqual(errors, []);
  } finally { await page.close(); }
  await boardLabelDrag(browser);
};
