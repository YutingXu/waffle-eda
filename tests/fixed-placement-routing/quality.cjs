"use strict";
const {definitions} = require("./runtime.cjs");
const {obstacle} = require("./strip.cjs");
const R = AtriumRules, shape = AtriumBoardShape, C = AtriumConnectivity;
const byType = violations => {
  const counts = {};
  for (const v of violations) counts[v.type] = (counts[v.type] || 0) + 1;
  return counts;
};
function copperOnBoard(i, doc, rings) {
  const path = i.points || [[i.x, i.y]], radius = (i.width ?? i.diameter) / 2;
  for (const pt of path) {
    if (!shape.polyContains(doc.outline, pt) || rings.slice(1).some(r => shape.polyContains(r, pt))) return false;
  }
  // Endpoints inside the outline still allow a segment to cross a concave edge or a hole.
  for (let j = 0; j < Math.max(1, path.length - 1); j++) {
    const a = path[j], b = path[j + 1] || a;
    for (const ring of rings) for (let k = 0; k < ring.length; k++) {
      if (R.kit.closestSegments(a, b, ring[k], ring[(k + 1) % ring.length]).d < radius - 1e-6) return false;
    }
  }
  return true;
}
// The product DRC excludes unassigned lands from electrical net pairs and checks board-level keepouts.
// Check placed footprint restrictions and floating pads separately for track/via geometry.
function fixedObstacleViolations(doc, defs, project, rules) {
  const K=R.kit, restrictions=[], emitted=new Set(doc.items.filter(i=>i.kind==="track"||i.kind==="via").map(i=>i.id));
  for (const part of doc.items) if(part.kind==="part") {
    const fp=defs.get(part.def)?.footprint;
    for(const [j,s] of (fp?.shapes||[]).entries()) {
      if(!obstacle(s)||s.cutout)continue;
      let points=s.points;
      if(s.kind==="circle") {
        const n=Math.max(24,Math.ceil(Math.PI/Math.acos(Math.max(-1,1-.001/s.r))));
        points=Array.from({length:n},(_,k)=>[s.x+s.r*Math.cos(k*2*Math.PI/n),s.y+s.r*Math.sin(k*2*Math.PI/n)]);
      }
      if(points?.length)restrictions.push({...s,id:part.id+"/restriction/"+j,kind:"graphic",keepout:true,
        closed:s.kind==="circle"||s.closed,points:points.map(q=>Atrium.world(q,part))});
    }
  }
  const out=[];
  if(restrictions.length && emitted.size) {
    const ids=new Set(restrictions.map(i=>i.id));
    for(const v of AtriumPCBDraw.keepoutViolations({...doc,items:doc.items.concat(restrictions)},defs,{limit:Infinity})) {
      if(ids.has(v.otherId)&&emitted.has(v.id))out.push({...v,type:"footprintKeepout"});
    }
  }
  const geo=K.extract(doc,defs), empty=geo.pads.filter(f=>!f.net&&!f.maskOnly), set=K.compile(R.migrate(rules),{doc,project});
  if(!empty.length||!set.byType.clearance.length)return out;
  const emptySet=new Set(empty), candidates=geo.copper.filter(f=>emitted.has(f.id)), witnesses=new Map();
  K.pairs([...candidates,...empty],Math.max(...set.byType.clearance.map(K.clearanceMax)),(a,b)=>{
    if(emptySet.has(a)===emptySet.has(b)||a.span[1]<b.span[0]||b.span[1]<a.span[0])return;
    const pad=emptySet.has(a)?a:b, route=pad===a?b:a, r=set.pair("clearance",route,pad);
    if(!r)return;
    const need=K.clearanceGap(r,route.ck,pad.ck),gap=K.pieceGap(route,pad,need);
    if(gap.d+1e-6>=need)return;
    const key=JSON.stringify([route.id,pad.id,pad.pin]), prev=witnesses.get(key);
    if(!prev||gap.d<prev.actual)witnesses.set(key,{type:"unassignedPadClearance",id:route.id,otherId:pad.id,ruleId:r.id,
      what:pad.pin,actual:gap.d,required:need,at:gap.at});
  });
  return out.concat([...witnesses.values()]);
}
function inspect(p) {
  const doc = p.documents.find(d => d.kind === "pcb"), defs = definitions(p);
  // Both full checks inspect committed physical geometry, independently of the path planner's report.
  const connectivity = C.inspectFull(doc, defs);
  const rules=R.stored(doc,p)||R.defaults();
  const checked = R.drc(doc, defs, rules, {project: p, connections:connectivity, limit: Infinity});
  const violations = checked.violations.filter(v => v.type !== "unrouted").concat(fixedObstacleViolations(doc,defs,p,rules));
  const rings = [doc.outline, ...shape.holes(doc)];
  if (!Atrium.validOutline(doc.outline)) throw Error("Reference lacks a valid physical outline");
  let vias = 0, length = 0;
  for (const i of doc.items) {
    if (!["track", "via"].includes(i.kind) || obstacle(i)) continue;
    if (!copperOnBoard(i, doc, rings)) violations.push({type: "physicalBoundary", id: i.id});
    if (i.kind === "via") vias++; else length += Atrium.pathLength(i);
  }
  for (const s of connectivity.shorts) violations.push({type: "physicalShort", nets: s.nets, id: s.fromId, otherId: s.toId});
  // Account for an existing physical issue by identity and severity, never by subtracting group totals.
  const key = v => JSON.stringify([v.type, v.ruleId, v.id, v.otherId, v.what, v.title, v.nets, v.actual, v.required, v.at]);
  return {violations, keys: violations.map(key), opens: connectivity.airwires.length,
    openNets: connectivity.nets.filter(n => n.missing).length, shorts: connectivity.shorts.length,
    vias, lengthMm: +length.toFixed(3)};
}
function delta(after, before) {
  const counts = new Map();
  for (const k of before.keys) counts.set(k, (counts.get(k) || 0) + 1);
  return after.violations.filter((v, n) => {
    const k = after.keys[n], left = counts.get(k) || 0;
    if (left) counts.set(k, left - 1);
    return !left;
  });
}
function summary(check, added = check.violations) {
  return {legal: !added.length && check.shorts === 0, newIssues: byType(added), issues: byType(check.violations), opens: check.opens,
    openNets: check.openNets, shorts: check.shorts, vias: check.vias, lengthMm: check.lengthMm};
}
function evaluate(p, add, baseline) {
  const materialise = items => ({...p, documents: [{...p.documents[0], items: [...p.documents[0].items, ...items]}]});
  const rawCheck = inspect(materialise(add)), newIssues = delta(rawCheck, baseline), raw = summary(rawCheck, newIssues);
  if (raw.legal) return {raw, accepted: raw, withheldNets: 0, add};
  // The same offline rejection policy applies to every engine. Withhold whole new nets involved
  // in issues. An unattributable or residual violation rejects the entire proposal.
  const byId = new Map(add.map(i => [i.id, i.net])), bad = new Set();
  let unknown = false;
  for (const v of newIssues) {
    const nets = [byId.get(v.id), byId.get(v.otherId), ...(v.nets || [])].filter(Boolean);
    if (!nets.length) unknown = true;
    for (const n of nets) bad.add(n);
  }
  let kept = unknown ? [] : add.filter(i => !bad.has(i.net));
  const filtered = kept.length ? inspect(materialise(kept)) : baseline;
  if (delta(filtered, baseline).length) kept = [];
  const keptNets = new Set(kept.map(i => i.net));
  return {raw, accepted: summary(kept.length ? filtered : baseline, []),
    withheldNets: new Set(add.map(i => i.net).filter(n => !keptNets.has(n))).size, add: kept};
}
module.exports = {inspect, delta, summary, evaluate, byType};
