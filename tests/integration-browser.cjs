"use strict";

// Real Chromium smoke test with an isolated profile. Requires playwright-core and an installed
// Chrome/Chromium. Run: node tests/integration-browser.cjs [--executable PATH] [--snapshot PATH]
// The Demo workflow can also write its shared capture with --performance-snapshot PATH.
// Use --group NAME for a complete group (listed by --list-groups) or a CI subgroup
// (listed by --list-ci-groups), or a --*-only switch for one check.
const assert=require("node:assert/strict");
const fs=require("node:fs/promises");
const path=require("node:path");
const {pathToFileURL}=require("node:url");
const {chromium,errors:{TimeoutError}}=require("playwright-core");
const {windowPanel,showPanel}=require("./support/window-panels.cjs");
const {readProjectZIP}=require("./support/browser-native-project.cjs");
const {projectFromRecords}=require("./support/native-cad.cjs");

// Retry readiness observations in place. The action that produced the state and
// any assertions about it run once, so the same page retains any errors.
async function retryWait(wait){
  try{return await wait();}
  catch(error){
    if(!(error instanceof TimeoutError))throw error;
    console.log("browser readiness retry after "+error.message.split("\n")[0]);
    return wait();
  }
}
const waitFor=(locator,options)=>retryWait(()=>locator.waitFor(options));
const waitForFunction=(page,check,arg,options)=>retryWait(()=>page.waitForFunction(check,arg,options));

function arg(name){
  const i=process.argv.indexOf(name);
  if(i<0)return undefined;
  assert.ok(process.argv[i+1] && !process.argv[i+1].startsWith("--"),"missing value for "+name);
  return path.resolve(process.argv[i+1]);
}

async function keyboardProfiles(browser){
  const page=await browser.newPage({viewport:{width:1400,height:960}});
  const errors=[],engineRequests=[];
  page.on("pageerror",e=>errors.push(e.message));
  page.on("request",r=>{if(/\/engine-(core|mvp|simd128)\.js$/.test(r.url()))engineRequests.push(r.url());});
  page.setDefaultTimeout(6000);
  try{
    await page.goto(pathToFileURL(path.join(__dirname,"..","app","index.html")).href);
    await page.locator("dialog.sp-dialog[open] [data-start-action=demo]").click();
    await waitFor(page.locator("#doc-name").filter({hasText:"Sensor board"}));
    await page.evaluate(async()=>{
      await AtriumLazy.need(["AtriumKeymapPresets","AtriumPalette","AtriumVSKeys","AtriumCamera","AtriumPrefs"]);
    });
    const primary=await page.evaluate(()=>AtriumKeymap.mac?"Meta":"Control");
    const press=key=>page.keyboard.press(key.replace(/^Mod\+/,primary+"+"));
    const focus=()=>page.locator("#canvas").focus();
    const tool=name=>waitForFunction(page,name=>AtriumNavHost.tool()===name,name);
    const editor=async kind=>{await page.locator(`#document-tabs [data-kind=${kind}]:visible`).first().click();await focus();};
    const profile=async name=>{
      await page.evaluate(name=>{AtriumKeymap.setPreset(name);AtriumNavHost.act("select");},name);
      await focus();
    };
    const chain=async(...keys)=>{for(const key of keys)await press(key);};
    const palette=page.locator("dialog.nav-palette[open]");

    await profile("altium");
    await editor("pcb");
    const [anchor,other]=await page.evaluate(()=>{
      if(globalThis.AtriumRouter)throw Error("Expected the board to open with the router still cold.");
      const head=document.head,append=head.append.bind(head),held=[];
      const routerFiles=new Set(["pcb/router.js","pcb/diffpair.js","pcb/route-feel.js","pcb/drag-reroute.js"]);
      head.append=(...nodes)=>{
        for(const node of nodes){
          if(node.tagName==="SCRIPT"&&routerFiles.has(node.getAttribute("src")))held.push(node);
          else append(node);
        }
      };
      globalThis.releaseRouterScripts=()=>{delete head.append;append(...held);};
      const H=AtriumNavHost,b=H.canvas().getBoundingClientRect();
      AtriumCamera.takeCamera(H.view());
      return [[b.left+b.width*.44,b.top+b.height*.48],[b.left+b.width*.57,b.top+b.height*.53]];
    });
    const conflict=()=>press("Shift+KeyR");
    const routeState=()=>page.evaluate(()=>{
      const s=AtriumNavHost.routeSessionNow();
      return s?{mode:s.state.mode,net:s.state.net,...s.anchor()}:null;
    });
    const exitRoute=async()=>{await press("Escape");await press("Escape");await tool("select");};
    await chain("p","t");await tool("route");
    await page.mouse.click(...other);
    await conflict();
    assert.equal(await routeState(),null);
    await press("Escape");await tool("select");
    await chain("p","t");await tool("route");
    await conflict();
    await page.mouse.click(...anchor);
    await page.mouse.move(...other);
    assert.equal(await routeState(),null);
    await page.evaluate(()=>releaseRouterScripts());
    await waitForFunction(page,()=>!!AtriumNavHost.routeTool());
    const coldRoute=await routeState();
    assert.equal(coldRoute.mode,"push","only the active cold route keeps its Shift+R");
    await exitRoute();
    await chain("p","t");await tool("route");
    await page.mouse.click(...anchor);
    assert.deepEqual(await routeState(),coldRoute,"the queued click anchors the same route as a warm click");
    await exitRoute();

    const modes=["walkaround","push","hug","stop","ignore"];
    const advance=mode=>modes[(modes.indexOf(mode)+1)%modes.length];
    let mode="push";
    for(const [name,keys] of [
      ["altium",["p","t"]],["classic",["w"]],["kicad",["x"]],["vscode",["w"]],
      ["allegro",["F3"]],["modern",["r"]],["rts",["p","t"]]
    ]){
      await profile(name);
      await chain(...keys);await tool("route");
      await conflict();mode=advance(mode);
      await page.mouse.click(...anchor);
      assert.equal((await routeState())?.mode,mode,name+" arms the first anchor in "+mode);
      for(let i=0;i<modes.length;i++){
        await conflict();mode=advance(mode);
        assert.equal((await routeState())?.mode,mode,name+" cycles the live route to "+mode);
      }
      await exitRoute();
    }
    assert.deepEqual(engineRequests,[],"Home, opening the board and interactive routing leave WASM unloaded");

    await profile("altium");
    await editor("schematic");
    await chain("p","w");await tool("route");await press("Escape");
    await press("Control+m");await tool("measure");await press("Escape");
    await press("Control+w");await tool("route");await press("Escape");

    await profile("classic");
    await editor("pcb");
    await press("Mod+d");
    await waitFor(page.locator('#inspector details[open] > summary[data-t="Layers"]'));

    await profile("kicad");
    await press("x");await tool("route");await press("Escape");
    await editor("schematic");
    await press("w");await tool("route");await press("Escape");

    await profile("vscode");
    await press("Mod+p");await waitFor(palette);
    await press("Escape");
    const docId=await page.evaluate(()=>AtriumNavHost.currentId());
    await press("Mod+w");
    await waitForFunction(page,id=>AtriumNavHost.currentId()!==id,docId);
    await press("Mod+Shift+t");
    await waitForFunction(page,id=>AtriumNavHost.currentId()===id,docId);

    await profile("allegro");
    await editor("pcb");
    await press("F3");await tool("route");
    await press("F6");await tool("select");
    const scale=await page.evaluate(()=>AtriumNavHost.view().camera().scale);
    await press("F11");await waitForFunction(page,scale=>AtriumNavHost.view().camera().scale>scale,scale);

    await profile("modern");
    await press("t");await tool("label");await press("Escape");
    await editor("schematic");
    await press("t");await waitFor(page.getByRole("dialog",{name:"Place text",exact:true}));await press("Escape");
    await focus();await press("Mod+Shift+p");await waitFor(palette);
    await press("Mod+s");assert.equal(await palette.count(),1,"ordinary palette opening does not start a Modern chord");
    await press("Escape");await focus();
    await press("Mod+k");await palette.waitFor();await press("Mod+s");
    await waitFor(page.getByRole("dialog",{name:"Keyboard shortcuts editor",exact:true}));
    await press("Escape");

    await profile("rts");
    const y=await page.evaluate(()=>AtriumNavHost.view().camera().cy);
    await press("w");await waitForFunction(page,y=>AtriumNavHost.view().camera().cy!==y,y);
    await chain("p","w");await tool("route");await press("Escape");

    await profile("altium");
    const units=()=>page.evaluate(()=>AtriumNavHost.units());
    const initialUnits=await units();
    await page.evaluate(()=>{
      AtriumKeymap.setBindings("toggle-units",["Mod+C"]);
      window.__keyTestCopies=0;
      document.addEventListener("copy",()=>window.__keyTestCopies++);
    });
    await press("Mod+c");
    assert.notEqual(await units(),initialUnits,"custom keyboard binding overrides browser copy on canvas");
    const copies=()=>page.evaluate(()=>window.__keyTestCopies);
    assert.equal(await copies(),0);
    await page.evaluate(()=>{
      AtriumKeymap.resetCommand("toggle-units");AtriumKeymap.setBindings("copy",[]);
    });
    await press("Mod+c");assert.equal(await copies(),0,"removing Copy disables its design shortcut");
    await page.evaluate(()=>{
      AtriumKeymap.setBindings("toggle-units",["Mod+Alt+Left","Mod+Z"]);
      document.querySelector("#current-document-tab").focus();
    });
    await press("Mod+Alt+ArrowLeft");assert.equal(await units(),initialUnits,"tab focus preserves a modified arrow shortcut");
    await page.evaluate(()=>{
      const input=document.createElement("input");input.id="keymap-test-input";
      document.body.append(input);input.focus();
    });
    // One native insertion creates one undo unit regardless of how browser timers group keystrokes.
    await page.keyboard.insertText("text");await press("Mod+z");
    assert.equal(await page.locator("#keymap-test-input").inputValue(),"");
    assert.equal(await units(),initialUnits,"editing text retains native undo");

    await editor("pcb");
    const reference=page.locator("dialog.kcs-dialog[open]");
    const scope=reference.getByRole("combobox",{name:"Shortcut scope"});
    const search=reference.getByRole("searchbox",{name:"Filter shortcuts"});
    const row=id=>reference.locator('.kcs-row[data-q*="'+id+'"]');
    assert.equal(await page.locator('.work-menu[data-menu="help"] [data-action="cheatsheet"]').count(),0);
    await page.evaluate(()=>document.querySelector('.work-menu[data-menu="help"] [data-action="shortcuts"]').click());
    await reference.waitFor();
    assert.equal(await scope.inputValue(),"pcb");
    assert.ok(await row("pcb-arc-center").count()>0);
    assert.equal(await row("sch-power").count(),0);
    await search.fill("sch-power");
    assert.equal(await reference.locator(".kcs-row:visible").count(),0);
    await scope.selectOption("schematic");
    assert.equal(await row("pcb-arc-center").count(),0);
    await row("sch-power").first().waitFor();
    await reference.getByRole("button",{name:"Customise…",exact:true}).click();
    const custom=page.getByRole("dialog",{name:"Keyboard shortcuts editor",exact:true});
    assert.equal(await custom.getByRole("combobox",{name:"Context"}).inputValue(),"schematic");
    await custom.getByRole("button",{name:"Done",exact:true}).click();
    await focus();
    await press("Mod+Shift+/");
    await reference.waitFor();
    await reference.getByRole("button",{name:"Close keyboard shortcuts"}).click();
    await reference.waitFor({state:"hidden"});
    await press("Mod+Shift+/");
    await reference.waitFor();
    await press("Escape");
    await reference.waitFor({state:"hidden"});
    await page.evaluate(()=>AtriumPrefs.set("keyboard.peekCheatsheet",true));
    await page.keyboard.down(primary);
    await reference.waitFor();
    await page.keyboard.up(primary);
    await reference.waitFor({state:"hidden"});
    assert.deepEqual(errors,[]);
    console.log("PASS real browser shortcuts for all seven profiles, cold first anchor, routing modes, Modern palette chords, custom bindings and native text undo");
  }finally{await page.close();}
  await require("./schematic/browser-wire-finish.cjs")(browser);
}

