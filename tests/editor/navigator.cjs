"use strict";
// node tests/editor/navigator.cjs [--dom /path/to/linkedom.mjs]
const assert=require("node:assert/strict");
const path=require("node:path");
const {pathToFileURL}=require("node:url");


// Navigator panel model (navigator-panel.js): compiled sheets, components, nets with pins, ports.
function panelModel(){
  for(const m of ["model","parts","sch-objects","hierarchy","navigator-panel"])require(require("../support/app-source-paths.cjs").appFile(m+".js"));
  require("../pcb/dense-board.js");
  const N=AtriumNavigatorPanel,p=AtriumParts.example(),defs=new Map(p.library.map(d=>[d.id,d])),cache=new Map();
  const m=N.model(p,defs,cache);
  assert.deepEqual(m.sheets.map(s=>s.label),p.documents.map(d=>d.name));
  assert.equal(m.parts.length,p.documents[0].items.filter(i=>i.kind==="part").length,"schematic components");
  const gnd=m.nets.find(n=>n.name==="GND");
  assert.ok(gnd&&gnd.pins.length>=2,"compiled net with pins");
  assert.ok(gnd.pins.every(x=>/^[A-Z]+\d+-\w+$/.test(x.label)));
  let rows=N.flatten(m);
  assert.deepEqual(rows.filter(r=>r.type==="group").map(r=>r.label),["Sheets","Components","Nets / Buses","Ports"]);
  rows=N.flatten(m,{expanded:new Set(["n:GND"])});
  assert.equal(rows.filter(r=>r.type==="pin").length,gnd.pins.length,"expanded net lists its pins");
  rows=N.flatten(m,{query:"u1"});
  assert.ok(rows.some(r=>r.type==="part"&&r.label==="U1"));
  assert.ok(rows.filter(r=>r.type==="pin").every(r=>/u1/i.test(r.label+r.detail)),"search reaches pins");
  assert.ok(!rows.some(r=>r.type==="group"&&r.label==="Sheets"),"empty groups drop out while searching");
  rows=N.flatten(m,{collapsed:new Set(["parts"])});
  assert.ok(!rows.some(r=>r.type==="part"));
  // Same items: cached rows are reused; an edit to one document rebuilds only that document.
  const before=cache.get(p.documents[1].id);N.model(p,defs,cache);assert.equal(cache.get(p.documents[1].id),before);
  p.documents[0].items.push({id:"extra",kind:"part",def:"std-r",x:0,y:0,ref:"R99",value:"1k"});
  const m2=N.model(p,defs,cache);assert.equal(cache.get(p.documents[1].id),before);assert.ok(m2.parts.some(x=>x.label==="R99"));
  // 25k-object board, board-only project: build then search well under a frame budget.
  const {d,defs:dd}=makeAtriumBenchmarkBoard(160),bp={name:"b",library:[...dd.values()],documents:[d]};
  let t=Date.now();const bm=N.model(bp,dd,new Map());const build=Date.now()-t;
  assert.equal(bm.parts.length,d.items.filter(i=>i.kind==="part").length);
  t=Date.now();for(let k=0;k<20;k++)N.flatten(bm,{query:"r1"+k});const search=(Date.now()-t)/20;
  assert.ok(build<1500&&search<50,"25k board model "+build+" ms, search "+search+" ms");
  console.log("PASS navigator panel model: 25k board build "+build+" ms, search "+search.toFixed(1)+" ms per keystroke");
}
panelModel();

