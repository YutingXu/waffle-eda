"use strict";
// Exercise a physical, authored 2.0 folder through the editor and its file grant.
// Use the fixture's geometric and electrical measurements as the independent oracle.
const assert = require("node:assert/strict");
const fs = require("node:fs"), os = require("node:os"), path = require("node:path"), crypto = require("node:crypto");
const {pathToFileURL} = require("node:url");
const {hostEnv, folderFiles} = require("../support/native-folder-fixture.cjs");
const {chromium} = require("playwright-core");

const root = path.resolve(process.argv[2] || path.join(__dirname, "../.."));
const fixture = path.join(__dirname, "../fixtures/design-query/query-proof");
const manifest = "Query proof.waffle";
const targetScope = 'track where net.name = "Rail" and width < 0.2';
const hash = bytes => crypto.createHash("sha256").update(bytes).digest("hex");
const rows = bytes => bytes.toString("utf8").trimEnd().split("\n").map(line => JSON.parse(line));
function readAll(dir){
  const names=fs.readdirSync(dir,{recursive:true,withFileTypes:true})
    .filter(entry=>entry.isFile())
    .map(entry=>path.relative(dir,path.join(entry.parentPath || entry.path,entry.name)).split(path.sep).join("/"))
    .filter(name=>name!=="README.md" && !name.startsWith(".waffle/journal/") && !name.startsWith(".waffle/local/"))
    .sort();
  return new Map(names.map(name=>[name,fs.readFileSync(path.join(dir,name))]));
}
const resources = names => names.filter(n=>/^(design-query(?:-parser|-context|-index|-geometry)?|query-fields|query-exchange)\.js$/.test(n));
const stage = process.env.QUERY_PROOF_STAGE || "all";
const include = name => stage==="all" || stage===name;
const result={};
async function menuAction(page,menu,action){
  const group=page.locator('.menubar [data-menu="'+menu+'"]');
  await group.locator(":scope > summary").click();
  await group.getByRole("menuitem",{name:action,exact:true}).click();
}
const state=page=>page.evaluate(()=>({doc:AtriumNavHost.currentId(),dirty:AtriumNavHost.isDirty(),history:AtriumNavHost.undoSteps().history.length}));

// The renderer supplies the same commit plan as the desktop editor. Forward it
// to the native transaction engine and wait for publication before inspecting bytes.
function nativeFolder(work){
  const env=hostEnv(path.join(work,"folder-host"),root);
  return (dir,request)=>folderFiles(env,process.env.PYTHON||"python3",path.join(root,"mcp"),path.join(dir,manifest))(request);
}

