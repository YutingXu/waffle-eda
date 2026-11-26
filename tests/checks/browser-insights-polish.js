"use strict";

const assert = require("node:assert/strict");
const path = require("node:path");
const {pathToFileURL} = require("node:url");
const editor = pathToFileURL(path.join(__dirname, "../../app/index.html")).href;

async function rotatedMarkers(browser, {capture} = {}) {
  const at = [31.153, 11]; // A point on the right of the demo board, still on screen at 120°.
  const land = 3.5; // Move the Insight diamond far enough from its anchor to exercise damage culling.
  const page = await browser.newPage({viewport:{width:1440, height:960}, reducedMotion:"reduce"});
  const errors = [];
  page.on("pageerror", error => errors.push(error.message));
  page.setDefaultTimeout(7000);
  try {
    await page.goto(editor);
    await page.waitForFunction(() => globalThis.AtriumNavHost && globalThis.AtriumPrefs);
    await page.evaluate(() => AtriumPrefs.set({"labs.notebook":true, "display.renderer":"2d"}));
    await page.locator("dialog.sp-dialog[open] [data-start-action=demo]").click();
    await page.locator("#doc-name", {hasText:"Sensor board"}).waitFor();
    await page.evaluate(async ({at, land}) => {
      await AtriumLazy.need(["AtriumCamera", "AtriumCanvasInput", "AtriumDRCMarkers", "AtriumInsightsUI"]);
      // Distant batched paths can affect antialiasing. Measure only the known fixture.
      AtriumPrefs.set(Object.fromEntries(AtriumInsights.enabledChecks("pcb").map(check => ["insights.check." + check.id, false])));
      AtriumInsights.register({id:"rotation-fixture", kind:"pcb", title:"Rotation fixture", run:() => [{at, land}]});
      AtriumInsightsUI.schedule({force:true, now:true, heavy:true});
    }, {at, land});
    await page.waitForFunction(() => AtriumInsightsUI.current().some(x => x.check === "rotation-fixture"));
    const results = await page.evaluate(async ({at, land}) => {
      const h = AtriumNavHost, board = h.doc(), violation = {at, type:"width"};
      const settle = () => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      const drc = doc => AtriumDRCMarkers.renderFor(h, doc, [violation]);
      h.addRenderer(doc => doc === board ? drc(doc) : null);
      async function sample(pane, name, partial = false) {
        h.redraw(true);
        await settle();
        const {view, canvas} = pane, [doc, defs, options] = view.internals().frame();
        if (doc !== board) throw Error("Expected the demo board in the measured pane.");
        const ctx = canvas.getContext("2d");
        const dpr = canvas.width / canvas.getBoundingClientRect().width;
        const diff = (a, b) => a.reduce((n, value, i) => n + Number(value !== b[i]), 0);
        const opts = {...options, reuseBase:false, noReuse:true};
        const scale = view.scale(), hint = AtriumProblemMarks.size(scale, "pcb", "hint");
        const offset = (land + hint.r) / Math.sqrt(2);
        const marks = [
          {kind:"DRC", at, overlay:drc(doc).overlay},
          {kind:"Insight", at:[at[0] + offset, at[1] - offset], overlay:AtriumInsightsUI._render(doc).overlay}
        ].map(mark => {
          const [x, y] = view.worldToScreen(mark.at);
          const margin = Math.min(x, y, canvas.clientWidth - x, canvas.clientHeight - y);
          const read = () => ctx.getImageData(Math.round(x*dpr)-28, Math.round(y*dpr)-28, 56, 56).data;
          return {...mark, x, y, margin, read, normal:read()};
        });
        const out = [];
        for (const {kind, x, y, margin, read, normal, overlay} of marks) {
          // Keep the center outside the update, while the glyph extends across its left edge.
          const area = partial ? [Math.floor(x) + 2, Math.floor(y) - 12, Math.floor(x) + 14, Math.floor(y) + 12] : null;
          const paint = overlay => {
            const draw = {...opts, overlay};
            if (area) view.internals().paint(doc, defs, draw, area, false);
            else view.render(doc, defs, draw);
          };
          const clear = () => view.render(doc, defs, {...opts, overlay:[]});
          clear();
          const normalBase = read();
          if (partial) paint([]);
          const base = read();
          let bounds, anchorOutside;
          paint([(ctx, frame) => {
            if (partial) {
              bounds = frame.worldViewport?.(frame.area, 24);
              if (kind === "Insight") {
                const [l, t, r, b] = frame.worldViewport(frame.area, hint.screen * 2.1 + 8);
                anchorOutside = at[0] < l || at[0] > r || at[1] < t || at[1] > b;
              }
            }
            overlay(ctx, frame);
          }]);
          const actual = read();
          clear();
          paint([(ctx, frame) => {
            overlay(ctx, {...frame, worldViewport:undefined});
          }]);
          const expected = read();
          clear();
          paint([(ctx, frame) => overlay(ctx, {...frame, worldViewport:() => [-1e6, -1e6, -1e6, -1e6]})]);
          const excluded = read();
          // Compare the padded rectangle with an independent inverse projection of its four corners.
          const corners = area && [[area[0]-24,area[1]-24],[area[2]+24,area[1]-24],
            [area[2]+24,area[3]+24],[area[0]-24,area[3]+24]].map(view.screenToWorld);
          const expectedBounds = corners && [Math.min(...corners.map(p=>p[0])),Math.min(...corners.map(p=>p[1])),
            Math.max(...corners.map(p=>p[0])),Math.max(...corners.map(p=>p[1]))];
          out.push({kind, margin, ink:diff(base, expected), difference:diff(actual, expected), excluded:diff(base, excluded),
            editorInk:diff(normalBase, normal), bounds, expectedBounds, anchorOutside});
        }
        return {name, camera:view.camera(), marks:out};
      }
      const pane = () => h.panes().find(p => p.active);
      const out = [await sample(pane(), "ordinary board")];
      for (let i = 0; i < 8; i++) h.act("camera-turn-right");
      out.push(await sample(pane(), "rotated board"));
      h.act("flip-board");
      out.push(await sample(pane(), "rotated and flipped board"));
      await h.openSplit("down", board.id);
      await settle();
      const split = h.panes().find(p => !p.active && p.docId === board.id);
      if (!split) throw Error("Expected an independently rendered second board pane.");
      split.view.restoreCamera({...split.view.camera(), cx:at[0], cy:at[1], rotation:Math.PI*2/3, flipped:true});
      out.push(await sample(split, "rotated and flipped split pane"));
      out.push(await sample(split, "rotated and flipped damage strip", true));
      h.redraw(true);
      await settle();
      return out;
    }, {at, land});
    assert.equal(results[0].camera.rotation ?? 0, 0);
    for (const result of results) {
      for (const mark of result.marks) {
        const message = result.name + " " + mark.kind;
        assert.ok(mark.margin > 30, message + " keeps the fixture well inside the pane");
        assert.ok(mark.editorInk > 0, message + " paints marker ink in the normal editor frame");
        assert.ok(mark.ink > 0, message + " reference paints the marker");
        assert.equal(mark.difference, 0, message + " matches the reference without culling");
        assert.equal(mark.excluded, 0, message + " culls the marker outside the viewport");
        if (mark.expectedBounds) assert.deepEqual(mark.bounds, mark.expectedBounds, "The damage viewport includes 24 CSS pixels before inversion");
        if (mark.kind === "Insight" && mark.expectedBounds) assert.equal(mark.anchorOutside, true, "The shifted diamond reaches the damage strip when its anchor does not");
      }
    }
    for (const result of results.slice(1)) assert.ok(Math.abs(result.camera.rotation - 2*Math.PI/3) < 1e-10);
    for (const result of results.slice(2)) assert.equal(result.camera.flipped, true);
    assert.deepEqual(errors, []);
    if (capture) await capture(page, "rotated-flipped-split-markers", results);
    console.log("PASS browser overlays: 0° and 120° PCB markers, flipped cameras, split panes and padded damage");
  } finally { await page.close(); }
}

