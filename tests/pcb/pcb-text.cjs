"use strict";
// PCB text: stroke fonts, layout metrics, justification, mirroring, TrueType
// glyph caching, knockout, barcodes (Code 39, Code 128, QR), Gerber
// primitives that match fab-outputs, KiCad mapping and validation.
const assert=require("node:assert/strict");
for(const m of ["model","parts","pcb-pours","pcb-appearance","zip","vectorize","pcb-text-rich","pcb-text","fab-outputs"])require(require("../support/app-source-paths.cjs").appFile(m+".js"));
const A=Atrium,T=AtriumPCBText,R=AtriumPCBTextRich,F=AtriumFabOutputs,V=AtriumVectorize;
const now=()=>typeof performance!=="undefined"?performance.now():Date.now();
const close=(a,b,e=1e-9,m="")=>assert.ok(Math.abs(a-b)<=e,m+" "+a+" vs "+b);
const pts=l=>l.strokes.flatMap(s=>s.points);
const ys=l=>pts(l).map(p=>p[1]),xs=l=>pts(l).map(p=>p[0]);

// ---- PCB Text and fabrication reuse the same decoded ASCII glyphs -----------
for(const [ch,g] of F.glyphs)assert.equal(T.glyph(ch,"default"),g,"glyph "+JSON.stringify(ch));
assert.ok(T.glyphs.has("Ω")&&!F.glyphs.has("Ω"));
for(let c=32;c<127;c++)assert.ok(T.supported(String.fromCharCode(c)),"ASCII "+c);
for(const ch of "Ωµμ±°×²³¹÷≤≥≈≠∞√€£©®™·πΔλΦφθαβστ←→↑↓↔ØøÅÄÖÜÉéèêëñçüöäßåŠš…–—½¼¾§¶")if(ch!=="ß")assert.ok(T.supported(ch),"unicode "+ch);
assert.equal(T.supported("漢"),false);
// Accents are composed above the base glyph, lower over lowercase.
{
  const E=T.glyph("É","default"),e=T.glyph("é","default");
  assert.ok(E.length===T.glyph("E","default").length+1&&Math.max(...E.at(-1).map(p=>p[1]))>6);
  assert.ok(Math.max(...e.at(-1).map(p=>p[1]))<6&&Math.min(...e.at(-1).map(p=>p[1]))>4);
}
// Sans Serif rounds chamfers, Serif adds serifs; metrics are shared.
{
  const O=T.glyph("O","sans"),I=T.glyph("I","serif"),H=T.glyph("H","serif");
  assert.ok(O[0].length>T.glyph("O","default")[0].length,"sans O is rounder");
  assert.deepEqual(T.glyph("L","sans"),T.glyph("L","default"),"sharp corners stay");
  assert.ok(H.length>T.glyph("H","default").length,"serif H");
  assert.ok(I.length>=3);
  const a=T.layout("ABC",{height:2,strokeFont:"serif"}),b=T.layout("ABC",{height:2});
  assert.deepEqual(a.metrics,b.metrics);
}

// ---- strokeText is identical to fab-outputs ----------------------------------
for(const [text,at,angle,size,align,mirror] of [["R12",[10,20],0,1,"left",false],["U1 +5V",[3.3,-7.1],90,.68,"center",true],
  ["Hello, PCB!",[-5,5],33.5,1.27,"right",false],["x",[0,0],270,2,"left",true],["",[0,0],0,1,"left",false]]){
  const a=F.strokeText(text,at,angle,size,align,mirror),b=T.strokeText(text,at,angle,size,align,mirror);
  assert.deepEqual(b.strokes,a.strokes,"strokeText "+text);assert.equal(b.unsupported,a.unsupported);
}

