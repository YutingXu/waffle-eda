"use strict";
const assert=require("node:assert/strict"),fs=require("node:fs/promises"),path=require("node:path"),{pathToFileURL}=require("node:url");
const {openProjectZIP,saveFirstProjectZIP,readProjectZIP}=require("../support/browser-native-project.cjs");

// Independent printed ink extents in board coordinates (mm, Y down), measured from the
// release's unmodified PiDP11IOExpander.GTO circular apertures and centreline endpoints.
// Isolate one object at a time so a pad or an adjacent legend cannot satisfy a check.
module.exports=async function pcbTextPixels(browser){
  await firstPlacement(browser);
  const page=await browser.newPage();
  try{
    const directory=path.join(__dirname,"../fixtures/altium/pidp11-io-expander");
    const names=["PCB-PiDP11IOExpander.PrjPcb","PiDP11IOExpander.SchDoc","PiDP11IOExpander.PcbDoc"];
    await page.goto(pathToFileURL(path.join(__dirname,"../../app/index.html")).href);
    assert.equal(await page.evaluate(()=>!!globalThis.AtriumDesignReader),false);
    assert.equal(await page.evaluate(()=>Boolean(globalThis.AtriumPCBText || document.querySelector('script[src$="/pcb-text.js"], script[src="pcb-text.js"]'))),false);
    // Hold the lazy script until the reader has reached its first visible board.
    // A slow load must never leave a usable canvas with missing text and bounds.
    await holdPCBText(page);
    const choosing=page.waitForEvent("filechooser");
    await page.locator('dialog.sp-dialog[open] [data-start-action="import"]').click();
    const chooser=await choosing;
    await chooser.setFiles(names.map(name=>path.join(directory,name)));
    await page.waitForFunction(()=>typeof globalThis.releasePCBText==="function");
    assert.equal(await page.evaluate(()=>AtriumNavHost.project().name==="PCB-PiDP11IOExpander"),false);
    await page.evaluate(()=>globalThis.releasePCBText());
    await page.waitForFunction(()=>globalThis.AtriumNavHost?.project().name==="PCB-PiDP11IOExpander");
    assert.equal(await page.evaluate(()=>typeof globalThis.AtriumPCBText.projectItem), "function");
    assert.deepEqual(await page.evaluate(()=>AtriumNavHost.project().documents.map(d=>AtriumImportReports.sourceDocument(d).sourceName).sort()),names.slice(1).sort());
    // The detached canvas includes an authored reference that the opened source lacks.
    await page.evaluate(()=>AtriumLazy.need("AtriumDesignators"));
    const measured=await page.evaluate(paintedInk);
    for(const {name,target,ink,tolerance} of measured)for(let k=0;k<4;k++)
      assert.ok(Math.abs(target[k]-ink[k])<=tolerance,`${name}: painted edge ${k} at ${ink[k]} mm, expected ${target[k]} mm`);
    const frames=await page.evaluate(projectStrings);
    const [initial,short,undo,redo,unrelated]=frames;
    assert.deepEqual(initial.values,["Revision A","PiDP-11 I/O Expander","https://github.com/sstallion/PCB-PiDP11IOExpander"]);
    assert.equal(short.values[2],"R10");assert.deepEqual(undo.values,initial.values);assert.deepEqual(redo.values,short.values);
    assert.deepEqual(frames.map(f=>f.hit),[true,false,true,false,false]);
    for(const f of frames){
      assert.equal(f.raw,".ProjectURL");assert.equal(f.matchesFresh,true,"retained board ink equals a fresh 2D paint");
      if(f.gpu!=null)assert.equal(f.gpu,true,"retained GPU text matches a fresh 2D paint");
    }
    assert.equal(undo.digest,initial.digest);assert.equal(redo.digest,short.digest);assert.notEqual(short.digest,initial.digest);
    assert.equal(unrelated.digest,short.digest);assert.deepEqual(unrelated.damage,[]);
    for(const f of [short,undo,redo])assert.deepEqual(f.damage,[".ProjectURL"]);
    const native=[[50.475896,-2.730246,56.527700,-1.968500],[44.445428,-3.830828,56.527700,-2.857500],
      [27.094434,-1.671828,56.527700,-.698500]];
    for(let n=0;n<3;n++)for(let k=0;k<4;k++)
      assert.ok(Math.abs(initial.inks[n][k]-native[n][k])<=.04,`parameter ${n}, painted edge ${k}: ${initial.inks[n][k]} vs ${native[n][k]} mm`);
    const original=await fs.readFile(path.join(directory,names[2]));
    assert.equal(await page.evaluate(async base64=>{
      const p=AtriumNavHost.project(),doc=p.documents.find(d=>d.kind==="pcb");
      const source=Uint8Array.from(atob(base64),char=>char.charCodeAt(0));
      const copy=await AtriumTranslatorClient.export("altium-source-copy",p,{documentId:doc.id,original:{name:"PiDP11IOExpander.PcbDoc",bytes:source},provenance:AtriumImportReports.provenance()});
      const bytes=copy.files[0].bytes;
      return copy.details.records.length===0 && bytes.length===source.length && bytes.every((v,k)=>v===source[k]);
    },original.toString("base64")),true,"editing project parameters preserves the original Altium PCB bytes");
    await reopenedSourceCopy(browser,page,original);
    const placed=await page.evaluate(placedFields);
    for(const [n,frame] of placed.entries()){
      assert.equal(frame.screen,true,"placed footprint lettering equals literal 2D control");
      if(frame.gpu!=null)assert.equal(frame.gpu,true,"placed footprint lettering equals literal WebGL control");
      assert.equal(frame.print,true,"both layer-set PDF pages equal literal controls");
      assert.equal(frame.gerber,true,"top and bottom Gerbers equal literal controls");
      assert.deepEqual(frame.ink,n%2?[true,true]:[false,false],"pick points are on the long literal inscription only");
      assert.deepEqual(frame.hits,n%2?["pt","pb"]:[null,null],"the visible inscription can be picked after edit or redo");
      assert.deepEqual(frame.hiddenHits,[null,null],"hidden inscriptions are excluded from picking");
      assert.deepEqual(frame.changed,n?["pb","pt"]:[]);
    }
    const outlines=await page.evaluate(footprintOutlines);
    for(const [name,{expected,expectedGPU,screen,batched,gpu}] of Object.entries(outlines)){
      assert.deepEqual(screen,expected,`${name}: 2D footprint fill and stroke`);
      assert.deepEqual(batched,expected,`${name}: batched 2D footprint fill and stroke`);
      if(gpu)assert.deepEqual(gpu,expectedGPU,`${name}: WebGL footprint fill and stroke`);
    }
  }finally{await page.close();}
};

