"use strict";
// Pour Manager model (app/pcb/pour-manager.js): rows, inline edits, pour order, affected pours,
// repour through the engine's public API, poured area and the preview thumbnail.
const assert=require("node:assert/strict");
for(const m of ["model","spatial","pcb-appearance","pcb-pours","polygon-pour","pour-manager"])require(require("../support/app-source-paths.cjs").appFile(m+".js"));
if(!globalThis.performance)globalThis.performance={now:()=>Date.now()};
const PP=AtriumPolygonPour,M=AtriumPourManager;
const rect=(x0,y0,x1,y1)=>[[x0,y0],[x1,y0],[x1,y1],[x0,y1]];
const near=(a,b,eps,m)=>assert.ok(Math.abs(a-b)<=eps,(m||"")+" got "+a+" want "+b);
function board(items){return {kind:"pcb",name:"Board",items,outline:rect(0,0,50,40),rules:{format:"atrium-rules",version:1,units:"mm",defaults:{clearance:.2,trackWidth:.15,viaDrill:.3},nets:{}}};}
const via=(id,x,y,net)=>({id,kind:"via",x,y,diameter:.6,drill:.3,layer:"Multi",net});

const gnd=PP.make(rect(2,2,48,38),{name:"GND top",net:"GND",layer:"Top",pourIndex:0});
const vcc=PP.make(rect(10,10,20,20),{name:"VCC",net:"VCC",layer:"Top",pourIndex:1});
const bot=PP.make(rect(2,2,48,38),{name:"GND bottom",net:"GND",layer:"Bottom",pourIndex:2});
const cut=PP.make(rect(30,30,35,35),{layer:"Top",cutout:true});
const doc=board([via("v1",25,20,"GND"),via("v2",15,15,"VCC"),gnd,vcc,bot,cut]),defs=new Map();

