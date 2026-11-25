"use strict";
const assert=require("node:assert/strict");
require("../../app/core/model.js");require("../../app/library/parts.js");require("../../app/core/zip.js");require("../../app/formats/bom.js");require("../../app/formats/bom-optimiser.js");
const A=Atrium,B=AtriumBOM,O=AtriumBOMOptimiser;

// ------------------------------------------------------------ value parsing
const v=t=>{const p=O.parseText(t);return p.value==null?null:O.formatValue(p.value,p.kind||"R");};
for(const t of ["10k","10K","10kΩ","10 kΩ","10000","10 kohm","10K OHM","10k0"])assert.equal(v(t),"10 kΩ",t);
assert.equal(v("4k7"),"4.7 kΩ");assert.equal(v("4R7"),"4.7 Ω");assert.equal(v("R47"),"470 mΩ");assert.equal(v("0R"),"0 Ω");assert.equal(v("1M"),"1 MΩ");
const c=t=>{const p=O.parseText(t);return O.formatValue(p.value,"C");};
for(const t of ["100n","0.1u","100nF","0.1 µF","100 nF","0.1UF","100NF"])assert.equal(c(t),"100 nF",t);
assert.equal(c("2n2"),"2.2 nF");assert.equal(c("1u0"),"1 µF");assert.equal(c("4.7pF"),"4.7 pF");
let p=O.parseText("100nF 50V X7R ±10% 0402");
assert.deepEqual([p.kind,p.voltage,p.dielectric,p.tolerance,p.package],["C",50,"X7R",10,"0402"]);
p=O.parseText("10k 1% 1/4W 100ppm");assert.deepEqual([p.tolerance,p.power,p.tempco],[1,0.25,100]);
p=O.parseText("10uF 6V3 X5R");assert.equal(p.voltage,6.3);
p=O.parseText("22pF NP0");assert.equal(p.dielectric,"C0G");
assert.equal(O.parseText("10k/20k").value,null);
assert.equal(O.parseValueToken("1MF"),null);
assert.equal(O.packageOf("R_0603_1608Metric"),"0603");assert.equal(O.packageOf("C_1005Metric"),"0402");
assert.equal(O.packageOf("RESC1608X55N"),"0603");assert.equal(O.packageOf("SOIC-8"),null);

// E-series.
assert.equal(O.eSeries(4700),"E6");assert.equal(O.eSeries(1200),"E12");assert.equal(O.eSeries(5100),"E24");
assert.equal(O.eSeries(4990),"E96");assert.equal(O.eSeries(9090),"E48");assert.equal(O.eSeries(3010),"E48");assert.equal(O.eSeries(1020),"E96");assert.equal(O.eSeries(4800),null);
assert.equal(O.SERIES.E96.length,96);assert.deepEqual(O.nearest(4800,"E24"),[4700,5100]);

// Net voltages.
for(const [n,x] of [["3V3",3.3],["+5V",5],["12V",12],["VCC_3V3",3.3],["P3V3",3.3],["VDD_1V8",1.8],["-12V",-12],["+3.3V",3.3],["V3P3",3.3],["GND",0],["AGND",0],["VBUS",null],["VDD",null],["3V3_TO_5V",null],["LED1",null]])
  assert.equal(O.netVoltage(n),x,n);

// Ratings dominance never allows a downgrade.
const d=(a,b)=>O.dominates(a,b).ok;
assert.ok(d({tolerance:1},{tolerance:5}));assert.ok(!d({tolerance:5},{tolerance:1}));
assert.ok(d({voltage:50},{voltage:16}));assert.ok(!d({voltage:16},{voltage:50}));
assert.ok(d({dielectric:"C0G"},{dielectric:"X7R"}));assert.ok(d({dielectric:"X7R"},{dielectric:"X5R"}));assert.ok(!d({dielectric:"X5R"},{dielectric:"X7R"}));
assert.ok(!d({dielectric:"Y5V"},{dielectric:"X7R"}));assert.ok(!d({},{voltage:16}));assert.ok(!d({},{mpn:"X"}));
assert.deepEqual(O.dominates({voltage:16},{}).caveats,["voltage"]);

