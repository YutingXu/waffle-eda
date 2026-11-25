"use strict";

const assert = require("node:assert/strict");
const {menu, openProperties, zoom, screen} = require("./browser.cjs");

async function chooseFrame(page) {
  return page.evaluate(async () => {
    await AtriumLazy.need(["AtriumFrameConversion", "AtriumNetlist"]);
    const h = AtriumNavHost, A = Atrium, S = AtriumSchObjects, p = h.project(), defs = h.defs();
    const sheets = p.documents.filter(d => d.kind === "schematic");
    let tried = 0, rejected = 0;
    for (const doc of sheets) {
      const g = Math.max(doc.grid || .254, .254);
      const local = AtriumHierarchy.local(doc, defs);
      for (const item of doc.items) {
        if (item.kind !== "part" || tried >= 6) continue;
        const pins = A.pins(item, defs.get(item.def), doc.kind);
        if (pins.length < 2 || pins.length > 6) continue;
        const b = A.bounds(A.itemPoints(item, defs.get(item.def), doc.kind));
        if (!b) continue;
        const low = n => Math.floor(n / g) * g - g, high = n => Math.ceil(n / g) * g + g;
        const box = [low(b[0]), low(b[1]), high(b[2]), high(b[3])];
        const inside = ([x, y]) => x >= box[0] && x <= box[2] && y >= box[1] && y <= box[3];
        const crossing = local.nets.some(net => net.pins.some(c => c.i === item && inside(c.pin.at))
          && net.pins.some(c => c.i !== item && !inside(c.pin.at))
          && net.wires.some(w => w.points.some((at, i) => i && inside(at) !== inside(w.points[i - 1]))));
        if (!crossing) continue;

        const probe = S.make("frame", box.slice(0, 2), {w: box[2] - box[0], h: box[3] - box[1], text: "QA circuit"});
        const draft = {...p, documents: p.documents.map(d => d === doc ? {...d, items: [...d.items, probe]} : d)};
        tried++;
        try {
          const plan = AtriumFrameConversion.plan(draft, doc.id, probe.id);
          if (plan.symbol.entries.length && plan.child.items.some(i => i.id === item.id)) {
            h.selectDocument(doc.id);
            h.select([]);
            return {doc: doc.id, item: item.id, box, tried, rejected, seededCircuit: false};
          }
        } catch {}
        rejected++;
      }
    }

    // The dense synthetic input has only a wire and a label. Keep the same
    // backing project, and add a known two-pin crossing on the copied sheet.
    const doc = sheets[0], bounds = A.bounds(doc.items.flatMap(i => A.itemPoints(i, defs.get(i.def), doc.kind))) || [0, 0, 50, 50];
    const g = Math.max(doc.grid || .254, .254);
    const snap = n => Math.round(n / g) * g;
    const x = snap(bounds[2] + 40), y = snap(bounds[1] + 30);
    const def = AtriumParts.catalogue.find(d => d.id === "std-r");
    const part = (ref, x) => ({id: A.id(), kind: "part", def: def.id, ref, value: "10k", x, y, angle: 0, pinNets: {}});
    const a = part("QA801", x), b = part("QA802", x + 40);
    const pinAt = (item, n) => A.pins(item, def, doc.kind).find(p => p.number === n).at;
    const points = [pinAt(a, "2"), pinAt(b, "1")];
    const box = [snap(x - 8), snap(y - 8), snap(x + 10), snap(y + 8)];
    h.selectDocument(doc.id);
    h.edit(() => {
      if (!p.library.some(d => d.id === def.id)) p.library.push(A.clone(def));
      doc.items.push(a, b, {id: A.id(), kind: "wire", points},
        {id: A.id(), kind: "netlabel", text: "__QA_FRAME_BOUNDARY_R5", x: points[1][0], y: points[1][1]});
    });
    h.select([]);
    return {doc: doc.id, item: a.id, box, tried, rejected, seededCircuit: true};
  });
}

