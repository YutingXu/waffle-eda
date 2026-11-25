"use strict";

globalThis.AtriumRevisionPanel = (() => {
  const limit=40;
  function el(tag,text,cls){ return AtriumNavCommon.el(tag, text, cls); }
  function button(label,fn,cls){
    const node=el("button",label,cls);
    node.type="button";node.onclick=fn;node.classList.add("ui-button");node.dataset.size="lg";
    return node;
  }
  function named(node,label){node.setAttribute("aria-label",label);return node;}
  function select(label){return named(el("select", null, "ui-field"),label);}
  function open(ctx){
    const review=AtriumRevisionReview;
    const dialog=named(el("dialog",null,"work-dialog ui-dialog revision-dialog"),"Change table");
    const title=el("h2","Change table"),status=el("p",null,"rev-status");
    status.setAttribute("role","status");
    const header=el("header",null,"rev-header"),heading=el("div"),done=button("Done",()=>dialog.close(),"rev-done");
    /* diff-ui */let lastPair=null;const visual=button("Visual diff",()=>{if(!lastPair)return;const p=lastPair;dialog.close();globalThis.AtriumLazy?.need("AtriumDiffView").then(V=>V.start({project:p.before,label:p.from},{project:p.after,label:p.to,working:p.working}),e=>ctx.info?.(e.message));},"rev-visual");visual.hidden=true;visual.title="Show these changes on the canvas: side by side, overlay, swipe or blink";
    heading.append(title,status);header.append(heading,visual,done);
    const sources=el("div",null,"rev-sources");
    const controls=el("div",null,"rev-controls"),area=select("Revision area"),change=select("Change type");
    const search=named(el("input", null, "ui-field"),"Find revision changes");
    search.type="search";search.placeholder="Find a designator, net or value";
    // The library search field (ui/components.css): magnifier, match count, and the kit's clear button on focus.
    const finder=el("div",null,"ui-search rev-search"),found=el("span",null,"ui-search-count");
    finder.append(AtriumNavCommon.icon("search"),search,found);
    controls.append(finder,area,change);
    const body=el("div",null,"rev-split"),left=el("div",null,"rev-nav");
    const list=named(el("div",null,"ui-list rev-list"),"Changed objects");
    list.dataset.layout="flush";list.setAttribute("role","listbox");list.tabIndex=0;
    const paging=el("div",null,"rev-paging"),prev=button("Previous",()=>page(-1)),next=button("Next",()=>page(1));
    const range=el("span");paging.append(prev,range,next);
    const detail=named(el("section",null,"rev-detail"),"Change details");
    left.append(list,paging);body.append(left,detail);
    let result=null,matches=[],start=0,selected=-1,visible=[],chosenButton=null;
    let fromName="",toName="Working design",workingTarget=true,token=0,filterToken=0,timer;
    let busy=false;
    async function readRevision(spec){
      const H=globalThis.AtriumNavHost;
      if(!globalThis.AtriumGit)await AtriumLazy.need("AtriumGitPicker");
      return AtriumGit.readSpec(spec,H);
    }
    const git=button("Compare with HEAD",()=>load(async(active,begin)=>{
      begin("Reading Git HEAD…");
      const before=await readRevision({type:"head"});
      if(!active())return null;
      const after=await readRevision({type:"working"});
      return {before:before.project,from:before.label,after:after.project,to:after.label,working:true};
    }));
    const pick=button("Choose project ZIP…",()=>load(async(active,begin)=>{
      const before=await readRevision({type:"file"});
      if(!before||!active())return null;
      begin("Reading "+before.label+"…");
      const after=await readRevision({type:"working"});
      return {before:before.project,from:before.label,after:after.project,to:after.label,working:true};
    }));
    async function pickRevisions(){
      await AtriumLazy.need("AtriumGitPicker");
      const r=await AtriumGitPicker.pickPair({title:"Compare revisions",after:{type:"working"}});if(!r)return;
      const GIT=globalThis.AtriumGit,H=globalThis.AtriumNavHost;
      return load(async(active,begin)=>{
        begin("Reading "+GIT.specLabel(r.before)+"…");
        let b=await GIT.readSpec(r.before,H);if(!b||!active())return null;
        if(r.mergeBase&&r.before.rev&&r.after.rev){const base=await GIT.mergeBase(r.before.rev,r.after.rev);if(base&&base!==r.before.rev)b={...await GIT.readSpec({type:"base",rev:base},H),label:"Merge base "+short(base)};}
        const a=await GIT.readSpec(r.after,H);if(!a||!active())return null;
        return {before:b.project,from:b.label,after:a.project,to:a.label,working:!!a.working};
      });
    }
    const commits=button("Git history…",()=>pickRevisions().catch(e=>{status.textContent=e.message;}));
    git.hidden=commits.hidden=!globalThis.AtriumHost?.folderGitGrant;
    sources.append(git,commits,pick);
    // The engine's summary (AtriumDiff): severity counts, the leading changes in words (pins that
    // moved between nets first) and Markdown / HTML / JSON reports. Text only; no design markup.
    const overview=named(el("section",null,"rev-overview"),"Change summary");overview.hidden=true;
    let semantic=null;
    function paintOverview(){
      overview.replaceChildren();
      if(!semantic){overview.hidden=true;return;}
      const s=semantic.summary,chips=el("div",null,"rev-severity");
      for(const k of ["electrical","mechanical","cosmetic"]){const c=el("span",s.bySeverity[k]+" "+(k==="mechanical"?"layout":k),"ui-badge");if(k!=="cosmetic")c.dataset.tone=k==="electrical"?"danger":"warning";chips.append(c);}
      overview.append(chips);
      if(s.headline.length){const ul=el("ul",null,"rev-headline");for(const t of s.headline.slice(0,6))ul.append(el("li",t));overview.append(ul);}
      if(typeof ctx.exportFile==="function"&&!s.identical){
        const bar=el("div",null,"rev-export"),o={title:"Design changes",from:fromName,to:toName};
        const save=(label,name,make)=>button(label,()=>Promise.resolve().then(()=>ctx.exportFile(name,make())).catch(e=>{status.textContent=e.message;}));
        bar.append(save("Export Markdown","design-changes.md",()=>AtriumDiff.toMarkdown(semantic,o)),save("Export HTML","design-changes.html",()=>AtriumDiff.toHTML(semantic,o)),
          save("Export JSON","design-changes.json",()=>JSON.stringify(AtriumDiff.toJSON(semantic,o),null,2)+"\n"));
        overview.append(bar);
      }
      overview.hidden=false;
    }
    dialog.append(header,sources,overview,controls,body);
    controls.hidden=body.hidden=true;
    status.textContent=git.hidden?"Choose a saved project ZIP to compare with the working design.":"Compare the working design with HEAD or choose an earlier revision.";
    function short(id){return String(id).slice(0,12);}
    function enabled(){
      git.disabled=pick.disabled=commits.disabled=busy;
    }
    function clearReport(){
      ++filterToken;clearTimeout(timer);
      result=null;matches=[];visible=[];chosenButton=null;selected=-1;
      list.replaceChildren();detail.replaceChildren();controls.hidden=body.hidden=true;
      semantic=null;overview.hidden=true;lastPair=null;visual.hidden=true;
    }
    async function load(read){
      if(busy)return;
      const id=++token,active=()=>id===token;
      busy=true;enabled();
      try{
        let input=await read(active,message=>{clearReport();status.textContent=message;});
        if(!input||!active())return;
        status.textContent="Comparing "+input.from+"…";
        await new Promise(resolve=>setTimeout(resolve,0));if(!active())return;
        if(input.working && globalThis.AtriumImportReports)input.before=await AtriumImportReports.comparison(input.before);
        if(!active())return;
        const engine=globalThis.AtriumDiff;
        const diff=engine?await engine.compareAsync(input.before,input.after,{},active):null;if(!active())return;
        const report=await review.compareAsync(input.before,input.after,active,{match:!!engine,matching:diff?.matching});if(!report||!active())return;
        fromName=input.from;toName=input.to;workingTarget=input.working;lastPair=input;visual.hidden=false;
        result=report;semantic=diff;paintOverview();
        await populateScopes(report,active);if(!active())return;
        search.value="";found.textContent="";controls.hidden=!report.rows.length;
        await filter();
      }catch(error){if(active()){clearReport();status.textContent=error.message;}}
      finally{if(active()){busy=false;enabled();}}
    }
    async function populateScopes(report,active){
      area.replaceChildren();change.replaceChildren();
      const areas=new Map(),docs=new Map(),states={Changed:0,Added:0,Removed:0};
      let deadline=performance.now()+4;
      for(let i=0;i<report.rows.length;i++){
        const row=report.rows[i];
        areas.set(row.area,(areas.get(row.area)||0)+1);states[row.status]++;
        if(row.document && !docs.has(row.document))docs.set(row.document,row.documentName);
        if(i%512===0 && performance.now()>=deadline){await new Promise(resolve=>setTimeout(resolve,0));if(!active())return;deadline=performance.now()+4;}
      }
      area.add(new Option("All areas",""));
      for(const name of ["Schematic","PCB","Library","Rules","Blocks","Project"])if(areas.has(name))area.add(new Option(name+" · "+areas.get(name),name));
      if(docs.size>1){
        const group=el("optgroup");group.label="Documents";
        for(const [id,name] of docs)group.append(new Option(name,"doc:"+id));area.append(group);
      }
      change.add(new Option("All changes",""));
      for(const name of ["Changed","Added","Removed"])change.add(new Option(name+" · "+states[name],name));
      area.value=change.value="";
    }
    function present(row){
      return AtriumRevisionPresent.row(result,row);
    }
    function drawDetail(row,view){
      detail.replaceChildren();
      const head=el("header",null,"rev-detail-head"),description=el("div");
      description.append(el("small",[row.status,view.context||row.documentName||row.area].filter(Boolean).join(" · ")),el("h3",view.title));
      head.append(description);
      if(workingTarget && row.locate)head.append(button("Locate",()=>{dialog.close();ctx.select(row.locate);}));
      detail.append(head);
      const graphic=globalThis.AtriumRevisionGeometry?.preview(result,row);
      if(graphic)detail.append(graphic);
      const table=el("table",null,"rev-values"),thead=el("thead"),tr=el("tr");
      for(const label of ["Field","Before","After"]){const cell=el("th",label);cell.scope="col";tr.append(cell);}
      thead.append(tr);
      const tbody=el("tbody");table.append(thead,tbody);detail.append(table);
      const iterator=review.fields(result,row);
      let cursor=iterator.next();
      const more=button("More fields",addFields);
      function addFields(){
        for(let i=0;i<32 && !cursor.done;i++){
          const field=cursor.value,r=el("tr"),heading=el("th",field.label);heading.scope="row";r.append(heading);
          for(const str of [field.before,field.after]){
            const td=el("td",str==="Absent"?"—":str);
            if(str==="Absent"){td.title="Absent";td.setAttribute("aria-label","Absent");}
            r.append(td);
          }
          tbody.append(r);cursor=iterator.next();
        }
        more.hidden=cursor.done;
      }
      addFields();detail.append(more);detail.scrollTop=0;
    }
    function choose(entry){
      chosenButton?.setAttribute("aria-selected","false");
      chosenButton=entry.node;selected=entry.index;
      entry.node.setAttribute("aria-selected","true");list.setAttribute("aria-activedescendant",entry.node.id);
      drawDetail(matches[selected],entry.view);
    }
    function paint(){
      list.replaceChildren();list.scrollTop=0;visible=[];chosenButton=null;selected=-1;
      list.removeAttribute("aria-activedescendant");detail.replaceChildren();
      const end=Math.min(start+limit,matches.length),count=matches.length;
      const readout=count?(start+1)+"–"+end+" of "+count+(count===1?" change":" changes"):result.rows.length?"No matching changes":"No differences";
      status.textContent=fromName+" → "+toName+" · "+readout;
      range.textContent=count?(start+1)+"–"+end+" / "+count:"";
      prev.disabled=start===0;next.disabled=end>=count;paging.hidden=count<=limit;
      body.hidden=!count;if(!count)return;
      const groups=new Map();
      for(let i=start;i<end;i++){
        const row=matches[i],key=row.document??row.area;
        if(!groups.has(key)){
          const label=row.documentName||row.area,pane=named(el("div",null,"rev-group"),label);
          pane.setAttribute("role","group");pane.append(el("h4",label));groups.set(key,{pane,entries:[]});list.append(pane);
        }
        const group=groups.get(key),view=present(row),node=el("div",null,"ui-row rev-option");
        node.setAttribute("role","option");node.setAttribute("aria-selected","false");node.id="rev-option-"+i;
        const mark=el("span",({Added:"+",Changed:"~",Removed:"−"})[row.status],"rev-mark");
        mark.dataset.kind=row.status;mark.setAttribute("aria-hidden","true");
        const text=el("div");text.append(el("strong",view.title));
        if(view.detail)text.append(el("small",view.detail));
        node.setAttribute("aria-label",[row.status,view.title,view.detail].filter(Boolean).join(" · "));
        node.append(mark,text);group.pane.append(node);
        const entry={index:i,view,node};group.entries.push(entry);
        node.onclick=()=>{list.focus();choose(entry);};
      }
      visible=[...groups.values()].flatMap(g=>g.entries);choose(visible[0]);
    }
    function page(step){const pos=start+step*limit;if(pos<0||pos>=matches.length)return;start=pos;paint();list.focus();}
    list.onkeydown=event=>{
      if(!visible.length)return;
      const i=visible.findIndex(entry=>entry.index===selected);
      const target=({ArrowDown:Math.min(i+1,visible.length-1),ArrowUp:Math.max(i-1,0),Home:0,End:visible.length-1})[event.key];
      if(target==null)return;
      event.preventDefault();choose(visible[target]);visible[target].node.scrollIntoView?.({block:"nearest"});
    };
    async function filter(){
      if(!result)return;
      clearTimeout(timer);const id=++filterToken,report=result;
      const active=()=>id===filterToken && report===result;
      const scope=area.value||"",byDoc=scope.startsWith("doc:");
      const items=await review.findRowsAsync(report,byDoc?"":scope,change.value,search.value,active,byDoc?scope.slice(4):"");
      if(items && active()){matches=items;start=0;found.textContent=search.value?String(items.length):"";paint();}
    }
    area.onchange=change.onchange=filter;
    search.oninput=()=>{++filterToken;clearTimeout(timer);timer=setTimeout(filter,90);};
    dialog.onclose=()=>{token++;clearReport();dialog.remove();};
    globalThis.AtriumShell.adoptDialog(dialog,{title,body,initialFocus:()=>git.hidden?pick:git});
    document.body.append(dialog);dialog.showModal();
  }
  return {open};
})();
