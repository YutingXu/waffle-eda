"use strict";
// @ts-ignore CommonJS entry point; native and browser hosts declare this dependency in their loaders.
if (!globalThis.AtriumComponentMatch && typeof require === "function") require("../library/component-match.js");
globalThis.AtriumECO = (() => {
  const A=Atrium;
  // The project file format (layout 2; docs/format-2.md). JSON with keys sorted at
  // every level. The project, its arrays and objects down to depth 3 (documents, each document's
  // fields) have one entry per line, two-space indent; every deeper value (a board item, a pad, a
  // point) is one minified line, unless that line would exceed LINE characters, when it is laid
  // out the same way one level down. Non-integer numbers below 1e9 keep 12 significant digits
  // (83.82000000000001 -> 83.82). Diffs stay one line per changed object. app/save-cache.js
  // writes the same bytes incrementally and mcp/headless.js the same bytes headless.
  const LINE=1024,DEPTH=4,skip=x=>x===undefined||typeof x==="function"||typeof x==="symbol";
  const num=A.projectNumber;
  function sorted(v){
    if(typeof v==="number")return num(v);
    if(Array.isArray(v))return v.map(sorted);
    if(v===null||typeof v!=="object")return v;
    const o=Object.create(null);
    for(const k of Object.keys(v).sort())o[k]=sorted(v[k]);
    return o;
  }
  // v is sorted(); d its depth (the project is 0).
  function layout(v,d){
    if(v===null||typeof v!=="object")return JSON.stringify(v);
    if(d>=DEPTH){const m=JSON.stringify(v);if(m.length<=LINE)return m;}
    const inner=" ".repeat(2*d+2),outer=" ".repeat(2*d);
    if(Array.isArray(v))return v.length?"[\n"+inner+v.map(x=>skip(x)?"null":layout(x,d+1)).join(",\n"+inner)+"\n"+outer+"]":"[]";
    const keys=Object.keys(v).filter(k=>!skip(v[k]));
    return keys.length?"{\n"+inner+keys.map(k=>JSON.stringify(k)+": "+layout(v[k],d+1)).join(",\n"+inner)+"\n"+outer+"}":"{}";
  }
  const serialize=p=>layout(sorted(p),0)+"\n";
  const componentItems=d=>d.items.filter(i=>i.kind==="part");
  const idFor=r=>JSON.stringify([r.sheet,r.sourceId,r.link,r.targetId,r.field,r.pin??null]);
  function preview(project,scope,boardId,opts={}){
    const cx=context(project,scope,boardId,opts),{board,defs,issues}=cx,rows=[];
    const boardRefs=new Map();
    for(const p of cx.parts)groupInto(boardRefs,up(p.ref),p);
    for(const c of cx.comps.values()){
      if(!c.inScope)continue;
      const m=cx.matched.get(c.key),sources=c.gates,ctx=sources[0],sp=ctx.p;
      if(!m){issues.add(ctx.sheet.name+" / "+sp.ref+" has no linked footprint on "+board.name+".");continue;}
      const bp=m.bp,link=bp.link||sp.link||"",sd=defs.get(sp.def),bd=defs.get(bp.def);
      const base={sheet:ctx.sheet.id,sheetName:ctx.sheet.name,component:bp.ref,sourceId:sp.id,link,targetId:bp.id};
      function add(field,before,after,pin){
        if(before===after)return;
        const row={...base,field,before,after};
        if(pin!==undefined)row.pin=pin;
        rows.push(row);
      }
      if(sp.ref && sp.ref!==bp.ref){
        add("ref",bp.ref,sp.ref);
        if((boardRefs.get(sp.ref.toUpperCase())||[]).some(i=>i.id!==bp.id))issues.add(sp.ref+" is already in use on the board. Review related renames together.");
      }
      add("value",bp.value,sp.value);
      const pins=new Map(),pads=new Map();
      for(const p of sd?.symbol?.pins||[])if(p.number!=="")groupInto(pins,p.number,p);
      for(const p of bd?.footprint?.pads||[])if(p.number!=="")groupInto(pads,p.number,p);
      for(const number of pins.keys())if(!pads.has(number))issues.add(sp.ref+" pin "+number+" has no matching footprint pad.");
      for(const [number,padGroup] of pads){
        if(!pins.has(number)){issues.add(bp.ref+" pad "+number+" has no matching schematic pin.");continue;}
        if(pins.get(number).length!==1){issues.add(sp.ref+" pin "+number+" is ambiguous.");continue;}
        const assigned=bp.pinNets&&Object.prototype.hasOwnProperty.call(bp.pinNets,number);
        const oldNets=assigned?[bp.pinNets[number]]:[...new Set(padGroup.map(p=>p.net||""))];
        if(oldNets.length!==1){issues.add(bp.ref+" pad "+number+" has inconsistent footprint net assignments.");continue;}
        const net=c.net(number).net;
        if(ctx.bad.has(net)){issues.add(sp.ref+" pin "+number+" has conflicting schematic net names.");continue;}
        if(pins.get(number)[0].hidden && !net){issues.add(sp.ref+" pin "+number+" is hidden and its net is unresolved.");continue;}
        add("net",oldNets[0],net,number);
      }
    }
    for(const p of cx.extras)issues.add(board.name+" / "+p.ref+" has no linked component in the selected schematics.");
    const natural=new Intl.Collator("en",{numeric:true});
    const fields={ref:0,value:1,net:2};
    rows.sort((a,b)=>{
      const humanOrder=natural.compare(a.component,b.component)||fields[a.field]-fields[b.field]||natural.compare(a.pin||"",b.pin||"");
      if(humanOrder)return humanOrder;
      const left=idFor(a),right=idFor(b);return left<right?-1:left>right?1:0;
    });
    return {eco:{format:"atrium-eco",version:1,scope,board:boardId,boardName:board.name,rows,...(opts.matchDecisions?{matchDecisions:opts.matchDecisions}:{})},review:cx.review,matches:cx.matches,issues:[...issues].sort()};
  }
  function validateOrder(patch){
    if(!patch || patch.format!=="atrium-eco"||patch.version!==1||typeof patch.scope!=="string"||typeof patch.board!=="string"||!Array.isArray(patch.rows))throw Error("Unsupported Waffle ECO file.");
    const keys=new Set();
    for(const r of patch.rows){
      if(!r||!["ref","value","net"].includes(r.field)||["sheet","sourceId","link","targetId","before","after"].some(k=>typeof r[k]!=="string")||
        (r.field==="net"?(typeof r.pin!=="string"||!r.pin):r.pin!==undefined))throw Error("Invalid ECO change.");
      const k=idFor(r);if(keys.has(k))throw Error("ECO contains duplicate changes.");keys.add(k);
    }
  }
  function resolve(project,patch){
    validateOrder(patch);
    const current=preview(project,patch.scope,patch.board,{matchDecisions:patch.matchDecisions}), live=new Map(current.eco.rows.map(r=>[idFor(r),r]));
    const valid=[],stale=[];
    for(const r of patch.rows){const v=live.get(idFor(r));if(v && v.before===r.before && v.after===r.after)valid.push(v);else stale.push(r);}
    return {current,valid,stale};
  }
  function prepare(project,patch){
    const result=resolve(project,patch);
    if(result.current.review.pending)throw Error("Review component matches before executing this ECO.");
    if(result.stale.length)throw Error("This ECO is stale. Recompare the schematic and board before applying it.");
    const board=project.documents.find(d=>d.id===patch.board),parts=componentItems(board);
    const byId=new Map(parts.map(p=>[p.id,p])),renames=new Map();
    for(const r of result.valid)if(r.field==="ref")renames.set(r.targetId,r.after);
    const used=new Map();
    for(const p of parts){
      const ref=(renames.get(p.id)??p.ref).toUpperCase(),other=used.get(ref);
      if(other && (renames.has(p.id)||renames.has(other.id)))throw Error("The selected changes would duplicate board designator "+ref+".");
      used.set(ref,p);
    }
    return ()=>{
      for(const r of result.valid){
        const p=byId.get(r.targetId);
        if(r.field==="net")p.pinNets={...p.pinNets,[r.pin]:r.after};
        else p[r.field]=r.after;
      }
      return result.valid.length;
    };
  }
  const apply=(project,patch)=>prepare(project,patch)();

  // =====================================================================================
  // ECO v2: "Update PCB Document" and "Update Schematic from PCB" (Altium-style change list).
  //
  // plan(project,{board,scope,direction,removeExtras,rooms}) ->
  //   {format:"atrium-eco",version:2,direction:"pcb"|"sch",scope,board,boardName,options,changes,issues}
  // A change: {id,group,action,object,document,before,after,selected,requires?,via?,...}. Actions:
  //   link, addComponent, removeComponent, ref, value, footprint, param   (components)
  //   addNet, renameNet, removeNet, padNet                                (nets)
  //   netClass, diffPair, room                                            (directives and rooms)
  // Components are keyed by designator: the gates of a multi-gate part (same definition and
  // designator; gate in item.unit, item.part accepted) are one component with one footprint,
  // and each pin's net comes from the gate that owns it. component-match.js pairs identities
  // before scoring the remaining components together. New footprints go in a packed grid beside the board edge, one
  // cluster per sheet. Removal is opt-in and never touches locked footprints.
  // validate() runs the selected changes on a copy; execute() runs them on the project (call it
  // inside one editor edit for one undo step) and returns a per-change status report.
  const cmp=(a,b)=>natural2.compare(String(a??""),String(b??""));
  const natural2=new Intl.Collator("en",{numeric:true});
  const up=s=>String(s??"").trim().toUpperCase();
  const annotated=r=>!!String(r||"").trim()&&!/[?*]/.test(r);
  const own=(o,k)=>!!o&&typeof o==="object"&&Object.prototype.hasOwnProperty.call(o,k);
  const unitOf=p=>(Number.isInteger(p.unit)&&p.unit>0?p.unit:0)||(Number.isInteger(p.part)&&p.part>0?p.part:0)||1;
  const gateName=u=>u<=26?String.fromCharCode(64+u):"#"+u;
  const fail=m=>{throw Error(m);};
  const wanted=d=>String(d?.footprintName||d?.footprint?.name||"").trim();
  const changeId=(action,...keys)=>JSON.stringify([action,...keys.map(k=>k??"")]);
  const GROUP_OF={link:"Link Components",addComponent:"Add Components",removeComponent:"Remove Components",ref:"Change Components",
    value:"Change Components",footprint:"Change Components",param:"Change Components",addNet:"Add Nets",renameNet:"Rename Nets",
    removeNet:"Remove Nets",padNet:"Pad Nets",netClass:"Net Classes",diffPair:"Differential Pairs",room:"Rooms"};
  const GROUPS=[...new Set(Object.values(GROUP_OF))];
  const RUN_ORDER=["link","removeComponent","ref","value","footprint","param","addComponent","renameNet","addNet","padNet","removeNet","netClass","diffPair","room"];
  const ACTION_LABEL={link:"Link",addComponent:"Add",removeComponent:"Remove",ref:"Modify designator",value:"Modify comment",footprint:"Change footprint",
    param:"Modify parameter",addNet:"Add net",renameNet:"Rename net",removeNet:"Remove net",padNet:"Pad net",netClass:"Net class",diffPair:"Differential pair",room:"Add room"};
  // Extra schematic-direction actions and planners (pin-swap.js: pin and gate swaps from the board).
  const SCH_PLANNERS=[];
  function extendSch(action,{group,label,run,plan}){GROUP_OF[action]=group;if(!GROUPS.includes(group))GROUPS.push(group);if(!RUN_ORDER.includes(action))RUN_ORDER.push(action);ACTION_LABEL[action]=label;SCH[action]=run;if(plan&&!SCH_PLANNERS.includes(plan))SCH_PLANNERS.push(plan);}
  function groupInto(map,k,v){if(!map.has(k))map.set(k,[]);map.get(k).push(v);}
  function footprintDef(project,sd){
    if(sd?.footprint)return sd;
    const w=up(wanted(sd));if(!w)return null;
    return project.library.find(d=>d.footprint&&up(d.footprint.name)===w)||null;
  }
  function pinTable(sd){const m=new Map();for(const p of sd?.symbol?.pins||[])if(p.number!==""&&p.number!=null)groupInto(m,String(p.number),p);return m;}
  function padTable(fp){const m=new Map();for(const p of fp?.pads||[])if(p.number!==""&&p.number!=null&&!p.thermalVia)groupInto(m,String(p.number),p);return m;}

  // ------------------------------------------------------------------ comparison context
  const assignmentCache=new WeakMap();
  // A review decision changes which candidate is accepted, but leaves the assignment evidence
  // unchanged. Retain the last committed assignment per board for asynchronous dialog/status plans.
  // Validate/execute always recompute directly from the model, including uncommitted edits.
  function matchingVersion(project,board,sheets,scope){
    const undo=globalThis.AtriumUndoStore;
    if(!undo?.documentVersions)return null;
    const v=undo.documentVersions(board,project);
    if(!v)return null;
    const stamps=[scope,v.floor,v.library,v.project,v.parameters,v.items,v.outer];
    for(const sheet of sheets){
      const s=undo.documentVersions(sheet,project);if(!s)return null;
      stamps.push(sheet.id,s.items,s.outer);
    }
    return JSON.stringify(stamps);
  }
  function cachedLocal(project,defs){
    return (doc,build)=>{
      const entry=A.sheetEntry(project,doc,defs);
      return entry?(entry.local??=build()):build();
    };
  }
  function *contextSteps(project,scope,boardId,opts={}){
    let tick=0;
    let board=boardId!=null?project.documents.find(d=>d.kind==="pcb"&&d.id===boardId):project.documents.find(d=>d.kind==="pcb");
    const all=project.documents.filter(d=>d.kind==="schematic");
    if(boardId!=null&&!board)board=project.documents.find(d=>d.kind==="pcb"&&up(d.name)===up(boardId));
    // A sheet by ID or name, like the authoring tools.
    if(scope!=="*"){const s=all.find(d=>d.id===scope)||all.find(d=>up(d.name)===up(scope));if(!s)throw Error("No schematic sheet is called "+scope+". Sheets: "+all.map(d=>d.name).join(", ")+".");scope=s.id;}
    const sheets=all.filter(d=>scope==="*"||d.id===scope);
    if(!board||!sheets.length)throw Error("Choose a schematic and a board from this project.");
    const defs=new Map(project.library.map(d=>[d.id,d])),issues=new Set();
    let hier=null;
    // Manual and background plans reuse the shared, journal-certified sheet graphs.
    try{hier=globalThis.AtriumHierarchy?.compileCached(project,{defs})||null;}catch{hier=null;}
    const channelLimit=hier?.issues.find(issue=>issue.kind==="channelLimit");
    if(channelLimit)throw Error(channelLimit.text);
    const conflicted=hier?new Set(hier.nets.filter(n=>n.conflict).map(n=>n.name)):null;
    for(const inst of hier?.instances||[])if(!globalThis.AtriumMultichannel&&inst.channel&&inst.channel.index===1&&(scope==="*"||inst.doc.id===scope))
      issues.add(inst.doc.name+" repeats in "+inst.symbol.name+". Only its first channel is synchronised with the board.");
    const graphs=new Map(),inScope=new Set(sheets.map(s=>s.id)),schNets=new Set();
    // Every net of the compiled project (all sheets and channels), so a partial comparison
    // never mistakes a net of an uncompared sheet for one the schematic dropped.
    for(const s of all){
      if((++tick&15)===0)yield;
      const mine=hier?.byDoc.get(s.id),graph=mine||A.sheetNets(project,s,defs);
      graphs.set(s.id,{graph,stored:!s.items.some(i=>["wire","netlabel","power","port","offsheet","sheetsymbol","bus"].includes(i.kind)),bad:mine?conflicted:new Set((graph.nets||[]).filter(n=>n.conflict).map(n=>n.name))});
      if(graphs.get(s.id).stored)for(const p of componentItems(s))for(const n of Object.values(p.pinNets||{}))if(n)schNets.add(n);
      for(const v of graph.byPin.values())if(v)schNets.add(v);
      for(const v of graph.byWire?.values?.()||[])if(v)schNets.add(v);
    }
    for(const m of hier?.byInstance?.values?.()||[]){for(const v of m.byPin.values())if(v)schNets.add(v);for(const v of m.byWire?.values?.()||[])if(v)schNets.add(v);}
    for(const n of hier?.nets||[])if(n.name)schNets.add(n.name);
    const comps=new Map(),allLinks=new Set(),allRefs=new Set(),duplicateRefs=new Set();
    for(const sheet of all){
      const scoped=inScope.has(sheet.id);
      for(const p of (globalThis.AtriumMultichannel?.sheetParts(project,sheet,hier)||componentItems(sheet))){
        if((++tick&127)===0)yield;
        if(p.link)allLinks.add(p.link);
        if(annotated(p.ref))allRefs.add(up(p.ref));
        // Every sheet contributes gates (a part's gates may sit on other sheets); only components
        // with a gate on a compared sheet are compared.
        if(!annotated(p.ref)){if(!scoped)continue;issues.add(sheet.name+" / "+(p.ref||"(no designator)")+" is not annotated. Annotate the schematics before updating the board.");continue;}
        let key=up(p.ref);
        const g=graphs.get(sheet.id),multi=defs.get(p.def)?.symbol?.parts>1;
        let c=comps.get(key);
        if(c&&(!multi||c.def!==p.def||c.gates.some(x=>unitOf(x.p)===unitOf(p)))){
          issues.add("Duplicate schematic designator "+p.ref+".");duplicateRefs.add(key);
          key=JSON.stringify([key,p.id,p.mcInstance?.id||""]);c=null;
        }
        if(!c){c={key,ref:p.ref.trim(),def:p.def,value:p.value??"",parameters:p.parameters||null,gates:[],inScope:false};comps.set(key,c);}
        else if((p.value??"")!==c.value)issues.add("The gates of "+c.ref+" have different comments ("+c.value+", "+(p.value??"")+").");
        if(scoped)c.inScope=true;
        c.gates.push({p,sheet,graph:(p.mcInstance&&hier?.byInstance.get(p.mcInstance.id))||g.graph,bad:g.bad,stored:g.stored});
      }
    }
    for(const c of comps.values()){
      c.sd=defs.get(c.def);c.fd=footprintDef(project,c.sd);c.sheet=(c.gates.find(g=>inScope.has(g.sheet.id))||c.gates[0]).sheet;
      c.links=[...new Set(c.gates.map(g=>g.p.link).filter(Boolean))];
      // A pin's net comes from whichever placed gate owns it (shared pins: the first gate that names one).
      c.net=n=>{for(const g of c.gates){const v=g.graph.byPin.get(g.p.id+"/"+n)||(g.stored&&g.p.pinNets?.[n]);if(v)return {net:v,bad:!!g.bad?.has(v)};}return {net:"",bad:false};};
    }
    const parts=componentItems(board),byLink=new Map(),byRef=new Map();
    for(const bp of parts){if(bp.link)groupInto(byLink,bp.link,bp);groupInto(byRef,up(bp.ref),bp);}
    for(const list of byRef.values())if(list.length>1)issues.add("Duplicate board designator "+list[0].ref+".");
    const C=globalThis.AtriumComponentMatch,location=C.boardLocations(board),bySource=new Map(),byTarget=new Map(parts.map(p=>[p.id,p]));
    const left=[],right=[],linkUse=new Map();
    for(const c of comps.values()){
      if((++tick&127)===0)yield;
      const g=c.gates[0],p=g.p,channel=p.mcInstance?.id||p.channel||"";
      c.sourceKey=JSON.stringify([g.sheet.id,p.id,channel]);
      c.channel=channel;
      c.location={sheet:g.sheet.id,channel,x:p.x,y:p.y};
      for(const link of c.links)groupInto(linkUse,link,c);
      bySource.set(c.sourceKey,c);
      left.push(C.describe(p,c.sd,{key:c.sourceKey,ids:c.gates.map(g=>g.p.id),links:c.links,unit:1,sheet:g.sheet.id,
        channel,room:up(p.mcInstance?.suffix?.slice(1)||g.sheet.name),plane:g.sheet.id,
        footprint:up(c.fd?.footprint?.name||wanted(c.sd)),pins(){
          const m=new Map();
          for(const n of pinTable(c.sd).keys()){const r=c.net(n);if(r.net&&!r.bad)m.set(n,r.net);}
          return m;
        }}));
    }
    for(const p of parts){
      if((++tick&127)===0)yield;
      // An unannotated symbol still owns its exact footprint while annotation is pending.
      if(p.link&&allLinks.has(p.link)&&!linkUse.has(p.link))continue;
      const d=defs.get(p.def),loc=location(p);
      right.push(C.describe(p,d,{unit:1,sheet:loc.sheet,channel:loc.channel,room:loc.room,plane:loc.source?.sheet||"",
        x:loc.source?.x,y:loc.source?.y,boardAt:[p.x,p.y],pins:()=>C.boardPins(p,d)}));
    }
    const version=opts.background&&matchingVersion(project,board,all,scope),previous=version&&assignmentCache.get(board);
    let result;
    if(previous&&previous.version===version&&previous.hierarchy===globalThis.AtriumHierarchy&&previous.channels===globalThis.AtriumMultichannel&&previous.objects===globalThis.AtriumSchObjects)result=previous.result;
    else{
      result=yield* C.steps(left,right,{strictSheet:true,background:!!opts.background});
      // A different task may have edited the project while the worker was scoring candidates.
      if(version&&version===matchingVersion(project,board,all,scope))assignmentCache.set(board,{version,result,
        hierarchy:globalThis.AtriumHierarchy,channels:globalThis.AtriumMultichannel,objects:globalThis.AtriumSchObjects});
    }
    const matched=new Map(),taken=new Set(),reserved=new Set(result.reviewTargets);
    const matches=[],sources=[],targets=[],removals=new Map(),pending=new Set();
    const decisions=Array.isArray(opts.matchDecisions)?opts.matchDecisions:[];
    const sourcePicks=new Map(decisions.filter(d=>d&&typeof d.source==="string").map(d=>[d.source,d]));
    const targetPicks=new Map(decisions.filter(d=>d&&d.source===undefined).map(d=>[d.target,d]));
    const targetRecords=new Map(right.map(r=>[r.key,r])),stamps=new Map();
    function stamp(r){
      if(!stamps.has(r)){
        const pinMap=r.pins(),pairs=pinMap instanceof Map?[...pinMap]:Object.entries(pinMap||{});
        const evidence=[r.ids,r.links,r.sourceIds,r.ref,r.value,r.footprint,r.library,r.sheet,r.channel,r.room,r.x,r.y,r.boardAt,pairs.sort((a,b)=>cmp(a[0],b[0]))];
        // The token expires a saved choice after edits. Keep it small even for a large BGA.
        const text=JSON.stringify(evidence);let h=2166136261,j=5381;
        for(let i=0;i<text.length;i++){const n=text.charCodeAt(i);h=Math.imul(h^n,16777619);j=Math.imul(j,33)^n;}
        stamps.set(r,(h>>>0).toString(36)+"."+(j>>>0).toString(36));
      }
      return stamps.get(r);
    }
    function accept(c,id,info){
      const bp=byTarget.get(id);
      matched.set(c.key,{bp,how:info.by,info});taken.add(id);
      if(c.inScope){
        const pair={source:c.sourceKey,target:id,sourceRef:c.ref,targetRef:bp.ref,sheet:c.sheet.name,...info};
        if(duplicateRefs.has(up(c.ref)))pair.sourceAt=[c.location.x,c.location.y];
        if(byRef.get(up(bp.ref))?.length>1)pair.targetAt=[bp.x,bp.y];
        matches.push(pair);
      }
    }
    const reviewTargetIds=new Set(),waitingTargets=new Set();
    for(const a of left){
      if((++tick&127)===0)yield;
      const c=bySource.get(a.key),m=result.pairs.get(a.key);
      if(!result.reviewSources.has(a.key)){
        if(m)accept(c,m.target,m);
        continue;
      }
      c.skip=true;
      if(!c.inScope)continue;
      const evidence=result.choices.get(a.key)||[],candidates=evidence.map(e=>e.target),pick=sourcePicks.get(a.key);
      for(const id of candidates)reviewTargetIds.add(id);
      const row={source:a.key,ref:c.ref,sheet:c.sheet.name,channel:c.channel,at:[a.x,a.y],proposed:m?.target||null,candidates,evidence,
        confidence:m?.confidence??0,reasons:m?.reasons||[result.unpairedReasons?.get(a.key)||"A board footprint also fits another schematic component"],stamp:stamp(a)};
      if(pick&&pick.stamp===row.stamp&&(pick.target===null||candidates.includes(pick.target)&&
        stamp(targetRecords.get(pick.target))===pick.targetStamp&&!taken.has(pick.target))){
        c.skip=false;row.choice=pick.target;
        if(pick.target){
          const e=evidence.find(e=>e.target===pick.target);
          accept(c,pick.target,{by:"review",confidence:e.confidence,reasons:["Pair chosen in component review",...e.reasons],review:false});
        }
      }else{
        pending.add(a.key);
        for(const id of candidates)waitingTargets.add(id);
      }
      sources.push(row);
    }
    for(const id of reviewTargetIds){
      if((++tick&127)===0)yield;
      const p=byTarget.get(id),pick=targetPicks.get(id),signature=stamp(targetRecords.get(id));
      const assigned=taken.has(id),waiting=waitingTargets.has(id);
      const row={target:id,ref:p.ref,at:[p.x,p.y],value:p.value||"",footprint:defs.get(p.def)?.footprint?.name||"",locked:!!p.locked,stamp:signature,assigned,waiting};
      if(!assigned&&!waiting){
        if(p.locked||opts.direction==="sch")row.choice="keep";
        else if(pick?.stamp===signature&&["keep","remove"].includes(pick.action))row.choice=pick.action;
        else pending.add(id);
        if(row.choice==="remove")removals.set(id,true);
      }
      targets.push(row);
    }
    // A copied schematic link cannot be written onto two board footprints. Keep a unique
    // board link when possible; a reviewed new copy receives its own link when the ECO runs.
    for(const c of comps.values()){
      const bp=matched.get(c.key)?.bp;
      const free=link=>link&&(!byLink.has(link)||byLink.get(link).length===1&&byLink.get(link)[0]===bp);
      c.preferredLink=c.links.find(l=>linkUse.get(l).length===1&&free(l))||
        (bp?.link&&free(bp.link)?bp.link:"");
    }
    const usedLinks=new Set([...allLinks,...byLink.keys()]);
    function fresh(c){
      const base="eco-"+encodeURIComponent(c.gates.map(g=>g.p.id).sort()[0]);let n=1,link=base;
      while(usedLinks.has(link))link=base+"-"+(++n);
      usedLinks.add(link);return link;
    }
    const repeated=new Map();
    for(const c of comps.values())if(!c.channel&&!c.preferredLink)c.preferredLink=fresh(c);
    for(const c of comps.values())if(c.channel)groupInto(repeated,JSON.stringify(c.gates.map(g=>g.p.id).sort()),c);
    for(const group of repeated.values()){
      // All instances share one schematic link base. Applying the first channel may already
      // have written it when the next channel validates the same underlying schematic gate.
      const source=group.map(c=>c.preferredLink).filter(Boolean).map(baseLink).find(base=>group.every(c=>{
        const owners=byLink.get(base+"@"+c.channel);
        return !owners||owners.length===1&&owners[0]===matched.get(c.key)?.bp;
      }))||fresh(group[0]);
      for(const c of group)c.preferredLink=source+"@"+c.channel;
    }
    const extras=parts.filter(bp=>!taken.has(bp.id)&&(removals.has(bp.id)||!reserved.has(bp.id)&&
      (scope==="*"||location(bp).sheet===scope)&&!(bp.link&&allLinks.has(bp.link))&&!allRefs.has(up(bp.ref))));
    const review={sources,targets,pending:pending.size};
    if(review.pending)issues.add("Ambiguous component identity. Review component matches before executing changes.");
    return {project,board,all,sheets,defs,issues,comps,matched,extras,parts,graphs,schNets,scope,review,matches,removals};
  }
  const context=(project,scope,board,opts)=>globalThis.AtriumComponentMatch.finish(contextSteps(project,scope,board,opts));
  // Return validated decisions for a fresh plan; re-planning also recomputes all dependent net,
  // package and placement rows. Decisions expire when either component's evidence changes.
  function decide(p,source,target,action){
    const decisions=[...(p.options.matchDecisions||[])],r=p.review;
    if(source!=null){
      const row=r.sources.find(x=>x.source===source);
      if(!row||target!==null&&!row.candidates.includes(target))throw Error("Choose a footprint from this component review.");
      if(target!=null&&r.sources.some(x=>x.source!==source&&x.choice===target))throw Error("That footprint is already paired.");
      const t=r.targets.find(x=>x.target===target);
      return [...decisions.filter(d=>d.source!==source),{source,target,stamp:row.stamp,...(t?{targetStamp:t.stamp}:{})}];
    }
    const t=r.targets.find(x=>x.target===target);
    if(!t||t.assigned||t.waiting||!["keep","remove"].includes(action)||t.locked&&action==="remove")throw Error("Choose an unpaired footprint to keep or remove.");
    return [...decisions.filter(d=>d.source!==undefined||d.target!==target),{target,action,stamp:t.stamp}];
  }

  // ------------------------------------------------------------------ placement
  // New footprints arrive in clusters, one per schematic sheet (and per channel of a repeated
  // sheet), beside the board outline (a grid when there is none). Inside a cluster the parts keep
  // the arrangement of their symbols: parts drawn near each other start near each other, scaled
  // to the footprint sizes and packed without overlaps.
  const GAP=1,snapMm=v=>Math.round(v*20)/20+0;
  function footprintBox(fp){
    const pts=A.symbolPoints(fp);
    if(Array.isArray(fp?.courtyard))pts.push(...fp.courtyard.filter(p=>Array.isArray(p)));
    if(Array.isArray(fp?.courtyard)&&fp.courtyard.length===4&&fp.courtyard.every(Number.isFinite))pts.push([fp.courtyard[0],fp.courtyard[1]],[fp.courtyard[2],fp.courtyard[3]]);
    return A.bounds(pts)||[-0.5,-0.5,0.5,0.5];
  }
  const clusterOf=e=>{const inst=e.comp.gates.find(g=>g.sheet.id===e.comp.sheet.id)?.p?.mcInstance;return {key:e.comp.sheet.id+(inst?"@"+inst.id:""),
    name:e.comp.sheet.name+(inst?" "+String(inst.suffix||inst.name||inst.id).replace(/^_/,""):""),channel:inst?.id||null};};
  // Relative layout of one cluster: schematic positions scaled to the footprints, then each part
  // (largest first) takes the free spot nearest its scaled position. Returns sizes and offsets.
  function packCluster(entries){
    const items=entries.map(e=>{const g=e.comp.gates.find(x=>x.sheet.id===e.comp.sheet.id)||e.comp.gates[0],b=footprintBox(e.comp.fd.footprint);
      return {e,b,w:b[2]-b[0]+GAP,h:b[3]-b[1]+GAP,sx:+g.p.x||0,sy:+g.p.y||0};});
    const area=items.reduce((s,q)=>s+q.w*q.h,0),sb=A.bounds(items.map(q=>[q.sx,q.sy])),sw=Math.max(sb[2]-sb[0],1),sh=Math.max(sb[3]-sb[1],1);
    const k=Math.max(0.03,Math.min(1,Math.sqrt(area*2.2/(sw*sh))));
    for(const q of items){q.tx=(q.sx-sb[0])*k-q.w/2;q.ty=(q.sy-sb[1])*k-q.h/2;}
    const CELL=4,grid=new Map(),cells=(x0,y0,x1,y1,f)=>{for(let i=Math.floor(x0/CELL);i<=Math.floor(x1/CELL);i++)for(let j=Math.floor(y0/CELL);j<=Math.floor(y1/CELL);j++)f(i+","+j);};
    const free=(x,y,w,h)=>{let ok=true;cells(x,y,x+w,y+h,c=>{if(ok)for(const o of grid.get(c)||[])if(x<o[2]-1e-9&&o[0]<x+w-1e-9&&y<o[3]-1e-9&&o[1]<y+h-1e-9){ok=false;break;}});return ok;};
    const take=(x,y,w,h)=>{const r=[x,y,x+w,y+h];cells(x,y,x+w,y+h,c=>{if(!grid.has(c))grid.set(c,[]);grid.get(c).push(r);});};
    const order=[...items].sort((a,b)=>b.w*b.h-a.w*a.h||cmp(a.e.comp.ref,b.e.comp.ref));
    const STEP=0.5;
    for(const q of order){
      let best=null;
      for(let r=0;r<400&&!best;r++){
        for(let i=-r;i<=r;i++)for(const [dx,dy] of r?[[i,-r],[i,r],[-r,i],[r,i]]:[[0,0]]){
          const x=snapMm(q.tx+dx*STEP),y=snapMm(q.ty+dy*STEP);
          if(!free(x,y,q.w,q.h))continue;
          const d=Math.hypot(x-q.tx,y-q.ty);if(!best||d<best.d)best={x,y,d};
        }
      }
      if(!best)best={x:snapMm(q.tx),y:snapMm(q.ty)};
      q.x=best.x;q.y=best.y;take(q.x,q.y,q.w,q.h);
    }
    const x0=Math.min(...items.map(q=>q.x)),y0=Math.min(...items.map(q=>q.y));
    for(const q of items){q.x-=x0;q.y-=y0;}
    return {items,w:Math.max(...items.map(q=>q.x+q.w)),h:Math.max(...items.map(q=>q.y+q.h))};
  }
  function placeNew(cx,list){
    if(!list.length)return [];
    const {board,defs}=cx,area=A.docBounds(board,defs),outline=board.outline?.length>=3?A.bounds(board.outline):null;
    const order=cx.all.map(s=>s.id),groups=new Map();
    for(const e of list){const c=clusterOf(e);if(!groups.has(c.key))groups.set(c.key,{...c,sheet:e.comp.sheet.id,entries:[]});groups.get(c.key).entries.push(e);}
    const packs=[...groups.values()].sort((a,b)=>order.indexOf(a.sheet)-order.indexOf(b.sheet)||cmp(a.name,b.name)).map(g=>({g,pack:packCluster(g.entries)}));
    // Beside the outline: a row to the right of everything on the board, wrapping below it. No
    // outline: a grid of clusters about as wide as it is tall.
    const LABEL=4,SPACE=5,clusters=[];
    const total=packs.reduce((s,q)=>s+(q.pack.w+SPACE)*(q.pack.h+LABEL+SPACE),0);
    const wrap=outline?Math.max((outline[2]-outline[0])*2,120):Math.max(Math.sqrt(total)*1.2,...packs.map(q=>q.pack.w));
    const x0=snapMm(outline?area[2]+SPACE*2:area[0]),y0=snapMm(outline?outline[1]:area[1]);
    let x=0,y=0,rowH=0;
    for(const {g,pack} of packs){
      if(x>0&&x+pack.w>wrap){x=0;y+=rowH+SPACE;rowH=0;}
      const ox=snapMm(x0+x),oy=snapMm(y0+y+LABEL);
      for(const q of pack.items)q.e.change.at=[snapMm(ox+q.x-q.b[0]+GAP/2),snapMm(oy+q.y-q.b[1]+GAP/2)];
      clusters.push({key:g.key,sheet:g.sheet,sheetName:g.name,name:g.name,channel:g.channel,bounds:[ox,oy,snapMm(ox+pack.w),snapMm(oy+pack.h)],ids:pack.items.map(q=>q.e.change.id)});
      x+=pack.w+SPACE;rowH=Math.max(rowH,pack.h+LABEL);
    }
    return clusters;
  }

  // ------------------------------------------------------------------ Update PCB
  // Multichannel parts carry a channel link (base@instance); the schematic part stores the base.
  const baseLink=l=>globalThis.AtriumMultichannel?.baseLink?AtriumMultichannel.baseLink(l):l;
  function addLink(c,bp,base,add){
    const link=c.preferredLink,gateLinks={};
    for(const g of c.gates)gateLinks[g.p.id]=baseLink(g.p.link||"");
    if((bp.link||"")!==link||Object.values(gateLinks).some(v=>v!==baseLink(link)))
      add({...base,action:"link",id:changeId("link",bp.id),object:c.ref,before:bp.link||"",after:link,gateLinks});
  }
  function planPCB(cx,opts){
    const {board,defs,issues}=cx,changes=[],pinRows=[],fresh=[];
    const add=c=>{c.group=GROUP_OF[c.action];if(c.selected===undefined)c.selected=true;changes.push(c);return c;};
    function pads(c,bp,fp,addId,partId,fpId){
      const pins=pinTable(c.sd),table=padTable(fp);
      for(const n of pins.keys())if(!table.has(n))issues.add(c.ref+" pin "+n+" has no matching footprint pad.");
      for(const [n,group] of table){
        if(!pins.has(n)){issues.add(c.ref+" pad "+n+" has no matching schematic pin.");continue;}
        if(pins.get(n).length!==1){issues.add(c.ref+" pin "+n+" is ambiguous.");continue;}
        const before=bp&&own(bp.pinNets,n)?[bp.pinNets[n]]:[...new Set(group.map(p=>p.net||""))];
        if(before.length!==1){issues.add(c.ref+" pad "+n+" has inconsistent footprint net assignments.");continue;}
        const {net,bad}=c.net(n);
        if(bad){issues.add(c.ref+" pin "+n+" has conflicting schematic net names.");continue;}
        if(pins.get(n)[0].hidden&&!net){issues.add(c.ref+" pin "+n+" is hidden and its net is unresolved.");continue;}
        pinRows.push({c,partId,existing:!!bp,n,before:bp?before[0]:"",after:net,addId,fpId});
      }
    }
    for(const c of [...cx.comps.values()].filter(c=>!c.skip&&c.inScope).sort((a,b)=>cmp(a.ref,b.ref))){
      const m=cx.matched.get(c.key),base={sheet:c.sheet.id,sheetName:c.sheet.name,component:c.ref,sourceIds:c.gates.map(g=>g.p.id),document:board.name};
      if(!c.fd){
        issues.add(c.sheet.name+" / "+c.ref+(wanted(c.sd)?" needs footprint "+wanted(c.sd)+", which is not in the project library.":" has no footprint."));
        if(!m)continue;
      }
      if(!m){
        const partId=A.id(),ch=add({...base,action:"addComponent",id:changeId("addComponent",c.key),object:c.ref,before:"",after:c.fd.footprint.name,
          def:c.fd.id,value:c.value,link:c.preferredLink,partId,at:[0,0],angle:0});
        if(c.parameters&&Object.keys(c.parameters).length)ch.parameters={...c.parameters};
        fresh.push({change:ch,comp:c});
        pads(c,null,c.fd.footprint,ch.id,partId,null);
        continue;
      }
      const bp=m.bp,bd=defs.get(bp.def),t={...base,targetId:bp.id};
      addLink(c,bp,t,add);
      if(c.ref!==bp.ref)add({...t,action:"ref",id:changeId("ref",bp.id),object:bp.ref,before:bp.ref,after:c.ref});
      if(c.value!==(bp.value??""))add({...t,action:"value",id:changeId("value",bp.id),object:c.ref,before:bp.value??"",after:c.value});
      let fp=bd?.footprint,fpId=null;
      if(c.fd&&fp&&up(c.fd.footprint.name)!==up(fp.name)){
        if(bp.locked)issues.add(board.name+" / "+bp.ref+" is locked; its footprint stays "+fp.name+".");
        else{fpId=add({...t,action:"footprint",id:changeId("footprint",bp.id),object:c.ref,before:fp.name,after:c.fd.footprint.name,beforeDef:bp.def,def:c.fd.id}).id;fp=c.fd.footprint;}
      }
      const sp=c.parameters||{},bpp=bp.parameters||{};
      for(const k of Object.keys(sp).sort(cmp)){
        const before=own(bpp,k)?String(bpp[k]):null,after=String(sp[k]);
        if(before!==after)add({...t,action:"param",id:changeId("param",bp.id,k),object:c.ref+" "+k,key:k,before,after});
      }
      pads(c,bp,fp,null,bp.id,fpId);
    }
    // opts.layout false: the changes only (the status bar counts them); new parts get no positions or clusters.
    const clusters=opts.layout===false?[]:placeNew(cx,fresh);
    // Nets named on the board: which pads and how much copper carry each.
    const boardNets=new Map(),entry=n=>{let e=boardNets.get(n);if(!e)boardNets.set(n,e={pads:[],copper:0});return e;};
    for(const i of board.items){
      if(i.kind==="part"){
        const seen=new Set();
        for(const [n,v] of Object.entries(i.pinNets||{})){if(v)entry(v).pads.push(i.id+"/"+n);seen.add(n);}
        for(const p of defs.get(i.def)?.footprint?.pads||[])if(!seen.has(String(p.number))&&p.net)entry(p.net).pads.push(i.id+"/"+p.number);
      }else if(typeof i.net==="string"&&i.net)entry(i.net).copper++;
    }
    // Pads whose schematic pin was compared. Only nets whose every pad was compared may be
    // renamed or removed: anything else would change footprints the ECO never looked at.
    const compared=new Set(),byBefore=new Map(),pinCount=new Map();
    for(const r of pinRows){
      if(r.existing){compared.add(r.partId+"/"+r.n);if(r.before)groupInto(byBefore,r.before,r);}
      if(r.after)pinCount.set(r.after,(pinCount.get(r.after)||0)+1);
    }
    const allCompared=b=>{const ps=boardNets.get(b).pads;return (ps.length||cx.scope==="*")&&ps.every(k=>compared.has(k));};
    const schNets=cx.schNets,renames=new Map(),claimed=new Set(),kept=[];
    for(const b of [...boardNets.keys()].sort(cmp)){
      if(schNets.has(b))continue;
      if(!allCompared(b)){kept.push(b);continue;}
      const rows=byBefore.get(b)||[],targets=new Set(rows.filter(r=>r.after).map(r=>r.after));
      if(targets.size!==1)continue;
      const s=[...targets][0];
      if(boardNets.has(s)||claimed.has(s)||(byBefore.get(s)||[]).length)continue;
      claimed.add(s);
      // Only the pads the schematic moves to the new name follow it; disconnected pads keep their own row.
      renames.set(b,add({action:"renameNet",id:changeId("renameNet",b),object:b,document:board.name,before:b,after:s,copper:boardNets.get(b).copper,
        pads:rows.filter(r=>r.after===s).map(r=>[r.partId,r.n])}));
    }
    for(const b of kept)issues.add("Net "+b+" is not in the schematics, but some of its pads were not compared. It is kept.");
    const addNets=new Map();
    for(const s of [...pinCount.keys()].sort(cmp))if(!boardNets.has(s)&&!claimed.has(s))
      addNets.set(s,add({action:"addNet",id:changeId("addNet",s),object:s,document:board.name,before:"",after:s,pins:pinCount.get(s)}).id);
    const removed=new Set();
    for(const b of [...boardNets.keys()].sort(cmp))if(!schNets.has(b)&&!renames.has(b)&&allCompared(b)){
      const e=boardNets.get(b);removed.add(b);
      add({action:"removeNet",id:changeId("removeNet",b),object:b,document:board.name,before:b,after:"",copper:e.copper,selected:!e.copper});
    }
    for(const r of pinRows){
      if(r.before===r.after)continue;
      // Disconnecting a pad is ticked only when its old net goes away anyway.
      const vanishing=r.before&&(renames.has(r.before)||removed.has(r.before));
      const ch=add({action:"padNet",id:changeId("padNet",r.existing?r.partId:"new:"+r.c.key,r.n),object:r.c.ref+"-"+r.n,component:r.c.ref,targetId:r.partId,pin:r.n,
        sheet:r.c.sheet.id,sheetName:r.c.sheet.name,document:board.name,before:r.before,after:r.after,selected:!!r.after||!r.existing||!!vanishing});
      const requires=[r.addId,r.fpId,r.after&&addNets.get(r.after)].filter(Boolean);
      if(requires.length)ch.requires=requires;
      const ren=r.before&&renames.get(r.before);
      if(ren&&ren.after===r.after)ch.via=ren.id;
    }
    for(const bp of [...cx.extras].sort((a,b)=>cmp(a.ref,b.ref))){
      if(bp.locked){issues.add(board.name+" / "+bp.ref+" has no schematic component. It is locked and is kept.");continue;}
      add({action:"removeComponent",id:changeId("removeComponent",bp.id),object:bp.ref,targetId:bp.id,document:board.name,before:bp.ref,after:"",selected:cx.removals.has(bp.id)||!!opts.removeExtras});
    }
    directives(cx);
    if(opts.rooms){
      const byId=new Map(fresh.map(f=>[f.change.id,f.change]));
      // A room is made only when at least one of its footprints is added (requiresAny).
      for(const cl of clusters)add({action:"room",id:changeId("room",cl.key||cl.sheet),object:cl.sheetName||"Sheet",sheet:cl.sheet,sheetName:cl.sheetName,document:board.name,
        before:"",after:cl.sheetName,bounds:cl.bounds,members:cl.ids.map(id=>byId.get(id).partId),requiresAny:[...cl.ids]});
    }
    return {changes,clusters};
  }
  // Schematic directives (netClass, diffPair, signal, polarity, tags on net labels, ports, power ports,
  // off-sheet connectors, wires and directive items) act on the board live through the signal model
  // (signals.js directives(); docs/design/signal-model.md §7–8, unified-rules Q1): Update PCB copies no
  // classes or pairs any more. It reports what the directives cannot do yet: a directive off a named net,
  // a pair without two nets, an assumed polarity, a net the board does not have until this update adds it.
  // Saved ECO reports with netClass / diffPair rows still apply (the executors below).
  function directives(cx){
    const S=globalThis.AtriumSignals;
    if(!S?.directives)return;
    const {records,issues}=S.directives(cx.project);
    for(const i of issues)cx.issues.add(i.text);
    if(!records.length)return;
    const onBoard=new Set();
    for(const i of cx.board.items||[]){if(i.net)onBoard.add(i.net);for(const n of Object.values(i.pinNets||{}))if(n)onBoard.add(n);}
    for(const r of records)if(!onBoard.has(r.net)&&cx.schNets.has(r.net))cx.issues.add(r.sheetName+": the directive on "+r.net+" applies once this update adds the net to "+cx.board.name+".");
    let M=null;try{M=S.model(cx.project,cx.board);}catch{M=null;}
    for(const i of M?.issues||[])if(i.kind==="pair"||i.kind==="polarity"||i.kind==="double")cx.issues.add(i.text);
  }

  // ------------------------------------------------------------------ Update Schematic from PCB
  function channelRename(comps,cx){
    const first=comps[0],inst=first.gates[0].p.mcInstance,ref=cx.matched.get(first.key)?.bp.ref;
    if(!inst||!ref)return null;
    const candidates=new Set([first.gates[0].p.mcSource.ref]);
    if(ref.endsWith(inst.suffix))candidates.add(ref.slice(0,-inst.suffix.length));
    // Index and custom schemes can encode the ordinal before or after the number. Accept
    // only a single base that the project's own naming function reproduces in every instance.
    const m=/^([A-Za-z_]+)(\d+)([A-Za-z]*)$/.exec(ref);
    if(m)for(let k=0;k<m[2].length;k++)for(const gate of [m[3],""])candidates.add(m[1]+Number(m[2].slice(k))+gate);
    const valid=[...candidates].filter(name=>name&&comps.every(c=>c.gates[0].p.mcInstance.designator({ref:name})===cx.matched.get(c.key)?.bp.ref));
    return valid.length===1?valid[0]:null;
  }
  function planSCH(cx){
    const {board,defs,issues,project}=cx,changes=[];
    const add=c=>{c.group=GROUP_OF[c.action];if(c.selected===undefined)c.selected=true;changes.push(c);return c;};
    const finalRefs=new Map(),channels=new Map();
    const logical=c=>JSON.stringify(c.gates.map(g=>g.p.id).sort());
    for(const c of cx.comps.values())if(c.channel)groupInto(channels,logical(c),c);
    for(const c of [...cx.comps.values()].filter(c=>!c.skip&&c.inScope).sort((a,b)=>cmp(a.ref,b.ref))){
      const m=cx.matched.get(c.key);
      if(!m){issues.add(c.sheet.name+" / "+c.ref+" has no footprint on "+board.name+". Use Update PCB to add it.");continue;}
      const bp=m.bp,bd=defs.get(bp.def),t={sheet:c.sheet.id,sheetName:c.sheet.name,component:c.ref,sourceIds:c.gates.map(g=>g.p.id),targetId:bp.id,document:c.sheet.name};
      addLink(c,bp,t,add);
      const group=c.channel?channels.get(logical(c)):null;
      if(group&&group[0]!==c)continue;
      const consistent=(read,field)=>{
        if(!group||group.every(x=>{const m=cx.matched.get(x.key);return m&&read(m.bp)===read(bp);}))return true;
        issues.add("The channel footprints of "+c.gates[0].p.mcSource.ref+" disagree on "+field+". Their shared schematic component is kept.");return false;
      };
      if(group?group.some(x=>cx.matched.get(x.key)?.bp.ref!==x.ref):bp.ref!==c.ref){
        const before=group?c.gates[0].p.mcSource.ref:c.ref,after=group?channelRename(group,cx):bp.ref;
        if(after){
          add({...t,action:"ref",id:changeId("ref",c.key),object:before,before,after});
          for(const x of group||[c])finalRefs.set(x.key,up(cx.matched.get(x.key).bp.ref));
        }else issues.add("The board designators of "+before+" do not share one designator under the project's channel naming scheme.");
      }
      if(consistent(p=>p.value??"","comment")&&(bp.value??"")!==c.value)add({...t,action:"value",id:changeId("value",c.key),object:c.ref,before:c.value,after:bp.value??""});
      if(consistent(p=>up(defs.get(p.def)?.footprint?.name),"footprint")&&bd?.footprint&&up(bd.footprint.name)!==up(wanted(c.sd))){
        const pins=[...pinTable(c.sd).keys()].sort(cmp).join(),compatible=bd.symbol&&!bd.mirrorOf&&[...pinTable(bd).keys()].sort(cmp).join()===pins;
        const name=(c.sd?.name||"Component")+" ("+bd.footprint.name+")",reuse=project.library.find(d=>d.name===name&&d.symbol&&up(d.footprint?.name)===up(bd.footprint.name));
        add({...t,action:"footprint",id:changeId("footprint",c.key),object:c.ref,before:wanted(c.sd)||"(none)",after:bd.footprint.name,beforeDef:c.def,
          def:compatible?bd.id:reuse?reuse.id:A.id(),...(compatible||reuse?{}:{cloneOf:c.def,boardDef:bd.mirrorOf||bd.id,name})});
      }
      const bpp=bp.parameters||{},sp=c.parameters||{};
      const keys=group?new Set(group.flatMap(x=>Object.keys(cx.matched.get(x.key)?.bp.parameters||{}))):Object.keys(bpp);
      for(const k of [...keys].sort(cmp)){
        if(!consistent(p=>p.parameters?.[k],k))continue;
        const before=own(sp,k)?String(sp[k]):null,after=String(bpp[k]);
        if(before!==after)add({...t,action:"param",id:changeId("param",c.key,k),object:c.ref+" "+k,key:k,before,after});
      }
    }
    for(const f of SCH_PLANNERS)try{f(cx,add,{changeId,cmp});}catch(e){issues.add(e.message);}
    for(const bp of cx.extras)issues.add(board.name+" / "+bp.ref+" has no schematic component.");
    const used=new Map();
    for(const c of cx.comps.values()){const r=finalRefs.get(c.key)||c.key;if(used.has(r))issues.add("Updating the schematic would duplicate designator "+r+".");used.set(r,c);}
    return {changes,clusters:[]};
  }

  // ------------------------------------------------------------------ sync state (board.sync)
  // board.sync.base: {<board part id>: [designator, comment, footprint]} as both sides last agreed
  // (written by execute). A difference is then traced to the side that changed: "schematic",
  // "board", or both (a conflict, never resolved silently). board.sync.ignore: "Never sync this"
  // rules [{action, object, pin?, key?, label}], listed and removable in Sync Settings.
  const BASE_FIELDS=["ref","value","footprint"];
  const baseOf=b=>{const v=b?.sync?.base;return v&&typeof v==="object"&&!Array.isArray(v)?v:null;};
  const ignoresOf=b=>Array.isArray(b?.sync?.ignore)?b.sync.ignore.filter(r=>r&&typeof r.action==="string"):[];
  const ruleKey=r=>[r.action,up(r.object),r.pin??"",r.key??""].join("\u0000");
  const ruleOf=c=>({action:c.action,object:String(c.component??c.object??""),...(c.pin!=null?{pin:String(c.pin)}:{}),...(c.key!=null?{key:String(c.key)}:{})});
  function syncOf(board){if(!board.sync||typeof board.sync!=="object"||Array.isArray(board.sync))board.sync={};return board.sync;}
  function tidySync(board){const s=board.sync;if(s&&typeof s==="object"){for(const k of Object.keys(s))if(s[k]==null||Array.isArray(s[k])&&!s[k].length||typeof s[k]==="object"&&!Array.isArray(s[k])&&!Object.keys(s[k]).length)delete s[k];if(!Object.keys(s).length)delete board.sync;}}
  function neverSync(board,c){
    const rule={...ruleOf(c),label:describe(c)},list=ignoresOf(board);
    if(list.some(r=>ruleKey(r)===ruleKey(rule)))return false;
    syncOf(board).ignore=[...list,rule];return true;
  }
  function syncAgain(board,rule){const k=ruleKey(rule);syncOf(board).ignore=ignoresOf(board).filter(r=>ruleKey(r)!==k);tidySync(board);}
  function forgetBase(board){if(board.sync){delete board.sync.base;delete board.sync.locations;tidySync(board);}}
  // The side each component difference came from, against the last agreed state.
  function reconcile(cx,changes,direction){
    const base=baseOf(cx.board);if(!base)return;
    const mine=changes.filter(c=>BASE_FIELDS.includes(c.action)&&c.targetId&&Array.isArray(base[c.targetId]));
    if(!mine.length)return;
    let other=null;
    const alt=c=>{if(!other){try{other=(direction==="sch"?planPCB:planSCH)({...cx,issues:new Set()},{}).changes;}catch{other=[];}}return other.find(o=>o.action===c.action&&o.targetId===c.targetId)||null;};
    const same=(f,a,b)=>f==="value"?String(a??"")===String(b??""):up(a)===up(b);
    for(const c of mine){
      const f=c.action,was=base[c.targetId][BASE_FIELDS.indexOf(f)];if(was==null)continue;
      const sch=direction==="pcb"?c.after:c.before,brd=direction==="pcb"?c.before:c.after;
      const sChanged=!same(f,sch,was),bChanged=!same(f,brd,was);
      if(sChanged&&bChanged){c.origin="both";c.conflict={schematic:sch,board:brd,base:was};c.use=null;c.selected=false;const a=alt(c);if(a)c.alt=a;}
      else if(bChanged){c.origin="board";if(direction==="pcb"){const a=alt(c);if(a){c.alt=a;c.use="reverse";}}}
      else if(sChanged){c.origin="schematic";if(direction==="sch"){const a=alt(c);if(a){c.alt=a;c.use="reverse";}}}
    }
  }
  // After an execute: the fields both sides now agree on become the new base.
  function rebase(project,boardId){
    let cx;try{cx=context(project,"*",boardId);}catch{return;}
    const base={...(baseOf(cx.board)||{})},locations={...(cx.board.sync?.locations||{})},live=new Set(cx.parts.map(p=>p.id));
    for(const k of Object.keys(base))if(!live.has(k)||!Array.isArray(base[k]))delete base[k];
    for(const k of Object.keys(locations))if(!live.has(k))delete locations[k];
    for(const c of cx.comps.values()){
      const m=cx.matched.get(c.key);if(!m)continue;
      if(c.links.includes(m.bp.link)||m.how==="id"||m.how==="source")locations[m.bp.id]=c.location;
      const bp=m.bp,bd=cx.defs.get(bp.def),s=[c.ref,c.value,c.fd?.footprint?.name||wanted(c.sd)],d=[bp.ref,bp.value??"",bd?.footprint?.name||""];
      const next=(base[bp.id]||[null,null,null]).slice(0,3);
      for(let i=0;i<3;i++)if(i===1?s[i]===d[i]:up(s[i])===up(d[i]))next[i]=d[i];
      if(next.some(v=>v!=null))base[bp.id]=next;
    }
    syncOf(cx.board).base=base;cx.board.sync.locations=locations;tidySync(cx.board);
  }
  function *planSteps(project,opts={}){
    const scope=opts.scope??"*",direction=opts.direction==="sch"?"sch":"pcb";
    const cx=yield* contextSteps(project,scope,opts.board,opts);
    const r=direction==="sch"?planSCH(cx):planPCB(cx,opts);
    if(opts.reconcile!==false)reconcile(cx,r.changes,direction);
    const ig=new Set(ignoresOf(cx.board).map(ruleKey));
    if(ig.size)for(const c of r.changes)if(ig.has(ruleKey(ruleOf(c)))){c.ignored=true;c.selected=false;}
    const g=c=>GROUPS.indexOf(c.group),rank=c=>RUN_ORDER.indexOf(c.action);
    r.changes.sort((a,b)=>g(a)-g(b)||cmp(a.component??a.object,b.component??b.object)||rank(a)-rank(b)||cmp(a.pin??a.key??"",b.pin??b.key??"")||(a.id<b.id?-1:a.id>b.id?1:0));
    if(opts.select)for(const c of r.changes)c.selected=opts.select.has?opts.select.has(c.id):!!opts.select[c.id];
    return {format:"atrium-eco",version:2,direction,scope:cx.scope,board:cx.board.id,boardName:cx.board.name,
      options:{removeExtras:!!opts.removeExtras,rooms:!!opts.rooms,matchDecisions:opts.matchDecisions||[]},
      matches:cx.matches,review:cx.review,changes:r.changes,clusters:r.clusters,issues:[...cx.issues].sort(cmp)};
  }

  const plan=(project,opts)=>globalThis.AtriumComponentMatch.finish(planSteps(project,{...opts,background:false}));
  const planAsync=(project,opts,active)=>globalThis.AtriumComponentMatch.inSlices(planSteps(project,{...opts,background:true}),active);

  // ------------------------------------------------------------------ execution
  const same=(a,b)=>JSON.stringify(a??null)===JSON.stringify(b??null);
  function expect(ok,message){if(!ok)throw Error(message||"Changed since the comparison. Compare again.");}
  // Lookups are indexed once per run, so executing is linear in the design size.
  function makeEnv(project,board){
    const sch=new Map(),parts=new Map();
    for(const d of project.documents)if(d.kind==="schematic")for(const i of d.items)if(i.kind==="part")sch.set(i.id,i);
    for(const i of board.items)if(i.kind==="part")parts.set(i.id,i);
    return {project,board,sch,parts,lib:new Map(project.library.map(d=>[d.id,d])),removed:new Set(),index:null};
  }
  function boardPart(env,id){return (!env.removed.has(id)&&env.parts.get(id))||fail("The footprint is no longer on the board.");}
  function schParts(env,ids){
    const out=(ids||[]).map(id=>env.sch.get(id));
    expect(out.length&&out.every(Boolean),"A schematic part of this component was removed.");
    return [...new Set(out)];
  }
  function libDef(env,id){return env.lib.get(id)||env.project.library.find(d=>d.id===id);}
  function flush(env){if(env.removed.size){env.board.items=env.board.items.filter(i=>!env.removed.has(i.id));env.removed.clear();}}
  const padNetOf=(env,part,pin)=>own(part.pinNets,pin)?part.pinNets[pin]:((libDef(env,part.def)?.footprint?.pads||[]).find(p=>String(p.number)===pin)?.net||"");
  // net -> [{item}] for copper and [{item,pin}] for pads, built once; entries are re-checked on use.
  function netIndex(env){
    if(env.index)return env.index;
    flush(env);
    const idx=new Map(),put=(n,e)=>{if(!n)return;let l=idx.get(n);if(!l)idx.set(n,l=[]);l.push(e);};
    for(const i of env.board.items){
      if(i.kind==="part"){
        const seen=new Set();
        for(const [k,v] of Object.entries(i.pinNets||{})){put(v,{item:i,pin:k});seen.add(k);}
        for(const p of libDef(env,i.def)?.footprint?.pads||[]){const k=String(p.number);if(!seen.has(k)&&p.net){put(p.net,{item:i,pin:k});seen.add(k);}}
      }else if(typeof i.net==="string")put(i.net,{item:i});
    }
    return env.index=idx;
  }
  function moveNet(env,from,to,pads){
    const idx=netIndex(env),moved=[];
    for(const e of idx.get(from)||[]){
      if(e.pin==null){if(e.item.net===from){e.item.net=to;moved.push(e);}continue;}
      if(pads&&!pads.has(e.item.id+"/"+e.pin))continue;
      if(padNetOf(env,e.item,e.pin)===from){e.item.pinNets={...e.item.pinNets,[e.pin]:to};moved.push(e);}
    }
    if(to){const l=idx.get(to);if(l)l.push(...moved);else idx.set(to,moved);}
    return moved.length;
  }
  // Stored signals, net tags and paths that name a renamed net follow it (signals.js): net classes and pairs
  // are the signal model's, so they follow too.
  function renameInRules(env,from,to){
    const S=globalThis.AtriumSignals,store=env.project?.signals;
    if(S&&store&&typeof store==="object"){const next=JSON.parse(JSON.stringify(store));if(S.renameNet(next,from,to))env.project.signals=next;return;}
    // No store yet: classes and pairs from imported class records that name the net are adopted renamed.
    if(!S||!env.board)return;
    const M=S.model(env.project,env.board),swap=n=>n===from?to:n,nc=M.netClasses(),dp=M.diffPairs();
    if(!Object.values(nc).some(m=>m.includes(from))&&!dp.some(p=>p.positive===from||p.negative===from))return;
    S.applyClasses(env.project,env.board,{netClasses:Object.fromEntries(Object.entries(nc).map(([k,m])=>[k,[...new Set(m.map(swap))]])),diffPairs:dp.map(p=>({...p,positive:swap(p.positive),negative:swap(p.negative)}))});
  }
  // A board's net classes and pairs as the signal model gives them; save() makes them the model's (signals.js).
  function classTarget(env){
    const S=globalThis.AtriumSignals||fail("Signals are not available in this build."),M=S.model(env.project,env.board);
    const set={netClasses:M.netClasses(),diffPairs:M.diffPairs()};
    return {set,save(){S.applyClasses(env.project,env.board,set);}};
  }
  // Write a component link on a schematic part. A part that had none keeps its assembly-variant
  // settings: variants key parts by link, else by ID (variants.js), so the entry is re-keyed.
  function setSchLink(env,g,link){
    const b=baseLink(link);
    if(!b||(g.link||"")===b)return;
    if(!g.link&&Array.isArray(env.project.variants))for(const v of env.project.variants)
      if(v?.parts&&own(v.parts,g.id)&&!own(v.parts,b)){const parts={...v.parts,[b]:v.parts[g.id]};delete parts[g.id];v.parts=parts;}
    g.link=b;
  }
  const PCB={
    link(env,c){
      const bp=boardPart(env,c.targetId),gates=schParts(env,c.sourceIds);
      expect((bp.link||"")===c.before&&gates.every(g=>(g.link||"")===(c.gateLinks?.[g.id]??(g.link||""))||g.link===baseLink(c.after)));
      bp.link=c.after;for(const g of gates)setSchLink(env,g,c.after);
    },
    ref(env,c){const bp=boardPart(env,c.targetId);expect(bp.ref===c.before);bp.ref=c.after;},
    value(env,c){const bp=boardPart(env,c.targetId);expect((bp.value??"")===c.before);bp.value=c.after;},
    footprint(env,c){
      const bp=boardPart(env,c.targetId);let d=libDef(env,c.def);
      expect(bp.def===c.beforeDef);expect(!bp.locked,"The footprint is locked.");expect(d?.footprint,"Footprint "+c.after+" is not in the library.");
      let note="";
      // A bottom-side part takes the mirrored definition of the new footprint (pcb-edit.js).
      if(bp.layer==="Bottom"){
        const E2=globalThis.AtriumPCBEdit;
        if(E2?.counterpart){d=E2.counterpart(env.project,d,null,{inner:E2.innerCount?.(env.board,env.lib)});env.lib.set(d.id,d);note="Mirrored for the bottom side";}
        else note="Placed with the top-side footprint; flip it twice to mirror it.";
      }
      const keep=new Set(d.footprint.pads.map(p=>String(p.number)));
      bp.def=d.id;
      if(bp.pinNets)bp.pinNets=Object.fromEntries(Object.entries(bp.pinNets).filter(([k])=>keep.has(k)));
      return note;
    },
    param(env,c){
      const bp=boardPart(env,c.targetId);
      expect((own(bp.parameters,c.key)?String(bp.parameters[c.key]):null)===c.before);
      bp.parameters={...(bp.parameters||{}),[c.key]:c.after};
    },
    addComponent(env,c){
      expect(!env.parts.has(c.partId),"This component was already added.");
      const d=libDef(env,c.def);expect(d?.footprint,"Footprint "+c.after+" is not in the library.");
      const gates=schParts(env,c.sourceIds),item={id:c.partId,kind:"part",def:c.def,ref:c.object,value:c.value??"",link:c.link,x:c.at[0],y:c.at[1],angle:c.angle||0,pinNets:{}};
      if(c.parameters)item.parameters={...c.parameters};
      env.board.items.push(item);env.parts.set(item.id,item);
      for(const g of gates)setSchLink(env,g,c.link);
      return "Placed at "+c.at.map(v=>+v.toFixed(2)).join(", ")+" mm";
    },
    removeComponent(env,c){
      const bp=boardPart(env,c.targetId);expect(bp.ref===c.before);expect(!bp.locked,"The footprint is locked.");
      env.removed.add(bp.id);env.parts.delete(bp.id);env.index=null;
    },
    renameNet(env,c){
      const pads=Array.isArray(c.pads)?new Set(c.pads.map(([id,pin])=>id+"/"+pin)):null;
      const n=moveNet(env,c.before,c.after,pads);
      expect(n>0,"Net "+c.before+" is no longer on the board.");
      renameInRules(env,c.before,c.after);
      return n+" object"+(n===1?"":"s")+" renamed";
    },
    padNet(env,c){
      const bp=boardPart(env,c.targetId),pads=(libDef(env,bp.def)?.footprint?.pads||[]).filter(p=>String(p.number)===c.pin);
      expect(pads.length,"Pad "+c.pin+" is not on the footprint.");
      expect(padNetOf(env,bp,c.pin)===c.before);
      bp.pinNets={...bp.pinNets,[c.pin]:c.after};
      if(env.index&&c.after){const l=env.index.get(c.after);const e={item:bp,pin:c.pin};if(l)l.push(e);else env.index.set(c.after,[e]);}
    },
    removeNet(env,c){const n=moveNet(env,c.before,"",null);return n?n+" object"+(n===1?"":"s")+" cleared":"";},
    addNet(){return "";},
    netClass(env,c){
      const t=classTarget(env),cur=t.set.netClasses?.[c.object]||[],drop=new Set(c.remove||[]);
      const next=[...new Set([...cur.filter(n=>!drop.has(n)),...(c.add||c.after)])].sort(cmp);
      t.set.netClasses={...(t.set.netClasses||{}),[c.object]:next};t.save();
    },
    diffPair(env,c){
      const t=classTarget(env),list=t.set.diffPairs||[];
      t.set.diffPairs=[...list.filter(p=>p.name!==c.object),{...c.after}];t.save();
    },
    room(env,c){
      const members=c.members.filter(id=>env.parts.has(id));
      expect(members.length,"None of this sheet's footprints was added.");
      flush(env);
      // A plain room already made for this sheet by an earlier ECO takes the new footprints.
      const rooms=Array.isArray(env.board.rooms)?env.board.rooms:[],mine=rooms.filter(r=>r.sheet===c.sheet);
      const plain=mine.find(r=>!r.channel&&Array.isArray(r.members));
      if(plain&&!mine.some(r=>r.channel)){
        plain.members=[...new Set([...plain.members,...members])];
        return members.length+" footprint"+(members.length===1?"":"s")+" added to room "+plain.name;
      }
      // Rooms belong to app/rooms.js (multichannel). Contract: AtriumRooms.ecoRoom(board,{name,sheet,bounds,components,project}).
      const R=globalThis.AtriumRooms,fn=R&&(R.ecoRoom||R.fromECO||R.addRoom);
      expect(typeof fn==="function","Rooms are not available in this build.");
      fn.call(R,env.board,{name:c.object,sheet:c.sheet,bounds:c.bounds,components:members,project:env.project});
      return members.length+" component"+(members.length===1?"":"s");
    }
  };
  const SCH={
    link:PCB.link,
    ref(env,c){const g=schParts(env,c.sourceIds);expect(g.every(p=>p.ref===c.before));for(const p of g)p.ref=c.after;},
    value(env,c){const g=schParts(env,c.sourceIds);expect(g.every(p=>(p.value??"")===c.before));for(const p of g)p.value=c.after;},
    param(env,c){
      const g=schParts(env,c.sourceIds);
      expect((own(g[0].parameters,c.key)?String(g[0].parameters[c.key]):null)===c.before);
      for(const p of g)p.parameters={...(p.parameters||{}),[c.key]:c.after};
    },
    footprint(env,c){
      const g=schParts(env,c.sourceIds);expect(g.every(p=>p.def===c.beforeDef));
      let d=libDef(env,c.def);
      if(!d){
        const base=libDef(env,c.cloneOf),fp=libDef(env,c.boardDef)?.footprint;
        expect(base?.symbol&&fp,"The component or footprint is no longer in the library.");
        d={...JSON.parse(JSON.stringify(base)),id:c.def,name:c.name,footprint:JSON.parse(JSON.stringify(fp)),footprintName:fp.name};
        delete d.mirrorOf;delete d.mirrorSig;env.project.library.push(d);env.lib.set(d.id,d);
      }
      expect(d.symbol,"The new definition has no symbol.");
      for(const p of g)p.def=d.id;
      return c.cloneOf?"New library entry "+c.name:"";
    }
  };
  function run(project,ecoPlan,select){
    if(!ecoPlan||ecoPlan.format!=="atrium-eco"||ecoPlan.version!==2||!Array.isArray(ecoPlan.changes))throw Error("Unsupported Waffle ECO.");
    const board=project.documents.find(d=>d.kind==="pcb"&&d.id===ecoPlan.board)||fail("The board of this ECO is not in the project.");
    const chosen=select==null?new Set(ecoPlan.changes.filter(c=>c.selected).map(c=>c.id)):new Set(select);
    const env=makeEnv(project,board),sch=env.sch,H=ecoPlan.direction==="sch"?SCH:PCB,OTHER=ecoPlan.direction==="sch"?PCB:SCH,status=new Map(),byId=new Map(ecoPlan.changes.map(c=>[c.id,c]));
    const fwd=c=>c.use!=="reverse";
    // Designators after the selected changes must stay unique.
    const dup=new Set();
    if(ecoPlan.direction==="sch"){
      const refs=new Map();
      for(const p of sch.values())refs.set(p.id,up(p.ref));
      for(const c of ecoPlan.changes)if(c.action==="ref"&&chosen.has(c.id)&&fwd(c))for(const id of c.sourceIds||[])refs.set(id,up(c.after));
      const owners=new Map();
      for(const p of sch.values())if(annotated(refs.get(p.id)))groupInto(owners,refs.get(p.id),p);
      for(const c of ecoPlan.changes)if(c.action==="ref"&&chosen.has(c.id)&&fwd(c)){
        const list=owners.get(up(c.after))||[];
        if(list.length>1&&!(libDef(env,list[0].def)?.symbol?.parts>1&&list.every(p=>p.def===list[0].def)&&new Set(list.map(unitOf)).size===list.length))dup.add(c.id);
      }
    }else{
      const refs=new Map(),gone=new Set();
      for(const c of ecoPlan.changes)if(c.action==="removeComponent"&&chosen.has(c.id))gone.add(c.targetId);
      for(const p of env.parts.values())if(!gone.has(p.id))refs.set(p.id,up(p.ref));
      for(const c of ecoPlan.changes)if(chosen.has(c.id)&&fwd(c)){if(c.action==="ref")refs.set(c.targetId,up(c.after));if(c.action==="addComponent")refs.set(c.partId,up(c.object));}
      const count=new Map();for(const r of refs.values())count.set(r,(count.get(r)||0)+1);
      for(const c of ecoPlan.changes)if(chosen.has(c.id)&&fwd(c)&&(c.action==="ref"&&count.get(up(c.after))>1||c.action==="addComponent"&&count.get(up(c.object))>1))dup.add(c.id);
    }
    const rank=a=>RUN_ORDER.indexOf(a);
    for(const c of [...ecoPlan.changes].sort((a,b)=>rank(a.action)-rank(b.action))){
      if(!chosen.has(c.id)){status.set(c.id,{state:"skipped",message:"Not selected"});continue;}
      if(dup.has(c.id)){status.set(c.id,{state:"failed",message:"Would duplicate designator "+(c.action==="ref"?c.after:c.object)+"."});continue;}
      const need=(c.requires||[]).find(r=>status.get(r)?.state!=="done");
      if(need){const n=byId.get(need);status.set(c.id,{state:"skipped",held:true,message:"Needs: "+(n?ACTION_LABEL[n.action]+" "+n.object:"another change")});continue;}
      if(c.requiresAny?.length&&!c.requiresAny.some(r=>status.get(r)?.state==="done")){status.set(c.id,{state:"skipped",held:true,message:"None of its footprints is added"});continue;}
      if(c.via&&status.get(c.via)?.state==="done"){status.set(c.id,{state:"done",message:"Assigned by the net rename"});continue;}
      // A conflict runs only once a side is chosen; "reverse" keeps the other side's value.
      if(c.conflict&&c.use!=="forward"&&c.use!=="reverse"){status.set(c.id,{state:"skipped",held:true,message:"Conflict: choose the schematic or the board value"});continue;}
      const rc=c.use==="reverse"&&c.alt?c.alt:c,h=(rc===c?H:OTHER)[rc.action];
      if(!h){status.set(c.id,{state:"failed",message:"This change does not apply in this direction."});continue;}
      try{const m=h(env,rc)||"";status.set(c.id,{state:"done",message:rc===c?m:(ecoPlan.direction==="sch"?"Board updated":"Schematic updated")+(m?" · "+m:"")});}catch(e){status.set(c.id,{state:"failed",message:e.message});}
    }
    flush(env);
    const rows=ecoPlan.changes.map(c=>({id:c.id,group:c.group,action:c.action,object:c.object,document:c.document,...status.get(c.id)}));
    let applied=0,failed=0,skipped=0,held=0;
    for(const r of rows){if(r.state==="done")applied++;else if(r.state==="failed")failed++;else{skipped++;if(r.held)held++;}}
    return {applied,failed,skipped,held,selected:chosen.size,rows};
  }
  // A copy for the dry run that shares everything the changes never write: board items and
  // schematic parts are shallow copies (handlers replace pinNets, parameters and rules instead
  // of editing them), the library list is copied, variants and rooms are deep copies.
  function dryCopy(project){
    const deep=v=>v==null?v:JSON.parse(JSON.stringify(v));
    return {...project,library:[...project.library],variants:deep(project.variants),
      documents:project.documents.map(d=>d.kind==="pcb"?{...d,items:d.items.map(i=>({...i})),...(d.rooms?{rooms:deep(d.rooms)}:{})}:
        {...d,items:d.items.map(i=>i.kind==="part"?{...i}:i)})};
  }
  // Dry run on a copy: the same checks and order, and the result must still be a valid project.
  function validateChanges(project,ecoPlan,select){
    const copy=dryCopy(project);
    const live=context(project,ecoPlan.scope,ecoPlan.board,{...ecoPlan.options,direction:ecoPlan.direction});
    let error="";
    if(ecoPlan.review?.pending||live.review.pending)error="Review component matches before executing this ECO.";
    else if(ecoPlan.matches){
      const current=new Map(live.matches.map(m=>[m.source,m.target]));
      if(ecoPlan.matches.some(m=>current.get(m.source)!==m.target))error="Component identities changed. Compare again before executing this ECO.";
    }
    if(error){
      const r={valid:false,error,applied:0,failed:0,skipped:ecoPlan.changes.length,held:ecoPlan.changes.length,
        rows:ecoPlan.changes.map(c=>({id:c.id,object:c.object,state:"skipped",held:true,message:error}))};
      Object.defineProperty(r,"result",{value:copy,enumerable:false});return r;
    }
    const r=run(copy,ecoPlan,select);
    try{A.validate(copy);r.valid=!r.failed;}catch(e){r.valid=false;r.error="The result would not be a valid project: "+e.message;}
    Object.defineProperty(r,"result",{value:copy,enumerable:false});  // the project as Execute would leave it (diff preview)
    return r;
  }
  function execute(project,ecoPlan,select){
    const check=validateChanges(project,ecoPlan,select);
    if(check.error)throw Error(check.error);
    if(ecoPlan.review?.sources.length&&check.failed)throw Error(check.rows.find(r=>r.state==="failed")?.message||"Validate the reviewed changes before executing.");
    const r=run(project,ecoPlan,select);
    if(r.applied){rebase(project,ecoPlan.board);recordClusters(project,ecoPlan,r);}
    return r;
  }
  // The clusters new footprints arrived in, kept with the board so the canvas can label them and
  // a group can be dragged by its label (sync-status.js) until its parts are on the board.
  function recordClusters(project,ecoPlan,r){
    const board=project.documents.find(d=>d.id===ecoPlan.board);if(!board||ecoPlan.direction==="sch")return;
    const done=new Set(r.rows.filter(x=>x.state==="done").map(x=>x.id)),byId=new Map(ecoPlan.changes.map(c=>[c.id,c]));
    const live=new Set(board.items.filter(i=>i.kind==="part").map(i=>i.id));
    const kept=(Array.isArray(board.sync?.clusters)?board.sync.clusters:[]).map(c=>({...c,ids:(c.ids||[]).filter(id=>live.has(id))})).filter(c=>c.ids.length);
    for(const cl of ecoPlan.clusters||[]){
      const ids=cl.ids.filter(id=>done.has(id)).map(id=>byId.get(id)?.partId).filter(id=>id&&live.has(id));
      if(ids.length)kept.push({name:cl.name||cl.sheetName||"Sheet",sheet:cl.sheet,ids});
    }
    if(kept.length)syncOf(board).clusters=kept;else if(board.sync){delete board.sync.clusters;tidySync(board);}
  }
  // Routed copper (tracks, arcs, vias) that touches a footprint's pads.
  function padCopper(board,defs,part){
    const fp=defs.get(part.def)?.footprint;if(!fp)return {tracks:0,vias:0};
    const pads=(fp.pads||[]).map(p=>{const at=A.world([p.x,p.y],part),r=Math.max(p.w,p.h)/2+0.05;return [at[0]-r,at[1]-r,at[0]+r,at[1]+r];});
    const on=pt=>pads.some(b=>pt[0]>=b[0]&&pt[0]<=b[2]&&pt[1]>=b[1]&&pt[1]<=b[3]);
    let tracks=0,vias=0;
    for(const i of board.items){
      if(i.kind==="via"){if(on([i.x,i.y]))vias++;}
      else if((i.kind==="track"||i.kind==="arc")&&Array.isArray(i.points)&&i.points.some(on))tracks++;
    }
    return {tracks,vias};
  }
  // Warnings Validate explains before Execute: [{kind, text, why, ids}].
  function warnings(project,ecoPlan,check){
    const out=[],board=project.documents.find(d=>d.id===ecoPlan.board),defs=new Map(project.library.map(d=>[d.id,d])),sel=ecoPlan.changes.filter(c=>c.selected);
    const list=(xs,n=6)=>xs.slice(0,n).join(", ")+(xs.length>n?" and "+(xs.length-n)+" more":"");
    const open=ecoPlan.changes.filter(c=>c.conflict&&c.use!=="forward"&&c.use!=="reverse");
    if(open.length)out.push({kind:"conflict",ids:open.map(c=>c.id),text:open.length+" conflict"+(open.length===1?" needs":"s need")+" a choice: "+list(open.map(c=>c.object)),
      why:"The schematic and the board both changed the same thing since they were last in sync. Choose which value to keep in the row; until then it is skipped."});
    if(board){
      const byId=new Map(board.items.map(i=>[i.id,i])),heavy=[];let n=0;
      for(const c of sel.filter(c=>c.action==="removeComponent")){const part=byId.get(c.targetId);if(!part)continue;const k=padCopper(board,defs,part),t=k.tracks+k.vias;if(t){n+=t;heavy.push(c.object+" ("+t+")");}}
      if(heavy.length)out.push({kind:"copper",ids:sel.filter(c=>c.action==="removeComponent").map(c=>c.id),text:"Removing "+heavy.length+" footprint"+(heavy.length===1?"":"s")+" with routed copper: "+n+" track"+(n===1?"":"s")+" and vias stay behind ("+list(heavy)+").",
        why:"Execute removes the footprint, not its copper. The tracks stay on the board, unconnected, until you delete them. Untick the row to keep the footprint."});
    }
    const nets=sel.filter(c=>c.action==="removeNet"&&c.copper);
    if(nets.length)out.push({kind:"copper",ids:nets.map(c=>c.id),text:nets.length+" removed net"+(nets.length===1?" has":"s have")+" copper: "+list(nets.map(c=>c.object+" ("+c.copper+")")),why:"The copper stays where it is but loses its net name."});
    const rev=sel.filter(c=>c.use==="reverse");
    if(rev.length)out.push({kind:"reverse",ids:rev.map(c=>c.id),text:rev.length+" change"+(rev.length===1?"":"s")+" made on the "+(ecoPlan.direction==="sch"?"schematic":"board")+" will be copied to the "+(ecoPlan.direction==="sch"?"board":"schematic")+": "+list(rev.map(c=>c.object)),
      why:"These were edited on the "+(ecoPlan.direction==="sch"?"schematic":"board")+" since the last sync, so the newer value is kept on both sides instead of being overwritten."});
    const locked=ecoPlan.issues.filter(i=>/locked/.test(i));
    if(locked.length)out.push({kind:"locked",ids:[],text:locked.length+" locked footprint"+(locked.length===1?" is":"s are")+" left unchanged.",why:"Locked parts and their copper are never moved, changed or removed. Unlock them on the board to include them."});
    if(check?.held)out.push({kind:"held",ids:check.rows.filter(r=>r.held).map(r=>r.id),text:check.held+" change"+(check.held===1?"":"s")+" will be skipped because a change "+(check.held===1?"it needs":"they need")+" is not ticked.",
      why:"For example a pad cannot join a net whose footprint is not added. See the Message column; tick the change it names."});
    if(check?.failed)out.push({kind:"failed",ids:check.rows.filter(r=>r.state==="failed").map(r=>r.id),text:check.failed+" change"+(check.failed===1?"":"s")+" cannot be executed.",why:"The Message column says why. The other changes still run."});
    return out;
  }
  // One call for scripts and MCP: compare, then run the default (or given) selection.
  function update(project,opts={}){
    const p=plan(project,opts),select=opts.only?p.changes.filter(c=>opts.only.includes(c.id)||opts.only.includes(c.action)||opts.only.includes(c.group)).map(c=>c.id):null;
    if(opts.dryRun)return {plan:p,report:validateChanges(project,p,select)};
    return {plan:p,report:execute(project,p,select)};
  }
  const show=v=>v==null||v===""?"—":Array.isArray(v)?v.join(", ")||"—":typeof v==="object"?(v.positive+" / "+v.negative):String(v);
  // One plain sentence per change ("R12: footprint 0402 → 0603"); the engineering term is ACTION_LABEL.
  function describe(c){
    const b=show(c.before),a=show(c.after),pin=c.component!=null&&c.pin!=null?c.component+" pin "+c.pin:c.object;
    switch(c.action){
      case "addComponent":return "Add "+c.object+" ("+c.after+(c.value?" · "+c.value:"")+")";
      case "removeComponent":return "Remove "+c.object+" from the board";
      case "link":return "Link "+c.object+" to its "+(c.document||"board")+" footprint";
      case "ref":return "Rename "+b+" → "+a;
      case "value":return c.object+": comment "+b+" → "+a;
      case "footprint":return c.object+": footprint "+b+" → "+a;
      case "param":return c.component+": "+c.key+" "+(c.before==null?"(none)":b)+" → "+a;
      case "padNet":return !c.before?pin+": connect to "+a:!c.after?pin+": disconnect from "+b:pin+": net "+b+" → "+a;
      case "addNet":return "Add net "+c.object+(c.pins?" ("+c.pins+" pin"+(c.pins===1?"":"s")+")":"");
      case "renameNet":return "Rename net "+b+" → "+a;
      case "removeNet":return "Remove net "+c.object+(c.copper?" ("+c.copper+" copper object"+(c.copper===1?"":"s")+" lose the net)":"");
      case "netClass":return "Net class "+c.object+": "+[(c.add||[]).length?"add "+c.add.join(", "):"",(c.remove||[]).length?"remove "+c.remove.join(", "):""].filter(Boolean).join("; ");
      case "diffPair":return "Differential pair "+c.object+": "+a;
      case "room":return "Add room "+c.object+" around "+(c.members?.length||0)+" part"+(c.members?.length===1?"":"s");
      default:return ACTION_LABEL[c.action]+" "+c.object+(c.before!=null||c.after!=null?": "+b+" → "+a:"");
    }
  }
  function reportText(ecoPlan,result){
    const st=new Map((result?.rows||[]).map(r=>[r.id,r])),lines=[];
    lines.push("Waffle engineering change order — "+(ecoPlan.direction==="sch"?"Update schematics from "+ecoPlan.boardName:"Update "+ecoPlan.boardName),"");
    for(const g of GROUPS){
      const list=ecoPlan.changes.filter(c=>c.group===g);if(!list.length)continue;
      lines.push(g+" ("+list.length+")");
      for(const c of list){const r=st.get(c.id);lines.push("  ["+(c.selected?"x":" ")+"] "+describe(c)+(r?"  — "+r.state+(r.message?": "+r.message:""):""));}
      lines.push("");
    }
    if(ecoPlan.issues.length){lines.push("Notes ("+ecoPlan.issues.length+")",...ecoPlan.issues.map(i=>"  "+i),"");}
    if(result)lines.push("Done "+result.applied+", failed "+result.failed+", skipped "+result.skipped);
    return lines.join("\n")+"\n";
  }
  // Re-match an exported ECO (version 2, or the version 1 grid) against the current design.
  // Returns a fresh plan with the file's changes selected, and the stale ones that no longer match.
  function reopen(project,file){
    if(file?.format==="atrium-eco"&&file.version===1){
      const r=resolve(project,file),fresh=plan(project,{board:file.board,scope:file.scope});
      const ids=new Set(r.valid.map(v=>v.field==="net"?changeId("padNet",v.targetId,v.pin):changeId(v.field,v.targetId)));
      for(const c of fresh.changes)c.selected=ids.has(c.id);
      return {plan:fresh,stale:r.stale.length};
    }
    if(!file||file.format!=="atrium-eco"||file.version!==2||!Array.isArray(file.changes)||typeof file.board!=="string")throw Error("Unsupported Waffle ECO file.");
    const fresh=plan(project,{board:file.board,scope:typeof file.scope==="string"?file.scope:"*",direction:file.direction,...(file.options||{})});
    const live=new Map(fresh.changes.map(c=>[c.id,c]));let stale=0;
    for(const c of fresh.changes)c.selected=false;
    for(const c of file.changes){
      const v=c&&live.get(c.id);
      if(!v||!same(v.before,c.before)||!same(v.after,c.after)){stale++;continue;}
      if(v.action==="addComponent"&&c.partId&&c.partId!==v.partId){
        const was=v.partId;v.partId=String(c.partId);
        for(const x of fresh.changes){if(x.targetId===was)x.targetId=v.partId;if(x.members)x.members=x.members.map(m=>m===was?v.partId:m);}
      }
      if(v.action==="addComponent"){v.link=String(c.link||v.link);if(Array.isArray(c.at)&&c.at.length===2&&c.at.every(Number.isFinite))v.at=[...c.at];}
      v.selected=c.selected!==false;
    }
    return {plan:fresh,stale};
  }

  // ------------------------------------------------------------------ dialog
  const remembered=new Map();  // unticked change IDs per board (a unique ID) and direction
  const memoKey=(b,dir)=>b+"\u0000"+dir;
  function loadMemo(k){
    if(remembered.has(k))return remembered.get(k);
    let s=new Set();try{s=new Set(JSON.parse(localStorage.getItem("atrium-eco-unticked:"+k)||"[]"));}catch{}
    remembered.set(k,s);return s;
  }
  function saveMemo(k,s){remembered.set(k,s);try{localStorage.setItem("atrium-eco-unticked:"+k,JSON.stringify([...s].slice(-2000)));}catch{}}
  // Dialog defaults remembered per user: "rooms" (a room per sheet), "arrange" (pack new parts inside the board).
  const pref=(k,d)=>{try{const v=localStorage.getItem("atrium.eco."+k);return v==null?d:v==="1";}catch{return d;}};
  const setPref=(k,v)=>{try{localStorage.setItem("atrium.eco."+k,v?"1":"0");}catch{}};
  // "schematic.afterUpdatePcb": "show" (switch to the board and fit it) or "stay".
  function afterUpdate(){
    const k="schematic.afterUpdatePcb",P=globalThis.AtriumPrefs;
    try{return P?.get?P.get(k):globalThis.AtriumPref?.get?.(k,"show")??"show";}catch{return "show";}
  }
  function showBoard(boardId,msg){
    const H=globalThis.AtriumNavHost;if(!H?.selectDocument)return;
    for(const d of document.querySelectorAll("dialog.eco-dialog[open]"))d.close();
    setTimeout(()=>{try{
      if(H.currentId?.()!==boardId)H.selectDocument(boardId);
      H.act?.("fit-document");
      H.info?.(msg+" · showing "+(H.doc?.()?.name||"the board")+". Undo reverts the whole update.");
    }catch{}},0);
  }
  // The change list is grouped by what changes, in plain words; the ECO groups (files, MCP,
  // reports) stay as they are. Extension groups (pin and gate swaps) keep their own heading.
  /** @type {Array<[string,string,string[]]>} */
  const KINDS=[["add","Add parts",["addComponent"]],["remove","Remove parts",["removeComponent"]],["footprint","Change footprint",["footprint"]],
    ["component","Designators and comments",["ref","value"]],["param","Parameters",["param"]],["nets","Change nets",["padNet","addNet","removeNet"]],
    ["rename","Rename nets",["renameNet"]],["classes","Classes",["netClass"]],["rules","Rules",["diffPair"]],["rooms","Rooms",["room"]],["link","Links",["link"]]];
  const KIND_OF=new Map(KINDS.flatMap(([k,,acts])=>acts.map(a=>[a,k])));
  const kindOf=c=>KIND_OF.get(c.action)||"x:"+c.group;
  const kindName=k=>KINDS.find(x=>x[0]===k)?.[1]||k.slice(2);
  const HELP={add:"Footprints the board does not have yet. They arrive grouped by schematic sheet beside the board.",remove:"Footprints with no schematic part. Locked footprints are never removed.",
    footprint:"The footprint (land pattern) differs between the schematic and the board.",component:"Designator (the name, such as R12) or comment (the value, such as 10k).",
    param:"Component parameters such as Tolerance or MPN.",nets:"Which net each pad is on.",rename:"A net with a new name; its copper follows.",classes:"Net classes from schematic directives.",
    rules:"Differential pairs from schematic directives.",rooms:"A room (placement area) per sheet.",link:"The hidden link that ties a symbol to its footprint."};
  const ORIGIN={schematic:"Changed on the schematic",board:"Changed on the board",both:"Conflict"};
  // A row as the user reads it: the sentence for what Execute will do.
  function sentence(c){
    if(c.conflict&&c.use==="reverse"&&c.alt)return describe(c.alt);
    if(c.use==="reverse"&&c.alt)return describe(c.alt);
    return describe(c);
  }
  const hostCtx=H=>({currentProject:()=>H.project(),project:H.project(),doc:H.doc(),edit:H.edit,info:H.info,
    pickFile:accept=>globalThis.AtriumIO?.pickFile?.(accept),exportFile:(name,text)=>globalThis.AtriumIO?.exportFile?.(name,text)});
  function itemBox(item,def,kind){
    const g=A.geometries(def,kind);if(!g)return null;
    const pts=A.symbolPoints(g).map(p=>A.world(p,item));
    return A.bounds(pts.length?pts:[[item.x,item.y]]);
  }
  function open(ctx,o={}){
    const proj=()=>ctx.currentProject?.()||ctx.project;
    const project=proj(),sheets=project.documents.filter(d=>d.kind==="schematic"),boards=project.documents.filter(d=>d.kind==="pcb");
    if(!sheets.length||!boards.length){ctx.info("Add a schematic and a board to compare.");return;}
    const H=globalThis.AtriumNavHost;
    const node=(tag,text,cls)=>AtriumNavCommon.el(tag, text, cls);
    const button=(label,act,title,cls)=>{const b=node("button",label,cls);b.type="button";b.onclick=act;if(title)b.title=title;if(cls==="eco-pick"){b.classList.add("ui-button");b.dataset.size="sm";}return b;};
    const check=(label,value,title)=>{const l=node("label",null,"eco-opt"),c=node("input");c.type="checkbox";c.checked=value;l.append(c,node("span",label));if(title)l.title=title;return [l,c];};
    const dialog=node("dialog",null,"work-dialog eco-dialog");dialog.setAttribute("aria-label","Engineering change order");
    let direction=o.reverse||o.direction==="sch"?"sch":"pcb";
    // Altium updates from the whole project; a single sheet stays one choice away.
    let scope="*",boardId=ctx.doc?.kind==="pcb"?ctx.doc.id:(globalThis.Atrium?.preferredDocument?.(project,"pcb",ctx.doc?.id)?.id||boards[0].id);
    let current=null,result=null,checked=null,executed=false,filter="all",query="",focus=null,warned=null,diff=null,settings=!!o.settings;
    const startDoc=H?.currentId?.(),startSel=H?.selection?.()||[];
    const collapsed=new Set();
    let matchDecisions=[],planToken=0,closed=false,matchPage=0,planScope="";
    const head=node("div",null,"eco-head"),title=node("h2"),sub=node("span",null,"eco-sub");
    const gear=button("Sync Settings",()=>{settings=!settings;render();},"Never-sync rules, defaults for new parts and the sync history","eco-gear");
    head.append(title,sub,gear);
    // Plain words for the Altium term: an ECO is the list of changes below.
    const explain=node("p","Engineering Change Order (ECO): the list of differences between the schematic and the board. Tick what to apply; Validate checks it; Execute applies it as one undo step.","eco-explain");
    const dir=node("select");dir.setAttribute("aria-label","Direction");
    dir.add(new Option("Update PCB from schematics","pcb"));dir.add(new Option("Update schematics from PCB","sch"));dir.value=direction;
    const source=node("select"),target=node("select");source.setAttribute("aria-label","Schematics");target.setAttribute("aria-label","Board");
    source.add(new Option("All schematics","*"));for(const s of sheets)source.add(new Option(s.name,s.id));
    for(const b of boards)target.add(new Option(b.name,b.id));
    source.value=scope;target.value=boardId;
    const [removeLabel,removeBox]=check("Remove footprints without schematic parts",false,"Lists unlinked board footprints as Remove changes, ticked. Locked footprints are never removed.");
    const roomsAvailable=!!globalThis.AtriumRooms;
    const [roomsLabel,roomsBox]=check("Create a room per sheet",roomsAvailable&&pref("rooms",false),roomsAvailable?"Adds a room (placement area) around each sheet's new footprints, as Altium does.":"Rooms need the multichannel module.");
    roomsBox.disabled=!roomsAvailable;
    // After Execute, pack the added footprints inside the outline (arrange.js, Tools › Component Placement).
    const [arrangeLabel,arrangeBox]=check("Arrange new parts inside the board",pref("arrange",false),"After Execute, packs the added footprints inside the board outline (Tools › Component Placement › Arrange Within Board), in the same undo step. Off: they wait beside the board, grouped by sheet.");
    if(!globalThis.AtriumArrange&&globalThis.AtriumLazy?.need)AtriumLazy.need("AtriumArrange").catch(()=>{});
    const bar=node("div",null,"eco-bar");
    const route=node("span",null,"eco-route");route.append(source,node("span","→","eco-arrow"),target);
    bar.append(dir,route);
    const opts=node("div",null,"eco-opts");opts.append(removeLabel,roomsLabel,arrangeLabel);
    // Search and filters.
    const tools=node("div",null,"eco-tools"),search=node("input");search.type="search";search.placeholder="Search changes (R12, GND, footprint…)";search.setAttribute("aria-label","Search changes");
    const chips=node("div",null,"eco-chips");chips.setAttribute("role","group");chips.setAttribute("aria-label","Show");
    tools.append(AtriumUI.searchField(search),chips);
    const body=node("div",null,"eco-body");
    const wrap=node("div",null,"eco-table-wrap"),table=node("table",null,"eco-table"),thead=node("thead"),tbody=node("tbody");
    const all=node("input");all.type="checkbox";all.setAttribute("aria-label","Include all changes");
    const hr=node("tr"),th0=node("th",null,"eco-enable");th0.append(all);hr.append(th0);
    for(const [t,c] of [["Change","eco-what"],["Where","eco-doc"],["Check","eco-state"],["Done","eco-state"],["Message","eco-msg"],["",""]])hr.append(node("th",t,c));
    thead.append(hr);table.append(thead,tbody);wrap.append(table);
    const matchBox=node("details",null,"eco-matches"),matchSummary=node("summary"),matchBody=node("div");
    matchBox.append(matchSummary,matchBody);
    const detail=node("aside",null,"eco-detail");detail.setAttribute("aria-live","polite");
    const page=node("div",null,"eco-settings");
    body.append(wrap,page);
    const warnBox=node("div",null,"eco-warn"),reportBox=node("div",null,"eco-report"),diffBox=node("details",null,"eco-diff");diffBox.hidden=true;
    const notes=node("details",null,"eco-notes"),notesSum=node("summary"),notesList=node("ul");notes.append(notesSum,notesList);
    const status=node("div",null,"eco-status ui-dialog-status");status.setAttribute("role","status");
    const say=t=>{status.textContent=t;};
    const footer=node("div",null,"work-actions eco-actions");
    const openFile=button("Open ECO…",async()=>{
      try{
        const f=await ctx.pickFile([".waffle-eco"]);if(!f)return;
        const r=reopen(proj(),JSON.parse(await f.text()));
        direction=r.plan.direction;scope=r.plan.scope;boardId=r.plan.board;dir.value=direction;source.value=scope;target.value=boardId;
        planToken++;current=r.plan;matchDecisions=current.options.matchDecisions||[];planScope=JSON.stringify([scope,boardId,direction]);
        if(current.review?.pending)matchBox.open=true;
        result=checked=diff=warned=null;executed=false;render();
        say("Opened "+f.name+(r.stale?". "+r.stale+" outdated change"+(r.stale===1?" was":"s were")+" left out.":". Review and validate the changes."));
      }catch(e){say(e.message);}
    });
    const exportFile=button("Export ECO…",async()=>{
      try{const p={...current,changes:current.changes.filter(c=>c.selected).map(({alt,...c})=>c)};
        const ok=await ctx.exportFile(proj().name.replace(/[\\/:*?"<>|]/g,"-")+".waffle-eco",serialize(p));if(ok)say("Selected changes exported.");}catch(e){say(e.message);}
    });
    const report=button("Report Changes…",async()=>{
      try{const ok=await ctx.exportFile(proj().name.replace(/[\\/:*?"<>|]/g,"-")+"-ECO-report.txt",reportText(current,result||checked));if(ok)say("Report saved.");}catch(e){say(e.message);}
    });
    const board=()=>proj().documents.find(d=>d.id===boardId);
    // ---- the diff engine's preview of the result (AtriumDiff, lazy)
    let diffToken=0;
    function previewResult(copy){
      const token=++diffToken;diff=null;diffBox.hidden=true;
      const run=D=>{
        const opts={geometry:true,validate:false,worker:false};
        const p=D.compareAsync?D.compareAsync(proj(),copy,opts,()=>token===diffToken&&dialog.open):Promise.resolve(D.compare(proj(),copy,opts));
        return p.then(r=>{if(!r||token!==diffToken)return;diff=r;renderDiff();});
      };
      const D=globalThis.AtriumDiff;
      (D?run(D):globalThis.AtriumLazy?.need?.("AtriumDiff").then(run))?.catch?.(()=>{});
    }
    function renderDiff(){
      diffBox.replaceChildren();diffBox.hidden=!diff;if(!diff)return;
      const s=diff.summary,sum=node("summary",(executed?"What changed: ":"What Execute will change: ")+(s.identical?"nothing":s.text));
      const ul=node("ul");for(const t of (s.headline||[]).slice(0,10))ul.append(node("li",t));
      diffBox.append(sum,ul);
    }
    // ---- linked preview on the target canvas
    let ghosts=null,offRender=null,shownDoc=null;
    function paintGhosts(ctx2,info){
      if(!ghosts||H?.currentId?.()!==ghosts.doc)return;
      const px=1/info.scale,css=k=>{try{return getComputedStyle(document.documentElement).getPropertyValue(k).trim();}catch{return "";}};
      ctx2.save();ctx2.lineWidth=1.5*px;ctx2.setLineDash([4*px,3*px]);ctx2.strokeStyle=css("--accent")||"#2f81f7";ctx2.fillStyle=ctx2.strokeStyle;
      for(const b of ghosts.boxes){ctx2.globalAlpha=.12;ctx2.fillRect(b[0],b[1],b[2]-b[0],b[3]-b[1]);ctx2.globalAlpha=1;ctx2.strokeRect(b[0],b[1],b[2]-b[0],b[3]-b[1]);}
      ctx2.restore();
    }
    function clearPreview(){ghosts=null;H?.clearHighlight?.();H?.redraw?.();}
    function previewRow(c){
      if(!H?.selectDocument||!c)return;
      const p=proj(),defs=new Map(p.library.map(d=>[d.id,d])),toBoard=direction==="pcb"?c.use!=="reverse":c.use==="reverse";
      const sheetIds=new Set(c.sourceIds||[]);
      const doc=toBoard?board():(p.documents.find(d=>d.id===c.sheet)||p.documents.find(d=>d.kind==="schematic"&&d.items.some(i=>sheetIds.has(i.id))));
      if(!doc){say("This change has nothing to show on a canvas.");return;}
      if(H.currentId()!==doc.id){H.selectDocument(doc.id);shownDoc=doc.id;}
      const ids=new Set(),boxes=[],ghost=[];
      if(toBoard){for(const id of [c.targetId,...(c.members||[])])if(id)ids.add(id);}
      else for(const id of sheetIds)ids.add(id);
      if(c.action==="addComponent"||c.action==="room"){
        const adds=c.action==="room"?current.changes.filter(x=>x.action==="addComponent"&&c.members?.includes(x.partId)):[c];
        for(const a of adds){const d=defs.get(a.def),b=d&&footprintBox(d.footprint);if(b)ghost.push([b[0]+a.at[0],b[1]+a.at[1],b[2]+a.at[0],b[3]+a.at[1]]);}
        boxes.push(...ghost);
      }
      const items=doc.items.filter(i=>ids.has(i.id));
      for(const i of items){const b=itemBox(i,defs.get(i.def),doc.kind);if(b)boxes.push(b);}
      // The diff engine's geometry for the same object, when the preview has it.
      for(const id of ids)for(const k of diff?.byObject?.[id]||[]){const g=diff.changes[k]?.geometry;if(g?.box&&g.doc===doc.id)boxes.push(g.box);}
      H.select(items.map(i=>i.id),items[0]?.id||null);
      const net=c.action==="padNet"||c.action==="renameNet"||c.action==="removeNet"?(toBoard?(c.before||c.after):(c.after||c.before)):c.action==="addNet"?c.object:"";
      if(net&&doc.kind==="pcb")H.setHighlight?.(net);else H.clearHighlight?.();
      if(!offRender&&H.addRenderer)offRender=H.addRenderer(d=>ghosts&&d?.id===ghosts.doc?{overlay:paintGhosts}:null);
      ghosts={doc:doc.id,boxes:ghost};
      const all2=A.bounds(boxes.flatMap(b=>[[b[0],b[1]],[b[2],b[3]]]));
      if(all2){
        // Fit the box into the part of the canvas the docked dialog leaves visible (its left side).
        const m=Math.max(3,(all2[2]-all2[0])*.4,(all2[3]-all2[1])*.4),z=[all2[0]-m,all2[1]-m,all2[2]+m,all2[3]+m];
        const cr=H.canvas?.()?.getBoundingClientRect?.(),dr=dialog.getBoundingClientRect();
        const f=cr?.width?Math.max(.2,Math.min(1,(dr.left-cr.left-16)/cr.width)):1;
        if(f<.9){const w=Math.max(z[2]-z[0],(z[3]-z[1])*(cr.width*f)/Math.max(1,cr.height));z[0]=(z[0]+z[2])/2-w/2;z[2]=z[0]+w/f;}
        H.zoomTo?.(z);
      }
      H.redraw?.();
      say(items.length||boxes.length?"Shown on "+doc.name+(net&&doc.kind==="pcb"?" · net "+net+" highlighted":"")+".":"Nothing to show yet on "+doc.name+".");
    }
    // ---- validate and execute
    function runValidate(){
      checked=validateChanges(proj(),current);
      warned=warnings(proj(),current,checked);
      previewResult(checked.result);
      return checked;
    }
    const validate=button("Validate Changes",()=>{
      try{runValidate();render();
        say(checked.error||(warned.length?warned.length+" thing"+(warned.length===1?"":"s")+" to know before Execute (above).":"All "+checked.applied+" ticked changes can be executed."));
      }catch(e){say(e.message);}
    });
    let confirmArmed=false;
    const run2=button("Execute Changes",()=>{
      try{
        if(!current||current.review?.pending||!current.changes.some(c=>c.selected))return;
        // Validate first; warnings are shown and explained, and a second click executes.
        if(!checked||!warned){runValidate();if(checked.error){render();say(checked.error);return;}}
        if(warned.length&&!confirmArmed){confirmArmed=true;render();say("Read the notes above, then Execute again to apply.");run2.focus();return;}
        let r=null;const p=current;
        let arranged=null;
        ctx.edit(()=>{const had=new Set((proj().documents.find(d=>d.id===p.board)?.items||[]).map(i=>i.id));r=execute(proj(),p);
          const bd=proj().documents.find(d=>d.id===p.board),AR=globalThis.AtriumArrange;
          if(arrangeBox.checked&&!arrangeLabel.hidden&&AR&&bd?.outline?.length>=3){const ids=bd.items.filter(i=>i.kind==="part"&&!had.has(i.id)).map(i=>i.id);if(ids.length)try{arranged=AR.arrange(bd,null,{project:proj(),ids,region:"board"});}catch{}}});
        result=r;checked=r;executed=true;confirmArmed=false;clearPreview();render();renderDiff();
        const msg=r.applied+" change"+(r.applied===1?"":"s")+" executed"+(r.failed?", "+r.failed+" failed":"")+(arranged?.moved?" · "+arranged.moved+" arranged inside the board"+(arranged.failed.length?" ("+arranged.failed.length+" did not fit)":""):"");
        say(msg+". Undo reverts the whole ECO.");ctx.info(msg);
        const added=p.changes.filter(c=>c.action==="addComponent"&&r.rows.find(x=>x.id===c.id)?.state==="done").length;
        // First import (or many new parts): the grouping hint, once the board is showing.
        if(p.direction!=="sch"&&added&&!arranged?.moved)setTimeout(()=>globalThis.AtriumLazy?.need?.("AtriumSyncStatus").then(S=>S.hint?.({board:p.board,added,clusters:p.clusters?.length||0}),()=>{}),60);
        // Preferences › Schematic: after Update PCB, show the board fitted to the parts (default) or stay here.
        if(p.direction!=="sch"&&r.applied&&afterUpdate()!=="stay")showBoard(p.board,msg);
      }catch(e){say(e.message);}
    });
    footer.append(status,openFile,exportFile,report,button("Close",()=>dialog.close()),validate,run2);
    validate.title="Check every ticked change without applying anything, and explain what to know first";run2.title="Apply the ticked changes (one undo step)";
    openFile.title="Open a saved change list (.waffle-eco)";exportFile.title="Save the ticked changes as a change list (.waffle-eco)";
    dialog.append(head,explain,bar,opts,matchBox,tools,body,detail,warnBox,diffBox,reportBox,notes,footer);
    const memo=()=>loadMemo(memoKey(boardId,direction)),saveMemoNow=()=>saveMemo(memoKey(boardId,direction),memo());
    async function compare(){
      scope=source.value;boardId=target.value;direction=dir.value;
      const key=JSON.stringify([scope,boardId,direction]),token=++planToken;
      if(key!==planScope){matchDecisions=[];matchPage=0;planScope=key;}
      const active=()=>token===planToken&&!closed;
      current=null;result=checked=diff=warned=null;confirmArmed=false;syncTotals();
      say("Comparing components…");
      shown.clear();
      try{
        const next=await planAsync(proj(),{board:boardId,scope,direction,removeExtras:removeBox.checked,rooms:roomsBox.checked,matchDecisions},active);
        if(!active()||!next)return;
        current=next;if(current.review.pending)matchBox.open=true;
        const off=memo();for(const c of current.changes)if(off.has(c.id)&&!c.conflict)c.selected=false;
        result=checked=diff=warned=null;executed=false;confirmArmed=false;focus=null;say("");
      }catch(e){if(!active())return;current=null;say(e.message);}
      render();
    }
    function toggle(c,on){c.selected=on;const off=memo();if(on)off.delete(c.id);else off.add(c.id);}
    const PAGE=200,shown=new Map();
    let ui={groups:new Map(),rows:new Map()};
    function invalidate(){if((checked||warned)&&!executed){checked=warned=diff=null;confirmArmed=false;render();return true;}return false;}
    function syncGroup(g){
      const u=ui.groups.get(g);if(!u)return;
      const on=u.list.filter(c=>c.selected).length;
      u.box.checked=on===u.list.length&&on>0;u.box.indeterminate=on>0&&on<u.list.length;u.count.textContent=on+" of "+u.list.length;
    }
    function syncTotals(){
      const changes=(current?.changes||[]).filter(c=>!c.ignored),on=changes.filter(c=>c.selected).length;
      all.checked=on===changes.length&&on>0;all.indeterminate=on>0&&on<changes.length;all.disabled=executed||!changes.length;
      run2.disabled=executed||!on||!!current?.review?.pending;validate.disabled=run2.disabled;exportFile.disabled=!on;report.disabled=!current;
      run2.textContent=executed?"Executed":confirmArmed?"Execute anyway":on?"Execute "+on+" Change"+(on===1?"":"s"):"Execute Changes";
      run2.classList.toggle("is-armed",confirmArmed);
    }
    function syncRow(c){const r=ui.rows.get(c.id);if(r){r.box.checked=!!c.selected;r.tr.classList.toggle("is-off",!c.selected);}}
    function setMany(list,on){
      for(const c of list){if(c.conflict&&on&&c.use!=="forward"&&c.use!=="reverse")continue;toggle(c,on);}
      saveMemoNow();
      if(invalidate())return;
      for(const c of list)syncRow(c);
      for(const g of new Set(list.map(kindOf)))syncGroup(g);
      syncTotals();
    }
    const counts=()=>{
      const ch=current?.changes||[],st=new Map((result||checked)?.rows?.map(r=>[r.id,r])||[]);
      return {all:ch.filter(c=>!c.ignored).length,conflicts:ch.filter(c=>c.conflict).length,board:ch.filter(c=>c.origin==="board"||c.origin==="schematic").length,
        off:ch.filter(c=>!c.selected&&!c.ignored).length,ignored:ch.filter(c=>c.ignored).length,problems:ch.filter(c=>{const r=st.get(c.id);return r&&(r.state==="failed"||r.held);}).length};
    };
    function visible(c,st){
      if(filter==="all"&&c.ignored)return false;
      if(filter==="conflicts"&&!c.conflict)return false;
      if(filter==="board"&&!(c.origin==="board"||c.origin==="schematic"))return false;
      if(filter==="off"&&(c.selected||c.ignored))return false;
      if(filter==="ignored"&&!c.ignored)return false;
      if(filter==="problems"){const r=st.get(c.id);if(!r||!(r.state==="failed"||r.held))return false;}
      if(query){const q=query.toLowerCase(),hay=(sentence(c)+" "+(c.component||"")+" "+(c.object||"")+" "+(ACTION_LABEL[c.action]||"")+" "+kindName(kindOf(c))).toLowerCase();if(!q.split(/\s+/).every(w=>hay.includes(w)))return false;}
      return true;
    }
    function renderChips(){
      const n=counts();chips.replaceChildren();
      for(const [k,label] of [["all","All"],["conflicts","Conflicts"],["board","Changed since last sync"],["off","Excluded"],["ignored","Never sync"],["problems","Problems"]]){
        if(k!=="all"&&!n[k]&&filter!==k)continue;
        const b=button(label+" "+n[k],()=>{filter=k;render();},null,"ui-chip eco-chip");b.setAttribute("aria-pressed",String(filter===k));chips.append(b);
      }
    }
    function choice(c,td){
      const box=node("span",null,"eco-choice");box.setAttribute("role","radiogroup");box.setAttribute("aria-label","Keep which value for "+c.object);
      const pcbDir=direction==="pcb";
      const opts=[[pcbDir?"forward":"reverse","Schematic: "+show(c.conflict.schematic)],[pcbDir?"reverse":"forward","Board: "+show(c.conflict.board)]];
      for(const [use,label] of opts){
        const b=button(label,e=>{e.stopPropagation();c.use=use;c.selected=true;if(!invalidate())render();},"Keep this value on both sides","eco-pick");
        b.setAttribute("role","radio");b.setAttribute("aria-checked",String(c.use===use));
        if(use==="reverse"&&!c.alt){b.disabled=true;b.title="This value cannot be copied to the other side.";}
        box.append(b);
      }
      td.append(box);
    }
    function renderDetail(){
      detail.replaceChildren();const c=focus&&current?.changes.find(x=>x.id===focus);detail.hidden=!c||settings;
      if(!c)return;
      const k=kindOf(c);
      const term=ACTION_LABEL[c.action]||c.action;
      detail.append(node("strong",sentence(c)),node("span"," · "+term+(kindName(k)!==term?" · "+kindName(k):""),"eco-term"));
      const why=[];
      if(HELP[k])why.push(HELP[k]);
      if(c.conflict)why.push("Both sides changed since the last sync (it was "+show(c.conflict.base)+"). Pick the value to keep; the other side is updated to match.");
      else if(c.use==="reverse")why.push("This was changed on the "+(direction==="pcb"?"board":"schematic")+" since the last sync, so the newer value is copied back instead of being overwritten. Untick to leave both sides as they are.");
      else if(c.origin)why.push(ORIGIN[c.origin]+" since the last sync.");
      if(c.ignored)why.push("You chose never to sync this. Sync Settings lists it; Sync Again brings it back.");
      detail.append(node("p",why.join(" "),"eco-why"));
    }
    function renderSettings(){
      page.replaceChildren();
      const b=board(),rules=ignoresOf(b);
      const sec=(t,help)=>{const s=node("section",null,"eco-set");s.append(node("h3",t));if(help)s.append(node("p",help,"eco-set-help"));page.append(s);return s;};
      const s1=sec("Never sync","Changes you chose to keep different on the schematic and the board. They are left out of every update until you sync them again.");
      if(!rules.length)s1.append(node("p","No rules. Use “Never sync” on a change to add one.","eco-set-empty"));
      else{const ul=node("ul",null,"eco-rules");for(const r of rules){const li=node("li");li.append(node("span",r.label||(r.object+" · "+(ACTION_LABEL[r.action]||r.action))),
        button("Sync Again",()=>{ctx.edit(()=>syncAgain(board(),r));compare();say("“"+(r.label||r.object)+"” is synced again.");},"Remove this rule"));ul.append(li);}s1.append(ul);}
      const s2=sec("New parts","How footprints arrive on the board the first time.");
      const [rl,rb]=check("Create a room per sheet",roomsBox.checked);rb.disabled=!roomsAvailable;rb.onchange=()=>{roomsBox.checked=rb.checked;setPref("rooms",rb.checked);compare();};
      const [al,ab]=check("Arrange new parts inside the board",arrangeBox.checked);ab.onchange=()=>{arrangeBox.checked=ab.checked;setPref("arrange",ab.checked);};
      const hint=button("Show the Grouping Hint Again",()=>{try{localStorage.removeItem("atrium.hint.ecoClusters");}catch{}say("The hint shows after the next update that adds parts.");});
      s2.append(rl,al,hint);
      const base=baseOf(b),n=base?Object.keys(base).length:0;
      const s3=sec("Sync history",n?"Waffle remembers the last values both sides agreed on for "+n+" part"+(n===1?"":"s")+". It uses them to tell schematic edits from board edits and to spot conflicts.":"Nothing yet. After the first Execute, Waffle remembers the values both sides agreed on, to tell schematic edits from board edits.");
      if(n)s3.append(button("Forget Sync History",()=>{ctx.edit(()=>forgetBase(board()));compare();say("Sync history cleared. Differences now follow the update direction.");},"Differences no longer show which side changed"));
      page.append(button("Back to Changes",()=>{settings=false;render();},null,"eco-back"));
    }
    function chooseMatch(source,target,action){
      try{matchDecisions=decide(current,source,target,action);compare();}catch(e){say(e.message);}
    }
    function renderMatches(){
      const r=current?.review,ms=current?.matches||[],required=r?.pending||0;
      matchBox.hidden=settings||!(ms.length||r?.sources.length);
      matchSummary.textContent=required?"Review component matches · "+required+" decision"+(required===1?"":"s")+" needed":"Component matches ("+ms.length+")";
      matchBody.replaceChildren();if(matchBox.hidden||!matchBox.open)return;
      const targets=new Map(r.targets.map(x=>[x.target,x])),reviewed=new Set(r.sources.map(x=>x.source));
      const records=[...r.sources.map(row=>({source:row})),...r.targets.filter(t=>!t.assigned&&!t.waiting).map(row=>({target:row})),
        ...ms.filter(m=>!reviewed.has(m.source)).map(row=>({pair:row}))];
      const size=50;matchPage=Math.max(0,Math.min(matchPage,Math.ceil(records.length/size)-1));
      const t=node("table",null,"eco-table"),thead=node("thead"),head=node("tr"),tb=node("tbody");
      for(const h of ["Schematic component","Board footprint","Match evidence","Decision"])head.append(node("th",h));
      thead.append(head);t.append(thead,tb);
      function duplicates(refs) {
        const seen=new Set(), repeated=new Set();
        for(const value of refs){const ref=up(value);if(seen.has(ref))repeated.add(ref);seen.add(ref);}
        return repeated;
      }
      const sameSource=duplicates([...r.sources.map(s=>s.ref), ...ms.filter(m=>!reviewed.has(m.source)).map(m=>m.sourceRef)]);
      const sameTarget=duplicates([...r.targets.map(t=>t.ref), ...ms.filter(m=>!targets.has(m.target)).map(m=>m.targetRef)]);
      const at=point=>point?" ("+point.map(n=>+n.toFixed(2)).join(", ")+" mm)":"";
      const coordinates=(row,repeated)=>repeated.has(up(row.ref))?at(row.at):"";
      const name=t=>[t.ref,t.value,t.footprint].filter(Boolean).join(" · ")+coordinates(t,sameTarget);
      for(const entry of records.slice(matchPage*size,(matchPage+1)*size)){
        const tr=node("tr"),origin=node("td"),destination=node("td"),why=node("td"),action=node("td");
        tr.append(origin,destination,why,action);tb.append(tr);
        if(entry.source){
          const row=entry.source;
          origin.textContent=row.ref+" · "+row.sheet+coordinates(row,sameSource);
          const pick=node("select");pick.setAttribute("aria-label","Footprint for "+row.ref);
          pick.add(new Option("New schematic component",""));
          for(const id of row.candidates){const target=targets.get(id),op=new Option(name(target),id);
            op.disabled=target.assigned&&row.choice!==id;pick.add(op);}
          pick.value=(own(row,"choice")?row.choice:row.proposed)||"";destination.append(pick);
          const explain=()=>{const e=row.evidence.find(e=>e.target===pick.value);
            if(e)evidenceCell(why,e.confidence,e.reasons);else why.textContent="No board footprint paired";};
          explain();
          const accept=button(own(row,"choice")?"Confirmed":"Accept",()=>chooseMatch(row.source,pick.value||null),null,"eco-pick");
          accept.disabled=executed||own(row,"choice");pick.disabled=executed;
          pick.onchange=()=>{explain();accept.disabled=false;accept.textContent=pick.value?"Accept pairing":"Mark new";};
          action.append(accept);
        }else if(entry.target){
          const t=entry.target;origin.textContent="—";destination.textContent=name(t);
          why.textContent=t.locked?"Locked footprint":"No schematic component paired";
          const pick=node("select");pick.setAttribute("aria-label","Unpaired footprint "+t.ref);
          pick.add(new Option("Choose…",""));pick.add(new Option("Keep on board","keep"));
          if(!t.locked&&direction==="pcb")pick.add(new Option("Remove footprint","remove"));pick.value=t.choice||"";
          pick.disabled=executed||t.locked||direction==="sch";pick.onchange=()=>{if(pick.value)chooseMatch(null,t.target,pick.value);};action.append(pick);
        }else{
          const m=entry.pair;origin.textContent=m.sourceRef+" · "+m.sheet+at(m.sourceAt);destination.textContent=m.targetRef+at(m.targetAt);
          evidenceCell(why,m.confidence,m.reasons);action.textContent="Matched";
        }
      }
      matchBody.append(t);
      if(records.length>size){
        const nav=node("div",null,"eco-match-pages"),prev=button("Previous",()=>{matchPage--;renderMatches();},null,"eco-pick"),
          next=button("Next",()=>{matchPage++;renderMatches();},null,"eco-pick");
        prev.disabled=matchPage===0;next.disabled=(matchPage+1)*size>=records.length;
        nav.append(prev,node("span",(matchPage*size+1)+"–"+Math.min((matchPage+1)*size,records.length)+" of "+records.length),next);matchBody.append(nav);
      }
    }
    // Confidence first, then the evidence; reasons that argue against the pairing read as cautions.
    function evidenceCell(td,confidence,reasons){
      td.replaceChildren();
      if(confidence!=null){const c=node("span",Math.round(100*confidence)+"%","eco-conf");if(confidence<.8)c.classList.add("is-low");td.append(c);}
      reasons.forEach((r,i)=>{
        if(i)td.append(" · ");
        const label=globalThis.AtriumI18n?.text?.(r,"diff")||r;
        td.append(/^(Same|Nearby|Unique|Distinct|Numbered|Non-polar) /.test(r)?label:node("span",label,"eco-caution"));
      });
    }
    matchBox.ontoggle=renderMatches;
    function render(){
      const b=boards.find(x=>x.id===boardId);
      title.textContent=settings?"Sync Settings":direction==="sch"?"Update Schematics from PCB":"Update PCB from Schematics";
      sub.textContent=direction==="sch"?(b?.name||"")+" → "+(scope==="*"?"all schematics":sheets.find(s=>s.id===scope)?.name):(scope==="*"?"All schematics":sheets.find(s=>s.id===scope)?.name)+" → "+(b?.name||"");
      gear.setAttribute("aria-pressed",String(settings));
      removeLabel.hidden=roomsLabel.hidden=arrangeLabel.hidden=direction==="sch";
      for(const n of [explain,bar,opts,matchBox,tools,wrap,notes,warnBox,diffBox,reportBox,validate,run2,exportFile,openFile,report])n.classList.toggle("is-hidden",settings);
      page.hidden=!settings;
      if(settings){renderSettings();detail.hidden=true;return;}
      renderMatches();renderChips();
      tbody.replaceChildren();ui={groups:new Map(),rows:new Map()};
      const changes=current?.changes||[],st=new Map((result||checked)?.rows?.map(r=>[r.id,r])||[]);
      const stCell=(c,r,which)=>{
        const td=node("td",null,"eco-state");if(!r||which==="done"&&!executed)return td;
        const ok=r.state==="done",bad=r.state==="failed",held=r.state==="skipped"&&c.selected||r.held;
        const mark=node("span",ok?"✓":bad?"✕":held?"!":"–",ok?"eco-ok":bad?"eco-bad":held?"eco-held":"eco-skip");
        mark.setAttribute("aria-label",ok?"OK":bad?"Failed":held?"Will be skipped":"Not selected");mark.title=mark.getAttribute("aria-label");td.append(mark);return td;
      };
      const order=[...KINDS.map(k=>k[0])];for(const c of changes){const k=kindOf(c);if(!order.includes(k))order.push(k);}
      let visibleN=0;
      for(const g of order){
        const every=changes.filter(c=>kindOf(c)===g),list=every.filter(c=>visible(c,st));
        if(!list.length)continue;
        visibleN+=list.length;
        const gr=node("tr",null,"eco-group"),gc=node("td",null,"eco-enable"),gb=node("input");gb.type="checkbox";gb.disabled=executed;
        gb.setAttribute("aria-label","Include all: "+kindName(g));gb.onchange=()=>setMany(list.filter(c=>!c.ignored||filter==="ignored"),gb.checked);gc.append(gb);
        const name=node("td",null,"eco-group-name");name.colSpan=6;
        const tw=node("button",kindName(g),"eco-twisty");tw.type="button";tw.setAttribute("aria-expanded",String(!collapsed.has(g)));
        tw.onclick=()=>{if(collapsed.has(g))collapsed.delete(g);else collapsed.add(g);render();};
        const count=node("span","","eco-count");name.append(tw,count);if(HELP[g])name.append(node("span",HELP[g],"eco-group-help"));gr.append(gc,name);tbody.append(gr);
        ui.groups.set(g,{box:gb,count,list});syncGroup(g);
        if(collapsed.has(g))continue;
        // Long groups render a page at a time, so a 2,000-part ECO stays a light table.
        const limit=shown.get(g)||PAGE;
        for(const c of list.slice(0,limit)){
          const tr=node("tr",null,"eco-row"+(c.selected?"":" is-off")+(focus===c.id?" is-focus":"")+(c.conflict?" is-conflict":"")),cb=node("input"),c0=node("td",null,"eco-enable");
          cb.type="checkbox";cb.checked=!!c.selected;cb.setAttribute("aria-label","Include: "+sentence(c));cb.disabled=executed||(c.conflict&&c.use!=="forward"&&c.use!=="reverse");
          cb.onchange=()=>setMany([c],cb.checked);cb.onclick=e=>e.stopPropagation();c0.append(cb);
          const r=st.get(c.id),what=node("td",null,"eco-what");
          what.append(node("span",sentence(c),"eco-text"));
          const meta=node("span",null,"eco-meta");meta.append(node("span",ACTION_LABEL[c.action]||c.action,"eco-term"));
          // Origin and "Never sync" are library badges: schematic info, board accent, both warning, ignored neutral.
          if(c.origin){const o=node("span",c.use==="reverse"?(direction==="pcb"?"Board → schematic":"Schematic → board"):ORIGIN[c.origin],"ui-badge eco-badge eco-badge-"+c.origin);const t={schematic:"info",board:"accent",both:"warning"}[c.origin];if(t)o.dataset.tone=t;meta.append(o);}
          if(c.ignored)meta.append(node("span","Never sync","ui-badge eco-badge eco-badge-ignored"));
          what.append(meta);
          if(c.conflict&&!executed)choice(c,what);
          const never=button(c.ignored?"Sync Again":"Never Sync",e=>{e.stopPropagation();
            const was=!!c.ignored;ctx.edit(()=>{if(was)syncAgain(board(),ruleOf(c));else neverSync(board(),c);});
            compare();say(was?"“"+describe(c)+"” is back in the list.":"“"+describe(c)+"” will not be synced. Sync Settings lists it and can bring it back.");},
            c.ignored?"Bring this change back into updates":"Leave this difference alone in every future update (listed in Sync Settings)","eco-never");
          never.disabled=executed;
          const tdN=node("td",null,"eco-row-tools");tdN.append(never);
          tr.append(c0,what,node("td",c.use==="reverse"?(direction==="pcb"?(c.sheetName||"Schematic"):current.boardName):(c.document||""),"eco-doc"),
            stCell(c,r,"check"),stCell(c,r,"done"),node("td",r?.message||"","eco-msg"),tdN);
          tr.tabIndex=-1;
          tr.onclick=()=>{focus=c.id;for(const x of tbody.querySelectorAll(".is-focus"))x.classList.remove("is-focus");tr.classList.add("is-focus");renderDetail();previewRow(c);};
          tbody.append(tr);ui.rows.set(c.id,{tr,box:cb});
        }
        if(list.length>limit){
          const tr=node("tr",null,"eco-more"),td=node("td");td.colSpan=7;
          const more=button("Show "+Math.min(list.length-limit,PAGE*5)+" more of "+(list.length-limit)+" "+kindName(g).toLowerCase(),()=>{shown.set(g,limit+PAGE*5);render();});
          td.append(more);tr.append(td);tbody.append(tr);
        }
      }
      if(!visibleN){
        const tr=node("tr"),td=node("td",!current?"Comparing…":current.review.pending?"Resolve the component matches above to complete this change list.":!changes.length?"The schematic and the board are in sync. Nothing to change.":query?"No change matches “"+query+"”.":"No changes in this view.","eco-empty");
        td.colSpan=7;tr.append(td);tbody.append(tr);
      }
      // Warnings Validate found, explained; and the report after Execute.
      warnBox.replaceChildren();warnBox.hidden=executed||!warned?.length;
      if(warned?.length&&!executed){
        warnBox.append(node("h3",confirmArmed?"Before you execute":"To know before Execute"));
        const ul=node("ul");for(const w of warned){const li=node("li",null,"eco-w eco-w-"+w.kind);li.append(node("strong",w.text),node("span"," "+w.why));ul.append(li);}warnBox.append(ul);
      }
      reportBox.replaceChildren();reportBox.hidden=!executed;
      if(executed&&result){
        reportBox.append(node("h3","Executed: "+result.applied+" applied"+(result.failed?", "+result.failed+" failed":"")+(result.skipped?", "+result.skipped+" skipped":"")));
        const bad=result.rows.filter(r=>r.state==="failed");
        if(bad.length){const ul=node("ul");for(const r of bad.slice(0,20))ul.append(node("li",r.object+": "+r.message));reportBox.append(ul);}
        const undo=globalThis.AtriumKeymap?.hintFor?.("undo","pcb");
        reportBox.append(node("p","Undo"+(undo?" ("+undo+")":"")+" reverts the whole update. Report Changes… saves this list.","eco-why"));
      }
      notes.hidden=!current?.issues.length;notesSum.textContent=(current?.issues.length||0)+" note"+(current?.issues.length===1?"":"s")+" (not changed)";
      notesList.replaceChildren(...(current?.issues||[]).slice(0,500).map(i=>node("li",i)));
      renderDetail();
      syncTotals();
    }
    all.onchange=()=>setMany((current?.changes||[]).filter(c=>!c.ignored),all.checked);
    search.oninput=()=>{query=search.value.trim();render();};
    dir.onchange=source.onchange=target.onchange=removeBox.onchange=compare;
    roomsBox.onchange=()=>{setPref("rooms",roomsBox.checked);compare();};
    arrangeBox.onchange=()=>setPref("arrange",arrangeBox.checked);
    document.body.append(dialog);
    dialog.onclose=()=>{
      closed=true;planToken++;diffToken++;clearPreview();offRender?.();
      // The preview switched documents or selection: go back unless the update ran.
      if(!executed&&H){try{if(shownDoc&&startDoc&&H.currentId()!==startDoc)H.selectDocument(startDoc);H.select?.(startSel);}catch{}}
      dialog.remove();
    };
    run2.dataset.uiDefault="false";
    globalThis.AtriumShell?.adoptDialog?.(dialog, {title, body, actions:footer, sheet:true});
    dialog.showModal();compare();
    // Net class and pair directives need the rules module, which the editor loads on demand.
    if(!globalThis.AtriumRules&&globalThis.AtriumLazy?.need)AtriumLazy.need("AtriumRules").then(()=>{if(dialog.open&&!executed&&!checked)compare();},()=>{});
    return dialog;
  }
  const workflows={"eco-reverse":{open:c=>open(c,{reverse:true})}};
  // Design › Sync Settings… (the dialog's settings page).
  if(typeof document!=="undefined"&&globalThis.AtriumNavCommon?.ready)AtriumNavCommon.ready(h=>h.registerAction("sync-settings",()=>open(hostCtx(h),{settings:true})));
  return {extendSch,open,serialize,preview,apply,resolve,plan,planAsync,decide,cachedLocal,validate:validateChanges,execute,update,reopen,describe,report:reportText,workflows,GROUPS,ACTIONS:ACTION_LABEL,
    warnings,neverSync,syncAgain,forgetBase,ignores:ignoresOf,ruleOf,rebase,KINDS,kindOf};
})();
