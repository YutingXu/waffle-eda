"use strict";
const assert = require("node:assert/strict");
for (const m of ["model","design-query-record","parts","sch-appearance","sch-objects","hierarchy","multichannel","erc","netlist","component-match","diff","undo-store","altium-export","kicad-export","kicad-schematic","frame-conversion"])
  require(require("../support/app-source-paths.cjs").appFile(m+".js"));
const A=Atrium, S=AtriumSchObjects, H=AtriumHierarchy, F=AtriumFrameConversion;
const def = {id:"one",name:"Input",prefix:"U",footprint:{name:"Pin",pads:[],shapes:[]},symbol:{shapes:[],pins:[{x:0,y:0,number:"1",name:"Pin",electrical:0}]}};
const output = {...def,id:"out",symbol:{shapes:[],pins:[{...def.symbol.pins[0],electrical:2}]}};
const bidir = {...def,id:"io",symbol:{shapes:[],pins:[{...def.symbol.pins[0],electrical:1}]}};
const add = (doc,i) => (doc.items.push(i),i);
const wire = (d,...points) => add(d,{kind:"wire",id:A.id(),points});
const label = (d,text,x,y) => add(d,{kind:"netlabel",id:A.id(),text,x,y});
const pin = (d,ref,x,y,lib=def) => add(d,{kind:"part",id:A.id(),ref,value:"",x,y,angle:0,def:lib.id,link:A.id(),pinNets:{}});
const frame = (d,x=-10,y=-10,w=20,h=20,text="Module") => add(d,{kind:"textframe",role:"frame",id:A.id(),x,y,w,h,text});
function project(scope) {
  const p=A.project("Extraction",[def,output,bidir]);
  p.rules={list:[{id:"scope",type:"ercNetScope",enabled:true,scope:AtriumDesignQueryRecord.selector("all"),netScope:scope}]};
  return p;
}
const netlist = p => AtriumNetlist.extract(p,{source:"schematic"}).nets;
const diff = (a,b) => AtriumDiff.compare(a,b,{schematicNets:"compiled",ignoreAutoNetNames:false}).changes.filter(c => c.category==="connectivity");
function convert(p,d,f,scope,options={}) {
  const ref=A.clone(p), before=JSON.stringify(p), oldIds=new Set(d.items.map(i=>i.id));
  const result=F.plan(p,d.id,f.id,{scope,...options});
  assert.equal(JSON.stringify(p),before,"planning is read-only");
  p.rules.list[0].netScope=scope;
  result.apply(p);
  assert.deepEqual(netlist(p),netlist(ref),"exported pin names, electrical types and physical nets");
  assert.deepEqual(diff(ref,p).map(x=>x.text),[],"Compare reports no connectivity changes");
  assert.deepEqual(diff(p,ref).map(x=>x.text),[],"reverse comparison");
  for (const id of oldIds) assert.equal(p.documents.flatMap(s=>s.items.filter(i=>i.id===id)).length,1,"retained unique "+id);
  assert.equal(result.symbol.id,f.id);
  assert.throws(()=>result.apply(p),/frame changed/);
  return result;
}

// An arbitrarily placed rotated/mirrored part, a physical wire cut, label-only
// connectivity, global power, and disjoint sheets with the same local spelling.
for (const scope of ["global","flat","hierarchical"]) {
  const p=project(scope),d=p.documents[0],other=A.sheet("schematic","Other");p.documents.push(other);
  const f=frame(d,-105,-205,20,20,"RF");const a=pin(d,"A1",-100,-200,output);
  a.angle=90;a.mirror=true;
  pin(d,"B1",-65,-200);wire(d,[-100,-200],[-79,-200],[-65,-200]);label(d,"CLK",-67,-200);
  pin(d,"A2",-100,-195);pin(d,"B2",-65,-195);label(d,"SENSE",-100,-195);label(d,"SENSE",-65,-195);
  pin(d,"A3",-100,-190);add(d,S.make("power",[-100,-190],{text:"GND"}));
  pin(other,"C3",5,5);add(other,S.make("power",[5,5],{text:"GND"}));
  pin(other,"C4",0,0);label(other,"CLK",0,0);
  const note=add(d,{kind:"textframe",id:A.id(),x:-98,y:-203,w:2,h:1,text:"Note"});
  p.review={version:1,records:{thread:{id:"thread",type:"thread",doc:d.id,anchor:{id:note.id}}}};
  p.waivers={version:1,list:[{id:"w",objects:[{doc:d.id,id:a.id}]}]};
  const result=convert(p,d,f,scope), edge=result.symbol.entries.find(e=>e.io==="output");
  assert.ok(edge);assert.deepEqual(S.entryPoint(result.symbol,edge),[-85,-200]);
  assert.ok(result.child.items.includes(a));assert.ok(result.child.items.includes(note));assert.ok(result.child.sheet.infinite);
  assert.equal(p.review.records.thread.doc,result.child.id);assert.equal(p.waivers.list[0].objects[0].doc,result.child.id);
  assert.ok(result.child.items.some(i=>i.kind==="power" && i.text==="GND"));
  if (scope==="flat") assert.ok(d.items.some(i=>i.kind==="port" && i.text===edge.name));
}

