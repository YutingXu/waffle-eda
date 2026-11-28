"use strict";
// Run directly with Node and playwright-core. Set ATRIUM_ROUTING_SHOTS to capture the synthetic PCB.
const assert = require("node:assert/strict"), path = require("node:path"), fs = require("node:fs/promises");
const {pathToFileURL} = require("node:url");
const serveApp = require("../support/browser-app-server.cjs");

async function routeSuggestionWorker(browser) {
  const app = await serveApp();
  const page = await browser.newPage({viewport:{width:1120,height:720}});
  const errors = [];
  page.on("pageerror", error => errors.push(error.message));
  page.setDefaultTimeout(6000);
  try {
    await page.clock.install();
    await page.goto(app.url);
    await page.locator("dialog.sp-dialog[open] [data-start-action=demo]").click();
    await page.evaluate(async () => {
      await AtriumLazy.need(["AtriumRules", "AtriumDesignQuery"]);
      const host = AtriumNavHost, project = host.project();
      await host.selectDocument(project.documents.find(doc => doc.kind === "pcb").id);
      AtriumPower.setMode("off");
      AtriumPrefs.set("routing.suggest", false);
      AtriumPrefs.set("routing.suggestOn", "hover");
      const board = host.doc();
      host.edit(() => {
        board.outline = [[0, 0], [24, 0], [24, 14], [0, 14]];
        board.items = [4, 20].map((x, i) => ({id:`suggestion-pad-${i}`, kind:"pad", number:"1", x, y:7,
          net:"Worker scope", layer:"Top", shape:"round", w:1, h:1, drill:0}));
        const rules = AtriumRules.create(), width = rules.list.find(rule => rule.type === "width");
        width.priority = 2;
        rules.list.push({...width, id:"suggestion-width", name:"Worker scope width", priority:1,
          scope:AtriumDesignQueryRecord.selector("net", "Worker scope"), min:.38, preferred:.38, max:.38});
        AtriumRules.store(board, project, rules);
      });
      host.view().fit(board, host.defs(), "board");
      host.redraw();
    });
    const route = page.locator('details[data-menu="route"]');
    const menu = async action => {
      await route.locator(":scope > summary").click();
      await route.locator(`[data-action="${action}"]:visible`).click();
    };
    await menu("route");
    await page.waitForFunction(() => AtriumNavHost.tool() === "route" && globalThis.AtriumRouteSuggest?._state.installed);
    const disabled = await page.evaluate(() => AtriumRouteSuggest.debug());
    assert.equal(disabled.worker, "none", "arming the tool creates no idle worker");
    const hover = async () => {
      const point = await page.evaluate(() => {
        const host = AtriumNavHost, box = host.canvas().getBoundingClientRect();
        const wire = host.connections().airwires.find(wire => wire.net === "Worker scope");
        const middle = wire.from.map((coordinate, i) => (coordinate + wire.to[i]) / 2);
        const [x, y] = host.view().worldToScreen(middle);
        return [box.left + x, box.top + y];
      });
      await page.mouse.move(...point);
    };
    await hover();
    await page.clock.runFor(80); // Hold over a real connection past the suggestion debounce.
    assert.deepEqual(await page.evaluate(() => {
      const {worker, last, visible} = AtriumRouteSuggest.debug();
      return {worker, last, visible};
    }), {worker:"none", last:null, visible:false}, "disabled suggestions leave the worker dormant");

    await menu("route-suggest-toggle");
    assert.equal(await page.evaluate(() => AtriumPrefs.get("routing.suggest")), true);
    await hover();
    await page.waitForFunction(() => {
      const result = AtriumRouteSuggest.debug();
      return result.worker === "ready" && result.latency.n > 0 && result.query?.net === "Worker scope";
    });
    const first = await page.evaluate(() => AtriumRouteSuggest.current());
    assert.ok(first.legs.length > 0);
    assert.ok(first.legs.every(leg => Math.abs(leg.width - .38) < 1e-7), "the worker honors the native net-scoped width rule");
    assert.deepEqual(errors, []);
    console.log("PASS Route Suggestions worker paints a scoped ghost on demand and stays dormant when disabled");
  } finally {
    await page.close();
    await app.close();
  }
}

