"use strict";
// Explicit second-look experiment. Both policies call the same suggest/validate APIs with the same limits.
const {definitions,now} = require("./runtime.cjs");
require("../../app/pcb/route-suggest-engine.js");
const {inspect,delta,summary,evaluate} = require("./quality.cjs");
const {route} = require("./profiles.cjs");
const A=AtriumAutorouter, E=AtriumRouteSuggestEngine;
const budget = Object.freeze({calls:12, maxCells:24000, budgetMs:32});

function accessPoint(at, id, toward, net, shapes) {
  const parent=shapes.find(s=>s.pad && s.id===id && s.net===net &&
    Math.hypot(s.at[0]-at[0],s.at[1]-at[1])<1e-4);
  if (!parent) return at;
  const pad=parent.item, angle=Atrium.rad((parent.parent?.angle||0)+(pad.angle||0)), co=Math.cos(angle), si=Math.sin(angle);
  const candidates=[[.4*pad.w,0],[-.4*pad.w,0],[0,.4*pad.h],[0,-.4*pad.h]];
  let chosen=at, best=-Infinity;
  for(const [x,y] of candidates) {
    const pt=[at[0]+x*co-y*si,at[1]+x*si+y*co];
    let clearance=1;
    for(const o of shapes) {
      if(o.net===net)continue;
      if(Array.isArray(parent.layers) && Array.isArray(o.layers) && !o.layers.some(l=>parent.layers.includes(l)))continue;
      clearance=Math.min(clearance,A.core.geometry.ptCore(pt[0],pt[1],o.shape)-o.shape.r);
    }
    const score=clearance-.25*(Math.hypot(pt[0]-toward[0],pt[1]-toward[1])-Math.hypot(at[0]-toward[0],at[1]-toward[1]));
    if(score>best){best=score;chosen=pt;}
  }
  return chosen;
}
function run(p, mode) {
  if(!["centre","edge"].includes(mode))throw Error("Unknown escape policy");
  const d=p.documents[0],defs=definitions(p),baseline=inspect(p),start=route(p,"single");
  const accepted=evaluate(p,start.plan.add,baseline);
  let board={...d,items:[...d.items,...accepted.add]},checks=inspect({...p,documents:[board]});
  const initial=checks.opens, seen=new Map();
  let calls=0,cells=0,landed=0,rejected=0;
  const begun=now();
  while(calls<budget.calls && checks.opens) {
    const air=AtriumConnectivity.inspectFull(board,defs).airwires.map(w=>({...w,
      key:JSON.stringify([w.net,...[[w.fromId,w.from],[w.toId,w.to]].sort()]),
      span:Math.hypot(w.from[0]-w.to[0],w.from[1]-w.to[1])}));
    air.sort((a,b)=>(seen.get(a.key)||0)-(seen.get(b.key)||0)||a.span-b.span||(a.key<b.key?-1:a.key>b.key?1:0));
    const w=air[0], attempt=seen.get(w.key)||0;
    if(attempt>=2)break;
    seen.set(w.key,attempt+1);
    let from=w.from,to=w.to;
    if(mode==="edge") {
      const shapes=[];
      A.eachCopper(board,defs,o=>{if(o.pad)o.at=o.parent?Atrium.world([o.item.x,o.item.y],o.parent):[o.item.x,o.item.y];shapes.push(o);});
      from=accessPoint(w.from,w.fromId,w.to,w.net,shapes);
      to=accessPoint(w.to,w.toId,w.from,w.net,shapes);
    }
    if(attempt)[from,to]=[to,from];
    const project={...p,documents:[board]}, q={net:w.net,from,to,maxCells:budget.maxCells,budgetMs:budget.budgetMs,alternatives:false,shove:false};
    calls++;
    const suggestion=E.suggest(board,defs,q,{project});
    cells+=suggestion.stats?.cells||0;
    if(!suggestion.ok)continue;
    const alt=suggestion.alternatives[0], next=E.toPlan(alt,{net:w.net});
    if(next.remove?.length || next.modify?.length || !E.validate(board,defs,alt,{project,net:w.net}).ok) {rejected++;continue;}
    const trial={...board,items:[...board.items,...next.add]}, check=inspect({...p,documents:[trial]});
    if(check.opens>=checks.opens || delta(check,baseline).length){rejected++;continue;}
    board=trial;checks=check;landed++;
  }
  return {initial,accepted:summary(checks,delta(checks,baseline)),calls,cells,landed,rejected,searchAndCheckMs:Math.round(now()-begun)};
}
module.exports={run,accessPoint,budget};
