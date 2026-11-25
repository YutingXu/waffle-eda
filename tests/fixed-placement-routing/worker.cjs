"use strict";
// Standard input is the stripped materialisation only; no source path, human copper or reference statistics.
const fs = require("node:fs"), assert = require("node:assert/strict");
const {inventory, placements} = require("./strip.cjs");
const {inspect, evaluate, summary} = require("./quality.cjs");
const {profiles, placementFeatures, route} = require("./profiles.cjs");
const {hash} = require("./sources.cjs");
function run(p, methods, rescue = false) {
  const counts = inventory(p), fixed = JSON.stringify(placements(p));
  for (const k of ["tracks", "arcs", "vias", "fills", "polygons", "pouredRegions", "embeddedVias"]) assert.equal(counts[k],0,"residual " + k);
  const baseline = inspect(p), runs = {}, projectHash = hash(JSON.stringify(p));
  for (const id of methods) {
    const input = structuredClone(p);
    const {plan, routeMs, expansions} = route(input, id);
    const {raw,accepted,withheldNets,add} = evaluate(input,plan.add,baseline);
    assert.equal(JSON.stringify(placements(input)),fixed);
    assert.equal(hash(JSON.stringify(input)),projectHash,"route preview mutated stripped input");
    const geometry = add.map(({id,...c}) => c);
    runs[id] = {raw,accepted,withheldNets,routeMs,expansions,geometrySha256:hash(JSON.stringify(geometry))};
  }
  const fallback = rescue ? Object.fromEntries(["centre","edge"].map(mode => [mode,require("./rescue.cjs").run(structuredClone(p),mode)])) : undefined;
  return {features:placementFeatures(p),stripped:counts,initial:summary(baseline,[]),runs,fallback};
}
if (require.main === module) {
  const methods = process.argv.slice(2).filter(v=>v!=="--rescue");
  const p = JSON.parse(fs.readFileSync(0,"utf8"));
  process.stdout.write(JSON.stringify(run(p, methods.length ? methods : ["v1","v2",...profiles.map(c=>c.id)],process.argv.includes("--rescue"))));
}
module.exports = {run};
