"use strict";
const assert = require("node:assert/strict");
require("../../app/notebook/calculation-intent.js");
require("../../app/notebook/calculation-core.js");
const core = globalThis.AtriumCalculationCore;
const intent = globalThis.AtriumCalculationIntent;
function valid(source, options) {
  const result = core.evaluate(source, options);
  assert.ok(result.ok, source + " " + JSON.stringify(result.diagnostic));
  return result;
}
function fails(source, code, options) {
  const r = core.evaluate(source, options);
  assert.equal(r.ok, false, source);
  assert.equal(r.diagnostic.code, code, source);
  assert.ok(r.diagnostic.span[0] >= 0 && r.diagnostic.span[1] <= source.length, source);
}
function near(actual, expected, epsilon=1e-12) {
  assert.ok(actual === expected || Math.abs(actual-expected) <= epsilon*Math.abs(expected), actual+" vs "+expected);
}
const zero = [0,0,0,0,0,0,0], ohm = [2,1,-3,-2,0,0,0];
for (const [source, display] of [
  ["10k || 4.7k","3.197 k"], ["10kΩ ∥ 4.7kΩ","3.197 kΩ"],
  ["1/(2π·10k·10n)","1.592 k"], ["1/(2*pi*10k*10n)","1.592 k"],
  ["3.3V/10mA","330 Ω"], ["50 mil in mm","1.27 mm"], ["20·log10(2)","6.021 dB"],
  ["2**3**2","512"], ["-2^2","-4"], ["(-2)^2","4"], ["2^-3","125 m"],
  ["(2*pi)**2","39.48"], ["sin(90deg)","1"], ["sqrt(4 mm²)","2 mm"],
  ["-20 °C in K","253.1 K"], ["(-8)^(1/3)","-2"], ["5 kΩ - 10k ohm","-5 kΩ"]
]) assert.equal(valid(source).display,display,source);
assert.deepEqual(valid("10k||4.7k").dimensions,zero);
assert.deepEqual(valid("10kΩ∥4.7kΩ").dimensions,ohm);
near(valid("10k || 4.7k").value,470000/147);
for (const [s,v] of [["10m",.01],["10M",1e7],["10meg",1e7],["10µ",1e-5],["10μ",1e-5],["10u",1e-5],["2 in",.0508],["3.3E24",3.3e24]]) near(valid(s).value,v);
assert.equal(valid("1.00000000000000011102230246251565404236316680908203125").value,1);
assert.equal(valid("1.00000000000000011102230246251565404236316680908203126").value,1.0000000000000002);
assert.equal(valid("1e-320").value,Number("1e-320"));
assert.equal(valid("0.1 V + 0.2 V",{displayUnit:"mV"}).display,"300 mV");
assert.equal(core.format(valid("1.27 mm"),"mil"),"50 mil");
assert.equal(valid("0 °C - -5 °C").value,5);
assert.equal(valid("0 °C + 5 Δ°C").display,"5 °C");
const units = core.quantity(179,"ppm/K");
near(core.as(units,"ppm/K"),179);
assert.equal(core.as(core.quantity(5,"%"),"%"),5);
for (const [source,code] of [["3.3k E24","syntax"],["10kΩ ∥ 4.7k","dimension"],["1V + 1A","dimension"],["1V in A","dimension"],["1/0","domain"],["1/(1 ± 2)","domain"],["ln(0)","domain"],["log10(1V)","dimension"],["sqrt(-1)","domain"],["1 V ^ pi","dimension"],["10V ± -1V","tolerance"],["0 °C * 2","unit"],["10 V ± 1 A","dimension"],["assert 3","assertion"],["noSuchFunc(1)","function"],["constructor(1)","function"],["globalThis.process","reference"],["1e400","numeric"],["((((1","syntax"]]) fails(source,code);
const r5={raw:"10k",unit:"Ω",sourceId:"part/5",label:"R5",tolerance:{relative:.01}};
const c3={raw:"1n",unit:"F",sourceId:"part/3",label:"C3",tolerance:{relative:.05}};
const bindings={R5:r5,"R5.Value":r5,C3:c3};
const rc=valid("f_c = 1/(2π·R5·C3)",{bindings});
assert.equal(rc.name,"f_c"); assert.equal(rc.display,"15.92 kHz"); near(rc.value,1/(2*Math.PI*1e4*1e-9));
assert.ok(rc.worst.min < 1/(2*Math.PI*10100*1.05e-9));
assert.ok(rc.worst.max > 1/(2*Math.PI*9900*.95e-9));
assert.equal(valid("assert f_c > 10 kHz",{bindings:{f_c:rc}}).assertion.status,"pass");
const r2={...r5,raw:"4k7",sourceId:"part/2",label:"R2"};
const plus=valid("R5 + R2",{bindings:{R5:r5,R2:r2}});
assert.equal(plus.value,14700); assert.ok(plus.worst.min<=14553 && plus.worst.max>=14847);
near(plus.rss,Math.hypot(100,47));
assert.equal(valid("R5 - R5.Value",{bindings}).rss,0);
assert.deepEqual(valid("R5 - (R5.Value)",{bindings}).worst,{min:0,max:0});
assert.deepEqual(valid("R5 / R5",{bindings}).worst,{min:1,max:1});
assert.equal(valid("R5 * R5",{bindings}).warnings.some(x=>x.includes("conservative")),true);
assert.equal(valid("nominal(R5)",{bindings}).rss,0);
assert.deepEqual(valid("Balance - Balance",{bindings:{Balance:plus}}).worst,{min:0,max:0});
const missing={R5:{...r5,tolerance:undefined},C3:{...c3,tolerance:undefined}};
const plain=valid("1/(2π*R5*C3)",{bindings:missing});
assert.equal(plain.rss,0); assert.deepEqual(plain.warnings,["tolerance unknown: R5, C3"]);
const uncertainPass=valid("assert R5 > 0Ω",{bindings:missing});
assert.deepEqual(uncertainPass.warnings,["tolerance unknown: R5"]);
const def=valid("R5 * C3",{bindings:{R5:{...r5,toleranceSource:"default"},C3:missing.C3}});
assert.ok(def.warnings.some(w=>w.includes("R5 (±1%)"))); assert.ok(def.warnings.includes("tolerance unknown: C3"));
assert.deepEqual(valid("R5",{bindings:{R5:{...r5,tolerance:{relative:0}}}}).warnings,[]);
for (const [source,status] of [["assert 3.366V = 3.3V ± 2%","pass"],["assert 3.4V = 3.3V ± 2%","fail"],["assert (3.365V ± .015V) = 3.3V ± 2%","may-violate"],["assert 1.0000000000005 = 1","pass"],["assert 1.000000000002 = 1","fail"],["assert 1e-300 = 0","fail"],["assert 1.0000000000005 > 1","fail"],["assert 1.0000000000005 >= 1","pass"]]) assert.equal(valid(source).assertion.status,status,source);
for (const [raw,unit,value] of [["4k7","Ω",4700],["R47","Ω",.47],["10k","Ω",1e4],["10mV","V",.01],["10mV","Ω",.01],["2n2","F",2.2e-9],["-20°C","K",253.15]]) {
  const r=core.parseBoundValue(raw,{unit,sourceId:"placed",label:"X"}); assert.ok(r.ok,raw); near(r.value,value);
}
assert.equal(core.parseBoundValue("10k ± 25 Ω",{unit:"Ω",sourceId:"r"}).rss,25);
assert.equal(core.parseBoundValue("10kΩ ± 1%",{unit:"Ω",sourceId:"r",tolerance:{relative:.3}}).rss,100);
assert.equal(core.parseBoundValue("10mV",{unit:"V",sourceId:"v",tolerance:{absolute:1}}).rss,.001);
assert.equal(core.parseBoundValue("R5 + 2V",{unit:"V"}).ok,false);
const observed=[];
const net=valid("net VDD.voltage + Board::R5.Value",{resolve:r=>{observed.push(r); return {value:1,unit:"V",sourceId:r.name,tolerance:{absolute:0}};}});
assert.equal(net.value,2); assert.deepEqual(observed,[{name:"net VDD.voltage",span:[0,15]},{name:"Board::R5.Value",span:[18,33]}]);
const mismatch=core.evaluate("π + 3Ω"); assert.deepEqual(mismatch.diagnostic.span,[2,3]);
assert.equal(core.parse("(".repeat(70)+"1"+")".repeat(70)).ok,false);
fails("1+2","aborted",{signal:{aborted:true}});
for (const s of ["artwork","@R5",":12,3",">Draw","/res","search the library"]) assert.equal(intent.acceptsPaletteText(s),false,s);
for (const s of ['bands("yellow',"1/(","R5.Value*2","Vout=3","nearest E96 3k","3.3k in E24","2**3","period(10Hz)"]) assert.equal(intent.acceptsPaletteText(s),true,s);
const divider={id:"example.divider",version:"1.0.0",arguments:[{name:"vin",dimension:"voltage"},{name:"rtop",dimension:"resistance"},{name:"rbottom",dimension:"resistance"}],returns:"voltage",domain:"rtop >= 0 && rbottom > 0",expression:"vin·rbottom/(rtop+rbottom)",dependencies:[]};
const args=[{value:5,dimension:"voltage"},{value:1000,dimension:"resistance"},{value:2000,dimension:"resistance"}];
assert.equal(core.evaluateFunction(divider,args).display,"3.333 V");
assert.equal(core.evaluateFunction(divider,[...args.slice(0,2),{value:0,dimension:"resistance"}]).diagnostic.code,"domain");
assert.equal(core.evaluateFunction(divider,[{value:5,dimension:"power"},...args.slice(1)]).diagnostic.code,"dimension");
assert.equal(valid("example.divider(5V,1kΩ,2kΩ)",{functions:{"example.divider":divider}}).display,"3.333 V");
const wrap={id:"example.parent",version:"1",arguments:divider.arguments,returns:"voltage",expression:"example.divider(vin,rtop,rbottom)",dependencies:[{id:divider.id,version:divider.version}]};
assert.equal(core.evaluateFunction(wrap,args,{functions:{[divider.id]:divider}}).ok,true);
assert.equal(core.evaluateFunction({...wrap,dependencies:[]},args,{functions:{[divider.id]:divider}}).diagnostic.code,"function");
assert.equal(core.evaluateFunction({...wrap,dependencies:[{id:divider.id,version:"0"}]},args,{functions:{[divider.id]:divider}}).diagnostic.code,"function");
const recurse={...wrap,expression:"example.parent(vin,rtop,rbottom)",dependencies:[{id:wrap.id,version:wrap.version}]};
assert.equal(core.evaluateFunction(recurse,args,{functions:{[recurse.id]:recurse}}).diagnostic.code,"cycle");
assert.equal(core.evaluateFunction({...divider,expression:"design.secret"},args).diagnostic.code,"reference");
console.log("calculation-core: arithmetic, dimensions, references, interval/RSS, assertions, extension expressions and limits");
fails('nearest(3.3k,"E24")',"syntax");
const domainList={...divider,domain:["rtop >= 0 ohm","rbottom > 0 ohm"]};
assert.equal(core.validateFunctions([domainList]).ok,true);
assert.equal(core.evaluateFunction(domainList,args).display,"3.333 V");
assert.equal(core.validateFunctions([wrap],{functions:{[divider.id]:divider}}).ok,true);
assert.equal(core.validateFunctions([wrap]).diagnostic.code,"function");
assert.equal(core.validateFunctions([recurse]).diagnostic.code,"cycle");
assert.equal(core.validateFunctions([{...divider,expression:"globalThis.fetch(vin)"}]).diagnostic.code,"function");
assert.equal(core.validateFunctions([{...divider,domain:"vin + 2V"}]).diagnostic.code,"domain");
assert.equal(core.validateFunctions([{...divider,returns:"fake-unit"}]).diagnostic.code,"function");
assert.equal(core.validateFunctions([{...divider,expression:"1+("}]).diagnostic.code,"syntax");
assert.equal(core.validateFunctions([{...divider,expression:"abs(vin,rtop)"}]).diagnostic.code,"arity");
assert.equal(core.validateFunctions([divider,divider]).diagnostic.code,"function");
assert.equal(core.validateFunctions([divider],{signal:{aborted:true}}).diagnostic.code,"aborted");