function panelCompilation(){
  require("../../app/history/undo-store.js");
  const A=Atrium,N=AtriumNavigatorPanel,H=AtriumHierarchy,U=AtriumUndoStore;
  const p=A.project("Navigator test",[A.clone(AtriumParts.catalogue.find(d=>d.id==="std-r"))]);
  const [top]=p.documents,child=A.sheet("schematic","Sensor"),[def]=p.library;
  const part={id:"sensor-r",kind:"part",def:def.id,ref:"R1",value:"10k",x:0,y:0};
  const pin=A.pins(part,def,"schematic")[0];
  const port=AtriumSchObjects.make("port",pin.at,{text:"SENSE",io:"output"});
  const symbol=AtriumSchObjects.make("sheetsymbol",[40,0],{name:"Sensor",sheet:child.id,
    entries:[{id:"sense",name:"SENSE",side:"left",offset:5.08,io:"output"}]});
  top.items.push(symbol);child.items.push(part,port);p.documents.push(child);
  p.erc={scope:"hierarchical"};
  const cache=new Map(),defs=new Map([[def.id,def]]),history=[],future=[];
  const compile=H.compileCached;
  let compiles=0;
  H.compileCached=(...args)=>{compiles++;return compile(...args);};
  function verify(expected,change){
    const at=compiles,model=N.model(p,defs,cache,U);
    assert.equal(compiles-at,expected,change);
    assert.deepEqual(model,N.model(p,defs),change+" matches fresh compile");
    return model;
  }
  function edit(fn){const before=U.mark(p);fn();U.checkpoint(history,future,before);U.record(p);}
  const jump=direction=>U.jump(history,future,U.mark(p),direction);
  const component=model=>model.parts.find(row=>row.id===part.id);
  try {
    U.record(p);
    const first=verify(1,"first open");
    assert.ok(first.nets.find(net=>net.name==="SENSE").pins.some(row=>row.partId===part.id));
    edit(()=>{part.value="Revised sensor";part.comment="Review";});
    assert.equal(component(verify(0,"comment edit")).detail,"Revised sensor · Sensor");
    jump(-1);
    assert.equal(component(verify(0,"comment undo")).detail,"10k · Sensor");
    jump(1);
    assert.equal(component(verify(0,"comment redo")).detail,"Revised sensor · Sensor");
    edit(()=>{p.parameters={...p.parameters,Revision:"B"};});
    edit(()=>{p.parameters.Revision="C";});
    verify(0,"project parameter edits");

    // Mixed edits, structural changes, library pins and compiler settings still rebuild.
    edit(()=>{part.value="Renumbered sensor";part.ref="R2";});
    assert.ok(verify(1,"comment and designator").nets.some(net=>net.pins.some(row=>row.label==="R2-1")));
    edit(()=>{port.text="SENSE_OUT";});
    assert.ok(verify(1,"port rename").nets.some(net=>net.name==="SENSE_OUT"));
    jump(-1);verify(1,"port undo");
    jump(1);verify(1,"port redo");
    edit(()=>{def.symbol.pins[0].name="Input sense";});
    assert.ok(verify(1,"library pin rename").nets.some(net=>net.pins.some(row=>row.detail.startsWith("Input sense"))));
    edit(()=>{child.name="Signal chain";});
    assert.equal(component(verify(1,"sheet rename")).detail,"Renumbered sensor · Signal chain");
    edit(()=>{symbol.entries[0].name="SENSE_OUT";});
    verify(1,"sheet entry name");
    edit(()=>{symbol.repeat={name:"CH",from:1,to:2};});
    assert.ok(verify(1,"hierarchy repeat").sheets.some(row=>row.detail==="Sheet ×2"));
    edit(()=>{p.erc.scope="flat";});
    verify(1,"project net-identifier scope");
    edit(()=>{child.items.splice(0,1,{...part,value:"Replacement"});});
    assert.equal(component(verify(1,"item replaced under the same ID")).detail,"Replacement · Signal chain");
    edit(()=>{p.documents.pop();});
    verify(1,"sheet removed");
    jump(-1);verify(1,"sheet removal undone");

    child.items[0].value="Pending sensor";U.touch(p);
    assert.equal(component(verify(1,"unrecorded edit")).detail,"Pending sensor · Signal chain");
    U.record(p);verify(1,"journal caught up");
    console.log("PASS Navigator reuses compiled nets for comments, undo and redo with fresh-build parity");
  } finally {H.compileCached=compile;U.reset();}
}
panelCompilation();