async function footprintOutlines(){
  await AtriumLazy.need(["AtriumBoardShape","AtriumCanvasBoardBatches","AtriumCanvasGPU"]);
  const GPU=AtriumCanvasGPU, S=AtriumBoardShape;
  const canvas=document.createElement("canvas");
  canvas.style.cssText="position:fixed;left:-4000px;top:0;width:320px;height:320px";
  document.body.append(canvas);
  const view=AtriumCanvas.create(canvas), I=view.internals();
  view.restoreCamera({cx:0,cy:0,scale:100,referenceScale:100});
  const supported=!!document.createElement("canvas").getContext("webgl2");
  const rect=[[-.8,-.5],[.805,-.5],[.805,.5],[-.8,.5]], curve=S.circle(2,[0,0]);
  const curved={regionShape:curve,points:S.flattenContour(curve.contour),fill:false};
  const region={layer:"Mechanical",style:undefined,width:0};
  const roundRegion={...region,kind:"circle",points:undefined,x:0,y:0,r:.355};
  const cases={
    "native filled without an outline":[{fill:true,width:0},[.84,0],[true,false]],
    "native filled circle without an outline":[{kind:"circle",points:undefined,x:0,y:0,r:.35,fill:true,width:0},[.39,0],[true,false]],
    "native filled with an outline":[{fill:true,width:.16},[.84,0],[true,true]],
    "imported filled with an outline":[{fill:true,width:.16,strokeOutline:true},[.84,0],[true,true]],
    "straight unfilled with a default outline":[{fill:false,width:0},[.8,0],[false,true]],
    "legacy silk hairline on boundary":[{layer:undefined},[.805,0],[false,true]],
    // Native style-only overlays have a default vector pen and a GPU hairline.
    "legacy silk outside the GPU hairline":[{layer:undefined},[.84,0],[false,true],[false,false]],
    "curved unfilled without an outline":[{...curved,width:0},[1,0],[false,false]],
    "curved unfilled with an outline":[{...curved,width:.16},[1,0],[false,true]],
    "region hairline on boundary":[region,[.805,0],[false,true]],
    "region hairline clear of former pen":[region,[.84,0],[false,false]],
    "filled region has no pen":[{...region,fill:true},[.84,0],[true,false]],
    "circular region hairline on boundary":[roundRegion,[.355,0],[false,true]],
    "circular region hairline clear of former pen":[roundRegion,[.39,0],[false,false]]
  };
  const tracks=Array.from({length:1500},(_,n)=>{
    const x=-1.45+(n%50)*.055,y=-1.45+Math.floor(n/50)*.09;
    return {id:"density-"+n,kind:"track",layer:"Top",width:.03,points:[[x,y],[x+.03,y]]};
  });
  const opts={grid:false,origin:false,showUnrouted:false,editorPane:true,noReuse:true,hidden:new Set(["Top"])};
  const dpr=globalThis.devicePixelRatio;
  function ink(surface,at,layer){
    const [x,y]=view.worldToScreen(at).map(v=>Math.floor(v*dpr));
    const [r,g,b]=surface.getContext("2d").getImageData(x,y,1,1).data;
    return layer==="Mechanical"?r>=92 && b>=92 && g<=85:r>=80 && g>=80 && b<=45;
  }
  function sample(doc,defs,at,layer,accelerated){
    GPU.enable(accelerated);
    view.render(doc,defs,opts);
    const surface=accelerated?GPU.composite(I):canvas;
    if(!surface)throw Error("No WebGL frame for footprint outlines");
    return [ink(surface,[0,0],layer),ink(surface,at,layer)];
  }
  try{
    const result={};
    for(const [name,[variant,at,expected,expectedGPU=expected]] of Object.entries(cases)){
      const shape={kind:"path",layer:"Silk",style:"silk",closed:true,points:rect,...variant};
      const defs=new Map([["outline",{footprint:{shapes:[shape],pads:[]}}]]);
      const doc=Atrium.sheet("pcb",name);
      doc.items=[{kind:"part",id:"outline",def:"outline",ref:"",x:0,y:0,angle:0,layer:"Top",showRef:false}];
      const dense={...Atrium.sheet("pcb",name+" with dense copper"),items:[...doc.items,...tracks]};
      const screen=sample(doc,defs,at,shape.layer,false),batched=sample(dense,defs,at,shape.layer,false);
      if(!I.lodUsed)throw Error("Dense PCB did not draw a batched 2D frame");
      const batchedPart=I.cache.lod.info.has(doc.items[0]);
      if(batchedPart===!!shape.regionShape)throw Error(name+": unexpected footprint batching eligibility");
      result[name]={expected,expectedGPU,screen,batched,gpu:supported?sample(doc,defs,at,shape.layer,true):null};
    }
    return result;
  }finally{GPU.enable(null);canvas.remove();}
}