for (const expr of ["1 kg*metre/s² in N","1 kg*metre/s^2 in N","1 kg * metre / s² in N"])
  assert.equal(valid(expr).display,"1 N",expr);
assert.deepEqual(valid("1 V/A/s").dimensions,valid("1 Ω/s").dimensions);
assert.equal(valid("1 V/A/s in Ω/s").display,"1 Ω/s");
assert.equal(valid("(2 s) ^ 2 in s^2").display,"4 s^2");
assert.equal(valid("2 s^2 in s²").display,"2 s²");
assert.equal(core.validateFunctions([{...divider,domain:"(rtop >= 0 ohm)"}]).ok,true);

assert.equal(valid("200000000 m/s / 100 MHz").display,"2 m");
assert.deepEqual(valid("5 m^2").dimensions,valid("5 mm²").dimensions);
near(valid("10m/2").value,.005);

const hyphenFn={...divider,id:"vendor-tools.regulator.divider-out"};
assert.equal(core.validateFunctions([hyphenFn]).ok,true);
const hyphenOptions={functions:{[hyphenFn.id]:hyphenFn}};
assert.equal(valid("vendor-tools.regulator.divider-out(5V,1kΩ,2kΩ)",hyphenOptions).display,"3.333 V");
assert.equal(valid("5 V - vendor-tools.regulator.divider-out(5V,1kΩ,2kΩ)",hyphenOptions).display,"1.667 V");
assert.equal(valid("R5-R5",{bindings}).display,"0 Ω");