function sharedHierarchyWork() {
  for (const name of ["multichannel", "erc"]) require(require("../support/app-source-paths.cjs").appFile(name + ".js"));
  const A=Atrium, N=AtriumNavigatorPanel, H=AtriumHierarchy, U=AtriumUndoStore, E=AtriumERC;
  const p=AtriumParts.example(), [main]=p.documents, child=A.sheet("schematic", "Child");
  const wire={kind:"wire", id:"child-wire", points:[[0,0],[12,0]]};
  child.items.push(wire, {kind:"netlabel", id:"child-label", text:"TEST", x:0, y:0});
  main.items.push(AtriumSchObjects.make("sheetsymbol", [55,0], {name:"Child", sheet:child.id}));
  p.documents.push(child);
  const defs=new Map(p.library.map(def=>[def.id,def])), navCache=new Map(), ercCache=new WeakMap();
  const near=A.nearSegment, decorate=AtriumMultichannel.decorate;
  let segments=0, instances=0;
  A.nearSegment=(...args)=>{segments++;return near(...args);};
  AtriumMultichannel.decorate=(...args)=>{instances++;return decorate(...args);};
  try {
    U.record(p);
    const erc=E.run(p,{cache:ercCache});
    assert.ok(segments>0);
    assert.equal(instances,1,"cold ERC and hierarchy compile share one instance traversal");
    instances=segments=0;
    const first=N.model(p,defs,navCache,U);
    assert.deepEqual([segments,instances],[0,0],"opening Navigator reuses the committed ERC topology and instances");
    assert.equal(N.model(p,defs,navCache,U).nets,first.nets);
    assert.deepEqual([segments,instances],[0,0],"unchanged refresh does not walk the hierarchy again");
    const before=U.mark(p), history=[], future=[];
    wire.points=[[0,0],[8,0]];U.checkpoint(history,future,before);U.record(p,{doc:child,items:[wire]});
    const changed=E.run(p,{cache:ercCache});
    assert.notEqual(changed.hierarchy,erc.hierarchy);
    instances=segments=0;
    const next=N.model(p,defs,navCache,U);
    assert.notEqual(next.nets,first.nets);
    assert.deepEqual([segments,instances],[0,0],"Navigator reuses the new topology without rebuilding the untouched sheet");
    assert.equal(H.compileCached(p,{defs}),changed.hierarchy);
  } finally {A.nearSegment=near;AtriumMultichannel.decorate=decorate;U.reset();}
}
sharedHierarchyWork();