// ------------------------------------------------------------ a test project
const proj=AtriumParts.example(),[sch,brd]=proj.documents;
function add(ref,base,value,params){
  const s={...A.clone(sch.items.find(i=>i.ref===base)),id:"s-"+ref,ref,link:"link-"+ref,value};
  const b={...A.clone(brd.items.find(i=>i.ref===base)),id:"b-"+ref,ref,link:"link-"+ref,value};
  if(params)s.parameters=params;
  sch.items.push(s);brd.items.push(b);return s;
}
add("R3","R1","10k");add("R4","R1","10K");add("R5","R1","10k 5%");
add("R6","R1","10 kΩ",{Tolerance:"1%",Manufacturer:"Yageo","Manufacturer Part Number":"RC0603FR-0710KL"});
add("R7","R1","10 kΩ",{Tolerance:"1%",Manufacturer:"Yageo","Manufacturer Part Number":"RC0603FR-0710KL"});
add("C3","C2","100nF 16V X7R");add("C4","C2","0.1uF 50V X7R");add("C5","C2","100n 25V X5R");add("C6","C2","100nF 10V Y5V");
add("R8","R1","4k8");
const before=JSON.stringify(proj);
const an=O.analyse(proj);
assert.equal(JSON.stringify(proj),before,"analysis doesn't mutate");
assert.ok(an.ms>=0&&an.summary.parts===17);
const byTitle=t=>an.proposals.find(x=>x.title.includes(t));
// 100 nF: the 50 V X7R line covers 16 V X7R, 25 V X5R and 10 V Y5V? Y5V isn't dominated by X7R? It is (narrower temp, wider drift).
const cap=an.proposals.find(x=>x.kind==="C"&&x.applicable);
assert.ok(cap,"capacitor proposal");
assert.equal(cap.target.comment,"100 nF X7R 50 V");
assert.ok(cap.from.some(f=>f.comment==="100nF 16V X7R"));
for(const f of cap.from)assert.ok(f.target||!/C0G/.test(f.comment));
// 10k: the MPN line R6/R7 with 1% dominates the bare lines only with caveats (they lack tolerance) and the 5% line.
const res=an.proposals.find(x=>x.kind==="R"&&x.applicable&&x.value==="10 kΩ");
assert.ok(res);assert.equal(res.target.mpn,"RC0603FR-0710KL");
assert.equal(res.confidence,"check");assert.ok(res.caveats.length);assert.equal(res.selected,false);
assert.ok(res.from.some(f=>f.comment==="10k 5%"));
// Every applicable proposal: target ratings meet or beat every source line.
for(const pr of an.proposals.filter(x=>x.applicable)){
  const tgt=an.lines.find(l=>pr.from.some(f=>f.target&&f.comment===l.comment&&f.refs===B.compress(l.refs)));
  for(const f of pr.from){const l=an.lines.find(x=>x.comment===f.comment&&B.compress(x.refs)===f.refs);assert.ok(O.dominates({...tgt.spec,mpn:tgt.mpn},{...l.spec,mpn:l.mpn}).ok,pr.title+" "+f.comment);}
}
// Checks.
const check=id=>an.checks.find(x=>x.id===id);
assert.ok(check("missing-mpn").count>=3);
assert.ok(check("e-series").items.some(i=>/4.8 kΩ/.test(i.text)));

// Apply as one step; ratings and params are copied; stale analyses refuse.
const all=an.proposals.filter(x=>x.applicable).map(x=>x.id);
const sum=O.after(an,all);assert.ok(sum.lineItemsAfter<an.summary.lineItems);
const r=O.apply(proj,an,all);assert.ok(r.changed>0);
const r5=sch.items.find(i=>i.ref==="R5");
assert.equal(r5.parameters.Tolerance,"1%");assert.equal(r5.parameters["Manufacturer Part Number"],"RC0603FR-0710KL");assert.equal(r5.value,"10 kΩ");
assert.equal(brd.items.find(i=>i.ref==="R5").value,"10 kΩ","board copy follows");
assert.equal(sch.items.find(i=>i.ref==="C6").value,"100 nF X7R 50 V");
assert.throws(()=>O.apply(proj,an,all));
const an2=O.analyse(proj);
assert.ok(an2.summary.lineItems<an.summary.lineItems);
assert.ok(!an2.proposals.some(x=>x.applicable&&x.kind==="C"),"capacitors consolidated");
A.validate(proj);

