"use strict";

// Quick component swapping. Pure planners return edit plans that `apply` performs on a
// project, so the editor wraps one plan in a single undoable edit and headless callers
// (tests, MCP) can inspect or apply the same plan.
//
//   planSwap(doc, defs, ids, opts)          exchange positions, rotation and side (2 parts),
//                                           or rotate them through N parts of one footprint
//   planVariant(doc, defs, id, defId, opts) switch to another footprint size (0402/0603/...)
//   planLibrary(doc, defs, id, defId, opts) replace with another library part, same pin count
//
// Boards keep their copper as it is: tracks stay put and the ratsnest follows the moved
// pads (Altium's behaviour). Schematics stay connected: wire ends, labels and junctions at
// moved pins follow them, with an elbow as when a part is dragged.
globalThis.AtriumSwap = (() => {
  const A=()=>globalThis.Atrium;
  const round=v=>Math.round(v*1e6)/1e6+0;
  const geom=(def,kind)=>kind==="pcb"?def?.footprint:def?.symbol;
  const terminals=(def,kind)=>{const g=geom(def,kind);return g?.pads||g?.pins||[];};
  const signature=(def,kind)=>terminals(def,kind).map(p=>String(p.number)).sort().join(",");
  const natural=(a,b)=>String(a.ref).localeCompare(String(b.ref),undefined,{numeric:true});
  const fail=message=>({ok:false,message,ops:[],wires:[],addDefs:[]});
  function localCentre(def,kind){
    const b=A().bounds(A().symbolPoints(geom(def,kind)));
    return b?[(b[0]+b[2])/2,(b[1]+b[3])/2]:[0,0];
  }

  // ------------------------------------------------------------ schematic wiring follows pins
  // moves: [[oldPoint,newPoint]]. Returns wire and label/junction edits for `doc`.
  function follow(doc,moves,flip){
    const key=A().pointKey,moved=new Map(),clash=new Set();
    for(const [from,to] of moves){if(A().same(from,to))continue;const k=key(from);if(moved.has(k)&&!A().same(moved.get(k),to))clash.add(k);moved.set(k,to);}
    for(const k of clash)moved.delete(k);
    const wires=[],ops=[];let ends=0;
    for(const w of doc.items){
      if(w.kind==="wire"&&w.points?.length>1){
        const old=w.points;let pts=old.map(p=>p.slice()),changed=false;
        for(const end of [0,old.length-1]){
          const target=moved.get(key(old[end]));if(!target||A().same(target,old[end]))continue;
          const start=end===0,adj=start?old[1]:old[old.length-2];
          const bit=flip?flip(ends++):false,horiz=(Math.abs(old[end][1]-adj[1])<1e-4)!==bit,elbow=horiz?[adj[0],target[1]]:[target[0],adj[1]];
          if(start)pts.splice(0,1,target.slice(),elbow);else pts.splice(-1,1,elbow,target.slice());
          changed=true;
        }
        if(changed){pts=pts.filter((p,i,a)=>!i||!A().same(p,a[i-1]));wires.push({doc:doc.id,id:w.id,points:pts.map(p=>p.map(round))});}
      }else if((w.kind==="netlabel"||w.kind==="junction")&&Number.isFinite(w.x)){
        const target=moved.get(key([w.x,w.y]));
        if(target)ops.push({doc:doc.id,id:w.id,set:{x:round(target[0]),y:round(target[1])}});
      }
    }
    return {wires,ops};
  }
  // Net partition of a schematic: groups of pins, independent of generated net names.
  function partition(doc,defs){
    const by=A().connectivity(doc,defs).byPin,groups=new Map();
    for(const [pin,net] of by){if(!groups.has(net))groups.set(net,[]);groups.get(net).push(pin);}
    return [...groups.values()].map(g=>g.sort().join(",")).sort().join("|");
  }
  // Wiring that keeps every net: try each elbow orientation for the moved wire ends
  // (all combinations up to 6 ends) and keep the first that preserves the partition.
  function connected(doc,defs,ops,moves){
    const want=partition(doc,defs),probe=follow(doc,moves),count=countEnds(doc,moves);
    const tries=count<=6?1<<count:2;
    for(let t=0;t<tries;t++){
      const w=t===0?probe:follow(doc,moves,count<=6?n=>!!(t>>n&1):()=>true);
      const trial={...doc,items:doc.items.map(i=>({...i}))},proj={documents:[trial],library:[]};
      apply(proj,{ok:true,ops:[...ops,...w.ops],wires:w.wires});
      if(partition(trial,defs)===want)return w;
    }
    return null;
  }
  function countEnds(doc,moves){
    const keys=new Set(moves.map(([a])=>A().pointKey(a)));let n=0;
    for(const w of doc.items)if(w.kind==="wire"&&w.points?.length>1)for(const end of [0,w.points.length-1])if(keys.has(A().pointKey(w.points[end])))n++;
    return n;
  }
  const pinMoves=(item,def,kind,set,pairs)=>{
    const before=A().pins(item,def,kind),after=A().pins({...item,...set},set.defObject||def,kind);
    return (pairs||before.map((_,i)=>[i,i])).filter(([a,b])=>before[a]&&after[b]).map(([a,b])=>[before[a].at,after[b].at]);
  };

  // ------------------------------------------------------------ swap positions
  // opts.anchor "centroid" (default: bodies land on each other's bodies) or "origin";
  // opts.side (default true) exchanges top/bottom; opts.text exchanges designator offsets.
  function planSwap(doc,defs,ids,opts={}){
    const kind=doc.kind,chosen=new Set(ids),parts=doc.items.filter(i=>i.kind==="part"&&chosen.has(i.id));
    if(parts.length<2)return fail("Select two or more components to swap.");
    for(const p of parts)if(!geom(defs.get(p.def),kind))return fail(p.ref+" has no "+(kind==="pcb"?"footprint":"symbol")+".");
    if(parts.length>2){
      const sig=signature(defs.get(parts[0].def),kind);
      if(parts.some(p=>signature(defs.get(p.def),kind)!==sig))return fail("Cycle-swapping more than two components needs the same "+(kind==="pcb"?"footprint":"symbol")+" pins on each.");
    }
    parts.sort(natural);
    const anchor=opts.anchor==="origin"?"origin":"centroid";
    const places=parts.map(p=>{const def=defs.get(p.def);return {x:p.x,y:p.y,angle:p.angle||0,layer:p.layer,refAt:p.refAt,valueAt:p.valueAt,
      centre:A().world(localCentre(def,kind),p)};});
    const ops=[],moves=[];
    parts.forEach((p,i)=>{
      const def=defs.get(p.def),q=places[(i+1)%parts.length],set={angle:q.angle};
      if(anchor==="origin"){set.x=q.x;set.y=q.y;}
      else{const r=A().rotate(localCentre(def,kind),q.angle);set.x=round(q.centre[0]-r[0]);set.y=round(q.centre[1]-r[1]);}
      if(kind==="pcb"&&opts.side!==false&&(q.layer||"Top")!==(p.layer||"Top"))set.layer=q.layer??null;
      if(opts.text){set.refAt=q.refAt?q.refAt.slice():null;set.valueAt=q.valueAt?q.valueAt.slice():null;}
      ops.push({doc:doc.id,id:p.id,set});
      if(kind==="schematic")moves.push(...pinMoves(p,def,kind,set));
    });
    // Schematic wiring (opts.wiring): "follow" drags wire ends with the pins and fails
    // when no elbow arrangement keeps every net; "keep" leaves the wires, so the parts take
    // each other's nets (review the ECO to carry that to the board); "auto" (default)
    // follows when it can and keeps otherwise.
    let wiring={wires:[],ops:[]},exchanged=false;
    if(kind==="schematic"&&opts.wiring!=="keep"){
      wiring=connected(doc,defs,ops,moves);
      if(!wiring&&opts.wiring==="follow")return fail("Swapping "+parts.map(p=>p.ref).join(" and ")+" here would join or split nets where the moved wires cross other connections.");
      if(!wiring){wiring={wires:[],ops:[]};exchanged=true;}
    }else if(kind==="schematic")exchanged=true;
    const refs=parts.map(p=>p.ref);
    return {ok:true,action:"swap",anchor,ops:[...ops,...wiring.ops],wires:wiring.wires,addDefs:[],netsExchanged:exchanged,
      message:(parts.length===2?"Swapped "+refs.join(" ↔ ")+".":"Cycled positions "+refs.join(" → ")+" → "+refs[0]+".")+
        (exchanged?" The wiring stays, so they took each other's nets; use Review ECO to update the board.":"")};
  }

  // ------------------------------------------------------------ footprint variants
  // Chip land patterns (IPC-7351 nominal): pad [w,h], pad centre offset, body [w,h].
  const CHIP={"0201":{metric:"0603",pad:[.46,.4],x:.32,body:[.6,.3]},"0402":{metric:"1005",pad:[.59,.64],x:.485,body:[1,.5]},
    "0603":{metric:"1608",pad:[.9,.95],x:.8,body:[1.6,.8]},"0805":{metric:"2012",pad:[1.025,1.4],x:.9125,body:[2,1.25]},
    "1206":{metric:"3216",pad:[1.125,1.75],x:1.4875,body:[3.2,1.6]},"1210":{metric:"3225",pad:[1.125,2.65],x:1.4875,body:[3.2,2.5]},
    "2512":{metric:"6332",pad:[1.5,3.35],x:2.9,body:[6.3,3.2]}};
  const SIZES=["0201","0402","0603","0805","1206","1210","2512"],CODE=/(^|[^0-9])(0201|0402|0603|0805|1206|1210|2512)(?![0-9])/;
  const codeOf=name=>CODE.exec(String(name||""))?.[2]||null;
  const familyOf=name=>String(name||"").replace(/[_-]?\d{4}Metric/i,"").replace(CODE,"$1#");
  const fpName=def=>def?.footprint?.name||def?.name||"";
  const baseId=id=>String(id).replace(/@(0201|0402|0603|0805|1206|1210|2512)$/,"");
  function rename(text,code){
    return String(text).replace(CODE,"$1"+code).replace(/\d{4}Metric/i,CHIP[code].metric+"Metric");
  }
  // A clone of a two-pad chip part with the land pattern of another size.
  function synthesize(def,code){
    const c=CHIP[code],out=JSON.parse(JSON.stringify(def)),pads=out.footprint.pads;
    const [a,b]=pads,alongX=Math.abs(a.x-b.x)>=Math.abs(a.y-b.y),mid=[(a.x+b.x)/2,(a.y+b.y)/2];
    for(const p of pads){
      const s=Math.sign(alongX?p.x-mid[0]:p.y-mid[1])||1;
      if(alongX){p.x=round(mid[0]+s*c.x);p.y=mid[1];p.w=c.pad[0];p.h=c.pad[1];}
      else{p.y=round(mid[1]+s*c.x);p.x=mid[0];p.w=c.pad[1];p.h=c.pad[0];}
    }
    const [bw,bh]=alongX?c.body:[c.body[1],c.body[0]],x0=round(mid[0]-bw/2),y0=round(mid[1]-bh/2),x1=round(mid[0]+bw/2),y1=round(mid[1]+bh/2);
    out.footprint.shapes=[{kind:"path",points:[[x0,y0],[x1,y0],[x1,y1],[x0,y1]],style:"package",closed:true,fill:true}];
    out.id=baseId(def.id)+"@"+code;
    out.footprint.name=codeOf(out.footprint.name)?rename(out.footprint.name,code):(out.footprint.name||"")+" "+code;
    out.name=codeOf(def.name)?rename(def.name,code):String(def.name).replace(/ \((0201|0402|0603|0805|1206|1210|2512)\)$/,"")+" ("+code+")";
    return out;
  }
  // Footprints a part can switch to: same family (by size) first, then any footprint
  // with the same pad numbers. Two-pad chip families include standard sizes not yet in
  // the library; they are created when chosen.
  function variants(doc,defs,id){
    const part=doc.items.find(i=>i.id===id&&i.kind==="part"),def=part&&defs.get(part.def);
    if(!def?.footprint)return [];
    const sig=signature(def,"pcb"),name=fpName(def),code=codeOf(name),fam=familyOf(name),out=[];
    for(const d of defs.values()){
      if(!d.footprint||signature(d,"pcb")!==sig)continue;
      const n=fpName(d),c=codeOf(n),family=!!(code&&c&&familyOf(n)===fam);
      out.push({id:d.id,name:d.name,footprint:n,code:family?c:null,family,current:d.id===def.id,synthetic:false});
    }
    if(code&&def.footprint.pads.length===2){
      for(const c of SIZES)if(!out.some(o=>o.family&&o.code===c)){
        const sid=baseId(def.id)+"@"+c;if(defs.has(sid))continue;
        out.push({id:sid,name:synthesize(def,c).name,footprint:rename(name,c),code:c,family:true,current:false,synthetic:true});
      }
    }
    return out.sort((a,b)=>(b.family-a.family)||(a.family?SIZES.indexOf(a.code)-SIZES.indexOf(b.code):a.footprint.localeCompare(b.footprint))||(b.current-a.current));
  }
  // The family member after (dir 1) or before (dir -1) the part's current footprint.
  function nextVariant(doc,defs,id,dir=1){
    const fam=variants(doc,defs,id).filter(v=>v.family);
    if(fam.length<2)return null;
    const at=fam.findIndex(v=>v.current);
    return fam[(at+dir+fam.length)%fam.length].id;
  }
  function resolveDef(doc,defs,id,defId){
    if(defs.has(defId))return {def:defs.get(defId),added:null};
    const part=doc.items.find(i=>i.id===id),def=defs.get(part?.def),code=/@(\d{4})$/.exec(defId)?.[1];
    if(def&&code&&CHIP[code]&&baseId(defId)===baseId(def.id)&&def.footprint?.pads.length===2){const made=synthesize(def,code);return {def:made,added:made};}
    return {def:null,added:null};
  }
  // Pad pairing [oldIndex,newIndex]: by number when the numbers match, else in order.
  function pairing(fromDef,toDef,kind){
    const a=terminals(fromDef,kind),b=terminals(toDef,kind);
    if(signature(fromDef,kind)===signature(toDef,kind))return a.map((p,i)=>[i,b.findIndex(q=>String(q.number)===String(p.number))]);
    return a.map((_,i)=>[i,i]).filter(([,j])=>j<b.length);
  }
  function remapNets(item,fromDef,toDef){
    if(!item.pinNets)return undefined;
    const a=terminals(fromDef,"pcb"),b=terminals(toDef,"pcb"),pairs=pairing(fromDef,toDef,"pcb");
    if(signature(fromDef,"pcb")===signature(toDef,"pcb"))return undefined;
    const next={};
    for(const [i,j] of pairs){const n=item.pinNets[a[i].number];if(n!==undefined&&b[j])next[b[j].number]=n;}
    return next;
  }
  // Edits that point `items` (in their documents) at `target`, keeping nets.
  function retarget(docs,defs,entries,target,valueFrom){
    const ops=[],wires=[];
    for(const doc of docs){
      const mine=entries.filter(e=>doc.items.includes(e));if(!mine.length)continue;
      const moves=[];
      for(const item of mine){
        const from=defs.get(item.def),set={def:target.id};
        if(!geom(target,doc.kind))continue;
        if(doc.kind==="pcb"){const nets=remapNets(item,from,target);if(nets)set.pinNets=nets;}
        if(valueFrom&&item.value===(from.value??from.name))set.value=target.value??target.name;
        ops.push({doc:doc.id,id:item.id,set});
        if(doc.kind==="schematic")moves.push(...pinMoves(item,from,"schematic",{defObject:target},pairing(from,target,"schematic")));
      }
      if(!moves.length)continue;
      const mineOps=ops.filter(o=>o.doc===doc.id),w=connected(doc,defs,mineOps,moves);
      if(!w)return {ops,wires,error:"The new pins would join or split nets in "+doc.name+". Rewire by hand."};
      ops.push(...w.ops);wires.push(...w.wires);
    }
    return {ops,wires};
  }
  // Parts that follow: the part, other ids given in opts.ids with the same def, and with
  // opts.project, linked parts (same link and def) in other documents.
  function targets(doc,part,opts){
    const docs=opts.project?.documents||[doc],ids=new Set([part.id,...(opts.ids||[])]),out=[];
    const links=new Set();
    for(const i of doc.items)if(ids.has(i.id)&&i.kind==="part"&&i.def===part.def){out.push(i);if(i.link)links.add(i.link);}
    if(opts.project&&opts.linked!==false)for(const d of docs)for(const i of d.items)
      if(i.kind==="part"&&i.def===part.def&&i.link&&links.has(i.link)&&!out.includes(i))out.push(i);
    return {docs,items:out};
  }
  function planVariant(doc,defs,id,defId,opts={}){
    const part=doc.items.find(i=>i.id===id&&i.kind==="part");if(!part)return fail("Select a component.");
    const from=defs.get(part.def);if(!from?.footprint)return fail(part.ref+" has no footprint.");
    const {def:target,added}=resolveDef(doc,defs,id,defId);
    if(!target?.footprint)return fail("Footprint "+defId+" is not available.");
    if(target.footprint.pads.length!==from.footprint.pads.length)return fail(fpName(target)+" has a different pad count.");
    if(target.id===from.id)return fail(part.ref+" already uses "+fpName(target)+".");
    const all=new Map(defs);if(added)all.set(added.id,added);
    const {docs,items}=targets(doc,part,opts),edit=retarget(docs,all,items,target,false);
    if(edit.error)return fail(edit.error);
    const refs=[...new Set(items.map(i=>i.ref))];
    return {ok:true,action:"variant",ops:edit.ops,wires:edit.wires,addDefs:added?[added]:[],def:target.id,
      message:refs.join(", ")+": "+fpName(from)+" → "+fpName(target)+"."};
  }

  // ------------------------------------------------------------ library replacement
  function libraryCandidates(doc,defs,id){
    const part=doc.items.find(i=>i.id===id&&i.kind==="part"),def=part&&defs.get(part.def);if(!def)return [];
    const n=terminals(def,doc.kind).length,out=[];
    for(const d of defs.values())if(d.id!==def.id&&geom(d,doc.kind)&&terminals(d,doc.kind).length===n)
      out.push({id:d.id,name:d.name,footprint:fpName(d),category:d.category||"",exact:signature(d,doc.kind)===signature(def,doc.kind)});
    return out.sort((a,b)=>(b.exact-a.exact)||a.name.localeCompare(b.name));
  }
  function planLibrary(doc,defs,id,defId,opts={}){
    const part=doc.items.find(i=>i.id===id&&i.kind==="part");if(!part)return fail("Select a component.");
    const from=defs.get(part.def),target=defs.get(defId);
    if(!target||!geom(target,doc.kind))return fail("That part has no "+(doc.kind==="pcb"?"footprint":"symbol")+".");
    if(terminals(target,doc.kind).length!==terminals(from,doc.kind).length)return fail(target.name+" has a different pin count.");
    const {docs,items}=targets(doc,part,opts),edit=retarget(docs,defs,items,target,opts.keepValue!==true);
    if(edit.error)return fail(edit.error);
    return {ok:true,action:"library",ops:edit.ops,wires:edit.wires,addDefs:[],def:target.id,
      message:part.ref+": "+from.name+" → "+target.name+"."};
  }

  // ------------------------------------------------------------ apply
  // Performs a plan on a project ({documents, library}). null in a `set` removes the field.
  function apply(project,plan){
    if(!plan?.ok)return project;
    for(const d of plan.addDefs||[])if(!project.library.some(x=>x.id===d.id))project.library.push(JSON.parse(JSON.stringify(d)));
    const docs=new Map(project.documents.map(d=>[d.id,d])),find=(docId,id)=>{
      const d=docs.get(docId);const hit=d?.items.find(i=>i.id===id);if(hit)return hit;
      for(const x of project.documents){const i=x.items.find(i=>i.id===id);if(i)return i;}return null;};
    for(const op of plan.ops){
      const item=find(op.doc,op.id);if(!item)continue;
      for(const [k,v] of Object.entries(op.set)){if(v===null)delete item[k];else item[k]=typeof v==="object"?JSON.parse(JSON.stringify(v)):v;}
    }
    for(const w of plan.wires||[]){const item=find(w.doc,w.id);if(item)item.points=w.points.map(p=>p.slice());}
    return project;
  }

  // ------------------------------------------------------------ editor entry points
  const PREFS="atrium-swap-v1";
  let prefs={anchor:"centroid",text:false};
  try{const raw=globalThis.localStorage?.getItem(PREFS);if(raw)prefs={...prefs,...JSON.parse(raw)};}catch{}
  function setOptions(next){prefs={...prefs,...next};try{globalThis.localStorage?.setItem(PREFS,JSON.stringify(prefs));}catch{}return {...prefs};}
  // ctx: {project(), doc(), defs(), selection(), edit(fn), info(text)}
  function run(action,ctx){
    const project=ctx.project(),doc=ctx.doc(),defs=ctx.defs(),sel=ctx.selection();
    const parts=doc.items.filter(i=>i.kind==="part"&&sel.includes(i.id));
    const commit=plan=>{if(!plan.ok){ctx.info(plan.message);return false;}ctx.edit(()=>apply(project,plan));ctx.info(plan.message);return true;};
    if(action==="swap-components"||action==="swap-components-origin")
      return commit(planSwap(doc,defs,sel,{...prefs,anchor:action==="swap-components-origin"?"origin":prefs.anchor}));
    if(!parts.length){ctx.info("Select a component first.");return false;}
    const part=parts[0],same=parts.filter(p=>p.def===part.def).map(p=>p.id);
    if(action==="swap-variant"||action==="swap-variant-back"){
      const next=nextVariant(doc,defs,part.id,action==="swap-variant-back"?-1:1);
      if(!next){ctx.info("No other sizes of "+fpName(defs.get(part.def))+" for "+part.ref+". Use Choose footprint variant… for other footprints.");return false;}
      return commit(planVariant(doc,defs,part.id,next,{project,ids:same}));
    }
    if(action==="swap-variant-pick"){
      const list=variants(doc,defs,part.id);
      if(list.length<2){ctx.info("No compatible footprints for "+part.ref+".");return false;}
      return pick("Footprint for "+part.ref,list.map(v=>({id:v.id,label:v.footprint,detail:v.family?(v.synthetic?"new size":v.name):"same pads · "+v.name,current:v.current})),
        id=>commit(planVariant(doc,defs,part.id,id,{project,ids:same})));
    }
    if(action==="swap-library"){
      const list=libraryCandidates(doc,defs,part.id);
      if(!list.length){ctx.info("No library parts with "+terminals(defs.get(part.def),doc.kind).length+" pins.");return false;}
      return pick("Replace "+part.ref+" with",list.map(v=>({id:v.id,label:v.name,detail:v.footprint||v.category})),
        id=>commit(planLibrary(doc,defs,part.id,id,{project})));
    }
    return false;
  }
  // A small searchable list. Enter takes the first match; arrows move; Esc closes.
  function pick(title,items,choose){
    const doc=globalThis.document,el=(t,x,c)=>AtriumNavCommon.elementIn(doc, t, x, c);
    const d=el("dialog",null,"work-dialog swap-pick");d.setAttribute("aria-label",title);
    const search=el("input");search.type="search";search.placeholder="Filter";search.setAttribute("aria-label","Filter");
    const list=el("div",null,"ui-list swap-list");list.setAttribute("role","listbox");
    const foot=el("div",null,"work-actions"),cancel=el("button","Cancel");cancel.type="button";cancel.onclick=()=>d.close();foot.append(cancel);
    const find=AtriumUI.searchField(search,{cls:"swap-find",type:true});d.append(el("h2",title),find,list,foot);
    function render(){
      const q=search.value.trim().toLowerCase();list.replaceChildren();
      for(const it of items){
        if(q&&!(it.label+" "+(it.detail||"")).toLowerCase().includes(q))continue;
        // A library list row: the part, and its detail as the row's meta.
        const b=el("button",null,"ui-row"+(it.current?" swap-current":""));b.type="button";b.setAttribute("role","option");
        const text=el("span",null,"ui-row-text");text.append(el("span",it.label+(it.current?" (current)":""),"ui-row-title"));
        b.append(text,el("small",it.detail||"","ui-row-meta"));
        b.onclick=()=>{d.close();if(!it.current)choose(it.id);};list.append(b);
      }
    }
    search.oninput=render;
    d.addEventListener("keydown",e=>{
      const buttons=[...list.querySelectorAll("button")],i=buttons.indexOf(doc.activeElement);
      if(e.key==="Enter"&&doc.activeElement===search){e.preventDefault();(buttons.find(b=>!b.classList.contains("swap-current"))||buttons[0])?.click();}
      else if(e.key==="ArrowDown"||e.key==="ArrowUp"){e.preventDefault();if(i<=0&&e.key==="ArrowUp")search.focus();else buttons[Math.min(buttons.length-1,i+(e.key==="ArrowDown"?1:-1))]?.focus();}
    });
    globalThis.AtriumShell?.adoptDialog?.(d, {title:d.firstElementChild, body:[find,list], actions:foot, initialFocus:search});
    d.onclose=()=>d.remove();render();doc.body.append(d);d.showModal();search.focus();
    return true;
  }
  return {planSwap,planVariant,planLibrary,variants,nextVariant,libraryCandidates,apply,run,pick,setOptions,options:()=>({...prefs}),synthesize,family:familyOf,sizeCode:codeOf};
})();
