// Imported board rules (app/formats/import-rules.js): an imported Altium board is checked against its own
// rules once the user accepts them ("Use the board's rules", the pcb.importRules preference or MCP
// import_design source_rules:"use"). The real fixture showed 111 markers under Waffle's defaults
// (52 Clearance + 59 Routing Via Style; the via hits went when DRC got a 10 nm size tolerance for
// Altium's 11.811 mil = 0.2999994 mm holes) and shows 2 under its own rules: the two stub tracks
// inside a TH drill (see tests/formats/import-altium-real.cjs).
//
// Fixture: tests/fixtures/altium/pidp11-io-expander/ (BSD-2-Clause; see its NOTICE).
// Run: scripts/test-jsc.sh import-rules   (or node tests/formats/import-rules.cjs)
const assert = require("node:assert/strict"), fs = require("node:fs"), path = require("node:path");
globalThis.CFB = require("../../app/vendor/cfb.min.js");
for (const f of ["model", "parts", "sch-objects", "hierarchy", "board-shape", "stackup", "polygon-pour", "import-link", "source-file", "sch-import",
  "altium-rules", "pcb-pours", "pcb-import", "io", "connectivity", "query", "net-intent", "signals", "rules", "drc", "drc-fixes", "import-rules"]) require(require("../support/app-source-paths.cjs").appFile(f + ".js"));
const A = Atrium, R = AtriumRules, I = AtriumImportRules, DIR = path.join(__dirname, "../fixtures/altium/pidp11-io-expander");
const name = "PiDP11IOExpander.PcbDoc", r = AtriumIO.read(name, new Uint8Array(fs.readFileSync(path.join(DIR, name))));
const p = A.project("PiDP"); p.documents = r.documents; p.library = r.library; AtriumImportLink.reconcile(p, p.documents); A.validate(p);
const defs = new Map(p.library.map(d => [d.id, d])), pcb = p.documents.find(d => d.kind === "pcb");
const drc = doc => R.drc(doc, defs, R.stored(doc, p) || R.defaults(), {connections: () => AtriumConnectivity.inspect(doc, defs), project: p});

// ---------------------------------------------------------------- pending boards
assert.equal(p.rules, undefined, "the importer keeps Altium rules as source records only");
assert.equal(pcb.sourceRules.length, 41);
assert.deepEqual(I.pending(p).map(x => [x.doc.id, x.count, x.tool]), [[pcb.id, 41, "Altium"]]);

// A raw reader leaves source indexing to the import owner.
assert.ok(AtriumPolygonPour.adopt(pcb,defs,{project:p},false));
// ---------------------------------------------------------------- Waffle defaults: 54 violations
const before = drc(pcb), byType = t => before.violations.filter(v => v.type === t).length;
assert.equal(before.total, 54, "defaults: " + JSON.stringify(before.rules.filter(x => x.count).map(x => [x.name, x.count])));
assert.equal(byType("clearance"), 52, "0.2 mm default clearance vs the board's 0.1524 mm");
assert.equal(byType("viaStyle"), 0, "Altium-rounded 0.3 mm via holes pass (10 nm tolerance)");
assert.equal(byType("unrouted"), 2);

// ---------------------------------------------------------------- Use the board's rules: 2 violations
const out = I.apply(pcb, p, defs);
// Altium poured the stored fill under these very rules: it is kept (re-signed), not repoured.
assert.ok(out.kept === 2 && out.repoured === 0, "Altium's stored fill is kept under the board's own rules: " + JSON.stringify(out));
assert.deepEqual(AtriumPolygonPour.stale(pcb, defs), []);
assert.equal(out.total, 41);
assert.ok(out.converted > 0 && out.converted <= 41 && out.types > 0, JSON.stringify(out));
const own = R.stored(pcb, p);  // the board's rules, now in the project rule book
R.validate(own);
assert.equal(own.version, 2);
assert.ok(p.rules.list.some(x => x.origin?.kind === "import" && x.origin.board === pcb.id), "converted rules carry their origin");
const clearance = own.list.filter(x => x.type === "clearance" && x.enabled);
assert.ok(clearance.some(x => Math.abs(x.gap - 0.1524) < 1e-6), "the board's 6 mil clearance");
assert.deepEqual(I.pending(p), [], "a board with rules is no longer offered");
const after = drc(pcb);
assert.equal(after.total, 2, "own rules: " + JSON.stringify(after.violations.map(v => [v.type, v.title])));
assert.ok(after.violations.every(v => v.type === "unrouted"), "only the two stubs inside a drill hole remain");
// The editor's DRC adds the Missing Courtyard check (drc-fixes.js): the fixture's courtyards are on
// Mechanical 4, which the board names "Top Courtyard", so no part is reported.
const parts = pcb.items.filter(i => i.kind === "part" && defs.get(i.def)?.footprint?.pads?.length);
assert.ok(parts.length > 20 && parts.every(i => AtriumDRCFixes.hasCourtyard(defs.get(i.def).footprint, pcb.layerNames)), "courtyards on the named mechanical layer count");
assert.ok(!parts.every(i => AtriumDRCFixes.hasCourtyard(defs.get(i.def).footprint)), "without the board's layer names they would not");

