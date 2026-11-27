"use strict";
const assert = require("node:assert/strict");
const path = require("node:path");
const {pathToFileURL} = require("node:url");
const {showPanel} = require("../support/window-panels.cjs");

const app = pathToFileURL(path.join(__dirname, "../../app/index.html")).href;
async function fresh(browser, run, settings) {
  const page = await browser.newPage({viewport: {width: 1400, height: 900}});
  const errors = [];
  const legacyContractRequests = [], graphRequests = [], pcbConnectivityRequests = [];
  page.on("pageerror", error => errors.push(error.message));
  page.on("request", request => {
    if (request.url().endsWith("/automation/legacy-command-contract.js")) legacyContractRequests.push(request.url());
    if (request.url().endsWith("/ui/commit-graph.js")) graphRequests.push(request.url());
    if (request.url().endsWith("/checks/connectivity.js")) pcbConnectivityRequests.push(request.url());
  });
  page.setDefaultTimeout(8000);
  try {
    if (settings) await page.addInitScript(values => {
      localStorage.setItem("atrium.prefs", JSON.stringify({format:"atrium-prefs",version:1,values}));
    },settings);
    if (settings) await page.clock.install();
    await page.goto(app);
    await run(page, graphRequests, pcbConnectivityRequests);
    assert.deepEqual(errors, []);
    assert.deepEqual(legacyContractRequests, [], "the legacy worker catalogue stays out of the editor and its workers");
  } finally {
    await page.close();
  }
}

async function demo(page) {
  await page.locator("dialog.sp-dialog[open] [data-start-action=demo]").click();
  await page.waitForFunction(() => AtriumNavHost.doc()?.name === "Sensor board");
}

async function historyDemand(browser) {
  await fresh(browser, async (page, graphRequests) => {
    await page.locator("dialog.sp-dialog[open]").waitFor();
    // Wait for the real idle registration, including History's toolbar and status markup.
    await page.waitForFunction(() => globalThis.AtriumHistoryEntry?.status().installed);
    assert.equal(await page.locator(".hv-entry use").getAttribute("href"), "#i-history");
    for (const id of ["history", "branch", "more"])
      assert.equal(await page.locator(`.icon-bank symbol#i-${id}[data-proposed]`).count(), 1);
    assert.deepEqual(graphRequests, [], "Home needs no commit graph script");
    await demo(page);
    await page.evaluate(() => new Promise(resolve => AtriumIdle.idle(() => resolve(), {timeout:2000})));
    assert.deepEqual(graphRequests, [], "an idle editor still needs no commit graph script");
    await page.getByRole("button", {name:"History", exact:true}).click();
    await page.locator(".hv-view canvas.hv-graph").waitFor();
    assert.equal(graphRequests.length, 1, "first History use loads its graph");
    assert.ok(await page.evaluate(() => AtriumCommitGraph.lanes([{revision:"one"}]).length === 1));
  });
}