async function placeFrame(page, plan) {
  await openProperties(page);
  const size = page.getByRole("combobox", {name: "Sheet size", exact: true});
  const showSettings = async () => {
    if (!await size.isVisible()) await page.locator("#inspector summary").filter({hasText: "Document settings"}).click();
    await size.waitFor();
  };
  await showSettings();
  const original = await size.inputValue();
  const before = await page.evaluate(() => {
    const d = AtriumNavHost.doc();
    return {grid: d.grid, paper: AtriumSchAppearance.pageBounds(d), drawing: JSON.stringify(d.schDrawing || null)};
  });
  assert.notEqual(original, "none");
  await size.selectOption("none");
  await page.waitForFunction(() => AtriumSchAppearance.isInfinite(AtriumNavHost.doc()));
  const after = await page.evaluate(() => {
    const d = AtriumNavHost.doc();
    return {grid: d.grid, drawing: JSON.stringify(d.schDrawing || null)};
  });
  assert.deepEqual(after, {grid: before.grid, drawing: before.drawing});
  await size.selectOption(original);
  await page.waitForFunction(() => !AtriumSchAppearance.isInfinite(AtriumNavHost.doc()));
  const restored = await page.evaluate(() => AtriumSchAppearance.pageBounds(AtriumNavHost.doc()));
  const dimensions = ([left, top, right, bottom]) => [right - left, bottom - top];
  assert.deepEqual(dimensions(restored), dimensions(before.paper), "Restoring the page changed its paper dimensions.");
  if (before.drawing !== "null") assert.deepEqual(restored, before.paper, "Restoring an explicit source page moved its origin.");

  await zoom(page, plan.box);
  await menu(page, "place", "sch-frame");
  await page.waitForFunction(() => AtriumNavHost.tool() === "sch-place");
  for (const p of [plan.box.slice(0, 2), plan.box.slice(2)]) await page.mouse.click(...await screen(page, p));
  const dialog = page.getByRole("dialog", {name: "Place frame", exact: true});
  await dialog.getByRole("textbox", {name: "Name", exact: true}).fill("QA circuit");
  await dialog.getByRole("button", {name: "OK", exact: true}).click();
  await page.waitForFunction(() => AtriumNavHost.doc().items.some(AtriumSchObjects.isFrame));
  const frame = await page.evaluate(() => {
    const h = AtriumNavHost, item = h.doc().items.find(i => AtriumSchObjects.isFrame(i) && i.text === "QA circuit");
    return item && {id: item.id, x: item.x, y: item.y, w: item.w, h: item.h};
  });
  assert.ok(frame, "The Frame command did not place a named frame on a fixed sheet.");

  await page.evaluate(() => AtriumNavHost.select([]));
  await showSettings();
  await size.selectOption("none");
  await page.waitForFunction(() => AtriumSchAppearance.isInfinite(AtriumNavHost.doc()));
  await menu(page, "view", "fit-document");
  assert.ok(await page.evaluate(() => Number.isFinite(AtriumNavHost.view().scale()) && AtriumNavHost.view().scale() > 0),
    "Fit did not select a usable view on an infinite sheet.");
  await page.evaluate(() => {
    const h = AtriumNavHost, board = h.project().documents.find(d => d.kind === "pcb");
    if (board) h.selectDocument(board.id);
  });
  await menu(page, "panels", "navigator-panel");
  await page.getByRole("searchbox", {name: "Search the Navigator", exact: true}).fill("QA circuit");
  await page.locator(".navp-count:visible").filter({hasText: /^1\/\d+$/}).waitFor();
  await page.locator('.navp-row[data-type="frame"]:visible').filter({hasText: "QA circuit"}).click();
  await page.waitForFunction(({doc, id}) => AtriumNavHost.currentId() === doc && AtriumNavHost.selection().includes(id), {doc: plan.doc, id: frame.id});
  return frame;
}

async function snapshotNetlist(page, plan, frame) {
  await page.evaluate(async ({plan, frame}) => {
    await AtriumLazy.need("AtriumDiff");
    const h = AtriumNavHost;
    function snapshot(p) {
      const n = AtriumNetlist.extract(p, {source: "schematic"});
      const pinNets = n.nets.map(net => [net.name, net.nodes.map(pin => [pin.ref, pin.pin]).sort()]).sort();
      const compiled = AtriumHierarchy.compile(p);
      const endpointGroups = compiled.nets.map(net => net.pins.map(c => [c.part.id, c.pin.number, c.ref]).sort())
        .filter(group => group.length).map(group => JSON.stringify(group)).sort();
      return {
        pinNets, endpointGroups,
        ids: p.documents.flatMap(d => d.items.map(i => i.id)).sort(),
        docs: p.documents.length, undo: h.undoSteps().history.length,
      };
    }
    const p = h.project();
    const schematicProject = p => ({...p, documents: p.documents.filter(d => d.kind === "schematic")});
    const original = schematicProject(p);
    const copy = {...original, documents: Atrium.clone(original.documents), rules: original.rules && Atrium.clone(original.rules)};
    window.__schematicWorkflows = {snapshot, before: snapshot(p), original: copy, schematicProject, plan, frame};
  }, {plan, frame});
}