// The public resolver receives signal names as written and one span for the entire field.
for (const name of ["net VDD.voltage","net 48V.voltage",'net "Battery +/A::sense.1".voltage',
                    "net 'test.name (+)'.voltage",'net "A\\"B\\\\C".voltage']) {
  const expr=name+" + 1 V", token={name,span:[0,name.length]};
  assert.equal(intent.acceptsPaletteText(expr),true);
  assert.deepEqual(core.parse(expr).references,[token]);
  assert.equal(valid(expr,{resolve:ref=>{
    assert.deepEqual(ref,token);
    return {raw:"5 V",sourceId:"signal-48",tolerance:{absolute:0}};
  }}).value,6);
  fails(expr,"reference");
}
for (const input of ["net VDD.","net 48V.","net VDD.vol","net 'audio +",'net "rail /']) assert.equal(intent.acceptsPaletteText(input),true,input);
for (const search of ["net","net VDD","net 48V","net settings","network VDD.voltage"]) assert.equal(intent.acceptsPaletteText(search),false,search);
assert.equal(valid("2 V + net 48V.voltage",{bindings:{"net 48V.voltage":{raw:"5 V"}}}).display,"7 V");
assert.deepEqual(core.parse('net "a+b".voltage * 2').references,[{name:'net "a+b".voltage',span:[0,17]}]);

