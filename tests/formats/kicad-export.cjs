"use strict";
const assert=require("node:assert/strict"),crypto=require("node:crypto"),fs=require("node:fs"),os=require("node:os"),path=require("node:path"),cp=require("node:child_process");
require("../../app/core/model.js");require("../../app/library/parts.js");require("../../app/formats/kicad-export.js");
const A=Atrium,K=AtriumKiCad;
function parse(text){
  const tokens=text.match(/\(|\)|"(?:\\.|[^"\\])*"|[^()\s]+/g),stack=[[]];
  for(const t of tokens){
    if(t==="("){const v=[];stack.at(-1).push(v);stack.push(v);}
    else if(t===")"){assert.ok(stack.length>1);stack.pop();}
    else stack.at(-1).push(t.startsWith('"')?JSON.parse(t):t);
  }
  assert.equal(stack.length,1);assert.equal(stack[0].length,1);return stack[0][0];
}
const items=(v,name)=>v.filter(i=>Array.isArray(i)&&i[0]===name);
const one=(v,name)=>items(v,name)[0];
const project=AtriumParts.example(),doc=project.documents[1];
const frozen=JSON.stringify(project),result=K.exportBoard(project,doc);
assert.equal(JSON.stringify(project),frozen);
assert.equal(result.content,K.exportBoard(project,doc.id).content);
const tree=parse(result.content);assert.equal(tree[0],"kicad_pcb");
assert.equal(items(tree,"footprint").length,11);assert.equal(items(tree,"segment").length,51);assert.equal(items(tree,"via").length,5);
assert.equal(items(tree,"gr_line").filter(x=>one(x,"layer")[1]==="Edge.Cuts").length,8);
const stamps=[...result.content.matchAll(/\(tstamp ([0-9a-f-]+)\)/g)].map(m=>m[1]);
assert.equal(new Set(stamps).size,stamps.length);
const expected=crypto.createHash("sha1").update(Buffer.from("2777f222749b4685a1d84996d0fa5821","hex")).update(doc.id+"\u001fb-J1/footprint").digest().subarray(0,16);
expected[6]=expected[6]&15|80;expected[8]=expected[8]&63|128;assert.equal(one(items(tree,"footprint")[0],"tstamp")[1].replaceAll("-",""),expected.toString("hex"));
const synthetic=A.project("Interop",AtriumParts.catalogue),b=synthetic.documents[1];
b.outline=[[1,3],[8,3],[8,15],[1,15],[1,3]];
const def=A.clone(synthetic.library[0]);def.id="custom";def.footprint.name='quoted "part"';
def.footprint.pads[0]={number:"P",name:"A",x:-1,y:2,w:1.6,h:.9,drill:0,shape:"octagonal",angle:22,layer:"Bottom"};
def.footprint.pads[1]={number:"Q",x:1.7,y:.3,w:1.8,h:1.2,drill:0,angle:10,shape:"ellipse",layer:"Bottom",net:"OLD"};
synthetic.library.push(def);
b.items.push({id:"instance",kind:"part",def:def.id,ref:'R"1',value:"10k",x:3.4,y:8.1,angle:75,layer:"Bottom",pinNets:{P:"A",Q:""}});
b.items.push({id:"inner",kind:"track",layer:"Inner 1",width:.12,points:[[2,4],[3,.2],[3,8]],net:"A"});
b.items.push({id:"blind",kind:"via",fromLayer:"Top",toLayer:"Inner 1",x:2,y:4,diameter:.7,drill:.3,net:"A"});
b.items.push({id:"hole",kind:"pad",number:"",x:2,y:5,w:2,h:2,drill:2,shape:"circle",layer:"Mechanical"});
b.items.push({id:"unsafe",kind:"graphic",layer:"Keepout",points:[[3,3],[4,4]],width:.15});
b.items.push({id:"solid",kind:"graphic",layer:"Top",net:"A",points:[[2,5],[5,7],[6,5]],fill:true,closed:true});
b.notes=["Source pours omitted."];
const output=K.exportBoard(synthetic,b),board=parse(output.content),fp=items(board,"footprint")[0];
assert.equal(one(fp,"layer")[1],"B.Cu");assert.deepEqual(one(fp,"at").slice(1).map(Number),[3.4,8.1,285]);
const [p0,p1]=items(fp,"pad");assert.deepEqual(one(p0,"at").slice(1).map(Number),[-1,2,263]);assert.equal(p0[3],"custom");assert.equal(one(p0,"net")[2],"A");
assert.equal(one(p1,"net"),undefined);assert.deepEqual(one(p0,"layers").slice(1),["B.Cu","B.Paste","B.Mask"]);
const actual=A.world([-1,2],{x:3.4,y:8.1,angle:-Number(one(fp,"at")[3])}),want=A.world([-1,2],b.items[0]);assert.ok(A.same(actual,want));
assert.equal(items(board,"via")[0][1],"blind");assert.deepEqual(one(items(board,"via")[0],"layers").slice(1),["F.Cu","In1.Cu"]);
assert.ok(items(one(board,"layers"),"2").some(l=>l[1]==="In2.Cu"));
assert.ok(output.diagnostics.some(s=>/unused inner/.test(s)));assert.ok(output.diagnostics.some(s=>/Keepout/.test(s)));/* keep-outs: rule areas or a note (pcb-draw review H2) */
assert.ok(output.diagnostics.some(s=>/copper fills/.test(s)));assert.ok(output.diagnostics.includes(b.notes[0]));
assert.equal(one(items(board,"footprint")[1],"pad")[2],"np_thru_hole");
assert.throws(()=>K.exportBoard(synthetic,synthetic.documents[0]),/PCB layout/);
const csv=K.exportBOM(synthetic,b).content;assert.ok(csv.includes('"R""1","10k","quoted ""part"""'));
const temp=fs.mkdtempSync(path.join(os.tmpdir(),"atrium-kicad-"));
try{
  const demo=path.join(temp,"demo.kicad_pcb"),rotated=path.join(temp,"rotated.kicad_pcb");
  fs.writeFileSync(demo,result.content);fs.writeFileSync(rotated,output.content);
  if(process.env.KICAD_CLI){const p=cp.spawnSync(process.env.KICAD_CLI,["pcb","export","svg","--layers","F.Cu","-o",path.join(temp,"demo.svg"),demo],{encoding:"utf8"});assert.equal(p.status,0,p.stderr||p.error?.message);}
  if(process.env.KIUTILS_PYTHONPATH){
    const script=[
      "from kiutils.board import Board","from collections import Counter","import sys,math",
      "b=Board.from_file(sys.argv[1],encoding='utf-8')","assert (len(b.footprints),sum(len(f.pads) for f in b.footprints))==(11,22)",
      "assert Counter(type(x).__name__ for x in b.traceItems)=={'Segment':51,'Via':5}","assert sum(getattr(x,'layer','')=='Edge.Cuts' for x in b.graphicItems)==8",
      "r=Board.from_file(sys.argv[2],encoding='utf-8')","f=r.footprints[0];p=f.pads[0]","assert f.position.angle==285 and p.position.angle==263 and p.number=='P' and p.net.name=='A'",
      "assert p.layers==['B.Cu','B.Paste','B.Mask'] and p.shape=='custom' and len(p.customPadPrimitives)==1",
      "assert f.pads[1].net is None and r.footprints[1].pads[0].type=='np_thru_hole'",
      "assert any(getattr(x,'type',None)=='blind' for x in r.traceItems)",
      "print('PASS independent KiUtils parse of demo and rotated bottom footprint, custom pads, clearing nets, NPTH and blind vias')"
    ].join("\n");
    const p=cp.spawnSync("python3",["-c",script,demo,rotated],{encoding:"utf8",env:{...process.env,PYTHONPATH:process.env.KIUTILS_PYTHONPATH,PYTHONDONTWRITEBYTECODE:"1"}});
    assert.equal(p.status,0,p.stderr||p.error?.message);process.stdout.write(p.stdout);
  }
}finally{fs.rmSync(temp,{recursive:true,force:true});}
console.log("PASS editable KiCad board, stable object UUIDs, pad mapping, millimetre geometry and angles, multilayer connectivity, omission report and BOM");