// Re-entry across a rectangle, a through-wire with both endpoints outside, a
// bare crossing exactly on its edge, a corner-tangent and an internal isolated pin.
{
  const p=project("hierarchical"),d=p.documents[0],f=frame(d);
  const line=wire(d,[-20,0],[5,0],[5,18],[12,18],[12,6],[5,6],[-20,6]);
  pin(d,"U1",-20,0,output);pin(d,"U2",-20,6);pin(d,"U3",5,0);label(d,"LOOP",5,0);
  wire(d,[-15,-5],[-5,5]);label(d,"DIAG",-15,-5);pin(d,"U4",-15,-5);pin(d,"U5",-5,5);
  const tangent=wire(d,[-15,5],[-5,15]);pin(d,"U6",-15,5);pin(d,"U7",-5,15);
  pin(d,"U8",7,7);
  const r=convert(p,d,f,"hierarchical");
  assert.ok(r.parent.items.some(i=>i.id===line.id));assert.ok(r.parent.items.includes(tangent));
  assert.deepEqual(r.symbol.entries.map(e=>e.name).sort(),["DIAG","LOOP"]);
  assert.ok(r.child.items.filter(i=>i.kind==="wire").length>=3);
}

// A bus is one interface and its member nets retain their pin sets. Multiple labels
// along one bus alias by vector index; the original Altium/KiCad spelling survives.
for (const scope of ["hierarchical","flat","global"]) {
  const p=project(scope),d=p.documents[0],f=frame(d),bus=add(d,S.make("bus",[0,0],{points:[[-20,0],[5,0]]}));
  label(d,"DATA[1..0]",-20,0);label(d,"D[0..1]",5,0);
  for (let k=0;k<2;k++) {
    pin(d,"U"+(k+1),2,3+k);label(d,"D"+k,2,3+k);
    pin(d,"J"+(k+1),-20,3+k);label(d,"DATA"+k,-20,3+k);
  }
  const be=add(d,{id:A.id(),kind:"busentry",x:2,y:2,angle:0,size:2});
  const r=convert(p,d,f,scope);assert.ok(r.child.items.includes(be));
  assert.equal(r.symbol.entries.filter(e=>S.isBus(e.name)).length,1);
  assert.ok(r.parent.items.some(i=>i.id===bus.id));assert.ok(r.child.items.some(i=>i.kind==="bus"));
}

// A diagonal bus entry may itself straddle the edge while neither the bus nor
// member wire crosses it. Its shortened glyph ends at the interface on its bus side.
for (const busFirst of [false,true]) {
  const p=project("hierarchical"),d=p.documents[0],f=frame(d,0,0,10,10);
  const tap=add(d,{kind:"busentry",id:A.id(),x:-1,y:6,angle:0,size:2});
  const ends=S.hotspots(tap),[bx,by]=ends[busFirst ? 0 : 1],[wx,wy]=ends[busFirst ? 1 : 0];
  add(d,S.make("bus",[bx,by],{points:[[bx,2],[bx,8]]}));label(d,"D[0..7]",bx,8);
  const finish=wx<0 ? -7 : 7;wire(d,[wx,wy],[finish,wy]);pin(d,"U1",finish,wy);label(d,"D0",finish,wy);
  const r=convert(p,d,f,"hierarchical"),owner=busFirst ? r.parent : r.child;
  const clipped=owner.items.find(i=>i.id===tap.id);
  assert.ok(clipped);assert.equal(clipped.size,1);
  assert.ok(S.hotspots(clipped).some(q=>A.same(q,[0,5])));
  assert.deepEqual(r.symbol.entries.map(e=>[e.name,S.entryPoint(r.symbol,e)]),[["D0",[0,5]]]);
}

