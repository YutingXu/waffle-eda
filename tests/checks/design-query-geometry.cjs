"use strict";
const assert = require("node:assert/strict");
for (const name of ["model", "parts", "spatial", "board-shape", "stackup", "viastack", "rules", "dfa", "undo-store", "panel", "design-query-geometry"])
  require(require("../support/app-source-paths.cjs").appFile(name + ".js"));

const A = Atrium, G = AtriumDesignQueryGeometry, U = AtriumUndoStore, B = AtriumBoardShape;
const K = AtriumRules.kit;
const almost = (a, b) => assert.ok(Math.abs(a-b) < 1e-12, `${a} differs from ${b}`);
const at = (id, kind, x, y, extra = {}) => ({id, kind, x, y, ...extra});
const pad = (id,x,y,w=.4,h=w,extra={}) => at(id,"pad",x,y,{w,h,shape:"rect",layer:"Top",...extra});
const via = (id,x,y,diameter=.4) => at(id,"via",x,y,{diameter,drill:.15,layer:"Multi"});
const basePad = {number:"1", x:0, y:0, w:.4, h:.4, shape:"rect", layer:"Top"};
const part = (id,ref,def,x,y,extra={}) => at(id,"part",x,y,{ref,def,angle:0,layer:"Top",...extra});
const loop = (l,b,r,t) => [[l,b],[r,b],[r,t],[l,t]];

{
  const def = {id:"offset", footprint:{pads:[basePad], courtyard:[2,-1,4,1]}};
  const mirrored = part("bottom","U4",def.id,10,20,{angle:90,mirror:true,layer:"Bottom"});
  const doc = {id:"board",kind:"pcb",items:[part("anchor","U3",def.id,10,20,{angle:90}),mirrored,
    {id:"track",kind:"track",layer:"Top",width:1,points:[[9.5,25],[10.5,25]]},
    pad("pad",12,23,1,1,{shape:"round"}), via("mirror-adjacent",10,15.5,1), via("origin-adjacent",10,20.75,1)]};
  const defs = new Map([[def.id,def]]), g = G.create({doc,defs});
  const anchor = g.resolveRef({family:"anchor",name:"U3"}).target;
  assert.equal(anchor.id,"anchor");
  const near = g.prepareNear({anchor,mode:"body",radius:.5});
  assert.equal(near.basis,"courtyard");
  const clearance = AtriumRules.kit.extract(doc,defs,{physical:true});
  const feature = clearance.copper.find(f => f.id === "track");
  const court = AtriumDFA.record(doc.items[0],defs,{measure:"courtyard"});
  almost(g.distanceMm(feature,anchor), K.pieceGap(feature,K.feature({},court.poly,0),Infinity).d);
  almost(g.distanceMm({id:"track"},anchor), .5);
  assert.equal(near.matches(feature),true,"exact compound boundary is included");
  assert.equal(near.matches({id:"pad"}),true,"the copper edge reaches the radius while its centre does not");
  assert.equal(g.prepareNear({anchor,mode:"body",radius:.4999999}).matches(feature),false);
  assert.equal(g.prepareNear({anchor,mode:"origin",radius:.5}).matches(feature),false);
  assert.equal(g.prepareNear({anchor,mode:"origin",radius:.25}).matches({id:"origin-adjacent"}),true);
  assert.equal(g.prepareNear({anchor:{id:"bottom"},radius:0}).matches({id:"mirror-adjacent"}),true);
  assert.deepEqual(g.spatial(near.bounds).sort(),["anchor","pad","track"],"physical courtyard belongs to the broad phase");
  assert.equal(near.matches({...feature,docId:"different"}),null);

  // A rule already holds both the feature and the anchor from indexes. Measuring
  // the pair must never enumerate the board's owners or create a second index.
  const items = doc.items;
  const isolated = G.create({doc,defs,lookup:id => id === "anchor" ? items[0] : null});
  doc.items = new Proxy(items,{get(a,key) {
    if (key === "length") return a.length;
    throw Error("A direct clearance subject read unrelated owners");
  }});
  try { assert.equal(isolated.prepareNear({anchor,radius:.5}).matches(feature),true); }
  finally { doc.items = items; }
}

