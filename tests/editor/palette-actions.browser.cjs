"use strict";

// Exercise the shared palette through the visible editors in a real Chromium browser.
const assert = require("node:assert/strict");
const path = require("node:path");
const {pathToFileURL} = require("node:url");

async function check(browser, root) {
  const page = await browser.newPage({viewport:{width:1380, height:910}});
  await require("../fixtures/notebook-labs.cjs").profile(page);
  const errors = [];
  page.on("pageerror", error => errors.push(error.message));
  page.setDefaultTimeout(6000);
  const palette = page.locator("#palette[open]"), input = palette.getByRole("combobox");
  const canvas = page.locator("#canvas"), wait = (fn, arg) => page.waitForFunction(fn, arg);
  const model = () => page.evaluate(() => JSON.stringify(AtriumNavHost.project()));
  const editCount = () => page.evaluate(() => AtriumNavHost.undoSteps().history.length);
  const active = () => palette.locator('[role=option][aria-selected=true] .nav-palette-label').innerText();
  async function setDoc(kind) {
    await page.evaluate(kind => {
      const h = AtriumNavHost;
      h.selectDocument(h.project().documents.find(d => d.kind === kind).id);
      h.act("select"); h.select([]); h.canvas().focus();
    }, kind);
  }
  async function pointAt(at) {
    const screen = await page.evaluate(at => {
      const h = AtriumNavHost, view = h.view(), canvas = h.canvas(), box = canvas.getBoundingClientRect();
      globalThis.AtriumCamera?.takeCamera?.(view);
      view.restoreCamera({...view.camera(), cx:at[0], cy:at[1], scale:7});
      h.redraw(); const p = view.worldToScreen(at);
      return [box.left + p[0], box.top + p[1]];
    }, at);
    await page.mouse.move(...screen);
    await canvas.focus();
  }
  async function clickWorld(at) {
    const screen = await page.evaluate(at => {
      const h = AtriumNavHost, box = h.canvas().getBoundingClientRect(), p = h.view().worldToScreen(at);
      return [box.left+p[0],box.top+p[1]];
    }, at);
    await page.mouse.click(...screen);
  }
  async function open(text, at, surface) {
    if (surface) {
      const stage = page.locator(surface + " canvas").first();
      await stage.hover({position:{x:80,y:75}}); await stage.focus();
    } else if (at) await pointAt(at);
    else await canvas.focus();
    await page.keyboard.press("/");
    await input.waitFor();
    await input.fill(text);
  }
  async function choose(label, detail) {
    const match = await page.waitForFunction(([label, detail]) => {
      const all = [...document.querySelectorAll("#palette[open] [role=option]")];
      const exact = all.filter(row => row.querySelector(".nav-palette-label")?.textContent === label && (!detail || row.querySelector(".nav-palette-detail")?.textContent.includes(detail)));
      const preferred = exact.find(row => row.closest('[role=group]')?.firstElementChild?.textContent === "Insert");
      const selected = preferred || exact[0]; return selected ? selected.dataset.i : null;
    }, [label, detail]);
    const index = Number(await match.jsonValue());
    // Use keyboard focus and selection so Tab / Cmd-K act on the same row a user sees.
    let selected = Number(await palette.locator('[role=option][aria-selected=true]').getAttribute("data-i"));
    while (selected !== index) {
      await input.press(selected < index ? "ArrowDown" : "ArrowUp");
      selected = Number(await palette.locator('[role=option][aria-selected=true]').getAttribute("data-i"));
    }
    assert.equal(await active(), label);
  }
  async function commit(label, values) {
    await choose(label);
    if (!values) return input.press("Enter");
    await input.press("Tab");
    const form = palette.locator("form:visible");
    for (const [name, value] of Object.entries(values)) {
      const field = form.getByLabel(name,{exact:true});
      if (await field.evaluate(e => e.tagName === "SELECT")) await field.selectOption(value);
      else await field.fill(value);
    }
    await form.locator('button[type=submit]').click();
  }
  async function undo(before, count) {
    assert.equal(await editCount(), count + 1);
    await page.evaluate(() => AtriumNavHost.act("undo"));
    assert.equal(await model(), before);
  }
  async function insert(text, label, at, fn, values) {
    const before = await model(), count = await editCount();
    await open(text, at); await commit(label, values);
    await wait(count => AtriumNavHost.undoSteps().history.length === count + 1, count);
    const state = await page.evaluate(() => {
      const h = AtriumNavHost, doc = h.doc(), item = doc.items.at(-1);
      return {doc, item, selected:h.selection(), project:h.project()};
    });
    await fn(state);
    await undo(before, count);
    console.log("  " + label);
  }
  try {
    await page.addInitScript(() => {globalThis.ATRIUM_UNDO_VERIFY = "throw";});
    await page.goto(pathToFileURL(path.join(root,"app","index.html")).href);
    await page.locator("dialog.sp-dialog[open] [data-start-action=demo]").click();
    await page.locator("#doc-name",{hasText:"Sensor board"}).waitFor();
    await page.evaluate(async () => {
      await AtriumLazy.need(["AtriumDrawing", "AtriumPanel", "AtriumUndoStore"]);
      const h = AtriumNavHost, A = Atrium, p = A.project("Palette exercise", AtriumParts.catalogue);
      const [sheet, board] = p.documents;
      sheet.name = "Controller sheet"; board.name = "Controller board";
      sheet.grid = board.grid = .25;
      sheet.items.push({kind:"wire", id:"open-wire", points:[[0,0],[20,0]]},
        {kind:"textframe",id:"fixture-note",x:40,y:10,w:20,h:12,text:"Bench notebook",note:true});
      const def = p.library.find(d => d.id === "std-r"), part = A.instantiate(p, def, [5,10]);
      part.parameters = {MPN:"R-1002", DATASHEET:"https://datasheets.example.invalid/resistor.pdf"};
      sheet.items.push(part);
      const cap = A.instantiate(p, p.library.find(d => d.id === "std-c"), [12,16]);
      cap.parameters = {DATASHEET:"javascript:alert(1)"}; sheet.items.push(cap);
      const fileDef = structuredClone(def); fileDef.name = "Lab thin film"; fileDef.value = "820 Ω";
      localStorage.setItem("atrium.libraries.v1", JSON.stringify([{id:"test-file",name:"Bench parts",defs:[fileDef]}]));
      const footprint = A.instantiate(p,def,[5,10],0,part); footprint.pinNets = {"1":"CLK"};
      board.items.push(footprint, {kind:"track",id:"clock-track",points:[[5,5],[40,5]],width:.25,net:"CLK",layer:"Top"});
      board.outline = [[0,0],[60,0],[60,40],[0,40]];
      p.documents.push(AtriumDrawing.create(p,{board:board.id,preset:"blank"}), AtriumPanel.create(p,{board:board.id}));
      await h.replaceProject(p,{force:true,dirty:false}); h.selectDocument(sheet.id); h.canvas().focus();
    });

    await setDoc("schematic");
    await open("",[20,0]);
    await wait(() => globalThis.AtriumPalette?.context()?.dangling === true);
    assert.ok(["Port","Power Port","Net Label","Off-Sheet Connector"].includes(await active()));
    await input.press("Escape");
    await open("",[44,12]); await wait(() => globalThis.AtriumPalette?.context()?.notebook);
    assert.ok(["Text","Note","Frame","Rich Text","Heading","Checklist","Equation","Calculation"].includes(await active()));
    await input.press("Escape");
    const endpoint = [20,0], selected = ({item, selected}) => assert.ok(selected.includes(item.id));
    for (const [text, title, kind, value] of [
      ["Port","Port","port","CLK"], ["Net Label","Net Label","netlabel","SYNC"], ["Power Port","Power Port","power","+3V3"],
      ["Off-Sheet Connector","Off-Sheet Connector","offsheet","OUT"], ["Note","Note","textframe","Pin map"]
    ]) {
      const field = kind === "power" ? "Power net" : kind === "textframe" ? "Text" : "Name";
      await insert(text,title,endpoint,state => {
        assert.equal(state.item.kind,kind); assert.equal(state.item.text,value); selected(state);
        assert.deepEqual([state.item.x,state.item.y],endpoint);
      }, {[field]:value});
    }
    if (await page.evaluate(() => typeof AtriumSchObjects.isFrame === "function")) {
      await insert("Frame","Frame",endpoint,({item, selected}) => {
        assert.equal(item.kind,"textframe"); assert.equal(item.role,"frame"); assert.equal(item.text,"Power stage");
        assert.deepEqual([item.x,item.y,item.w,item.h],[20,0,60,40]); assert.ok(selected.includes(item.id));
      }, {Title:"Power stage","Width (mm)":"60","Height (mm)":"40"});
    }
    await insert("Sheet Symbol","Sheet Symbol",endpoint,state => {
      selected(state); assert.equal(state.item.kind,"sheetsymbol");
      assert.ok(state.project.documents.some(d => d.id === state.item.sheet));
    });
    await open("/res 10k",endpoint); await choose("Resistor · 10 kΩ"); await input.press("Tab");
    assert.equal(await palette.getByLabel("Resistance",{exact:true}).inputValue(),"10 kΩ");
    await palette.locator("form:visible input").press("Escape"); await input.press("Escape");
    await insert("/res 10k","Resistor · 10 kΩ",endpoint,state => {
      selected(state); assert.equal(state.item.value,"10 kΩ"); assert.deepEqual([state.item.x,state.item.y],endpoint);
    });
    await insert("Lab thin film","Lab thin film",endpoint,({item,project,selected}) => {
      assert.ok(selected.includes(item.id));
      const copy = project.library.find(d => d.id === item.def);
      assert.notEqual(copy.id,"std-r"); assert.equal(copy.name,"Lab thin film");
      assert.equal(copy.libraryRef.id,"std-r"); assert.equal(copy.libraryRef.library,"test-file"); assert.ok(copy.libraryRef.hash);
    });
    const beforeRefusal = await model(), refusalHistory = await editCount();
    await open("/res 10k",endpoint);
    await commit("Resistor · 10 kΩ",{Resistance:"invalid resistance"});
    await wait(() => /Enter a resistance/.test(document.getElementById("status").textContent));
    assert.equal(await model(),beforeRefusal);
    assert.equal(await editCount(),refusalHistory);
    // The search input takes literal slashes, and displacing the pointer over the palette
    // never moves the original canvas anchor.
    await open("res",[15,12]);
    await input.fill("res"); await input.press("End"); await input.press("/");
    assert.equal(await input.inputValue(),"res/");
    await input.press("Escape"); await palette.waitFor({state:"hidden"});

    const beforeJumps = await model();
    await open("@R1",endpoint); await choose("R1", "Controller sheet"); await input.press("Enter");
    await wait(() => AtriumNavHost.doc().items.some(i => i.ref === "R1" && AtriumNavHost.selection().includes(i.id)));
    await open(":12,15",endpoint); await input.press("Enter");
    assert.equal(await model(),beforeJumps);

    async function secondary(query, label, button, detail) {
      await open(query); await choose(label,detail); await input.press("Control+k");
      const action = palette.getByRole("menuitem",{name:button,exact:true}); await action.click();
      await palette.waitFor({state:"hidden"});
    }
    const placeFromResult = await model(), oldHistory = await editCount();
    await secondary("@R1","R1","Place Component","Controller sheet");
    await wait(() => AtriumNavHost.doc().items.some(i => i.ref === "R2"));
    const duplicate = await page.evaluate(() => AtriumNavHost.doc().items.at(-1));
    assert.equal(duplicate.parameters.MPN,"R-1002"); await undo(placeFromResult,oldHistory);
    await open("@C1"); await choose("C1","Controller sheet"); await input.press("Control+k");
    await palette.getByRole("menuitem",{name:"Show in Library",exact:true}).waitFor();
    assert.equal(await palette.getByRole("menuitem",{name:"Open Datasheet",exact:true}).count(),0);
    await page.keyboard.press("Escape"); await input.press("Escape");
    // Route an external datasheet to an isolated new page, without leaving this browser.
    await page.context().route("https://datasheets.example.invalid/**", route => route.fulfill({status:200,contentType:"text/plain",body:"Test datasheet"}));
    const popup = page.context().waitForEvent("page");
    await secondary("@R1","R1","Open Datasheet","Controller sheet");
    const sheetPage = await popup;
    await sheetPage.waitForURL("https://datasheets.example.invalid/resistor.pdf");
    await sheetPage.close();

    await page.evaluate(() => {
      if (!navigator.clipboard) Object.defineProperty(navigator,"clipboard",{value:{}});
      Object.defineProperty(navigator.clipboard,"writeText",{configurable:true,value:async value => {globalThis.paletteCopied = value;}});
    });
    await secondary("@R1","R1","Copy MPN","Controller sheet");
    assert.equal(await page.evaluate(() => globalThis.paletteCopied),"R-1002");
    await secondary("@R1","R1","Show in Library","Controller sheet");
    await wait(() => document.body.classList.contains("library-panel-open") &&
      [...document.querySelectorAll(".panel-library input")].some(x => x.value === "Resistor"));
    await secondary("@R1","R1","Show on Board","Controller sheet");
    await wait(() => AtriumNavHost.doc().kind === "pcb" && AtriumNavHost.doc().items.some(i => i.ref === "R1" && AtriumNavHost.selection().includes(i.id)));
    assert.equal(await model(),beforeJumps);

    const boardAnchor = [10,5];
    await open("",boardAnchor);
    await wait(() => globalThis.AtriumPalette?.context()?.net === "CLK");
    assert.ok(["Route Track","Edit Net Class","Tune Track Length"].includes(await active()));
    await input.press("Escape");
    await insert("Via","Via",boardAnchor,state => {
      selected(state); assert.equal(state.item.kind,"via"); assert.equal(state.item.net,"CLK"); assert.deepEqual([state.item.x,state.item.y],boardAnchor);
    });
    await insert("Board Text","Board Text",boardAnchor,state => {
      selected(state); assert.equal(state.item.text,"TOP SIDE"); assert.deepEqual([state.item.x,state.item.y],boardAnchor);
    }, {Text:"TOP SIDE"});
    await insert("/res 4k7","Resistor · 4.7 kΩ",boardAnchor,state => {
      selected(state); assert.equal(state.item.kind,"part"); assert.equal(state.item.value,"4.7 kΩ");
    });
    const beforeBoardNavigation = await model();
    for (const action of ["Highlight Net", "Select All on Net", "Show Routed Length", "Edit Net Class"]) {
      await secondary("@CLK","CLK",action);
      if (action === "Highlight Net") await wait(() => AtriumNavHost.highlight() === "CLK");
      if (action === "Select All on Net") await wait(() => AtriumNavHost.selection().includes("clock-track"));
      if (action === "Show Routed Length") await wait(() => /CLK.*35.*routed/.test(document.getElementById("status").textContent));
      if (action === "Edit Net Class") await wait(() => globalThis.AtriumSignalsPanel?.isOpen());
    }
    await open("@R1-1",boardAnchor); await choose("R1.1","Controller board"); await input.press("Enter");
    assert.equal(await model(),beforeBoardNavigation);
    console.log("  Designator, pad, coordinate, PCB cross-probe and net actions");

    for (const [title,id] of [["Polygon Pour","pcb-polygon"],["Keepout Region","pcb-keepout-region"],["Linear Dimension","pcb-dim-linear"]]) {
      const before = await model(), n = await editCount();
      await open(title,boardAnchor); await commit(title);
      await wait(id => globalThis.AtriumPCBDraw?.session?.id === id,id);
      assert.deepEqual(await page.evaluate(() => AtriumPCBDraw.session.pts[0]),boardAnchor);
      await clickWorld([22,5]); await clickWorld([22,15]);
      if (id !== "pcb-dim-linear") await page.keyboard.press("Enter");
      if (id === "pcb-polygon") await page.locator("dialog[open]").getByRole("button",{name:"OK",exact:true}).click();
      await wait(n => AtriumNavHost.undoSteps().history.length > n,n);
      const item = await page.evaluate(() => AtriumNavHost.doc().items.at(-1));
      if (id === "pcb-polygon") assert.equal(item.kind,"polygon");
      if (id === "pcb-keepout-region") assert.ok(item.keepout || item.layer === "Keepout");
      if (id === "pcb-dim-linear") assert.equal(item.dimension.type,"linear");
      await page.keyboard.press("Escape"); await page.keyboard.press("Escape"); await undo(before,n);
      console.log("  " + title);
    }
    await open("Route Track",boardAnchor); await commit("Route Track");
    await wait(() => !!AtriumNavHost.liveRoute()); await page.keyboard.press("Escape"); await page.keyboard.press("Escape");
    await open(">Tune Track Length",boardAnchor); await choose("Tune Track Length");
    await palette.getByRole("button",{name:"Run",exact:true}).click();
    await wait(() => !!AtriumNavHost.liveTune()); await page.keyboard.press("Escape"); await page.keyboard.press("Escape");
    assert.equal(await model(),beforeBoardNavigation);

    for (const entrance of ["menu","F1","/"]) {
      if (entrance === "menu") {await page.locator('.work-menu[data-menu="view"] > summary').click(); await page.locator('.work-menu[data-menu="view"] [data-action="search"]').click();}
      else {await pointAt(boardAnchor); await page.keyboard.press(entrance);}
      await input.fill("r"); await choose("Run Design Rule Check");
      const tools = palette.getByRole("group",{name:"Tools",exact:true});
      assert.equal(await tools.getByRole("option",{name:/Run Design Rule Check/,selected:true}).count(),1);
      assert.equal(await palette.getByRole("option",{selected:true}).count(),1);
      assert.equal(await palette.getByRole("button",{name:"Run",exact:true}).count(),1);
      await input.press("Escape");
    }
    assert.deepEqual(await page.evaluate(() => ["drc","rules","fab-outputs","footprint-wizard"].filter(id => AtriumPalette.index().has("insert:"+id))),[]);
    const workflows = [["DRC","Run Design Rule Check","drc"],["add rule","Rules…","rules",".rules-editor"],
      ["Gerber drill","Fabrication Outputs…","fab",".fab-dialog"],["IPC-7351","Library: IPC Footprint Wizard…","footprint-wizard",".fw-dialog"]];
    await page.evaluate(() => {
      const h = AtriumNavHost, execute = h.executeKey;
      globalThis.pcbCommandLog = [];
      h.executeKey = (...args) => {pcbCommandLog.push(args[0]); return execute.apply(h,args);};
    });
    for (const [query,label,id,selector] of workflows) for (const prefix of ["",">"]) {
      await open(prefix+query,boardAnchor); await choose(label);
      assert.equal((await palette.locator(".nav-palette-label").allTextContents()).filter(t => t === label).length,1);
      assert.ok(await palette.getByRole("button",{name:"Run",exact:true}).isVisible());
      const n = await page.evaluate(id => pcbCommandLog.filter(v => v === id).length,id);
      if (prefix) await input.press("Enter"); else await palette.getByRole("button",{name:"Run",exact:true}).click();
      await wait(([id,n]) => pcbCommandLog.filter(v => v === id).length > n,[id,n]);
      if (id === "drc") await wait(() => /rule violation|no violations|completed|no .*violations/i.test(document.getElementById("status").textContent));
      else {
        const modal = page.locator("dialog[open]" + selector);
        await modal.getByRole("button",{name:"Close",exact:true}).last().click();
        await modal.waitFor({state:"hidden"});
      }
      assert.equal(await page.evaluate(id => pcbCommandLog.filter(v => v === id).length,id),n+1);
    }
    console.log("  DRC, rules, fabrication and IPC wizard use one menu command and Run in both query modes");

    await setDoc("drawing");
    for (const [title,field] of [["Drawing Text","texts"], ["Board Fabrication View","views"], ["Assembly View","views"], ["Bill of Materials Table","views"]]) {
      await insert(title, title, [10,10], ({doc}) => {
        const items = doc.drawing[field]; assert.ok(items.length > 0);
        assert.equal(items.at(-1).sheet,doc.drawing.sheets[0].id);
        assert.deepEqual([items.at(-1).x,items.at(-1).y], [22.7,22.7]);
      }, title === "Drawing Text" ? {Text:"Assembly instructions"} : null);
    }
    const drawingBefore = await model(), drawingHistory = await editCount();
    await open("Drawing Line",[10,10]); await commit("Drawing Line");
    await clickWorld([22,15]); await page.keyboard.press("Enter");
    await wait(n => AtriumNavHost.undoSteps().history.length > n,drawingHistory);
    const drawingLine = await page.evaluate(() => AtriumNavHost.doc().drawing.lines.at(-1));
    assert.deepEqual(drawingLine.points[0],[22.5,22.5]); // Drawing lines snap to the half-mm drawing grid.
    await page.keyboard.press("Escape"); await undo(drawingBefore,drawingHistory);
    const sheets = await page.evaluate(() => AtriumNavHost.doc().drawing.sheets.length);
    await insert("Drawing Sheet","Drawing Sheet",[10,10], ({doc}) => assert.equal(doc.drawing.sheets.length,sheets+1));
    await setDoc("panel");
    await open(">edit panel",[10,10]); await choose("Panelize…");
    assert.ok(await palette.getByRole("button",{name:"Run",exact:true}).isVisible());
    await input.press("Escape");
    for (const [title,field] of [["Add Board Row","rows"],["Add Board Column","cols"]]) {
      const n = await page.evaluate(field => AtriumNavHost.doc().panel[field],field);
      await insert(title,title,[10,10], ({doc}) => assert.equal(doc.panel[field],n+1));
    }

    await setDoc("schematic");
    for (const [kind, tool] of [["symbol","Pin"], ["footprint","Pad"]]) {
      const selector = kind === "symbol" ? "dialog.se-dialog[open]" : "dialog.fe-dialog[open]";
      await page.evaluate(kind => AtriumNavHost.act(kind + "-editor"),kind);
      const modal = page.locator(selector); await modal.waitFor();
      const baseline = await modal.evaluate(d => d.paletteSurface.objects().length);
      await open(tool,null,selector); await commit(tool);
      await wait(([selector,n]) => document.querySelector(selector).paletteSurface.objects().length === n+1,[selector,baseline]);
      const inserted = await modal.evaluate(d => d.paletteSurface.objects().at(-1).label);
      await open("@"+inserted.split(" · ")[0],null,selector); await choose(inserted); await input.press("Enter");
      await open(":3,4",null,selector); await input.press("Enter");
      await open(">Undo",null,selector); await choose("Undo"); await input.press("Enter");
      await wait(([selector,n]) => document.querySelector(selector).paletteSurface.objects().length === n,[selector,baseline]);
      await open("Rectangle",null,selector); await commit("Rectangle");
      const extent = await modal.locator("canvas").first().boundingBox();
      await modal.locator("canvas").first().click({position:{x:extent.width*.8, y:extent.height*.8}});
      await wait(selector => document.querySelector(selector).paletteSurface.commands().some(c => c.label === "Undo"),selector);
      await open(">Undo",null,selector); await choose("Undo"); await input.press("Enter");
      await modal.evaluate(d => d.close());
      console.log("  " + kind + " pin/pad, rectangle, object/coordinate jump and local Undo");
    }
    const ipc = "dialog.fw-dialog[open]";
    await page.evaluate(() => AtriumNavHost.act("footprint-wizard"));
    await page.locator(ipc).waitFor();
    const title = "Chip R / C / L (0201–2512)";
    await open("Chip R",null,ipc); await commit(title,{Package:"0603"});
    assert.equal(await page.locator(ipc).getByLabel("Preset",{exact:true}).inputValue(),"0603");
    assert.equal(await page.locator(ipc).evaluate(d => d.paletteSurface.objects().length),2);
    const beforeWizard = await model(), wizardHistory = await editCount();
    await open(">Add to library",null,ipc); await choose("Add to library"); await input.press("Enter");
    await wait(n => AtriumNavHost.undoSteps().history.length > n,wizardHistory);
    const saved = await page.evaluate(() => AtriumNavHost.project().library.at(-1));
    assert.equal(saved.footprint.pads.length,2); await undo(beforeWizard,wizardHistory);
    console.log("  IPC 0603 footprint preview, generated library definition, Undo");
    console.log("Visible palette actions passed in seven editor contexts.");
    assert.deepEqual(errors,[]);
  } catch (error) {
    console.error(await palette.isVisible() ? await palette.innerText() : await page.locator("#status").innerText());
    throw error;
  } finally {await page.close();}
}