async function panelEdits(parseHTML) {
  const {window,document}=parseHTML('<html><body><aside id="navigator"></aside></body></html>');
  for(const module of ["annotate","undo-store","nav-common"])require(require("../support/app-source-paths.cjs").appFile(module+".js"));
  const N=AtriumNavigatorPanel,U=AtriumUndoStore,p=AtriumParts.example(),[main]=p.documents;
  const hidden=Atrium.sheet("schematic","Hidden sheet"),part=main.items.find(i=>i.ref==="R1");
  part.value="Review sensor AA";
  const other={...part,id:"hidden-part",link:"hidden-link",ref:"R?",value:"Review sensor AB"};
  hidden.items.push(other);p.documents.push(hidden);
  const defs=new Map(p.library.map(d=>[d.id,d])),history=[],future=[],events=new Map();
  let picked,reads=0;
  globalThis.document=document;
  globalThis.AtriumQuery={applyIds(docId,ids){picked=[docId,ids];}};
  N.attach({project:()=>p,currentId:()=>main.id,defs:()=>{reads++;return defs;},docById:id=>p.documents.find(d=>d.id===id),
    registerAction(){},info(){},canvas:()=>null,on:(name,callback)=>events.set(name,callback)});
  const edit=(fn,commit=true)=>{
    const before=U.mark(p,{current:main.id});fn();U.checkpoint(history,future,before);
    if(commit)U.record(p);else U.touch(p);
    events.get("change")();
  };
  const snapshot=rows=>rows.map(({entry,_k,...row})=>row);
  try {
    U.record(p);N.toggle(true);
    const search=document.querySelector('.navp-tools input');
    const expectFresh=async()=>{
      const expected=snapshot(N.flatten(N.model(p,defs),{query:search.value})), deadline=performance.now()+2000;
      while(JSON.stringify(snapshot(N.rows()))!==JSON.stringify(expected)&&performance.now()<deadline)await new Promise(requestAnimationFrame);
      assert.deepEqual(snapshot(N.rows()),expected);
    };
    search.value="review sensor AA";search.oninput();
    assert.ok(N.rows().some(r=>r.entry?.id===part.id) && !N.rows().some(r=>r.entry?.id===other.id), "typing filters the tree in the input event");
    assert.equal(document.querySelectorAll(".navp-row").length,N.rows().length,"only current matches are mounted for a small result");
    await expectFresh();
    search.value="review sensor AB";search.oninput();
    const enter=new window.Event("keydown",{bubbles:true,cancelable:true});enter.key="Enter";
    search.onkeydown(enter);
    assert.deepEqual(picked,[hidden.id,[other.id]],"Enter uses the newly pasted query");
    edit(()=>{other.value="Changed sensor";});
    picked=null;search.onkeydown(enter);
    assert.equal(picked,null,"Enter sees a pending model change before the scheduled refresh");
    edit(()=>{other.value="Review sensor AB";});

    search.value="";search.oninput();
    const group = N.rows().findIndex(r=>r.group==="parts");
    document.querySelector(`.navp-row[data-index="${group}"]`).dispatchEvent(new window.Event("click",{bubbles:true}));
    search.value="review sensor";search.oninput();search.value="";search.oninput();
    assert.ok(!N.rows().some(r=>r.type==="part"), "clearing a query preserves collapsed groups");
    document.querySelector(`.navp-row[data-index="${group}"]`).dispatchEvent(new window.Event("click",{bubbles:true}));
    assert.ok(N.rows().some(r=>r.entry?.id===other.id));

    search.value="review sensor";search.oninput();await expectFresh();
    const index=N.rows().findIndex(r=>r.entry?.id===other.id);
    document.querySelector(`.navp-row[data-index="${index}"]`).dispatchEvent(new window.Event("click",{bubbles:true}));
    assert.deepEqual(picked,[hidden.id,[other.id]]);

    // Annotate updates an unopened sheet in place while the main sheet stays active.
    edit(()=>AtriumAnnotate.apply(p,AtriumAnnotate.plan(p)));
    await expectFresh();
    assert.notEqual(other.ref,"R?");
    const active=document.querySelector("#navp-active");
    assert.equal(N.rows()[+active.dataset.index].entry.id,other.id,"the active Navigator row survives renumbering");

    N.toggle(false);
    const at=reads;
    edit(()=>{part.value="Review sensor revised AA";other.value="Review sensor revised AB";},false);
    assert.equal(reads,at,"edits with Navigator closed do not read the model");
    N.toggle(true);await expectFresh();
    for(let i=0;i<2;i++){
      U.jump(history,future,U.mark(p,{current:main.id}),-1);events.get("change")();
      await expectFresh();
    }
    assert.equal(other.ref,"R?");assert.equal(other.value,"Review sensor AB");
    const loaded=Atrium.sheet("schematic","Hydrated sheet");
    loaded.items.push({...part,id:"hydrated-part",value:"Review sensor late"});
    U.reconcile(p,()=>p.documents.push(loaded),{structureChanged:true});
    events.get("document")();
    await expectFresh();
    assert.ok(N.rows().some(r=>r.entry?.id==="hydrated-part"),"navigation sees an idle-loaded sheet");
    console.log("PASS Navigator refreshes queried rows for hidden-sheet annotation, closed-panel edits and undo");
  } finally {
    N.toggle(false);U.reset();delete globalThis.document;delete globalThis.AtriumQuery;
  }
}