async function editingCommandDemand(browser) {
  const page = await browser.newPage({viewport:{width:1400,height:900}});
  const errors = [];
  page.on("pageerror", error => errors.push(error.message));
  try {
    await page.addInitScript(() => {
      const pending = new Map(), append = Element.prototype.append;
      const held = new Set(["pcb/smart-guides.js","schematic/sch-place.js","editor/context-menu.js"]);
      globalThis.releaseCommandModule = name => {
        const load = pending.get(name);
        if (!load) return false;
        pending.delete(name); held.delete(name); load(); return true;
      };
      Element.prototype.append = function (...nodes) {
        const source = nodes.length === 1 && nodes[0]?.getAttribute?.("src");
        if (this !== document.head || !held.has(source)) return append.apply(this,nodes);
        pending.set(source,() => append.apply(this,nodes));
      };
    });
    await page.goto(app);
    await demo(page);
    const fixture = await page.evaluate(() => {
      const h = AtriumNavHost, sheet = h.project().documents.find(doc => doc.kind === "schematic");
      const tracks = [
        {id:Atrium.id(),kind:"track",layer:"Top",width:.25,net:"",points:[[10,5],[11,5]]},
        {id:Atrium.id(),kind:"track",layer:"Top",width:.25,net:"",points:[[20,8],[21,8]]}
      ];
      h.edit(() => h.doc().items.push(...tracks));
      const ids = tracks.map(track => track.id);
      h.select(ids);
      const item = sheet.items.find(item => item.kind === "part" && !item.mirror);
      return {ids, sheet:sheet.id, symbol:item.id, def:item.def};
    });
    const xs = () => page.evaluate(ids => ids.map(id => AtriumNavHost.doc().items.find(item => item.id === id).points[0][0]),fixture.ids);
    assert.deepEqual(await xs(),[10,20]);
    const alignCold = await page.evaluate(() => {
      const cold = !globalThis.AtriumGuides;
      AtriumNavHost.act("align-left");
      return cold;
    });
    assert.equal(alignCold,true,"the first alignment dispatch waits for the guide script");
    assert.deepEqual(await xs(),[10,20]);
    await page.waitForFunction(() => releaseCommandModule("pcb/smart-guides.js"));
    await page.waitForFunction(ids => ids.every(id => AtriumNavHost.doc().items.find(item => item.id === id).points[0][0] === 10),fixture.ids);
    await page.evaluate(ids => {
      const h = AtriumNavHost;
      h.act("undo"); h.select(ids); h.act("align-right");
    },fixture.ids);
    assert.deepEqual(await xs(),[20,20],"the loaded command uses the new alignment, with normal Undo");

    await page.evaluate(async ({sheet,symbol}) => {
      const h = AtriumNavHost;
      await h.selectDocument(sheet); h.select([symbol]);
    },fixture);
    const mirrored = () => page.evaluate(id => !!AtriumNavHost.doc().items.find(item => item.id === id).mirror,fixture.symbol);
    const mirrorCold = await page.evaluate(() => {
      const cold = !globalThis.AtriumSchPlace;
      AtriumNavHost.act("mirror-x");
      return cold;
    });
    assert.equal(mirrorCold,true,"the first mirror dispatch waits for schematic placement");
    assert.equal(await mirrored(),false);
    await page.waitForFunction(() => releaseCommandModule("schematic/sch-place.js"));
    await page.waitForFunction(id => AtriumNavHost.doc().items.find(item => item.id === id)?.mirror === true,fixture.symbol);
    await page.evaluate(() => AtriumNavHost.act("mirror-x"));
    assert.equal(await mirrored(),false,"the warm command mirrors a second time");
    await page.evaluate(id => {
      const h = AtriumNavHost;
      if (!h.placeDef(h.defs().get(id),"schematic")) throw Error("Library placement did not start");
      h.executeKey("mirror-y");
    },fixture.def);
    assert.match(await page.locator("#status").textContent(),/^Mirrored vertically/);
    assert.equal(await page.evaluate(() => AtriumNavHost.tool()),"place","mirroring keeps the floating component armed");
    await page.evaluate(() => AtriumNavHost.executeKey("escape"));

    await page.setViewportSize({width:620,height:900});
    await page.evaluate(() => {
      const source = document.createElement("button");
      source.type = "button"; source.className = "revision-chip"; source.textContent = "Review baseline";
      source.onclick = () => {window.openedOverflow = (window.openedOverflow || 0) + 1;};
      document.querySelector("footer.statusbar").append(source);
    });
    const more = page.getByRole("button",{name:"More status controls",exact:true});
    assert.equal(await more.getAttribute("aria-haspopup"),"menu");
    assert.equal(await more.getAttribute("aria-expanded"),"false");
    await more.press("ArrowDown");
    assert.equal(await page.evaluate(() => !!globalThis.AtriumContextMenu),false,"the first status use waits for Context Menu");
    await page.waitForFunction(() => releaseCommandModule("editor/context-menu.js"));
    const menu = page.getByRole("menu",{name:"More status controls",exact:true});
    for (let presses = 1; presses <= 2; presses++) {
      await menu.waitFor();
      assert.equal(await more.getAttribute("aria-expanded"),"true");
      await menu.getByRole("menuitem",{name:"Review baseline",exact:true}).press("Enter");
      await menu.waitFor({state:"hidden"});
      assert.equal(await more.getAttribute("aria-expanded"),"false");
      assert.equal(await page.evaluate(() => window.openedOverflow),presses);
      if (presses === 1) await more.click();
    }
    assert.deepEqual(errors,[]);
    console.log("PASS cold and warm alignment, mirror placement and status overflow commands");
  } finally {await page.close();}
}