async function reopenedSourceCopy(browser,page,source){
  const saved=await saveFirstProjectZIP(page);
  const archive=await readProjectZIP(saved.buffer);
  const digest=AtriumFormat2.sha256(source);
  assert.deepEqual(Buffer.from(archive.files.get(".waffle/imports/"+digest+"/source")),source);
  const reopened=await browser.newPage();
  try{
    await reopened.goto(page.url());
    await openProjectZIP(reopened,saved);
    await reopened.waitForFunction(()=>AtriumNavHost.folderProject()?.temporary);
    await reopened.locator('#document-tabs [data-kind="pcb"]').first().click();
    await reopened.evaluate(async original=>{
      await AtriumLazy.need("AtriumTranslatorClient");
      const h=AtriumNavHost;
      await h.requireProjectClosure({purpose:"export"});
      await h.folderProject().ensureImportReports();
      globalThis.exactSourceCopy=async ()=>{
        const bytes=Uint8Array.from(atob(original),char=>char.charCodeAt(0));
        const copy=await AtriumTranslatorClient.export("altium-source-copy",h.project(),{
          documentId:h.doc().id,original:{name:"PiDP11IOExpander.PcbDoc",bytes},provenance:AtriumImportReports.provenance()
        });
        const output=copy.files[0].bytes;
        return copy.details.records.length===0 && output.length===bytes.length && output.every((byte,index)=>byte===bytes[index]);
      };
    },source.toString("base64"));
    assert.equal(await reopened.evaluate(()=>globalThis.exactSourceCopy()),true,"the native ZIP reopen exports the same Altium PCB bytes");
    await reopened.evaluate(()=>{
      const h=AtriumNavHost, polygon=h.doc().items.find(item=>item.kind==="polygon");
      h.edit(()=>{polygon.points[0][0]+=.2;},"Change the original copper contour");
    });
    await assert.rejects(reopened.evaluate(()=>globalThis.exactSourceCopy()),/Only existing standalone copper tracks|polygon.*changed/i);
  }finally{await reopened.close();}
}

