"use strict";
// IPC-7351B wizard: land equations, goal tables, names and generated library defs.
const assert=require("node:assert/strict");
for(const m of ["model","parts","library-panel","footprint-wizard"])require(require("../support/app-source-paths.cjs").appFile(m));
const W=AtriumFootprintWizard,L=AtriumLibrary;
const near=(a,b,t=1e-6,msg)=>assert.ok(Math.abs(a-b)<=t,(msg||"")+" expected "+b+" got "+a);
const pad=(def,n)=>def.footprint.pads.find(p=>p.number===String(n));
{
  // SOIC-8 (JEDEC MS-012): E 5.80–6.20, L 0.40–1.27, b 0.31–0.51, F 0.10, P 0.05, density B.
  // Zmax = 5.80 + 2·0.35 + √(0.40² + 0.1² + 0.05²) = 6.915 → 6.90
  // S: Smin = 3.26, worst Smax = 5.40, CS(RMS) = √(0.40² + 2·0.87²) = 1.2938, Smax(RMS) = 4.9769
  // Gmin = 4.9769 − 0.70 − √(1.2938² + 0.0125) = 2.978 → 3.00;  Xmax = 0.31 + 0.06 + 0.229 = 0.599 → 0.60
  // These match the published IPC-7351B nominal land for SOIC127P600X175-8N used by KiCad's
  // IPC generator (pads 1.95 × 0.60 at ±2.475 mm).
  const d=W.generate({family:"gullwing",preset:"SOIC-8",density:"B"}),i=d.footprint.ipc;
  assert.equal(d.footprint.name,"SOIC127P600X175-8N");
  near(i.Zraw,6.915331,1e-5,"Z raw");near(i.Graw,2.9783,1e-3,"G raw");near(i.Xraw,.599129,1e-5,"X raw");
  assert.deepEqual([i.Z,i.G,i.X],[6.9,3,.6]);
  const p1=pad(d,1),p8=pad(d,8);
  near(p1.w,1.95);near(p1.h,.6);near(p1.x,-2.475);near(p1.y,-1.905);near(p8.x,2.475);near(p8.y,-1.905);
  assert.equal(d.footprint.pads.length,8);assert.equal(d.footprint.height,1.75);assert.equal(d.prefix,"U");
  // Courtyard = pads/body + 0.25, rounded out to 0.05: x ±3.70, y body max 5.0/2+0.25 = ±2.75.
  assert.deepEqual(d.footprint.courtyard,[-3.7,-2.75,3.7,2.75]);
  assert.ok(d.footprint.shapes.some(s=>s.layer==="Mechanical 15"),"courtyard layer");
  assert.ok(d.footprint.shapes.some(s=>s.layer==="Mechanical 13"&&s.kind==="path"),"assembly outline");
  assert.ok(d.footprint.shapes.some(s=>s.kind==="text"&&s.text===".Designator"),"assembly designator");
  // Densities A and C change toe/heel/side and the courtyard and the name suffix.
  const a=W.generate({family:"gullwing",preset:"SOIC-8",density:"A"}),c=W.generate({family:"gullwing",preset:"SOIC-8",density:"C"});
  assert.equal(a.footprint.name,"SOIC127P600X175-8M");assert.equal(c.footprint.name,"SOIC127P600X175-8L");
  assert.ok(a.footprint.ipc.Z>i.Z&&i.Z>c.footprint.ipc.Z,"Z grows with density A");
  assert.equal(a.footprint.ipc.goal.courtyard,.5);assert.equal(c.footprint.ipc.goal.courtyard,.1);
  const v=L.validateDef(d);assert.ok(v.ok,v.errors.join("; "));
  assert.deepEqual(L.checkFootprint(d.footprint).filter(x=>x.level!=="info").map(x=>x.code),[]);
  console.log("PASS SOIC-8 IPC-7351B worked example: Z 6.90 / G 3.00 / X 0.60, name, courtyard, densities");
}
{
  // 0603 resistor (1608 metric, IPC-SM-782): L 1.50–1.70, W 0.70–0.95, T 0.15–0.40. Table 3-5
  // goals (B): toe 0.35, heel 0, side 0. Z = 1.50 + 0.70 + √(0.2² + 0.0125) = 2.429 → 2.45,
  // G = 1.2531 − 0.4213 = 0.832 → 0.85, X = 0.70 + √(0.25² + 0.0125) = 0.974 → 0.95.
  // (2026-11-19: inputs and heel changed from 0.70–0.90 / 0.15–0.45 / heel −0.05, which gave the
  // same land; both now match IPC-7351B and IPC-SM-782 as KiCad publishes them.)
  // Pads 0.80 × 0.95 at ±0.825 (KiCad R_0603_1608Metric, IPC-7351B nominal).
  const d=W.generate({family:"chip",preset:"0603",kind:"RES"}),i=d.footprint.ipc;
  assert.equal(d.footprint.name,"RESC1608X55N");assert.deepEqual([i.Z,i.G,i.X],[2.45,.85,.95]);
  near(pad(d,1).w,.8);near(pad(d,1).h,.95);near(pad(d,1).x,-.825);near(pad(d,2).x,.825);
  assert.equal(d.prefix,"R");assert.ok(d.symbol?.pins.length===2,"standard resistor symbol");
  assert.equal(W.generate({family:"chip",preset:"0603",kind:"CAP"}).footprint.name,"CAPC1608X55N");
  assert.equal(W.generate({family:"chip",preset:"2512"}).footprint.name,"RESC6332X70N");
  assert.equal(W.generate({family:"chip",preset:"0201"}).footprint.name,"RESC0603X26N");
  // Smaller than 0603 uses the Table 3-6 goals (toe 0.20, heel 0, side 0; no longer flagged since
  // they match KiCad's published IPC-7351B table).
  const s=W.generate({family:"chip",preset:"0402"});assert.equal(s.footprint.ipc.goal.table,"chipSmall");assert.equal(s.footprint.ipc.goal.toe,.2);assert.deepEqual(s.footprint.ipc.flagged,[]);
  for(const k of Object.keys(W.CHIPS)){const x=W.generate({family:"chip",preset:k});assert.ok(L.validateDef(x).ok,k);}
  console.log("PASS 0603 IPC-7351B worked example: Z 2.45 / G 0.85 / X 0.95, RESC names 0201–2512");
}
{
  // Fine pitch uses the ≤0.625 mm side goal. SOT-23-5 name is the classic SOT95P280X145-5N.
  const t=W.generate({family:"gullwing",preset:"TSSOP-14"});assert.equal(t.footprint.ipc.goal.side,.03);assert.equal(t.footprint.name,"SOP65P640X120-14N");
  assert.equal(W.generate({family:"gullwing",preset:"LQFP-48"}).footprint.ipc.goal.side,-.02);
  assert.equal(W.generate({family:"sot23",preset:"SOT-23-5"}).footprint.name,"SOT95P280X145-5N");
  const s3=W.generate({family:"sot23",preset:"SOT-23-3"});assert.equal(s3.prefix,"Q");assert.equal(s3.footprint.pads.length,3);
  assert.ok(pad(s3,3).x>0&&pad(s3,1).x<0&&pad(s3,2).x<0,"SOT-23 pins 1,2 left; 3 right");
  const s223=W.generate({family:"sot223"});assert.equal(s223.footprint.name,"SOT230P700X180-4N");assert.ok(pad(s223,4).h>pad(s223,1).h*3,"SOT-223 tab is wide");
  const q=W.generate({family:"gullwing",preset:"LQFP-64"});assert.equal(q.footprint.name,"QFP50P1200X1200X160-64N");assert.equal(q.footprint.pads.length,64);
  // Pin 1 top of the left side; numbering counter-clockwise: pin 17 starts the bottom row.
  assert.ok(pad(q,1).x<0&&pad(q,1).y<0);assert.ok(pad(q,17).y>0&&pad(q,17).x<0);assert.ok(pad(q,33).x>0&&pad(q,33).y>0);assert.ok(pad(q,49).y<0&&pad(q,49).x>0);
  const sod=W.generate({family:"sod",preset:"SOD-123"});assert.equal(sod.prefix,"D");assert.match(sod.footprint.name,/^SOD\d+X135N$/);
  const melf=W.generate({family:"melf",preset:"MiniMELF"});assert.equal(melf.footprint.name,"DIOMELF3515N");
  console.log("PASS gull-wing fine pitch, SOT-23/-5/-6, SOT-223, QFP numbering, SOD and MELF names");
}
{
  // QFN-32 5×5: exposed pad (number 33), paste reduced to ~60 % and thermal vias tied to it.
  const d=W.generate({family:"nolead",preset:"QFN-32 5×5"}),fp=d.footprint,ep=pad(d,33);
  assert.equal(fp.name,"QFN50P500X500X100-33N");assert.ok(ep.thermal);
  const area=(ep.w+2*ep.pasteExpansion)*(ep.h+2*ep.pasteExpansion)/(ep.w*ep.h);near(area,.6,1e-6,"paste coverage");
  const cov=ep.pasteApertures.reduce((s,a)=>s+a.w*a.h,0)/(ep.w*ep.h);near(cov,.6,1e-6,"window coverage");
  const vias=fp.pads.filter(p=>p.thermalVia);assert.ok(vias.length>=4);assert.ok(vias.every(v=>v.number==="33"&&v.drill===.3));
  assert.equal(fp.ipc.goal.toe,.3);assert.deepEqual(L.checkFootprint(fp).filter(x=>x.level==="error"),[]);
  assert.ok(!L.checkFootprint(fp).some(x=>x.code==="duplicate"),"thermal vias share the EP number without a duplicate warning");
  const dfn=W.generate({family:"nolead",preset:"DFN-8 3×3"});assert.equal(dfn.footprint.name,"SON65P300X300X80-9N");
  const noVia=W.generate({family:"nolead",preset:"QFN-32 5×5",thermalVias:null});assert.ok(!noVia.footprint.pads.some(p=>p.thermalVia));
  console.log("PASS QFN/DFN: exposed pad, 60% paste windows and expansion, thermal vias, SON naming");
}
{
  const b=W.generate({family:"bga",preset:"BGA-256 1.0"}),fp=b.footprint;
  assert.equal(fp.pads.length,256);assert.equal(fp.name,"BGA256C100P16X16_1700X1700X170N");assert.equal(pad(b,"A1").w,.4);
  assert.ok(pad(b,"A1").x<0&&pad(b,"A1").y<0);assert.ok(pad(b,"T16"),"rows skip I, O, Q, S");
  const dep=W.generate({family:"bga",preset:"BGA-144 0.8 (perimeter)"});assert.equal(dep.footprint.pads.length,225-81);assert.ok(!pad(dep,"H8"));
  const list=W.generate({family:"bga",rows:4,cols:4,pitch:.5,ball:.3,D:3,E:3,H:.6,depop:"A1, B2-3"});assert.equal(list.footprint.pads.length,13);
  assert.equal(W.rowName(19),"Y");assert.equal(W.rowName(20),"AA");
  const h=W.generate({family:"header",preset:"2×5 2.54"});assert.equal(h.footprint.pads.length,10);assert.equal(pad(h,1).shape,"rect");
  assert.ok(pad(h,2).x>pad(h,1).x&&pad(h,2).y===pad(h,1).y,"zig-zag numbering across rows");
  assert.ok(pad(h,1).drill>=.9&&pad(h,1).drill<=1.15,"hole for a 0.64 mm square post");assert.equal(h.prefix,"J");
  const dip=W.generate({family:"dip",preset:"DIP-8"});assert.equal(dip.footprint.name,"DIP762W46P254L1106H533Q8N");assert.ok(pad(dip,8).x>0&&pad(dip,8).y<0);
  const smd=W.generate({family:"smdheader"});assert.equal(smd.footprint.pads.length,10);
  for(const f of W.FAMILIES)for(const p of f.presets){const d=W.generate({family:f.id,preset:p});const v=L.validateDef(d,{footprintWarnings:false});assert.ok(v.ok,f.id+" "+p+": "+v.errors.join("; "));
    assert.ok(d.footprint.shapes.some(s=>s.layer==="Mechanical 15"),"courtyard "+p);}
  assert.throws(()=>W.generate({family:"gullwing",preset:"SOIC-8",W:{min:.6,max:.4}}),/valid lead width|valid terminal width/);
  console.log("PASS BGA full/depopulated with JEDEC rows, headers, DIP, SMD header; every preset validates");
}
