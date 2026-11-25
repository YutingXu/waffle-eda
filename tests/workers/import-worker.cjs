"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const {performance} = require("node:perf_hooks");
const {resolveObjectURL, Blob} = require("node:buffer");
const {isMainThread, Worker, parentPort, workerData, moveMessagePortToContext} = require("node:worker_threads");
const {appFile} = require("../support/app-source-paths.cjs");
const worker = appFile("import-worker.js");
const fileText = name => fs.readFileSync(appFile(name), "utf8");

if (!isMainThread) {
  // Run the browser worker entry on a real OS worker without exposing CommonJS globals.
  const w = vm.createContext({TextDecoder, TextEncoder, atob, btoa, crypto:require("node:crypto").webcrypto});
  // A browser deserializes each message in the receiving worker, including plain records and binary transfers.
  const port = moveMessagePortToContext(parentPort, w);
  w.self = w;
  w.postMessage = (message, transfers) => port.postMessage(message, transfers);
  w.importScripts = (...files) => files.forEach(f => {
    const file = path.resolve(path.dirname(worker), f);
    vm.runInContext(fs.readFileSync(file, "utf8"), w, {filename: file});
  });
  port.onmessage = event => w.onmessage(event);
  port.start();
  vm.runInContext(workerData.source ?? fileText("import-worker.js"),w,{filename:"import-worker.js"});
} else {
  globalThis.CFB = require("../../app/vendor/cfb.min.js");
  for(const module of ["model","design-query-record","signals","obsolete-project","source-file","altium-ids","altium-rules","pcb-pours","pcb-import","sch-import","pcb-patch","sch-patch","source-copy","io","translator-table","translator-registry","panel","import-sidecars"])require(require("../support/app-source-paths.cjs").appFile(module+".js"));

  const workers = [];
  function host({bundle=true, broken=false, crash=false, noWorker=false}={}) {
    const stats={opened:[],probes:[],fallback:0,sourceFallback:0,exportMessages:[]};
    let odbEnabled = false;
    class BrowserWorker {
      constructor(url) {
        if (broken) throw Error("This origin cannot start a worker");
        stats.opened.push(url.startsWith("blob:")?"embedded":"static");
        const blob = url.startsWith("blob:") ? resolveObjectURL(url) : null;
        Promise.resolve(blob?.text()).then(source=>{
          this.thread=new Worker(__filename,{workerData:{source}});
          workers.push(this.thread);
          this.thread.on("message",data=>this.onmessage?.({data}));
          this.thread.on("error",e=>this.onerror?.(e));
        });
      }
      postMessage(msg,transfers) {
        if (msg.operation === "detect") stats.probes.push(msg.buffer.byteLength);
        if (msg.operation === "translate-export" || msg.operation === "close-export-session")
          stats.exportMessages.push([msg.operation,msg.session,msg.snapshot,!!msg.model]);
        if(crash){
          this.thread.removeAllListeners("message");
          this.thread.postMessage(msg,transfers);
          for (const transfer of transfers) assert.equal(transfer.byteLength,0,"the worker already owns its transferred input");
          this.thread.terminate();setImmediate(()=>this.onerror({message:"Worker process lost"}));return;
        }
        this.thread.postMessage(msg,transfers);
      }
      terminate(){this.thread?.terminate();}
    }
    const page = vm.createContext({Worker:noWorker?undefined:BrowserWorker, Blob, URL, Uint8Array, ArrayBuffer, setTimeout, clearTimeout, AtriumImportSidecars,
      AtriumPrefs:{get:key=>key === "butter.odb" && odbEnabled},
      AtriumSourceCopy:{usedLibrary:AtriumSourceCopy.usedLibrary, prepare(...args){stats.sourceFallback++;return AtriumSourceCopy.prepare(...args);}},
      TextDecoder, location:{href:"file:///application/index.html"}, AtriumIO:{read(name,bytes){stats.fallback++;return AtriumIO.read(name,bytes);}}});
    if(bundle)vm.runInContext(fileText("worker-source.js"),page);
    vm.runInContext(fileText("obsolete-project.js"),page);
    vm.runInContext(fileText("translator-table.js"),page);
    vm.runInContext(fileText("translator-registry.js"),page);
    vm.runInContext(fileText("import-worker-client.js"),page);
    return {api:page.AtriumImport,stats,enableOdb() {odbEnabled = true;}};
  }
  function sourceBoard() {
    const compound=CFB.utils.cfb_new();
    const board=Buffer.from("|VX0=0mil|VY0=0mil\0","latin1"),boardStream=Buffer.alloc(4+board.length);
    boardStream.writeUInt32LE(board.length);board.copy(boardStream,4);
    CFB.utils.cfb_add(compound,"Board6/Data",boardStream);
    const track=Buffer.alloc(54);track[0]=4;track.writeUInt32LE(49,1);track[5]=1;track[6]=12;
    for(const at of [8,10,12])track.writeUInt16LE(0xffff,at);
    track.writeInt32LE(1000000,26);track.writeInt32LE(100000,34);
    CFB.utils.cfb_add(compound,"Tracks6/Data",track);
    return Buffer.from(CFB.write(compound,{type:"array"}));
  }
  async function verifySourceRecovery(){
    const input=sourceBoard(),backing=Buffer.alloc(input.length+4,0xff);
    input.copy(backing,2);const bytes=backing.subarray(2,-2);
    const imported=AtriumIO.read("sample.PcbDoc",bytes),doc=imported.documents[0];
    const track=doc.items.find(i=>i.kind==="track");
    assert.ok(track);track.width+=.1;const before=JSON.stringify(imported);
    const expected=AtriumSourceCopy.prepare(doc,imported.library,bytes);
    assert.ok(expected.changes.length);assert.notDeepEqual(Buffer.from(expected.bytes),input);
    for(const opts of [{},{crash:true},{noWorker:true}]){
      const {api,stats}=host(opts);
      if (opts.crash) {
        await assert.rejects(api.prepareSource(doc,imported.library,bytes), /Worker process lost/);
        assert.equal(stats.sourceFallback, 0);
        assert.deepEqual(bytes,input);
        continue;
      }
      if (opts.noWorker) {
        await assert.rejects(api.prepareSource(doc,imported.library,bytes), /isolated translation worker/);
        assert.equal(stats.sourceFallback, 0);
        continue;
      }
      const result=await api.prepareSource(doc,imported.library,bytes);
      const fallback=false;
      assert.equal(api.mode,fallback?"fallback":"worker");assert.equal(stats.sourceFallback,Number(fallback));
      assert.deepEqual(stats.opened,opts.noWorker?[]:["embedded"]);
      assert.deepEqual(Buffer.from(result.bytes),Buffer.from(expected.bytes));
      assert.deepEqual(result.changes,expected.changes);assert.equal(result.sourceSha256,doc.sourceSha256);
      const corrupt=Buffer.from(bytes);corrupt[corrupt.length-1]^=1;
      await assert.rejects(api.prepareSource(doc,imported.library,corrupt),/SHA-256 mismatch/);
      assert.equal(stats.sourceFallback,fallback?2:0,"source errors from a working worker must reach the caller");
      assert.equal(JSON.stringify(imported),before);assert.deepEqual(bytes,input);
    }
  }
  async function verifyColdDesignExports() {
    // Start each formatter before opening any file. Loading an unrelated importer or
    // exporting a fabrication job must not change the copper, pin types or designators.
    const fixture = path.join(__dirname,"../fixtures/altium/pidp11-io-expander/PiDP11IOExpander.PcbDoc");
    const original = fs.readFileSync(fixture), imported = host();
    const opened = await imported.api.import([{name:path.basename(fixture),bytes:original}]);
    const board = opened.model.documents.find(d => d.kind === "pcb");
    assert.ok(board.pcbDrawing.pours.length>0,"the original Altium board has source pours");
    const {api} = host(), options = {documentId:board.id,provenance:opened.provenance};
    const first = await api.export("altium",opened.model,options);
    const pcbFile = r => r.files.find(f => f.name.endsWith(".PcbDoc")).bytes;
    assert.ok(first.details.counts.polygons>0);
    assert.ok(first.details.counts.regions>0);
    const second = await imported.api.export("altium",opened.model,options);
    assert.deepEqual(pcbFile(first),pcbFile(second));
    assert.deepEqual(fs.readFileSync(fixture),original);

    for (const name of ["parts","sch-objects","hierarchy","multichannel","erc","netlist"]) require(require("../support/app-source-paths.cjs").appFile(name+".js"));
    const project = AtriumParts.example(), child = project.documents.find(d => d.kind === "schematic");
    const parent = Atrium.sheet("schematic","Two channels");
    parent.items.push(AtriumSchObjects.make("sheetsymbol",[40,0],{name:"Repeat(CH,1,2)",sheet:child.id}));
    project.documents.unshift(parent);
    project.multichannel = {naming:"index"};
    const part = child.items.find(i => i.kind === "part"), definition = project.library.find(d => d.id === part.def);
    for (const pin of definition.symbol.pins) pin.electrical = "open collector";
    const netlist = AtriumNetlist.extract(project,{source:"schematic"});
    for (const format of ["kicad","protel","csv"]) {
      const expected = AtriumNetlist[format](netlist,{name:project.name});
      assert.match(expected,/R101/);
      if (format === "kicad") assert.match(expected,/open_collector/);
      const actual = await host({bundle:false}).api.export("netlist-"+format,project,{source:"schematic"});
      assert.equal(actual.files[0].text,expected,format+" netlist preserves channel designators and pin metadata");
    }
  }
  async function verifyFrameExports(api) {
    for (const name of ["sch-objects","design-query-record","hierarchy"]) require(require("../support/app-source-paths.cjs").appFile(name+".js"));
    const p=Atrium.project("Frame example",[]), root=p.documents[0], original=JSON.stringify(p.documents[1]);
    root.name="Assembly"; root.sheet={infinite:true,titleBlock:"none"};
    p.library=[{id:"test-point",name:"Test point",prefix:"TP",symbol:{pins:[{number:"1",name:"SIG",x:0,y:0,electrical:4}],shapes:[]}}];
    for (const [n,x,title] of [[1,-6000,"Input"],[2,6000,"Control"]]) {
      root.items.push({id:"frame"+n,kind:"textframe",role:"frame",text:title,x:x-15,y:-15,w:50,h:30},
        {id:"tp"+n,kind:"part",def:"test-point",ref:"TP"+n,x,y:0,angle:0,link:"test"+n,value:"Test"});
    }
    root.items.push({id:"wire",kind:"wire",points:[[-6000,0],[6000,0]],net:"SIGNAL"},
      {id:"label",kind:"netlabel",text:"SIGNAL",x:-6000,y:0});
    const snapshot=JSON.stringify(p);
    const pins=graph=>graph.nets.filter(n=>n.pins.length).map(n=>[n.name,n.pins.map(c=>c.ref+"."+c.pin.number).sort()]).sort();
    const expected=[["SIGNAL",["TP1.1","TP2.1"]]];
    assert.deepEqual(pins(AtriumHierarchy.compile(p)),expected);
    for (const format of ["kicad","altium"]) {
      const opts={scope:"document",documentId:root.id};
      await assert.rejects(api.export(format,p,opts),/One sheet per frame/);
      const out=await api.export(format,p,{...opts,pageMode:"frames"}), page=out.report.kinds.find(r=>r.kind==="Schematic page");
      assert(page.references.some(r=>r.source.object===root.id && r.reason.includes("one sheet per frame")));
      const frame=out.report.kinds.find(r=>r.kind==="frame");
      assert.deepEqual(frame.references.map(r=>r.source.object).sort(),[root.id+"/frame1",root.id+"/frame2"]);
      const parts=out.report.kinds.find(r=>r.kind==="part");
      assert.deepEqual(parts.references.map(r=>[r.source.file,r.source.object]).sort(),[
        [root.name,root.id+"/tp1"],[root.name,root.id+"/tp2"]],format+" attributes moved components to the original sheet");
      assert.equal(out.files.filter(f=>/\.(SchDoc|kicad_sch)$/i.test(f.name)).length,3);
      assert(!out.files.some(f=>/\.(PcbDoc|kicad_pcb)$/i.test(f.name)),"unrelated board stays out of a selected-sheet export");
      const imported=await api.import(out.files.map(f=>({name:f.name,bytes:f.bytes || new TextEncoder().encode(f.text)})),{translator:format});
      assert.deepEqual(pins(AtriumHierarchy.compile(imported.model)),expected,format+" exported files reconnect both test points");
      if (format === "kicad") for (const sheet of imported.model.documents) {
        assert.equal(sheet.sheetOrigin,"top-left","the editable KiCad page keeps its origin after provenance is separated");
      }
      const symbols=imported.model.documents.flatMap(d=>d.items.filter(i=>i.kind==="sheetsymbol"));
      assert.equal(symbols.length,2);
      for (const sym of symbols) assert(imported.model.documents.some(d=>d.id===sym.sheet));
      assert.equal(JSON.stringify(p.documents[1]),original);
      assert.equal(JSON.stringify(p),snapshot);
    }
  }
  async function verifyImportedScope(api) {
    const bytes = value => new TextEncoder().encode(value);
    const fixture = path.join(__dirname,"../fixtures/altium/pidp11-io-expander/PiDP11IOExpander.SchDoc");
    const sheet = {name:path.basename(fixture),bytes:fs.readFileSync(fixture)};
    const file = scope => ({name:"Scope.PrjPcb",bytes:bytes("[Design]\nHierarchyMode="+scope+"\n[Document1]\nDocumentPath="+sheet.name)});
    const original = await api.import([file(0),sheet],{translator:"altium"});
    const {model,provenance,report} = original, H = AtriumHierarchy;
    const setting = H.scopeSetting(model);
    assert.equal(setting,H.effectiveScope(model,"automatic"));
    assert.equal(H.sourceAutomatic(model),true);
    assert.equal(provenance.manifest.netScope,"automatic");
    assert.equal(report.kinds.find(k=>k.kind==="Net identifier scope").kept,1);
    const native = await api.export("altium",model,{provenance});
    const manifest = result => new TextDecoder().decode(result.files.find(f=>f.name.endsWith(".PrjPcb")).bytes);
    assert.match(manifest(native),/^HierarchyMode=0$/m);
    model.documents[0].items.push({kind:"sheetsymbol",id:"test-child",name:"Child",x:20,y:20,w:8,h:8,
      entries:[{id:"child-entry",name:"TEST",side:"left",offset:3,io:"input"}]});
    assert.notEqual(H.effectiveScope(model,"automatic"),setting);
    const amended = await api.export("altium",model,{provenance});
    assert.match(manifest(amended),new RegExp("^HierarchyMode="+{flat:1,global:3}[setting]+"$","m"));
    assert.ok(amended.report.notes.some(note=>note.includes("preserve the imported connections")));
    const strict = await api.import([file(4),sheet],{translator:"altium"});
    assert.equal(H.scopeSetting(strict.model),"hierarchical");
    const scope = strict.report.kinds.find(k=>k.kind==="Net identifier scope");
    assert.equal(scope.approximated,1);
    assert.equal(scope.references[0].source.object,"Design/HierarchyMode");
    assert.match(scope.references[0].reason,/Power ports connect globally/);
  }

  async function main(){
    const example=new TextEncoder().encode("|RECORD=Board|VX0=0mil|VY0=0mil|VX1=100mil|VY1=0mil|VX2=100mil|VY2=100mil\n|RECORD=Net|ID=0|NAME=CLK\n|RECORD=Track|NET=0|LAYER=TOP|X1=0mil|X2=100mil|Y1=0mil|Y2=100mil|WIDTH=10mil");
    const backing=new Uint8Array(example.length+2);backing.set(example,1);
    const view=backing.subarray(1,-1);
    const kiCadFiles = ["demo.kicad_pro", "demo.kicad_pcb"].map(name => ({name, bytes: fs.readFileSync(path.join(__dirname, "../fixtures/import", name))}));
    const projectWithMinimum = JSON.parse(kiCadFiles[0].bytes.toString("utf8"));
    projectWithMinimum.board.design_settings.rules.min_via_diameter = .15;
    const viaRules = {name:"demo.kicad_dru", bytes:Buffer.from(
      `(version 1) (rule "Power via" (condition "A.NetClass == 'Power'") (constraint via_diameter (min 0.7mm)))`)};
    for(const bundle of [true,false]){
      const {api,stats}=host({bundle});
      const result=await Promise.all([api.read("one.PcbDoc",view),api.read("two.PcbDoc",view)]);
      for(const r of result){assert.equal(r.documents[0].items[0].net,"CLK");assert.deepEqual(r.documents[0].items[0].points[1],[2.54,-2.54]);}
      assert.equal(api.mode,"worker");assert.deepEqual(stats.opened,[bundle?"embedded":"static"]);
      await assert.rejects(api.read("bad.PcbDoc",new Uint8Array([0])),/header/);
      assert.equal(stats.fallback,0,"parse errors do not retry on the UI thread");
      const [, imported] = await api.readSet(kiCadFiles);
      const [board] = imported.documents, defs = new Map(imported.library.map(def => [def.id, def]));
      assert.equal(board.pcbDrawing.pours.length, 1);
      assert.equal(board.sourcePourSignature, AtriumPCBPours.signature(board, defs), "the worker preserves KiCad's fill after installing project rules");
      const [, withRules] = await api.readSet([{...kiCadFiles[0],bytes:Buffer.from(JSON.stringify(projectWithMinimum))},kiCadFiles[1],viaRules]);
      const [constrained] = withRules.documents, ruleDefs = new Map(withRules.library.map(def => [def.id, def]));
      assert.deepEqual(constrained.rules.list.filter(rule => rule.diameterMin != null).map(rule => rule.diameterMin), [.7,.15]);
      assert.equal(constrained.sourcePourSignature, AtriumPCBPours.signature(constrained, ruleDefs),
        "the worker preserves KiCad's fill after linking board and custom via limits");
    }
    for(const bundle of [true,false]) {
      const {api,stats,enableOdb} = host({bundle});
      await verifyFrameExports(api);
      await verifyImportedScope(api);
      const largeHeader = new Uint8Array(1024*1024);
      largeHeader.set(new TextEncoder().encode('{"format":"atrium","name":"header"}'));
      await assert.rejects(api.detect("renamed.json",largeHeader),{code:AtriumObsoleteProject.code,message:AtriumObsoleteProject.note});
      assert.equal(largeHeader.length,1024*1024);
      assert.deepEqual(stats.probes,[AtriumObsoleteProject.limit],"the isolated chooser receives only the bounded signature");
      const result = await api.import([{name:"one.PcbDoc",bytes:view}]);
      const [board] = result.model.documents;
      assert.ok(board.items.some(item => item.kind === "track" && item.net === "CLK"));
      assert.equal(board.sourceName, undefined, "source metadata stays in provenance");
      assert.equal(result.report.translator,"altium");
      assert.deepEqual(Buffer.from(result.provenance.files[0].bytes),Buffer.from(view));
      assert.equal(stats.fallback,0);
      const out = await api.export("kicad", result.model, {scope:"document",documentId:board.id,provenance:result.provenance});
      assert.equal(out.report.translator,"kicad");assert.equal(out.report.direction,"export");
      assert.ok(out.files.some(file=>file.name.endsWith(".kicad_pcb") && /kicad_pcb/.test(file.text)));
      await assert.rejects(api.export("legacy",result.model),/legacy has no export translator/);
      await assert.rejects(api.export("odb",result.model), /Enable ODB\+\+ output in Experimental features/);
      const {model} = await api.import(kiCadFiles,{translator:"kicad"});
      const opts = {date:"2026-11-22T12:00:00Z",documentId:model.documents.find(d=>d.kind==="pcb").id};
      const expected = await Promise.all(["fabrication","ipc2581"].map(id=>api.export(id,model,opts)));
      const start = stats.exportMessages.length, group = api.exportSession();
      try {
        assert.deepEqual(await group.export("fabrication",model,opts),expected[0]);
        assert.deepEqual(await group.export("ipc2581",model,opts),expected[1]);
        assert.deepEqual(await group.export("ipc2581",structuredClone(model),opts),expected[1]);
      } finally {group.close();}
      await assert.rejects(group.export("fabrication",model,opts),/output job has closed/i);
      assert.deepEqual(stats.exportMessages.slice(start),[
        ["translate-export",1,1,true],["translate-export",1,1,false],
        ["translate-export",1,2,true],["close-export-session",1,undefined,false]
      ]);
      assert.deepEqual(await api.export("ipc2581",model,opts),expected[1],"closing a job leaves the worker usable");
      const panelProject = structuredClone(model);
      const panel = AtriumPanel.create(panelProject,{board:opts.documentId,rows:1,cols:2});
      panelProject.documents.push(panel);
      const panelOptions = {...opts,panelId:panel.id};
      enableOdb();
      const rows = [["fabrication",{include:["gerber","drill"]}],
        ["fabrication",{include:["pnp"],provenance:[{files:[]}]}],["ipc2581",{}],["odb",{}]];
      const write = (client,[id,extra]) => client.export(id,panelProject,{...panelOptions,...extra});
      const freshPanel = await Promise.all(rows.map(r=>write(api,r)));
      const firstPanelMessage = stats.exportMessages.length, panelJob = api.exportSession();
      try {
        for (const [i,r] of rows.entries()) assert.deepEqual(await write(panelJob,r),freshPanel[i]);
      } finally {panelJob.close();}
      assert.deepEqual(stats.exportMessages.slice(firstPanelMessage),[
        ["translate-export",2,1,true],["translate-export",2,1,false],
        ["translate-export",2,1,false],["translate-export",2,1,false],["close-export-session",2,undefined,false]
      ],"Flattened and repeat outputs receive one immutable panel snapshot per job");
      assert.deepEqual(await write(api,rows[0]),freshPanel[0],"The panel snapshot is usable in a new job");
      const retainedProject = Atrium.project("Retained drill drawing",[]);
      const retainedBoard = retainedProject.documents.find(d=>d.kind === "pcb");
      retainedBoard.outline = [[0,0],[20,0],[20,15],[0,15]];
      retainedBoard.items = [{id:"source-hole",kind:"pad",layer:"Multi",x:5,y:5,w:1,h:1,shape:"circle",drill:.6,plated:false}];
      retainedBoard.sourceDrillDrawing = {tools:[0,1].map(mark=>({mark,diameter:.6,slot:0,plated:false,hits:1}))};
      const retainedPanel = AtriumPanel.create(retainedProject,{board:retainedBoard.id,rows:1,cols:1,separation:"vscore",
        rails:{top:false,bottom:false},fiducials:{enabled:false},tooling:{enabled:false}});
      retainedProject.documents.push(retainedPanel);
      const mark = [JSON.stringify(["source-hole","pad"]),0];
      const drillOptions = {...opts,documentId:retainedBoard.id,panelId:retainedPanel.id,include:["drillmap"],
        provenance:[{drillDrawings:[{documentId:retainedBoard.id,size:1.27,marks:[mark]}]}]};
      const writeDrill = client=>client.export("fabrication",retainedProject,drillOptions);
      const retainedJob = api.exportSession();
      try {
        const oldDrill = await writeDrill(retainedJob);
        assert.match(oldDrill.details.files[0].title,/source tool symbols/);
        mark[1] = 1;
        const newDrill = await writeDrill(retainedJob);
        assert.notEqual(newDrill.files[0].text,oldDrill.files[0].text,"Changed retained tool symbol changes the drill film");
        assert.deepEqual(newDrill,await writeDrill(api));
      } finally {retainedJob.close();}
      const extras = Array.from({length: 320}, (_, i) => "|RECORD=DrawingTemplate|INDEX=" + i);
      const many = new TextEncoder().encode(new TextDecoder().decode(view) + "\n" + extras.join("\n"));
      const measured = await api.import([{name: "templates.PcbDoc",bytes: many}], {referencePage: {kind: "Unsupported PCB record",offset:309,limit:1}});
      const row = measured.report.kinds.find(r => r.kind === "Unsupported PCB record");
      assert.equal(row.dropped,320);
      assert.ok(row.references.some(ref => ref.grouped && ref.objects.some(v => v?.last - v?.first > 20)), "the worker compacted later source record numbers");
      const references = [...AtriumTranslatorRegistry.references(row)];
      assert.equal(references.length,320);
      assert.equal(new Set(references.map(r => r.source.object)).size,320);
      assert.equal(references[309].source.file,"templates.PcbDoc");
      assert.deepEqual(measured.report.referencePage,{kind:row.kind,offset:309,total:320,items:[references[309]],nextOffset:310});
      assert.match(references[309].source.object,/ASCII record#\d+$/);
      assert.match(references[309].reason,/unsupported/i);
      assert.deepEqual(view,example,"the caller retained its input for a later attempt");
    }
    // A first export in a fresh worker must plot dimension arrows and the dimension's
    // actual stroke lettering. A previous Gerber or KiCad job must not supply missing code.
    for (const f of ["board-shape","vectorize","pcb-text-rich","pcb-text","pcb-draw","pcb-appearance","dxf"]) require(require("../support/app-source-paths.cjs").appFile(f+".js"));
    const dimensions = Atrium.project("Dimension check",[]), drawing = dimensions.documents.find(d=>d.kind === "pcb");
    const dimension = AtriumPCBDraw.dimensionItem("linear",[[0,0],[12.7,3]],{dir:"h",offset:-4});
    dimension.layer = "Mechanical 1";
    drawing.items.push(dimension);
    const dxfOptions = {documentId:drawing.id,outline:false,holes:false,layers:[dimension.layer]};
    const expectedDXF = AtriumDXF.exportBoard(drawing,new Map(),dxfOptions);
    assert.ok(expectedDXF.entities > 5,"the reference includes the dimension label");
    for (const bundle of [true,false]) {
      const {api,stats} = host({bundle});
      const coldDXF = await api.export("dxf",dimensions,dxfOptions);
      assert.deepEqual(stats.opened,[bundle ? "embedded" : "static"]);
      assert.equal(coldDXF.details.entities,expectedDXF.entities);
      assert.equal(coldDXF.files[0].text,expectedDXF.text);
    }
    await verifyColdDesignExports();
    const {api: translator} = host();
    const fixtures = path.join(__dirname,"../fixtures/compat/projects");
    const index = JSON.parse(fs.readFileSync(path.join(fixtures,"..","index.json"),"utf8"));
    const rejection = {code:AtriumObsoleteProject.code,message:AtriumObsoleteProject.note};
    for (const {file:name} of index.projects) {
      const bytes = fs.readFileSync(path.join(fixtures,name)), exact = Buffer.from(bytes);
      await assert.rejects(translator.import([{name,bytes}]),rejection,name);
      assert.deepEqual(bytes,exact,name);
    }
    const manifest = new TextEncoder().encode('{"kind":"project","formatVersion":"2.0"}\n{"id":"doc"}\n');
    assert.equal(await translator.detect("folder.waffle",manifest),null,"the import worker leaves native manifests to folder Open");
    console.log("PASS real worker rejection of the historical project corpus and foreign Altium and KiCad export.");
    for(const opts of [{broken:true},{crash:true}]){
      const {api,stats}=host(opts);
      if (opts.crash) {
        await assert.rejects(api.read("recover.PcbDoc",view), /Worker process lost/);
        await assert.rejects(api.read("new-file.PcbDoc",view), /Worker process lost/);
        assert.equal(stats.fallback, 0); assert.deepEqual(stats.opened, ["embedded", "embedded"]);
        assert.deepEqual(view,example);
        continue;
      }
      await assert.rejects(api.read("recover.PcbDoc",view), /isolated translation worker/);
      assert.equal(api.mode,"unavailable");
      assert.equal(stats.fallback,0);assert.deepEqual(view,example);
    }
    console.log("PASS concurrent reads, embedded/static boot, error isolation and unavailable workers.");
    await verifySourceRecovery();
    console.log("PASS isolated binary source copy, hash mismatch and input ownership.");
    const fixtureDir=process.argv.includes("--fixtures") ? process.argv[process.argv.indexOf("--fixtures")+1] : null;
    if(!fixtureDir)return;
    const {api,stats}=host();
    for(const name of ["Level.Shifter.SchDoc","QFN24.PcbLib","PE42442.SchLib","Panel.PcbDoc"]){
      const bytes=fs.readFileSync(path.join(fixtureDir,name));
      const result=await api.read(name,bytes);
      assert.ok(result.documents.length||result.library.length);
      const p=Atrium.project(name,result.library);
      if(result.documents.length)p.documents=result.documents;
      Atrium.validate(p);
    }
    const bytes=fs.readFileSync(path.join(fixtureDir,"qfsae-0.PcbDoc"));
    let ticks=0;
    const pulse=setInterval(()=>ticks++,1);
    const times=[];
    try{
      for(let i=0;i<3;i++){
        const started=performance.now(),result=await api.read("PDP_V3.PcbDoc",bytes);
        times.push(performance.now()-started);
        const items=result.documents[0].items;
        assert.equal(items.filter(k=>k.kind==="track").length,501);
        assert.equal(items.filter(k=>k.kind==="part").length,52);
        assert.equal(items.filter(k=>k.kind==="via").length,53);
        assert.equal(result.library.reduce((n,d)=>n+d.footprint.pads.length,0),329);
      }
    }finally{clearInterval(pulse);}
    assert.ok(ticks>0);assert.equal(stats.fallback,0);
    console.log("Real-worker dense-board median "+times.sort((a,b)=>a-b)[1].toFixed(1)+" ms over three opens; "+ticks+" main-thread timer callbacks during those opens. All four Altium file types validated.");
    const imported=await api.read("PDP_V3.PcbDoc",bytes),board=imported.documents[0];
    const foreground=AtriumIO.read("PDP_V3.PcbDoc",bytes).documents[0];
    assert.equal(board.pcbDrawing.pours.length,8,"PDP_V3 has eight stored copper fill regions");
    assert.deepEqual(board.pcbDrawing,foreground.pcbDrawing,"foreground and worker preserve the same source drawing");
    assert.equal(board.sourcePourSignature,foreground.sourcePourSignature);
    const noEdits=await api.prepareSource(board,imported.library,bytes);
    assert.deepEqual(Buffer.from(noEdits.bytes),bytes);assert.equal(noEdits.changes.length,0);
    const track=board.items.find(i=>i.kind==="track"&&i.layer==="Top"&&i.sourceRecord?.startsWith("tracks6/data#"));
    assert.ok(track);track.width+=.075;const durations=[];let callbacks=0,largestGap=0,last=performance.now();
    const heartbeat=setInterval(()=>{const t=performance.now();largestGap=Math.max(largestGap,t-last);last=t;callbacks++;},1);
    try{
      for(let i=0;i<3;i++){
        const t=performance.now(),copy=await api.prepareSource(board,imported.library,bytes);
        durations.push(performance.now()-t);assert.equal(copy.changes.length,1);
        if(i===0){
          const reread=await api.read(copy.name,copy.bytes);
          const reopened=reread.documents[0].items.find(v=>v.sourceRecord===track.sourceRecord);
          assert.ok(Math.abs(reopened.width-track.width)<.00000131);
        }
      }
    }finally{clearInterval(heartbeat);}
    assert.ok(callbacks>0);assert.equal(stats.sourceFallback,0);
    console.log("Real-worker verified source copy: "+durations.sort((a,b)=>a-b)[1].toFixed(1)+" ms median over three edited copies, "+callbacks+" foreground timer callbacks across copies and one reopen, largest observed callback gap "+largestGap.toFixed(1)+" ms.");
  }
  main().catch(error=>{console.error(error);process.exitCode=1;}).finally(()=>Promise.all(workers.map(w=>w.terminate())));
}