async function holdPCBText(page){
  await page.evaluate(()=>{
    const head=document.head, append=head.append;
    head.append=function(...nodes){
      if(!nodes.some(node=>node instanceof HTMLScriptElement && new URL(node.src,location.href).pathname.endsWith("/pcb-text.js")))
        return append.apply(this,nodes);
      globalThis.releasePCBText=()=>{
        delete head.append;
        append.apply(head,nodes);
      };
    };
  });
}

async function firstPlacement(browser){
  const page=await browser.newPage();
  try{
    await page.goto(pathToFileURL(path.join(__dirname,"../../app/index.html")).href);
    // The optional starter library loads the footprint renderer during setup.
    // A blank project without those parts exercises the genuinely cold board tool.
    await page.evaluate(async()=>{
      const prefs=await AtriumLazy.need("AtriumPrefs");
      prefs.set("library.starterInNewProjects",false);
    });
    assert.equal(await page.evaluate(()=>Boolean(globalThis.AtriumPCBText)),false);
    await holdPCBText(page);
    await page.getByRole("button", {name:"Continue to editor", exact:true}).click();
    await page.locator('details[data-menu="file"] summary').click();
    await page.getByRole("menuitem", {name:"New Project…", exact:true}).click();
    const name = page.getByRole("dialog", {name:"New project", exact:true}).getByRole("textbox", {name:"New project", exact:true});
    await name.fill("Cold board");
    await name.press("Enter");
    await page.waitForFunction(() => AtriumNavHost.project().name === "Cold board");
    await page.locator('#document-tabs [data-kind="pcb"]').first().click();
    await page.locator('details[data-menu="place"] summary').click();
    await page.getByRole("menuitem",{name:"String",exact:true}).click();
    await page.locator("#canvas").click({position:{x:150,y:150}});
    await page.waitForFunction(()=>typeof globalThis.releasePCBText==="function");
    assert.equal(await page.getByRole("dialog",{name:"Board text",exact:true}).count(),0);
    await page.evaluate(()=>globalThis.releasePCBText());
    const prompt=page.getByRole("dialog",{name:"Board text",exact:true});
    await prompt.getByRole("textbox",{name:"Board text",exact:true}).fill("FIRST");
    await prompt.getByRole("button",{name:"Apply",exact:true}).click();
    await page.waitForFunction(()=>AtriumNavHost.doc().items.some(i=>i.kind==="label" && i.text==="FIRST"));
  }finally{await page.close();}
}

