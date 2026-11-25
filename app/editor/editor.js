"use strict";
(() => {
  const A=Atrium, $=id=>document.getElementById(id);
  // The active pane's canvas and view. Split view swaps these when another pane is activated.
  let canvas=$("canvas"), view=AtriumCanvas.create(canvas);
  if(matchMedia("(max-width:620px)").matches)document.body.classList.add("hide-left","hide-right");
  const uid=A.id;
  const {el, appendPropertyRow: row} = AtriumNavCommon;
  function btn(text,act,cls) {const n=el("button",text,cls);n.type="button";if(typeof act==="function")n.onclick=act;else n.dataset.action=act;return n;}
  function inspectorButton(text,act,cls) {const n=btn(text,act,cls);return globalThis.AtriumUI?.button(n,"secondary")??n;}
  function info(text) {const node=$("status");if(node&&node.textContent!==text)node.textContent=text;}
  // i18n: the status text may be shown translated (i18n-dom.js); compare with both.
  const notebookOff=()=>globalThis.AtriumLabs?.notebookEnabled()===false;
  const notebookLocked=i=>notebookOff() && !!A.notebookItemKind(i);
  const notebookNotice="Notebook items are read-only while notebook features are off.";
  // Compare just authored notebook data. Never invoke a provider or load user assets.
  // An edit may target another sheet or change an item's kind, so hints alone are insufficient.
  function notebookState(p){
    const rows=[];
    for(const d of p.documents){
      if(d.kind!=="schematic")continue;
      if(d.notesLayer!==undefined)rows.push([d.id,"layer",d.notesLayer]);
      for(const i of d.items)if(A.notebookItemKind(i))rows.push([d.id,i]);
    }
    for(const r of p.rules?.list||[])if(r.origin?.kind==="calculation")rows.push(["rule",r]);
    return JSON.stringify(rows);
  }
  const loadingStatus=()=>{const t=$("status")?.textContent;return t==="Loading…"||t===globalThis.AtriumI18n?.text?.("Loading…","status");};
  let project, current, defs, selected=null,tool="select",pending=null,ghostAngle=0,drag=null,chain=[],routeNet="",routeWidth=globalThis.AtriumPref?.get("pcb.trackWidth",.25)||.25,layer="Top",grid=true,highlight="",hidden=new Set(),refScale=1,showUnrouted=globalThis.AtriumPref?.get("pcb.showRatsnest",true)!==false,focusedPart=null,swapFootprint=null;
  let revision=0,authoredRevision=0,pointer=null,dirty=false,history=[],future=[],frame=0,openBusy=false,libraryTarget=null;
  let schematicNetHighlight=null;
  const emptyHighlightMembers={ids:new Set(),pins:[]};
  const dialog=$("library-dialog"), query=$("library-search");
  let selectedIds=new Set(),clipboard=null,paste=null,layerMode="all";
  let guideSession=null,guideResult=null,smartGuides=true,designatorFollow=false;
  let pcbEdit=null; // AtriumPCBEdit controller (flip, lock, unions, multi-edit, Find Similar, snap, HUD)
  let layerCache=null,measureStart=null,measureEnd=null,selectionVersion=0,highlightSelectionVersion=-1;
  // Navigation modules (nav-common.js): events, render contributions and registered actions.
  const navListeners=new Map(),navRenderers=new Set(),navActions=new Map();let navVersion=0;
  let canvasInput=null, inputLoad=null, pendingInput=[];
  const coldContacts=new Map();
  function navEmit(t,detail){if(t==="replace"||t==="document")cancelInput();else if(t==="panes")canvasInput?.prune();for(const f of navListeners.get(t)||[])try{f(detail);}catch(e){globalThis.console?.error?.(e);}}
  function navRender(d,info){let o=null;for(const f of navRenderers){let r=null;try{r=f(d,info);}catch(e){globalThis.console?.error?.(e);}if(!r)continue;o??={};for(const k in r){if(k==="overlay")(o.overlay??=[]).push(r.overlay);else o[k]=r[k];}}return o;}
  function assignSelection(ids,primary=null,keepHighlight=false){
    const netChosen=keepHighlight&&highlightSelectionVersion===selectionVersion;
    selectedIds=new Set(ids);selectionVersion++;if(netChosen)highlightSelectionVersion=selectionVersion;fieldSel=null;
    selected=selectedIds.has(primary)?primary:selectedIds.values().next().value??null;
    globalThis.AtriumExtensions?.notify("selectionChanged");navEmit("selection");
  }
  function single(id){assignSelection(id?[id]:[],id);}
  const documentViews=new Map();
  // Split view. Each pane owns a canvas and a view (camera and render caches). The active
  // pane's canvas, view, document and visual state live in the editor globals; an inactive
  // pane keeps a copy of its state and re-renders only when its inputs change.
  const panes=[{canvas,stage:$("canvas-stage"),view,docId:null,state:null,version:0,sig:""}];
  // A view asks for an exact frame after a pan or zoom gesture and after deferred airwires (canvas.js).
  function paneRepaint(p){if(!p.view)return;p.version++;if(p===activePane)draw();else schedule();}
  view.onRepaint?.(()=>paneRepaint(panes[0]));
  let activePane=panes[0],splitState=null;
  const splitKey="atrium-split-v1";
  // Sash drags (dock or split). A pane whose full repaint is cheap follows the sash live: paneObserver redraws
  // it in the frame of each layout change. A pane whose repaint costs more than PIN_MS (a dense board)
  // would drop frames doing that, so it is pinned instead: its canvas, and the GPU board layer over it,
  // keep their size with their centre where it was in the pane (the camera keeps the centre too), the pane
  // clips them, and the sash's release unpins them for one exact repaint.
  const PIN_MS=12;let sashFrozen=null;
  function recordPaintCost(p,d,cost,reused){
    // A resize invalidates the retained base. Keep the cost of rebuilding it across cached paints
    // and tab switches, while a cheap full paint of another document can still resize live.
    const costs=p.resizeCosts??=new WeakMap();
    costs.set(d,reused?Math.max(cost,costs.get(d)||0):cost);
  }
  function freezePanes(){
    if(sashFrozen)return;
    sashFrozen=[];
    for(const p of panes){
      const c=p.canvas,stage=c?.parentElement;
      const d=p===activePane?doc():docById(p.docId);
      if(!c?.isConnected||!stage||!(p.resizeCosts?.get(d)>PIN_MS))continue;
      const s=stage.getBoundingClientRect();
      for(const n of [c,stage.querySelector(":scope>.atrium-gpu-board")]){
        if(!n||getComputedStyle(n).display==="none")continue;
        const r=n.getBoundingClientRect();if(!r.width||!r.height)continue;
        sashFrozen.push([n,n.style.cssText]);
        const x=`calc(50% + ${r.left-s.left-s.width/2}px)`,y=`calc(50% + ${r.top-s.top-s.height/2}px)`;
        n.style.cssText+=`;position:absolute;margin:0;width:${r.width}px;height:${r.height}px;left:${x};top:${y}`+
          `;left:round(nearest,${x},1px);top:round(nearest,${y},1px)`;
      }
    }
  }
  function thawPanes(){if(!sashFrozen)return;for(const [n,css] of sashFrozen)n.style.cssText=css;sashFrozen=null;}
  document.addEventListener("pointerdown",e=>{if(e.button===0&&e.target.closest?.(".dock-sash,#canvas-sash"))freezePanes();},true);
  addEventListener("resize",thawPanes);
  let homeFit=null,openFit=null;
  // A pane that changes size (a dock or split sash, a panel opening, the window) is redrawn in this
  // same frame: the observer runs after layout and before paint, so the canvas never shows a stretched,
  // cleared or stale bitmap, or a void beside it, for one frame.
  const paneObserver=new ResizeObserver(entries=>{
    let sized=false;
    for(const e of entries||[]){
      const p=panes.find(q=>q.canvas===e.target);if(!p)continue;
      const w=e.contentRect.width,h=e.contentRect.height;
      if(p.size&&p.size[0]===w&&p.size[1]===h)continue; // this frame's paint already measured and drew it
      p.size=[w,h];p.view?.resized?.(e.contentRect);p.version++;if(p===activePane)activeDirty=true;
      if(homeFit&&p===panes[0]&&e.contentRect.width&&e.contentRect.height){
        const target=homeFit;homeFit=null;
        if(p===activePane&&doc()===target&&starter)fit(e.contentRect);
      }
      sized=true;
    }
    if(sized&&viewportVisible&&!homeFit){if(frame){cancelAnimationFrame(frame);frame=0;}paintFrame();}else schedule();
  });
  const otherPane=()=>panes[1]?(activePane===panes[0]?panes[1]:panes[0]):null;
  const docById=id=>folder()?.loadedDocument(id)||project.documents.find(d=>d.id===id);
  function invalidateViews(d,items){for(const p of panes)if(p.view&&(p===activePane||p.docId===d.id))p.view.invalidate(d,items);}
  // Selection follows component links across a schematic and its board.
  function linkedIds(target,source,ids){
    if(target===source)return [...ids];
    const base=l=>l.split("@")[0],links=new Set();for(const i of source.items)if(i.link&&ids.has(i.id))links.add(base(i.link));
    return links.size?target.items.filter(i=>i.link&&links.has(base(i.link))).map(i=>i.id):[];
  }
  function renderOther(trace){
    const p=otherPane(),d=p&&docById(p.docId);if(!d)return;
    const same=d===doc(),sig=[revision,d.id,highlight,showUnrouted,grid,selectionVersion,p.version,navVersion].join("|");
    if(!same&&sig===p.sig)return;
    p.sig=sig;const t=performance.now();
    const st=p.state,ids=same?selectedIds:new Set(linkedIds(d,doc(),selectedIds));
    const schematicHighlightIds=schematicHighlight(d)?.ids;
    const netByWire=d.kind!=="pcb"&&highlight&&!schematicHighlightIds?nets(d).byWire:undefined;
    const opts={hidden:st.hidden,layer:st.layer,layerMode:st.layerMode,grid,selected:same?selected:ids.values().next().value??null,selectedIds:ids,highlight,showUnrouted,
      transientGeometry:same&&!!drag?.before,routing:false,width:routeWidth,netByWire,schematicHighlightIds,...navRender(d,{active:false,same}),editorPane:true};
    const started=trace?performance.now():0;
    const reused=p.view.render(d,defs,opts);
    const end=performance.now();recordPaintCost(p,d,end-t,reused);
    if(trace&&p.size?.[0]&&p.size[1])trace.draw(p.canvas,started,end);
  }
  function activatePane(p){
    if(!p?.view||p===activePane)return;
    if(drag)endDrag(true);
    const prev=activePane,oldDoc=doc(),oldIds=new Set(selectedIds);
    rememberDocumentView();
    prev.docId=current;prev.state={refScale,hidden,layer,layerMode};prev.version++;
    resetTools();
    activePane=p;view=p.view;canvas=p.canvas;current=p.docId;
    ({refScale,hidden,layer,layerMode}=p.state);layerCache=null;
    const d=doc();assignSelection(linkedIds(d,oldDoc,oldIds));globalThis.AtriumExtensions?.notify("activeDocumentChanged");
    p.stage.append($("tools"));
    refresh();navEmit("document");
  }
  function counterpart(){
    const d=doc(),kind=d.kind==="pcb"?"schematic":"pcb";
    return A.preferredDocument(project,kind,null)?.id||folder()?.documents().find(x=>x.kind===kind)?.id||project.documents.find(x=>x!==d)?.id||d.id;
  }
  function saveSplit(){
    const split=splitState?{...splitState,doc:otherPane()?.docId}:null;
    if(folder())folder().setView({split});
    else try{globalThis.sessionStorage?.setItem(splitKey,JSON.stringify(split));}catch{}
  }
  function clampRatio(r){return Math.min(.9,Math.max(.1,Number.isFinite(r)?r:.5));}
  function applySplitLayout(){
    const host=$("editor-panes"),second=panes[1];
    host?.classList.toggle("is-split",!!second);host?.classList.toggle("split-down",splitState?.orientation==="down");
    const first=panes[0].stage;
    first.style.flex="";
    if(second){
      const ratio=splitState.ratio, basis=`round(nearest,calc((100% - var(--s-2)) * ${ratio}),1px)`;
      if(globalThis.CSS?.supports?.("flex-basis","round(nearest,100%,1px)")){
        first.style.flex="0 1 "+basis;
        second.stage.style.flex="1 1 0px";
      }else{
        first.style.flex=ratio+" 1 0px";
        second.stage.style.flex=(1-ratio)+" 1 0px";
      }
      const sash=$("canvas-sash");sash.setAttribute("aria-orientation",splitState.orientation==="down"?"horizontal":"vertical");
      sash.setAttribute("aria-valuenow",String(Math.round(splitState.ratio*100)));
    }
  }
  function bindSash(sash){
    const host=$("editor-panes"),stacked=()=>getComputedStyle(host).flexDirection==="column";
    sash.addEventListener("pointerdown",e=>{
      if(e.button!==0)return;e.preventDefault();sash.setPointerCapture?.(e.pointerId);sash.classList.add("is-dragging");
      let last=null,raf=0;
      const apply=()=>{
        raf=0;const ev=last;if(!ev||!splitState)return;last=null;
        const b=host.getBoundingClientRect(),down=stacked(),size=down?b.height:b.width,min=down?120:240;
        const at=(down?ev.clientY-b.top:ev.clientX-b.left)/size;
        splitState.ratio=size>2*min+4?Math.min(1-min/size,Math.max(min/size,at)):.5;applySplitLayout();
      };
      // One layout per frame; the panes then redraw in that frame (paneObserver).
      const follow=ev=>{last={clientX:ev.clientX,clientY:ev.clientY};if(!raf)raf=requestAnimationFrame(apply);};
      const done=()=>{if(raf)cancelAnimationFrame(raf);apply();thawPanes();sash.classList.remove("is-dragging");sash.removeEventListener("pointermove",follow);sash.removeEventListener("pointerup",done);sash.removeEventListener("pointercancel",done);saveSplit();};
      sash.addEventListener("pointermove",follow);sash.addEventListener("pointerup",done);sash.addEventListener("pointercancel",done);
    });
    sash.addEventListener("dblclick",()=>{splitState.ratio=.5;applySplitLayout();saveSplit();});
    sash.addEventListener("keydown",e=>{
      const down=stacked(),step=({ArrowLeft:-1,ArrowRight:1,ArrowUp:-1,ArrowDown:1})[e.key];
      if(!step||(down!==(e.key==="ArrowUp"||e.key==="ArrowDown")))return;
      e.preventDefault();e.stopPropagation();splitState.ratio=clampRatio(splitState.ratio+step*.02);applySplitLayout();saveSplit();
    });
  }
  function openSplit(orientation="right",docId=null,{focus=true,ratio}={}){
    const session=folder(), requested=docId||counterpart();
    if(session?.getDocumentRef(requested)&&!docById(requested)){
      return session.ensureDocument(requested,{purpose:"view"}).then(()=>folder()===session&&openSplit(orientation,requested,{focus,ratio}),e=>info(e.message));
    }
    if(panes[1]){
      splitState.orientation=orientation;if(ratio!==undefined)splitState.ratio=clampRatio(ratio);applySplitLayout();
      if(docId&&focus){const p=panes[1];if(activePane!==p)activatePane(p);selectDocument(docId);}
      else if(docId)showInOther(docId);
      saveSplit();syncSplit();return;
    }
    const host=$("editor-panes");if(!host)return;
    const id=docById(docId)?docId:counterpart(),d=docById(id);
    const stage=el("div",null,"split-pane"),c=el("canvas",null,"ui-viewport"),sash=el("div",null,"split-sash");
    stage.id="canvas-stage-2";stage.setAttribute("role","region");
    c.id="canvas-2";c.dataset.interaction="design";c.tabIndex=0;c.setAttribute("aria-label","Second design canvas");stage.append(c);
    sash.id="canvas-sash";sash.tabIndex=0;sash.setAttribute("role","separator");sash.setAttribute("aria-label","Resize split editor");
    sash.setAttribute("aria-valuemin","10");sash.setAttribute("aria-valuemax","90");
    host.append(sash,stage);
    const saved=documentViews.get(id);
    const p={canvas:c,stage,view:AtriumCanvas.create(c),docId:id,version:0,sig:"",
      state:saved?{refScale:saved.refScale,hidden:new Set(saved.hidden),layer:saved.layer,layerMode:saved.layerMode}:{refScale:1,hidden:new Set(),layer:"Top",layerMode:"all"}};
    panes.push(p);p.view.saveWritePending?.(folderPending||folderSaving);p.view.onRepaint?.(()=>paneRepaint(p));splitState={orientation,ratio:clampRatio(ratio)};applySplitLayout();
    bindCanvas(c);bindSash(sash);paneObserver.observe(c);
    // The new pane is narrower than the canvas any saved camera came from: fit it.
    p.view.fit(d,defs);p.state.refScale=p.view.scale()||1;
    /* chords-refit */if(activePane===panes[0])fit();
    if(focus){activatePane(p);canvas.focus();}else{refresh();navEmit("panes");}
    saveSplit();info("Split "+(orientation==="down"?"down":"right")+" · "+d.name);
  }
  function closeSplit(quiet=false,remember=true){
    const p=panes[1];if(!p)return;
    if(drag)endDrag(true);
    const first=panes[0];
    if(activePane===p){
      // Keep the document being worked on: the primary pane adopts it and its camera.
      if(first.state)documentViews.set(first.docId,{view:first.view.camera(),...first.state});
      const cam=view.camera();resetTools();
      activePane=first;view=first.view;canvas=first.canvas;first.docId=current;view.restoreCamera(cam);
      first.stage.append($("tools"));
    }else if(docById(p.docId))documentViews.set(p.docId,{view:p.view.camera(),...p.state});
    p.view.onRepaint?.(null);paneObserver.unobserve?.(p.canvas);p.stage.remove();$("canvas-sash")?.remove();
    p.view=null;panes.length=1;splitState=null;applySplitLayout();
    for(const n of document.querySelectorAll(".pane-caption"))n.remove();
    if(remember)saveSplit();
    if(!quiet){refresh();canvas.focus();info("Split closed");}navEmit("panes");
  }
  function validatePanes(){
    const other=otherPane();
    if(other&&!docById(other.docId))closeSplit(true);
  }
  function restoreSplit(){
    let saved=null;try{saved=JSON.parse(globalThis.sessionStorage?.getItem(splitKey)||"null");}catch{}
    if(saved&&docById(saved.doc))openSplit(saved.orientation==="down"?"down":"right",saved.doc,{focus:false,ratio:saved.ratio});
  }
  const shortcutBinding=(action,kind=doc()?.kind)=>globalThis.AtriumKeymap?.hintKey(action,kind);
  function chromeAttribute(node,name,value){if(node.getAttribute(name)!==value)node.setAttribute(name,value);}
  function chromeFlag(node,name,value){if(node[name]!==value)node[name]=value;}
  const actionSelector=actions=>actions.map(action=>'[data-action="'+action+'"]').join(",");
  let toolControls,checkedMenuControls;
  function syncSplitTitles(force=false){
    const isSplit=!!panes[1],kind=doc().kind;
    if(!force&&lastSplitTitleKind===kind&&lastSplitTitleState===isSplit)return;
    lastSplitTitleKind=kind;lastSplitTitleState=isSplit;
    const C=globalThis.AtriumNavCommon;
    const toggle=document.querySelector('.editor-tabbar [data-action="split-toggle"]');
    if(toggle){
      const label=isSplit?"Close split":"Split editor right";
      C?.shortcutTitle(toggle,label,shortcutBinding("split-toggle",kind));
      toggle.setAttribute("aria-label",label);
    }
    const counterpart=pcb()?"Split with Schematic":"Split with Board";
    const label=globalThis.AtriumI18n?.text?.(counterpart,"menu")??counterpart;
    for(const n of document.querySelectorAll('[data-action="split-counterpart"]')){
      if(n.getAttribute("role")==="menuitem"){
        if(n.textContent!==label)n.textContent=label;
      }else{
        C?.shortcutTitle(n,label,shortcutBinding("split-counterpart",kind));
        n.setAttribute("aria-label",label);
      }
    }
  }
  let lastSplitTitleKind,lastSplitTitleState;
  function syncSplit(){
    const second=panes[1],other=otherPane(),toggle=document.querySelector('.editor-tabbar [data-action="split-toggle"]');
    if(toggle)chromeAttribute(toggle,"aria-pressed",String(!!second));
    syncSplitTitles();
    for(const n of document.querySelectorAll('[data-action="split-close"]'))chromeFlag(n,"disabled",!second);
    for(const t of document.querySelectorAll("#document-tabs [data-tab]")){
      const inOther=other&&t.dataset.tab===other.docId&&t.dataset.tab!==current;
      if(inOther&&t.dataset.pane!=="other")t.dataset.pane="other";
      if(!inOther&&t.dataset.pane)delete t.dataset.pane;
    }
    for(const p of panes){
      p.stage.classList.toggle("is-active",!!second&&p===activePane);
      let cap=[...p.stage.children].find(n=>n.classList.contains("pane-caption"));
      if(!second){cap?.remove();continue;}
      const d=docById(p===activePane?current:p.docId);
      if(!cap){cap=el("div",null,"pane-caption");cap.setAttribute("aria-hidden","true");cap.append(el("i"),el("span"));p.stage.append(cap);}
      const name=d?.name||"";
      if(cap.lastChild.textContent!==name)cap.lastChild.textContent=name;
      if(cap.title!==name)cap.title=name;
      if(p!==first())chromeAttribute(p.stage,"aria-label",(name||"Design")+" (second view)");
    }
    /* chords-tabs */const T=globalThis.AtriumSplitTabs;if(T)T.sync();else if(second)globalThis.AtriumLazy?.need?.("AtriumSplitTabs").then(()=>syncSplit(),()=>{});
    /* split-follow */const F=globalThis.AtriumSplitFollow;if(F)F.sync();else if(second)globalThis.AtriumLazy?.need?.("AtriumSplitFollow").then(()=>syncSplit(),()=>{});
  }
  const first=()=>panes[0];
  let tabDropInstalled=false;
  function installTabDrop(){
    if(tabDropInstalled || !globalThis.AtriumTabDrop)return;
    AtriumTabDrop.install({panes,docById,activatePane,selectDocument,openSplit,showInOther,info,el,
      splitState:()=>splitState,activePane:()=>activePane,current:()=>current,canvas:()=>canvas});
    tabDropInstalled=true;
  }
  let starter=true;
  if(!project)project=A.project("Untitled",AtriumParts.catalogue);
  current=starter?project.documents[0].id:A.preferredDocument(project,"pcb")?.id||project.documents[0].id;
  let lengthSession=null,lengthPointer=null,lengthPrefs={style:"accordion"};
  // PCB interactive router (AtriumRouter / AtriumDiffPair). Schematic wires keep the chain code.
  let fencePreview=null;   // AtriumViaFence preview overlay while the Via Fencing panel is open
  let routeFromNet=null,routeSession=null,routePreview=null,routePointer=null,routeArm=null,routeCornerOverride=null,routePrefs={},routeWidthSet=false,clickCtrl=false;
  // Dynamic re-route on component drag (AtriumRouter.dragSession) and tabbed-routing defaults.
  let dragPreview=null,dragPrefs={enabled:true,maxConnections:32};
  // Part text (sch-fields.js): a sheet field (Designator, Comment, visible parameter) that is selected or under
  // the pointer, and a press on part text on a sheet or a board, which moves that text and not the part.
  var fieldSel=null,fieldHover=null;
  const SF=()=>globalThis.AtriumSchFields;
  function fieldFocus(){
    const t=drag?.kind==="text"&&drag.t.key&&drag.t;
    return pcb()?null:t?{id:t.item.id,key:t.key,mode:"drag"}:fieldSel?{...fieldSel,mode:"selected"}:fieldHover&&tool==="select"&&!drag?{...fieldHover,mode:"hover"}:null;
  }
  function textAt(p){
    if(!SF())globalThis.AtriumLazy?.need?.("AtriumSchFields").catch(()=>{});
    return tool==="select"?SF()?.pick(view,doc(),defs,p,{...lineOpts(),selectable:i=>selectable(i)&&!notebookLocked(i)}):null;
  }
  const routing=()=>tool==="route"||tool==="route-diffpair";
  const useRouter=()=>pcb()&&routing()&&!!globalThis.AtriumRouter;
  let movingObject=null,keyboardPoint=false,routeStops=[],routeMode="",reverseBend=false,shortcutStatus="",wireAtCursor=false;
  const doc=()=>docById(current)||project.documents[0];
  const active=()=>selected==null?undefined:doc().items.find(i=>i.id===selected);
  const documentItems=d=>globalThis.AtriumUndoStore?.documentItems?.(d,project);
  const pcb=()=>doc().kind==="pcb";
  const screen=(e,c=canvas)=>{const b=c.getBoundingClientRect();return [e.clientX-b.left,e.clientY-b.top];};
  const round=n=>Number(n.toFixed(4));
  // Units are a display and entry concern; the model stays in millimetres.
  const U=A.units,unit=()=>U.normal(project.units),len=(mm,digits)=>U.format(mm,unit(),digits),unitLabel=name=>name+" ("+unit()+")";
  const coordX=$("coord-x"),coordY=$("coord-y"),coordinatePrecision={fixed:true};
  function showCoords(p){
    if(p&&globalThis.AtriumBoardShape&&pcb())p=AtriumBoardShape.toUser(doc(),p);
    const u=unit(),mm=u==="mm",digits=mm?2:1,precision=mm?coordinatePrecision:undefined;
    const x=p?U.format(p[0],u,digits,precision):"—",y=p?U.format(p[1],u,digits,precision):"—";
    if(coordX&&coordX.textContent!==x)coordX.textContent=x;
    if(coordY&&coordY.textContent!==y)coordY.textContent=y;
  }
  function syncUnits(){
    const label=$("unit-toggle-label"), I=globalThis.AtriumI18n;
    if(label){
      const key=unit()==="mil"?"status.switch_to_mm":"status.switch_to_mil";
      const text=I?.t(key)??(unit()==="mil"?"Switch to mm":"Switch to mil");
      if(label.textContent!==text)label.textContent=text;
    }
  }
  function toggleUnits(){
    const next=unit()==="mil"?"mm":"mil";
    if(next==="mil")project.units="mil";else delete project.units;
    change();if(pointer)showCoords(pointer);
    info("Units "+(next==="mil"?"mils":"millimetres")+" · "+gridText());
  }
  const gridText=()=>"Snap grid "+len(doc().grid);
  const overview=()=>pcb()?"Board layout":"Schematic";
  const propLabel={frame:"Frame",...(globalThis.AtriumSchObjects?.LABELS||{}),part:"Component",wire:"Wire",track:"Track",via:"Via",pad:"Pad",label:"Text",netlabel:"Net label",junction:"Junction",graphic:"Graphic"};
  const lineOpts=()=>({hidden,layer,layerMode,grid,selected,selectedIds,highlight,showUnrouted,transientGeometry:!!drag?.before,routing:routing()||tool==="via",width:routeWidth});
  const blockOverlay=()=>globalThis.AtriumBlocks?.overlay(pointer)||null;
  const touchFree=()=>globalThis.AtriumCanvasInput?.ignoreSnap() || globalThis.AtriumTouchPrecision?.free(canvas);
  const snapAt=p=>touchFree()?p:useRouter()&&globalThis.AtriumRouteFeel?AtriumRouteFeel.snap(p):(pcbEdit&&pcb()&&pcbEdit.snap(p))||view.snapPoint(doc(),defs,p,{...lineOpts(),grid:pcbEdit&&pcb()?pcbEdit.snapPrefs.grid:true});
  function nets(d=doc()){return A.sheetNets(project,d,defs,globalThis.AtriumNavHost);}
  function schematicHighlight(d){
    if(!schematicNetHighlight||d.kind!=="schematic")return;
    const occurrences=schematicNetHighlight.get(d.id), instance=AtriumNavCommon.paletteInstance(navHost,d.id);
    const members=instance?occurrences?.get(instance):occurrences?.values().next().value;
    return members||emptyHighlightMembers;
  }
  // One defs map per library content: item edits keep it, so caches keyed on it stay valid; a new map when the
  // project, its library list or a definition (or its footprint or symbol object) changed, or the undo store
  // applied records outside the documents' items (library or rules undo/redo; outer()). force: always a new map.
  let defsKey=null,observedLibraryStore=null;
  function libraryKey(){const L=project.library,k=[project,L,L.length,UNDO?.outer?.()];for(const d of L)k.push(d,d?.id,d?.footprint,d?.symbol);return k;}
  function refreshDefs(force,libraryPossible=true){
    const store=globalThis.AtriumUndoStore;
    if(store&&store!==observedLibraryStore){
      observedLibraryStore=store;
      store.onLibraryChange?.(()=>{refreshDefs(true);if(viewportVisible)redraw(true);});
    }
    layerCache=null;globalThis.AtriumCanvas?.edited?.(libraryPossible);const k=libraryKey();
    if(force===true||!defs||!defsKey||k.length!==defsKey.length||k.some((v,n)=>v!==defsKey[n]))defs=new Map(project.library.map(d=>[d.id,d]));defsKey=k;}
  // Related copies keep document IDs. A separate identity follows Undo across File › Open.
  let fileSession={}, folderDerived=false, folderPending=false, folderSaving=false, releaseSavedWork=null;
  const folder=()=>fileSession.folder,FUI=()=>globalThis.AtriumFolderProjectUI;
  const folderUI=()=>AtriumLazy.need("AtriumFolderProjectUI");
  function importSession(){
    return globalThis.AtriumEditorFiles?.importStatus(fileSession.imported,navHost) || null;
  }
  function importSessionChanged(){
    navEmit("import-session",importSession());
    globalThis.AtriumEditorFiles?.syncImportHint(navHost);
  }
  function setFileSession(next){
    if(next===fileSession)return;
    fileSession.imported?.operation?.controller.abort();
    fileSession=next;
    if(!next.imported)globalThis.AtriumImportSaveView?.clearHint();
  }
  function folderContext(documentId){
    return {project:()=>project,current:()=>documentId??current,host:()=>navHost,session:folder,derived:()=>folderDerived,mayReplace,info,dirty:dirtyState,
      flush:()=>UNDO?.sync(project),
      pending:setFolderPending,
      saving:setFolderSaving,
      updated(detail){refreshDefs();refresh();
        if(detail?.kind==="schematic"||detail?.kind==="project"||detail?.kind==="library"){
          AtriumHierarchy.invalidatePublished(project);navEmit("folder-owner",detail);
        }
      },explorer:renderExplorer,
      adopt(session,close){closeSplit(true,false);leaveFolder();setFileSession({folder:session,close});(UNDO||=globalThis.AtriumUndoStore).reset(session.dirty?null:session.project);history=[];future=[];
        showProject(session.project,session.activeId,false,true);importSessionChanged();
        FUI().restoreView?.(session,documentViews);if(restoreDocumentView(false))draw();}
    };
  }
  function updateFolderProjectionHold(){
    for(const pane of panes)pane.view?.saveWritePending?.(folderPending||folderSaving);
  }
  function setFolderPending(on){
    if(folderPending===on)return;
    folderPending=on;updateFolderProjectionHold();navEmit("saved-write-pending",on);
  }
  function setFolderSaving(on){
    if(folderSaving===on)return;
    folderSaving=on;updateFolderProjectionHold();
    if(on)releaseSavedWork=editPipeline?.holdFrom("pours");
    else if(releaseSavedWork){
      editPipeline.suspend();releaseSavedWork();releaseSavedWork=null;
    }
  }
  function leaveFolder(){fileSession.close?.();setFolderPending(false);setFolderSaving(false);}
  function dirtyState(v){if(dirty!==v)navEmit("dirty",v);/* doc-tabs: saved state */dirty=v;globalThis.AtriumHost?.setDirty?.(v,starter?null:project.name);document.title=starter?"Waffle":(dirty?"• ":"")+project.name+" — Waffle";
    // Status-bar marker for unsaved changes; click to save.
    let u=document.getElementById("unsaved");
    if(!u){const st=document.getElementById("status");if(st){u=document.createElement("button");u.id="unsaved";u.type="button";u.className="status-unsaved status-action";u.textContent="● Unsaved";u.onclick=()=>save();st.before(u);}}
    if(u){chromeFlag(u,"hidden",!dirty);syncUnsavedTitle();}}
  function syncUnsavedTitle(){
    const button=$("unsaved");
    if(button)globalThis.AtriumNavCommon?.shortcutTitle(button,"Save unsaved changes",shortcutBinding("save",folder()?.document(current)?.kind));
  }
  function persist(){return folder()?.flushDrafts() ?? globalThis.AtriumAutosave?.flush();}
  const mirrorWorkspace=()=>globalThis.AtriumProjectWindowClient?.isMirror() ? globalThis.AtriumProjectWindowClient : null;
  function forwardMirror(kind,data){return mirrorWorkspace().forward(kind,data).catch(e=>{info(e.message);return false;});}
  function change({undoRecorded=false,source,touched,persistDerived=false}={}){
    if(lockRevert){
      const r=lockRevert;lockRevert=null;
      if(r.project===project&&r.mirror){
        const after=r.mirror.copyProject(project);
        project=UNDO?.reject(r.state) ?? revive(r.state);current=r.state.current;
        if(source!=="pours")r.mirror.submit(project,after,r.label).catch(e=>info(e.message));
        assignSelection(r.state.ids||[],r.state.selected);revision++;refreshDefs();refresh();return;
      }
      if(r.project===project){project=revive(r.state);current=r.state.current;assignSelection(r.state.ids||[r.state.selected].filter(Boolean),r.state.selected);revision++;refreshDefs();refresh();globalThis.AtriumRevisions?.guard?.(project);return;}
      checkpoint0(r.state,r.label);
    }
    const trace=globalThis.__waffleFrameTrace,started=trace?performance.now():0;
    revision++;if(source!=="pours")authoredRevision++;starter=false;
    // Navigator highlights describe the compiled design on the revision that was selected.
    const clearNet=!!schematicNetHighlight&&source!=="pours";
    if(clearNet){highlight="";schematicNetHighlight=null;highlightSelectionVersion=-1;}
    if(source==="pours")editPipeline?.suspend();else editPipeline?.supersede();
    if(!undoRecorded){
      const store=(UNDO||=globalThis.AtriumUndoStore);
      folderDerived=!!folder()&&source==="pours"&&!persistDerived;
      try{
        if(store?.record&&store.root()===project&&(folder()||source==="numeric-field"||source==="pours"&&touched||source==null&&(touched||visibleBoard()))&&source!=="undo")store.record(project,touched);
        else if(!folder()||source!=="undo")store?.touch?.(project,touched);
      }finally{folderDerived=false;}
    }
    const scopeStep = scopeCheckpoint ? history.at(-1) : null; scopeCheckpoint = false;
    if (!source && globalThis.AtriumWorkbench?.reviewScope?.(project,revision,scopeStep)) {if(folder())UNDO?.record(project,[]);else UNDO?.touch(project,[]);}
    dirtyState(folder()?folder().dirty:true);refreshDefs(false,source!=="pours");
    if(!folder())globalThis.AtriumAutosave?.schedule();
    refresh(!source);editPipeline?.resume();globalThis.AtriumExtensions?.notify("documentChanged");navEmit("change",{source});
    if(clearNet)navEmit("highlight");
    trace?.commit(started,performance.now());
  }
  // history: AtriumUndoStore (undo-store.js, lazy: idle prefetch or the first edit) keeps compact, shared snapshots;
  // until it loads, whole-project JSON as before (the store lifts those entries). revive() turns one back into a project.
  let UNDO=globalThis.AtriumUndoStore;const revive=(s,h)=>UNDO?UNDO.rollback(s,h):JSON.parse(s.project);
  const snapshot=()=>{const meta={current,selected,ids:[...selectedIds],fileSession,imports:globalThis.AtriumImportReports?.capture()};
    return (UNDO||=globalThis.AtriumUndoStore)?UNDO.mark(project,meta):{project:JSON.stringify(project),...meta};};
  // revisions: a released revision is read-only. Direct edits (drags, placement) that checkpoint are
  // reverted at their change(); a project replaced meanwhile (Open) keeps its undo step.
  var lockRevert=null,scopeCheckpoint=false;function checkpoint(state=snapshot(),label,targets=[current]){const mirror=mirrorWorkspace();if(mirror||targets.some(id=>folder()?.canEdit(id)===false||globalThis.AtriumCollabLock?.guard(id))||globalThis.AtriumRevisions?.guard?.(project,true)){lockRevert={state,label,project,mirror};return;}return checkpoint0(state,label);}
  function checkpoint0(state,label){scopeCheckpoint=true;if(UNDO)return UNDO.checkpoint(history,future,state,label);globalThis.AtriumLazy?.need?.("AtriumUndoStore");history.push(state);let size=state.project.length;for(let i=history.length-2;i>=0;i--){size+=history[i].project.length;if(size>16000000||history.length-i>45){history.splice(0,i+1);break;}}future=[];}
  // n<0 undoes and n>0 redoes |n| steps in one restore (History panel jumps); tree switches to an alternate branch's state.
  function undo(redo=false,n=redo?1:-1,tree=null){
    if(mirrorWorkspace())return forwardMirror(redo?"redo":"undo");
    if(drag)endDrag(true);
    globalThis.AtriumCanvasInput?.cancelSketch?.(canvas);
    if(routeSession){if(!redo&&!tree)executeKey("route-back");return;}
    if(globalThis.AtriumCollabLock?.guard(current))return;
    if(!tree&&globalThis.AtriumCollabLive?.undo(redo))return;
    if(tree)navEmit("replace");/* a private branch */
    const source=n>0?future:history,target=n>0?history:future;
    if(!tree&&!source.length)return;
    if(notebookOff()){
      const count=Math.min(Math.abs(n)||1,source.length),destination=tree||source[source.length-count];
      if(destination && destination.fileSession===fileSession){
        let inspectState=!!tree || !!destination.project || !UNDO;
        if(!inspectState){
          const ranges=n<0?[UNDO.changes(destination,UNDO.live())]:source.slice(-count).map(step=>UNDO.changes(null,step));
          inspectState=ranges.some(rows=>rows.some(row=>row.replaced || row.docAdded || row.docRemoved ||
            row.keys?.some(k=>k==="notesLayer" || k==="rules") ||
            [...row.added||[],...row.removed||[],...(row.modified||[]).flat()].some(i=>A.notebookItemKind(i) || i?.origin?.kind==="calculation")));
        }
        if(inspectState){
          const dest=destination.project?JSON.parse(destination.project):UNDO.project(destination);
          if(dest && notebookState(dest)!==notebookState(project)){info(notebookNotice);return;}
        }
      }
    }
    const units0=project.units,here=snapshot(),saved=!UNDO?(target.push(here),source.pop()):tree?UNDO.adopt(history,future,here,tree):UNDO.jump(history,future,here,n),switching=current!==saved?.current;if(!saved)return;
    if(switching)rememberDocumentView();
    const restored=UNDO?UNDO.root():JSON.parse(saved.project);
    if(units0)restored.units=units0;else delete restored.units;
    const newSession=saved.fileSession!==fileSession;
    if(newSession){globalThis.AtriumHost?.clearProjectPath?.();setFileSession(saved.fileSession);}
    const reports=globalThis.AtriumImportReports, imports=reports?.capture();
    reports?.restore(fileSession,saved.imports);
    if(imports!==saved.imports)folder()?.markSidecarsDirty();
    project=restored;current=saved.current;folder()?.focus(current);
    assignSelection(saved.ids||[saved.selected].filter(Boolean),saved.selected);resetTools();
    const needsFit=switching && !restoreDocumentView(false);
    change({source:"undo"});
    if(newSession){if(fileSession.imported)globalThis.AtriumEditorFiles?.bindSource(fileSession.imported);importSessionChanged();}
    if(needsFit)fit();globalThis.AtriumMotion?.undone?.(doc(),UNDO?.motion);
    info(tree?"Switched to the other branch":Math.abs(n)>1&&UNDO?(n>0?"Redone ":"Undone ")+Math.abs(n)+" steps":redo?"Redone":"Undone");
  }
  function routePath(a,b){
    const mode=routeMode || (pcb()?"45":"90");
    if(mode==="free")return [a,b];
    return reverseBend ? A.pathBetween(b,a,mode==="45").reverse() : A.pathBetween(a,b,mode==="45");
  }
  function moveProjection(p){
    if(!movingObject)return null;
    const {item,anchor}=movingObject,dx=p[0]-anchor[0],dy=p[1]-anchor[1];
    if(item.points){const ghost={...item};A.moveItem(ghost,dx,dy);return ghost;}
    return {...item,x:item.x+dx,y:item.y+dy,...(item.kind==="part"?{angle:ghostAngle}:{})};
  }
  // One animation frame renders every pane that needs it. draw() marks the active pane;
  // the inactive pane renders only when its own inputs change (see renderOther).
  let activeDirty=false, viewportVisible=globalThis.AtriumPower?.visible?.()!==false, opening3D=null;
  const editPipeline=globalThis.AtriumEditPipeline?.create(globalThis.AtriumIdle,()=>viewportVisible);
  let rendererPref;
  function renderedBoard(pane){
    if(!pane.canvas?.isConnected||in3D(pane))return null;
    const root=pane===activePane?doc():docById(pane.docId);
    return root?.kind==="pcb"||root?.kind==="panel"?root:null;
  }
  const visibleBoard=()=>viewportVisible&&panes.some(renderedBoard);
  function requestBoardRenderer(){
    if(globalThis.AtriumCanvasGPU||!visibleBoard())return;
    const p=globalThis.AtriumCanvasGPUPref;
    if(p&&globalThis.AtriumPrefs)p.request(visibleBoard);
    else rendererPref??=globalThis.AtriumLazy?.need?.(["AtriumPrefs","AtriumCanvasGPUPref"]).then(requestBoardRenderer,()=>{});
  }
  function draw(){activeDirty=true;pointerOnly=false;for(const p of panes)p.view?.settle?.();schedule();}
  function redraw(all=false){if(all===true)for(const p of panes)p.version++;draw();}
  // perf1: a frame asked for only because the pointer moved (no other draw() before it) may reuse the board layer.
  var pointerOnly=false;
  function drawPointer(){const fresh=!activeDirty||pointerOnly;draw();if(fresh)pointerOnly=true;}
  function schedule(){if(frame||!viewportVisible)return;frame=requestAnimationFrame(()=>paintFrame());}
  // A layout change made since the last frame (a document switch shows the layer bar, a panel opens) is
  // measured before painting, so the pane draws once, at its new size, rather than once stale and again
  // from paneObserver.
  function measurePanes(){
    for(const p of panes){
      const c=p.canvas;if(!p.view||!c?.isConnected)continue;
      const r=c.getBoundingClientRect(),w=r.width,h=r.height;
      if(p.size&&p.size[0]===w&&p.size[1]===h)continue;
      p.size=[w,h];p.view.resized?.(r);p.version++;if(p===activePane)activeDirty=true;
    }
  }
  function paintFrame(launch=false){
    frame=0;if((!viewportVisible&&!launch)||homeFit)return;
    const trace=globalThis.__waffleFrameTrace;
    measurePanes();fitRevealed();globalThis.Atrium3D?.refresh?.();
    if(activeDirty){
      activeDirty=false;
      if(!in3D(activePane)){
        const p=activePane,d=doc(),t=performance.now(),reused=renderActive(trace);
        recordPaintCost(p,d,performance.now()-t,reused);
      }
    }
    if(!in3D(otherPane()))renderOther(trace);
    if(viewportVisible){requestBoardRenderer();navEmit("frame");}
  }
  globalThis.AtriumPower?.onChange?.(({visible})=>{
    if(visible===viewportVisible)return;
    viewportVisible=visible;
    if(visible){syncLayerControl();redraw(true);editPipeline?.resume();renderComponents();if(inspectorDirty)inspect();}
    else {cancel3DIntent();editPipeline?.suspend();if(frame){cancelAnimationFrame(frame);frame=0;}}
  });
  function updateTuning(p){
    if(!lengthSession||!p||lengthPointer&&lengthPointer[0]===p[0]&&lengthPointer[1]===p[1])return;
    const r=lengthSession.move(p);lengthPointer=p;if(r?.gauge?.text)info(r.gauge.text);
  }
  function renderActive(trace){let route=chain;
    const renderedPane=trace&&activePane;
    updateTuning(pointer);
    if(routeSession&&pointer&&pcb()&&pointer!==routePointer){routePointer=pointer;try{routePreview=routeSession.move(snapAt(pointer));routeStatus();}catch(e){info(e.message);}}
    if(chain.length&&pointer)route=[...chain,...routePath(chain.at(-1),snapAt(pointer)).slice(1)];
    const ghost=tool==="label"&&!pcb()&&pointer&&globalThis.AtriumSchPlace?AtriumSchPlace.labelGhost(snapAt(pointer)):tool==="sch-place"&&pointer?globalThis.AtriumSchObjects?.preview(snapAt(pointer)):movingObject&&pointer?moveProjection(snapAt(pointer)):pending&&pointer?{kind:"part",id:"preview",def:pending.id,ref:focusedPart?.ref||pending.prefix+"?",value:pending.value||"",x:snapAt(pointer)[0],y:snapAt(pointer)[1],angle:ghostAngle,...(!pcb()&&!focusedPart&&globalThis.AtriumSchPlace?AtriumSchPlace.ghostPart(pending,project):{})}:null;
    const measureTo=measureEnd||(tool==="measure"&&measureStart&&pointer?snapAt(pointer):null);
    const measure=measureStart&&measureTo?{a:measureStart,b:measureTo,text:measureText(measureStart,measureTo)}:null;
    const d=doc(),schematicHighlightIds=schematicHighlight(d)?.ids,drawDefs=pcbEdit&&ghost?pcbEdit.renderDefs(defs,ghost):defs,opts={...lineOpts(),measure,block:blockOverlay(),marquee:drag?.kind==="box"&&drag.moved?boxOf(drag.origin,pointer||drag.origin):pickFrom&&pointer?boxOf(pickFrom,pointer):null,paste:drag?.copy?.plan||paste,pasteAt:drag?.copy?.at||(paste&&pointer?pastePoint(pointer):null),route,routePreview:pcb()&&globalThis.AtriumRouteFeel?AtriumRouteFeel.frame(routeSession?routePreview:dragPreview,!!routeSession,!routeSession&&useRouter()&&pointer?snapAt(pointer):null):routeSession?routePreview:dragPreview,pointer,lengthTuning:lengthSession?.overlay?.(),viaFence:fencePreview,guides:drag?.kind==="move"?guideResult:null,fieldFocus:fieldFocus(),ghost,netByWire:!pcb()&&highlight&&!schematicHighlightIds?nets().byWire:undefined,schematicHighlightIds,snapAt:(chain.length||keyboardPoint)&&pointer?snapAt(pointer):null,...navRender(doc(),{active:true,ghost}),reuseBase:pointerOnly};
    const started=trace?performance.now():0;
    const reused=view.render(d,drawDefs,opts);pointerOnly=false;
    if(renderedPane?.size?.[0]&&renderedPane.size[1])trace.draw(renderedPane.canvas,started,performance.now());
    if(viewportVisible&&folder())FUI().present(folder(),current);
    const zoom=$("zoom-value");
    if(zoom){const z=view.scale()/(96/25.4)*100,label=(z>=10?Math.round(z):+z.toFixed(1))+"%";if(zoom.textContent!==label)zoom.textContent=label;}
    return reused;
  }
  const glide=(f,options)=>globalThis.AtriumCamera?.glideTo?AtriumCamera.glideTo(view,f,options):f();
  function fit(measured){homeFit=openFit=null;const d=doc();/* draftsman: a drawing fits all its sheets (sheet 1 until drawing.js loads) */if(d.kind==="drawing"){const b=globalThis.AtriumDrawing?.fitBox?.(d),N=globalThis.AtriumNavCommon;if(b&&N?.cameraFor){view.restoreCamera(N.cameraFor(b,canvas.clientWidth||800,canvas.clientHeight||600,view.camera(),{margin:.06}));refScale=view.scale()||1;draw();return;}view.fit({...d,kind:"schematic"},defs,"document");refScale=view.scale()||1;draw();return;}/* newfix F3: nothing to fit -> the sheet frame (or the board outline) */view.fit(d,defs,d.kind!=="panel"&&!d.items.length?"document":undefined,measured);refScale=view.scale()||1;draw();}
  function fitLayout(){const rect=canvas.getBoundingClientRect();view.resized(rect);fit(rect);}
  // The import report can resize the pane when it opens and again when the design is revealed.
  function fitOpened(){fitLayout();if(canvas.inert)openFit={view,doc:doc()};}
  function fitRevealed(){
    if(!openFit||canvas.inert)return;
    const target=openFit;openFit=null;
    if(target.view===view&&target.doc===doc())fitLayout();
  }
  function resetTools(){globalThis.AtriumCamera?.stopWheel?.();if(drag)endDrag(true);paste?.cancel?.();lengthPointer=null;globalThis.AtriumSchPlace?.closePopover();schPlacementClicks=null;pickFrom=null;if(pickResolve){const r=pickResolve;pickResolve=null;r(null);}routeSession?.cancel?.();routeSession=null;routePreview=null;routeArm=null;routeFromNet=null;routeCornerOverride=null;lengthSession?.cancel?.();lengthSession=null;measureStart=null;measureEnd=null;globalThis.AtriumBlocks?.cancel();globalThis.AtriumSchObjects?.cancel();tool="select";paste=null;movingObject=null;keyboardPoint=false;pending=null;chain=[];routeStops=[];routeMode="";reverseBend=wireAtCursor=false;routeNet="";focusedPart=null;pointer=null;ghostAngle=0;drag=null;pcbEdit?.reset();}
  function toolName(t){/* newfix F10 */if(t==="sch-place"){const m=globalThis.AtriumSchObjects?.floating?.()?.mode,l=m&&globalThis.AtriumSchObjects?.COMMANDS?.["sch-"+m];return l?"Place "+l.toLowerCase():"Place object";}if(t==="pcb-draw")return "Draw shape";return {select:"Select",pan:"Pan",paste:"Place copy",measure:"Measure distance",junction:"Place junction","split-wire":"Split wire",route:pcb()?"Route track":"Draw wire",place:"Place component","move-object":"Move object",label:pcb()?"Place text":"Place net label",via:"Place via","length-tune":"Interactive length tuning","route-diffpair":"Interactive differential pair routing","length-tune-pair":"Interactive diff pair length tuning","length-tune-skew":"Diff pair skew tuning","length-tune-phase":"Interactive phase tuning"}[t]||t;}
  // One-shot point pick for workflows (board origin). Resolves null on Escape or tool change.
  var pickResolve=null,pickFrom=null;
  // o.from draws a rectangle from that corner to the pointer while picking (area selections, Arrange).
  function pickPoint(prompt,o){
    const signal=o?.signal;if(signal?.aborted)return Promise.resolve(null);
    setTool("pick-point");pickFrom=o?.from||null;info(prompt||"Click a point.");canvas.focus();
    return new Promise(resolve=>{
      const abort=()=>{if(pickResolve===finish)setTool("select");};
      const finish=point=>{signal?.removeEventListener("abort",abort);resolve(point);};
      pickResolve=finish;signal?.addEventListener("abort",abort,{once:true});
    });
  }
  function setTool(t){if(doc().kind==="drawing"&&t!=="select"&&t!=="pan"){info("A drawing shows views of the board. Use Place › Drawing View… and the dimension tools, or the Properties panel.");return;}if(doc().kind==="panel"&&t!=="select"&&t!=="pan"){info("A panel shows its boards. Edit them in their own layout, or change the panel with Tools › Panelize….");return;}const at=pointer;resetTools();pointer=at;tool=t;if(t!=="select"&&t!=="pick-point")single(null);info(t==="route"?(pcb()?"Click to start routing. Space changes the corner direction.":"Click a pin to start a wire. Space changes the corner direction."):t==="move-object"?"Click the object to move.":t==="measure"?"Click the first measurement point.":t==="select"?"Ready":"Escape returns to Select.");syncTools();inspect();draw();}
  let lastToolTitleKind,lastToolTitle;
  function syncToolTitles(force=false){
    const kind=doc().kind,C=globalThis.AtriumNavCommon;
    const newKind=force||kind!==lastToolTitleKind;
    if(newKind)for(const action of ["route","label"]){
      const button=$("tools")?.querySelector('[data-action="'+action+'"]');
      if(!button)continue;
      const title=toolName(action),label=button.querySelector(".tool-label");
      C?.shortcutTitle(button,title,shortcutBinding(action,kind));
      button.setAttribute("aria-label",title);
      if(label&&label.textContent!==title)label.textContent=title;
    }
    const status=$("tool-value"),text=toolName(tool);
    if(status&&(newKind||lastToolTitle!==tool||status.textContent!==text)){
      C?.shortcutTitle(status,"Active tool",shortcutBinding(tool==="place"?"library":tool,kind));
      if(status.textContent!==text)status.textContent=text;
    }
    lastToolTitleKind=kind;lastToolTitle=tool;
  }
  function syncTools(){pcbEdit?.sync?.();const h=globalThis.AtriumCollabLive?.historyAvailability?.();
    selectComponent();syncLayerControl();
    toolControls??=actionSelector(["select","pan","route","via","label","junction","split-wire","measure","grid","library",
      "toggle-left","toggle-right","undo","redo","close-project","rotate","delete","layer-mode","copy","cut","duplicate","paste"]);
    const board=pcb(), item=active();
    for(const n of document.querySelectorAll(toolControls)){
      const a=n.dataset.action;
      if(["select","pan","route","via","label","junction","split-wire","measure","grid","library"].includes(a))chromeAttribute(n,a==="grid"&&n.getAttribute("role")==="menuitemcheckbox"?"aria-checked":"aria-pressed",String(a==="grid"?grid:a==="library"?tool==="place":tool===a));
      if(a==="toggle-left"||a==="toggle-right")chromeAttribute(n,"aria-expanded",String(!document.body.classList.contains(a==="toggle-left"?"hide-left":"hide-right")));
      if(a==="undo")chromeFlag(n,"disabled",!(h?h.undo:history.length));if(a==="redo")chromeFlag(n,"disabled",!(h?h.redo:future.length));
      if(a==="close-project")chromeFlag(n,"disabled",starter);
      if(a==="rotate")chromeFlag(n,"disabled",!pending&&(selectedIds.size!==1||item?.kind!=="part"));if(a==="delete")chromeFlag(n,"disabled",!item);
      if(a==="via"||a==="layer-mode")chromeFlag(n,"hidden",!board);
      if(a==="junction"||a==="split-wire")chromeFlag(n,"hidden",board);
      if(["copy","cut","duplicate"].includes(a))chromeFlag(n,"disabled",!selectedIds.size);
      if(a==="paste")chromeFlag(n,"disabled",false);
      if(a==="layer-mode")chromeAttribute(n,"title","Layer display · "+({all:"All layers",dim:"Dim other layers",single:"Active layer only"})[layerMode]);
    }
    syncToolTitles();
    syncChecks();canvas.style.cursor=tool==="pan"?"var(--ui-cursor-pan)":tool==="select"?"default":"crosshair";
    if(globalThis.AtriumViewConfig){if(pcb())AtriumViewConfig.refresh();else AtriumViewConfig.close();}
  }
  function rememberDocumentView(){
    if(openFit?.view===view&&openFit.doc===doc())return;
    documentViews.set(current,{view:view.camera(),refScale,hidden,layer,layerMode});
  }
  function restoreDocumentView(fitMissing=true){
    const saved=documentViews.get(current);
    hidden=saved?.hidden||new Set();layer=saved?.layer||"Top";layerMode=saved?.layerMode||"all";
    highlight="";schematicNetHighlight=null;layerCache=null;
    if(saved){refScale=saved.refScale;view.restoreCamera(saved.view);}else if(fitMissing)fitLayout();
    return !!saved;
  }
  function selectDocument(id,added=false){
    const session=folder();
    if(session&&id!==current&&!docById(id)&&session.getDocumentRef(id)&&session.activeId!==id){
      return session.activate(id).then(()=>session===folder()&&selectDocument(id,added),e=>{if(e.name!=="AbortError")info(e.message);});
    }
    const other=otherPane();
    if(other&&other.docId===id&&current!==id){activatePane(other);return;}
    if(current===id||!project.documents.some(d=>d.id===id))return;
    rememberDocumentView();
    resetTools();current=id;single(null);restoreDocumentView();globalThis.AtriumExtensions?.notify("activeDocumentChanged");
    if(added)change();else {if(session)refreshDefs();refresh();}
    if(session){session.focus(current);FUI().rememberView(session,current,documentViews);}
    info("Ready");navEmit("document");
  }
  const partsList=$("parts"),partCount=$("part-count");
  let componentNav=null,componentsLoading=false,componentsVisible=false;
  let inspectorVisible=true,inspectorDirty=false,inspectorStamp=null;
  function selectComponent(){if(componentsVisible&&viewportVisible)componentNav?.select(selected);}
  function renderComponents(){
    if(!componentsVisible||!viewportVisible)return;
    const d=doc(),items=documentItems(d);
    if(!componentNav){
      if(!(items?items.components.length:d.items.some(i=>i.kind==="part"))){
        const note=partsList.firstElementChild;
        if(note.textContent!=="No components placed")note.textContent="No components placed";
        partsList.removeAttribute("aria-busy");return;
      }
      if(!globalThis.AtriumNavigator){
        if(componentsLoading)return;
        componentsLoading=true;partsList.setAttribute("aria-busy","true");partsList.firstElementChild.textContent="Loading components…";
        globalThis.AtriumLazy.need("AtriumNavigator").then(()=>{
          componentsLoading=false;partsList.removeAttribute("aria-busy");renderComponents();
        },e=>{componentsLoading=false;partsList.removeAttribute("aria-busy");partsList.firstElementChild.textContent=e.message;});
        return;
      }
      componentNav=globalThis.AtriumNavigator.create(partsList,(id,activate)=>{choose(id,true);if(activate)canvas.focus();});
    }
    const count=String(componentNav.refresh(d,defs,selected,revision,items));
    if(partCount.textContent!==count)partCount.textContent=count;
  }
  const dockObserver=new ResizeObserver(entries=>{
    for(const {target,contentRect:r} of entries){
      const visible=r.width>0&&r.height>0;
      if(target===partsList.parentElement){if(visible!==componentsVisible){componentsVisible=visible;renderComponents();}}
      else {inspectorVisible=visible;if(visible&&inspectorDirty)inspect();}
    }
  });
  dockObserver.observe(partsList.parentElement);dockObserver.observe($("inspector"));
  function selectExplorerDocument(id){
    function focus(){ $("documents").querySelector('[aria-current="true"]')?.focus();
      if(matchMedia("(max-width:620px)").matches){document.body.classList.add("hide-left");syncTools();canvas.focus();} }
    const pending=selectDocument(id);
    if(pending?.then)return pending.then(focus);
    focus();
  }
  function renderExplorer(){
    globalThis.AtriumWorkbench?.syncExplorer(project,current,selectExplorerDocument,revision,folder()&&FUI().explorerDocuments(folder()));
  }
  function choose(id,center=false){single(id);const i=active();if(center&&i){
    const at=view.worldToScreen(i.points?i.points[0]:[i.x,i.y]);if(at[0]<30||at[1]<30||at[0]>canvas.clientWidth-30||at[1]>canvas.clientHeight-30)view.pan(canvas.clientWidth/2-at[0],canvas.clientHeight/2-at[1]);}
    selectComponent();inspect();syncTools();draw();}
  const expanded=new Set();
  function disclosure(parent,title,build) {
    const details=el("details",null,"inspector-disclosure"),summary=el("summary",title,"ui-disclosure-marker"),body=el("div",null,"inspector-disclosure-body");summary.dataset.t=title;
    const collapse=el("div",null,"ui-collapse"),content=el("div",null,"ui-collapse-content");content.append(body);collapse.append(content);
    const key=doc().id+"/"+(selected||"document")+"/"+title;let populated=false;
    details.dataset.disclosureKey=key;
    function populate(){if(!populated){build(body);populated=true;}}
    details.append(summary,collapse);details.open=expanded.has(key);if(details.open)populate();
    details.ontoggle=()=>{if(!details.isConnected)return;if(details.open){expanded.add(key);populate();}else expanded.delete(key);};
    parent.append(details);
  }
  function section(parent,title){const s=el("section",null,"inspect-section");s.append(el("h3",title));parent.append(s);return s;}
  function field(parent,label,value,update,opt={}) {
    const l=el("label",null,"field-row"), inp=el(opt.values?"select":"input",null,"ui-field");
    l.append(el("span",label));if(opt.values){for(const entry of opt.values){const [v,t]=Array.isArray(entry)?entry:[entry,entry];inp.add(new Option(t,v));}}
    else if(opt.length){inp.type="text";inp.inputMode="decimal";inp.autocomplete="off";inp.spellcheck=false;inp.dataset.unit=unit();inp.title="Value in "+unit()+". Suffixes such as mil, mm or in are accepted.";value=value==null?"":String(U.value(value,unit()));}
    else {inp.type=opt.number?"number":"text";if(opt.number)inp.step=String(opt.step||"any");if(opt.min!=null)inp.min=String(opt.min);}
    inp.value=value??"";inp.setAttribute("aria-label",label);
    if(opt.length || opt.number || opt.numericUnit) {
      const item=active(),d=doc(),u=opt.length?unit():opt.numericUnit || "";
      const target=opt.key && item ? {scope:"item",documentId:d.id,itemId:item.id,path:[opt.key]} : undefined;
      globalThis.AtriumLazy?.numericField?.(inp,{unit:u,storageUnit:opt.length?"mm":u,nanometres:!!opt.length,
        declaration:opt.valueUnit ? {kind:"part",item,definition:defs.get(item.def),field:"value",documentId:d.id}:undefined,
        min:opt.min,max:opt.length||opt.number?1e7:undefined,period:opt.period,optional:!!opt.allowEmpty,integer:opt.step===1,target,textValue:!!opt.valueUnit,allowText:!!opt.valueUnit,
        locals:()=>globalThis.AtriumNumericFields.geometryLocals(item,d.id)});
    }
    inp.onchange=()=>{
      if(opt.length){
        if(opt.allowEmpty && !inp.value.trim()){update(null);return;}
        const v=U.parse(inp.value,unit());
        if(!Number.isFinite(v)||Math.abs(v)>1e7||v<(opt.min??-Infinity)){
          inp.value=value;
          info(!Number.isFinite(v)?"Enter a length such as 0.25mm or 10mil.":Math.abs(v)>1e7?"This length is too large.":opt.minMessage||"Enter a length of at least "+len(opt.min)+".");
          return;
        }
        update(v);return;
      }
      const v=opt.number?Number(inp.value):opt.values?inp.value:inp.value.trim();if((opt.number&&(!inp.value||!Number.isFinite(v)||Math.abs(v)>1e7||v<(opt.min??-Infinity)))||(!opt.number&&!v&&!opt.allowEmpty)){inp.value=value;return;}update(v);};
    l.append(inp);parent.append(l);return inp;
  }
  function amend(fn,label,touched,scope){
    if(globalThis.AtriumRevisions?.guard?.(project))return false;
    return applyEdit(fn,label,touched,true,scope);
  }
  // A proposal supplies its exact write footprint before mutation. A checkpoint token is
  // issued to the host only and is valid for the current project, step and revision.
  function edit(fn,label,touched,scope){
    if(globalThis.AtriumRevisions?.guard?.(project))return false;
    const prior=scope?.previous,amending=!!(prior&&prior.project===project&&prior.step===history.at(-1)&&prior.revision===revision&&!future.length);
    return applyEdit(fn,label,touched,amending,scope);
  }
  function applyEdit(fn,label,touched,amending,scope){
    const mirror=mirrorWorkspace();
    if(mirror){
      const state=snapshot();let after;
      try{fn();after=mirror.copyProject(project);}
      finally{project=UNDO?.reject(state)??revive(state);current=state.current;refreshDefs();refresh();}
      mirror.submit(project,after,label).catch(e=>info(e.message));return true;
    }
    const targets=scope?.documents?.length?scope.documents:[current];
    if(folder()&&targets.some(id=>!folder().canEdit(id))){info("This Waffle document is read-only.");return false;}
    if(targets.some(id=>globalThis.AtriumCollabLock?.guard(id)))return false;
    const live=globalThis.AtriumCollabLive;
    if(scope&&live?.guardObjects?.(scope.items))return false;
    const before=snapshot(),d0=doc(),blocked={},protectedState=notebookOff()?notebookState(project):null;let settle;
    const apply=()=>{
      fn();
      globalThis.AtriumNumericFields?.capture(project);
      const docs=scope?targets.map(docById).filter(Boolean):[doc()];
      for(const d of docs){
        const r=pcbEdit?.settle?.(d),n=globalThis.AtriumDynamicSymbol?.settle?.(project,d);
        if(scope&&r?.teardrops?.length&&live?.guardObjects?.(r.teardrops))throw blocked;
        if(touched){
          const s=settled(r,n);
          if(settle!==null)settle=s&&{library:!!(s.library||settle?.library)};
        }
      }
      if(protectedState!==null && notebookState(project)!==protectedState){info(notebookNotice);throw blocked;}
    };
    try{if(UNDO?.duringEdit)UNDO.duringEdit(apply);else apply();}
    catch(error){project=error===blocked && UNDO?UNDO.reject(before):revive(before);current=before.current;assignSelection(before.ids||[before.selected].filter(Boolean),before.selected);refreshDefs();refresh();if(error===blocked)return false;globalThis.AtriumDiagnostics?.failed(error);throw error;}
    if(amending){if(UNDO)UNDO.fork(future);else future=[];}else checkpoint(before,label,targets);
    change({touched:hintOf(touched,d0,settle)});
    return scope?{checkpoint:{project,step:history.at(-1),revision},amended:amending}:true;
  }
  function settled(r,n){return pcbEdit&&!r?null:{library:!!(r?.mirrors?.length||n)};}
  function hintOf(t,d,s){
    if(typeof t==="function")t=t();
    if(!t||!s)return;
    const scopes=Array.isArray(t)&&t.some(h=>h&&!h.kind&&(h.doc?.items||h.library===true));
    if(scopes)return s.library?[...t,{library:true}]:t;
    return {doc:d,items:t,library:s.library};
  }
  // A part transform reports its attached wires as well as the part; following designators may move neighbours.
  function editTransform(item,props,follow=false,ghost=false){
    const d=doc();let moved=[],library=false;
    edit(()=>{moved=A.transformPart(d,item,defs.get(item.def),props,undefined,{defs,query:b=>view.query(d,defs,b),avoidPinShorts:true});
      if(follow)moved.push(...followDesignators([item.id]));
      if(ghost)library=!!pcbEdit?.commitGhost(item);
    },undefined,()=>[{doc:d,items:moved,library}]);
  }
  // git-blame: under Properties, who last changed the selected object (blame.js, lazy; desktop with a Git project only).
  function revealInspector(launch=false){if(inspectorDirty&&$("inspector").getClientRects().length){inspectorVisible=true;inspect(false,launch);}}
  function inspect(reuseOverview=false,launch=false){
    inspectorDirty=!inspectorVisible||!viewportVisible&&!launch;if(inspectorDirty)return;
    const panel=$("inspector"),d=doc(),overview=pcb()&&tool==="select"&&!selectedIds.size&&!globalThis.AtriumPCBDraw?.session;
    inspectorStamp=overview&&globalThis.AtriumUndoStore?.trackOverview?.(d,project,inspectorStamp,
      [defs,unit(),globalThis.AtriumBoardShape,globalThis.AtriumComponentClasses,globalThis.AtriumRooms,
        pcbEdit,JSON.stringify(globalThis.AtriumPCBEdit?.filters?.pcb)],
      reuseOverview&&!panel.querySelector("details[open]"));
    if(inspectorStamp?.keep)return;
    const focused=document.activeElement,filter=panel.contains(focused)&&focused.getAttribute("data-selection-kind");
    inspectBody(panel);gitBlameLine();if(selected&&selectedIds.size===1&&!pcb())globalThis.AtriumConnectionPreview?.properties(panel,d,active());
    if(filter&&document.activeElement===document.body)panel.querySelector(`[data-selection-kind="${filter}"]`)?.focus({preventScroll:true});
  }
  function gitBlameLine(){const H=globalThis.AtriumHost,L=globalThis.AtriumLazy;if(!(H?.gitQuery&&H.folderGitGrant||H?.historyQuery&&H.historyPath)||!L||selectedIds.size>1)return;const item=active(),panel=$("inspector");if(!item||!panel)return;
    (globalThis.AtriumBlame?Promise.resolve():L.need("AtriumBlame")).then(()=>{if(active()===item&&panel.isConnected)globalThis.AtriumBlame?.inspector(panel,navHost,item);},()=>{});}
  function documentControls(panel,title,render){
    disclosure(panel,title,s=>{
      if(globalThis.AtriumDocumentInspector)render(globalThis.AtriumDocumentInspector,s);
      else globalThis.AtriumLazy?.appendOnLoad("AtriumDocumentInspector",s,render,info);
    });
  }
  function inspectBody(panel){
    // A lazy extension or selection refresh can rebuild the panel before the browser's toggle event.
    for(const details of panel.querySelectorAll("details[data-disclosure-key]")){
      const key=details.dataset.disclosureKey;
      if(details.open)expanded.add(key);else expanded.delete(key);
      details.ontoggle=null;
    }
    panel.replaceChildren();const item=active(), d=doc();if(d.kind==="panel"){globalThis.AtriumPanel?.inspect(panel,navHost);return;}if(d.kind==="drawing"&&globalThis.AtriumDrawing){AtriumDrawing.inspect(panel,navHost);return;}pcbEdit?.filterBar(panel);if(pcb()&&globalThis.AtriumPCBDraw?.inspectTool(panel))return;
    if(fieldSel&&d.kind==="schematic"&&SF()?.inspect(panel,{doc,defs:()=>defs,edit:(fn,touched)=>edit(fn,undefined,touched),field,section,row,select:id=>{choose(id);inspect();syncTools();draw();}},fieldSel))return;
    if(d.kind==="schematic" && selectedIds.size===1 && notebookLocked(item)){
      const compat=globalThis.AtriumNotebookCompat,sectionNode=section(panel,"Notebook · Read-only");
      const summary=el("p",compat?.description(item,project) || item.text || item.alt || "");summary.style.whiteSpace="pre-wrap";
      sectionNode.append(el("p",compat?.label(item) || "Notebook item"),summary);
      for(const link of compat?.navigation(item,project) || [])sectionNode.append(inspectorButton(link.text,()=>compat.follow(link,navHost).catch(e=>info(e.message))));
      return;
    }
    if(d.kind==="schematic" && !notebookOff() && selectedIds.size===1 && globalThis.AtriumReviewNotes?.inspect(panel,item,navHost))return;
    const availableCopper=()=>currentLayers();
    if(selectedIds.size>1){
      const s=section(panel,selectedIds.size+" objects selected"),counts=new Map();
      for(const obj of d.items)if(selectedIds.has(obj.id)){const k=globalThis.AtriumSchObjects?.isFrame(obj)?"frame":obj.kind;counts.set(k,(counts.get(k)||0)+1);}
      for(const [kind,n] of counts)row(s,propLabel[kind]||kind,String(n));
      // A whole via fence is selected (clicking one fence via selects its group): fence properties.
      const fenceId=pcb()&&globalThis.AtriumViaFence?AtriumViaFence.fenceOfSelection(d,selectedIds):null;
      if(fenceId)AtriumViaFence.inspector(panel,{...fenceCtx(),fenceId});
      else pcbEdit?.inspectMulti(panel,s);
      return;
    }
    if((routing()&&pcb())||tool==="via"){
      const options=availableCopper().filter(name=>!hidden.has(name));
      const changeLayer=v=>{if(routeSession){routerLayer(v);return;}if(chain.length){chain=[];routeStops=[];routeNet="";info("Layer changed. Click to start a new route.");}layer=v;};
      if(!options.includes(layer))changeLayer(options[0]||"");
      const s=section(panel,toolName(tool));
      field(s,"Copper layer",layer,v=>{changeLayer(v);syncLayerControl();inspect();draw();},{values:options}).disabled=!options.length;
      if(routing())field(s,unitLabel("Width"),routeWidth,v=>{routeWidth=v;routeWidthSet=true;routeSession?.setWidth?.(v);routePointer=null;draw();},{length:true,min:.001});
      field(s,"Net",routeNet,v=>{routeNet=v;},{allowEmpty:true});}
    if(item){
      const def=defs.get(item.def),editItem=fn=>edit(fn,undefined,[item]);const s=section(panel,item.kind==="part"?item.ref:globalThis.AtriumSchObjects?.isFrame(item)?"Frame":item.calculation?"Calculation":propLabel[item.kind]||"Object");
      if(item.kind==="part"){
        if(pcb()&&!globalThis.AtriumSupportPlace)globalThis.AtriumLazy?.need?.("AtriumSupportPlace").catch(()=>{});
        row(s,pcb()?"Footprint":"Symbol",pcb()?def.footprint.name||def.name:def.name);
        
        field(s,"Designator",item.ref,v=>{if(doc().items.some(i=>i!==item&&i.kind==="part"&&i.ref===v)){info("This designator is already in use.");inspect();return;}editItem(()=>{item.ref=v;});});
        field(s,"Comment",item.value,v=>editItem(()=>{item.value=v;}),{allowEmpty:true,key:"value",valueUnit:true,
          numericUnit:({R:"Ω",C:"F",L:"H"})[String(defs.get(item.def)?.prefix || item.ref || "").charAt(0).toUpperCase()]});
        const otherDocs=project.documents.filter(x=>x.kind!==d.kind);
        const matches=otherDocs.flatMap(x=>x.items.filter(y=>item.link&&y.link===item.link).map(y=>[x,y]));
        if(matches.length)s.append(inspectorButton(pcb()?"Show in schematic":"Show on board",async()=>{
          const owner=doc(), version=selectionVersion;
          let probe=globalThis.AtriumCrossProbe;
          try{probe??=await globalThis.AtriumLazy?.need("AtriumCrossProbe");}catch{/* use the existing matched component */}
          if(doc()!==owner||selectionVersion!==version||probe?.probeSelection())return;
          const [od,oi]=matches[0];selectDocument(od.id);choose(oi.id,true);
        }));
        else if(!pcb()){s.append(inspectorButton("Place footprint on board",()=>{focusedPart=item;if(def.footprint)placeLinked(def);else {swapFootprint=item;showLibrary("pcb");}}));}
      }
      if(!pcb()&&globalThis.AtriumSchObjects){if(item.kind==="part")AtriumSchObjects.partParameters(panel,item,def,schCtx(editItem));else if(AtriumSchObjects.KINDS.has(item.kind))AtriumSchObjects.inspector(s,item,schCtx(editItem));}
      if(item.kind==="label"&&pcb()&&globalThis.AtriumPCBText)AtriumPCBText.inspector(s,item,fn=>editItem(()=>fn(item)),unit(),{info});
      else if(item.kind==="label"||item.kind==="netlabel")field(s,"Text",item.text,v=>editItem(()=>{item.text=v;if(item.autoName)delete item.autoName;}));
      if(!pcb())globalThis.AtriumSchObjects?.directives?.(s,item,schCtx(editItem));
      if("x" in item){
        for(const k of ["x","y"])field(s,unitLabel(k.toUpperCase()),item[k],v=>item.kind==="part"?editTransform(item,{[k]:v}):globalThis.AtriumSchObjects?.isFrame(item)?nudgeSelection(k==="x"?v-item.x:0,k==="y"?v-item.y:0):editItem(()=>{item[k]=v;}),{length:true,key:k});
        if(item.kind==="part")field(s,"Rotation (°)",item.angle||0,v=>editTransform(item,{angle:v%360}),{number:true,numericUnit:"deg",key:"angle",period:360});
      }
      if(pcb())globalThis.AtriumPCBDraw?.inspectItem(s,item);
      pcbEdit?.inspectItem(s,item);
      if(item.kind==="part"){
        const extend=inspector=>inspector.extend(s,item,def,{pcb:pcb(),unit:unit(),edit:editItem,info});
        if(globalThis.AtriumPartInspector)extend(AtriumPartInspector);
        else globalThis.AtriumLazy?.need("AtriumPartInspector").then(inspector=>{if(s.isConnected)extend(inspector);},e=>info(e.message));
      }
      if(item.kind==="wire"&&nets().byWire.has(item.id))row(s,"Connected net",nets().byWire.get(item.id));
      if(item.points && ["wire","track"].includes(item.kind) && !A.pathArc(item)){
        disclosure(panel,"Vertices",vs=>{item.points.forEach((p,j)=>{const group=el("div",null,"vertex-row");vs.append(group);for(const [axis,k]of ["X","Y"].map((a,k)=>[a,k]))field(group,axis+(j+1),p[k],v=>editItem(()=>p[k]=v),{length:true});});});}
      
    }else{
      const s=section(panel,pcb()?"Board":"Sheet");
      const b=A.bounds(d.outline);if(pcb()&&b)row(s,"Dimensions",U.value(b[2]-b[0],unit())+" × "+len(b[3]-b[1]));
      const kind=pcb()?"track":"wire",counts=documentItems(d)?.counts;
      let parts=counts?.get("part")||0,lines=counts?.get(kind)||0;
      if(!counts)for(const i of d.items){if(i.kind==="part")parts++;else if(i.kind===kind)lines++;}
      row(s,"Components",String(parts));row(s,pcb()?"Tracks":"Wires",String(lines));
      {/* integ-next: the next step on an empty sheet or board */const sch=pcb()&&!parts&&project.documents.some(x=>x.kind==="schematic"&&x.items.some(i=>i.kind==="part"));
        const next=pcb()?(!parts&&sch?["This board has no components yet. Pull them in from the schematic.","Update PCB Document (Design › Update PCB Document…)","eco"]:!parts?["Empty board. Place a component, or draw on a schematic first.","Place Component (P, C)","library"]:!d.outline.length?["Set the board shape before routing.","Define Board Shape…","board-wizard"]:null)
          :!d.items.length?["Empty sheet. Place a component to start, then wire it up.","Place Component (P, P)","library"]:null;
        if(next)s.append(el("p",next[0],"side-note empty-hint"),inspectorButton(next[1],next[2]));}
      if(pcb()&&!d.outline.length){/* newfix F17: the wizard once, typed coordinates as the alternative */if(!parts)s.append(inspectorButton("Define Board Shape…","board-wizard"));s.append(inspectorButton("Enter Coordinates…",()=>outlineDialog(d)));}
      const parentSheet=!pcb()&&globalThis.AtriumHierarchy?.parentOf(project,d.id);if(parentSheet)s.append(inspectorButton("Up to "+parentSheet.doc.name+" · "+parentSheet.symbol.name,"sch-hierarchy-up"));
    }
    if(!item&&pcb()&&globalThis.AtriumBoardShape&&d.outline.length)disclosure(panel,"Board Shape",s=>{s.classList.add("bsh-section");AtriumBoardShape.properties(s,{doc:d,project,edit:fn=>edit(fn,undefined,[]),info,pickPoint},{compact:true});});
    if(pcb())documentControls(panel,"Layers",(ui,s)=>ui.layers(s,{d,defs,view,hidden,availableCopper,btn,el,toggle(k,prune){
      if(hidden.has(k))hidden.delete(k);else hidden.add(k);
      if(prune){pruneSelection();syncTools();}inspect();draw();
    }}));
    if(!item&&pcb())documentControls(panel,"Connectivity",(ui,s)=>ui.connectivity(s,showUnrouted,el,inspectorButton));
    if(!item&&!pcb()){
      const conflicts=nets().nets.filter(n=>n.conflict);
      if(conflicts.length){const s=section(panel,"Connectivity");s.append(el("p",conflicts.length+" connected net"+(conflicts.length===1?" has":"s have")+" conflicting labels.","side-note"));}
    }
    if(!item){
      documentControls(panel,"Document settings",(ui,s)=>ui.settings(s,{d,project,pcb:pcb(),field,edit:fn=>edit(fn,undefined,[]),unitLabel,btn:inspectorButton,el,outlineDialog}));
      documentControls(panel,"Nets",(ui,s)=>ui.netList(s,{d,pcb:pcb(),nets,highlight,setHighlight,field,row}));
    }
  }
  function refresh(reuseOverview=false,structure=true){globalThis.AtriumSchAppearance?.setProject?.(project);validatePanes();const tabs=folder()?FUI().tabs(folder(),current):project.documents;globalThis.AtriumWorkbench?.sync(globalThis.AtriumProjectWindowClient?.visibleTabs(tabs)??tabs,current,selectDocument,doc().grid,unit());syncUnits();
    const projectName=$("project-name"),kind=$("doc-kind"),kindLabel=overview();
    if(projectName&&projectName.textContent!==project.name)projectName.textContent=project.name;
    if(kind&&kind.textContent!==kindLabel)kind.textContent=kindLabel;
    if(structure)renderExplorer();
    renderComponents();inspect(reuseOverview);syncTools();if(structure)syncSplit();draw();}
  function placeLinked(def){const part=focusedPart||swapFootprint,board=A.preferredDocument(project,"pcb",current);if(!board){info("Add a board layout first.");return;}selectDocument(board.id);beginPlace(def,part);swapFootprint=null;}
  let schPlacementClicks=null;
  const prepareSchPlacement=()=>globalThis.AtriumSchPlace?null:globalThis.AtriumLazy?.need("AtriumSchPlace");
  function beginPlace(def,other=null){
    resetTools();
    if(!pcb()){
      const ready=prepareSchPlacement();
      if(!ready)globalThis.AtriumSchPlace?.beginPart(def);
      else {
        // On a cold dock placement the first canvas click can arrive before the script.
        const clicks=schPlacementClicks=[],sheet=doc(),owner=project;
        const resume=()=>{
          if(schPlacementClicks!==clicks)return;
          schPlacementClicks=null;
          if(doc()!==sheet||project!==owner){resetTools();syncTools();draw();return;}
          globalThis.AtriumSchPlace?.beginPart(def);
          const angle=ghostAngle;
          for(const click of clicks){
            if(tool!=="place"||pending!==def)break;
            ghostAngle=click.angle;clickTool(click.at);
          }
          if(tool==="place"&&pending===def){ghostAngle=angle;draw();}
        };
        ready.then(resume,resume);
      }
    }
    tool="place";canvas.focus();pending=def;focusedPart=other;single(null);syncTools();inspect();info("Click to place "+(other?.ref||def.name)+". Space rotates.");draw();
  }
  // New component: the symbol editor (schematic) or the IPC wizard (board); library-editor.js is the fallback.
  function newComponent(){const L=globalThis.AtriumLazy,ready=globalThis.AtriumSymbolEditor&&globalThis.AtriumLibrary?Promise.resolve():L?.modules?.().includes("AtriumLibrary")?L.need("AtriumLibrary"):null;if(!ready)return false;const board=libraryTarget==="pcb";dialog.close();ready.then(()=>workflow(board?"footprint-wizard":"component-new"),e=>info(e.message));return true;}
  function showLibrary(kind=null){
    const session=folder();
    if(session && FUI().workflow(session,"library-catalogue",()=>{if(folder()===session)showLibrary(kind);},info))return;
    libraryTarget=kind||doc().kind;query.value="";
    if(libraryTarget==="schematic")prepareSchPlacement()?.catch(()=>{});
    $("new-library-component").onclick=()=>newComponent()||(globalThis.AtriumLibraryEditor||!globalThis.AtriumLazy?Promise.resolve(globalThis.AtriumLibraryEditor):AtriumLazy.need("AtriumLibraryEditor")).then(E=>E.open({
      library:project.library,target:libraryTarget,commit:(def,place)=>{
        edit(()=>project.library.push(def));query.value=def.name;renderLibrary();info(def.name+" added to the project library");
        return ()=>{
          if(place){dialog.close();if(swapFootprint)placeLinked(def);else beginPlace(def);}
          else query.focus();
        };
      }
    }),e=>info(e.message));
    globalThis.AtriumShell?.adoptDialog?.(dialog,{title:$("library-heading"),body:[$("library-list"),query.closest("label")],initialFocus:query});
    dialog.showModal();renderLibrary();query.focus();
  }
  function renderLibrary(){
    const C=globalThis.AtriumCatalogue,list=$("library-list"),target=libraryTarget||doc().kind;
    if(!C){
      list.replaceChildren(el("p","Loading component library…","side-note"));
      globalThis.AtriumLazy?.need("AtriumCatalogue").then(()=>{if(dialog.open)renderLibrary();},()=>{
        if(dialog.open)list.replaceChildren(el("p","The component library could not be loaded.","side-note"));
      });
      return;
    }
    const pool=project.library.filter(d=>!d.mirrorOf&&A.geometries(d,target));
    C.render(list,{owner:project,pool,query:query.value,target,ids:new Set(project.library.map(d=>d.id)),footprints:target==="pcb"&&!!swapFootprint,key:"dialog",onChange:renderLibrary,manage:{currentProject:()=>project,edit,info},
      onPick:choice=>{const def=defs.get(choice.id);if(!A.geometries(def,target)){renderLibrary();return;}dialog.close();if(swapFootprint)placeLinked(def);else beginPlace(def);}});
  }
  const fileUI=()=>AtriumLazy.need("AtriumEditorFiles");
  const fileDialog=(method,args)=>globalThis.AtriumEditorFiles?AtriumEditorFiles[method](...args):fileUI().then(ui=>ui[method](...args));
  const report=(...args)=>fileDialog("report",args),promptValue=(...args)=>fileDialog("promptValue",args);
  function addDocument(kind){
    const owner=project;
    const open=ui=>{if(project===owner)ui.addDocument(kind,navHost,added=>{
      if(project!==owner)return;
      checkpoint();project.documents.push(added);selectDocument(added.id,true);canvas.focus();info(added.name+" added");
    });};
    return globalThis.AtriumEditorFiles?open(AtriumEditorFiles):fileUI().then(open);
  }
  function newProject(){return fileDialog("newProject",[{async before(){
    if(!await mayReplace())return false;
    const previous=project, stamp=authoredRevision;
    await prepareWorkbench(previous,{starterView:false});
    if(previous!==project || stamp!==authoredRevision)return false;
    if(drag)endDrag(true);checkpoint();leaveFolder();setFileSession({});globalThis.AtriumHost?.clearProjectPath?.();importSessionChanged();return true;
  },units:()=>globalThis.AtriumPref?.get("general.units",project.units)||project.units,fab:newFab,show:showProject,info}]);}
  function outlineDialog(d){
    const show=ui=>{if(d===doc())ui.perimeter(d,{project,apply(points){if(d!==doc())return;edit(()=>{d.outline=points;delete d.boardShape;});fit();}});};
    if(globalThis.AtriumBoardShapeUI)show(AtriumBoardShapeUI);
    else globalThis.AtriumLazy?.need("AtriumBoardShapeUI").then(show,e=>info(e.message));
  }
  function mayReplace(force=false){
    if(globalThis.AtriumForeignDrafts?.needsReview(navHost))return globalThis.AtriumForeignDrafts.review(navHost);
    return dirty||force?fileUI().then(ui=>ui.confirmReplace({name:project.name||"Untitled",dirty,isDirty:()=>dirty,save:()=>save({all:true})})):Promise.resolve(true);
  }
  const boxOf=(a,b)=>[Math.min(a[0],b[0]),Math.min(a[1],b[1]),Math.max(a[0],b[0]),Math.max(a[1],b[1])];
  const pastePoint=p=>touchFree()?p:p.map(v=>A.snap(v,doc().grid));
  function selectable(i){return view.selectable(i,doc(),lineOpts(),defs)&&(!pcbEdit||pcbEdit.selectable(i));}
  function pruneSelection(){assignSelection(doc().items.filter(i=>selectedIds.has(i.id)&&selectable(i)).map(i=>i.id),selected,true);}
  function makeTranslation(frameOnly=false){
    return AtriumEditSelection.translation(doc(),defs,doc().items.filter(i=>selectedIds.has(i.id)),
      {frameOnly,query:b=>view.query(doc(),defs,b)});
  }
  function nudgeSelection(dx,dy){
    if(!selectedIds.size || !doc().items.some(i=>selectedIds.has(i.id) && !notebookLocked(i)))return;
    if(pcbEdit&&!pcbEdit.guardLocked(selectedIds,"Nudge",()=>nudgeSelection(dx,dy)))return;
    let moved=[];edit(()=>{const t=makeTranslation();t.apply(dx,dy);t.finish();moved=[...t.affected,...followDesignators(t.affected.filter(i=>i.kind==="part").map(i=>i.id))];},undefined,()=>moved);
  }
  // Re-place the designators of moved or rotated parts (and any they now cover). Call inside edit().
  function followDesignators(ids){
    if(!designatorFollow||!pcb()||!ids.length||!globalThis.AtriumDesignators)return [];
    return AtriumDesignators.apply(doc(),AtriumDesignators.relayout(doc(),defs,ids,{project}))||[];
  }
  function alignCommand(a){
    const G=globalThis.AtriumGuides;
    if(!G){info("This feature is unavailable in this build.");return;}
    const ids=doc().items.filter(i=>selectedIds.has(i.id) && !notebookLocked(i)).map(i=>i.id),grid=a==="align-grid";
    const run=plan=>{if(pcbEdit&&plan.locked?.length&&!pcbEdit.guardLocked(plan.locked,"Move",()=>run(plan)))return;
      if(!plan.moves.length){info("Nothing to move.");return;}
      const touched=new Set();
      edit(()=>{G.applyPlan(doc(),defs,plan,part=>view.connectedWires(doc(),defs,part),touched);for(const obj of followDesignators(plan.moves.map(m=>m.id)))touched.add(obj);},undefined,touched);
      info(plan.moves.length+(plan.moves.length===1?" object moved":" objects moved"));
    };
    if(ids.length<(grid?1:2)){info(grid?"Select the objects to align to the grid.":"Select two or more objects.");return;}
    if(a==="make-row"||a==="make-column"){
      promptValue(a==="make-row"?"Row pitch":"Column pitch",U.format(doc().grid*8,unit()),text=>{
        const pitch=U.parse(text,unit());
        if(!(pitch>0)){info("Enter a pitch greater than zero.");return;}
        run(G.array(doc(),defs,ids,a==="make-row"?"x":"y",pitch));
      },"Apply",{unit:unit(),storageUnit:"mm",nanometres:true,min:.000001});
      return;
    }
    run(grid?G.alignToGrid(doc(),defs,ids):a.startsWith("distribute")?G.distribute(doc(),defs,ids,a==="distribute-h"?"x":"y"):G.align(doc(),defs,ids,a.slice(6)));
  }
  function deleteSelection(){
    if(!selectedIds.size)return;
    if(pcbEdit&&!pcbEdit.guardLocked(selectedIds,"Delete",()=>deleteSelection()))return;
    const targets=doc().items.filter(i=>selectedIds.has(i.id) && !notebookLocked(i));
    if(!targets.length){info(notebookNotice);return;}
    const ids=new Set(targets.map(i=>i.id)),left=[...selectedIds].filter(id=>!ids.has(id));
    const removedAssertions=targets.some(i=>i.calculation?.primaryAssertionId||i.calculation?.assertions?.length);
    edit(()=>{doc().items=doc().items.filter(i=>!ids.has(i.id));if(removedAssertions)globalThis.AtriumCalculations.syncRules(project);assignSelection(left);},undefined,[]);
  }
  function storeSelection(copy,cut){
    if(!copy)return;
    if(cut && (copy.doc!==current || doc().items.filter(i=>selectedIds.has(i.id)&&!notebookLocked(i)).length!==copy.items.length || copy.items.some(item=>!selectedIds.has(item.id))))
      throw Error("Selection changed. Cut again to remove the selected objects.");
    clipboard=copy;if(cut)deleteSelection();syncTools();
    info(copy.items.length+(copy.items.length===1?" object":" objects")+(cut?" cut":" copied"));return copy;
  }
  async function beginPaste(clip){
    if(!clip)return;
    if(notebookOff()){
      const items=clip.items.filter(i=>!notebookLocked(i));
      if(!items.length){info(notebookNotice);return;}
      if(items.length!==clip.items.length)clip={...clip,items,origin:AtriumEditSelection.originOf(items[0]).slice()};
    }
    const signal=clip.items.some(i=>A.notebookItemKind?.(i))?globalThis.AtriumLabs?.notebookSignal():null;
    if(signal?.aborted){info(notebookNotice);return;}
    if(clip.items.some(i=>i.calculation)&&!globalThis.AtriumCalculations){
      const owner=project,sheet=doc(),rev=revision;
      globalThis.AtriumLazy.need("AtriumCalculations").then(()=>{if(!signal?.aborted&&owner===project&&sheet===doc()&&rev===revision)beginPaste(clip);},e=>{if(!signal?.aborted)info(e.message);});return;
    }
    try{
      const target=doc(), pending=AtriumEditSelection.demand(clip);
      if(pending){await pending;if(signal?.aborted||doc()!==target)return;}
      const plan=AtriumEditSelection.prepare(project,target,clip,defs),at=pointer;
      resetTools();single(null);paste=plan;pointer=at;tool="paste";canvas.focus();
      syncTools();inspect();draw();info("Click to place "+plan.items.length+(plan.items.length===1?" object.":" objects."));
    }catch(error){info(error.message);}
  }
  function currentLayers(){return layerCache??=AtriumCanvas.routingLayers(doc(),defs);}
  // View Configuration (Ctrl+L) reads and drives the same hidden-layer state as the layer tabs.
  const viewConfigCtx={
    hidden:()=>hidden,layer:()=>layer,layerMode:()=>layerMode,
    layers:()=>[...currentLayers(),...AtriumPCBLayerBar.otherLayers(navHost)],doc:()=>doc(),defs:()=>defs,
    setLayerMode:m=>{layerMode=m;pruneSelection();inspect();syncTools();draw();},
    redraw:()=>{pruneSelection();syncTools();inspect();draw();}
  };
  globalThis.addEventListener?.("atrium-pcb-appearance",()=>{const bar=$("layer-tabs");if(bar)bar.dataset.layers="";syncTools();inspect();for(const p of panes)p.version++;draw();});
  // Theme and appearance changes repaint every pane, not just the active one.
  globalThis.addEventListener?.("atrium-theme",()=>{for(const p of panes)p.version++;draw();});
  let shortcutTitlesPending=false;
  globalThis.AtriumKeymap?.onChange?.(()=>{
    if(shortcutTitlesPending)return;
    shortcutTitlesPending=true;
    queueMicrotask(()=>{
      shortcutTitlesPending=false;
      syncSplitTitles(true);syncToolTitles(true);syncUnits();syncUnsavedTitle();pcbEdit?.sync?.();
    });
  });
  function setActiveLayer(v){
    if(v===layer)return;
    if(routeSession){routerLayer(v);return;}
    if(chain.length){chain=[];routeStops=[];routeNet="";info("Layer changed. Click to start a new route.");}
    layer=v;pruneSelection();inspect();syncTools();draw();
  }
  let loadingLayerBar=false;
  function syncLayerControl(){
    const bar=$("layer-tabs");if(!bar||!pcb())return;
    const copper=currentLayers().filter(k=>!hidden.has(k)),ui=globalThis.AtriumPCBLayerBar;
    if(ui&&viewportVisible){
      layer=ui.sync(bar,navHost,copper,layerMode,{refresh:syncLayerControl,setMode:viewConfigCtx.setLayerMode,visibilityChanged:viewConfigCtx.redraw});
      return;
    }
    if(!copper.includes(layer))layer=(ui?ui.copperTabs(copper,doc(),layer):copper)[0]||"";
    if(viewportVisible&&!loadingLayerBar&&globalThis.AtriumLazy){
      loadingLayerBar=true;
      AtriumLazy.need("AtriumPCBLayerBar").then(()=>{loadingLayerBar=false;syncLayerControl();},e=>{loadingLayerBar=false;if(pcb()&&viewportVisible)info(e.message);});
    }
  }
  function measureText(a,b){
    const dx=b[0]-a[0],dy=b[1]-a[1],d=Math.hypot(dx,dy),other=unit()==="mil"?"mm":"mil";
    return (pcb()?"Board":"Sheet")+" distance "+len(d)+" ("+U.format(d,other)+")   Δx "+len(dx)+"   Δy "+len(dy);
  }
  // Schematic route completion needs contact geometry only. PCB routes and vias also need the net.
  function netAt(p) {
    const board=pcb(),opts=lineOpts();
    for(const i of view.query?.(doc(),defs,[p[0]-.001,p[1]-.001,p[0]+.001,p[1]+.001])||doc().items){
      if(i.kind==="part")for(const pin of A.pins(i,defs.get(i.def),doc().kind)){
        if(!pin.hidden&&(!board||AtriumCanvas.canContact(pin,i,opts))&&A.same(pin.at,p))return {hit:true,net:board?(i.pinNets?.[pin.number]??pin.net??""):""};
      }
      if(board&&!AtriumCanvas.canContact(i,null,opts))continue;
      if(["pad","via","junction","netlabel"].includes(i.kind)&&A.same([i.x,i.y],p))return {hit:true,net:i.net||i.text||""};
      if(!board&&i.kind!=="bus"&&globalThis.AtriumSchObjects?.KINDS.has(i.kind)&&AtriumSchObjects.hotspots(i).some(q=>A.same(q,p)))return {hit:true,net:i.text||""};
      if(["wire","track"].includes(i.kind)&&i.points.some((q,n)=>n&&A.nearSegment(p,i.points[n-1],q)<.00011))return {hit:true,net:i.net||""};}
    return {hit:false,net:""};
  }
  function commitRoute(){
    routeStops=[];
    if(chain.length<2){
      chain=[];
      if(wireAtCursor)setTool("select");else draw();
      return;
    }
    checkpoint();
    doc().items.push(pcb()?{id:uid(),kind:"track",points:chain,width:routeWidth,layer,net:routeNet}:{id:uid(),kind:"wire",points:chain});
    if(!pcb())globalThis.AtriumPrefs?.junctions?.(doc(),doc().items.at(-1));
    chain=[];routeNet="";
    if(wireAtCursor){const at=pointer;resetTools();pointer=at;}
    change();
    info(pcb()?"Track placed":"Wire placed");
  }
  function clickTool(p){
    if(tool==="pick-point"){const r=pickResolve;pickResolve=null;setTool("select");r?.(p);return;}
    if(tool==="sch-place"){Promise.resolve(globalThis.AtriumSchObjects?.click(p)).catch(e=>info(e.message));return;}
    if(tool.startsWith?.("length-tune")){lengthClick(p);return;}
    if(tool==="measure"){
      if(!measureStart || measureEnd){measureStart=p;measureEnd=null;info("Click the second measurement point.");}
      else {measureEnd=p;info(measureText(measureStart,measureEnd));}
      draw();return;
    }
    if(tool==="move-object"){
      if(!movingObject){
        const item=view.hit(doc(),defs,pointer||p,lineOpts());if(!item)return;if(notebookLocked(item)){choose(item.id);info(notebookNotice);return;}
        if(pcbEdit&&!pcbEdit.guardLocked([item.id],"Move",()=>{movingObject={item,anchor:p};ghostAngle=item.angle||0;choose(item.id);draw();}))return;
        movingObject={item,anchor:p};ghostAngle=item.angle||0;choose(item.id);
        info("Click to place. Escape cancels the move.");draw();return;
      }
      const item=movingObject.item,preview=moveProjection(p),delta=p.map((n,i)=>n-movingObject.anchor[i]);
      if(delta.some(n=>n!==0) || item.kind==="part"&&preview.angle!==(item.angle||0) || pcbEdit?.state.ghostFlip){
        if(item.kind==="part")editTransform(item,{x:preview.x,y:preview.y,angle:preview.angle},false,true);
        else if(globalThis.AtriumSchObjects?.isFrame(item)){const move=makeTranslation(clickCtrl);edit(()=>{move.apply(...delta);move.finish();},undefined,()=>move.affected);}
        else edit(()=>A.moveItem(item,...delta),undefined,[item]);
      }
      setTool("select");choose(item.id);return;
    }
    if(tool==="paste"&&paste){const placed=paste;edit(()=>{const ids=placed.commit(p);resetTools();assignSelection(ids);});const again=placed.again?.();if(again){paste=again;pointer=p;tool="paste";syncTools();draw();info("Stamped "+placed.items.length+(placed.items.length===1?" object":" objects")+". Click for another; Escape or right-click ends.");return;}info(placed.items.length+" placed");return;}
    if(tool==="split-wire"||tool==="junction"){
      const plan=AtriumWireEdit.place(doc(),tool,p,5/view.scale(),bounds=>view.query(doc(),defs,bounds));
      if(plan.changed)edit(()=>plan.apply());info(plan.message);return;
    }
    if(pcb()&&(routing()||tool==="via")&&!layer){info("Show a copper layer to route or place a via.");return;}
    if(tool==="place"&&pending){if(schPlacementClicks){schPlacementClicks.push({at:p,angle:ghostAngle});return;}if(focusedPart&&doc().items.some(i=>i.kind==="part"&&i.ref===focusedPart.ref)){info(focusedPart.ref+" already exists on this board.");return;}checkpoint();const part=A.instantiate(project,pending,p,ghostAngle,focusedPart),repeat=!pcb()&&!focusedPart&&globalThis.AtriumSchPlace;if(repeat)AtriumSchPlace.decorate(part,pending,project);
      if(pcb()&&focusedPart){const sd=project.documents.find(d=>d.items.includes(focusedPart));if(sd){const n=globalThis.AtriumHierarchy?AtriumHierarchy.sheetNets(project,sd,defs):A.connectivity(sd,defs);for(const pad of A.pins(part,pending,"pcb"))part.pinNets[pad.number]=n.byPin.get(focusedPart.id+"/"+pad.number)||"";}}
      doc().items.push(part);pcbEdit?.commitGhost(part);if(repeat){change();info(part.ref+" placed. Click to place "+AtriumSchPlace.ghostPart(pending,project).ref+"; Tab edits, Escape or right-click ends.");return;}resetTools();single(part.id);change();info(part.ref+" placed");}
    else if(routeArm)routeArm.anchor??={point:pointer||p,revision,layer};
    else if(useRouter())routerClick(p);
    else if(tool==="route"){const n=netAt(p);if(chain.length){if(pcb()&&n.net&&routeNet&&routeNet!==n.net){info("This terminal belongs to "+n.net+".");return;}if(!routeNet&&pcb())routeNet=n.net;
      const a=chain.at(-1);if(A.same(a,p)){commitRoute();return;}chain.push(...routePath(a,p).slice(1));routeStops.push(chain.length);if(n.hit)commitRoute();else draw();}
      else {chain=[p];routeStops=[1];if(pcb()&&n.net)routeNet=n.net;info("Click or Enter adds a corner. Escape finishes the placed path.");draw();}}
    else if(tool==="via"){
      const net=netAt(p).net||routeNet, at={id:uid(),x:p[0],y:p[1],net};
      let via;
      try { via=globalThis.AtriumViaStack?AtriumViaStack.place(doc(),at,{project,defs,obeyRules:true}):{...at,kind:"via",diameter:.84,drill:.4,layer:"Multi"}; }
      catch(e){info(e.message);return;}
      edit(()=>doc().items.push(via),undefined,[]);
    }
    else if(tool==="label"&&!pcb()&&globalThis.AtriumSchPlace)AtriumSchPlace.placeLabel(p,{edit,doc,info});
    else if(tool==="label"){
      const target=doc(),owner=project,board=pcb();
      const prompt=()=>{
        if(project!==owner||doc()!==target||tool!=="label")return;
        promptValue(board?"Board text":"Net name",board?"Text":"SIGNAL",text=>{
          if(project===owner&&doc()===target)edit(()=>target.items.push({id:uid(),kind:board?"label":"netlabel",x:p[0],y:p[1],text,...(board?{layer:"Silk",size:1}:{})}));
        });
      };
      if(!board||!lazyRetry("place-board-text","AtriumPCBText",prompt))prompt();
    }
  }
  // Interactive routing on boards. First click starts a session on the net under the cursor;
  // each click anchors, Ctrl+click auto-completes, Escape or right-click commits as one undo step.
  function routerClick(p){
    if(!routeSession){
      const at=routeStart(p),o={net:at.net,layer,start:at.point,revision,project,...routePrefs,...AtriumRouteFeel.routeOptions(routePrefs.corner)};
      if(routeFromNet&&!routeFromNet.includes(at.net)){info("Choose a pad or track of "+routeFromNet.join(" or ")+".");return;}
      if(routeCornerOverride)o.corner=routeCornerOverride;
      if(routeWidthSet)o.width=routeWidth;
      try{
        if(tool==="route-diffpair"){if(!globalThis.AtriumDiffPair)throw Error("Differential pair routing is unavailable in this build.");routeSession=AtriumDiffPair.begin(doc(),defs,o);}
        else routeSession=AtriumRouter.begin(doc(),defs,o);
      }catch(e){routeSession=null;info(e.message);return;}
      routeCornerOverride=null;routePreview=routeSession.move(p);routeStatus();draw();return;
    }
    if(clickCtrl&&routeSession.complete){const r=routeSession.complete(p);if(r?.done){finishRoute();return;}info(r?.message||"Couldn't complete this connection automatically.");draw();return;}
    routePreview=routeSession.move(p);const r=routeSession.click();routePointer=null;
    if(r?.done)finishRoute();else{routeStatus();draw();}
  }
  // Altium starts a route from the pad or track under the cursor (route-feel.js start).
  function routeStart(p){return AtriumRouteFeel.start(p,{netAt,pointer,opts:lineOpts(),view,doc:doc(),defs});}
  function finishRoute(){
    const s=routeSession;if(!s)return;const pre=routePreview;routeSession=null;routePreview=null;
    const st=s.state||{};if(st.mode)routePrefs.mode=st.mode;if(st.corner)routePrefs.corner=st.corner;
    const plan=s.commit();
    if(plan&&(plan.add?.length||plan.modify?.length||plan.remove?.length)){let accepted=false;edit(()=>{AtriumRouter.apply(doc(),plan);accepted=true;},undefined,()=>planItems(plan));if(!accepted)return;globalThis.AtriumRouteFeel?.committed(plan,pre);info((tool==="route-diffpair"?"Differential pair placed":"Track placed")+(plan.length?" · "+len(plan.length):""));}
    else draw();
  }
  function routerLayer(v){
    const r=routeSession.switchLayer(v);
    if(!r?.ok){info(r?.message||"Can't change layer here.");syncTools();return;}
    layer=v;routePointer=null;info(r.message||"Layer "+v);syncTools();inspect();draw();
  }
  function routeStatus(){if(routePreview&&globalThis.AtriumRouteFeel)info(AtriumRouteFeel.status(routePreview,len));}
  // Track tools pick tracks only (view.hit kinds), so a track running inside a footprint's
  // courtyard is found rather than the footprint (round 3, bug 2).
  function trackHit(p){return view.hit(doc(),defs,p,{...lineOpts(),kinds:["track"]});}
  // Interactive length tuning (Route menu, T R / T I): the first click picks a track
  // segment, moving previews the meander, the second click commits as one undo step.
  function lengthClick(p){
    if(lengthSession){
      updateTuning(pointer||p);const s=lengthSession,plan=s.commit(),pr=s.properties();lengthSession=null;lengthPointer=null;
      for(const k of ["style","amplitude","gap","miter","sides","rounding"])if(pr[k]!=null&&!(pr.phase&&k==="style"))lengthPrefs[k]=pr[k];
      if(plan&&(plan.add?.length||plan.remove?.length||plan.modify?.length))edit(()=>AtriumLength.applyPlan(doc(),plan),"Length tuning",planItems(plan));
      info("Click another track to tune, or Escape to finish.");draw();return;
    }
    const at=pointer||p,item=trackHit(at);
    if(!item){info("Click a track to tune.");return;}
    try{lengthSession=AtriumLength.begin(doc(),defs,{trackId:item.id,at,pair:tool!=="length-tune",skew:tool==="length-tune-skew",phase:tool==="length-tune-phase",revision,project,...lengthPrefs});
      lengthPointer=null;updateTuning(at);draw();}
    catch(e){lengthSession=null;info(e.message);}
  }
  function lengthProperties(pr){
    const session=lengthSession;
    AtriumLength.properties(pr,{unit:unit(),info,closed:()=>canvas.focus(),apply(values){
      if(session!==lengthSession)return;updateTuning(pointer);const r=session.set(values);if(r?.gauge?.text)info(r.gauge.text);draw();
    }});
  }
  function prewarmRouter(){if(useRouter()){
    globalThis.AtriumLazy?.need?.("AtriumRouteSuggest").catch(()=>{});
    if(!globalThis.AtriumPower?.efficient?.())try{AtriumRouter.world(doc(),defs,{revision});}catch{}
  }}
  // Arm the real tool immediately. Only its first anchor is retained if the JS is still loading.
  function armRouter(){
    const L=globalThis.AtriumLazy;
    if(!L||L.has("AtriumRouter")){prewarmRouter();return;}
    const request=routeArm={anchor:null,steps:0},status=$("status").textContent;
    info("Loading…");
    L.need("AtriumRouter").then(()=>{
      if(routeArm!==request)return;
      routeArm=null;
      if(loadingStatus())info(status);
      prewarmRouter();
      if(request.steps)cycleConflict(request.steps);
      const at=request.anchor;
      if(at&&at.revision===revision&&at.layer===layer){
        const next=pointer;
        pointer=at.point;
        try{clickTool(snapAt(pointer));}catch(error){info(error.message);}finally{pointer=next;}
      }
      drawPointer();
    },error=>{if(routeArm!==request)return;setTool("select");info(error.message);});
  }
  function cycleConflict(step){
    if(!useRouter())return;
    const ms=AtriumRouter.modes;
    if(routeSession){routeSession.cycleMode(step);routePrefs.mode=routeSession.state?.mode;routePointer=null;}
    else routePrefs.mode=ms[(ms.indexOf(routePrefs.mode||ms[0])+step)%ms.length];
    info(AtriumRouter.modeNames?.[routePrefs.mode]||routePrefs.mode);draw();
  }
  let webPicker;
  async function openWebFiles(input){
    let handles;
    try{handles=await showOpenFilePicker({multiple:input.multiple});}
    catch(error){if(error.name!=="AbortError")input.click();return;}
    const files=await Promise.all(handles.map(async handle=>
      Object.defineProperty(await handle.getFile(),"fileHandle",{value:handle})));
    return importFiles(files);
  }
  function openFilePicker(extensions){
    if(openBusy||webPicker)return;
    const source=$("file-input"), input=extensions?document.createElement("input"):source;
    if(extensions){input.type="file";input.multiple=true;input.accept=extensions.join(",");input.onchange=()=>importFiles(input.files);}
    if(globalThis.AtriumHost)AtriumHost.open(extensions||source.getAttribute("accept").split(",")).then(files=>importFiles(files)).catch(async error=>{
      info(error.message);
      if(error.code==="pre-release-format")(await fileUI()).report([error.message],"Couldn’t open this file");
    });
    // The browser API rejects KiCad's underscore suffixes in a type filter. The
    // normal intake still validates selected formats after this multi-file chooser.
    else if(!extensions&&location.protocol!=="file:"&&globalThis.isSecureContext&&typeof showOpenFilePicker==="function")
      webPicker=openWebFiles(input).catch(error=>info(error.message)).finally(()=>{webPicker=null;});
    else input.click();
  }
  async function importFiles(files,o={}){
    if(openBusy||!files?.length&&!o.directories?.length)return false;
    const selection=Array.from(files || []);
    openBusy=true;
    // Something is opening: the start page waiting on a chooser closes now (start-page.js).
    try{globalThis.dispatchEvent?.(new CustomEvent("atrium-opening",{detail:{into:!!o.into}}));}catch{}
    try{return await (await fileUI()).open(selection,o,{host:navHost,info,folderUI,folderContext,context:workflowContext,mayReplace,adopt,fitOpened});}
    finally{openBusy=false;}
    function adopt({after,newDoc,openLib,libraryTarget:target},imported){
      if(drag)endDrag(true);
      const session=folder();
      if(session&&(openLib||o.into)){
        FUI().mergeImported(session,after,navHost);
        if(openLib)libraryTarget=target;else selectDocument(newDoc);
        return;
      }
      checkpoint();
      if(!openLib&&!o.into){leaveFolder();setFileSession(imported||{});}
      if(o.into||openLib){
        project=after;
        if(!openLib&&newDoc!==current)selectDocument(newDoc,true);else change();
        if(openLib){libraryTarget=target;const d=A.preferredDocument(project,target,current);if(d&&d.id!==current)selectDocument(d.id);}
      }else {showProject(after,newDoc,true);if(!imported)importSessionChanged();}
    }
  }
  function showProject(p,id,deferFit=false,clean=false){
    const replacement=p!==project;
    if(replacement)for(const pane of panes){pane.view?.invalidate?.();if(pane.view)globalThis.AtriumCanvasGPU?.release?.(pane.view.internals());}
    project=p;current=id;navEmit("replace");documentViews.clear();globalThis.AtriumMessages?.clear?.(null,{replacement});single(null);
    hidden=new Set();highlight="";schematicNetHighlight=null;resetTools();
    if(clean){
      revision++;starter=false;dirtyState(false);refreshDefs(true);refresh();
      globalThis.AtriumExtensions?.notify("documentChanged");
    }else change();
    globalThis.AtriumExtensions?.notify("activeDocumentChanged");
    if(!deferFit)fit();
  }
  function save(o={}){
    const mirror=mirrorWorkspace();
    if(mirror&&o.as){info("Use Save As in the project’s main window.");return Promise.resolve(false);}
    const field=document.activeElement, session=fileSession, documentId=current;
    const pending=session.imported;
    if(pending)o={...o,anchor:o.anchor||field};
    field?.blur?.();
    const numeric=globalThis.AtriumNumericFields;
    const commit=field?.waffleNumericWaiting ? AtriumLazy.need("AtriumNumericFields").then(ui=>ui.commitField(field)) :
      numeric?.draft?.(field) ? numeric.commitField(field) : null;
    const fail=error=>{info(error.message);return false;};
    const write=()=>afterWorkspaceGesture(()=>{
      if(fileSession!==session||mirror&&current!==documentId)return false;
      if(mirror)return forwardMirror("save",{all:o.all===true});
      const target=current===documentId?doc():docById(documentId)||doc(), whole=o.all||o.as||!folder(), owner=project;
      const copper=globalThis.AtriumPolygonPour?.live?.pendingSave?.(whole||o.only?undefined:target,o.only);
      return copper?copper.then(()=>fileSession===session&&project===owner&&saveCommitted(o,pending,target.id),fail):saveCommitted(o,pending);
    });
    const settle=()=>{const edits=globalThis.AtriumNumericFields?.finishEdits?.(navHost);return edits?edits.then(ok=>ok&&write(),fail):write();};
    return commit?commit.then(ok=>ok&&settle(),fail):settle();
  }
  function saveCommitted(o,pending,documentId){
    if(folder()?.standalone && o.as)return folder().standalone.copyOriginal();
    const context=()=>folderContext(documentId);
    if(folder()&&!o.as)return FUI().save(folder(),context(),o);
    if(pending){
      return fileUI().then(ui=>pending.current()&&ui.saveImported(pending,o,{
        host:navHost,folderUI,folderContext:context,clean:()=>dirtyState(false)}));
    }
    return folderUI().then(ui=>ui.create(context(),{download:o.download})).catch(e=>{info(e.message);return false;});
  }
  // Print prints what has focus: a report (an element marked data-print-target that holds the focus,
  // else the topmost open dialog marked so: BOM, Messages, the Print dialogs) before the document.
  function printTarget(a){
    const focused=document.activeElement?.closest?.("[data-print-target]"),open=[...document.querySelectorAll("dialog[open][data-print-target]")].pop();
    const modal=document.querySelector("dialog:modal"),t=focused||open;
    if(!t){if(modal){info("Close this dialog to print the document.");return true;}return false;}
    t.dispatchEvent(new CustomEvent("atrium-print",{detail:{mode:a==="export-pdf"?"pdf":"print"}}));return true;
  }
  function workflow(a){
    const session=folder();
    if(session&&FUI().workflow(session,a,()=>{if(folder()===session)workflow(a);},info))return;
    if(lazyRetry(a,"AtriumEditorWorkflows",()=>workflow(a)))return;
    pcbEdit?.beforeOutput?.(a);
    const selectBoard=()=>{
      if(pcb())return true;
      const board=A.preferredDocument(project,"pcb",current);
      if(!board){info("Open a board layout first.");return false;}
      selectDocument(board.id);return true;
    };
    return globalThis.AtriumEditorWorkflows?.open(a,{selectBoard,info,context:()=>workflowContext(a),retry:name=>lazyRetry(a,name,()=>workflow(a))});
  }
  function workflowContext(action){
    document.querySelectorAll(".project-tools[open]").forEach(e=>e.open=false);
    resetTools();syncTools();
    const session=folder(), apply=session&&(action==="eco"||action==="eco-reverse")?(...args)=>FUI().atomicEdit(session,()=>edit(...args)):edit;
    return {project,doc:doc(),defs,edit:apply,info,refresh,revision:()=>revision,folderProject:session,
      exportBinaryCopy:AtriumIO.exportBinaryCopy,connections:()=>view.boardConnectivity(doc(),defs),
      showUnrouted:()=>showUnrouted,toggleUnrouted:()=>{showUnrouted=!showUnrouted;inspect();draw();navEmit("unrouted");},
      locate:(id,point)=>{choose(id);const at=view.worldToScreen(point);glide(()=>view.pan(canvas.clientWidth/2-at[0],canvas.clientHeight/2-at[1]));canvas.focus();draw();},select:(id,other)=>{
      const owner=project.documents.find(d=>d.items.some(i=>i.id===id));if(owner&&owner.id!==current)selectDocument(owner.id);choose(id,true);
    },selection:()=>[...selectedIds],currentProject:()=>project,showCatalogue:k=>{swapFootprint=null;showLibrary(k);},exportFile:AtriumIO.exportFile,pickFile:AtriumIO.pickFile,
      units:unit(),documentKind:()=>doc().kind,placeDef:(def,k=doc().kind)=>{if(!A.geometries(def,k)){info("This component has no "+(k==="pcb"?"footprint":"symbol")+".");return;}if(doc().kind!==k){const t=A.preferredDocument(project,k,current);if(!t){info("Add a "+(k==="pcb"?"board layout":"schematic sheet")+" first.");return;}selectDocument(t.id);}if(dialog.open)dialog.close();beginPlace(defs.get(def.id)||def);},place:items=>beginPaste({kind:"pcb",doc:current,cut:false,origin:[0,0],items,library:[]}),fit,pickPoint};
  }
  function boardCommand(action,name,run){
    const feature=globalThis[name];
    if(!feature){
      if(lazyRetry(action,name,()=>boardCommand(action,name,run)))return;
      info("This feature is unavailable in this build.");
      return;
    }
    if(!pcb()){
      const board=A.preferredDocument(project,"pcb",current);
      if(!board){info("Open a board layout first.");return;}
      selectDocument(board.id);
    }
    const selection=[...selectedIds];
    resetTools();syncTools();
    return run(feature,{project,doc:doc(),defs,edit,info,selection,pickPoint,
      select:ids=>{assignSelection(ids);inspect();syncTools();draw();}});
  }
  // Feature modules load on first use (lazy.js). An action whose module is missing shows
  // "Loading…" and runs once it arrives; repeats are ignored while it loads.
  const lazyWaiting=new Map();
  // Lazy-dispatch audit: a handler whose module is not loaded yet (an action missing from
  // lazy.js's map, or reached another way) awaits AtriumLazy.need and runs again, instead of
  // reporting the feature unavailable. True when a load started.
  function lazyRetry(a,name,run){
    const L=globalThis.AtriumLazy;if(!name||!L||globalThis[name]!=null||!L.modules?.().includes(name))return false;
    if(lazyWaiting.has(a))return true;lazyWaiting.set(a,null);info("Loading…");
    L.need(name).then(()=>{lazyWaiting.delete(a);if(loadingStatus())info("Ready");attachExtensions();run();},e=>{lazyWaiting.delete(a);info(e.message);});
    return true;
  }
  // The fab preset for new projects (Get set up › Fab house, "start.fabPreset"), applied as the start page applies it to a blank project.
  async function newFab(p){const id=globalThis.AtriumPref?.get("start.fabPreset","");if(!id)return null;try{const S=globalThis.AtriumStartPage||await globalThis.AtriumLazy.need("AtriumStartPage");return await S.withFab(p);}catch(e){info(e.message);return null;}}
  function cancel3DIntent(){opening3D?.release?.();opening3D=null;}
  function lazyGate(a,run,nextChord){
    const labs=globalThis.AtriumLabs;
    if(labs?.allowsAction(a)===false){info("Enable notebook features in Preferences › Experimental features to use this command.");return true;}
    if(a==="view-2d"||a==="escape")cancel3DIntent();
    if(a==="view-3d"&&!viewportVisible)return true;
    if(AtriumNavCommon.openPaletteAction(a,nextChord))return true;
    if(a==="route"&&pcb()||a==="route-diffpair")return false; // armRouter retains the first input while loading
    const L=globalThis.AtriumLazy,names=L?.forAction(a,doc().kind);
    if(!names||L.has(names))return false;
    if(a==="view-3d"&&(!opening3D||opening3D.pane!==activePane||opening3D.board!==doc())){
      cancel3DIntent();opening3D={pane:activePane,board:doc(),release:editPipeline?.holdIdle(250)};
    }
    if(lazyWaiting.has(a)&&!lazyWaiting.get(a)?.aborted)return true;
    const was=$("status")?.textContent,signal=labs?.notebookAction(a)?labs.notebookSignal():null;
    lazyWaiting.set(a,signal);info("Loading…");
    L.need(names).then(()=>{
      if(lazyWaiting.get(a)!==signal)return;
      lazyWaiting.delete(a);if(loadingStatus())info(was||"Ready");if(signal?.aborted)return;attachExtensions();
      if(a==="view-3d"){const open=opening3D?.pane===activePane&&opening3D?.board===doc()&&viewportVisible;cancel3DIntent();if(!open)return;}
      run(a);
    },e=>{if(lazyWaiting.get(a)!==signal)return;lazyWaiting.delete(a);if(a==="view-3d")cancel3DIntent();if(!signal?.aborted)info(e.message);});
    return true;
  }
  let extensionHost=null;
  function attachExtensions(){if(extensionHost&&globalThis.AtriumExtensions){const h=extensionHost;extensionHost=null;AtriumExtensions.attach(h);}}
  // Schematic place objects and the sheet hierarchy (sch-objects.js, hierarchy.js).
  function schCtx(change=edit){return {project:()=>project,doc,defs:()=>defs,edit:change,info,draw,setTool,selectDocument,canvas,view,unit,refresh,
    choose:(id,center)=>choose(id,center),selected:()=>active(),pickFile:AtriumIO.pickFile};}
  // Mirror X / Y, the Tab placement popover (sch-place.js) and checked toggle menu items.
  function placeCtx(){return {tool:()=>tool,pending:()=>pending,project:()=>project,doc,defs:()=>defs,draw,info,canvas};}
  function mirrorCommand(a){
    const S=globalThis.AtriumSchPlace,axis=a==="mirror-x"?"x":"y",word=axis==="x"?"horizontally":"vertically";
    if(!S){if(lazyRetry(a,"AtriumSchPlace",()=>mirrorCommand(a)))return;info("This feature is unavailable in this build.");return;}
    if(pcb()){info("Mirror X/Y is for schematics. On boards, L flips a component to the other side.");return;}
    if(tool==="place"&&pending){ghostAngle=S.mirrorGhost(axis,ghostAngle);info("Mirrored "+word+".");draw();return;}
    if(tool==="sch-place"){info(S.mirrorFloating(axis)?"Mirrored "+word+".":"This object does not mirror.");draw();return;}
    if(tool==="paste"&&paste){S.mirrorItems({kind:"schematic",grid:doc().grid,items:paste.items},paste.defs,new Set(paste.items.map(i=>i.id)),axis,[0,0]);paste.bounds=A.docBounds({...doc(),outline:[],items:paste.items},paste.defs);draw();return;}
    if(drag?.kind==="move"&&drag.before&&!drag.segment){
      const touched=drag.mirrorItems??=new Set();for(const item of drag.translation.affected)touched.add(item);
      drag.translation.apply(0,0);drag.translation.finish();S.mirrorItems(doc(),defs,selectedIds,axis,drag.anchor,touched);invalidateViews(doc());
      drag.lastDelta=null;drag.translation=makeTranslation(drag.frameOnly);if(pointer)drag.translation.apply(...drag.anchor.map((v,k)=>A.snap(v+pointer[k]-drag.origin[k],doc().grid)-v));
      invalidateViews(doc());info("Mirrored "+word+".");draw();return;}
    const ids=tool==="move-object"&&movingObject?new Set([movingObject.item.id]):selectedIds;
    if(!ids.size){info("Select parts, wires or graphics to mirror. While placing or dragging, press X or Y.");return;}
    const touched=new Set();let n=0;edit(()=>{n=S.mirrorItems(doc(),defs,ids,axis,undefined,touched);},undefined,touched);info(n?n+(n===1?" object":" objects")+" mirrored "+word+".":"Nothing in the selection mirrors.");
  }
  const prefOut=(k,v)=>{if(k)globalThis.AtriumPref?.set(k,v);}; // menu toggles -> Preferences
  function syncChecks(){try{
    const S=globalThis.AtriumSchPlace,auto=S?S.prefs().autoIncrement:globalThis.AtriumPref?.get("general.autoIncrement",true)!==false;
    const on={"drag-reroute-toggle":dragPrefs.enabled,"smart-guides":smartGuides,"designators-follow":designatorFollow,"sch-hop-overs":!!doc()?.hopOvers,
      grid,"toggle-left":!document.body.classList.contains("hide-left"),"toggle-right":!document.body.classList.contains("hide-right"),messages:!!globalThis.AtriumMessages?.isOpen?.(),"library-panel":document.body.classList.contains("library-panel-open"),"scripting-console":document.querySelector('[data-action="scripting-console"]')?.getAttribute("aria-pressed")==="true",
      "view-planning":pcb()&&!in3D(activePane)&&!!globalThis.AtriumStackup?.isPlanning?.(),"view-3d":pcb()&&in3D(activePane),"view-2d":pcb()&&!in3D(activePane)&&!globalThis.AtriumStackup?.isPlanning?.(),/* integ-checks */
      hud:!!pcbEdit?.state?.hud,"snap-object":!!pcbEdit?.snapPrefs?.objects,unrouted:showUnrouted,"sch-auto-increment":auto};
    checkedMenuControls??=".menu-items :is("+actionSelector(Object.keys(on))+")";
    for(const n of document.querySelectorAll(checkedMenuControls)){chromeAttribute(n,"role","menuitemcheckbox");chromeAttribute(n,"aria-checked",String(!!on[n.dataset.action]));}
  }catch{}}
  function schObjects(a){const S=globalThis.AtriumSchObjects;if(!S){info("This feature is unavailable in this build.");return;}Promise.resolve(S.command(a,schCtx())).catch(e=>info(e.message));}
  // A command that throws is rolled back unless it recorded a step (edit() rolls back its own).
  let acting=0;
  function act(a){
    // Opening diagnostics never edits the board. Taking an undo snapshot here
    // can synchronize the journal and invalidate the board's render cache.
    if(a==="frame-monitor"){
      if(!lazyGate(a,act))navActions.get(a)?.();
      return;
    }
    if(folder()&&(a==="save"||a==="save-all"||a==="save-as"))return save({all:a==="save-all",as:a==="save-as"});if(acting||!(UNDO||=globalThis.AtriumUndoStore))return act0(a);const before=snapshot(),n=history.length,top=history[n-1];acting=1;try{return act0(a);}catch(e){if(history.length===n&&history[n-1]===top){project=revive(before);current=before.current;assignSelection(before.ids||[],before.selected);refreshDefs();refresh();}globalThis.AtriumDiagnostics?.failed(e);throw e;}finally{acting=0;}}
  function act0(a){globalThis.AtriumMotion?.action?.(a);(UNDO||=globalThis.AtriumUndoStore)?.action(a);if(in3D(activePane)&&Atrium3D.command(a,activePane.stage))return;
    // Shift+C clears the Filter and the net highlight; Select Net picks a net when none is in scope.
    if(a==="query-clear")a="highlight-filter-clear";else if(a==="select-net")a="select-net-pick";
    if(a==="drc")return workflow(a);
    if(lazyGate(a,act))return;installPCBEdit();const i=active();if(pcbEdit?.act(a)){if(a==="hud")prefOut("pcb.hud",!!pcbEdit.state?.hud);return;}switch(a){
    case "unrouted":showUnrouted=!showUnrouted;prefOut("pcb.showRatsnest",showUnrouted);inspect();draw();navEmit("unrouted");info(showUnrouted?"Unrouted connections shown":"Unrouted connections hidden");break;
    case "extensions":globalThis.AtriumExtensions?.openManager();break;
    case "scripting-console":globalThis.AtriumScripting?.toggle();break;
    case "print":case "export-pdf":if(!printTarget(a))workflow(a);break;
    case "board-shape":case "board-dimensions":case "board-wizard":case "import-dxf":case "export-dxf":
    case "compare":case "connectivity":case "export":case "symbols":case "blocks":case "eco":case "eco-reverse":case "rules":case "mcp":case "bom":case "annotate":case "fab":case "fab-outputs":case "output-jobs":case "step":case "logo":case "stackup":case "viaStack":case "viaTemplates":case "fabProfiles":case "rule-sets":case "via-stubs":case "compile":case "erc":case "messages":case "length":case "autoroute":case "autoroute-all":case "autoroute-net":case "autoroute-connection":case "autoroute-component":case "autoroute-area":case "fanout":workflow(a);break;
    case "phase-tune-static":
      if(!globalThis.AtriumLength||!pcb()){info("Open a board layout to match pair phase.");break;}
      AtriumLength.matchPhase(doc(),defs,{rounding:lengthPrefs.rounding,edit,info});break;
    case "diffpair-retrace":case "diffpair-gloss":case "route-tabs":case "route-tabs-trapezoid":
      if(globalThis.AtriumRouteFeel)AtriumRouteFeel.editTracks(a,navHost,{trackHit,promptValue,len,transition:()=>routePrefs.transition});
      else info("This feature is unavailable in this build.");break;
    case "drag-reroute-toggle":dragPrefs.enabled=!dragPrefs.enabled;prefOut("pcb.rerouteOnDrag",dragPrefs.enabled);info(dragPrefs.enabled?"Re-route on component drag: on (up to "+dragPrefs.maxConnections+" connections)":"Re-route on component drag: off");break;
    case "length-tune":case "length-tune-pair":case "length-tune-skew":case "length-tune-phase":
      if(!globalThis.AtriumLength){if(lazyRetry(a,"AtriumLength",()=>act(a)))break;info("This feature is unavailable in this build.");break;}
      if(!pcb()){const board=A.preferredDocument(project,"pcb",current);if(!board){info("Open a board layout first.");break;}selectDocument(board.id);}
      setTool(a);info(a==="length-tune-phase"?"Click a track of a differential pair: bumps keep it in phase up to the cursor. 1/2 distance, 3/4 tolerance, [/] rounding, Tab properties.":"Click a track to tune its length. 1/2 amplitude, 3/4 gap, ,/. miter, [/] sawtooth rounding, Tab properties.");break;
    case "layer-controls":if(!pcb()){info("Layer controls are for board layouts.");break;}executeKey(a);break;
    case "view-config":case "view-2d":case "view-3d":case "view-planning":case "grid-picker":case "grid-custom":case "grid-next":/* integ-grid */executeKey(a);break;
    case "polygon-pour":case "repour":
      boardCommand(a,"AtriumPolygonPour",(p,ctx)=>p.command(a,ctx,active(),layer));break;
    case "via-fence":case "fence-selected":case "fence-edge":case "fence-area":case "fence-return":case "fence-regenerate":case "fence-remove":
      boardCommand(a,"AtriumViaFence",(f,ctx)=>f.command(a,{...ctx,revision:()=>revision,units:unit(),
        selection:()=>[...selectedIds],preview:p=>{fencePreview=p;draw();}}));break;
    case "about":globalThis.AtriumAbout?.about();break;case "licenses":globalThis.AtriumAbout?.licenses();break;
    case "add-schematic":addDocument("schematic");break;case "add-pcb":addDocument("pcb");break;
    case "rename-document":fileDialog("renameDocument",[navHost]);break;
    case "new":newProject();break;
    case "save":save();break;case "save-all":save({all:true});break;case "save-as":save({as:true});break;case "open":openFilePicker();break;case "undo":undo();break;case "redo":undo(true);break;
    case "save-project-zip":case "discard-import-data":AtriumLazy.need("AtriumProjectArchiveUI").then(ui=>ui[a==="save-project-zip"?"save":"discard"]({host:navHost})).catch(e=>info(e.message));break;
    case "theme-preferences":case "theme-gallery":AtriumTheme.open();break;
    case "keyboard-shortcuts":AtriumKeymap.open({kind:doc().kind,exportFile:AtriumIO.exportFile,pickFile:AtriumIO.pickFile});break;
    case "swap-components":case "swap-components-origin":case "swap-variant":case "swap-variant-back":case "swap-variant-pick":case "swap-library":
      AtriumSwap.run(a,{project:()=>project,doc,defs:()=>defs,selection:()=>[...selectedIds],edit,info});break;
    case "move-object":setTool("move-object");canvas.focus();break;
    case "library-panel":case "library-sources":case "footprint-wizard":case "footprint-editor":case "symbol-editor":case "edit-footprint":case "edit-symbol":case "symbol-wizard":workflow(a);break;
    case "library":swapFootprint=null;workflow("library-place");break;case "library-catalogue":swapFootprint=null;showLibrary();break;case "close-dialog":dialog.close();swapFootprint=null;break;
    case "copy":designClipboard.copy(false);break;
    case "cut":designClipboard.copy(true);break;
    case "paste":designClipboard.paste();break;
    case "measure":setTool("measure");break;
    case "split-region":case "add-bend-line":
      if(!pcb()||!globalThis.AtriumRigidFlex){info("Open a board layout first.");break;}
      AtriumRigidFlex.pickPlanningLine(a,{doc,defs:()=>defs,edit,draw,info,pickPoint});break;
    case "fit-objects":case "fit-document":executeKey(a);break;
    case "duplicate":beginPaste(AtriumEditSelection.capture(doc(),defs,selectedIds,false,project.blobs,project));break;
    case "select-all":assignSelection(doc().items.filter(item=>selectable(item)).map(i=>i.id));inspect();syncTools();draw();break;
    case "layer-mode":if(pcb()){layerMode=({all:"dim",dim:"single",single:"all"})[layerMode];pruneSelection();inspect();syncTools();draw();info(({all:"All layers",dim:"Other layers dimmed",single:"Active layer only"})[layerMode]);}break;
    case "junction":case "split-wire":if(!pcb())setTool(a);break;
    case "start-wire":{
      if(doc().kind!=="schematic")break;
      const at=pointer&&snapAt(pointer);
      if(chain.length){const finishing=wireAtCursor;commitRoute();if(finishing)break;}
      setTool("route");wireAtCursor=true;canvas.focus();
      if(at)clickTool(at);
      break;}
    case "select":case "pan":case "route":case "label":setTool(a);if(a==="route"&&pcb())armRouter();break;
    case "route-diffpair":
      if(!pcb()){const board=A.preferredDocument(project,"pcb",current);if(!board){info("Open a board layout first.");break;}selectDocument(board.id);}
      setTool(a);info("Click a pad or track of a differential pair to start routing it.");armRouter();break;case "via":if(pcb())setTool(a);break;
    case "rotate":if(pending){ghostAngle=(ghostAngle+90)%360;draw();}else if(i?.kind==="part"&&(!pcbEdit||pcbEdit.guardLocked([i.id],"Rotate",()=>act(a))))editTransform(i,{angle:((i.angle||0)+90)%360},true);break;
    case "align-left":case "align-right":case "align-top":case "align-bottom":case "align-hcenter":case "align-vcenter":
    case "distribute-h":case "distribute-v":case "align-grid":case "make-row":case "make-column":alignCommand(a);break;
    case "designators-place":
      if(!globalThis.AtriumDesignators){info("This feature is unavailable in this build.");break;}
      if(!pcb()){info("Open a board layout first.");break;}
      AtriumDesignators.placeSelection(doc(),defs,{project,selection:selectedIds,edit,info});break;
    case "arrange-board":case "arrange-rect":
      boardCommand(a,"AtriumArrange",(arrange,ctx)=>arrange.command(a,ctx).catch(e=>info(e.message)));break;
    case "designators-follow":designatorFollow=!designatorFollow;prefOut("pcb.designatorsFollow",designatorFollow);info(designatorFollow?"Designators follow moved and rotated parts.":"Designators stay where they are.");break;
    case "mirror-x":case "mirror-y":mirrorCommand(a);break;
    case "smart-guides":smartGuides=!smartGuides;prefOut("pcb.smartGuides",smartGuides);info(smartGuides?"Smart guides on. Hold Ctrl (⌘) while dragging to suspend them.":"Smart guides off.");break;
    case "sch-power":case "sch-port":case "sch-offsheet":case "sch-sheet-symbol":case "sch-sheet-entry":case "sch-bus":case "sch-bus-entry":
    case "sch-noerc":case "sch-text":case "sch-textframe":case "sch-frame":case "sch-note":case "sch-line":case "sch-rect":case "sch-arc":case "sch-polygon":
    case "sch-image":case "sch-hierarchy-up":case "sch-hierarchy-down":case "sch-sync-entries":schObjects(a);break;case "sch-hop-overs":schObjects(a);prefOut("schematic.hopOvers",!!doc()?.hopOvers);break;
    case "delete":deleteSelection();break;
    case "sch-calculation":globalThis.AtriumCalculationSheet?.compose(navHost);break;
    case "fit":glide(fit);break;case "zoom-in":case "zoom-out":glide(()=>view.zoom(a==="zoom-in"?1.25:0.8),{relative:true});draw();break;case "grid":grid=!grid;syncTools();draw();break;case "toggle-units":toggleUnits();break;
    case "split-toggle":if(panes[1])closeSplit();else openSplit("right");break;
    case "split-right":case "split-down":openSplit(a==="split-down"?"down":"right");break;
    case "split-close":closeSplit();break;
    case "toggle-left":case "toggle-right":{
      const side=a==="toggle-left"?"left":"right";document.body.classList.toggle("hide-"+side);
      if(matchMedia("(max-width:620px)").matches&&!document.body.classList.contains("hide-"+side))document.body.classList.add("hide-"+(side==="left"?"right":"left"));
      revealInspector();syncTools();break;}
    default:if(navActions.has(a))navActions.get(a)();
  }}
  document.addEventListener("click",e=>{const b=e.target.closest("[data-action]");if(b&&!b.disabled&&b.dataset.action&&!e.target.closest("[data-extension]")){act(b.dataset.action);syncChecks();}});
  $("file-input").onchange=e=>{importFiles(e.target.files);e.target.value="";};
  query.oninput=renderLibrary;
  dialog.addEventListener("cancel",()=>{swapFootprint=null;});
  dialog.addEventListener("click",e=>{if(e.target===dialog){dialog.close();swapFootprint=null;}});
  // Net highlight (Ctrl/⌘+click on board copper, Alt+click, context menu, Nets panel). altium-keys.js
  // (lazy) dims everything else, names the net in the status bar and owns the Altium pick tools.
  function setHighlight(n,scope=null){
    n=n||"";
    if(n===highlight&&scope===schematicNetHighlight){
      if(n&&highlightSelectionVersion!==selectionVersion){highlightSelectionVersion=selectionVersion;navEmit("highlight");}
      return;
    }
    if(scope!==schematicNetHighlight)navVersion++;
    highlight=n;schematicNetHighlight=n?scope:null;highlightSelectionVersion=selectionVersion;inspect();draw();navEmit("highlight");
    if(n&&globalThis.AtriumLazy&&!globalThis.AtriumAltiumKeys)AtriumLazy.need("AtriumAltiumKeys").then(()=>draw(),()=>{});
  }
  function clearHighlight(){const had=!!highlight;if(had)setHighlight("");return had;}
  // Move Selection / Drag (M S, M D, altium-keys.js): the objects follow the pointer until a click.
  function beginStickyMove(item,p){
    if(notebookLocked(item)){info(notebookNotice);return;}
    globalThis.AtriumCollabLive?.flush?.();
    const wire=item.kind==="wire"&&selectedIds.size===1,segment=wire?AtriumWireEdit.begin(doc(),item,defs,p,b=>view.query(doc(),defs,b)):null;
    drag={kind:"move",item,start:view.worldToScreen(p),origin:p,anchor:AtriumEditSelection.originOf(item).slice(),segment,before:null,sticky:true};navEmit("move-intent",drag);draw();
  }
  function hitList(v,d,p,o,limit=8){return v.hits(d,defs,p,o,limit);}
  function pointerDown(e){
    if(e.button===2){rightDown(e);return;}
    if(e.button!==0&&e.button!==1)return;e.preventDefault();canvas.focus();if(!globalThis.AtriumCanvasInput?.isReplay(e))canvas.setPointerCapture(e.pointerId);const s=screen(e),p=view.screenToWorld(s);pointer=p;
    // Move Selection / Drag (M S, M D): the objects follow the pointer and this click places them.
    if(drag?.sticky){const moved=!!drag.before;endDrag(false);info(moved?"Moved.":"Ready");return;}
    if(tool==="pan"||e.button===1||e.altKey&&e.pointerType!=="touch"||space){beginPan(e,false);return;}
    pcbEdit?.pointerDown(p);
    if(globalThis.AtriumBlocks?.canvasClick(p.map(n=>A.snap(n,doc().grid)))){draw();return;}
    if(tool!=="select"){clickCtrl=e.ctrlKey||e.metaKey;clickTool(tool==="paste"?pastePoint(p):snapAt(p));clickCtrl=false;return;}
    globalThis.AtriumCollabLive?.flush?.();
    // Altium: Ctrl+click (⌘+click on macOS) on copper highlights its net and dims the rest.
    if(pcb()&&e.pointerType!=="touch"&&(e.ctrlKey||e.metaKey)&&!e.shiftKey&&e.button===0){act("net-click");return;}
    const gripRadius=6/view.scale(),selectedWire=!pcb()&&!e.shiftKey&&selectedIds.size===1?active():null;
    const onGrip=AtriumWireEdit.endpointAt(selectedWire,p,gripRadius)!==null;
    // Altium: a press on a part's Designator, Comment or visible parameter takes that text, not the part
    // (unless the part is one of several selected objects, which then move together).
    const t=!onGrip&&!e.shiftKey&&e.pointerType!=="touch"?textAt(p):null;
    if(t&&!(selectedIds.size>1&&selectedIds.has(t.item.id))){
      if(t.key){assignSelection([]);fieldSel={id:t.item.id,key:t.key};syncTools();inspect();draw();info(SF().label(t.key)+" of "+(t.item.ref||"the part")+". Drag to move it; Space rotates it.");}
      else choose(t.item.id);
      drag={kind:"text",id:e.pointerId,t,item:t.item,start:s,origin:p,before:null};return;
    }
    // A finger that starts on any selected object under it moves the selection (docs/design-system.md, Touch).
    let hit=onGrip?selectedWire:e.pointerType==="touch"&&selectedIds.size?(l=>l.find(i=>selectedIds.has(i.id))||l[0])(hitList(view,doc(),p,lineOpts())):view.hit(doc(),defs,p,lineOpts());if(hit&&pcbEdit&&!pcbEdit.selectable(hit))hit=null;
    if(!hit){
      if(!e.shiftKey&&clearHighlight())info("Net highlight cleared.");
      const previous=new Set(selectedIds);
      if(!e.shiftKey)choose(null);
      drag={kind:"box",id:e.pointerId,origin:p,start:s,previous:e.shiftKey?previous:new Set(),moved:false};
      return;
    }
    const frameOnly=(e.ctrlKey||e.metaKey)&&globalThis.AtriumSchObjects?.isFrame(hit);
    if(frameOnly && selectedIds.size>1)choose(hit.id);
    // Schematic: a grip of the selected rectangle resizes it.
    const resize=!pcb()&&selectedIds.size===1&&selectedIds.has(hit.id)&&globalThis.AtriumSchObjects?.resizeAt?.(hit,p,6/view.scale());
    const copy=e.pointerType==="touch"&&e.ctrlKey&&globalThis.AtriumLabs?.notebookEnabled()!==false&&globalThis.AtriumTouchPrecision;
    if(resize&&!e.shiftKey&&!copy&&!frameOnly){drag={kind:"resize",id:e.pointerId,item:hit,start:s,resize,before:null};info("Drag to size. Escape cancels.");return;}
    if(e.shiftKey){
      const ids=new Set(selectedIds);if(ids.has(hit.id))ids.delete(hit.id);else ids.add(hit.id);
      assignSelection(ids,hit.id);inspect();syncTools();draw();return;
    }
    if(!selectedIds.has(hit.id)){
      if(hit.groupId||hit.unionId){assignSelection((pcbEdit?.mates?pcbEdit.mates(doc(),hit):doc().items.filter(i=>i.groupId===hit.groupId)).filter(i=>selectable(i)).map(i=>i.id),hit.id);inspect();syncTools();draw();}
      else choose(hit.id);
    }
    else {selected=hit.id;syncTools();if(highlight&&highlightSelectionVersion===selectionVersion){highlightSelectionVersion=-1;navEmit("selection");}}
    if(notebookLocked(hit)){info(notebookNotice);return;}
    if(copy){drag={kind:"copy",id:e.pointerId,start:s,copy:copy.duplicate(navHost,p)};return;}
    const wire=hit.kind==="wire" && selectedIds.size===1;
    const segment=wire?AtriumWireEdit.begin(doc(),hit,defs,p,b=>view.query(doc(),defs,b),{
      tolerance:gripRadius,snap:at=>touchFree()?at:view.snapPoint(doc(),defs,at,{...lineOpts(),grid:true,exclude:hit.id})
    }):null;
    if(wire&&!segment){info("Edit this wire in Properties → Vertices.");return;}
    drag={kind:"move",id:e.pointerId,item:hit,frameOnly,start:s,origin:p,anchor:AtriumEditSelection.originOf(hit).slice(),segment,before:null};navEmit("move-intent",drag);
  }
  // Delay the native context menu until release distinguishes a right click from a pan.
  let rightPress=null,rightReplay=false,rightDrop=null;
  function beginPan(e,right){
    globalThis.AtriumCamera?.takeCamera?.(view);
    drag={kind:"pan",id:e.pointerId,at:[e.clientX,e.clientY],right};
    if(!right)canvas.style.cursor="var(--ui-cursor-panning)";
  }
  function rightDown(e){
    if(drag||rightPress)return;
    canvas.setPointerCapture?.(e.pointerId);
    rightDrop=null;rightPress={id:e.pointerId,x:e.clientX,y:e.clientY,t:performance.now(),moved:false,held:null};
    beginPan(e,true);
  }
  function movePan(e){
    if(e.pointerId!==drag.id)return;
    if(drag.right && !rightPress?.moved){
      if(!rightPress || Math.hypot(e.clientX-rightPress.x,e.clientY-rightPress.y)<4)return;
      drag.moved=rightPress.moved=true;canvas.style.cursor="var(--ui-cursor-panning)";
    }
    const dx=e.clientX-drag.at[0],dy=e.clientY-drag.at[1];
    if(!dx&&!dy)return;
    view.pan(dx,dy);drag.at=[e.clientX,e.clientY];
    pointer=view.screenToWorld(screen(e));keyboardPoint=false;showCoords(pointer);
    cameraFrame(activePane);
  }
  addEventListener("pointerup",e=>{
    const r=rightPress;if(!r||r.id!==e.pointerId||e.button!==2)return;
    if(drag?.right)movePan(e);rightPress=null;
    const click=!r.moved&&performance.now()-r.t<(globalThis.AtriumCamera?.clickMs?.()||250);
    if(!click)rightDrop={canvas,until:performance.now()+800};
    if(!r.held)return;
    // After the release has run (the pan ends), as if the menu had opened on mouse-up.
    if(click)setTimeout(()=>{rightReplay=true;try{r.held.target.dispatchEvent(new MouseEvent("contextmenu",r.held.init));}finally{rightReplay=false;}},0);
  },true);
  addEventListener("pointercancel",e=>{if(rightPress?.id===e.pointerId)rightPress=null;},true);
  addEventListener("contextmenu",e=>{
    if(rightReplay)return;
    const r=rightPress;
    if(r&&e.target===canvas){e.preventDefault();e.stopImmediatePropagation();
      r.held??={target:e.target,init:{bubbles:true,cancelable:true,composed:true,view:window,button:2,clientX:e.clientX,clientY:e.clientY,screenX:e.screenX,screenY:e.screenY,ctrlKey:e.ctrlKey,shiftKey:e.shiftKey,altKey:e.altKey,metaKey:e.metaKey}};return;}
    if(rightDrop?.canvas===e.target&&rightDrop.until>performance.now()){rightDrop=null;e.preventDefault();e.stopImmediatePropagation();}
  },true);
  // Mouse back/forward thumb buttons step the view history (camera.js); the browser's history never moves.
  for(const t of ["pointerdown","pointerup","mousedown","mouseup","auxclick"])addEventListener(t,e=>{
    if(e.button!==3&&e.button!==4)return;e.preventDefault();e.stopPropagation();
    if(t==="pointerup"&&!document.querySelector("dialog:modal"))executeKey(e.button===3?"view-back":"view-forward");
  },true);
  function move(e){
    if(drag?.kind==="pan"){movePan(e);return;}
    const s=screen(e);let p=view.screenToWorld(s);pointer=p;keyboardPoint=false;
    showCoords(p);
    /* chords-corner */if(drag?.corner&&drag.kind==="move"&&globalThis.AtriumAltiumTools)p=AtriumAltiumTools.constrain(drag.corner,drag.origin,p);
    if(drag?.kind==="box" && Math.hypot(s[0]-drag.start[0],s[1]-drag.start[1])>3)drag.moved=true;
    if(drag?.kind==="copy"&&(drag.copy.plan||Math.hypot(s[0]-drag.start[0],s[1]-drag.start[1])>3))drag.copy.move(p);
    if(drag?.kind==="resize"&&(drag.before||Math.hypot(s[0]-drag.start[0],s[1]-drag.start[1])>3)){
      if(!drag.before)drag.before=snapshot();
      drag.resize.move(p,touchFree()?0:doc().grid);invalidateViews(doc(),[drag.item]);
      info("Size "+len(drag.item.w)+" × "+len(drag.item.h));
    }
    if(drag?.kind==="text"&&(drag.before||Math.hypot(s[0]-drag.start[0],s[1]-drag.start[1])>3)){
      if(!drag.before){drag.before=snapshot();drag.session=SF().session(doc(),defs,drag.t);if(!drag.session){drag=null;return;}}
      // Snaps to the grid like Altium; Ctrl/⌘ or Shift (or the touch modifier) places it freely.
      const free=touchFree()||e.ctrlKey||e.metaKey||e.shiftKey||pcb()&&pcbEdit&&!pcbEdit.snapPrefs.grid;
      const at=drag.session.anchor.map((v,k)=>free?v+p[k]-drag.origin[k]:A.snap(v+p[k]-drag.origin[k],doc().grid));
      if(""+at!==""+drag.last){drag.session.move(at);drag.last=at;invalidateViews(doc(),[drag.item]);}
    }
    else if(!drag&&!pcb()&&e.pointerType!=="touch"){
      const f=textAt(p),was=fieldHover;fieldHover=f?{id:f.item.id,key:f.key}:null;
      if(was?.id!==fieldHover?.id||was?.key!==fieldHover?.key){canvas.style.cursor=fieldHover?"move":"";drawPointer();}
    }
    if(drag?.kind==="move"&&(drag.before||Math.hypot(s[0]-drag.start[0],s[1]-drag.start[1])>3)){
      if(!drag.before){
        if(!drag.segment&&pcbEdit&&!pcbEdit.guardLocked(selectedIds,"Move")){drag=null;return;}
        drag.before=snapshot();
        if(drag.segment)drag.originalPoints=drag.item.points;
        else {
          // Parts keep their tracks: re-route each pad's connection while dragging (one undo step on drop).
          drag.reroute=null;dragPreview=null;
          if(pcb()&&globalThis.AtriumRouter?.dragSession&&[...selectedIds].some(id=>{const it=doc().items.find(i=>i.id===id);return it&&(it.kind==="part"||it.kind==="via"||it.kind==="pad");}))
            try{drag.reroute=(globalThis.AtriumDragReroute||AtriumRouter).dragSession(doc(),defs,[...selectedIds],{revision,project,enabled:dragPrefs.enabled,maxConnections:dragPrefs.maxConnections,mode:routePrefs.mode,corner:routePrefs.corner,shift:e.shiftKey,onUpdate:p=>{if(drag?.reroute){dragPreview=p;if(p.statusText)info(p.statusText);drawPointer();}}});}catch(error){drag.reroute=null;}
          drag.translation=makeTranslation(drag.frameOnly ?? (e.ctrlKey||e.metaKey));
          guideSession=smartGuides&&globalThis.AtriumGuides?AtriumGuides.begin(doc(),defs,selectedIds,{viewport:boxOf(view.screenToWorld([0,0]),view.screenToWorld([canvas.clientWidth,canvas.clientHeight]))}):null;
        }
      }
      if(drag.segment){
        const step=touchFree()?0:doc().grid;
        drag.item.points=drag.segment.pointsAt(p,step);
        const F=drag.segment.followers||[];for(const f of F)f.wire.points=f.session.pointsAt(p,step);
        invalidateViews(doc(),[drag.item,...F.map(f=>f.wire)]);
      }else{
        let d=drag.anchor.map((v,k)=>{const raw=v+p[k]-drag.origin[k];return (touchFree()||pcbEdit&&pcb()&&!pcbEdit.snapPrefs.grid?raw:A.snap(raw,doc().grid))-v;});
        // Smart guides override the grid on the axis they snap; Ctrl/Cmd suspends them.
        guideResult=guideSession&&!touchFree()?guideSession.snap([p[0]-drag.origin[0],p[1]-drag.origin[1]],{scale:view.scale(),threshold_px:6,grid:doc().grid,anchor:drag.anchor,suspend:e.ctrlKey||e.metaKey,gridOnly:!pcb()}):null;
        const osnap=!touchFree()&&pcbEdit&&pcb()&&!(e.ctrlKey||e.metaKey)?pcbEdit.snap([drag.anchor[0]+p[0]-drag.origin[0],drag.anchor[1]+p[1]-drag.origin[1]],{exclude:selectedIds}):null;
        if(osnap){d=[osnap[0]-drag.anchor[0],osnap[1]-drag.anchor[1]];guideResult=null;}
        else if(guideResult)d=guideResult.delta;
        if(e.pointerType==="touch")drag.touchPoint=p.map((_,k)=>drag.origin[k]+d[k]);
        if(!drag.lastDelta||d[0]!==drag.lastDelta[0]||d[1]!==drag.lastDelta[1]){
          invalidateViews(doc(),drag.translation.apply(...d));drag.lastDelta=d;
        }
        if(drag.reroute){try{dragPreview=drag.reroute.move(d);if(dragPreview.statusText)info(dragPreview.statusText);}catch(error){drag.reroute.cancel();drag.reroute=null;dragPreview=null;}}
      }
    }
    pcbEdit?.pointerMove(p);
    if(pointerArtwork())drawPointer();
  }
  function pointerArtwork(){
    return drag||paste||measureStart||movingObject||keyboardPoint||pending||chain.length||routeSession||
      useRouter()||lengthSession||pickFrom||blockOverlay()||tool==="sch-place"||tool==="label"&&!pcb();
  }
  // Include earlier mirror positions and their attached wires, even after the translation was restarted.
  function dragHint(plan,follow,r){
    if(pcbEdit&&!r||!drag.resize&&!drag.segment&&!drag.translation)return;
    const items=drag.resize?[drag.item]:drag.segment?[drag.item,...(drag.segment.followers||[]).map(f=>f.wire)]:[...drag.translation.affected];
    return {doc:doc(),items:[...items,...(drag.mirrorItems||[]),...planItems(plan),...follow],library:!!(drag.flipLibrary||r?.mirrors?.length)};
  }
  function planItems(plan){const ids=new Set((plan?.modify||[]).map(m=>m.id));return ids.size?doc().items.filter(i=>ids.has(i.id)):[];}
  function endDrag(cancel){
    // A stationary right press never changed the camera or its canvas cursor.
    if(drag?.right&&!drag.moved){drag=null;return;}
    if(drag?.copy&&!cancel)drag.copy.commit();
    if(drag?.kind==="text"){
      const d=drag,hint={doc:doc(),items:[d.item]};drag=null;
      if(d.before){
        if(cancel){project=revive(d.before,hint);refreshDefs();invalidateViews(doc());refresh();if(fieldSel)fieldSel={...fieldSel};}
        else if(typeof UNDO?.unchanged==="function"&&d.before.pos!=null&&UNDO.unchanged(d.before,project,hint))info("No change");
        else{checkpoint(d.before);change({undoRecorded:typeof UNDO?.unchanged==="function"&&d.before.pos!=null,touched:hint});info((d.t.key?SF().label(d.t.key):"Label")+" moved.");}
      }
      navEmit("move-end");syncTools();inspect();draw();return;
    }
    if(drag?.kind==="box" && drag.moved && !cancel && pointer){
      const ids=view.enclosed(doc(),defs,boxOf(drag.origin,pointer),lineOpts()).filter(i=>!pcbEdit||pcbEdit.selectable(i)).map(i=>i.id);
      assignSelection([...drag.previous,...ids]);inspect();
    }
    if(drag?.before){
      if(cancel){
        if(drag.segment){drag.item.points=drag.originalPoints;for(const f of drag.segment.followers||[])f.wire.points=f.original;}else if(drag.resize)drag.resize.cancel();else {drag.translation.apply(0,0);drag.translation.finish();}
        // Back to the mark, with what changed while dragging (a mirror, a live repour's commit).
        project=revive(drag.before,dragHint(null,[],{}));refreshDefs();invalidateViews(doc());refresh();
      }else{
        let routed=null,follow=[];
        if(drag.reroute){try{const plan=drag.reroute.commit();if(plan.modify.length||plan.add.length||plan.remove.length){AtriumRouter.apply(doc(),plan);routed=plan;}if(plan.message)info(plan.message);}catch(error){info(error.message);routed=false;}}
        if(!drag.segment&&drag.translation){
          if(drag.translation.finish())invalidateViews(doc());
          follow=followDesignators(drag.translation.affected.filter(i=>i.kind==="part").map(i=>i.id));
        }
        const st=pcbEdit?.settle?.(),hint=routed===false?undefined:dragHint(routed,follow,st);
        // Dropped back where it started (nothing differs from the mark): no undo step, no unsaved change.
        const undoRecorded=typeof UNDO?.unchanged==="function"&&drag.before.pos!=null;
        // A pointer move names its own step.
        if(drag.kind==="move"&&!drag.sticky)UNDO?.action(drag.segment?"drag-object":"move-selection");
        if(undoRecorded&&UNDO.unchanged(drag.before,project,hint))info("No change");else{checkpoint(drag.before);change({undoRecorded,touched:hint});}
      }
    }
    if(drag?.reroute&&cancel)drag.reroute.cancel();
    const ended=!!drag;drag=null;dragPreview=null;guideSession=null;guideResult=null;pcbEdit?.reset();if(ended)navEmit("move-end");syncTools();draw();
  }
  function afterWorkspaceGesture(action){
    // Drag previews mutate the live model under an Undo mark until placement or Escape.
    if(!drag?.before)return action();
    return new Promise(resolve=>{
      const off=navHost.on("move-end",()=>{off();resolve();});
    }).then(()=>afterWorkspaceGesture(action));
  }
  function cameraFrame(p,inFrame){
    paneRepaint(p);p.view.moving?.();
    // The wheel animation already runs inside a frame. Include its camera in that paint.
    if(inFrame&&frame){cancelAnimationFrame(frame);paintFrame();}
  }
  // Preserve first-contact ordering and its document while the idle camera module loads.
  const inputOps={find:c=>panes.find(q=>q.canvas===c),host:()=>navHost,docId:p=>p===activePane?current:p.docId,active:p=>p===activePane,
    activate:activatePane,frame:cameraFrame,busy:()=>!!drag&&!drag.sticky};
  let precisionLoad=null;
  // One contact recogniser for every profile. Taps select and cycle, drags pan or move the selection, and
  // a hold picks up the object or opens the context menu on release. Two fingers pan and pinch.
  // Precision editing and the additional camera controls depend on notebook features.
  const createInput=()=>globalThis.AtriumCanvasInput?.create(inputOps);
  function inputEvent(e){
    if(globalThis.AtriumCanvasInput?.isReplay(e))return;
    if(e.type==="pointerdown"&&e.pointerType==="touch"&&fieldHover){fieldHover=null;drawPointer();}
    const notebook=globalThis.AtriumLabs?.notebookEnabled()!==false;
    const p=inputOps.find(e.target)||globalThis.AtriumCanvasInput?.surface(e.target)||coldContacts.get(e.pointerId);
    if(!canvasInput&&!inputLoad)canvasInput=createInput();
    const firstTouch=notebook&&p?.view&&e.type==="pointerdown"&&e.pointerType==="touch"&&!globalThis.AtriumTouchPrecision&&(!canvasInput||canvasInput.needsTouchPrecision(p.canvas));
    if(firstTouch) {
      precisionLoad??=AtriumLazy.need("AtriumTouchPrecision").catch(error=>info(error.message)).finally(()=>{precisionLoad=null;});
    }
    if(canvasInput&&!inputLoad&&!(firstTouch&&p?.view)){if(!canvasInput.handle(e,p))return;}
    else{
      if(!p?.view)return;
      const direct=e.pointerType==="touch"||e.pointerType==="pen";
      if(e.type==="pointerdown"){
        if(!direct||e.button!==0)return;
        coldContacts.set(e.pointerId,p);
        try{p.canvas.setPointerCapture(e.pointerId);}catch{}
      }else if(e.type.startsWith("pointer")||e.type==="lostpointercapture"){
        if(!coldContacts.has(e.pointerId))return;
      }else if(/^(click|dblclick|auxclick|contextmenu)$/.test(e.type)&&
          (!inputLoad||!direct&&!e.sourceCapabilities?.firesTouchEvents))return;
      const last=pendingInput.at(-1);
      if(pendingInput.length>=128&&e.type==="pointermove"&&last?.e.type===e.type&&last.e.pointerId===e.pointerId)last.e=e;
      else pendingInput.push({e,p,id:inputOps.docId(p)});
      if(!inputLoad){
        const load=inputLoad=AtriumLazy.need(["AtriumCamera","AtriumCanvasInput"]).then(()=>notebook&&precisionLoad).then(()=>{
          if(inputLoad!==load)return;
          canvasInput??=createInput();
          const waiting=pendingInput;pendingInput=[];coldContacts.clear();inputLoad=null;
          for(const q of waiting)if(q.p.canvas.isConnected&&inputOps.docId(q.p)===q.id)canvasInput?.handle(q.e,q.p);
        },error=>{if(inputLoad===load){pendingInput=[];coldContacts.clear();inputLoad=null;info(error.message);}});
      }
    }
    e.preventDefault();e.stopImmediatePropagation();
  }
  for(const type of ["pointerdown","pointerover","pointermove","pointerup","pointercancel","lostpointercapture","wheel",
    "touchstart","touchmove","touchend","touchcancel","gesturestart","gesturechange","gestureend","click","dblclick","auxclick","contextmenu"])
    addEventListener(type,inputEvent,{capture:true,passive:false});
  // A host whose web view reports touchscreen contacts as mouse input (macOS WKWebView) forwards them here
  // as [id,clientX,clientY] rows. The page takes a contact that starts on a design canvas and replays it as
  // touch pointers; anything else returns false and the host delivers its ordinary mouse events.
  const hostTouches=new Map();
  globalThis.__waffleDirectTouch=(phase,contacts)=>{
    const types={start:"pointerdown",move:"pointermove",end:"pointerup",cancel:"pointercancel"},type=types[phase];
    if(!type||!Array.isArray(contacts))return false;
    let taken=false;
    for(const [id,x,y] of contacts){
      if(!Number.isFinite(id)||!Number.isFinite(x)||!Number.isFinite(y))continue;
      let target=phase==="start"?null:hostTouches.get(id);
      if(phase==="start"){
        hostTouches.delete(id);
        const hit=document.elementFromPoint(x,y);
        if(!(hit instanceof HTMLCanvasElement)||!panes.some(p=>p.canvas===hit)&&!globalThis.AtriumCanvasInput?.surface(hit))continue;
        hostTouches.set(id,target=hit);
      }
      if(!target)continue;
      const end=phase==="end"||phase==="cancel";
      target.dispatchEvent(new PointerEvent(type,{bubbles:true,cancelable:true,composed:true,pointerId:1e6+id,pointerType:"touch",
        isPrimary:hostTouches.size===1,button:type==="pointermove"?-1:0,buttons:end?0:1,clientX:x,clientY:y,
        pressure:end?0:.5,width:20,height:20}));
      if(end)hostTouches.delete(id);
      taken=true;
    }
    return taken;
  };
  function cancelInput(){pendingInput=[];coldContacts.clear();canvasInput?.clear();}
  globalThis.AtriumLabs?.onChange(enabled=>{
    cancelInput();canvasInput=null;inputLoad=null;
    if(enabled)return;
    if(tool==="paste"&&paste?.items.some(i=>A.notebookItemKind?.(i)))setTool("select");
    for(const p of panes){const rad=p.view?.camera().rotation;if(rad){globalThis.AtriumCamera?.takeCamera(p.view);p.view.rotate(-rad);cameraFrame(p);}}
  });
  addEventListener("blur",()=>{cancelInput();rightPress=null;if(drag?.kind==="pan")endDrag(true);});
  document.addEventListener("visibilitychange",()=>{if(document.hidden)cancelInput();});
  function bindCanvas(c){
    const pane=()=>panes.find(p=>p.canvas===c),mine=()=>c===canvas;
    c.addEventListener("pointerdown",e=>{const p=pane();if(!p?.view)return;if(!mine()){if(e.button!==0&&e.button!==1&&e.button!==2)return;activatePane(p);}pointerDown(e);});
    c.addEventListener("pointermove",e=>{if(mine()&&(!drag||drag.sticky||drag.id===e.pointerId))move(e);});
    c.addEventListener("pointerup",e=>{if(mine()&&(!drag||!drag.sticky&&drag.id===e.pointerId))endDrag(false);});
    const cancelContact=e=>{if(mine()&&drag&&!drag.sticky&&drag.id===e.pointerId){rightPress=null;endDrag(true);}};
    c.addEventListener("pointercancel",cancelContact);
    c.addEventListener("lostpointercapture",cancelContact);
    c.addEventListener("pointerleave",e=>{
      if(e.pointerType==="touch"||!mine()||drag)return;
      const repaint=!pcb()||pointerArtwork();
      if(pointer)activePane.palettePoint={doc:doc(),xy:pointer.slice()};
      pointer=null;if(repaint)draw();
    });
    c.addEventListener("contextmenu",e=>{
      e.preventDefault();
      if(!mine()){activatePane(pane());return;}
      if(drag?.sticky){endDrag(true);info("Move cancelled.");return;}
      if(routeSession&&e.ctrlKey&&!e.metaKey&&e.button===0)return;
      if(routeSession)finishRoute();
      else if(chain.length)commitRoute();
      else if(tool==="sch-place"&&globalThis.AtriumSchObjects?.finish())draw();
      else if(tool!=="select"||drag||keyboardPoint||blockOverlay())setTool("select");
      else{
        // Opening a menu in Select still clears transient tools. The menu's own hit
        // handler refreshes Properties and the board if it changes the selection.
        const at=pointer;
        resetTools();pointer=at;
        info("Ready");
      }
    });
    c.addEventListener("dblclick",e=>{if(!mine()||tool!=="select")return;const p=view.screenToWorld(screen(e));
      // Altium: double-click a board object to edit it in Properties (Ctrl/⌘+double-click cross-probes).
      if(e.ctrlKey||e.metaKey)return;
      if(pcb()){if(view.hit(doc(),defs,p,lineOpts())){pointer=p;act("board-properties");e.preventDefault();}return;}if(globalThis.AtriumSchObjects?.dblclick(view.hit(doc(),defs,p,lineOpts()),p,schCtx()))e.preventDefault();});
    c.addEventListener("focus",()=>{if(!mine())activatePane(pane());fitRevealed();});
  }
  let space=false;
  function pointerHere(){
    return pointer || view.screenToWorld([canvas.clientWidth/2,canvas.clientHeight/2]);
  }
  // 3D layout view: view3d.js loads on the first press of 3 and overlays the pane's stage.
  function in3D(p){return !!(p&&globalThis.Atrium3D?.isOpen?.(p.stage));}
  let load3DBusy=false;
  function load3D(then){
    if(globalThis.Atrium3D){then();return;}
    if(load3DBusy)return;load3DBusy=true;info("Loading 3D view…");
    const s=document.createElement("script");s.src="canvas/view3d.js";
    const fail=()=>info("The 3D view could not be loaded. Use File → Export 3D STEP… instead.");
    s.onload=()=>{load3DBusy=false;if(globalThis.Atrium3D)then();else fail();};
    s.onerror=()=>{load3DBusy=false;s.remove();fail();};
    document.head.append(s);
  }
  function view3dCtx(){
    const p=activePane,paneDoc=()=>p===activePane?doc():panes.includes(p)?docById(p.docId):null;
    return {doc:doc(),defs,project,stage:p.stage||$("canvas-stage"),info,revision:()=>revision,document:()=>paneDoc()||null,currentProject:()=>project,
      alive:()=>panes.includes(p),holdIdle:editPipeline?.holdIdle,view2d:()=>p.view?.camera(),folder,activate:()=>{if(p!==activePane&&panes.includes(p))activatePane(p);},closed:()=>draw(),exportFile:AtriumIO.exportFile,
      selection:()=>{const d=paneDoc();return !d?[]:p===activePane?[...selectedIds]:linkedIds(d,doc(),selectedIds);},
      select:ids=>{if(p!==activePane&&panes.includes(p))activatePane(p);const have=new Set(doc().items.map(i=>i.id));assignSelection(ids.filter(id=>have.has(id)));inspect();syncTools();draw();}};
  }
  let keyEvent=null;
  function executeKey(action,param=undefined,nextChord=null){
    if(keyEvent&&globalThis.AtriumRouteFeel&&useRouter())action=AtriumRouteFeel.spaceAction(action,keyEvent);
    if(in3D(activePane)&&Atrium3D.command(action,activePane.stage,param))return;
    if(lazyGate(action,()=>executeKey(action,param,nextChord),nextChord))return;
    switch(action){
      case "escape":
        if(lengthSession){lengthSession.cancel();lengthSession=null;info("Length tuning cancelled.");draw();return;}
        if(routeSession){finishRoute();info("Click to start another route, or Escape to select.");return;}
        if(tool==="route"&&chain.length){commitRoute();if(tool==="route")info(pcb()?"Click to start another route, or Escape to select.":"Click a pin to start another wire, or Escape to select.");return;}
        if(tool==="sch-place"&&globalThis.AtriumSchObjects?.finish()){info("Placed. Click to start another, or Escape to select.");return;}
        endDrag(true);setTool("select");choose(null);return;
      case "deselect":setTool("select");choose(null);return;
      case "fit-document":case "fit-objects":{
        const scope=action==="fit-document"?"document":pcb()?"board":"objects";
        glide(()=>{view.fit(doc(),defs,scope);refScale=view.scale()||1;});draw();return;}
      case "rotate-ccw":case "rotate-cw":{
        const step=action==="rotate-ccw"?-90:90;
        // A moving or selected text field turns about its anchor; its part stays put (sch-fields.js).
        if(drag?.kind==="text"&&drag.t.key||fieldSel&&!drag){const ref=drag?{id:drag.item.id,key:drag.t.key}:fieldSel;
          if(drag?.session)drag.session.rotate(step);else edit(()=>SF().turn(doc(),defs,ref,step),undefined,[doc().items.find(i=>i.id===ref.id)]);
          invalidateViews(doc());inspect();draw();return;}
        if(tool==="sch-place"&&globalThis.AtriumSchObjects?.rotate(step))draw();
        else if(globalThis.AtriumSchObjects?.rotatable(active())&&tool==="select"){const item=active();edit(()=>AtriumSchObjects.rotateItem(item,step),undefined,[item]);}
        else if(pending || movingObject){ghostAngle=(ghostAngle+step+360)%360;draw();}
        else if(active()?.kind==="part"){const item=active();if(pcbEdit&&!pcbEdit.guardLocked([item.id],"Rotate",()=>executeKey(action,param)))return;editTransform(item,{angle:((item.angle||0)+step+360)%360},true);}
        return;}
      case "grid-next":{
        // G steps up through the presets of the current unit; Shift+G steps down.
        const sizes=U.presets(unit(),doc().kind),g=doc().grid;
        const next=param===-1?[...sizes].reverse().find(n=>n<g-1e-9)??sizes.at(-1):sizes.find(n=>n>g+1e-9)??sizes[0];
        edit(()=>{doc().grid=next;});info(gridText());return;}
      case "grid-picker":case "grid-custom":{
        const d=doc(),target={scope:"document",documentId:d.id,path:["grid"]};
        AtriumEditorKeys.gridPicker(d.grid,action==="grid-custom",(value,entry)=>{
          const fields=globalThis.AtriumNumericFields;
          if(value!==d.grid || entry || fields?.stored(project,target))edit(()=>{d.grid=value;fields?.remember(project,target,entry);});
          info(gridText());
        },{unit:unit(),kind:d.kind,target});return;}
      case "layer-controls":if(pcb()){AtriumPCBLayerBar.controls();syncTools();}return;
      case "length-key":{if(!lengthSession)return;updateTuning(pointer);const r=lengthSession.key(param);if(r?.properties){lengthProperties(r.properties);return;}if(r?.gauge?.text)info(r.gauge.text);draw();return;}
      case "view-2d":if(in3D(activePane))Atrium3D.close(activePane.stage);if(globalThis.AtriumStackup?.setPlanning)AtriumStackup.setPlanning(false);info("2D layout mode");draw();return;
      case "view-3d":if(!pcb())return;load3D(()=>{if(pcb())Atrium3D.open(view3dCtx());});return;
      case "view-planning":if(!pcb())return;if(in3D(activePane))Atrium3D.close(activePane.stage);if(globalThis.AtriumStackup?.setPlanning){if(AtriumStackup.setPlanning(true)===false)info("Rigid-flex support is not loaded.");else{info("Board planning mode: regions and bend lines");draw();}}else info("Board planning mode arrives with rigid-flex support.");return;
      case "view-config":if(pcb()&&globalThis.AtriumViewConfig)AtriumViewConfig.toggle(viewConfigCtx);return;
      case "pan-hold":space=true;return;
      case "route-bend":if(routeSession){routeSession.toggleBend();routePointer=null;draw();return;}reverseBend=!reverseBend;draw();return;
      case "route-mode":{
        if(useRouter()){const cs=AtriumRouter.corners;
          if(routeSession){routeSession.cycleCorner(1);routePrefs.corner=routeSession.state?.corner;routePointer=null;}
          else {
            const corner=routeCornerOverride||AtriumRouteFeel.routeOptions(routePrefs.corner).corner||cs[0];
            routeCornerOverride=routePrefs.corner=cs[(cs.indexOf(corner)+1)%cs.length];
          }
          info(AtriumRouter.cornerNames?.[routePrefs.corner]||routePrefs.corner);draw();return;}
        const modes=pcb()?["45","90","free"]:["90","45","free"];
        routeMode=modes[(modes.indexOf(routeMode||modes[0])+1)%modes.length];
        info(routeMode==="free"?"Free-angle routing":routeMode+"° routing");draw();return;}
      case "route-conflict":if(routeArm)routeArm.steps++;else cycleConflict(1);return;
      case "route-layer-next":case "route-layer-prev":{
        if(!routeSession)return;const ls=currentLayers();if(ls.length<2)return;
        const k=ls.indexOf(layer),step=action==="route-layer-next"?1:-1;routerLayer(ls[(k+step+ls.length)%ls.length]);return;}
      case "route-via":if(routeSession?.addVia){const r=routeSession.addVia();if(r?.ok&&r.layer){layer=r.layer;syncTools();}if(r?.message)info(r.message);routePointer=null;draw();}return;
      case "route-autoshrink":if(routeSession?.toggleAutoShrink){routePrefs.autoShrink=routeSession.toggleAutoShrink();info("Diff pair auto-shrink "+(routePrefs.autoShrink?"on":"off"));routePointer=null;draw();}else{routePrefs.autoShrink=routePrefs.autoShrink===false;info("Diff pair auto-shrink "+(routePrefs.autoShrink?"on":"off"));}return;
      case "route-transition":{const list=globalThis.AtriumDiffPair?.transitions||["mitered","rounded","step"];
        routePrefs.transition=routeSession?.cycleTransition?routeSession.cycleTransition(1):list[(list.indexOf(routePrefs.transition||list[0])+1)%list.length];
        info(globalThis.AtriumDiffPair?.transitionNames?.[routePrefs.transition]||routePrefs.transition);routePointer=null;draw();return;}
      case "route-width":if(routeSession?.nextWidth){routeSession.nextWidth(param===-1?-1:1);routePointer=null;draw();}return;
      case "route-via-size":if(routeSession?.nextVia){routeSession.nextVia(param===-1?-1:1);routePointer=null;draw();}return;
      case "route-arc":if(routeSession&&globalThis.AtriumRouteFeel){info(AtriumRouteFeel.arcKey(routeSession,param));routePointer=null;draw();}return;
      case "route-back":
        if(routeSession){if(!routeSession.back()){routeSession.cancel();routeSession=null;routePreview=null;}routePointer=null;const bl=routeSession?.state?.layer;if(bl&&bl!==layer){layer=bl;syncTools();inspect();}draw();return;}
        if(routeStops.length){routeStops.pop();chain.length=routeStops.at(-1)||0;if(!chain.length)routeNet="";draw();}return;
      case "cursor-step":{
        pointer=pointerHere().map((v,n)=>A.snap(v+(n||!view.flipped?.()?1:-1)*param[n]*doc().grid,doc().grid));keyboardPoint=true;
        showCoords(pointer);
        draw();return;}
      case "nudge":nudgeSelection((view.flipped?.()?-1:1)*param[0]*doc().grid,param[1]*doc().grid);return;
      case "place-at-pointer":{
        pointer=param??pointerHere();clickTool(tool==="paste"?pastePoint(pointer):snapAt(pointer));return;}
      case "select-at-pointer":choose(view.hit(doc(),defs,pointerHere(),lineOpts())?.id||null);return;
      case "tool-properties":{
        if(!pcb()&&globalThis.AtriumSchPlace?.popover(placeCtx()))return;
        document.body.classList.remove("hide-right");syncTools();
        const field=$("inspector").querySelector('[aria-label^="Width ("],[aria-label="Net"]');
        field?.focus();field?.select?.();return;}
      case "zoom-at":view.zoom(param,view.worldToScreen(pointerHere()));draw();return;
      case "keep-routing":case "prefix-cancel":return;
      case "route":case "via":case "label":case "junction":case "measure":case "pan":
        act(action);canvas.focus();return;
      default:act(action);
    }
  }
  function captureImageHost(host){
    const doc=host.doc(),session=host.folderProject?.(),op=new AbortController(),labs=globalThis.AtriumLabs?.notebookSignal();
    const abort=()=>op.abort();
    if(labs?.aborted)abort();else labs?.addEventListener("abort",abort,{once:true});
    const current=()=>!op.signal.aborted&&host.doc()===doc&&host.folderProject?.()===session;
    const offDoc=host.on("document",()=>{if(!current())op.abort();});
    const offProject=host.on("replace",()=>op.abort());
    return {doc,session,signal:op.signal,current,close(){offDoc();offProject();labs?.removeEventListener("abort",abort);}};
  }
  globalThis.AtriumNotebookImageDrop={capture:captureImageHost};
  function placeAttachment(file,point,source){
    if(notebookOff() || !file || !globalThis.AtriumNavHost?.folderProject?.() || doc().kind!=="schematic" ||
       !/^(image\/(heic|heif|png|jpeg|webp|svg\+xml)|application\/pdf)$/.test(file.type) && !/\.(heic|heif|png|jpe?g|webp|svg|pdf)$/i.test(file.name))return false;
    const scope=captureImageHost(navHost);
    AtriumLazy.need("AtriumNotebookImageUI").then(ui=>scope.current()&&ui.insert({host:navHost,file,point,source,signal:scope.signal}))
      .catch(e=>{if(!scope.signal.aborted)info(e.message);}).finally(scope.close);
    return true;
  }
  const designClipboard=AtriumSelectionClipboard.install({capture:cut=>AtriumEditSelection.capture(doc(),defs,selectedIds,cut,project.blobs,project),
    store:storeSelection,local:()=>clipboard,attachment:file=>placeAttachment(file,pointer,"paste"),memberFiles:rows=>globalThis.__waffleCopyNativeDocuments(rows),
    place:clip=>beginPaste(clip),report:info,context:()=>doc(),revision:()=>revision});
  const shortcuts=AtriumEditorKeys.create(executeKey,text=>{
    if(text){shortcutStatus||=$("status")?.textContent||"Ready";info(text);}
    else if(shortcutStatus){info(shortcutStatus);shortcutStatus="";}
  },(event,command)=>!command.run&&designClipboard.nativeShortcut(event,command.action));
  let heldShortcuts=null;
  function clearShortcuts(){heldShortcuts=null;shortcuts.clear();}
  window.addEventListener("blur",()=>{space=false;clearShortcuts();});
  document.addEventListener("pointerdown",clearShortcuts,true);
  document.addEventListener("focusin",clearShortcuts);
  function keyState(e){
    return {kind:doc().kind,documentId:current,
      modal:!!(document.querySelector("dialog:modal, details.work-menu[open]")||e.target.closest?.("dialog[open]")),canvas:e.target===canvas,
      interactive:!["select","pan"].includes(tool),tool,selected:selectedIds.size>0,selectionCount:selectedIds.size,tuning:!!lengthSession,cursorAt:keyboardPoint,view3d:in3D(activePane),busRouting:!!routeSession?.bus,
      get rotatable(){return !!pending || drag?.kind==="text"&&!!drag.t.key || !!fieldSel&&!drag || movingObject?.item.kind==="part" || tool==="sch-place" || tool==="select"&&!drag&&selectedIds.size===1&&(active()?.kind==="part"||!!globalThis.AtriumSchObjects?.rotatable(active()));},
      canProperties:pcb() && (routing() || tool==="via") || !pcb() && (tool==="place"&&!!pending || tool==="sch-place" || tool==="label"),dragging:drag?.kind==="move"&&!!drag.before,sticky:!!drag?.sticky};
  }
  // Save the first real key strokes until the selected profile can resolve them.
  function holdShortcut(e,ready){
    const preset=AtriumKeymap.preset();
    if(!heldShortcuts||heldShortcuts.preset!==preset){
      const waiting=heldShortcuts={doc:doc(),pane:activePane,preset,target:e.target,focus:document.activeElement,events:[]};
      ready.then(loaded=>{
        if(heldShortcuts!==waiting)return;
        heldShortcuts=null;
        if(!loaded||waiting.focus!==document.activeElement||!waiting.target.isConnected)return;
        for(const event of waiting.events){
          if(waiting.doc!==doc()||waiting.pane!==activePane||waiting.preset!==AtriumKeymap.preset())break;
          // A lead shortcut can focus an input. Send the next stroke to the same target
          // it would have reached if the preset had already been loaded.
          const target=document.activeElement===waiting.focus?waiting.target:document.activeElement;
          target?.dispatchEvent(event);
        }
      });
    }
    heldShortcuts.events.push(new KeyboardEvent(e.type,e));
    e.preventDefault();
  }
  document.addEventListener("keyup",e=>{
    if(e.code!=="Space"&&e.key!==" ")return;
    space=false;
    if(heldShortcuts)heldShortcuts.events.push(new KeyboardEvent(e.type,e));
  });
  document.addEventListener("keydown",e=>{
    if(designClipboard.textShortcut(e)){shortcuts.clear();return;}
    const state=keyState(e),ready=AtriumKeymap.pendingPreset();
    if(ready){
      if(shortcuts.waitsForPreset(e,state))holdShortcut(e,ready);
      return;
    }
    keyEvent=e;try{
      if(!shortcuts.handle(e,state))designClipboard.preventUnboundShortcut(e);
    }finally{keyEvent=null;}
  });
  window.addEventListener("atrium-command",e=>{act(e.detail);syncChecks();});
  window.addEventListener("dragover",e=>e.preventDefault());
  window.addEventListener("drop",e=>{
    e.preventDefault();
    if(dialog.open)return;
    const files=Array.from(e.dataTransfer.files);
    const receiver=globalThis.AtriumDropEditor;
    const token=e.isTrusted && receiver && e.dataTransfer.getData(receiver.type);
    if (token && e.target===canvas) {
      const b=canvas.getBoundingClientRect(),hit=navHost.hit(canvas,e.clientX,e.clientY);
      const kind=doc().kind==="pcb" ? "board" : doc().kind==="schematic" ? "sheet" : doc().kind;
      const point=hit?.point || view.screenToWorld([e.clientX-b.left,e.clientY-b.top]);
      receiver.reference({token,isTrusted:e.isTrusted},navHost,{kind,point}).catch(error=>info(error.message));
      return;
    }
    const directories=Array.from(e.dataTransfer.items||[],item=>item.webkitGetAsEntry?.())
      .filter(entry=>entry?.isDirectory).map(entry=>entry.name);
    const fallback=()=>{
      if(e.target===canvas && files.length===1){const b=canvas.getBoundingClientRect();
        if(placeAttachment(files[0],view.screenToWorld([e.clientX-b.left,e.clientY-b.top])))return;}
      importFiles(files,{drop:true,directories});
    };
    if(e.isTrusted && files.length && !directories.length && globalThis.AtriumPrefs?.get("butter.drop")===true){
      const target={isTrusted:e.isTrusted,target:e.target,clientX:e.clientX,clientY:e.clientY,files};
      const source=doc(), stamp=revision, start=drop=>doc()===source&&revision===stamp
        ? drop.handle(target,navHost,()=>!notebookOff()) : true;
      (receiver ? Promise.resolve(start(receiver)) : AtriumLazy.need("AtriumDropEditor").then(start))
        .then(handled=>{if(!handled)fallback();}).catch(error=>info(error.message));
    }else fallback();
  });
  window.addEventListener("pagehide",()=>{if(dirty)persist();});
  matchMedia("(max-width:620px)").addEventListener?.("change",e=>{
    document.body.classList.toggle("hide-left",e.matches);document.body.classList.toggle("hide-right",e.matches);syncTools();draw();});
  const pcbEditContext={doc,defs:()=>defs,project:()=>project,pcb,view:()=>view,canvas:()=>canvas,stage:()=>activePane.stage,
    selection:()=>selectedIds,primary:()=>selected,selectionVersion:()=>selectionVersion,
    select:(ids,primary)=>{assignSelection(ids,primary);inspect();syncTools();draw();},selectable,pruneSelection:()=>{pruneSelection();syncTools();draw();},
    edit,field,info,draw,syncChecks,inspect:()=>inspect(),refreshDefs:()=>refreshDefs(true),unit,len:mm=>len(mm),parseLength:t=>U.parse(t,unit()),unitValue:mm=>U.value(mm,unit()),
    layers:()=>currentLayers(),hiddenLayers:()=>hidden,layerName:l=>AtriumPCBAppearance.name(l),revision:()=>revision,drag:()=>drag,hit:p=>view.hit(doc(),defs,p,lineOpts()),
    mode:()=>tool==="place"&&pending?"place":tool==="move-object"&&movingObject?"move-object":drag?.kind==="move"&&drag.before?"drag":"select",
    afterFlip:ids=>{const placed=doc().items.filter(i=>ids.includes(i.id)&&i.designator).map(i=>i.id);return placed.length&&globalThis.AtriumDesignators?AtriumDesignators.apply(doc(),AtriumDesignators.relayout(doc(),defs,placed,{project})):[];},
    onFlipBoard:f=>{const want=f?"Bottom":"Top";if(currentLayers().includes(want)&&!hidden.has(want))setActiveLayer(want);},
    zoomTo:ids=>{const s=new Set(ids),items=doc().items.filter(i=>s.has(i.id));if(items.length){glide(()=>view.fit({...doc(),outline:[],items},defs,"objects"));draw();}}};
  function installPCBEdit(){
    if(pcbEdit || !globalThis.AtriumPCBEdit)return;
    pcbEdit=AtriumPCBEdit.install(pcbEditContext);
    inspect();
  }
  // Navigation host for palette.js, crossprobe.js, drc-view.js, nets-panel.js and pcb-list.js.
  function paneInfo(p){
    const active=p===activePane;
    return {canvas:p.canvas,view:p.view,docId:active?current:p.docId,active,
      options:active?{hidden,layer,layerMode,transientGeometry:!!drag?.before}:{...p.state,transientGeometry:p.docId===current&&!!drag?.before}};
  }
  function paneOwner({view,docId,active}){
    return panes.find(p=>p.view===view&&(p===activePane)===active&&(active?current:p.docId)===docId);
  }
  // Show a document in the inactive split pane without activating it (cross-probe keeps focus).
  function showInOther(id){
    const p=otherPane();if(!p?.view||!docById(id))return false;
    if(p.docId!==id){
      globalThis.AtriumCamera?.stopWheel?.(p.view);
      if(p.state&&docById(p.docId))documentViews.set(p.docId,{view:p.view.camera(),...p.state});
      const saved=documentViews.get(id);p.docId=id;p.sig="";
      p.state=saved?{refScale:saved.refScale,hidden:new Set(saved.hidden),layer:saved.layer,layerMode:saved.layerMode}:{refScale:1,hidden:new Set(),layer:"Top",layerMode:"all"};
      if(saved)p.view.restoreCamera(saved.view);else{p.view.fit(docById(id),defs);p.state.refScale=p.view.scale()||1;}
      syncSplit();saveSplit();navEmit("panes");
    }
    p.version++;schedule();return true;
  }
  function prepareWorkbench(p=project,{starterView=starter}={}){
    const modules=["AtriumPCBEdit","AtriumDock","AtriumWireEdit","AtriumTabDrop","AtriumTooltip","AtriumSurfaceMotion","AtriumExtensions"];
    if(!starterView)modules.push("AtriumProjectTree");
    if(p.documents.some(d=>d.items.some(i=>i.kind==="part")))modules.push("AtriumSchFields");
    const install=()=>{installPCBEdit();installTabDrop();attachExtensions();};
    if(globalThis.AtriumLazy?.has(modules)){install();return Promise.resolve();}
    return AtriumLazy.need(modules).then(install);
  }
  const navHost={
    canvasGeometryRoots:()=>panes.map(renderedBoard).filter(Boolean),
    hasBoardArtwork:d=>d?.kind==="panel"||d?.kind==="pcb"&&!!(d.items?.length||d.outline?.length||d.boardShape||d.pcbDrawing?.pours?.length),
    boardGeometry(root=doc(),defaults){return globalThis.AtriumResolvedGeometry?.readEditor(project,root,defaults)??null;},
    async prepareBoardGeometry(root=doc(),defaults){
      if((root?.kind!=="pcb"&&root?.kind!=="panel")||!project.documents.includes(root))return null;
      const owner=project;
      const geometry=await AtriumLazy.need("AtriumResolvedGeometry");
      return geometry.prepareEditor(navHost,owner,root,defaults);
    },
    project:()=>project,doc,docById,documentRefs:()=>folder()?.documents()||project.documents,currentId:()=>current,defs:()=>defs,revision:()=>revision,
    authoredRevision:()=>authoredRevision,afterWorkspaceGesture,
    folderProject:folder,saveAll:o=>save({...o,all:true}),savedWritePending:()=>folderPending,
    requireProjectClosure:o=>folder()?.requireClosure(o)||Promise.resolve(project),
    selection:()=>[...selectedIds],fieldFocus,tool:()=>tool,units:unit,info,edit,act,executeKey,revealInspector,prepareWorkbench,
    // A transparent native window is occluded until its first frame is ready.
    async prepareLaunch(){
      await prepareWorkbench();
      revealInspector(true);
      if(!activeDirty&&!frame)return;
      if(frame)cancelAnimationFrame(frame);
      paintFrame(true);
    },
    palettePoint:()=>pointer||(activePane.palettePoint?.doc===doc()?activePane.palettePoint.xy:null),
    // DRC markers and Timing Vision: layer visibility, the selection filter and the live route or tuning session.
    hiddenLayers:()=>hidden,selectable:i=>selectable(i),liveRoute:()=>routeSession?{preview:routePreview,net:routeSession.state?.net??null}:null,
    liveTune:()=>lengthSession?{net:lengthSession.net,mode:lengthSession.mode,overlay:lengthSession.overlay?.()||null}:null,
    exportFile:(name,text)=>AtriumIO.exportFile(name,text),
    canvas:()=>canvas,view:()=>view,panes:()=>panes.filter(p=>p.view).map(paneInfo),
    ownsPane:owner=>!!paneOwner(owner),activatePane(owner){const p=paneOwner(owner);if(!p)return false;activatePane(p);return true;},repaintPane(owner){const p=paneOwner(owner);if(p)paneRepaint(p);},
    editInProgress:()=>!!drag||!!routeSession||chain.length>0,
    captureViewState(){
      if(in3D(activePane)||!canvas.clientWidth||!canvas.clientHeight)return null;
      return {documentId:current,camera:view.camera(),viewport:{pixelWidth:canvas.clientWidth,pixelHeight:canvas.clientHeight},
        ...(pcb()?{layers:{hidden:[...hidden],active:layer,mode:layerMode}}:{})};
    },
    applyViewState(state){
      if(state.documentId!==current||navHost.editInProgress()||in3D(activePane))return false;
      if(pcb()&&state.layers){
        hidden=new Set(state.layers.hidden);layer=state.layers.active;layerMode=state.layers.mode;
      }
      homeFit=openFit=null;refScale=state.camera.referenceScale;view.restoreCamera(state.camera);
      assignSelection(state.selection,state.selection[0]??null);setHighlight(state.netHighlight||"");
      selectComponent();syncTools();inspect();draw();return true;
    },
    captureWorkspaceSplit(){return splitState&&otherPane()?.docId?{direction:splitState.orientation,ratio:splitState.ratio,secondary:otherPane().docId}:null;},
    async applyWorkspaceSplit(active,split){
      if(!split){closeSplit(true);if(folder()?.localState.split)saveSplit();}
      await selectDocument(active);
      if(split)await openSplit(split.direction,split.secondary,{focus:false,ratio:split.ratio});
      refresh();
    },
    select(ids,primary=null,{afterMenu=false}={}){
      const owner=doc(),have=new Set(owner.items.map(i=>i.id));
      assignSelection(ids.filter(id=>have.has(id)),primary);selectComponent();inspect();syncTools();
      if(!afterMenu){draw();return;}
      // A warm menu is ready to paint. Submit the selection's canvas update on
      // the following frame, provided the same pane and selection still own it.
      const pane=activePane,selection=selectedIds;
      requestAnimationFrame(()=>{if(activePane===pane&&doc()===owner&&selectedIds===selection)draw();});
    },
    selectDocument:id=>selectDocument(id),showInOther,/* split-follow */openSplit:(o,id,f)=>openSplit(o||"right",id,{focus:false,...f}),
    // Start page and Preferences (prefs.js): the untouched starter project, and the PCB toggles Preferences owns.
    isStarter:()=>starter,setPref(k,v){if(k==="pcb.trackWidth"){if(!routeWidthSet&&v>0)routeWidth=+v;return true;}v=!!v;if(k==="schematic.hopOvers"){const d=doc();if(d?.kind==="schematic"&&!!d.hopOvers!==v)edit(()=>{if(v)d.hopOvers=true;else delete d.hopOvers;});return true;}if(k==="pcb.rerouteOnDrag")dragPrefs.enabled=v;else if(k==="pcb.smartGuides")smartGuides=v;else if(k==="pcb.designatorsFollow")designatorFollow=v;else if(k==="pcb.showRatsnest"){if(showUnrouted!==v){showUnrouted=v;inspect();draw();navEmit("unrouted");}}else if(k==="pcb.hud"){if(pcbEdit?.state&&!!pcbEdit.state.hud!==v)pcbEdit.act("hud");}else return false;syncTools();return true;},
    highlight:()=>highlight,highlightMembers:schematicHighlight,highlightSelected:()=>!!highlight&&highlightSelectionVersion===selectionVersion,setHighlight,clearHighlight:()=>clearHighlight(),
    // altium-keys.js: point picks, hit tests in world coordinates and the live router's presets.
    pickPoint:(t,o)=>pickPoint(t,o),hitAt:p=>view.hit(doc(),defs,p,lineOpts()),enclosed:b=>view.enclosed(doc(),defs,b,lineOpts()).filter(i=>selectable(i)),
    selectableItems:()=>doc().items.filter(i=>selectable(i)),beginStickyMove,drag:()=>drag,setLayer:v=>setActiveLayer(v),
    routeTool:()=>routeSession?{presets:()=>routeSession?.presets?.()||null,state:()=>routeSession?.state||{},
      setWidth(w){const r=routeSession?.setWidth?.(w);routeWidth=r||routeWidth;routeWidthSet=true;routePointer=null;draw();return r;},
      setVia(v){const r=routeSession?.setVia?.(v);routePointer=null;draw();return r;}}:null,
    showUnrouted:()=>showUnrouted,
    connections:()=>pcb()?view.boardConnectivity(doc(),defs):null,
    allowsHover:c=>tool==="select"&&!drag&&!space&&!in3D(panes.find(p=>p.canvas===c))&&!dialog.open,
    hit(c,x,y,all){
      const p=panes.find(q=>q.canvas===c);if(!p?.view)return null;
      const b=c.getBoundingClientRect(),pt=p.view.screenToWorld([x-b.left,y-b.top]),d=p===activePane?doc():docById(p.docId);if(!d)return null;
      const o=p===activePane?lineOpts():{hidden:p.state.hidden,layer:p.state.layer,layerMode:p.state.layerMode};
      // all: every object under the point, topmost first (touch taps cycle through them).
      if(all)return hitList(p.view,d,pt,o);
      return {doc:d,item:p.view.hit(d,defs,pt,o),point:pt,pane:paneInfo(p)};
    },
    zoomTo(box,options){if(!box||!globalThis.AtriumNavCommon)return;glide(()=>view.restoreCamera(AtriumNavCommon.cameraFor(box,canvas.clientWidth||800,canvas.clientHeight||600,view.camera(),options)));draw();},
    centerOn(p){glide(()=>view.restoreCamera({...view.camera(),cx:p[0],cy:p[1]}));pointer=p;keyboardPoint=true;showCoords(p);canvas.focus();draw();},
    messageContext:()=>({project,currentProject:()=>project,info,exportFile:AtriumIO.exportFile,
      select:id=>{const owner=project.documents.find(d=>d.items.some(i=>i.id===id));if(owner&&owner.id!==current)selectDocument(owner.id);choose(id,true);},
      locate:(id,point)=>{choose(id);const at=view.worldToScreen(point);glide(()=>view.pan(canvas.clientWidth/2-at[0],canvas.clientHeight/2-at[1]));canvas.focus();draw();}}),
    redraw,invalidate(){navVersion++;draw();},
    invalidateDocument(id,artwork=false){
      for(const p of panes)if((p===activePane?current:p.docId)===id){
        if(artwork)p.view?.invalidate?.(docById(id));
        paneRepaint(p);
      }
    },
    /* annotate: pointer-only overlay frame */redrawOverlay:()=>drawPointer(),
    // Derived data (live pours): change the document without an undo checkpoint and without
    // clearing redo; history keeps the copper that matched each snapshot. A clean project stays clean.
    derive(fn,{source,touched,persistDerived}={}){const was=dirty;fn();change({source,touched,persistDerived});if(!was)dirtyState(false);},
    stageEdit:editPipeline?.stage,
    on(t,f){if(!navListeners.has(t))navListeners.set(t,new Set());navListeners.get(t).add(f);return ()=>navListeners.get(t).delete(f);},
    routeSelectedNet(net){
      if(!pcb()||!net)return;
      const pair=globalThis.AtriumDiffPair?.find(doc(),net);
      setTool(pair?"route-diffpair":"route");routeFromNet=pair?[pair.positive,pair.negative]:[net];
      setHighlight(net);armRouter();canvas.focus();info("Choose a pad or track of "+routeFromNet.join(" or ")+".");
    },
    addRenderer(f){navRenderers.add(f);return ()=>navRenderers.delete(f);},routeSessionNow:()=>routeSession,startRoute(s){const p=pointer;resetTools();pointer=p;tool="route";routeSession=s;draw();},
    registerAction(id,f){navActions.set(id,f);},
    // integ-ui: the Properties panel's row helpers, so module sections look like the editor's.
    ui:{section:(p,t)=>section(p,t),row:(p,l,v)=>row(p,l,v),field:(...a)=>field(...a),disclosure:(...a)=>disclosure(...a),button:inspectorButton},
    // Autosave and recovery (autosave.js), recent projects (palette.js), board modules that load after first paint (lazy.js).
    // History panel (history-panel.js): the undo states, and jumps of n steps or to an alternate branch's state.
    undoSteps:()=>({history,future}),historyGo:(n,tree)=>undo(n>0,n,tree),
    fileSession:()=>fileSession,importSession,importSessionChanged,
    restoreImportSession:input=>fileUI().then(ui=>ui.restoreImported(input,navHost)),
    showImportReport(result,ids,names,options){const s=fileSession;return AtriumLazy.need("AtriumImportReports").then(r=>s===fileSession&&r.show(r.remember(s,result,ids,names,options)));},
    isDirty:()=>dirty,markUnsaved(){dirtyState(true);},openFiles:importFiles,openFilePicker,saveProject:save,
    moduleLoaded(name){const lazy=!!name;refreshDefs(!lazy);refresh(lazy,!lazy||name==="AtriumMultichannel");},
    async replaceProject(p,o={}){
      if(!o.force&&!await mayReplace()||o.current&&!o.current())return false;
      const old=project, stamp=authoredRevision, L=globalThis.AtriumLazy;
      const readers=L?.boardRenderers(p) || [];
      // The first schematic refresh can resolve the project's net scope synchronously.
      if(p.rules!=null&&!globalThis.AtriumDesignQueryRecord)readers.push("AtriumDesignQueryRecord");
      await Promise.all([readers.length && L?.need(readers),prepareWorkbench(p,{starterView:!!o.starter})]);
      if(project!==old || authoredRevision!==stamp || o.current&&!o.current())return false;
      if(drag)endDrag(true);if(!starter&&!o.workspaceMirror)checkpoint();
      const H=globalThis.AtriumHost;
      leaveFolder();
      if(o.copy||fileSession.imported||o.importFileSession)H?.clearProjectPath?.();
      if(o.copy)globalThis.AtriumAutosave?.detach?.(p);
      if(o.copy||folder()||fileSession.imported||o.importFileSession)setFileSession(o.importFileSession||{});
      starter=false;showProject(p,(o.workspaceMirror&&o.document)||(!o.starter&&A.preferredDocument(p,"pcb")?.id)||p.documents[0].id);
      if(o.starter)starter=true;if(o.dirty===false||o.starter)dirtyState(false);
      importSessionChanged();
      return true;
    },
    // Draw tools (pcb-draw.js): tool state, snapping, active layer, cursor and amend for repours.
    setTool,snapAt,netAt,
    // search: place a library part from the palette's search box (palette.js).
    placeDef(def,k=doc().kind){/* search placeDef */if(!def)return false;if(!A.geometries(def,k)){info("This component has no "+(k==="pcb"?"footprint":"symbol")+".");return false;}if(doc().kind!==k){const t=A.preferredDocument(project,k,current);if(!t){info("Add a "+(k==="pcb"?"board layout":"schematic sheet")+" first.");return false;}selectDocument(t.id);}beginPlace(defs.get(def.id)||def);return true;},
    // Paste Special / rubber stamp (paste-special.js): the clipboard and a ready paste plan on the cursor.
    clipboard:()=>clipboard,placePlan(plan){if(!plan)return;const at=pointer;resetTools();single(null);paste=plan;pointer=at;tool="paste";canvas.focus();syncTools();inspect();draw();},activeLayer:()=>layer,copperLayers:()=>currentLayers(),pointer:()=>pointer,amend
  };
  globalThis.AtriumNavHost=navHost;
  globalThis.__waffleCopyNativeDocuments=rows=>fileUI().then(ui=>importFiles(ui.nativeFiles(rows),{into:true})).catch(error=>{info(error.message);return false;});
  globalThis.__waffleFocusNativeMember=path=>AtriumLazy.need("AtriumNativeMemberUI").then(ui=>ui.focusMember(path,navHost)).catch(error=>{info(error.message);return false;});
  // git-status: a project opened from disk: merge conflicts and "what changed since I last opened" (git-picker.js, lazy).
  let gitOpen = 0;
  function detectGitProject(event){
    const host=globalThis.AtriumHost,grant=host?.folderGitGrant,request=++gitOpen;
    if(event.detail?.fromSave||!grant||!host.gitQuery){globalThis.AtriumGit?.reset();return;}
    const active=()=>request===gitOpen&&host===globalThis.AtriumHost&&grant===host.folderGitGrant;
    globalThis.AtriumIdle?.afterFrame(()=>AtriumIdle.idle(async()=>{
      if(!active()||!folder())return;
      try{const picker=await AtriumLazy.need("AtriumGitPicker");if(active())await picker.onProjectOpened(navHost);}
      catch{/* Git remains optional for an opened folder. */}
    }));
  }
  addEventListener("atrium-host-project",detectGitProject);
  addEventListener("atrium-git-binding",detectGitProject);
  // Layer Controls lost Ctrl+D to Duplicate (Altium): View › Layer Controls keeps it reachable.
  globalThis.AtriumNavCommon?.menuItem("view","layer-controls","Layer Controls",{after:"view-config",scope:"pcb"});
  globalThis.AtriumNavCommon?.hostReady(navHost);
  // The empty Home canvas can take its first fit from layout, before its first painted frame.
  if(starter&&!globalThis.__atriumOpeningProject&&globalThis.AtriumPref?.get("general.startPage","auto")!=="never")homeFit=doc();
  globalThis.AtriumLabs?.beforeChange?.(enabled=>{
    if(enabled)return;
    if(globalThis.AtriumReviewNotes?.hasPending?.() || globalThis.AtriumNotebookImageUI?.hasPending?.())return false;
    if(document.querySelector("dialog.math-editor[open],dialog.notebook-image-dialog[open],dialog.sw-editor[open],dialog.calculation-dialog[open]"))return false;
    const rich=globalThis.AtriumRichTextEditor;
    if(rich?.current?.() && rich.close(true)===false)return false;
    if(drag?.before)endDrag(false);
    return true;
  });
  globalThis.AtriumLabs?.onChange?.(enabled=>{
    if(!enabled){globalThis.AtriumReviewNotes?.close?.(false);if(paste?.items?.some(i=>notebookLocked(i)) || notebookLocked(movingObject?.item))setTool("select");}
    for(const pane of panes){
      pane.version++;
      const sheet=pane===activePane?doc():docById(pane.docId);
      if(sheet)pane.view?.invalidate?.(sheet);
    }
    navVersion++;inspect();draw();
  });
  refreshDefs();refresh();if(!homeFit)fit();bindCanvas(canvas);paneObserver.observe(canvas);restoreSplit();
  if(!homeFit&&!globalThis.__atriumOpeningProject)prepareWorkbench().then(()=>{inspect();syncTools();},e=>info(e.message));
  extensionHost=({
    project:()=>project,documentId:()=>current,defs:()=>defs,revision:()=>revision,selection:()=>[...selectedIds],
    select:ids=>{const have=new Set(doc().items.map(i=>i.id));assignSelection(ids.filter(id=>have.has(id)));inspect();syncTools();draw();},
    edit,amend,editInProgress:()=>!!drag,info,units:unit,activate:id=>selectDocument(id),
    locate:id=>{const owner=project.documents.find(d=>d.items.some(i=>i.id===id));if(owner&&owner.id!==current)selectDocument(owner.id);choose(id,true);},
    runAction:a=>executeKey(a),exportFile:AtriumIO.exportFile,pickFile:AtriumIO.pickFile
  });attachExtensions();
  // Installed extensions can declare startup activation or a command available on Home.
  // Built-in editor commands attach when the workbench is entered.
  let installedExtensions=false;
  try{installedExtensions=JSON.parse(localStorage.getItem("atrium.extensions.v1")||"[]").some(row=>row?.enabled!==false);}catch{}
  if(extensionHost&&installedExtensions)AtriumLazy.need("AtriumExtensions").then(attachExtensions,e=>info(e.message));
  globalThis.AtriumWorkbench?.onOpen?.(()=>syncChecks());
})();