async function convert(page, plan, frame) {
  await snapshotNetlist(page, plan, frame);
  const {x, y, w, h} = frame;
  await zoom(page, [x, y, x + w, y + h]);
  const at = await page.evaluate(({x, y, w, h, id}) => {
    const host = AtriumNavHost, canvas = host.canvas(), rect = canvas.getBoundingClientRect();
    for (const t of [.2, .4, .6, .8, .5, .1, .9]) {
      for (const point of [[x + t * w, y], [x, y + t * h], [x + t * w, y + h], [x + w, y + t * h]]) {
        const [px, py] = host.view().worldToScreen(point);
        const screen = [rect.left + px, rect.top + py];
        if (document.elementFromPoint(...screen) === canvas && host.hit(canvas, ...screen)?.item?.id === id) return screen;
      }
    }
    return null;
  }, frame);
  assert.ok(at, "The canvas did not expose an unobstructed frame border.");
  await page.mouse.click(...at, {button: "right"});
  await page.locator('[data-menu-action="sch-convert-frame"]').click();
  const notice = page.locator("#project-scope-notice");
  await page.waitForFunction(() => {
    const n = document.querySelector("#project-scope-notice");
    return AtriumNavHost.project().documents.length > window.__schematicWorkflows.before.docs || Boolean(n && n.getBoundingClientRect().width);
  }).catch(async () => {
    throw new Error("The frame conversion did not finish. " + (await page.locator("#status").textContent()));
  });
  if (await notice.isVisible()) {
    const keep = notice.getByRole("button", {name: /^Keep/i});
    if (await keep.count()) await keep.click();
    else await notice.getByRole("button", {name: /^(Switch|Dismiss)/i}).click();
  }
  await page.waitForFunction(() => AtriumNavHost.project().documents.length === window.__schematicWorkflows.before.docs + 1);
  const after = await page.evaluate(() => {
    const h = AtriumNavHost, p = h.project(), {snapshot, before, original, schematicProject, plan, frame} = window.__schematicWorkflows;
    const parent = p.documents.find(d => d.id === plan.doc), symbol = parent.items.find(i => i.id === frame.id);
    const child = p.documents.find(d => d.id === symbol?.sheet), result = snapshot(p);
    const occurrences = ids => {
      const counts = new Map();
      for (const id of ids) counts.set(id, (counts.get(id) || 0) + 1);
      return counts;
    };
    const ids = occurrences(result.ids), previous = occurrences(before.ids);
    const compared = AtriumDiff.compare(original, schematicProject(p), {schematicNets: "compiled", ignoreAutoNetNames: false});
    const electricalChanges = compared.changes.filter(change => change.category === "connectivity").length;
    return {
      entries: symbol?.entries?.length || 0, partMoved: Boolean(child?.items.some(i => i.id === plan.item)),
      preservedIds: [...previous].every(([id, count]) => ids.get(id) === count), electricalChanges, sameNamedNetlist: JSON.stringify(result.pinNets) === JSON.stringify(before.pinNets),
      samePinGroups: JSON.stringify(result.endpointGroups) === JSON.stringify(before.endpointGroups), undoSteps: result.undo - before.undo,
    };
  });
  assert.ok(after.entries > 0 && after.partMoved && after.preservedIds, "Conversion failed to preserve objects or create the crossing interface.");
  assert.ok(after.sameNamedNetlist && after.samePinGroups, "Conversion changed the exported netlist or original pin connectivity.");
  assert.equal(after.electricalChanges, 0, "Compare found schematic connectivity changes after conversion.");
  assert.equal(after.undoSteps, 1, "Conversion took more or fewer than one Undo step.");
  await menu(page, "edit", "undo");
  assert.ok(await page.evaluate(() => {
    const {before, snapshot, plan, frame} = window.__schematicWorkflows;
    const p = AtriumNavHost.project(), after = snapshot(p);
    return JSON.stringify(after.ids) === JSON.stringify(before.ids)
      && JSON.stringify(after.pinNets) === JSON.stringify(before.pinNets)
      && p.documents.length === before.docs
      && p.documents.find(d => d.id === plan.doc)?.items.some(i => i.id === frame.id && AtriumSchObjects.isFrame(i));
  }), "Undo did not restore the frame, original objects and original netlist.");
  return {entries: after.entries, sameNamedNetlist: true, samePinGroups: true, comparedElectricalChanges: 0, oneUndo: true};
}

async function dragFrame(page, plan, frame) {
  const {x, y, w, h} = frame;
  const read = () => page.evaluate(({part, id}) => {
    const d = AtriumNavHost.doc(), f = d.items.find(i => i.id === id), p = d.items.find(i => i.id === part);
    return [f.x, f.y, p.x, p.y];
  }, {part: plan.item, id: frame.id});
  const base = await read();
  const modifier = process.platform === "darwin" ? "Meta" : "Control";
  for (const frameOnly of [false, true]) {
    await page.evaluate(() => { AtriumNavHost.select([]); AtriumNavHost.setTool("select"); });
    await zoom(page, [x, y, x + w, y + h]);
    const start = await screen(page, [x, y + h * .32]);
    const end = await screen(page, [x + 5, y + h * .32 + 4]);
    if (frameOnly) await page.keyboard.down(modifier);
    try {
      await page.mouse.move(...start);
      await page.mouse.down();
      await page.mouse.move(...end, {steps: 4});
      await page.mouse.up();
    } finally { if (frameOnly) await page.keyboard.up(modifier); }
    const actual = await read(), [dx, dy, px, py] = actual.map((v, i) => v - base[i]);
    assert.ok(Math.abs(dx) > 1 && Math.abs(dy) > 1, "Dragging the frame did not translate it.");
    assert.ok(Math.abs(px - (frameOnly ? 0 : dx)) < 0.0001 && Math.abs(py - (frameOnly ? 0 : dy)) < 0.0001,
      "Frame movement did not respect the contents modifier.");
    await menu(page, "edit", "undo");
    assert.deepEqual(await read(), base);
  }
  return {movesContents: true, modifierMovesFrameOnly: true};
}

module.exports = {chooseFrame, placeFrame, convert, dragFrame};