function paintedInk(){
  const source=AtriumNavHost.project().documents.find(d=>d.kind==="pcb");
  const refs=new Map(source.items.filter(i=>i.kind==="part").map(i=>[i.ref,i]));
  const pcb=Atrium.sheet("pcb","Lettering"),testPart={...refs.get("R1"),value:"PCB",x:0,y:0,angle:90};
  const placed={...testPart,ref:"HH",layer:"Bottom",designator:{x:0,y:0,angle:0,height:.8}};
  const authored={...testPart,boardLabels:undefined,sourceRecord:undefined,ref:"HH",layer:"Bottom",refAt:[0,0]};
  const value={at:[0,0],angle:0,field:"value",layer:"Bottom silk",font:"truetype",size:1.524,justify:"bottom-left",mirrored:true,
    sourceTextBox:{mode:"ink",text:"PCB",width:4,height:1,size:1.524,family:"Arial",bold:false,italic:false}};
  // The two HH references use the stroke font’s 1/6-height pen and full cap height.
  const cases=[
    ["free GP0",source.items.find(i=>i.text==="GP0"),[.69850,-17.52600,2.518156,-16.76400]],
    ["reference R1",refs.get("R1"),[24.82850,-8.25500,25.801828,-7.49300]],
    ["rotated reference C2",refs.get("C2"),[35.94100,-2.60350,36.70300,-1.418590]],
    ["mirrored bottom value",testPart,[0,-4,1,0]],
    ["auto-placed bottom reference",placed,[-7/15,-11/15,7/15,11/15]],
    ["authored bottom reference",authored,[-1.19,-.736667,.056667,.056667]]
  ];
  return cases.map(([name,item,target])=>{
    const canvas=document.createElement("canvas"),width=700,height=700;
    canvas.getBoundingClientRect=()=>({width,height});
    const c=AtriumCanvas.create(canvas),scale=130;
    c.restoreCamera({cx:(target[0]+target[2])/2,cy:(target[1]+target[3])/2,scale,referenceScale:scale});
    const documentItem=item===testPart?{...item,boardLabels:[value]}:item;
    const doc={...pcb,items:[documentItem],pcbDrawing:{annotations:{}}};
    c.render(doc,new Map([[item.def,{footprint:{shapes:[],pads:[]}}]]),{grid:false,origin:false,showUnrouted:false});
    const rgb=canvas.getContext("2d").getImageData(0,0,canvas.width,canvas.height).data,dpr=canvas.width/width;
    let left=canvas.width,top=canvas.height,right=-1,bottom=-1;
    for(let y=0;y<canvas.height;y++)for(let x=0;x<canvas.width;x++){
      const i=(y*canvas.width+x)*4;
      if(rgb[i]<80 || rgb[i+1]<80 || rgb[i+2]>45)continue;
      left=Math.min(left,x);top=Math.min(top,y);right=Math.max(right,x+1);bottom=Math.max(bottom,y+1);
    }
    return {name,target,ink:[...c.screenToWorld([left/dpr,top/dpr]),...c.screenToWorld([right/dpr,bottom/dpr])],tolerance:2/(scale*dpr)};
  });
}

