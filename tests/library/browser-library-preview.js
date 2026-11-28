"use strict";

const assert = require("node:assert/strict"), path = require("node:path");

module.exports = async function libraryPreview(browser) {
  const page = await browser.newPage({viewport: {width: 1200, height: 900}}), errors = [];
  page.on("pageerror", e => errors.push(e.message));
  try {
    await page.setContent('<main id="properties"></main><dialog><input id="library-search"><div id="library-list"></div></dialog>' +
      '<style>#library-list,.lib-list{max-height:400px;overflow:auto}.cat-pv-pics canvas{width:90px;height:58px}</style>');
    for (const file of [
      "core/uuid-v7.js", "core/model.js", "library/parts.js", "library/component-families.js", "library/library-pairing.js", "pcb/pcb-appearance.js",
      "canvas/canvas.js", "library/catalogue.js", "editor/keymap.js", "ui/dialog.js", "ui/kit.js", "editor/nav-common.js", "history/undo-store.js",
      "library/library-ui.js", "library/library-panel.js",
    ]) {
      await page.addScriptTag({path: path.join(__dirname, "../../app", file)});
    }
    await page.evaluate(() => {
      const A = Atrium, C = AtriumCatalogue, F = AtriumComponentFamilies, U = AtriumUndoStore;
      const original = A.project("First", []), template = AtriumParts.catalogue.find(d => d.id === "std-r");
      for (let f = 0; f < 3; f++) {
        const members = [];
        for (let n = 0; n < 12; n++) for (let k = 0; k < 2; k++) {
          const d = A.clone(template);
          d.id = [f, n, k].join("-"); d.name = "Device " + n;
          d.footprint.name = "Package " + k; d.footprint.pads[0].w = 0.4 + (f + n + k) / 10;
          original.library.push(d); members.push({defId: d.id, part: "Chip " + n});
        }
        F.create(original, "Family " + f, members);
      }
      let project = original, revision = 0;
      const H = [], future = [], signals = new Map();
      globalThis.AtriumNavHost = {on(type, fn) { signals.set(type, fn); return () => signals.delete(type); }};
      const ctx = {currentProject: () => project, documentKind: () => "schematic", revision: () => revision, selection: () => [],
        edit(fn) { const mark = U.mark(project, {}); fn(); U.checkpoint(H, future, mark); U.touch(project); revision++; signals.get("change")?.(); }};
      const real = AtriumCanvas.preview, calls = [], frame = window.requestAnimationFrame.bind(window), cancel = window.cancelAnimationFrame.bind(window);
      const held = new Map();
      let holding = false, serial = -1, cancelled = 0;
      window.requestAnimationFrame = fn => { if (!holding) return frame(fn); const id = serial--; held.set(id, fn); return id; };
      window.cancelAnimationFrame = id => { if (held.delete(id)) cancelled++; else cancel(id); };
      AtriumCanvas.preview = (c, d, k) => { calls.push([d.id, k]); return real(c, d, k); };
      const panel = AtriumLibrary.togglePanel(ctx, true), dialog = document.querySelector("dialog"), list = document.querySelector("#library-list");
      const wait = () => new Promise(r => frame(() => frame(r)));
      const choice = (host, id) => host.querySelector('[data-def="' + id + '"]');
      const probe = {
        filter(q) { panel.search.value = q; panel.search.dispatchEvent(new Event("input")); },
        pickDock(id) { choice(panel.node.querySelector(".lib-list"), id).click(); },
        pickDialog(id) { choice(list, id).focus(); },
        renderPicker(q = "Family") { C.render(list, {owner: project, pool: project.library, query: q, key: "dialog", target: "schematic"}); },
        openPicker() { dialog.showModal(); this.renderPicker(); },
        async take() { await wait(); return calls.splice(0); },
        pending() { return {frames: held.size, cancelled}; },
        hold() { holding = true; cancelled = 0; },
        release() { holding = false; const jobs = [...held.values()]; held.clear(); jobs.forEach(fn => fn(performance.now())); },
        checkFresh(id, surface) {
          const def = project.library.find(d => d.id === id), host = surface === "dock" ? panel.node.querySelector(".lib-detail") : dialog;
          const found = host.querySelector(".cat-pv");
          if (found?.dataset.def !== id) return false;
          return [...found.querySelectorAll("figure canvas")].every(c => {
            const fresh = document.createElement("canvas");
            fresh.style.width = c.clientWidth + "px"; fresh.style.height = c.clientHeight + "px";
            document.body.append(fresh);
            try { real(fresh, def, c.dataset.kind); return fresh.toDataURL() === c.toDataURL(); }
            finally { fresh.remove(); }
          });
        },
        hideDock() { panel.node.querySelector(".lib-panel-close").click(); },
        showDock() { AtriumLibrary.togglePanel(ctx, true); },
        changeWidth(id, w) { ctx.edit(() => { project.library.find(d => d.id === id).footprint.pads[0].w = w; }); },
        undo() { U.jump(H, future, U.mark(project, {}), -1); U.touch(project); revision++; signals.get("change")?.(); },
        newProject() {
          project = A.clone(project); project.name = "Another project";
          project.library.find(d => d.id === "0-0-1").footprint.pads[0].w = 4;
          revision++; signals.get("change")?.();
        }
      };
      globalThis.previewTest = probe;
    });
    const take = () => page.evaluate(() => previewTest.take());
    const pair = id => [[id, "schematic"], [id, "pcb"]];
    const dock = page.locator(".panel-library"), picker = page.locator("dialog");
    await page.evaluate(() => previewTest.filter("Family"));
    assert.equal(await dock.locator(".cat-family-packages .lib-row").count(), 72);
    assert.equal(await dock.locator(".lib-row .ui-row-icons use").count(), 144);
    assert.deepEqual(await take(), []);
    await page.evaluate(() => { previewTest.pickDock("0-0-0"); previewTest.pickDock("0-0-1"); });
    assert.deepEqual(await take(), pair("0-0-1"));
    assert.ok(await page.evaluate(() => previewTest.checkFresh("0-0-1", "dock")));
    await dock.locator(".lib-family-head").nth(1).click();
    assert.deepEqual(await take(), []);
    await page.evaluate(() => { previewTest.hold(); previewTest.pickDock("2-2-0"); previewTest.hideDock(); });
    assert.deepEqual(await page.evaluate(() => previewTest.pending()), {frames: 0, cancelled: 1});
    await page.evaluate(() => { previewTest.release(); previewTest.changeWidth("2-2-0", 3.3); });
    assert.deepEqual(await take(), []);
    await page.evaluate(() => previewTest.showDock());
    assert.deepEqual(await take(), pair("2-2-0"));
    assert.ok(await page.evaluate(() => previewTest.checkFresh("2-2-0", "dock")));
    await page.evaluate(() => previewTest.undo());
    assert.deepEqual(await take(), pair("2-2-0"));
    assert.ok(await page.evaluate(() => previewTest.checkFresh("2-2-0", "dock")));
    await page.evaluate(() => { previewTest.hideDock(); previewTest.openPicker(); });
    assert.deepEqual(await take(), []);
    await page.evaluate(() => { previewTest.pickDialog("0-1-0"); previewTest.pickDialog("0-0-1"); });
    assert.deepEqual(await take(), pair("0-0-1"));
    assert.ok(await page.evaluate(() => previewTest.checkFresh("0-0-1", "picker")));
    await page.evaluate(() => { previewTest.hold(); previewTest.pickDialog("2-3-1"); });
    assert.equal((await page.evaluate(() => previewTest.pending())).frames, 1);
    await page.keyboard.press("Escape"); await picker.waitFor({state: "hidden"});
    assert.deepEqual(await take(), []);
    assert.deepEqual(await page.evaluate(() => previewTest.pending()), {frames: 0, cancelled: 1});
    await page.evaluate(() => { previewTest.release(); previewTest.openPicker(); previewTest.pickDialog("0-0-1"); });
    assert.deepEqual(await take(), pair("0-0-1"));
    await page.evaluate(() => { previewTest.newProject(); previewTest.renderPicker(); });
    assert.deepEqual(await take(), [], "matching IDs across projects never transfer the active preview");
    await page.evaluate(() => previewTest.pickDialog("0-0-1"));
    assert.deepEqual(await take(), pair("0-0-1"));
    assert.ok(await page.evaluate(() => previewTest.checkFresh("0-0-1", "picker")));
    await page.keyboard.press("Escape"); await picker.waitFor({state: "hidden"});
    await page.evaluate(() => previewTest.showDock());
    assert.deepEqual(await take(), [], "a hidden dock drops the old project's selection when reopened");
    await page.evaluate(() => previewTest.pickDock("0-0-1"));
    assert.deepEqual(await take(), pair("0-0-1"));
    assert.ok(await page.evaluate(() => previewTest.checkFresh("0-0-1", "dock")));
    assert.deepEqual(errors, []);
    console.log("PASS 72 exact packages: filtering, changing family and hidden views draw zero previews; rapid selection draws one matching pair");
  } finally { await page.close(); }
};