// Before pouring: every pour is listed in order, nothing poured, the cutout last without priority.
{
  const r=M.rows(doc,defs);
  assert.deepEqual(r.map(x=>x.id),[gnd.id,vcc.id,bot.id,cut.id]);
  assert.deepEqual(r.map(x=>x.priority),[1,2,3,null]);
  assert.deepEqual(r.map(x=>x.state),["unpoured","unpoured","unpoured","cutout"]);
  assert.equal(r[0].name,"GND top");assert.equal(r[0].connectStyle,"relief");assert.equal(r[0].fill,"solid");assert.equal(r[0].clearance,null);
}
// Repour all through the engine: every pour is poured and fresh; areas are the copper areas.
{
  const res=M.repour(doc,defs,null,{});
  assert.ok(res.regions.length>=3);
  const r=M.rows(doc,defs);
  assert.deepEqual(r.slice(0,3).map(x=>x.state),["poured","poured","poured"]);
  // The bottom pour has nothing on it but the GND via: 46 × 36 minus that via's relief gaps (< 2 mm²).
  assert.ok(r[2].area<46*36&&r[2].area>46*36-2,"bottom pour area "+r[2].area);
  // The top GND pour pours first (priority 1) around nothing of its own layer but the cutout,
  // the VCC via and the antipad: less than the full rectangle.
  assert.ok(r[0].area<46*36-20&&r[0].area>46*36-60,"top area "+r[0].area);
  near(M.area(doc.pcbDrawing.pours.filter(x=>x.polygon===bot.id)),r[2].area,1e-9,"area()");
}
// Inline edits validate and change one field.
{
  M.setField(doc,vcc.id,"connectStyle","direct");assert.equal(vcc.connectStyle,"direct");
  M.setField(doc,vcc.id,"clearance",.5);assert.equal(vcc.clearance,.5);
  M.setField(doc,vcc.id,"clearance",null);assert.equal("clearance" in vcc,false);
  M.setField(doc,vcc.id,"minWidth",.2);assert.equal(vcc.minPrimLength,.2);
  M.setField(doc,vcc.id,"fill","hatched");assert.equal(vcc.fillMode,"hatched");
  M.setField(doc,vcc.id,"removeIslands",false);assert.equal(vcc.removeDeadCopper,false);
  M.setField(doc,vcc.id,"islandArea","1.5");assert.equal(vcc.islandAreaThreshold,1.5);
  M.setField(doc,vcc.id,"name","Supply");assert.equal(vcc.name,"Supply");
  assert.throws(()=>M.setField(doc,vcc.id,"layer","Top Overlay"),/layer/);assert.equal(vcc.layer,"Top");
  assert.throws(()=>M.setField(doc,vcc.id,"connectStyle","glue"),/Connect style/);
  assert.throws(()=>M.setField(doc,vcc.id,"clearance",-1),/0 to 1000/);
  assert.throws(()=>M.setField(doc,vcc.id,"colour","red"),/Unknown pour field/);
  assert.throws(()=>M.setField(doc,"nope","name","x"),/No polygon pour/);
  M.setField(doc,vcc.id,"fill","solid");
  // Edited settings make that pour (and the later ones on its layer) stale; Bottom stays fresh.
  const r=M.rows(doc,defs),st=Object.fromEntries(r.map(x=>[x.id,x.state]));
  assert.equal(st[vcc.id],"stale");assert.equal(st[bot.id],"poured");
}
// Affected pours: a pour plus the poured pours after it on its layer; a cutout touches its layer.
{
  assert.deepEqual(M.affected(doc,[gnd.id]),[gnd.id,vcc.id]);
  assert.deepEqual(M.affected(doc,[vcc.id]),[vcc.id]);
  assert.deepEqual(M.affected(doc,[bot.id]),[bot.id]);
  assert.deepEqual(M.affected(doc,[cut.id]),[gnd.id,vcc.id]);
  M.repour(doc,defs,[vcc.id],{});
  assert.ok(M.rows(doc,defs).slice(0,3).every(x=>x.state==="poured"),"repour selected refreshes");
}
// Reorder: priority follows the list; the others keep their order after it.
{
  assert.equal(M.reorder(doc,[vcc.id,gnd.id]),true);
  assert.deepEqual(M.rows(doc,defs).map(x=>x.id),[vcc.id,gnd.id,bot.id,cut.id]);
  assert.deepEqual([vcc.pourIndex,gnd.pourIndex,bot.pourIndex],[0,1,2]);
  assert.equal(M.reorder(doc,[vcc.id,gnd.id]),false,"no change");
  // Order matters to the engine: both Top pours are now stale.
  const st=Object.fromEntries(M.rows(doc,defs).map(x=>[x.id,x.state]));
  assert.equal(st[vcc.id],"stale");assert.equal(st[gnd.id],"stale");
  M.repour(doc,defs,null,{});
  // VCC now pours first; GND pours around it, so GND's copper excludes VCC's square.
  const g=M.rows(doc,defs).find(x=>x.id===gnd.id);assert.ok(g.area<46*36-100,"GND pours around VCC: "+g.area);
}
// Shelving strips the copper at once; enabling makes it unpoured until repoured.
{
  M.setField(doc,bot.id,"enabled",false);assert.equal(bot.shelved,true);
  assert.equal(doc.pcbDrawing.pours.some(r=>r.polygon===bot.id),false);
  assert.equal(M.rows(doc,defs).find(x=>x.id===bot.id).state,"shelved");
  M.setField(doc,bot.id,"enabled",true);assert.equal(bot.shelved,false);
  assert.equal(M.rows(doc,defs).find(x=>x.id===bot.id).state,"unpoured");
}
// Thumbnail and bounds.
{
  assert.deepEqual(M.bounds(vcc),[10,10,20,20]);
  const svg=M.thumbnail(doc,gnd.id);
  assert.ok(svg.startsWith("<svg")&&svg.includes('class="pm-copper"')&&svg.includes('class="pm-outline"'));
  assert.ok(!M.thumbnail(doc,bot.id).includes("pm-copper"),"unpoured: outline only");
}
// An empty board.
{
  assert.deepEqual(M.rows(board([]),defs),[]);
  assert.throws(()=>M.repour(board([]),defs,null,{}),/no poured polygons/);
}
console.log("pour-manager ok");