// Single-field inference and reusable nominal query operands use the notebook's typed quantities.
for (const [source,unit,expected] of [["250m","W","250 mW"],["1k","Ω","1 kΩ"],["5","%","5 %"],
  ["80","ppm/K","80 ppm/K"],["1.25","mm","1.25 mm"],["3","ea","3 ea"],["250 mW","W","250 mW"]]) {
  const field={unit}, value=core.evaluateField(source,field), plan=core.compileScalar(core.parse(source),field);
  assert.ok(value.ok,source); assert.equal(value.display,expected);
  const q=plan.read(); assert.equal(q.ok,true);
  assert.equal(core.compareNominal(value,q),0); assert.deepEqual(q.worst,value.worst); assert.equal(q.rss,value.rss);
}
assert.equal(core.evaluateField("250m",null).value,.25);
assert.equal(core.evaluateField("2*3",{unit:"W"}).diagnostic.code,"dimension");
assert.deepEqual(core.evaluateField("  250 mA ",{unit:"W"}).diagnostic.span,[2,8]);
assert.deepEqual(core.parseBoundValue("  4k7 mA ± 1%",{unit:"Ω",fieldUnit:"Ω"}).diagnostic.span,[2,8]);
assert.equal(core.parseBoundValue("10mV",{unit:"Ω"}).display,"10 mV");
fails("assert imported < 250m","dimension",{bindings:{imported:{raw:"10mV",unit:"Ω"}}});
for (const [source,inputUnit] of [["3%","%"],["5 ppm","ppm"],["1 scalar","scalar"],["250m",undefined],["2 V / 2 V in dimensionless","dimensionless"]])
  assert.equal(core.evaluateField(source,null).inputUnit,inputUnit,source);