// An existing bus port without a drawn bus still represents its named members.
// Moving a repeated sheet symbol preserves the parent's Repeat(SIG) fan-out.
{
  const p=project("hierarchical"),root=p.documents[0],top=A.sheet("schematic","Module"),channel=A.sheet("schematic","Repeated");p.documents.push(top,channel);
  const rootSym=add(root,S.make("sheetsymbol",[40,0],{name:"Root",sheet:top.id,entries:[{id:A.id(),name:"D[0..1]",side:"left",offset:4,io:"input"}]}));
  void rootSym;
  const f=frame(top,-20,-20,40,40),port=add(top,S.make("port",[0,-15],{text:"D[0..1]"}));
  add(top,S.make("sheetsymbol",[0,0],{name:"Repeat(CH,1,2)",sheet:channel.id,w:10,h:8,
    entries:[{id:A.id(),name:"Repeat(SIG)",side:"left",offset:2,io:"input"}]}));
  pin(channel,"U1",0,0);add(channel,S.make("port",[0,0],{text:"SIG"}));
  for(let k=0;k<2;k++){
    pin(top,"R"+(k+1),40,4*k);label(top,"SIG"+(k+1),40,4*k);label(top,"D"+k,40,4*k);
    pin(root,"P"+(k+1),10,4*k);label(root,"D"+k,10,4*k);
  }
  const r=convert(p,top,f,"hierarchical");
  assert.ok(r.child.items.some(i=>i.id===port.id));assert.ok(r.symbol.entries.some(e=>S.isBus(e.name)));
}

// Creating a flat bus port with the original member spelling would short two unrelated
// nets. Both surviving bus drawings alias the fresh port name to the original members.
{
  const p=project("flat"),d=p.documents[0],other=A.sheet("schematic","Independent");p.documents.push(other);
  const f=frame(d);
  add(d,S.make("bus",[0,0],{points:[[-18,0],[6,0]]}));label(d,"DATA[0..1]",-18,0);
  for(let i=0;i<2;i++){pin(d,"U"+i,4,i+2);label(d,"DATA"+i,4,i+2);pin(d,"J"+i,-19,i+2);label(d,"DATA"+i,-19,i+2);}
  pin(other,"Q1",1,1);add(other,S.make("port",[1,1],{text:"DATA0"}));
  const r=convert(p,d,f,"flat");assert.ok(r.symbol.entries.some(e=>S.isBus(e.name)&&e.name!=="DATA[0..1]"));
}

// Multiple ordinary instances below an explicit repeated channel keep independent
// pin identities. The old port on the nested sheet remains reachable by its parent.
{
  const p=project("hierarchical"),top=p.documents[0],mid=A.sheet("schematic","Channel"),nested=A.sheet("schematic","Nested");p.documents.push(mid,nested);
  const repeat=add(top,S.make("sheetsymbol",[40,0],{name:"Repeat(CH,1,2)",sheet:mid.id,entries:[]}));
  for (let k=0;k<2;k++) {
    const s=add(mid,S.make("sheetsymbol",[35,20*k],{name:"Channel",sheet:nested.id,entries:[{id:A.id(),name:"PAD",side:"left",offset:3,io:"input"}]}));
    const pt=S.entryPoint(s,s.entries[0]);pin(mid,"J"+(k+1),...pt);label(mid,"DATA"+k,...pt);
  }
  const f=frame(nested);pin(nested,"U1",1,0);add(nested,S.make("port",[1,0],{text:"PAD",io:"input"}));pin(nested,"U2",20,0,output);
  wire(nested,[1,0],[20,0]);
  const source=nested.items.find(i=>i.ref==="U1"),board=p.documents[1],channels=H.instances(p).instances.filter(i=>i.doc===nested);
  const bp=channels.map((i,k)=>add(board,{kind:"part",id:A.id(),def:source.def,value:"",ref:i.designator(source),link:AtriumMultichannel.chLink(source.link,i),
    sourceLink:source.link,channel:i.channelScope,x:20*k,y:0,angle:0,pinNets:{}}));
  board.sync={locations:Object.fromEntries(bp.map((b,k)=>[b.id,{sheet:nested.id,channel:channels[k].id,x:1,y:0}]))};
  p.variants=[{id:"v",name:"Assembly",parts:{[bp[0].link]:{fitted:false}}}];
  const r=convert(p,nested,f,"hierarchical");
  const next=H.instances(p).instances.filter(i=>i.doc===r.child);
  assert.deepEqual(bp.map(b=>b.link),next.map(i=>AtriumMultichannel.chLink(source.link,i)));
  assert.ok(bp.every(b=>board.sync.locations[b.id].sheet===r.child.id));assert.ok(p.variants[0].parts[bp[0].link]);
  assert.equal(H.compile(p).instances.filter(i=>i.doc.id===r.child.id).length,4);
  assert.ok(nested.items.some(i=>i.kind==="port"&&i.text==="PAD"));
  // A later real wiring break in one participating definition is still reported.
  const old=A.clone(p);mid.items.find(i=>i.kind==="sheetsymbol").entries[0].offset+=2;
  assert.ok(diff(old,p).length);assert.equal(S.repeatOf(repeat).to,2);
}