// ---------------------------------------------------------------- headless (MCP import_design): nothing inspected the board first
{
  const fresh = AtriumIO.read(name, new Uint8Array(fs.readFileSync(path.join(DIR, name)))), q = A.project("Fresh");
  q.documents = fresh.documents; q.library = fresh.library; AtriumImportLink.reconcile(q, q.documents);  // as MCP import_design assembles it
  const d = q.documents.find(x => x.kind === "pcb"), lib = new Map(q.library.map(x => [x.id, x]));
  const res = I.apply(d, q, lib);
  assert.ok(res.kept === 2 && res.repoured === 0, "the stored fill is adopted under the old rules, then kept under the new ones (Altium poured it under them)");
  assert.deepEqual(AtriumPolygonPour.stale(d, lib), []);
  // A pour edited before the rules are adopted is repoured; the other keeps Altium's fill.
  const edited = AtriumIO.read(name, new Uint8Array(fs.readFileSync(path.join(DIR, name)))), e = edited.documents.find(x => x.kind === "pcb"), elib = new Map(edited.library.map(x => [x.id, x]));
  const eq = A.project("Edited"); eq.documents = edited.documents; eq.library = edited.library; AtriumImportLink.reconcile(eq, eq.documents);
  assert.ok(AtriumPolygonPour.adopt(e,elib,{project:eq},false));
  const poly = e.items.find(i => i.kind === "polygon"); poly.clearance = .5;
  const er = I.apply(e, eq, elib);
  assert.ok(er.kept >= 1 && er.repoured > 0 && e.pcbDrawing.pours.some(r => r.polygon === poly.id && r.source !== "altium"), "edited pour repoured: " + JSON.stringify(er));
  assert.deepEqual(AtriumPolygonPour.stale(e, elib), []);
  assert.equal(R.drc(d, lib, R.stored(d, q), {connections: () => AtriumConnectivity.inspect(d, lib), project: q}).total, 2);
}

// ---------------------------------------------------------------- same as the rules editor's Replace button
// A later .RUL file can have the same rule names and entirely different clearances.
// Even after saving the board, only a new pour establishes copper under those constraints.
{
  const raw=AtriumIO.read(name,new Uint8Array(fs.readFileSync(path.join(DIR,name)))),project=A.project("External constraints");
  project.documents=raw.documents;project.library=raw.library;const board=project.documents[0];
  board.sourceRules=board.sourceRules.map(line=>AtriumAltiumRules.describe(line).name==="Clearance"?line.replace(/\bGAP=[^|]+/,"GAP=25mil"):line);
  board.sourceRulesReplaced=true;
  const saved=A.validate(JSON.parse(JSON.stringify(project))),reopened=saved.documents[0],library=new Map(saved.library.map(def=>[def.id,def]));
  const result=I.apply(reopened,saved,library);
  assert.equal(result.kept,0);assert.ok(result.repoured>0,"changed external rules repour the two source polygons");
  assert.deepEqual(AtriumPolygonPour.stale(reopened,library,{project:saved}),[]);
}
const set = R.migrate(null), again = R.replaceWithSource(set, pcb.sourceRules);
assert.equal(again.converted, out.converted);
assert.deepEqual(R.normalize(again.set).list.map(x => [x.type, x.name, x.priority]), R.stored(pcb, p).list.map(x => [x.type, x.name, x.priority]));
// Converted rules replace their whole type; types with no source record keep Waffle's rules.
const types = new Set(again.set.list.map(x => x.type));
for (const t of R.normalize(R.migrate(null)).list.map(x => x.type)) assert.ok(types.has(t), t + " kept");
// Duplicate names get a suffix, like the dialog's uniqueName.
const dup = R.replaceWithSource(R.migrate(null), [pcb.sourceRules[0], pcb.sourceRules[0]].filter(Boolean));
const names = dup.set.list.map(x => x.name.toLowerCase());
assert.equal(new Set(names).size, names.length, "unique rule names");

// ---------------------------------------------------------------- no source rules: nothing to offer
const plain = A.project("Plain"); assert.deepEqual(I.pending(plain), []);
const empty = A.clone(pcb); empty.sourceRules = []; assert.equal(I.apply(empty, plain).converted, 0);

