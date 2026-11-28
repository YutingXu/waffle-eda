"use strict";
// A contact belongs to one canvas and document until release. Mouse and hovering pen events use
// the editor's ordinary dispatch. Direct contacts are committed only after their intent is known.
globalThis.AtriumCanvasInput = (() => {
  // The touch scheme (docs/design-system.md, Touch). It depends only on the gesture and on whether the
  // touched object is already selected, never on how dense the design is or how large its hit target is.
  // slop: px a contact may wander and still be a tap or a press; hold: ms of a still finger before a pick-up;
  // multiTap: ms from the first finger down to the last finger up for a two- or three-finger tap.
  const TOUCH = Object.freeze({slop:8, penSlop:3, hold:450, multiTap:250, doubleTap:320, cycleRadius:22, swipe:64});
  // Multi-finger gestures and the commands they run. Remap here; nothing else names a command.
  const GESTURES = Object.freeze({"two-finger-tap":"undo", "three-finger-tap":"redo",
    "three-finger-swipe-left":"undo", "three-finger-swipe-right":"redo"});
  const HOLD = TOUCH.hold, TAP = TOUCH.doubleTap, SLOP = TOUCH.slop, SWIPE = TOUCH.swipe;
  const clock = {now: () => performance.now(), later: (f, ms) => setTimeout(f, ms), clear: id => clearTimeout(id)};
  const keys = {shiftKey: false, ctrlKey: false, altKey: false};
  const replayed = new WeakSet(), grips = new WeakSet(), surfaces = new WeakMap(), coasting = new WeakMap();
  const sketches=new WeakSet(),tools=new WeakSet(),claimed=new WeakMap();
  let touchEvent=null;
  function arm(set,canvas,on){
    if(on)set.add(canvas);
    else {set.delete(canvas);const active=claimed.get(canvas);if(active?.set===set)active.cancel();}
  }
  function cancelSketch(canvas){
    const active=claimed.get(canvas);
    if(active?.set!==sketches)return false;
    active.cancel();return true;
  }
  function setModifiers(next = {}) { for (const key of Object.keys(keys)) keys[key] = !!next[key]; }
  const distance = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);
  // Two-finger coasting and turning are notebook camera features; Preview keeps plain pan and pinch.
  const cameraPref = key => globalThis.AtriumLabs?.notebookEnabled() !== false && !!globalThis.AtriumCamera?.cfg[key];
  const client = e => [e.clientX, e.clientY];
  function local(c, at) { const r = c.getBoundingClientRect(); return [at[0] - r.left, at[1] - r.top]; }
  function dispatch(c, type, detail) {
    return !c.dispatchEvent(new CustomEvent(type, {detail, bubbles: true, composed: true, cancelable: true}));
  }
  function editEvent(c, e, type, at = client(e), grip = false) {
    const touch = e.pointerType === "touch";
    const init = {bubbles: true, cancelable: true, composed: true, view: window,
      clientX: at[0], clientY: at[1], pointerType: e.pointerType, pointerId: e.pointerId, isPrimary: true,
      button: type === "pointermove" ? -1 : 0, buttons: type === "pointerup" || type === "pointercancel" ? 0 : 1,
      pressure: e.pressure, tiltX: e.tiltX, tiltY: e.tiltY, twist: e.twist, width: e.width, height: e.height,
      altKey: e.altKey || touch && keys.altKey, ctrlKey: e.ctrlKey || touch && keys.ctrlKey,
      shiftKey: e.shiftKey || touch && keys.shiftKey, metaKey: e.metaKey};
    const next=typeof PointerEvent==="function"?new PointerEvent(type,init):new MouseEvent(type,init);
    if(!("pointerType" in next))for(const key of ["pointerType","pointerId","isPrimary","pressure","tiltX","tiltY","width","height"])Object.defineProperty(next,key,{value:init[key]});
    replayed.add(next);
    if (grip && touch) grips.add(next);
    const prior=touchEvent;touchEvent=touch?next:null;
    try{c.dispatchEvent(next);}finally{touchEvent=prior;}
  }
  // Midpoint translation, span ratio and incremental angle use the same pair and anchor.
  function pair(points, rotate) {
    const it = points.values(), a = it.next().value.at, b = it.next().value?.at;
    return b ? {at: [(a[0]+b[0])/2, (a[1]+b[1])/2], span: distance(a,b), angle: rotate?Math.atan2(b[1]-a[1],b[0]-a[0]):0} : {at:a,span:0,angle:0};
  }
  const turn = a => Math.atan2(Math.sin(a), Math.cos(a));
  // Rotation is optional. Leave the fast, axis-aligned renderer and its caches untouched at zero.
  function orientation(rad) {
    rad=turn(rad);
    if(!Number.isFinite(rad)||Math.abs(rad)<1e-8) return null;
    const cos=Math.cos(rad),sin=Math.sin(rad);
    function vector(x,y,inverse=false) {
      return inverse?[x*cos+y*sin,-x*sin+y*cos]:[x*cos-y*sin,x*sin+y*cos];
    }
    function point(p,w,h,inverse=false) {
      const [x,y]=vector(p[0]-w/2,p[1]-h/2,inverse);
      return [x+w/2,y+h/2];
    }
    function bounds(a,project) {
      const q=[[a[0],a[1]],[a[2],a[1]],[a[2],a[3]],[a[0],a[3]]].map(project);
      return [Math.min(...q.map(p=>p[0])),Math.min(...q.map(p=>p[1])),Math.max(...q.map(p=>p[0])),Math.max(...q.map(p=>p[1]))];
    }
    function grid(ctx,box,step,scale,dpr,fine,coarse) {
      if(!(step>0&&Number.isFinite(step))) return;
      while(step*scale<12) step*=2;
      const [x,y,r,b]=box;
      if(!coarse) {
        ctx.fillStyle=fine; const size=1.15/scale;
        for(let i=Math.ceil(x/step);i<=r/step;i++) for(let j=Math.ceil(y/step);j<=b/step;j++) ctx.fillRect(i*step-size/2,j*step-size/2,size,size);
        return;
      }
      ctx.lineWidth=1/(scale*dpr);
      for(const major of [false,true]) {
        ctx.strokeStyle=major?coarse:fine;ctx.beginPath();
        for(let i=Math.ceil(x/step);i<=r/step;i++) if((i%5===0)===major){ctx.moveTo(i*step,y);ctx.lineTo(i*step,b);}
        for(let j=Math.ceil(y/step);j<=b/step;j++) if((j%5===0)===major){ctx.moveTo(x,j*step);ctx.lineTo(r,j*step);}
        ctx.stroke();
      }
    }
    return {rad,cos,sin,vector,point,bounds,grid,span:(w,h)=>[Math.abs(w*cos)+Math.abs(h*sin),Math.abs(w*sin)+Math.abs(h*cos)]};
  }
  function registerView(pane) {
    surfaces.set(pane.canvas,pane);
    return ()=>{globalThis.AtriumCamera?.stopWheel?.(pane.view);pane.input.dispose?.();surfaces.delete(pane.canvas);};
  }
  function documentHit(doc,point,scale) {
    const editor=doc?.kind==="drawing"?globalThis.AtriumDrawing:doc?.kind==="panel"?globalThis.AtriumPanelUI:null;
    return editor?.inputAt?.(point,scale);
  }
  function library(canvas,stage,options={}) {
    const pane={canvas,view:stage.view}, origin=stage.O;
    const palette=()=>canvas.closest("dialog[open]")?.paletteSurface;
    const point=(x,y)=>palette()?.toWorld?.(x,y) || stage.toLocal(local(canvas,[x,y]));
    const h={currentId:()=>stage.doc.id,tool:()=>options.tool?.()||"pan",defs:stage.defs,
      hit(c,x,y){const at=point(x,y),item=options.hit?.(at)||palette()?.hitAt?.(at)||null;return {doc:stage.doc,item,point:at};},
      act:id=>options.undo?.(id==="undo"),select:()=>{},selection:()=>[]};
    pane.input={host:h,precision:options.precision,selected:options.selected,frame:()=>stage.schedule(),point, screen:p=>stage.toScreen(p),active:()=>canvas.isConnected,
      hold(detail){
        // Object-context actions and insertion both belong to the open library editor's palette.
        const request={...detail,docId:globalThis.AtriumNavHost?.currentId?.()||detail.docId,surfaceDocId:detail.docId,
          target:palette()?.hitAt?.(detail.point)||detail.item};
        if(dispatch(canvas,"waffle-insert-request",request)) return true;
        if(detail.item && options.inspect) options.inspect(detail.item);
        return true;
      },
      zoom(hit){const b=hit?.item?.box;if(!b){stage.fit();return;}
        zoomBox(pane,b.map((n,i)=>n+origin[i%2]),stage.schedule);}
    };
    const dispose=registerView(pane);
    canvas.closest("dialog")?.addEventListener("close",dispose,{once:true});
    return pane;
  }
  function zoomBox(pane,box,frame,{fly=false}={}) {
    const c=pane.canvas,v=pane.view,cam=v.camera(),rot=orientation(cam.rotation||0);
    const cx=(box[0]+box[2])/2,cy=(box[1]+box[3])/2;
    let w=box[2]-box[0],h=box[3]-box[1]; if(rot) [w,h]=rot.span(w,h);
    const b=[cx-w/2,cy-h/2,cx+w/2,cy+h/2],N=globalThis.AtriumNavCommon;
    if(!N?.cameraFor) return;
    const next={...cam,...N.cameraFor(b,c.clientWidth,c.clientHeight,cam)};
    const camera=globalThis.AtriumCamera;
    if(fly&&camera?.flyTo)camera.flyTo(next,{view:v,canvas:c,redraw:()=>frame(pane)});
    else {v.restoreCamera(next);frame(pane);}
  }
  function create(ops, time = clock) {
    const states = new Map(), owners = new Map(), palms = new Set(), pens = new Set(), shadows = new Set(), mouseShadows=new Set(), legacy = new Map();
    let coast = null, entering = null;
    const C = () => globalThis.AtriumCamera;
    const host = s => s.pane.input?.host || ops.host();
    const active = s => s.pane.input?.active() ?? ops.active(s.pane);
    const docId = p => p.input?.host.currentId() || ops.docId(p);
    const frame = (p,inFrame,wheelEnd) => p.input ? p.input.frame() : ops.frame(p,inFrame,wheelEnd);
    const state = p => {
      if (!states.has(p)) {
        const s={pane:p,points:new Map(),mode:"idle",recent:-Infinity}; states.set(p,s);
        if(p.input)p.input.dispose=()=>{if(coast?.state===s)stopMotion();reset(s);states.delete(p);};
      }
      return states.get(p);
    };
    const valid = s => s.pane.canvas.isConnected && docId(s.pane) === s.docId;
    const loc = (s, at) => local(s.pane.canvas, at);
    const world = (s, at) => s.pane.input?.point(...at)||s.pane.view.screenToWorld(loc(s, at));
    function stopMotion() { if (coast) { coast.track?.cancel(); coasting.delete(coast.state.pane.view); coast = null; } }
    function stopHold(s) { time.clear(s.timer); s.timer = 0; }
    function detail(s, e, at = client(e)) {
      const point = world(s, at);
      return {canvas:s.pane.canvas, docId:s.docId, point, world:point, client:at, clientX:at[0], clientY:at[1],
        pointerId:e.pointerId, pointerType:e.pointerType, eraser:e.pointerType==="pen"&&(e.button===5||e.buttons===32), item:s.hit?.item || null, itemId:s.hit?.item?.id || null, tool:s.tool};
    }
    function editing(s, e, phase) {
      const d = detail(s,e);
      d.altKey = e.altKey;
      d.editPoint = s.offset ? world(s, [d.clientX+s.offset[0], d.clientY+s.offset[1]]) : d.world;
      dispatch(s.pane.canvas, "waffle-touch-edit", {...d, phase});
    }
    function stream(s, e, phase, name=s.stream) {
      let events;
      try { events = e.getCoalescedEvents?.(); } catch {}
      const rect=s.pane.input?null:s.pane.canvas.getBoundingClientRect();
      const project=v=>rect?s.pane.view.screenToWorld([v.clientX-rect.left,v.clientY-rect.top]):world(s,client(v));
      const samples = (events?.length ? events : [e]).map(v => ({world:project(v), pressure:v.pressure,
        tiltX:v.tiltX, tiltY:v.tiltY, twist:v.twist, timeStamp:v.timeStamp}));
      return dispatch(s.pane.canvas, name, {...detail(s,e), phase, samples, pressure:e.pressure, tiltX:e.tiltX, tiltY:e.tiltY});
    }
    function replay(s, e, type, at) {
      entering = s;
      try {
        at ??= client(e);
        if(s.offset) at=[at[0]+s.offset[0],at[1]+s.offset[1]];
        editEvent(s.pane.canvas,e,type,at,s.grip);
      } finally { entering = null; }
    }
    function rollback(s) {
      if (s.mode === "drag") replay(s,s.last,"pointercancel");
      if (s.mode === "stream") {claimed.delete(s.pane.canvas);stream(s,s.last,"cancel");}
      if (s.aim || s.mode === "drag" || s.mode === "place") editing(s,s.last,"cancel");
      s.aim = false;
    }
    function reset(s) {
      stopHold(s); hideCue(s); rollback(s);
      for (const id of s.points.keys()) { owners.delete(id); pens.delete(id); }
      s.points.clear(); s.mode="idle"; s.swipe=null; s.velocity=null; s.tap=null; s.web=null; s.webEnd=null; s.wheelPinch=null; s.last=null; s.hit=null;
    }
    function clear() {
      stopMotion();
      C()?.stopWheel?.();
      for (const s of states.values()) if (s !== entering) reset(s);
      palms.clear();shadows.clear();mouseShadows.clear();legacy.clear();
    }
    function prune() {
      for (const [p,s] of states) if (p.covered || !p.canvas.isConnected || s.points.size && !valid(s)) {
        reset(s); states.delete(p); if(coast?.state===s) stopMotion();
      }
    }
    function activate(s) {
      if (!active(s)) {
        entering = s;
        try { ops.activate(s.pane); } finally { entering = null; }
      }
    }
    // Does the contact start on something already selected? A grip of the selection counts, and so does a
    // selected object lying under another one (a tap cycles down to it).
    function selectedAt(s) {
      const item=s.hit?.item;
      if (s.grip) return true;
      if (!item || !active(s)) return false;
      if (s.pane.input) return !!s.pane.input.selected?.(item);
      // A drawing or panel object: selected when it is that document's own current pick.
      if (s.hit.pick) return !!s.hit.grip || documentHit(s.hit.doc,null,s.pane.view.scale?.())?.item?.id===item.id;
      const ids=new Set(host(s).selection?.()||[]);
      if (!ids.size) return false;
      if (ids.has(item.id)) return true;
      const all=host(s).hit(s.pane.canvas,s.start[0],s.start[1],true);
      return Array.isArray(all) && all.some(i=>ids.has(i.id));
    }
    // The pick-up cue: a short lift pulse around the held object, or the marquee corner at the finger.
    function showCue(s) {
      const d=globalThis.document, c=s.pane.canvas;
      if (!d?.createElement) return;
      const el=d.createElement("div"), r=c.getBoundingClientRect(), item=s.hit?.item;
      el.className="touch-lift"; el.setAttribute("aria-hidden","true");
      let box=null;
      if (item && !s.pane.input && !s.hit.pick) {
        const h=host(s), w=globalThis.AtriumNavCommon?.itemBox(s.hit.doc||h.doc(),h.defs(),item), v=s.pane.view;
        if (w) {
          const q=[[w[0],w[1]],[w[2],w[1]],[w[2],w[3]],[w[0],w[3]]].map(p=>v.worldToScreen(p));
          box=[Math.min(...q.map(p=>p[0])),Math.min(...q.map(p=>p[1])),Math.max(...q.map(p=>p[0])),Math.max(...q.map(p=>p[1]))];
          box=[Math.max(box[0],0)+r.left-4,Math.max(box[1],0)+r.top-4,Math.min(box[2],r.width)+r.left+4,Math.min(box[3],r.height)+r.top+4];
          if (!(box[2]>box[0]&&box[3]>box[1])) box=null;
        }
      }
      const [x,y]=s.start, object=!!item;
      if (!box) box=object?[x-22,y-22,x+22,y+22]:[x,y,x+16,y+16];
      el.dataset.kind=object?"object":"marquee";
      el.style.cssText="position:fixed;pointer-events:none;z-index:2147483000;box-sizing:border-box;"+
        `left:${box[0]}px;top:${box[1]}px;width:${box[2]-box[0]}px;height:${box[3]-box[1]}px;`+
        (object?"border:2px solid var(--accent);border-radius:var(--chrome-control-radius);box-shadow:var(--elev-2);":
          "border:1.5px dashed var(--accent);background:color-mix(in srgb,var(--accent) 16%,transparent);");
      (c.closest?.("dialog[open]")||d.body).append(el);
      s.cue=el;
      const level=globalThis.AtriumMotion?.level?.()||"full";
      if (typeof el.animate!=="function" || level==="off") return;
      if (level==="full") el.animate([{transform:"scale(.94)",opacity:.4},{transform:"scale(1.05)",opacity:1,offset:.55},{transform:"scale(1)",opacity:1}],
        {duration:180,easing:"cubic-bezier(.2,.8,.2,1)"});
      else el.animate([{opacity:0},{opacity:1}],{duration:120});
    }
    function hideCue(s) { s.cue?.remove(); s.cue=null; }
    // A still finger past the hold time picks up: what it drags next moves, or draws a selection box.
    function lift(s) {
      if (s.mode !== "pending" || !valid(s)) return;
      s.mode = "held"; s.tap = null; activate(s); showCue(s);
    }
    // A pick-up released without moving opens the context menu at the finger (the right-click menu).
    function menu(s, e) {
      if (!valid(s)) return;
      s.mode = "hold"; activate(s);
      const d = {...detail(s,e,s.start),point:s.startWorld,world:s.startWorld,source:"hold"};
      if(s.pane.input?.hold(d)) return;
      const h = host(s), hit = s.hit;
      if (d.item && !hit.pick && !s.selected) h.select([d.itemId]);
      const open = m => { if (valid(s) && active(s) && h.currentId() === d.docId) m.open(h,d.clientX,d.clientY,{hit,returnFocus:d.canvas}); };
      // After the release has run, as a right-click menu opens after its mouse-up.
      time.later(() => {
        const loader = globalThis.AtriumLazy, context = globalThis.AtriumContextMenu;
        if (context && (!loader || globalThis.AtriumCrossProbe)) open(context);
        else loader?.need(["AtriumContextMenu", "AtriumCrossProbe"]).then(([m]) => open(m), h.info);
      },0);
    }
    // The undo or redo step a gesture is about to run, for its status line.
    function stepName(h, redo) {
      const steps=h.undoSteps?.(), list=redo?steps?.future:steps?.history;
      if (!list) return "";
      if (!list.length) return null;
      // The live state carries the act that produced it (undo-store.js); a redo step carries its own.
      const act=(redo?list.at(-1)?.act:globalThis.AtriumUndoStore?.live?.().act)||{};
      const named=act.label && !/^edit$/i.test(act.label) ? act.label : globalThis.AtriumKeymap?.command?.(act.action)?.title;
      return named ? String(named).replace(/…$|\.\.\.$/,"") : "";
    }
    function command(s, gesture) {
      const id=GESTURES[gesture]; if (!id) return;
      activate(s);
      const h=host(s), history=id==="undo"||id==="redo", name=history?stepName(h,id==="redo"):"";
      h.act(id);
      if (history && name!==null && h.info) h.info((id==="undo"?"Undo":"Redo")+(name?": "+name:""));
      else if (history && h.info) h.info(id==="undo"?"Nothing to undo":"Nothing to redo");
    }
    function start(s, e) {
      s.docId=docId(s.pane); s.start=client(e); s.last=e; s.mode="pending"; s.multi=false; s.invalid=false; s.velocity=null;
      s.first=time.now(); s.fingers=1; s.wandered=false; s.multiCamera=null;
      s.tool=active(s)?host(s).tool():"select";
      s.hit=host(s).hit(s.pane.canvas,e.clientX,e.clientY); s.offset=null; s.grip=false;
      s.startWorld=s.hit?.point || world(s,s.start);
      if(!s.pane.input && active(s)){
        const local=documentHit(s.hit?.doc,s.startWorld,s.pane.view.scale?.());
        if(local){s.hit={...s.hit,...local};s.tool=local.tool||s.tool;}
      }
      if(e.pointerType==="touch" && active(s)){
        const d=detail(s,e); dispatch(s.pane.canvas,"waffle-touch-hit",d);
        if(d.item && s.hit)s.hit={...s.hit,item:d.item};
        s.grip=d.edit===true;
        if(s.grip && Array.isArray(d.anchor)&&d.anchor.length===2&&d.anchor.every(Number.isFinite)){
          const target=s.pane.input?s.pane.input.screen(d.anchor):s.pane.view.worldToScreen(d.anchor),at=loc(s,s.start);
          s.offset=[target[0]-at[0],target[1]-at[1]];
        }
      }
      if(active(s)){
        const canvas=s.pane.canvas;
        for(const [set,name] of [[tools,"waffle-canvas-tool-input"],[sketches,"waffle-sketch-input"]]){
          if((set.has(canvas)||set===sketches&&e.pointerType==="pen")&&stream(s,e,"start",name)){
            s.mode="stream";s.stream=name;
            claimed.set(canvas,{set,cancel:()=>{rollback(s);s.mode="ignored";}});
            return;
          }
        }
      }
      s.selected=selectedAt(s);
      s.aim=e.pointerType==="touch" && active(s) && !s.grip && s.tool!=="select" && s.tool!=="pan";
      if (s.aim) editing(s,e,"start");
      // Only a finger with the Select tool picks up. A pen is a mouse; an armed tool aims while the finger rests.
      if (e.pointerType==="touch" && s.tool==="select") s.timer=time.later(() => lift(s),HOLD);
    }
    function pan(s, from, to, factor=1, angle=0) {
      const dx=to[0]-from[0],dy=to[1]-from[1],v=s.pane.view;
      const zoom=factor!==1 && Number.isFinite(factor);
      if (!dx && !dy && !zoom && !angle) return;
      if (dx || dy) v.pan(dx,dy);
      if (zoom || angle) {
        const at=loc(s,to);
        if (zoom) v.zoom(factor,at);
        if (angle) v.rotate?.(angle,at);
      }
      frame(s.pane);
    }
    function speed(s, dx, dy, dt) {
      if (dt<=0 || dt>100 || !dx&&!dy) return;
      const v=s.velocity;
      const k=v?1-Math.exp(-dt/24):1;
      s.velocity={x:(v?.x||0)*(1-k)+dx/dt*k,y:(v?.y||0)*(1-k)+dy/dt*k,t:time.now()};
    }
    function momentum(s) {
      const v=s.velocity;
      if (globalThis.document?.hidden || !v || !s.multi || time.now()-v.t>85 || !cameraPref("camera.momentum") || !C().animate()) return;
      const m=Math.hypot(v.x,v.y);
      if (m<.12) return;
      const motion=globalThis.AtriumMotion;
      if (!motion?.choreograph) return;
      stopMotion();
      const k=Math.min(1,2.2/m), ms=motion.duration("slow");
      const run=coast={state:s,last:0}; coasting.set(s.pane.view,stopMotion);
      run.track=motion.choreograph(s.pane.view,"camera",{camera:true,ms,ease:"linear",step(_e,t) {
        if (coast!==run || !valid(s) || !C().animate()) { if (coast===run) stopMotion(); return; }
        const end=t*ms, integral=85*(Math.exp(-run.last/85)-Math.exp(-end/85));
        if (integral) { s.pane.view.pan(v.x*k*integral,v.y*k*integral); frame(s.pane); }
        run.last=end;
        if (m*k*Math.exp(-end/85)<.025) stopMotion();
      },done:stopMotion});
    }
    function move(s,e) {
      const row=s.points.get(e.pointerId),at=client(e),old=row.at;
      const rotate=s.mode==="pan" && s.points.size>1 && cameraPref("camera.rotate");
      const before=s.mode==="pan"?pair(s.points,rotate):null;
      row.at=at; s.last=e;
      if (distance(row.start,at)>=SLOP) s.wandered=true;
      if (s.swipe) { s.swipe.get(e.pointerId).at=at; return; }
      if (s.mode==="hold" || s.mode==="ignored") return;
      if (s.mode==="held") {
        if (distance(s.start,at)<SLOP) return;
        hideCue(s);
        if (s.pane.input?.navigation) { s.mode="pan"; pan(s,s.start,at); s.t=time.now(); return; }
        s.mode="drag"; replay(s,s.down,"pointerdown",s.start); editing(s,e,"start");
      }
      if (s.mode==="stream") { if(e.type==="pointermove") stream(s,e,"move"); return; }
      if (s.mode==="pending") {
        if (distance(s.start,at)<(e.pointerType==="pen"?TOUCH.penSlop:SLOP)) return;
        stopHold(s); s.tap=null;
        const isPen=e.pointerType==="pen";
        // A finger pans unless it starts on the selection (or a touch modifier asks for a selection box).
        if (s.pane.input?.navigation || s.tool==="pan" || !isPen && (!active(s) || s.tool==="select" && !s.selected && !keys.shiftKey)) {
          s.mode="pan"; pan(s,s.start,at); s.t=time.now(); return;
        }
        if (s.tool!=="select" && !s.grip && !isPen) s.mode="place";
        else { s.mode="drag"; replay(s,s.down,"pointerdown",s.start); }
        if(!s.aim)editing(s,e,"start");
      }
      if (s.mode==="drag" || s.mode==="place") {
        if (at[0]!==old[0] || at[1]!==old[1]) { replay(s,e,"pointermove",at); editing(s,e,"move"); }
      } else if (s.mode==="pan" && before) {
        const after=pair(s.points,rotate),factor=before.span&&after.span?after.span/before.span:1;
        const angle=rotate&&before.span&&after.span?turn(after.angle-before.angle):0;
        pan(s,before.at,after.at,factor,angle);
        if (distance(after.at,before.at)>0) {
          const t=time.now(); speed(s,after.at[0]-before.at[0],after.at[1]-before.at[1],t-s.t); s.t=t;
        }
      }
    }
    // Tapping a selected object again selects the next object under the finger, as Altium's repeated click.
    function cycle(s,e,at,modified) {
      if (e.pointerType!=="touch" || s.tool!=="select" || modified || !s.selected || !s.hit?.item || s.pane.input || s.hit.pick) return false;
      const h=host(s), list=h.hit(s.pane.canvas,at[0],at[1],true);
      if (!Array.isArray(list) || !list.length) return false;
      const ids=h.selection(), c=s.cycle, pickable=i=>h.selectable?.(i)!==false;
      const same=c && c.doc===s.docId && distance(c.at,at)<TOUCH.cycleRadius && ids.length===1 && ids[0]===c.id;
      const seen=same?c.seen:new Set(list.filter(i=>ids.includes(i.id)).map(i=>i.id));
      let next=list.find(i=>!seen.has(i.id) && pickable(i));
      if (!next) { seen.clear(); next=list.find(pickable)||list[0]; }
      seen.add(next.id); s.cycle={doc:s.docId,at,id:next.id,seen};
      activate(s); h.select([next.id]);
      if (list.length>1) h.info?.(`Object ${list.indexOf(next)+1} of ${list.length} under the finger`);
      return true;
    }
    function tap(s,e) {
      const old=s.tap,at=client(e),id=s.hit?.item?.id,navigation=!!s.pane.input?.navigation;
      // Read-only views (Review Changes) keep double-tap to fit; editors cycle instead.
      if (navigation && s.tool==="select" && id && old?.id===id && old.doc===s.docId && time.now()-old.t<TAP && distance(at,old.at)<TOUCH.cycleRadius) {
        s.tap=null; activate(s); s.pane.input.zoom(s.hit); return;
      }
      s.tap=navigation && s.tool==="select" && id?{id,doc:s.docId,t:time.now(),at}:null;
      const item=s.hit?.item;
      // A checkbox or field claims its own hit rectangle. Keep tool placement and modifier edits on the ordinary path.
      const modified=e.shiftKey||e.ctrlKey||e.metaKey||e.altKey||e.pointerType==="touch"&&Object.values(keys).some(Boolean);
      if(id && s.tool==="select" && active(s) && !s.pane.input && !modified &&
        (item.kind==="textframe" || item.kind==="reviewItem" || globalThis.AtriumNotebook?.isNote?.(item))) {
        if(dispatch(s.pane.canvas,"waffle-canvas-tap",{...detail(s,e),source:"tap"})) return;
      }
      if(cycle(s,e,at,modified)) return;
      if(!s.aim)editing(s,e,"start"); replay(s,e,"pointerdown",at); replay(s,e,"pointerup",at); editing(s,e,"end");
    }
    function swipe(s) {
      if(s.swipe.size!==3) return;
      const delta=[...s.swipe.values()].map(r=>[r.at[0]-r.start[0],r.at[1]-r.start[1]]);
      const x=delta.reduce((n,p)=>n+p[0],0)/3;
      if(Math.abs(x)>=SWIPE && delta.every(([dx,dy])=>dx*Math.sign(x)>SWIPE/2 && Math.abs(dx)>1.6*Math.abs(dy))){
        command(s,x<0?"three-finger-swipe-left":"three-finger-swipe-right");
      }
    }
    function end(s,e,cancel) {
      stopHold(s);
      if (!cancel) move(s,e);
      hideCue(s);
      if (cancel) { rollback(s); s.mode="ignored"; s.invalid=true; s.tap=null; s.swipe=null; s.velocity=null; }
      else if(s.mode==="stream") {claimed.delete(s.pane.canvas);stream(s,e,"end");}
      else if(s.mode==="pending") tap(s,e);
      else if(s.mode==="held") menu(s,e);
      else if(s.mode==="drag" || s.mode==="place") {
        if(s.mode!=="drag") replay(s,e,"pointerdown");
        replay(s,e,"pointerup"); editing(s,e,"end");
      }
      const wasPan=s.mode==="pan";
      s.points.delete(e.pointerId); owners.delete(e.pointerId); pens.delete(e.pointerId);
      if(e.pointerType==="touch") s.lifted={t:time.now(),at:client(e)};
      if(!s.points.size) {
        s.recent=time.now(); s.recentAt=client(e);
        // Two or three fingers down and up quickly without travelling: undo or redo (GESTURES).
        const tapped=!cancel && !s.invalid && !s.wandered && (s.fingers===2||s.fingers===3) && time.now()-s.first<=TOUCH.multiTap;
        if(tapped) {
          if(s.multiCamera){s.pane.view.restoreCamera?.(s.multiCamera);frame(s.pane);}
          command(s,s.fingers===2?"two-finger-tap":"three-finger-tap");
        }
        else if(s.swipe) swipe(s);
        else if(wasPan&&!cancel) momentum(s);
        s.mode="idle"; s.aim=false; s.swipe=null; s.hit=null; s.last=null; s.down=null;
      }
    }
    function direct(e,pane) {
      const id=e.pointerId,down=e.type==="pointerdown",up=e.type==="pointerup",lost=e.type==="pointercancel"||e.type==="lostpointercapture";
      if(palms.has(id)) { if(up||lost) palms.delete(id); return true; }
      const s=owners.get(id) || (pane&&state(pane));
      if(!s) return false;
      if(!down){
        if(!owners.has(id)) return e.pointerType==="touch" || e.pointerType==="pen" && (up||lost||e.buttons>0);
        if(s!==entering&&!valid(s)) { reset(s); return true; }
        if(up||lost) end(s,e,lost); else move(s,e);
        return true;
      }
      const eraser=e.pointerType==="pen"&&(e.button===5||e.buttons===32)&&sketches.has(s.pane.canvas);
      if(e.button!==0 && !eraser) return false;
      stopMotion(); C()?.takeCamera?.(s.pane.view);
      if(e.pointerType==="touch" && pens.size) { palms.add(id); return true; }
      if(e.pointerType==="pen"&&pens.size || s.points.size && s.down?.pointerType==="mouse" && e.pointerType!=="mouse"){palms.add(id);return true;}
      if(e.pointerType==="pen") {
        // A palm may reach the screen before the stylus. Roll an unfinished touch edit back.
        for(const q of states.values()) if(q.points.size && ![...q.points.keys()].some(k=>pens.has(k))){
          for(const key of q.points.keys()) palms.add(key);
          reset(q);
        }
        pens.add(id);
      }
      if(!s.pane.input && ops.busy?.() && !s.points.size) { palms.add(id); pens.delete(id); return true; }
      if(s.points.has(id)) return true;
      // Direct touch is consumed before the document's hover listeners see it.
      if(e.pointerType==="touch") globalThis.AtriumCanvasHover?.dismiss();
      owners.set(id,s); const at=client(e); s.points.set(id,{start:at,at});
      try { s.pane.canvas.setPointerCapture(id); } catch {} // Includes a contact released during lazy loading.
      if(s.points.size===1) { if(s.web)s.web.direct=true; s.down=e; start(s,e); }
      else {
        stopHold(s); hideCue(s); rollback(s); s.tap=null; s.multi=true; s.velocity=null; s.t=time.now();
        s.fingers=Math.max(s.fingers||1,s.points.size); s.multiCamera??=s.pane.view.camera?.();
        if(s.web) s.web.direct=true;
        if(s.invalid)s.mode="ignored";
        else if(s.points.size===2) s.mode="pan";
        else if(s.points.size===3 && !s.invalid) { s.mode="three"; s.swipe=new Map([...s.points].map(([k,r])=>[k,{start:r.at,at:r.at}])); }
        else { s.mode="ignored"; s.invalid=true; s.swipe=null; }
      }
      return true;
    }
    function web(e,s) {
      const c=s.pane.canvas,g=s.web,r=c.getBoundingClientRect();
      const at=Number.isFinite(e.clientX)&&Number.isFinite(e.clientY)?client(e):g?.at||[r.left+r.width/2,r.top+r.height/2];
      const rotation=Number(e.rotation)||0;
      if(e.type==="gesturestart") {
        stopMotion(); C()?.takeCamera?.(s.pane.view);
        const last=s.wheelPinch;
        if(last && time.now()-last.t<45 && distance(last.at,at)<26) s.pane.view.restoreCamera(last.before);
        s.wheelPinch=null;
        s.web={at,scale:e.scale>0?e.scale:1,rotation,direct:!!s.points.size}; s.docId=docId(s.pane);
      } else if(e.type==="gestureend") { s.web=null; s.webEnd={at,t:time.now()}; }
      else if(g&&!g.direct && e.scale>0 && Number.isFinite(e.scale)) {
        const angle=cameraPref("camera.rotate")?turn((rotation-g.rotation)*Math.PI/180):0;
        pan(s,g.at,at,e.scale/g.scale,angle); g.at=at; g.scale=e.scale; g.rotation=rotation;
      }
      return true;
    }
    // Older WebKitGTK can deliver Touch Events while still having a PointerEvent constructor.
    // The stream that reports down first owns the sequence. A dual-delivery backend never edits twice.
    function touchList(e,pane) {
      let handled=false;
      const types={touchstart:"pointerdown",touchmove:"pointermove",touchend:"pointerup",touchcancel:"pointercancel"};
      for(const contact of Array.from(e.changedTouches||[])){
        const id=-1-contact.identifier;
        let p=legacy.get(id);
        if(!p){
          if(e.type!=="touchstart")continue;
          p=surfaces.get(contact.target)||ops.find?.(contact.target)||pane;if(!p)continue;
          const current=state(p);
          if([...current.points.keys()].some(k=>k>=0)||time.now()-(current.nativeTime??-Infinity)<55){handled=true;continue;}
          legacy.set(id,p);
        }
        const end=e.type==="touchend"||e.type==="touchcancel";
        const ev={type:types[e.type],pointerId:id,pointerType:"touch",isPrimary:true,button:0,buttons:end?0:1,
          clientX:contact.clientX,clientY:contact.clientY,width:2*(contact.radiusX||1),height:2*(contact.radiusY||1),
          pressure:end?0:contact.force||.5,tiltX:0,tiltY:0,twist:0,timeStamp:e.timeStamp,
          shiftKey:e.shiftKey,ctrlKey:e.ctrlKey,metaKey:e.metaKey,altKey:e.altKey};
        const s=state(p);s.legacyAt=client(ev);s.legacyTime=time.now();
        direct(ev,p); if(end)legacy.delete(id);handled=true;
      }
      return handled;
    }
    // A Mac touch display: WebKit also emulates a mouse, and Safari gesture events, from the fingers the macOS
    // host forwards as touch pointers (editor.js __waffleDirectTouch: untrusted, pointerId from 1e6). While host
    // contacts are down, and for HOST_QUIET ms after, those duplicates on a canvas are dropped. A mouse drag (a box) that
    // began just before the first host contact is the same finger: it is cancelled and its selection restored.
    const HOST_QUIET=300, hostIds=new Set(), dupMice=new Set();
    let hostQuiet=-Infinity, recentMouse=null;
    function hostDuplicate(e,pane){
      const t=time.now(),type=e.type,end=type==="pointerup"||type==="pointercancel"||type==="lostpointercapture";
      if(!e.isTrusted&&e.pointerType==="touch"&&e.pointerId>=1e6){
        if(type==="pointerdown"){
          const m=recentMouse;
          if(!hostIds.size&&m&&t-m.t<150&&m.pane.canvas.isConnected){
            recentMouse=null; dupMice.add(m.e.pointerId);
            editEvent(m.pane.canvas,m.e,"pointercancel"); // the editor drops its box or move unchanged
            if(m.selection)ops.host?.()?.select?.(m.selection);
          }
          hostIds.add(e.pointerId);
        } else if(end&&hostIds.delete(e.pointerId)&&!hostIds.size) hostQuiet=t+HOST_QUIET;
        return null;
      }
      const owned=!!pane&&(hostIds.size>0||t<hostQuiet); // chrome keeps every mouse event
      if(e.pointerType==="mouse"&&(type.startsWith("pointer")||type==="lostpointercapture")){
        if(dupMice.has(e.pointerId)){if(end)dupMice.delete(e.pointerId);return true;}
        if(type==="pointerdown"){
          if(owned){dupMice.add(e.pointerId);return true;}
          if(e.isTrusted&&e.button===0&&pane)recentMouse={e,pane,t,selection:ops.host?.()?.selection?.()};
          return null;
        }
        if(end&&recentMouse?.e.pointerId===e.pointerId)recentMouse=null;
        return owned&&!e.buttons&&!end?true:null; // hover echoes of the fingers
      }
      return owned&&type.startsWith("gesture")?true:null;
    }
    function handle(e,pane) {
      if(replayed.has(e)) return false;
      const duplicate=hostDuplicate(e,pane); if(duplicate!==null) return duplicate;
      if(e.type==="pointerdown" || e.type==="touchstart") C()?.stopWheel?.();
      if(e.type==="dblclick" && cancelSketch(pane?.canvas))return true;
      if(e.type.startsWith("touch"))return touchList(e,pane);
      if(e.pointerType==="touch" && e.type.startsWith("pointer")){
        if(e.type==="pointerdown" && pane && [...legacy.values()].includes(pane))shadows.add(e.pointerId);
        if(shadows.has(e.pointerId)){if(e.type==="pointerup"||e.type==="pointercancel")shadows.delete(e.pointerId);return true;}
        if(pane)state(pane).nativeTime=time.now();
      }
      if(e.pointerType==="mouse" && e.type.startsWith("pointer")){
        const s=pane&&state(pane),fromTouch=e.sourceCapabilities?.firesTouchEvents;
        if(e.type==="pointerdown" && (fromTouch || fromTouch==null && s?.legacyAt && time.now()-s.legacyTime<90 && distance(s.legacyAt,client(e))<12))mouseShadows.add(e.pointerId);
        if(mouseShadows.has(e.pointerId)){if(e.type==="pointerup"||e.type==="pointercancel")mouseShadows.delete(e.pointerId);return true;}
      }
      if(e.type==="pointerdown" && e.pointerType==="mouse") {
        stopMotion(); if(pane) state(pane).recent=-Infinity;
        if(!pane || e.button!==0 || !sketches.has(pane.canvas)&&!tools.has(pane.canvas))return false;
        const taken=direct(e,pane),s=state(pane);if(taken&&s.mode==="stream")return true;
        if(taken)reset(s);return false;
      }
      if(e.pointerType==="touch" && e.type==="pointerdown" && pens.size){palms.add(e.pointerId);return true;}
      if(e.pointerType==="touch" && palms.has(e.pointerId)){if(e.type==="pointerup"||e.type==="pointercancel"||e.type==="lostpointercapture")palms.delete(e.pointerId);return true;}
      // WebKit replays a mouse move where a finger lifted. That echo is not hover: no card, no owner outline.
      if(e.pointerType==="mouse" && !e.buttons && (e.type==="pointermove"||e.type==="pointerover") && pane){
        const t=state(pane).lifted; if(t && time.now()-t.t<700 && distance(t.at,client(e))<24) return true;
      }
      if(e.type.startsWith("pointer")||e.type==="lostpointercapture") return (e.pointerType==="touch" || e.pointerType==="pen" || owners.has(e.pointerId)) && direct(e,pane);
      if(!pane) return false;
      const s=state(pane);
      if(e.type.startsWith("gesture")) return web(e,s);
      if(e.type==="wheel") {
        if(!s.web&&!s.points.size) C()?.wheel(e,pane.view,pinch=>{
          const at=pinch?client(e):null;
          if(at && s.webEnd && time.now()-s.webEnd.t<65 && distance(s.webEnd.at,at)<26) return null;
          stopMotion(); s.webEnd=null;
          s.wheelPinch=pinch?{at,t:time.now(),before:pane.view.camera()}:null;
          let anchor;
          return ()=>anchor??=loc(s,at||client(e));
        },pane.canvas,(inFrame,wheelEnd)=>frame(pane,inFrame,wheelEnd));
        return true;
      }
      // Direct input already selected, placed or opened a menu. Retain real mouse/keyboard menus.
      return e.pointerType==="touch" || e.pointerType==="pen" || !!s.points.size ||
        time.now()-s.recent<700 && s.recentAt && distance(s.recentAt,client(e))<24;
    }
    globalThis.addEventListener?.("keydown",e=>{if(e.key==="Escape")clear();},true);
    // Loading touch-only grips can wait until the next fresh, ordinary finger contact.
    const needsTouchPrecision=canvas=>!owners.size && !sketches.has(canvas) && !tools.has(canvas);
    // Help › Troubleshooting › Input Diagnostics (input-diagnostics.js) watches what the scheme took while it is open.
    const traced=(e,pane)=>{const taken=handle(e,pane);globalThis.__waffleInputTrace?.(e,taken,pane);return taken;};
    return {handle:traced,clear,prune,stopMotion,needsTouchPrecision};
  }
  return {TOUCH, GESTURES, create, orientation, zoomBox, library, registerView, documentHit, cancelSketch, setSketchActive:(c,on)=>arm(sketches,c,on),setToolActive:(c,on)=>arm(tools,c,on),
    ignoreSnap:()=>!!touchEvent?.altKey, surface:c=>surfaces.get(c), stopMotion:v=>coasting.get(v)?.(), isReplay:e=>replayed.has(e), isGrip:e=>grips.has(e), setModifiers, modifiers:()=>({...keys})};
})();