const pwr={raw:"150m",unit:"W",fieldUnit:"W",tolerance:{relative:.1}};
assert.equal(valid("assert R1.Power < 250m",{bindings:{"R1.Power":pwr}}).assertion.status,"pass");
assert.equal(valid("assert 250m > (R1.Power)",{bindings:{"R1.Power":pwr}}).assertion.status,"pass");
const wrong="assert R1.Power < 250mA";
assert.deepEqual(core.evaluate(wrong,{bindings:{"R1.Power":pwr}}).diagnostic.span,[wrong.indexOf("250"),wrong.length]);
fails("assert (R1.Power + 0 W) < 250m","dimension",{bindings:{"R1.Power":pwr}});
const count={countQuery:()=>({complete:true,count:3})};
for (const [source,display] of [["3 pcs + 2 ea","5 ea"],["3 ea - 1 ea","2 ea"],["2 * 3 ea","6 ea"],
  ["6 ea / 2","3 ea"],["6 / 3 ea","2"],["6 ea / 3 pcs","2"],["count(LED)","3 ea"],
  ["count(LED) * 20 mA","60 mA"],["20 mA * count(LED)","60 mA"],["-count(LED)","-3 ea"],["abs(-3 ea)","3 ea"]])
  assert.equal(valid(source,count).display,display,source);
const exactCount=valid("count(LED)",{countQuery:()=>({complete:true,count:12345})});
assert.equal(exactCount.display,"12345 ea"); assert.equal(exactCount.copyText,"12345 ea");
assert.equal(core.format(exactCount,"pcs"),"12345 pcs");
assert.equal(core.format({kind:"quantity",tag:"count",dimensions:zero,value:12345}),"12345 ea");
assert.equal(core.compareNominal(exactCount,core.quantity(12345,"ea")),0);
assert.equal(valid("12345.5 ea").display,"12350 ea");
assert.equal(valid("12345 ea ± 1 ea").display,"12350 ea");
for (const bad of ["2","2 %","4 A","2 V / 2 V"])
  assert.deepEqual(core.evaluate("3 ea + "+bad).diagnostic.span,[7,7+bad.length]);
assert.equal(valid("assert count(LED) = 3",count).assertion.status,"pass");
assert.equal(valid("assert count(LED) = 3 pcs",count).assertion.status,"pass");
fails("assert count(LED) = 3 %","dimension",count);
fails("assert count(LED) = 3 V / 1 V","dimension",count);
for (const receipt of [null,{count:0,complete:false},{count:0,complete:true,status:"partial"},{count:-1,complete:true},{count:1.5,complete:true}])
  fails("assert count(LED) = 0 ea","query-incomplete",{countQuery:()=>receipt});
const nested='count(part where (designator like "💡*()") and power < 250m)';
const selection=nested.slice(6,-1), marker=selection.indexOf("250m");
assert.deepEqual(core.parse(nested).queries,[{source:selection,span:[6,nested.length-1]}]);
assert.equal(core.parse(nested).references.length,0);
assert.deepEqual(core.evaluate(nested,{countQuery:()=>({diagnostic:{code:"unit",message:"incompatible",span:[marker,marker+4]}})}).diagnostic.span,
  [nested.indexOf("250m"),nested.indexOf("250m")+4]);
assert.equal(core.validateFunctions([{...divider,expression:"count(LED) * 1 V"}]).ok,false);
assert.equal(intent.acceptsPaletteText("count(LED)"),true);
assert.equal(core.compileScalar("1*2").bareLiteral,false);
assert.equal(core.compileScalar("(-250m)").bareLiteral,true);
const expr="abs(width + 2 mm) / 2", ast=core.parse(expr), scalarPlan=core.compileScalar(ast,null);
// Reads must never dispatch on AST kinds again after the plan was constructed.
const poison=node=>{
  for (const k of ["arg","child","left","right","object"]) if (node[k]) poison(node[k]);
  for (const arg of node.args || []) poison(arg);
  Object.defineProperty(node,"type",{get(){throw Error("Scalar AST revisited during row evaluation");}});
};
poison(ast.ast);
for (const v of [.1,2,35]) {
  const opts={bindings:{width:{raw:v,unit:"mm",fieldUnit:"mm",sourceId:"pad",tolerance:{relative:.02}}}};
  const row=scalarPlan.read(opts), sheet=valid(expr,opts);
  assert.equal(core.compareNominal(row,sheet),0); assert.deepEqual(row.worst,sheet.worst); assert.equal(row.rss,sheet.rss);
}
assert.equal(core.compareNominal(core.quantity(1.0000000000005,"V"),core.quantity(1,"V")),0);
assert.throws(()=>core.compareNominal(core.quantity(1,"ea"),core.quantity(1,"%")));