{
  const def = {id:"multiland", footprint:{pads:[basePad,{...basePad,id:"2a",number:"2",x:8,angle:90,w:1.2,h:.2},
    {...basePad,id:"2b",number:"2",x:-8}],
    shapes:[{layer:"Mechanical 13",points:loop(-1,-2,1,2)}]}};
  const missing = {id:"missing", footprint:{}};
  const doc = {id:"board",kind:"pcb",items:[part("a","U3",def.id,0,0),part("b","U5",missing.id,8,0),
    pad("stack",3,0,.2,.2,{layer:"Multi",drill:.12,stackMode:"tmb",padStack:{Top:{w:.2,h:.2},Bottom:{w:1,h:1},Mid:{w:.5,h:.5}}}),
    pad("slot",10,0,2.2,1,{layer:"Multi",drill:.4,slotLength:2}),
    pad("custom",10,2,2,2,{angle:90,shape:"custom",poly:[[-1,-1],[1,-1],[1,-.5],[0,-.5],[0,1],[-1,1]]}),
    via("by-cut",3.5,4.5,.4)]};
  B.apply(doc,{...B.rect({x:-4,y:6,width:20,height:12}),cutouts:[B.rect({x:4,y:5,width:2,height:2}).contour]});
  const g = G.create({doc,defs:new Map([[def.id,def],[missing.id,missing]])});
  const body = {id:"a"}, origin = {id:"b"};
  assert.equal(g.resolveRef({family:"anchor",name:"a"}).target.id,"a");
  assert.equal(g.prepareNear({anchor:body,radius:1}).basis,"body");
  assert.equal(g.prepareNear({anchor:origin,radius:1}).ok,false,"missing geometry cannot use DFA's generic placeholder");
  almost(g.distanceMm({id:"stack",kind:"pad",layer:"Top"},body),1.9);
  almost(g.distanceMm({id:"stack",kind:"pad",layer:"Bottom"},body),1.5);
  almost(g.distanceMm({id:"a",kind:"pad",pin:"2"},origin,"origin"),0);
  assert.ok(g.distanceMm({id:"a/2b",ownerId:"a",kind:"pad",pin:"2",item:{id:"2b"}},origin,"origin") > 15);
  // The older Filter projection identifies the row by an owner-qualified UI
  // ID. Its underlying authored pad and position in the footprint identify the land.
  const projected = (layer, padIndex, padId) => ({kind:"pad",sub:true,part:doc.items[0],
    item:{id:"a/2",sub:true,pin:"2",layer,padIndex,padId}});
  almost(g.distanceMm(projected("Top",1,"2a"),origin,"origin"),0);
  assert.ok(g.distanceMm(projected("Top",2),origin,"origin") > 15);
  assert.equal(g.distanceMm(projected("Bottom",1,"2a"),origin,"origin"),null);
  assert.ok(g.distanceMm({id:"a",kind:"pad",pin:"1"},origin,"origin") > 7);
  almost(g.distanceMm({id:"slot",kind:"hole"},origin,"origin"),1);
  almost(g.distanceMm({id:"by-cut"},{id:doc.id,kind:"cutout"}),.3);
  almost(g.distanceMm({id:"by-cut"},{id:doc.id,kind:"board-edge"}),.3);
  const custom = g.distanceMm({id:"custom"},origin,"origin");
  assert.ok(Number.isFinite(custom) && custom > 0);
  const cps = K.extract(doc,new Map(),{physical:true,items:[doc.items[4]]}).pads[0];
  almost(custom,K.pieceGap(cps,K.feature({},[[8,0]],0),Infinity).d);
}

