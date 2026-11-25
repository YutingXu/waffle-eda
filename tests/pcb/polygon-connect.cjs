"use strict";

// Smart polygon connect styles: rule resolution, Auto classification and its
// reasons, current-sized spokes, per-pad overrides and the starved-thermal DRC.
const assert=require("node:assert/strict");
for(const m of ["model","spatial","pcb-appearance","pcb-pours","altium-rules","rules","polygon-pour"])require(require("../support/app-source-paths.cjs").appFile(m+".js"));
if(!globalThis.performance)globalThis.performance=require("node:perf_hooks").performance;
const PP=AtriumPolygonPour,R=AtriumRules;
const rect=(x0,y0,x1,y1)=>[[x0,y0],[x1,y0],[x1,y1],[x0,y1]];
const near=(a,b,eps,msg)=>assert.ok(Math.abs(a-b)<=eps,msg+": "+a+" vs "+b);
function pip(x,y,r){let ins=false;const n=r.length>>1;for(let i=0,j=n-1;i<n;j=i++){const x1=r[2*j],y1=r[2*j+1],x2=r[2*i],y2=r[2*i+1];if((y1>y)!==(y2>y)&&x<x1+(y-y1)*(x2-x1)/(y2-y1))ins=!ins;}return ins;}
const inRegions=(x,y,regs)=>regs.some(g=>{const rs=PP.rings(g);return pip(x,y,rs[0])&&!rs.slice(1).some(h=>pip(x,y,h));});

// ---- footprints
const pad2=(name,pitch,w,h)=>({id:name,name,footprint:{name,pads:[{number:"1",x:-pitch/2,y:0,w,h,shape:"roundrect"},{number:"2",x:pitch/2,y:0,w,h,shape:"roundrect"}],shapes:[]}});
const qfn={id:"qfn",name:"QFN-16_3x3",footprint:{name:"QFN-16_3x3",shapes:[],pads:[
  ...Array.from({length:16},(_,i)=>{const side=i>>2,k=(i&3)-1.5,o=1.45;
    const [x,y,w,h]=side===0?[-o,k*.5,.7,.25]:side===1?[k*.5,o,.25,.7]:side===2?[o,-k*.5,.7,.25]:[-k*.5,-o,.25,.7];return {number:String(i+1),x,y,w,h,shape:"rect"};}),
  {number:"17",x:0,y:0,w:1.7,h:1.7,shape:"rect"}]}};
const sot={id:"sot",name:"SOT-223",footprint:{name:"SOT-223",shapes:[],pads:[
  {number:"1",x:-2.3,y:3.15,w:.95,h:1.5,shape:"rect"},{number:"2",x:0,y:3.15,w:.95,h:1.5,shape:"rect"},{number:"3",x:2.3,y:3.15,w:.95,h:1.5,shape:"rect"},
  {number:"4",x:0,y:-3.15,w:3.25,h:1.8,shape:"rect"}]}};
const header={id:"hdr",name:"PinHeader_1x2",footprint:{name:"PinHeader_1x2",shapes:[],pads:[{number:"1",x:0,y:0,w:1.7,h:1.7,drill:1,shape:"rect"},{number:"2",x:2.54,y:0,w:1.7,h:1.7,drill:1,shape:"round"}]}};
const defs=new Map([pad2("C_0402",.96,.56,.62),pad2("L_1210",3.2,1,2.7),qfn,sot,header].map(d=>[d.id,d]));
const part=(id,ref,def,x,y,pinNets,extra={})=>({id,kind:"part",ref,def,x,y,angle:0,layer:"Top",pinNets,value:extra.value||ref,...extra});
const via=(id,x,y,net)=>({id,kind:"via",x,y,diameter:.6,drill:.3,layer:"Multi",net});
function board(items,rules){return {kind:"pcb",name:"Smart",items,outline:rect(0,0,60,40),grid:.25,notes:[],...(rules?{rules}:{})};}
const decisions=(doc,poly,opts)=>new Map(PP.connections(doc,defs,poly,opts).map(d=>[d.label,d]));