// Each unconverted source line stays inspectable after applying and saving the ordinary project.
const {nativeImportRoundTrip}=require("../support/native-cad.cjs");
const nativeReload=(project,inputs=[{name,bytes:new Uint8Array(fs.readFileSync(path.join(DIR,name)))}],group)=>nativeImportRoundTrip(project,inputs,group);
assert.deepEqual(R.sourceReport(pcb.sourceRules,pcb),out.report);
for(const [i,row] of out.report.entries()){
  assert.equal(row.record,i+1);
  if(row.status!=="supported"){assert.equal(row.text,pcb.sourceRules[i]);assert.ok(row.reason);}
}
const saved=nativeReload(p),savedBoard=saved.documents.find(d=>d.id===pcb.id);
assert.deepEqual(savedBoard.sourceRules,pcb.sourceRules);
assert.deepEqual(R.sourceReport(savedBoard.sourceRules,savedBoard),out.report);
const src=(kind,name,params,scope="All",second="All",priority=1)=>[
  "RULEKIND="+kind,"NAME="+name,"ENABLED=TRUE","PRIORITY="+priority,"SCOPE1EXPRESSION="+scope,"SCOPE2EXPRESSION="+second,params
].filter(Boolean).join("|");

// An unrecognised higher-priority rule must not expand a fallback to all objects. Disabled rows do not shadow.
const bad=src("Width","Special","MINLIMIT=1mil|PREFEREDWIDTH=3mil|MAXLIMIT=5mil","InPadClass('P')");
const good=src("Width","Fallback","MINLIMIT=2mil|PREFEREDWIDTH=3mil|MAXLIMIT=99999mil","All","All",2);
assert.ok(R.sourceReport([good,bad]).every(r=>r.status==="source-only"&&r.text));
assert.match(R.sourceReport([good,bad])[0].reason,/Higher-priority/);
assert.equal(R.sourceReport([good,bad.replace("ENABLED=TRUE","ENABLED=FALSE")])[0].status,"supported");
// A higher-priority rule naming a class the board does not have matches nothing (as in Altium): it no
// longer blocks the fallback. With the class present, or with no class records at all, it still does.
const withClasses=names=>({sourceClasses:names.map(n=>"RECORD=Class|KIND=3|NAME="+n+"|SUPERCLASS=FALSE")});
assert.equal(R.sourceReport([good,bad],withClasses(["Other"]))[0].status,"supported");
assert.match(R.sourceReport([good,bad],withClasses(["Other"]))[1].reason,/class this board does not have/);
assert.equal(R.sourceReport([good,bad],withClasses(["P"]))[0].status,"source-only");
assert.equal(R.fromAltium(good).rule.max,2539.9746);
const same=src("Clearance","Same net","NETSCOPE=SameNetOnly|GAP=8mil");
const other=src("Clearance","Different nets","NETSCOPE=DifferentNets|GAP=6mil","All","All",2);
assert.deepEqual(R.sourceReport([same,other]).map(r=>r.status),["source-only","supported"]);

// Blank authored selectors cannot inherit All, even with a legacy compatibility scope present.
for(const side of [1,2]){
  const blank=good.replace("SCOPE"+side+"EXPRESSION=All","SCOPE"+side+"EXPRESSION=|SCOPE"+side+"COUNT=1|SCOPE"+side+"_0_KIND=Board");
  const row=R.sourceReport([blank])[0];
  assert.equal(row.status,"source-only");assert.equal(row.scopeDiagnostics[0].side,side);
  assert.match(row.reason,/query is empty/);
}