// Package advisories are never applicable.
const pk=AtriumParts.example();const r0603=pk.library.find(x=>x.id==="std-r");
const r0402={...A.clone(r0603),id:"std-r-0402"};r0402.footprint.name="R_0402";pk.library.push(r0402);
pk.documents[0].items.push({...A.clone(pk.documents[0].items.find(i=>i.ref==="R1")),id:"s-R9",ref:"R9",def:"std-r-0402",link:"l9"});
pk.documents[1].items.push({...A.clone(pk.documents[1].items.find(i=>i.ref==="R1")),id:"b-R9",ref:"R9",def:"std-r-0402",link:"l9"});
const pa=O.analyse(pk).proposals.find(x=>x.subtype==="package");
assert.ok(pa&&!pa.applicable);assert.throws(()=>O.apply(pk,O.analyse(pk),[pa.id]));

// DC bias from net names.
const nb=AtriumParts.example();const c2=nb.documents[1].items.find(i=>i.ref==="C2");
c2.pinNets={"1":"+5V","2":"GND"};nb.documents[0].items.find(i=>i.ref==="C2").value="100nF 6.3V X7R";
let bias=O.analyse(nb).checks.find(x=>x.id==="dc-bias");
assert.ok(bias&&bias.items[0].severity==="warning"&&/10 V/.test(bias.items[0].text));
nb.documents[0].items.find(i=>i.ref==="C2").value="100nF 4V X7R";
assert.equal(O.analyse(nb).checks.find(x=>x.id==="dc-bias").items[0].severity,"error");
nb.documents[0].items.find(i=>i.ref==="C2").value="100nF 16V X7R";
assert.ok(!O.analyse(nb).checks.find(x=>x.id==="dc-bias"));
// Resistor power: 100 Ω across 5 V is 250 mW, above 0603's typical 100 mW.
const r2=nb.documents[1].items.find(i=>i.ref==="R2");r2.pinNets={"1":"+5V","2":"GND"};
const pw=O.analyse(nb).checks.find(x=>x.id==="power");
assert.ok(pw&&pw.items[0].severity==="error"&&/typically/.test(pw.items[0].text));
// Headless entry point on AtriumBOM.
assert.equal(typeof B.optimise,"function");assert.ok(B.optimise(nb).proposals);

