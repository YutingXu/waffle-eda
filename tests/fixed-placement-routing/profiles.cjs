"use strict";
const {definitions, resetClock, now} = require("./runtime.cjs");
const A = AtriumAutorouter, V2 = AtriumAutorouterV2;
const profiles = [
  {id: "single", router: {}},
  {id: "margin", margin: .06, order: "crowded", router: {viaCost: 14, againstCost: .35, shortLength: 4}},
  {id: "escape", order: "crowded", router: {gridDiv: 3, viaCost: 7, againstCost: .25, shortLength: 3, setback: .4}},
  {id: "direct", order: "short", router: {viaCost: 22, againstCost: .25, diagCost: 0, bend45: .25, shortLength: 9}},
  {id: "congestion", order: "long", router: {global: true, viaCost: 8, againstCost: .4, presFactor: .9, histStep: .6}}
];
const heuristic = "margin";

// Only pad/terminal positions, pad-layer access and pad net assignments enter the scorer.
function placementFeatures(p) {
  const d = p.documents[0], defs = definitions(p), pads = [];
  A.eachCopper(d, defs, o => {
    if (!o.pad || !o.net) return;
    const at = o.parent ? Atrium.world([o.item.x, o.item.y], o.parent) : [o.item.x, o.item.y];
    pads.push({x: at[0], y: at[1], net: o.net, through: o.layers === "all"});
  });
  const [x0,y0,x1,y1] = Atrium.bounds(d.outline);
  const nets = new Set(pads.map(x => x.net));
  return [Math.log1p(pads.length / Math.max(1, (x1-x0)*(y1-y0)) * 10),
    Math.log1p(pads.length / Math.max(1, nets.size)), pads.filter(p => p.through).length / Math.max(1, pads.length)];
}
function configure(job, profile) {
  const difficulty = new Map();
  for (const c of job.conns) {
    const a = job.terms[c.a], b = job.terms[c.b], ds = Math.hypot(a.x-b.x, a.y-b.y);
    let value = profile.order === "short" ? -ds : ds;
    if (profile.order === "crowded") {
      // Foreign terminals close to an escape are difficult to reach after neighbouring nets land.
      value = 0;
      for (const t of job.terms) {
        if (job.obstacles[t.obs].net === c.net) continue;
        value += Math.max(0, 3 - Math.min(Math.hypot(t.x-a.x, t.y-a.y), Math.hypot(t.x-b.x, t.y-b.y)));
      }
    }
    difficulty.set(c.net, Math.max(difficulty.get(c.net) ?? -Infinity, value));
  }
  if (profile.order) {
    const ordered = [...difficulty].sort((a,b) => a[1]-b[1] || a[0]-b[0]);
    // Stay inside the original priority tier (net classes, differential pairs and length groups).
    ordered.forEach(([n], i) => { job.nets[n].priority += (i+1)/(ordered.length+1)*.01; });
  }
  if (profile.margin) {
    for (const n of job.nets) n.c += profile.margin;
    for (const o of job.obstacles) o.clr += profile.margin;
    job.edgeClearance += profile.margin;
  }
}
function route(p, id) {
  const d = p.documents[0], defs = definitions(p), options = {project: p};
  resetClock();
  const started = now();
  let plan;
  if (id === "v1") {
    const multi = A.boardLayers(d, defs).length > 2;
    plan = A.routeBoard(d, defs, {...options, fanout: multi, fanoutOptions: {auto: "bga"}, router: A.STRATEGIES[multi ? 1 : 0].router});
  } else if (id === "v2") {
    plan = V2.routeBoard(d, defs, options);
  } else {
    const profile = profiles.find(c => c.id === id);
    if (!profile) throw Error("Unknown routing profile " + id);
    const o = {...options, router: profile.router, alternates: false};
    const setup = V2.setup(d, defs, o);
    if (profile.order || profile.margin) configure(setup.prep.job, profile);
    plan = V2.finish(setup, A.core.runSync(setup.prep.job), d, defs, o);
  }
  if (plan.remove?.length || plan.modify?.length || plan.add.some(i => !["track", "via", "graphic"].includes(i.kind))) throw Error("Unexpected edit to fixed geometry");
  return {plan, routeMs: Math.round(now()-started), expansions: plan.report.expansions || 0};
}
module.exports = {profiles, heuristic, configure, placementFeatures, route};