async function groupedMarkers(browser) {
  const page = await browser.newPage({viewport:{width:1440, height:960}, reducedMotion:"reduce"});
  const errors = [];
  page.on("pageerror", error => errors.push(error.message));
  page.setDefaultTimeout(8000);
  try {
    await page.goto(editor);
    await page.locator("dialog.sp-dialog[open] [data-start-action=demo]").click();
    await page.locator("#doc-name", {hasText:"Sensor board"}).waitFor();
    await page.evaluate(async () => {
      await AtriumLazy.need(["AtriumInsightsUI", "AtriumDRCMarkers"]);
      AtriumDRCMarkers.setVisible(false, AtriumNavHost);
      AtriumPrefs.set(Object.fromEntries(AtriumInsights.enabledChecks("pcb").map(c => ["insights.check." + c.id, false])));
      const tracks = AtriumNavHost.doc().items.filter(x => x.kind === "track" && x.net);
      for (const [i, [id, title, severity, x]] of [
        ["band-advice", "Board advice", "advice", 10],
        ["band-tip", "First grouped tip", "tip", 31],
        ["band-other", "Second grouped tip", "tip", 52]
      ].entries()) AtriumInsights.register({id, kind:"pcb", title, severity,
        run:() => [{at:[x,10], objects:[tracks[i].id], net:id, message:title + " detail"}]});
      AtriumInsightsUI.schedule({force:true, now:true, heavy:true});
    });
    await page.waitForFunction(() => AtriumInsightsUI.current().filter(x => x.check.startsWith("band-")).length === 3);
    const result = await page.evaluate(() => {
      const h = AtriumNavHost, pane = h.panes().find(p => p.active), view = pane.view, d = h.doc();
      const b = pane.canvas.getBoundingClientRect(), P = AtriumProblemMarks, I = AtriumInsightsUI;
      const point = (x, y = 10) => view.worldToScreen([x,y]);
      const hit = x => {
        const [px,py] = point(x);
        const g = I.groupAt(pane, b.left + px, b.top + py);
        return g && {at:g.at, winner:g.rep.check, members:g.members.map(x => x.check)};
      };
      const place = (x, scale = 1) => view.restoreCamera({...view.camera(),cx:x,cy:10,scale,referenceScale:scale});
      place(b.width/2);
      const fit = hit(10), unpainted = hit(31);
      const surface = document.createElement("canvas");
      surface.width = Math.ceil(b.width); surface.height = Math.ceil(b.height);
      const ctx = surface.getContext("2d"), [ox,oy] = point(0,0);
      ctx.setTransform(1,0,0,1,ox,oy);
      const paint = I._render(d).overlay;
      paint(ctx, P.paneFrame(pane, b));
      const painted = [10,31,52].filter(x => {
        const [sx,sy] = point(x).map(Math.floor);
        return ctx.getImageData(sx,sy,1,1).data[3] > 0;
      }).map(x => [x,10]);
      place(b.width/2 + 15);
      const cut = hit(31);
      const damage = paint.panDamage?.(P.paneFrame(pane,b), -15, 0) || [];
      const repaired = [10,31].map(x => {
        const [px,py] = point(x);
        return damage.some(([l,t,r,bottom]) => px>l && px<r && py>t && py<bottom);
      });
      const cellBuilds = [], bandWinners = [];
      globalThis.AtriumProblemMarks = {...P, cells(list, atOf, scale, cell, rank) {
        if (list[0]?.check?.startsWith("band-")) cellBuilds.push(cell);
        return P.cells(list, atOf, scale, cell, rank);
      }};
      try {
        place(31, 2); hit(52); // Prewarm a different band, then record only the checked moves.
        cellBuilds.length = 0;
        place(b.width/2); bandWinners.push(hit(10));
        place(b.width/2 / .95 + 15, .95); bandWinners.push(hit(31));
        place(31, 1.125); bandWinners.push(hit(52));
      } finally { globalThis.AtriumProblemMarks = P; }
      place(31, 32);
      const close = hit(31);
      place(b.width/2);
      const [px,py] = point(10), click = {x:b.left+px,y:b.top+py};
      const items = d.items, iterate = items[Symbol.iterator];
      let walks = 0, priority, beforeGeometry, boxes, labels, afterGeometry;
      items[Symbol.iterator] = function(){walks++;return iterate.call(this);};
      try {
        priority = AtriumProblemHover.over(pane.canvas, click.x, click.y);
        const tooltip = AtriumProblemHover._find(pane,click.x,click.y);
        beforeGeometry = walks;
        labels = tooltip?.entries.map(e => e.objects);
        boxes = tooltip?.boxes.length;
        afterGeometry = walks;
      } finally {delete items[Symbol.iterator];}
      h.redraw(true);
      return {fit, unpainted, cut, repaired, painted, cellBuilds, bandWinners, close, click, priority, beforeGeometry, afterGeometry, boxes, labels};
    });
    const members = ["band-advice","band-tip","band-other"];
    assert.deepEqual(result.fit, {at:[10,10],winner:"band-advice",members});
    assert.deepEqual(result.painted, [result.fit.at], "the shared pick is the one painted diamond");
    assert.equal(result.unpainted, null, "a hidden group member has no independent overview hit");
    assert.deepEqual(result.cut, {at:[31,10],winner:"band-tip",members}, "an onscreen fallback preserves all group members");
    assert.deepEqual(result.repaired, [true,true], "the retained pan repairs both old and new anchors");
    assert.deepEqual(result.bandWinners, [result.fit, result.cut, {at:[52,10],winner:"band-other",members:["band-other"]}]);
    assert.deepEqual(result.cellBuilds, [64,32], "a within-band move reuses membership and a band change rebuilds it");
    assert.deepEqual(result.close, {at:[31,10],winner:"band-tip",members:["band-tip"]});
    assert.ok(result.priority);
    assert.equal(result.boxes, 3);
    assert.deepEqual([result.beforeGeometry,result.afterGeometry], [0,1], "only a card's details resolve board objects, in one traversal");
    assert.deepEqual(result.labels.map(x => x.at(-1)), members, "each entry retains its object/net labels");
    await page.mouse.move(result.click.x, result.click.y);
    const quiet = page.locator("#waffle-problem-card:visible");
    await quiet.waitFor();
    assert.equal(await quiet.locator(".ui-tooltip-head strong").textContent(), "3 problems here");
    assert.deepEqual(await quiet.locator(".ui-tooltip-list strong").allTextContents(),
      ["Board advice", "First grouped tip", "Second grouped tip"]);
    assert.deepEqual(await quiet.locator(".ui-tooltip-value").allTextContents(), ["Advice", "Tip", "Tip"]);
    await page.mouse.click(result.click.x, result.click.y);
    await page.locator(".insight-card:visible .insight-title").filter({hasText:/^Board advice$/}).waitFor();
    await page.evaluate(() => AtriumInsightsUI.open(AtriumInsightsUI.current().find(x => x.check === "band-tip")));
    await page.locator(".insight-card:visible .insight-title").filter({hasText:/^First grouped tip$/}).waitFor();
    assert.equal(await page.evaluate(() => {
      const p = AtriumNavHost.panes().find(p => p.active), b = p.canvas.getBoundingClientRect();
      const [x,y] = p.view.worldToScreen([31,10]);
      return AtriumInsightsUI.groupAt(p,b.left+x,b.top+y)?.rep.check;
    }), "band-tip", "a pinned member keeps its exact marker anchor");
    await page.locator(".insight-card:visible .insight-close").click();
    await page.locator(".insight-card").waitFor({state:"hidden"});
    assert.deepEqual(errors, []);
    console.log("PASS PCB Insight zoom bands: paint/pick, pan repair, grouped Tip/Advice and pinned members");
  } finally { await page.close(); }
}

