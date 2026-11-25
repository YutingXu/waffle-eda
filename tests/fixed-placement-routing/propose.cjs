"use strict";
// Produce a new routed Waffle copy of one pinned board with a single frozen model choice.
const assert = require("node:assert/strict"), fs = require("node:fs");
const {entries,confirmation,read} = require("./sources.cjs");
const {imported} = require("./runtime.cjs");
const {strip,placements} = require("./strip.cjs");
const {inspect,evaluate} = require("./quality.cjs");
const {route,placementFeatures} = require("./profiles.cjs");
const {choose} = require("./learn.cjs");
const models = require("./models.json");

function propose(placement, frozen) {
  const p=structuredClone(placement), fixed=placements(p), initial=inspect(p);
  const choice=choose(frozen.model,placementFeatures(p));
  const selected=route(p,choice);
  const checked=evaluate(p,selected.plan.add,initial);
  p.documents[0].items.push(...checked.add);
  assert.deepEqual(placements(p),fixed);
  Atrium.validate(p);
  return {p,choice,initial:initial.opens,accepted:checked.accepted,withheldNets:checked.withheldNets,routeMs:selected.routeMs};
}
if(require.main===module) {
  const [id,output] = process.argv.slice(2), fixture=[...entries,...confirmation].find(b=>b.id===id);
  if(!fixture||!output?.endsWith(".waffle"))throw Error("Usage: node propose.cjs PUBLIC_BOARD_ID NEW_FILE.waffle");
  const frozen=models.byFamily[fixture.family]||models.unseen;
  assert(!frozen.model.families.includes(fixture.family));
  const placed=strip(imported(read(fixture),fixture.id)), {p,...report}=propose(placed,frozen);
  fs.writeFileSync(output,JSON.stringify(p,null,2)+"\n",{flag:"wx"});
  console.log(JSON.stringify({id,excludedFamily:fixture.family,...report},null,2));
}
module.exports={propose};