async function physicalConnectivityDemand(browser) {
  const cold = page => page.evaluate(() => typeof globalThis.AtriumConnectivity === "undefined");
  await fresh(browser, async (page, _graphRequests, requests) => {
    await page.locator("dialog.sp-dialog[open]").waitFor();
    console.log("Welcome PCB connectivity requests:",requests.length);
    assert.equal(await cold(page),true,"Welcome does not load the physical PCB solver");
    assert.equal(requests.length,0);
    assert.equal(await page.evaluate(async () => {
      const h = AtriumNavHost, p = Atrium.project("Schematic only",[]);
      const sheet = p.documents[0], id = Atrium.id();
      p.documents = [sheet];
      sheet.items.push({kind:"wire",id,points:[[0,0],[5,0]]},
        {kind:"netlabel",id:Atrium.id(),x:0,y:0,text:"DEMAND"});
      await h.replaceProject(p,{force:true,dirty:false});
      return Atrium.connectivity(h.doc(),h.defs()).byWire.get(id);
    }),"DEMAND","the schematic connectivity compiler is available without the PCB solver");
    await page.waitForFunction(() => !!globalThis.AtriumEditorDemand);
    await page.evaluate(() => new Promise(resolve => AtriumIdle.idle(resolve,{timeout:1000})));
    assert.equal(await cold(page),true,"opening only a schematic keeps PCB connectivity cold");
    assert.equal(requests.length,0);

    // A project with a dormant board still supports synchronous activation.
    assert.equal(await page.evaluate(async () => {
      const h = AtriumNavHost, p = Atrium.project("Schematic and dormant board",[]);
      await h.replaceProject(p,{force:true,starter:true,dirty:false});
      return h.doc().kind;
    }),"schematic");
    assert.equal(requests.length,1);
    const dormant = await page.evaluate(() => {
      const h = AtriumNavHost, board = h.project().documents.find(doc => doc.kind === "pcb");
      h.selectDocument(board.id);
      const graph = h.connections();
      return {kind:h.doc().kind, empty:graph.airwires.length};
    });
    assert.deepEqual(dormant,{kind:"pcb",empty:0});
    console.log("PCB connectivity requests: Welcome 0, schematic-only 0, dormant PCB project 1");
  });

  for (const action of ["add-pcb","new"]) {
    await fresh(browser, async (page, _graphRequests, requests) => {
      await page.locator("dialog.sp-dialog[open]").waitFor();
      await page.evaluate(async () => {
        const p = Atrium.project("Schematic only",[]);
        p.documents = [p.documents[0]];
        await AtriumNavHost.replaceProject(p,{force:true,dirty:false});
      });
      await page.evaluate(action => AtriumNavHost.executeKey(action),action);
      const title = action === "add-pcb" ? "Add PCB layout" : "New project";
      await page.locator("dialog[open]").getByRole("textbox",{name:title,exact:true}).waitFor();
      assert.equal(requests.length,0,"the dialog opens while physical connectivity is cold");
      await page.locator("dialog[open]").getByRole("button",{name:action === "add-pcb" ? "Add" : "Apply",exact:true}).click();
      await page.waitForFunction(action => {
        const h = AtriumNavHost;
        return action === "add-pcb" ? h.doc().kind === "pcb" : h.project().name === "Untitled";
      },action);
      assert.equal(requests.length,1);
      assert.equal(await page.evaluate(() => {
        const h = AtriumNavHost, board = h.project().documents.find(doc => doc.kind === "pcb");
        h.selectDocument(board.id);
        return h.connections()?.airwires.length;
      }),0,"the new board can synchronously read its physical connectivity");
    });
  }
  console.log("PASS Add PCB and New Project load the solver after confirmation from a schematic-only project");

  const page = await browser.newPage({viewport:{width:1400,height:900}}), errors = [], requests = [];
  page.on("pageerror",e => errors.push(e.message));
  page.on("request",request => {if (request.url().endsWith("/checks/connectivity.js")) requests.push(request.url());});
  try {
    await page.addInitScript(() => {
      const append = Element.prototype.append;
      Element.prototype.append = function (...nodes) {
        if (this !== document.head || nodes[0]?.getAttribute?.("src") !== "checks/connectivity.js")
          return append.apply(this,nodes);
        globalThis.releasePhysicalConnectivity = () => {
          Element.prototype.append = append;
          append.apply(this,nodes);
        };
      };
    });
    await page.goto(app);
    await page.locator("dialog.sp-dialog[open] [data-start-action=demo]").click();
    await page.waitForFunction(() => !!globalThis.releasePhysicalConnectivity);
    assert.equal(await cold(page),true,"PCB publication awaits the solver");
    assert.equal(await page.evaluate(() => AtriumNavHost.doc().kind),"schematic");
    await page.evaluate(() => {
      const L = AtriumLazy;
      globalThis.concurrentConnectivity = Promise.all([
        L.need("AtriumConnectivity"), L.need("AtriumConnectivityLive"), L.need("AtriumConnectivity")
      ]);
      releasePhysicalConnectivity();
    });
    await page.waitForFunction(() => AtriumNavHost.doc().name === "Sensor board");
    const identity = await page.evaluate(async () => {
      const [base,live,second] = await concurrentConnectivity;
      const h = AtriumNavHost, graph = h.connections(), exact = base.inspectFull(h.doc(),h.defs());
      return {oneBase:base === second && base === AtriumConnectivity, live:live === AtriumConnectivityLive,
        synchronous:Array.isArray(graph.airwires), nets:graph.nets.length,
        same:JSON.stringify([graph.nets,graph.shorts,graph.airwires]) === JSON.stringify([exact.nets,exact.shorts,exact.airwires])};
    });
    assert.equal(identity.oneBase,true);
    assert.equal(identity.live,true);
    assert.equal(identity.synchronous,true);
    assert.ok(identity.nets > 0);
    assert.equal(identity.same,true,"the first explicit graph matches the full physical inspection");
    assert.equal(requests.length,1,"direct, live and workbench consumers share one actual load");
    assert.deepEqual(errors,[]);
    console.log("PASS first PCB waits for one shared physical solver and returns the exact synchronous graph");
  } finally {await page.close();}
}

