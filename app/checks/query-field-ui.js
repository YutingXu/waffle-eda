"use strict";
// Mounted by existing field editors and query inputs. A suggestion never changes the
// editor's text automatically. One explicit parameter edit goes through normal Undo.
globalThis.AtriumQueryFieldUI=(()=>{
  const G=globalThis,F=G.AtriumQueryFields;
  const states=new WeakMap();
  let serial=0;
  function editor(node,field,{project,host=G.AtriumNavHost,changed,edit}={}) {
    const d=node.ownerDocument,owner=typeof project==="function"?project():project;
    const input=d.createElement("input"),label=d.createElement("label"),save=d.createElement("button"),
      cancel=d.createElement("button"),status=d.createElement("span"),panel=d.createElement("span");
    panel.className="query-field-declaration";
    const scope=field.owner?.scope || "project";
    label.textContent=(scope==="library"?"Library":scope==="placement"?"Component":"Project")+" parameter "+field.label+" unit";
    input.type="text";input.maxLength=48;input.value=field.unit || "";input.autocomplete="off";
    label.append(input);save.type=cancel.type="button";save.textContent="Save unit";cancel.textContent="Cancel";status.setAttribute("role","status");
    const close=()=>{panel.remove();node.focus();};
    save.onclick=()=>{
      try {
        if(typeof project==="function" && project()!==owner || host?.project && host.project()!==owner)throw Error("This project has changed.");
        if(owner?.readOnly || owner?.atriumCompat?.readOnly)throw Error("This parameter is read-only.");
        const unit=input.value.trim();
        if(!unit || !G.AtriumCalculationCore.units(unit==="m"?"metre":unit))throw Error("Enter a recognized unit.");
        if(!edit && !host?.edit)throw Error("Open an editable project to declare this unit.");
        const write=()=>F.declare(owner,field,unit);
        const accepted=edit?edit(write,"Declare parameter unit"):host.edit(write,"Declare parameter unit");
        if(accepted===false)throw Error("This parameter is read-only.");
        close();changed?.();
      } catch(e) {status.textContent=e.message;input.setAttribute("aria-invalid","true");input.focus();}
    };
    cancel.onclick=close;
    input.onkeydown=e=>{if(e.key==="Escape" || e.key==="Enter"){e.preventDefault();e.stopPropagation();if(e.key==="Escape")close();else save.click();}};
    panel.append(label,save,cancel,status);node.after(panel);input.focus();return panel;
  }
  function attach(input,options={}) {
    if(states.has(input))return states.get(input);
    const doc=input.ownerDocument,other=input.getAttribute("aria-describedby"),box=doc.createElement("span"),ghost=doc.createElement("span"),
      actions=doc.createElement("span");
    box.className="query-field-assist";box.hidden=true;ghost.id="query-field-hint-"+(++serial);
    ghost.className="query-field-ghost";ghost.setAttribute("role","status");ghost.setAttribute("aria-live","polite");
    input.setAttribute("aria-describedby",[other,ghost.id].filter(Boolean).join(" "));box.append(ghost,actions);input.after(box);
    const project=()=>typeof options.project==="function"?options.project():options.project || options.host?.project?.();
    let pane,context,latest;
    function update(compiled={},extra) {
      latest=compiled;context=extra || (typeof options.context==="function"?options.context():options.context) || {};
      if(pane?.isConnected)return;
      const messages=[];
      actions.replaceChildren();
      function replaceButton(label,replacement,span) {
        const original=input.value,[a,b]=span || [];
        if(typeof replacement!=="string" || replacement.length>256 || !Number.isInteger(a) || !Number.isInteger(b) || a<0 || b<a || b>original.length)return;
        const choice=doc.createElement("button");choice.type="button";choice.textContent=label;
        choice.onclick=()=>{if(input.value!==original)return;input.focus();input.setRangeText(replacement,a,b,"end");
          input.dispatchEvent(new (doc.defaultView.Event)("input",{bubbles:true}));};
        actions.append(choice);
      }
      for(const hint of (compiled.hints || []).slice(0,12)) {
        if(hint.code==="case-alternative") {
          replaceButton(String(hint.label || "Use "+hint.replacement),hint.replacement,hint.span);continue;
        }
        const raw=typeof hint.field==="object"?hint.field.id:hint.field;
        if(typeof raw!=="string")continue;
        const field=F.describe(project(),{...context,...(hint.context || {}),field:raw});
        if(field.type==="unavailable")continue;
        if(hint.code==="inferred-unit") {
          const u=hint.unit || field.unit;
          if(u){messages.push(field.label+" uses "+u);ghost.dataset.unit=u;}
        } else if(hint.code==="declare-unit" && field.type==="undeclared" && field.owner) {
          const fix=doc.createElement("button");fix.type="button";fix.textContent="Declare unit…";
          fix.setAttribute("aria-label","Declare unit for "+field.label);
          fix.onclick=()=>{pane=editor(fix,field,{...options,project,changed:()=>{options.changed?.();update(options.result?.() || latest,context);}});};
          actions.append(fix);
        }
      }
      const completion=context.completion || compiled.completion;
      if(completion?.prefix && Array.isArray(completion.span)) {
        for(const field of F.complete(project(),{...context,prefix:completion.prefix}).slice(0,8))
          replaceButton(field.label+(field.unit?" ("+field.unit+")":""),field.id,completion.span);
      }
      ghost.textContent=messages.join(" · ");if(!messages.length)delete ghost.dataset.unit;
      box.hidden=!messages.length && !actions.childNodes.length;
    }
    function dispose(){box.remove();states.delete(input);if(other)input.setAttribute("aria-describedby",other);else input.removeAttribute("aria-describedby");}
    const handle={update,dispose};states.set(input,handle);if(options.result)update(options.result());return handle;
  }
  return Object.freeze({attach,editor});
})();
