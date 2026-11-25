"use strict";
// Drive normal File Open, Save as Zip, extraction, Discard and Undo in Chromium. The small
// host double supplies temporary picker grants; conversion and extraction use the shipping
// filesystem publisher, Git resolver and on-disk readback. No existing design is opened.
const assert=require("node:assert/strict"),fs=require("node:fs"),os=require("node:os"),path=require("node:path");
const {execFileSync}=require("node:child_process"),{createHash}=require("node:crypto");
const {createStaticServer}=require("../support/browser-app-server.cjs");
const root=path.resolve(__dirname,"../.."),app=path.join(root,"app");
const sha=b=>createHash("sha256").update(b).digest("hex");
const input=Buffer.from(`(kicad_pcb (version 20240108) (generator pcbnew)
 (general (thickness 1.6)) (layers (0 "F.Cu" signal) (31 "B.Cu" signal) (44 "Edge.Cuts" user))
 (net 0 "") (net 1 "GND") (net 2 "SENSE")
 (gr_text "Precision" (at 4.000003 3.000007 12.1234567894) (layer "F.SilkS") (effects (font (size 1 1))))
 (gr_rect (start 0 0) (end 30 20) (stroke (width 0.1) (type default)) (fill none) (layer "Edge.Cuts"))
 (segment (start 4 10) (end 26 10) (width 0.5) (layer "F.Cu") (net 1))
 (segment (start 15 2) (end 15 18) (width 0.4) (layer "F.Cu") (net 2))
 (zone (net 1) (net_name "GND") (layer "F.Cu") (hatch edge 0.5) (connect_pads (clearance 0.25))
  (min_thickness 0.2) (polygon (pts (xy 1 1) (xy 29 1) (xy 29 19) (xy 1 19)))
  (filled_polygon (layer "F.Cu") (pts (xy 1 1) (xy 29 1) (xy 29 19) (xy 1 19)))))
`);
function native(op,request){
  return JSON.parse(execFileSync(process.env.PYTHON||"python3",["-I","-B",path.join(root,"native/project_archive.py"),op],
    {input:JSON.stringify(request),encoding:"utf8",maxBuffer:32*1048576}));
}
function git(dir,...args){
  return execFileSync("git",["-c","user.name=Fixture","-c","user.email=archive@example.invalid",
    "-c","commit.gpgSign=false","-c","core.hooksPath="+os.devNull,"-C",dir,...args],{encoding:"utf8",stdio:["ignore","pipe","pipe"]});
}
async function serve(){
  const server=createStaticServer({root:app,decode:true,requireFile:true,mime:{".html":"text/html",".js":"text/javascript",".css":"text/css",".json":"application/json"}});
  await new Promise(r=>server.listen(0,"127.0.0.1",r));return server;
}
module.exports=async function portable(browser,{instrumentOnly=false}={}){
  const tmp=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),"waffle-test-zip-"))),repo=path.join(tmp,"repo"),outside=path.join(tmp,"offline");
  const context=await browser.newContext({viewport:{width:1280,height:900}}),page=await context.newPage(),server=await serve(),errors=[];
  page.on("pageerror",e=>errors.push(e.message));page.setDefaultTimeout(15000);
  const source=path.join(repo,"Sensor.kicad_pcb"),grants=new Map(),leases=new Set();
  let picked="source",zip=null,exportCount=0,converted,extracted,commits=0,firstSaveChoices=0;
  function offer(manifest) {
    const grant="grant-"+grants.size;grants.set(grant,manifest);
    return {name:path.basename(manifest),folderProject:{grant,manifest:path.basename(manifest),name:path.basename(path.dirname(manifest))}};
  }
  const member=(grant,p)=>{
    const dir=path.dirname(grants.get(grant)),target=path.resolve(dir,p);
    assert.ok(target.startsWith(dir+path.sep));return target;
  };
  try{
    fs.mkdirSync(repo);fs.mkdirSync(outside);fs.writeFileSync(source,input);
    git(repo,"init","-b","main");git(repo,"add","Sensor.kicad_pcb");git(repo,"commit","-m","Record synthetic original");
    await page.exposeFunction("testArchiveHost",async(action,q={})=>{
      switch(action){
        case "pick": return picked==="source"?{name:"Sensor.kicad_pcb",data:input.toString("base64")}:
          picked==="zip"?{name:"Sensor.zip",data:zip.toString("base64")}:offer(extracted);
        case "counts": return {exports:exportCount};
        case "importSaveChoice":
          assert.deepEqual(q,{source:"Sensor.kicad_pcb",format:"kicad"});
          firstSaveChoices++;
          return "waffle";
        case "create": {
          const target=path.join(tmp,"new-project");fs.mkdirSync(target);
          return offer(path.join(target,q.name)).folderProject;
        }
        case "convert": converted=native("convert",{...q,parent:repo}).manifest;return offer(converted);
        case "install": extracted=native("install",{...q,parent:outside}).manifest;return offer(extracted);
        case "lease": {const lease=q.grant+"/"+Math.random();leases.add(lease);return {lease};}
        case "release": leases.delete(q.lease);return true;
        case "read": {
          assert.ok(leases.has(q.lease));return {files:q.paths.flatMap(p=>{
            const name=member(q.grant,p);if(!fs.existsSync(name))return [];
            const data=fs.readFileSync(name);return [{path:p,sha256:sha(data),length:data.length,data:data.toString("base64")}];
          })};
        }
        case "original": {
          assert.ok(leases.has(q.lease));const m=grants.get(q.grant);
          return native("original",{root:path.dirname(m),manifest:path.basename(m),bindingPath:q.bindingPath,inputId:q.inputId});
        }
        case "commit": {
          const hashes={};
          for(const item of q.plan){
            const name=member(q.grant,item.path),was=fs.existsSync(name)?fs.readFileSync(name):null;
            assert.equal(item.expected,was?sha(was):null);
            if(item.remove){fs.unlinkSync(name);continue;}
            let next;
            if(item.text!=null)next=Buffer.from(item.text);
            else if(item.data!=null)next=Buffer.from(item.data,"base64");
            else {let at=0;const pieces=[];for(const edit of item.splice.edits){
              pieces.push(was.subarray(at,edit.offset),Buffer.from(edit.insert));at=edit.offset+edit.remove;
            }pieces.push(was.subarray(at));next=Buffer.concat(pieces);}
            fs.mkdirSync(path.dirname(name),{recursive:true});fs.writeFileSync(name,next);hashes[item.path]=sha(next);
          }commits++;return {saved:true,hashes,transaction:"test-"+commits};
        }
        case "export": zip=Buffer.from(q.data,"base64");exportCount++;return true;
        default: throw Error("Unexpected test host operation "+action);
      }
    });
    await page.addInitScript(()=>{
      const call=(a,q)=>testArchiveHost(a,q),decode=s=>Uint8Array.from(atob(s),c=>c.charCodeAt(0));
      globalThis.AtriumHost={
        open:async()=>{const p=await call("pick");return [p.folderProject?p:new File([decode(p.data)],p.name)];},
        chooseProjectFolder:q=>call("create",q),canConvertSibling:f=>f.name==="Sensor.kicad_pcb",
        bindImportSave:({file})=>file.name==="Sensor.kicad_pcb" ? "fixture-source" : null,
        importSaveChoice:({file,format})=>call("importSaveChoice",{source:file?.name,format}),
        folderConvertSibling:({file,...q})=>call("convert",q),
        folderLocateImportSource:()=>{throw Error("First Save queried Git for the selected input");},
        folderReadImportSource:q=>call("original",q),installProjectArchive:q=>call("install",q),
        folderReadLease:q=>call("lease",q),folderRead:q=>call("read",q),folderRelease:q=>call("release",q),folderCommit:q=>call("commit",q),
        folderAdopt:async()=>true,folderClose:async()=>true,folderLocalState:async()=>({}),
        folderImportIgnoreNotice:()=>{throw Error("Save queried the repository ignore rules");},
        exportFile:async(name,payload)=>{
          const ok=await call("export",{name,data:new Uint8Array(payload).toBase64()});
          globalThis.testArchiveCount=(await call("counts")).exports;return ok;
        },setDirty(){},
      };
    });
    await page.goto("http://127.0.0.1:"+server.address().port+"/index.html");
    const action=id=>page.locator('[data-action="'+id+'"]').first().evaluate(el=>el.click());
    async function instrument() {
      const fixture=path.join(root,"tests/fixtures/format-2/instrument"), destination=path.join(tmp,"instrument");
      const files=fs.readdirSync(fixture,{recursive:true}).filter(p=>fs.statSync(path.join(fixture,p)).isFile());
      const unchanged=(dir,selected=files)=>{for(const name of selected)assert.equal(sha(fs.readFileSync(path.join(dir,name))),sha(fs.readFileSync(path.join(fixture,name))),name);};
      fs.cpSync(fixture,destination,{recursive:true});
      extracted=path.join(destination,"Instrument.waffle");picked="folder";
      const nextGrant=()=>"grant-"+grants.size;
      async function opened(grant) {
        await page.waitForFunction(g=>globalThis.AtriumNavHost?.folderProject()?.grant===g && AtriumNavHost.doc().items.some(i=>i.id==="inspection"),grant);
        return page.evaluate(async()=>{
          const h=AtriumNavHost,folder=h.folderProject(),sheet=h.doc(),item=sheet.items.find(i=>i.id==="inspection");
          await folder.ensureImportReports();
          const {bytes}=await folder.readAsset({ownerId:sheet.id,assetRef:item.asset});
          const bitmap=await createImageBitmap(new Blob([bytes],{type:"image/png"})), canvas=document.createElement("canvas");
          canvas.width=bitmap.width;canvas.height=bitmap.height;const ctx=canvas.getContext("2d");ctx.drawImage(bitmap,0,0);bitmap.close();
          return [canvas.width,canvas.height,...ctx.getImageData(0,0,1,1).data,AtriumImportReports.retained().length];
        });
      }
      const exportedAngle=()=>page.evaluate(async()=>{
        const h=AtriumNavHost, folder=h.folderProject(), board=folder.documents().find(row=>row.kind==="pcb");
        await folder.ensureDocument(board.id);
        const client=await AtriumLazy.need("AtriumTranslatorClient");
        const result=await client.export("kicad",h.project(),{scope:"document",documentId:board.id});
        const pcb=result.files.find(file=>file.name.endsWith(".kicad_pcb"));
        return /\(at 2\.000003 3\.000007 ([^)]+)\)/.exec(pcb.text)?.[1];
      });
      const firstGrant=nextGrant();await action("open");
      assert.deepEqual(await opened(firstGrant),[2,2,20,62,92,255,1]);
      const firstSave=commits;await page.evaluate(()=>AtriumNavHost.saveAll());assert.equal(commits,firstSave);unchanged(destination);
      const count=exportCount;await action("save-project-zip");await page.waitForFunction(n=>globalThis.testArchiveCount>n,count);
      const offlineGrant=nextGrant();picked="zip";await action("open");
      await page.getByRole("button",{name:"Extract and open…",exact:true}).click();
      assert.deepEqual(await opened(offlineGrant),[2,2,20,62,92,255,1]);
      const offline=path.dirname(extracted);unchanged(offline);
      assert.equal(await exportedAngle(),"12.1234567894");
      await action("discard-import-data");
      const dialog=page.getByRole("dialog",{name:"Discard Import Data",exact:true});
      await dialog.getByRole("button",{name:"Discard selected import",exact:true}).click();
      await page.waitForFunction(()=>AtriumNavHost.isDirty()&&AtriumImportReports.retained().length===0);
      assert.equal(await page.evaluate(()=>AtriumNavHost.saveAll()),true);
      const provenance=files.filter(name=>name.startsWith(".waffle/imports/"));
      assert.equal(provenance.length,2);
      for(const name of provenance)assert.equal(fs.existsSync(path.join(offline,name)),false);
      unchanged(offline,files.filter(name=>!provenance.includes(name)&&name!=="Instrument.waffle"));
      const withoutBinding=fs.readFileSync(path.join(fixture,"Instrument.waffle"),"utf8").split("\n").filter(line=>!line||JSON.parse(line).kind!=="importIndex").join("\n");
      assert.equal(fs.readFileSync(extracted,"utf8"),withoutBinding);
      assert.equal(await exportedAngle(),"12.123456789");
      await page.evaluate(()=>AtriumNavHost.act("undo"));
      await page.waitForFunction(()=>AtriumNavHost.isDirty()&&AtriumImportReports.retained().length===1);
      assert.equal(await page.evaluate(()=>AtriumNavHost.saveAll()),true);unchanged(offline);unchanged(destination);
      assert.equal(await exportedAngle(),"12.1234567894");
      assert.deepEqual(errors,[]);
      console.log("PASS physical folder open and clean Save, decoded RGBA, offline ZIP extraction, scoped Discard and Undo of source proof");
    }
    if(instrumentOnly){await instrument();return;}
    await action("open");
    await page.waitForFunction(()=>AtriumNavHost.importSession()?.state==="unsaved");
    assert.equal(converted,undefined,"opening the foreign design does not publish a folder");
    await page.evaluate(() => {
      const h = AtriumNavHost, post = Worker.prototype.postMessage;
      const trial = window.testFirstSave = {next:"authored",revisions:[],restore:()=>{Worker.prototype.postMessage=post;}};
      Worker.prototype.postMessage = function(message,...transfer){
        const convert = message?.op === "convert";
        const change = convert && trial.next;
        if (change) trial.next = null;
        if (convert) trial.revisions.push(h.revision());
        const sent = post.call(this,message,...transfer);
        if (change) queueMicrotask(() => {
          const doc = h.doc(), track = doc.items.find(i=>i.kind==="track");
          if (change === "authored") h.edit(()=>{track.width+=.1;},"Edit during first Save",[track.id],{documents:[doc.id],items:[track.id]});
          else h.derive(()=>{},{source:"pours"});
        });
        return sent;
      };
    });
    await action("save");
    await page.waitForFunction(()=>document.getElementById("status").textContent.includes("The design changed during preparation"));
    assert.equal(converted,undefined,"an authored edit cancels first Save before publishing a sibling");
    assert.equal(await page.evaluate(()=>AtriumNavHost.importSession()?.state),"unsaved");
    await page.evaluate(() => {
      AtriumNavHost.act("undo");
      window.testFirstSave.revisions.length = 0;
      window.testFirstSave.next = "derived";
    });
    await action("save");
    const ready=()=>page.waitForFunction(()=>globalThis.AtriumNavHost?.folderProject?.()&&globalThis.AtriumNavHost.doc().kind==="pcb");
    await ready();
    assert.equal(await page.evaluate(async()=>{
      await AtriumNavHost.folderProject().ensureImportReports();
      return AtriumImportReports.retained().length;
    }),1);
    assert.equal(firstSaveChoices,2);
    const projections = await page.evaluate(() => {
      const trial = window.testFirstSave;
      trial.restore();
      return [...new Set(trial.revisions)];
    });
    assert.ok(projections.length > 1 && projections.at(-1) > projections[0],
      "first Save snapshots the later projection after a derived fill");
    assert.ok(converted);const sourceHash=sha(input),logical=".waffle/imports/"+sourceHash+"/source";
    assert.deepEqual(fs.readFileSync(path.join(path.dirname(converted),logical)),input);
    assert.deepEqual(fs.readFileSync(source),input);
    const info=()=>page.evaluate(async()=>{
      await AtriumLazy.need(["AtriumConnectivity","AtriumRules","AtriumPolygonPour","AtriumPCBText"]);
      const host=AtriumNavHost,p=host.project(),b=host.doc(),defs=host.defs();
      const drc=AtriumRules.drc(b,defs,AtriumRules.stored(b,p),{project:p,connections:()=>AtriumConnectivity.inspect(b,defs)});
      const copper=AtriumPolygonPour.outputCopper(b,defs,{project:p});
      // Draw the native board at a fixed size and camera. The live canvas also carries
      // editor overlays and can be resized or switched to a separate GPU board surface.
      const canvas=document.createElement("canvas");
      canvas.getBoundingClientRect=()=>({width:640,height:460});
      const view=AtriumCanvas.create(canvas);
      view.restoreCamera({cx:15,cy:10,scale:17,referenceScale:17,flipped:false});
      view.render(b,defs,{project:p,noReuse:true,grid:false,showUnrouted:false,netNames:false,viaMarks:false,hideRegionGuides:true});
      return {drc:drc.total,geometry:b.items.map(i=>[i.kind,i.width,i.points]),copper:JSON.stringify(copper.regions),
        render:canvas.toDataURL()};
    });
    const before=await info();assert.ok(before.geometry.some(i=>i[0]==="track")&&before.copper.length>2);
    const custom="# team worksheet\n/cache/\n/previews/\n/history/\n/journal/\n/local/\n";
    fs.writeFileSync(path.join(path.dirname(converted),".waffle/.gitignore"),custom);
    for(const sub of ["cache","previews","history","journal","local"]){
      const dir=path.join(path.dirname(converted),".waffle",sub);fs.mkdirSync(dir,{recursive:true});fs.writeFileSync(path.join(dir,"private"),"temp");
    }
    // Install the old Git-only representation as a fixture. Only the explicit archive
    // action may resolve it now, and Save As must refuse before choosing an output root.
    const retainedSource = path.join(path.dirname(converted),logical);
    const [indexName] = fs.readdirSync(path.dirname(retainedSource)).filter(name=>name.startsWith("bindings-"));
    const indexPath = path.join(path.dirname(retainedSource),indexName);
    const rows = fs.readFileSync(indexPath,"utf8").trimEnd().split("\n").map(JSON.parse);
    rows.find(row=>row.kind==="input").git = native("locate",{root:repo,source,sha256:sourceHash,byteLength:input.length}).git;
    const legacy = await page.evaluate(rows=>rows.map(AtriumImportSidecars.canonical).join("\n")+"\n",rows);
    fs.writeFileSync(indexPath,legacy);
    fs.unlinkSync(retainedSource);
    fs.writeFileSync(source,"changed working copy\n");
    assert.equal(await page.evaluate(()=>AtriumNavHost.saveProject({as:true})),false);
    assert.match(await page.locator("#status").textContent(),/retained original has no local copy/i);
    assert.equal(fs.existsSync(path.join(tmp,"new-project")),false);
    await action("save-project-zip");await page.waitForFunction(()=>document.getElementById("status").textContent.includes(".zip"));
    assert.equal(exportCount,1);
    const first=zip;await page.evaluate(async()=>{await (await AtriumLazy.need("AtriumProjectArchiveUI")).save();});
    assert.deepEqual(zip,first);assert.equal(exportCount,2);
    const exportsAtLeast=n=>page.waitForFunction(count=>globalThis.testArchiveCount>=count,n);
    await page.evaluate(()=>{
      const h=AtriumNavHost,doc=h.doc(),track=doc.items.find(i=>i.kind==="track");
      h.edit(()=>{track.width+=0.1;},"Change track width",[track.id],{documents:[doc.id],items:[track.id]});
    });
    const version=page.locator('dialog[open][aria-label="Use saved project"]');
    await action("save-project-zip");await version.getByRole("button",{name:"Cancel",exact:true}).click();
    await version.waitFor({state:"hidden"});assert.equal(exportCount,2);
    await action("save-project-zip");await version.getByRole("button",{name:"Zip Last Saved",exact:true}).click();
    await exportsAtLeast(3);assert.deepEqual(zip,first);assert.equal(await page.evaluate(()=>AtriumNavHost.isDirty()),true);
    await action("save-project-zip");await version.getByRole("button",{name:"Save All and Zip",exact:true}).click();
    await exportsAtLeast(4);assert.notDeepEqual(zip,first);assert.equal(await page.evaluate(()=>AtriumNavHost.isDirty()),false);
    await page.evaluate(()=>AtriumNavHost.act("undo"));assert.equal(await page.evaluate(()=>AtriumNavHost.saveAll()),true);
    await action("save-project-zip");await exportsAtLeast(5);
    // Select the untouched first export. The later width edit can legitimately repour copper.
    zip=first;picked="zip";await action("open");
    await page.getByRole("button",{name:"Extract and open…",exact:true}).click();
    await page.waitForFunction(()=>globalThis.AtriumNavHost.folderProject()?.grant==="grant-1");
    assert.deepEqual(fs.readFileSync(path.join(path.dirname(extracted),logical)),input);
    assert.equal(fs.readFileSync(path.join(path.dirname(extracted),".waffle/.gitignore"),"utf8"),custom);
    assert.equal(fs.existsSync(path.join(path.dirname(extracted),".waffle/cache/private")),false);
    assert.equal(fs.readFileSync(source,"utf8"),"changed working copy\n");
    await page.evaluate(async()=>{await AtriumNavHost.folderProject().ensureImportReports();});
    const foreignAngles=()=>page.evaluate(async()=>{
      const h=AtriumNavHost,client=await AtriumLazy.need("AtriumTranslatorClient");
      const values=[];
      for(const translator of ["kicad","altium"]){
        const out=await client.export(translator,h.project(),{scope:"document",documentId:h.doc().id});
        if(translator==="kicad"){
          const text=out.files.find(f=>f.name.endsWith(".kicad_pcb")).text;
          values.push(/\(gr_text "Precision" \(at [^ ]+ [^ ]+ ([^)]+)\)/.exec(text)?.[1]);
        }else{
          const bytes=out.files.find(f=>f.name.endsWith(".PcbDoc")).bytes;
          const text=new TextDecoder().decode(bytes).split(/\r?\n/).find(line=>line.includes("|TEXT=Precision|"));
          values.push(/\|ROTATION=([^|]+)/.exec(text)?.[1]);
        }
      }
      return values;
    });
    const exact=["12.1234567894","12.1234567894"], canonicalAngles=["12.123456789","12.123456789"];
    assert.deepEqual(await foreignAngles(),exact,"reopened 2.0 folder emits the imported angle in both design formats");
    await page.evaluate(()=>{
      const h=AtriumNavHost,doc=h.doc(),label=doc.items.find(i=>i.text==="Precision");
      h.edit(()=>{label.angle=-13.987654321;},"Rotate label",[label.id],{documents:[doc.id],items:[label.id]});
    });
    assert.deepEqual(await foreignAngles(),["13.987654321","13.987654321"]);
    await page.evaluate(()=>AtriumNavHost.act("undo"));
    assert.deepEqual(await foreignAngles(),exact);
    const imported=await page.evaluate(async()=>{
      const entry=AtriumImportReports.retained()[0],ui=await AtriumLazy.need("AtriumProjectArchiveUI");
      const h=AtriumNavHost,client=await AtriumLazy.need("AtriumTranslatorClient");
      const files=await ui.originalFiles(entry.index),translation=await client.import(files,{translator:"kicad"});
      await ui.useOriginal(entry,"compare",{host:h});
      const comparison=!!AtriumDiffView.session();AtriumDiffView.close();
      const encoded=await client.export("kicad",h.project(),{scope:"document",documentId:h.doc().id});
      const file=encoded.files.find(f=>f.name.endsWith(".kicad_pcb"));
      const exported=await client.import([{name:file.name,bytes:new TextEncoder().encode(file.text)}],{translator:"kicad"});
      const geometry=p=>p.documents.flatMap(d=>d.items.filter(i=>i.kind==="track").map(i=>i.width)).sort();
      return {sha:await AtriumImportSidecars.sha(files[0].bytes),widths:geometry(translation.model),
        roundTrip:geometry(exported.model),comparison};
    });
    assert.equal(imported.sha,sourceHash);assert.equal(imported.comparison,true);
    assert.deepEqual(imported.widths,[0.4,0.5]);assert.deepEqual(imported.roundTrip,imported.widths);
    const beforeDiscard=await info();
    const boardMember=fs.readFileSync(extracted,"utf8").trimEnd().split("\n").map(JSON.parse)
      .find(row=>row.kind==="document"&&row.docKind==="pcb");
    const boardPath=path.join(path.dirname(extracted),boardMember.path),savedBoard=fs.readFileSync(boardPath);
    await action("discard-import-data");
    const discard=page.getByRole("dialog",{name:"Discard Import Data",exact:true});
    await discard.getByRole("button",{name:"Cancel",exact:true}).click();
    await discard.waitFor({state:"hidden"});
    assert.equal(await page.evaluate(()=>AtriumImportReports.retained().length),1);
    await action("discard-import-data");await discard.getByRole("button",{name:"Discard selected import",exact:true}).click();
    await page.waitForFunction(()=>AtriumNavHost.isDirty()&&AtriumImportReports.retained().length===0);
    assert.equal(await page.evaluate(()=>AtriumNavHost.saveAll()),true);
    assert.equal(fs.existsSync(path.join(path.dirname(extracted),logical)),false);
    assert.deepEqual(fs.readFileSync(boardPath),savedBoard,"Discard preserves the authored native PCB file");
    assert.equal(fs.readFileSync(source,"utf8"),"changed working copy\n");
    assert.equal(git(repo,"show","HEAD:Sensor.kicad_pcb"),input.toString("utf8"));
    assert.deepEqual(await foreignAngles(),canonicalAngles,"discard exports the authored native rotation");
    const after=await info();assert.deepEqual(after.geometry,before.geometry);assert.equal(after.drc,beforeDiscard.drc);assert.equal(after.copper,beforeDiscard.copper);
    assert.ok(after.render.length>1000 && after.render===beforeDiscard.render,"Discard keeps the native PCB artwork pixels identical");
    await page.evaluate(()=>AtriumNavHost.act("undo"));
    await page.waitForFunction(()=>AtriumNavHost.isDirty()&&AtriumImportReports.retained().length===1);
    assert.equal(await page.evaluate(()=>AtriumNavHost.saveAll()),true);
    assert.deepEqual(fs.readFileSync(path.join(path.dirname(extracted),logical)),input);
    picked="folder";await action("open");await page.waitForFunction(()=>globalThis.AtriumNavHost.folderProject()?.grant==="grant-2");
    await page.evaluate(()=>AtriumNavHost.folderProject().ensureImportReports());
    assert.equal(await page.evaluate(()=>AtriumImportReports.retained().length),1);
    assert.deepEqual(await foreignAngles(),exact,"Undo restores the import proof across Save All and native reopen");
    await page.reload();await page.waitForFunction(()=>globalThis.AtriumNavHost?.project() && !AtriumNavHost.folderProject());
    await action("save-project-zip");const initial=page.getByRole("dialog",{name:"Save project first",exact:true});
    await initial.getByRole("button",{name:"Cancel",exact:true}).click();await initial.waitFor({state:"hidden"});
    assert.equal(exportCount,5);
    await action("save-project-zip");await initial.getByRole("button",{name:"Save project…",exact:true}).click();
    await exportsAtLeast(6);assert.ok(fs.readdirSync(path.join(tmp,"new-project")).some(n=>n.endsWith(".waffle")));
    assert.deepEqual(errors,[]);
    await instrument();
    console.log("PASS Git-independent first Save and Save As, explicit ZIP materialization of legacy Git originals, offline extraction, comparison, scoped discard and Undo");
  }catch(error){console.error(await page.locator("#status").textContent(),await page.locator("dialog[open]").evaluateAll(ds=>ds.map(d=>d.getAttribute("aria-label")||d.innerText.slice(0,40))));throw error;}finally{await context.close();await new Promise(r=>server.close(r));fs.rmSync(tmp,{recursive:true,force:true});}
};
