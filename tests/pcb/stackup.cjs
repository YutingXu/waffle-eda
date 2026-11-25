"use strict";
// Layer Stack Manager model: defaults, presets, edits, blocked removal, drill
// pairs, Altium import and the delay from AtriumImpedance.
const assert=require("node:assert/strict");
globalThis.CFB=require("../../app/vendor/cfb.min.js");
for(const m of ["model","altium-rules","pcb-import","impedance","stackup","undo-store"])require(require("../support/app-source-paths.cjs").appFile(m+".js"));
const S=AtriumStackup,A=Atrium;
const close=(a,b,eps=1e-6,m)=>assert.ok(Math.abs(a-b)<=eps,(m?m+": ":"")+a+" differs from "+b);
const board=()=>A.sheet("pcb","Board");
const types=stack=>stack.layers.map(l=>l.type);
const sources=stack=>stack.layers.map(l=>S.isCopper(l)?{...l,source:l.key}:{...l});

// Default: Altium's two-layer build-up near 1.6 mm.
{
  const doc=board(),stack=S.get(doc,new Map());
  assert.equal(stack.derived,true);assert.equal(S.stored(doc),null);
  assert.deepEqual(types(stack),["Overlay","Solder Mask","Signal","Dielectric","Signal","Solder Mask","Overlay"]);
  assert.deepEqual(S.copperLayers(doc),["Top","Bottom"]);
  const [top,core]=[stack.layers[2],stack.layers[3]];
  assert.equal(top.thickness,.035);assert.equal(S.weight(top.thickness),1);assert.equal(top.name,"Top Layer");
  assert.equal(core.material,"FR-4");assert.equal(core.dielectric,"Core");close(core.thickness,1.51,1e-9);
  assert.ok(core.dk>4&&core.df>0);
  close(S.thickness(doc),1.6,.005,"total thickness");
  assert.equal(stack.layers[1].thickness,.01016);
}
// Derived stacks widen to the deepest inner layer objects use.
{
  const doc=board(),defs=new Map([["fp",{id:"fp",name:"FP",footprint:{shapes:[],pads:[{x:0,y:0,w:1,h:1,layer:"Inner 2",number:"1"}]}}]]);
  doc.items.push({id:"t",kind:"track",points:[[0,0],[1,0]],width:.2,layer:"Top"});
  assert.deepEqual(S.copperLayers(doc,defs),["Top","Bottom"]);
  doc.items.push({id:"p",kind:"part",def:"fp",ref:"U1",value:"",x:0,y:0,angle:0,pinNets:{}});
  assert.deepEqual(S.copperLayers(doc,defs),["Top","Inner 1","Inner 2","Bottom"]);
  doc.items.push({id:"v",kind:"via",x:0,y:0,diameter:.6,drill:.3,layer:"Multi",fromLayer:"Top",toLayer:"Inner 4"});
  assert.deepEqual(S.copperLayers(doc,defs),["Top","Inner 1","Inner 2","Inner 3","Inner 4","Bottom"]);
  close(S.thickness(doc,defs),1.6,.01);
}
// Presets: 2, 4, 6 and 8 layers with planes, all near 1.6 mm.
for(const [id,n,planes] of [["2",2,[]],["4",4,["Inner 1","Inner 2"]],["6",6,["Inner 1","Inner 4"]],["8",8,["Inner 1","Inner 3","Inner 4","Inner 6"]]]){
  const p=S.preset(id),cu=p.layers.filter(S.isCopper);
  assert.equal(cu.length,n);assert.deepEqual(cu.filter(l=>l.type==="Plane").map(l=>l.key),planes);
  close(p.layers.reduce((s,l)=>s+l.thickness,0),1.6,.01,"preset "+id);
  assert.deepEqual(S.problems(p.layers),[]);
  assert.deepEqual(S.normalize(JSON.parse(JSON.stringify(p))).layers,p.layers);
}
assert.equal(S.preset(4).layers.find(l=>l.key==="Inner 1").name,"GND");
// Validation.
{
  const p=S.preset(2);
  assert.throws(()=>S.normalize({layers:p.layers.filter(l=>l.type!=="Dielectric")}),/need a dielectric between them/);
  const inside=[...p.layers];inside.splice(3,0,{type:"Solder Mask",name:"Stray",thickness:.01});
  assert.throws(()=>S.normalize({layers:inside}),/belong outside the copper/);
  assert.throws(()=>S.normalize({layers:p.layers.filter((l,i)=>i!==4)}),/at least two copper/);
  assert.throws(()=>S.normalize({layers:p.layers.map(l=>l.type==="Signal"?{...l,thickness:0}:l)}),/thickness above zero/);
  assert.throws(()=>S.normalize({version:9,layers:p.layers}),/newer version/);
  const doc=board();doc.stackup={version:1,layers:[{type:"Signal"}]};
  assert.equal(S.stored(doc),null,"an unreadable stack falls back to the derived default");
  assert.deepEqual(S.copperLayers(doc),["Top","Bottom"]);
  const keys=S.normalize({layers:p.layers.map(l=>({...l,key:"Inner 9"}))}).layers.filter(S.isCopper).map(l=>l.key);
  assert.deepEqual(keys,["Top","Bottom"],"keys follow stack position");
}

