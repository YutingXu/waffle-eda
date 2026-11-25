"use strict";
// Altium saves editable region outlines and the last tessellation in parallel streams.
// Exercise the binary reader, footprint transforms, pour solver, film and ASCII re-import.
const assert = require("node:assert/strict"), fs = require("node:fs"), path = require("node:path");
globalThis.CFB = require("../../app/vendor/cfb.min.js");
for (const name of ["model","board-shape","board-shape-sources","altium-ids","pcb-pours","pcb-import","io","pcb-appearance","spatial","stackup",
  "polygon-pour","pcb-draw","pcb-text","rules","zip","fab-outputs","altium-export","ipc2581"]) require(require("../support/app-source-paths.cjs").appFile(name+".js"));
const A=Atrium, B=AtriumBoardShape, U=.00000254, none=65535;
const rect=(x,y,w,h)=>[[x,y],[x+w,y],[x+w,y+h],[x,y+h]];
const tick=x=>Math.round(x/U);
function props(text) {
  const v=Buffer.from("|"+text+"\0","latin1"), n=Buffer.alloc(4);
  n.writeUInt32LE(v.length);return Buffer.concat([n,v]);
}
function vertices(points) {
  const b=Buffer.alloc(4+16*points.length);b.writeUInt32LE(points.length);
  points.forEach(([x,y],i)=>{b.writeDoubleLE(tick(x),4+16*i);b.writeDoubleLE(tick(y),12+16*i);});
  return b;
}
function raw(outer,holes=[],{shape=false,arc,layer=1,kind=0,cut=false,keep=false,scope,resolution,cavity,owner=none,polygon=none,net=none}={}) {
  const h=Buffer.alloc(18);h[0]=layer;h[2]=keep?2:0;h.writeUInt16LE(net,3);h.writeUInt16LE(polygon,5);h.writeUInt16LE(owner,7);h.writeUInt16LE(holes.length,14);
  let edge=vertices(outer);
  if(shape){
    edge=Buffer.alloc(4+37*(outer.length+1));edge.writeUInt32LE(outer.length);
    [...outer,outer[0]].forEach(([x,y],j)=>{
      const k=4+37*j;edge.writeInt32LE(tick(x),k+1);edge.writeInt32LE(tick(y),k+5);
      if(arc&&j===0){edge[k]=1;edge.writeInt32LE(tick(arc.x),k+9);edge.writeInt32LE(tick(arc.y),k+13);
        edge.writeInt32LE(tick(arc.r),k+17);edge.writeDoubleLE(arc.sa,k+21);edge.writeDoubleLE(arc.ea,k+29);}
    });
  }
  const p=["V7_LAYER="+layer,"KIND="+kind,"ISSHAPEBASED="+(arc?"TRUE":"FALSE"),"SUBPOLYINDEX="+(polygon===none?-1:0)];
  if(cut)p.push("ISBOARDCUTOUT=TRUE");if(scope!=null)p.push("KEEPOUTRESTRICTIONS="+scope);
  if(resolution!=null)p.push("ARCRESOLUTION="+resolution);
  if(cavity!=null)p.push("CAVITYHEIGHT="+cavity);
  const data=Buffer.concat([h,props(p.join("|")),edge,...holes.map(vertices)]),head=Buffer.alloc(5);
  head[0]=11;head.writeUInt32LE(data.length,1);return Buffer.concat([head,data]);
}
const boardFields="VX0=0mm|VY0=0mm|VX1=30mm|VY1=0mm|VX2=30mm|VY2=30mm|VX3=0mm|VY3=30mm";
function read(flat,shape,extra=[]) {
  const streams=new Map([["board6/data",props(boardFields)],["nets6/data",props("NAME=GND")],
    ["components6/data",props("SOURCEDESIGNATOR=U1|PATTERN=Test|X=6mm|Y=6mm|LAYER=TOP|ROTATION=90")],...extra]);
  if(flat.length)streams.set("regions6/data",Buffer.concat(flat));
  if(shape.length)streams.set("shapebasedregions6/data",Buffer.concat(shape));
  return AtriumPCB.read("Regions.PcbDoc",streams,null);
}
function project(input) {const p=A.project("Regions",input.library);p.documents=input.documents;return p;}
function ascii(p) {const out=AtriumAltiumExport.exportBoard(p,p.documents[0]);return {out,back:project(AtriumIO.read("Regions.PcbDoc",out.bytes))};}