// ---- Layout metrics: height, justification, line spacing, mirror ---------------
{
  const h=2.5,l=T.layout("HI",{height:h});
  close(Math.min(...ys(l)),-h,1e-12,"cap top");close(Math.max(...ys(l)),0,1e-12,"baseline");
  assert.deepEqual(l.metrics,[0,-h,T.textUnits(2)*h/6,0]);
  // Ink box includes half the stroke width.
  close(l.box[1],-h-l.width/2,1e-12);close(l.width,h/6,1e-12);
  const W=T.textUnits(2)*h/6;
  // [left edge, cap top + h]: top anchors put the cap top at 0, bottom anchors the baseline.
  const expect={"top-left":[0,h],"top-center":[-W/2,h],"top-right":[-W,h],"middle-left":[0,h/2],"center":[-W/2,h/2],
    "middle-right":[-W,h/2],"bottom-left":[0,0],"bottom-center":[-W/2,0],"bottom-right":[-W,0]};
  for(const j of T.JUSTIFY){
    const m=T.layout("HI",{height:h,justify:j}).metrics;
    close(m[0],expect[j][0],1e-12,j+" x");close(m[1],expect[j][1]-h,1e-12,j+" top");
  }
  // Legacy align still works and matches bottom-center.
  assert.deepEqual(T.layout("HI",{height:h,align:"center"}).strokes,T.layout("HI",{height:h,justify:"bottom-center"}).strokes);
  // Multiline: pitch = lineSpacing x height, lines aligned individually.
  const m=T.layout("AB\nC",{height:1,lineSpacing:2,justify:"top-right"});
  assert.equal(m.lines,2);close(m.metrics[1],0,1e-12);close(m.metrics[3],1+2,1e-12,"two lines");
  close(Math.max(...xs(m)),0,1e-12,"right aligned");
  const def=T.layout("A\nB",{height:1}).metrics;close(def[3]-def[1],1+5/3,1e-12,"default pitch 5/3");
  // Mirror flips about the anchor; bottom layers mirror automatically.
  const plain=T.layout("R1",{height:1}),mir=T.layout("R1",{height:1,mirrored:true});
  assert.deepEqual(pts(mir),pts(plain).map(p=>[-p[0],p[1]]));
  assert.equal(T.props({text:"x",layer:"Bottom silk"}).mirrored,true);assert.equal(T.props({text:"x",layer:"Silk"}).mirrored,false);
  assert.equal(T.props({text:"x",layer:"Bottom silk",mirrored:false}).mirrored,false);
  // Italic slants stroke text to the right at the top.
  const it=T.layout("I",{height:6,italic:true}),up=it.strokes[1].points;
  assert.ok(up[1][0]>up[0][0]+1,"italic slant");
  // Unsupported characters plot as "?".
  assert.equal(T.layout("A漢B",{height:1}).unsupported,1);
}

// Independent Altium Default cells in nPM1100 config1, nRF5340 config2 and
// the nRF5340 DK. The first two also have released silk Gerbers on a 2.54 µm grid.
{
  for(const [value,size,width,rawW,rawH,printedWidth] of [
    ["R1",.499999,.1249934,.91643454,.74982324,.78994],["R1",.5499989,.12500102,.98309176,.79981806,.85852],
    ["R10",.599999,.12500102,1.74950882,.84980272]
  ]){
    const label={kind:"label",x:0,y:0,text:".PartLabel",size,width,layer:"Silk",
      sourceTextBox:{mode:"ink",text:".PartLabel",font:"stroke",strokeFont:"default",strokeWidth:width,size,width:rawW-width,height:rawH-width}};
    const project={parameters:{PartLabel:value}},view=T.projectItem(label,project),box=T.hitBox(view);
    close(box[2]-box[0],rawW-width,.00002,"independent source run width "+value);
    close(box[3]-box[1],rawH-width,.00002,"independent source run height "+value);
    if(printedWidth)close(box[2]-box[0],printedWidth,.00254,"released Gerber ink width "+value);
    assert.equal(label.text,".PartLabel");
    assert.strictEqual(T.projectItem(label,{parameters:{}}),label);
    project.parameters.PartLabel="R?÷";
    const fallback=T.projectItem(label,project);
    assert.deepEqual(T.layoutItem(fallback).strokes,T.layoutItem({...label,text:"R?÷"}).strokes,"unmeasured character retains the ordinary stroke layout");
  }
}

// ---- Gerber primitives match the fab-outputs stroke font -----------------------
{
  const label={id:"t",kind:"label",text:"C12 10uF",x:12.5,y:-3,angle:30,size:1.2,layer:"Silk"};
  const prim=T.toPrimitives(label);
  const ref=F.strokeText(label.text,[label.x,label.y],label.angle,label.size,"left",false);
  assert.deepEqual(prim.strokes.map(s=>s.points),ref.strokes);
  assert.ok(prim.strokes.every(s=>s.width===Math.max(.1,1.2/6)));
  // Footprint text: part frame and auto-mirror on the bottom overlay.
  const part={x:5,y:6,angle:90},shape={kind:"text",text:"REF",x:1,y:2,angle:0,size:.8,align:"center"};
  const fp=T.toPrimitives(shape,{frame:part,layer:"Bottom silk"});
  const fref=F.strokeText("REF",A.world([1,2],part),90,.8,"center",true);
  assert.deepEqual(fp.strokes.map(s=>s.points),fref.strokes);
  assert.equal(fp.regions.length,0);
}

