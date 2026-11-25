"use strict";
// Dragging a document tab onto the editor, as VS Code's editor drop zones: the third of the editor
// nearest an edge splits it there (left, right, top or bottom; while split, it moves the tab to that
// side's pane and turns the split), the middle shows it in that pane, and a pane's tab strip
// (split-tabs.js) takes it as a tab. Each dragover is arithmetic on rectangles measured once per drag;
// the preview follows in the next frame, and the drop's work runs after the native drag session ends.
// The workbench installs this before exposing interactive document tabs.
globalThis.AtriumTabDrop={install(E){
  const $=id=>document.getElementById(id),{panes,docById,activatePane,selectDocument,openSplit,showInOther,info,el}=E;

    const tabs=$("document-tabs"),host=$("editor-panes"),mime="application/x-atrium-document",paneMime="application/x-atrium-pane",viewMime="application/x-atrium-document-view";
    if(!tabs||!host)return;
    const drop=el("div",null,"split-drop");drop.setAttribute("aria-hidden","true");host.append(drop);
    const ours=e=>{const t=e.dataTransfer?.types;if(t)for(let i=0;i<t.length;i++)if(t[i]===mime||t[i]===viewMime)return true;return false;};
    tabs.addEventListener("dragstart",e=>{const t=e.target.closest?.("[data-tab]");if(!t||!e.dataTransfer)return;e.dataTransfer.setData(mime,t.dataset.tab);e.dataTransfer.effectAllowed="copyMove";});
    let rects=null,zone=null,shown="",paint=0,dragged=null;
    const ST=()=>globalThis.AtriumSpatialMotion;
    document.addEventListener("dragstart",e=>{dragged=e.target.closest?.("[data-tab]")?.dataset.tab||null;},true);
    // Split, the panes fill the editor area (its tab bar gives way to theirs), less the layer bar while a board is active.
    function measure(){
      const area=$("editor-area")||host,a=area.getBoundingClientRect(),layer=docById(dragged)?.kind==="pcb"?parseFloat(getComputedStyle(area).getPropertyValue("--chrome-layer-height"))||0:0;
      return {host:host.getBoundingClientRect(),frame:{left:a.left,top:a.top,width:a.width,height:a.height-layer},panes:panes.map(p=>p.stage.getBoundingClientRect())};
    }
    function zoneAt(x,y,strip){
      const r=rects||(rects=measure()),b=r.host,split=!!panes[1];
      if(!b.width||!b.height||x<b.left||y<b.top||x>=b.right||y>=b.bottom)return null;
      let side="center",near=split?.2:1/3;
      if(!strip)for(const [s,f] of [["left",(x-b.left)/b.width],["right",(b.right-x)/b.width],["top",(y-b.top)/b.height],["bottom",(b.bottom-y)/b.height]])if(f<near){near=f;side=s;}
      if(side==="center"){
        const k=Math.max(0,r.panes.findIndex(q=>x>=q.left&&x<q.right&&y>=q.top&&y<q.bottom)),q=r.panes[k]||b;
        return {side,k,rect:{left:q.left,top:q.top,width:q.width,height:q.height}};
      }
      // The pane the document fills: the sash takes 2 px and the first pane round((size - 2) * ratio).
      const f=r.frame,down=side==="top"||side==="bottom",k=side==="left"||side==="top"?0:1,size=down?f.height:f.width;
      const first=Math.round((size-2)*(split?E.splitState().ratio:.5)),at=k?first+2:0,len=k?size-first-2:first;
      return {side,k,rect:down?{left:f.left,top:f.top+at,width:f.width,height:len}:{left:f.left+at,top:f.top,width:len,height:f.height}};
    }
    const keyOf=z=>z?z.side+z.k+":"+z.rect.left+","+z.rect.top+","+z.rect.width+","+z.rect.height:"";
    function show(){
      paint=0;const z=zone,key=keyOf(z);if(key===shown)return;shown=key;
      // While split, the middle of a pane is split-tabs' drop (it highlights the pane itself).
      const mine=!!z&&!(panes[1]&&z.side==="center");
      if(mine){const r=z.rect;Object.assign(drop.style,{left:r.left+"px",top:r.top+"px",width:r.width+"px",height:r.height+"px"});for(const p of panes)ST()?.target(p.stage,false);}
      drop.classList.toggle("is-drop",mine);drop.dataset.zone=z?z.side:"";
    }
    const want=z=>{if(keyOf(z)===keyOf(zone))return;zone=z;if(!paint)paint=requestAnimationFrame(show);};
    function forget(){rects=null;want(null);}
    document.addEventListener("dragend",()=>{dragged=null;});
    host.addEventListener("dragover",e=>{
      if(!ours(e))return;e.preventDefault();
      const z=zoneAt(e.clientX,e.clientY,!!(panes[1]&&e.target.closest?.(".pane-tabs")));
      if(!panes[1]||z&&z.side!=="center")e.stopPropagation();
      want(z);
    },true);
    host.addEventListener("dragleave",e=>{if(!ours(e))return;const b=rects?.host;if(!b||e.clientX<b.left||e.clientY<b.top||e.clientX>=b.right||e.clientY>=b.bottom)forget();});
    document.addEventListener("dragend",forget,true);
    async function dropView(id,z){
      const views=globalThis.AtriumDocViews;
      if(!views?.isOpen(id))return;
      if(z.side!=="center"){
        const orientation=z.side==="top"||z.side==="bottom"?"down":"right";
        await openSplit(orientation,panes[1]?null:E.current(),{focus:false});
      }
      views.move(id,z.k);
    }
    function dropTab(id,z,from){
      if(!docById(id))return;
      const T=globalThis.AtriumSplitTabs,name=docById(id).name;
      if(z.side==="center"){
        if(panes[1]&&T)T.moveTab(from,z.k,id);else{activatePane(panes[z.k]||E.activePane());selectDocument(id);E.canvas().focus();}
        return;
      }
      const orientation=z.side==="top"||z.side==="bottom"?"down":"right";
      if(panes[1]){
        const at=p=>p===E.activePane()?E.current():p.docId,src=from??panes.findIndex(p=>at(p)===id),there=at(panes[z.k]);
        openSplit(orientation);
        if(src>=0&&src!==z.k&&at(panes[src])===id&&(!T||T.groups?.[src]?.length<=1)){
          // A pane's only document goes to the far side: the panes trade places instead of one closing.
          T?.swap();activatePane(panes[z.k]);showInOther(there);selectDocument(id);
        }else if(T)T.moveTab(from,z.k,id);else{activatePane(panes[z.k]);selectDocument(id);}
        E.canvas().focus();info("Moved "+name+" to the "+z.side+" pane");return;
      }
      if(z.k)return openSplit(orientation,id);
      // Left or top: the dragged document takes the first pane, and the one shown moves to the second.
      const keep=E.current();
      return Promise.resolve(openSplit(orientation,keep,{focus:false})).then(()=>{if(!panes[1])return;activatePane(panes[0]);return selectDocument(id);})
        .then(()=>{E.canvas().focus();info("Split "+z.side+" · "+name);},e=>info(e.message));
    }
    host.addEventListener("drop",e=>{
      if(!ours(e))return;
      const z=zoneAt(e.clientX,e.clientY,!!(panes[1]&&e.target.closest?.(".pane-tabs")));forget();
      if(panes[1]&&z?.side==="center"&&panes[z.k]?.stage.dataset.tabDrop)return; // split-tabs moves it into that pane
      e.preventDefault();e.stopPropagation();
      const id=e.dataTransfer.getData(mime),raw=e.dataTransfer.getData(paneMime),from=raw===""?null:+raw;
      const view=e.dataTransfer.getData(viewMime);
      if(z&&view)setTimeout(()=>dropView(view,z).catch(e=>info(e.message)),0);
      else if(z&&docById(id))setTimeout(()=>dropTab(id,z,from),0);
    },true);
}};