{
  // Synthetic source records using the independently documented binary
  // primitive layouts. Geometry and names are authored here.
  const formats = {arcs: [1, 56], tracks: [4, 45], fills: [6, 46]};
  function keepout(family, mask, layer = 1, flagged = true) {
    const [type, offset] = formats[family], legacy = mask === undefined;
    const data = Buffer.alloc(legacy ? offset : offset + 4);
    data[0] = layer;
    data[1] = 4;
    data[2] = flagged ? 2 : 0;
    for (const field of [3, 5, 7]) data.writeUInt16LE(none, field);
    data.writeInt32LE(tick(6), 13);
    data.writeInt32LE(tick(6), 17);
    if (type === 1) {
      data.writeInt32LE(tick(2), 21);
      data.writeDoubleLE(180, 33);
      data.writeInt32LE(tick(.2), 41);
    } else {
      data.writeInt32LE(tick(10), 21);
      data.writeInt32LE(tick(10), 25);
      if (type === 4) data.writeInt32LE(tick(.2), 29);
    }
    data.writeUInt32LE(layer === 56 ? 0x0103000d : 0x01000001, offset - 4);
    if (!legacy) data[offset] = mask;
    const header = Buffer.alloc(5);
    header[0] = type;
    header.writeUInt32LE(data.length, 1);
    return Buffer.concat([header, data]);
  }
  const board = (family, mask, layer, modern = true, active = true) => project(read([], [],
    [[family + (modern ? "6": "") + "/data", keepout(family, mask, layer, active)]]));
  const area = p => p.documents[0].items.find(i => i.keepout || i.layer === "Keepout");
  for (const family of Object.keys(formats)) {
    for (const mask of [0x10, 0x1f, 0]) {
      const p = board(family, mask);
      assert.equal(area(p).keepoutRestrictions, mask, family + " preserves the V7 restriction byte");
      assert.equal(area(ascii(p).back).keepoutRestrictions, mask, family + " preserves the restriction via ASCII export");
    }
    assert.equal(area(board(family, undefined)).keepoutRestrictions, undefined, family + " without a restriction byte");
    assert.equal(area(board(family, 0x90)).keepoutRestrictions, undefined, family + " with an unknown bit");
    assert.equal(area(board(family, 0x10, 1, false)).keepoutRestrictions, undefined, family + " in an unversioned stream");
    assert.equal(area(board(family, 0x10, 33)).keepoutRestrictions, undefined, family + " on a non-signal layer");
    assert.equal(area(board(family, 0, 56)).keepoutRestrictions, undefined, family + " on the dedicated Keep-Out layer");
    assert.equal(area(board(family, 0x10, 1, true, false)), undefined, family + " ordinary copper");
  }
  for (const m of ["sha256", "source-file", "sexpr", "format-2-codec", "format-2-units", "format-2-values", "format-2-model"])
    require(require("../support/app-source-paths.cjs").appFile(m + ".js"));
  const C = AtriumFormat2, M = AtriumFormat2Model, R = AtriumRules;
  function restore(input) {
    const native = M.fromEditor(input);
    const {project: reopened, members} = M.manifest(M.parse(C.serialize(native.manifest)));
    for (const {path, file} of native.files) {
      const ref = members.find(m => m.path === path);
      if (ref?.kind === "pcb") reopened.documents.push(M.document(M.parse(C.serialize(file)), {name: ref.name}));
    }
    return reopened;
  }
  const track = {id:"track", kind:"track", layer:"Top", net:"SIG", points:[[5,-8], [11,-8]], width:.2};
  const through = {id:"through", kind:"pad", layer:"Multi", net:"SIG", number:"1", x:8, y:-8, drill:.3, w:.7, h:.7, shape:"round"};
  const smd = {...through, id:"smd", layer:"Top", drill:0};
  function forbidden(p, item) {
    const d = p.documents[0], doc = {...d, items: [...d.items, item]};
    return R.drc(doc, new Map(), R.create(), {types:["clearance"], project:p}).violations
      .filter(i => i.what === "Keep-out").map(i => i.id);
  }
  const p = board("fills", 0x10), reopened = restore(p);
  for (const subject of [p, reopened, ascii(reopened).back]) {
    assert.equal(area(subject).keepoutRestrictions, 0x10);
    assert.deepEqual(forbidden(subject, track), []);
    assert.deepEqual(forbidden(subject, through), ["through"]);
    assert.deepEqual(forbidden(subject, smd), []);
  }
  for (const fallback of [0x1f, undefined, 0x90]) {
    const p = board("fills", fallback);
    assert.deepEqual(forbidden(p, track), ["track"]);
    assert.deepEqual(forbidden(p, through), ["through"]);
  }
}