// Saved Altium width rows override the base dimensions only on their assigned physical layer.
{
  require(require("../support/app-source-paths.cjs").appFile("router.js"));
  const project=A.project("Layer widths"),board=A.sheet("pcb","Layer widths");project.documents=[board];
  board.stackup={source:"Altium",version:1,layers:["Top","Inner 1","Bottom"].map(key=>({key,type:"Signal",name:key,material:"Copper",thickness:.035})),drillPairs:[]};
  board.sourceRuleLayers={"Inner 1":null,"Inner 3":"Inner 1"};
  board.sourceClasses=["RECORD=Class|KIND=0|NAME=Fast nets|M0=DATA|SUPERCLASS=FALSE"];
  const base="MINLIMIT=0.10mm|PREFEREDWIDTH=0.15mm|MAXLIMIT=0.35mm";
  const widths="MINLIMIT=0.13mm|PREFEREDWIDTH=0.18mm|MAXLIMIT=0.30mm|TOPLAYER_MINWIDTH=0.20mm|TOPLAYER_PREFWIDTH=0.25mm|TOPLAYER_MAXWIDTH=0.3mm|MIDLAYER3_MINWIDTH=0.12mm|MIDLAYER3_PREFWIDTH=0.14mm|MIDLAYER3_MAXWIDTH=0.16mm|MIDLAYER29_MINWIDTH=0.30mm|IMPEDANCEPROFILEDRIVEN=TRUE|IMPEDANCEPROFILEID=unresolved";
  const data="InNetClass('Fast nets')";
  board.sourceRules=[src("Width","Default",base,"All","All",10),src("Width","Fast widths",widths,data,"All",7),
    src("Width","Disabled",base,data,"All",1).replace("ENABLED=TRUE","ENABLED=FALSE"),
    src("Width","Missing layer",base,"OnLayer('Mid Layer 30')","All",2),
    src("Width","Missing class",base,"InNetClass('Absent')","All",3)];
  const track=(id,net,layer,y)=>({id,kind:"track",net,layer,width:.18,points:[[0,y],[2,y]]});
  board.items=[track("outer","DATA","Top",1),track("middle","DATA","Inner 1",2),track("bottom","DATA","Bottom",3),track("other","OTHER","Top",4)];
  const applied=I.apply(board,project);
  assert.equal(applied.converted,4);
  const report=applied.report.find(r=>r.name==="Fast widths");
  assert.deepEqual([report.status,report.priority,report.scope,report.scope2],["partial",7,data,"All"]);
  assert.match(report.reason,/linked Altium impedance profile/);assert.match(report.reason,/absent from the board stack/);
  assert.match(applied.report[3].reason,/layer this board does not have/);
  const active=R.stored(board,project).list.filter(r=>r.type==="width");
  assert.deepEqual(active.map(r=>[r.name,r.enabled,r.priority]),[["Disabled",false,1],["Missing class",true,2],["Fast widths",true,3],["Default",true,4]]);
  const expect={Top:[.20,.25,.30],"Inner 1":[.12,.14,.16],Bottom:[.13,.18,.30]};
  const widthsOf=w=>[w.min,w.preferred,w.max];
  function check(project){
    const board=project.documents.find(d=>d.kind==="pcb"),defs=new Map();
    const route=AtriumRouter.core.rulesFor(board,{},project,defs);
    for(const [layer,values] of Object.entries(expect)){
      const rule=R.query(board,"width",{net:"DATA",layer},{project});
      assert.deepEqual(widthsOf(rule),values);assert.equal(rule.ruleName,"Fast widths");
      assert.deepEqual(widthsOf(route.width("DATA",layer)),values);
    }
    assert.equal(R.query(board,"width",{net:"OTHER",layer:"Top"},{project}).ruleName,"Default");
    assert.deepEqual(R.scopeCoverage(board,defs,{project}).map(r=>r.name),["Missing class"]);
    const result=R.drc(board,defs,R.stored(board,project),{project,types:["width"]});
    assert.deepEqual(result.violations.map(v=>[v.id,v.required,v.limit]),[["outer",.2,"min"],["middle",.16,"max"]]);
    assert.ok(result.complete);
  }
  check(project);check(require("../support/native-cad.cjs").nativeRoundTrip(project));
  const height=src("Height","Height","MINHEIGHT=0mil|PREFHEIGHT=450mil|MAXHEIGHT=71000mil");
  assert.equal(R.fromAltium(height).rule.max,1803.4);
}

// Silk clearance and the number of thermal conductors keep their own meanings.
{
  const board=A.sheet("pcb","Manufacturing");
  const silk=src("SilkToSilkClearance","Overlay","SILKTOSILKCLEARANCE=0mil");
  const polygon=src("PolygonConnect","Thermal","CONNECTSTYLE=Relief|RELIEFCONDUCTORWIDTH=4mil|RELIEFENTRIES=4|POLYGONRELIEFANGLE=90 Angle|AIRGAPWIDTH=4mil");
  const out=R.replaceWithSource(R.create(),[silk,polygon],board);
  assert.equal(out.set.list.find(r=>r.type==="silkToSilk").gap,0);
  assert.equal(out.report[0].status,"supported");
  assert.equal(R.sourceReport([silk.replace("0mil","4mil")],board)[0].status,"partial");
  const rule=out.set.list.find(r=>r.type==="polygonConnect");
  assert.equal(rule.entries,4);assert.equal(rule.minEntries,0);
  assert.equal(R.create().list.find(r=>r.type==="polygonConnect").minEntries,2);
}

