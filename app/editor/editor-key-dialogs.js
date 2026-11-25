"use strict";

// The snap grid dialog is built on the command that opens it.
globalThis.AtriumEditorKeyDialogs = (() => {
  // Presets follow the document's display unit. The custom entry accepts any length with
  // an optional suffix (10mil, 0.25mm, 0.01in); bare numbers use the display unit.
  function gridPicker(current,customFirst,apply,opt={}){
    const U=globalThis.Atrium.units,unit=U.normal(opt.unit),kind=opt.kind||"pcb",board=kind==="pcb";
    const {min,max}=U.gridLimits(kind);
    const d=document.createElement("dialog"),form=document.createElement("form");
    const name=(board?"PCB":"Schematic")+" snap grid";
    d.className="keys-grid";d.setAttribute("aria-label",name);
    const heading=document.createElement("h2");heading.textContent=name;
    const step=document.createElement("select");step.setAttribute("aria-label","Grid spacing");
    const sizes=U.presets(unit,board?"pcb":"schematic"), selected=sizes.findIndex(v=>Math.abs(v-current)<1e-9);
    if(selected<0)sizes.push(current);
    else sizes[selected]=current;
    for(const value of sizes.sort((a,b)=>a-b))step.add(new Option(U.format(value,unit),String(value)));
    step.add(new Option("Custom…","custom"));
    step.value=customFirst?"custom":String(current);
    const custom=document.createElement("input");custom.type="text";custom.inputMode="decimal";custom.autocomplete="off";custom.spellcheck=false;
    const shown=String(U.value(current,unit));
    custom.dataset.unit=unit;custom.value=shown;custom.setAttribute("aria-label","Custom grid spacing ("+unit+")");
    custom.placeholder=unit==="mil"?"e.g. 5, 2.5mil or 0.1mm":"e.g. 0.1, 0.05mm or 5mil";
    let entry, typed=false;
    globalThis.AtriumLazy?.numericField?.(custom,{unit,storageUnit:"mm",nanometres:true,min,max,target:opt.target,
      stage:value=>{entry=value;}});
    const note=document.createElement("p");note.className="keys-grid-note";note.setAttribute("role","alert");
    function mode(){custom.hidden=step.value!=="custom";custom.disabled=custom.hidden;note.textContent="";if(!custom.hidden){custom.focus();custom.select();}}
    const foot=document.createElement("div");
    step.className=custom.className="ui-field";
    const cancel=document.createElement("button"),set=document.createElement("button");
    cancel.type="button";cancel.textContent="Cancel";cancel.onclick=()=>d.close();set.type="submit";set.textContent="Apply";
    cancel.className=set.className="ui-button";set.dataset.variant="primary";
    foot.append(cancel,set);form.append(heading,step,custom,note,foot);d.append(form);
    form.onsubmit=event=>{event.preventDefault();
      const editing=step.value==="custom";
      if(editing && !typed && custom.value===shown){d.close();return;}
      const value=editing?U.parse(custom.value,unit):Number(step.value);
      if(!Number.isFinite(value)){note.textContent="Enter a spacing such as "+(unit==="mil"?"5mil":"0.1mm")+".";custom.focus?.();return;}
      if(!editing && value===current && (value<min || value>max)){d.close();return;}
      if(value<min){note.textContent=board?"The snap grid must be at least "+U.format(min,"mm")+".":"The snap grid must be at least 1mil (0.0254mm).";custom.focus?.();return;}
      if(value>max){note.textContent="This spacing is too large.";custom.focus?.();return;}
      apply(value,editing ? entry : undefined);d.close();};
    custom.oninput=()=>{typed=true;note.textContent="";};
    step.onchange=mode;
    step.onkeydown=e=>{if(e.key.toLowerCase()==="g"&&!e.ctrlKey&&!e.metaKey&&!e.altKey){e.preventDefault();step.value="custom";mode();}};
    AtriumShell.openDialog(d,{title:heading,body:[step,custom,note],actions:foot,initialFocus:step});
    mode();
  }
  return {gridPicker};
})();
