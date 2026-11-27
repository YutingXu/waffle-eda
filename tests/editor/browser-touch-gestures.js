"use strict";
// Trusted touch on the schematic and the board, in the default Preview profile and with Labs on:
// one finger pans blank space and never selects, two fingers pinch about their midpoint, a tap
// selects a part and a one-finger drag moves it. The mouse keeps its rubber-band selection.

const assert = require("node:assert/strict");
const path = require("node:path");
const {pathToFileURL} = require("node:url");

// Find a blank point and a part whose centre picks it, both well inside the canvas.
function targets() {
  const h = AtriumNavHost, c = h.canvas(), r = c.getBoundingClientRect(), v = h.view();
  const inside = ([x, y]) => x > 60 && y > 60 && x < r.width - 60 && y < r.height - 60;
  const pick = at => h.hit(c, r.left + at[0], r.top + at[1])?.item || null;
  let blank = null;
  for (let y = 80; y < r.height - 80 && !blank; y += 23)
    for (let x = 80; x < r.width - 80 && !blank; x += 23) {
      const ring = [[0,0],[-30,0],[30,0],[0,-30],[0,30],[60,40],[-60,-40]].map(([dx, dy]) => [x+dx, y+dy]);
      if (ring.every(at => inside(at) && !pick(at))) blank = [x, y];
    }
  let part = null;
  for (const item of h.doc().items.filter(i => i.kind === "part" && !i.locked)) {
    const box = AtriumNavCommon.itemBox(h.doc(), h.defs(), item);
    if (!box) continue;
    const at = v.worldToScreen([(box[0]+box[2])/2, (box[1]+box[3])/2]);
    if (inside(at) && pick(at)?.id === item.id) { part = {id:item.id, at}; break; }
  }
  return {origin:[r.left, r.top], blank, part};
}

async function checkDocument(page, kind, labs) {
  const label = `${kind}${labs ? " with Labs" : ""}`;
  await page.evaluate(kind => {
    const h = AtriumNavHost, d = h.project().documents.find(d => d.kind === kind);
    h.selectDocument(d.id); h.setTool("select"); h.select([]); h.canvas().focus();
    if (d.kind === "pcb") h.act("fit"); // keep parts on screen
  }, kind);
  await page.waitForFunction(kind => AtriumNavHost.doc().kind === kind && !globalThis.AtriumMotion?.active(), kind);
  const cdp = await page.context().newCDPSession(page);
  const touch = (type, points) => cdp.send("Input.dispatchTouchEvent", {type, touchPoints:points.map(([id,x,y]) => ({id,x,y}))});
  const state = () => page.evaluate(() => ({camera:AtriumNavHost.view().camera(), selection:AtriumNavHost.selection(),
    drag:AtriumNavHost.drag()?.kind || null}));
  const {origin, blank, part} = await page.evaluate(targets);
  assert.ok(blank, `${label}: a blank area to drag`);
  assert.ok(part, `${label}: a part to tap and drag`);
  const at = ([x, y]) => [origin[0]+x, origin[1]+y];

  // One finger on blank space pans and leaves the selection alone.
  const [bx, by] = at(blank), before = await state();
  await touch("touchStart", [[1,bx,by]]);
  for (let i = 1; i <= 8; i++) await touch("touchMove", [[1,bx+i*6,by+i*4]]);
  const during = await state();
  await touch("touchEnd", []);
  const panned = await state();
  assert.equal(during.drag, null, `${label}: a one-finger drag starts no selection rectangle`);
  assert.deepEqual(panned.selection, [], `${label}: a one-finger drag selects nothing`);
  assert.equal(panned.camera.scale, before.camera.scale, `${label}: a one-finger drag does not zoom`);
  const shift = await page.evaluate(cam => {
    const now = AtriumNavHost.view().camera();
    return Math.hypot((cam.cx-now.cx)*now.scale, (cam.cy-now.cy)*now.scale);
  }, before.camera);
  assert.ok(Math.abs(shift - Math.hypot(48, 32)) < 1.5, `${label}: the canvas follows the finger (${shift.toFixed(1)} px)`);

  // Two fingers pinch about their midpoint and never select.
  const [mx, my] = at(blank), anchor = await page.evaluate(([x, y]) => AtriumNavHost.view().screenToWorld([x, y]), blank);
  const pinchStart = await state();
  await touch("touchStart", [[1,mx-40,my],[2,mx+40,my]]);
  for (let i = 1; i <= 8; i++) await touch("touchMove", [[1,mx-40-i*5,my],[2,mx+40+i*5,my]]);
  await touch("touchEnd", []);
  const pinched = await state(), still = await page.evaluate(w => AtriumNavHost.view().worldToScreen(w), anchor);
  assert.ok(Math.abs(pinched.camera.scale/pinchStart.camera.scale - 2) < .02, `${label}: spreading two fingers to twice the span zooms 2x`);
  assert.ok(Math.hypot(still[0]-blank[0], still[1]-blank[1]) < 1.5, `${label}: the pinch keeps the midpoint under the fingers`);
  assert.deepEqual(pinched.selection, [], `${label}: two fingers select nothing`);
  // Back to the first camera, where the part was found.
  await page.evaluate(cam => { AtriumNavHost.view().restoreCamera(cam); AtriumNavHost.redraw(); }, before.camera);

  // A tap selects the part; a one-finger drag on the selected part moves it, in one Undo step.
  const [px, py] = at(part.at), item = id => page.evaluate(id => JSON.stringify(AtriumNavHost.doc().items.find(i => i.id === id)), id);
  await touch("touchStart", [[1,px,py]]); await touch("touchEnd", []);
  await page.waitForFunction(id => AtriumNavHost.selection().includes(id), part.id);
  const original = await item(part.id), camera = (await state()).camera;
  await touch("touchStart", [[1,px,py]]);
  for (let i = 1; i <= 10; i++) await touch("touchMove", [[1,px+i*8,py+i*5]]);
  await touch("touchEnd", []);
  const after = await state(), dropped = JSON.parse(await item(part.id));
  assert.notEqual(JSON.stringify(dropped), original, `${label}: dragging a selected part with one finger moves it`);
  assert.deepEqual(after.camera, camera, `${label}: moving a part does not pan`);
  assert.deepEqual(after.selection, [part.id]);
  await page.evaluate(() => AtriumNavHost.act("undo"));
  assert.equal(await item(part.id), original, `${label}: one Undo restores the part`);

  // The mouse still drags a selection rectangle from blank space.
  await page.evaluate(() => AtriumNavHost.select([]));
  await page.mouse.move(bx, by); await page.mouse.down(); await page.mouse.move(bx+30, by+20, {steps:3});
  const box = await state();
  await page.mouse.up();
  assert.equal(box.drag, "box", `${label}: a mouse drag on blank space still draws a selection rectangle`);
  assert.equal(box.camera.cx, (await state()).camera.cx, `${label}: a mouse drag does not pan`);
  await cdp.detach();
}

