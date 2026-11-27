"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const {pathToFileURL} = require("node:url");
const {chromium} = require("../support/playwright.cjs");

async function run(browser) {
  const page = await browser.newPage(), requested = new Set();
  page.on("request", request => requested.add(new URL(request.url()).pathname.split("/").at(-1)));
  const url = pathToFileURL(path.join(__dirname, "../../app/index.html")).href;
  try {
    await page.goto(url);
    const demo = page.getByRole("button", {name:"Try the Demo", exact:true});
    await demo.waitFor();
    const timing = await page.evaluate(() => ({enabled:AtriumPrefs.get("butter.macros"),
      registered:!!AtriumKeymap.command("butter.macros.record-start"),
      scripts:performance.getEntriesByType("resource").filter(row => /\/butter-macros\.js$/.test(row.name)).length}));
    assert.deepEqual(timing, {enabled:false, registered:false, scripts:0});
    assert.equal(requested.has("butter-macros.js"), false);
    await demo.click();
    await page.waitForFunction(() => AtriumNavHost.project().name === "Sensor interface");
    await page.locator('#document-tabs [data-kind="pcb"]').first().click();
    await page.evaluate(() => AtriumPrefs.set("butter.macros", true));
    await page.waitForFunction(() => Boolean(AtriumKeymap.command("butter.macros.record-start")));

    const recordingStart = performance.now();
    await page.keyboard.press("F1");
    const palette = page.locator("#palette[open]");
    await palette.getByRole("combobox").fill("Start Macro Recording");
    await palette.getByText("Start Macro Recording", {exact:true}).first().click();
    await page.waitForFunction(() => globalThis.AtriumMacros && AtriumButter.run("butter.macros.record-status")
      .then(r => r.result.status === "recording"));
    const tracks = await page.evaluate(() => AtriumNavHost.doc().items.filter(i => i.kind === "track" && !i.locked)
      .slice(0, 3).map(i => ({id:i.id, width:i.width})));
    assert.equal(tracks.length, 3);
    await page.evaluate(id => AtriumNavHost.select([id], id), tracks[0].id);
    const width = page.locator("#inspector").getByLabel(/^Width \(/).first();
    await width.fill("0.63 mm");
    await width.press("Enter");
    await page.waitForFunction(id => AtriumNavHost.doc().items.find(i => i.id === id).width === .63, tracks[0].id);
    const ids = tracks.slice(1).map(track => track.id);
    await page.evaluate(ids => AtriumNavHost.select(ids, ids[0]), ids);
    const batchWidth = page.locator("#inspector").getByLabel("Width", {exact:true});
    await batchWidth.fill("0.491 mm");
    await batchWidth.press("Tab");
    await page.waitForFunction(ids => ids.every(id => AtriumNavHost.doc().items.find(i => i.id === id).width === .491), ids);
    await page.locator('details[data-menu="tools"] summary').click();
    await page.locator('details[data-menu="tools"] [data-action="drc"]').click();
    const stopRecording = (count, timeout) => page.evaluate(async ([count, timeout]) => {
      const deadline = performance.now() + timeout;
      while ((await AtriumButter.run("butter.macros.record-status")).result.count < count && performance.now() < deadline)
        await new Promise(resolve => requestAnimationFrame(resolve));
      const {result} = await AtriumButterEditor.apply("butter.macros.record-stop", {});
      return {result, selectedCount:AtriumNavHost.selection().length};
    }, [count, timeout]);
    const {result:capture} = await stopRecording(3, 10000);
    assert.deepEqual(capture.steps.map(({command, args}) => ({command, args})), [
      {command:"butter.macros.set-track-width", args:{width:.63}},
      {command:"butter.macros.set-track-width", args:{width:.491}},
      {command:"butter.macros.check-design-rules", args:{}},
    ]);
    const recordingMs = performance.now() - recordingStart;

    await page.evaluate(async () => {
      AtriumPrefs.set("butter.query", true);
      await AtriumButterEditor.apply("butter.macros.record-start", {});
      AtriumNavHost.act("query-panel");
    });
    await page.locator(".query-input").fill("IsTrack");
    await page.locator(".query-apply").click();
    const {result:selection, selectedCount} = await stopRecording(1, 4000);
    assert(selectedCount > 1);
    assert.equal(selection.steps.length, 1);
    assert.equal(selection.steps[0].command, "butter.query.search");
    assert.equal(selection.steps[0].select, true);
    await page.evaluate(() => AtriumQuery.toggle(false));

    const macro = await page.evaluate(async options => {
      const [change, , check] = options.steps;
      change.args.width = {$parameter:"width"};
      return (await AtriumButterEditor.apply("butter.macros.save", {macro:{format:"waffle-macro", version:1,
        name:"Width and board rules", alias:"width-and-rules", shortcut:"Alt+Shift+M", selectionOnly:true,
        parameters:[{name:"width", type:"number", default:.63}], steps:[
          {...change, id:Atrium.id(), args:{width:.59}}, change, check],
      }})).result.macro;
    }, capture);
    const originals = ids.map(() => .491);
    const getWidths = () => page.evaluate(ids => ids.map(id => AtriumNavHost.doc().items.find(i => i.id === id).width), ids);
    await page.evaluate(ids => AtriumNavHost.select(ids, ids[0]), ids);
    await page.waitForFunction(() => AtriumKeymap.command("butter.macros.alias.width-and-rules"));
    await page.locator("#canvas").focus();
    await page.evaluate(() => AtriumPrefs.set("labs.notebook", true));
    const bounds = await page.locator("#canvas").boundingBox();
    await page.mouse.move(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2);
    await page.keyboard.press("/");
    await palette.getByRole("combobox").fill("width-and-rules");
    await palette.getByText("Run on selection", {exact:true}).first().waitFor();
    await page.keyboard.press("Escape");
    const playback = [];
    for (let trial = 0; trial < 5; trial++) {
      await page.evaluate(ids => AtriumNavHost.select(ids, ids[0]), ids);
      await page.locator("#canvas").focus();
      const start = performance.now();
      await page.keyboard.press("Alt+Shift+M");
      await page.waitForFunction(ids => ids.every(id => AtriumNavHost.doc().items.find(i => i.id === id).width === .63), ids);
      playback.push(performance.now() - start);
      await page.evaluate(() => AtriumNavHost.act("undo"));
      assert.deepEqual(await getWidths(), originals, "one ordinary Undo reverses the complete hotkey macro");
    }

    const failures = await page.evaluate(async ({ids, macro}) => {
      AtriumNavHost.select(ids, ids[0]);
      const invalid = {id:Atrium.id(), command:"butter.macros.place-power-port", args:{pin:"1"}};
      const recipe = {...macro, steps:[macro.steps[0], invalid]};
      const atomic = await AtriumButterEditor.apply("butter.macros.run", {macro:recipe});
      const committed = ids.map(id => AtriumNavHost.doc().items.find(i => i.id === id).width);
      const stepwise = await AtriumMacros.runStepwise({macro:recipe}, {approve:receipt => receipt.result.changes === 2});
      return {atomic:atomic.result, committed, stepwise};
    }, {ids, macro});
    assert.equal(failures.atomic.status, "failed");
    assert.equal(failures.atomic.applied, 0);
    assert.deepEqual(failures.committed, originals);
    assert.equal(failures.stepwise.status, "failed");
    assert.equal(failures.stepwise.stoppedAt, 1);
    assert.equal(failures.stepwise.applied, 1);
    assert.deepEqual(await getWidths(), [.59, .59]);
    await page.evaluate(() => AtriumNavHost.act("undo"));
    assert.deepEqual(await getWidths(), originals);

    await page.evaluate(() => AtriumPrefs.set("butter.query", true));
    const argumentCases = JSON.parse(await fs.readFile(path.join(__dirname, "../fixtures/butter-command-arguments.json"), "utf8"));
    const outcomes = await page.evaluate(async cases => {
      AtriumPrefs.set("butter.visualHistory", true);
      return Promise.all(cases.map(async ({command, args}) => {
        try {
          const receipt = await AtriumButter.run(command, JSON.parse(args), {mode:"plan"});
          return receipt.result.complete ? "accepted" : receipt.result.diagnostic?.code;
        } catch (error) {return error.code;}
      }));
    }, argumentCases);
    assert.deepEqual(outcomes, argumentCases.map(row => row.outcome));
    const incomplete = await page.evaluate(async () => {
      const h = AtriumNavHost, doc = h.doc(), project = h.project();
      const rules = structuredClone(AtriumProjectRules.book(project));
      const widthRule = rules.list.find(rule => rule.type === "width");
      widthRule.scope = {languageVersion:99, source:"track"};
      h.edit(() => {project.rules = rules;}, "Newer rule scope");
      const direct = (await AtriumButter.run("butter.macros.check-design-rules", {rules:["width"]})).result;
      const steps = [
        {id:Atrium.id(), command:"butter.macros.set-track-width", args:{width:.49}},
        {id:Atrium.id(), command:"butter.macros.check-design-rules", args:{rules:["width"]}},
      ];
      const macro = {format:"waffle-macro", version:1, name:"Check newer rules", alias:"check-newer", id:Atrium.id(), steps};
      const receipt = await AtriumButterEditor.apply("butter.macros.run", {macro});
      await h.act("undo");
      return {direct, receipt};
    });
    assert.equal(incomplete.direct.complete, false);
    assert.equal(incomplete.receipt.changes, 0);
    assert.equal(incomplete.receipt.result.steps.at(-1).code, incomplete.direct.diagnostics[0].code);
    assert.deepEqual(await getWidths(), originals);
    const condition = await page.evaluate(async ({ids, macro}) => {
      const query = "track where width < 100 mm";
      const never = "track where width > 100 mm";
      const conditional = {...macro, steps:[
        {...macro.steps[0], when:{source:never}}, {...macro.steps[1], when:{source:query}},
      ]};
      return (await AtriumButter.run("butter.macros.run", {macro:conditional, selection:ids}, {mode:"plan"})).result;
    }, {ids, macro});
    assert.equal(condition.status, "ready");
    assert.deepEqual(condition.steps.map(step => step.status), ["skipped", "ready"]);
    assert.deepEqual(await getWidths(), originals);

    const scoped = await page.evaluate(async ({projectMacro, selecting}) => {
      const host = AtriumNavHost, board = host.doc(), sheet = host.project().documents.find(d => d.kind === "schematic");
      const saved = (await AtriumButterEditor.apply("butter.query.save-query",
        {name:"Board tracks", source:"track", scope:{documentId:board.id}})).result.record;
      const chosen = {...projectMacro, id:Atrium.id(), alias:"select-board-tracks", name:"Select board tracks",
        selectionOnly:false, parameters:[], steps:[selecting]};
      delete chosen.shortcut;
      await AtriumButterEditor.apply("butter.macros.save", {macro:chosen});
      await host.selectDocument(sheet.id);
      const conditional = {...chosen, steps:[{...projectMacro.steps.at(-1), when:{savedQueryId:saved.id}}]};
      const planned = await AtriumButter.run("butter.macros.run", {macro:conditional}, {mode:"plan"});
      return {boardId:board.id, sheetId:sheet.id, status:planned.result.steps[0].status};
    }, {projectMacro:macro, selecting:selection.steps[0]});
    assert.equal(scoped.status, "ready");
    await page.waitForFunction(() => AtriumKeymap.command("butter.macros.alias.select-board-tracks") &&
      AtriumKeymap.command("butter.macros.alias.width-and-rules"));
    await page.evaluate(() => AtriumKeymap.command("butter.macros.alias.select-board-tracks").run());
    const revealed = await page.evaluate(() => ({documentId:AtriumNavHost.currentId(), count:AtriumNavHost.selection().length}));
    assert.deepEqual(revealed, {documentId:scoped.boardId, count:selectedCount});

    const power = await page.evaluate(async ({boardId, sheetId}) => {
      const host = AtriumNavHost;
      await host.selectDocument(sheetId);
      await AtriumLazy.need(["AtriumSchObjects", "AtriumSchObjectTools", "AtriumSchPlace"]);
      const part = host.doc().items.find(item => item.kind === "part"), pin = Atrium.pins(part, host.defs().get(part.def), "schematic")[0];
      await AtriumButterEditor.apply("butter.macros.record-start", {});
      await host.act("sch-power");
      await AtriumSchObjects.click(pin.at);
      const captured = (await AtriumButterEditor.apply("butter.macros.record-stop", {})).result.steps;
      const placed = host.doc().items.find(item => item.kind === "power" && Atrium.same([item.x,item.y], pin.at));
      await host.act("undo");
      await host.selectDocument(boardId);
      return {captured, pin:String(pin.number), placed:!!placed};
    }, scoped);
    assert.equal(power.placed, true);
    assert.equal(power.captured.length, 1);
    assert.equal(power.captured[0].command, "butter.macros.place-power-port");
    assert.equal(power.captured[0].args.pin, power.pin);
    assert.equal(power.captured[0].args.net, "GND");

    const composition = await page.evaluate(async ({ids,scoped,pin}) => {
      const host = AtriumNavHost, board = host.doc(), sheet = host.project().documents.find(d => d.id === scoped.sheetId);
      const part = sheet.items.find(item => item.kind === "part");
      const initial = board.items.find(item => item.id === ids[0]).width;
      const doc = id => host.project().documents.find(d => d.id === id);
      const widths = () => doc(board.id).items.filter(item => ids.includes(item.id)).map(item => item.width);
      const powerCount = () => doc(sheet.id).items.filter(item => item.kind === "power").length;
      const baseline = {widths:widths(),ports:powerCount(),undo:host.undoSteps().history.length};
      const step = (command,args) => ({id:Atrium.id(),command:"butter.macros." + command,args});
      const edit = (width,targets) => step("set-track-width",{documentId:board.id,width,ids:targets});
      const steps = [edit(.37,[...ids].reverse()),edit(initial,[ids[0]]),edit(.43,[ids[1]])];
      const macro = {id:Atrium.id(),format:"waffle-macro",version:1,name:"Compose macro",alias:"compose-macro",steps};
      const reduced = await AtriumButter.run("butter.macros.run",{macro});
      const empty = await AtriumButterEditor.apply("butter.macros.run",{macro:{...macro,steps:[edit(.37,[ids[0]]),edit(initial,[ids[0]])]}});
      const afterEmpty = {widths:widths(),ports:powerCount(),undo:host.undoSteps().history.length};
      const mixed = {...macro,steps:[...steps,step("place-power-port",{documentId:sheet.id,ids:[part.id],pin,net:"GND"})]};
      const receipt = await AtriumButterEditor.apply("butter.macros.run",{macro:mixed});
      const changed = {widths:widths(),ports:powerCount()};
      await host.act("undo");
      return {baseline,afterEmpty,changed,empty:empty.changes,mixed:receipt.changes,
        undone:{widths:widths(),ports:powerCount(),undo:host.undoSteps().history.length},ops:reduced.proposal.ops};
    },{ids,scoped,pin:power.pin});
    assert.deepEqual(composition.ops.map(op => [op.id,op.before,op.after]), [[ids[1],originals[1],.43]]);
    assert.equal(composition.empty,0);
    assert.deepEqual(composition.afterEmpty,composition.baseline);
    assert.equal(composition.mixed,2);
    assert.deepEqual(composition.changed,{widths:[originals[0],.43],ports:composition.baseline.ports+1});
    assert.deepEqual(composition.undone,composition.baseline,"one Undo reverses both members of the mixed proposal");

    const mixedScopes = await page.evaluate(async ({id,scoped}) => {
      const host = AtriumNavHost;
      AtriumPrefs.set("butter.numericFields",true);
      const current = documentId => host.project().documents.find(doc => doc.id === documentId);
      const state = () => {
        const board = current(scoped.boardId), sheet = current(scoped.sheetId);
        return {width:board.items.find(item => item.id === id).width,boardGrid:board.grid,sheetGrid:sheet.grid};
      };
      const grid = (documentId,source) => ({id:Atrium.id(),command:"butter.numericFields.set",
        args:{target:{scope:"document",documentId,path:["grid"]},source}});
      const edits = [{id:Atrium.id(),command:"butter.macros.set-track-width",args:{ids:[id],width:.38}},
        grid(scoped.boardId,"0.73 mm")];
      const results = [];
      for (const steps of [edits,[...edits,grid(scoped.sheetId,"1.6 mm")]]) {
        const macro = {id:Atrium.id(),format:"waffle-macro",version:1,name:"Mixed document edits",alias:"mixed-document-edits",steps};
        const before = state(), priorHistory = host.undoSteps().history.length;
        const applied = await AtriumButterEditor.apply("butter.macros.run",{macro});
        const after = state(), addedHistory = host.undoSteps().history.length - priorHistory;
        await host.act("undo");
        const undone = state();
        await host.act("redo");
        const redone = state();
        await host.act("undo");
        results.push({before,after,undone,redone,addedHistory,changes:applied.changes});
      }
      return results;
    },{id:ids[0],scoped});
    for (const [index,result] of mixedScopes.entries()) {
      assert.equal(result.changes,index+2);
      assert.equal(result.addedHistory,1);
      assert.deepEqual(result.after,{width:.38,boardGrid:.73,sheetGrid:index ? 1.6 : result.before.sheetGrid});
      assert.deepEqual(result.undone,result.before,"Undo restores item and document fields in the same proposal");
      assert.deepEqual(result.redone,result.after,"Redo restores both categories of writes");
    }

    const downloading = page.waitForEvent("download");
    await page.evaluate(id => AtriumButterEditor.apply("butter.macros.export", {id}), macro.id);
    const download = await downloading;
    assert.equal(download.suggestedFilename(), "width-and-rules.waffle-extension");
    const packageText = await fs.readFile(await download.path(), "utf8");
    const pkg = JSON.parse(packageText);
    assert.deepEqual(pkg.manifest.permissions, ["read:project", "ui:command", "propose:edits"]);
    assert.match(pkg.files["main.js"], /api\.proposals\.submit\(receipt\.proposal/);
    const valid = await page.evaluate(async text => {
      await AtriumLazy.need("AtriumExtensions");
      const files = await AtriumExtensions.packageFromFiles([new File([text], "width-and-rules.waffle-extension")]);
      return AtriumExtensions.validateManifest(JSON.parse(files["waffle-extension.json"]), files).id;
    }, packageText);
    assert.equal(valid, pkg.manifest.id);
    const installing = page.evaluate(async text => {
      const entries = await AtriumExtensions.packageFromFiles([new File([text], "width-and-rules.waffle-extension")]);
      return (await AtriumExtensions.install(entries)).id;
    }, packageText);
    await page.getByRole("dialog", {name:"Install Width and board rules?", exact:true}).getByRole("button", {name:"Install", exact:true}).click();
    assert.equal(await installing, pkg.manifest.id);
    const review = page.getByRole("dialog", {name:"Review changes from Width and board rules", exact:true});
    const extension = pkg.manifest.contributes.commands[0].command;
    const invoke = value => page.evaluate(({extension, value}) => AtriumExtensions.execute(extension, {width:value}), {extension,value});
    async function decide(accept, value) {
      await page.evaluate(ids => AtriumNavHost.select(ids, ids[0]), ids);
      await Promise.all([invoke(value), (async () => {
        await review.waitFor();
        assert.deepEqual(await getWidths(), originals, "the sandboxed command waits for existing edit approval");
        await review.getByRole("button", {name:accept ? "Apply selected" : "Discard", exact:true}).click();
      })()]);
      assert.deepEqual(await getWidths(), accept ? [value, value] : originals);
    }
    await decide(false, .63);
    await assert.rejects(invoke(.63), /already declined this change/);
    await decide(true, .64);
    await page.evaluate(() => AtriumNavHost.act("undo"));
    assert.deepEqual(await getWidths(), originals);
    await page.evaluate(() => AtriumPrefs.set("butter.macros", false));
    assert.equal(await page.evaluate(() => AtriumKeymap.command("butter.macros.alias.width-and-rules")), null);
    assert.equal(await page.evaluate(() => AtriumButter.run("butter.macros.list").catch(error => error.code)), "butter_disabled");
    return {disabledMacroScriptRequests:timing.scripts, recordedSteps:capture.steps.length,
      recordingMs:+recordingMs.toFixed(1), playbackMs:playback.map(ms => +ms.toFixed(1))};
  } finally {await page.close();}
}

(async () => {
  const browser = await chromium.launch(process.env.CHROME ? {executablePath:process.env.CHROME} : {channel:"chrome"});
  try {
    const metrics = await run(browser);
    console.log("PASS macro default-off, real capture, hotkey, atomic Undo, stepwise failure, query conditions and extension export");
    console.log(JSON.stringify(metrics));
  }
  finally {await browser.close();}
})().catch(error => {console.error(error); process.exitCode = 1;});