// Adding layers: an inner pair renumbers nothing; a layer above Top renumbers.
{
  const doc=board(),defs=new Map();
  const top={id:"a",kind:"track",points:[[0,0],[1,0]],width:.2,layer:"Top"},bottom={id:"b",kind:"track",points:[[0,1],[1,1]],width:.2,layer:"Bottom"};
  doc.items.push(top,bottom);
  const layers=sources(S.get(doc,defs)),core=layers.findIndex(l=>l.type==="Dielectric");
  layers.splice(core+1,0,S.blank("Plane","GND"),S.blank("Prepreg"));
  let r=S.plan(doc,defs,layers);
  assert.equal(r.ok,true,r.problems.join(" "));
  assert.equal(S.apply(doc,defs,r),0);
  assert.deepEqual(S.copperLayers(doc),["Top","Inner 1","Bottom"]);
  assert.equal(S.stored(doc).layers.find(l=>l.key==="Inner 1").type,"Plane");
  assert.equal(top.layer,"Top");assert.equal(bottom.layer,"Bottom");
  const json=JSON.parse(JSON.stringify(doc.stackup));assert.equal(json.version,1);assert.equal(json.derived,undefined);
  assert.ok(json.layers.every(l=>!("source" in l)));
  // A new signal layer above the old top layer becomes Top; objects follow their layer.
  const next=sources(S.stored(doc)),first=next.findIndex(S.isCopper);
  next.splice(first,0,S.blank("Signal","New top"),S.blank("Prepreg"));
  r=S.plan(doc,defs,next);assert.equal(r.ok,true,r.problems?.join(" "));
  assert.equal(S.apply(doc,defs,r),1);
  assert.equal(top.layer,"Inner 1");assert.equal(bottom.layer,"Bottom");
  assert.deepEqual(S.copperLayers(doc),["Top","Inner 1","Inner 2","Bottom"]);
  // Moving a copper layer: its objects keep riding with it.
  const moved=sources(S.stored(doc)),i=moved.findIndex(l=>l.source==="Inner 1"),j=moved.findIndex(l=>l.source==="Inner 2");
  [moved[i],moved[j]]=[moved[j],moved[i]];
  r=S.plan(doc,defs,moved);assert.equal(r.ok,true);S.apply(doc,defs,r);
  assert.equal(top.layer,"Inner 2");
  assert.equal(S.stored(doc).layers.find(l=>l.key==="Inner 1").name,"GND");
}
// Removing a copper layer that still has objects is blocked unless they move.
{
  const doc=board(),defs=new Map();
  doc.stackup=S.preset(4);
  const track={id:"t",kind:"track",points:[[0,0],[1,0]],width:.2,layer:"Inner 1"};
  const blind={id:"v",kind:"via",x:0,y:0,diameter:.5,drill:.2,layer:"Multi",fromLayer:"Top",toLayer:"Inner 2"};
  doc.items.push(track,blind);
  assert.deepEqual(S.usage(doc,defs,"Inner 1"),{total:1,tracks:1,vias:0,pads:0,other:0,footprints:0,pours:0});
  const without=key=>{
    const list=sources(S.stored(doc)),i=list.findIndex(l=>l.source===key);
    list.splice(i,2);return list;
  };
  let r=S.plan(doc,defs,without("Inner 1"));
  assert.equal(r.ok,false);assert.match(r.problems[0],/GND \(Inner 1\) still holds 1 object: 1 track\. Move them/);
  assert.equal(track.layer,"Inner 1");assert.throws(()=>S.apply(doc,defs,r),/still holds/);
  r=S.plan(doc,defs,without("Inner 1"),{moves:{"Inner 1":"Bottom"}});
  assert.equal(r.ok,true,r.problems.join(" "));
  S.apply(doc,defs,r);
  assert.equal(track.layer,"Bottom");assert.equal(blind.toLayer,"Inner 1","the blind via follows the old Inner 2");
  assert.deepEqual(S.copperLayers(doc),["Top","Inner 1","Bottom"]);
  // Moving the via's end layer onto its start layer would collapse its span.
  r=S.plan(doc,defs,without("Inner 1"),{moves:{"Inner 1":"Top"}});
  assert.equal(r.ok,false);assert.match(r.problems.join(" "),/would start and end on the same layer/);
  // A move target that is itself removed is reported.
  const list=without("Inner 1"),bi=list.findIndex(l=>l.source==="Bottom");list[bi]={...list[bi]};delete list[bi].source;
  r=S.plan(doc,defs,list,{moves:{"Inner 1":"Bottom"}});assert.equal(r.ok,false);
  // Footprint copper on a renumbered layer cannot change when another board shares the footprint.
  const def={id:"fp",name:"Shared",footprint:{shapes:[],pads:[{x:0,y:0,w:1,h:1,layer:"Top",number:"1"}]}},fdefs=new Map([["fp",def]]);
  const other=board();other.items.push({id:"q",kind:"part",def:"fp",ref:"U2",value:"",x:0,y:0,angle:0,pinNets:{}});
  doc.items.push({id:"p",kind:"part",def:"fp",ref:"U1",value:"",x:0,y:0,angle:0,pinNets:{}});
  const grown=sources(S.stored(doc)),first=grown.findIndex(S.isCopper);
  grown.splice(first,0,S.blank("Signal"),S.blank("Core"));
  r=S.plan(doc,fdefs,grown,{project:{documents:[doc,other]}});
  assert.equal(r.ok,false);assert.match(r.problems[0],/Footprint Shared/);
  r=S.plan(doc,fdefs,grown,{project:{documents:[doc]}});assert.equal(r.ok,true);S.apply(doc,fdefs,r);
  assert.equal(def.footprint.pads[0].layer,"Inner 1");assert.equal(track.layer,"Bottom");assert.equal(blind.fromLayer,"Inner 1");
  assert.deepEqual(S.copperLayers(doc),["Top","Inner 1","Inner 2","Bottom"]);
}

