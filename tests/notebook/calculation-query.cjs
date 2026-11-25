"use strict";
const assert=require("node:assert/strict");
for (const file of ["model","parts","sch-objects","hierarchy","undo-store","note-fields","calculation-intent","calculation-core",
  "calculators","calculation-helpers","calculation-records","calculation-graph","calculation-design","calculation-checks",
  "calculation-actions","calculations","query-fields"]) require(require("../support/app-source-paths.cjs").appFile(file+".js"));

const C=AtriumCalculations, core=AtriumCalculationCore, F=AtriumQueryFields;
const defs=[
  {id:"led",prefix:"D",generic:{family:"led"}},{id:"diode",prefix:"D",generic:{family:"diode"}},
  {id:"res",prefix:"R",generic:{family:"resistor"},parameters:{Ripple:{id:"ripple",value:"1",unit:"mV"}}}
].map(def=>({...def,name:def.id,symbol:{pins:[],shapes:[]}}));
const project=Atrium.project("Shared quantities",defs), doc=project.documents[0];
doc.id="sheet";
const part=(id,def,ref,extra={})=>({kind:"part",id,def,ref,x:0,y:0,...extra});
const resistor=part("r1","res","R1",{value:"1k",parameters:{Power:"150m",TCR:"25",Ripple:"250"}});
doc.items.push(part("lamp1","led","D1"),part("lamp2","led","D2"),part("diode","diode","D3"),resistor);
const source="LEDs = count(LED) * 20 mA";
const block=AtriumCalculationRecords.backing({id:"bias",x:0,y:0,source,
  assertions:[{id:"must-fit",source:"assert count(LED) = 2 ea",bindings:[]}]});
