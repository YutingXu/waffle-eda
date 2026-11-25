"use strict";
// Make each preamble and payload from numbers here, independently of the reader.
const assert = require("node:assert/strict"), Raw = require("../../extensions/spice/raw.js");
const design = {nodeMap: {OUT: "Output bus"}, elements: [{line: "V1 OUT 0 5"}]};
const columns = [["frequency", "frequency"], ["v(out)", "voltage"], ["v1#branch", "current"]];
const ac = {type: "ac", sweep: "lin", points: 2, fstart: 10, fstop: 20};
function record({plot, flags, vars, points, wide = false, ascii = false, payload}) {
  const header = ["Title: Bench", "Plotname: " + plot, "Flags: " + flags, "No. Variables: " + vars.length,
    "No. Points: " + points, "Variables:", ...vars.map(([n,k],i) => i + "\t" + n + "\t" + k), ascii ? "Values:" : "Binary:"].join("\r\n") + "\r\n";
  const bytes = [];
  const text = s => { for (const c of s) { const v = c.charCodeAt(0); bytes.push(v & 255); if (wide) bytes.push(v >> 8); } };
  if (wide) bytes.push(255,254);
  text(header);
  if (ascii) text(payload); else for (const [value,size] of payload) {
    const b = new ArrayBuffer(size), dv = new DataView(b);
    if (size === 8) dv.setFloat64(0,value,true); else dv.setFloat32(0,value,true);
    bytes.push(...new Uint8Array(b));
  }
  return Uint8Array.from(bytes);
}
const values = [[10,0,1,-2,0.5,0.25],[20,0,3,4,-0.25,0]];
for (const engine of ["ngspice","ltspice"]) {
  const bytes = record({plot:"AC Analysis", flags:"complex forward", vars:columns, points:2, wide:engine === "ltspice",
    payload:values.flat().map(n => [n,8])});
  const res = Raw.parse(bytes,engine,ac,design);
  assert.deepEqual(res.x,[10,20]); assert.deepEqual(res.signals.map(s => s.name),["v(OUT)","i(V1)"]);
  assert.deepEqual(res.signals[0].re,[1,3]); assert.deepEqual(res.signals[0].im,[-2,4]);
  assert.throws(() => Raw.parse(bytes.subarray(0,bytes.length-1),engine,ac),/binary size/);
  assert.throws(() => Raw.parse(bytes,engine,{type:"tran"}),/selected analysis/);
}
const ascii = data => record({plot:"AC Analysis", flags:"complex", vars:columns, points:2, ascii:true, payload:data});
const complexText = "0\t10,0\n\t1,-2\n\t0.5,0.25\n1\t20,0\n\t3,4\n\t-0.25,0\n";
assert.deepEqual(Raw.parse(ascii(complexText),"ngspice",ac).signals[1].im,[0.25,0]);
assert.throws(() => Raw.parse(ascii(complexText.replace("1\t20","2\t20")),"ngspice",ac),/index/);
assert.throws(() => Raw.parse(ascii(complexText.slice(0,-5)),"ngspice",ac),/ASCII/);
assert.throws(() => Raw.parse(ascii(complexText + "2 30,0"),"ngspice",ac),/more ASCII/);
assert.throws(() => Raw.parse(ascii(complexText.replace("1,-2","NaN,-2")),"ngspice",ac),/non-finite/);
for (const width of [4,8]) {
  const fast = record({plot:"Transient Analysis", flags:"real forward FastAccess", vars:[["time","time"],["V(OUT)","voltage"]], points:3, wide:true,
    payload:[[-0.125,8],[0.25,8],[0.5,8],[2,width],[4,width],[8,width]]});
  const res = Raw.parse(fast,"ltspice",{type:"tran"});
  assert.deepEqual(res.x,[0.125,0.25,0.5]); assert.deepEqual(res.signals[0].re,[2,4,8]);
}
const op = record({plot:"Operating Point",flags:"real",vars:columns.slice(1),points:1,wide:true,payload:[[3.25,4],[-0.5,4]]});
assert.equal(Raw.parse(op,"ltspice",{type:"op"},design).nodes.OUT,3.25);
// A UTF-16 title holding U+0A0A (both bytes 0x0A) is one line, not a line break.
const titled = record({plot:"Operating Point",flags:"real",vars:columns.slice(1),points:1,wide:true,payload:[[1.5,4],[-0.5,4]]});
const at = titled.indexOf(66); titled[at] = 10; titled[at + 1] = 10; // "Bench" -> "\u0a0aench"
assert.equal(Raw.parse(titled,"ltspice",{type:"op"},design).nodes.OUT,1.5);
// Truncated, empty and garbage inputs fail with a rawfile error, never a crash or a hang.
for (const bad of [new Uint8Array(0), new Uint8Array([255,254]), Uint8Array.from("Title: x\nBinary:\n", c => c.charCodeAt(0)), op.subarray(0, 40), new Uint8Array(4096).fill(10)])
  assert.throws(() => Raw.parse(bad,"ltspice",{type:"op"}),/Invalid SPICE rawfile/);
const tooLarge = record({plot:"Transient Analysis",flags:"real",vars:columns,points:2000000,payload:[]});
assert.throws(() => Raw.parse(tooLarge,"ngspice",{type:"tran"}),/excessive/);
console.log("SPICE rawfiles: generated ASCII, binary, mixed/planar, complex and malformed samples OK");