// ------------------------------------------------------------ inline hints (bom.js Lines grid)
{
  require("../../app/editor/prefs-storage.js");
  const hp=AtriumParts.example(),[hs,hb]=hp.documents;
  const put=(ref,base,value,params)=>{
    const s={...A.clone(hs.items.find(i=>i.ref===base)),id:"s-"+ref,ref,link:"link-"+ref,value};if(params)s.parameters=params;
    hs.items.push(s);hb.items.push({...A.clone(hb.items.find(i=>i.ref===base)),id:"b-"+ref,ref,link:"link-"+ref,value});};
  put("C3","C2","100nF 16V X7R");put("C4","C2","0.1uF 50V X7R");put("C5","C2","100n 25V X5R");put("R8","R1","4k8");
  let col=B.collect(hp),key=O.contentKey(col);
  assert.equal(O.contentKey(B.collect(hp)),key,"same content, same key");
  const ha=O.analyseCached(hp,key,{collected:col});
  assert.equal(O.analyseCached(hp,key,{collected:col}),ha,"one analysis per key");
  assert.equal(O.cachedAnalysis(hp,key),ha);assert.equal(O.cachedAnalysis(hp,"other"),null);
  let H=O.hints(ha);
  const merge=H.list.find(h=>h.kind==="merge"&&h.parts.includes("s-C3"));
  assert.ok(merge&&merge.applicable,"capacitor merge hint");
  for(const id of ["s-C3","s-C4","s-C5"])assert.ok(merge.parts.includes(id),id);
  assert.ok(merge.groups.length>=2&&merge.groups[0].includes("s-C4"),"the kept line (50 V X7R) is the first group");
  const series=H.list.find(h=>h.kind==="series");
  assert.ok(series&&series.parts.includes("s-R8")&&series.severity==="warning","4k8 is outside E96/E24");
  assert.ok(!H.list.some(h=>h.check==="e-series"&&h.severity==="info"),"E48/E96 notes stay in the Optimise tab");
  assert.equal(H.count,H.list.length);assert.equal(H.lines,H.list.filter(h=>h.applicable).reduce((n,h)=>n+h.savings.lines,0));
  // Placement: every grid line holding a part of the merge is marked, whatever the grouping; others aren't.
  let rows=B.build(col),RH=B.rowHints(rows,H);
  const rowOf=ref=>rows.find(r=>r.refs.includes(ref));
  for(const ref of ["C3","C4","C5"])assert.ok(RH.get(rowOf(ref))?.includes(merge),ref+" marked");
  assert.ok(RH.get(rowOf("R8")).includes(series));
  for(const ref of ["U1","J1"])assert.ok(!RH.has(rowOf(ref)),ref+" unmarked");
  rows=B.build(col,{groupBy:["footprint"]});RH=B.rowHints(rows,H);
  assert.ok(RH.get(rows.find(r=>r.refs.includes("C3"))).includes(merge),"grouped by footprint, still marked");
  assert.equal(B.rowHints(rows,null).size,0);
  // DC bias and power warnings land on the part's own line.
  const nb2=AtriumParts.example();nb2.documents[1].items.find(i=>i.ref==="C2").pinNets={"1":"+5V","2":"GND"};
  nb2.documents[0].items.find(i=>i.ref==="C2").value="100nF 6.3V X7R";
  const bh=O.hints(O.analyse(nb2)).list.find(h=>h.kind==="bias");
  const nbRows=B.build(B.collect(nb2));
  assert.ok(bh&&bh.parts.length===1&&B.rowHints(nbRows,O.hints(O.analyse(nb2))).get(nbRows.find(r=>r.refs.includes("C2"))).some(h=>h.kind==="bias"));
  // MCP output keeps its shape: no internal line keys or part ids.
  assert.ok(O.summarise(ha).checks.every(c=>c.items.every(i=>!("keys" in i)&&!("ids" in i))));
  // Dismissals: per project, in localStorage under a registered "state" prefix, never in the project.
  const mem=new Map(),store={getItem:k=>mem.has(k)?mem.get(k):null,setItem:(k,v)=>mem.set(k,String(v)),removeItem:k=>mem.delete(k)};
  const dz=O.dismissals("/work/Board.waffle",store);
  assert.ok(dz.key.startsWith(O.DISMISS_PREFIX));assert.equal(AtriumPrefsStorage.kind(dz.key),"state");
  dz.add(series.id);
  assert.ok(O.dismissals("/work/Board.waffle",store).has(series.id),"survives reopening");
  assert.ok(!O.dismissals("/work/Other.waffle",store).has(series.id),"per project");
  const before=JSON.stringify(hp);
  let H2=O.hints(ha,{dismissed:dz});
  assert.ok(!H2.list.some(h=>h.id===series.id)&&H2.count===H.count-1);
  assert.ok(!B.rowHints(B.build(col),H2).has(rowOf("R8")),"a dismissed hint leaves its line");
  assert.equal(JSON.stringify(hp),before);
  dz.remove(series.id);assert.equal(mem.size,0,"nothing stored once empty");
  // Apply is one undo step through the editor's edit(), and the hints follow the edit.
  const history=[],edit=fn=>{history.push(JSON.stringify(hp));fn();};
  const undo=()=>{const s=JSON.parse(history.pop());hp.documents=s.documents;hp.library=s.library;};
  const res=O.applyHint(hp,ha,merge.id,edit);
  assert.equal(history.length,1,"one undo step");assert.ok(res.parts>=2);
  assert.equal(hs.items.find(i=>i.ref==="C3").value,"100 nF X7R 50 V");
  assert.throws(()=>O.applyHint(hp,ha,series.id,edit),"advice can't be applied");
  assert.throws(()=>O.applyHint(hp,ha,"nope",edit),/no longer applies/);
  assert.equal(history.length,1);
  col=B.collect(hp);const key2=O.contentKey(col);
  assert.notEqual(key2,key,"an edit changes the key");
  H=O.hints(O.analyseCached(hp,key2,{collected:col}));
  assert.ok(!H.list.some(h=>h.id===merge.id),"applied merge is gone");
  rows=B.build(col);assert.ok(!B.rowHints(rows,H).has(rows.find(r=>r.refs.includes("C3")))||!B.rowHints(rows,H).get(rows.find(r=>r.refs.includes("C3"))).some(h=>h.kind==="merge"));
  undo();
  assert.equal(JSON.stringify(hp),before,"undo restores the design");
  // A cell edit (4k8 -> 4k7) removes the E-series hint on that line.
  B.applyChanges(hp,B.planEdit([B.collect(hp).parts.find(e=>e.ref==="R8")],"comment","4k7"));
  col=B.collect(hp);H=O.hints(O.analyseCached(hp,O.contentKey(col),{collected:col}));
  rows=B.build(col);assert.ok(!(B.rowHints(rows,H).get(rows.find(r=>r.refs.includes("R8")))||[]).some(h=>h.kind==="series"),"hint updates after the edit");
}