// ---- Gerber output through fab-outputs ---------------------------------------
// A board with stroke, inverted, barcode and footprint text plots identically
// whether fab-outputs uses its own glyphs or AtriumPCBText.toPrimitives.
{
  const p=A.project("Text",AtriumParts.catalogue),pcb=p.documents.find(d=>d.kind==="pcb");
  pcb.outline=[[0,0],[40,0],[40,30],[0,30]];
  pcb.items.push({id:"l1",kind:"label",text:"ATRIUM v1.0",x:5,y:10,size:1.5,layer:"Silk"},
    {id:"l2",kind:"label",text:"BOTTOM",x:30,y:20,size:1,layer:"Bottom silk"});
  const model=F.analyse(p,pcb);
  const silk=model.layers.get("Silk").filter(f=>f.t==="stroke"),bot=model.layers.get("Bottom silk").filter(f=>f.t==="stroke");
  const want=T.toPrimitives(pcb.items[0]).strokes,wantBot=T.toPrimitives(pcb.items[1]).strokes;
  assert.deepEqual(silk.map(f=>f.points),want.map(s=>s.points));
  assert.deepEqual(bot.map(f=>f.points),wantBot.map(s=>s.points),"bottom text mirrored like fab");
  assert.ok(silk.every(f=>f.width===.25));
}

// ---- Placed project text preserves its authored film geometry through Undo/Redo.
{
  const {parseGerber}=require("../formats/gerber-compare.cjs");
  require("../../app/history/undo-store.js");
  const undo=AtriumUndoStore, history=[], future=[];
  const label={kind:"text",text:".Build",x:2,y:1,style:"silk",justify:"bottom-left",size:1.2,width:.2};
  const def={id:"label",footprint:{name:"Marking",pads:[],shapes:[label]}};
  const p=A.project("Marking",[def]), board=p.documents.find(d=>d.kind==="pcb");
  p.parameters={Build:"L"};
  board.outline=[[0,0],[60,0],[60,50],[0,50]];
  board.items=[
    {id:"face",kind:"part",ref:"U1",def:def.id,x:10,y:12,angle:0,layer:"Top",showRef:false},
    {id:"mirror",kind:"part",ref:"U2",def:def.id,x:42,y:28,angle:90,layer:"Bottom",showRef:false}
  ];
  const film = (project, ext) => F.build(project,board.id,{origin:"absolute",date:new Date(0)})
    .files.find(file=>file.name.endsWith("."+ext)).content;
  function verify(value) {
    assert.equal(p.parameters.Build,value);
    const literal=A.clone(p);
    literal.library[0].footprint.shapes[0].text=value;
    return ["GTO","GBO"].map(ext=>{
      const bytes=film(p,ext);
      assert.equal(bytes,film(literal,ext),ext+" variable and literal plot identically");
      const {shapes,bbox}=parseGerber(bytes);
      assert.ok(shapes.length>0 && shapes.every(s=>s.k==="capsule" && s.r===.1 && s.dark),ext+" authored pen");
      if(value==="L"){
        // L spans 0.8 mm × 1.2 mm from its baseline. The bottom glyph's
        // horizontal stroke is reflected before the 90° footprint rotation.
        const expected=ext==="GTO"?[11.9,-13.1,12.9,-11.7]:[40.9,-30.1,42.3,-29.1];
        for(let i=0;i<4;i++)close(bbox[i],expected[i],1e-6,ext+" authored extent");
      }
      return bytes;
    });
  }
  try {
    const initial=verify("L"), mark=undo.mark(p);
    p.parameters.Build="LL";
    undo.checkpoint(history,future,mark,"Change the marking");
    undo.record(p);
    const changed=verify("LL");
    for(let i=0;i<2;i++)assert.notEqual(changed[i],initial[i]);
    assert.ok(undo.jump(history,future,undo.mark(p),-1));
    assert.deepEqual(verify("L"),initial);
    assert.ok(undo.jump(history,future,undo.mark(p),1));
    assert.deepEqual(verify("LL"),changed);
    assert.equal(label.text,".Build");
  } finally { undo.reset(); }
}

