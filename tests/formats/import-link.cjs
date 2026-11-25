"use strict";
const assert=require("node:assert/strict");
require("../../app/core/model.js");require("../../app/formats/import-link.js");
const A=Atrium,L=AtriumImportLink;
function fixture(){
  const p=A.project("Dual import",[]);p.documents=[];
  function imp(kind,name,parts,opts={}){
    const ext=kind==="pcb"?".PcbDoc":".SchDoc",d=A.sheet(kind,name);d.sourceName=name+ext;
    for(const [ref,fp,pins] of parts){
      const def={id:A.id(),name:kind==="pcb"?fp:"Symbol",prefix:"U",value:"IC",sourceName:d.sourceName};
      if(kind==="pcb")def.footprint={name:fp,shapes:[],pads:pins.map((number,i)=>({number,x:i,y:0,w:1,h:1}))};
      else {def.footprintName=fp;def.symbol={shapes:[],pins:pins.map((number,i)=>({number,x:i,y:0}))};}
      p.library.push(def);
      d.items.push({id:A.id(),kind:"part",def:def.id,ref,value:"IC",link:A.id(),pinNets:{},x:0,y:0,angle:0});
    }
    Object.assign(d,opts);p.documents.push(d);return d;
  }
  return {p,imp};
}
for(const first of ["pcb","schematic"]){
  const {p,imp}=fixture(),other=first==="pcb"?"schematic":"pcb",data=[["U1","QFN-24",["1","2"]]];
  const d1=imp(first,"First",data);L.reconcile(p,[d1]);const id=d1.items[0].link;
  const empty=L.placeholder(other,"Canvas");p.documents.push(empty);
  const d2=imp(other,"Second",data),r=L.reconcile(p,[d2]);
  assert.equal(r.linked,1);assert.deepEqual(r.removed,[empty.id]);assert.equal(d2.items[0].link,id);assert.equal(d1.items[0].link,id);
  assert.equal(L.preferred(p,other,empty.id),d2);assert.equal(L.reconcile(p,[d2]).linked,0);
  assert.doesNotThrow(()=>A.validate(p));
}
{
  const {p,imp}=fixture();
  const sc=imp("schematic","Sensors",[["U1","TSSOP",["A"]],["R1","",["1","2"]],["D1","",["P","N"]],["C1","SMD",["1","2"]],["U?","QFN",["1"]]]);
  const bd=imp("pcb","PCB",[["u1","QFN",["A"]],["r1","0603",["2","1"]],["D1","SMALL",["1","2"]],["C1","smd",["1","2",""]],["U?","QFN",["1"]]]);
  const r=L.reconcile(p,[sc,bd]);assert.equal(r.linked,2);assert.match(r.notes.join(" "),/U1/);
  assert.equal(sc.items[1].link,bd.items[1].link);assert.equal(sc.items[3].link,bd.items[3].link);
  assert.notEqual(sc.items[4].link,bd.items[4].link);
}
{
  const {p,imp}=fixture(),row=[["U1","QFN",["1"]]];
  const s1=imp("schematic","SheetA",row),s2=imp("schematic","SheetB",row),b=imp("pcb","Main",row);
  const keep=s1.items[0].link;b.items[0].link=keep;
  const r=L.reconcile(p,[s2]);assert.equal(r.linked,0);assert.equal(b.items[0].link,keep);assert.match(r.notes.join(" "),/Ambiguous/);
  s2.items[0].ref="U2";const b2=imp("pcb","NewBoard",[["U2","QFN",["1"]]]);
  s2.items[0].link=keep;assert.equal(L.reconcile(p,[b2]).linked,0);assert.notEqual(b2.items[0].link,keep);
}
{
  const {p,imp}=fixture(),old=L.placeholder("pcb","Edited");
  old.grid=.5;const blank=A.sheet("pcb","Original blank");p.documents.push(old,blank);
  const board=imp("pcb","Real",[]);assert.deepEqual(L.reconcile(p,[board]).removed,[]);
  assert.equal(L.preferred(p,"pcb"),board);assert.equal(L.preferred(p,"pcb",blank.id),blank);
  const s=imp("schematic","Other",[["R1","0603",["1","2"]]],{sourceProject:"Other"});
  const b=imp("pcb","Main",[["R1","0603",["1","2"]]],{sourceProject:"Main"});
  assert.equal(L.reconcile(p,[s,b]).linked,0);
}
console.log("PASS separate imports in either order, stable links, pin/package compatibility, ambiguous hierarchy, explicit counterpart preservation and safe placeholder cleanup");