{
  const def = {id:"def",footprint:{pads:[basePad],courtyard:[4,-.5,6,.5]}};
  const anchor = part("anchor","U3",def.id,0,0), other = part("other","U4",def.id,0,0);
  const doc = {id:"board",kind:"pcb",items:[anchor,other,pad("old",5,0),pad("new",15,0)]};
  const defs = new Map([[def.id,def]]), project = {id:"project",documents:[doc],library:[def]}, history = [], future = [];
  U.reset(); U.mark(project);
  const g = G.create({doc,defs,journal:U,projectId:project.id,occurrence:"panel/B",allows:r=>r.id !== "other"});
  const bound = {id:anchor.id,docId:doc.id};
  const read = id => ({id,docId:doc.id,occurrenceId:"panel/B"});
  const inspect = () => g.prepareNear({anchor:bound,radius:.02});
  const first = inspect(), indexed = () => g.spatial(inspect().bounds).filter(id => id !== anchor.id);
  assert.deepEqual(indexed(),["old"]);
  assert.equal(first.matches(read("old")),true);
  U.duringEdit(() => assert.equal(first.matches(read("old")),null,"an unsettled edit cannot issue a match"));
  assert.equal(first.matches({...read("old"),occurrenceId:"panel/A"}),null);
  assert.equal(g.resolveRef({family:"anchor",name:"U4"}).diagnostic.code,"broken-reference");
  assert.equal(g.prepareNear({anchor:{id:"other"},radius:1}).ok,false);

  const before = U.mark(project);
  anchor.x += 10; anchor.ref = "U8";
  U.checkpoint(history,future,before,"Move and rename"); U.record(project,{doc,items:[anchor]});
  assert.equal(first.matches(read("old")),null,"a plan from another revision cannot publish geometry");
  assert.deepEqual(indexed(),["new"]);
  assert.equal(inspect().matches(read("new")),true);
  assert.equal(g.resolveRef({family:"anchor",name:"U3"}).diagnostic.code,"broken-reference");
  assert.equal(g.resolveRef({family:"anchor",name:"U3",binding:{target:{...bound,itemId:anchor.id}}}).target.name,"U8");
  assert.ok(U.jump(history,future,U.mark(project),-1));
  assert.deepEqual(indexed(),["old"]);
  assert.equal(g.resolveRef({family:"anchor",name:"U3"}).target.id,anchor.id);
  assert.ok(U.jump(history,future,U.mark(project),1));
  assert.deepEqual(indexed(),["new"]);

  // An in-place definition replacement invalidates the old retained footprint.
  def.footprint.courtyard = [-1,-1,1,1];
  U.record(project,{library:true});
  assert.equal(inspect().matches(read("new")),false);
  U.reset();
}

{
  const definition = {id:"definition",footprint:{pads:[basePad]}};
  const defs = new Map([[definition.id,definition]]), anchor = part("anchor","U3",definition.id,0,0);
  const stack = via("via",1,0,.2);
  stack.stackMode = "tmb"; stack.padStack = {Mid:{diameter:2.2}};
  const doc = {id:"stack-board",kind:"pcb",items:[anchor,stack],pcbDrawing:{pours:[]}};
  let pours = 0;
  const journal = {documentVersions:() => ({seq:0,floor:0,outer:0,library:0,pours})};
  const g = G.create({doc,defs,journal});
  const near = () => g.prepareNear({anchor,mode:"origin",radius:0});
  const old = near(), subject = {id:"via"};
  assert.equal(old.matches(subject),false);
  doc.pcbDrawing.pours.push({layer:"Inner 1"}); pours++;
  assert.equal(old.matches(subject),null);
  assert.equal(near().matches(subject),true,"derived copper layer changes refresh cached via lands");
}

{
  const definition = {id:"definition",footprint:{pads:[basePad],courtyard:[1,-.5,2,.5]}};
  const item = part("u","U3",definition.id,0,0), initial = pad("p",1.5,0), replacement = pad("q",6.5,0);
  const doc = {id:"native-board",kind:"pcb",items:[item,initial,replacement]};
  const project = {id:"native-project",documents:[doc],library:[definition]};
  U.reset(project); U.reconcile(project,() => {},{doc});
  try {
    assert.equal(U.root(),project);
    assert.equal(U.unrecorded(),false);
    assert.equal(U.documentVersions(doc,project,true),null);
    assert.equal(U.stats().shadow,0);
    const withoutRevision = G.context(project,doc);
    assert.equal(withoutRevision.prepareNear({anchor:item,radius:0}).ok,false);
    const g = G.context(project,doc,{revision:1});
    const old = g.prepareNear({anchor:item,radius:0});
    assert.equal(old.matches(initial),true);
    assert.equal(U.stats().shadow,0,"opening a query must not build an Undo baseline");
    U.duringEdit(() => assert.equal(old.matches(initial),null,"a transient edit cannot borrow a cold receipt"));

    U.reconcile(project,() => {
      item.x += 5;
      assert.equal(old.matches(initial),null,"the new disk view must finish adoption first");
    },{doc});
    assert.equal(old.matches(initial),null);
    const current = g.prepareNear({anchor:item,radius:0});
    assert.equal(current.matches(replacement),true);
    assert.equal(U.documentVersions(doc,project,true),null);
    assert.equal(U.stats().shadow,0);
    U.mark(project);
    assert.ok(U.documentVersions(doc,project,true));
    assert.equal(current.matches(replacement),null);
    assert.equal(g.prepareNear({anchor:item,radius:0}).matches(replacement),true);
  } finally { U.reset(); }
}