// ---- TrueType through an injected glyph source ---------------------------------
{
  let rendered=0;
  const ring=(cx,cy,R,n,rev)=>{const r=[];for(let i=0;i<n;i++){const a=(rev?-1:1)*2*Math.PI*i/n;r.push([cx+R*Math.cos(a),cy+R*Math.sin(a)]);}return r;};
  T.setGlyphSource({available:()=>true,metrics:()=>({cap:.7,descent:.2,cell:1.1}),advance:(key,s)=>Array.from(s).length*.6,
    glyph(key,ch){rendered++;
      if(ch==="O")return [{outer:ring(.3,-.35,.3,48,false),holes:[ring(.3,-.35,.18,48,true)]}];
      return [{outer:[[0,-.7],[.5,-.7],[.5,0],[0,0]],holes:[]}];}});
  const item={id:"tt",kind:"label",text:"OHO",x:0,y:0,size:1.4,font:"truetype",family:"Test",bold:true,italic:true,layer:"Silk"};
  const l=T.layoutItem(item);
  assert.equal(l.polygons.length,3);assert.equal(l.polygons[0].holes.length,1,"O keeps its counter");
  assert.equal(rendered,2,"each glyph traced once");
  // Height: the cap (0.7 em) maps to 1.4 mm, so the H block spans 1.4 mm.
  const H=l.polygons[1].outer;close(Math.min(...H.map(p=>p[1])),-1.4,1e-9);close(H[1][0]-H[0][0],1,1e-9);
  close(l.polygons[1].outer[0][0],.6*2,1e-9,"advance");
  T.layoutItem({...item,text:"HOOH"});assert.equal(rendered,2,"glyph cache hit");
  const prim=T.toPrimitives(item);assert.equal(prim.regions.length,3);assert.equal(prim.strokes.length,0);
  // Bridged ring area equals outer minus hole.
  const o=l.polygons[0];close(V.area(prim.regions[0]),V.area(o.outer)+V.area(o.holes[0]),1e-9);
  const separate=T.toPrimitives(item,{keepHoles:true});
  assert.deepEqual(separate.polygons.map(poly=>poly.holes.length),[1,0,1]);
  assert.deepEqual(separate.polygons[0],{outer:o.outer,holes:o.holes});
  assert.deepEqual(separate.polygons[1].outer,prim.regions[1],"Solid glyphs keep their plotted ring order");
  // Mirroring keeps outer rings positive.
  const m=T.layoutItem({...item,mirrored:true});assert.ok(V.area(m.polygons[0].outer)>0&&V.area(m.polygons[0].holes[0])<0);
  const placed={...item,justify:"center",sourceTextBox:{text:"OHO",width:2.8,height:.9,size:1.4,family:"Test",bold:true,italic:true}};
  const fitted=T.layoutItem(placed);[-1.4,-.45,1.4,.45].forEach((v,k)=>close(fitted.box[k],v));
  assert.equal(fitted.polygons[0].holes.length,1);
  assert.notDeepEqual(T.layoutItem({...placed,family:"Other"}).box,fitted.box);
  const frame={...item,justify:"bottom-left",text:"H\nH",sourceTextBox:{...placed.sourceTextBox,mode:"frame",text:"H\nH",height:8,width:9}};
  const framed=T.layoutItem(frame);close(framed.box[2],.5*1.4/1.1);close(framed.box[1],-1.6*1.4/1.1);
  const renamed={...placed,text:"HH",sourceTextBox:{...placed.sourceTextBox,mode:"ink"}};
  close(T.layoutItem(renamed).box[3]-T.layoutItem(renamed).box[1],.7*1.4/1.1);
  const cold={...placed,text:"XYZ",sourceTextBox:{...placed.sourceTextBox,text:"XYZ",mode:"ink"}};
  const count=rendered;T.paintBox(cold);T.hitBox(cold);T.hitDistance(cold,[0,0]);
  const pin={...cold,justify:"bottom-left",sourceTextBox:{...cold.sourceTextBox,mode:"baseline"}};
  T.paintBox(pin);
  T.draw({save(){},restore(){},translate(){},fillRect(){},globalAlpha:1},pin,.1,"black");
  assert.equal(rendered,count,"metadata alone culls native text without tracing offscreen outlines");
  const original=T.layoutItem(cold);assert.ok(rendered>count);
  cold.x+=5;assert.equal(T.layoutItem(cold),original,"translation reuses local glyph geometry");
  cold.sourceTextBox.width+=1;cold.mirrored=true;
  const edited=T.layoutItem(cold),full=T.layout(cold.text,T.props(cold));
  assert.notEqual(edited,original);assert.deepEqual(edited.box,full.box);assert.deepEqual(edited.polygons,full.polygons);
  assert.equal(T.kicad(item).mode,"poly");
  T.setGlyphSource({available:()=>false});
  assert.match(T.layoutItem({...item,text:"Q"}).fallback,/unavailable/);
  assert.match(T.layoutItem(item).fallback,/unavailable/,"the same placed object invalidates when the font provider changes");
  T.setGlyphSource(null);
}

