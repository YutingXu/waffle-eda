"use strict";
// Part text fields (sch-fields.js) and imported pin numbers (sch-appearance.js pinText).
const assert=require("node:assert/strict");
const {appFile}=require("../support/app-source-paths.cjs");
globalThis.CFB=require(appFile("vendor/cfb.min.js"));
for(const file of ["model","parts","sch-import","io","source-file","spatial","pcb-appearance","sch-appearance","canvas","sch-objects","sch-fields",
  "format-2-codec","format-2-units","format-2-values","format-2-model"])require(appFile(file+".js"));
const A=Atrium,S=AtriumSchAppearance,F=AtriumSchFields,M=AtriumFormat2Model,F2=AtriumFormat2;
const close=(a,b,tol=1e-6,what="")=>assert.ok(Math.abs(a-b)<=tol,what+": expected "+a+" ≈ "+b);

// A context that records where each string is painted: the anchor, the angle and the baseline offset.
function recorder(){
  const out=[];let state={t:[0,0],a:0};const stack=[];
  const ctx={save(){stack.push({...state});},restore(){state=stack.pop();},translate(x,y){state.t=[state.t[0]+x,state.t[1]+y];},rotate(a){state.a+=a;},
    measureText:t=>({width:t.length}),fillRect(){},fillText(text,x,y){out.push({text,at:state.t,angle:state.a,dy:y,align:this.textAlign});}};
  return {ctx,out};
}

{
  // Altium pin numbers sit outside the body, 80 mil from it along the pin, with the bottom of their
  // text box (the font's descent) on the pin line: the digits clear the line by the descent and never
  // touch it. Measured on a sheet printed by Altium (10 pt pin numbers): the number starts 82 mil from
  // the body and its digits end 18.5 mil (0.47 mm, 0.23 em) above the pin's centre line. Pins of all
  // four orientations; vertical numbers read bottom to top and sit left of the pin.
  const pins=[[0,"R"],[1,"U"],[2,"L"],[3,"D"]].map(([rot,name],k)=>
    "|RECORD=2|OwnerIndex=1|OwnerPartId=1|PinConglomerate="+(24+rot)+"|PinLength=30|Location.X="+(200+k*100)+"|Location.Y=300|Name="+name+"|Designator=2"+k);
  const source=["|RECORD=31|FontIdCount=1|Size1=10|FontName1=Times New Roman|SystemFont=1",
    "|RECORD=1|LibReference=Probe|Location.X=100|Location.Y=100|PartCount=1|CurrentPartId=1",...pins,
    "|RECORD=2|OwnerIndex=1|OwnerPartId=1|PinConglomerate=24|PinLength=30|Location.X=700|Location.Y=300|Designator=9|Designator_CustomPosition_Margin=9"].join("\n");
  const {documents:[sheet],library}=AtriumSCH.read("Pins.SchDoc",null,source);
  const part=sheet.items.find(i=>i.kind==="part"),def=library.find(d=>d.id===part.def)||{};
  assert.ok(def.schDrawing?.pinFont,"sheet font pins keep Altium geometry");
  for(const angle of [0,90,180,270]){
    const p={...part,angle},{ctx,out}=recorder();
    S.pinText(ctx,p,def,20,false);
    for(const pin of def.schDrawing.pins){
      const n=out.find(o=>o.text===pin.number);assert.ok(n,"pin "+pin.number+" is drawn");
      const start=A.world(pin.start,p),d=A.rotate(pin.direction,angle),margin=pin.numberMargin??2.032;
      close(n.at[0],start[0]+d[0]*margin,1e-9,"pin "+pin.number+" x at "+angle);close(n.at[1],start[1]+d[1]*margin,1e-9,"pin "+pin.number+" y at "+angle);
      const vertical=Math.abs(d[1])>.5;
      // Text runs away from the body; a vertical number is turned to read bottom to top.
      close(n.angle,vertical?-Math.PI/2:0,1e-9,"pin "+pin.number+" angle");
      const along=vertical?-Math.sign(d[1]):Math.sign(d[0]);
      assert.equal(n.align,along>0?"left":"right","pin "+pin.number+" alignment at "+angle);
      // The alphabetic baseline is the descent above the line (0.22 em without canvas metrics):
      // up for a horizontal pin, left of a vertical one.
      close(n.dy,-.22*2.032,1e-9,"pin "+pin.number+" baseline");
      const up=A.rotate([0,n.dy],n.angle*180/Math.PI);
      if(vertical){assert.ok(up[0]<-.4&&Math.abs(up[1])<1e-9,"pin "+pin.number+" sits left of its line at "+angle);}
      else assert.ok(up[1]<-.4&&Math.abs(up[0])<1e-9,"pin "+pin.number+" sits above its line at "+angle);
    }
  }
  // A pin's custom designator position (Designator_CustomPosition_Margin, in 10 mil units) moves the number along the pin.
  close(def.schDrawing.pins.find(p=>p.number==="9").numberMargin,2.286);
  A.validate({...A.project("Pins"),library,documents:[sheet]});
}

