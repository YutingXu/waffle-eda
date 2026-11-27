"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const {pathToFileURL} = require("node:url");
let chromium;
try { ({chromium} = require("../support/playwright.cjs")); }
catch { console.log("SKIP Butter AI editor command proof: Playwright Core unavailable."); process.exit(0); }

function folderFixture() {
  for (const name of ["model","source-file","format-2-codec","format-2-units","format-2-values","format-2-model"])
    require(require("../support/app-source-paths.cjs").appFile(name + ".js"));
  const project = Atrium.project("Wired AI fixture",[{id:"test-part",name:"Test part",prefix:"R",
    symbol:{shapes:[],pins:[{number:"1",name:"Terminal",x:0,y:0,io:"passive"}]}}]);
  const [sheet] = project.documents;
  project.documents = [sheet];
  sheet.id = "wired-sheet";
  sheet.items.push(
    {kind:"part",id:"wired-part",def:"test-part",ref:"R1",value:"Baseline",x:5,y:0,angle:0},
    {kind:"wire",id:"attached-wire",points:[[5,0],[11,0]]},
    {kind:"netlabel",id:"target-label",text:"BASELINE",x:11,y:0});
  const version = () => {
    const result = AtriumFormat2Model.fromEditor(project,{entryDocument:sheet.id});
    const files = result.files.map(({path,file}) => {
      const bytes = AtriumFormat2.serialize(file);
      return {path,base64:Buffer.from(bytes).toString("base64"),sha256:AtriumFormat2.sha256(bytes)};
    });
    return {files,manifest:result.manifestPath};
  };
  const initial = version();
  sheet.items.at(-1).text = "EXTERNALLY_CHANGED";
  return {...initial, revised:version().files};
}

async function nativeFolderProof(browser,root,pkg) {
  const page = await browser.newPage();
  const errors = [];
  page.on("pageerror",error => errors.push(error.message));
  try {
    await page.addInitScript(payload => {
      globalThis.openDiagnostics = [];
      addEventListener("unhandledrejection",event => openDiagnostics.push(event.reason?.stack ?? String(event.reason)));
      let files = new Map(payload.files.map(file => [file.path,file]));
      globalThis.changeFixtureFiles = () => {files = new Map(payload.revised.map(file => [file.path,file]));};
      globalThis.AtriumHost = {
        platform:"mac", async open() {
          return [{name:payload.manifest,folderProject:{grant:"ai-fixture",manifest:payload.manifest,name:"Wired AI fixture"}}];
        },
        async folderReadLease() {return {lease:"ai-read"};},
        async folderRelease() {},async folderAdopt() {return true;},async folderClose() {},
        async folderLocalState() {return {};},finishedOpening() {},markOpened() {},clearProjectPath() {},setDirty() {},
        async folderRead({grant,paths}) {
          if (grant !== "ai-fixture") throw Error("Unexpected folder");
          return {files:paths.map(path => {
            const file = files.get(path);
            const bytes = Uint8Array.from(atob(file.base64),character => character.charCodeAt(0));
            return {path,bytes,length:bytes.length,sha256:file.sha256};
          })};
        }
      };
    },folderFixture());
    await page.goto(pathToFileURL(path.join(root,"app/index.html")).href);
    await page.waitForFunction(() => globalThis.AtriumNavHost);
    await page.evaluate(() => {AtriumPower.setMode("always"); return AtriumNavHost.act("open");});
    await page.waitForFunction(() => AtriumNavHost.folderProject()?.hasPresented("wired-sheet"),null,{timeout:8000}).catch(async error => {
      const state = await page.evaluate(() => ({title:document.title,current:AtriumNavHost.currentId(),
        project:AtriumNavHost.project().name,folder:!!AtriumNavHost.folderProject(),openDiagnostics,
        status:[...document.querySelectorAll("[role=status]")].map(element => element.textContent)}));
      throw Error("Native folder fixture did not open: " + JSON.stringify({state,errors}),{cause:error});
    });
    const result = await page.evaluate(async bundle => {
      const host = AtriumNavHost;
      AtriumPrefs.set("butter.ai",true);
      await AtriumLazy.need(["AtriumButterEditor","AtriumExtensions"]);
      const X = AtriumExtensions;
      X.attach({project:host.project,documentId:host.currentId,revision:host.revision,
        selection:() => new Set(host.selection()),info:host.info},
        {consent:() => ({"ai:provider":true,"propose:edits":true})});
      await X.install(bundle);
      const editor = AtriumButterEditor, project = host.project(), folderProject = host.folderProject();
      const context = {project, folderProject, currentProject:host.project, defs:host.defs(), edit:host.edit};
      await editor.apply("butter.ai.set-policy",{allowed:true,proposeEdits:true});
      host.select(["wired-part"]);
      const ask = () => editor.apply("butter.ai.ask",{provider:"waffle.local-ai-example:local",prompt:"Move the wired part."});
      const review = await AtriumLazy.need("AtriumAI");
      const held = (await ask()).result.proposal;
      const reviewed = review.inspect(held,project).length;
      let partial, copied, stale, digestChanged;
      try {await review.apply(context,held,[0]);} catch (error) {partial = error.message;}
      try {await review.apply(context,JSON.parse(JSON.stringify(held)));} catch (error) {copied = error.code;}
      const applied = await review.apply(context,held);
      const state = () => ({part:host.doc().items.find(row => row.id === "wired-part").x,
        wire:host.doc().items.find(row => row.id === "attached-wire").points});
      const moved = state();
      await host.act("undo");
      const undone = state();
      host.select(["wired-part"]);
      const beforeEdit = (await ask()).result.proposal;
      review.inspect(beforeEdit,project);
      host.edit(() => {host.doc().items.find(row => row.id === "target-label").text = "Edited in editor";},"Unrelated edit");
      try {await review.apply(context,beforeEdit);} catch (error) {stale = error.code;}
      host.select(["wired-part"]);
      const beforeExternal = (await ask()).result.proposal;
      review.inspect(beforeExternal,project);
      changeFixtureFiles();
      try {await review.apply(context,beforeExternal);} catch (error) {digestChanged = error.code;}
      return {reviewed,applied,moved,undone,partial,copied,stale,digestChanged,
        proof:{source:held.editor_source,sha256:held.source_sha256},didNotChange:state()};
    },pkg);
    assert.equal(result.reviewed,2);
    assert.equal(result.applied,2);
    assert.match(result.partial,/one change/);
    assert.equal(result.copied,"stale_source");
    assert.equal(result.stale,"stale_source");
    assert.equal(result.digestChanged,"stale_source");
    assert.match(result.proof.sha256,/^[0-9a-f]{64}$/);
    assert.equal(result.proof.source.documentId,"wired-sheet");
    assert.deepEqual(result.moved,{part:8,wire:[[8,0],[11,0]]});
    assert.deepEqual(result.undone,{part:5,wire:[[5,0],[11,0]]});
    assert.deepEqual(result.didNotChange,result.undone);
  } finally { await page.close(); }
}