// Automatic cannot silently disconnect a pair of unrelated Global labels. An
// explicitly retained Global plan is electrically equivalent, even with no board.
{
  const p=project("automatic"),d=p.documents[0],f=frame(d);
  pin(d,"P1",0,0);pin(d,"P2",20,0);wire(d,[0,0],[20,0]);
  for (let i=0;i<2;i++){const o=A.sheet("schematic","Elsewhere "+i);p.documents.push(o);pin(o,"T"+i,2,2);label(o,"SHARED",2,2);}
  assert.throws(()=>F.plan(p,d.id,f.id,{scope:"hierarchical"}),/disconnect/);
  convert(p,d,f,"global");
}

// In a repeated Flat source a global port cannot distinguish two channel-local
// nets. Only the Hierarchical choice preserves the named physical pin sets.
{
  const p=project("flat"),top=p.documents[0],ch=A.sheet("schematic","Channel");p.documents.push(ch);
  add(top,S.make("sheetsymbol",[40,0],{name:"Repeat(CH,1,2)",sheet:ch.id,entries:[]}));
  const f=frame(ch);pin(ch,"A1",0,0);pin(ch,"A2",20,0);wire(ch,[0,0],[20,0]);label(ch,"LOCAL",20,0);
  assert.throws(()=>F.plan(p,ch.id,f.id,{scope:"flat"}),/join/);
  convert(p,ch,f,"hierarchical");
}

// Unnamed repeated nets embed the physical designator *inside* their names. An
// ordinary port's suffix would change those names. The generated fallback label
// retains its original connected pin, requiring no declarations on unrelated sheets.
for (const style of ["hyphen","underscore"]) {
  const p=project("hierarchical"),top=p.documents[0],ch=A.sheet("schematic","Repeated");p.documents.push(ch);
  if (style === "underscore") ch.sourceName="Repeated.SchDoc";
  add(top,S.make("sheetsymbol",[50,0],{name:"Repeat(CH,1,2)",sheet:ch.id,entries:[]}));
  const f=frame(ch),source=pin(ch,"A1",0,0);pin(ch,"Z2",20,0);wire(ch,[0,0],[20,0]);
  const old=A.clone(p),r=convert(p,ch,f,"hierarchical");
  const naming=r.child.items.find(i=>i.autoName);
  assert.deepEqual(naming?.autoName,{part:source.id,pin:"1",style});
  const literal=A.clone(p);
  for (const d of literal.documents) for (const i of d.items) delete i.autoName;
  const partition=proj=>AtriumNetlist.extract(proj,{source:"schematic"}).nets.map(n=>n.nodes.map(p=>p.ref+"."+p.pin).sort().join(",")).sort();
  assert.deepEqual(partition(literal),partition(old),"a reader of literal labels preserves separate channel pins");
  assert.ok(AtriumAltiumExport.exportSchematic(p,r.child).diagnostics.some(s=>s.includes("literal net labels")));
  assert.ok(AtriumKiCadSchematic.exportSheet(p,r.child).diagnostics.some(s=>s.includes("literal net labels")));
  source.ref="B3";
  const expected=style==="hyphen" ? "Net-B3_CH2-1" : "NetB3_CH2_1";
  assert.ok(H.compile(p).nets.some(n=>n.name===expected),"stable pin reference follows re-annotation");
  label(r.child,"EXPLICIT",source.x,source.y);
  assert.ok(H.compile(p).nets.some(n=>n.name==="EXPLICIT_CH2"),"user label takes priority");
  r.child.items.pop();source.y+=2;
  assert.ok(!H.compile(p).nets.some(n=>n.name===expected),"a disconnected naming pin cannot name a different net");
}