// ---- 1. A power net through a regulator and an inductor connects directly.
{
  const items=[part("u1","U1","sot",15,15,{"1":"GND","2":"N1","3":"VIN","4":"N1"}),
    part("l1","L1","L_1210",25,15,{"1":"SW","2":"N1"}),part("c1","C1","C_0402",30,15,{"1":"N1","2":"GND"})];
  const poly=PP.make(rect(5,5,40,30),{net:"N1",connectStyle:"auto"});
  const d=decisions(board([...items,poly]),poly);
  assert.equal(d.get("U1-2").style,"direct");assert.match(d.get("U1-2").reason,/inductor L1/);
  assert.equal(d.get("U1-4").style,"direct");assert.match(d.get("U1-4").reason,/Exposed\/thermal pad of U1/);
  assert.match(d.get("U1-4").hint,/via array/);
  assert.equal(d.get("L1-2").style,"direct");
  assert.equal(d.get("C1-1").style,"relief","0402 on a power net still gets a relief");assert.match(d.get("C1-1").reason,/0402 passive/);
  assert.ok([...d.values()].every(x=>x.source==="auto"));
  // Name patterns: VCC is power by name; GND alone is not.
  const named=decisions(board([part("c9","C9","C_0402",10,10,{"1":"VCC","2":"GND"}),part("u9","U9","sot",20,20,{"1":"GND","2":"VCC","3":"X","4":"Y"}),poly]),{...poly,net:"VCC"});
  assert.match(named.get("U9-2").reason,/power net name/);assert.equal(named.get("U9-2").style,"direct");
}
// ---- 2. Decoupling cap on GND gets a relief, QFN exposed pad is direct, vias direct.
const gndItems=[part("c2","C2","C_0402",20,20,{"1":"VDD","2":"GND"}),part("u2","U2","qfn",30,20,{"1":"GND","2":"SDA","5":"VDD","17":"GND"}),
  via("v1",34,20,"GND"),part("j1","J1","hdr",45,20,{"1":"GND","2":"SIG"})];
{
  const poly=PP.make(rect(2,2,58,38),{net:"GND",connectStyle:"auto",viaConnectStyle:"auto"});
  const doc=board([...gndItems,poly]),d=decisions(doc,poly);
  assert.equal(d.get("C2-2").style,"relief");assert.match(d.get("C2-2").reason,/tombstone/);
  assert.equal(d.get("U2-17").style,"direct");assert.match(d.get("U2-17").reason,/Exposed/);
  assert.equal(d.get("U2-1").style,"relief");assert.match(d.get("U2-1").reason,/not flagged as a current return/);
  assert.equal(d.get("Via").style,"direct");
  assert.equal(d.get("J1-1").style,"relief");assert.match(d.get("J1-1").reason,/hand soldering/);
  // The pour follows the decisions: EP covered, C2 pad 2 has an air gap with spokes.
  const st={},regs=PP.pour(doc,defs,poly,{stats:st});
  assert.equal(st.connections.length,d.size);
  assert.ok(inRegions(30,20,regs),"exposed pad poured over (direct)");
  const c2=[20.48,20];assert.ok(!inRegions(c2[0]+.28+.12,c2[1]+.25,regs),"C2 relief air gap");
  assert.ok(inRegions(c2[0]+.28+.12,c2[1],regs),"C2 relief spoke");
  // GND flagged as a current return (Power net class) becomes direct for SMD IC pins.
  const rules=R.create();rules.netClasses={Power:["GND"]};
  const flagged=decisions(board([...gndItems,poly],rules),poly);
  assert.equal(flagged.get("U2-1").style,"direct");assert.match(flagged.get("U2-1").reason,/net class Power/);
  assert.equal(flagged.get("C2-2").style,"relief","small passives keep reliefs");
}
// ---- 3. Spoke width from current: IPC-2221 form, 1 A, 35 µm outer copper, 10 °C rise.
{
  const w=PP.ipcWidth(1,.035,true,10);
  near(w,.300,.005,"1 A outer 1 oz needs about 0.30 mm (11.8 mil)");
  near(PP.ipcWidth(1,.035,false,10),.783,.01,"inner layers need about 2.6x the width");
  near(PP.ipcWidth(3,.070,true,10),.684,.01,"3 A on 2 oz needs about 0.68 mm");
  const rules=R.create();rules.netCurrents={GND:8};
  const poly=PP.make(rect(2,2,58,38),{net:"GND",connectStyle:"auto"});
  const doc=board([...gndItems,poly],rules),d=decisions(doc,poly);
  const j=d.get("J1-1"),need=PP.ipcWidth(8,.035,true,10);
  near(j.spokeWidth,need/4,1e-9,"TH relief spokes share the 8 A cross-section");assert.match(j.reason,/carry 8 A/);
  assert.equal(d.get("U2-1").style,"direct","8 A flags GND as a current return");
  const c2=d.get("C2-2");assert.equal(c2.spokeWidth,.56,"spokes clamp to the narrower pad side");assert.match(c2.reason,/Clamped/);
  // The poured spoke really has that width.
  const regs=PP.pour(doc,defs,poly,{}),x=45+.85+.254/2,half=j.spokeWidth/2;
  assert.ok(inRegions(x,20+half-.02,regs)&&!inRegions(x,20+half+.03,regs),"poured spoke width "+j.spokeWidth.toFixed(3));
}
// ---- 4. Rules: polygonConnect scopes, kinds rows and precedence; overrides win.
{
  const rules=R.create();
  assert.equal(R.query({rules},"polygonConnect",{net:"GND"}).style,"polygon","the default rule defers to the polygon");
  rules.list.unshift({id:"pc-c2",type:"polygonConnect",name:"C2Direct",comment:"",enabled:true,priority:1,scope:AtriumDesignQueryRecord.create('pad where component.designator = "C2" and pin.number = "2"'),
    style:"direct",conductorWidth:.2,entries:4,angle:90,airGap:.2,minEntries:2,powerWidth:.5,tempRise:10,kinds:{}});
  rules.list.unshift({id:"pc-gnd",type:"polygonConnect",name:"GndRelief",comment:"",enabled:true,priority:1,scope:AtriumDesignQueryRecord.selector("net","GND"),
    style:"relief",conductorWidth:.3,entries:2,angle:45,airGap:.3,minEntries:1,powerWidth:.5,tempRise:10,kinds:{via:{style:"direct"},th:{entries:4,airGap:.4}}});
  const set=R.normalize(rules);R.validate(JSON.parse(JSON.stringify(set)));
  assert.equal(set.list.find(r=>r.id==="pc-gnd").priority,1);
  const q=R.query({rules:set},"polygonConnect",{net:"GND",padKind:"th"});
  assert.deepEqual([q.ruleName,q.style,q.entries,q.airGap,q.conductorWidth],["GndRelief","relief",4,.4,.3],"kind rows override rule values");
  assert.equal(R.query({rules:set},"polygonConnect",{net:"GND",padKind:"via"}).style,"direct");
  assert.match(R.describe(set.list.find(r=>r.id==="pc-gnd")),/Polygon Connect Style Constraint .*Vias\{style=direct\}.*\(InNet\('GND'\)\)/);
  const poly=PP.make(rect(2,2,58,38),{net:"GND",connectStyle:"auto",viaConnectStyle:"auto"});
  let d=decisions(board([...gndItems,poly],set),poly);
  assert.deepEqual([d.get("U2-17").style,d.get("U2-17").source,d.get("U2-17").entries],["relief","rule",2],"a matching rule beats the polygon's Auto");
  assert.equal(d.get("Via").style,"direct");assert.equal(d.get("J1-1").airGap,.4);
  // Rule priority: GndRelief (1) is above C2Direct (2), so C2 stays relief; move C2Direct up.
  assert.equal(d.get("C2-2").style,"relief");
  set.list.find(r=>r.id==="pc-c2").priority=0;const reordered=R.normalize(set);
  d=decisions(board([...gndItems,poly],reordered),poly);assert.equal(d.get("C2-2").style,"direct","the pad scope selects C2 pin 2");
  // Overrides on the polygon win over rules and Auto.
  const over={...poly,connectOverrides:{"u2:17":"none","c2:2":"relief"}};
  d=decisions(board([...gndItems,over],reordered),over);
  assert.deepEqual([d.get("U2-17").style,d.get("U2-17").source],["none","override"]);assert.equal(d.get("C2-2").style,"relief");
  const regs=PP.pour(board([...gndItems,over],reordered),defs,over,{});
  assert.ok(!inRegions(30,20,regs),"No Connect clears the exposed pad");
  assert.ok(PP.validate(over)===over);assert.throws(()=>PP.validate({...over,connectOverrides:{x:"maybe"}}));
  // Invalid rule data is rejected.
  for(const bad of [r=>r.style="spokes",r=>r.entries=3,r=>r.kinds={bga:{}},r=>r.kinds={th:{width:1}},r=>r.minEntries=5])
    assert.throws(()=>{const c=JSON.parse(JSON.stringify(set));bad(c.list.find(r=>r.id==="pc-gnd"));R.validate(c);});
  assert.throws(()=>R.validate({...set,netCurrents:{GND:-1}}));
  // Altium records convert.
  const alt=R.fromAltium("RULEKIND=PolygonConnect|NAME=PlaneConnect|ENABLED=TRUE|SCOPE1EXPRESSION=InComponent('U1')|SCOPE2EXPRESSION=All|CONNECTSTYLE=Direct|RELIEFCONDUCTORWIDTH=12mil|RELIEFENTRIES=2|AIRGAPWIDTH=8mil|POLYGONRELIEFANGLE=45 Angle");
  assert.deepEqual([alt.rule.scope,alt.rule.style,alt.rule.entries,alt.rule.angle,alt.rule.conductorWidth],[{languageVersion:1,source:'object where component.designator = "U1"'},"direct",2,45,.3048]);
}
// ---- 5. Starved thermal: other-net tracks cut three of four spokes.
{
  const tp={id:"tp",kind:"pad",number:"1",x:20,y:20,w:1.6,h:1.6,drill:.9,shape:"round",layer:"Multi",net:"GND"};
  const cut=[[[16,19.0],[24,19.0]],[[16,21.0],[24,21.0]],[[21.0,16],[21.0,24]]].map((p,i)=>({id:"t"+i,kind:"track",points:p,width:.2,layer:"Top",net:"SIG"+i}));
  const fine={id:"tp2",kind:"pad",number:"1",x:40,y:20,w:1.6,h:1.6,drill:.9,shape:"round",layer:"Multi",net:"GND"};
  const poly=PP.make(rect(2,2,58,38),{net:"GND",connectStyle:"relief",removeDeadCopper:false});
  const doc=board([tp,fine,...cut,via("va",10,10,"GND"),poly],R.create());
  PP.apply(doc,defs);
  const th=PP.thermals(doc,defs);
  assert.deepEqual(th.map(t=>[t.id,t.connected,t.entries]).sort(),[["tp",1,4],["tp2",4,4]]);
  const out=R.drc(doc,defs,doc.rules,{types:["polygonConnect"]});
  const v=out.violations.filter(x=>x.type==="polygonConnect");
  assert.equal(v.length,1);assert.equal(v[0].id,"tp");assert.match(v[0].detail,/Starved thermal: 1 of 4 relief spokes connected, minimum 2/);
  assert.equal(out.rules.find(r=>r.type==="polygonConnect").count,1);
  doc.items[2].points[0][0]=16.5;
  assert.ok(R.drc(doc,defs,doc.rules,{types:["polygonConnect"]}).notes.some(n=>/out of date/.test(n)),"stale pours are not checked");
}
// ---- 6. Repour cost of Auto against fixed reliefs on a dense board.
{
  let seed=7;const rnd=()=>((seed=Math.imul(seed,1103515245)+12345>>>0)/4294967296);
  const items=[],nets=["GND","SIG1","SIG2","VCC","SIG3"];
  for(let i=0;i<300;i++)items.push(part("p"+i,(rnd()<.5?"C":"R")+i,"C_0402",3+rnd()*94,3+rnd()*74,{"1":nets[Math.floor(rnd()*5)],"2":nets[Math.floor(rnd()*5)]}));
  for(let i=0;i<30;i++)items.push(part("q"+i,"U"+i,"qfn",5+rnd()*90,5+rnd()*70,{"1":"GND","2":"SIG1","17":"GND","5":"VCC"}));
  for(let i=0;i<300;i++)items.push(via("w"+i,2+rnd()*96,2+rnd()*76,nets[Math.floor(rnd()*5)]));
  for(let i=0;i<120;i++){const x=2+rnd()*90,y=2+rnd()*70;items.push({id:"k"+i,kind:"track",points:[[x,y],[x+3+rnd()*6,y+rnd()*6]],width:.25,layer:"Top",net:nets[1+Math.floor(rnd()*4)]});}
  const fixed=PP.make(rect(0,0,100,80),{net:"GND",connectStyle:"relief"}),smart={...fixed,connectStyle:"auto"};
  const doc={kind:"pcb",items:[...items],outline:rect(0,0,100,80),rules:R.create()};
  const time=p=>{let best=Infinity;for(let k=0;k<4;k++){const t=performance.now();PP.pour(doc,defs,p,{});best=Math.min(best,performance.now()-t);}return best;};
  time(fixed);const a=time(fixed),b=time(smart),ctxT=(()=>{const t=performance.now();PP.connectContext(doc,defs,{});return performance.now()-t;})();
  assert.ok(b<=a*1.15+5,"Auto repour "+b.toFixed(1)+" ms vs fixed "+a.toFixed(1)+" ms");
  globalThis.__connectTiming={fixed:a,auto:b,context:ctxT};
}
console.log("polygon-connect: ok");
