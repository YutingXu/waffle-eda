"use strict";
globalThis.AtriumReviewNotes=(()=>{
  const G=globalThis,M=G.AtriumMarkup,W=G.AtriumSheetWidgets,R=G.AtriumReviewComments;
  const el=(tag,text)=>AtriumNavCommon.el(tag, text);
  const names={sticky:"Sticky note",callout:"Callout",reviewChecklist:"Review checklist",inkStroke:"Sketch"};
  const pretty=s=>s[0].toUpperCase()+s.slice(1);
  const fresh=()=>G.Atrium.id();
  let host,panel,contents,draft,armed,brush="pen",colour="blue",penWidth=.55,highWidth=2.4;
  try {
    const s=JSON.parse(G.localStorage?.getItem("waffle.notes.brush") || "{}");
    if(["pen","highlighter","eraser"].includes(s.brush))brush=s.brush;
    if(M.colours.includes(s.colour))colour=s.colour;
    if(s.penWidth>=.1&&s.penWidth<=20)penWidth=s.penWidth;
    if(s.highWidth>=.1&&s.highWidth<=20)highWidth=s.highWidth;
  }catch{}
  function storeBrush(){try{G.localStorage?.setItem("waffle.notes.brush",JSON.stringify({brush,colour,penWidth,highWidth}));}catch{}}
  const selected=()=>host.doc().items.find(i=>host.selection().includes(i.id));
  function run(f){try{return f();}catch(e){host.info(e.message);if(panel)panel.querySelector('[role="status"]').textContent=e.message;}}
  function btn(parent,text,fn) {
    const b=el("button",text);b.type="button";b.onclick=()=>run(fn);globalThis.AtriumUI?.button(b,"secondary");parent.append(b);return b;
  }
  function input(parent,title,value,change,{type="text",options,max,min,step}={}) {
    const l=el("label"),name=el("span",title),c=el(options?"select":type==="textarea"?"textarea":"input");
    if(options)for(const [v,t] of options)c.append(new Option(t,v));
    else if(type!=="textarea") c.type=type;
    if(type==="checkbox"){c.className="ui-checkbox";c.checked=!!value;}
    else {c.className="ui-field";c.value=value??"";}
    if(max!=null)c.max=max;if(min!=null)c.min=min;if(step!=null)c.step=step;
    c.setAttribute("aria-label",title);c.onchange=()=>run(()=>change(type==="checkbox"?c.checked:c.value));
    if(type==="checkbox")l.className="rn-check";l.append(name,c);parent.append(l);return c;
  }
  function group(parent,title) {const s=el("fieldset"),legend=el("legend",title);s.append(legend);parent.append(s);return s;}
  function repaint(){const d=host.doc();host.invalidateDocument(d.id);host.redraw(true);}
  function local(fn){
    const d=host.doc(),state=M.localView(d);fn(state);M.saveView(d);
    if(draft&&!M.policy(d).hit({kind:"inkStroke"}))G.AtriumCanvasInput.cancelSketch(armed.canvas);
    repaint();refresh();
  }
  function editCurrent(id,label,fn,touchesReview=false) {
    const d=host.doc(),i=d.items.find(x=>x.id===id);
    if(!i)throw Error("The selected note was removed.");
    host.edit(()=>fn(i,d,host.project()),label,touchesReview?undefined:[i]);
  }
  function makeThread(p,d,i,row) {
    return R.add(p,{doc:d.id,anchor:{kind:"item",id:i.id,at:[i.x,i.y],label:"Review checklist"},text:row.text}).id;
  }
  function place(type,at,text) {
    const d=host.doc(),p=host.project();
    if(d.kind!=="schematic")throw Error("Choose a schematic sheet.");
    if(type==="sketch"){arm();return;}
    const that=selected(),target=(that&&!M.kind(that)?that:null) || host.hitAt(at);
    let i;
    host.edit(()=>{
      if(type==="reviewChecklist") {
        i=W.make("todo",at,{argument:text||"Review item"});
        const row=i.widget.state.rows[0];row.threadId=makeThread(p,d,i,row);
      }else{
        const anchor=type==="callout"&&target && !M.kind(target)?M.reference(p,d,target,null,null,host.defs()):{docId:d.id,at:[...at]};
        const pos=type==="callout"&&anchor.itemId?[at[0]+8,at[1]-7]:at;
        i=M.card(type,pos,text||names[type],type==="sticky"?"amber":"blue",p,d,anchor);
      }
      d.items.push(i);
    },"Place "+names[type],type==="reviewChecklist"?undefined:()=>[i]);
    if(!i)return;
    host.setTool("select");host.select([i.id]);open();
    if(type==="sticky"||type==="callout")editRich(i);
    return i;
  }
  function cancelDraft(){
    const erased=draft?.erased?.size,preview=draft?.hold?.shape;
    clearTimeout(draft?.hold?.timer);draft?.capture?.cancel();draft=null;
    if(preview)host.info("Sketch canceled.");
    if(erased)host?.redraw();else host?.redrawOverlay?.();
  }
  function release(){if(armed){G.AtriumCanvasInput.setSketchActive(armed.canvas,false);armed=null;}cancelDraft();}
  function syncTool(){if(armed && (host.tool()!=="sketch" || host.canvas()!==armed.canvas || host.doc().id!==armed.docId))release();}
  function arm() {
    if(host.doc().kind!=="schematic")return;
    if(!M.localView(host.doc()).visible)local(v=>{v.visible=true;});
    if(M.localView(host.doc()).hiddenKinds.has("inkStroke"))local(v=>{v.hiddenKinds.delete("inkStroke");});
    release();host.setTool("sketch");armed={canvas:host.canvas(),docId:host.doc().id};G.AtriumCanvasInput.setSketchActive(armed.canvas,true);
    open();host.canvas().focus();host.info(brush==="eraser"?"Erase a whole stroke. Escape returns to Select.":"Draw on the sheet. Hold still at the end to snap a line, circle or rectangle. Escape returns to Select.");
  }
  function eraseSegment(a,b,doc) {
    const r=Math.max(penWidth,1.2),bounds=[Math.min(a[0],b[0])-r,Math.min(a[1],b[1])-r,Math.max(a[0],b[0])+r,Math.max(a[1],b[1])+r];
    const nearby=host.view().query?.(doc,host.defs(),bounds) || doc.items;
    for(const i of nearby)if(i.ink&&!draft.erased.has(i.id) && G.AtriumSchNoteInk.hit(M.points(i),i.ink,a,b,r)){
      draft.erased.add(i.id);draft.hidden.add(i);
      if(i.ink.gesture)for(const member of doc.items)if(member.ink?.gesture===i.ink.gesture)draft.hidden.add(member);
    }
  }
  const shapeHoldMs=600;
  function trackHold(pen,e,samples) {
    const hold=pen.hold,scale=hold.scale;
    let moved=false;
    for(const sample of samples){
      const p=sample.world;
      if(!Array.isArray(p)||!p.every(Number.isFinite))continue;
      // Keep a bounded trace of the pen's actual turns; the ordinary smoothed
      // capture remains untouched so continuing the gesture restores freehand.
      const last=hold.trace.at(-1);
      if(!last || Math.hypot(p[0]-last[0],p[1]-last[1])>=hold.spacing){
        if(hold.trace.length>=384){hold.trace=hold.trace.filter((_,i)=>i%2===0);hold.spacing*=2;}
        hold.trace.push(p);
      }
      if(!hold.eligible && Math.hypot(p[0]-hold.start[0],p[1]-hold.start[1])*scale>=24)hold.eligible=true;
      if(Math.hypot(p[0]-hold.anchor[0],p[1]-hold.anchor[1])*scale>3){hold.anchor=p;moved=true;}
    }
    if(!moved)return;
    if(hold.shape)host.info("Drawing freehand.");
    clearTimeout(hold.timer);hold.shape=null;hold.preview=null;
    if(!hold.eligible || e.phase==="end")return;
    const position=hold.anchor;
    const active=()=>draft===pen && hold.anchor===position && !document.hidden && host.canvas()===armed?.canvas &&
      host.doc().id===pen.docId && host.tool()==="sketch" && M.policy(host.doc()).hit({kind:"inkStroke"});
    hold.timer=setTimeout(async()=>{
      hold.timer=null;
      if(!active())return;
      let geometry=G.AtriumSketchShapes;
      if(!geometry)try{geometry=await G.AtriumLazy.need("AtriumSketchShapes");}catch{
        if(active())host.info("Shape recognition is unavailable. Continue drawing freehand.");return;
      }
      if(!active())return;
      const tip=pen.capture.tip,trace=[...hold.trace,tip],shape=geometry.fit(trace,{scale,width:pen.width});
      if(!shape)return;
      hold.shape=shape;
      hold.preview=geometry.project(shape,[...pen.capture.points,tip],pen.segments);
      host.redrawOverlay();host.info(pretty(shape.kind)+" snapped. Release to keep it, or continue drawing.");
    },shapeHoldMs);
  }
  function handleSketch(event) {
    if(G.AtriumLabs?.notebookEnabled()===false)return;
    const e=event.detail;
    syncTool();
    if(!armed||e.canvas!==armed.canvas||e.docId!==armed.docId)return;
    if(e.phase==="start"){
      if(draft || !M.policy(host.doc()).hit({kind:"inkStroke"}))return;
      const erasing=e.eraser || brush==="eraser",width=brush==="highlighter"?highWidth:penWidth;
      draft={id:e.pointerId,docId:e.docId,brush,colour,width,segments:[],capture:erasing?null:G.AtriumSchNoteInk.capture(e.pointerType,width),erased:new Set(),hidden:new Set(),previous:null};
      if(!erasing){
        const scale=host.view().camera().scale;
        draft.hold={scale,start:e.world,anchor:e.world,spacing:.5/scale,trace:[],eligible:false,timer:null,shape:null,preview:null};
      }
      event.preventDefault();
    }
    if(!draft||draft.id!==e.pointerId)return;
    if(e.phase==="cancel"){cancelDraft();return;}
    const samples=e.samples?.length?e.samples:[{world:e.world,pressure:e.pressure}];
    if(draft.hold)trackHold(draft,e,samples);
    if(!draft.capture) {
      for(const sample of samples)if(Array.isArray(sample.world)) {eraseSegment(draft.previous||sample.world,sample.world,host.doc());draft.previous=sample.world;}
    }else if(e.phase!=="end") {
      draft.capture.append(samples);
      if(draft.capture.points.length>=M.maxVertices-100) {
        const chunk=draft.capture.finish(),last=chunk.at(-1);draft.segments.push(chunk);
        draft.capture=G.AtriumSchNoteInk.capture(e.pointerType,draft.width);draft.capture.append([{world:last.slice(0,2),pressure:last[2]/255}]);
      }
    }
    if(e.phase==="end"){
      const done=draft,d=host.doc();draft=null;
      if(done.capture){
        clearTimeout(done.hold.timer);
        const tail=done.capture.finish(samples),shape=done.hold.shape;
        const all=shape?[G.AtriumSketchShapes.project(shape,tail,done.segments)]:[...done.segments,tail].filter(v=>v.length);
        const rows=[];
        // Browser input can coalesce many events in a single dispatch. Split any
        // oversized tail too, retaining its shared endpoints and one real Undo.
        for(const pts of all) for(let n=0;n<pts.length;n+=M.maxVertices-1) {
          if(n && n===pts.length-1)break;
          rows.push(M.stroke(pts.slice(n,n+M.maxVertices),done.brush,done.colour,done.width));
        }
        if(rows.length>1){const id=fresh();rows.forEach(i=>{i.ink.gesture=id;});}
        if(rows.length){
          host.edit(()=>d.items.push(...rows),"Draw "+done.brush,rows);
          if(shape&&host.doc().items.includes(rows[0]))host.info(pretty(shape.kind)+" added.");
        }
      }else if(done.erased.size) {
        const groups=new Set(d.items.filter(i=>done.erased.has(i.id)&&i.ink?.gesture).map(i=>i.ink.gesture));
        const gone=d.items.filter(i=>done.erased.has(i.id)||i.ink?.gesture&&groups.has(i.ink.gesture));
        const ids=new Set(gone.map(i=>i.id));
        host.edit(()=>{d.items=d.items.filter(i=>!ids.has(i.id));},"Erase sketch",gone);
      }
    }
    if(draft?.hidden.size)host.redraw();else host.redrawOverlay();
  }
  function open() {
    if(G.AtriumLabs?.notebookEnabled()===false)return;
    if(host.doc().kind!=="schematic")return;
    if(!panel) {
      panel=el("section");panel.id="review-notes-panel";panel.className="review-notes-panel";panel.setAttribute("aria-label","Review Notes");
      const header=el("header");header.append(el("h2","Review Notes"));btn(header,"Close",close);
      contents=el("div");contents.className="rn-controls";
      const status=el("p");status.setAttribute("role","status");panel.append(header,contents,status);
      panel.addEventListener("keydown",e=>{if(e.key==="Escape"){e.stopPropagation();close();}});
      host.canvas().parentElement.append(panel);
    }
    if(panel.parentElement!==host.canvas().parentElement)host.canvas().parentElement.append(panel);
    panel.hidden=false;refresh();
  }
  function close(restoreFocus=true){if(armed)host.setTool("select");release();if(panel)panel.hidden=true;if(restoreFocus)host.canvas()?.focus();}
  function layerSettings(parent,d) {
    const s=group(parent,"Notes layer"),v=M.localView(d);
    input(s,"Show on this sheet",v.visible,x=>local(state=>{state.visible=x;}),{type:"checkbox"});
    input(s,"Print with this sheet",d.notesLayer?.print!==false,x=>host.edit(()=>{d.notesLayer={...d.notesLayer,id:d.notesLayer?.id || fresh(),print:x};},"Change Notes print setting"),{type:"checkbox"});
    const more=el("details");more.append(el("summary","Filter note types"));
    for(const [k,label] of Object.entries(names))input(more,label,!v.hiddenKinds.has(k),x=>local(state=>{if(x)state.hiddenKinds.delete(k);else state.hiddenKinds.add(k);}),{type:"checkbox"});
    s.append(more);
  }
  function brushControls(parent) {
    const s=group(parent,"Sketch");
    input(s,"Drawing tool",brush,v=>{brush=v;storeBrush();if(!armed)arm();else refresh();},{options:[["pen","Pen"],["highlighter","Highlighter"],["eraser","Whole-stroke eraser"]]});
    if(brush!=="eraser"){
      input(s,"Ink colour",colour,v=>{colour=v;storeBrush();},{options:M.colours.map(c=>[c,pretty(c)])});
      input(s,"Stroke width (mm)",brush==="highlighter"?highWidth:penWidth,v=>{
        const n=Number(v);if(!Number.isFinite(n)||n<.1||n>20)throw Error("Choose a width from 0.1 to 20 mm.");
        if(brush==="highlighter")highWidth=n;else penWidth=n;storeBrush();
      },{type:"number",min:.1,max:20,step:.05});
    }
    btn(s,armed?"Finish sketch":"Start sketch",()=>{if(armed){host.setTool("select");release();refresh();}else arm();});
  }
  function editRich(i) {
    const h=host,id=i.id,d=host.doc();
    G.AtriumLazy.need("AtriumRichText").then(async r=>{
      if(h.doc()!==d)return;
      const live=d.items.find(v=>v.id===id);
      if(live)await r.edit(live,h);
    }).catch(e=>h.info(e.message));
  }
  function cardControls(parent,i,k) {
    const d=host.doc(),p=host.project(),s=group(parent,names[k]),at=()=>d.items.find(v=>v.id===i.id);
    if(k==="reviewChecklist"){
      for(const row of i.widget.state.rows) {
        const done=W.checked(p,row);
        const c=input(s,row.text,done===true,x=>editCurrent(i.id,"Set Review status",live=>W.setDone(host.project(),live,row.id,x),!!row.threadId),{type:"checkbox"});
        c.disabled=done===null;
        if(done===null)s.append(el("span","Review thread missing"));
        if(row.threadId&&done!==null)btn(s,"Open in Comments",()=>R.focus(row.threadId,true));
      }
      btn(s,"Edit checklist",()=>G.AtriumLazy.need("AtriumSheetWidgetEditor").then(ui=>ui.open(i.id)));return;
    }
    if(k==="inkStroke"){s.append(el("span",pretty(i.ink.brush)+" · "+i.ink.width+" mm"));return;}
    btn(s,"Edit note text",()=>editRich(i));
    input(s,"Note colour",i[k].colour,v=>editCurrent(i.id,"Change note colour",live=>{live[k].colour=v;}),{options:M.colours.map(c=>[c,pretty(c)])});
    for(const [key,title] of [["w","Note width (mm)"],["h","Note height (mm)"]])input(s,title,i[key],v=>{
      const n=Number(v);if(!Number.isFinite(n)||n<4||n>10000)throw Error("Choose a note size from 4 to 10000 mm.");
      editCurrent(i.id,"Resize note",live=>{live[key]=n;});
    },{type:"number",min:4,max:10000,step:.5});
    if(k==="sticky") {
      const v=M.localView(d);
      btn(s,v.minimized.has(i.id)?"Restore note":"Minimize note",()=>local(state=>{if(state.minimized.has(i.id))state.minimized.delete(i.id);else state.minimized.add(i.id);}));
    }else {
      const a=i.callout.anchor,hit=M.locate(p,d,a,host.defs());
      const targetLabel=hit.live?R.labelFor(p.documents.find(v=>v.id===hit.docId).items.find(v=>v.id===a.itemId)):a.itemId?"Target missing":"Choose a target";
      s.append(el("span",targetLabel));
      const choices=[["","Choose target"]],refs=new Map();
      for(const sheet of p.documents.filter(v=>v.kind==="schematic"))for(const it of sheet.items) {
        if(it===i || M.kind(it))continue;const id=sheet.id+"/"+it.id;
        const caption=sheet.name+" · "+R.labelFor(it); choices.push([id,caption]);refs.set(id,[sheet,it]);
      }
      let target=a.itemId?a.docId+"/"+a.itemId:"",pin=a.pin || "",instance=a.instanceId || "";
      input(s,"Anchor target",target,v=>{target=v;},{options:choices});
      input(s,"Pin (optional)",pin,v=>{pin=v;});input(s,"Sheet instance ID (optional)",instance,v=>{instance=v;});
      btn(s,"Attach callout",()=>{const pair=refs.get(target);if(!pair||!at())throw Error("Choose a live target.");
        const anchor=M.reference(p,pair[0],pair[1],pin,instance,host.defs());editCurrent(i.id,"Attach callout",live=>{live.callout.anchor=anchor;});});
    }
  }
  function refresh(){
    syncTool();if(!panel || panel.hidden)return;
    if(host.doc().kind!=="schematic"){close();return;}
    const filtersOpen=contents.querySelector("details")?.open || false;
    contents.replaceChildren();const i=selected(),k=M.kind(i);
    if(k)cardControls(contents,i,k);
    if(armed)brushControls(contents);
    const add=group(contents,"Insert");
    for(const name of ["sticky","callout","reviewChecklist"])btn(add,names[name],()=>place(name,host.palettePoint?.() || host.view().screenToWorld([host.canvas().clientWidth/2,host.canvas().clientHeight/2])));
    if(!armed)brushControls(contents);layerSettings(contents,host.doc());contents.querySelector("details").open=filtersOpen;
  }
  function inspect(parent,i,h) {
    if(!M.kind(i))return false;
    const s=h.ui.section(parent,names[M.kind(i)]);btn(s,"Edit in Review Notes",()=>{open();contents.querySelector("textarea, input, select")?.focus();});
    if(M.kind(i)==="reviewChecklist")btn(s,"Edit checklist",()=>G.AtriumLazy.need("AtriumSheetWidgetEditor").then(ui=>ui.open(i.id)));
    return true;
  }
  function links(parent,{project,doc,item,row,input,edit,closeDialog,refresh:render}) {
    const t=row.threadId && R.thread(project,row.threadId);
    if(row.threadId&&!t)parent.append(el("span","Review thread missing"));
    const choices=[["","Unlinked"],...R.threads(project,{doc:doc.id,status:"all"}).map(r=>[r.id,r.text])];
    input(parent,"Review thread",row.threadId || "",v=>{edit(live=>{if(v)live.threadId=v;else{live.done=t?.status==="resolved";delete live.threadId;}});render();},{options:choices});
    if(!t)btn(parent,"Create Review thread",()=>{edit(live=>{live.threadId=makeThread(project,doc,item,live);});render();});
    else btn(parent,"Open in Comments",()=>{closeDialog();R.focus(t.id,true);});
  }
  function attach(h) {
    if(!h||host===h)return;host=h;
    host.registerAction("review-notes",open);
    host.on("selection",refresh);host.on("change",refresh);host.on("document",refresh);host.on("frame",syncTool);
    document.addEventListener("waffle-sketch-input",handleSketch);
    function restoreDot(i,d){
      if(G.AtriumLabs?.notebookEnabled()===false || !i?.sticky || !M.localView(d).minimized.has(i.id))return false;
      local(v=>v.minimized.delete(i.id));h.select([i.id]);open();editRich(i);return true;
    }
    document.addEventListener("click",e=>{
      if(e.target!==h.canvas() || h.doc().kind!=="schematic" || !M.localView(h.doc()).minimized.size || h.tool()!=="select" || e.detail!==1 || e.ctrlKey || e.shiftKey || e.metaKey)return;
      const hit=h.hit(e.target,e.clientX,e.clientY);
      if(hit && restoreDot(hit.item,hit.doc)){e.preventDefault();e.stopPropagation();}
    },true);
    document.addEventListener("keydown",e=>{
      if(e.target!==h.canvas() || h.tool()!=="select" || e.key!=="Enter"||e.ctrlKey||e.shiftKey||e.metaKey)return;
      if(restoreDot(selected(),h.doc()))e.preventDefault();
    },true);
    document.addEventListener("waffle-canvas-tap",event=>{
      if(event.defaultPrevented || h.tool()!=="select")return;
      const e=event.detail,i=e.item,d=h.doc();if(!i||e.docId!==d.id || !M.policy(d).hit({kind:M.kind(i)}))return;
      if(restoreDot(i,d))event.preventDefault();
    });
    h.addRenderer(d=>{
      if(!draft || d.id!==draft.docId)return null;
      if(!draft.capture)return {hide:draft.hidden};
      const pen=draft;return {overlay(ctx){
        const style={brush:pen.brush,width:pen.width},pigment=M.paint(pen.colour,M.darkPaper()).line;
        if(pen.hold.preview){G.AtriumSchNoteInk.draw(ctx,pen.hold.preview,style,pigment);return;}
        const tail=pen.capture.tip,live=pen.capture.points;
        G.AtriumSchNoteInk.drawPaths(ctx,[...pen.segments,tail?[...live,tail]:live],style,pigment);
      }};
    });
  }
  if(typeof document!=="undefined"&&G.AtriumNavHost)attach(G.AtriumNavHost);
  // A sketch stroke still under the pen when the project is left asks once (leave-project.js) and is dropped at the commit.
  const LP=G.AtriumLeaveProject;
  LP?.draft("review-sketch",LP.order.notes,{state:()=>draft||null,message:"Discard the sketch stroke you are drawing?",discard:()=>release()});
  return Object.freeze({attach,place,open,close,inspect,links,hasPending:()=>!!draft});
})();