async function openPage(browser,dir,commits,folder,{cold=false}={}){
  const page=await browser.newPage({viewport:{width:1360,height:960},reducedMotion:"reduce"});
  const requested=[], errors=[];
  const allowed=new Set(readAll(dir).keys());
  page.setDefaultTimeout(10000);
  page.on("pageerror",e=>errors.push(e.message));
  page.on("request",r=>requested.push(new URL(r.url()).pathname.split("/").pop()));
  await page.exposeFunction("queryProofRead",({grant,paths})=>{
    assert.equal(grant,"query-proof");
    assert.ok(paths.every(name=>allowed.has(name)),"read outside the granted native project");
    return folder(dir,{paths});
  });
  await page.exposeFunction("queryProofCommit",request=>{
    assert.equal(request.grant,"query-proof");
    assert.equal(request.manifest,manifest);
    assert.ok(request.plan.every(member=>allowed.has(member.path)),"write outside the granted native project");
    const receipt=folder(dir,request);
    assert.equal(receipt.saved,true);
    assert.ok(receipt.transaction,"native writer did not publish a transaction");
    for(const [name,digest] of Object.entries(receipt.hashes)){
      assert.equal(hash(fs.readFileSync(path.join(dir,name))),digest,name);
    }
    commits.push(Object.keys(receipt.hashes));
    return receipt;
  });
  await page.clock.install();
  await page.addInitScript(manifest=>{
    const entry={grant:"query-proof",name:"Query proof",manifest};
    window.AtriumHost={platform:"mac",open:async()=>[{name:manifest,folderProject:entry}],finishedOpening(){},markOpened(){},
      folderReadLease:async()=>({lease:"project-files"}),folderRelease:async()=>{},folderClose:async()=>{},folderLocalState:async()=>({}),
      folderAdopt:async()=>true,clearProjectPath(){},setDirty(){},folderRead:q=>queryProofRead(q),folderCommit:q=>queryProofCommit(q)};
  },manifest);
  await page.goto(pathToFileURL(path.join(root,"app/index.html")).href);
  const enter=page.getByRole("button",{name:"Continue to editor",exact:true});
  await enter.waitFor();
  if(cold)await page.clock.runFor(1200);
  assert.equal(await page.evaluate(()=>AtriumLabs.notebookEnabled()),false);
  assert.deepEqual(resources(requested),[],"the shared query compiler must stay cold on empty Home");
  result.emptyHome??=resources(requested);
  await enter.click();
  if(cold){
    await page.clock.runFor(1500);
    result.untouchedEditor=resources(requested);
    assert.deepEqual(result.untouchedEditor,[],"an untouched empty design must not demand the query compiler");
    const first=await expectFilter(page,"track where width < 0.2",[]);
    assert.ok(requested.includes("design-query.js"),"the normal first filter must load the compiler");
    result.firstFilter={count:first.matched,loaded:[...new Set(resources(requested))]};
  }
  await menuAction(page,"file","Open…");
  try {
    await page.waitForFunction(()=>AtriumNavHost.folderProject()?.hasPresented("analog") && AtriumNavHost.doc()?.id==="analog");
  }catch(e){
    const status=await page.locator("#status").textContent();throw new Error("Native open failed. "+status+" "+errors.join(" "),{cause:e});
  }
  result.onNativeOpen??=resources(requested);
  return {page,requested,errors};
}
async function selectDoc(page,id){
  if((await state(page)).doc===id)return;
  await page.locator('#documents [data-doc="'+id+'"]').first().click();
  await page.waitForFunction(id=>AtriumNavHost.currentId()===id && AtriumNavHost.folderProject()?.hasPresented(id),id);
}
async function openFilter(page){
  const input=page.getByLabel("Query expression",{exact:true});
  if(!(await input.isVisible())){await page.evaluate(()=>AtriumNavHost.canvas().focus());await page.keyboard.press("F12");}
  await input.waitFor();return input;
}
async function filter(page,source,diagnostic){
  const input=await openFilter(page);
  await input.fill(source);await input.press("Enter");
  const panel=page.locator(".panel-query");
  // First-use geometry may load after Enter. History records successful Apply
  // only after it has finished, including completed empty results.
  const settled=await page.waitForFunction(({source,diagnostic})=>{
    const panel=document.querySelector(".panel-query");
    if(diagnostic)return new RegExp(diagnostic,"i").test(panel.querySelector(".query-error").textContent);
    return globalThis.AtriumQuery?.history()[0]===source && /^\d+ matched(?: · \d+ unavailable)?$/.test(panel.querySelector(".query-count").textContent);
  },{source,diagnostic},{timeout:5000}).then(()=>true,()=>false);
  const status=await panel.locator(".query-error").textContent();
  const matched=await panel.locator(".query-count").textContent();
  const selected=await page.evaluate(()=>Array.from(AtriumNavHost.selection()).sort());
  const hint=await panel.locator(".query-field-assist").allTextContents();
  return {source:await input.inputValue(),matched,selected,status,hint:hint.join(" "),settled};
}
async function expectFilter(page,source,expected,{count=expected.length,unavailable=0}={}){
  const found=await filter(page,source);
  assert.equal(found.source,source);
  assert.equal(found.settled,true,JSON.stringify(found));
  assert.equal(found.status,"",JSON.stringify(found));
  const expectedCount=count+" matched"+(unavailable ? " · "+unavailable+" unavailable" : "");
  assert.equal(found.matched,expectedCount,JSON.stringify(found));
  assert.deepEqual(found.selected,[...expected].sort(),JSON.stringify(found));
  return found;
}
async function basicFilter(page){
  const baseline=await state(page);
  const classic=await expectFilter(page,"IsTrack And OnLayer('Top') And Width < 0.2mm",["rail-thin"]);
  const native=await expectFilter(page,"track where width < 0.2",["rail-thin","lowercase-rail"]);
  assert.match(native.hint,/mm/);
  const boundary=await expectFilter(page,"track where width <= 0.2 and net.name = \"Rail\"",["rail-thin","rail-at-limit"]);
  await expectFilter(page,'part where designator like "u?"',["offset-u3"]);
  await expectFilter(page,'part where designator like case "u?"',[]);
  const exact=await expectFilter(page,'object where component.designator = "u3"',[],{unavailable:7});
  const folded=await expectFilter(page,'object where component.designator like "u3"',["offset-u3"],{unavailable:7});
  assert.deepEqual(await state(page),baseline);
  return {classic,native,boundary,exact,folded};
}
async function caseAlternative(page){
  const source='part where designator = "u3"', panel=page.locator(".panel-query");
  const before=await state(page),zero=await expectFilter(page,source,[]);
  const button=panel.getByRole("button",{name:/^Use [“"']?U3[”"']?$/i});
  await button.waitFor();
  // The text field validates after typing. A completed empty result must keep
  // its alternative visible long enough for someone to read and choose it.
  await page.clock.runFor(250);
  assert.equal(await button.isVisible(),true,"the case alternative disappeared while the query was unchanged");
  const input=page.getByLabel("Query expression",{exact:true});
  assert.equal(await input.inputValue(),source);
  await button.click();
  const chosen=await input.inputValue();
  assert.equal(chosen,source.replace("u3","U3"));
  const matches=await expectFilter(page,chosen,["offset-u3"]);
  assert.equal(await button.isVisible(),false);
  await expectFilter(page,'part where designator = "u999"',[]);
  assert.equal(await button.isVisible(),false);
  assert.deepEqual(await state(page),before);
  return {original:zero.source,chosen,selected:matches.selected};
}
async function units(page){
  await selectDoc(page,"power");
  const resistors=await expectFilter(page,"resistor where value < 1k and sheet = Power",["r-small"]);
  assert.match(resistors.hint,/Ω/);
  const compatible=await expectFilter(page,"part where value < 1 kΩ",["r-small"],{unavailable:1});
  const power=await expectFilter(page,"resistor where power < 1",["r-small"]);
  const tolerance=await expectFilter(page,"resistor where tolerance = 5",["r-small"]);
  assert.match(power.hint,/\bW\b/);
  assert.match(tolerance.hint,/%/);
  const missing=await filter(page,"part where value < 1k","unit");
  assert.match(missing.status,/unit/i);
  const wrong=await filter(page,"resistor where value < 1 V","Ω");
  assert.match(wrong.status,/Ω/);
  return {resistors:resistors.selected,compatible,resistanceHint:resistors.hint,powerHint:power.hint,toleranceHint:tolerance.hint,
    fieldDiagnostic:missing.status,incompatible:wrong.status};
}
async function near(page){
  await selectDoc(page,"analog");
  const allLands='pad where component.designator = "TP1"';
  await expectFilter(page,allLands,[],{count:2});
  const physical=await page.evaluate(source=>{
    const h=AtriumNavHost;
    return AtriumQuery.run(h.project(),h.doc(),source,{defs:h.defs(),revision:h.revision()}).subs.map(s=>({id:s.id,at:s.at}));
  },allLands);
  assert.deepEqual(physical.map(p=>p.at).sort((a,b)=>a[0]-b[0]),[[32.5,26],[38.5,26]]);
  assert.equal(new Set(physical.map(p=>p.id)).size,2);
  const plated=physical.find(p=>p.at[0]===32.5);
  const matches={repeatedPinLands:physical};
  for(const [key,source,part] of [["top","pad on layer Top near U3 within 1 mm","probe-edge"],
      ["bottom","pad on layer Bottom near U3 within 1 mm","probe-edge"],
      ["origin","pad near origin of U3 within 1 mm","probe-origin"]]){
    const panel=await expectFilter(page,source,[],{count:1});
    const pins=await page.evaluate(source=>{
      const h=AtriumNavHost;
      const found=AtriumQuery.run(h.project(),h.doc(),source,{defs:h.defs(),revision:h.revision()});
      if(found.unknown || found.truncated)throw new Error("Filter could not measure all the physical pad rows.");
      return found.subs.map(sub=>({id:sub.id,part:sub.part.id,pin:sub.pin}));
    },source);
    assert.deepEqual(pins.map(p=>[p.part,p.pin]),[[part,"1"]]);
    if(key!=="origin")assert.equal(pins[0].id,plated.id);
    matches[key]={display:panel.matched,pin:pins[0].id};
  }
  const shift=await page.evaluate(async()=>{
    const h=AtriumNavHost,q="pad on layer Top near U3 within 1 mm",Q=AtriumDesignQuery;
    const count=async()=>Q.count(q,{project:h.project(),documentId:"analog",revision:h.revision()});
    const at=()=>h.doc().items.find(i=>i.id==="offset-u3").x;
    const initial=await count();
    h.edit(()=>{h.doc().items.find(i=>i.id==="offset-u3").x+=.001;},"Move the courtyard one micrometre");
    const moved=await count();
    h.act("undo");
    const undo=await count();
    return {counts:[initial,moved,undo].map(r=>r.complete?r.count:r.diagnostic),restored:at()};
  });
  assert.deepEqual(shift,{counts:[1,2,1],restored:30});
  matches.editAndUndo=shift;
  return matches;
}
async function countRows(page){
  await selectDoc(page,"analog");
  return page.evaluate(async()=>{
    const host=AtriumNavHost;
    const session=host.folderProject();
    const project=await session.requireClosure({purpose:"project"});
    const revision=host.revision();
    const Q=await AtriumLazy.need("AtriumDesignQuery");
    const shadowBefore=AtriumUndoStore.stats().shadow;
    const sources=[["electrical","track where width < 0.15 mm"],["edge","pad on layer Top near U3 within 1 mm","analog"],
      ["bottomEdge","pad on layer Bottom near U3 within 1 mm","analog"],["eitherEdge","pad near U3 within 1 mm","analog"],
      ["origin","pad near origin of U3 within 1 mm","analog"]];
    const counts={};
    for(const [key,source,documentId] of sources)counts[key]=await Q.count(source,{project,documentId,revision});
    return {counts,shadowBefore,shadowAfter:AtriumUndoStore.stats().shadow};
  });
}
async function compileProject(page){
  await selectDoc(page,"power");
  await menuAction(page,"project","Validate Project (ERC)");
  const messages=page.getByRole("region",{name:"Messages",exact:true});
  await messages.getByText("Unconnected pin R1-1",{exact:true}).waitFor();
  const observed=await page.evaluate(()=>AtriumMessages.messages().filter(m=>m.group==="Compiler" && m.check==="unconnectedPins")
    .map(m=>[m.documentId,m.objectId,m.class,m.text]).sort((a,b)=>a[3].localeCompare(b[3])));
  const expected=[["power","r-small","Fatal","R1"],["power","r-bound","Warning","R2"],
    ["power","c-small","Warning","C1"],["monitor","r-control","Warning","R9"]].flatMap(([doc,id,severity,ref])=>
    ["1","2"].map(pin=>[doc,id,severity,"Unconnected pin "+ref+"-"+pin])).sort((a,b)=>a[3].localeCompare(b[3]));
  assert.deepEqual(observed,expected);
  return observed;
}
async function drc(page,id){
  await selectDoc(page,id);
  await menuAction(page,"tools","Run Design Rule Check");
  await page.getByRole("region",{name:"Messages",exact:true}).waitFor();
  await page.waitForFunction(id=>globalThis.AtriumMessages?.messages().some(m=>m.group==="DRC" && m.documentId===id && m.source==="DRC"),id);
  return page.evaluate(id=>AtriumMessages.messages().filter(m=>m.group==="DRC" && m.documentId===id && m.drc)
    .map(({drc:v})=>({rule:v.ruleId,id:v.id,other:v.otherId,actual:v.actual,required:v.required,...(v.scopeDiagnostic?{scopeDiagnostic:v.scopeDiagnostic}:{})})),id);
}
function checkDRC(rows,id,changed){
  const widths=rows.filter(r=>["local-rail","global-rail"].includes(r.rule)).map(r=>[r.id,r.rule,r.actual,r.required]).sort();
  const expected=id==="analog"?
    [["rail-at-limit","global-rail",.2,.25],["rail-thin",changed ? "local-rail" : "global-rail",.12,changed ? .18 : .25]]:
    [["other-thin","global-rail",.12,.25]];
  assert.deepEqual(widths,expected);
  const pair=rows.filter(r=>r.rule==="two-nets");
  if(id==="analog"){
    assert.equal(pair.length,1);
    assert.deepEqual([pair[0].id,pair[0].other].sort(),["pair-minus","pair-plus"]);
    assert.ok(Math.abs(pair[0].actual-.15)<1e-9);
    assert.equal(pair[0].required,.3);
  }else assert.deepEqual(pair,[]);
}
function compareScopeSave(before,after,scope){
  assert.deepEqual([...before.keys()],[...after.keys()]);
  for(const [name,bytes] of before)if(name!==manifest)assert.deepEqual(after.get(name),bytes,name);
  const previous=before.get(manifest),saved=after.get(manifest);
  const expected=rows(previous).map(row=>row.id==="local-rail" ? {...row,value:{...row.value,scope}} : row);
  assert.deepEqual(rows(saved),expected);
  assert.ok(!saved.includes(Buffer.from("IsTrack")));
  const unsaved=previous.toString("utf8").split("\n"),persisted=saved.toString("utf8").split("\n");
  assert.equal(unsaved.length,persisted.length);
  assert.equal(persisted.filter((line,index)=>line!==unsaved[index]).length,1);
  return hash(saved);
}
async function ruleEditor(page,source=targetScope){
  await selectDoc(page,"analog");
  await menuAction(page,"design","Rules…");
  const dialog=page.getByRole("dialog",{name:"Rules and Constraints Editor"});
  await dialog.waitFor();
  const item=dialog.getByRole("treeitem",{name:/Analog guard threshold/});
  await item.click();
  const scope=dialog.getByLabel("Scope query",{exact:true});
  if(!(await scope.isVisible()))await dialog.locator(".rules-scope-row select").first().selectOption("query");
  await scope.fill(source);
  try{
    await page.waitForFunction(source=>[...document.querySelectorAll(".rules-scope code")].some(c=>c.textContent===source),source,{timeout:4000});
  }catch(e){throw Error("Native scope edit rejected. "+await dialog.locator(".rules-query-status:visible").textContent(),{cause:e});}
  assert.equal(await scope.getAttribute("aria-invalid"),null);
  await dialog.getByRole("button",{name:"Apply",exact:true}).click();
  try{
    await page.waitForFunction(source=>AtriumNavHost.project().rules.list.some(r=>r.id==="local-rail" && r.scope?.source===source),source);
  }catch(e){
    throw Error("Rules Apply did not update the project. "+await dialog.locator(".rules-feedback").textContent(),{cause:e});
  }
  await dialog.getByRole("button",{name:"Close",exact:true}).click();
}
async function boundScope(browser,page,dir,commits,folder){
  const source="track near origin of U3 within 1 mm";
  const before=readAll(dir),previousCommits=commits.length;
  await ruleEditor(page,source);
  assert.equal((await state(page)).dirty,true);
  await menuAction(page,"file","Save All");
  await page.waitForFunction(()=>!AtriumNavHost.isDirty());
  const after=readAll(dir);
  assert.deepEqual(commits.slice(previousCommits),[[manifest]]);
  const saved=rows(after.get(manifest)).find(row=>row.id==="local-rail").value.scope;
  assert.equal(saved.languageVersion,1);
  assert.equal(saved.source,source);
  assert.equal(saved.bindings?.length,1);
  const manifestSha256=compareScopeSave(before,after,saved);
  const occurrence=saved.bindings[0];
  assert.equal(source.slice(...occurrence.span),"U3");
  assert.deepEqual([occurrence.target?.docId,occurrence.target?.itemId],["analog","offset-u3"]);
  const reopened=await openPage(browser,dir,commits,folder);
  try{
    const loaded=await reopened.page.evaluate(()=>AtriumNavHost.project().rules.list.find(r=>r.id==="local-rail").scope);
    assert.deepEqual(loaded,saved);
    const identity=await reopened.page.evaluate(async saved=>{
      const h=AtriumNavHost,Q=await AtriumLazy.need("AtriumDesignQuery");
      const read=q=>Q.count(q,{project:h.project(),documentId:"analog",revision:h.revision()});
      h.edit(()=>{
        const original=h.doc().items.find(i=>i.id==="offset-u3");
        original.ref="U8";
        h.doc().items.push({...original,id:"replacement-u3",ref:"U3",x:6,y:7});
      },"Rename the bound component and reuse its label");
      const stillOriginal=await read(saved),newSpelling=await read(saved.source);
      h.edit(()=>{h.doc().items=h.doc().items.filter(i=>i.id!=="offset-u3");},"Delete the bound component");
      const deleted=await read(saved);
      h.act("undo");const restored=await read(saved);h.act("undo");
      return {original:stillOriginal,ephemeral:newSpelling,deleted,restored};
    },saved);
    assert.deepEqual([identity.original.count,identity.ephemeral.count,identity.deleted.complete,identity.restored.count],[0,1,false,0],JSON.stringify(identity));
    assert.equal(identity.deleted.diagnostic?.code,"broken-reference");
    assert.deepEqual(reopened.errors,[]);
    assert.deepEqual(readAll(dir),after);
    return {saved,identity,manifestSha256};
  }finally{await reopened.page.close();}
}
async function savedRules(browser,page,dir,original,commits,folder){
  const pre=await drc(page,"analog");
  checkDRC(pre,"analog",false);
  await ruleEditor(page);
  const h=await state(page);
  assert.equal(h.dirty,true);
  await menuAction(page,"file","Save All");
  await page.waitForFunction(()=>!AtriumNavHost.isDirty());
  const scope={languageVersion:1,source:targetScope};
  const manifestSha256=compareScopeSave(original,readAll(dir),scope);
  const save={files:[manifest],changedFields:{"local-rail":["value.scope"]},scope,manifestSha256};
  assert.deepEqual(commits,[save.files]);
  const next=await openPage(browser,dir,commits,folder);
  try{
    assert.equal(await next.page.evaluate(()=>AtriumNavHost.project().rules.list.find(r=>r.id==="local-rail").scope.source),targetScope);
    const a=await drc(next.page,"analog"),b=await drc(next.page,"control");
    checkDRC(a,"analog",true);checkDRC(b,"control",true);assert.deepEqual(next.errors,[]);
    return {save,analog:a,control:b};
  }finally{await next.page.close();}
}
async function calculation(page){
  await selectDoc(page,"power");
  const record=await page.evaluate(async()=>{
    const host=AtriumNavHost;
    const project=await host.folderProject().requireClosure({purpose:"project"});
    const api=await AtriumLazy.need("AtriumCalculations");
    const run=await api.evaluate(project,{documentId:"power",blockId:"count-resistors",revision:host.revision(),host});
    const row=run.records.find(r=>r.blockId==="count-resistors");
    const snapshot=api.evaluateSnapshot(project,{documentId:"power",blockId:"count-resistors",revision:host.revision()});
    return {value:row.result.value,ok:row.result.ok,display:row.result.display,assertions:row.assertions.map(a=>a.status||a.result?.assertion?.status),
      frozen:snapshot.records.find(r=>r.blockId==="count-resistors")?.result?.value,diagnostic:row.result.diagnostic};
  });
  assert.equal(record.ok,true,JSON.stringify(record));
  assert.equal(record.value,1);assert.equal(record.frozen,1);assert.match(record.display,/1\s+ea/);
  assert.deepEqual(record.assertions,["pass"]);
  return record;
}
async function incompleteChecks(browser,folder){
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),"waffle-broken-query-"));
  fs.cpSync(fixture,dir,{recursive:true});
  const file=path.join(dir,manifest),commits=[];
  const altered=rows(fs.readFileSync(file));
  const invalidBoardScope="track where width < 1 V";
  altered.find(r=>r.id==="two-nets").value.scope2.source=invalidBoardScope;
  altered.find(r=>r.id==="low-ohms").value.scope.source="resistor where value < 1 V";
  fs.writeFileSync(file,altered.map(r=>JSON.stringify(r)).join("\n")+"\n");
  const original=readAll(dir);
  let page;
  try{
    const opened=await openPage(browser,dir,commits,folder);page=opened.page;
    const findings=(await drc(page,"analog")).filter(r=>r.rule==="two-nets");
    assert.equal(findings.length,1);
    const [finding]=findings;
    assert.equal(finding.scopeDiagnostic?.side,"scope2");
    assert.equal(finding.scopeDiagnostic.code,"dimension");
    assert.equal(invalidBoardScope.slice(...finding.scopeDiagnostic.span),"1 V");
    assert.equal(finding.actual,undefined);
    await selectDoc(page,"power");await menuAction(page,"project","Validate Project (ERC)");
    await page.waitForFunction(()=>globalThis.AtriumMessages?.messages().some(m=>m.group==="Compiler" && m.check==="ruleScope"));
    const failure=await page.evaluate(()=>AtriumMessages.messages().filter(m=>m.ruleId==="low-ohms" && m.check==="ruleScope").map(m=>({severity:m.class,description:m.text})));
    assert.equal(failure.length,1);
    assert.equal(failure[0].severity,"Error");
    assert.match(failure[0].description,/Ω/);
    assert.deepEqual(opened.errors,[]);
    assert.deepEqual(readAll(dir),original);assert.deepEqual(commits,[]);
    return {board:{rule:finding.rule,...finding.scopeDiagnostic},schematic:failure};
  }finally{await page?.close();fs.rmSync(dir,{recursive:true,force:true});}
}
async function queryConsumers(page,requested) {
  const source = "resistor where value < 1 kΩ and sheet = Power";
  await selectDoc(page,"power");
  const palette = page.locator("dialog#palette");
  const box = palette.getByRole("combobox");
  const open = mode => page.evaluate(mode => AtriumNavCommon.openPalette(mode),mode);
  await open("@");
  await box.fill("@R1");
  await palette.locator(".nav-palette-label").filter({hasText:/^R1$/}).first().waitFor();
  await box.fill("@" + source);
  await palette.locator(".nav-palette-empty:not([hidden])").waitFor();
  assert.ok(!requested.includes("query-service.js"));
  await box.press("Escape");
  await page.evaluate(() => AtriumPrefs.set("butter.query",true));
  for (const mode of ["@","search"]) {
    await open(mode);
    await box.fill((mode === "@" ? "@" : "") + source);
    const group = palette.getByRole("group",{name:"Objects",exact:true});
    try { await group.getByRole("option").first().waitFor(); }
    catch (error) { throw Error(mode + " " + await palette.innerText(),{cause:error}); }
    assert.deepEqual(await group.locator(".nav-palette-label").allTextContents(),["R1"]);
    const expected = await page.evaluate(async source => {
      const host = AtriumNavHost;
      const result = await AtriumQueryService.search(source,{project:host.project(),revision:host.revision(),enabled:true,fields:["designator"]});
      return result.rows.map(row => row.fields.designator);
    },source);
    assert.deepEqual(await group.locator(".nav-palette-label").allTextContents(),expected);
    await box.press("Enter");
    await page.waitForFunction(() => AtriumNavHost.selection().includes("r-small"));
  }

  await page.evaluate(() => AtriumNavHost.act("bom"));
  const bom = page.locator(".bom-dialog[open]"), input = bom.getByRole("searchbox",{name:"Search BOM lines"});
  await input.fill(source);
  try { await page.waitForFunction(() => {
    const grid = document.querySelector(".bom-dialog .ui-sheet-grid");
    return grid && grid.tBodies[0].textContent.includes("R1") && !grid.tBodies[0].textContent.includes("R2") &&
      !grid.tBodies[0].textContent.includes("C1") && !grid.parentElement.hasAttribute("aria-busy");
  }); } catch (error) { throw Error(await bom.innerText(),{cause:error}); }
  await page.evaluate(() => {
    AtriumHost.exportFile = async (name,text) => { window.queryBOMExport = {name,text}; return true; };
  });
  await bom.getByRole("combobox",{name:"Export format"}).selectOption("csv");
  await bom.getByRole("button",{name:"Export",exact:true}).click();
  const exported = await page.waitForFunction(() => window.queryBOMExport).then(handle => handle.jsonValue());
  assert.match(exported.name,/-BOM\.csv$/);
  assert.match(exported.text,/\bR1\b/);
  assert.doesNotMatch(exported.text,/\b(?:R2|C1|R9)\b/);
  await page.evaluate(async () => {
    const real = await AtriumLazy.need("AtriumPrintReport");
    globalThis.AtriumPrintReport = {...real,open(context,options) {
      return real.open(context,{...options,report:async () => {
        const report = await options.report();
        window.queryBOMReport = report;
        return report;
      }});
    }};
    AtriumHost.exportFile = async (name,bytes) => {
      const chunks = [];
      for (let at = 0; at < bytes.length; at += 8192) chunks.push(String.fromCharCode(...bytes.subarray(at, at+8192)));
      window.queryBOMPDF = {name,base64:btoa(chunks.join(""))};
      return true;
    };
  });
  await bom.getByRole("button",{name:"Export PDF…",exact:true}).click();
  const print = page.locator(".print-report-dialog[open]");
  await print.locator(".print-thumb").first().waitFor();
  const report = await page.evaluate(() => window.queryBOMReport);
  assert.equal(report.sections[0].rows.length,1);
  assert.ok(report.sections[0].rows[0].includes("R1"));
  await print.getByRole("button",{name:"Export PDF…",exact:true}).click();
  const pdf = await page.waitForFunction(() => window.queryBOMPDF).then(handle => handle.jsonValue());
  assert.match(pdf.name,/-BOM\.pdf$/);
  const bytes = Uint8Array.from(Buffer.from(pdf.base64,"base64"));
  const {openDocument,pageText} = await import(pathToFileURL(path.join(root,"app","notebook","datasheet-document.mjs")).href);
  const document = await openDocument(bytes);
  try {
    assert.equal(document.numPages,1);
    const {fields} = await pageText(document,1), text = fields.map(field => field.text).join(" ");
    assert.match(text,/\bR1\b/);
    assert.doesNotMatch(text,/\b(?:R2|C1|R9)\b/);
  } finally { await document.destroy(); }
  await print.getByRole("button",{name:"Close",exact:true}).click();
  await input.fill("R2");
  await page.waitForFunction(() => {
    const tbody = document.querySelector(".bom-dialog .ui-sheet-grid tbody");
    return tbody?.textContent.includes("R2") && !tbody.textContent.includes("R1");
  });
  await bom.getByRole("button",{name:"Close",exact:true}).click();
  await selectDoc(page,"analog");
  const near = "pad on layer Top near U3 within 1 mm";
  await open("@");
  await box.fill("@" + near);
  const pads = palette.getByRole("group",{name:"Objects",exact:true});
  await pads.getByRole("option").first().waitFor();
  const expectedPads = await page.evaluate(async source => {
    const host = AtriumNavHost, found = await AtriumQueryService.search(source,{project:host.project(),documentId:host.doc().id,
      revision:host.revision(),enabled:true,fields:["designator"]});
    return found.rows.map(row => row.fields.designator + "." + row.pin);
  },near);
  assert.deepEqual(await pads.locator(".nav-palette-label").allTextContents(),expectedPads);
  await box.press("Enter");
  await page.waitForFunction(() => AtriumNavHost.selection().includes("probe-edge"));
  await page.evaluate(() => AtriumPrefs.set("butter.query",false));
  return {source,matched:"r-small",bomPdf:{name:pdf.name,rows:report.sections[0].rows.length}};
}
async function consumerFixture(browser,folder) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(),"waffle-query-consumers-")), commits = [];
  let page;
  try {
    fs.cpSync(fixture,dir,{recursive:true});
    // BOM includes physical components. Give the fixture's schematic examples named footprints.
    for (const name of ["Small resistor","Small capacitor"]) {
      const file = path.join(dir,"libraries",name + ".wlib"), records = rows(fs.readFileSync(file));
      records.find(record => record.kind === "librarySettings").value.footprintName = name;
      fs.writeFileSync(file,records.map(record => JSON.stringify(record)).join("\n") + "\n");
    }
    const original = readAll(dir), opened = await openPage(browser,dir,commits,folder);
    page = opened.page;
    const matched = await queryConsumers(page,opened.requested);
    assert.deepEqual(opened.errors,[]);
    assert.deepEqual(readAll(dir),original);
    assert.deepEqual(commits,[]);
    return matched;
  } finally { await page?.close(); fs.rmSync(dir,{recursive:true,force:true}); }
}
async function run(){
  const work=fs.mkdtempSync(path.join(os.tmpdir(),"waffle-native-query-"));
  let browser;
  try{
    const dir=path.join(work,"project");
    fs.cpSync(fixture,dir,{recursive:true});
    const original=readAll(dir),commits=[];
    assert.equal(original.size,10);
    result.memberSha256=Object.fromEntries([...original].map(([name,bytes])=>[name,hash(bytes)]));
    const folder=nativeFolder(work);
    browser=await chromium.launch({...(process.env.CHROME?{executablePath:process.env.CHROME}:{channel:"chrome"}),args:["--allow-file-access-from-files"]});
    result.browser=browser.version();
    if (include("settings") && fs.existsSync(path.join(root,"app/automation/descriptors/query.json"))) {
      const opened=await openPage(browser,dir,commits,folder);
      try { result.settings=await require("../editor/browser-butter-settings.js")(opened.page,opened.requested,root,menuAction); }
      finally { await opened.page.close(); }
      assert.deepEqual(opened.errors,[]);
      assert.deepEqual(readAll(dir),original);
      assert.deepEqual(commits,[]);
    }
    if (stage==="settings") {console.log(JSON.stringify(result,null,2));return;}
    const {page,requested,errors}=await openPage(browser,dir,commits,folder,{cold:include("cold")});
    if(include("filter"))result.filter=await basicFilter(page);
    if(include("case"))result.alternative=await caseAlternative(page);
    if(include("units"))result.units=await units(page);
    if(include("geometry"))result.geometry=await near(page);
    if(include("count")){
      result.count=await countRows(page);
      assert.deepEqual(Object.values(result.count.counts).map(r=>[r.complete,r.count]),[[true,3],[true,1],[true,1],[true,1],[true,1]]);
      assert.equal(result.count.shadowAfter,result.count.shadowBefore);
      if(stage==="count")assert.equal(result.count.shadowBefore,0);
    }
    if(include("erc"))result.erc=await compileProject(page);
    if(include("consumers"))result.consumers=await consumerFixture(browser,folder);
    result.requested=[...new Set(resources(requested))];
    assert.deepEqual(readAll(dir),original,"read and filter operations must preserve every native member");
    assert.deepEqual(commits,[]);
    if(include("rules"))result.rules=await savedRules(browser,page,dir,original,commits,folder);
    if(include("binding"))result.binding=await boundScope(browser,page,dir,commits,folder);
    if(include("calculation"))result.calculation=await calculation(page);
    if(include("diagnostic"))result.incomplete=await incompleteChecks(browser,folder);
    assert.deepEqual(errors,[]);
    assert.equal(await page.evaluate(()=>AtriumLabs.notebookEnabled()),false);
    result.notebookLabs=false;
    result.nativeSaveTransactions=commits;
    console.log(JSON.stringify(result,null,2));
  }finally{await browser?.close();fs.rmSync(work,{recursive:true,force:true});}
}
run().catch(e=>{console.error(JSON.stringify(result));console.error(e);process.exitCode=1;});