// Altium's board-owned DRC selections do not control the rule book or router.
{
  for(const name of ["nav-common","drc-view"])require(require("../support/app-source-paths.cjs").appFile(name+".js"));
  const p=A.project("Checks"),b=A.sheet("pcb","Source checks"),native=A.sheet("pcb","Native checks");p.documents=[b,native];
  const base="MINLIMIT=0.40mm|MAXLIMIT=0.50mm";
  b.sourceRules=[src("Width","Width",base,"All","All",2),
    src("Width","Disabled width","MINLIMIT=0.49mm|MAXLIMIT=0.55mm","All","All",1).replace("ENABLED=TRUE","ENABLED=FALSE"),
    src("Clearance","Clearance","NETSCOPE=DifferentNets|GAP=0.35mm")];
  b.sourceRuleChecks={kinds:[2,2,0],batch:[2],online:[0]};
  const items=[{id:"a",kind:"track",layer:"Top",net:"A",width:.10,points:[[0,0],[2,0]]},
    {id:"b",kind:"track",layer:"Top",net:"B",width:.10,points:[[0,.2],[2,.2]]}];
  b.items=A.clone(items);native.items=items.map(i=>({...A.clone(i),id:"native-"+i.id}));
  const defs=new Map(),batch=(p,b,options={})=>AtriumDRC.batch(b,defs,R.stored(b,p),{project:p,...options});
  assert.equal(b.ruleCheckSelection,undefined);assert.ok(batch(p,b).violations.some(v=>v.type==="clearance"));
  const adopted=I.apply(b,p);
  assert.deepEqual(adopted.report.map(r=>[r.enabled,r.checks]),[
    [true,{kindId:2,batch:true,online:false}],[false,{kindId:2,batch:true,online:false}],[true,{kindId:0,batch:false,online:true}]]);
  assert.deepEqual(b.ruleCheckSelection,{batch:["clearance"],online:["width"]});
  require("../support/drc-geometry.cjs");
  const check=(p,b,native)=>{
    const first=batch(p,b),byType=r=>[...new Set(r.violations.map(v=>v.type))].sort();
    assert.deepEqual(byType(first),["width"]);assert.ok(!first.rules.some(r=>r.type==="clearance"));
    assert.ok(first.violations.every(v=>v.ruleName==="Width"&&v.required===.4));
    assert.deepEqual(byType(batch(p,b,{types:["clearance"]})),["clearance"]);
    assert.deepEqual(byType(batch(p,b,{checkMode:"all"})),["clearance","width"]);
    assert.deepEqual(byType(batch(p,native)),["clearance","width"]);
    assert.equal(R.query(b,"clearance",{net:"A",net2:"B",layer:"Top"},{project:p}).gap,.35);
    const online=AtriumDRCView.online(),opt={project:p};
    online.seed(b,defs,R.stored(b,p),first.violations,undefined,undefined,undefined,undefined,p);
    assert.deepEqual(byType(online.update(b,defs,R.stored(b,p),opt)),["clearance"]);
    assert.deepEqual(byType(online.update(native,defs,R.stored(native,p),opt)),["clearance","width"]);
    assert.deepEqual(byType(online.update(b,defs,R.stored(b,p),opt)),["clearance"]);
  };
  check(p,b,native);
  const reopened=require("../support/native-cad.cjs").nativeRoundTrip(p);
  check(reopened,reopened.documents[0],reopened.documents[1]);
}

// Board ownership survives an import into a two-board project and adding a future board to a one-board import.
{
  const project=A.project("Multi"),first=A.sheet("pcb","First"),second=A.sheet("pcb","Second");project.documents=[first,second];
  first.sourceRules=[good];second.sourceRules=[src("Width","Second width","MINLIMIT=8mil|PREFEREDWIDTH=9mil|MAXLIMIT=12mil")];
  const initial=R.query(second,"width",{net:"N"},{project}).min;
  I.apply(first,project);assert.equal(R.query(second,"width",{net:"N"},{project}).min,initial);
  I.apply(second,project);assert.equal(R.query(first,"width",{net:"N"},{project}).min,.0508);
  assert.equal(R.query(second,"width",{net:"N"},{project}).min,.2032);
  assert.ok(project.rules.list.filter(r=>r.origin?.board).every(r=>r.boards.length===1&&r.boards[0]===r.origin.board));
  const third=A.sheet("pcb","Future");saved.documents.push(third);
  assert.equal(R.query(third,"clearance",{net:"A",net2:"B"},{project:saved}).gap,R.defaults().defaults.clearance);
  assert.ok(!AtriumProjectRules.book(saved).list.some(r=>r.origin?.kind==="import"&&AtriumProjectRules.appliesToBoard(r,third.id)));
}