async function placedFields(){
  await AtriumLazy.need(["AtriumPrint","AtriumFabOutputs","AtriumCanvasGPU","AtriumUndoStore"]);
  const h=AtriumNavHost,T=AtriumCanvasGPU,lib=Atrium.clone(AtriumParts.catalogue.find(d=>d.id==="std-r"));
  const fields=["REV .bUiLd",".DeSiGnAtOr",".cOmMeNt"];
  lib.id="placed-fields";lib.footprint={name:"Markings",pads:[],shapes:fields.map((text,n)=>({
    kind:"text",text,x:2,y:1+n*4,size:1.2,width:.2,style:"silk",justify:"bottom-left"}))};
  const p=Atrium.project("Placed fields",[lib]),doc=p.documents.find(d=>d.kind==="pcb");
  p.parameters={Build:"F1",Designator:"Wrong project field",Comment:"Wrong project field"};
  doc.outline=[[0,0],[60,0],[60,50],[0,50]];
  doc.items=[["pt","F1","LF",10,12,0,"Top"],["pb","L1","FL",42,28,90,"Bottom"]].map(([id,ref,value,x,y,angle,layer])=>({
    kind:"part",id,ref,value,x,y,angle,layer,showRef:false,def:lib.id,pinNets:{}}));
  await h.replaceProject(p,{force:true});h.selectDocument(doc.id);AtriumUndoStore.record(p);
  const holder=document.createElement("div");holder.style.cssText="position:fixed;left:-4000px;top:0";document.body.append(holder);
  const surface=()=>{
    const canvas=document.createElement("canvas");holder.append(canvas);canvas.getBoundingClientRect=()=>({width:1000,height:570});
    const view=AtriumCanvas.create(canvas);view.restoreCamera({cx:28,cy:21,scale:23,referenceScale:23});return {canvas,view};
  };
  const flat=surface(),gpu=surface(),ready=!!document.createElement("canvas").getContext("webgl2"),changed=[];
  globalThis.AtriumCanvasGPU={...T,damage(i,cache,d){if(i.canvas===flat.canvas)changed.push(...d.changed.map(v=>v.id));return T.damage(i,cache,d);}};
  function mask(surface,design,accelerated){
    const {canvas,view}=surface,board=design.documents.find(d=>d.kind==="pcb"),defs=new Map(design.library.map(d=>[d.id,d]));
    const opts={grid:false,origin:false,showUnrouted:false,project:design};
    view.render(board,defs,accelerated?{...opts,editorPane:true,noReuse:true}:opts);
    const copy=document.createElement("canvas");copy.width=canvas.width;copy.height=canvas.height;
    const ctx=copy.getContext("2d",{willReadFrequently:true});
    if(accelerated){const gl=canvas.previousElementSibling;if(!gl?.matches(".atrium-gpu-board")||gl.style.display==="none")throw Error("No footprint GPU frame");ctx.drawImage(gl,0,0);}
    ctx.drawImage(canvas,0,0);
    const rgba=ctx.getImageData(0,0,copy.width,copy.height).data,out=new Uint8Array(copy.width*copy.height);
    for(let i=0;i<out.length;i++)out[i]=rgba[i*4]>=80 && rgba[i*4+1]>=80 && rgba[i*4+2]<45;
    if(!out.includes(1))throw Error("No footprint ink");return out;
  }
  function literal(){
    const q=Atrium.clone(p),board=q.documents.find(d=>d.kind==="pcb");q.library=[];
    for(const i of board.items){
      const def=Atrium.clone(lib);def.id+="-"+i.id;i.def=def.id;
      def.footprint.shapes.forEach((s,n)=>{s.text=["REV "+p.parameters.Build,i.ref,i.value][n];});
      q.library.push(def);
    }
    return q;
  }
  const same=(a,b)=>a.length===b.length && a.every((v,k)=>v===b[k]);
  const date=new Date(Date.UTC(2026,10,20));
  const print=q=>AtriumPrint.build(q,{date,documents:[doc.id],layerSets:["top","bottom"],footer:false,links:false,bookmarks:false}).pages.map(pg=>pg.list);
  const films=q=>AtriumFabOutputs.build(q,doc.id,{date,origin:"absolute"}).files.filter(f=>/\.(?:GTO|GBO)$/.test(f.name)).map(f=>f.content);
  async function frame(){
    await new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)));
    const q=literal(),fresh=surface(),expected=mask(fresh,q,false);
    const points=[[21.67,12.5],[41.59,20.46]],dpr=fresh.canvas.width/1000;
    const ink=points.map(pt=>{
      const [x,y]=fresh.view.worldToScreen(pt).map(v=>Math.floor(v*dpr));
      return !!expected[y*fresh.canvas.width+x];
    });
    fresh.canvas.remove();
    const screen=same(mask(flat,p,false),expected),webgl=ready?same(mask(gpu,p,true),expected):null;
    const hit=(pt,hidden)=>flat.view.hit(doc,h.defs(),pt,{kinds:["part"],hidden})?.id || null;
    const hits=points.map(pt=>hit(pt));
    const hiddenHits=points.map((pt,n)=>hit(pt,new Set([n===0?"Silk":"Bottom silk"])));
    const a=print(p),b=print(q),g=films(p),g0=films(q);
    return {screen,gpu:webgl,ink,hits,hiddenHits,changed:changed.splice(0).sort(),print:a.length===2 && JSON.stringify(a)===JSON.stringify(b),
      gerber:g.length===2 && same(g,g0)};
  }
  try{
    if(ready)T.enable(true);
    const result=[await frame()];h.edit(()=>{p.parameters.Build="LLLLLLLL";},"Change footprint marking");result.push(await frame());
    h.act("undo");result.push(await frame());h.act("redo");result.push(await frame());return result;
  }finally{globalThis.AtriumCanvasGPU=T;T.enable(null);holder.remove();}
}