// ------------------------------------------------------------ suppliers
const lines=[{key:"a",refs:["R1","R2"],qty:2,comment:"10k",mpn:"RC0603FR-0710KL",manufacturer:"Yageo",kind:"R",value:"10 kΩ",valueKey:"R10000",package:"0603",spec:{kind:"R",tolerance:1}},
  {key:"b",refs:["C1"],qty:1,comment:"100nF",kind:"C",value:"100 nF",valueKey:"C1e-7",package:"0402",spec:{kind:"C",voltage:16,dielectric:"X7R"}},
  {key:"c",refs:["U1"],qty:1,comment:"Buffer",kind:null}];
assert.equal(O.queryFor(lines[0]).mpn,"RC0603FR-0710KL");
assert.equal(O.queryFor(lines[1]).text,"100nF 0402 capacitor X7R 16V");
assert.equal(O.queryFor(lines[2]),null);
const calls=[];
function fakeFetch(routes){return async(url,init)=>{calls.push({url,init});const h=routes.find(r=>url.startsWith(r[0]));if(!h)return {ok:false,status:404,json:async()=>({})};return {ok:true,status:200,json:async()=>h[1](url,init)};};}
const mouserJson={Errors:[],SearchResults:{NumberOfResult:1,Parts:[{ManufacturerPartNumber:"RC0603FR-0710KL",Manufacturer:"YAGEO",Description:"Thick Film Resistors - SMD 1/10W 10K ohm 1%",
  MouserPartNumber:"603-RC0603FR-0710KL",AvailabilityInStock:"125000",Min:"1",Mult:"1",LifecycleStatus:null,ProductDetailUrl:"https://www.mouser.com/x",
  PriceBreaks:[{Quantity:1,Price:"$0.10",Currency:"USD"},{Quantity:100,Price:"$0.012",Currency:"USD"},{Quantity:1000,Price:"$0.004",Currency:"USD"}]}]}};
const dkJson={SearchLocaleUsed:{Currency:"USD"},Products:[{ManufacturerProductNumber:"RC0603FR-0710KL",Manufacturer:{Name:"YAGEO"},Description:{ProductDescription:"RES 10K OHM 1% 1/10W 0603"},
  QuantityAvailable:500,ProductStatus:{Status:"Active"},ProductUrl:"https://www.digikey.com/x",ProductVariations:[{DigiKeyProductNumber:"311-10.0KHRCT-ND",MinimumOrderQuantity:1,QuantityAvailableforPackageType:500,
  StandardPricing:[{BreakQuantity:1,UnitPrice:0.1},{BreakQuantity:10,UnitPrice:0.011}]}]}]};
const nexarJson={data:{supSearchMpn:{results:[{part:{mpn:"RC0603FR-0710KL",manufacturer:{name:"YAGEO"},shortDescription:"10k",specs:[{attribute:{shortname:"lifecyclestatus"},displayValue:"NRND"}],
  sellers:[{company:{name:"Farnell"},offers:[{sku:"F1",inventoryLevel:20,moq:5,prices:[{quantity:5,price:0.02,currency:"USD"}]}]}]}}]}}};