// ------------------------------------------------------------------ fields
const def={id:"d",name:"R",symbol:{shapes:[{kind:"path",style:"body",points:[[-2,-1],[2,-1],[2,1],[-2,1]],closed:true}],pins:[]}};
const defs=new Map([["d",def]]);
const pos=part=>AtriumCanvas.referencePositions(part,def,"schematic");
function fieldAt(part,key){return F.list(part,def,pos(part)).find(f=>f.key===key);}
{
  // A default Designator is centred above the part. Its first move gives it a left-aligned anchor at the same
  // place, so the text does not jump; the part itself never moves. Mirrored and rotated parts store part coordinates.
  for(const [angle,mirror] of [[0,false],[90,false],[180,true],[270,true]]){
    const part={kind:"part",id:"p",def:"d",x:10,y:20,angle,mirror,ref:"R1",value:"10k"},before=F.quad(fieldAt(part,"ref"));
    const session=F.begin(part,def,"ref",pos(part));
    F.quad(fieldAt(part,"ref")).forEach((c,k)=>{close(c[0],before[k][0],1e-6,"x "+angle);close(c[1],before[k][1],1e-6,"y "+angle);});
    session.move([session.anchor[0]+2.54,session.anchor[1]-5.08]);
    assert.deepEqual([part.x,part.y,part.angle],[10,20,angle]);
    const at=fieldAt(part,"ref").at;close(at[0],session.anchor[0]+2.54);close(at[1],session.anchor[1]-5.08);
    assert.deepEqual(F.toLocal(A.world(part.refAt,part),part).map(v=>+v.toFixed(6)),part.refAt.map(v=>+v.toFixed(6)));
    // Rotating the field turns the text only (Space while dragging, Rotation in Properties).
    session.rotate(-90);
    assert.equal(((fieldAt(part,"ref").paint.angle%360)+360)%360,270,"the Designator turned a quarter anticlockwise");
    assert.equal(part.angle,angle);close(fieldAt(part,"ref").at[0],at[0]);
  }
}
{
  // Visible parameters: imported ones store their own position; stacked ones (under the Comment) get one when
  // first moved, and stay put when the Comment moves.
  const part={kind:"part",id:"q",def:"d",x:0,y:0,angle:0,ref:"U1",value:"MCU",parameters:{MPN:"ABC-1",Rating:"5 V"},paramShow:{MPN:true,Rating:true},
    schPaint:{parameters:{Rating:{family:"Arial",size:1.5,align:"left",baseline:"bottom",angle:0,at:[4,4],text:"5 V"}}}};
  const keys=F.list(part,def,pos(part)).map(f=>f.key);
  assert.deepEqual(keys,["ref","value","param:MPN","param:Rating"]);
  const mpn=fieldAt(part,"param:MPN").at.slice();
  const comment=F.begin(part,def,"value",pos(part));comment.move([comment.anchor[0]+5.08,comment.anchor[1]]);
  close(fieldAt(part,"param:MPN").at[0],mpn[0]);close(fieldAt(part,"param:MPN").at[1],mpn[1]);
  const rating=F.begin(part,def,"param:Rating",pos(part));rating.move([10,-2.54]);
  assert.deepEqual(part.schPaint.parameters.Rating.at,[10,-2.54]);assert.equal(part.schPaint.parameters.Rating.family,"Arial");
  assert.deepEqual([part.x,part.y],[0,0]);
  // Hit testing finds the field under its glyphs, before the part body.
  const view={query:()=>[part]},doc={kind:"schematic",items:[part]};
  const on=F.quad(fieldAt(part,"ref")),centre=[(on[0][0]+on[2][0])/2,(on[0][1]+on[2][1])/2];
  assert.deepEqual(F.at(view,doc,defs,centre,{scale:10}),{item:part,key:"ref"});
  assert.equal(F.at(view,doc,defs,[0,0],{scale:10}),null,"the body is not a field");
  assert.equal(F.at(view,doc,defs,centre,{scale:1}),null,"text too small to draw is not picked");
  // The field positions persist in the native format.
  const project=A.project("Fields",[def]);const [sheet]=project.documents;sheet.items.push(part);
  A.validate(project);
  const storage=M.fromEditor(project);
  const file=storage.files.find(f=>M.parse(F2.serialize(f.file)).header.kind==="schematic");
  const back=M.document(M.parse(F2.serialize(file.file))).items.find(i=>i.id==="q");
  for(let k=0;k<2;k++)close(back.valueAt[k],part.valueAt[k],1e-4,"Comment position");
  assert.deepEqual(back.schPaint.parameters.Rating.at,[10,-2.54]);
  assert.deepEqual(Object.keys(back.schPaint.parameters).sort(),["MPN","Rating"]);
}
console.log("sch-fields ok");