async function projectStrings(){
  await AtriumLazy.need(["AtriumCanvasFast","AtriumCanvasGPU","AtriumUndoStore"]);
  const h=AtriumNavHost,doc=h.project().documents.find(d=>d.kind==="pcb");
  h.selectDocument(doc.id);
  // Give the retained views a committed baseline before asking for precise edit damage.
  AtriumUndoStore.record(h.project());
  const width=1600,height=200,scale=48,opts={grid:false,origin:false,showUnrouted:false,layer:"Bottom silk",layerMode:"single"};
  const holder=document.createElement("div");holder.style.cssText="position:fixed;left:-4000px;top:0";document.body.append(holder);
  function surface(){
    const canvas=document.createElement("canvas");holder.append(canvas);canvas.getBoundingClientRect=()=>({width,height});
    const view=AtriumCanvas.create(canvas);view.restoreCamera({cx:41.8,cy:-2.25,scale,referenceScale:scale});
    return {canvas,view};
  }
  const flat=surface(),accelerated=surface(),gpu=AtriumCanvasGPU;
  const damage=[];
  globalThis.AtriumCanvasGPU={...gpu,damage(i,cache,delta){
    if(i.canvas===flat.canvas)damage.push(...delta.changed.map(obj=>obj.text || obj.kind));
    return gpu.damage(i,cache,delta);
  }};
  const capable=!!document.createElement("canvas").getContext("webgl2");
  const rows=["Revision .ProjectRev",".ProjectTitle",".ProjectURL"];
  function pixels(surface,useGPU){
    const {canvas,view}=surface;
    view.render(doc,h.defs(),useGPU?{...opts,editorPane:true,noReuse:true}:opts);
    // Read a copy. Repeated getImageData on the retained editor surface can
    // move Chrome's 2D context to CPU rasterization halfway through the test.
    const ink=document.createElement("canvas");ink.width=canvas.width;ink.height=canvas.height;
    const reader=ink.getContext("2d",{willReadFrequently:true});
    if(useGPU){
      const gl=canvas.previousElementSibling;
      if(!gl?.matches(".atrium-gpu-board")||gl.style.display==="none")throw Error("No GPU frame for board lettering");
      reader.drawImage(gl,0,0);
    }
    reader.drawImage(canvas,0,0);
    const data=reader.getImageData(0,0,ink.width,ink.height).data,dpr=ink.width/width;
    const bounds=rows.map(()=>[Infinity,Infinity,-Infinity,-Infinity]),mask=new Uint8Array(ink.width*ink.height);
    for(let y=0;y<ink.height;y++){
      const worldY=view.screenToWorld([0,(y+.5)/dpr])[1];
      const n=worldY>-.65||worldY< -3.9?-1:worldY> -1.8?2:worldY> -2.8?0:1;
      if(n<0)continue;
      for(let x=0;x<ink.width;x++){
        const j=y*ink.width+x,k=j*4;
        if(data[k]<80 || data[k+1]<80 || data[k+2]>42)continue;
        mask[j]=1;
        const b=bounds[n];b[0]=Math.min(b[0],x);b[1]=Math.min(b[1],y);b[2]=Math.max(b[2],x+1);b[3]=Math.max(b[3],y+1);
      }
    }
    return {mask,inks:bounds.map(b=>[...view.screenToWorld([b[0]/dpr,b[1]/dpr]),...view.screenToWorld([b[2]/dpr,b[3]/dpr])])};
  }
  const match=(a,b)=>a.length===b.length && a.every((v,k)=>v===b[k]);
  const wait=()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));
  async function frame(){
    await wait();
    const labels=rows.map(t=>doc.items.find(i=>i.text===t)),values=labels.map(i=>AtriumPCBText.projectItem(i,h.project()).text);
    const current=pixels(flat,false),fresh=surface(),exact=pixels(fresh,false);fresh.canvas.remove();
    const hit=flat.view.hit(doc,h.defs(),[30,-1.1],{...opts,kinds:["label"]})===labels[2];
    let digest=2166136261;for(const bit of current.mask)digest=Math.imul(digest^bit,16777619);
    return {values,raw:labels[2].text,hit,inks:current.inks,digest,damage:damage.splice(0),matchesFresh:match(current.mask,exact.mask),
      gpu:capable?match(pixels(accelerated,true).mask,exact.mask):null};
  }
  try{
    if(capable)gpu.enable(true);
    const result=[await frame()];
    h.edit(()=>{h.project().parameters.ProjectURL="R10";},"Edit project URL");result.push(await frame());
    h.act("undo");result.push(await frame());h.act("redo");result.push(await frame());
    h.edit(()=>{h.project().parameters.OrderNumber="1234";},"Edit unrelated parameter");result.push(await frame());
    return result;
  }finally{globalThis.AtriumCanvasGPU=gpu;gpu.enable(null);holder.remove();}
}