async function extensionPackages(browser){
  for(const mode of ["auto","always"]){
    const page=await browser.newPage(),sources=[],remote=[],errors=[];
    page.setDefaultTimeout(8000);
    page.on("request",r=>{
      if(/\/extensions\/(?:bundled\.js|packages\/[^/]+\.js)$/.test(r.url()))sources.push(r.url().split("/").at(-1));
      if(/^https?:/.test(r.url()))remote.push(r.url());
    });
    page.on("pageerror",e=>errors.push(e.message));
    try{
      await page.addInitScript(mode=>{
        if(window!==window.top)return;
        localStorage.setItem("atrium.prefs",JSON.stringify({format:"atrium-prefs",version:1,values:{"general.efficiency":mode}}));
      },mode);
      await page.goto(pathToFileURL(path.join(__dirname,"..","app","index.html")).href);
      await waitForFunction(page,()=>globalThis.AtriumStartPage?.isOpen());
      assert.equal(await page.evaluate(()=>!!globalThis.AtriumExtensions),false,"Welcome keeps the runtime cold on a fresh profile");
      assert.deepEqual(sources,[],"Welcome requests no extension packages");
      await page.getByRole("button",{name:"Continue to editor",exact:true}).click();
      await waitForFunction(page,()=>!AtriumStartPage.isOpen()&&globalThis.AtriumExtensions?.attached);
      assert.deepEqual(await page.evaluate(()=>[AtriumPower.mode(),AtriumExtensions.workers.length,
        !!AtriumKeymap.command("ai.askSelection"),AtriumExtensions.commands().some(c=>c.id==="calculators.show")]),[mode,0,true,true]);
      assert.deepEqual(sources,[],"the workbench registers commands without reading inactive extension source");
      if(mode==="always"){
        await page.evaluate(()=>{
          const head=document.head,append=head.append;
          head.append=function(...nodes){
            const script=nodes.find(n=>n.tagName==="SCRIPT"&&n.src.endsWith("/extensions/packages/waffle.calculators.js"));
            if(!script)return append.apply(this,nodes);
            delete head.append;
            queueMicrotask(()=>script.onerror(new Event("error")));
          };
        });
        await assert.rejects(page.evaluate(()=>AtriumExtensions.execute("calculators.compute","track",{current:1})),/Couldn't load the built-in extension/);
        assert.equal(await page.evaluate(()=>AtriumExtensions.workers.length),0,"failed source load starts no worker");
      }
      await page.evaluate(()=>AtriumExtensions.execute("calculators.show"));
      const panel=page.locator(".panel-calc:visible"),picker=panel.getByRole("combobox",{name:"Calculator",exact:true});
      assert.equal(await panel.count(),1,"the legacy command opens one native calculator panel");
      await require("./analysis/browser-calculators.js").assertCatalog(picker);
      assert.ok(await picker.evaluate(node=>node===document.activeElement),"the native calculator picker receives focus");
      await picker.selectOption({label:"Voltage divider"});
      await panel.getByRole("textbox",{name:"Input voltage V",exact:true}).fill("9");
      await panel.getByRole("textbox",{name:"Upper resistor Ω",exact:true}).fill("2000");
      await panel.getByRole("textbox",{name:"Lower resistor Ω",exact:true}).fill("1000");
      await panel.locator(".calc-results").getByText("3 V",{exact:true}).waitFor();
      assert.deepEqual(await panel.locator(".calc-results td").allTextContents(),["3 V","3 mA"]);
      await picker.selectOption({label:"LED series resistor"});
      await panel.getByRole("textbox",{name:"Supply voltage V",exact:true}).fill("12");
      await panel.getByRole("textbox",{name:"Forward voltage V",exact:true}).fill("2");
      await panel.getByRole("textbox",{name:"LED current mA",exact:true}).fill("20");
      await panel.locator(".calc-results").getByText("500 Ω",{exact:true}).waitFor();
      assert.deepEqual(await panel.locator(".calc-results td").allTextContents(),["500 Ω","200 mW"]);
      assert.deepEqual(sources,[],"opening the view never activates a script worker");
      assert.equal(await page.evaluate(()=>AtriumExtensions.workers.length),0,"opening and using native forms starts no extension worker");
      const amps=await page.evaluate(async()=>(await AtriumExtensions.execute("calculators.compute","via",{drill:.3,plating:25,rise:10})).current);
      assert.ok(Math.abs(amps-1.9)<.05,"the offline script API still runs");
      assert.deepEqual(sources,["waffle.calculators.js"]);
      assert.deepEqual(remote,[]);
      assert.deepEqual(errors,[]);
    }finally{await page.close();}
  }
  await installedExtensionStartup(browser);
  await require("./extensions/browser-extension-themes.js")(browser);
  console.log("PASS cold extension runtime at Welcome, installed activation, offline first use and load retry");
}

async function installedExtensionStartup(browser){
  const page=await browser.newPage(),errors=[];
  page.setDefaultTimeout(8000);
  page.on("pageerror",e=>errors.push(e.message));
  try{
    await page.addInitScript(()=>{
      if(window!==window.top)return;
      localStorage.setItem("atrium.prefs",JSON.stringify({format:"atrium-prefs",version:1,
        values:{"general.efficiency":"always","general.startPage":"always"}}));
    });
    await page.goto(pathToFileURL(path.join(__dirname,"..","app","index.html")).href);
    await page.getByRole("button",{name:"Continue to editor",exact:true}).click();
    await waitForFunction(page,()=>!AtriumStartPage.isOpen()&&globalThis.AtriumExtensions?.attached);
    const activations=[
      ["startup","onStartup",[]],
      ["command","onCommand:startup.command",[{key:"Alt+Shift+F7",command:"startup.command"}]],
      ["board","onDocumentKind:pcb",[]]
    ];
    for(const [name,event,keybindings] of activations){
      const command="startup."+name;
      const manifest={id:"test.startup-"+name,name:"Startup "+name,version:"1.0.0",apiVersion:1,main:"main.js",
        activationEvents:[event],permissions:["ui:command"],contributes:{commands:[{command,title:"Run "+name}],keybindings}};
      const files={"waffle-extension.json":JSON.stringify(manifest),
        "main.js":`exports.activate = api => {api.commands.register(${JSON.stringify(command)}, () => "ran");};`};
      const install=page.evaluate(files=>AtriumExtensions.install(files).then(record=>record.id),files);
      await page.locator("dialog.ext-prompt[open]").getByRole("button",{name:"Install",exact:true}).click();
      assert.equal(await install,manifest.id);
    }
    await page.reload();
    await waitForFunction(page,()=>globalThis.AtriumStartPage?.isOpen()&&
      globalThis.AtriumExtensions?.list().some(row=>row.id==="test.startup-startup"&&row.status==="active"));
    assert.deepEqual(await page.evaluate(()=>AtriumExtensions.list().filter(row=>row.id.startsWith("test.startup-"))
      .map(row=>[row.id,row.status])),[
      ["test.startup-startup","active"],["test.startup-command","inactive"],["test.startup-board","inactive"]
    ]);
    assert.equal(await page.evaluate(()=>AtriumExtensions.execute("startup.startup")),"ran");

    // The board becomes active by loading the demo directly from Welcome.
    await page.locator("dialog.sp-dialog[open] [data-start-action=demo]").click();
    await waitForFunction(page,()=>AtriumNavHost.doc().kind==="pcb"&&!AtriumStartPage.isOpen()&&
      AtriumExtensions.list().some(row=>row.id==="test.startup-board"&&row.status==="active"));
    assert.equal(await page.evaluate(()=>AtriumExtensions.execute("startup.board")),"ran");
    assert.equal(await page.evaluate(()=>AtriumExtensions.list().find(row=>row.id==="test.startup-command").status),"inactive");
    await page.locator("#canvas").focus();
    await page.keyboard.press("Alt+Shift+F7");
    await waitForFunction(page,()=>AtriumExtensions.list().some(row=>row.id==="test.startup-command"&&row.status==="active"));
    assert.equal(await page.evaluate(()=>AtriumExtensions.execute("startup.command")),"ran");
    assert.deepEqual(errors,[]);
  }finally{await page.close();}
}

async function firstUseDialogs(browser){
  await require("./library/browser-component-demand.js")(browser);
  await require("./library/browser-library-drag.cjs")(browser);
  await require("./formats/browser-step-worker.cjs")(browser);
  const prefsPage=await browser.newPage(),errors=[];
  let releaseSettings;
  const settingsReady=new Promise(resolve=>{releaseSettings=resolve;});
  try{
    prefsPage.setDefaultTimeout(6000);
    prefsPage.on("pageerror",e=>errors.push(e.message));
    await prefsPage.addInitScript(()=>localStorage.setItem("atrium.prefs",JSON.stringify({format:"atrium-prefs",version:1,values:{"general.startPage":"never","general.efficiency":"always"}})));
    await prefsPage.route(/\/(camera|prefs-storage)\.js$/,async route=>{await settingsReady;await route.continue();});
    await prefsPage.goto(pathToFileURL(path.join(__dirname,"..","app","index.html")).href, {waitUntil:"domcontentloaded"});
    await waitForFunction(prefsPage,()=>!!globalThis.AtriumPrefs&&!!globalThis.AtriumNavHost);
    const menu=prefsPage.locator('.work-menu[data-menu="file"]');
    const save=menu.locator('[data-action="save"]'), undo=prefsPage.locator('.work-menu[data-menu="edit"] [data-action="undo"]');
    await prefsPage.evaluate(()=>AtriumKeymap.setBindings("save",["Mod+Alt+9"]));
    assert.equal(await save.getAttribute("aria-description"),null,"changing a shortcut leaves closed File rows untouched");
    await menu.locator("summary").press("ArrowDown");
    const shortcut=key=>prefsPage.evaluate(key=>[AtriumKeymap.display(key),AtriumKeymap.display(key,true)],key);
    const saveLabel=()=>save.evaluate(button=>[button.dataset.hint,button.getAttribute("aria-description")]);
    assert.deepEqual(await saveLabel(),await shortcut("Mod+Alt+9"),"cold keyboard open presents the current binding");
    await prefsPage.evaluate(()=>AtriumKeymap.setBindings("save",["Mod+Shift+Y"]));
    assert.deepEqual(await saveLabel(),await shortcut("Mod+Shift+Y"),"the active menu's visual and spoken bindings change together");
    assert.equal(await undo.getAttribute("aria-description"),null,"Edit stays untouched while File is open");
    await menu.locator('[data-action="preferences"]').click();
    const prefs=prefsPage.getByRole("dialog",{name:"Preferences"}), search=prefs.getByRole("searchbox");
    assert.ok(await search.evaluate(input=>document.activeElement===input));
    const interval=prefs.getByRole("spinbutton",{name:"Autosave interval",exact:true});
    await interval.fill("9");releaseSettings();
    await waitFor(prefs.getByRole("button",{name:"Mouse and Camera"}));
    await waitFor(prefs.getByRole("button",{name:"Reset all settings…"}));
    assert.ok(await interval.evaluate(input=>document.activeElement===input&&input.value==="9"),"late pages preserve the unfinished edit and focus");
    assert.equal(await prefsPage.evaluate(()=>!!globalThis.AtriumThemePicker),false,"General leaves the Appearance gallery unloaded");
    await search.press("ArrowDown");await prefsPage.keyboard.press("ArrowDown");
    assert.ok(await prefs.getByRole("button",{name:"Appearance",exact:true}).evaluate(b=>b===document.activeElement&&b.getAttribute("aria-current")==="page"));
    await search.fill("unpacked");await prefs.getByRole("button",{name:"Extensions and Tools",exact:true}).click();
    await waitFor(prefs.getByRole("switch",{name:"Developer mode: load unpacked extensions from a folder",exact:true}));
    assert.deepEqual(errors,[]);
  }finally{releaseSettings();await prefsPage.close();}
  for(const changeSheets of [false,true]){
    const context=await browser.newContext({viewport:{width:1400,height:960}});
    try{
      const page=await context.newPage(),errors=[];
      page.on("pageerror",e=>errors.push(e.message));
      page.setDefaultTimeout(6000);
      // Hold the real inner script until the outer disclosure fragment is in the live DOM.
      await page.addInitScript(()=>{
        const append=Element.prototype.append;
        Element.prototype.append=function(...nodes){
          const script=nodes[0];
          if(this===document.head && nodes.length===1 && script?.src?.endsWith("/sheet-inspector.js")){
            window.releaseSheetInspector=()=>{Element.prototype.append=append;append.call(this,script);};
            return;
          }
          return append.apply(this,nodes);
        };
      });
      await page.goto(pathToFileURL(path.join(__dirname,"..","app","index.html")).href);
      await page.locator("dialog.sp-dialog[open] [data-start-action=demo]").click();
      await waitFor(page.locator("#doc-name").filter({hasText:"Sensor board"}));
      assert.deepEqual(await page.evaluate(()=>[!!globalThis.AtriumEditorKeyDialogs,!!globalThis.AtriumDocumentInspector,!!globalThis.AtriumSchObjectForms]),[false,false,false]);
      if(!changeSheets){
        const boardGrid=()=>page.evaluate(()=>AtriumNavHost.doc().grid);
        const initialGrid=await boardGrid();
        await page.evaluate(()=>AtriumNavHost.executeKey("grid-custom"));
        const grid=page.getByRole("dialog",{name:"PCB snap grid",exact:true});
        await grid.getByLabel(/Custom grid spacing/).fill("0.4mm");await grid.getByRole("button",{name:"Apply"}).click();
        // Numeric submission may await its evaluator before the form commits and closes.
        await grid.waitFor({state:"hidden"});
        assert.equal(await boardGrid(),.4);
        await page.evaluate(()=>AtriumNavHost.act("undo"));
        assert.equal(await boardGrid(),initialGrid);
        await page.evaluate(()=>AtriumNavHost.act("redo"));
        assert.equal(await boardGrid(),.4);
        await page.evaluate(()=>AtriumNavHost.act("shortcuts"));
        const reference=page.getByRole("dialog",{name:"Keyboard shortcuts",exact:true});
        await reference.getByRole("button",{name:"Close keyboard shortcuts"}).click();
        await reference.waitFor({state:"hidden"});
        assert.equal(await page.evaluate(()=>!!globalThis.AtriumPCBSelectionInspector),false);
        await page.getByRole("button",{name:"Snap options",exact:true}).click();
        const snaps=page.getByRole("dialog",{name:"Snap options",exact:true});
        const distance=snaps.getByLabel("Snap distance in pixels");
        await distance.fill("11");await distance.press("Tab");
        assert.equal(await page.evaluate(()=>AtriumPCBEdit.snapPrefs.radius),11);
        await snaps.locator("input").first().press("Escape");
        const via=await page.evaluate(()=>{const h=AtriumNavHost,item=h.doc().items.find(i=>i.kind==="via");h.select([item.id]);return {id:item.id,net:item.net};});
        const net=page.locator('#inspector [aria-label="Net"]').first();
        await net.fill("TEST_VIA");await net.press("Tab");
        assert.equal(await page.evaluate(id=>AtriumNavHost.doc().items.find(i=>i.id===id).net,via.id),"TEST_VIA");
        await page.evaluate(()=>AtriumNavHost.act("undo"));assert.equal(await net.inputValue(),via.net);
        await page.evaluate(()=>AtriumNavHost.act("find-similar"));
        await page.getByRole("dialog",{name:"Find Similar Objects"}).getByRole("button",{name:"Cancel",exact:true}).click();
      }
      const sheet=page.locator("#documents button").filter({hasText:"Analog front end"});
      await sheet.click();
      const settings=page.locator("#inspector summary").filter({hasText:"Document settings"});
      if(!await settings.isVisible())await showPanel(page,"properties");
      await settings.click();
      await waitFor(page.locator('#inspector [aria-label="Name"]'));
      await waitForFunction(page,()=>typeof window.releaseSheetInspector==="function");
      const orientation=page.locator('#inspector [aria-label="Orientation"]');
      assert.equal(await orientation.count(),0);
      if(changeSheets){
        await page.locator("#documents button").filter({hasText:"Sensor board"}).click();
        assert.equal(await orientation.count(),0);
        await sheet.click();
        await waitFor(page.locator('#inspector [aria-label="Name"]'));
      }
      await page.evaluate(()=>window.releaseSheetInspector());
      await waitFor(orientation);
      const initial=await orientation.inputValue(),other=initial==="landscape"?"portrait":"landscape";
      await orientation.selectOption(other);
      assert.equal(await page.evaluate(()=>AtriumNavHost.doc().sheet.orientation),other);
      await page.evaluate(()=>AtriumNavHost.act("undo"));assert.equal(await orientation.inputValue(),initial);
      if(changeSheets){
        await page.evaluate(()=>AtriumNavHost.act("sch-sheet-symbol"));
        const symbol=page.getByRole("dialog",{name:"Place sheet symbol"});
        await waitFor(symbol.getByLabel("Child sheet"));await symbol.getByRole("button",{name:"Cancel"}).click();
        await page.evaluate(()=>AtriumNavHost.act("sch-text"));
        const form=page.getByRole("dialog",{name:"Place text"});await form.getByLabel("Text",{exact:true}).fill("Cold form text");
        await form.getByRole("button",{name:"OK"}).click();
        await page.locator("#canvas").click({position:{x:180,y:120}});
        assert.ok(await page.evaluate(()=>AtriumNavHost.doc().items.some(i=>i.text==="Cold form text")));
      }
      assert.deepEqual(errors,[]);
    }finally{await context.close();}
  }
  console.log("PASS cold Preferences focus and settings search, grid, shortcut, snap, via, matching-object and schematic placement dialogs, and nested sheet settings after a document switch");
}

async function accessibility(browser, screenshotDir){
  const check = require("./editor/browser-accessibility.js");
  await check(browser, {screenshotDir});
  let scans = 0;
  const audit = async (page, state) => {await check.check(page, state); scans++;};
  await require("./pcb/browser-routing-polish.js")(browser, {audit});
  for (const theme of ["light", "dark"]) await require("./checks/browser-insights-polish.js")(browser, {theme, audit});
  assert.equal(scans, 10, "routing and Insights accessibility scans run in both themes");
  console.log("PASS accessibility: ten live routing and Design Insights axe scans");
}

async function importSurfaces(browser){
  await require("./formats/browser-import-demand.js")(browser);
  await require("./pcb/browser-pour-open-connectivity.js")(browser);
  await require("./formats/browser-translator-surfaces.js")(browser);
  await require("./pcb/browser-placement-identity.js")(browser);
  await require("./formats/browser-translator-exchange.js")(browser);
  await require("./formats/browser-translator-rule-views.js")(browser);
  await require("./editor/browser-menu-downloads.js")(browser);
  await require("./project/browser-project-archive.js")(browser);
}

async function main(){
  const groups=[
    {name:"projects", run:projectChecks},
    {name:"editor", parts:[
      {name:"editor-interaction", run:editorInteractionChecks},
      {name:"editor-gpu", run:editorGpuChecks},
      {name:"editor-interface", run:editorInterfaceChecks},
    ]},
    {name:"audits", run:auditChecks},
    {name:"resolved-geometry", run:()=>require("./e2e/a1-resolved-geometry.cjs").checkResolvedGeometry(browser)},
    {name:"titlebar", run:async()=>{await require("./editor/browser-titlebar-safe-area.cjs")(browser);await require("./editor/browser-titlebar-safe-area.cjs")(browser,{platform:"windows",viewports:[{width:770,height:500}]});await require("./editor/browser-windows-caption.cjs")(browser);await require("./editor/browser-appbar-contrast.js")(browser);await require("./editor/browser-search-keys.js")(browser);await require("./project/browser-split-controls.js")(browser);}},
  ];
  const expand=entries=>entries.flatMap(group=>group.parts||group);
  const ciGroups=expand(groups), listGroups=process.argv.includes("--list-groups");
  if(listGroups||process.argv.includes("--list-ci-groups")){
    for(const {name} of listGroups?groups:ciGroups)console.log(name);
    return;
  }
  const groupAt=process.argv.indexOf("--group");
  const group=groupAt<0 ? null : [...groups,...ciGroups].find(({name})=>name===process.argv[groupAt+1]);
  if(groupAt>=0)assert.ok(group,"Unknown Chromium integration group: "+(process.argv[groupAt+1]||"(missing)"));
  const executable=arg("--executable"),snapshot=arg("--snapshot"),performancePath=arg("--performance-snapshot");
  // GPU-process recovery uses its own Chromium process and keeps the suite's executable.
  if(executable)process.env.CHROME=executable;
  const dockOnly=process.argv.includes("--dock-only"),safeAreaOnly=process.argv.includes("--safe-area-only");
  const browser=await retryWait(()=>chromium.launch({
    headless:true, timeout:8000, ...(executable?{executablePath:executable}:{channel:"chrome"}),
    ...(dockOnly||safeAreaOnly?{args:["--allow-file-access-from-files"]}:{})
  }));
  try{
    if(process.argv.includes("--keys-only")){await keyboardProfiles(browser);return;}
    if(process.argv.includes("--dialogs-only")){await firstUseDialogs(browser);return;}
    if(process.argv.includes("--palette-lifecycle-only")){await require("./editor/browser-palette-lifecycle.js")(browser);return;}
    if(process.argv.includes("--startup-demand-only")){await require("./editor/browser-startup-demand.js")(browser);return;}
    if(process.argv.includes("--tooltips-only")){await require("./ui/browser-ui-tooltips.js")(browser);return;}
    const view3dCase=["open","folder","navigation"].find(name=>process.argv.includes("--view3d-"+name+"-only"));
    if(view3dCase){await require("./canvas/browser-view3d-open.js")(browser,[view3dCase]);return;}
    if(process.argv.includes("--touch-navigation-only")){await require("./editor/browser-touch-navigation.js")(browser);return;}
    if(process.argv.includes("--touch-gestures-only")){await require("./editor/browser-touch-gestures.js")(browser);return;}
    if(process.argv.includes("--touch-scheme-only")){await require("./editor/browser-touch-scheme.js")(browser);return;}
    if(process.argv.includes("--problem-hover-only")){await require("./checks/browser-problem-hover.js")(browser,{screenshotDir:snapshot});return;}
    if(process.argv.includes("--drc-messages-only")){await require("./checks/browser-drc-messages.js")(browser);return;}
    if(process.argv.includes("--show-in-messages-only")){await require("./checks/browser-show-in-messages.js")(browser);return;}
    if(process.argv.includes("--canvas-hover-only")){await require("./editor/browser-canvas-hover.js")(browser);return;}
    if(process.argv.includes("--rotated-markers-only")){await require("./checks/browser-insights-polish.js").rotatedMarkers(browser);return;}
    if(process.argv.includes("--no-quirks-only")){await require("./editor/browser-no-quirks.js")(browser);return;}
    if(process.argv.includes("--frame-monitor-only")){await require("./canvas/browser-frame-monitor.js")(browser,snapshot);return;}
    if(dockOnly){await require("./editor/browser-dock-beta.cjs")(browser);return;}
    if(safeAreaOnly){await require("./editor/browser-dialog-safe-area.cjs")(browser);return;}
    if(process.argv.includes("--titlebar-only")){await require("./editor/browser-titlebar-safe-area.cjs")(browser);return;}
    if(process.argv.includes("--panels-only")){await require("./editor/browser-panels-menu.js")(browser);return;}
    if(process.argv.includes("--tab-overflow-only")){await require("./editor/browser-tab-overflow.js")(browser);return;}
    if(process.argv.includes("--menu-toggle-only")){await require("./editor/browser-menu-toggle.js")(browser);return;}
    if(process.argv.includes("--messages-fonts-only")){await require("./editor/browser-messages-fonts.js")(browser);return;}
    if(process.argv.includes("--messages-filter-only")){await require("./editor/browser-messages-filter.js")(browser);return;}
    if(process.argv.includes("--inline-stack-only")){await require("./editor/browser-inline-stack.js")(browser);return;}
    if(process.argv.includes("--panel-chrome-only")){await require("./editor/browser-panel-chrome.js")(browser);return;}
    if(process.argv.includes("--review-composer-only")){await require("./history/browser-review-composer.js")(browser);return;}
    if(process.argv.includes("--calculators-only")){await require("./analysis/browser-calculators.js")(browser);return;}
    if(process.argv.includes("--import-only")){await importSurfaces(browser);return;}
    if(process.argv.includes("--demo-workflow-only")){await demoProjectWorkflow();return;}
    if(process.argv.includes("--home-only")){await require("./project/browser-home-projects.js")(browser);return;}
    if(process.argv.includes("--welcome-only")){await require("./project/browser-welcome-open.js")(browser);return;}
    if(process.argv.includes("--frames-only")){await require("./notebook/browser-infinite-frames.js")(browser);return;}
    if(process.argv.includes("--editing-only")){await require("./editor/browser-editing-input.js")(browser);return;}
    if(process.argv.includes("--schematic-terminal-drag-only")){await require("./schematic/browser-sch-terminal-drag.js")(browser);return;}
    const zoomCase=["settle","surfaces"].find(name=>process.argv.includes("--zoom-"+name+"-only"));
    if(zoomCase){await require("./canvas/browser-zoom-geometry.js")([zoomCase]);return;}
    if(process.argv.includes("--gpu-pour-lod-only")){await require("./canvas/browser-gpu-pour-lod.cjs")({requireHardware:process.argv.includes("--require-hardware")});return;}
    if(process.argv.includes("--dense-edit-only")){await require("./canvas/browser-dense-edit-refresh.js")(browser);return;}
    if(process.argv.includes("--fields-only")){await require("./schematic/browser-sch-fields.js")(browser);return;}
    if(process.argv.includes("--links-only")){await require("./schematic/browser-part-links.js")(browser);return;}
    if(process.argv.includes("--notebook-only")){await require("./notebook/browser-notebook-integration.js")(browser);return;}
    if(process.argv.includes("--bom-only")){await require("./formats/browser-bom-ui.js")(browser);return;}
    if(process.argv.includes("--print-only")){await require("./formats/browser-print-unify.js")(browser);return;}
    if(process.argv.includes("--accessibility-only")){await accessibility(browser, snapshot);return;}
    if(process.argv.includes("--extensions-only")){await extensionPackages(browser);return;}
    for(const {run} of expand(group?[group]:groups))await run();
  }finally{await browser.close();}

  async function projectChecks(){
    await extensionPackages(browser);
    await require("./editor/browser-startup-demand.js")(browser);
    await firstUseDialogs(browser);
    await require("./ui/browser-ui-tooltips.js")(browser);
    await require("./history/browser-review-composer.js")(browser);
    await require("./notebook/browser-notebook-integration.js")(browser);
    await require("./formats/browser-print-unify.js")(browser);
    await require("./motion/diff-blink-browser.cjs")(browser);
    await require("./analysis/browser-calculators.js")(browser);
    await importSurfaces(browser);
    await demoProjectWorkflow();
  }

  async function demoProjectWorkflow(){
    const context=await browser.newContext({viewport:{width:1400,height:960},acceptDownloads:true});
    const page=await context.newPage(),errors=[];
    page.setDefaultTimeout(5000);
    page.on("pageerror",e=>errors.push(e.message));
    context.on("page",next=>next.on("pageerror",e=>errors.push(e.message)));
    await page.goto(pathToFileURL(path.join(__dirname,"..","app","index.html")).href);
    const action=async name=>{
      const selector='[data-action="'+name+'"]';
      if(!await page.locator(selector+":visible").count()){
        const menu=page.locator(".work-menu").filter({has:page.locator(selector+":not([hidden])")}).first();
        if(await menu.count())await menu.locator("summary").click();
      }
      await page.locator(selector+":visible").first().click();
    };
    const save=async()=>{
      const wait=page.waitForEvent("download");
      await action("save");const file=await wait;
      assert.match(file.suggestedFilename(),/\.zip$/);
      await waitFor(page.locator("#status").filter({hasText:"Saved "+file.suggestedFilename()+"."}));
      assert.equal(await file.failure(),null);
      const {manifest,files}=await readProjectZIP(await fs.readFile(await file.path()));
      return projectFromRecords(manifest,name=>files.get(name),{nativeAssets:true});
    };
    await page.locator("dialog.sp-dialog[open] [data-start-action=demo]").click();
    await waitFor(page.locator("#doc-name").filter({hasText:"Sensor board"}));
    // The final picture can use more than one canvas when the GPU draws the board.
    // Sample a browser screenshot so both supported rendering paths count.
    await retryWait(async()=>{
      const deadline=performance.now()+5000;
      do {
        const png=await page.locator("#canvas").screenshot();
        const painted=await page.evaluate(async encoded=>{
          const bytes=Uint8Array.from(atob(encoded),c=>c.charCodeAt(0));
          const img=await createImageBitmap(new Blob([bytes],{type:"image/png"}));
          const c=document.createElement("canvas");c.width=96;c.height=64;
          const ctx=c.getContext("2d");
          ctx.drawImage(img,0,0,c.width,c.height);img.close();
          const colours=new Set(new Uint32Array(ctx.getImageData(0,0,c.width,c.height).data.buffer));
          return colours.size>10;
        },png.toString("base64"));
        if(painted)return;
      } while(performance.now()<deadline);
      throw new TimeoutError("Timed out waiting for copper, silkscreen and substrate on the visible board canvas");
    });
    if(snapshot)await page.screenshot({path:snapshot});
    const initial=await page.evaluate(async()=>{
      const D=globalThis.AtriumDiagnostics;
      const off=D.performanceSnapshot(), enabledWhileOff=D.performance!==null;
      const loadedWhileOff=!!globalThis.AtriumPerformanceDiagnostics;
      await AtriumLazy.need("AtriumPerformanceDiagnostics");
      globalThis.demoPerformanceLease=D.startPerformance();
      return {off,enabledWhileOff,loadedWhileOff,active:D.performanceSnapshot()};
    });
    assert.deepEqual(initial.off,{version:1,recording:false,rows:[]},"the ordinary Demo opens and paints without recording");
    assert.equal(initial.enabledWhileOff,false);
    assert.equal(initial.loadedWhileOff,false,"the recorder stays unloaded during ordinary Demo startup");
    assert.deepEqual(initial.active,{version:1,recording:true,rows:[]});
    assert.deepEqual(await page.evaluate(()=>[!!globalThis.AtriumPCBTextInspector,!!globalThis.AtriumPCBSelectionInspector,
      !!globalThis.AtriumSchObjectInspector,!!globalThis.AtriumSheetInspector]),[false,false,false,false]);
    const pcbText=await page.evaluate(async()=>{
      const host=AtriumNavHost,[first,second]=host.doc().items.filter(i=>i.kind==="label");
      host.select([first.id]);
      const stale=document.querySelector("#inspector .pcbtext-inspector");
      const requested=["AtriumPCBTextInspector","AtriumPCBSelectionInspector"].every(n=>AtriumLazy.pending(n));
      const clipboard=new DataTransfer();
      document.querySelector("#canvas").dispatchEvent(new ClipboardEvent("copy",{bubbles:true,cancelable:true,clipboardData:clipboard}));
      const copied=JSON.parse(clipboard.getData(AtriumSelectionClipboard.mime)).items[0];
      host.select([second.id]);
      await AtriumLazy.need("AtriumPCBTextInspector");
      return {id:second.id,text:second.text,requested,staleEmpty:!stale.children.length,copiedFirst:copied.id===first.id};
    });
    assert.ok(pcbText.requested && pcbText.staleEmpty,"first PCB text selection requests controls and a superseded selection gets none");
    assert.ok(pcbText.copiedFirst,"the very first selection can be copied while its Properties controls load");
    const silk=page.locator('#inspector .pcbtext-inspector [aria-label="Text"]');
    assert.equal(await silk.inputValue(),pcbText.text);
    await silk.fill("Assembly\nA");await silk.press("Tab");
    assert.equal(await page.evaluate(id=>AtriumNavHost.doc().items.find(i=>i.id===id).text,pcbText.id),"Assembly\nA");
    await action("undo");assert.equal(await silk.inputValue(),pcbText.text);
    const tracks=await page.evaluate(async()=>{
      const host=AtriumNavHost,ids=host.doc().items.filter(i=>i.kind==="track").slice(0,2).map(i=>i.id);
      await AtriumLazy.need("AtriumRules");
      host.select(ids);
      return ids;
    });
    const width=page.locator('#inspector [aria-label="Width"]');
    await width.fill("0.001mm");await width.press("Tab");
    await page.getByRole("dialog",{name:"Design rule check"}).getByRole("button",{name:"Cancel"}).click();
    const lock=page.locator('#inspector [aria-label="Locked"]');
    await lock.check();
    assert.ok(await page.evaluate(ids=>ids.every(id=>AtriumNavHost.doc().items.find(i=>i.id===id).locked),tracks));
    await action("undo");assert.equal(await lock.isChecked(),false);
    await page.evaluate(()=>AtriumNavHost.select([]));
    const priorDrc=await page.evaluate(()=>AtriumDiagnostics.performanceSnapshot().rows.find(
      row=>row.component==="drc" && row.operation==="publish")?.counts.completed ?? 0);
    await action("drc");
    const messages=page.getByRole("region",{name:"Messages",exact:true});
    await waitForFunction(page,prior=>{
      const row=AtriumDiagnostics.performanceSnapshot().rows.find(row=>row.component==="drc" && row.operation==="publish");
      return row?.counts.completed>prior && globalThis.AtriumMessages?.messages().some(m=>m.group==="DRC" && m.source==="Rule summary");
    },priorDrc);
    const messagesTab=page.getByRole("tab",{name:"Messages",exact:true});
    const dock=page.locator("#properties .dock-group").filter({has:messagesTab});
    await waitFor(dock);
    await waitFor(messages);
    assert.equal(await messagesTab.getAttribute("aria-selected"),"true","DRC activates the right-dock Messages tab");
    assert.equal(await messagesTab.getAttribute("aria-controls"),await messages.getAttribute("id"),"the selected Messages tab controls the result region");
    await waitForFunction(page,()=>document.activeElement?.matches(".msg-panel .msg-grid"));
    const closeName={name:"Close Messages",exact:true};
    const closeMessages=dock.getByRole("button",closeName);
    assert.equal(await page.getByRole("button",closeName).count(),1,"a docked Messages panel exposes one Close control");
    assert.equal(await closeMessages.getAttribute("data-dock-close"),"messages","the selected tab owns the visible Close control");
    await closeMessages.click();
    await waitFor(messages,{state:"hidden"});
    await waitFor(messagesTab,{state:"hidden"});
    await waitForFunction(page,()=>!AtriumMessages.isOpen() &&
      document.activeElement?.matches('#properties [data-dock-tab="properties"][aria-selected="true"]'));
    await page.locator("#project-name").click({button:"right"});
    await waitFor(page.getByRole("menuitem",{name:"Add Existing to Project…",exact:true}));
    assert.equal(await page.locator(".nav-menu-portal > .nav-menu [aria-haspopup=menu]",{hasText:"Add New to Project"}).count(),1);
    await page.keyboard.press("Escape");
    const sheet=page.locator("#documents button").filter({hasText:"Analog front end"});
    await sheet.click({button:"right"});
    await waitFor(page.getByRole("menuitem",{name:/Rename/}));
    assert.equal(await page.getByRole("menuitem",{name:/^Validate Project \(ERC\)/}).getAttribute("data-menu-action"),"compile");
    await page.keyboard.press("Escape");
    assert.deepEqual(await page.evaluate(()=>[!!globalThis.AtriumNetsTable,!!globalThis.AtriumPartInspector]),[false,false]);
    for(const panel of ["nets","library"]){
      await windowPanel(page,panel);
      await waitFor(page.locator('#properties .dock-tabs [aria-selected="true"]').filter({hasText:new RegExp(panel,"i")}));
      if(panel==="nets")await waitForFunction(page,()=>AtriumNetsPanel.rows().some(r=>r.name==="VIN"));
    }
    await sheet.click();
    await showPanel(page,"properties");
    const settings=page.locator('#inspector summary').filter({hasText:"Document settings"});
    assert.equal(await page.evaluate(()=>!!globalThis.AtriumSheetInspector),false);
    await settings.click();
    const orientation=page.locator('#inspector [aria-label="Orientation"]');
    const originalOrientation=await orientation.inputValue(),other=originalOrientation==="portrait"?"landscape":"portrait";
    await orientation.selectOption(other);
    assert.equal(await page.evaluate(()=>AtriumNavHost.doc().sheet.orientation),other);
    await action("undo");assert.equal(await orientation.inputValue(),originalOrientation);
    assert.ok(await page.evaluate(async()=>{
      const host=AtriumNavHost,first=host.doc().items.find(i=>i.kind==="part" && i.id!=="s-R1");
      host.select([first.id]);
      const requested=AtriumLazy.pending("AtriumSchObjectInspector");
      AtriumNavHost.select(["s-R1"]);
      const input=document.querySelector('#inspector [aria-label="Comment"]');
      input.focus();
      await AtriumLazy.need(["AtriumPartInspector","AtriumSchObjectInspector"]);
      return requested && document.activeElement===input && !!document.querySelector('#inspector [aria-label="Show designator"]') &&
        document.querySelectorAll("#inspector .sch-params").length===1;
    }),"first-use fields preserve input focus and attach only to the current schematic part");
    await showPanel(page,"components");
    await page.locator('#parts [data-part="s-R1"]').click();
    await showPanel(page,"properties");
    const value=page.getByRole("textbox",{name:"Comment",exact:true});
    const readComment=()=>page.evaluate(()=>AtriumNavHost.doc().items.find(i=>i.id==="s-R1")?.value);
    const orig=await value.inputValue(), updatedComment="47 kΩ";
    await value.fill(updatedComment);await value.press("Tab");
    await waitForFunction(page,expected=>AtriumNavHost.doc().items.find(i=>i.id==="s-R1")?.value===expected,updatedComment);
    await action("undo");assert.equal(await value.inputValue(),orig);assert.equal(await readComment(),orig);
    await action("redo");assert.equal(await value.inputValue(),updatedComment);assert.equal(await readComment(),updatedComment);
    await action("eco");
    await page.getByRole("button",{name:/^Execute \d+ Changes?$/}).click();
    const confirm=page.getByRole("button",{name:"Execute anyway",exact:true});
    if(await confirm.isVisible())await confirm.click();
    await waitForFunction(page,()=>globalThis.AtriumNavHost.doc().kind==="pcb");
    await showPanel(page,"components");
    const boardRef=await page.evaluate(()=>AtriumNavHost.doc().items.find(i=>i.kind==="part"&&i.ref==="R1").id);
    await page.locator('#parts [data-part="'+boardRef+'"]').click();
    await showPanel(page,"properties");
    assert.equal(await value.inputValue(),updatedComment);
    const before=await save();const board=p=>p.documents.find(d=>d.kind==="pcb");
    await action("library-catalogue");
    await page.locator("#library-search").fill("test point");
    // The library search field: Escape clears the query first, then closes the dialog.
    await page.locator("#library-search").press("Escape");
    assert.equal(await page.locator("#library-search").inputValue(),"","Escape clears the library search first");
    assert.ok(await page.locator("#library-dialog").isVisible(),"the dialog stays open while the search had text");
    await page.locator("#library-search").press("Escape");
    await waitFor(page.locator("#library-dialog"),{state:"hidden"});
    await action("library-catalogue");await page.locator("#library-search").fill("test point");
    await page.locator("#library-list button").filter({hasText:/Test point/i}).first().click();
    const canvas=page.locator("#canvas");await canvas.click({position:{x:60,y:100}});
    const [start,end]=await page.evaluate(()=>{
      const h=AtriumNavHost, part=h.doc().items.find(i=>i.kind==="part"&&i.ref==="J1");
      const pad=Atrium.pins(part,h.defs().get(part.def),"pcb").find(p=>part.pinNets[p.number]);
      const to=[pad.at[0]+3,pad.at[1]],view=h.view();
      view.restoreCamera({...view.camera(),cx:pad.at[0]+1.5,cy:pad.at[1],scale:40});h.redraw();
      return [pad.at,to].map(p=>{const [x,y]=view.worldToScreen(p);return {x,y};});
    });
    await action("route");
    await canvas.click({position:start});
    await waitForFunction(page,()=>!!AtriumNavHost.liveRoute());
    await canvas.click({position:end});await canvas.press("Escape");
    const after=await save(), count=(p,kind)=>board(p).items.filter(i=>i.kind===kind).length;
    assert.equal(count(after,"part"),count(before,"part")+1,"placed Test point");
    assert.ok(count(after,"track")>count(before,"track"),"committed copper from J1");
    const capture=await page.evaluate(()=>{
      const D=globalThis.AtriumDiagnostics, running=D.performanceSnapshot();
      const stopped=globalThis.demoPerformanceLease.stop();
      delete globalThis.demoPerformanceLease;
      return {running,stopped,retained:D.performanceSnapshot()};
    });
    assert.equal(capture.running.recording,true);
    assert.equal(capture.stopped,true);
    assert.deepEqual(capture.retained,{...capture.running,recording:false});
    for(const [component,operation,outcome] of [
      ["pcb","draw","visible"],["schematic","draw","visible"],["drc","publish","completed"],
      ["library","search","completed"],["routing","compute","completed"],["save","save","completed"]
    ]){
      const row=capture.running.rows.find(row=>row.component===component && row.operation===operation);
      assert.ok(row?.counts[outcome]>0,component+"/"+operation+" records "+outcome+" real work");
      assert.ok(Number.isFinite(row.runP95) && row.runP95>=0,component+"/"+operation+" has a run duration");
      assert.ok(Number.isFinite(row.endToEndP95) && row.endToEndP95>=0,component+"/"+operation+" has an end-to-end duration");
      if(component==="save"){
        assert.ok(row.counts.completed>=2 && row.counts.queued>0,"both downloads complete, including a queued folder save");
        assert.equal(row.counts.durable,0,"browser ZIP downloads do not report native durable writes");
      }
    }
    await action("library-catalogue");
    await page.locator("#library-search").fill("resistor");
    await waitFor(page.locator("#library-list button").filter({hasText:/resistor/i}).first());
    await page.locator("#library-search").press("Escape");
    await page.locator("#library-search").press("Escape");
    const afterStop=await page.evaluate(async()=>{
      const D=globalThis.AtriumDiagnostics, R=await AtriumLazy.need("AtriumRecover");
      return {snapshot:D.performanceSnapshot(), disabled:D.performance===null,
        shareable:D.performanceSnapshot({shareable:true}), report:JSON.parse(await R.report()).performance.activity};
    });
    assert.equal(afterStop.disabled,true);
    assert.deepEqual(afterStop.snapshot,capture.retained,"a real catalogue search after Stop leaves the capture unchanged");
    assert.deepEqual(afterStop.report,afterStop.shareable,"Crash Diagnostics reads the shared, bucketed capture");
    if(performancePath)await fs.writeFile(performancePath,JSON.stringify(capture.retained,null,2)+"\n");
    const sibling="Second project.kicad_pcb";
    const buffer=await fs.readFile(path.join(__dirname,"fixtures/import/demo.kicad_pcb"));
    await page.locator("#file-input").setInputFiles({name:sibling,mimeType:"application/octet-stream",buffer});
    const popup=page.waitForEvent("popup");
    await page.getByRole("button",{name:"Open in new window"}).click();
    const second=await popup;
    await waitForFunction(second,name=>globalThis.AtriumNavHost?.project().name==="Second project" &&
      AtriumNavHost.importSession()?.sourceLabel===name,sibling,{timeout:10000}).catch(async error=>{
      const details=await Promise.all([page,second].map(p=>p.evaluate(()=>({
        project:globalThis.AtriumNavHost?.project().name,status:document.querySelector("#status")?.textContent,
        dialog:document.querySelector("dialog[open]")?.textContent?.slice(0,150),explicitOpen:!!window.__atriumOpeningProject
      }))));
      throw Error(error.message+" "+JSON.stringify({windows:details,errors}));
    });
    assert.equal(await second.locator("dialog.sp-dialog[open]").count(),0);
    assert.equal(await page.evaluate(()=>AtriumNavHost.project().name),after.name);
    await second.close();
    assert.deepEqual(errors,[]);
    console.log("PASS browser canvas pixels, schematic edits, undo/redo, DRC, ECO, cross-probe, placement, routing, downloads, shared performance capture, explorer menus, panels, Escape, and separate project windows");
  }

  async function editorInteractionChecks(){
    await require("./editor/browser-touch-navigation.js")(browser);
    await require("./editor/browser-touch-precision.js")(browser);
    await require("./editor/browser-touch-gestures.js")(browser);
    await require("./editor/browser-touch-scheme.js")(browser);
    await require("./checks/browser-problem-hover.js")(browser);
    await require("./editor/browser-canvas-hover.js")(browser);
    await require("./checks/browser-annular-problems.js")(browser);
    await require("./checks/browser-drc-messages.js")(browser);
    await require("./checks/browser-show-in-messages.js")(browser);
    await require("./canvas/browser-schematic-net-navigation.js")(browser);
    await require("./canvas/browser-view3d-open.js")(browser,["navigation","open","folder"]);
    await require("./editor/browser-editing-input.js")(browser);
    await require("./schematic/browser-sch-terminal-drag.js")(browser);
    await require("./pcb/browser-route-no-op.cjs")(browser);
    await require("./canvas/browser-dense-edit-refresh.js")(browser);
  }

  async function editorGpuChecks(){
    await require("./canvas/browser-zoom-geometry.js")(["surfaces","settle"]);
    await require("./canvas/browser-gpu-pour-lod.cjs")();
  }

  async function editorInterfaceChecks(){
    await require("./schematic/browser-sch-fields.js")(browser);
    await require("./schematic/browser-part-links.js")(browser);
    await require("./notebook/browser-infinite-frames.js")(browser);
    await require("./pcb/browser-pcb-text.js")(browser);
    await require("./project/browser-welcome-open.js")(browser);
    await require("./library/browser-library-families.js")(browser);
    await require("./library/browser-library-preview.js")(browser);
    await require("./library/browser-library-demand.js")(browser);
    await require("./library/browser-group-library.js")(browser);
    await require("./library/browser-component-match.js")(browser);
    await require("./editor/browser-ux-consistency.js")(browser);
    await require("./ui/browser-ui-kit.js")(browser);
    await require("./ui/browser-ui-gallery.cjs")(browser);
    await require("./editor/browser-preferences-layout.js")(browser);
    await require("./editor/browser-prefs-held.js")(browser);
    await require("./editor/browser-editor-chrome.js")(browser);
    await require("./editor/browser-chrome-pixels.js")(browser);
    await require("./editor/browser-menu-toggle.js")(browser);
    await require("./editor/browser-messages-fonts.js")(browser);
    await require("./editor/browser-messages-filter.js")(browser);
    await require("./editor/browser-inline-stack.js")(browser);
    await require("./editor/browser-panel-chrome.js")(browser);
    await require("./ui/browser-owner-layers.cjs")(browser);
    await require("./editor/browser-scripting-console.cjs")(browser);
  }

  async function auditChecks(){
    await accessibility(browser);
    await require("./editor/browser-focus-rings.js")(browser);
    await require("./editor/browser-no-quirks.js")(browser);
    await require("./history/browser-project-history.js")(browser);
    await require("./history/browser-visual-history.js")(browser);
    await require("./history/browser-history-refs.js")(browser);
    await require("./history/browser-butter-history.cjs")(browser);
    await require("./editor/browser-inspector-layout.js")(browser);
    await require("./checks/browser-class-filter.js")(browser);
    await require("./formats/browser-bom-ui.js")(browser);
    await require("./editor/browser-interface-field-alignment.js")(browser);
    await require("./editor/browser-workbench-tree.js")(browser);
    await require("./editor/browser-panels-menu.js")(browser);
    await require("./editor/browser-tab-overflow.js")(browser);
    await require("./canvas/browser-frame-monitor.js")(browser);
    await require("./project/browser-project-connections.js")(browser);
    await require("./editor/browser-shortcut-labels.js")(browser);
    await require("./editor/browser-keymap-cold.js")(browser);
    await require("./editor/browser-status-bar.js")(browser);
    await require("./canvas/browser-object-snap.js")(browser);
    await require("./editor/browser-palette-engine.js")(browser);
    await require("./checks/browser-query-filter.js")(browser);
    await require("./editor/browser-update-demand.js")(browser);
    await require("./editor/browser-palette-lifecycle.js")(browser);
    await require("./project/browser-crash-safety.js")(browser);
    await require("./editor/browser-soak.js")(browser);
    await require("./project/browser-home-projects.js")(browser);
    await keyboardProfiles(browser);
  }
}
main().catch(e=>{console.error(e.stack||e.message);process.exitCode=1;});