// Drill pairs from through, blind and buried vias plus footprint holes.
{
  const doc=board(),stack=S.preset(4);
  stack.drillPairs=[{from:"Inner 2",to:"Bottom"}];doc.stackup=stack;
  const via=(id,a,b)=>({id,kind:"via",x:0,y:0,diameter:.5,drill:.2,layer:"Multi",...(a?{fromLayer:a,toLayer:b}:{})});
  doc.items.push(via("t"),via("b1","Top","Inner 1"),via("b2","Inner 1","Top"),via("u","Inner 1","Inner 2"),via("t2","Bottom","Top"));
  doc.items.push({id:"p",kind:"part",def:"fp",ref:"J1",value:"",x:0,y:0,angle:0,pinNets:{}});
  const defs=new Map([["fp",{id:"fp",name:"Header",footprint:{shapes:[],pads:[{x:0,y:0,w:1.6,h:1.6,drill:1,number:"1"},{x:2,y:0,w:2,h:2,drill:2,number:""},{x:4,y:0,w:1,h:1,drill:0,number:"3",layer:"Top"}]}}]]);
  const pairs=S.drillPairs(doc,defs);
  assert.deepEqual(pairs.map(p=>[p.from,p.to,p.kind,p.vias,p.pads,p.npth,p.defined,p.used]),[
    ["Top","Bottom","through",2,1,1,true,true],
    ["Top","Inner 1","blind",2,0,0,false,true],
    ["Inner 1","Inner 2","buried",1,0,0,false,true],
    ["Inner 2","Bottom","blind",0,0,0,true,false]]);
  assert.deepEqual(pairs.map(p=>p.fileFunction),["Plated,1,4,PTH","Plated,1,2,Blind","Plated,2,3,Buried","Plated,3,4,Blind"]);
  assert.equal(pairs[0].npthFunction,"NonPlated,1,4,NPTH");
  assert.equal(pairs[1].name,"Top Layer - GND");
  // A drill pair whose layer is removed is dropped; others are renumbered.
  const list=sources(S.stored(doc)),i=list.findIndex(l=>l.source==="Inner 2");list.splice(i,2);
  doc.items=doc.items.filter(v=>v.id!=="u");
  const r=S.plan(doc,defs,list);assert.equal(r.ok,true,r.problems.join(" "));
  S.apply(doc,defs,r);assert.deepEqual(doc.stackup.drillPairs,[]);
  doc.stackup.drillPairs=[{from:"Bottom",to:"Inner 1"},{from:"Inner 1",to:"Inner 1"},{from:"Top",to:"Inner 7"}];
  assert.deepEqual(S.stored(doc).drillPairs,[{from:"Inner 1",to:"Bottom"}],"stored pairs are ordered and validated");
}

