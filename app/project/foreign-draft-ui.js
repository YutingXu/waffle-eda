"use strict";
globalThis.AtriumForeignDraftUI = (() => {
  const G=globalThis;
  const AtriumI18n=G.AtriumI18n || {define:e=>(key,args)=>e[key].replace(/\{(\w+)\}/g,(s,k)=>args?.[k]??s)};
  const t=AtriumI18n.define({
    "foreignDraft.status":"Not saved yet (imported from {format})",
    "foreignDraft.close":"Close {name}?",
    "foreignDraft.recover":"Recover imported projects",
    "foreignDraft.restore":"Restore Draft",
    "foreignDraft.keep":"Keep for Later",
    "foreignDraft.discard":"Discard",
    "foreignDraft.save":"Save",
    "foreignDraft.cancel":"Cancel"
  });
  const status=p=>t("foreignDraft.status",{format:p.formatLabel});
  function el(tag,text) { const n=document.createElement(tag); if (text) n.textContent=text; return n; }
  function button(id,run) {
    const keys={cancel:"foreignDraft.cancel",keep:"foreignDraft.keep",discard:"foreignDraft.discard",
      save:"foreignDraft.save",restore:"foreignDraft.restore"};
    const b=el("button",t(keys[id])); b.type="button"; b.dataset.choice=id; b.className="ui-button";
    b.dataset.variant=id==="save"||id==="restore"?"primary":id==="discard"?"danger":"secondary";
    b.addEventListener("click",run); return b;
  }
  function dialog(title,cls) {
    const d=el("dialog"); d.className="recover-dialog "+cls;
    d.append(el("h2",title)); d.addEventListener("close",()=>d.remove(),{once:true}); return d;
  }
  function closeChoice(p) {
    const d=dialog(t("foreignDraft.close",{name:p.name}),"foreign-import-close"), actions=el("div");
    const detail=el("p",status(p));
    d.append(detail,actions);
    return new Promise(resolve=>{
      let decision="cancel";
      for (const key of ["cancel","keep","discard","save"]) {
        const b=button(key,()=>{decision=key;d.close();});
        if(key==="save") b.autofocus=true;
        actions.append(b);
      }
      AtriumShell.adoptDialog(d,{title:d.firstElementChild,body:detail,actions,initialFocus:actions.querySelector("[autofocus]")});
      d.addEventListener("close",()=>resolve(decision),{once:true}); document.body.append(d); d.showModal();
    });
  }
  function append(heads,container,modal,host,afterDiscard) {
    for (const head of heads) {
      const row=el("section");row.className="recover-group foreign-import-draft";
      row.append(el("h3",head.pending.name),el("p",status(head.pending)));
      const busy=async fn=>{
        const buttons=[...row.querySelectorAll("button")];
        for(const b of buttons)b.disabled=true;
        try { await fn(); } catch(e) { host.info?.(e.message); let error=row.querySelector("[role=alert]"); if(!error){error=el("p");error.setAttribute("role","alert");row.append(error);}error.textContent=e.message; }
        finally { for(const b of buttons)b.disabled=false; }
      };
      row.append(button("restore",()=>busy(async()=>{if(await G.AtriumForeignDrafts.restore(head,host))modal.close();})),
        button("discard",()=>busy(async()=>{await G.AtriumForeignDrafts.discard(head);row.remove();afterDiscard?.();})));
      container.append(row);
    }
  }
  function prompt(heads,host) {
    const d=dialog(t("foreignDraft.recover"),"foreign-import-recovery"), body=el("div"), foot=el("div");
    d.append(body,foot);
    append(heads,body,d,host,()=>{if(!body.childElementCount)d.close();});
    const keep=button("keep",()=>d.close());foot.append(keep);
    AtriumShell.adoptDialog(d,{title:d.firstElementChild,body,actions:foot,initialFocus:keep});
    document.body.append(d);d.showModal();return d;
  }
  return Object.freeze({status,closeChoice,append,prompt});
})();
