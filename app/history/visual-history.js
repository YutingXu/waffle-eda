"use strict";
// One session/Git time control. UI reads are scoped to the current file, row and document.
globalThis.AtriumVisualHistory = (() => {
  const G=globalThis,U=()=>G.AtriumUndoStore,A=()=>G.AtriumHistoryArtwork,K=()=>G.AtriumUIKit,HEIGHT=48;
  const el=(tag,cls,text)=>AtriumNavCommon.classedElement(document, tag, cls, text);
  function button(name,fn,variant){const b=el("button","hist-btn ui-button",name);b.type="button";b.dataset.size="sm";if(variant)b.dataset.variant=variant;b.onclick=e=>{e.stopPropagation();fn();};return b;}
  function affected(info,docId,changes=info.changes) {
    const result={before:[],after:[]};
    for(const change of changes||[]) if(change.doc?.id===docId && change.path==="items"){
      for(const item of change.removed)result.before.push(item);
      for(const item of change.added)result.after.push(item);
      for(const [before,after] of change.modified){result.before.push(before);result.after.push(after);}
    }
    return result;
  }
  function defsAt(host,mark){
    const library=U().libraryAt(mark);
    return library===host.project().library?host.defs():new Map((library||[]).map(d=>[d.id,d]));
  }
  function pair(host,info,canvases,previous,current){
    const did=info.docs.find(d=>d.id===host.currentId())?.id||info.docs[0]?.id;
    const doc=host.docById(did), changes=info.changes;
    if (!doc || !changes?.some(c=>c.path==="items")) {
      const change=changes?.[0];if(!change)return;
      if(change.path==="library" && (change.modified?.length||change.removed?.length||change.added?.length)){
        const pair=change.modified?.[0]||[change.removed?.[0],change.added?.[0]];
        for(const [i,def] of pair.entries()){
          if(def){G.AtriumCanvas.preview(canvases[i],def,host.doc().kind);canvases[i].dataset.ready="true";}
          else canvases[i].replaceWith(el("span","hist-property","Absent"));
        }
        return;
      }
      for(const [i,mark] of [previous,current].entries()) {
        const state=U().viewState(mark), owner=did?state?.doc(did):state?.project();
        const target=canvases[i];
        if((change.docAdded||change.docRemoved)&&owner?.items?.length) {
          A().copy(target,A().render(owner,defsAt(host,mark),{w:58,h:34}));continue;
        }
        let value=owner;
        for(const key of [...(change.path?change.path.split("."):[]),...(change.keys?.slice(0,1)||[])])value=value?.[key];
        const text=Array.isArray(value)?String(value.length):value && typeof value==="object"?value.name||"Present":value==null?"Absent":String(value);
        const badge=el("span","hist-property",text);badge.title=text;target.replaceWith(badge);
      }
      return;
    }
    const layers=affected(info,did,changes),sides=["before","after"],definitions=[previous,current].map(mark=>defsAt(host,mark)),boxes=[];
    for(const [i,side] of sides.entries())for(const item of layers[side]){
      const box=G.AtriumNavCommon.itemBox(doc,definitions[i],item);if(box)boxes.push(box);
    }
    if(!boxes.length)return;
    const bounds=boxes.reduce((a,b)=>[Math.min(a[0],b[0]),Math.min(a[1],b[1]),Math.max(a[2],b[2]),Math.max(a[3],b[3])]);
    for(const [i,side] of sides.entries()){
      const sample={kind:doc.kind,id:doc.id,name:doc.name,items:layers[side],outline:[],grid:doc.grid};
      if(doc.kind==="schematic")sample.schDrawing={width:200,height:200,border:false,zones:false,showGrid:false,frame:[]};
      A().copy(canvases[i],A().render(sample,definitions[i],{w:58,h:34},bounds));
    }
  }
  function mount(host,ui,api){
    // One time control (the documents family's pager beside the slider), one preview, one list of steps.
    const list=ui.list, panel=list.parentNode, scrub=el("div","hist-scrub");
    list.classList.add("ui-list"); list.setAttribute("role", "listbox");
    const slider=el("input");slider.type="range";slider.min="0";slider.setAttribute("aria-label","Session and Git history");
    const pager=K().pager({unit:"step",label:"Step through history",onStep:d=>stepBy(d)});
    const place=el("output","hist-position ui-status-line","Current design");const older=button("Older commits",()=>loadGit(true),"quiet");older.hidden=true;
    const gitStatus = K().el("div");
    scrub.append(pager,slider,older,place);
    list.before(gitStatus);
    const pane=el("section","hist-preview"), title=el("strong"), documents=el("select","ui-field");
    documents.setAttribute("aria-label","Preview document");
    const dismiss=K().closeButton(()=>clear(),"Close preview");dismiss.classList.add("hist-preview-close");
    const canvas=el("canvas","hist-design-preview"), art=el("div","ui-thumb hist-art"), artBox=el("span","ui-thumb-art");
    artBox.append(canvas);art.append(artBox);
    const caption=el("p","hist-caption ui-status-line");
    const actions=el("div","hist-controls");
    const compare=button("Compare with now",()=>compareNow(),"quiet"),restore=button("Restore",()=>apply(false),"primary"),
      fork=button("Fork here",()=>chosen?.commit?branchDialog():apply(true),"quiet");
    compare.title="Compare this state with the current design";
    actions.append(compare,fork,restore);pane.append(title,documents,dismiss,art,caption,actions);pane.hidden=true;
    panel.insertBefore(scrub,list);panel.insertBefore(pane,list);
    const rail=el("div","hist-rail");list.replaceChildren(rail);
    const rows=new Map();
    let revealCurrent=false,state,chosen,shown=false,source,gitLoading=false,gitDone=false,commits=[],binding,snapshot;
    let epoch=0,paintFrame=0,previewFrame=0,worker=null,watch=null,session=null,project=null;
    const liveBinding=()=>G.AtriumHost?.historyPath||G.AtriumHost?.folderGitGrant||G.AtriumHost?.projectPath||null;
    let savedBinding;
    const onBinding=event=>{if(event.detail?.fromSave)savedBinding=liveBinding();};
    G.addEventListener("atrium-git-binding",onBinding);
    const visible=()=>shown&&!panel.hidden&&!list.hidden&&!document.hidden&&G.AtriumPower?.visible?.()!==false;
    function cancelPreview(){epoch++;worker?.abort();worker=null;if(previewFrame)cancelAnimationFrame(previewFrame);previewFrame=0;}
    function clear(){cancelPreview();chosen=null;pane.hidden=true;place.textContent="Current design";paintSelection();if(state)slider.value=String(commits.length+state.at);syncPager();}
    function syncPager(){pager.set(Number(slider.value),Number(slider.max)+1);}
    function stepBy(d){if(slider.disabled)return;const max=Number(slider.max),v=Number(slider.value);
      const to=d===-Infinity?0:d===Infinity?max:Math.max(0,Math.min(max,v+d));if(to===v&&chosen)return;slider.value=String(to);selectIndex(to);syncPager();}
    function paintSelection(){
      for(const r of rows.values())r.node.setAttribute("aria-selected",String(chosen?.state?.id===r.t.id));
    }
    function compareNow(){
      if(!chosen?.preview)return;
      const held=chosen,active=()=>held===chosen&&project===host.project()&&binding===liveBinding();
      return G.AtriumLazy.need("AtriumGitPicker").then(async()=>{
        if(!active())return;
        const git=G.AtriumGit;
        const a=held.commit?{project:held.preview,label:held.label}:await git.readSpec(
          {type:"undo",mark:held.readState||held.state,reviewed:held.state.live,label:held.label},host,undefined,active);
        const b=await git.readSpec({type:"working"},host,undefined,active);
        if(active())return git.compare(a,b,{active});
      }).catch(e=>{if(active())host.info(e.message);});
    }
    const sameFile=s=>!s?.fileSession || s.fileSession===host.fileSession?.();
    function apply(keepLine){
      if(!chosen?.plan||chosen.commit||chosen.origin!==host.project()||session!==host.fileSession?.()||!sameFile(chosen.state))return;
      const selected=chosen;
      const r=G.AtriumHistoryEdits.reviewedRestore(host,U(),{keep:!!keepLine,markFirst:true,project:host.project(),mark:{fileSession:session,current:host.currentId()},baseline:selected.baseline,read:selected.readState,plan:selected.plan,label:(keepLine?"Fork from ":"Restore ")+selected.label,anchor:selected.state});
      if(r.failed){host.info(r.failed.message);return;}
      if(r.cancelled){host.info("This history line changed. Select the step again to review it.");clear();return;}
      const message=r.applied?(keepLine?"Forked":"Restored")+" “"+selected.label+"”":"No remaining fields to restore";
      if(r.applied)clear();host.info(message+(r.preserved?" · "+r.preserved+" newer or peer changes kept":""));
    }
    function branchDialog(){
      if(!chosen?.commit||!source)return;
      const selection=chosen,owner=source,dialog=el("dialog","work-dialog"),heading=el("h2",null,"Create Git branch");
      const field=el("input","ui-field");field.placeholder="Branch name";field.setAttribute("aria-label","Branch name");field.autocomplete="off";
      const note=el("p",null,"Create a local branch at "+selection.commit.revision.slice(0,8)+". Your current checkout stays open.");
      const error=el("p");error.setAttribute("role","status");
      const ok=button("Create branch",async()=>{
        if(!field.value.trim()||selection!==chosen||owner!==source||!owner.current())return;
        ok.disabled=true;
        try{const r=await owner.query("createBranch",{name:field.value.trim(),revision:selection.commit.revision,confirm:true});host.info("Created branch "+r.branch);dialog.close();gitDone=false;loadGit();}
        catch(e){error.textContent=e.message;ok.disabled=false;}
      });
      const footer=el("div");
      ok.dataset.variant="primary";
      footer.append(button("Cancel",()=>dialog.close()),ok);
      dialog.append(heading,note,field,error,footer);
      G.AtriumUI.adoptDialog(dialog,{title:heading,body:[note],actions:footer});
      dialog.onclose=()=>dialog.remove();document.body.append(dialog);dialog.showModal();field.focus();
    }
    function display(model){
      if(!chosen)return;
      const docs=model.documents||[],wanted=chosen.docId||host.currentId(), d=docs.find(x=>x.id===wanted)||docs[0];
      documents.replaceChildren(...docs.map(doc=>{const opt=el("option",null,doc.name||doc.kind);opt.value=doc.id;return opt;}));
      documents.hidden=docs.length<2;
      if(d){
        chosen.docId=d.id;documents.value=d.id;
        const defs=model.library===host.project().library?host.defs():new Map((model.library||[]).map(def=>[def.id,def]));
        canvas.dataset.kind=d.kind;
        A().copy(canvas,A().render(d,defs,{w:canvas.clientWidth||300,h:canvas.clientHeight||120}));
      }
      if(d){
        const count=d.items?.length||0,kind=d.kind==="pcb"?"PCB":d.kind==="schematic"?"Schematic":d.kind;
        caption.textContent=(docs.length>1?kind:d.name||kind)+" · "+count+" "+(count===1?"object":"objects");
      }else caption.textContent="This version contains no document.";
    }
    function redrawSelected(){
      if(!chosen?.preview)return;
      const model=chosen.commit?chosen.preview:U().viewState(chosen.readState||chosen.state)?.project();
      if(model)display(model);else caption.textContent="This undo state has expired.";
    }
    documents.onchange=()=>{if(chosen){chosen.docId=documents.value;redrawSelected();}};
    function request(entry){
      cancelPreview();
      const ticket=epoch;chosen=entry;pane.hidden=false;canvas.width=canvas.height=1;delete canvas.dataset.ready;
      if(!entry.commit){entry.baseline ||= U().reviewMark(host.project());entry.readState ||= entry.state.live ? entry.baseline : entry.state;}
      title.textContent=place.textContent=entry.label;syncPager();documents.replaceChildren();documents.hidden=true;
      caption.textContent="Reading preview…";compare.disabled=restore.disabled=fork.disabled=true;
      restore.hidden=!!entry.commit;fork.textContent=entry.commit?"Create Git branch…":"Fork here";paintSelection();
      previewFrame=requestAnimationFrame(async()=>{
        previewFrame=0;if(!visible()||ticket!==epoch)return;
        const owner=entry.origin=host.project();
        try{
          let model;
          if(entry.commit){
            const controller=worker=new AbortController(),side=await source.project(entry.commit.revision,controller.signal);
            if(ticket!==epoch||!visible())return;model=side.project;fork.disabled=!!G.AtriumHost?.historyPath;fork.title=fork.disabled?"Imported source history is read-only.":"";
          }else {
            const v=U().viewState(entry.readState);if(!v)throw Error("This undo state has expired.");
            const baseline=U().viewState(entry.baseline);if(!baseline||!U().sinceReview(entry.baseline))throw Error("This preview has expired.");
            model=v.project();entry.plan=G.AtriumHistoryEdits.plan(baseline.project(),model,v.peers);
            restore.disabled=!sameFile(entry.state)||!entry.plan.ops.length;
            fork.disabled=restore.disabled;
          }
          if(ticket!==epoch||owner!==host.project()||!visible())return;
          entry.preview=model;compare.disabled=!model;
          if(model) display(model);
          else caption.textContent="The design was absent at this commit.";
        }catch(e){if(ticket===epoch)caption.textContent=e.message;}
      });
    }
    function pick(i,again=false){
      if(!state)return;
      slider.value=String(commits.length+i);
      const t=api.tree(state,i),info=api.stepLabel(state,i);
      if(!t)return;
      if(again&&chosen?.state?.id===t.id&&chosen.plan){apply(false);return;}
      request({state:t,label:info.label,docId:info.docs?.[0]?.id});
    }
    function selectIndex(i){if(i<commits.length){const c=commits[i];request({commit:c,label:(c.subject||"Commit")+" · "+c.revision.slice(0,7)});}
      else pick(i-commits.length);}
    slider.oninput=()=>{selectIndex(Number(slider.value));syncPager();};
    function drawRows(){
      paintFrame=0;if(!visible()||!state)return;
      if(revealCurrent && list.clientHeight){
        list.scrollTop=Math.max(0,(state.at+1)*HEIGHT-list.clientHeight);revealCurrent=false;
      }
      const first=Math.max(0,Math.floor(list.scrollTop/HEIGHT)),end=Math.min(state.list.length,Math.ceil((list.scrollTop+list.clientHeight)/HEIGHT));
      for(const [i,r] of rows)if(i<first||i>=end||r.t.id!==api.tree(state,i)?.id||r.prev!==api.tree(state,i-1)?.id){
        watch?.forget(r.thumb);r.node.remove();rows.delete(i);
      }
      for(let i=first;i<end;i++){
        const t=api.tree(state,i);if(!t)continue;
        if(rows.has(i)){
          const row=rows.get(i);row.node.classList.toggle("is-current",i===state.at);row.node.classList.toggle("is-future",i>state.at);
          row.status.textContent=i===state.at?"Current":i>state.at?"Undone":"";continue;
        }
        const info=api.stepLabel(state,i),r=el("div","hist-row");r.id="hist-opt-"+i;r.dataset.index=String(i);
        r.setAttribute("role","option");r.setAttribute("aria-selected",String(chosen?.state?.id===t.id));
        r.classList.toggle("is-current",i===state.at);r.classList.toggle("is-future",i>state.at);r.style.top=i*HEIGHT+"px";
        const kind=info.rows?.some(c=>c.added?.length)?"plus":info.rows?.some(c=>c.removed?.length)?"minus":i?"select":"project";
        const icon=K().icon(kind);icon.classList.add("ui-row-icon","hist-edit-icon");
        r.classList.add("ui-row");
        const words=el("span","ui-dock-text ui-row-text"),name=el("span","hist-label ui-row-title",info.label),meta=el("span","hist-meta ui-row-detail",
          info.docs?.map(d=>d.name||d.kind).join(", ")||"");
        const status=el("span","hist-state-label",i===state.at?"Current":i>state.at?"Undone":"");meta.append(status);
        words.append(name,meta);
        // Before → after, as two small tiles of the touched region (rendered only while in view).
        const thumb=el("span","hist-thumbs ui-row-meta"), canvases=["Before","After"].map((label,k)=>{
          const box=el("span","ui-thumb hist-mini"),frame=el("span","ui-thumb-art"),pic=el("canvas");pic.width=pic.height=1;pic.setAttribute("aria-hidden","true");
          box.title=label;frame.append(pic);box.append(frame);if(k){const arrow=el("span","hist-arrow","→");arrow.setAttribute("aria-hidden","true");thumb.append(arrow);}thumb.append(box);return pic;});
        thumb.setAttribute("aria-label","Before and after");
        const forkAt=U().branches().some(b=>b.fork.pos===t.pos&&t.pos!=null);
        if(forkAt)meta.append(el("span","hist-fork-label"," · Fork"));
        r.append(icon,words,thumb);r.onclick=()=>pick(i,true);
        r.onpointerenter=e=>{if(e.pointerType==="mouse")api.preview(i);};
        rail.append(r);rows.set(i,{node:r,t,status,prev:api.tree(state,i-1)?.id,thumb});
        if(info.rows?.length)watch?.add(thumb,()=>pair(host,info,canvases,api.tree(state,i-1),t));else thumb.hidden=true;
      }
    }
    function schedule(){if(visible()&&!paintFrame)paintFrame=requestAnimationFrame(drawRows);}
    async function loadGit(append=false){
      if(!binding||savedBinding===binding||(!append&&gitDone)||gitLoading||!visible())return;
      gitLoading=true;older.disabled=true;gitStatus.replaceChildren();const bound=binding;
      try{await G.AtriumLazy.need(["AtriumGitPicker", "AtriumProjectHistoryData"]);if(!visible()||savedBinding===bound||bound!==liveBinding())return;
        source ||= G.AtriumProjectHistoryData.source(G.AtriumGit);
        const data=await source.query("projectLog",{limit:500,skip:append?commits.length:0,...(append?{snapshot}:{})});
        if(!source?.current()||bound!==binding)return;
        const batch=data.commits.slice().reverse();
        commits=append?batch.concat(commits):batch;snapshot=data.snapshot;
        if(append)slider.value=String(Number(slider.value)+batch.length);
        gitDone=true;older.hidden=!data.more;range();
      }catch(e){if(bound===binding){
        gitDone=true;
        const retry=K().button("Try again",{size:"sm",run:()=>{gitDone=false;loadGit(append);}});
        gitStatus.replaceChildren(K().notice({tone:"danger",title:"Git history unavailable.",text:e.message,live:true,actions:[retry]}));
      }}
      finally{gitLoading=false;older.disabled=false;if(binding!==bound&&visible())loadGit();}
    }
    function range(){if(!state)return;slider.max=String(Math.max(0,commits.length+state.list.length-1));slider.disabled=slider.max==="0";
      if(!chosen)slider.value=String(commits.length+state.at);
      slider.setAttribute("aria-valuetext",place.textContent);syncPager();}
    function update(s){
      const p=host.project(), b=liveBinding(),id=host.fileSession?.();
      if(p!==project||b!==binding||session!==id||source&&!source.current()){clear();source?.close();source=null;gitDone=false;snapshot=null;older.hidden=true;gitStatus.replaceChildren();commits=[];rows.clear();rail.replaceChildren();watch?.reset();project=p;binding=b;session=id;}
      state=s;rail.style.height=s.list.length*HEIGHT+"px";range();schedule();loadGit();
    }
    function show(on){
      if(on&&!shown)savedBinding=undefined;
      shown=on;scrub.hidden=gitStatus.hidden=!on;
      if(on){revealCurrent=true;watch ||= A().watch(list);schedule();}
      else {clear();watch?.reset();if(paintFrame)cancelAnimationFrame(paintFrame);paintFrame=0;
        for(const r of rows.values())r.node.remove();rows.clear();}
    }
    function keys(e){
      if(!state||!["ArrowUp","ArrowDown","Home","End","Enter"," ","Escape"].includes(e.key))return;
      e.preventDefault();e.stopPropagation();
      if(e.key==="Escape"){clear();return;}
      let i=chosen?.state?state.list.findIndex((_,j)=>api.tree(state,j)?.id===chosen.state.id):state.at;
      if(e.key==="Enter"||e.key===" "){pick(Math.max(0,i),true);return;}
      i=e.key==="Home"?0:e.key==="End"?state.list.length-1:Math.max(0,Math.min(state.list.length-1,i+(e.key==="ArrowDown"?1:-1)));
      if(i*HEIGHT<list.scrollTop)list.scrollTop=i*HEIGHT;else if((i+1)*HEIGHT>list.scrollTop+list.clientHeight)list.scrollTop=(i+1)*HEIGHT-list.clientHeight;
      pick(i);syncPager();list.setAttribute("aria-activedescendant","hist-opt-"+i);schedule();
    }
    list.addEventListener("keydown",keys);list.addEventListener("scroll",schedule,{passive:true});
    const size=new ResizeObserver(schedule);size.observe(list);
    function resume(){if(!visible()){cancelPreview();}else{schedule();if(chosen&&!chosen.preview)request(chosen);}}
    document.addEventListener("visibilitychange",resume);const offPower=G.AtriumPower?.onChange?.(resume);
    function appearance(){if(visible()){for(const r of rows.values()){watch?.forget(r.thumb);r.node.remove();}rows.clear();schedule();redrawSelected();}}
    G.addEventListener("atrium-theme",appearance);G.addEventListener("atrium-pcb-appearance",appearance);
    function close(){
      G.removeEventListener("atrium-git-binding",onBinding);
      show(false);watch?.close();source?.close();source=null;binding=null;
      size.disconnect();list.removeEventListener("keydown",keys);list.removeEventListener("scroll",schedule);
      document.removeEventListener("visibilitychange",resume);offPower?.();
      G.removeEventListener("atrium-theme",appearance);G.removeEventListener("atrium-pcb-appearance",appearance);
      scrub.remove();pane.remove();rail.remove();gitStatus.remove();
    }
    return {update,show,clear,close,selectBranch(t,label){request({state:t,label});},refresh(){gitDone=false;loadGit();}};
  }
  return Object.freeze({mount,affected});
})();
