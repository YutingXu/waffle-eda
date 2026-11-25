"use strict";
// Run the focused corpus acceptance gate after preparing the verified source caches.
const assert = require("node:assert/strict");
const {entries,confirmation} = require("./sources.cjs");
const {measure,folds} = require("./bench.cjs");
const expected = require("./results.json");
require("./check.cjs");
const before = process.argv.includes("--original-engine");
for (const entry of [...entries,...confirmation]) {
  const want=expected.boards[entry.id], b=measure(entry,[],!before);
  assert.equal(b.stripSha256,want.stripSha256,entry.id+" materialisation");
  assert.deepEqual(b.stripped,want.stripped);
  assert.deepEqual(b.source,want.source);
  assert.equal(b.initial.opens,want.inputOpens);
  assert.deepEqual(b.reference.filledMm2ByLayer,want.poursMm2ByLayer);
  assert.deepEqual(b.reference.newIssues,want.referenceNewIssues);
  assert.deepEqual([b.reference.opens,b.reference.vias,b.reference.lengthMm],want.reference);
  const fold=folds([b])[0];
  assert.equal(fold.choice,want.choice);
  assert.deepEqual(fold.trainingBoards,want.trainingBoards);
  for (const [method,v] of Object.entries(b.runs)) {
    const metrics=[v.accepted.opens,v.accepted.vias,v.accepted.lengthMm];
    assert(v.accepted.legal&&!v.accepted.shorts,entry.id+"/"+method);
    assert.deepEqual(v.accepted.newIssues,{});
    if(before) {
      const old=want.originalRoutes[method];
      assert.deepEqual(metrics,old.accepted);
      assert.equal(v.raw.opens,old.rawOpens);
      assert.deepEqual(v.raw.newIssues,old.rawNewIssues);
    } else {
      assert.deepEqual(metrics,want.routes[method].slice(1,4));
      assert.equal(v.expansions,want.routes[method][5]);
      assert.equal(v.withheldNets,want.routes[method][6]);
      assert.equal(v.geometrySha256,want.geometrySha256[method],entry.id+"/"+method+" geometry");
      assert.deepEqual(v.raw.newIssues,want.rawIssues[method]?.issues||{});
    }
  }
  if(!before) for (const [mode,f] of Object.entries(b.fallback)) {
    const expected=want.fallback[mode];
    assert(f.accepted.legal&&!f.accepted.shorts);
    assert.deepEqual([f.accepted.opens,f.accepted.vias,f.accepted.lengthMm,f.calls,f.cells],
      [expected.opens,expected.vias,expected.trackMm,expected.calls,expected.cells]);
  }
  console.log("Verified",entry.id,fold.choice);
}