module.exports = async function routingPolish(browser, {audit} = {}) {
  await routeSuggestionWorker(browser);
  for (const theme of ["light", "dark"]) {
    const page = await browser.newPage({viewport: {width: 1320, height: 868}, colorScheme: theme, reducedMotion: "reduce"});
    await page.addInitScript(() => { globalThis.ATRIUM_UNDO_VERIFY = "throw"; });
    const errors = [];
    page.on("pageerror", e => errors.push(e.message));
    let routingLoads = 0;
    page.on("request", r => {if (r.url().endsWith("/route-feel.js")) routingLoads++;});
    page.setDefaultTimeout(6000);
    const canvas = page.locator("#canvas");
    const shot = async name => {
      if (!process.env.ATRIUM_ROUTING_SHOTS) return;
      await page.evaluate(async () => { await document.fonts.ready; await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r))); });
      await page.screenshot({path: path.join(process.env.ATRIUM_ROUTING_SHOTS, "routing-polish-" + name + "-" + theme + ".png"), animations: "disabled"});
    };
    const menu = async (name, action) => {
      const m = page.locator('details[data-menu="' + name + '"]');
      await m.locator(":scope > summary").click();
      await m.locator('[data-action="' + action + '"]:visible').click();
    };
    const world = p => page.evaluate(p => {
      const h = AtriumNavHost, b = h.canvas().getBoundingClientRect(), xy = h.view().worldToScreen(p);
      return [b.left + xy[0], b.top + xy[1]];
    }, p);
    const put = async (p, click = false) => { const xy = await world(p); await page.mouse.move(...xy); if (click) await page.mouse.click(...xy); };
    const settle = () => page.evaluate(() => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r))));
    const prefs = async () => {
      await menu("file", "preferences");
      const d = page.locator(".prf-dialog[open]");
      await d.getByRole("button", {name: "Routing", exact: true}).click(); return d;
    };
    const setJitter = async (dialog, tolerance) => {
      const field = dialog.getByLabel("Walkaround jitter tolerance", {exact:true});
      await field.focus();
      await field.press("ControlOrMeta+a");
      await page.keyboard.insertText(String(tolerance));
      await field.press("Tab");
    };
    const closePrefs = async (dialog, keyboard = false) => {
      const close = dialog.getByRole("button", {name:"Close Preferences", exact:true});
      if (keyboard) await close.press("Enter");
      else await close.click();
      await dialog.waitFor({state:"hidden"});
    };
    async function findRoutingPreferences() {
      const centre = {press: async () => {await page.locator("#canvas").focus(); await page.keyboard.press("/");}}; // the palette with no filter
      const palette = page.getByRole("dialog", {name:"Command palette", exact:true})
        .getByRole("combobox");
      const dialog = page.getByRole("dialog", {name:"Preferences", exact:true});
      const labels = ["Starting corner style", "Neck down at pads", "Walkaround jitter tolerance", "Space cycles corner style",
        "Pad entry", "Name the snap target", "Corner style at the head", "Re-route attached tracks while dragging parts",
        "Live re-route limit", "Re-route depth"];
      for (const label of labels) {
        await centre.press("Enter");
        await palette.fill(label);
        const option = page.getByRole("option", {name:new RegExp("^" + label + " Preferences › Routing")}).first();
        const id = await option.getAttribute("id");
        for (let i = 0; i < 50 && (await palette.getAttribute("aria-activedescendant")) !== id; i++) await page.keyboard.press("ArrowDown");
        assert.equal(await palette.getAttribute("aria-activedescendant"), id, "search reaches " + label);
        await page.keyboard.press("Enter");
        const field = dialog.getByLabel(label, {exact:true});
        await field.waitFor();
        assert.ok(await field.evaluate(n => n === document.activeElement), "search opens and focuses " + label);
        await closePrefs(dialog, true);
      }
    }
    try {
      await page.goto(pathToFileURL(path.join(__dirname, "../../app/index.html")).href);
      await page.locator("dialog.sp-dialog[open] [data-start-action=demo]").click();
      await page.locator("#doc-name").filter({hasText: "Sensor board"}).waitFor();
      await page.evaluate(async theme => {
        await AtriumLazy.need(["AtriumLength", "AtriumPrefs", "AtriumCamera"]);
        const h = AtriumNavHost, project = h.project();
        h.selectDocument(project.documents.find(d => d.kind === "pcb").id);
        const board = h.doc();
        AtriumTheme.set({preset: theme, followSystem: false}, {persist: false});
        h.edit(() => {
          board.name = "Timing coupon"; project.name = "Routing study";
          board.grid = .1; board.outline = [[-3, -4], [37, -4], [37, 15], [-3, 15]];
          const pad = (id, net, x, y, w = .5, ht = w) => ({id, kind: "pad", number: id, net, x, y, w, h: ht, angle: 0, shape: "rect", layer: "Top", drill: 0});
          const row = (net, y, len, die = 0) => [{id: net, kind: "track", layer: "Top", net, width: .15, points: [[0, y], [len, y]]},
            {...pad(net + "-a", net, 0, y, .23), packageLength: 0, pinDelay: die}, pad(net + "-b", net, len, y, .23)];
          const legend = (text, x, y) => ({id: "legend-" + text, kind: "label", layer: "Silk", text, x, y, size: .7});
          board.items = [...row("DATA0", 2, 27), ...row("CLK_P", 6.6, 30, 6), ...row("CLK_N", 7, 30), ...row("REF", 10, 34),
            legend("DATA0", 0, 1.25), legend("CLK +/-", 0, 5.9), legend("REF", 0, 9.3), pad("neck-start", "ENTRY", 33, 4, .8),
            ...Array.from({length: 5}, (_, k) => pad("end-" + k, k === 2 ? "ENTRY" : "PIN" + k, 33 + (k - 2) * .4, -2, .2, .8))];
          board.lengthTuning = {version: 1, targets: {}, groups: [{name: "Sampling clock", members: ["CLK_P", "CLK_N", "REF"], basis: "delay", delayTolerance: .1, pairDelayTolerance: .1},
            {name: "Constrained bus", members: ["CLK_P", "REF"], target: 33, tolerance: .02}]};
          const set = AtriumRules.create();
          const width = set.list.find(r => r.type === "width"); Object.assign(width, {min: .2, preferred: .35, max: 1});
          Object.assign(set.list.find(r => r.type === "clearance"), {gap: .15});
          Object.assign(set.list.find(r => r.type === "diffPairsRouting"), {widthMin: .15, widthPreferred: .15, gapMin: .25, gapPreferred: .25, maxUncoupled: 20});
          set.diffPairs = [{name: "CLK", positive: "CLK_P", negative: "CLK_N"}]; AtriumRules.store(board, project, set);
        });
        h.select([]); h.view().fit(board, h.defs(), "board"); h.redraw();
      }, theme);
      const primary = await page.evaluate(theme => {
        AtriumPower.setMode(theme === "light" ? "always" : "off");
        AtriumKeymap.setBindings("diffpair-retrace", ["Mod+Alt+G"]);
        return AtriumKeymap.mac ? "Meta" : "Control";
      }, theme);
      assert.equal(routingLoads, 0, "reading the board leaves the routing UI unloaded");
      await canvas.focus();
      await page.keyboard.press(primary + "+Alt+g");
      await page.waitForFunction(() => AtriumNavHost.tool() === "pick-point");
      if (theme === "light") {
        await put([10, 6.6], true);
        await page.getByRole("dialog", {name: /^Retrace gap/}).waitFor();
      }
      await page.keyboard.press("Escape");
      await page.waitForFunction(() => AtriumNavHost.tool() === "select");
      await page.evaluate(() => {
        AtriumKeymap.resetCommand("diffpair-retrace");
        AtriumNavHost.select(["CLK_P", "CLK_N"]);
      });
      const routeMenu = page.locator('details[data-menu="route"]');
      await routeMenu.locator(":scope > summary").click();
      await routeMenu.locator("#sub-route-pairs > .submenu-trigger").click();
      await routeMenu.getByRole("menuitem", {name: "Retrace Differential Pair…", exact: true}).click();
      await page.getByRole("dialog", {name: /^Retrace gap/}).getByRole("textbox").fill("invalid gap");
      await page.keyboard.press("Enter");
      await page.waitForFunction(() => document.querySelector("#status").textContent.startsWith("Enter min"));
      const warm = await page.evaluate(() => {
        const h = AtriumNavHost, receipt = [], items = () => JSON.stringify(h.doc().items);
        h.act("diffpair-gloss"); receipt.push(document.querySelector("#status").textContent);
        const original = items(), count = h.doc().items.length;
        for (const action of ["route-tabs", "route-tabs-trapezoid"]) {
          h.select(["DATA0", "REF"]);
          h.act(action);
          receipt.push(h.doc().items.length > count);
          h.act("undo");
          receipt.push(items() === original);
        }
        h.select([]); AtriumPower.setMode("auto");
        return receipt;
      });
      assert.match(warm[0], /smooth/i);
      assert.deepEqual(warm.slice(1), [true, true, true, true], "warm T and trapezoid tabs apply synchronously and each undo restores the board");
      assert.equal(routingLoads, 1);
      await findRoutingPreferences();
      let d = await prefs();
      if (audit) await audit(page, theme + " Routing Preferences");
      assert.equal(await d.getByRole("banner").count(), 0);
      assert.ok(await d.getByRole("heading", {name: "Preferences"}).isVisible());
      await d.getByLabel("Starting corner style", {exact:true}).selectOption("90");
      await d.getByLabel("Neck down at pads", {exact:true}).uncheck();
      await setJitter(d, 0);
      await closePrefs(d);
      const routeToPad = async enabled => {
        await menu("route", "route"); await put([33, 4], true); await put([33, -2]);
        await page.waitForFunction(() => !!AtriumNavHost.routeSessionNow() && !!AtriumNavHost.liveRoute()?.preview);
        await settle();
        const r = await page.evaluate(() => {
          const h = AtriumNavHost, p = h.liveRoute().preview;
          return {corner: h.routeSessionNow().state.corner, reached: p.reached, neck: p.preview.find(x => x.neck)?.width};
        });
        assert.equal(r.corner, "90", "the chosen corner starts the route"); assert.equal(r.reached, enabled, JSON.stringify(r));
        assert.equal(r.neck, enabled ? .2 : undefined);
        await page.keyboard.press("Escape"); await page.keyboard.press("Escape"); await canvas.focus();
      };
      await routeToPad(false);
      d = await prefs(); await d.getByLabel("Neck down at pads", {exact:true}).check(); await closePrefs(d);
      await routeToPad(true);
      // A fixed starting corner can still be cycled before or after placing the first anchor.
      await menu("route", "route"); await canvas.focus(); await page.keyboard.press("Shift+Space");
      await put([33, 4], true); await settle();
      assert.equal(await page.evaluate(() => AtriumNavHost.routeSessionNow().state.corner), "90arc");
      await page.keyboard.press("Shift+Space");
      assert.equal(await page.evaluate(() => AtriumNavHost.routeSessionNow().state.corner), "any");
      await page.keyboard.press("Escape"); await page.keyboard.press("Escape");
      d = await prefs();
      await d.getByLabel("Starting corner style", {exact:true}).selectOption("45arc"); await d.getByLabel("Neck down at pads", {exact:true}).check();
      await setJitter(d, 150);
      await shot("preferences"); await d.getByRole("button", {name: "Close Preferences", exact:true}).click();
      const values = await page.evaluate(() => JSON.parse(localStorage.getItem("atrium.prefs")).values);
      assert.equal(values["routing.cornerStyle"], "45arc"); assert.equal(values["routing.jitterTolerance"], 150);

      await page.evaluate(() => {
        const h = AtriumNavHost, v = h.view(), c = h.canvas();
        v.zoom(1.55);
        const [x, y] = v.worldToScreen([13, 4.8]); v.pan(c.clientWidth / 2 - x, c.clientHeight / 2 - y); h.redraw();
      });
      // Open the real tuning tool, move over copper and change the live pattern with Tab.
      await menu("route", "length-tune"); await put([4, 2], true); await put([19, 4.8]); await settle();
      const configure = async (pattern, amp, miter) => {
        await canvas.focus(); await page.keyboard.press("Tab");
        const p = page.getByRole("dialog", {name: "Length tuning properties"});
        await p.getByLabel("Pattern", {exact: true}).selectOption(pattern);
        if (audit && pattern === "accordion") await audit(page, theme + " live Length tuning properties");
        await p.getByLabel("Target length (mm)").fill("36");
        await p.getByLabel("Tolerance (mm)").fill("0.02");
        await p.getByLabel("Amplitude (mm)").fill(amp); await p.getByLabel("Gap (mm)").fill("1.15");
        await p.getByLabel("Miter (%)").fill(miter);
        if (pattern === "accordion") await p.getByLabel("Sides").selectOption("2");
        await p.getByRole("button", {name: "Apply"}).click(); await put([19, 4.8]); await settle();
        assert.ok(await canvas.evaluate(c => c === document.activeElement), "Tab properties return focus to the board");
      };
      await configure("trombone", "2", "50");
      let gauge = await page.evaluate(() => AtriumNavHost.liveTune().overlay.gauge);
      assert.equal(gauge.style, "Trombone"); assert.ok(gauge.length < 32 && gauge.status === "short");
      await shot("trombone");
      await configure("accordion", "1.05", "75");
      gauge = await page.evaluate(() => AtriumNavHost.liveTune().overlay.gauge);
      assert.equal(gauge.status, "within"); assert.equal(gauge.style, "Accordion");
      await shot("accordion"); await put([19, 4.8], true); await page.keyboard.press("Escape");
      assert.ok(await page.evaluate(() => Math.abs(AtriumLength.netLength(AtriumNavHost.doc(), AtriumNavHost.defs(), "DATA0").length - 36) < .02));

      // Match the time group in one click, then check that one Undo restores every leg.
      const before = await page.evaluate(() => JSON.stringify(AtriumNavHost.doc().items.filter(i => ["CLK_P", "CLK_N"].includes(i.id))));
      await menu("route", "length");
      const manager = page.getByRole("dialog", {name: "Length tuning", exact: true});
      await manager.getByRole("searchbox").fill("Sampling clock");
      let group = manager.locator(".length-group").filter({hasText: "Sampling clock"});
      assert.ok(await group.locator('tr[data-status="short"]').count() >= 2);
      await manager.getByLabel("Pattern style").selectOption("accordion");
      await manager.getByLabel("Miter (%)").fill("65"); await group.getByRole("button", {name: "Tune group"}).click();
      group = manager.locator(".length-group").filter({hasText: "Sampling clock"});
      assert.equal(await group.locator('tr[data-status="pass"]').count(), 3);
      assert.ok(await group.getByRole("button", {name: "Tune group"}).evaluate(b => b === document.activeElement));
      assert.ok(await group.getByRole("columnheader", {name: "Δ target (ps)"}).isVisible());
      if (audit) await audit(page, theme + " tuned Length Manager");
      assert.equal(await group.getByRole("columnheader", {name: "Locate", exact: true}).count(), 1);
      await shot("group"); await page.keyboard.press("Escape");
      const serialize = () => page.evaluate(() => JSON.stringify(AtriumNavHost.doc().items));
      const applied = await serialize();
      await menu("edit", "undo");
      assert.equal(await page.evaluate(() => JSON.stringify(AtriumNavHost.doc().items.filter(i => ["CLK_P", "CLK_N"].includes(i.id)))), before);
      const restored = await serialize();
      await menu("route", "length");
      await manager.getByRole("searchbox").fill("Constrained bus");
      group = manager.locator(".length-group").filter({hasText: "Constrained bus"});
      assert.equal(await group.locator('tr[data-status="short"]').count(), 1);
      assert.equal(await group.locator('tr[data-status="long"]').count(), 1);
      await group.getByRole("button", {name: "Tune group"}).click();
      assert.ok(await manager.locator(".length-report").getByText("Group unchanged.", {exact: false}).isVisible());
      assert.equal(await serialize(), restored);
      await page.keyboard.press("Escape"); await menu("edit", "redo");
      assert.equal(await serialize(), applied);
      // A three-via coupon reproduces a diagonal jog from the dense-board cursor sweep.
      await page.evaluate(() => {
        const h = AtriumNavHost, board = h.doc(), project = h.project();
        h.edit(() => {
          const via = (id, net, x, y) => ({id, net, kind: "via", x, y, diameter: .6, drill: .3, layer: "Multi"});
          board.name = "Breakout coupon"; board.grid = .01; board.outline = [[3, 0], [12.6, 0], [12.6, 8.4], [3, 8.4]];
          board.items = [via("start", "CLOCK", 9, 2), via("a", "A", 6.94, 3.72), via("b", "B", 7.14, 5.13)];
          board.lengthTuning = {version: 1, targets: {}, groups: []};
          const rules = AtriumRules.create();
          Object.assign(rules.list.find(r => r.type === "width"), {min: .25, preferred: .25, max: .25});
          Object.assign(rules.list.find(r => r.type === "clearance"), {gap: .2});
          AtriumRules.store(board, project, rules);
        });
        h.select([]); h.view().fit(board, h.defs(), "board"); h.redraw();
      });
      d = await prefs(); await d.getByLabel("Starting corner style", {exact:true}).selectOption("45");
      await setJitter(d, 100); await closePrefs(d);
      await menu("route", "route"); await put([9, 2], true); await put([6.61, 6.4]); await settle();
      const trace = await page.evaluate(() => {
        const head = AtriumNavHost.liveRoute().preview;
        return {status: head.status, points: head.preview.find(x => x.head).points};
      });
      assert.equal(trace.status, "ok"); assert.ok(trace.points.length >= 4 && trace.points.length < 8);
      const dirs = trace.points.slice(1).map((p, i) => (8 + Math.round(Math.atan2(p[1] - trace.points[i][1], p[0] - trace.points[i][0]) * 4 / Math.PI)) % 8);
      for (let i = 1; i < dirs.length - 1; i++) assert.ok(!(dirs[i - 1] % 2 && dirs[i - 1] === dirs[i + 1]), "parallel diagonal jog on live head");
      await shot("gloss"); await put([6.61, 6.4], true); await page.keyboard.press("Escape");
      assert.ok(await page.evaluate(() => AtriumNavHost.doc().items.some(i => i.kind === "track" && i.net === "CLOCK" && i.points.length >= 4)));
      await page.keyboard.press("Escape");
      await page.evaluate(() => {
        const h = AtriumNavHost, board = h.doc();
        h.edit(() => {
          board.grid = .01; board.outline = [[-2, -3.5], [12, -3.5], [12, 3.5], [-2, 3.5]];
          board.items = [{id: "source", kind: "pad", number: "1", net: "CLOCK", x: 0, y: 0, w: .3, h: .3, layer: "Top", shape: "round"},
            {id: "block", kind: "via", net: "OTHER", x: 5, y: 0, diameter: .6, drill: .3, layer: "Multi"}];
        });
        h.view().fit(board, h.defs(), "board"); h.redraw();
      });
      const changes = async tolerance => {
        const dialog = await prefs();
        await setJitter(dialog, tolerance); await closePrefs(dialog);
        await menu("route", "route"); await put([0, 0], true);
        let previous = 0, count = 0;
        for (let i = 0; i < 14; i++) {
          await put([8 + i / 30, i % 2 ? .05 : -.05]); await settle();
          const side = await page.evaluate(() => {
            const pts = AtriumNavHost.liveRoute().preview.preview.find(x => x.head).points;
            let area = 0;
            for (let j = 1; j < pts.length; j++) area += pts[j - 1][0] * pts[j][1] - pts[j][0] * pts[j - 1][1];
            return Math.sign(area);
          });
          if (side && previous && side !== previous) count++;
          if (side) previous = side;
        }
        await page.keyboard.press("Escape"); await page.keyboard.press("Escape"); return count;
      };
      assert.equal(await changes(100), 0); assert.ok(await changes(0) >= 10);
      await require("./browser-routing-sessions.js")(page);
      if (theme === "light") {
        await page.evaluate(() => AtriumI18n.setLocale("en-XA"));
        await menu("route", "length");
        await page.waitForFunction(() => {
          const option = document.querySelector('.length-tools option[value="accordion"]');
          return option && option.textContent !== "Accordion";
        });
        const pattern = page.locator(".length-tools select").first();
        assert.equal(await pattern.inputValue(), "accordion");
        assert.notEqual(await pattern.getAttribute("aria-label"), "Pattern style");
      }
      assert.deepEqual(errors, []);
      console.log("PASS routing preferences, live trombone/accordion, one-click delay match, rejected group, Undo/Redo and live diagonal gloss (" + theme + ")");
    } catch (error) {
      console.error(await page.evaluate(() => ({status: document.querySelector("#status")?.textContent, tool: AtriumNavHost.tool(), live: AtriumNavHost.liveTune()?.net, dialogs: [...document.querySelectorAll("dialog[open]")].map(d => d.getAttribute("aria-label")), route: AtriumNavHost.routeSessionNow()?.state, focus: document.activeElement?.id})));
      throw error;
    } finally { await page.close(); }
  }
};

if (require.main === module) (async () => {
  if (process.env.ATRIUM_ROUTING_SHOTS) await fs.mkdir(process.env.ATRIUM_ROUTING_SHOTS, {recursive: true});
  const {chromium} = require("../support/playwright.cjs");
  const browser = await chromium.launch({headless: true, ...(process.env.CHROME ? {executablePath: process.env.CHROME} : {channel: "chrome"})});
  try { await module.exports(browser); } finally { await browser.close(); }
})().catch(e => { console.error(e); process.exitCode = 1; });