// ---- Inverted (knockout) text and frames -----------------------------------------
{
  const item={id:"k",kind:"label",text:"O",x:0,y:0,size:3,width:.5,inverted:true,margin:.5,layer:"Silk"};
  const l=T.layoutItem(item);
  // Rectangle with the O cut out, plus the island inside the O.
  assert.equal(l.strokes.length,0);assert.equal(l.polygons.length,2,"frame + island");
  const frame=l.polygons.find(p=>p.holes.length===1);assert.ok(frame,"O hole");
  const ink=T.layout("O",{height:3,width:.5}).box,r=[ink[0]-.5,ink[1]-.5,ink[2]+.5,ink[3]+.5];
  const b=frame.outer.reduce((b,p)=>[Math.min(b[0],p[0]),Math.min(b[1],p[1]),Math.max(b[2],p[0]),Math.max(b[3],p[1])],[Infinity,Infinity,-Infinity,-Infinity]);
  for(let i=0;i<4;i++)close(b[i],r[i],1e-9,"knockout rectangle "+i);
  // Area: rectangle minus the O stroke (rasterised capsules, ~1% tolerance).
  const f=new Uint8Array(1000*1000);V.rasterStrokes(f,1000,1000,T.layout("O",{height:3,width:.5}).strokes,{scale:100,ox:r[0],oy:r[1]});
  let inkArea=0;for(const v of f)inkArea+=v/255;inkArea/=100*100;
  const area=l.polygons.reduce((s,p)=>s+p.area,0),rectArea=(r[2]-r[0])*(r[3]-r[1]);
  close(area,rectArea-inkArea,.01*rectArea,"knockout area");
  const prim=T.toPrimitives(item);assert.equal(prim.regions.length,2);
  close(V.area(prim.regions[0])+V.area(prim.regions[1]),area,1e-6,"bridged regions keep area");
  assert.equal(T.kicad(item).mode,"poly");
  const bottom={...item,x:3,y:4,angle:27,layer:"Bottom silk"}, parent={x:18,y:14,angle:63,mirror:true};
  const [x,y]=A.world([bottom.x,bottom.y],parent), put=q=>A.world(q,{x,y,angle:90});
  const expected=T.layoutItem(bottom,bottom.layer).polygons.map(p=>({outer:(p.holes.length?p.outer:V.bridge(p)).map(put),
    holes:p.holes.map(h=>h.map(put))}));
  assert.deepEqual(T.toPrimitives(bottom,{frame:parent,layer:bottom.layer,keepHoles:true}).polygons,expected,
    "Rotated and mirrored knockout keeps its counter and nested island");
  const project=A.project("Nested text regions",AtriumParts.catalogue), board=project.documents.find(d=>d.kind==="pcb");
  board.outline=[[0,0],[40,0],[40,30],[0,30]];
  board.items.push({...bottom,x:18,y:14});
  let bridgesWithHoles=0;
  globalThis.AtriumVectorize={...V,bridge(p) {
    if (p.holes.length) bridgesWithHoles++;
    return V.bridge(p);
  }};
  try {
    const regions=F.analyse(project,board).layers.get("Bottom silk").filter(f=>f.t==="region");
    assert.deepEqual(regions.map(f=>f.holes?.length??0),[1,0]);
    assert.equal(bridgesWithHoles,0,"Manufacturing can use the original rings directly");
  } finally {globalThis.AtriumVectorize=V;}
  // Frame adds one closed stroke around the text.
  const fr=T.layout("AB",{height:1,frame:true,margin:.2});
  assert.equal(fr.strokes.length,T.layout("AB",{height:1}).strokes.length+1);
  const last=fr.strokes.at(-1).points;assert.deepEqual(last[0],last.at(-1));
}

