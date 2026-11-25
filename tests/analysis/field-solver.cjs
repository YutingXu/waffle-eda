"use strict";
// AtriumFieldSolver (2D finite-difference quasi-static solver) against exact and
// published reference values, and against the closed-form AtriumImpedance models.
const assert=require("node:assert/strict");
require("../../app/analysis/impedance.js");
require("../../app/analysis/field-solver.js");
const F=AtriumFieldSolver,I=AtriumImpedance,mil=.0254;
const near=(a,b,rel,m)=>assert.ok(Math.abs(a-b)<=Math.abs(b)*rel,(m?m+": ":"")+a+" vs "+b+" (±"+(rel*100)+"%)");
const ok=r=>{assert.ok(r.ok,r.error);return r;};

// Wheeler (1965) exact conformal map for an air microstrip, w/h = 1: 126.5 ohm
// (Hammerstad & Jensen's Z01 is within 0.01 % of it for w/h <= 1).
near(ok(F.solve({structure:"microstrip",w:1,h:1,er:1})).z,126.51,.01,"air microstrip w/h=1");
// Pozar, Microwave Engineering 4th ed., Example 3.7: er 2.2, d 1.27 mm, W 3.916 mm -> 50 ohm, eps_eff 1.87.
{const r=ok(F.solve({structure:"microstrip",w:3.916,h:1.27,er:2.2}));near(r.z,50,.015,"Pozar 3.7 Z0");near(r.eeff,1.87,.015,"Pozar 3.7 eps_eff");assert.ok(Math.abs(r.delay-Math.sqrt(r.eeff)/.299792458)<1e-9);}
// Pozar Example 3.5: stripline b 3.2 mm, er 2.2, W 2.66 mm -> 50 ohm.
{const r=ok(F.solve({structure:"stripline",w:2.66,h1:1.6,h2:1.6,er:2.2}));near(r.z,50,.01,"Pozar 3.5 stripline");near(r.eeff,2.2,1e-9);}
// Cohn (1954) exact zero-thickness symmetric stripline.
for(const w of [.1,.3,1,3])near(ok(F.solve({structure:"stripline",w,h1:.5,h2:.5,er:1})).z,I.models.stripCohn(w,1),.01,"Cohn w/b="+w);
// Cohn (1955) exact zero-thickness edge-coupled stripline, even and odd modes.
for(const [w,s] of [[.2,.1],[.5,.3],[1,.5]]){
  const r=ok(F.solve({structure:"coupled-stripline",w,s,h1:.5,h2:.5,er:3})),c=I.models.coupledStripAir(w,1,0,s);
  near(r.zodd,c.odd/Math.sqrt(3),.015,"Cohn odd w="+w+" s="+s);near(r.zeven,c.even/Math.sqrt(3),.015,"Cohn even w="+w+" s="+s);
  assert.equal(r.zdiff,2*r.zodd);assert.equal(r.zcommon,r.zeven/2);near(r.eeffOdd,3,1e-6);near(r.eeffEven,3,1e-6);
}
// Wheeler (1978) thick-strip stripline (stated within 0.5 % for w/(b-t) > 0.1).
for(const [w,t] of [[.2,.05],[.5,.1],[1,.2]])near(ok(F.solve({structure:"stripline",w,h1:(1-t)/2,h2:(1-t)/2,t,er:1})).z,I.models.stripWheeler(w,1,t),.015,"Wheeler thick w="+w+" t="+t);
// Kirschning & Jansen (1984) coupled microstrip (t = 0) via AtriumImpedance.
for(const [u,g,er] of [[.5,.5,4.3],[1,.3,4.3],[2,1,9.8],[.3,2,2.2]]){
  const c=F.compare({structure:"microstrip",w:u*.2,h:.2,s:g*.2,er});
  near(c.solver.zodd,c.closedForm.zodd,.02,"KJ odd u="+u);near(c.solver.zeven,c.closedForm.zeven,.02,"KJ even u="+u);
  near(c.solver.eeffOdd,c.closedForm.eeffOdd,.02,"KJ eps odd");near(c.solver.eeffEven,c.closedForm.eeffEven,.02,"KJ eps even");
  assert.ok(Math.abs(c.deltaPct.z)<2);
  assert.ok(c.solver.kb>0&&c.solver.kb<.5&&c.solver.kf<0,"microstrip FEXT is negative");
}
// Conductor-backed CPW (Ghione & Naldi, Wadell 3.4.3) via AtriumImpedance.
for(const [w,g,h] of [[.3,.15,.2],[.2,.1,.4],[.5,.2,.2]]){const c=F.compare({structure:"cpwg",w,g,h,er:4.3});near(c.solver.z,c.closedForm.z,.05,"CPWG w="+w);}
// Solder mask lowers Z0 by 1-4 % (Polar AP8155); an etched (trapezoidal) strip has a higher Z0.
{
  const g={structure:"microstrip",w:8*mil,h:5*mil,er:4,t:1.4*mil},a=ok(F.solve(g)),m=ok(F.solve({...g,cover:{t:.5*mil,er:3.3}})),e=ok(F.solve({...g,etch:2}));
  const drop=1-m.z/a.z;assert.ok(drop>.01&&drop<.04,"mask drop "+drop);assert.ok(m.eeff>a.eeff);
  assert.ok(e.z>a.z,"etch raises Z");assert.ok(ok(F.solve({...g,etch:1})).z>e.z,"deeper etch raises Z further");
  near(a.z,I.solve(g).z,.02,"thick microstrip vs H&J");
}
// Offset stripline is lower than the centred one; the generic form reproduces the named structure.
{
  const sym=ok(F.solve({structure:"stripline",w:.15,h1:.2,h2:.2,t:.035,er:4})),off=ok(F.solve({structure:"stripline",w:.15,h1:.15,h2:.25,t:.035,er:4}));
  assert.ok(off.z<sym.z);near(off.z,I.solve({structure:"stripline",w:.15,h1:.15,h2:.25,t:.035,er:4}).z,.05,"offset stripline");
  const named=ok(F.solve({structure:"microstrip",w:.2,h:.2,t:.035,er:4.3})),gen=ok(F.solve({conductors:[{x0:-.1,x1:.1,y:.2,t:.035,role:"signal"}],dielectrics:[{y0:0,y1:.2,er:4.3}],groundPlanes:[0]}));
  near(gen.z,named.z,1e-9,"generic form");
}
// Per-unit-length matrices: symmetric, Maxwell signs, and Z = sqrt(L/C), v = 1/sqrt(LC) for one line.
{
  const r=ok(F.solve({structure:"microstrip",w:.3,h:.2,t:.035,er:4.3,tanD:.02},{fGHz:2})),M=r.matrices;
  const L=M.L[0][0]*1e-6,C=M.C[0][0]*1e-9; // H/m, F/m
  near(Math.sqrt(L/C),r.z,1e-9,"Z = sqrt(L/C)");near(1e3/Math.sqrt(L*C)/1e12,1/r.delay,1e-9,"v = 1/sqrt(LC)");
  const p=ok(F.solve({structure:"microstrip",w:.15,s:.15,h:.1,t:.035,er:4},{fGHz:5})).matrices;
  near(p.C[0][1],p.C[1][0],1e-12);assert.ok(p.C[0][1]<0&&p.L[0][1]>0&&p.R[0][0]>0&&p.G[0][0]>0);
}
// Losses against the closed form (Wheeler's incremental-inductance rule; Pozar 3.30 for Df).
for(const g of [{structure:"microstrip",w:.15,h:.1,t:.035,er:4,tanD:.02,freq:5},{structure:"stripline",w:.15,h1:.2,h2:.2,t:.035,er:4,tanD:.02,freq:5},{structure:"microstrip",w:.15,s:.15,h:.1,t:.035,er:4,tanD:.02,freq:5}]){
  const c=F.compare(g);
  near(c.solver.alpha_c,c.closedForm.loss.conductor,.15,g.structure+" conductor loss");near(c.solver.alpha_d,c.closedForm.loss.dielectric,.05,g.structure+" dielectric loss");
}
// Roughness: every factor is 1 at low frequency; H-J and Groisse saturate at 2; Huray grows to 1 + 1.5 SR.
{
  const R=F.roughness;
  for(const k of ["hammerstad","groisse","huray"])near(R[k](1e-5,{rq:1}),1,1e-3,k+" low f");
  near(R.hammerstad(1e5,{rq:1}),2,1e-3);near(R.groisse(1e5,{rq:1}),2,1e-3);
  let prev=0;for(const f of [.01,.1,1,10,100]){const k=R.huray(f,{radius:.5,N:14,Ahex:9.4});assert.ok(k>prev);prev=k;}
  near(R.huray(1e9,{radius:.5,N:14,Ahex:9.4}),1+1.5*14*4*Math.PI*.25/9.4,.005,"Huray limit");
  const a=ok(F.solve({structure:"microstrip",w:.2,h:.1,t:.035,er:4},{fGHz:10})),b=ok(F.solve({structure:"microstrip",w:.2,h:.1,t:.035,er:4},{fGHz:10,roughness:{model:"groisse",rq:1}}));
  near(b.alpha_c/a.alpha_c,R.groisse(10,{rq:1}),1e-9);
}
// Djordjevic-Sarkar: exact at fRef, Dk falls monotonically, Df nearly flat around fRef.
{
  const m=F.dielectric.djordjevicSarkar({er:4.3,tanD:.02,fRef:1});
  near(m(1).er,4.3,1e-12);near(m(1).tanD,.02,1e-12);
  let prev=Infinity;for(const f of [1e-5,1e-3,.1,1,10,100,1e3]){const e=m(f).er;assert.ok(e<prev);prev=e;}
  for(const f of [.01,.1,10,100])near(m(f).tanD,.02,.1,"DS tanD at "+f+" GHz");
  const g={structure:"microstrip",w:.3,h:.2,t:.035,er:4.3,tanD:.02},lo=ok(F.solve(g,{fGHz:.1,dispersion:"djordjevic-sarkar"})),hi=ok(F.solve(g,{fGHz:20,dispersion:"djordjevic-sarkar"}));
  assert.ok(lo.eeff>hi.eeff&&lo.z<hi.z,"Dk dispersion raises Z with frequency");
  near(ok(F.solve(g,{fGHz:1,dispersion:"djordjevic-sarkar"})).z,ok(F.solve(g)).z,1e-9,"DS at fRef = static");
}
// Synthesis, mesh, quality levels.
{
  const g={structure:"microstrip",h:.2,t:.035,er:4.2},s=F.synthesize(g,{target:50});assert.ok(s.ok);near(s.result.z,50,.002);
  const d=F.synthesize({structure:"stripline",h1:.2,h2:.2,t:.0175,er:4,w:.12},{target:90,vary:"s"});assert.ok(d.ok);near(d.result.zdiff,90,.002);
  const m=F.mesh({...g,w:.3});assert.equal(m.potential.length,m.nx*m.ny);assert.equal(m.xs.length,m.nx);assert.equal(m.er.length,(m.nx-1)*(m.ny-1));
  const q={structure:"microstrip",w:1,h:1,er:1},fast=ok(F.solve(q,{quality:"fast"})),fine=ok(F.solve(q,{quality:"fine"}));
  assert.ok(Math.abs(fine.z-126.51)<Math.abs(fast.z-126.51));assert.ok(fast.mesh.nodes<fine.mesh.nodes);
  assert.equal(F.solve({structure:"microstrip",h:.2,er:4}).ok,false);
}
// Speed (JSC, normal quality): generous bounds so a slow machine does not fail; typical runs are 5x faster.
{
  const one=ok(F.solve({structure:"microstrip",w:.3,h:.2,t:.035,er:4.3})),two=ok(F.solve({structure:"microstrip",w:.15,s:.15,h:.1,t:.035,er:4}));
  assert.ok(one.ms<1000,"single-ended "+one.ms+" ms");assert.ok(two.ms<2500,"differential "+two.ms+" ms");
}
// async: a Promise in every environment (no Worker under JSC: synchronous fallback).
globalThis.__testDone=F.async({structure:"microstrip",w:.3,h:.2,er:4.3}).then(r=>{assert.ok(r.ok);near(r.z,F.solve({structure:"microstrip",w:.3,h:.2,er:4.3}).z,1e-12);});
