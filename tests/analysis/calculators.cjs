"use strict";
// AtriumCalc (app/analysis/calculators.js) against published examples and hand calculations.
const assert=require("node:assert/strict");
globalThis.CFB=require("../../app/vendor/cfb.min.js");
for(const m of ["model","altium-rules","pcb-import","stackup","impedance","ipc2152","calculators"])require(require("../support/app-source-paths.cjs").appFile(m+".js"));
const C=AtriumCalc,P=AtriumIPC2152,MIL=.0254;
const near=(a,b,rel,m)=>assert.ok(Math.abs(a-b)<=Math.abs(b)*rel,(m?m+": ":"")+a+" vs "+b+" (±"+(rel*100)+"%)");
const calc=(id,inp,ctx)=>C.calculate(id,inp,ctx);

// ---- Track width -------------------------------------------------------------------------
// IPC-2221: 100 mil², 10 °C rise, external carries 0.048·10^0.44·100^0.725 = 3.73 A; inner half.
near(P.ipc2221.current(100,10,false),3.73,.005,"IPC-2221 external 100 mil²");
near(P.ipc2221.current(100,10,true),1.86,.005,"IPC-2221 internal 100 mil²");
// IPC-2221 classic: 1 A, 10 °C, 1 oz outer layer -> about 0.30 mm (12 mil) on every IPC-2221 calculator.
near(calc("track_width",{current:1,rise:10,copper:1}).values.width_ipc2221,.304,.02,"IPC-2221 1 A 10 °C 1 oz");
// NinjaCalc IPC-2152 worked example (blog.mbedded.ninja): 1 A, 40 °C, 1 oz, 1.6 mm board, plane at
// 1.6 mm, 0.2 W/m·K -> unadjusted 3361 µm², modifiers 0.903 · 1.092 · 0.602 · 1.032, adjusted
// 2058 µm², minimum width 0.0588 mm.
{
  const u=P.modifiers({oz:1,current:1,board:1.6,plane:1.6,k:.2}),area=P.chartArea(1,40);
  near(area*645.16,3361,.005,"NinjaCalc unadjusted area");near(u.copper,.903,.002,"copper modifier");near(u.board,1.092,.003,"board modifier");
  near(u.plane,.602,.004,"plane modifier");near(u.conductivity,1.032,.002,"k modifier");near(area*u.total*645.16,2058,.01,"adjusted area");
  const r=calc("track_width",{current:1,rise:40,copper:1,board:1.6,plane:1.6,conductivity:.2});
  near(r.values.width_ipc2152,.0588,.01,"NinjaCalc width");
}
// IPC-2152 universal chart (Figure 5-1, 3 oz): 10 A at 20 °C needs about 500 mil² (smps.us reading;
// its own fit gives 513). Brooks & Adam's external fit at 3 oz lands within 5 %.
near(P.brooksAdam.width(10,20,4.134,false)*4.134,500,.05,"Brooks & Adam vs IPC-2152 chart 10 A 20 °C");
near(P.chartArea(10,20),500,.05,"chart fit 10 A 20 °C");
// The Brooks & Adam fit inverts exactly, and inner layers carry about as much as outer ones
// (IPC-2152), not half (IPC-2221).
for(const [I,dT,th,int] of [[1,10,1.378,false],[3,20,.689,true],[5,30,2.756,true]])near(P.brooksAdam.current(P.brooksAdam.width(I,dT,th,int),dT,th,int),I,1e-9,"B&A round trip");
{
  const ext=calc("track_width",{current:2,rise:10,copper:1}).values.width,int=calc("track_width",{current:2,rise:10,copper:1,layer:"internal"}).values.width;
  assert.ok(int/ext>.7&&int/ext<1.5,"inner/outer width ratio "+int/ext);
  const i21=calc("track_width",{current:2,rise:10,copper:1,layer:"internal"}).values.width_ipc2221;
  near(i21/calc("track_width",{current:2,rise:10,copper:1}).values.width_ipc2221,Math.pow(2,1/.725),1e-9,"IPC-2221 internal 2^(1/0.725) wider");
}
// Wider for more current or less rise; warnings outside the test data.
assert.ok(calc("track_width",{current:5}).values.width>calc("track_width",{current:2}).values.width);
assert.ok(calc("track_width",{current:40}).warnings.length);
// One IPC-2152 implementation: the calculator is AtriumIPC2152.conductor, with its clamping and warnings. Before
// the fix calculators.js kept an unclamped copy, so a 4 oz track on a 3 mm board with a plane 3 mm away and
// k 0.5 W/m·K got a different width here than in the Current Capacity rule and check.
{
  const inp={current:2,rise:10,copper:4,board:3,plane:3,conductivity:.5},r=calc("track_width",inp);
  const o={width:null,current:2,rise:10,thickness:4*.035,internal:false,board:3,plane:3,k:.5};
  near(r.values.width_ipc2152,P.conductor({...o,method:"ipc2152"}).width,1e-9,"chart width = AtriumIPC2152");
  near(r.values.width,P.conductor({...o,method:"brooksAdam"}).width,1e-9,"Brooks & Adam width = AtriumIPC2152");
  near(r.values.width_ipc2221,P.conductor({...o,method:"ipc2221"}).width,1e-9,"IPC-2221 width = AtriumIPC2152");
  assert.equal(r.warnings.filter(w=>/clamped/.test(w)).length,4,"copper, board, plane and k clamped: "+r.warnings.join(" | "));
  const m=P.modifiers({oz:3,current:2,board:2.36,plane:2.40,k:.34});
  near(r.values.modifiers.copper,m.copper,1e-9);near(r.values.modifiers.board,m.board,1e-9);near(r.values.modifiers.plane,m.plane,1e-9);near(r.values.modifiers.conductivity,m.conductivity,1e-9);
  near(calc("current_capacity",{solve:"width",current:2,rise:10,copper:4,board:3,plane:3,conductivity:.5}).values.width,r.values.width_ipc2152,1e-9,"both calculators agree");
}