(async () => {
  const root = path.resolve(__dirname,"../..");
  const base = path.join(root,"extensions/examples/ai-provider");
  const pkg = Object.fromEntries(["waffle-extension.json","provider.js"].map(file => [file,fs.readFileSync(path.join(base,file),"utf8")]));
  const manifest = JSON.parse(pkg["waffle-extension.json"]);
  manifest.permissions.push("propose:edits");
  pkg["waffle-extension.json"] = JSON.stringify(manifest);
  pkg["provider.js"] += `
const answer = module.exports.respond;
module.exports.respond = async input => {
  if (input.question === "Hold the response.") {
    await new Promise(resolve => setTimeout(resolve,10000));
    return {type:"answer",text:"This answer is stale."};
  }
  if (input.question === "Move the wired part.") return {type:"answer",text:"A component move.",suggestion:{
    componentId:input.context.selection[0],field:"x",value:8
  }};
  if (input.question === "Draft a value edit.") return {type:"answer",text:"A value edit.",suggestion:{
    componentId:input.context.selection[0],field:"value",value:"Reviewed local AI draft"
  }};
  return answer(input);
};
`;
  const browser = await chromium.launch({headless:true,args:["--allow-file-access-from-files"],executablePath:process.env.CHROME ||
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"});
  try {
    const page = await browser.newPage();
    await page.goto(pathToFileURL(path.join(root,"app/index.html")).href);
    await page.getByRole("button",{name:"Try the Demo",exact:true}).click();
    await page.locator("#doc-name",{hasText:"Sensor board"}).waitFor();
    const result = await page.evaluate(async pkg => {
      const host = AtriumNavHost, load = name => AtriumLazy.need(name);
      const lazyBefore = !globalThis.AtriumAIProvidersDesktop;
      await load("AtriumButter");
      let code;
      try { await AtriumButter.run("butter.ai.providers"); } catch (error) {code = error.code;}
      const remainedOff = !globalThis.AtriumAIProvidersDesktop && !globalThis.AtriumAIProviders;
      AtriumPrefs.set("butter.ai",true);
      AtriumPrefs.set("butter.query",true);
      await load(["AtriumButterEditor","AtriumExtensions"]);
      const id = "waffle.local-ai-example:local";
      const X = AtriumExtensions;
      X.attach({project:host.project, documentId:host.currentId, revision:host.revision,
        selection:() => new Set(host.selection()), info:host.info},
        {consent:request => request.kind === "install" ? {"ai:provider":true,"propose:edits":true} : true});
      await X.install(pkg);
      const editor = AtriumButterEditor;
      await editor.apply("butter.ai.set-policy",{allowed:true,tools:["query"]});
      const start = performance.now();
      const worked = await editor.apply("butter.ai.ask",{provider:id,prompt:"Which parts are in the active board?"});
      const latency = performance.now() - start;
      const pending = X.workers.some(worker => worker.pool.startsWith("ai:"));
      const part = host.doc().items.find(item => item.kind === "part");
      host.select([part.id]);
      const old = part.value;
      const args = {componentId:part.id,field:"value",value:"Reviewed local AI draft"};
      const withoutGrant = await editor.apply("butter.ai.ask",{provider:id,prompt:"Draft a value edit."});
      await editor.apply("butter.ai.set-policy",{allowed:true,tools:["query"],proposeEdits:true});
      const suggested = await editor.apply("butter.ai.ask",{provider:id,prompt:"Draft a value edit."});
      const proposal = await AtriumButter.run("butter.ai.draft",args);
      const stayed = host.doc().items.find(item => item.id === part.id).value === old;
      const review = await load("AtriumAI");
      const approved = suggested.result.proposal;
      const project = host.project();
      const context = {project, currentProject:host.project, defs:host.defs(), edit:host.edit};
      const reviewed = review.inspect(approved,project).length === 1 && suggested.result.proposalRevision === host.revision();
      await review.apply(context,approved);
      const applied = host.doc().items.find(item => item.id === part.id).value === args.value;
      await host.act("undo");
      const undone = host.doc().items.find(item => item.id === part.id).value === old;
      const started = editor.apply("butter.ai.ask",{provider:id,prompt:"Hold the response."});
      const deadline = Date.now() + 3000;
      while (!X.workers.some(worker => worker.pool.startsWith("ai:")) && Date.now() < deadline)
        await new Promise(resolve => setTimeout(resolve,10));
      const active = X.workers.some(worker => worker.pool.startsWith("ai:"));
      await editor.apply("butter.ai.set-policy",{allowed:false});
      await editor.apply("butter.ai.set-policy",{allowed:true,tools:["query"],proposeEdits:true});
      const revoked = (await started).result;
      const ended = !X.workers.some(worker => worker.pool.startsWith("ai:"));
      const workspace = host.fileSession();
      await host.replaceProject(Atrium.project("Separate unconsenting project",[]),{force:true});
      const separate = {sameWorkspace:workspace === host.fileSession(),
        policy:(await AtriumButter.run("butter.ai.policy")).result,
        activity:(await AtriumButter.run("butter.ai.activity")).result.requests};
      await host.replaceProject(project,{force:true});
      await editor.apply("butter.ai.set-policy",{allowed:false});
      let optedOut = false;
      try { await editor.apply("butter.ai.ask",{provider:id,prompt:"Repeat the request."}); }
      catch (error) {optedOut = error.code === "permission_denied";}
      return {lazyBefore,off:code,remainedOff,result:worked.result,latency,pending,ops:proposal.proposal?.ops?.length,
        stayed,reviewed,applied,undone,optedOut,suggested:suggested.result.proposal?.ops?.length,
        deniedSuggestion:withoutGrant.result.proposal === undefined,active,ended,separate,revoked};
    },pkg);
    assert.equal(result.off,"butter_disabled");
    for (const flag of ["lazyBefore","remainedOff","stayed","reviewed","applied","undone","optedOut","deniedSuggestion","active","ended"]) assert.equal(result[flag],true,flag);
    assert.equal(result.result.status,"answered",JSON.stringify(result));
    assert.match(result.result.text,/Read [1-9]\d* approved rows/);
    assert.equal(result.ops,1);
    assert.equal(result.suggested,1);
    assert.equal(result.pending,false);
    assert.deepEqual(result.revoked,{status:"failed",code:"stale_source"});
    assert.deepEqual(result.separate,{sameWorkspace:true,policy:{allowed:false,tools:[],proposeEdits:false},activity:[]});
    await nativeFolderProof(browser,root,pkg);
    console.log(`PASS Butter AI browser project isolation, revocation, and native folder proposal guard with connected wires and one Undo. Local two-round request ${result.latency.toFixed(1)} ms.`);
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
