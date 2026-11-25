"use strict";
globalThis.AtriumSheetWidgetEditor=(()=>{
  const G=globalThis,W=G.AtriumSheetWidgets;
  let session=null;
  const tablesEnabled=()=>G.AtriumPrefs?.get("butter.tables")===true;
  const el=(name,t,cl)=>AtriumNavCommon.el(name, t, cl);
  const button=(t,fn)=>{const b=el("button",t,"ui-button");b.type="button";b.addEventListener("click",fn);return b;};
  const id=()=>G.Atrium.id();
  function input(parent,label,value,fn,{type="text",options,max=2048,numeric}={}) {
    const l=el("label",null,"sw-field"),caption=el("span",label);caption.id="sw-label-"+id();l.append(caption);
    const e=el(options?"select":"input",null,"ui-field");e.setAttribute("aria-labelledby",caption.id);
    if (options) for (const [v,t] of options) e.append(new Option(t,v));
    else {e.type=type;e.maxLength=max;if(type==="number")e.step="any";}
    if(numeric)G.AtriumLazy?.numericField?.(e,numeric);
    e.value=value ?? "";e.onchange=()=>fn(e.value,e);l.append(e);parent.append(l);return e;
  }
  const find=(h,docId,itemId)=>h.project().documents.find(d=>d.id===docId)?.items.find(i=>i.id===itemId);
  function open(itemId,h=G.AtriumNavHost) {
    const signal=G.AtriumLabs?.notebookSignal();
    if(signal?.aborted)return false;
    const project=h.project(),doc=h.doc(),found=find(h,doc.id,itemId);
    if (!W.isWidget(found)) return false;
    session?.close();
    if(found.widget.type==="table" && found.widget.state.tableVersion===1){
      if(!tablesEnabled())return false;
      const enter=editor=>{if(h.project()===project && h.doc().id===doc.id && find(h,doc.id,itemId))editor.open(h,doc.id,itemId);};
      if(G.AtriumTableEditor)enter(G.AtriumTableEditor);else G.AtriumLazy.need("AtriumTableEditor").then(enter);
      return true;
    }
    const dlg=el("dialog",null,"work-dialog sw-editor"),body=el("div",null,"sw-body"),status=el("p",null,"sw-status");
    const head=el("header"), actions=el("div"), done=button("Done",async()=>{const ui=G.AtriumNumericFields;if(!ui?.pending(dlg) || await ui.flush(dlg))dlg.close();});
    done.classList.add("is-primary");actions.append(done);head.append(el("h2",W.types[found.widget.type] || found.text),actions);
    dlg.setAttribute("aria-label",head.firstChild.textContent);status.setAttribute("role","status");dlg.append(head,body,status);document.body.append(dlg);
    const get=()=>!signal?.aborted && h.project()===project && find(h,doc.id,itemId);
    let detached=false, frame=0, authored=false;
    const schedule=(force=false)=>{
      authored ||= force===true;
      if(!detached && !frame)frame=requestAnimationFrame(()=>{
        frame=0;const editing=body.contains(document.activeElement) && document.activeElement?.waffleNumeric;
        if(!detached && !G.AtriumNumericFields?.pending(body) && (authored || !editing))render();
        authored=false;
      });
    };
    const write=(label,fn,rebuild=false)=>{
      const item=get();if(!item){dlg.close();return;}
      try {
        const previous=JSON.stringify(item.widget.state), next=JSON.parse(previous);fn(next);
        if (JSON.stringify(next)===previous && !G.AtriumNumericFields?.editingBinding()) return;
        if (!W.valid({...item,widget:{...item.widget,state:next}})) throw Error("This value falls outside the widget’s allowed bounds.");
        h.edit(()=>{const live=get();if(!live)throw Error("Widget unavailable.");live.widget.state=next;} ,label,[item]);
        status.textContent="";if(rebuild)schedule(true);
      } catch(e){status.textContent=e.message;}
    };
    function linked(row) {
      if(!row.link)return;
      const target=find(h,row.link.docId,row.link.itemId);
      body.append(button(target?"Open linked object":"Linked object unavailable",()=>{
        if(!target)return;dlg.close();h.selectDocument?.(row.link.docId);h.select?.([row.link.itemId]);}));
    }
    function links(form,current,fn) {
      const choices=[["","No link"]];
      for(const d of project.documents)for(const i of d.items) {
        if(i.id===itemId)continue;
        if(choices.length>1024)break;
        choices.push([JSON.stringify([d.id,i.id]),d.name+" · "+(i.ref || i.name || i.text || i.kind)+" · "+i.id]);
      }
      if(current&&!choices.some(c=>c[0]===JSON.stringify([current.docId,current.itemId]))) choices.push([JSON.stringify([current.docId,current.itemId]),"Unavailable object"]);
      input(form,"Linked object",current?JSON.stringify([current.docId,current.itemId]):"",v=>{const pair=v?JSON.parse(v):null;fn(pair?{docId:pair[0],itemId:pair[1]}:null);},{options:choices});
    }
    function cell(form,data,replace) {
      const v=data || {kind:"literal",text:""}, choices=[["literal","Text or quantity"],["field","Design field"],["calculation","Calculation"]];
      input(form,"Cell source",v.kind,k=>replace(k==="literal"?{kind:k,text:""}:k==="field"?{kind:k,expression:"{sheet.Title}"}:{kind:k,documentId:doc.id,blockId:"unbound"},true),{options:choices});
      if(v.kind==="literal")input(form,"Text",v.text,t=>replace({kind:"literal",text:t}));
      if(v.kind==="field") {
        const field=input(form,"Field",v.expression,expression=>{
          const f=G.AtriumNoteFields?.resolve(project,doc,expression);replace({kind:"field",expression,...(f?.binding?{binding:f.binding}:{})});
        });
        const list=el("datalist");list.id="sw-complete-"+id();field.setAttribute("list",list.id);form.append(list);
        field.oninput=()=>{list.replaceChildren();for(const c of (G.AtriumNoteFields?.complete(project,doc,field.value)||[]).slice(0,24))list.append(new Option(c.label,c.expression));};
      }
      if(v.kind==="calculation"){
        input(form,"Calculation sheet",v.documentId,documentId=>replace({...v,documentId},true),{options:project.documents.filter(d=>d.kind==="schematic").map(d=>[d.id,d.name])});
        const target=project.documents.find(d=>d.id===v.documentId), blocks=target?.items.filter(i=>i.calculation || i.kind==="calculation" || i.calc) || [];
        if(blocks.length) input(form,"Calculation",v.blockId,blockId=>replace({...v,blockId}),{options:[["unbound","Choose a calculation"],...blocks.map(i=>[i.id,i.text || i.name || i.id])]});
        else input(form,"Calculation block ID",v.blockId==="unbound"?"":v.blockId,blockId=>replace({...v,blockId:blockId || "unbound"}));
        input(form,"Instance (optional)",v.instanceId || "",instanceId=>{const n={...v};if(instanceId)n.instanceId=instanceId;else delete n.instanceId;replace(n);});
      }
    }
    function todo(item,s) {
      for(const r of s.rows) {
        const box=el("fieldset"),check=el("input",null,"ui-checkbox");check.type="checkbox";check.checked=W.checked(project,r)===true;check.disabled=W.checked(project,r)===null;
        const label=el("label",null,"sw-check");label.append(check,el("span",r.text));box.append(label);
        check.onchange=()=>{const live=get();try{h.edit(()=>W.setDone(project,live,r.id,check.checked),"Check to-do",r.threadId?undefined:[live]);}catch(e){status.textContent=e.message;}};
        const prop=(k,v)=>write("Edit checklist row",n=>{const live=n.rows.find(x=>x.id===r.id);if(v==null||v===""&&k!=="text")delete live[k];else live[k]=v;});
        input(box,"Item",r.text,v=>prop("text",v));input(box,"Assignee",r.assignee,v=>prop("assignee",v),{max:128});input(box,"Due",r.due,v=>prop("due",v),{type:"date"});
        links(box,r.link,v=>prop("link",v));
        G.AtriumReviewNotes?.links(box,{project,doc,item,row:r,input,closeDialog:close,refresh:schedule,edit(fn){
          const live=get(),target=live?.widget.state.rows.find(v=>v.id===r.id);
          if(!target)throw Error("Checklist row unavailable.");
          h.edit(()=>fn(target),"Link Review thread");
        }});
        box.append(button("Remove item",()=>write("Remove checklist row",n=>{n.rows=n.rows.filter(x=>x.id!==r.id);},true)));body.append(box);linked(r);
      }
      body.append(button("Add item",()=>write("Add checklist row",n=>n.rows.push({id:id(),text:"New item",done:false}),true)));
    }
    function table(s) {
      const tbl=el("div",null,"sw-table");
      for(const c of s.columns)input(tbl,"Column title",c.title,v=>write("Rename table column",n=>{n.columns.find(x=>x.id===c.id).title=v;}));
      for(const [idx,r] of s.rows.entries()) {
        const section=el("fieldset");section.append(el("legend","Row "+(idx+1)));
        for(const c of s.columns){const box=el("fieldset");box.append(el("legend",c.title));cell(box,r[W.keyFor(c.id)],(v,refresh)=>write("Edit table cell",n=>{n.rows.find(x=>x.id===r.id)[W.keyFor(c.id)]=v;},refresh));section.append(box);}
        section.append(button("Remove row",()=>write("Remove table row",n=>{n.rows=n.rows.filter(x=>x.id!==r.id);},true)));tbl.append(section);
      }
      body.append(tbl,button("Add row",()=>write("Add table row",n=>n.rows.push({id:id()}),true)),button("Add column",()=>write("Add table column",n=>n.columns.push({id:"c"+id().replace(/-/g,"").slice(0,32),title:"Column "+(n.columns.length+1)}),true)));
    }
    function budget(s) {
      body.append(el("p","Parts with Power rail and Supply current or Output current rating parameters contribute automatically."));
      for(const r of s.sources) {
        const b=el("fieldset"),put=(k,v,repaint)=>write("Edit power budget",n=>{n.sources.find(x=>x.id===r.id)[k]=v;},repaint);
        input(b,"Rail",r.rail,v=>put("rail",v));input(b,"Current",r.use,v=>put("use",v),{options:[["load","Load"],["rating","Regulator rating"]]});
        cell(b,r.input,(v,refresh)=>put("input",v,refresh));b.append(button("Remove source",()=>write("Remove power source",n=>{n.sources=n.sources.filter(x=>x.id!==r.id);},true)));body.append(b);
      }
      body.append(button("Add source",()=>write("Add power source",n=>n.sources.push({id:id(),rail:"VDD",use:"load",input:{kind:"literal",text:"0 mA"}}),true)));
    }
    function render() {
      const item=get();if(!item){dlg.close();return;}const {type,state:s}=item.widget;body.replaceChildren();
      const put=(k,v,r=false)=>write("Edit "+(W.types[type] || "widget"),n=>{n[k]=v;},r);
      if(type==="todo")todo(item,s);
      else if(type==="table"){
        if(tablesEnabled())body.append(button("Upgrade to full table",async()=>{
          try{
            const editor=await G.AtriumLazy.need("AtriumTableEditor"),live=get();
            if(!tablesEnabled() || !live || h.doc().id!==doc.id || h.folderProject?.()?.canEdit?.(doc.id)===false)return;
            await G.AtriumLazy.need("AtriumButterEditor");
            await G.AtriumButterEditor.apply("butter.tables.upgrade",{documentId:doc.id,itemId});
            close();editor.open(h,doc.id,itemId);
          }catch(error){status.textContent=error.message;}
        }));table(s);
      }
      else if(type==="power-budget")budget(s);
      else if(type==="pin-map"){
        const choices=[["","Choose a part"]];for(const d of project.documents.filter(d=>d.kind==="schematic"))for(const i of d.items.filter(i=>i.kind==="part"))choices.push([JSON.stringify([d.id,i.id]),d.name+" · "+i.ref]);
        input(body,"Part",s.part?JSON.stringify([s.part.docId,s.part.itemId]):"",v=>{const ref=v?JSON.parse(v):null;put("part",ref?{docId:ref[0],itemId:ref[1]}:null,true);},{options:choices});
      } else if(type==="calculator"){
        const presets=G.AtriumWidgetCatalogue.calculatorPresets;
        input(body,"Calculator",s.calculator,v=>write("Change calculator",n=>{Object.keys(n).forEach(k=>delete n[k]);n.calculator=v;},true),{options:presets});
        const spec=G.AtriumCalc?.list().find(c=>c.id===s.calculator);
        for(const f of spec?.inputs || []){if(f.key==="l")continue;input(body,f.label+(f.unit?" ("+f.unit+")":""),s[f.key] ?? f.default,v=>put(f.key,+v,true),{type:"number",numeric:{unit:f.unit || "",min:f.min,max:f.max,host:h,project,
            target:{scope:"item",documentId:doc.id,itemId,path:["widget","state",f.key]}}});}
      } else if(type==="bode"){
        input(body,"SPICE bench",s.bench,v=>put("bench",v,true),{options:[["","Active circuit"],...(project.simulation?.benches || []).map(b=>[b.id,b.name || b.id])]});
        input(body,"Probe net",s.probe,v=>put("probe",v,true));input(body,"Vertical axis",s.channel,v=>put("channel",v,true),{options:[["both","Magnitude and phase"],["db","Magnitude (dB)"],["phase","Phase (°)"]]});
      } else if(type==="link"){
        input(body,"Caption",s.caption,v=>put("caption",v));input(body,"Datasheet or URL",s.url,v=>put("url",v,true),{type:"url"});
        const go=button("Open link",async()=>{try{await W.openURL(get().widget.state.url);}catch(e){status.textContent=e.message;}});go.disabled=!W.safeURL(s.url);body.append(go);
      }
      const result=el("div",null,"sw-result");result.setAttribute("aria-live","polite");body.append(result);
      const revision=h.revision(),ctx={host:h,revision,defs:h.defs(),dark:document.documentElement.dataset.theme==="dark"},runtime=G.AtriumSheetWidgetRuntime;
      const prepared=type.startsWith("ext.") && runtime.preparedView(project,doc,item,revision);
      Promise.resolve(prepared || runtime.prepare(project,doc,item,ctx)).then(view=>{
        if(!result.isConnected || revision!==h.revision())return;
        if(!view){setTimeout(()=>{if(result.isConnected)schedule();},G.AtriumExtensionWidgets.limits.interval);return;}
        if(type.startsWith("ext."))for(const r of view.rows){
          const label=r.cells.map(c=>c.text).join(" · ");if(!r.action){result.append(el("p",label));continue;}
          const send=async(event,action)=>{
            try{const live=get();if(live && h.revision()===revision && await runtime.interact(h,doc,live,{type:event.type,action,key:event.key}))schedule();
            }catch(e){status.textContent=e.message;}
          };
          let pointer="",key="";
          const b=button(label,ev=>{const kind=ev.detail===0?"key":["touch","pen"].includes(pointer)?"touch":"activate";
            send({type:kind,key:kind==="key"?key || "Enter":undefined},r.action);pointer="";key="";});
          b.onpointerdown=ev=>{pointer=ev.pointerType;};b.onkeydown=ev=>{if(ev.key==="Enter" || ev.key===" ")key=ev.key;};
          b.onfocus=()=>send({type:"focus"},r.action);result.append(b);
        }else if(type!=="todo" && type!=="link") {const out=el("pre",view.fallback.text);result.append(out);}
      }).catch(e=>{if(result.isConnected)status.textContent=e.message;});
    }
    function close(){if(dlg.open)dlg.close();else cleanup();}
    const offChange=h.on?.("change",schedule);
    const off=h.on?.("document",()=>{if(h.project()!==project || h.doc().id!==doc.id)close();});
    function cleanup(){detached=true;cancelAnimationFrame(frame);offChange?.();off?.();dlg.remove();if(session?.dialog===dlg)session=null;}
    globalThis.AtriumShell?.adoptDialog?.(dlg, {title:head.firstElementChild, body:[body,status], actions, defaultAction:false});
    dlg.addEventListener("close",cleanup,{once:true});session={dialog:dlg,close};dlg.showModal();render();
    Promise.all(["AtriumCalc","AtriumNoteFields","AtriumReviewComments","AtriumReviewNotes"].filter(n=>G.AtriumLazy.modules().includes(n) && !G[n] &&
      (found.widget.type==="calculator"?n==="AtriumCalc":found.widget.type==="todo"?["AtriumReviewComments","AtriumReviewNotes"].includes(n):n==="AtriumNoteFields")).map(n=>G.AtriumLazy.need(n))).then(schedule);
    return true;
  }
  return Object.freeze({open});
})();