const curved=[[8,4],[8,12],[4,12],[4,4]],arc={x:8,y:8,r:4,sa:270,ea:90},hole=rect(6,7,1,1);
{
  const opts={arc,cut:true,keep:true,layer:74,resolution:"0.5mil"};
  for(const reverse of [false,true]){
    const points=reverse?[curved[1],curved[0],curved[3],curved[2]]:curved;
    const [start,...rest]=points;
    const onArc=degrees=>[arc.x+arc.r*Math.cos(A.rad(degrees)),arc.y+arc.r*Math.sin(A.rad(degrees))];
    const samples=(reverse?[45,0,315]:[315,0,45]).map(onArc);
    const flat=[[start[0]+2*U,start[1]],...samples,...rest];
    const shape=raw(points,[],{...opts,shape:true});
    const boardSource=read([raw(flat,[],opts)],[shape]);
    const board=B.fresh(boardSource.documents[0]);
    assert.equal(board.cutouts.length,1,"Native anchors with two ticks of rounding represent one cutout");
    assert.equal(board.cutouts[0].filter(segment=>segment.kind==="arc").length,1,"Keep the directed authored arc");
    assert.ok(boardSource.notes.some(s=>s.startsWith("1 paired region")));
    const requireBoth=(vertices,settings,message)=>{
      const other=read([raw(vertices,[],settings)],[shape]);
      assert.equal(B.fresh(other.documents[0]).cutouts.length,2,message);
    };
    requireBoth([flat[0],...samples.slice().reverse(),...rest],opts,"The same arc points in a different sweep order remain a separate path");
    requireBoth([flat[0],...samples.map(([x,y])=>[2*arc.x-x,y]),...rest],opts,"The complementary arc remains a separate path");
    requireBoth([flat[0],...samples.map(([x,y])=>[x+.020,y]),...rest],opts,"A distinct curve beyond the stated facet resolution remains a separate path");
    requireBoth(flat,{...opts,scope:2},"Different source purpose flags prevent merging");
    requireBoth(flat,{...opts,cavity:"0.1mm"},"An extra cavity depth property prevents merging");
  }
}
{
  // Stored silkscreen polygon faces are editable artwork. Flattened and
  // authored twins make one face, and a shelved owner contributes nothing.
  const outline=rect(2,3,9,8), opening=rect(4,5,1,1);
  const mark=props("POLYGONTYPE=Polygon|LAYER=TOPOVERLAY|HATCHSTYLE=Solid|SHELVED=FALSE|"+boardFields);
  const hidden=props("POLYGONTYPE=Polygon|LAYER=BOTTOMOVERLAY|HATCHSTYLE=Solid|SHELVED=TRUE|"+boardFields);
  const p=project(read([raw(outline,[opening],{polygon:0,layer:33}),raw(outline,[],{polygon:1,layer:34})],
    [raw(outline,[opening],{polygon:0,layer:33,shape:true})],[["polygons6/data",Buffer.concat([mark,hidden])]]));
  const d=p.documents[0], art=d.items.filter(item=>item.kind==="graphic");
  assert.equal(art.length,1);
  assert.equal(art[0].layer,"Silk");
  assert.equal(art[0].regionShape.cutouts.length,1);
  assert.equal(d.pcbDrawing.pours,undefined);
  const fab=AtriumFabOutputs.analyse(p,d.id);
  const [face]=fab.layers.get("Silk").filter(f=>f.t==="region");
  assert.equal(face.holes.length,1);
}
{
  // Native ASCII uses explicit owner IDs and different coordinate fields for
  // authored edges and tessellated islands. An island can precede its owner.
  const header=["RECORD=Board|"+boardFields,"RECORD=Net|ID=7|NAME=Ground"];
  const top="RECORD=Polygon|ID=17|INDEXFORSAVE=17|NET=7|LAYER=TOP|NAME=71|POURINDEX=6|HATCHSTYLE=Solid|POUROVER=FALSE|POUROVERSTYLE=2|GRIDSIZE=20mil|TRACKWIDTH=8mil|"+
    "VX0=10mm|VY0=4mm|KIND0=1|CX0=10mm|CY0=8mm|SA0=270|EA0=90|R0=4mm|VX1=10mm|VY1=12mm|VX2=4mm|VY2=12mm|VX3=4mm|VY3=4mm|VX4=10mm|VY4=4mm";
  const bottom="RECORD=Polygon|ID=3|INDEXFORSAVE=3|NET=7|LAYER=BOTTOM|NAME=66|POURINDEX=1|HATCHSTYLE=Solid|"+boardFields;
  const outer=[[2100000.125,2100000.25],[3000000,2100000.25],[3000000,3200000],[2100000.125,3200000]];
  const hole=[[2300000.25,2200000],[2400000,2200000],[2300000.25,2400000]];
  const fields=(p,v)=>v.map(([x,y],j)=>p+"VX"+j+"="+x+"|"+p+"VY"+j+"="+y).join("|");
  const island=(id,side,sub)=>"RECORD=Region|KIND=0|LAYER="+side+"|POLYGON="+id+"|SUBPOLYINDEX="+sub+
    "|MAINCONTOURVERTEXCOUNT=4|"+fields("M",outer)+"|HOLECOUNT=1|HOLE0VERTEXCOUNT=3|"+fields("H0",hole);
  const topIsland=island(17,"TOP",9),bottomIsland=island(3,"BOTTOM",8);
  const free="RECORD=Region|LAYER=TOPOVERLAY|KIND=0|ISSHAPEBASED=TRUE|MAINCONTOURVERTEXCOUNT=4|"+boardFields+"|HOLECOUNT=1|HOLE0VERTEXCOUNT=3|"+fields("H0",hole);
  const legacy="RECORD=Region|LAYER=BOTTOMOVERLAY|KIND=0|"+boardFields+"|HOLECOUNT=1|HOLE0COUNT=3|HOLE0VX0=2mm|HOLE0VY0=2mm|HOLE0VX1=4mm|HOLE0VY1=2mm|HOLE0VX2=2mm|HOLE0VY2=4mm";
  const parse=rows=>project(AtriumPCB.read("Exchange.PcbDoc",null,[...header,...rows].join("\r\n")));
  const p=parse([topIsland,bottom,free,bottomIsland,legacy,top,island(42,"TOP",1)]);
  const d=p.documents[0],clean=JSON.stringify(d),zones=d.items.filter(i=>i.kind==="polygon");
  assert.deepEqual(zones.map(i=>[i.name,i.layer,i.net,i.pourIndex]),[["B","Bottom","Ground",1],["G","Top","Ground",6]]);
  const G=zones[1],get=(board,name)=>board.pcbDrawing?.pours?.find(r=>r.polygon===board.items.find(i=>i.kind==="polygon"&&i.name===name).id);
  assert.equal(get(d,"G").subPolygonIndex,9);
  assert.deepEqual(AtriumPCBPours.nativeContours(get(d,"G")),[outer,hole],"fractional native ticks survive exactly");
  assert.equal(d.items.filter(i=>i.kind==="graphic"&&i.regionShape?.cutouts?.length===1).length,2,"authored and prior Waffle hole names both decode");
  assert(d.notes.some(v=>v.includes("Omitted unsupported polygon-owned region")),"unresolved owner never becomes free artwork");
  const {out,back}=ascii(p),b=back.documents[0],again=b.items.find(i=>i.name==="G");
  assert.equal(out.counts.regions,4);assert.equal(JSON.stringify(d),clean,"export keeps the user's stored copper untouched");
  const flatRows=out.content.split("\r\n").filter(row=>row.includes("RECORD=Region|")&&row.includes("|MVX0="));
  assert.equal(flatRows.length,2);
  assert(flatRows.every(row=>!row.includes("|ISSHAPEBASED=")),"Designer reads the flat outer contour only when this key is absent");
  assert.equal(again.hatchWidth,.2032);assert.equal(again.hatchPitch,.508);
  assert.deepEqual(again.sourcePourOver,{style:2,sameNet:false});
  assert.equal(B.regionOf(again).contour.filter(g=>g.kind==="arc").length,1);
  assert.equal(B.regionOf(again).contour.length,4,"no artificial closing edge appears in the native curve");
  assert.deepEqual(get(b,"G").data,get(d,"G").data);
  G.pourOverSameNet=true;G.points=G.points.slice(0,-1);
  const edited=ascii(p).back.documents[0].items.find(i=>i.name==="G");
  assert.equal(edited.sourcePourOver,undefined);assert(!B.regionOf(edited),"editing the outline retires the source arc");
  const damaged=parse([top,bottom,topIsland,bottomIsland,island(17,"TOP",10).replace("MVY3=","TRUNCATED=")]).documents[0];
  assert.equal(get(damaged,"G"),undefined,"one truncated island invalidates its owner's complete copper");
  assert.equal(get(damaged,"B").subPolygonIndex,8,"another complete owner survives");
  // The rightmost hole vertex sits inside a straight wall by .01 native
  // tick. Rounding the hole to display nanometres would push it outside.
  const fineHole=[[6000,3000],[10000.99,5000],[6000,7000]];
  const fine="RECORD=Region|LAYER=TOPOVERLAY|KIND=0|ISSHAPEBASED=TRUE|MAINCONTOURVERTEXCOUNT=4|"+
    "VX0=0mil|VY0=0mil|VX1=1.0001mil|VY1=0mil|VX2=1.0001mil|VY2=1mil|VX3=0mil|VY3=1mil|HOLECOUNT=1|HOLE0VERTEXCOUNT=3|"+fields("H0",fineHole);
  const original=parse([fine]),micro=original.documents[0].items[0],returned=ascii(original).back.documents[0].items[0];
  assert.equal(micro.regionShape.cutouts.length,1);assert.deepEqual(returned.regionShape.cutouts,micro.regionShape.cutouts);
}
{
  const P=AtriumPolygonPour;
  const p=A.project("Edit"),d=p.documents.find(d=>d.kind==="pcb"),defs=new Map();
  d.outline=rect(0,-30,30,30);
  const filled=P.make(rect(2,-12,20,9),{id:"filled",name:"Poured",layer:"Top",net:"GND",removeDeadCopper:false});
  const empty=P.make(rect(1,-25,6,6),{id:"unpoured",name:"Unpoured",layer:"Bottom",net:"GND",removeDeadCopper:false});
  const t={id:"track",kind:"track",points:[[10,-11],[10,-6]],width:.4,layer:"Top",net:"SIG"};
  d.items=[filled,empty,t];P.apply(d,defs,{project:p,only:[filled.id]});
  const old=d.pcbDrawing.pours[0].data;t.points=t.points.map(([x,y])=>[x+4,y]);
  const prior=JSON.stringify(d),copy=A.clone(p),fresh=copy.documents.find(d=>d.kind==="pcb");
  P.apply(fresh,defs,{project:copy,only:[filled.id],reuse:false});
  const expected=fresh.pcbDrawing.pours.map(r=>r.data);
  assert.notEqual(expected[0],old,"moving the obstacle changes actual copper");
  const out=AtriumAltiumExport.exportBoard(p,d),back=AtriumIO.read("Edit.PcbDoc",out.bytes).documents[0];
  assert.equal(JSON.stringify(d),prior,"exporting a stale design cannot repour the working document");
  assert.deepEqual(back.pcbDrawing.pours.map(r=>r.data),expected);
  assert.deepEqual(back.pcbDrawing.pours.map(r=>back.items.find(i=>i.id===r.polygon).name),["Poured"]);
  assert.equal(back.items.filter(i=>i.kind==="polygon").length,2,"the unpoured outline remains editable");
  d.items=[filled,empty];delete d.pcbDrawing;filled.removeDeadCopper=true;
  P.apply(d,defs,{project:p,only:[filled.id]});
  assert.equal(d.pcbDrawing.pours?.length||0,0,"an evaluated dead island has no region rows");
  d.items.push({...t,net:"GND"});
  const exposed=AtriumAltiumExport.exportBoard(p,d);
  assert.equal(exposed.counts.regions,1,"a new anchor exposes copper in a previously evaluated empty pour");
}
{
  const read=()=>project(AtriumPCB.read("Hatch.PcbDoc",null,[
    "RECORD=Board|"+boardFields,"RECORD=Net|ID=7|NAME=GND",
    "RECORD=Track|POLYGON=21|LAYER=TOP|X1=1mm|Y1=3mm|X2=9mm|Y2=3mm|WIDTH=.2mm",
    "RECORD=Track|POLYGON=22|LAYER=TOP|X1=1mm|Y1=3mm|X2=9mm|Y2=3mm|WIDTH=.2mm",
    "RECORD=Polygon|ID=21|NET=7|LAYER=TOP|HATCHSTYLE=90Degree|REMOVEDEAD=FALSE|"+boardFields].join("\r\n")));
  const p=read(),d=p.documents[0],t=d.items.find(i=>i.kind==="track");
  assert.equal(t.net,"GND");assert.equal(d.items.filter(i=>i.kind==="track").length,1);
  assert.equal(ascii(p).out.counts.tracks,1,"an untouched native hatch remains a physical owned track");
  t.width+=.05;
  assert.equal(ascii(p).out.counts.tracks,0,"an edited hatch cannot emit an obsolete source stroke before first inspection");
  assert(d.items.includes(t),"verification keeps the original work-in-progress edit intact");
}
{
  const circle=[B.arc([0,0],5,0,0,true)],hole=B.polySegments(rect(0,0,1,1));
  const cut=B.cutInContours(circle,[hole]);
  assert(cut.some(g=>g.kind==="arc"&&Math.abs(B.sweep(g))===360),"a cut-in at a full circle's seam preserves the entire outer edge");
  assert(Math.abs(Math.abs(B.signedArea(cut))-(Math.PI*25-1))<1e-8);
}
{
  const opts={arc,layer:35,owner:0},poly=rect(14,12,4,5),ko=rect(19,4,3,3),ordinary=rect(3,22,3,3);
  const source=read([raw(curved,[hole],opts),raw(ordinary,[],{layer:57}),raw(poly,[],{kind:1,owner:0})],
    [raw(poly,[],{shape:true,kind:1,owner:0}),raw(curved,[hole],{...opts,shape:true}),raw(ko,[],{shape:true,keep:true,scope:2,layer:32}),
      raw(ordinary,[],{shape:true,layer:57}),raw(curved,[hole],{shape:true,layer:74,arc,cut:true})]);
  assert(source.notes.some(s=>s.startsWith("3 paired region")));
  const p=project(source),d=p.documents[0],fp=p.library[0].footprint,part=d.items.find(i=>i.kind==="part");
  assert.equal(fp.shapes.length,2);assert.equal(d.items.filter(i=>i.kind==="graphic").length,2);
  const paste=fp.shapes.find(s=>s.layer==="Top paste"),cut=fp.shapes.find(s=>s.cutout);
  assert.equal(paste.regionShape.contour.filter(s=>s.kind==="arc").length,1);assert.equal(paste.regionShape.cutouts.length,1);
  assert.equal(B.regionOf(paste),paste.regionShape);assert.equal(cut.layer,"Top");assert.equal(cut.fill,false);
  const keep=d.items.find(i=>i.keepout);assert.equal(keep.layer,"Bottom");assert.equal(keep.keepoutRestrictions,2);
  assert(A.keepoutBlocks(keep,"track"));assert(!A.keepoutBlocks(keep,"via"));
  const board=B.fresh(d);assert.equal(board.cutouts.length,1);assert.equal(B.profileContours(board).length,3);
  assert(!B.contains(board,[10,-8]));assert(B.contains(board,[6.5,-7.5]));assert(B.contains(board,[17,-20]));
  const saved=JSON.parse(JSON.stringify(p));A.validate(saved);
  assert.equal(B.profileContours(B.fresh(saved.documents[0])).length,3);
  const shifted=B.translate(board,1,1);
  assert.equal(B.profileContours(shifted).length,3);assert(B.contains(shifted,[7.5,-6.5]));
  const {out,back}=ascii(p);assert.equal(out.counts.regions,5);assert.equal(out.counts.tracks,0);
  const bp=back.library[0].footprint.shapes,bpPaste=bp.find(s=>s.layer==="Top paste");
  assert.equal(bpPaste.regionShape.contour.filter(s=>s.kind==="arc").length,1);assert.equal(bpPaste.regionShape.cutouts.length,1);
  assert.equal(bp.filter(s=>s.cutout).length,1);assert.equal(back.documents[0].items.find(i=>i.keepout).keepoutRestrictions,2);
  assert.equal(B.profileContours(B.fresh(back.documents[0])).length,3);
  for(const item of [bpPaste,paste]){
    const exact=B.placeContour(item.regionShape.contour,p=>A.world(p,part),part.angle),g=exact.find(s=>s.kind==="arc");
    assert(Math.hypot(g.c[0]-arc.x,g.c[1]+arc.y)<.00003);
  }
  const fab=AtriumFabOutputs.build(p,d),film=ext=>fab.files.find(f=>f.name.endsWith("."+ext))?.content;
  assert(/G36\*[\s\S]*?G0[23]X[\s\S]*?G37\*/.test(film("GTP")),"region keeps a Gerber circular edge and its hole");
  assert(!fab.model.layers.get("Top").some(f=>f.t==="region"),"polygon cutout adds no conductor");
  assert(!fab.model.layers.get("Bottom").some(f=>f.t==="region"),"keepout adds no conductor");
  assert((film("GM1").match(/D02\*/g)||[]).length===3,"profile mills three separate closed paths without a cut-in");
  const ipc=AtriumIPC2581.build(p,d).content;
  assert(/<Contour><Polygon>[\s\S]*?<PolyStepCurve[\s\S]*?<Cutout>/.test(ipc));
  const defs=new Map(p.library.map(x=>[x.id,x]));
  const zone=AtriumPolygonPour.make(rect(13,-18,14,10),{layer:"Top",net:"GND",removeDeadCopper:false,clearance:0});
  const poured=AtriumPolygonPour.pour({...d,items:[part,zone]},defs,zone);
  function hasCopper(q){return poured.some(r=>{const rings=AtriumPCBPours.contours(r).map(a=>Array.from({length:a.length/2},(_,j)=>[a[2*j],a[2*j+1]]));return B.polyContains(rings[0],q)&&!rings.slice(1).some(h=>B.polyContains(h,q));});}
  assert(hasCopper([20,-14]));assert(!hasCopper([16,-14]),"footprint polygon cutout removes only its own area on its copper layer");
}
{
  const a=rect(3,3,5,5),b=rect(3,3,6,4);
  const x=read([raw(a)],[raw(b,[],{shape:true})]);assert.equal(x.documents[0].items.filter(i=>i.kind==="graphic").length,2,"distinct shapes sharing an anchor survive");
  const only=read([],[raw(a,[rect(4,4,1,1)],{shape:true,polygon:0})],[["polygons6/data",props(boardFields+"|LAYER=TOP|HATCHSTYLE=Solid|POLYGONTYPE=Polygon|NET=0")]]);
  const stored=only.documents[0].pcbDrawing.pours;assert.equal(stored.length,1);assert.equal(stored[0].count,2);
  const island=raw(a,[],{shape:true,polygon:0});
  const partial=read([],[island,island.subarray(0,island.length-1)],[["polygons6/data",props(boardFields+"|LAYER=TOP|HATCHSTYLE=Solid|POLYGONTYPE=Polygon|NET=0")]]);
  assert(!partial.documents[0].pcbDrawing?.pours?.length,"a truncated shape-only stream cannot certify partial copper as a complete source pour");
  const masks=read([raw(a,[],{keep:true,scope:1})],[raw(a,[],{shape:true,keep:true,scope:2})]).documents[0].items.filter(i=>i.keepout);
  assert.deepEqual(masks.map(i=>i.keepoutRestrictions),[1,2],"coincident regions with different object restrictions remain distinct");
  const malformed=raw(a,[],{shape:true});malformed[malformed.length-37+1]^=1;
  assert(read([],[malformed]).notes.some(s=>s.includes("Unclosed shape-based region")));
}
{
  const a=rect(14,14,4,4),p=project(read([],[raw(a,[],{shape:true,keep:true,scope:2,layer:1,owner:0})]));
  const d=p.documents[0],defs=new Map(p.library.map(x=>[x.id,x]));
  d.items.push({id:"top",kind:"track",points:[[15,-15],[16,-16]],width:.15,layer:"Top",net:"A"},
    {id:"bottom",kind:"track",points:[[15,-15],[16,-16]],width:.15,layer:"Bottom",net:"A"},
    {id:"via",kind:"via",x:15.5,y:-15.5,diameter:.5,drill:.25,layer:"Multi",net:"A"});
  assert.deepEqual(AtriumPCBDraw.keepoutViolations(d,defs).map(v=>v.id),["top"],"component keepout restricts tracks on Top and permits vias and Bottom tracks");
  const poly=AtriumPolygonPour.make(rect(12,-20,8,8),{layer:"Top",net:"GND",removeDeadCopper:false});
  const pdoc={...d,items:[d.items[0],poly]},rs=AtriumPolygonPour.pour(pdoc,defs,poly);
  const inside=rs.some(r=>AtriumPCBPours.contours(r).every((xy,j)=>{
    const ring=Array.from({length:xy.length/2},(_,k)=>[xy[2*k],xy[2*k+1]]);
    return B.polyContains(ring,[15,-15])===(j===0);
  }));
  assert(inside,"a track-only keepout permits polygon copper");
}
{
  const name="PiDP11IOExpander.PcbDoc",file=path.join(__dirname,"../fixtures/altium/pidp11-io-expander",name);
  const p=project(AtriumIO.read(name,new Uint8Array(fs.readFileSync(file)))),d=p.documents[0];
  const source=d.items.filter(i=>i.sourceRecord?.startsWith("regions6/"));assert.equal(source.length,19);
  const {out,back}=ascii(p),copy=back.documents[0];assert.equal(out.counts.regions,24);
  const archived=doc=>(doc.pcbDrawing?.pours||[]).map(r=>[doc.items.find(i=>i.id===r.polygon)?.name,r.layer,r.net,r.subPolygonIndex,r.count,r.data]);
  assert.deepEqual(archived(copy),archived(d),"five native polygon-owned islands retain their full coordinate bytes, 45 holes and two owner names");
  assert.equal(copy.items.filter(i=>i.kind==="graphic"&&i.fill&&i.width===0).length,19);
  assert.equal(back.documents[0].items.filter(i=>i.regionShape?.cutouts.length).length,source.filter(i=>i.regionShape?.cutouts.length).length);
}
{
  // PcbLib/Data begins with the footprint's byte-counted name, followed by primitive frames.
  const name=Buffer.from([4,84,101,115,116]),length=Buffer.alloc(4);length.writeUInt32LE(name.length);
  const flat=raw(rect(0,0,3,3),[],{layer:35}),shape=raw(curved,[hole],{shape:true,arc,keep:true,scope:1});
  const fp=AtriumPCB.read("Regions.PcbLib",new Map([["test/parameters",props("PATTERN=Test")],
    ["test/data",Buffer.concat([length,name,flat,shape])]]),null).library[0].footprint;
  assert.equal(fp.shapes.length,2);assert.equal(fp.shapes[0].layer,"Top paste");
  assert(fp.shapes[1].keepout);assert.equal(fp.shapes[1].keepoutRestrictions,1);
  assert.equal(fp.shapes[1].regionShape.contour.filter(g=>g.kind==="arc").length,1);
}
// Dense printed boards batch ordinary footprint paths. A polygon cutout is an editor
// guide, so it must not change the strokes printed for the footprint around it.
{
  for(const name of ["path-record","vectorize","pcb-text-rich","canvas","pdf","print"])require(require("../support/app-source-paths.cjs").appFile(name+".js"));
  const graphics=raw(rect(3,3,4,3),[],{layer:33,owner:0}),cut=raw(rect(4,4,1,1),[],{kind:1,owner:0,shape:true});
  const p=project(read([graphics],[cut])),d=p.documents[0];
  for(let n=0;n<1501;n++){
    const x=2+(n%46)*.5,y=-2-Math.floor(n/46)*.5;
    d.items.push({id:"r"+n,kind:"track",points:[[x,y],[x+.15,y]],width:.1,layer:"Top"});
  }
  const pdf=()=>AtriumPrint.build(p,{date:new Date(Date.UTC(2025,0,1)),documents:[d.id],layerSets:["composite"],footer:false}).pages[0].list;
  const withGuide=pdf(),fp=p.library[0].footprint;
  assert(fp.shapes.some(s=>s.cutout));fp.shapes=fp.shapes.filter(s=>!s.cutout);
  assert(JSON.stringify(withGuide)===JSON.stringify(pdf()),"adding an editor cutout leaves printed assembly strokes identical");
}
console.log("PASS binary and ASCII regions, source twins, curved manufacturing artwork, scoped keepouts and footprint polygon cutouts.");