// ---- Track resistance --------------------------------------------------------------------
// 1 oz copper is about 0.49 mΩ per square at 20 °C (ρ 1.724e-8 / 35 µm); 10 mil × 1 in = 100 squares.
{
  const r=calc("track_resistance",{width:.254,length:25.4,copper:1,current:1,temperature:20});
  near(r.values.sheet*1000,.4926,.002,"sheet resistance 1 oz");near(r.values.resistance,.04926,.002,"10 mil × 1 in");near(r.values.drop,.04926,.002,"drop at 1 A");
  // +0.393 %/°C: 100 °C is 31.4 % higher than 20 °C.
  near(calc("track_resistance",{width:.254,length:25.4,temperature:100}).values.resistance/r.values.resistance,1.3144,1e-6,"temperature coefficient");
}

// ---- Via -----------------------------------------------------------------------------------
// 0.3 mm hole, 25 µm plating, 1.6 mm: A = π·0.325·0.025 = 0.02553 mm² (39.6 mil²),
// R = 1.724e-5 Ω·mm × 1.6 / A = 1.08 mΩ at 20 °C. Capacity: the IPC-2152 chart for 39.6 mil² at 10 °C (as the Current
// Capacity rule, AtriumIPC2152.via); IPC-2221 external 0.048·10^0.44·39.6^0.725 = 1.89 A is the comparison.
{
  const r=calc("via_current",{drill:.3,plating:25,length:1.6,rise:10,current:1,ambient:10});
  near(r.values.area,.025525,.001,"via barrel area");near(r.values.resistance,1.0807e-3,.002,"via resistance");
  near(r.values.current_max,P.via({drill:.3,plating:.025,rise:10}).current,1e-9,"via current = AtriumIPC2152.via");
  near(r.values.current_max,P.chartCurrent(r.values.area/(MIL*MIL),10),1e-9,"IPC-2152 chart for the barrel");
  near(r.values.current_max_ipc2221,1.89,.01,"IPC-2221 comparison");
  near(r.values.thermal_resistance,1.6e-3/(385*Math.PI*.325*.025e-6),1e-6,"via thermal resistance");
  assert.equal(calc("via_current",{current:5}).values.vias_needed,Math.ceil(5/calc("via_current",{}).values.current_max));
}

