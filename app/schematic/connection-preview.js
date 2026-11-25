"use strict";

globalThis.AtriumConnectionPreview = (() => {
  const G=globalThis, H=G.AtriumHierarchy, C=G.AtriumNavCommon, S=G.AtriumSheetConnections, T=G.AtriumConnectionThumbnails;
  const hover=G.AtriumCanvasHover;
  const DWELL=300, LEAVE=180, PAGE=8, POWER=3, LARGE=60000;
  let host, prepared, prepTicket=0, compileTicket=0, demand=false;
  let card, pinned, focusEntry=null, occurrence=null, pendingProbe=null, flash;
  let chooser=false;
  const visible=()=>document.visibilityState!=="hidden" && G.AtriumPower?.visible?.()!==false;
  const efficient=()=>!!G.AtriumPower?.efficient?.();
  const sameGeneration=p=>p && p.project===host.project() && p.rev===host.revision();
  const current=()=>sameGeneration(prepared) && !host.drag?.()?.before ? prepared.index : null;
  const idle=fn=>G.AtriumIdle.idle(fn,{timeout:120});
  // A hover that dwells on a connector asks for its connections, in Efficiency mode too; only a very
  // large project there waits for an explicit Load, since its compile is the costly part.
  const sheetItems=p=>p.documents.reduce((n,d)=>n+(d.kind==="schematic" ? d.items.length : 0),0);
  const manual=()=>efficient() && sheetItems(host.project())>LARGE;
  function cancelPreparation() {
    if (compileTicket) G.AtriumIdle.cancel(compileTicket);
    if (prepTicket) G.AtriumIdle.cancel(prepTicket);
    prepTicket=compileTicket=0; demand=false;
  }
  function compiled(project, result) {
    if (!host || host.project()!==project || !visible()) return;
    if (prepared?.compiled===result && prepared.index) {
      prepared.rev=host.revision(); updateLists(); return;
    }
    if (sameGeneration(prepared) && prepared.compiled===result && prepTicket) return;
    if (efficient() && !demand && !card && !pinned?.root.isConnected) return;
    if (prepTicket) G.AtriumIdle.cancel(prepTicket);
    const partial=host.folderProject?.()?.completeFor("schematic-connections")===false;
    const p=prepared={project,rev:host.revision(),compiled:result,index:null,partial};
    const it=S.stages(result);
    function slice() {
      prepTicket=0;
      if (p!==prepared || !sameGeneration(p) || !visible()) return;
      const until=performance.now()+3;
      let next;
      do {next=it.next();} while (!next.done && performance.now()<until);
      if (!next.done) {prepTicket=idle(slice); return;}
      p.index=next.value; demand=false; updateLists();
    }
    prepTicket=idle(slice);
  }
  // Only document opens, committed edits and explicit user actions request a
  // compilation. Hover can consume a published generation or wait for it.
  function prepare(explicit=false) {
    if (!host || !visible() || !host.panes().some(p=>host.docById(p.docId)?.kind==="schematic") && !explicit) return;
    if (explicit) demand=true;
    const p=host.project(), rev=host.revision(), cached=H.peek(p,rev);
    if (cached) {compiled(p,cached); return;}
    if (compileTicket || !explicit && efficient()) return;
    compileTicket=idle(()=>{
      compileTicket=0;
      if (p!==host.project() || rev!==host.revision() || !visible() || host.drag()?.before || efficient() && !demand) return;
      if (!H.peek(p,rev)) H.compileCached(p,{defs:host.defs(),editorRevision:rev});
      else compiled(p,H.peek(p,rev));
    });
  }
  function read() {
    if (current()) return;
    const p=host.project(), result=H.peek(p,host.revision());
    if (result) compiled(p,result);
  }
  function setOccurrence(next) {
    const changed = occurrence?.docId !== next?.docId || occurrence?.instanceId !== next?.instanceId;
    occurrence = next;
    if (changed) G.AtriumNetsTable?.schedule();
    return changed;
  }
  function activateInstance(docId,instanceId) {
    const changed = setOccurrence(instanceId ? {docId,instanceId} : null);
    updateLists();
    if (changed && host?.highlight?.()) host.invalidate();
  }
  const location=()=>({occurrence,entry:focusEntry});
  function restoreLocation(l) {setOccurrence(l?.occurrence || null); focusEntry=l?.entry || null;}
  function setTarget(t) {
    setOccurrence(t.instance ? {docId:t.doc.id,instanceId:t.instance.id} : null);
    focusEntry=t.entry ? {docId:t.doc.id,itemId:t.item.id,entryId:t.entry.id} : null;
  }
  function describe(t) {
    const dir=t.kind==="port" || t.kind==="entry" || t.kind==="offsheet" && t.io!=="unspecified";
    return (S.labels[t.kind] || "Wire") + (t.name ? " " +t.name : "") + (dir ? " · "+t.io : "");
  }
  const sheetName=t=>t.doc.name+(t.instance?.suffix ? " · "+t.instance.suffix.slice(1) : t.instance?.parent && current()?.compiled.instances.filter(i=>i.doc===t.doc).length>1 ? " · "+t.instance.label : "");
  function sourceOf(hit) {
    if (hit?.doc.kind!=="schematic" || !hit.item) return null;
    const item=hit.item;
    const entry=item.kind==="sheetsymbol" ? G.AtriumSchObjects.entryAt(item,hit.point,5/hit.pane.view.scale()) : null;
    const kind=entry ? "entry" : H.sourceType(item);
    return kind ? {doc:hit.doc,item,entry,kind,name:entry?.name ?? item.text,io:S.direction(entry || item),pane:hit.pane} : null;
  }
  const sameSource=(a,b)=>a && b && a.pane.canvas===b.pane.canvas && a.doc===b.doc && a.item===b.item && a.entry===b.entry;
  const cameraChanged=(a,b)=>a.cx!==b.cx || a.cy!==b.cy || a.scale!==b.scale || a.rotation!==b.rotation || a.flipped!==b.flipped;
  function resultFor(t) {
    const graph=current();
    const inst=occurrence?.docId===t.doc.id ? occurrence.instanceId : null;
    const limit=t.kind==="power" ? POWER : undefined;
    const row=graph?.targetsFor(t.doc.id,t.item.id,t.entry?.id,inst,limit);
    return row || (inst && graph?.targetsFor(t.doc.id,t.item.id,t.entry?.id,null,limit));
  }
  function screenBox(t,pane) {
    const r=pane.canvas.getBoundingClientRect(), b=T.bounds(t);
    const a=pane.view.worldToScreen(b.slice(0,2)), z=pane.view.worldToScreen(b.slice(2));
    return [r.left+Math.min(a[0],z[0]),r.top+Math.min(a[1],z[1]),r.left+Math.max(a[0],z[0]),r.top+Math.max(a[1],z[1])];
  }
  function clearFlash() {if (flash) {clearTimeout(flash.timer); flash.node.remove(); flash=null;}}
  function placeFlash() {
    if (!flash) return;
    const pane=host.panes().find(p=>p.docId===flash.target.doc.id);
    if (!pane) {clearFlash(); return;}
    const [x,y,right,bottom]=screenBox(flash.target,pane);
    Object.assign(flash.node.style,{left:(x-4)+"px",top:(y-4)+"px",width:(right-x+8)+"px",height:(bottom-y+8)+"px"});
  }
  function flashTarget(t) {
    clearFlash();
    const node=C.el("div",null,"sheet-connection-flash"); node.setAttribute("aria-hidden","true");
    document.body.append(node); flash={target:t,node,timer:setTimeout(clearFlash,740)}; placeFlash();
  }
  function jump(t) {
    if (!host || host.docById(t.doc.id)!==t.doc || !t.doc.items.includes(t.item)) return false;
    close();
    return G.AtriumCamera.jump(t.doc.id,()=>{
      setTarget(t); host.select([t.item.id]); host.zoomTo(C.grow(T.bounds(t),3));
      host.canvas().focus({preventScroll:true}); flashTarget(t);
    });
  }
  // With an inactive split pane, cross-probing keeps its focus on the board.
  function probe(targets,net,keyboard) {
    if (!targets.length) return false;
    const pane=host.panes().find(p=>host.docById(p.docId)?.kind==="schematic");
    const t=targets.find(t=>t.doc.id===pane?.docId) || targets[0];
    if (!pane || pane.active) {
      const ok=jump(t); if (ok) host.setHighlight(net); return ok;
    }
    const ok=G.AtriumCrossProbe?.go({docId:t.doc.id,ids:[t.item.id],net,box:C.grow(T.bounds(t),3),label:describe(t),kind:"net"},keyboard) ?? false;
    if (ok) {pendingProbe=t; flashTarget(t);}
    return ok;
  }
  function stopList(view) {view?.abort?.abort(); view?.observer?.disconnect();}
  function close() {
    hover.cancel("connection"); hover.release("connection"); chooser=false;
    if (!card) return;
    const {root}=card; stopList(card); card=null;
    const focused=root.contains(document.activeElement);
    root.remove(); if (focused) host.canvas()?.focus({preventScroll:true});
  }
  function settleLeave() {
    hover.cancel("connection");
    if (card && !chooser && !card.root.contains(document.activeElement)) hover.leave("connection",LEAVE,close);
  }
  function position(view) {
    const {root,t}=view, area=t.pane.canvas.getBoundingClientRect();
    const [x,y,r,b]=screenBox(t,t.pane), w=root.offsetWidth,h=root.offsetHeight, gap=9, margin=4;
    const top=margin+parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--window-caption-height"))||margin; // below the title bar
    const box={left:margin, top, right:innerWidth-margin, bottom:innerHeight-margin};
    const anchor={left:x, top:y, right:r, bottom:b};
    const spec={gap, order:["right", "left", "bottom", "top"], ranks:["start"]};
    const inside=rect=>rect.left>=area.left && rect.right<=area.right && rect.top>=area.top && rect.bottom<=area.bottom;
    const p=hover.firstFit(anchor, w, h, box, {...spec, clear:inside}) || hover.firstFit(anchor, w, h, box, spec);
    if (!p) {close(); return;}
    root.style.left=p.left+"px"; root.style.top=p.top+"px";
    view.rect=[p.left, p.top, p.left+w, p.top+h];
  }
  function targetRow(view,t) {
    const row=C.button(null,()=>jump(t),"sheet-connection-target ui-button");
    row.dataset.doc=t.doc.id; row.dataset.item=t.item.id; row.dataset.instance=t.instance.id;
    if (t.entry) row.dataset.entry=t.entry.id;
    const thumbnail=C.el("canvas"); thumbnail.setAttribute("aria-hidden","true");
    const text=C.el("span",null,"sheet-connection-caption"); text.append(C.el("strong",sheetName(t)),C.el("small",describe(t)));
    row.append(thumbnail,text); view.targets.set(thumbnail,t);
    return row;
  }
  function thumbnails(view) {
    const signal=view.abort.signal;
    if (!view.root.isConnected) return;
    if (typeof IntersectionObserver==="undefined") {for (const [node,t] of view.targets) T.request(host,node,t,signal); return;}
    view.observer=new IntersectionObserver(entries=>{
      if (signal.aborted) return;
      for (const e of entries) if (e.isIntersecting) {
        view.observer.unobserve(e.target); T.request(host,e.target,view.targets.get(e.target),signal);
      }
    });
    for (const n of view.targets.keys()) view.observer.observe(n);
  }
  function render(view) {
    stopList(view); view.abort=new AbortController(); view.targets=new Map();
    const {body,t}=view, res=resultFor(t);
    const oldTop=body.scrollTop; body.replaceChildren();
    if (!res) {
      body.append(C.el("p","Waiting for sheet connections…","sheet-connection-summary"));
      if (manual()) body.append(C.button("Load connections",()=>prepare(true),"sheet-connection-more ui-button"));
    } else {
      const list=view.direct && t.kind!=="power" && res.direct.length ? res.direct : res.targets;
      if (t.kind==="power") body.append(C.el("p",t.name+": "+res.count+" "+(res.count===1?"connection":"connections")+" on "+res.sheets+" "+(res.sheets===1?"sheet":"sheets"),"sheet-connection-summary"));
      if (prepared?.partial) body.append(C.el("p","Showing connections on loaded sheets","sheet-connection-summary"));
      else if (!res.otherSheet) body.append(C.el("p","Not connected to any other sheet","sheet-connection-summary"));
      if (res.count && t.kind!=="power") body.append(C.el("p",list.length+" "+(list.length===1?"connection":"connections"),"sheet-connection-summary"));
      const limit=t.kind==="power" ? POWER : view.limit;
      for (const dest of list.slice(0,limit)) body.append(targetRow(view,dest));
      if (t.kind!=="power" && list.length>limit) body.append(C.button("Show more connections ("+(list.length-limit)+")",()=>{
        view.limit+=PAGE; render(view); body.querySelectorAll(".sheet-connection-target")[limit]?.focus();
      },"sheet-connection-more ui-button"));
      for (const msg of (view===card ? res.ignored.slice(0,1) : res.ignored)) body.append(C.el("p",msg,"sheet-connection-reason"));
    }
    body.scrollTop=oldTop; thumbnails(view);
    if (view===card) position(view);
  }
  function updateLists() {
    if (card?.awaitDirect && current()) {
      card.awaitDirect=false;
      const res=resultFor(card.t);
      if (res?.direct.length===1 && (card.t.kind!=="power" || res.count===1)) {jump(res.direct[0]); return;}
    }
    if (card) render(card);
    if (card && chooser && !card.root.contains(document.activeElement)) card.root.querySelector("button")?.focus({preventScroll:true});
    if (pinned?.root.isConnected) render(pinned); else {stopList(pinned); pinned=null;}
  }
  function open(t,direct=false,explicit=direct) {
    if (explicit) hover.dismiss();
    close();
    function present() {
      chooser=explicit;
      const root=C.el("section",null,"sheet-connection-card"), title=C.el("h3",describe(t),"sheet-connection-title");
      root.setAttribute("role","region"); root.setAttribute("aria-label","Connections for "+describe(t));
      const body=C.el("div",null,"sheet-connection-list"); root.append(title,body); document.body.append(root);
      root.addEventListener("pointerenter",()=>hover.stay("connection")); root.addEventListener("pointerleave",settleLeave);
      root.addEventListener("focusout",e=>{
        if (!root.contains(e.relatedTarget) && !root.matches(":hover")) hover.leave("connection",LEAVE,close);
      });
      card={root,body,t,direct,limit:PAGE,camera:t.pane.view.camera()}; render(card); read();
      if (!current() && !manual()) prepare(true);
      if (direct) root.querySelector("button")?.focus({preventScroll:true});
      return !!card;
    }
    if (explicit) present();
    else hover.show("connection",t.pane.canvas,present);
  }
  function direct(hit) {
    const t=sourceOf(hit); if (!t) return false;
    const res=resultFor(t);
    if (res?.direct.length===1 && (t.kind!=="power" || res.count===1)) return jump(res.direct[0]);
    // The explicit command may prepare a cold project. Re-evaluate after the
    // asynchronous compile so a single destination still jumps directly.
    open(t,true);
    if (!res && card) {card.awaitDirect=true; prepare(true);}
    return true;
  }
  function properties(panel,doc,item) {
    if (!item || doc.kind!=="schematic") return;
    stopList(pinned); pinned=null;
    const existing=panel.querySelector(".sheet-connection-properties"); existing?.remove();
    let entry=null;
    if (item.kind==="sheetsymbol") {
      if (!item.entries?.length) return;
      entry=item.entries.find(e=>e.id===focusEntry?.entryId && item.id===focusEntry.itemId && doc.id===focusEntry.docId) || item.entries[0];
    }
    const kind=entry ? "entry" : H.sourceType(item);
    if (!kind) return;
    const root=host.ui.section(panel,"Connects to"); root.classList.add("sheet-connection-properties");
    if (entry && item.entries.length>1) {
      const select=C.el("select"); select.setAttribute("aria-label","Sheet entry for connections");
      for (const e of item.entries) select.add(new Option(e.name,e.id));
      select.value=entry.id;
      select.onchange=()=>{focusEntry={docId:doc.id,itemId:item.id,entryId:select.value}; properties(panel,doc,item); panel.querySelector(".sheet-connection-properties select")?.focus();};
      root.append(select);
    }
    const body=C.el("div",null,"sheet-connection-list");
    root.append(body);
    pinned={root,body,t:{doc,item,entry,kind,name:entry?.name ?? item.text},limit:PAGE};
    render(pinned); if (!current()) prepare(true);
  }
  function refreshProperties() {
    const [id,...rest]=host.selection(), d=host.doc();
    if (id && !rest.length && d.kind==="schematic") properties(document.getElementById("inspector"),d,d.items.find(i=>i.id===id));
  }
  function attach(h) {
    if (host===h) return;
    host=h;
    hover.register("connection",{
      hide:close, contains:target=>card?.root.contains(target),
      over:(_canvas,_x,_y,hit)=>sourceOf(hit)
    });
    const paneAt=e=>e.target?.tagName==="CANVAS" && e.target.closest("#editor-panes") && h.panes().find(p=>p.canvas===e.target && h.docById(p.docId)?.kind==="schematic");
    // macOS Chromium sends contextmenu for Control+primary click, without a
    // click/dblclick. Finish a matching pair after the editor releases the drag.
    let lastControl=null, pendingControl=null, completedControl=null;
    const near=(a,e)=>a && a.canvas===e.target && Math.hypot(a.x-e.clientX,a.y-e.clientY)<5;
    document.addEventListener("contextmenu",e=>{
      if (!e.ctrlKey || e.button!==0 || h.tool()!=="select" || !paneAt(e)) return;
      const hit=h.hit(e.target,e.clientX,e.clientY), t=sourceOf(hit);
      if (!t) {lastControl=null;return;}
      const rec={canvas:e.target,x:e.clientX,y:e.clientY,at:performance.now(),hit,t};
      if (near(lastControl,e) && rec.at-lastControl.at<500 && sameSource(lastControl.t,t)) {pendingControl=rec;lastControl=null;}
      else lastControl=rec;
      e.preventDefault();
    },true);
    document.addEventListener("pointerup",e=>{
      const rec=pendingControl;pendingControl=null;
      if (near(rec,e) && e.ctrlKey && !h.drag?.()?.before) {completedControl=rec;direct(rec.hit);}
    });
    document.addEventListener("dblclick",e=>{
      if (e.ctrlKey && near(completedControl,e) && performance.now()-completedControl.at<200) {completedControl=null;e.preventDefault();}
    },true);
    document.addEventListener("pointermove",e=>{
      if (card && (card.root.contains(e.target) || C.inside([e.clientX,e.clientY],card.rect))) {hover.stay("connection"); return;}
      const pane=paneAt(e);
      if (e.pointerType==="touch" || e.buttons || h.tool()!=="select" || h.drag() || !pane) {settleLeave(); return;}
      if (chooser || card?.root.contains(document.activeElement)) return;
      const canvas=e.target, x=e.clientX, y=e.clientY;
      if (card) {
        const t=sourceOf(h.hit(canvas,x,y));
        if (sameSource(card.t,t)) {hover.stay("connection"); return;}
        if (!t) {settleLeave(); return;}
      }
      const pendingPoint=hover.pending("connection");
      if (pendingPoint?.canvas===canvas && Math.hypot(x-pendingPoint.x,y-pendingPoint.y)<4) return;
      // A sweep over thousands of objects needs no hit tests or thumbnail work.
      close();
      hover.queue("connection",canvas,DWELL,{canvas,x,y},()=>{
        const t=sourceOf(h.hit(canvas,x,y));
        if (t && hover.preferred("connection",canvas,x,y)) open(t);
      });
    },{passive:true});
    document.addEventListener("pointerout",e=>{if (paneAt(e) && !card?.root.contains(e.relatedTarget)) settleLeave();},{passive:true});
    document.addEventListener("pointerdown",e=>{
      if (card?.root.contains(e.target)) return;
      close();
      if (e.button===0 && paneAt(e) && h.tool()==="select") {
        const t=sourceOf(h.hit(e.target,e.clientX,e.clientY));
        if (t?.entry) {focusEntry={docId:t.doc.id,itemId:t.item.id,entryId:t.entry.id}; queueMicrotask(()=>{if(pinned?.t.item===t.item && pinned.t.entry!==t.entry)refreshProperties();});}
      }
    },{capture:true,passive:true});
    document.addEventListener("keydown",e=>{
      if (e.key==="Tab" && !e.shiftKey && card && e.target===card.t.pane.canvas) {
        const first=card.root.querySelector("button"); if (first) {e.preventDefault();first.focus({preventScroll:true});return;}
      }
      if (e.key==="Escape" && chooser && !e.defaultPrevented && !e.isComposing) {e.preventDefault(); e.stopPropagation(); close();}
    },true);
    document.addEventListener("wheel",e=>{if (chooser && !card?.root.contains(e.target)) close();},{capture:true,passive:true});
    document.addEventListener("waffle-canvas-hold",e=>{
      const detail=e.detail, canvas=detail?.canvas || e.target;
      if (e.defaultPrevented || !canvas?.closest?.("#editor-panes") || !Number.isFinite(detail?.clientX) || !Number.isFinite(detail?.clientY)) return;
      const t=sourceOf(h.hit(canvas,detail.clientX,detail.clientY));
      if (t) {e.preventDefault();open(t,false,true);}
    });
    h.on("document",()=>{
      close(); occurrence=null;
      if (pendingProbe?.doc===h.doc()) {setTarget(pendingProbe);pendingProbe=null;refreshProperties();}
      prepare();
    });
    h.on("panes",()=>{close(); prepare();});
    h.on("folder-owner",()=>{close(); cancelPreparation(); prepared=null; updateLists(); prepare();});
    h.on("replace",()=>{close(); clearFlash(); cancelPreparation(); prepared=pinned=focusEntry=occurrence=pendingProbe=null; T.reset();});
    h.on("change",()=>{close(); cancelPreparation(); if (!current()) {updateLists(); prepare(!!pinned?.root.isConnected);} });
    h.on("frame",()=>{
      if (flash) placeFlash();
      if (card && chooser) {
        const cam=card.t.pane.view.camera(), old=card.camera;
        if (cameraChanged(cam,old)) {card.camera=cam;position(card);}
      }
    });
    G.addEventListener("resize",close);
    G.addEventListener("blur",close);
    G.addEventListener("atrium-theme",()=>{T.reset();updateLists();});
    document.addEventListener("visibilitychange",()=>{if (visible()) prepare(); else {close();cancelPreparation();}});
    G.AtriumPower?.onChange?.(()=>{if (efficient()) cancelPreparation(); if (visible()) prepare();});
    refreshProperties(); prepare();
  }
  if (G.document?.createElement) C.ready(attach);
  return {current, compiled, sourceOf, jump, direct, probe, properties, activateInstance, location, restoreLocation};
})();