// An absolute temperature is stored in kelvin. Every result that keeps the celsius scale
// shows it in °C, whichever operand carries the scale, and an interval never compares with it.
for (const [source,display] of [["max(0 °C, 100 °C)","100 °C"],["min(0 °C, 100 °C)","0 °C"],["max(20 °C)","20 °C"],
  ["max(300 K, 0 °C)","26.85 °C"],["5 Δ°C + 20 °C","25 °C"],["5 K + 20 °C","25 °C"],["sum(5 Δ°C, 20 °C)","25 °C"],
  ["average(20 °C, 30 °C)","25 °C"],["average(5 Δ°C, 10 Δ°C)","7.5 Δ°C"],["5 Δ°C + 5 Δ°C","10 Δ°C"],["abs(-5 Δ°C)","5 Δ°C"],
  ["5 % + 10 %","15 %"],["max(5 %, 10 %)","10 %"],["average(5 %, 10 %)","7.5 %"],["abs(-5 %)","5 %"],["abs(-30 deg)","30 °"]])
  assert.equal(valid(source).display,display,source);
assert.equal(valid("5 Δ°C + 20 °C").tag,"celsius"); near(valid("5 Δ°C + 20 °C").value,298.15);
near(valid("average(20 °C ± 1 Δ°C, 30 °C)").worst.max,298.65,1e-9);
for (const source of ["(5 Δ°C + 20 °C) * 2","(20 °C + 5 Δ°C) * 2","20 °C + 30 °C","max(0 °C, 5 Δ°C)","min(5 Δ°C, 300 K, 0 °C)",
  "average(20 °C, 5 Δ°C)","20 °C > 5 Δ°C","5 Δ°C <= 20 °C"]) fails(source,"unit");
fails("sum(3 ea, 2)","dimension");

// Copied text parses back to the displayed quantity: a dimensionless prefix touches its
// number (1T is not 1 tesla) and unprefixed length spells metre (2 m would be milli).
for (const [source,unit] of [["1e12"],["1e15"],["1.5e18"],["2.5e-15"],["1e-3"],["-4.7e3"],["0"],["3.3e24"],["1e40"],["1e-40"],["1/3"],
  ["2 metre"],["-2 metre"],["2 mm"],["1.5 km"],["1 ft"],["50 mil"],["2 m²"],["1e6 metre²"],["3 metre/s"],["9.8 metre/s/s"],
  ["1 kg"],["2 mg"],["1 T"],["1 mT"],["10 kΩ"],["3.3 V"],["1 nF"],["1 µH"],["5 GHz"],["24 Wb"],["1 V*1 A*1 s/1 K"],
  ["25 °C"],["-40 °C"],["max(0 °C, 100 °C)"],["5 Δ°C"],["100 °C - 20 °C"],["300 K"],["5 %"],["179 ppm/K"],["30 deg"],["1 rad"],["12 ea"],
  ["20*log10(2)"],["2 metre","m"],["2 metre","mm"],["2 mm","mil"],["2 inch","in"],["300 K","°C"],["1e12","%"],["1 T","T"]]) {
  const shown=valid(source,{displayUnit:unit}), again=valid(shown.copyText,{displayUnit:unit}), label=source+" → "+shown.copyText;
  assert.deepEqual(again.dimensions,shown.dimensions,label);
  assert.equal(again.tag==="celsius",shown.tag==="celsius" || unit==="°C",label);
  assert.ok(Math.abs(again.value-shown.value)<=5e-4*Math.abs(shown.value),label+" = "+again.value);
  assert.equal(again.display,shown.display,label);
}
assert.equal(valid("1e12").display,"1 T"); assert.equal(valid("1e12").copyText,"1T");
assert.equal(valid("2 metre").display,"2 m"); assert.equal(valid("2 metre").copyText,"2 metre");
assert.equal(valid("2 metre",{displayUnit:"m"}).copyText,"2 metre");