// ---- Impedance -------------------------------------------------------------------------------
// Pozar, Microwave Engineering 4th ed., Example 3.7: 50 Ω microstrip, εr 2.20, d 1.27 mm -> W 3.916 mm, εeff 1.87.
{
  const r=calc("impedance",{structure:"microstrip",width:3.916,height:1.27,er:2.2,thickness:0});
  near(r.values.impedance,50,.01,"Pozar 3.7 Z0");near(r.values.eeff,1.87,.01,"Pozar 3.7 eps_eff");
  const s=calc("impedance",{structure:"microstrip",height:1.27,er:2.2,thickness:0,target:50});
  near(s.values.width,3.916,.01,"Pozar 3.7 synthesis");
}
// Pozar Example 3.5: 50 Ω stripline, b 3.2 mm, εr 2.20 -> W 2.66 mm.
near(calc("impedance",{structure:"stripline",width:2.66,h1:1.6,h2:1.6,er:2.2,thickness:0}).values.impedance,50,.01,"Pozar 3.5 stripline");
// Differential: Zdiff = 2·Zodd and below 2·Z0 for coupled lines.
{
  const r=calc("impedance",{mode:"differential",width:.15,gap:.15,height:.1,er:4.2});
  near(r.values.zdiff,2*r.values.zodd,1e-9,"Zdiff");assert.ok(r.values.zdiff<2*r.values.z0);
}
// Prefilled from a board: the default stack-up's top layer is a microstrip over the core.
{
  const doc=Atrium.sheet("pcb","Board"),defs=new Map(),g=AtriumImpedance.geometry(AtriumStackup.get(doc,defs).layers,"Top");
  const r=calc("impedance",{width:.3},{doc,defs});
  assert.equal(r.values.structure,"microstrip");assert.equal(r.values.layer,"Top");near(r.values.h,g.h,1e-9,"stack-up height");
  assert.equal(r.board,"Board");
  // Typed values override the stack-up.
  near(calc("impedance",{width:.3,height:.5},{doc,defs}).values.h,.5,1e-12,"override");
  // Via length from the stack-up: a through via's plating spans top copper to bottom copper
  // (the board minus mask and silk).
  {const t=AtriumStackup.layerInfo(doc,"Top",defs),b=AtriumStackup.layerInfo(doc,"Bottom",defs);
    near(calc("via_current",{},{doc,defs}).values.length,b.z+b.thickness-t.z,1e-9,"via span");assert.ok(b.z+b.thickness-t.z<AtriumStackup.thickness(doc,defs));}
}

// ---- E-series (IEC 60063) -------------------------------------------------------------------
assert.deepEqual(C.eseries("E6"),[1,1.5,2.2,3.3,4.7,6.8]);
assert.equal(C.eseries("E24").length,24);assert.equal(C.eseries("E96").length,96);assert.equal(C.eseries("E192").length,192);
assert.ok(C.eseries("E192").includes(9.2)&&!C.eseries("E192").includes(9.19),"E192 9.20 exception");
assert.deepEqual(C.eseries("E96").slice(0,6),[1,1.02,1.05,1.07,1.1,1.13]);
assert.ok(C.eseries("E96").includes(4.99)&&C.eseries("E48").includes(4.87));
assert.equal(C.nearest(5000,"E24").value,5100);assert.equal(C.nearest(1234,"E96").value,1240);assert.equal(C.nearest(9.6,"E12").value,10);
assert.equal(C.nearest(0.00047,"E6").value,.00047);
{
  const r=calc("eseries",{value:5000,series:"E24"});
  assert.ok(Math.abs(r.values.series.error)<.005,"series pair "+JSON.stringify(r.values.series));
  assert.ok(Math.abs(r.values.parallel.error)<.005,"parallel pair "+JSON.stringify(r.values.parallel));
  const p=r.values.parallel;near(p.a*p.b/(p.a+p.b),p.value,1e-9,"parallel value");
  // 1.5 k ∥ 3 k... 1 k exactly: 2 k ∥ 2 k in E24.
  assert.equal(Math.abs(calc("eseries",{value:1000,series:"E24"}).values.parallel.error)<1e-12,true);
}