// An empty-entry wrapper draws no connections on a previously annotation-only
// schematic. The comparison's existing annotation fallback still sees parent and child.
{
  const p=project("global"),d=p.documents[0],f=frame(d);pin(d,"U1",0,0).pinNets={"1":"SENSE"};pin(d,"U2",22,0).pinNets={"1":"SENSE"};
  const before=A.clone(p);convert(p,d,f,"global");const normal=AtriumDiff.compare(before,p);
  assert.deepEqual(normal.changes.filter(c=>c.category==="connectivity").map(c=>c.text),[]);
}

// Empty frames, collision-free document names and reproducible temporary exports.
{
  const p=project("flat"),d=p.documents[0],f=frame(d,0,0,10,10,d.name);
  const produce=()=>{let n=0;return F.plan(p,d.id,f.id,{makeId:()=>"generated-"+(++n)});};
  assert.deepEqual(produce().child,produce().child);
  const r=convert(p,d,f,"flat");assert.notEqual(r.child.name,d.name);assert.equal(r.symbol.entries.length,0);
}

// Local and sibling targets leave a repeated child. External and missing targets stay. The reversed call is Undo.
for (const m of ["note-fields","notebook","calculation-records","widget-catalogue","sheet-widgets"]) require(require("../support/app-source-paths.cjs").appFile(m+".js"));
{
  const child="child-sheet",parent="parent-sheet",ext="external-sheet",occ="occ-local-child",out="occ-outside";
  const moved=new Set(["item-local","item-sibling","item-unmapped"]);
  const t=(docId,itemId,instanceId)=>({docId,itemId,instanceId});
  const rows=[t(child,"item-local",occ),t(child,"item-sibling",occ),t(ext,"item-external","occ-external"),t(child,"item-missing",occ),t(child,"item-unmapped",occ),t(child,"item-stale","occ-stale"),{...t(child,"item-local",occ),detached:true}];
  const inst=new Map([["occ-stale","from-get"]]);
  inst.forTarget=(id,doc,item)=>doc===child&&id===occ&&(item==="item-local"||item==="item-sibling")?out:doc===parent&&id===occ&&(item==="item-local"||item==="item-sibling")?"post-mutation-lookup":doc===parent&&id===out&&(item==="item-local"||item==="item-sibling")?occ:id==="occ-external"?"occ-external":undefined;
  const copy=()=>rows.map(v=>({...v}));
  const note={id:"n",kind:"textframe",richText:{blocks:[{runs:[...copy().map(binding=>({binding})),{binding:null}]}]}};
  const calc={id:"c",kind:"calculation",bindings:[...copy().map(target=>({target})),{target:null}],assertions:[{id:"a",bindings:copy().map(target=>({target}))}]};
  const todo={id:"w",kind:"textframe",widget:{type:"todo",state:{rows:[...copy().map(link=>({link})),{link:null}]}}};
  const project={documents:[{items:[note,calc,todo]}]};
  const view=i=>[note.richText.blocks[0].runs[i].binding,calc.bindings[i].target,calc.assertions[0].bindings[i].target,todo.widget.state.rows[i].link];
  const every=(i,f)=>view(i).every(f);
  AtriumNotebook.moveBindings(project,child,parent,moved,inst);
  assert.ok(every(0,v=>v.docId===parent&&v.instanceId===out)&&every(1,v=>v.docId===parent&&v.instanceId===out),"local target and positive sibling");
  assert.ok(every(2,v=>v.docId===ext&&v.instanceId==="occ-external")&&every(3,v=>v.docId===child&&v.instanceId===occ)&&every(4,v=>v.docId===parent&&v.instanceId===occ),"external, left-behind and missing occurrence");
  assert.deepEqual(view(5).map(v=>v.instanceId), ["from-get","occ-stale","occ-stale","from-get"], "only rich text and widgets fall back to the map");
  assert.deepEqual(view(6).map(v=>v.docId), [parent,child,child,child], "only rich text rebases detached targets");
  assert.equal(note.richText.blocks[0].runs[7].binding,null); assert.equal(calc.bindings[7].target,null); assert.equal(todo.widget.state.rows[7].link,null);
  AtriumNotebook.moveBindings(project,parent,child,moved,inst);
  assert.ok(every(0,v=>v.docId===child&&v.instanceId===occ)&&every(1,v=>v.docId===child&&v.instanceId===occ)&&every(4,v=>v.docId===child&&v.instanceId===occ),"Undo restores moved targets");
  assert.ok(every(2,v=>v.docId===ext&&v.instanceId==="occ-external")&&every(3,v=>v.docId===child&&v.instanceId===occ));
}
console.log("PASS frame extraction preserves physical pin, wire, bus and target identity across net scopes and repeated instances");
