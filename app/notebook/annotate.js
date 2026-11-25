"use strict";
// Annotate Schematics (Altium: Tools » Annotation » Annotate Schematics…).
// plan() is pure: it proposes designators from a project and options without
// touching the model. prepare() turns an accepted plan into a single mutation,
// including back-annotation of linked board footprints, for one ctx.edit step.
globalThis.AtriumAnnotate=(()=>{
  const A=Atrium;
  const ORDERS=[
    {key:"up-across",label:"Up Then Across",help:"Columns from left to right; each column from bottom to top."},
    {key:"down-across",label:"Down Then Across",help:"Columns from left to right; each column from top to bottom."},
    {key:"across-up",label:"Across Then Up",help:"Rows from bottom to top; each row from left to right."},
    {key:"across-down",label:"Across Then Down",help:"Rows from top to bottom; each row from left to right."}
  ];
  const MATCHING=[
    {key:"none",label:"None"},
    {key:"sheet",label:"Complete Existing Packages · Per Sheet"},
    {key:"project",label:"Complete Existing Packages · Whole Project"}
  ];
  const SCOPES=[{key:"all",label:"All"},{key:"ignore-selected",label:"Ignore Selected Parts"},{key:"only-selected",label:"Only Selected Parts"}];
  const natural=new Intl.Collator("en",{numeric:true,sensitivity:"base"});
  const upper=s=>String(s??"").trim().toUpperCase();
  const pending=ref=>!String(ref??"").trim()||String(ref).includes("?");
  const unitOf=item=>Number.isInteger(item.unit)&&item.unit>0?item.unit:null;
  const unitLetter=u=>u?(u<=26?String.fromCharCode(64+u):"#"+u):"";

  // Designator prefix: the existing ref without its sheet suffix, digits and "?",
  // falling back to the library definition's default prefix.
  function prefixOf(ref,def,suffix=""){
    let r=String(ref??"").trim();
    if(suffix&&r.toUpperCase().endsWith(suffix.toUpperCase()))r=r.slice(0,r.length-suffix.length);
    const lead=r.match(/^[^\d?]+/)?.[0]?.trim();
    return lead||String(def?.prefix||"").replace(/[\d?]/g,"").trim()||"U";
  }

  // The same page rectangle and reference zones the schematic renderer draws.
  function pageBounds(doc){
    if(globalThis.AtriumSchAppearance?.pageBounds)return AtriumSchAppearance.pageBounds(doc);
    const p=doc.schDrawing||doc.schRestored?.sheet,w=p?.width||292.1,h=p?.height||193.04;
    return doc.sourceName?[0,-h,w,0]:[-12.7,-12.7,w-12.7,h-12.7];
  }
  const clamp=(v,lo,hi)=>Math.max(lo,Math.min(hi,v));
  function regions(doc,options={}){
    const p=doc.schDrawing||doc.schRestored?.sheet,[left,top,right,bottom]=pageBounds(doc);
    const w=right-left,h=bottom-top,inset=p?.border===false?0:Math.min(5.08,w*.07,h*.07);
    const cols=clamp(Math.round(options.zonesX||p?.zonesX||6),1,64),rows=clamp(Math.round(options.zonesY||p?.zonesY||4),1,64);
    const x0=left+inset,y0=top+inset,cw=(w-2*inset)/cols,rh=(h-2*inset)/rows;
    return {cols,rows,column:x=>clamp(Math.floor((x-x0)/cw),0,cols-1),row:y=>clamp(Math.floor((y-y0)/rh),0,rows-1)};
  }

  // Location used for ordering: the designator's position (Altium default), or
  // the symbol centre. Model Y grows downwards on screen, so "up" is smaller y.
  function partBox(item,def){
    const local=A.bounds(A.symbolPoints(def?.symbol))||[-.5,-.5,.5,.5];
    return A.bounds([[local[0],local[1]],[local[2],local[1]],[local[2],local[3]],[local[0],local[3]]].map(p=>A.world(p,item)));
  }
  function location(item,def,mode="designator"){
    const b=partBox(item,def);
    if(mode==="center")return [(b[0]+b[2])/2,(b[1]+b[3])/2];
    if(item.refAt)return A.world(item.refAt,item);
    const upright=(Math.abs(Math.round((item.angle||0)/90))%2)!==0;
    return upright?[b[2]+.9,item.y-.4]:[(b[0]+b[2])/2,b[1]-2.75];
  }
  function comparator(order){
    // a/b carry {col,row,x,y}. Ties fall through to the current designator and id.
    const by={
      "up-across":(a,b)=>a.col-b.col||b.y-a.y||a.x-b.x,
      "down-across":(a,b)=>a.col-b.col||a.y-b.y||a.x-b.x,
      "across-up":(a,b)=>b.row-a.row||a.x-b.x||b.y-a.y,
      "across-down":(a,b)=>a.row-b.row||a.x-b.x||a.y-b.y
    }[order]||null;
    if(!by)throw Error("Unknown order of processing: "+order);
    const eps=v=>Math.abs(v)<1e-6?0:v;
    return (a,b)=>eps(by(a,b))||natural.compare(a.current,b.current)||(a.unit||0)-(b.unit||0)||(a.id<b.id?-1:a.id>b.id?1:0);
  }

  function sheetConfig(raw={}){
    const start=Number(raw.startIndex);
    return {enabled:raw.enabled!==false,scope:SCOPES.some(s=>s.key===raw.scope)?raw.scope:"all",
      startIndex:Number.isInteger(start)&&start>0?start:null,suffix:typeof raw.suffix==="string"?raw.suffix.trim():""};
  }
  const lookup=(map,id)=>map instanceof Map?map.get(id):map&&Object.prototype.hasOwnProperty.call(map,id)?map[id]:undefined;

  // A group of parts may legitimately share a designator only as the distinct
  // units of one multi-part package (same definition, unit numbers all set).
  function joins(kept,e){
    if(!kept.length)return true;
    if(!e.unit||kept.some(k=>!k.unit||k.def!==e.def||k.unit===e.unit))return false;
    const count=e.unitCount;
    return !count||kept.length<count;
  }

  /**
   * plan(project, options) -> {rows, changes, issues, duplicates, options}
   *  options.order      "up-across" | "down-across" | "across-up" | "across-down"
   *  options.action     "update" (number "?" designators only) | "reset-all" | "reset-duplicates" | "annotate" (reset all, then update) | "none"
   *  options.matching   "none" | "sheet" | "project" (complete existing multi-unit packages)
   *  options.sheets     {[sheetId]: {enabled, scope, startIndex, suffix}}
   *  options.proposed   {[partId]: ref} proposals carried over from a previous call
   *  options.locks      {[partId]: bool} lock overrides; default is item.designatorLocked
   *  options.selected   part ids, for the "Ignore/Only Selected" annotation scopes
   *  options.location   "designator" (default) | "center"; options.zonesX / zonesY override sheet zones
   */
  function plan(project,options={}){
    const order=options.order||"up-across",action=options.action||"update",matching=MATCHING.some(m=>m.key===options.matching)?options.matching:"none";
    const cmp=comparator(order),defs=new Map(project.library.map(d=>[d.id,d]));
    const selected=new Set(options.selected||[]),issues=new Set();
    const all=[],listed=[];
    for(const sheet of project.documents.filter(d=>d.kind==="schematic")){
      const cfg=sheetConfig(lookup(options.sheets,sheet.id)),zone=regions(sheet,options),entries=[];
      for(const item of sheet.items){
        if(item.kind!=="part")continue;
        const def=defs.get(item.def),at=location(item,def,options.location),lock=lookup(options.locks,item.id);
        const inScope=cfg.enabled&&(cfg.scope==="all"||(cfg.scope==="only-selected")===selected.has(item.id));
        const locked=lock===undefined?item.designatorLocked===true:!!lock;
        const proposed=lookup(options.proposed,item.id);
        const e={id:item.id,item,def:item.def,unitCount:Number.isInteger(def?.unitCount)?def.unitCount:def?.symbol?.parts>1?def.symbol.parts:null,defn:def,
          sheet:sheet.id,sheetName:sheet.name,cfg,current:item.ref,unit:unitOf(item)||unitOf({unit:item.part})||(def?.symbol?.parts>1?1:null),autoUnit:!unitOf(item)&&!unitOf({unit:item.part})&&def?.symbol?.parts>1,locked,listed:inScope,
          active:inScope&&!locked,x:at[0],y:at[1],col:zone.column(at[0]),row:zone.row(at[1])};
        e.proposed=e.active&&typeof proposed==="string"?proposed:item.ref;
        entries.push(e);
      }
      entries.sort(cmp);
      for(const e of entries){all.push(e);if(e.listed)listed.push(e);}
    }
    const active=listed.filter(e=>e.active),fixed=all.filter(e=>!e.active);
    const reset=e=>{e.proposed=prefixOf(e.proposed||e.current,e.defn,e.cfg.suffix)+"?";};

    if(action==="reset-all"||action==="annotate")for(const e of active)reset(e);
    if(action==="reset-duplicates"){
      const kept=new Map();
      for(const e of [...fixed,...active]){
        if(pending(e.proposed))continue;
        const key=upper(e.proposed),group=kept.get(key)||[];
        if(joins(group,e)){group.push(e);kept.set(key,group);continue;}
        if(e.active)reset(e);
        else issues.add("Locked or excluded designator "+e.current+" is duplicated and cannot be reset.");
      }
    }
    if(action==="update"||action==="annotate"){
      // Every numbered designator outside the run, and every proposal already
      // numbered inside it, is reserved across all sheets.
      const used=new Map(),packages=new Map(),counters=new Map();
      const reserve=(ref,e,fresh=false)=>{
        const key=upper(ref);if(!used.has(key))used.set(key,[]);used.get(key).push(e);
        if(e.unit){
          if(!packages.has(key))packages.set(key,{ref,def:e.def,units:new Set(),sheets:new Set(),fresh,count:e.unitCount,open:true});
          const p=packages.get(key);p.units.add(e.unit);p.sheets.add(e.sheet);
        }else if(packages.has(key))packages.get(key).open=false;
      };
      for(const e of all){const ref=e.active?e.proposed:e.current;if(!pending(ref))reserve(ref,e);}
      for(const p of packages.values())if((used.get(upper(p.ref))||[]).length!==p.units.size)p.open=false;
      for(const e of active){
        if(!pending(e.proposed))continue;
        const prefix=prefixOf(e.proposed||e.current,e.defn,e.cfg.suffix),suffix=e.cfg.suffix;
        if(e.unit){
          // A gate placed without a chosen unit takes the package's first free gate (U1A, then U1B…).
          const free=p=>{if(!p.units.has(e.unit))return e.unit;if(e.autoUnit&&p.count)for(let u=1;u<=p.count;u++)if(!p.units.has(u))return u;return 0;};
          const room=p=>p.open&&p.def===e.def&&free(p)&&(!p.count||p.units.size<p.count)&&
            upper(prefixOf(p.ref,e.defn,suffix))===upper(prefix)&&
            (p.fresh||e.autoUnit&&matching==="none"?p.sheets.has(e.sheet):matching==="project"||(matching==="sheet"&&p.sheets.has(e.sheet)));
          const fit=[...packages.values()].filter(room).sort((a,b)=>Number(b.fresh)-Number(a.fresh)||natural.compare(a.ref,b.ref))[0];
          if(fit){const u=free(fit);if(u!==e.unit){e.unit=u;e.unitChanged=true;}e.proposed=fit.ref;reserve(fit.ref,e);continue;}
        }
        const start=e.cfg.startIndex||1,key=upper(prefix)+"\u0000"+upper(suffix)+"\u0000"+start;
        let n=counters.get(key)||start;
        while(used.has(upper(prefix+n+suffix)))n++;
        e.proposed=prefix+n+suffix;counters.set(key,n+1);reserve(e.proposed,e,true);
      }
    }

    // Duplicates in the proposed state, across every sheet.
    const groups=new Map();
    for(const e of all){const ref=e.active?e.proposed:e.current;if(pending(ref))continue;const k=upper(ref);if(!groups.has(k))groups.set(k,[]);groups.get(k).push(e);}
    const duplicates=[];
    for(const [k,group] of groups){
      const kept=[];let bad=false;
      for(const e of group){if(joins(kept,e))kept.push(e);else bad=true;}
      if(bad){duplicates.push(group[0].active?group[0].proposed:group[0].current);for(const e of group)e.duplicate=true;}
    }
    duplicates.sort(natural.compare);
    if(duplicates.length)issues.add("Duplicate designators: "+duplicates.join(", ")+".");
    const unresolved=listed.filter(e=>e.active&&pending(e.proposed)).length;
    if(unresolved)issues.add(unresolved+" designator"+(unresolved===1?" is":"s are")+" not annotated yet.");
    const rows=listed.map(e=>({id:e.id,sheet:e.sheet,sheetName:e.sheetName,current:e.current,proposed:e.proposed,
      unit:e.unit,unitChanged:!!e.unitChanged,display:(e.active?e.proposed:e.current)+(e.unitCount>1&&!pending(e.active?e.proposed:e.current)?unitLetter(e.unit):""),locked:e.locked,changed:e.active&&(e.proposed!==e.current||!!e.unitChanged),duplicate:!!e.duplicate,
      location:[e.x,e.y],zone:[e.col,e.row]}));
    const proposed={};for(const e of active)proposed[e.id]=e.proposed;
    return {rows,changes:rows.filter(r=>r.changed),proposed,issues:[...issues],duplicates,
      options:{order,matching,action,location:options.location||"designator"}};
  }

  // Board footprints renamed to follow the schematic, paired by component link
  // (the pairing import-link.js establishes and eco.js compares).
  function backAnnotation(project,changes,boards="*"){
    const targets=project.documents.filter(d=>d.kind==="pcb"&&(boards==="*"||(Array.isArray(boards)?boards.includes(d.id):d.id===boards)));
    const renamed=new Map(changes.map(c=>[c.id,c.proposed]));
    const finalRef=new Map(),changedLinks=new Set();
    for(const d of project.documents)if(d.kind==="schematic")for(const i of d.items){
      if(i.kind!=="part"||!i.link)continue;
      if(!finalRef.has(i.link))finalRef.set(i.link,new Set());
      finalRef.get(i.link).add(renamed.has(i.id)?renamed.get(i.id):i.ref);
      if(renamed.has(i.id)&&renamed.get(i.id)!==i.ref)changedLinks.add(i.link);
    }
    const rows=[],issues=new Set();
    for(const board of targets){
      const parts=board.items.filter(i=>i.kind==="part"),byLink=new Map();
      for(const p of parts)if(p.link){if(!byLink.has(p.link))byLink.set(p.link,[]);byLink.get(p.link).push(p);}
      const renames=new Map();
      for(const link of changedLinks){
        const matches=byLink.get(link)||[],refs=[...finalRef.get(link)];
        if(!matches.length)continue;
        if(matches.length>1){issues.add(board.name+": "+matches.map(p=>p.ref).join(", ")+" share one component link.");continue;}
        const bp=matches[0];
        if(refs.length!==1){issues.add(board.name+" / "+bp.ref+": linked schematic parts disagree ("+refs.sort(natural.compare).join(", ")+").");continue;}
        if(pending(refs[0])){issues.add(board.name+" / "+bp.ref+" keeps its designator until "+refs[0]+" is annotated.");continue;}
        if(bp.designatorLocked===true){issues.add(board.name+" / "+bp.ref+" is locked.");continue;}
        if(refs[0]!==bp.ref)renames.set(bp.id,refs[0]);
      }
      // Drop renames that would duplicate a board designator. Dropping one can
      // expose another (a partial swap), so repeat until stable.
      for(let changed=true;changed;){
        changed=false;const seen=new Map();
        for(const p of parts){const k=upper(renames.get(p.id)??p.ref);if(!seen.has(k))seen.set(k,[]);seen.get(k).push(p);}
        for(const [k,group] of seen){
          if(group.length<2)continue;
          for(const p of group)if(renames.has(p.id)){issues.add(board.name+": renaming "+p.ref+" to "+renames.get(p.id)+" would duplicate designator "+k+".");renames.delete(p.id);changed=true;}
        }
      }
      for(const p of parts)if(renames.has(p.id))rows.push({board:board.id,boardName:board.name,targetId:p.id,link:p.link,before:p.ref,after:renames.get(p.id)});
    }
    rows.sort((a,b)=>natural.compare(a.boardName,b.boardName)||natural.compare(a.after,b.after));
    return {rows,issues:[...issues].sort()};
  }

  /**
   * prepare(project, result, {locks, boards}) -> {schematic, board, locks, issues, execute}
   * Checks the plan is still current and returns execute(), the mutation to run
   * inside one ctx.edit so schematic and board changes undo together.
   * boards: "*" (all), a board id, an array of ids, or null/false for none.
   */
  function prepare(project,result,options={}){
    const items=new Map();
    for(const d of project.documents)if(d.kind==="schematic")for(const i of d.items)if(i.kind==="part")items.set(i.id,i);
    for(const c of result.changes){
      const i=items.get(c.id);
      if(!i||i.ref!==c.current)throw Error("The schematic changed since these designators were proposed. Update the change list and try again.");
      if(i.designatorLocked===true&&lookup(options.locks,c.id)!==false)throw Error(c.current+" is locked.");
    }
    const lockChanges=[];
    if(options.locks)for(const [id,lock] of options.locks instanceof Map?options.locks:Object.entries(options.locks)){
      const i=items.get(id);if(i&&(i.designatorLocked===true)!==!!lock)lockChanges.push([i,!!lock]);
    }
    const board=options.boards?backAnnotation(project,result.changes,options.boards):{rows:[],issues:[]};
    const boardParts=new Map();
    for(const d of project.documents)if(d.kind==="pcb")for(const i of d.items)if(i.kind==="part")boardParts.set(i.id,i);
    const execute=()=>{
      for(const c of result.changes){const it=items.get(c.id);it.ref=c.proposed;if(c.unitChanged){it.unit=c.unit;delete it.part;}}
      for(const [i,lock] of lockChanges){if(lock)i.designatorLocked=true;else delete i.designatorLocked;}
      for(const r of board.rows)boardParts.get(r.targetId).ref=r.after;
      if(options.boards)globalThis.AtriumMultichannel?.renameChannels(project,options.boards);
      return {schematic:result.changes.length,board:board.rows.length,locks:lockChanges.length};
    };
    return {schematic:result.changes,board:board.rows,locks:lockChanges.length,issues:board.issues,execute};
  }
  const apply=(project,result,options)=>prepare(project,result,options).execute();

  // ---------------------------------------------------------------- dialog
  const SVG="http://www.w3.org/2000/svg";
  function svg(tag,attrs){const e=document.createElementNS(SVG,tag);for(const k in attrs)e.setAttribute(k,attrs[k]);return e;}
  function diagram(order){
    const root=svg("svg",{viewBox:"0 0 64 64",class:"ann-diagram","aria-hidden":"true"});
    const cells=[14,32,50];
    for(const x of cells)for(const y of cells)root.append(svg("rect",{x:x-5,y:y-4,width:10,height:8,rx:1,class:"ann-cell"}));
    const pts=[];
    const lines=order.startsWith("across")?(order==="across-up"?[...cells].reverse():cells):cells;
    for(const line of lines){
      const run=order==="up-across"?[...cells].reverse():cells;
      for(const v of run)pts.push(order.startsWith("across")?[v,line]:[line,v]);
    }
    root.append(svg("polyline",{points:pts.map(p=>p.join(",")).join(" "),class:"ann-path"}));
    const [x1,y1]=pts.at(-2),[x2,y2]=pts.at(-1),a=Math.atan2(y2-y1,x2-x1),s=5;
    const head=[[x2,y2],[x2-s*Math.cos(a-.5),y2-s*Math.sin(a-.5)],[x2-s*Math.cos(a+.5),y2-s*Math.sin(a+.5)]];
    root.append(svg("polygon",{points:head.map(p=>p.map(v=>v.toFixed(2)).join(",")).join(" "),class:"ann-head"}));
    root.append(svg("circle",{cx:pts[0][0],cy:pts[0][1],r:2.6,class:"ann-start"}));
    return root;
  }
  const remember={get(){try{return JSON.parse(localStorage.getItem("atrium-annotate-v1")||"{}")||{};}catch{return {};}},
    set(v){try{localStorage.setItem("atrium-annotate-v1",JSON.stringify(v));}catch{}}};

  function open(ctx){
    const project=ctx.project,sheets=project.documents.filter(d=>d.kind==="schematic"),boards=project.documents.filter(d=>d.kind==="pcb");
    if(!sheets.some(s=>s.items.some(i=>i.kind==="part"))){ctx.info("There are no schematic components to annotate.");return;}
    const node=(tag,text,cls)=>AtriumNavCommon.el(tag, text, cls);
    const button=(label,act,title)=>{const b=node("button",label);b.type="button";b.onclick=act;if(title)b.title=title;return b;};
    const saved=remember.get();
    const selection=typeof ctx.selection==="function"?ctx.selection():ctx.selectedIds;
    const selected=[...(selection||[])];
    const state={order:ORDERS.some(o=>o.key===saved.order)?saved.order:"up-across",matching:MATCHING.some(m=>m.key===saved.matching)?saved.matching:"none",
      sheets:Object.fromEntries(sheets.map(s=>[s.id,{enabled:true,scope:"all",startIndex:null,suffix:""}])),
      proposed:{},locks:{},boardsOn:boards.length>0,board:"*"};
    const dialog=node("dialog",null,"work-dialog annotate-dialog");dialog.setAttribute("aria-label","Annotate schematics");
    const head=node("div",null,"ann-head-row");head.append(node("h2","Annotate"),node("span","Schematic annotation configuration","ann-sub"));
    const split=node("div",null,"ann-split"),config=node("section",null,"ann-config"),changes=node("section",null,"ann-changes");

    // Order of processing.
    const orderBox=node("div",null,"ann-group");orderBox.append(node("h3","Order of Processing"));
    const orderRow=node("div",null,"ann-order"),orderSelect=node("select"),orderPic=node("div",null,"ann-figure"),orderHelp=node("small");
    orderSelect.setAttribute("aria-label","Order of processing");
    for(const o of ORDERS)orderSelect.add(new Option(o.label,o.key));
    orderSelect.value=state.order;
    const drawOrder=()=>{orderPic.replaceChildren(diagram(state.order));orderHelp.textContent=ORDERS.find(o=>o.key===state.order).help+" Positions use the designator location, bucketed by sheet zone.";};
    orderSelect.onchange=()=>{state.order=orderSelect.value;drawOrder();remember.set({...remember.get(),order:state.order});refresh("none","Order changed. Update the change list to renumber.");};
    const orderPick=node("div",null,"ann-order-pick");orderPick.append(orderSelect,orderHelp);
    orderRow.append(orderPick,orderPic);orderBox.append(orderRow);

    // Matching options.
    const multi=sheets.some(s=>s.items.some(i=>i.kind==="part"&&unitOf(i)));
    const matchBox=node("div",null,"ann-group");matchBox.append(node("h3","Matching Options"));
    const matchSelect=node("select");matchSelect.setAttribute("aria-label","Matching options");
    for(const m of MATCHING)matchSelect.add(new Option(m.label,m.key));
    matchSelect.value=multi?state.matching:"none";matchSelect.disabled=!multi;
    if(!multi)state.matching="none";
    matchSelect.onchange=()=>{state.matching=matchSelect.value;remember.set({...remember.get(),matching:state.matching});refresh("none","Matching changed. Update the change list to apply it.");};
    matchBox.append(matchSelect,node("small",multi?"Places unnumbered units into existing packages that still have free units.":"No multi-part components in this project. Each part gets its own designator."));

    // Sheets to annotate.
    const sheetBox=node("div",null,"ann-group");sheetBox.append(node("h3","Schematic Sheets To Annotate"));
    const sheetWrap=node("div",null,"ann-table-wrap ann-sheet-wrap"),sheetTable=node("table",null,"ann-table ann-sheets");
    const sh=node("thead"),shr=node("tr");
    for(const [t,title] of [["",""],["Schematic Sheet",""],["Annotation Scope",""],["Start Index","Number this sheet from a fixed index"],["Suffix","Text appended to each new designator"]]){const th=node("th",t);if(title)th.title=title;shr.append(th);}
    sh.append(shr);const sb=node("tbody");sheetTable.append(sh,sb);sheetWrap.append(sheetTable);
    for(const s of sheets){
      const cfg=state.sheets[s.id],tr=node("tr");
      const on=node("input");on.type="checkbox";on.checked=true;on.setAttribute("aria-label","Annotate "+s.name);
      on.onchange=()=>{cfg.enabled=on.checked;refresh("none");};
      const scope=node("select");scope.setAttribute("aria-label","Annotation scope for "+s.name);
      for(const o of SCOPES)if(o.key==="all"||selected.length)scope.add(new Option(o.label,o.key));
      scope.disabled=!selected.length;scope.title=selected.length?"":"Select parts in the editor to annotate or skip them.";
      scope.onchange=()=>{cfg.scope=scope.value;refresh("none");};
      const startOn=node("input");startOn.type="checkbox";startOn.setAttribute("aria-label","Use start index for "+s.name);
      const start=node("input");start.type="number";start.min="1";start.step="1";start.value="1";start.disabled=true;start.className="ann-index";start.setAttribute("aria-label","Start index for "+s.name);
      const syncStart=()=>{const n=Math.floor(Number(start.value));cfg.startIndex=startOn.checked&&n>0?n:null;start.disabled=!startOn.checked;};
      startOn.onchange=()=>{syncStart();refresh("none","Start index changed. Update the change list to renumber.");};
      start.onchange=()=>{if(!(Number(start.value)>=1))start.value="1";syncStart();refresh("none","Start index changed. Update the change list to renumber.");};
      const suffix=node("input");suffix.type="text";suffix.className="ann-suffix";suffix.maxLength=12;suffix.spellcheck=false;suffix.setAttribute("aria-label","Designator suffix for "+s.name);
      suffix.onchange=()=>{suffix.value=suffix.value.replace(/[\s?]/g,"");cfg.suffix=suffix.value;refresh("none","Suffix changed. Update the change list to renumber.");};
      const count=s.items.filter(i=>i.kind==="part").length;
      const name=node("td");name.append(node("span",s.name),node("small",count+" part"+(count===1?"":"s")));
      const startCell=node("td",null,"ann-start-cell");startCell.append(startOn,start);
      const cells=[node("td"),name,node("td"),startCell,node("td")];
      cells[0].append(on);cells[2].append(scope);cells[4].append(suffix);tr.append(...cells);sb.append(tr);
    }
    const sheetActions=node("div",null,"ann-inline");
    const setAll=v=>()=>{for(const box of sb.querySelectorAll("tr td:first-child input")){box.checked=v;}for(const s of sheets)state.sheets[s.id].enabled=v;refresh("none");};
    sheetActions.append(button("All On",setAll(true)),button("All Off",setAll(false)));
    sheetBox.append(sheetWrap,sheetActions);
    config.append(orderBox,matchBox,sheetBox);

    // Proposed change list.
    changes.append(node("h3","Proposed Change List"));
    const listWrap=node("div",null,"ann-table-wrap ann-list"),table=node("table",null,"ann-table ann-changes-table");
    const th=node("thead"),thr=node("tr");
    for(const [t,cls,title] of [["Lock","ann-lock","Locked designators are never changed"],["Current",""],["","ann-arrow"],["Proposed",""],["Location of Part",""]]){const c=node("th",t,cls);if(title)c.title=title;thr.append(c);}
    th.append(thr);const body=node("tbody");table.append(th,body);listWrap.append(table);
    const listActions=node("div",null,"ann-inline");
    const update=button("Update Changes List",()=>refresh("update"),"Number every designator that still contains ?, keeping the others.");
    const resetAll=button("Reset All",()=>refresh("reset-all"),"Propose ? for every unlocked designator in scope.");
    const resetDup=button("Reset Duplicates",()=>refresh("reset-duplicates"),"Propose ? for designators that duplicate another part.");
    listActions.append(update,resetAll,resetDup);
    const summary=node("div",null,"ann-summary");summary.setAttribute("role","status");
    const issueBox=node("details",null,"ann-issues");

    // Back-annotation.
    const back=node("fieldset",null,"ann-back");back.append(node("legend","Back Annotation"));
    const backOn=node("input");backOn.type="checkbox";backOn.checked=state.boardsOn;backOn.disabled=!boards.length;
    const backLabel=node("label",null,"ann-check");backLabel.append(backOn,node("span","Update designators of linked board footprints"));
    const boardSelect=node("select");boardSelect.setAttribute("aria-label","Board to back-annotate");
    if(boards.length>1)boardSelect.add(new Option("All boards","*"));
    for(const b of boards)boardSelect.add(new Option(b.name,b.id));
    boardSelect.value=boards.length>1?"*":boards[0]?.id||"";boardSelect.disabled=!boards.length;state.board=boardSelect.value||"*";
    const backNote=node("small");
    backOn.onchange=()=>{state.boardsOn=backOn.checked;boardSelect.disabled=!backOn.checked;render();};
    boardSelect.onchange=()=>{state.board=boardSelect.value;render();};
    const backRow=node("div",null,"ann-inline");backRow.append(backLabel,boardSelect);
    back.append(backRow,backNote);
    changes.append(listWrap,listActions,summary,issueBox,back);
    split.append(config,changes);

    const status=node("div",null,"ann-status ui-dialog-status");status.setAttribute("role","status");
    const actions=node("div",null,"work-actions");
    const eco=button("Review Board ECO…",()=>{
      const target=boards.find(b=>b.id===state.board)||boards[0];dialog.close();
      AtriumECO.open({...ctx,doc:target});
    },"Engineering Change Order (ECO): the list of changes to apply to the board. Compares linked schematic parts with the board and applies the differences.");
    eco.hidden=!globalThis.AtriumECO||!boards.length;
    const accept=button("Accept Changes (Create ECO)",acceptChanges,"Renumber the designators. ECO = Engineering Change Order: the same renaming is recorded as a list of changes for the board, so the board can follow.");
    accept.classList.add("is-primary");accept.dataset.uiDefault="false";
    // The status shares the action row so it can never be squeezed out of a short dialog.
    actions.append(status,button("Close",()=>dialog.close()),eco,accept);
    dialog.append(head,split,actions);

    let result=null,job=null,known=ctx.revision?.();
    // Undo or edits elsewhere replace or change the project behind the dialog.
    const stale=()=>ctx.revision&&ctx.revision()!==known;
    function options(action){
      return {order:state.order,matching:state.matching,action,sheets:state.sheets,proposed:state.proposed,locks:state.locks,selected};
    }
    function refresh(action,message=""){
      try{
        result=plan(project,options(action));
        state.proposed=result.proposed;
        status.textContent=message;
      }catch(e){status.textContent=e.message;}
      render();
    }
    function render(){
      if(!result)return;
      body.replaceChildren();
      const frag=document.createDocumentFragment();
      for(const r of result.rows){
        const tr=node("tr");
        if(r.changed)tr.classList.add("is-changed");if(r.locked)tr.classList.add("is-locked");if(r.duplicate)tr.classList.add("is-duplicate");
        const lock=node("input");lock.type="checkbox";lock.checked=r.locked;lock.setAttribute("aria-label","Lock "+r.current);
        lock.onchange=()=>{state.locks[r.id]=lock.checked;if(lock.checked)delete state.proposed[r.id];refresh("none",lock.checked?r.current+" locked.":r.current+" unlocked.");};
        const u=unitLetter(r.unit);
        const cells=[node("td",null,"ann-lock"),node("td",r.current+(u?" "+u:""),"ann-ref"),node("td","→","ann-arrow"),
          node("td",r.proposed+(u?" "+u:""),"ann-ref ann-proposed"),node("td",r.sheetName,"ann-where")];
        cells[0].append(lock);
        if(r.duplicate)cells[3].title="Duplicate designator";
        tr.append(...cells);frag.append(tr);
      }
      body.append(frag);
      if(!result.rows.length){const tr=node("tr"),td=node("td","No parts in the selected sheets and scope.","ann-empty");td.colSpan=5;tr.append(td);body.append(tr);}
      const pendingCount=result.rows.filter(r=>!r.locked&&pending(r.proposed)).length;
      const lockCount=result.rows.filter(r=>r.locked).length;
      summary.textContent=result.rows.length+" parts · "+result.changes.length+" to change"+(lockCount?" · "+lockCount+" locked":"")+
        (pendingCount?" · "+pendingCount+" unannotated":"")+(result.duplicates.length?" · "+result.duplicates.length+" duplicated":"");
      job=null;let boardIssues=[];
      try{
        job=prepare(project,result,{locks:state.locks,boards:state.boardsOn&&boards.length?state.board:null});
        boardIssues=job.issues;
      }catch(e){status.textContent=e.message;}
      if(!boards.length)backNote.textContent="This project has no board layout.";
      else if(!state.boardsOn)backNote.textContent="Board footprints keep their designators. Use Review Board ECO… later to compare.";
      else backNote.textContent=job?(job.board.length?job.board.length+" linked footprint"+(job.board.length===1?"":"s")+" will be renamed in the same undo step.":"No linked footprints need renaming."):"";
      const issues=[...result.issues,...boardIssues];
      issueBox.replaceChildren();issueBox.hidden=!issues.length;
      if(issues.length){issueBox.append(node("summary",issues.length+" note"+(issues.length===1?"":"s")));const ul=node("ul");for(const m of issues)ul.append(node("li",m));issueBox.append(ul);}
      const work=job?job.schematic.length+job.locks:0;
      if(stale())status.textContent="The project changed outside this dialog. Close and reopen Annotate.";
      accept.disabled=!job||!work||stale();
      accept.title=job&&work?job.schematic.length+" schematic"+(job.board.length?" and "+job.board.length+" board":"")+" designator changes":"No changes to accept";
    }
    function acceptChanges(){
      if(!job)return;
      if(stale()){status.textContent="The project changed outside this dialog. Close and reopen Annotate.";accept.disabled=true;return;}
      try{
        const fresh=prepare(project,result,{locks:state.locks,boards:state.boardsOn&&boards.length?state.board:null});
        let counts=null;ctx.edit(()=>{counts=fresh.execute();});known=ctx.revision?.();
        const parts=[counts.schematic+" schematic designator"+(counts.schematic===1?"":"s")];
        if(counts.board)parts.push(counts.board+" board designator"+(counts.board===1?"":"s"));
        if(counts.locks)parts.push(counts.locks+" lock"+(counts.locks===1?"":"s"));
        const message="Updated "+parts.join(", ")+". Undo reverts the whole annotation.";
        ctx.info(message);
        state.proposed={};state.locks={};
        refresh("none",message);
      }catch(e){status.textContent=e.message;}
    }
    drawOrder();
    document.body.append(dialog);dialog.onclose=()=>dialog.remove();
    globalThis.AtriumShell?.adoptDialog?.(dialog, {title:head.querySelector("h2"), body:split, actions});
    refresh("none");dialog.showModal();
  }
  return {ORDERS,MATCHING,SCOPES,plan,prepare,apply,backAnnotation,prefixOf,location,regions,open};
})();