// Layer facts for exporters (Gerber X2 file functions) and layer tabs.
{
  const doc=board();doc.stackup=S.preset(4);
  const top=S.layerInfo(doc,"Top"),gnd=S.layerInfo(doc,"Inner 1"),bottom=S.layerInfo(doc,"Bottom");
  assert.equal(top.fileFunction,"Copper,L1,Top,Signal");assert.equal(top.number,1);assert.equal(top.count,4);assert.equal(top.side,"Top");
  close(top.z,.01016);assert.equal(top.weight,1);
  assert.equal(gnd.fileFunction,"Copper,L2,Inr,Plane");assert.equal(gnd.name,"GND");assert.equal(gnd.type,"Plane");close(gnd.z,.01016+.035+.2);
  assert.equal(bottom.fileFunction,"Copper,L4,Bot,Signal");
  assert.equal(S.layerInfo(doc,"Top mask").fileFunction,"Soldermask,Top");assert.equal(S.layerInfo(doc,"Top mask").filePolarity,"Negative");
  assert.equal(S.layerInfo(doc,"Bottom mask").fileFunction,"Soldermask,Bot");close(S.layerInfo(doc,"Bottom mask").thickness,.01016);
  assert.equal(S.layerInfo(doc,"Silk").fileFunction,"Legend,Top");assert.equal(S.layerInfo(doc,"Silk").z,0);
  assert.equal(S.layerInfo(doc,"Bottom paste").fileFunction,"Paste,Bot");
  assert.equal(S.layerInfo(doc,"Inner 5"),null);assert.equal(S.layerInfo(doc,"Mechanical 1"),null);
  close(S.layerInfo(doc,"Bottom silk").z,S.thickness(doc));
}

// Impedance and delay come from AtriumImpedance only. The IPC-2141 copy that stackup.js kept
// (AtriumStackup.impedance) was removed: its geometry() gave a dielectric with no Dk 4.8 where
// AtriumImpedance gives 4.4, so length-tuning's delay disagreed with the Layer Stack Manager.
{
  assert.equal(S.impedance,undefined,"no second impedance model");
  const I=AtriumImpedance,L4=S.preset(4).layers,board={kind:"pcb",items:[],stackup:{version:1,layers:L4}};
  const g=I.geometry(L4,"Top");assert.equal(g.structure,"microstrip");close(g.h,.2);
  close(S.delay(board,"Top",.2),I.solve({...g,w:.2}).delay,1e-12,"Top delay is the solver's");
  const bare=L4.map(l=>l.type==="Dielectric"?{...l,dk:undefined}:l);
  close(I.geometry(bare,"Top").er,4.4,1e-12,"a dielectric without a Dk is FR-4 4.4");
  // No reference plane: the one fallback (AtriumImpedance.delayFallback), with the layer's Dk and height.
  close(S.delay(board,"Inner 7",.2),I.PS_PER_MM*Math.sqrt(4.2),1e-12,"a layer not in the stack: inner, Dk 4.2");
  close(I.delayFallback({outer:true,w:.2}).ee,I.models.microstrip(.2,.2,.035,4.2).ee,1e-12,"outer: the solver's microstrip model");
  close(I.delayFallback({outer:false,er:4}).delay,I.PS_PER_MM*2,1e-12,"inner layer: sqrt(er)/c");
  // Differential pairs: the odd-mode delay of the coupled pair, not a lone track of that width.
  const odd=I.solve({...g,w:.2,s:.15});
  close(S.delay(board,"Top",.2,undefined,{gap:.15}),I.PS_PER_MM*Math.sqrt(odd.eeffOdd),1e-12,"pair delay: odd mode");
  close(S.pairDelay(board,"Top",.2,.15),odd.delay,1e-12);
  const lone=S.delay(board,"Top",.2);assert.ok(lone-odd.delay>.01*lone,"a coupled microstrip pair is faster (odd mode sees more air)");
  close(S.delay(board,"Top",.2,undefined,{gap:40}),lone,2e-3*lone,"a far gap tends to the lone track");
  // With a profile: its geometry on the layer and its solved gap.
  const pb={kind:"pcb",items:[],stackup:{version:1,layers:L4,impedanceProfiles:[{id:"d90",name:"D90",type:"diff",target:90,tolerance:10,layers:{Top:{enabled:true,gap:.18}}}]}};
  const pv=S.profileValues(pb,"d90","Top");
  close(S.delay(pb,"Top",pv.width,undefined,{profile:"d90"}),I.solve({...pv.geom,w:pv.width}).delay,1e-12,"profile gap and geometry");
  close(S.delay(pb,"Top",pv.width,undefined,{profile:"d90",gap:.3}),I.solve({...pv.geom,w:pv.width,s:.3}).delay,1e-12,"an explicit gap wins");
}