// An absolute temperature and an interval never convert into each other: the 273.15 offset
// belongs to the absolute scale only. A display unit picks the temperature scale family, and
// the value keeps its own kind, so an interval in a °C column shows in Δ°C and vice versa.
// Plain kelvin is coherent and takes the role the operation allows: an interval beside an
// absolute temperature, an absolute temperature when an absolute temperature is subtracted from it.
for (const source of ["(30 °C - 20 °C) in °C","(30 °C - 20 °C) in degC","25 °C in Δ°C","25 °C in deltaC","(5 Δ°C + 20 °C) in Δ°C"]) fails(source,"unit");
for (const [source,display,unit] of [["30 °C - 20 °C","10 Δ°C"],["30 °C - 20 °C","10 Δ°C","°C"],["30 °C - 20 °C","10 Δ°C","degC"],
  ["25 °C","25 °C","Δ°C"],["25 °C","298.1 K","K"],["30 °C - 20 °C","10 K","K"],["(30 °C - 20 °C) in Δ°C","10 Δ°C"],
  ["(30 °C - 20 °C) in K","10 K"],["25 °C in K","298.1 K"],["300 K in °C","26.85 °C"],["10 K in Δ°C","10 Δ°C"],
  ["max(10 K, 5 Δ°C)","10 Δ°C"],["-(30 °C - 20 °C)","-10 Δ°C"],["300 K - 20 °C","6.85 Δ°C"],["20 °C - 300 K","-280 °C"],
  ["300 K","26.85 °C","°C"],["300 K","300 Δ°C","Δ°C"]]) {
  const shown=valid(source,{displayUnit:unit});
  assert.equal(shown.display,display,source+" in "+unit); assert.equal(shown.copyText,display,source+" in "+unit);
}
assert.equal(valid("300 K - 20 °C").tag,"delta");
fails("5 Δ°C - 20 °C","unit");
assert.equal(valid("T - T",{bindings:{T:{raw:"25 °C"}}}).display,"0 Δ°C");
for (const [source,display] of [["average(5 Δ°C, 10 K)","7.5 Δ°C"],["average(30 deg, 60 deg)","45 °"],["average(30 deg, 1 rad)","0.7618 rad"]])
  assert.equal(valid(source).display,display,source);

// Every temperature, through every display unit, copies to text that re-parses to a quantity
// that behaves the same: same display, same scale and the same results in later formulas.
{
  const wrappers=["max(X, 0 °C)","min(X, 5 Δ°C)","max(X, 300 K)","average(X, 20 °C)","average(X, 5 Δ°C)","sum(X, 5 Δ°C)","abs(X)",
    "X + 5 Δ°C","X - 20 °C","X - 5 Δ°C","X > 0 °C","X < 5 Δ°C","X >= 300 K","X in K","X in °C","X in Δ°C","X*2"];
  const outcome=r=>r.ok ? r.display : r.diagnostic.code;
  for (const source of ["25 °C","-40 °C","0 °C","max(0 °C, 100 °C)","min(20 °C, 300 K)","average(20 °C, 30 °C)","20 °C + 5 Δ°C",
    "5 Δ°C","-5 Δ°C","30 °C - 20 °C","100 °C - 20 °C","abs(20 °C - 30 °C)","max(5 Δ°C, 10 Δ°C)","average(5 Δ°C, 10 Δ°C)","sum(5 Δ°C, 10 K)",
    "(30 °C - 20 °C) in Δ°C","25 °C in °C","300 K","300 K - 20 °C","10 K in Δ°C","300 K in °C"]) {
    for (const unit of [undefined,"°C","Δ°C","K","degC","deltaC"]) {
      const shown=valid(source,{displayUnit:unit}), again=valid(shown.copyText,{displayUnit:unit}), label=source+" in "+unit+" → "+shown.copyText;
      assert.equal(again.display,shown.display,label); assert.equal(again.copyText,shown.copyText,label);
      assert.ok(Math.abs(again.value-shown.value)<=5e-4*Math.abs(shown.value),label+" = "+again.value);
      // Only plain kelvin, which is coherent for both kinds, gives up the absolute/interval distinction.
      if (unit!=="K" && shown.tag) assert.equal(again.tag,shown.tag,label);
      if (again.tag!==shown.tag) continue;
      for (const w of wrappers) {
        const a=core.evaluate(w.replace("X","("+source+")")), b=core.evaluate(w.replace("X","("+shown.copyText+")"));
        assert.equal(outcome(b),outcome(a),label+" in "+w);
      }
    }
  }
}
