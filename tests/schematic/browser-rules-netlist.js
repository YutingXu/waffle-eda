"use strict";
// Run with Node and playwright-core. Pass --screenshots DIRECTORY to save each theme.
const assert=require("node:assert/strict"),fs=require("node:fs"),os=require("node:os"),path=require("node:path");
const {pathToFileURL}=require("node:url"),{execFileSync}=require("node:child_process");
const {appFile}=require("../support/app-source-paths.cjs");
for(const file of ["core/model.js","library/parts.js","core/zip.js","schematic/sch-objects.js","project/hierarchy.js","lazy.js"]) require(appFile(file));
globalThis.CFB=require(appFile("vendor/cfb.min.js"));
for(const file of AtriumLazy.files(["AtriumImportLink","AtriumSourceFile","AtriumBoardShapeSources","AtriumDesignQuery","AtriumRuleLint","AtriumNetlistText"])) require(appFile(file));
for(const file of ["formats/sch-import.js","formats/pcb-import.js","formats/io.js"]) require(appFile(file));
require("../pcb/dense-board.js");
const root=path.resolve(__dirname,"../.."), at=process.argv.indexOf("--screenshots"),screens=at>=0&&process.argv[at+1];
function fixtures() {
  const p=AtriumParts.example(),board=p.documents.find(d=>d.kind==="pcb");
  p.signals={version:1,signals:[{id:"in",name:"Input path",kind:"single",legs:[{nets:["VIN"]}],span:false,tags:["Analog"]},
    {id:"out",name:"Output path",kind:"single",legs:[{nets:["VOUT"]}],span:false,tags:["Analog"]}],
    tags:[{name:"Analog"},{name:"Power"}],nets:{GND:{tags:["Power"]},VDD:{tags:["Power"]}}};
  const set=AtriumRules.create(),width=set.list.find(r=>r.type==="width");
  width.name="Board width";
  for(const [priority,name,source] of [
    [2,"Analog width",'object where net.name = "VIN"'],
    [3,"Future clock",'track where net.name = "CLK_25M"'],
    [4,"Input and ground",'object where net.name = "VIN" and net.name = "GND"']
  ])set.list.push({...width,id:"width-"+priority,priority,name,scope:AtriumDesignQueryRecord.create(source)});
  set.list.find(r=>r.type==="viaStyle").holeMin=.5;set.list.find(r=>r.type==="holeSize").max=.4;
  board.items.push({kind:"via",id:"lint-via",x:12,y:8,net:"VIN",diameter:.8,drill:.3});
  AtriumProjectRules.store(p,board,set);
  const big=Atrium.project("PiDP-11 I/O expander");big.documents=[];big.library=[];
  for(const n of ["PCB-PiDP11IOExpander.PrjPcb","PiDP11IOExpander.SchDoc","PiDP11IOExpander.PcbDoc"]){
    const e=AtriumIO.read(n,new Uint8Array(fs.readFileSync(path.join(__dirname,"../fixtures/altium/pidp11-io-expander",n))));
    big.documents.push(...(e.documents||[]));big.library.push(...(e.library||[]));
  }
  AtriumImportLink.reconcile(big,big.documents);
  const {d,defs}=makeAtriumBenchmarkBoard(),dense=Atrium.project("Dense signal board",[...defs.values()]);
  dense.documents=[d];
  for(const [i,item] of d.items.entries()){
    if(item.kind==="part")item.pinNets={1:"N"+i%64,2:"GND"};else item.net="N"+i%64;
  }
  return [p,big,dense];
}
function metrics(project) {
  const board=project.documents.find(d=>d.kind==="pcb"), defs=new Map(project.library.map(d=>[d.id,d]));
  const d=AtriumNetlistText.compile(project), set=AtriumRules.migrate(AtriumRules.stored(board,project));
  const median=fn=>{
    fn();const samples=[];
    for(let i=0;i<11;i++){const before=performance.now();fn();samples.push(performance.now()-before);}
    return +samples.sort((a,b)=>a-b)[5].toFixed(2);
  };
  return {objects:project.documents.reduce((n,d)=>n+d.items.length,0),...d.counts,
    kicadBytes:Buffer.byteLength(AtriumNetlist.kicad(AtriumNetlist.extract(project))),
    textBytes:Buffer.byteLength(d.text),compileMs:median(()=>AtriumNetlistText.compile(project)),
    validateMs:median(()=>AtriumNetlistText.validate(d.text)),lintMs:median(()=>AtriumRuleLint.analyze(set,{project,board,defs}))};
}
(async()=>{
  if(process.argv.includes("--measure")){
    for(const p of fixtures())console.log(p.name,JSON.stringify(metrics(p)));
    return;
  }
  const {chromium}=require("playwright-core");
  const tmp=fs.mkdtempSync(path.join(os.tmpdir(),"waffle-netlist-")),browser=await chromium.launch({headless:true,...(process.env.CHROME?{executablePath:process.env.CHROME}:{channel:"chrome"})});
  try {
    if(screens)fs.mkdirSync(screens,{recursive:true});
    const env=require("../support/native-folder-fixture.cjs").hostEnv(path.join(tmp,"folder-host"),root);
    const author=[
      "import json,sys",
      "sys.path.insert(0,'tests')",
      "from native_sample import write_design,read_design",
      "manifest = write_design(sys.argv[1],json.load(sys.stdin))",
      "print(json.dumps(read_design(manifest)))"
    ].join("\n");
    const [small,large,dense]=fixtures();
    for(const [label,project] of [["sensor",small],["pidp11",large],["dense",dense]]) {
      const input=path.join(tmp,label,"Project.waffle");
      const saved=JSON.parse(execFileSync("python3",["-B","-c",author,input],{
        cwd:root,env,input:JSON.stringify(Atrium.validate(project)),encoding:"utf8",maxBuffer:32*1048576}));
      const tool=(op,args={})=>JSON.parse(execFileSync("python3",["mcp/server.py","--project",input,"--cli",op,"--args",JSON.stringify(args)],
        {cwd:root,env,encoding:"utf8"}));
      const expected=tool("read_netlist"),txt=expected.untrusted_design_text.text;
      assert.equal(tool("read_netlist",{line_offset:3,line_limit:2}).untrusted_design_text.text,txt.split("\n").slice(3,5).join("\n")+"\n");
      const bad=tool("validate_netlist",{text:'netlist 1\nnet N = [UNKNOWN.1]'}), diag=bad.untrusted_design_text.diagnostics[0];
      assert.equal(bad.valid,false);assert.deepEqual([diag.code,diag.line,diag.column,diag.endColumn],["unknown-part",2,10,17]);
      for(const theme of ["light","dark"]) {
        const page=await browser.newPage({viewport:{width:1400,height:900},colorScheme:theme,reducedMotion:"reduce"}), errors=[];
        page.on("pageerror",e=>errors.push(e.message));page.setDefaultTimeout(12000);
        try {
          await page.goto(pathToFileURL(path.join(root,"app","index.html")).href);
          await page.locator("dialog.sp-dialog[open] [data-start-action=demo]").click();await page.locator("#doc-name").filter({hasText:"Sensor board"}).waitFor();
          const showProject=project=>page.evaluate(async({project,theme})=>{
            await AtriumLazy.need(AtriumLazy.validatorsFor(project));await AtriumNavHost.replaceProject(Atrium.validate(project),{force:true,dirty:false});
            AtriumTheme.set({preset:theme,followSystem:false},{persist:false});
            AtriumNavHost.info("Ready");
          },{project,theme});
          const inspectSource=label==="pidp11"&&theme==="light";
          await showProject(inspectSource?project:saved);
          assert.ok(await page.evaluate(()=>!globalThis.AtriumNetlistText && !globalThis.AtriumNetlistView && !globalThis.AtriumRuleLint),"closed tools do no work at startup");
          if(inspectSource){
            const board=project.documents.find(d=>d.kind==="pcb"),row=AtriumRules.sourceReport(board.sourceRules,board).find(r=>r.status==="source-only");
            await page.getByText("Import report",{exact:true}).first().click();
            await page.getByRole("button",{name:"View import details",exact:true}).click();
            const report=page.getByRole("dialog").filter({has:page.getByRole("heading",{name:"Import details"})});
            await report.locator("details > summary").filter({hasText:board.name+" · "+board.sourceRules.length+" Altium design rules"}).click();
            await report.getByText(row.name+" · Source only",{exact:true}).click();
            assert.equal(await report.locator("pre").textContent(),row.text);
            assert.ok((await report.innerText()).includes(row.reason));
            await report.getByRole("button",{name:"Done"}).click();
            // Netlist parity compares the same verified saved projection. The source
            // report above belongs to the fresh Altium import before native adoption.
            await showProject(saved);
          }
          const menu=page.locator('.menubar details[data-menu="design"]');
          const choose=async a=>{await menu.locator(":scope > summary").click();await menu.locator('[data-action="'+a+'"]').click();};
          const shot=async name=>{if(!screens)return;await page.evaluate(async()=>{await document.fonts.ready;await new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)));});await page.screenshot({path:path.join(screens,label+"-"+name+"-"+theme+".png"),animations:"disabled"});};
          for(const kind of label==="sensor"?["schematic","pcb"]:["pcb"]) {
            await page.locator('#document-tabs [data-kind="'+kind+'"]:visible').first().click();
            await choose("netlist-view");const view=page.locator(".netlist-document:visible"),code=view.locator("code");
            await code.getByRole("link").first().waitFor();assert.equal(await code.textContent(),txt,"MCP bytes equal the highlighted editor text");
            assert.equal(await code.evaluate(n=>n.isContentEditable),false);assert.notEqual(await view.evaluate(n=>getComputedStyle(n).backgroundColor),"rgba(0, 0, 0, 0)");await shot("netlist");
            await view.getByRole("button",{name:"Check text"}).click();await view.locator(".netlist-diagnostics:visible").waitFor();
            if(label==="sensor" && kind==="schematic" && theme==="light"){
              await page.evaluate(()=>{
                const h=AtriumNavHost,part=h.doc().items.find(i=>i.ref==="R1");
                h.edit(()=>{part.value="Draft 11k";},"Change R1 value");
              });
              await page.waitForFunction(()=>document.querySelector(".netlist-source").textContent.includes("Draft 11k"));
              assert.equal(await code.textContent(),await page.evaluate(()=>AtriumNetlistText.compile(AtriumNavHost.project()).text));
              await page.evaluate(()=>AtriumNavHost.historyGo(-1));
              await page.waitForFunction(expected=>document.querySelector(".netlist-source").textContent===expected,txt);
            }
            if(label==="dense"){
              assert.ok(await code.getByRole("link").count()<3000,"offscreen records must not create link DOM");
              await view.locator("pre").evaluate(n=>n.scrollTop=n.scrollHeight);
              await code.getByRole("link",{name:"Show net N9",exact:true}).waitFor();
              await code.getByRole("link",{name:"Show net N9",exact:true}).click();
              await page.waitForFunction(()=>AtriumNavHost.highlight()==="N9" && !AtriumDocViews.isShown("netlist"));
            } else if(label==="sensor"){
              const what=kind==="schematic"?"Show pin R1.2":"Show net GND";
              await code.getByRole("link",{name:what,exact:true}).first().click();
              await page.waitForFunction(()=>!AtriumDocViews.isShown("netlist")&&AtriumNavHost.selection().length>0);
              assert.equal(await page.evaluate(()=>AtriumNavHost.doc().kind),kind);
              if(kind==="pcb")assert.equal(await page.evaluate(()=>AtriumNavHost.highlight()),"GND");
              await page.getByRole("tab",{name:"Netlist",exact:false}).click();
              await code.getByRole("link",{name:kind==="pcb"?"Show tag Power":"Show signal Input path",exact:true}).first().click();
              await page.waitForFunction(()=>!AtriumDocViews.isShown("netlist") && AtriumNavHost.selection().length>0);
              assert.equal(await page.evaluate(()=>AtriumNavHost.highlight()),kind==="pcb"?"":"VIN");
            } else {await view.locator("pre").focus();await page.keyboard.press("Escape");}
          }
          if(label==="sensor"){
            await choose("rules");const dlg=page.getByRole("dialog",{name:"Rules and Constraints Editor"});
            await dlg.getByRole("treeitem",{name:"Rule Hints",exact:true}).click();
            for(const t of ["Impossible scope","Priority shadow","Contradictory limits","No board matches"])await dlg.locator("strong").filter({hasText:t}).first().waitFor();
            await shot("rules");await dlg.locator(".rules-hints").getByRole("button",{name:"Input and ground",exact:true}).click();
            assert.equal(await dlg.getByLabel("Rule name",{exact:true}).inputValue(),"Input and ground");
            await dlg.getByLabel("Scope query",{exact:true}).fill('object where net.name = "VIN"');
            await dlg.getByRole("treeitem",{name:"Rule Hints",exact:true}).click();
            assert.equal(await dlg.locator(".rules-hints strong").filter({hasText:"Impossible scope"}).count(),0);
            assert.ok((await dlg.locator(".rules-hints li").filter({hasText:"Input and ground"}).textContent()).includes("Priority shadow"));
          }
          assert.deepEqual(errors,[]);console.log(label,theme,expected.counts,Buffer.byteLength(txt),"bytes");
        } finally {await page.close();}
      }
    }
  } finally {await browser.close();fs.rmSync(tmp,{recursive:true,force:true});}
})().catch(e=>{console.error(e);process.exitCode=1;});
