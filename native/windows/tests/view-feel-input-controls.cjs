"use strict";

const wait = ms => new Promise(resolve=>setTimeout(resolve,ms));
const evaluate = (client,fn,...args) => client.evaluate("(" + fn.toString() + ")(" + args.map(x=>JSON.stringify(x)).join(",") + ")");

function armPointerControl(action) {
  const H = AtriumNavHost, canvas = H.canvas(), view = H.view(), r = canvas.getBoundingClientRect();
  const toolBefore = H.tool();
  H.setTool("select");
  const pane = H.panes().find(p=>p.canvas===canvas), DRC = globalThis.AtriumDRCView;
  const markers = globalThis.AtriumDRCMarkers;
  const markerAt = ([x,y]) => pane && DRC && markers?.markerAt(H,pane,DRC.violations(pane.docId),x,y,DRC.waived(pane.docId));
  const problems = globalThis.AtriumProblemMarks, cross = globalThis.AtriumChecksCross;
  const badges = cross?.projected(H,H.doc()) || [];
  const badgeAt = ([x,y]) => pane && problems?.badgeUnder(pane,badges,"pcb",x-r.left,y-r.top);
  const Insights = globalThis.AtriumInsightsUI;
  const insightAt = ([x,y]) => pane && Insights?.markerAt?.(pane,x,y);
  const markerName = marker => marker ? {id:marker.id,type:marker.type} : null;
  const partAt = id => {
    const item = H.doc().items.find(p=>p.id===id);
    return item && AtriumNavCommon.itemBox(H.doc(),H.defs(),item);
  };
  const {width,height} = r;
  let target = null;
  let occludedByMarkers=0;
  const inside = (x,y) => x>r.left+70 && y>r.top+70 && x<r.right-110 && y<r.bottom-100;
  const pixel = n => Math.round(n*devicePixelRatio)/devicePixelRatio;
  const pointAt = world => {
    const [x,y]=view.worldToScreen(world);
    return [pixel(r.left+x),pixel(r.top+y)];
  };
  if (action === "pan") target = {id:null,point:[Math.round(r.left+width*.48),Math.round(r.top+height*.48)]};
  else if (action === "insight") {
    const radius=problems?.size(problems.scaleOf(view),"pcb","hint").r;
    for (const insight of Insights?.current?.() || []) {
      const point=pointAt(Insights._markAt(insight,radius));
      if (!inside(...point) || document.elementFromPoint(...point)!==canvas || markerAt(point) || badgeAt(point) ||
          insightAt(point)?.key!==insight.key) continue;
      target={id:null,point,insight:insight.key};
      break;
    }
  }
  else for (const item of H.doc().items) {
    if (item.kind!=="part" || item.locked || !H.selectable(item)) continue;
    const box=partAt(item.id);
    if (!box) continue;
    for (const [u,v] of [[.5,.5],[.25,.25],[.75,.25],[.25,.75],[.75,.75],[.5,.25],[.5,.75]]) {
      const point=pointAt([box[0]+(box[2]-box[0])*u,box[1]+(box[3]-box[1])*v]);
      if (!inside(...point) || document.elementFromPoint(...point)!==canvas || H.hit(canvas,...point)?.item?.id!==item.id) continue;
      const marker=markerAt(point), badge=badgeAt(point), insight=insightAt(point);
      if (action==="marker" && (!marker || badge || insight)) continue;
      if (action!=="marker" && (marker || badge || insight)) { occludedByMarkers++; continue; }
      target={id:item.id,point,marker:markerName(marker)};
      break;
    }
    if (target) break;
  }
  if (!target || document.elementFromPoint(...target.point)!==canvas) throw Error("No proven pointer target on the actual board");
  const state = () => {
    const part=target.id && H.doc().items.find(item=>item.id===target.id);
    return {item:part && partAt(target.id),placement:part && {x:part.x,y:part.y,angle:part.angle,ref:part.ref,def:part.def},
      camera:view.camera(),revision:H.authoredRevision(),drag:H.drag()?.kind || null,tool:H.tool(),selection:H.selection(),
      focusedDrcMarker:markerName(DRC?.focused()),openInsight:Insights?.cardFor?.()?.key || null};
  };
  const before = state(), events = [], pressRoute = [], abort = new AbortController();
  const press = (node,name,capture) => node.addEventListener("pointerdown",event=>{
    const info = {
      name,pointerId:event.pointerId,pointerType:event.pointerType,primary:event.isPrimary,trusted:event.isTrusted,
      button:event.button,targetIsCanvas:event.target===canvas,cancelled:event.defaultPrevented,
      captured:canvas.hasPointerCapture(event.pointerId),tool:H.tool(),drag:H.drag()?.kind || null
    };
    if (name === "window") {
      info.actualHit = H.hit(canvas,event.clientX,event.clientY)?.item?.id || null;
      info.markerHit = markerName(markerAt([event.clientX,event.clientY]));
      info.crossBadgeHit = badgeAt([event.clientX,event.clientY])?.label || null;
      info.insightHit = insightAt([event.clientX,event.clientY])?.key || null;
      setTimeout(()=>pressRoute.push({...info,name:"after-press-task",
        captured:canvas.hasPointerCapture(event.pointerId),drag:H.drag()?.kind || null,
        focusedDrcMarker:markerName(DRC?.focused())}),0);
    }
    pressRoute.push(info);
  },{capture,passive:true,signal:abort.signal});
  press(window,"window",true);
  press(document,"document",true);
  press(canvas,"canvas-capture",true);
  press(canvas,"canvas-after-editor",false);
  for (const type of ["pointerdown","pointerup","pointermove","pointercancel","gotpointercapture","lostpointercapture","keydown"]) {
    addEventListener(type,event=>{
      if (event.type === "pointermove" && !event.buttons) return;
      if (event.type === "keydown" && event.key!=="Escape") return;
      events.push({type,button:event.button,buttons:event.buttons,key:event.key,trusted:event.isTrusted,
        canvas:event.composedPath().includes(canvas),x:event.clientX,y:event.clientY,drag:H.drag()?.kind||null,
        target:event.target?.closest?.(".insight-card") ? "insight-card" : event.target?.tagName});
    },{capture:true,passive:true,signal:abort.signal});
  }
  window.__winPointerStop = () => {
    abort.abort();
    delete window.__winPointerStop;
    return {before,after:state(),events,pressRoute,toolBefore,viewport:[innerWidth,innerHeight]};
  };
  return {...target,dpr:devicePixelRatio,occludedByMarkers};
}