doc.items.push(block);
const lazy=[];
globalThis.AtriumLazy={modules:()=>["AtriumDesignQuery"],need(name) {
  lazy.push(name); assert.equal(name,"AtriumDesignQuery");
  require("../../app/checks/design-query.js");
  return Promise.resolve(AtriumDesignQuery);
}};
const opts={documentId:doc.id,revision:"s1"};
const answer=(text,o={},rev=opts.revision)=>C.answer({queryId:"test",documentId:doc.id,text,projectRevision:rev},{project,...o});
async function main() {
  assert.equal((await answer("10k || 4.7k")).display,"3.197 k");
  assert.equal((await answer("1/(2*pi*10k*10n)")).display,"1.592 k");
  // The declaration registry is sufficient for native design bindings and number fields.
  assert.equal((await answer("assert R1.Power < 250m")).result.assertion.status,"pass");
  assert.equal(core.compareNominal((await answer("R1.TCR * 2")).result,core.quantity(50,"ppm/K")),0);
  assert.equal((await answer("R1.Ripple")).display,"250 mV");
  assert.equal((await answer("R1.Power * 2")).display,"300 mW");
  assert.deepEqual(lazy,[]);
  assert.equal(globalThis.AtriumDesignQuery,undefined);

  const unchanged=JSON.stringify(project);
  const first=await C.evaluate(project,{...opts,blockId:block.id});
  assert.deepEqual(lazy,["AtriumDesignQuery"]);
  assert.equal(first.records[0].result.display,"40 mA"); assert.equal(first.records[0].assertions[0].status,"pass");
  assert.deepEqual(C.evaluateSnapshot(project,opts).records,first.records);
  const invoice=await answer("count(LED)"), qty=F.describe(project,{kind:"bom",field:"qty"});
  assert.equal(invoice.display,"2 ea"); assert.equal(qty.unit,"ea");
  assert.equal(core.compareNominal(invoice.result,F.adapt("2 pcs",qty).quantity),0);
  assert.equal((await answer("count(part where designator like \"D*\")")).display,"3 ea");
  const declared=F.describe(project,{kind:"resistor",field:"power"});
  const constant=F.adapt("250m",declared).quantity;
  assert.equal(constant.display,"250 mW"); assert.equal(core.compareNominal(constant,core.evaluate("0.25 W")),0);
  const query=AtriumDesignQuery.compile("resistor where power < 250m",AtriumDesignQuery.context(project,doc));
  assert.equal(query.ok,true); assert.equal(query.plan.matches(resistor),true);
  const mismatch="resistor where power < 250mA";
  assert.deepEqual(AtriumDesignQuery.compile(mismatch,AtriumDesignQuery.context(project,doc)).diagnostics[0].span,
    [mismatch.indexOf("250"),mismatch.length]);
  const bad="count("+mismatch+")";
  assert.deepEqual((await answer(bad)).span,[bad.indexOf("250"),bad.length-1]);

  // The worker receives scalar receipts. Two identical selectors from this occurrence share one read.
  const reads=[];
  const exact=await C.evaluate(project,{...opts,blockId:block.id,countQuery:(selector,ctx)=>{
    reads.push([selector,ctx.documentId,ctx.revision]);
    return AtriumDesignQuery.count(selector,ctx);
  }});
  assert.deepEqual(reads,[["LED",doc.id,opts.revision]]);
  assert.equal(exact.records[0].assertions[0].status,"pass");
  const denied={readProject:false};
  const hidden=await answer("count(LED)",{authority:denied});
  assert.equal(hidden.state,"diagnostic"); assert.equal(hidden.diagnostic.code,"denied");
  assert.equal(hidden.result,undefined);
  const fieldDenied={canReadField:key=>key!=="power"};
  const restricted=await answer("count(LED) * R1.Power",{authority:fieldDenied});
  assert.equal(restricted.diagnostic.code,"denied"); assert.equal(restricted.result,undefined);
  const unsafe=C.evaluateExpressionSnapshot(project,{...opts,source:"R1.Power",authority:fieldDenied});
  assert.equal(unsafe.result.diagnostic.code,"denied"); assert.deepEqual(unsafe.bindings,[]);
  assert.equal((await answer("R1.Power",{authority:denied})).diagnostic.code,"denied");
  assert.equal((await answer("2 * 3",{authority:denied})).display,"6");
  const blocked=await C.evaluate(project,{...opts,blockId:block.id,authority:{documentIds:[]}});
  assert.equal(blocked.diagnostic.code,"denied"); assert.deepEqual(blocked.records,[]);
  const partial=await answer("assert count(LED) = 0 ea",{countQuery:()=>({count:0,complete:false,status:"partial"})});
  assert.equal(partial.state,"diagnostic"); assert.equal(partial.diagnostic.code,"partial");
  const old=await answer("count(LED)",{countQuery:()=>({count:0,complete:true,revision:"previous"})});
  assert.equal(old.diagnostic.code,"stale");
  const privateAnswer=await answer("count(LED)",{authority:{documentIds:[doc.id]}});
  assert.deepEqual(privateAnswer.actions,["copy"]);
  const noReceipt=C.evaluateSnapshot(project,{...opts,authority:{documentIds:[doc.id]}});
  assert.equal(noReceipt.records[0].result.ok,false); assert.notEqual(noReceipt.records[0].assertions[0].status,"pass");
  const controller=new AbortController();
  const cancel=answer("count(LED)",{signal:controller.signal,countQuery:async()=>{controller.abort();return {count:2,complete:true};}});
  await assert.rejects(cancel,e=>e.name==="AbortError");
  assert.throws(()=>C.evaluateExpressionSnapshot(project,{...opts,source:"(",signal:controller.signal}),e=>e.name==="AbortError");
  const frozen=new AbortController();
  assert.throws(()=>C.evaluateSnapshot(project,{...opts,signal:frozen.signal,countSnapshot:()=>{
    frozen.abort(); return {count:2,complete:true};
  }}),e=>e.name==="AbortError");
  assert.equal(JSON.stringify(project),unchanged);

  // An authored project revision can invalidate counts without changing the saved equation.
  doc.items.push(part("lamp3","led","D4"));
  const edited=await C.evaluate(project,{...opts,revision:"s2",blockId:block.id});
  assert.equal(edited.records[0].result.display,"60 mA");
  assert.equal(edited.records[0].assertions[0].status,"fail");
  resistor.value="10 mV";
  const imported=C.evaluateExpressionSnapshot(project,{...opts,revision:"s3",source:"R1.Value"});
  assert.equal(imported.result.diagnostic.code,"dimension");
  assert.equal(core.parseBoundValue("10 mV",{unit:"Ω"}).display,"10 mV");
  console.log("PASS shared query, native field and Quick Maths quantities, exact snapshot counts, cancellation, authority and no design writes");
}
main().catch(e=>{console.error(e);process.exitCode=1;});