// The macOS host forwards touchscreen contacts that WebKit would report as a mouse (main.swift EditorWebView).
async function checkHostTouches(page) {
  await page.evaluate(() => { const h = AtriumNavHost; h.selectDocument(h.project().documents.find(d => d.kind === "schematic").id);
    h.setTool("select"); h.select([]); });
  const {origin, blank} = await page.evaluate(targets);
  const result = await page.evaluate(async ([origin, blank]) => {
    const h = AtriumNavHost, send = (phase, rows) => __waffleDirectTouch(phase, rows), frame = () => new Promise(requestAnimationFrame);
    const [x, y] = [origin[0]+blank[0], origin[1]+blank[1]], before = h.view().camera();
    const toolbar = document.querySelector("#doc-name")?.getBoundingClientRect();
    const declined = toolbar ? send("start", [[0, toolbar.left+4, toolbar.top+4]]) : false;
    const taken = send("start", [[0, x, y]]);
    for (let i = 1; i <= 6; i++) { send("move", [[0, x+i*8, y]]); await frame(); }
    const drag = h.drag()?.kind || null;
    send("end", [[0, x+48, y]]); await frame();
    const panned = h.view().camera();
    send("start", [[0, x-40, y]]); send("start", [[1, x+40, y]]);
    for (let i = 1; i <= 8; i++) { send("move", [[0, x-40-i*5, y], [1, x+40+i*5, y]]); await frame(); }
    send("end", [[0, x-80, y], [1, x+80, y]]); await frame();
    return {declined, taken, drag, selection:h.selection(), moved:(before.cx-panned.cx)*panned.scale,
      zoom:h.view().camera().scale/panned.scale, again:send("move", [[0, x, y]])};
  }, [origin, blank]);
  assert.equal(result.declined, false, "a host touch outside the canvas stays an ordinary mouse contact");
  assert.equal(result.taken, true, "a host touch on the canvas is taken as a touch contact");
  assert.equal(result.drag, null, "a forwarded one-finger drag starts no selection rectangle");
  assert.ok(Math.abs(result.moved - 48) < 1.5, `a forwarded one-finger drag pans (${result.moved})`);
  assert.ok(Math.abs(result.zoom - 2) < .02, `forwarded two-finger spread zooms (${result.zoom})`);
  assert.deepEqual(result.selection, []);
  assert.equal(result.again, false, "an ended host contact is forgotten");
}