// ---- Barcodes -----------------------------------------------------------------
{
  // Code 39: every symbol has 3 wide elements out of 9; "*" frames the data.
  const c=R.code39("A1");assert.equal(c.bars.length,5*4);
  assert.equal(c.width,4*(6+3*3)+3,"4 characters of 15 modules plus gaps");
  assert.throws(()=>R.code39("a*"),/cannot encode/);
  // Table integrity: Code 39 has 9 elements with exactly 3 wide, all distinct;
  // Code 128 symbols are 3 bars + 3 spaces over 11 modules (stop: 13), distinct.
  const t39=R.tables.code39;assert.equal(t39.length,44);assert.equal(new Set(t39).size,44);
  for(const w of t39){assert.equal(w.length,9);assert.equal(w.split("").filter(c=>c==="1").length,3);}
  const t128=R.tables.code128;assert.equal(t128.length,107);assert.equal(new Set(t128).size,107);
  t128.forEach((w,i)=>{const sum=[...w].reduce((s,c)=>s+ +c,0);assert.equal(sum,i===106?13:11,"code 128 symbol "+i);assert.equal(w.length,i===106?7:6);
    // Bars (odd positions from 1) total an even module count for 0-105 (parity check of the symbology).
    if(i<106)assert.equal([...w].filter((_,k)=>k%2===0).reduce((s,c)=>s+ +c,0)%2,0,"bar parity "+i);});
  // Code 128: checksums and code-set switching.
  assert.deepEqual(R.code128Values("1234"),[105,12,34,(105+12+2*34)%103,106]);
  assert.deepEqual(R.code128Values("Wikipedia"),[104,55,73,75,73,80,69,68,73,65,88,106]);
  const mixed=R.code128Values("AB123456");assert.deepEqual(mixed.slice(0,6),[104,33,34,99,12,34]);
  assert.deepEqual(R.code128Values("X12345Y").slice(0,5),[104,56,17,18,19]);
  const enc=R.code128("Hi");assert.equal(enc.width,11*4+13,"start + 2 + check + stop");
  // Layout: bars of the requested height, quiet zones, human-readable text.
  const l=T.layout("ATRIUM",{font:"barcode",height:5,barcode:{type:"code128",module:.2,quiet:10}});
  assert.equal(l.polygons.length,R.code128("ATRIUM").bars.length);
  close(l.metrics[2]-l.metrics[0],(R.code128("ATRIUM").width+20)*.2,1e-9,"width with quiet zones");
  assert.ok(l.strokes.length>0,"human-readable text");
  const ys=l.polygons.flatMap(p=>p.outer.map(q=>q[1]));close(Math.max(...ys)-Math.min(...ys),5,1e-9);
  // QR: structure, format information and Reed-Solomon codewords.
  const q=R.qr("https://atrium.example/SN-000123","M");
  assert.equal(q.size,q.version*4+17);
  const finder=(x,y)=>{for(let dy=0;dy<7;dy++)for(let dx=0;dx<7;dx++){const d=Math.max(Math.abs(dx-3),Math.abs(dy-3));if(q.modules[y+dy][x+dx]!==(d!==2))return false;}return true;};
  assert.ok(finder(0,0)&&finder(q.size-7,0)&&finder(0,q.size-7),"finder patterns");
  assert.equal(q.modules[q.size-8][8],true,"dark module");
  let fmt=0;for(let i=0;i<=5;i++)fmt|=(q.modules[i][8]?1:0)<<i;fmt|=(q.modules[7][8]?1:0)<<6;fmt|=(q.modules[8][8]?1:0)<<7;fmt|=(q.modules[8][7]?1:0)<<8;
  for(let i=9;i<15;i++)fmt|=(q.modules[8][14-i]?1:0)<<i;
  const f=fmt^0x5412;let rem=f;for(let i=14;i>=10;i--)if(rem>>i&1)rem^=0x537<<(i-10);
  assert.equal(rem,0,"format BCH");assert.equal(f>>13,0,"level M");assert.equal(f>>10&7,q.mask);
  // Each block's codeword polynomial vanishes at the generator roots, for
  // single- and multi-block symbols (short blocks carry a placeholder).
  for(const [msg,level] of [["https://atrium.example/SN-000123","M"],["x".repeat(120),"Q"],["Board rev C 2026-11","H"]]){
    const s=R.qr(msg,level),nb=s.blocks.length,short=nb-s.words.length%nb;
    const eccN={L:[7,10,15,20,26,18,20,24,30,18],M:[10,16,26,18,24,16,18,22,22,26],Q:[13,22,18,26,18,24,18,22,20,24],H:[17,28,22,16,22,28,26,26,24,28]}[level][s.version-1];
    let checked=0;
    s.blocks.forEach((b,i)=>{
      const words=i<short?[...b.slice(0,b.length-eccN-1),...b.slice(b.length-eccN)]:b;
      for(let r=0,root=1;r<eccN;r++,root=R.gfMul(root,2)){let acc=0;for(const w of words)acc=R.gfMul(acc,root)^w;assert.equal(acc,0,"syndrome "+r);}
      checked++;
    });
    assert.equal(checked,nb);
    if(level==="Q")assert.ok(nb>1,"multi-block symbol");
  }
  {
    const div=R.rsDivisor(10),data=[32,91,11,120,209,114,220,77,67,64,236,17,236,17,236,17],ecc=R.rsRemainder(data,div);
    // ISO/IEC 18004 Annex I example "01234567" (1-M): ECC codewords.
    assert.deepEqual(ecc,[196,35,39,119,235,215,231,226,93,23]);
  }
  const qrl=T.layout("SN123",{font:"barcode",height:8,barcode:{type:"qr"}});
  close(qrl.metrics[2]-qrl.metrics[0],8+8*8/R.qr("SN123").size,1e-9,"QR size with quiet zone");
  assert.throws(()=>R.qr("x".repeat(400)),/too long/);
}

