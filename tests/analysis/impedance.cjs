"use strict";
// AtriumImpedance closed-form solver against published reference values.
const assert=require("node:assert/strict");
require("../../app/analysis/impedance.js");
const I=AtriumImpedance,mil=.0254;
const near=(a,b,rel,m)=>assert.ok(Math.abs(a-b)<=Math.abs(b)*rel,(m?m+": ":"")+a+" vs "+b+" (±"+(rel*100)+"%)");

// Wheeler (1965) / Hammerstad-Jensen (1980): an air microstrip with w/h = 1
// is 126.5 ohm (H&J's Z01 is within 0.01 % of the exact value for w/h <= 1).
near(I.models.microstrip(1,1,0,1).z,126.5,.002,"air microstrip w/h=1");
// Pozar, Microwave Engineering 4th ed., Example 3.7: 50 ohm on er 2.20,
// d 0.127 cm: W = 0.3916 cm (W/d 3.081), eps_eff 1.87.
{const r=I.solve({structure:"microstrip",w:3.916,h:1.27,er:2.2});near(r.z,50,.01,"Pozar 3.7 Z0");near(r.eeff,1.87,.01,"Pozar 3.7 eps_eff");}
// Pozar Example 3.5: 50 ohm copper stripline, b 0.32 cm, er 2.20: W = 0.266 cm.
{const r=I.solve({structure:"stripline",w:2.66,h1:1.6,h2:1.6,er:2.2});near(r.z,50,.01,"Pozar 3.5 stripline");assert.equal(r.eeff,2.2);}
// Cohn's exact zero-thickness stripline and Wheeler's thick-strip formula agree as t -> 0 (Wheeler 1978: 0.5 %).
for(const w of [.2,.5,1,2])near(I.models.stripWheeler(w,1,1e-9),I.models.stripCohn(w,1),.005,"Wheeler vs Cohn w/b="+w);
// Wadell, Transmission Line Design Handbook 3.4.3 (conductor-backed CPW): as h -> infinity
// it becomes Wen's CPW on a half space, Z = 30 pi / sqrt((er+1)/2) * K(k')/K(k), k = w/(w+2g).
{
  const w=.3,g=.15,er=4.3,k=w/(w+2*g),r=I.models.cpwg(w,1e4,0,er,g);
  near(r.ee,(er+1)/2,.001,"CPW eps_eff");near(r.z,30*Math.PI/Math.sqrt((er+1)/2)/I.kRatio(k),.001,"CPW Z0");
}
// Thickness lowers Z0, solder mask lowers Z0 by 1-3 % (Polar Instruments AP8155 rule of thumb).
{
  const g={structure:"microstrip",w:8*mil,h:5*mil,er:4},thin=I.solve(g),thick=I.solve({...g,t:1.4*mil}),masked=I.solve({...g,t:1.4*mil,cover:{t:.5*mil,er:3.3}});
  assert.ok(thick.z<thin.z);const drop=1-masked.z/thick.z;assert.ok(drop>.01&&drop<.04,"mask drop "+drop);
  // IPC-2141 gives 50.3 ohm for this geometry with its own (less accurate) formula; H&J sits within 10 %.
  near(thick.z,50.26,.1,"IPC-2141 8/5 mil example");
}
// Embedded microstrip: a dielectric cover as thick as h approaches IPC-2141A's
// er' = er (1 - exp(-1.55 (h+c)/h)) within 3 %.
{const er=4,r=I.solve({structure:"microstrip",w:.2,h:.2,er,cover:{t:.2,er}});near(r.eeff,er*(1-Math.exp(-1.55*2)),.03,"embedded microstrip");}
// Edge-coupled lines: Zodd < Z0 < Zeven, Zdiff = 2 Zodd, Zcommon = Zeven / 2,
// coupling vanishes with the gap, and IPC-2141's Zdiff estimates agree within 8 %.
for(const g of [{structure:"microstrip",w:.15,h:.1,t:.035,er:4},{structure:"stripline",w:.127,h1:.2,h2:.2,t:.0175,er:4}]){
  for(const s of [.1,.2,.4]){
    const r=I.solve({...g,s});
    assert.ok(r.zodd<r.z0&&r.z0<r.zeven,"mode order");assert.equal(r.zdiff,2*r.zodd);assert.equal(r.zcommon,r.zeven/2);
    const ipc=g.structure==="microstrip"?2*r.z0*(1-.48*Math.exp(-.96*s/g.h)):2*r.z0*(1-.347*Math.exp(-2.9*s/(g.h1+g.h2+g.t)));
    // IPC-2141's stripline fit is coarse for s/b < 0.4 (it overstates Zdiff by ~11 % against Cohn's exact modes).
    if(g.structure==="microstrip"||s>=.2)near(r.zdiff,ipc,.08,g.structure+" s="+s+" vs IPC-2141");
  }
  const far=I.solve({...g,s:20});near(far.zodd,far.z0,.002,"uncoupled");near(far.zeven,far.z0,.002,"uncoupled even");
}
// Coupled microstrip in the homogeneous limit (er = 1) both modes travel at c.
{const r=I.solve({structure:"microstrip",w:.2,h:.2,er:1,s:.2});near(r.eeffOdd,1,.01);near(r.eeffEven,1,.01);}
// Offset stripline: symmetric when centred; Wadell's parallel-combination model otherwise.
{
  const sym=I.solve({structure:"stripline",w:.15,h1:.2,h2:.2,t:.035,er:4}),off=I.solve({structure:"stripline",w:.15,h1:.15,h2:.25,t:.035,er:4});
  assert.match(sym.model,/^Symmetric/);assert.match(off.model,/^Offset/);assert.ok(off.z<sym.z);
}
// Delay: ps/mm = sqrt(eps_eff) / c. Stripline in er 4 is 6.67 ps/mm.
near(I.solve({structure:"stripline",w:.15,h1:.2,h2:.2,er:4}).delay,2/.299792458,1e-9,"stripline delay");
// Kirschning-Jansen dispersion: eps_eff rises with frequency toward er.
{const r=I.solve({structure:"microstrip",w:.3,h:.2,er:4.3,freq:1}),hi=I.dispersion(r.eeff,4.3,1.5,.2,40);assert.ok(r.eeffDispersed>=r.eeff&&hi>r.eeffDispersed&&hi<4.3);}
// Losses: positive, conductor loss falls with width, dielectric loss scales with Df.
{
  const a=I.solve({structure:"microstrip",w:.15,h:.1,t:.035,er:4,freq:5}),b=I.solve({structure:"microstrip",w:.3,h:.1,t:.035,er:4,freq:5});
  assert.ok(a.loss.conductor>b.loss.conductor&&a.loss.dielectric>0);
  near(I.solve({structure:"stripline",w:.15,h1:.2,h2:.2,er:4,tanD:.01,freq:1}).loss.dielectric,8.686*2*Math.PI*1e9/299792458*2*.01/2/1000,1e-6,"stripline dielectric loss");
}
// Synthesis: width and gap for a target, honouring limits.
{
  const g={structure:"microstrip",h:.2,t:.035,er:4.2},w=I.synthesize(g,{target:50});
  assert.ok(w.ok);near(I.solve({...g,w:w.w}).z,50,1e-6);
  const d=I.synthesize({structure:"stripline",h1:.2,h2:.2,t:.0175,er:4,w:.12},{target:90,vary:"s"});
  assert.ok(d.ok);near(d.result.zdiff,90,1e-6);
  const c=I.synthesize(g,{target:50,min:.5,max:2});assert.equal(c.ok,false);assert.equal(c.clamped,true);assert.equal(c.w,.5);
  const bad=I.synthesize(g,{target:50,min:.3,max:.05});assert.equal(bad.ok,false);assert.match(bad.error,/maximum must be above/);
  // Other dimensions: dielectric height (Z rises with h), coplanar ground gap, stripline side.
  const h=I.synthesize({...g,w:.2},{target:75,vary:"h"});assert.ok(h.ok&&h.h>.2);near(I.solve({...g,w:.2,h:h.h}).z,75,1e-6);
  const cg=I.synthesize({...g,w:.3},{target:45,vary:"g",min:.05,max:5});assert.ok(cg.ok);near(I.solve({...g,w:.3,g:cg.g}).z,45,1e-6);
  const h2=I.synthesize({structure:"stripline",h1:.2,h2:.3,t:.0175,er:4,w:.12},{target:45,vary:"h2"});assert.ok(h2.ok&&h2.h2<.3);
  assert.match(I.synthesize({...g,w:.2},{target:60,vary:"h",min:.3,max:.1}).error,/dielectric height maximum/);
}
// Stack geometry: microstrip under solder mask, stripline between planes, chosen references.
{
  const L=[{type:"Solder Mask",thickness:.01,dk:3.5},{type:"Signal",key:"Top",thickness:.035,name:"Top"},{type:"Dielectric",thickness:.2,dk:4.2},
    {type:"Plane",key:"Inner 1",thickness:.035,name:"GND"},{type:"Dielectric",thickness:.3,dk:4.6},{type:"Signal",key:"Inner 2",thickness:.0175,name:"S"},
    {type:"Dielectric",thickness:.2,dk:4.2},{type:"Signal",key:"Bottom",thickness:.035,name:"Bottom"}];
  const top=I.geometry(L,"Top");assert.equal(top.structure,"microstrip");assert.equal(top.h,.2);near(top.cover.t,.01,1e-12);near(top.cover.er,3.5,1e-12);assert.equal(top.refBottom,"Inner 1");
  const mid=I.geometry(L,"Inner 2");assert.equal(mid.structure,"stripline");assert.equal(mid.h1,.3);assert.equal(mid.h2,.2);near(mid.er,(.3*4.6+.2*4.2)/.5,1e-12);
  const skip=I.geometry(L,"Bottom",["Inner 1",null]);assert.equal(skip.structure,"microstrip");near(skip.h,.3+.0175+.2,1e-12,"reference skips a layer");
  assert.equal(I.geometry(L,"Top",[null,null]).structure,"none");
}
// Speed: a differential solve is a few microseconds.
{const t0=Date.now();for(let i=0;i<20000;i++)I.solve({structure:"microstrip",w:.1+i*1e-6,h:.1,t:.035,er:4,s:.15});assert.ok(Date.now()-t0<1500);}
// ---------------------------------------------------------------- accuracy against a 2D field solver
// Reference values from an independent 2D quasi-static finite-difference
// Laplace solver (graded mesh, PCG, energy capacitance; within 0.3 % of Cohn's
// exact t = 0 coupled stripline), from the rigid-flex/impedance review
//. Fixed tables, no runtime dependency.
// The tables print their worst error so the achieved accuracy stays visible.
const pct=(a,b)=>(a/b-1)*100,acc={};
const track=(name,e)=>{acc[name]=Math.max(acc[name]||0,Math.abs(e));};
// Edge-coupled symmetric stripline with thickness: [w, h, t, s, Zodd, Zeven] in air
// (b = 2h + t). 34 points off the correction-table grid; the first five are the
// review's (old model: Zodd -3 to -9 %).
{
  const FD=[[0.1,0.1,0.035,0.1,71.8741,92.7704],[0.2797,0.0767,0.0175,0.2547,39.0568,39.2015],[0.3232,0.1518,0.0175,0.1672,56.0156,62.0131],[0.0879,0.1238,0.07,0.236,83.2619,93.3787],[0.3181,0.1346,0.0175,0.1113,50.3859,58.4843],[0.1,0.1,0.035,0.2,80.2794,85.7208],[0.1499,0.2121,0.07,0.1183,68.9593,118.989],[0.3293,0.2223,0.07,0.068,44.5325,83.775],[0.1022,0.0836,0.035,0.2833,73.5729,74.3916],[0.316,0.1357,0.035,0.3932,53.1981,53.7331],[0.2596,0.176,0.0175,0.067,58.1383,87.0121],[0.15,0.15,0.0175,0.15,83.2513,99.87],[0.3452,0.1151,0.07,0.1021,37.013,45.9043],[0.157,0.2135,0.07,0.0871,60.7268,121.4345],[0.2373,0.2164,0.035,0.2116,77.0238,93.61],[0.2575,0.1516,0.07,0.1239,51.7481,69.1292],[0.3286,0.1925,0.07,0.2855,59.6065,66.0754],[0.1,0.1,0.035,0.05,58.85,101.0765],[0.1299,0.1259,0.0175,0.1086,78.6257,98.9888],[0.1228,0.1793,0.035,0.1122,81.1719,124.0411],[0.2162,0.0895,0.0175,0.0842,49.0157,56.2852],[0.2872,0.1211,0.035,0.2401,51.4104,53.3799],[0.2,0.1,0.07,0.2,51.4515,55.5693],[0.325,0.2047,0.0175,0.1335,63.1045,79.7332],[0.2092,0.2245,0.0175,0.2983,92.2448,102.4872],[0.1187,0.0974,0.035,0.1322,69.7635,80.6182],[0.1392,0.1175,0.035,0.2748,76.7344,79.4579],[0.0784,0.1245,0.035,0.0936,81.7326,121.5729],[0.3343,0.0895,0.07,0.0626,29.5025,39.0185],[0.142,0.2145,0.07,0.2704,88.8369,108.4907],[0.1634,0.1657,0.035,0.2595,84.0708,92.3797],[0.2695,0.1612,0.0175,0.2543,67.3312,71.2906],[0.2665,0.0956,0.035,0.0663,40.0012,50.474],[0.059,0.1164,0.07,0.2076,89.4689,104.1617]];
  for(const [w,h,t,s,zo,ze] of FD){
    const b=2*h+t,r=I.solve({structure:"stripline",w,h1:h,h2:h,t,er:1,s}),out=t/b>.25;
    const eo=pct(r.zodd,zo),ee=pct(r.zeven,ze),lim=out?1.3:.75;
    track(out?"cstrip t/b>0.25":"cstrip",Math.max(Math.abs(eo),Math.abs(ee)));
    assert.ok(Math.abs(eo)<=lim&&Math.abs(ee)<=lim,"coupled stripline w "+w+" h "+h+" t "+t+" s "+s+": Zodd "+eo.toFixed(2)+" %, Zeven "+ee.toFixed(2)+" %");
    if(out)assert.ok(r.warnings.some(x=>/calibrated range/.test(x)),"extrapolation warns");
    else assert.ok(!r.warnings.some(x=>/calibrated range/.test(x)));
  }
  // Dielectric scales the air values exactly (homogeneous stripline).
  const a=I.solve({structure:"stripline",w:.1,h1:.1,h2:.1,t:.035,er:1,s:.1}),k=I.solve({structure:"stripline",w:.1,h1:.1,h2:.1,t:.035,er:4,s:.1});
  near(k.zodd,a.zodd/2,1e-12);
  // Zero thickness stays Cohn's exact solution; a far pair is the single line.
  const c=I.models.coupledStripAir(.3,1,0,.2),k1=Math.tanh(Math.PI*.3/2),k2=Math.PI*.5/2;
  near(c.odd,30*Math.PI/I.kRatio(k1/Math.tanh(k2)),1e-12);near(c.even,30*Math.PI/I.kRatio(k1*Math.tanh(k2)),1e-12);
  const far=I.models.coupledStripAir(.3,1,.1,8);near(far.odd,far.single,.001);near(far.even,far.single,.001);
}
// Coupled microstrip, zero thickness: [u, g, er, Zodd, Zeven, eeOdd, eeEven] (h = 1).
// Kirschning & Jansen 1984; the old Garg-Bahl fit was up to 7.4 % off here.
{
  const FD=[[0.63,0.1,10,30.46,83.34,5.582,6.878],[0.25,2,2,153.08,176.07,1.54,1.632],[1,1,4.4,60.5,80.54,2.884,3.389],[0.1,0.316,2,135.53,282.36,1.503,1.603],[1,0.2,4.4,43.75,92.04,2.781,3.367],[0.5,0.5,4.4,68.94,119.78,2.757,3.233],[2,0.5,4.4,38.48,56.65,2.964,3.586],[1.5,1.5,3.5,57.72,69.04,2.486,2.824],[0.3,0.15,4.4,59.37,163.26,2.713,3.108],[5,4,2,35.91,37.87,1.749,1.814],[0.13,2.5,10,96.5,103.44,5.824,6.325]];
  for(const [u,g,er,zo,ze,eo,ee] of FD){
    const r=I.solve({structure:"microstrip",w:u,h:1,er,s:g});
    const e=[pct(r.zodd,zo),pct(r.zeven,ze),pct(r.eeffOdd,eo),pct(r.eeffEven,ee)];
    track("cmicro t=0",Math.max(...e.map(Math.abs)));
    assert.ok(e.every(x=>Math.abs(x)<=.5),"KJ u "+u+" g "+g+" er "+er+": "+e.map(x=>x.toFixed(2)).join(" "));
  }
}
// Coupled microstrip with thickness: [w, h, t, s, er, Zodd, Zeven, eeOdd, eeEven].
// CAL set the 0.75 air gap-wall factor in coupledMicro; HOLD was not used for it.
{
  const CAL=[[0.1,0.1,0.035,0.1,4.4,50.3617,74.7275,2.47928,3.20754],[0.5,0.25,0.035,0.25,4,41.5827,54.9955,2.65615,3.21877],[0.15,0.1,0.035,0.15,4.4,46.0961,58.5145,2.70872,3.31781],[0.08,0.1,0.035,0.1,3.4,59.8199,91.8291,2.00763,2.52189],[0.2,0.1,0.035,0.1,4.4,37.3521,51.5724,2.71065,3.45302],[0.25,0.1,0.07,0.3,4.2,36.7624,41.3141,2.82347,3.21397],[0.1,0.1,0.0175,0.2,4.4,60.8835,71.2004,2.77601,3.21097],[0.1,0.05,0.0175,0.08,3.5,44.252,54.8503,2.35103,2.78766],[0.3,0.2,0.035,0.15,3.5,47.1374,70.7464,2.24553,2.77983],[0.4,0.2,0.035,0.4,4.4,43.1595,49.6353,2.98811,3.43823],[0.12,0.1,0.035,0.05,4,40.2639,76.5248,2.19226,3.01254],[0.2,0.15,0.035,0.6,4.4,55.3792,58.7415,2.94755,3.17215]],HOLD=[[0.15,0.1,0.035,0.12,3,51.3335,70.6903,1.97796,2.39054],[0.1,0.1,0.035,0.15,10,38.9031,49.2445,5.13458,6.6421],[0.3,0.2,0.07,0.2,4.4,42.74,60.9298,2.60493,3.34781],[0.2,0.1,0.018,0.1,2.2,51.6247,71.2027,1.65479,1.89495],[0.6,0.3,0.035,0.3,3.5,44.3131,58.5979,2.39781,2.85928],[0.07,0.075,0.0175,0.075,3.8,57.4657,83.5918,2.28813,2.8409]];
  for(const [set,FD,lz,le] of [["cal",CAL,1.2,.8],["hold-out",HOLD,.8,1]])for(const [w,h,t,s,er,zo,ze,eo,ee] of FD){
    const r=I.solve({structure:"microstrip",w,h,t,er,s});
    const ez=[pct(r.zodd,zo),pct(r.zeven,ze)],eE=[pct(r.eeffOdd,eo),pct(r.eeffEven,ee)];
    track("cmicro t>0 "+set+" Z",Math.max(...ez.map(Math.abs)));track("cmicro t>0 "+set+" eeff",Math.max(...eE.map(Math.abs)));
    assert.ok(ez.every(x=>Math.abs(x)<=lz)&&eE.every(x=>Math.abs(x)<=le),set+" w "+w+" h "+h+" t "+t+" s "+s+" er "+er+": "+[...ez,...eE].map(x=>x.toFixed(2)).join(" "));
  }
  // A wide gap gives the H&J thick single line.
  const g={structure:"microstrip",w:.2,h:.1,t:.035,er:4.4},one=I.solve(g),far=I.solve({...g,s:50});
  near(far.zodd,one.z,.002,"far pair Zodd");near(far.eeffOdd,one.eeff,.003,"far pair eeff");
  assert.ok(I.solve({...g,s:.005}).warnings.some(x=>/Kirschning-Jansen range/.test(x)));
  assert.ok(I.solve({structure:"microstrip",w:.01,h:.1,t:.07,er:4.4}).warnings.some(x=>/narrower than its thickness/.test(x)),"w < t warns");
}
// Microstrip conductor loss: Wheeler's incremental-inductance rule on an
// independent H&J transcription (review scratch ref.cjs), dB/m:
// [w, h, t, er, f GHz, dB/m]. The old parallel-plate formula was 1.3-3x high.
{
  const REF=[[0.2,0.1,0.035,4.4,1,3.4415],[0.05,0.1,0.035,4.4,1,3.9834],[0.1,0.1,0.035,4.4,10,11.4571],[1,0.1,0.035,4.4,1,3.5118],[3,1.6,0.035,2.2,1,0.2133],[0.15,0.1,0.0175,3.5,5,7.8419],[5,0.1,0.035,4,1,3.6082]];
  for(const [w,h,t,er,f,db] of REF){
    const r=I.solve({structure:"microstrip",w,h,t,er,freq:f,tanD:0});
    const e=pct(r.loss.conductor*1000,db);track("microstrip loss",e);
    assert.ok(Math.abs(e)<=1,"loss w "+w+" h "+h+" f "+f+": "+e.toFixed(2)+" %");
  }
  // Bogatin's rule of thumb, 36 / (w[mil] Z0) sqrt(f[GHz]) dB/in: 3.97 dB/m here.
  const r=I.solve({structure:"microstrip",w:.2,h:.1,t:.035,er:4.4,freq:1,tanD:0});near(r.loss.conductor*1000,36/(.2/.0254*r.z)/.0254,.2,"Bogatin");
  // Stripline loss uses the same incremental rule (the review found Pozar's stripline formula agrees within 1 %).
  const sl=I.solve({structure:"stripline",w:.2,h1:.2325,h2:.2325,t:.035,er:4,freq:1,tanD:0});assert.ok(sl.loss.conductor>0);
  // Roughness: Hammerstad-Jensen factor, 1 + (2/pi) atan(1.4 (rough/skin)^2), at most 2.
  const skin=1e3/Math.sqrt(Math.PI*1e9*4e-7*Math.PI*5.8e7),smooth=I.solve({structure:"microstrip",w:.2,h:.1,t:.035,er:4.4,freq:1});
  const rough=I.solve({structure:"microstrip",w:.2,h:.1,t:.035,er:4.4,freq:1,rough:skin});
  near(rough.loss.conductor/smooth.loss.conductor,1+2/Math.PI*Math.atan(1.4),1e-9,"roughness factor");
  assert.ok(I.solve({structure:"microstrip",w:.2,h:.1,t:.035,er:4.4,freq:1,rough:1}).loss.conductor<2.0001*smooth.loss.conductor);
}
console.log("Accuracy (max |error| %): "+Object.entries(acc).map(([k,v])=>k+" "+v.toFixed(2)).join(" · "));
console.log("PASS impedance: H&J, Pozar 3.5/3.7, Cohn/Wheeler, CPWG, coupled lines, offset stripline, dispersion, loss, synthesis, stack geometry; field-solver accuracy tables.");