async function diffConnectivityRetry(browser) {
  await fresh(browser, async (page, _graphRequests, requests) => {
    await page.locator("dialog.sp-dialog[open]").waitFor();
    await page.evaluate(async () => {
      const host = AtriumNavHost, p = Atrium.project("Schematic only",[]);
      p.documents = [p.documents[0]];
      await host.replaceProject(p,{force:true,dirty:false});
      const before = AtriumParts.example(), after = structuredClone(before);
      const board = after.documents.find(doc => doc.kind === "pcb");
      board.items.find(item => item.kind === "track").width += .05;
      const view = await AtriumLazy.need("AtriumDiffView");
      await view.start({project:before},{project:after},{doc:board.id});
      const model = view.session().model, run = model.drcDelta;
      globalThis.diffConnectivityRuns = 0;
      model.drcDelta = (...args) => { globalThis.diffConnectivityRuns++; return run(...args); };
      const head = document.head, append = head.append;
      head.append = function (...nodes) {
        if (nodes[0]?.getAttribute?.("src") !== "checks/connectivity.js") return append.apply(this,nodes);
        head.append = append;
        globalThis.rejectDiffConnectivity = () => nodes[0].dispatchEvent(new Event("error"));
      };
    });
    assert.equal(requests.length,0,"reviewing revisions keeps physical connectivity cold until DRC");
    const chip = page.locator(".dv-drc"), dialog = page.getByRole("dialog",{name:"DRC delta",exact:true});
    await chip.click();
    await page.waitForFunction(() => !!globalThis.rejectDiffConnectivity);
    await dialog.getByText(/Running the design rule check/).waitFor();
    await page.evaluate(() => rejectDiffConnectivity());
    await page.waitForFunction(() => !AtriumLazy.pending("AtriumConnectivity"));
    await dialog.waitFor({state:"hidden"});
    assert.equal(await chip.textContent(),"DRC Δ","the DRC chip offers a retry after a failed script");
    assert.equal(await page.evaluate(() => diffConnectivityRuns),0,"DRC does not run on a partial dependency set");
    await chip.click();
    await dialog.getByRole("heading",{name:/New violations/}).waitFor();
    assert.equal(await page.evaluate(() => diffConnectivityRuns),1);
    assert.equal(requests.length,1,"the retry loads the physical solver and runs the requested comparison");
    console.log("PASS comparison DRC waits for physical connectivity and retries a failed load");
  });
}