// KiCad board layer table and stackup section.
{
  const doc=board();doc.stackup=S.preset(4);
  const k=S.kicad(doc);
  assert.deepEqual(k.copper.map(c=>c.slice(0,3)),[[0,"F.Cu","signal"],[1,"In1.Cu","power"],[2,"In2.Cu","power"],[31,"B.Cu","signal"]]);
  const text=k.stackup.join("\n");
  assert.match(text,/^\(stackup/);assert.match(text,/\(layer "F\.Mask" \(type "Top Solder Mask"\) \(thickness 0\.01016\) \(epsilon_r 3\.5\)\)/);
  assert.match(text,/\(layer "dielectric 2" \(type "core"\) \(thickness 1\.04\) \(material "FR-4"\) \(epsilon_r 4\.8\) \(loss_tangent 0\.02\)\)/);
  assert.equal((text.match(/type "copper"/g)||[]).length,4);close(k.thickness,1.6,.005);
  doc.stackup=S.build(["Signal","Signal","Signal"]);assert.equal(S.kicad(doc).stackup,null);
}

// Altium import: the Board6 layer stack becomes doc.stackup, and mid layers
// interleaved with internal planes are renumbered to their stack position.
{
  function props(text){const raw=Buffer.from("|"+text+"\0","latin1"),b=Buffer.alloc(4);b.writeUInt32LE(raw.length);return Buffer.concat([b,raw]);}
  function frame(type,bytes){const b=Buffer.alloc(5);b[0]=type;b.writeUInt32LE(bytes.length,1);return Buffer.concat([b,bytes]);}
  function track(layer){
    const t=Buffer.alloc(49,0);t[0]=layer;t.writeUInt16LE(0xffff,3);t.writeUInt16LE(0xffff,7);
    t.writeInt32LE(0,13);t.writeInt32LE(0,17);t.writeInt32LE(1000000,21);t.writeInt32LE(0,25);t.writeInt32LE(100000,29);return frame(4,t);
  }
  // Top(1) -> GND plane(39) -> Mid1(2) -> Mid2(3) -> PWR plane(40) -> Bottom(32)
  const chain=[[1,"Top Layer",39],[39,"GND",2],[2,"Inner Sig 1",3],[3,"Inner Sig 2",40],[40,"PWR",32],[32,"Bottom Layer",0]];
  const fields=["VX0=0mil|VY0=0mil|VX1=1000mil|VY1=0mil|VX2=1000mil|VY2=1000mil","TOPHEIGHT=0.5mil|TOPCONST=3.8|TOPMATERIAL=LPI"];
  chain.forEach(([id,name,next],i)=>{
    fields.push("LAYER"+id+"NAME="+name+"|LAYER"+id+"NEXT="+next+"|LAYER"+id+"PREV="+(i?chain[i-1][0]:0)+"|LAYER"+id+"COPTHICK="+(id>=39?"1.4mil":"0.7mil"));
    if(next)fields.push("LAYER"+id+"DIELHEIGHT=10mil|LAYER"+id+"DIELCONST=4.3|LAYER"+id+"DIELMATERIAL="+(i%2?"FR-4":"PP 2116")+"|LAYER"+id+"DIELTYPE="+(i%2?1:2));
  });
  const streams=new Map([["board6/data",props(fields.join("|"))],["tracks6/data",Buffer.concat([track(2),track(3),track(1),track(32)])]]);
  const out=AtriumPCB.read("Six.PcbDoc",streams,null),doc=out.documents[0];
  assert.ok(doc.stackup);assert.equal(doc.stackup.source,"Altium");
  const stack=S.normalize(doc.stackup),cu=stack.layers.filter(S.isCopper);
  assert.deepEqual(cu.map(l=>[l.key,l.name,l.type]),[["Top","Top Layer","Signal"],["Inner 1","GND","Plane"],["Inner 2","Inner Sig 1","Signal"],
    ["Inner 3","Inner Sig 2","Signal"],["Inner 4","PWR","Plane"],["Bottom","Bottom Layer","Signal"]]);
  assert.deepEqual(doc.stackup.layers.filter(S.isCopper).map(l=>l.key),cu.map(l=>l.key));
  close(cu[0].thickness,.7*.0254,1e-9);close(cu[1].thickness,1.4*.0254,1e-9);
  const diel=stack.layers.filter(l=>l.type==="Dielectric");
  assert.deepEqual(diel.map(l=>l.dielectric),["Prepreg","Core","Prepreg","Core","Prepreg"]);
  close(diel[0].thickness,.254,1e-9);assert.equal(diel[0].dk,4.3);assert.equal(diel[0].material,"PP 2116");
  const mask=stack.layers[1];assert.equal(mask.type,"Solder Mask");close(mask.thickness,.0127,1e-9);assert.equal(mask.dk,3.8);assert.equal(mask.material,"LPI");
  assert.deepEqual(doc.items.filter(i=>i.kind==="track").map(i=>i.layer),["Inner 2","Inner 3","Top","Bottom"]);
  assert.ok(doc.notes.some(n=>/Inner 1 → Inner 2, Inner 2 → Inner 3/.test(n)));
  assert.deepEqual(S.copperLayers(doc),["Top","Inner 1","Inner 2","Inner 3","Inner 4","Bottom"]);
  close(S.thickness(doc),.0127+.01016+(.7*4+1.4*2)*.0254+5*.254,1e-6,"top mask from TOPHEIGHT, bottom mask default");
  // A board record without stack keys stays as before; a broken chain is ignored.
  const plain=AtriumPCB.read("Plain.PcbDoc",new Map([["board6/data",props("VX0=0mil|VY0=0mil")]]),null).documents[0];
  assert.equal(plain.stackup,undefined);
  const broken=fields.map(f=>f.replace("LAYER40NEXT=32","LAYER40NEXT=7"));
  assert.equal(AtriumPCB.read("Broken.PcbDoc",new Map([["board6/data",props(broken.join("|"))]]),null).documents[0].stackup,undefined);
  // A plain two-layer Altium stack needs no renumbering.
  const two=["VX0=0mil|VY0=0mil","LAYER1NAME=Top|LAYER1NEXT=32|LAYER1COPTHICK=1.4mil|LAYER1DIELHEIGHT=62mil|LAYER1DIELCONST=4.8",
    "LAYER32NAME=Bottom|LAYER32NEXT=0|LAYER32PREV=1|LAYER32COPTHICK=1.4mil"].join("|");
  const d2=AtriumPCB.read("Two.PcbDoc",new Map([["board6/data",props(two)],["tracks6/data",track(1)]]),null).documents[0];
  assert.deepEqual(S.copperLayers(d2),["Top","Bottom"]);assert.ok(!d2.notes.some(n=>/renumbered/.test(n)));
  close(S.thickness(d2),2*.01016+2*1.4*.0254+62*.0254,1e-6);
  assert.equal(S.stored(d2).layers[3].dielectric,"Core");
  // The project validator accepts the imported record.
  const project=A.project("Import");project.documents.push(doc);A.validate(JSON.parse(JSON.stringify(project)));
}
// Solver policy on the 4-layer preset (Top over 0.2 mm prepreg to the Inner 1 plane).
// Profiles without a policy keep the calculator's limits, auto gap and window = tolerance;
// policy "fab" takes the fab limits, the gap order and a DRC window of half the tolerance.
{
  const st=S.normalize(S.preset(4));
  const mk=(type,target,extra={},row={})=>({id:"p",name:"p",type,target,tolerance:10,...extra,layers:{Top:{enabled:true,...row}}});
  const at=(p,o)=>S.resolveProfileLayer(st,p,"Top",undefined,o);
  // Legacy (every stored profile so far): unchanged values, no warning band.
  const l50=at(mk("single",50));close(l50.width,.3567,5e-4);close(l50.minWidth,.2981,5e-4);close(l50.maxWidth,.4294,5e-4);
  assert.equal(l50.policy,"legacy");assert.equal(l50.window,10);assert.equal(l50.warnMinWidth,l50.minWidth);assert.equal(l50.warnMaxWidth,l50.maxWidth);
  const l80=at(mk("single",80));close(l80.minWidth,.0934,5e-4,"legacy keeps the 0.025 mm floor");
  const l90=at(mk("diff",90));close(l90.gap,.2,1e-9,"legacy gap clamp(h, 0.075, 0.5)");assert.equal(l90.warnMinGap,l90.minGap);
  // Fab policy: the same solved width, a ±5 % warning band inside the ±10 % flag band.
  const f50=at(mk("single",50,{policy:"fab"}));close(f50.width,l50.width,1e-9);assert.equal(f50.minWidth,l50.minWidth);
  assert.equal(f50.window,5);assert.ok(f50.minWidth<f50.warnMinWidth&&f50.warnMinWidth<f50.width&&f50.width<f50.warnMaxWidth&&f50.warnMaxWidth<f50.maxWidth);
  for(const [w,z] of [[f50.warnMinWidth,52.5],[f50.warnMaxWidth,47.5]])close(AtriumImpedance.solve({...f50.geom,w}).z,z,.05,"window edge "+z);
  assert.deepEqual([f50.limits.track,f50.limits.space,f50.limits.source],[.1,.1,"default"]);
  assert.equal(at(mk("single",50,{policy:"fab",window:2})).window,2,"explicit window");
  assert.equal(at(mk("single",50,{window:3})).window,3,"a legacy profile honours an explicit window");
  assert.equal(at(mk("single",50,{policy:"fab",window:20})).window,10,"the window never exceeds the tolerance");
  // Fab limits floor the window and the solve: 80 Ω min width 0.1 (legacy 0.093).
  close(at(mk("single",80,{policy:"fab"})).minWidth,.1,1e-9);
  close(at(mk("diff",100,{policy:"fab"}),{limits:{track:.2,space:.1}}).minWidth,.2,1e-9,"preset limits");
  // Gap order: 1. gap = max(min space, clearance, h); 2. width pinned at the fab minimum, gap widened.
  const f90=at(mk("diff",90,{policy:"fab"}));assert.equal(f90.step,"gap");close(f90.gap,.2,1e-9);
  assert.ok(f90.minGap<f90.warnMinGap&&f90.warnMaxGap<f90.maxGap,"gap warning band");
  close(at(mk("diff",90,{policy:"fab"}),{clearance:.25}).gap,.25,1e-9,"clearance floors the gap");
  close(at(mk("diff",90,{policy:"fab"}),{limits:{track:.1,space:.3}}).gap,.3,1e-9,"min space floors the gap");
  const f150=at(mk("diff",150,{policy:"fab"}));assert.equal(f150.step,"pin-width");close(f150.width,.1,1e-9);assert.ok(f150.gap>.2);
  close(AtriumImpedance.solve({...f150.geom}).zdiff,150,.01,"pinned width, widened gap hits the target");
  close(at(mk("diff",90,{policy:"fab"},{gap:.15})).gap,.15,1e-9,"a fixed gap is kept");
  // 3. Unreachable: the reason and the width the target needs.
  const u=at(mk("single",95,{policy:"fab"}));assert.equal(u.unreachable,true);assert.equal(u.reason,"width");assert.ok(u.need<.1);assert.match(u.error,/below the fab minimum width 0\.1 mm/);
  const u2=at(mk("diff",220,{policy:"fab"}));assert.equal(u2.unreachable,true);assert.match(u2.error,/even at gap/);
  assert.ok(at(mk("single",95)).width>0,"legacy keeps solving below the fab minimum");
  // Cleaned profiles keep window, policy and neck; other fields are dropped as before.
  const c=S.normalize({...S.preset(4),impedanceProfiles:[{...mk("diff",90,{policy:"fab",window:4,neck:{maxLength:3}}),junk:1},{...mk("single",50),id:"q",policy:"other",window:"x"}]}).impedanceProfiles;
  assert.equal(c[0].policy,"fab");assert.equal(c[0].window,4);assert.deepEqual(c[0].neck,{maxLength:3});assert.equal(c[0].junk,undefined);
  assert.equal(c[1].policy,undefined);assert.equal(c[1].window,undefined);
  // profileValues: the board's fab limits (fab-presets.js absent here: the default) are part of the cache.
  const doc=board();doc.stackup={...JSON.parse(JSON.stringify(st)),impedanceProfiles:[mk("single",80,{policy:"fab"})]};
  close(S.profileValues(doc,"p","Top").minWidth,.1,1e-9);assert.equal(S.fabLimits(doc).source,"default");
  globalThis.AtriumFabPresets={limits:()=>({track:.12,space:.11,preset:"test-fab"})};
  doc.fabPreset={id:"test-fab"};
  try{const v=S.profileValues(doc,"p","Top");close(v.minWidth,.12,1e-9,"preset limits after doc.fabPreset changes");assert.equal(v.limits.source,"test-fab");}
  finally{delete globalThis.AtriumFabPresets;}
}
// Revision counter: derived values (profile table, delay, signature) are cached per stack
// revision, not per JSON text. apply() and touch() bump it, a replaced doc.stackup is a new
// revision, and undo/redo of an in-place stack edit (undo-store.js) bumps it too.
{
  const doc=board(),defs=new Map(),st=S.preset(4);delete st.derived;
  st.impedanceProfiles=[{id:"z50",name:"Z50",type:"single",target:50,tolerance:10,layers:{Top:{enabled:true}}}];
  doc.stackup=JSON.parse(JSON.stringify(st));
  const r0=S.revision(doc),sig0=S.signature(doc),v0=S.profileValues(doc,"z50","Top",defs),d0=S.delay(doc,"Top",.15,defs);
  assert.ok(r0>0);assert.equal(S.revision(doc),r0,"stable while nothing changes");assert.equal(S.signature(doc),sig0);
  assert.equal(S.profileValues(doc,"z50","Top",defs),v0,"cached: the same object");
  assert.equal(S.revision(board()),0,"no stored stack: revision 0");assert.equal(S.signature(board()),"derived");
  // In place, announced with touch(): every cache misses.
  const pre=()=>doc.stackup.layers.find(l=>l.type==="Dielectric");
  pre().thickness*=1.5;
  const r1=S.touch(doc);assert.ok(r1>r0);assert.notEqual(S.signature(doc),sig0);
  const v1=S.profileValues(doc,"z50","Top",defs),d1=S.delay(doc,"Top",.15,defs);
  assert.notEqual(v1,v0);assert.ok(v1.width>v0.width+1e-3,"a thicker prepreg widens the 50 Ω track");assert.notEqual(d1,d0,"delay follows the edit");
  // A replaced stack object (import, Open, collaborator) is a new revision without a call.
  doc.stackup=JSON.parse(JSON.stringify(st));
  assert.ok(S.revision(doc)>r1);close(S.profileValues(doc,"z50","Top",defs).width,v0.width,1e-9);
  // apply() bumps the revision.
  const before=S.revision(doc),layers=sources(S.stored(doc));
  layers.find(l=>l.type==="Dielectric").thickness*=1.5;
  const plan=S.plan(doc,defs,layers);assert.equal(plan.ok,true,plan.problems?.join(" "));S.apply(doc,defs,plan);
  assert.ok(S.revision(doc)>before);close(S.profileValues(doc,"z50","Top",defs).width,v1.width,1e-9);
  // Undo and redo patch the stack in place (identity kept); the undo store bumps the revision.
  const U=AtriumUndoStore;U.reset();
  const project=A.project("Rev");project.documents.push(doc);
  const history=[],future=[],stackObj=doc.stackup;
  const mark=()=>U.mark(project,{current:doc.id});
  let m=mark();pre().thickness/=1.5;S.touch(doc);U.checkpoint(history,future,m,"thinner");U.touch(project);
  const thin=S.profileValues(doc,"z50","Top",defs).width;close(thin,v0.width,1e-9);
  U.jump(history,future,mark(),-1);
  assert.equal(doc.stackup,stackObj,"undo patched the stack in place");
  close(S.profileValues(doc,"z50","Top",defs).width,v1.width,1e-9,"undo invalidates the cache");
  U.jump(history,future,mark(),1);
  close(S.profileValues(doc,"z50","Top",defs).width,thin,1e-9,"redo invalidates the cache");
  // An edit recorded by the store's sync (no explicit touch) is seen once the store records it.
  pre().thickness*=1.5;U.record(project);
  close(S.profileValues(doc,"z50","Top",defs).width,v1.width,1e-9,"recorded in-place edit");
  U.reset();
}
// A derived stack follows the journal: a board without inner layers stays two layers while edits
// use none, and grows (then shrinks) as soon as an edit uses one.
{
  require("../../app/history/undo-store.js");
  const U=AtriumUndoStore,project=A.project("Derived"),doc=board();project.documents.push(doc);
  const t={id:"t",kind:"track",layer:"Top",width:.2,points:[[0,0],[1,0]]};doc.items.push(t,{id:"v",kind:"via",x:2,y:2,layer:"Multi"});
  U.reset();U.record(project);
  const copper=()=>S.copperLayers(doc,new Map()).length,edit=fn=>{fn();U.record(project);};
  assert.equal(copper(),2);
  edit(()=>{t.points[1][0]=3;});assert.equal(copper(),2,"an edit on Top keeps two layers");
  edit(()=>{t.layer="Inner 2";});assert.equal(copper(),4,"an edit onto Inner 2 derives four layers");
  edit(()=>{t.layer="Bottom";});assert.equal(copper(),2,"moving it back derives two again");
  edit(()=>{doc.items.push({id:"n",kind:"track",layer:"Inner 1",width:.2,points:[[0,1],[1,1]]});});assert.equal(copper(),3,"an added inner track");
  U.reset();
}
console.log("PASS layer stack defaults and presets; add, move and blocked or moved removal; drill pairs; X2 layer facts; KiCad stackup; Altium import; IPC-2141 impedance; solver policy; revision-keyed caches; derived stacks follow the journal.");