// ---- Regulator divider ----------------------------------------------------------------------
// LM317 (TI SLVS044): Vref 1.25 V, 5 V needs R2/R1 = 3 -> exact in E24.
{
  const r=calc("divider",{vout:5,vref:1.25,series:"E24",rmin:100,rmax:10000});
  assert.equal(r.values.error,0);near(r.values.top/r.values.bottom,3,1e-12,"LM317 ratio");
  // LM317 datasheet equation with the 50 µA ADJ current: 240 Ω / 750 Ω gives 1.25·(1 + 750/240) + 50e-6·750 = 5.194 V.
  const adj=calc("divider",{vout:5.19375,vref:1.25,series:"E24",rmin:240,rmax:240,iadj:50});
  assert.equal(adj.values.bottom,240);assert.equal(adj.values.top,750);near(adj.values.vout,5.19375,1e-9,"LM317 with I_adj");
  // 3.3 V from a 0.8 V buck reference: ratio 3.125. An exhaustive E96 search (every pair) finds
  // 35.7 k / 11.5 k at −0.501 % as the best; the calculator must find the same optimum.
  const b=calc("divider",{vout:3.3,vref:.8,series:"E96"});
  near(Math.abs(b.values.error),.0050066,1e-4,"E96 buck optimum");near(b.values.top/b.values.bottom,3.57/1.15,1e-9);near(.8*(1+b.values.top/b.values.bottom),b.values.vout,1e-9);
  assert.throws(()=>calc("divider",{vout:.5,vref:.8}),/above the reference/);
}

// ---- RC / LC, units, Ohm, derating, attenuator --------------------------------------------
{
  const r=calc("rclc",{r:1000,c:100,l:10});
  near(r.values.fc_rc,1591.549,1e-6,"RC 1 k 100 n");near(r.values.tau_rc,1e-4,1e-12,"tau");near(r.values.f0,159154.9,1e-6,"LC 10 µH 100 nF");near(r.values.z0,10,1e-12,"sqrt(L/C)");
}
{
  const u=calc("units",{value:10,unit:"mil"}).values;near(u.mm,.254,1e-12);near(u.um,254,1e-12);
  near(calc("units",{value:1,unit:"oz"}).values.um,35,1e-12);near(calc("units",{value:1,unit:"in"}).values.mil,1000,1e-12);
}
{
  const o=calc("ohm",{v:12,r:4}).values;near(o.i,3,1e-12);near(o.p,36,1e-12);
  const q=calc("ohm",{v:0,r:100,p:.25}).values;near(q.i,.05,1e-12);near(q.v,5,1e-12);
  assert.throws(()=>calc("ohm",{v:0,i:0,r:0,p:0}),/two of/);
}
{
  // Vishay CRCW: 0.25 W derates linearly from 70 °C to 0 at 155 °C; at 100 °C 0.25·55/85 = 0.1618 W.
  const d=calc("derating",{rated:.25,knee:70,tmax:155,ambient:100,power:.05}).values;near(d.allowed,.1618,.001,"derating 100 °C");assert.equal(d.ok,true);
  assert.equal(calc("derating",{rated:.25,ambient:60,power:.2}).values.ok,false);
}
{
  // 3 dB 50 Ω pads: Pi 292.4 / 17.61 Ω, T 8.55 / 141.9 Ω (Reference Data for Engineers tables).
  const a=calc("attenuator",{db:3,z0:50}).values;near(a.pi_shunt,292.4,.001);near(a.pi_series,17.61,.001);near(a.t_series,8.55,.001);near(a.t_shunt,141.9,.001);
}

// ---- API surface -----------------------------------------------------------------------------
{
  const L=C.list();assert.ok(L.length>=11);
  for(const c of L){assert.ok(c.formula.length&&c.assumptions.length&&c.sources.length,c.id+" documents itself");const r=calc(c.id,{});assert.ok(r.ok&&r.rows.length,c.id+" runs with defaults");}
  assert.throws(()=>calc("nope",{}),/Unknown calculator/);
  assert.throws(()=>calc("track_width",{amps:3}),/Unknown input amps/);
  assert.throws(()=>calc("track_width",{current:"x"}),/must be a number/);
  assert.throws(()=>calc("impedance",{structure:"coax"}),/must be one of/);
  assert.equal(calc("track_width",{current:"2.5"}).inputs.current,2.5);
  assert.equal(calc("track",{}).calculator,"track_width");
  // Headless entry point: the first board of a project prefills.
  const p=Atrium.project("P",[]),h=C.headless({calculator:"via_current",inputs:{}},{project:()=>p,board:(q,id)=>q.documents.find(d=>d.id===id)});
  assert.ok(h.ok);assert.equal(typeof C.format(1500,"Ω"),"string");assert.equal(C.format(1500,"Ω"),"1.5 kΩ");
}
console.log("calculators ok");
