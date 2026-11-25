"use strict";
const assert=require("node:assert/strict");
require("../../app/notebook/sketch-shapes.js");
require("../../app/notebook/sch-note-ink.js");
const S=AtriumSketchShapes,{capture}=AtriumSchNoteInk,TAU=Math.PI*2,scale=5,width=.55;
const ring=(rx,ry,n=64,start=.42,turn=TAU)=>Array.from({length:n+1},(_,j)=>{
  const a=start+turn*j/n;return [12+rx*Math.cos(a),-8+ry*Math.sin(a),Math.round(25+200*j/n)];
});
function poly(vertices,subdivisions=6) {
  return [vertices[0],...vertices.slice(1).flatMap((b,i)=>Array.from({length:subdivisions},(_,j)=>{
    const t=(j+1)/subdivisions,a=vertices[i];return [a[0]+(b[0]-a[0])*t,a[1]+(b[1]-a[1])*t];
  }))].map((p,j)=>[...p,Math.round(30+200*j/((vertices.length-1)*subdivisions))]);
}
const rectangle=poly([[0,0],[13,0],[13,8],[-6,8],[-6,0],[0,0]]);
const rot=p=>{const a=.32,c=Math.cos(a),s=Math.sin(a);return [100+c*p[0]-s*p[1],5000+s*p[0]+c*p[1],p[2]];};
const line=Array.from({length:41},(_,i)=>[20+i*.5,2+i*.2+.13*Math.sin(i/4),i===13?245:40+i]);
function snap(points,kind) {
  const fit=S.fit(points,{scale,width});assert.equal(fit?.kind,kind,JSON.stringify(points.slice(0,3)));
  const drawn=capture("pen",width);drawn.append(points.map(p=>({world:p,pressure:p[2]/255})));
  const captured=drawn.finish(),shape=S.project(fit,captured);
  assert.ok(shape.every(p=>p.length===3&&p.every(Number.isFinite)&&Number.isInteger(p[2])));
  assert.equal(shape[0][2],captured[0][2]);assert.equal(shape.at(-1)[2],captured.at(-1)[2]);
  return shape;
}
const snapped=snap(line,"line");
assert.ok(Math.max(...snapped.map(p=>p[2]))>130);
for(const p of snapped)assert.ok(Math.abs((p[0]-snapped[0][0])*(snapped.at(-1)[1]-snapped[0][1])-(p[1]-snapped[0][1])*(snapped.at(-1)[0]-snapped[0][0]))<1e-7);
const flat=line.map(p=>[p[0],p[1],128]);assert.equal(snap(flat,"line").length,2);
const extended=Array.from({length:18000},(_,i)=>[i/100,0,i===6040?255:80]);
const straight=S.fit([extended[0],extended.at(-1)],{width,scale});
const compact=S.project(straight,extended.slice(16000),[extended.slice(0,16001)]);
assert.deepEqual(compact,S.project(straight,extended));
assert.equal(Math.max(...compact.map(p=>p[2])),255,"keep pressure from earlier capture chunks");
assert.ok(compact.some(p=>Math.abs(p[0]-60.39)<1e-8&&p[2]===80));
assert.ok(compact.some(p=>Math.abs(p[0]-60.41)<1e-8&&p[2]===80));
assert.ok(compact.length<10);
for(const p of [rectangle,rectangle.map(rot),rectangle.slice().reverse().map(rot)]){
  const result=snap(p,"rectangle");assert.ok(Math.hypot(result[0][0]-result.at(-1)[0],result[0][1]-result.at(-1)[1])<1e-6);
}
for(const turn of [TAU,-TAU]){
  const p=ring(9,9,72,.71,turn),out=snap(p,"circle");
  assert.ok(out.length<=192);assert.deepEqual(out[0].slice(0,2),out.at(-1).slice(0,2));
  const radii=out.map(q=>Math.hypot(q[0]-12,q[1]+8));assert.ok(Math.max(...radii)-Math.min(...radii)<.04);
}
for(const bad of [
  [[0,0,128],[1,0,128]],poly([[0,0],[12,0],[11,4],[0,0]]),ring(10,7),
  ring(8,8,50,0,Math.PI*1.65),ring(8,8,70,0,2*TAU),ring(8,8,8),
  poly([[0,0],[10,0],[0,5],[10,5]]),poly([[0,0],[10,0],[5,0],[12,0]]),
  poly([[0,0],[10,0],[10,8],[0,0]])
])assert.equal(S.fit(bad,{scale,width}),null,"ordinary ambiguous path stays freehand");
console.log("PASS deliberate shape geometry, rotated rectangles, clockwise and reverse circles, compact pressure and ambiguous freehand");