// ---- KiCad mapping and validation ---------------------------------------------
{
  const k=T.kicad({text:"A",size:1,justify:"top-right",layer:"Bottom silk"});
  assert.equal(k.mode,"text");assert.equal(k.justify,"right top mirror");close(k.thickness,1/6);
  assert.equal(T.kicad({text:"A",justify:"center"}).justify,"");
  require("../../app/formats/kicad-export.js");
  const project=A.project("Placed lettering"),doc=project.documents.find(d=>d.kind==="pcb");
  const part={id:"placed",kind:"part",def:"part",ref:"R1",value:"H",sourceRecord:"components6/data#0",layer:"Top",x:10,y:8,angle:90,pinNets:{}};
  const annotation={at:[2,3],angle:-90,field:"value",layer:"Bottom silk",size:1,width:.2,mirrored:true,justify:"center",
    sourceTextBox:{mode:"ink",text:"H",size:1,width:1.5,height:1.1,font:"stroke",strokeWidth:.2,strokeFont:"default"}};
  doc.items=[part];doc.pcbDrawing={annotations:{[part.sourceRecord]:[annotation]}};
  project.library=[{id:"part",footprint:{name:"Part",pads:[],shapes:[]}}];
  const file=AtriumKiCad.exportBoard(project,doc).content;
  assert.match(file,/fp_text reference "R1"[^\n]* hide /,"native visibility suppresses the automatic reference");
  assert.match(file,/fp_text value "H"[^\n]* hide /);
  const emitted=[...file.matchAll(/\(fp_line \(start ([-.\d]+) ([-.\d]+)\) \(end ([-.\d]+) ([-.\d]+)\) \(layer "B.SilkS"\) \(width ([-.\d]+)\)/g)];
  const shape=AtriumPCBAppearance.annotationText(part,annotation),ink=T.toPrimitives(shape).strokes;
  assert.equal(emitted.length,ink.length);
  emitted.forEach((m,i)=>[...ink[i].points.flat(),ink[i].width].forEach((n,k)=>close(Number(m[k+1]),n,.000001)));
  require("../../app/pcb/designator-place.js");
  part.designator={x:1,y:2,height:1,angle:0};part.showValue=false;
  const auto=AtriumKiCad.exportBoard(project,doc).content;
  assert.match(auto,/\(fp_line[^\n]*"F.SilkS"/,"auto-placed reference plotted on its board side");
  assert.doesNotMatch(auto,/\(fp_line[^\n]*"B.SilkS"/,"hidden native value omitted");
  assert.ok(T.valid({text:"x",font:"barcode",barcode:{type:"qr",ecc:"H"}}));
  assert.ok(!T.valid({text:"x",font:"comic"}));assert.ok(!T.valid({text:"x",size:-1}));assert.ok(!T.valid({text:"x",barcode:{type:"ean"}}));
}

// ---- Hit box ------------------------------------------------------------------
{
  const item={text:"WIDE TEXT",x:10,y:10,angle:90,size:2};
  const b=T.hitBox(item);
  assert.ok(b[2]-b[0]<3&&b[3]-b[1]>10,"rotated box is tall");
  assert.equal(T.hitDistance(item,[10.5,15]),0);assert.ok(T.hitDistance(item,[20,15])>5);
}

// ---- Performance: layout cache ---------------------------------------------------
{
  T.clearCache();
  const items=[];for(let i=0;i<2000;i++)items.push({text:"R"+i,x:i,y:0,size:1});
  let t0=now();for(const i of items)T.layoutItem(i);const cold=now()-t0;
  t0=now();for(let k=0;k<5;k++)for(const i of items)T.layoutItem(i);const warm=(now()-t0)/5;
  t0=now();for(const i of items)T.layoutItem({...i});const copies=now()-t0;
  const inv={text:"INVERTED 0123",size:2,inverted:true};t0=now();T.layout(inv.text,inv);const knock=now()-t0;
  console.log("pcb-text: 2000 labels cold "+cold.toFixed(1)+" ms, warm "+warm.toFixed(1)+" ms, copies "+copies.toFixed(1)+" ms; knockout "+knock.toFixed(1)+" ms");
  assert.ok(warm<cold+5);
}

// ---- pcb-text-rich.js is lazy: until it loads, such text is stroke text, uncached --------
{
  T.clearCache();
  const rich=globalThis.AtriumPCBTextRich,asked=[];
  globalThis.AtriumLazy={need:n=>{asked.push(n);return new Promise(()=>{});}};
  delete globalThis.AtriumPCBTextRich;
  try{
    const qr={id:"q",kind:"label",text:"SN1",font:"barcode",barcode:{type:"qr"},size:4},inv={id:"i",kind:"label",text:"O",size:3,inverted:true};
    const l=T.layoutItem(qr);
    assert.equal(l.pending,true);assert.equal(l.font,"stroke");assert.equal(l.polygons.length,0);
    assert.equal(T.layoutItem(inv).pending,true);assert.equal(T.layoutItem(inv).polygons.length,0,"knockout waits for the module");
    assert.notEqual(T.layoutItem(qr),l,"a pending layout is not cached");
    assert.deepEqual(asked,["AtriumPCBTextRich"],"the module is requested once");
    assert.equal(T.layoutItem({kind:"label",text:"R1",size:1}).pending,undefined,"stroke text needs nothing");
    globalThis.AtriumPCBTextRich=rich;
    assert.ok(T.layoutItem(qr).polygons.length>10,"the QR code once the module is there");
  }finally{globalThis.AtriumPCBTextRich=rich;delete globalThis.AtriumLazy;}
}
// The bounds-only path for ordinary stroke labels must match the vector geometry used at editing zoom.
for (const text of ["R12345", "pQgj", " A B ", "Ωµ", "éþ", "🔩", "   ", ""]) {
  for (const strokeFont of ["default","sans","serif"]) for (const mirrored of [false,true]) {
    for (const justify of ["bottom-left","top-center","middle-right","center"]) {
      const item = {kind:"text",text,x:-5,y:.125,angle:35,size:.68,width:.1,justify,strokeFont,mirrored};
      assert.deepEqual(T.paintBox(item),T.hitBox(item));
    }
  }
}
{
  const authored = {kind:"text",text:"REV .Build",x:2,y:1,size:1.2,width:.2,justify:"bottom-left"};
  const frame = {x:42,y:28,angle:90};
  const layer = "Bottom silk", literal = {...authored,text:"REV LLLLLLLL"};
  const projected = T.projectItem(authored,{parameters:{Build:"LLLLLLLL"}});
  assert.deepEqual(T.paintBox(projected,{frame,layer}),T.hitBox(literal,{frame,layer}));
  const at = [41.59,20.46];
  assert.equal(T.hitDistance(projected,at,{frame,layer}),0);
  assert.equal(authored.text,"REV .Build");
}
// The same implicit reference is read for ordering and painting at successive cameras.
{
  const P=AtriumPCBAppearance, doc={kind:"pcb"}, part={ref:"R103",x:3.125,y:-17.3,angle:33.7,layer:"Top"};
  const def={footprint:{pads:[{x:-1.25,y:3.5,w:2.5,h:.75},{x:2,y:-.5,w:.4,h:1.2}]}};
  const world=A.world, placement=A.placement, journal=globalThis.AtriumUndoStore;
  let transforms=0, library=0, editing=false;
  A.world=(point,item)=>{if(item===part)transforms++;return world(point,item);};
  A.placement=(item,...args)=>{if(item===part)transforms++;return placement(item,...args);};
  globalThis.AtriumUndoStore={libraryVersion:()=>library,unrecorded:()=>editing};
  const reference=()=>[...P.partText(doc,part,def)][0].text;
  function referenceFromCorners() {
    const [left,top,right,bottom]=A.bounds(A.symbolPoints(def.footprint));
    const [l,t,r]=A.bounds([[left,top],[right,top],[right,bottom],[left,bottom]].map(point=>world(point,part)));
    const text=reference();
    assert.deepEqual([text.x,text.y],[(l+r)/2,t-.39],"reference position matches the exact four transformed corners");
    return text;
  }
  try {
    const first=referenceFromCorners();
    transforms=0;
    for(let i=0;i<12;i++)assert.deepEqual(reference(),first);
    assert.equal(transforms,0,"unchanged reference positions do not transform footprint corners for each draw");

    for(const pose of [{x:-9.625},{y:5.5},{mirror:true},{angle:90},{angle:270},{angle:-.001,mirror:false}]) {
      const prior=reference();
      Object.assign(part,pose);
      assert.notDeepEqual(referenceFromCorners(),prior,"the reference follows placement edits");
    }
    const before=reference();
    def.footprint.pads[0].y=-5.5;
    library++;
    assert.notDeepEqual(referenceFromCorners(),before,"the reference follows a library revision");
    editing=true;
    const pending=reference();
    def.footprint.pads[0].x=-21.25;
    assert.notDeepEqual(referenceFromCorners(),pending,"the reference also follows an uncommitted definition edit");
    part.refAt=[.25,-.5];
    const explicit=reference();
    assert.deepEqual([explicit.x,explicit.y],world(part.refAt,part),"an authored position is still used");
  } finally {
    A.world=world; A.placement=placement; globalThis.AtriumUndoStore=journal;
  }
}
// Ordering and visibility need the painter's layer sequence, including source
// fields revealed by the user, without resolving any of their text geometry.
{
  require(require("../support/app-source-paths.cjs").appFile("designator-place.js"));
  const pcb=AtriumPCBAppearance, def={footprint:{pads:[],shapes:[]}};
  const row=(field,layer)=>({field,layer,at:[.3,-.7],angle:45,size:1});
  const ref=row("ref","Mechanical 2"), value=row("value","Bottom paste");
  const sourceRecord="components6/data#17";
  const doc={kind:"pcb",pcbDrawing:{annotations:{[sourceRecord]:[ref,value]}}};
  for(const props of [{},{refAt:[.2,1]}, {layer:"Bottom"}, {showRef:false},
      {designator:{x:1,y:3},side:"bottom"},{designator:{x:1}},{sourceRecord},
      {sourceRecord,showValue:false},{boardLabels:[]},
      {boardLabels:[value],hiddenBoardLabels:[ref],showRef:true}]){
    const part={ref:"R7",value:"10k",x:4,y:-1,angle:45,...props};
    const expected=Array.from(pcb.partText(doc,part,def),r=>r.text.layer);
    const world=A.world, placement=A.placement;
    A.world=A.placement=()=>{throw new Error("a layer query transformed text geometry");};
    try{assert.deepEqual([...pcb.partTextLayers(doc,part,def)],expected);}
    finally{A.world=world;A.placement=placement;}
  }
}
console.log("pcb-text tests passed");