module.exports = async function insightsPolish(browser, {theme = "light", capture, audit} = {}) {
  if (theme === "light") {
    await rotatedMarkers(browser);
    await groupedMarkers(browser);
  }
  const page = await browser.newPage({viewport: {width: 1440, height: 1000}, reducedMotion: "reduce"});
  const errors = [];
  page.on("pageerror", e => errors.push(e.message));
  page.setDefaultTimeout(7000);
  try {
    await page.addInitScript(theme => {
      globalThis.ATRIUM_UNDO_VERIFY = "throw";
      localStorage.setItem("atrium.prefs", JSON.stringify({format: "atrium-prefs", version: 1, values: {
        "appearance.theme": theme, "appearance.animations": "off", "general.startPage": "always"
      }}));
    }, theme);
    await page.goto(editor);
    await page.locator("dialog.sp-dialog[open] [data-start-action=demo]").click();
    await page.evaluate(async () => {
      await AtriumLazy.need("AtriumInsightsUI");
      (await AtriumLazy.need("AtriumPrefs")).open("insights");
    });
    const preferences = page.getByRole("dialog", {name: "Preferences", exact: true});
    const todo = preferences.getByRole("switch", {name: "Open sheet to-do", exact: true});
    await todo.waitFor();
    assert.equal(await todo.getAttribute("aria-describedby"), null, "checks without an explanation still render");
    assert.equal(await preferences.locator("#prf-insights-expand").getAttribute("class"), "ui-field");
    await preferences.getByRole("button", {name:"General", exact:true}).click();
    const unitsHelp = preferences.locator("#prf-general-units-help");
    await unitsHelp.waitFor();
    assert.equal(await unitsHelp.locator(".ui-shortcut").count(), Number(!!await page.evaluate(() => AtriumKeymap.hintKey("toggle-units", AtriumNavHost.doc()?.kind))));
    await preferences.getByRole("button", {name:"Close Preferences", exact:true}).click();
    await page.evaluate(async theme => {
      const h = AtriumNavHost;
      AtriumTheme.setPreset(theme);
      const def = {id: "regulator", name: "Bench supply", category: "Voltage regulator", prefix: "U",
        symbol: {shapes: [], pins: [{number: "1", name: "VIN", x: -5, y: 0}, {number: "2", name: "VOUT", x: 5, y: 0},
          {number: "3", name: "GND", x: 0, y: 5}]}};
      const p = Atrium.project("48 V clearance bench", [def]), [sch, pcb] = p.documents;
      sch.name = "Supply"; pcb.name = "Clearance bench";
      const u = {id: "bench regulator", kind: "part", def: def.id, ref: "U1", x: 50, y: 40, angle: 0, pinNets: {}, parameters: {Vout: "48 V"}};
      sch.items = [u, ...Atrium.pins(u, def, "schematic").map((pin, i) =>
        ({id: "label-" + i, kind: "netlabel", text: ["INPUT", "HEATER_SUPPLY", "GND"][i], x: pin.at[0], y: pin.at[1]}))];
      pcb.outline = [[0, 0], [65, 0], [65, 42], [0, 42]];
      const track = (id, net, x, y) => ({id, name: id, kind: "track", net, layer: "Top", width: .4, points: [[x, y], [x + 22, y]]});
      pcb.items = [
        track("heater-1", "HEATER_SUPPLY", 7, 10), track("ground-1", "GND", 7, 11.4), track("logic-1", "5V", 7, 8.6),
        track("heater-2", "HEATER_SUPPLY", 36, 29), track("logic-2", "5V", 36, 30.4), track("ground-2", "GND", 36, 27.6),
        track("heater-3", "HEATER_SUPPLY", 36, 11), track("sense-3", "SENSE", 36, 12.4)
      ];
      await h.replaceProject(p, {force: true, dirty: false});
      h.selectDocument(pcb.id); h.act("insights-panel");
    }, theme);
    const panel = page.locator(".msg-panel:visible");
    const cells = panel.locator("td.msg-net-pair"), details = panel.locator("td.msg-net-pair-child");
    const toggle = panel.getByRole("button", {name: "Show all 2 findings for GND ↔ HEATER_SUPPLY"});
    await toggle.waitFor();
    assert.equal(await panel.getByRole("tab", {name: "Problems"}).getAttribute("aria-selected"), "true");
    assert.deepEqual((await cells.locator("span").allTextContents()).sort(), ["5V ↔ HEATER_SUPPLY", "GND ↔ HEATER_SUPPLY"]);
    assert.equal(await details.count(), 0);
    if (audit) await audit(page, theme + " collapsed Insights groups");
    await panel.getByRole("button", {name: "Layout", exact: true}).click();

    await toggle.focus();
    await page.keyboard.press("Enter");
    const collapse = panel.getByRole("button", {name: "Collapse findings for GND ↔ HEATER_SUPPLY"});
    assert.equal(await collapse.getAttribute("aria-expanded"), "true");
    assert.equal(await collapse.evaluate(n => n === document.activeElement), true);
    assert.equal(await details.count(), 2);
    if (audit) await audit(page, theme + " expanded Insights findings");
    assert.ok((await details.allTextContents()).every(text => text.includes("48 V from Vout on U1")));
    assert.ok((await details.last().boundingBox())?.width > 100, "expanded rows have room in the default side dock");

    await details.last().click();
    await page.waitForFunction(() => {
      const hosts = AtriumNavHost.selection();
      return hosts.includes("heater-2") || hosts.includes("ground-2") ||
        document.querySelector(".insight-card:not([hidden]) .insight-msg")?.textContent.includes("HEATER_SUPPLY and GND");
    });
    if (capture) {
      await page.evaluate(() => AtriumNavHost.act("move-panel"));
      const move = page.getByRole("dialog", {name: "Move panel", exact: true});
      await move.getByLabel("Panel", {exact: true}).selectOption("messages");
      await move.getByLabel("Destination").selectOption(JSON.stringify({area: "bottom", mode: "end"}));
      await move.getByRole("button", {name: "Move", exact: true}).click();
      await page.locator("#dock-bottom .msg-panel:visible").waitFor();
      await collapse.click();
      await toggle.waitFor();
      await page.locator(".insight-card:visible .insight-close").click();
      await page.evaluate(() => AtriumNavHost.act("fit"));
      await capture(page, "grouped");
      await toggle.click();
      await details.last().click();
      await page.locator(".insight-card:visible .insight-msg").waitFor();
      await capture(page, "expanded");
    }
    const old = await page.evaluate(() => {
      const h = AtriumNavHost, p = h.project(), d = h.doc();
      const found = AtriumInsights.analyze(p, d, h.defs(), {checks: ["creepage"]}).insights;
      return found.map(x => [x.key, x.netPair]);
    });
    assert.equal(old.length, 4);

    await page.evaluate(() => {
      const h = AtriumNavHost, p = h.project(), board = h.doc(), sch = p.documents.find(d => d.kind === "schematic");
      h.selectDocument(sch.id);
      const part = sch.items.find(i => i.kind === "part");
      h.edit(() => { part.parameters.Vout = "12 V"; }, "Edit regulator output", [part]);
      h.selectDocument(board.id);
    });
    await page.waitForFunction(() => AtriumMessages.problems().every(row => row.problem?.check !== "layout.hint.creepage"));
    assert.equal(await page.evaluate(() => {
      const h = AtriumNavHost;
      return AtriumInsights.analyze(h.project(), h.doc(), h.defs(), {checks: ["creepage"]}).insights.length;
    }), 0, "remote voltage edit matches a full recheck");
    await page.evaluate(() => {
      const h = AtriumNavHost, id = h.currentId();
      h.act("undo");
      h.selectDocument(id);
    });
    await page.waitForFunction(() => AtriumMessages.problems().filter(r => r.problem?.check === "layout.hint.creepage").length === 4);
    assert.deepEqual(errors, []);
    console.log("PASS browser Insights: canonical 48 V net pairs, keyboard expansion, locate and cross-sheet voltage undo");
  } finally { await page.close(); }
};
module.exports.rotatedMarkers = rotatedMarkers;

module.exports.groupedMarkers = groupedMarkers;