async function checkTouch(browser, root) {
  const page = await browser.newPage({hasTouch:true,isMobile:true,viewport:{width:400,height:820},deviceScaleFactor:2});
  await require("../fixtures/notebook-labs.cjs").profile(page);
  page.setDefaultTimeout(6000);
  try {
    await page.goto(pathToFileURL(path.join(root,"app","index.html")).href);
    await page.locator("dialog.sp-dialog[open] [data-start-action=demo]").tap();
    await page.locator("#doc-name",{hasText:"Sensor board"}).waitFor();
    const anchor = await page.evaluate(async () => {
      const h = AtriumNavHost, project = Atrium.project("Touch", AtriumParts.catalogue), sheet = project.documents[0];
      sheet.grid = .25; await h.replaceProject(project,{force:true,dirty:false}); h.selectDocument(sheet.id);
      const canvas = h.canvas(), v = h.view(), box = canvas.getBoundingClientRect();
      v.restoreCamera({...v.camera(),cx:20,cy:12,scale:5}); h.redraw();
      const screen = [Math.round(box.width*.4),Math.round(box.height*.4)];
      return [box.left+screen[0],box.top+screen[1]];
    });
    await page.touchscreen.tap(...anchor);
    const plus = page.getByRole("button",{name:"Insert at pointer",exact:true});
    assert.ok((await plus.boundingBox()).height >= 44);
    await plus.evaluate(button => button.addEventListener("pointerdown", e => {
      const h = AtriumNavHost, box = h.canvas().getBoundingClientRect();
      globalThis.frozenInsertionPoint = h.snapAt(h.view().screenToWorld([e.clientX-box.left,e.clientY-box.top]));
    },{once:true}));
    await plus.tap();
    const dialog = page.locator("#palette[open]"), input = dialog.getByRole("combobox");
    await input.fill("/res 10k");
    const resistor = dialog.getByRole("option").filter({hasText:"Resistor · 10 kΩ"}).first();
    await resistor.tap();
    if (await dialog.isVisible()) await dialog.getByRole("button",{name:"Insert",exact:true}).tap();
    await page.waitForFunction(() => AtriumNavHost.doc().items.length === 1);
    const placed = await page.evaluate(() => AtriumNavHost.doc().items[0]);
    assert.deepEqual([placed.x,placed.y],await page.evaluate(() => globalThis.frozenInsertionPoint));
    assert.equal(placed.value,"10 kΩ");
    console.log("  Touch + and tap anchored resistor");
  } finally { await page.close(); }
}

if (require.main === module) (async () => {
  const {chromium} = require("../support/playwright.cjs");
  const root = process.argv[2] ? path.resolve(process.argv[2]) : path.resolve(__dirname,"../..");
  const browser = await chromium.launch({headless:true, ...(process.env.CHROME ? {executablePath:process.env.CHROME} : {channel:"chrome"})});
  try {await check(browser,root); await checkTouch(browser,root);} finally {await browser.close();}
})().catch(error => {console.error(error); process.exitCode = 1;});
module.exports = check;