// The same source records feed physical objects, the rule resolver and batch DRC.
{
  const doc=A.sheet("pcb","Rules"),project=A.project("Rules");project.documents=[doc];
  const mask=src("SolderMaskExpansion","Vias","EXPANSION=0mil|ISTENTINGTOP=TRUE","IsVia");
  const pf=src("FabricationTestpoint","Probe","MINSIZE=1mm|MAXSIZE=3mm|PREFEREDSIZE=2mm|MINHOLESIZE=0mm|MAXHOLESIZE=1mm|PREFEREDHOLESIZE=0.3mm|ALLOWSIDETOP=TRUE|ALLOWSIDEBOTTOM=FALSE|USEGRID=TRUE");
  const supply=src("SupplyNets","Authored supply","VOLTAGE=0.000","InNet('SENSE')");
  const h=src("Height","Component height","MINHEIGHT=0mm|PREFHEIGHT=1mm|MAXHEIGHT=2mm");
  const np=src("HoleSize","Non-plated drill","ABSOLUTEVALUES=TRUE|MINLIMIT=1mm|MAXLIMIT=5mm","(HoleDiameter > 0) And (PadIsPlated = 'False')");
  const state=src("UnpouredPolygon","Polygon state","ALLOWSHELVED=FALSE");
  doc.sourceRules=[mask,pf,supply,h,np,state];
  const pad={id:"np",kind:"pad",x:0,y:0,layer:"Multi",w:1.5,h:1.5,shape:"round",drill:.6,plated:false};
  const via={id:"v",kind:"via",x:10,y:10,layer:"Multi",diameter:.5,drill:.3,fabTestpoint:"Bottom"};
  doc.items=[pad,via,{...pad,id:"plated",plated:true,x:20},{kind:"part",id:"c",ref:"C",def:"d",x:0,y:5,height:1},
    {kind:"part",id:"u",ref:"U",def:"d",x:0,y:10,bodies3d:[{maxZ:1},{maxZ:3}]},
    {kind:"polygon",id:"shelf",name:"Shelf",layer:"Top",net:"N",points:[[1,1],[2,1],[2,2]],shelved:true}];
  const applied=I.apply(doc,project),rules=R.stored(doc,project);
  assert.equal(applied.converted,6);
  const masks=R.maskRuleResolver(doc,"solder",{project});
  assert.equal(masks(via,null,"Top").tentTop,true);assert.equal(masks(via,null,"Bottom").tentBottom,undefined);
  assert.equal(masks(pad,null,"Top"),null);
  assert.equal(R.expansion(doc,"solder",{...via,maskExpansion:-.01},{project}),-.01);
  assert.equal(R.query(doc,"supplyNets",{net:"SENSE"},{project}).voltage,0);
  assert.equal(R.query(doc,"supplyNets",{net:"UNRELATED"},{project}),null);
  const result=R.drc(doc,new Map(),rules,{project,types:["fabricationTestpoint","holeSize","componentHeight","modifiedPolygon"]});
  const which=type=>result.violations.filter(v=>v.type===type).map(v=>v.id);
  assert.deepEqual(which("holeSize"),["np"]);assert.deepEqual(which("componentHeight"),["u"]);
  assert.deepEqual(which("modifiedPolygon"),["shelf"]);assert.deepEqual(which("fabricationTestpoint"),["v","v"]);
  const layerDoc={sourceRuleLayers:{"Inner 2":"Inner 4","Inner 1":null},stackup:{layers:[{type:"Plane",key:"Inner 1"}]}};
  const route=src("RoutingLayers","Layer policy","TOP LAYER_V5=TRUE|MID LAYER 2_V5=FALSE|BOTTOM LAYER_V5=FALSE");
  assert.deepEqual(R.fromAltium(route,layerDoc).rule.excluded,["Inner 1","Inner 4","Bottom"]);
  const older={stackup:{...layerDoc.stackup,source:"Altium"},notes:["Mid layers were renumbered to their stack order: Inner 2 → Inner 4."]};
  assert.deepEqual(R.fromAltium(route,older).rule.excluded,R.fromAltium(route,layerDoc).rule.excluded);
  assert.equal(R.fromAltium(good.replace("SCOPE1EXPRESSION=All","SCOPE1EXPRESSION=OnLayer('Mid Layer 4')"),older).rule,null);
  assert.deepEqual(R.fromAltium(good.replace("SCOPE1EXPRESSION=All","SCOPE1EXPRESSION=OnLayer('Mid Layer 2')"),layerDoc).rule.scope,AtriumDesignQueryRecord.selector("layer","Inner 4"));
}

// Component body mode 3 has explicit geometry eligibility. Its source cannot be
// reproduced by running a collision check on every generated footprint box.
{
  const line=src("ComponentClearance","Body","GAP=10mil|COLLISIONCHECKMODE=3|VERTICALGAP=10mil|DONOTCHECKWITHOUT3DBODY=TRUE");
  const res=R.fromAltium(line);
  assert.equal(res.rule.mode,"authored");assert.equal(res.rule.skipMissingBody,true);assert.equal(res.rule.gap,.254);
  assert.equal(res.rule.board,false);assert.equal(res.rule.fold,"flat");
  assert.equal(R.sourceReport([line])[0].status,"partial");assert.equal(R.sourceReport([line])[0].text,line);
  assert.equal(R.fromAltium(line.replace("CHECKMODE=3","CHECKMODE=2")).rule,null);
  assert.equal(R.fromAltium(line.replace("VERTICALGAP=10mil","VERTICALGAP=100000mil")).rule.vertical,2540);
}