{
  const definition = {id:"part",footprint:{pads:[basePad],courtyard:[0,-1,2,1]}};
  const doc = {id:"pcb",kind:"pcb",name:"Panel board",outline:loop(0,0,10,10),items:[
    part("u","U3",definition.id,3,5),pad("pad",5.8,5)]};
  const project = {id:"project",documents:[doc],library:[definition]}, defs = new Map([[definition.id,definition]]);
  const panel = AtriumPanel.create(project,{board:doc.id,rows:1,cols:2,cells:{"0,1":{rotation:90}}});
  const {doc:flat} = AtriumPanel.flatten(project,panel,defs);
  const g = G.create({doc:flat,defs,revision:1});
  const left = {id:"P1:u"}, right = {id:"P2:u"};
  almost(g.distanceMm({id:"P1:pad"},left),.6);
  almost(g.distanceMm({id:"P2:pad"},right),.6);
  assert.ok(g.distanceMm({id:"P2:pad"},left)>5);
  assert.equal(g.resolveRef({family:"anchor",name:"U3"}).diagnostic.code,"ambiguous-reference");
  assert.equal(g.resolveRef({family:"anchor",name:"U3",binding:{target:{itemId:right.id,docId:flat.id}}}).target.id,right.id);
}

globalThis.__testDone = (async () => {
  const definition = {id:"part", footprint:{pads:[basePad], courtyard:[1,-.5,2,.5]}};
  const anchor = part("anchor","U3",definition.id,0,0), firstPad = pad("first",1.5,0);
  const items = [anchor,firstPad,...Array.from({length:256},(_,i)=>pad("p"+i,i+10,0))];
  const doc = {id:"board",kind:"pcb",items}, project = {id:"p",documents:[doc],library:[definition]};
  const options = {documentId:doc.id,revision:1};
  const g = G.context(project,doc,options), bound = g.resolveRef({family:"anchor",name:"U3"}).target;
  const first = g.prepareNear({anchor:bound,radius:0});
  assert.equal(g,G.context(project,doc,{...options}));
  assert.equal(first.matches({id:firstPad.id}),true);
  firstPad.x = 3;
  assert.equal(G.context(project,doc,{...options,revision:2}),g);
  assert.equal(first.matches({id:firstPad.id}),null,"an old numeric revision stays stale after a headless edit");
  assert.equal(g.prepareNear({anchor:bound,radius:0}).matches({id:firstPad.id}),false);

  const allowed = {documentIds:new Set([doc.id])};
  const scoped = G.context(project,doc,{...options,authority:allowed,instanceId:"panel/A"});
  assert.notEqual(scoped,g);
  assert.notEqual(scoped,G.context(project,doc,{...options,authority:allowed,instanceId:"panel/B"}));
  const scopedPlan = scoped.prepareNear({anchor:bound,radius:2});
  allowed.revoked = true;
  Object.defineProperty(doc,"items",{configurable:true,get() { throw Error("Denied geometry examined the board"); }});
  try {
    const denied = G.context(project,doc,{...options,authority:{documentIds:new Set()}});
    assert.equal(denied.resolveRef({family:"anchor",name:"U3"}).diagnostic.code,"broken-reference");
    assert.equal(await denied.prepareSpatial(),false);
    assert.equal(scopedPlan.matches({id:firstPad.id}),null);
    const already = new AbortController(); already.abort();
    assert.equal(await g.prepareSpatial({signal:already.signal}),false);
  } finally { Object.defineProperty(doc,"items",{value:items,configurable:true,writable:true}); }

  let borrowedReads = 0;
  const borrowed = G.context(project,doc,{...options,lookup:id => id === anchor.id ? anchor : null,
    searchOwners() { borrowedReads++; return borrowedReads === 1 ? [firstPad.id] : undefined; }});
  assert.equal(await borrowed.prepareSpatial(),true);
  assert.equal(borrowedReads,0);
  assert.deepEqual(borrowed.spatial(first.bounds),[firstPad.id]);
  assert.equal(borrowed.spatial(first.bounds),undefined);

  const controller = new AbortController(), performance = Object.getOwnPropertyDescriptor(globalThis,"performance");
  let ticks = 0;
  Object.defineProperty(globalThis,"performance",{configurable:true,value:{now:() => (ticks += 5)}});
  try {
    const preparing = g.prepareSpatial({signal:controller.signal});
    controller.abort();
    assert.equal(await preparing,false,"interrupted work cannot accept a partial spatial projection");
  } finally {
    if (performance) Object.defineProperty(globalThis,"performance",performance);
    else delete globalThis.performance;
  }
  assert.equal(await g.prepareSpatial(),true);
  assert.deepEqual(g.spatial(first.bounds),[anchor.id]);
  console.log("PASS design-query clearance, transformed courtyards and panel copies, copper lands and cuts, authority, cancellation and indexed Undo");
})();