const fetch=fakeFetch([["https://api.mouser.com/api/v1/search/partnumber",()=>mouserJson],["https://api.mouser.com/api/v1/search/keyword",()=>({Errors:[],SearchResults:{Parts:[]}})],
  ["https://api.digikey.com/v1/oauth2/token",()=>({access_token:"T",expires_in:600})],["https://api.digikey.com/products/v4/search/keyword",()=>dkJson],
  ["https://identity.nexar.com/connect/token",()=>({access_token:"N",expires_in:600})],["https://api.nexar.com/graphql",()=>nexarJson]]);
const mo=O.provider("mouser",{fetch,settings:{apiKey:"KEY"}});
globalThis.__testDone=(async()=>{
  const found=await mo.search("RC0603FR-0710KL");
  assert.equal(found[0].offers[0].stock,125000);assert.equal(found[0].offers[0].priceBreaks[1].price,0.012);
  assert.ok(calls[0].url.includes("apiKey=KEY")&&calls[0].init.method==="POST"&&calls[0].init.credentials==="omit");
  assert.equal(JSON.parse(calls[0].init.body).SearchByPartRequest.mouserPartNumber,"RC0603FR-0710KL");
  calls.length=0;O.clearCache();
  const providers=[O.provider("mouser",{fetch,settings:{apiKey:"KEY"}}),O.provider("digikey",{fetch,settings:{clientId:"id",clientSecret:"sec"}}),O.provider("nexar",{fetch,settings:{clientId:"id",clientSecret:"s"}})];
  const priced=await O.price(lines,{providers,interval:0,session:null});
  // Privacy: nothing but the MPN or the value query leaves.
  for(const x of calls){const all=x.url+" "+(x.init.body||"");for(const bad of ["R1","R2","C1","Sensor","link-","FILTER","VDD"])assert.ok(!new RegExp("\\b"+bad+"\\b").test(all.replace(/RC0603FR-0710KL/g,"")),bad+" leaked in "+all);}
  assert.equal(priced.lines.get("a").parts.length,3);
  const cs=O.cost(lines,priced,{boards:100});
  const a=cs.rows.find(r=>r.key==="a");
  assert.equal(a.need,200);assert.equal(a.chosen.supplier,"DigiKey");assert.ok(Math.abs(a.chosen.unit-0.011)<1e-9);
  assert.ok(cs.rows.find(r=>r.key==="b").flags.includes("no-match"));assert.ok(cs.rows.find(r=>r.key==="c").flags.includes("no-query"));
  const n1=calls.length;await O.price(lines,{providers,interval:0,session:null});assert.equal(calls.length,n1,"cached");
  // JLC offline library: basic parts win once the extended fee counts.
  const csv="LCSC Part,First Category,Second Category,MFR.Part,Package,Solder Joint,Manufacturer,Library Type,Description,Datasheet,Price,Stock\n"+
    "C1525,Capacitors,MLCC,CL05B104KO5NNNC,0402,2,Samsung,Basic,\"100nF ±10% 16V X7R 0402 MLCC\",,\"1-9:0.0016,10-99:0.0010\",5000000\n"+
    "C99999,Capacitors,MLCC,GRM155R71H104KE14D,0402,2,Murata,Extended,\"100nF ±10% 50V X7R 0402 MLCC\",,\"1-9:0.0009\",900000\n"+
    "C11111,Capacitors,MLCC,X,0402,2,Other,Basic,\"100nF ±20% 10V X5R 0402 MLCC\",,\"1-:0.0001\",9\n"+
    "C2,Resistors,Chip,UNRELATED,0805,2,Other,Basic,\"1kΩ 1% 0805\",,\"1-:0.001\",10\n";
  const cat=O.jlcCatalogue(csv,{want:{mpn:new Set(),lcsc:new Set(),values:new Set(["C1e-7|0402"])}});
  assert.equal(cat.rows,4);assert.equal(cat.kept,3);
  const jp=[O.provider("jlc-library",{settings:{catalogue:cat}})];
  const jl=await O.price([lines[1]],{providers:jp,session:null});
  assert.equal(jl.lines.get("b").parts.length,2,"X5R/10V part rejected as a downgrade");
  let jc=O.cost([lines[1]],jl,{boards:10,jlc:{enabled:true,extendedFee:3}});
  assert.equal(jc.rows[0].chosen.sku,"C1525");assert.equal(jc.rows[0].chosen.basic,true);assert.equal(jc.fees,0);
  jc=O.cost([lines[1]],jl,{boards:10,jlc:{enabled:false}});
  assert.equal(jc.rows[0].chosen.sku,"C99999");
  assert.deepEqual(O.priceList("20-180:0.0043,200-:0.0035").map(x=>x.qty),[20,200]);
  assert.equal(O.money("0,10 €"),0.1);assert.equal(O.money("$1,234.50"),1234.5);
  assert.equal(O.lifecycle("Not Recommended for New Designs"),"nrnd");assert.equal(O.lifecycle("End of Life"),"eol");
  // Stubs refuse rather than guess.
  await O.provider("lcsc",{}).search("C1525").then(()=>assert.ok(false),()=>{});
  // Settings never carry an imported catalogue.
  const store={v:null,getItem(){return this.v;},setItem(k,v){this.v=v;}};
  O.saveSettings({providers:{"jlc-library":{enabled:true,catalogue:cat},mouser:{apiKey:"k"}}},store);
  assert.ok(!store.v.includes("C1525")&&O.loadSettings(store).providers.mouser.apiKey==="k");
  // Optimised export report.
  const rep=O.report(proj,an2,{costing:null,date:"2026-11-18",created:"2026-11-18T00:00:00Z"});
  assert.ok(rep.rows.length===an2.summary.lineItems||rep.rows.length<=an2.summary.lineItems);
  assert.ok(B.csv(rep).includes("Manufacturer Part Number"));

  // ------------------------------------------------------------ benchmark
  const big=AtriumParts.example(),[bs,bb]=big.documents;
  // About 2,000 distinct lines: E96 values across decades, mixed notation,
  // tolerances, capacitor ratings and part numbers, two parts per line.
  const E=O.SERIES.E96,caps=["16V X7R","50V X7R","25V X5R","10V X5R","50V C0G"];
  for(let i=0;i<5200;i++){
    const k=i>>1,isCap=k%4===3,ref=(isCap?"C":"R")+(100+i);
    const m=E[k%96],dec=Math.floor(k/96)%9;
    const v=isCap?O.formatValue(m*10**(dec-11),"C").replace(" ","")+" "+caps[k%5]:(k%3?String(Number((m*10**dec).toPrecision(3))):O.formatValue(m*10**dec,"R"))+(k%5===0?" 5%":k%5===1?" 1%":"");
    const base=isCap?"C2":"R1";
    const s={...A.clone(bs.items.find(x=>x.ref===base)),id:"s"+i,ref,value:v,link:"L"+i};
    if(k%3===0)s.parameters={"Manufacturer Part Number":"MPN"+k,Manufacturer:"M"+(k%3)};
    bs.items.push(s);bb.items.push({...A.clone(bb.items.find(x=>x.ref===base)),id:"b"+i,ref,value:v,link:"L"+i});
  }
  let t=performance.now();const ban=O.analyse(big);const ms=performance.now()-t;
  console.log("bench: "+ban.summary.parts+" parts, "+ban.summary.lineItems+" lines, "+ban.proposals.length+" proposals, "+ms.toFixed(1)+" ms");
  assert.ok(ban.summary.lineItems>=2000,"synthetic BOM has "+ban.summary.lineItems+" lines");
  assert.ok(ms<3000);
  // Lines-grid hints on the same BOM: hints + per-line placement + the content key, all cheap.
  const bcol=B.collect(big),brows=B.build(bcol);
  t=performance.now();const bh=O.hints(ban);const th=performance.now()-t;
  t=performance.now();const brh=B.rowHints(brows,bh);const tr=performance.now()-t;
  t=performance.now();O.contentKey(bcol);const tk=performance.now()-t;
  console.log("bench hints: "+brows.length+" grid lines, "+bh.count+" hints on "+brh.size+" lines · hints "+th.toFixed(1)+" ms · placement "+tr.toFixed(1)+" ms · content key "+tk.toFixed(1)+" ms");
  assert.ok(th+tr+tk<500);
  console.log("bom-optimiser tests passed");
})().catch(e=>{console.log("FAILED "+e.message+"\n"+e.stack);process.exitCode=1;throw e;});
