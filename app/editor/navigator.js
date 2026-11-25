"use strict";
globalThis.AtriumNavigator = (() => {
  const rowHeight=29, gap=2, pitch=rowHeight+gap, limit=96, overscan=6;
  const collator=new Intl.Collator(undefined,{numeric:true});
  let instance=0;
  function create(list,onPick) {
    const optionId="atrium-nav-"+(++instance)+"-";
    const scroller=list.closest(".pane-scroll"), doc=list.ownerDocument;
    const nodes=new Map(), positions=new Map(), previousScroll=new Map();
    let parts=[], definitions=null, source=null, sourceItems=null, sourceLength=0, sourceRevision;
    let sourceComponents=null, sourceLibrary;
    let selected=null,cursor=0,windowed=false,first=-1,last=-1,frame=0,keyboardFocus=false;
    list.classList.add("ui-list"); list.dataset.layout="flush";
    list.setAttribute("role","listbox");
    list.setAttribute("aria-label","Components");

    const setSelected=(node,on)=>node?.setAttribute("aria-selected",String(on));
    function selectedRow(id) {
      if(id===selected)return;
      setSelected(nodes.get(selected),false);
      selected=id;
      setSelected(nodes.get(id),true);
      if(positions.has(id))cursor=positions.get(id);
      updateActive();
    }
    let focusedNode=null;
    function updateActive() {
      if(focusedNode){focusedNode.style.outline="";focusedNode=null;}
      const node=nodes.get(parts[cursor]?.id);
      if(!node){list.removeAttribute("aria-activedescendant");return;}
      list.setAttribute("aria-activedescendant",node.id);
      if(keyboardFocus){node.style.outline="1px solid currentColor";node.style.outlineOffset="-2px";focusedNode=node;}
    }
    function setRow(item,index) {
      let n=nodes.get(item.id);
      if(!n) {
        n=doc.createElement("button"); n.type="button";n.className="ui-row part-row";n.tabIndex=-1;
        n.dataset.part=item.id;n.setAttribute("role","option");
        const value=doc.createElement("span");value.className="ui-row-subtitle";
        n.append(doc.createElement("strong"),value);
        n.onclick=()=>onPick(item.id,true);
        nodes.set(item.id,n);
      }
      n.id=optionId+index;
      n.setAttribute("aria-posinset",String(index+1));
      n.setAttribute("aria-setsize",String(parts.length));
      const value=item.value || definitions?.get(item.def)?.name || "";
      if(n.firstElementChild.textContent!==item.ref)n.firstElementChild.textContent=item.ref;
      if(n.lastElementChild.textContent!==value)n.lastElementChild.textContent=value;
      setSelected(n,item.id===selected);
      n.style.position=windowed?"absolute":"";
      n.style.top=windowed?index*pitch+"px":"";
      n.style.left=windowed?"0":"";
      n.style.height=windowed?rowHeight+"px":"";
      n.style.whiteSpace="nowrap";
      return n;
    }
    function viewport() {
      const top=scroller.getBoundingClientRect().top-list.getBoundingClientRect().top;
      return {top,height:scroller.clientHeight||scroller.getBoundingClientRect().height||480};
    }
    function paint(force=false) {
      if(!parts.length)return;
      const {top,height}=viewport();
      const start=windowed?Math.min(parts.length-1,Math.max(0,Math.floor(top/pitch)-overscan)):0;
      const end=windowed?Math.min(parts.length,start+limit,Math.max(start+1,Math.ceil((top+height)/pitch)+overscan)):parts.length;
      if(!force&&first===start&&last===end)return;
      first=start;last=end;
      for(const [id,node] of nodes){
        const index=positions.get(id);
        if(index==null||index<start||index>=end){node.remove();nodes.delete(id);}
      }
      let next=null;
      for(let i=end-1;i>=start;i--){
        const node=setRow(parts[i],i);
        if(node.parentNode!==list || node.nextElementSibling!==next)list.insertBefore(node,next);
        next=node;
      }
      updateActive();
    }
    function schedule() {
      if(!windowed||frame)return;
      frame=requestAnimationFrame(()=>{frame=0;paint();});
    }
    scroller.addEventListener("scroll",schedule,{passive:true});
    if(typeof ResizeObserver!=="undefined")new ResizeObserver(schedule).observe(scroller);
    function reveal(index) {
      if(!windowed){nodes.get(parts[index]?.id)?.scrollIntoView?.({block:"nearest"});return;}
      const {top,height}=viewport(),y=index*pitch;
      if(y<top)scroller.scrollTop+=y-top;
      else if(y+rowHeight>top+height)scroller.scrollTop+=y+rowHeight-top-height;
      paint();
    }
    function keyboard(e) {
      if(!parts.length)return;
      const page=Math.max(1,Math.floor(viewport().height/pitch)-1);
      const destinations={ArrowDown:cursor+1,ArrowUp:cursor-1,Home:0,End:parts.length-1,PageDown:cursor+page,PageUp:cursor-page};
      if(e.key==="Enter"||e.key===" "){
        e.preventDefault();e.stopPropagation();onPick(parts[cursor].id,true);return;
      }
      if(!Object.hasOwn(destinations,e.key))return;
      e.preventDefault();e.stopPropagation();
      cursor=Math.max(0,Math.min(parts.length-1,destinations[e.key]));
      reveal(cursor);updateActive();onPick(parts[cursor].id,false);
    }
    list.addEventListener("keydown",keyboard);
    list.addEventListener("focus",()=>{
      keyboardFocus=true;
      if(parts.length){
        if(!nodes.has(parts[cursor]?.id))cursor=Math.max(0,Math.min(parts.length-1,Math.ceil(viewport().top/pitch)));
        updateActive();
      }
    });
    list.addEventListener("blur",()=>{keyboardFocus=false;updateActive();});
    // rev: the host's edit revision (the editor keeps one defs map across item edits).
    function refresh(board,defs,id,rev,projection) {
      const components=projection?.components??null,library=projection?.version.library;
      const unchanged=components ? sourceComponents===components && sourceLibrary===library : !sourceComponents && sourceRevision===rev;
      if(source===board && definitions===defs && sourceItems===board.items && unchanged && (components || sourceLength===board.items.length)){
        selectedRow(id);return parts.length;
      }
      const switched=source?.id!==board.id,remembered=previousScroll.get(board.id)||0;
      if(source && switched)previousScroll.set(source.id,scroller.scrollTop);
      source=board;sourceItems=board.items;sourceLength=board.items.length;definitions=defs;sourceRevision=rev;
      sourceComponents=components;sourceLibrary=library;
      parts=(components?.slice()??board.items.filter(i=>i.kind==="part")).sort((a,b)=>collator.compare(a.ref,b.ref));
      positions.clear();parts.forEach((i,index)=>positions.set(i.id,index));
      selected=id;cursor=positions.get(id)??(switched?0:Math.min(cursor,Math.max(0,parts.length-1)));
      windowed=parts.length>limit;
      list.tabIndex=parts.length?0:-1;
      list.style.position=windowed?"relative":"";
      list.style.display=windowed?"block":"";
      list.style.height=windowed?(parts.length*pitch-gap)+"px":"";
      if(switched)scroller.scrollTop=remembered;
      if(!parts.length){
        nodes.clear();list.replaceChildren();
        const empty=doc.createElement("p");empty.className="side-note";empty.textContent="No components placed";
        list.append(empty);updateActive();
      }else{
        list.querySelector(".side-note")?.remove();
        paint(true);
      }
      return parts.length;
    }
    return {refresh,select:selectedRow};
  }
  return {create};
})();