async function pointerTrial(client,{action,sendNativePointer,verify}) {
  let raw,native,target;
  const result = {action,pass:false};
  try {
    const start=await verify();
    target=await evaluate(client,armPointerControl,action);
    try { native=await sendNativePointer({point:target.point,dpr:target.dpr,action:action==="insight" ? "marker" : action,window:start.os}); }
    finally {
      await wait(500);
      raw=await client.evaluate("__winPointerStop()");
    }
    // This control expects its own card to cover part of the editor after the
    // trusted press. All physical window and focus checks still run.
    await verify(action==="insight" ? target.insight : undefined);
    if (native?.status !== "performed") throw Error(native?.reason || "native pointer input unavailable");
    if (native.accepted !== (action==="cancel" ? 4 : 2))
      throw Error("Win32 did not admit each expected button or Escape event");
    const {before,after,events,viewport}=raw, button=action==="pan"?1:0;
    const down=events.filter(e=>e.type==="pointerdown" && e.trusted && e.canvas && e.button===button);
    const releases=events.filter(e=>e.type==="pointerup" && e.trusted && e.button===button);
    if (action==="marker" || action==="insight") {
      const press=raw.pressRoute.find(e=>e.name==="window");
      const markerMatches = action==="marker" ? target.marker?.id && press?.markerHit?.id===target.marker.id &&
        after.focusedDrcMarker?.id===target.marker.id : target.insight && press?.insightHit===target.insight && after.openInsight===target.insight;
      if (down.length!==1 || releases.length!==1 || !markerMatches ||
          !raw.pressRoute.some(e=>e.name==="document" && e.cancelled) ||
          raw.pressRoute.some(e=>e.name==="canvas-capture" || e.captured) ||
          after.drag || before.revision!==after.revision)
        throw Error("The trusted problem marker click did not follow its ordinary document capture route");
      return {...result,pass:true,target,native,raw};
    }
    const up=releases.filter(e=>e.canvas);
    if (down.length!==1 || up.length!==1 || before.drag || after.drag ||
        !events.some(e=>e.type==="pointermove" && e.trusted && e.buttons===(button===1 ? 4 : 1) && e.drag))
      throw Error("The trusted native drag did not begin, move and release once");
    if (action!=="pan") {
      const press=raw.pressRoute.find(e=>e.name==="window");
      if (press?.markerHit || press?.crossBadgeHit || press?.insightHit || press?.actualHit!==target.id)
        throw Error("The actual native press missed the marker-free selected footprint");
    }
    const outside=up[0].x<0 || up[0].y<0 || up[0].x>=viewport[0] || up[0].y>=viewport[1];
    if (outside !== (action==="outside")) throw Error("The release was on the wrong side of the native window");
    const same=(a,b)=>Array.isArray(a)&&Array.isArray(b)&&a.length===b.length&&a.every((n,i)=>Math.abs(n-b[i])<1e-6);
    if (action==="cancel") {
      if (!events.some(e=>e.type==="keydown" && e.trusted && e.key==="Escape") ||
          !same(before.item,after.item) || before.revision!==after.revision)
        throw Error("Escape did not roll back the native drag");
    } else if (action==="pan") {
      const {scale,cx,cy}=before.camera;
      const target=[cx-(up[0].x-down[0].x)/scale,cy-(up[0].y-down[0].y)/scale];
      const actual=[after.camera.cx,after.camera.cy];
      if (after.camera.scale!==scale || before.revision!==after.revision ||
          Math.hypot(...actual.map((v,i)=>v-target[i]))*scale>2)
        throw Error("The middle button did not preserve the two-axis pan");
    } else {
      if (!before.item || !after.item || same(before.item,after.item) || after.revision<=before.revision)
        throw Error("The trusted drop did not move and commit the selected footprint");
      await client.evaluate('AtriumNavHost.act("undo")');
      const restored=await evaluate(client,id=>{
        const H=AtriumNavHost,item=H.doc().items.find(p=>p.id===id);
        return item && AtriumNavCommon.itemBox(H.doc(),H.defs(),item);
      },target.id);
      if (!same(before.item,restored)) throw Error("Undo did not restore the footprint");
      result.undo=true;
    }
    result.pass=true;
  } catch (error) { result.reason=error.message; }
  return {...result,target,native,raw};
}

async function mountTwoPartBoard() {
  const A=Atrium, H=AtriumNavHost, project=A.project("Native pointer control",AtriumParts.catalogue.filter(i=>i.id==="std-r"));
  const board=project.documents.find(d=>d.kind==="pcb");
  board.outline=[[0,0],[46,0],[46,32],[0,32]];
  board.items=[[12,11],[31,20]].map(([x,y],i)=>({id:A.id(),kind:"part",def:"std-r",x,y,angle:0,ref:"R"+(i+1),value:"10 kΩ"}));
  project.documents=[board];
  await H.replaceProject(project,{force:true});
  H.selectDocument(board.id);
  H.setTool("select");
  H.canvas().focus();
  AtriumPrefs.set("display.renderer","2d");
  H.act("fit");
  H.redraw(true);
  await AtriumLazy.need(["AtriumDRC","AtriumInsightsUI"]);
  AtriumInsightsUI.schedule({now:true});
  return {id:board.id,partCount:H.doc().items.length,rules:AtriumRules.drc(H.doc(),H.defs()).total};
}

module.exports={pointerTrial,mountTwoPartBoard};
