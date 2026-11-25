"use strict";
const assert=require("node:assert/strict");
const fs=require("node:fs"),path=require("node:path");
for(const m of ["model","sch-objects","wire-edit"])require(require("../support/app-source-paths.cjs").appFile(m));
const A=Atrium,W=AtriumWireEdit,defs=new Map();
const wire=(id,...points)=>({id,kind:"wire",points});
const doc=(...items)=>({...A.sheet("schematic","Sheet"),items});
const label=(x,y,text)=>({id:A.id(),kind:"netlabel",x,y,text});
const start=[0,0],finish=[12,0],tap=[4,0];
{
  const w=wire("editable",start,finish),branch=wire("tap",tap,[4,3]),target=wire("target",[2,5],[8,5]);
  const sheet=doc(w,branch,target,label(0,0,"OLD"),label(2,5,"DEST"));
  assert.equal(W.endpointAt(w,[.1,.1],.2),0);assert.equal(W.endpointAt(w,[8,0],.2),null);
  const g=W.begin(sheet,w,defs,[.1,.1],null,{tolerance:.2,snap:p=>p.map(Math.round)});
  w.points=g.pointsAt([6.1,5.1],1);assert.deepEqual(w.points,[[6,5],[6,0],tap,finish]);
  const nets=A.connectivity(sheet,defs).byWire;assert.equal(nets.get(w.id),"DEST");assert.equal(nets.get(branch.id),"DEST");
  assert.deepEqual(g.pointsAt([.1,.1],1),[start,finish],"returning the grip to its starting position restores imported vertices");
  const free=wire("free",[0,0],[0,4],[4,4]),g2=W.begin(doc(free),free,defs,[4,4],null,{tolerance:.2});
  assert.deepEqual(g2.pointsAt([5.2,5.8],1),[[0,0],[0,4],[5,4],[5,6]],"the free tail extends from its adjacent bend");
  const diagonal=wire("diag",[2,1],[4,3]);
  assert.deepEqual(W.begin(doc(diagonal),diagonal,defs,[2,1],null,{tolerance:.2}).pointsAt([1,2],1),[[1,2],[4,3]]);
}
{
  // Wires joined end to end keep the joint when it is dragged: the other wire's end follows (beta feedback).
  const a=wire("a",[0,0],[10,0]),b=wire("b",[10,0],[10,8]),side=wire("side",[0,0],[0,-4]),sheet=doc(a,b,side,label(0,-4,"L"));
  const g=W.begin(sheet,a,defs,[10.05,0],null,{tolerance:.2});
  assert.deepEqual(g.followers.map(f=>f.wire.id),["b"],"only the wire ending at the dragged end follows");
  a.points=g.pointsAt([13,-3],1);for(const f of g.followers)f.wire.points=f.session.pointsAt([13,-3],1);
  assert.deepEqual([a.points.at(-1),b.points[0]],[[13,-3],[13,-3]]);
  const nets=A.connectivity(sheet,defs).byWire;assert.equal(nets.get("b"),nets.get("a"),"the joint stays connected");
  assert.equal(nets.get("a"),"L");
  assert.deepEqual(W.begin(sheet,side,defs,[0,-4],null,{tolerance:.2}).followers,[],"a net label at the end does not move");
}
{
  const w=wire("native",start,finish);w.schSource={record:12,role:"wire"};
  const sheet=doc(w,label(0,0,"VDD"),label(12,0,"VDD"),wire("branch",tap,[4,-2]));
  const plan=W.begin(sheet,w,defs,[8,.1]);
  assert.deepEqual(plan.pointsAt([9,2.3],1),[[0,0],[4,0],[4,2],[12,2],[12,0]]);
  w.points=plan.pointsAt([8,3.2],1);
  assert.deepEqual(w.points,[[0,0],[4,0],[4,3],[12,3],[12,0]]);
  assert.equal(A.connectivity(sheet,defs).byWire.get("branch"),"VDD");
  assert.deepEqual(plan.pointsAt([8,.1],1),[start,finish]);
  const vertical=wire("v",[0,0],[0,3],[10,3],[10,6]);
  const context=doc(vertical,label(10,4,"DATA"),wire("tap",[0,1],[3,1]));
  const moving=W.begin(context,vertical,defs,[5,3]);
  assert.deepEqual(moving.pointsAt([5,9],1),[[0,0],[0,4],[10,4],[10,6]]);
  assert.deepEqual(moving.pointsAt([5,-4],1),[[0,0],[0,1],[10,1],[10,6]]);
  assert.equal(W.begin(sheet,wire("x",[0,0],[1,1]),defs,[.5,.5]),null);
}
{
  const w=wire("bend",[0,0],[10,0],[10,10]);
  const power=AtriumSchObjects.make("power",[10,0],{text:"GND",style:"gnd"});
  const s=doc(w,power);
  assert.equal(A.connectivity(s,defs).byWire.get(w.id),"GND");
  w.points=W.begin(s,w,defs,[5,0]).pointsAt([5,3],1);
  assert.deepEqual([power.x,power.y],[10,0]);
  assert.equal(A.connectivity(s,defs).byWire.get(w.id),"GND","a span drag preserves its stationary power connection");
}
{
  const a=wire("a",[0,3],[12,3]),b=wire("b",[6,0],[6,10]);
  a.schSource={record:12,role:"wire"};
  const s=doc(a,b,label(0,3,"BUS_A"),label(6,0,"BUS_B"));
  const nets=()=>A.connectivity(s,defs);
  assert.notEqual(nets().byWire.get("a"),nets().byWire.get("b"));
  const refused=W.place(s,"split-wire",[6,3],.1);assert.equal(refused.changed,false);assert.match(refused.message,/crossing/);
  assert.equal(W.place(s,"split-wire",[0,3],.1).changed,false);
  const split=W.place(s,"split-wire",[2,3.06],.2);assert.ok(split.changed);split.apply();
  assert.equal(s.items[0].id,"a");assert.deepEqual(s.items[0].points,[[0,3],[2,3]]);
  assert.deepEqual(s.items[1].points,[[2,3],[12,3]]);assert.equal(s.items[1].schSource,undefined);
  assert.equal(nets().byWire.get(s.items[1].id),"BUS_A");
  assert.notEqual(nets().byWire.get("a"),nets().byWire.get("b"));
  W.place(s,"junction",[6,3],.1).apply();
  assert.equal(W.place(s,"junction",[6,3],.1).changed,false);assert.equal(nets().byWire.get("a"),nets().byWire.get("b"));
  assert.ok(nets().nets.find(n=>n.conflict));W.place(s,"split-wire",[6,3],.1).apply();
  assert.deepEqual(A.validate({format:"atrium",version:1,name:"Bus",library:[],documents:[JSON.parse(JSON.stringify(s))]}).documents[0],s);
}
{
  for(const crossing of [[[5,-5],[5,5]],[[1,-4],[9,4]]]){
    const h=wire("horizontal",[0,0],[10,0]),v=wire("crossing",...crossing);
    const s=doc(h,v,label(0,0,"H"),label(...crossing[0],"V"));
    const nets=()=>A.connectivity(s,defs).byWire;
    assert.notEqual(nets().get(h.id),nets().get(v.id));
    const placed=W.place(s,"junction",[5.01,0],.5,()=>s.items);
    assert.equal(placed.changed,true,placed.message);
    placed.apply();
    const dot=s.items.at(-1);
    assert.deepEqual([dot.kind,dot.x,dot.y],["junction",5,0]);
    assert.equal(nets().get(h.id),nets().get(v.id),"a junction picked near a crossing joins the two wires");
  }
}
const flag=process.argv.indexOf("--fixtures");
if(flag>=0){
  globalThis.CFB=require("../../app/vendor/cfb.min.js");
  for(const m of ["source-file","sch-import","sch-patch","source-copy","io"])require(require("../support/app-source-paths.cjs").appFile(m));
  const name="Level.Shifter.SchDoc",bytes=fs.readFileSync(path.join(process.argv[flag+1],name));
  const {documents:[sheet],library}=AtriumIO.read(name,bytes),lib=new Map(library.map(d=>[d.id,d]));
  const partMap=new Map(sheet.items.filter(i=>i.kind==="part").map(i=>[i.id,i.ref]));
  const pins=()=>[...A.connectivity(sheet,lib).byPin].map(([id,n])=>[id.replace(/^[^/]+/,x=>partMap.get(x)),n]).sort();
  const expected=pins(),w=sheet.items.find(i=>i.kind==="wire" && i.points.length===2 && i.points[0][1]===i.points[1][1]);
  const m=w.points[0].map((n,k)=>(n+w.points[1][k])/2),g=W.begin(sheet,w,lib,m);
  w.points=g.pointsAt([m[0],m[1]-.254],.254);
  assert.equal(w.points.length,4);assert.deepEqual(pins(),expected);
  const {reopenAltium}=require("../support/altium-folder.cjs");
  const saved=reopenAltium({...Atrium.project("Level shifter",library),documents:[sheet]},{name,bytes}).project;
  const out=AtriumSourceCopy.prepare(saved.documents[0],saved.library,bytes);assert.deepEqual(out.records,[w.schSource.record]);
  const reread=AtriumIO.read(out.name,out.bytes).documents[0].items.find(i=>i.schSource.record===w.schSource.record);
  assert.ok(reread.points.every((p,i)=>p.every((v,j)=>Math.abs(v-w.points[i][j])<.00000131)));
  console.log("PASS real Level Shifter segment drag, preserved pin-net membership, save/reopen and one changed native wire record");
  const added=AtriumIO.read(name,bytes),sd=added.documents[0];
  const bus=sd.items.find(i=>i.kind==="wire"&&i.points.length===2&&Math.abs(i.points[0][0]-460*.254)<1e-6 && Math.abs(i.points[0][1]+340*.254)<1e-6);
  assert.ok(bus);const point=[475*.254,-340*.254];
  const split=W.place(sd,"split-wire",point,.001);assert.ok(split.changed);split.apply();
  const node=W.place(sd,"junction",point,.001);assert.ok(node.changed);node.apply();
  sd.items.push(wire("test-branch",point,[point[0],point[1]+1.27]));
  const output=AtriumSourceCopy.prepare(sd,added.library,bytes);
  assert.deepEqual(output.records,["FileHeader header",bus.schSource.record,334,335,336]);
  assert.deepEqual(output.changes.map(c=>c.field),["points","Added wire","Added junction","Added wire"]);
  assert.deepEqual(output.bytes,AtriumSourceCopy.prepare(sd,added.library,bytes).bytes);
  const second=AtriumIO.read(output.name,output.bytes);
  const tail=second.documents[0].items.filter(i=>i.schSource.record>=334).sort((a,b)=>a.schSource.record-b.schSource.record);
  assert.deepEqual(tail.map(i=>i.kind),["wire","junction","wire"]);
  assert.deepEqual(tail[0].schPaint,bus.schPaint);
  const noOp=AtriumSourceCopy.prepare(second.documents[0],second.library,output.bytes);
  assert.deepEqual(noOp.bytes,output.bytes);
  sd.items.push({id:"unsupported",kind:"netlabel",x:0,y:0,text:"UNSUPPORTED"});
  assert.throws(()=>AtriumSourceCopy.prepare(sd,added.library,bytes),/new or unlinked/);sd.items.pop();
  delete bus.schSource;
  assert.throws(()=>AtriumSourceCopy.prepare(sd,added.library,bytes),/added or removed/);
  const outputArg=process.argv.indexOf("--write-copy");
  if(outputArg>=0)fs.writeFileSync(process.argv[outputArg+1],output.bytes,{flag:"wx"});
  console.log("PASS native split with two wires and one junction appended, stable native IDs, paint, modified header count and atomic rejection");
}
console.log("PASS orthogonal segment dragging, preserved anchors, branch intervals, split wires and deliberate junction creation");