module.exports = async browser => {
  await historyDemand(browser);
  await editingCommandDemand(browser);
  await physicalConnectivityDemand(browser);
  await diffConnectivityRetry(browser);
  for (const efficiency of ["off", "always"]) {
    await fresh(browser, async page => {
      await page.locator("dialog.sp-dialog[open]").waitFor();
      // Deliver any accidental idle task scheduled in the original 2.2 s window.
      await page.clock.runFor(2200);
      const cold = await page.evaluate(() => {
        const names = ["AtriumPCBEdit", "AtriumPCBPours", "AtriumNetsPanel", "AtriumWireEdit", "AtriumDock",
          "AtriumExtensions", "AtriumSurfaceMotion", "AtriumSchFields", "AtriumTabDrop", "AtriumTooltip", "AtriumRevisionsUI"];
        return {loaded:names.filter(name => globalThis[name]), efficiency:AtriumPower.mode()};
      });
      assert.deepEqual(cold, {loaded:[],efficiency});
      // Escape is the first workbench action. It waits for the workbench's editing
      // services, including the saved selection filter and snap state.
      await page.keyboard.press("Escape");
      await page.locator("dialog.sp-dialog[open]").waitFor({state:"hidden"});
      assert.equal(await page.evaluate(() => typeof AtriumPCBEdit.install), "function");
      assert.equal(await page.evaluate(() => typeof AtriumWireEdit.begin), "function");
      assert.equal(await page.evaluate(() => typeof AtriumTooltip.dismiss), "function", "the visible workbench has canvas hover and managed tooltips");
      await page.getByRole("tab", {name:"Board layout"}).click();
      assert.equal(await page.evaluate(() => !!globalThis.AtriumNetsPanel), false);
      await page.locator("#canvas").focus();
      await page.keyboard.press("F5");
      await page.waitForFunction(() => globalThis.AtriumNetsPanel?.override() === false);
      await showPanel(page, "nets");
      await page.getByRole("grid", {name:"Nets", exact:true}).waitFor();
    }, {"general.efficiency":efficiency});
  }

  await fresh(browser, async page => {
    await page.evaluate(() => {
      const editor = AtriumNavHost, prepare = editor.prepareWorkbench;
      const ready = new Promise(resolve => {window.releaseWorkbench = resolve;});
      editor.prepareWorkbench = (...args) => ready.then(() => prepare(...args));
    });
    await page.getByRole("button", {name:"Continue to editor",exact:true}).click();
    await page.keyboard.press("F1");
    assert.equal(await page.evaluate(() => !!globalThis.AtriumPCBEdit), false);
    await page.evaluate(() => window.releaseWorkbench());
    await page.locator("#palette[open] [role=option]").first().waitFor();
  });

  await fresh(browser, async page => {
    await demo(page);
    const position = await page.evaluate(() => {
      if (globalThis.AtriumCrossProbe) throw Error("Cross Probe is already loaded");
      const h = AtriumNavHost;
      const board = h.doc(), sheet = h.project().documents.find(d => d.kind === "schematic");
      const rect = h.canvas().getBoundingClientRect();
      for (const part of board.items.filter(i => i.kind === "part" && i.link)) {
        const other = sheet.items.find(i => i.kind === "part" && part.link === i.link);
        const [x, y] = h.view().worldToScreen([part.x, part.y]);
        const px = rect.left + x, py = rect.top + y;
        if (other && h.hit(h.canvas(), px, py)?.item?.id === part.id) return {px, py, item: other.id, document: sheet.id};
      }
      throw Error("No visible sample component has a matching schematic symbol");
    });
    const modifier = await page.evaluate(() => AtriumKeymap.mac ? "Meta" : "Control");
    await page.keyboard.down(modifier);
    try {
      await page.mouse.dblclick(position.px, position.py);
    } finally {
      await page.keyboard.up(modifier);
    }
    await page.waitForFunction(({item, document}) => AtriumNavHost.doc().id === document && AtriumNavHost.selection().includes(item), position);
  });

  await fresh(browser, async page => {
    await demo(page);
    const tools = page.locator('.work-menu[data-menu="tools"]');
    await tools.locator("summary").click();
    const crossSelect = tools.locator('[data-action="cross-select"]');
    assert.equal(await crossSelect.getAttribute("data-checked"), "false");
    assert.equal(await page.evaluate(() => !!globalThis.AtriumCrossProbe), false);
    await crossSelect.click();
    await page.waitForFunction(() => globalThis.AtriumCrossProbe?.crossSelect());
    assert.equal(await crossSelect.getAttribute("data-checked"), "true");
    assert.equal(await page.evaluate(() => !!globalThis.AtriumWindowedTable), false);
    await showPanel(page, "nets");
    await page.getByRole("grid", {name: "Nets", exact: true}).waitFor();
    await page.waitForFunction(() => !!document.querySelector(".nets-table tbody tr[data-r]"));

    await page.reload();
    await page.waitForFunction(() => globalThis.AtriumCrossProbe?.crossSelect());
    assert.equal(await crossSelect.getAttribute("data-checked"), "true", "startup restores the saved Cross Select mode");
  });

  await fresh(browser, async page => {
    const open = page.locator("dialog.sp-dialog[open]").getByRole("button", {name:"Open…", exact:true});
    await open.waitFor();
    assert.deepEqual(await page.evaluate(() => [typeof AtriumIO.pickFile, typeof AtriumIO.read]), ["function", "undefined"]);
    const picker = page.waitForEvent("filechooser");
    await open.click();
    await (await picker).setFiles(path.join(__dirname, "../fixtures/altium/pidp11-io-expander/PiDP11IOExpander.SchDoc"));
    await page.waitForFunction(() => {
      const project = AtriumNavHost.project();
      return project.name === "PiDP11IOExpander" && project.documents.some(d => d.kind === "schematic" && d.items.length > 10);
    });
    assert.deepEqual(await page.evaluate(() => [typeof AtriumIO.pickFile, typeof AtriumIO.read]), ["function", "function"]);
  });
  for (const enabled of [false, true]) {
    await fresh(browser, async page => {
      await page.getByRole("button", {name: "Continue to editor", exact: true}).click();
      await page.evaluate(async enabled => {
        const prefs = await AtriumLazy.need("AtriumPrefs");
        prefs.set("butter.numericFields", enabled);
        prefs.open("pcb");
      }, enabled);
      const grid = page.locator("dialog.prf-dialog[open] .prf-stepper #prf-pcb-grid");
      await grid.waitFor();
      assert.equal(await grid.getAttribute("type"), "number");
      assert.equal(await grid.inputValue(), "0.25");
      const next = await grid.evaluate(input => {
        const native = input.cloneNode();
        native.value = input.value;
        native.stepUp();
        return native.valueAsNumber;
      });
      assert.equal(await page.evaluate(() => !!globalThis.AtriumNumericFields), false, "the first Preferences numeric focus starts cold");
      await grid.evaluate(input => input.addEventListener("focusin", event => {
        window.firstGridFocus = {
          trusted: event.isTrusted, type: input.type, start: input.selectionStart, end: input.selectionEnd
        };
      }, {once: true}));
      await grid.click();
      await page.waitForFunction(() => !!globalThis.AtriumNumericFields);
      const focused = await page.evaluate(() => window.firstGridFocus);
      assert.equal(focused.trusted, true);
      assert.equal(focused.type, "text");
      if (enabled) {
        assert.deepEqual([focused.start, focused.end], [0, 4], "opt-in selects the existing value for expression entry");
        await grid.pressSequentially("0.1 mm + 0.2 mm");
        assert.equal(await grid.inputValue(), "0.1 mm + 0.2 mm");
        await grid.press("Enter");
        await page.waitForFunction(() => AtriumPrefs.get("pcb.grid") === .3);
        assert.equal(await grid.getAttribute("type"), "number", "expression commit restores the native number control");
      } else {
        assert.equal(focused.start, focused.end, "the default stepper has a text caret after its first click");
        await grid.press("ArrowUp");
        await page.waitForFunction(next => AtriumPrefs.get("pcb.grid") === next, next);
      }
    });
  }
  console.log("PASS cold Welcome in both power modes, Escape to editor, F5 net colours, and Nets through Window");
  console.log("PASS default Preferences caret and opted-in numeric entry on the first click");
  console.log("PASS cold Cross Probe gesture, Cross Select menu, Nets table, and Altium file open");
};

module.exports.historyDemand = historyDemand;

module.exports.editingCommandDemand = editingCommandDemand;

module.exports.physicalConnectivityDemand = physicalConnectivityDemand;

module.exports.diffConnectivityRetry = diffConnectivityRetry;