async function run(){
  const flag=process.argv.indexOf("--dom");
  const moduleName=flag<0?"linkedom":pathToFileURL(path.resolve(process.argv[flag+1])).href;
  let parseHTML;try{({parseHTML}=await import(moduleName));}catch{console.log("SKIP virtual list DOM test: linkedom is not installed");return;}
  const {window,document}=parseHTML('<body><div class="pane-scroll"><div id="parts"></div></div></body>');
  const list=document.querySelector("#parts"),scroller=list.parentElement;
  scroller.scrollTop=0;
  Object.defineProperty(scroller,"clientHeight",{value:620});
  scroller.getBoundingClientRect=()=>({top:15,height:620});
  list.getBoundingClientRect=()=>({top:15+140-scroller.scrollTop,height:parseInt(list.style.height)||620});
  global.requestAnimationFrame=cb=>setTimeout(cb,0);
  require("../../app/editor/navigator.js");
  let lastPick;
  const view=AtriumNavigator.create(list,(id,activate)=>{lastPick=[id,activate];view.select(id);});
  const parts=Array.from({length:20000},(_,i)=>{const n=(i*7919)%20000+1;return {id:"r"+n,kind:"part",ref:"R"+n,value:"1 kΩ"};});
  const board={id:"board",items:parts},defs=new Map();
  const start=performance.now();
  assert.equal(view.refresh(board,defs,null),20000);
  const firstPaint=performance.now()-start;
  const initial=[...list.querySelectorAll("button")];
  assert(initial.length<=96 && initial.length>=10,"visible rows only");
  assert.equal(initial[0].dataset.part,"r1","numeric ordering");
  const selectionStart=performance.now();
  for(let i=0;i<5000;i++)view.select("r"+(i%15+1));
  const selectionTime=performance.now()-selectionStart;
  assert.deepEqual([...list.querySelectorAll("button")],initial,"selection updates the existing rows in place");
  assert.equal(list.querySelectorAll('[aria-selected="true"]').length,1);

  function key(k){const e=new window.Event("keydown",{bubbles:true,cancelable:true});e.key=k;list.dispatchEvent(e);}
  key("End");
  assert.deepEqual(lastPick,["r20000",false]);
  const end=list.querySelector('[data-part="r20000"]');
  assert.equal(end.getAttribute("aria-posinset"),"20000");assert.equal(end.getAttribute("aria-setsize"),"20000");
  assert.equal(end.getAttribute("aria-selected"),"true");assert.equal(list.getAttribute("aria-activedescendant"),end.id);
  key("ArrowUp");assert.deepEqual(lastPick,["r19999",false]);
  key("Enter");assert.deepEqual(lastPick,["r19999",true]);
  key("PageUp");assert.deepEqual(lastPick,["r19980",false]);
  key("Home");assert.deepEqual(lastPick,["r1",false]);
  scroller.scrollTop=140+31*12345;
  scroller.dispatchEvent(new window.Event("scroll"));await new Promise(requestAnimationFrame);
  assert.ok(list.querySelector('[data-part="r12346"]'));assert.ok(list.querySelectorAll("button").length<=96);
  const savedScroll=scroller.scrollTop;
  const small={id:"small",items:parts.slice(-7)};
  assert.equal(view.refresh(small,defs,null),7);
  assert.equal(list.querySelectorAll("button").length,7);assert.equal(scroller.scrollTop,0);
  view.refresh(board,defs,null);assert.equal(scroller.scrollTop,savedScroll);
  view.refresh({id:"empty",items:[]},defs,null);assert.equal(list.querySelectorAll("button").length,0);assert.match(list.textContent,/No components/);
  console.log("PASS virtual navigator: 20,000 components, "+initial.length+" initial mounted rows; initial DOM model "+firstPaint.toFixed(2)+" ms; 5,000 selection updates "+selectionTime.toFixed(2)+" ms; preserved node identity, keyboard navigation and per-document scroll.");
  await panelEdits(parseHTML);
}
globalThis.__testDone=run().catch(e=>{console.error(e);process.exitCode=1;});