// Altium can measure to exposed copper instead of the mask boundary. Tented,
// shrunken and drill-only apertures retain their physical reference surfaces.
{
  const board=A.sheet("pcb","Legend"),rules=R.create();
  const record=src("SilkToSolderMaskClearance","Legend","MINSILKSCREENTOMASKGAP=10mil|CLEARANCETOEXPOSEDCOPPER=TRUE").replace("SCOPE1EXPRESSION=All","SCOPE1EXPRESSION=IsPad");
  const report=R.replaceWithSource(rules,[record],board);
  assert.equal(report.report[0].status,"partial"); assert.equal(report.report[0].text,record);
  const pad={kind:"pad",id:"p",x:0,y:0,w:2,h:2,shape:"rect",layer:"Top",maskExpansion:.2,net:"A"};
  const ink={kind:"graphic",id:"l",layer:"Silk",width:.1,points:[[1.25,-1],[1.25,1]]};
  board.items=[pad,ink];
  const measure=()=>R.drc(board,new Map(),rules,{types:["silkToMask"]}).violations;
  let v=measure();assert.equal(v.length,1);assert.ok(Math.abs(v[0].actual-.2)<1e-8);assert.equal(v[0].required,.254);
  const r=rules.list.find(r=>r.type==="silkToMask");r.exposedCopper=false;
  assert.ok(measure()[0].actual<1e-8);
  pad.maskExpansion=-.1;r.exposedCopper=true;assert.equal(measure().length,0);
  pad.tent={top:true};pad.maskExpansion=.2;assert.equal(measure().length,0);
  Object.assign(pad,{holeOnly:true,drill:2,tent:{top:false}});
  ink.points=[[.17,-1],[.17,1]];assert.equal(measure().length,0);
  r.exposedCopper=false;assert.equal(measure().length,1);
}
// One through drill and four separate layers of copper, including an intentionally empty outer face.
{
  const board=A.sheet("pcb","Stack"),rules=R.create();
  board.items=[{kind:"pad",id:"th",number:"1",x:0,y:0,w:1,h:1,drill:.5,shape:"round",layer:"Multi",net:"A",
    stackMode:"tmb",padStack:{Top:{w:0,h:0},Mid:{w:2,h:2},Bottom:{w:1,h:1}}},
    ...["Top","Inner 1","Inner 2","Bottom"].map(layer=>({kind:"pad",id:layer,x:1.1,y:0,w:.15,h:.15,shape:"round",layer,net:"B"}))];
  const x=R.kit.extract(board,new Map());
  assert.equal(x.holes.length,1);
  assert.deepEqual(x.copper.filter(p=>p.id==="th").map(p=>p.layer).sort(),["Bottom","Inner 1","Inner 2"]);
  assert.deepEqual(R.drc(board,new Map(),rules,{types:["clearance"]}).violations.map(v=>v.id==="th"?v.otherId:v.id).sort(),["Inner 1","Inner 2"]);
}

// A physical drill with zero copper participates in explicit drill checks, even when its selection outline is larger.
{
  require("../../app/pcb/viastack.js");
  const board=A.sheet("pcb","Drills"),rules=R.create();
  board.items=[{id:"np",kind:"pad",x:0,y:0,w:4,h:4,drill:1,layer:"Multi",net:"A",holeOnly:true,plated:false},
    {id:"land",kind:"pad",x:.7,y:0,w:.5,h:.5,drill:0,shape:"round",layer:"Top",net:"B"},
    {id:"upper",kind:"via",x:10,y:10,diameter:.3,drill:.1,net:"C",layer:"Multi",fromLayer:"Top",toLayer:"Inner 1",microvia:true},
    {id:"lower",kind:"via",x:10,y:10,diameter:.3,drill:.1,net:"C",layer:"Multi",fromLayer:"Inner 1",toLayer:"Bottom",microvia:true}];
  const clearance=rules.list.find(r=>r.type==="clearance");clearance.objects={"smd-hole":.3};
  const hit=R.drc(board,new Map(),rules,{types:["clearance"]}).violations;
  assert.equal(hit.length,1);assert.ok(hit[0].kinds.includes("hole"));
  const holes=rules.list.find(r=>r.type==="holeToHole");holes.allowStackedMicrovias=true;
  assert.equal(R.drc(board,new Map(),rules,{types:["holeToHole"]}).total,0);
  holes.allowStackedMicrovias=false;assert.equal(R.drc(board,new Map(),rules,{types:["holeToHole"]}).total,1);
}

