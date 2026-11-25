"use strict";

globalThis.AtriumBlocks = (() => {
  const A=Atrium;
  if(!globalThis.AtriumPlacement && typeof require==="function")require("../pcb/placement.js");
  const P=AtriumPlacement;
  const types=new Set(["part","track","via","pad","graphic","label"]);
  const rectangle=(a,b)=>[Math.min(a[0],b[0]),Math.min(a[1],b[1]),Math.max(a[0],b[0]),Math.max(a[1],b[1])];
  const finitePoint=p=>Array.isArray(p)&&p.length===2&&p.every(n=>Number.isFinite(n)&&Math.abs(n)<1e8);
  let gesture=null;

  function validate(block) {
    if(block?.format!=="atrium-block" || block.version!==1 || typeof block.name!=="string" || !block.name.trim() ||
       !finitePoint(block.size)||block.size.some(n=>n<=0)||!Array.isArray(block.items)||!block.items.length ||
       !block.items.every(i=>types.has(i?.kind))||!Array.isArray(block.library))throw Error("Invalid Waffle layout block.");
    const doc=A.sheet("pcb","Block");
    doc.items=block.items;
    A.validate({format:"atrium",version:1,name:block.name,documents:[doc],library:block.library});
    const used=new Set(block.items.filter(i=>i.kind==="part").map(i=>i.def));
    if(block.library.some(d=>!used.has(d.id)))throw Error("The block contains an unused definition.");
    for(const entity of netObjects(block))if(entity.net!=null&&typeof entity.net!=="string")throw Error("Invalid block net name.");
    return block;
  }

  function capture(doc,defs,a,b,name) {
    if(doc.kind!=="pcb"||!finitePoint(a)||!finitePoint(b))throw Error("Select an area on a PCB.");
    const [x0,y0,x1,y1]=rectangle(a,b), items=[], library=[], locals=new Map();
    if(x0===x1||y0===y1)throw Error("Choose two corners of a rectangle with an area.");
    for(const source of doc.items){
      if(!types.has(source.kind))continue;
      const def=defs.get(source.def), box=A.bounds(A.itemPoints(source,def,"pcb"));
      if(!box||box[0]<x0||box[1]<y0||box[2]>x1||box[3]>y1)continue;
      const item=A.clone(source);
      delete item.sourceRecord;
      item.id="item-"+(items.length+1);
      if(item.kind==="part"){
        if(!def?.footprint)throw Error("A selected component has no footprint.");
        if(!locals.has(def.id)){
          const copy=A.clone(def);copy.id="footprint-"+(library.length+1);locals.set(def.id,copy.id);library.push(copy);
        }
        item.def=locals.get(def.id);
        delete item.link;
      }
      A.moveItem(item,-x0,-y0);items.push(item);
    }
    if(!items.length)throw Error("The rectangle contains no complete PCB objects.");
    return validate({format:"atrium-block",version:1,name:name.trim()||"Layout block",size:[x1-x0,y1-y0],library,items});
  }

  function* netObjects(block) {
    yield* block.items;
    for(const d of block.library){
      yield* (d.footprint?.pads||[]);
      yield* (d.footprint?.shapes||[]);
    }
  }

  function netNames(block) {
    const names=new Set();
    for(const v of netObjects(block)){
      if(v.net)names.add(v.net);
      for(const n of Object.values(v.pinNets||{}))if(n)names.add(n);
    }
    return [...names].sort((a,b)=>a.localeCompare(b));
  }

  function boardNets(project) {
    const names=new Set(),defs=new Map(project.library.map(d=>[d.id,d]));
    for(const doc of project.documents){
      if(doc.kind==="schematic"){
        for(const net of A.connectivity(doc,defs).nets)names.add(net.name);
        continue;
      }
      const placed=new Set(doc.items.filter(i=>i.kind==="part").map(i=>i.def));
      for(const n of netNames({items:doc.items,library:project.library.filter(d=>placed.has(d.id))}))names.add(n);
    }
    return names;
  }

  function remapEntities(objects,map) {
    for(const obj of objects){
      if(obj.net)obj.net=map.get(obj.net);
      if(obj.pinNets)obj.pinNets=Object.fromEntries(Object.entries(obj.pinNets).map(([pin,net])=>[pin,net?map.get(net):""]));
    }
  }

  // Plan the entire paste before beginning an editor history transaction.
  function prepare(project,block,point,mapping=new Map()) {
    validate(block);
    if(!finitePoint(point))throw Error("Invalid block insertion point.");
    const existing=boardNets(project), sources=netNames(block);
    const specified=new Set();
    for(const [from,to] of mapping){
      if(!sources.includes(from)||!existing.has(to))throw Error("Choose a net that exists in the destination project.");
      if(specified.has(to))throw Error("Two block nets cannot share the same destination net.");
      specified.add(to);
    }
    const nets=new Map(mapping),local=sources.filter(s=>!mapping.has(s));
    let instance=1;
    while(local.some(s=>existing.has("B"+instance+"/"+s)))instance++;
    for(const name of local)nets.set(name,"B"+instance+"/"+name);
    const copies=A.clone({items:block.items,library:block.library});
    remapEntities(netObjects(copies),nets);
    const newDefs=[],defIds=new Map(),registry=new Map(project.library.map(d=>[P.definitionKey(d),d.id]));
    for(const def of copies.library){
      const old=def.id,key=P.definitionKey(def);
      if(!registry.has(key)){
        def.id=A.id();registry.set(key,def.id);newDefs.push(def);
      }
      defIds.set(old,registry.get(key));
    }
    const nextRef=P.refAllocator(project);
    for(const item of copies.items){
      P.newInstance(item);
      if(item.kind==="part"){
        const prefix=item.ref.match(/^(.*?)(?:\d+[a-z]?)$/i)?.[1]||item.ref.replace(/[^A-Za-z_]+/g,"")||"U";
        item.ref=nextRef(prefix);
        item.def=defIds.get(item.def);
      }
      A.moveItem(item,point[0],point[1]);
    }
    return {items:copies.items,library:newDefs,nets};
  }

  function sizeLabel(size) {return size.map(n=>Number(n.toFixed(2))).join(" × ")+" mm";}
  function element(tag,text,className) { return AtriumNavCommon.el(tag, text, className); }
  function button(parent,label,fn) {
    const b=element("button",label);b.type="button";b.onclick=fn;parent.append(b);return b;
  }
  function row(parent,className="work-toolbar") {
    const e=element("div",null,className);parent.append(e);return e;
  }
  function dialog(title) {
    const dlg=element("dialog",null,"work-dialog blocks-dialog"),h=element("h2",title);h.id="blocks-title-"+A.id();
    dlg.setAttribute("aria-labelledby",h.id);dlg.append(h);
    document.body.append(dlg);dlg.addEventListener("close",()=>dlg.remove(),{once:true});return dlg;
  }
  function footer(dlg) {return row(dlg,"work-actions");}
  function show(dlg, initialFocus) {
    const [title, ...body] = dlg.children;
    const actions = body.pop();
    globalThis.AtriumShell?.adoptDialog?.(dlg, {title, body, actions, initialFocus});
    dlg.showModal();
  }
  function primary(b) {b.classList.add("is-primary");return b;}
  // Errors sit above the footer and are announced; repeated errors replace each other.
  function say(dlg,text) {
    let n=dlg.querySelector(".work-error");
    if(!n){n=element("p",null,"work-note work-error");n.setAttribute("role","alert");const f=dlg.querySelector(".work-actions");if(f)f.before(n);else dlg.append(n);}
    n.textContent=text;return n;
  }
  function tip(parent,text) {
    const n=element("p",text,"work-note");parent.append(n);return n;
  }
  function uniqueName(project,name){
    const used=new Set((project.layoutBlocks||[]).map(b=>b.name));
    let s=name,n=2;while(used.has(s))s=name+" ("+(n++)+")";return s;
  }
  function addBlock(ctx,block) {
    const copy=A.clone(validate(block));copy.name=uniqueName(ctx.project,copy.name);copy.id=A.id();
    ctx.edit(()=>{ctx.project.layoutBlocks||=[];ctx.project.layoutBlocks.push(copy);});
    return copy;
  }
  function arm(ctx,mode,values={}) {gesture={ctx,mode,...values};}
  function open(ctx) {
    if(ctx.doc.kind!=="pcb"){ctx.info("Choose a PCB layout to work with reusable blocks.");return;}
    cancel();
    const dlg=dialog("Layout blocks"), buttons=row(dlg);
    button(buttons,"Capture area",()=>{
      dlg.close();arm(ctx,"capture");ctx.info("Choose the first corner of the area to copy. Escape cancels.");
    });
    button(buttons,"Import block…",async()=>{
      try{
        const file=await ctx.pickFile([".waffle-block"]);if(!file)return;
        const block=addBlock(ctx,JSON.parse(await file.text()));
        dlg.close();placeDialog(ctx,block);
      }catch(error){ctx.info(error.message);say(dlg,"Couldn’t import that block: "+error.message);}
    });
    const stored=ctx.project.layoutBlocks||[];
    if(!stored.length)tip(dlg,"Capture a rectangle around a layout to reuse its footprints, tracks and vias.");
    for(const block of stored){
      const r=row(dlg,"work-item"),left=element("div");
      left.append(element("strong",block.name),element("small",block.items.length+" objects · "+sizeLabel(block.size)));r.append(left);
      button(r,"Place",()=>{dlg.close();placeDialog(ctx,block);});
      button(r,"Export…",async()=>{
        try {
          const ok=await ctx.exportFile(block.name.replace(/[\\/:*?"<>|\x00-\x1f]/g,"_")+".waffle-block",JSON.stringify(block,null,2));
          if(ok!==false)ctx.info("Exported "+block.name+".");
        }catch(error){ctx.info(error.message);}
      });
    }
    primary(button(footer(dlg),"Close",()=>dlg.close()));show(dlg);
  }
  function captureDialog(ctx,block) {
    const dlg=dialog("Save layout block");
    tip(dlg,block.items.length+" PCB objects · "+sizeLabel(block.size));
    const field=element("label",null,"work-form"),input=element("input");input.value=block.name;
    field.append(element("span","Block name"),input);dlg.append(field);
    const controls=footer(dlg);
    function save(place){
      const name=input.value.trim();if(!name){input.focus();return;}
      const saved=addBlock(ctx,{...block,name});dlg.close();
      if(place)placeDialog(ctx,saved);else ctx.info("Saved "+saved.name+" to this project.");
    }
    button(controls,"Cancel",()=>dlg.close());button(controls,"Save and place",()=>save(true));primary(button(controls,"Save block",()=>save(false)));
    input.onkeydown=e=>{if(e.key==="Enter"){e.preventDefault();save(false);}};
    show(dlg,input);input.focus();input.select();
  }
  function placeDialog(ctx,block) {
    const dlg=dialog("Place "+block.name),mapping=new Map(),destinations=[...boardNets(ctx.project)].sort();
    tip(dlg,"Each copy gets new designators and separate nets. Map individual nets to make intended connections.");
    const names=netNames(block);
    if(names.length&&destinations.length){
      const details=element("details"),grid=element("div",null,"work-form");details.append(element("summary","Net connections ("+names.length+")"),grid);dlg.append(details);
      for(const name of names){
        const label=element("label");
        label.append(element("span",name));const select=element("select");select.setAttribute("aria-label","Connect "+name);
        select.append(new Option("New isolated net",""));for(const dest of destinations)select.append(new Option(dest,dest));
        select.onchange=()=>{if(select.value)mapping.set(name,select.value);else mapping.delete(name);};
        label.append(select);grid.append(label);
      }
    }
    const r=footer(dlg);button(r,"Cancel",()=>dlg.close());
    primary(button(r,"Choose position",()=>{
      if(new Set(mapping.values()).size!==mapping.size){ctx.info("Each block net needs a separate destination.");say(dlg,"Two block nets point at the same board net. Choose a different destination for each net, or leave one as a new isolated net.");return;}
      dlg.close();arm(ctx,"place",{block,mapping});ctx.info("Click to place the block’s top-left corner. Escape cancels.");
    }));show(dlg);
  }
  function canvasClick(point) {
    if(!gesture)return false;
    const g=gesture,{ctx}=g;
    try{
      if(g.mode==="capture"){
        if(!g.start){g.start=[...point];ctx.info("Choose the opposite corner. Only complete objects are copied.");return true;}
        const block=capture(ctx.doc,ctx.defs,g.start,point,uniqueName(ctx.project,"Layout block"));
        gesture=null;ctx.refresh();captureDialog(ctx,block);
      }else{
        const plan=prepare(ctx.project,g.block,point,g.mapping);
        gesture=null;
        ctx.edit(()=>{for(const d of plan.library)ctx.project.library.push(d);for(const i of plan.items)ctx.doc.items.push(i);});
        ctx.info("Placed "+g.block.name+" · "+plan.items.length+" objects");
      }
    }catch(error){ctx.info(error.message);}
    return true;
  }
  function cancel(){const was=!!gesture;gesture=null;return was;}
  function overlay(cursor) {
    const g=gesture;if(!g||!finitePoint(cursor))return null;
    let a,b;if(g.mode==="capture"){if(!g.start)return null;a=g.start;b=cursor;}
    else {a=cursor;b=[a[0]+g.block.size[0],a[1]+g.block.size[1]];}
    const [x,y,x1,y1]=rectangle(a,b);
    return {kind:"graphic",layer:"Mechanical",width:.12,closed:true,points:[[x,y],[x1,y],[x1,y1],[x,y1]]};
  }
  return {open,canvasClick,cancel,overlay,capture,prepare,validate,netNames};
})();
