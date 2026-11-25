"use strict";
// Public BSD-2-Clause PiDP source, hashed and attributed in tests/fixtures/altium/pidp11-io-expander.
const assert=require("node:assert/strict"), fs=require("node:fs"), path=require("node:path");
const app=name=>require(require("../support/app-source-paths.cjs").appFile(name+".js"));
for(const name of ["model","parts","net-intent","signals","sch-objects","hierarchy","connectivity","stackup",
    "component-classes","altium-rules","pcb-import","io","query","rules"])app(name);
globalThis.CFB=app("vendor/cfb.min");
const X=AtriumQueryExchange, Q=AtriumQuery, D=AtriumDesignQuery;
const name="PiDP11IOExpander.PcbDoc", bytes=fs.readFileSync(path.join(__dirname,"../fixtures/altium/pidp11-io-expander",name));
const original=AtriumIO.read(name,bytes), doc=original.documents[0], project={documents:[doc],library:original.library};
const ctx=D.context(project,doc);
const rows=doc.sourceRules.map(line=>AtriumAltiumRules.describe(line));
const sides=rows.flatMap((row,index)=>[row.first,row.second].map((source,i)=>({record:index+1,side:i+1,source,...X.fromAltium(source)})));
assert.equal(rows.length,41);assert.equal(sides.length,82);
assert.equal(sides.filter(s=>s.ok).length,79);
assert.deepEqual(sides.filter(s=>!s.ok).map(s=>s.source).sort(),["IsBGA","IsLCC","IsSOIC"]);
for(const side of sides){
  if(!side.ok){
    assert.deepEqual(side.diagnostics[0].span,[0,side.source.length]);
    assert.match(side.diagnostics[0].message,/pad arrangement/);continue;
  }
  assert.deepEqual(Object.keys(side.scope),["languageVersion","source"]);
  assert.equal(side.scope.languageVersion,1);
  const compiled=D.compile(side.scope,ctx);assert.equal(compiled.ok,true,side.source+": "+JSON.stringify(compiled.diagnostics));
  const encoded=X.toAltium(side.scope,ctx);assert.equal(encoded.ok,true,side.source+": "+JSON.stringify(encoded.diagnostics));
  assert.ok(X.fromAltium(encoded.source).ok);
}
const selected=source=>{const r=Q.run(project,doc,source);return [...r.ids,...r.subs.map(s=>s.id)].sort();};
for(const [source,count] of [["InNetClass('1A')",41],["IsVia",59],["CompPinCount < 5",20],["(HoleDiameter > 0) And (PadIsPlated = 'True')",32],["(HoleDiameter > 0) And (PadIsPlated = 'False')",4]]){
  const s=X.fromAltium(source).scope, encoded=X.toAltium(s,ctx);
  assert.equal(encoded.ok,true,JSON.stringify(encoded));
  const roundtrip=X.fromAltium(encoded.source);
  assert.equal(roundtrip.ok,true);const expected=selected(source);
  assert.equal(expected.length,count);assert.equal(new Set(expected).size,count);
  assert.deepEqual(selected(s.source),expected);assert.deepEqual(selected(roundtrip.scope.source),expected);
}
const precise="0.123456789012345", input="AsMM(Width) < "+precise;
const encoded=X.toAltium(X.fromAltium(input).scope,ctx);
assert.equal(encoded.source,input);assert.equal(X.fromAltium("Width < 9").ok,false);
assert.equal(X.fromAltium("Width < 9",{unit:"mil"}).scope.source,"object where width < 9 mil");
const like=X.fromClassic("Comment Like 'T*'").scope;
const textCtx=D.context(null,null,{fieldValue:(row,key)=>key==="comment"?row.value:undefined});
assert.equal(X.toAltium({languageVersion:1,source:"object where 1 = 1"},textCtx).source,"All");
for (const delimiter of ["|","\n","\t"]) {
  const result=X.toAltium({languageVersion:1,source:"part where comment = \"A"+delimiter+"B\""},textCtx);
  assert.equal(result.ok,false);
  assert.match(result.diagnostics[0].message,/delimiter or control character/);
}
assert.equal(D.compile(like,textCtx).plan.test({kind:"part",value:"test"}),true);
assert.equal(D.compile('part where comment = "Test"',textCtx).plan.test({kind:"part",value:"test"}),false);
assert.equal(D.compile('part where comment like case "T*"',textCtx).plan.test({kind:"part",value:"test"}),false);
assert.equal(X.toAltium({languageVersion:1,source:'part where comment like case "T*"'},textCtx).ok,false);
for(const literal of ["Test","Test's","ß🧵"]){
  const scope={languageVersion:1,source:"part where comment = "+JSON.stringify(literal)};
  const encoded=X.toAltium(scope,textCtx);assert.equal(encoded.ok,true);assert.match(encoded.source,/Pos\(/);
  const imported=X.fromAltium(encoded.source);assert.ok(imported.ok);
  const plan=D.compile(imported.scope,textCtx).plan;
  assert.equal(plan.test({kind:"part",value:literal}),true);assert.equal(plan.test({kind:"part",value:literal.toUpperCase()}),false);
  assert.equal(plan.test({kind:"part",value:"x"+literal}),false);
}
const mapped=X.fromClassic("Name = '🧵' And Width < 1.23mm"),nativeAt=mapped.scope.source.indexOf("1.23");
const exactWidth=D.compile("track where width = 0.2 mm",ctx).plan;
assert.equal(exactWidth.test({kind:"track",width:0.2}),true);
assert.equal(exactWidth.test({kind:"track",width:0.2000001}),false);
assert.deepEqual(X.originalSpan(mapped.map,[nativeAt,nativeAt+4]),[24,30]);
console.log("PASS physical PiDP 41 rules / 82 sides, 79 translated, three located classifiers; shared Filter and Altium round-trip 41 class members, 59 vias, 32 plated holes; exact length and text checks");

// The production static translator is loaded on a real worker using the same harness as File Open.
// Provenance must survive a board-only export while its two query sides stay individually attributable.
async function verifyTransport() {
  const {Worker}=require("node:worker_threads"),{once}=require("node:events");
  const worker=new Worker(path.join(__dirname,"../workers/import-worker.cjs"),{workerData:{}});
  try {
    assert.equal((await once(worker,"message"))[0].type,"ready");
    let id=0;
    async function request(packet) {
      const next=++id;worker.postMessage({id:next,...packet});
      for(;;){
        const [response]=await once(worker,"message");
        if(response.id!==next || response.type==="progress")continue;
        assert.equal(response.type,"result",response.message);
        return response.value;
      }
    }
    const read=buffer=>request({operation:"translate-import",files:[{name,buffer}],options:{source_rules:"use"}});
    const first=await read(bytes),book=first.provenance.sourceRules[0],ledger=first.report.kinds.find(r=>r.kind==="Design rule");
    assert.deepEqual([book.count,book.converted,ledger.kept,ledger.approximated,ledger.dropped],[41,28,22,6,13]);
    assert.equal(new Set(book.report.map(r=>r.record)).size,41);
    assert.deepEqual(book.report.find(r=>r.kind==="Clearance").checks,{kindId:0,batch:true,online:true});
    assert.deepEqual(book.report.find(r=>r.kind==="RoutingVias").checks,{kindId:11,batch:false,online:true});
    assert.equal(book.report.find(r=>r.kind==="PolygonConnect").enabled,true);
    assert.deepEqual(book.report.find(r=>r.kind==="PolygonConnect").checks,{kindId:20,batch:false,online:false});

    assert.equal(book.report.flatMap(r=>r.scopeDiagnostics || []).length,3);
    for(const row of book.report.filter(r=>r.scopeDiagnostics?.length)){
      const d=row.scopeDiagnostics[0];assert.equal(d.side,1);
      const ref=ledger.references.find(r=>r.reason?.includes(row.scope));
      assert.ok(ref?.source.object,JSON.stringify(row));assert.equal(ref.status,"dropped");
    }
    const real=first.model.documents.find(d=>d.kind==="pcb"),rules=first.model.rules?.list || real.rules?.list;
    assert.ok(rules?.some(r=>r.name==="Width_1A"));
    for(const rule of rules)for(const side of [rule.scope,rule.scope2].filter(Boolean)){
      assert.deepEqual(Object.keys(side).sort(),side.bindings?["bindings","languageVersion","source"]:["languageVersion","source"]);
    }
    const output=await request({operation:"translate-export",translator:"altium",model:first.model,
      options:{scope:"document",documentId:real.id,provenance:first.provenance}});
    const boardFile=output.files.find(f=>/\.pcbdoc$/i.test(f.name));
    const exported=boardFile.text || Buffer.from(boardFile.bytes).toString("latin1");
    const reopened=await read(new TextEncoder().encode(exported));
    const second=reopened.provenance.sourceRules[0];
    assert.equal(second.count,41);assert.equal(new Set(second.report.map(r=>r.record)).size,41);
    for(const [i,source] of book.report.entries()){
      assert.equal(second.report[i].name,source.name);assert.equal(second.report[i].scope,source.scope);
      assert.equal(second.report[i].scope2,source.scope2);assert.equal(second.report[i].status,source.status);
    }
    const edit=rules.find(r=>r.name==="Width_1A");
    edit.scope={languageVersion:1,source:'object where comment like case "A*"'};
    const saved=await request({operation:"translate-export",translator:"altium",model:first.model,
      options:{scope:"document",documentId:real.id,provenance:first.provenance}});
    const report=saved.report.kinds.find(r=>r.kind==="Design rule");
    assert.ok(report.references.some(r=>r.status==="approximated" && r.reason?.includes("case-sensitive wildcard") && r.source.object));
    const retained=saved.files.find(f=>/\.pcbdoc$/i.test(f.name)), again=await read(retained.bytes || new TextEncoder().encode(retained.text));
    assert.equal(again.provenance.sourceRules[0].report.find(r=>r.name==="Width_1A").scope,"InNetClass('1A')");
    console.log("PASS public Rules6 File Open → native rule adoption → Altium PcbDoc export → File Open: 41 distinct source rules; 22 supported, 6 partial, 13 source-only; unchanged role strings and one located retained edit");
  } finally {await worker.terminate();}
}
if (process.versions?.node) verifyTransport().catch(error=>{console.error(error);process.exitCode=1;});
