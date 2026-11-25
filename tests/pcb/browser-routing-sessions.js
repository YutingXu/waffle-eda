"use strict";
const assert = require("node:assert/strict");
const {windowPanel} = require("../support/window-panels.cjs");

module.exports = async function routingSessions(page) {
  const canvas = page.locator("#canvas");
  const put = async (p, click = false) => {
    const xy = await page.evaluate(p => {
      const h = AtriumNavHost, b = h.canvas().getBoundingClientRect(), s = h.view().worldToScreen(p);
      return [b.left + s[0], b.top + s[1]];
    }, p);
    await page.mouse.move(...xy);
    if (click) await page.mouse.click(...xy);
  };
  const settle = () => page.evaluate(() => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r))));
  const snapshot = () => page.evaluate(() => {
    const h = AtriumNavHost, b = h.doc();
    return {
      items: JSON.stringify(b.items),
      clearance: AtriumRules.drc(b, h.defs(), AtriumRules.stored(b, h.project()), {project: h.project(), types: ["clearance"]}).violations.map(v => [v.actual, v.required]),
      airwires: AtriumConnectivity.inspect(b, h.defs()).airwires.map(a => [a.net, a.from, a.to])
    };
  });
  const undo = async (before, after) => {
    await canvas.focus();
    await page.keyboard.press("Control+z");
    assert.deepEqual(await snapshot(), before);
    await page.keyboard.press("Control+Shift+z");
    assert.deepEqual(await snapshot(), after);
  };
  await page.evaluate(async () => {
    await AtriumLazy.need(["AtriumRouter", "AtriumLength", "AtriumCamera", "AtriumAltiumKeys", "AtriumMultiRoute"]);
    const h = AtriumNavHost, board = h.doc(), project = h.project();
    h.edit(() => {
      board.grid = .05;
      board.outline = [[0, 0], [16, 0], [16, 12], [0, 12]];
      delete board.pcbDrawing;
      delete board.lengthTuning;
      const pad = (id, x, y, net) => ({id, kind: "pad", number: "1", x, y, w: .23, h: .23, drill: 0, shape: "round", layer: "Top", net});
      const ends = (net, y) => [pad(net + "-s", 3, y, net), pad(net + "-e", 12, y, net)];
      board.items = [...ends("CLK_P", 2.8), ...ends("CLK_N", 3.2), ...ends("D0", 6), ...ends("D1", 6.6), ...ends("DRAG", 10),
        {id: "track", kind: "track", net: "DRAG", layer: "Top", width: .15, points: [[3, 10], [12, 10]]}];
      const rules = AtriumRules.create();
      Object.assign(rules.list.find(r => r.type === "clearance"), {gap: .1});
      Object.assign(rules.list.find(r => r.type === "width"), {min: .15, preferred: .15, max: .5});
      Object.assign(rules.list.find(r => r.type === "diffPairsRouting"), {widthMin: .15, widthPreferred: .15, gapMin: .25, gapPreferred: .25});
      rules.diffPairs = [{name: "CLK", positive: "CLK_P", negative: "CLK_N"}];
      rules.netClasses = {DATA: ["D0", "D1"]};
      AtriumRules.store(board, project, rules);
    });
    h.select([]);
    AtriumCamera.takeCamera(h.view());
    h.view().fit(board, h.defs(), "board");
    h.redraw();
  });
  const initial = await snapshot();
  assert.deepEqual(initial.clearance, []);
  const nets = page.getByRole("grid", {name: "Nets"});
  if (!await nets.isVisible()) await windowPanel(page, "nets");
  await nets.getByText("CLK_P", {exact: true}).click();
  await nets.focus();
  await page.keyboard.press("KeyR");
  await page.waitForFunction(() => AtriumNavHost.tool() === "route-diffpair");
  await put([3, 2.8], true);
  await page.waitForFunction(() => !!AtriumNavHost.routeSessionNow()?.state.pair);
  await put([12, 2.8]);
  await settle();
  assert.equal(await page.evaluate(() => AtriumNavHost.liveRoute().preview.reached), true, "pair reaches both target pads");
  await put([12, 2.8], true);
  await page.keyboard.press("Escape");
  const paired = await snapshot();
  assert.deepEqual(paired.airwires.map(a => a[0]).sort(), ["D0", "D1"]);
  assert.deepEqual(paired.clearance, []);
  await undo(initial, paired);

  await canvas.focus();
  await page.keyboard.press("KeyP");
  await page.keyboard.press("KeyM");
  const picker = page.getByRole("dialog", {name: "Interactive bus routing"});
  await picker.getByLabel("Group").selectOption("class:DATA");
  await picker.getByRole("button", {name: "Start"}).press("Enter");
  await page.waitForFunction(() => AtriumNavHost.tool() === "pick-point");
  await put([3, 6.3], true);
  await page.waitForFunction(() => !!AtriumNavHost.routeSessionNow()?.state.bus);
  await canvas.focus();
  for (let step = 0; step < 5 && await page.evaluate(() => AtriumNavHost.routeSessionNow().state.mode !== "hug"); step++) await page.keyboard.press("Shift+KeyR");
  assert.equal(await page.evaluate(() => AtriumNavHost.routeSessionNow().state.mode), "hug");
  await put([8, 6.3]); await settle();
  assert.equal(await page.evaluate(() => AtriumNavHost.liveRoute().preview.status), "ok");
  await put([8, 6.3], true);
  await page.keyboard.press("Backspace");
  assert.equal(await page.evaluate(() => AtriumNavHost.routeSessionNow().state.anchors), 0);
  await put([9, 6.3], true);
  await page.keyboard.press("Escape");
  await page.keyboard.press("Escape");
  const bus = await snapshot();
  assert.deepEqual(bus.clearance, []);
  const tracks = JSON.parse(bus.items).filter(i => i.kind === "track" && /^D[01]$/.test(i.net));
  assert.deepEqual(tracks.map(t => t.net).sort(), ["D0", "D1"]);
  await undo(paired, bus);

  await page.evaluate(() => AtriumNavHost.select(["DRAG-s"]));
  await canvas.focus();
  await page.keyboard.press("KeyM"); await page.keyboard.press("KeyS");
  await put([3, 10], true); await put([3, 11]); await settle();
  const held = await page.evaluate(() => {
    const h = AtriumNavHost, s = h.drag()?.reroute;
    globalThis.routingDragTest = s;
    return {position: h.doc().items.find(i => i.id === "DRAG-s").y, revision: h.revision(), steps: h.undoSteps().history.length};
  });
  assert.equal(held.position, 11);
  await page.evaluate(() => AtriumNavHost.act("measure"));
  assert.deepEqual(await snapshot(), bus);
  const ended = await page.evaluate(() => {
    const h = AtriumNavHost, s = globalThis.routingDragTest, w = s.world;
    return {alive: s.alive, masked: w.dead.subarray(0, w.nPersist).some(v => v & 4), revision: h.revision(), steps: h.undoSteps().history.length};
  });
  assert.deepEqual(ended, {alive: false, masked: false, revision: held.revision, steps: held.steps});
  await page.keyboard.press("Escape");
  await page.evaluate(() => {
    const h = AtriumNavHost, board=h.doc(), project=h.project();
    h.edit(() => {
      const set=AtriumRules.effective(board,project);
      Object.assign(set.list.find(r=>r.type==="viaStyle"),{diameterMin:.35,diameterPreferred:.45,diameterMax:.55,holeMin:.3,holePreferred:.3,holeMax:.35});
      Object.assign(set.list.find(r=>r.type==="annularRing"),{min:.1});
      AtriumRules.store(board,project,set);
    });
  });
  await page.locator('.tool[data-action="via"]').click();
  await put([10,9],true);
  const legal = await page.evaluate(() => {
    const h=AtriumNavHost, b=h.doc(), v=b.items.at(-1);
    return {size:[v.diameter,v.drill],kind:v.kind,violations:AtriumRules.drc(b,h.defs(),AtriumRules.stored(b,h.project()),{project:h.project(),types:["viaStyle","holeSize","annularRing"]}).violations.filter(x=>x.id===v.id)};
  });
  assert.equal(legal.kind,"via"); assert.deepEqual(legal.size,[.5,.3]); assert.deepEqual(legal.violations,[]);
  await page.keyboard.press("Escape");
  const beforeRefusal = await page.evaluate(() => {
    const h=AtriumNavHost, b=h.doc(), project=h.project();
    h.edit(() => {const set=AtriumRules.effective(b,project);set.list.find(r=>r.type==="viaStyle").diameterMax=.45;AtriumRules.store(b,project,set);});
    return [JSON.stringify(b.items),h.undoSteps().history.length];
  });
  await page.locator('.tool[data-action="via"]').click();
  await put([11,9],true);
  assert.deepEqual(await page.evaluate(()=>[JSON.stringify(AtriumNavHost.doc().items),AtriumNavHost.undoSteps().history.length]),beforeRefusal);
  assert.match(await page.locator("#status").innerText(),/diameter and drill/);
  await page.keyboard.press("Escape");
};
