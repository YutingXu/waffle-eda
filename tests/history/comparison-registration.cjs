"use strict";
const assert = require("node:assert/strict");
for (const name of ["model","sch-objects","hierarchy","multichannel","component-match","board-shape","diff","project-history-summary"])
  require(require("../support/app-source-paths.cjs").appFile(name+".js"));
const A = Atrium, D = AtriumDiff;
const base = A.project("Assembly",[]), board = base.documents[1];
const shape = {kind:"path",style:"silk",layer:"Silk",width:.1,points:[[0,0],[1,0]]};
base.library = [{id:"pkg",name:"Package",footprint:{name:"Package",pads:[],shapes:[shape]}}];
board.outline = [[0,0],[40,0],[40,30],[0,30]];
const positions = [[2,3],[20,3],[30,15],[5,20]];
board.items = positions.map(([x,y],i) => ({kind:"part",id:"p"+i,ref:"R"+i,def:"pkg",value:"100",x,y,angle:0,layer:"Top",pinNets:{},link:"link"+i}));
board.items.push({kind:"track",id:"trace",points:[[1,1],[9,1]],width:.2,net:"DATA",layer:"Top"},
  {kind:"via",id:"via",x:8,y:1,diameter:.6,drill:.2,net:"DATA",layer:"Multi"});
function shift(p,dx,dy) {
  const copy=A.clone(p), d=copy.documents[1], point=([x,y])=>[x+dx,y+dy];
  d.outline=d.outline.map(point);
  for (const i of d.items) {
    if (i.points) i.points=i.points.map(point);
    else {i.x+=dx;i.y+=dy;}
  }
  return copy;
}
const moved=shift(base,50,-10), result=D.compare(base,moved);
assert.deepEqual(result.changes.map(c=>c.kind),["board.translated"]);
const move=result.changes[0];
assert.deepEqual([move.translation.dx,move.translation.dy,move.translation.objects,move.translation.anchors],[50,-10,6,4]);
assert.deepEqual(result.byObject.trace,[0]);
assert.equal(D.toJSON(result,{limit:1}).changes[0].translation.objects,6);
assert.match(AtriumHistorySummary.fromProjects(base,moved).text,/Board translated/);
assert.equal(D.compare(moved,base).changes[0].translation.dx,-50);
assert.ok(D.compare(base,moved,{groupBoardMoves:false}).summary.byKind["part.moved"]===4);
const changed=A.clone(moved), d=changed.documents[1];
d.items[0].value="200";d.items[3].x+=1;d.items[4].width=.35;d.items[5].net="RETURN";
const delta=D.compare(base,changed), reverse=D.compare(changed,base);
assert.ok(delta.changes.some(c=>c.kind==="part.value"&&c.target.ref==="R0"));
assert.ok(delta.changes.some(c=>c.kind==="part.moved"&&c.target.ref==="R3"&&c.text.includes("relative to the board")));
assert.ok(delta.changes.some(c=>c.kind==="track.property"&&c.fields.includes("width")));
assert.ok(delta.changes.some(c=>c.kind==="via.net"));
assert.deepEqual(delta.summary.byKind,reverse.summary.byKind);
const perPart=delta.changes.find(c=>c.kind==="board.translated");
assert.equal(perPart.translation.objects,5);
assert.ok(!delta.byObject.p3.includes(delta.changes.indexOf(perPart)));
const within=A.clone(moved);within.documents[1].outline=A.clone(board.outline);
assert.ok(!D.compare(base,within).summary.byKind["board.translated"],"components moved within a stationary perimeter");
const partial=A.clone(moved);partial.documents[1].items[0].x-=50;partial.documents[1].items[1].x-=50;
assert.ok(!D.compare(base,partial).summary.byKind["board.translated"]);
const B=AtriumBoardShape;
const exact=A.clone(base), exactBoard=exact.documents[1];
const outline=B.polySegments(exactBoard.outline,true);
const h1=[B.arc([10,9],1,0,180,true),B.arc([10,9],1,180,360,true)];
const h2=B.polySegments([[20,8],[23,8],[23,10],[20,10]],true);
exactBoard.boardShape={version:1,contour:outline,cutouts:[h1,h2]};
const rearranged=shift(exact,50,-10), rearrangedBoard=rearranged.documents[1];
rearrangedBoard.boardShape=B.translate(exactBoard.boardShape,50,-10);
const rings=rearrangedBoard.boardShape.cutouts;
rings.reverse();
rings[0]=rings[0].slice(1).concat(rings[0][0]);
rings[1]=rings[1].reverse().map(B.reverse);
for(const [a,b] of [[exact,rearranged],[rearranged,exact]]) assert.deepEqual(D.compare(a,b).changes.map(c=>c.kind),["board.translated"]);
rings[1][0].r+=.1;
assert.ok(D.compare(exact,rearranged).summary.byKind["board.shape"],"a real change to one curved cutout remains visible");
const reordered=A.clone(base), oldShapes=base.library[0].footprint.shapes, newShapes=reordered.library[0].footprint.shapes;
const copper={...shape,layer:"Top",style:"body"}, body={...shape,layer:undefined,style:"package"};
oldShapes.push(copper,body);newShapes.splice(0,newShapes.length,body,copper,shape);
const session=D.session(base);
const first=session.compare(reordered);
assert.equal(first.summary.total,0);
assert.equal(first.stats.prepared.before.footprints,1);
assert.equal(session.compare(reordered).stats.prepared.before.footprints,0);
newShapes[1]={...copper,width:.25};
assert.deepEqual(session.compare(reordered).summary.byKind,D.compare(base,reordered).summary.byKind);
assert.ok(session.compare(reordered).summary.byKind["library.footprint"]);
const negative={...shape,negative:true}, dark={...shape,style:"body",layer:"Silk"};
for (const paint of [negative,dark,{...shape,fill:true}]) {
  const a=A.clone(base), b=A.clone(base);
  a.library[0].footprint.shapes=[shape,paint];b.library[0].footprint.shapes=[paint,shape];
  assert.equal(D.compare(a,b).summary.byKind["library.footprint"],1);
}
console.log("PASS board registration, absolute frames, retained physical exceptions, mixed footprint artwork and revision-scoped caching");