module.exports = async function touchGestures(browser) {
  for (const labs of [false, true]) {
    const context = await browser.newContext({viewport:{width:1280,height:860}, hasTouch:true});
    const page = await context.newPage(), errors = [];
    if (labs) await require("../fixtures/notebook-labs.cjs").profile(page);
    page.on("pageerror", error => errors.push(error.message));
    try {
      await page.goto(pathToFileURL(path.join(__dirname, "../../app/index.html")).href);
      await page.locator("dialog.sp-dialog[open] [data-start-action=demo]").click();
      await page.waitForFunction(() => !!globalThis.AtriumNavHost && AtriumNavHost.doc().kind === "pcb");
      assert.equal(await page.evaluate(() => AtriumLabs.notebookEnabled()), labs);
      for (const kind of ["schematic", "pcb"]) await checkDocument(page, kind, labs);
      if (!labs) {
        await checkHostTouches(page);
        const ranking = await page.evaluate(() => {
          const makeIndex = AtriumSpatial.create;
          let queries = 0;
          AtriumSpatial.create = (...args) => {
            const index = makeIndex(...args), query = index.query;
            index.query = function(box) { ++queries; return query.call(index, box); };
            return index;
          };
          try {
            const view = AtriumCanvas.create(document.createElement("canvas")), defs = new Map();
            view.restoreCamera({cx: 0, cy: 0, scale: 1, referenceScale: 1});
            const junction = (id, x, y) => ({id, kind: "junction", x, y});
            const probe = (kind, items, opts = {}) => {
              const doc = Atrium.sheet(kind, kind);
              doc.items = [...items, junction("away", 40, 40)];
              view.hit(doc, defs, [0, 0], opts);
              const before = queries, hits = view.hits(doc, defs, [0, 0], opts).map(x => x.id);
              const count = queries - before;
              const repeated = [], skip = new Set(opts.skip);
              for (let item; repeated.length < 8 && (item = view.hit(doc, defs, [0, 0], {...opts, skip})); skip.add(item.id)) repeated.push(item.id);
              return {hits, repeated, count};
            };
            const schematic = [junction("left", 0, 0), junction("right", 0, 0),
              {id: "wire", kind: "wire", points: [[-2, 0], [2, 0]]}];
            const track = (id, layer, x) => ({id, kind: "track", layer, width: .2, points: [[x, 0], [x + 3, 0]]});
            return [
              probe("schematic", schematic),
              probe("schematic", schematic, {skip: new Set(["right"])}),
              probe("pcb", [track("top", "Top", -2), track("bottom", "Bottom", 2), track("inner", "Inner 1", -2)],
                {layer: "Bottom", layerMode: "all", hidden: new Set(["Inner 1"])}),
              probe("schematic", Array.from({length: 9}, (_, n) => junction("j" + n, n * .3, 0))),
            ];
          } finally { AtriumSpatial.create = makeIndex; }
        });
        const expected = [["right", "left", "wire"], ["left", "wire"], ["bottom", "top"],
          Array.from({length: 8}, (_, n) => "j" + n)];
        assert.deepEqual(ranking.map(r => r.hits), expected);
        for (const {hits, repeated, count} of ranking) {
          assert.deepEqual(hits, repeated);
          assert.equal(count, 1, "one indexed spatial query per ranked stack");
        }
      }
      assert.deepEqual(errors, []);
    } finally { await context.close(); }
  }
  console.log("PASS touch gestures: one finger pans and moves a selected part, two fingers pinch, mouse box-selects, host-forwarded touches (Preview and Labs)");
};

if (require.main === module) {
  const {chromium} = require("../support/playwright.cjs");
  (async () => {
    const browser = await chromium.launch(process.env.CHROME ? {executablePath:process.env.CHROME} :
      {channel:"chrome", args:["--allow-file-access-from-files"]});
    try { await module.exports(browser); } finally { await browser.close(); }
  })().catch(error => { console.error(error); process.exitCode = 1; });
}