for(const f of ["obsolete-project","altium-ids","sexpr","library-import-altium","translator-table","translator-registry","translator-provenance","translator-adapters","translators"])require(require("../support/app-source-paths.cjs").appFile(f+".js"));
require("../../mcp/headless.js");
const headless=(files,source_rules)=>{
  const ans=AtriumHeadless(JSON.stringify({op:"translate",args:{direction:"import",translator:"altium",options:{source_rules}}}),JSON.stringify(files));
  const split=ans.indexOf("\n");return {head:JSON.parse(ans.slice(0,split)),project:JSON.parse(ans.slice(split+1))};
};
const file={name,data:fs.readFileSync(path.join(DIR,name)).toString("base64")};
for(const mode of ["use","keep"]){
  const {head,project}=headless([file],mode),board=project.documents.find(d=>d.kind==="pcb");
  assert.deepEqual(head.source_rules[0].report,out.report);
  assert.equal(head.source_rules[0].applied,mode==="use");
  assert.equal(board.sourceRules,undefined);
  const retained=nativeReload(project,[{name:file.name,bytes:Buffer.from(file.data,"base64")}],head.folder_provenance);
  assert.deepEqual(retained.documents.find(d=>d.id===board.id).sourceRules,pcb.sourceRules);
}
const libLine=src("Width","Library width","MINLIMIT=1mm|MAXLIMIT=2mm","InPadClass('Source only')");
const library={name:"Rule.PcbLib",data:Buffer.from("|RECORD=Library\r\n|RECORD=Component|PATTERN=Part|HEIGHT=1mm\r\n|RECORD=Rule|"+libLine+"\r\n").toString("base64")};
const importedLib=headless([library],"use"),loadedLib=nativeReload(importedLib.project,[{name:library.name,bytes:Buffer.from(library.data,"base64")}],importedLib.head.folder_provenance);
assert.equal(loadedLib.library[0].footprint.height,1);
assert.ok(loadedLib.importNotes.some(n=>n.includes(libLine)));
assert.ok(!loadedLib.documents.some(d=>d.sourceRules?.length));
assert.ok(!loadedLib.rules?.list?.some(r=>r.origin?.kind==="import"));

console.log("PASS imported board rules: PiDP-11 fixture " + before.total + " violations under Waffle defaults -> " + after.total + " under its own " +
  out.converted + " of " + out.total + " Altium rules");

// A failed compiler load leaves the imported rule offer and source artwork available for retry.
globalThis.__testDone = (async () => {
  const raw = AtriumIO.read(name, new Uint8Array(fs.readFileSync(path.join(DIR, name))));
  const project = A.project("Compiler retry");
  project.documents = raw.documents;
  project.library = raw.library;
  AtriumImportLink.reconcile(project, project.documents);
  const doc = project.documents.find(d => d.kind === "pcb");
  const library = new Map(project.library.map(def => [def.id, def]));
  const drawing = JSON.stringify(doc.pcbDrawing);
  const copper = () => doc.pcbDrawing.pours.map(region => [region.source, region.data]);
  const artwork = copper();
  const compiler = globalThis.AtriumDesignQuery;
  const {AtriumLazy: oldLazy, AtriumPrefs: oldPrefs} = globalThis;
  let edits = 0, attempts = 0;
  const host = {project:() => project, defs:() => library, info() {}, edit(fn) {edits++; fn();}};
  assert.ok(compiler);
  delete globalThis.AtriumDesignQuery;
  globalThis.AtriumPrefs = {get:() => "use"};
  globalThis.AtriumLazy = {async need(module) {
    assert.equal(module, "AtriumDesignQuery");
    if (++attempts === 1) throw Error("injected compiler failure");
    globalThis.AtriumDesignQuery = compiler;
  }};
  try {
    await assert.rejects(I.offer(host), /injected compiler failure/);
    assert.equal(edits, 0);
    assert.equal(JSON.stringify(doc.pcbDrawing), drawing);
    assert.equal(I.pending(project).length, 1);
    assert.equal(await I.offer(host), "use");
    assert.equal(edits, 1);
    assert.equal(attempts, 2);
    assert.deepEqual(I.pending(project), []);
    assert.equal(AtriumPolygonPour.state(doc, library, {project}), "source");
    assert.deepEqual(copper(), artwork);
    console.log("PASS imported rules compiler failure preserves stored copper and a retry uses the same source rules");
  } finally {
    globalThis.AtriumDesignQuery = compiler;
    globalThis.AtriumLazy = oldLazy;
    globalThis.AtriumPrefs = oldPrefs;
  }
})().catch(error => {console.error(error); process.exitCode = 1;});
