"use strict";
// Keyboard shortcuts editor (Preferences › Keyboard Shortcuts), loaded on first use by
// AtriumKeymap.open() in keymap.js. open(api, internals, ctx): api is AtriumKeymap; internals are
// the key map's preset name and title, user-binding count, effective(id) and the open-dialog slot.
// A searchable table of every command, grouped by category. Click a key cell to record
// a chord or a sequence (each key extends it; Enter or a pause finishes, Esc cancels).
globalThis.AtriumKeymapEditor = (() => {
  const WHEN_WORDS={pcb:"on boards","!pcb":"not on boards",schematic:"on schematics","!schematic":"not on schematics",
    routing:"while routing","!routing":"not routing",placing:"while placing","!placing":"not placing",interactive:"while a tool is active","!interactive":"no tool active",
    moving:"while moving","!moving":"not moving",selection:"something selected","!selection":"nothing selected",canvas:"canvas focused","!canvas":"outside the canvas",
    rotatable:"selection can rotate","!rotatable":"nothing to rotate",tuning:"while length tuning","!tuning":"not tuning",canProperties:"tool has properties",
    suggestion:"route ghost shown",suggestTab:"route ghost shown, Tab accepts",busRouting:"while routing a bus",cursorAt:"keyboard cursor shown","!cursorAt":"no keyboard cursor",dragging:"while dragging","!dragging":"not dragging",true:"always",false:"never"};
  const TOOL_WORDS={select:"Select",route:"Route",via:"Via",place:"Place",pan:"Pan",label:"Label",measure:"Measure","move-object":"Move"};
  // Lists that run their own keymap commands (registerCommand `focus`).
  const FOCUS_WORDS={library:"in the Library list",views:"in the Saved views list",slides:"in the Slides strip"};
  function describeTerm(t){
    t=t.trim();if(WHEN_WORDS[t])return WHEN_WORDS[t];
    let m=/^tool\s*(==|!=)\s*['"]?([\w-]+)['"]?$/.exec(t);
    if(m)return (m[1]==="=="?"with the ":"not with the ")+(TOOL_WORDS[m[2]]||m[2])+" tool";
    m=/^focus\s*==\s*['"]?([\w-]+)['"]?$/.exec(t);
    if(m)return FOCUS_WORDS[m[1]]||"in the "+m[1]+" list";
    m=/^selection\.count\s*(>=|<=|==|>|<)\s*(\d+)$/.exec(t);
    if(m)return ({">":"more than ","<":"fewer than ",">=":"at least ","<=":"at most ","==":"exactly "})[m[1]]+m[2]+" selected";
    return t;
  }
  // "pcb && !placing" → "On boards, not placing". Grouped expressions are returned as written.
  function describeWhen(src){
    src=String(src??"").trim();if(!src)return "";
    if(src.includes("(")||src.includes(")"))return src;
    const alts=src.split("||").map(a=>{const terms=a.split("&&").map(s=>s.trim()).filter(Boolean);
      const ctx=terms.filter(x=>/^!?(pcb|schematic)$/.test(x)),rest=terms.filter(x=>!/^!?(pcb|schematic)$/.test(x));
      return [...ctx,...rest].map(describeTerm).join(", ");});
    const text=alts.join(" or ");return text.charAt(0).toUpperCase()+text.slice(1);
  }

  function open(api,I,ctx={}){
    const doc=globalThis.document,el=(tag,text,cls)=>AtriumNavCommon.elementIn(doc, tag, text, cls);
    const button=(text,fn,cls,label)=>{const n=el("button",text,cls);n.type="button";n.onclick=fn;if(label){n.title=label;n.setAttribute("aria-label",label);}return n;};
    const d=el("dialog",null,"work-dialog keymap-dialog");d.setAttribute("aria-label","Keyboard shortcuts editor");I.setOpen(d);
    const presetPick=el("select",null,"ui-field");presetPick.setAttribute("aria-label","Key map preset");
    for(const p of api.presets())presetPick.add(new Option(p.title,p.id));presetPick.value=I.presetName();
    presetPick.onchange=()=>{api.setPreset(presetPick.value);status("Preset: "+I.presetTitle(presetPick.value)+". Your own bindings still apply on top.");};
    const head=el("header",null,"km-head"),title=el("h2","Keyboard shortcuts");
    const done=button("Done",()=>d.close(),"km-done ui-button");done.dataset.variant="primary";
    head.append(title,presetPick,button("Import…",importKeys,"ui-button"),button("Export…",exportKeys,"ui-button"),button("Reset all",()=>{
      if(!I.userCount())return;if(globalThis.confirm&&!globalThis.confirm("Remove all of your key bindings and return to the preset?"))return;api.resetAll();status("All bindings reset to the preset.");},"ui-button"),
      done);
    const search=el("input",null,"ui-field");search.type="search";search.placeholder="Search by command, key or context";search.setAttribute("aria-label","Search shortcuts");
    const scope=el("select",null,"ui-field");scope.setAttribute("aria-label","Context");
    scope.add(new Option("All editors","all"));scope.add(new Option("Schematic","schematic"));scope.add(new Option("PCB layout","pcb"));
    const conflictsOnly=el("input",null,"ui-checkbox"),modifiedOnly=el("input",null,"ui-checkbox");conflictsOnly.type=modifiedOnly.type="checkbox";
    const conflictLabel=el("label",null,"km-check"),modifiedLabel=el("label",null,"km-check"),conflictCount=el("span");
    conflictLabel.append(conflictsOnly," Conflicts ",conflictCount);modifiedLabel.append(modifiedOnly," Modified");
    const tools=el("div",null,"km-tools");tools.append(AtriumUI.searchField(search,{cls:"km-find",type:true}),scope,conflictLabel,modifiedLabel);
    const note=el("p",null,"km-status");note.setAttribute("role","status");
    const grid=el("table",null,"km-table"),thead=el("thead"),body=el("tbody");
    const hr=el("tr");
    for(const h of ["Command","Keybinding","When","Source","Actions"]){
      const th=el("th");th.scope="col";th.append(el("span",h,h==="Actions"?"visually-hidden":""));hr.append(th);
    }
    thead.append(hr);grid.append(thead,body);
    const wrap=el("div",null,"km-scroll");wrap.append(grid);
    d.append(head,tools,note,wrap);
    AtriumShell.adoptDialog(d,{title,body:[tools,note,wrap],initialFocus:search});
    function status(t){note.textContent=t||"";}
    let recording=null;
    function issues(){
      const map=new Map();
      for(const c of api.conflicts())for(const side of [c.a,c.b]){const k=side.command+"\u0000"+side.key+"\u0000"+side.when;if(!map.has(k))map.set(k,[]);map.get(k).push(c);}
      return map;
    }
    function render(){
      const q=search.value.trim().toLowerCase(),kind=scope.value,problems=issues(),t=api.table();
      const spokenQuery=q.replace(/\bctrl\b/g,"control").replace(/\bcmd\b/g,"command");
      conflictCount.textContent="("+new Set([...problems.values()].flat()).size+")";
      body.replaceChildren();let category="",shown=0,keyQ="";
      if(q)try{keyQ=api.normalize(q).toLowerCase();}catch{}
      for(const cmd of api.commands()){
        const all=t.byCommand.get(cmd.id)||[],src=I.effective(cmd.id).source;
        if(modifiedOnly.checked&&src!=="user")continue;
        const recs=kind==="all"?all:all.filter(r=>api.kinds(r)[kind]);
        if(kind!=="all"&&!recs.length&&(all.length||cmd.when&&!cmd.when.includes(kind)))continue;
        const flagged=recs.map(r=>problems.get(cmd.id+"\u0000"+r.key+"\u0000"+r.when)||null);
        if(conflictsOnly.checked&&!flagged.some(Boolean))continue;
        const title=cmd.titles?.[kind]||cmd.title;
        if(q){
          const hay=[title,cmd.title,cmd.id,cmd.category,cmd.when,api.describeWhen(cmd.when),...recs.flatMap(r=>[r.key,api.display(r.key),api.display(r.key,true),r.when,api.describeWhen(r.when)])].filter(Boolean).join("  ").toLowerCase();
          if(!hay.includes(q)&&!hay.includes(spokenQuery)&&!(keyQ&&recs.some(r=>r.key.toLowerCase()===keyQ)))continue;
        }
        if(cmd.category!==category){category=cmd.category;const g=el("tr",null,"km-group"),th=el("th",category);th.colSpan=5;g.append(th);body.append(g);}
        body.append(row(cmd,recs,title,src,flagged));shown++;
      }
      if(!shown){const tr=el("tr"),td=el("td","No commands match.","km-empty");td.colSpan=5;tr.append(td);body.append(tr);}
    }
    // One row per command: each binding is a chip (click to re-record, × to remove); the
    // When column names each distinct context in words, with the expression in its tooltip.
    function row(cmd,recs,title,src,flagged){
      const tr=el("tr");tr.dataset.command=cmd.id;
      const name=el("td",null,"km-name");name.append(el("span",title),el("small",cmd.id));
      const keyCell=el("td",null,"km-key"),chips=el("div",null,"km-chips");
      recs.forEach((rec,n)=>{
        const expr=[cmd.when,rec.when].filter(Boolean).join(" && "),words=api.describeWhen(expr);
        const chip=el("span",null,"ui-chip ui-shortcut-chip"),keys=el("button",null,"ui-shortcut-edit");keys.type="button";
        keys.dataset.binding=String(rec.index);
        const spoken=api.display(rec.key,true);
        keys.append(AtriumShortcut.render(rec.key, {variant:"inline"}));
        keys.setAttribute("aria-label","Change "+spoken+" for "+title+(words?", "+words:""));
        keys.title=(words||"Always")+(expr?" ("+expr+")":"")+"\nClick to record a new key.";
        keys.onclick=()=>record(tr,keyCell,cmd,rec.index,rec);
        chip.append(keys,button("×",()=>{api.removeBinding(cmd.id,rec.index);status("Removed "+spoken+" from "+title+".");},"ui-chip-remove","Remove "+spoken+" for "+title));
        if(flagged[n]){const why=flagged[n].map(c=>c.message).join("\n");chip.dataset.invalid="true";keys.title=why+"\n"+keys.title;keys.setAttribute("aria-description",why);tr.classList.add("km-conflict");}
        chips.append(chip);
      });
      if(!recs.length)chips.append(el("span","Not set","ui-shortcut-none"));
      keyCell.append(chips);
      const whenCell=el("td",null,"km-when"),contexts=new Map();
      for(const rec of recs)if(!contexts.has(rec.when))contexts.set(rec.when,rec);
      if(!recs.length)whenCell.append(el("span",api.describeWhen(cmd.when)||"Always","km-ctx"));
      for(const [w,rec] of contexts){
        const expr=[cmd.when,w].filter(Boolean).join(" && ");
        const b=button(api.describeWhen(expr)||"Always",()=>editWhen(whenCell,cmd,rec),"km-ctx","Edit the context of "+api.display(rec.key,true)+": "+(expr||"always"));
        whenCell.append(b);
      }
      const srcCell=el("td",src==="user"?"User":src==="preset"?"Preset":"Default","km-src km-"+src);
      const act=el("td",null,"km-actions");
      const K=globalThis.AtriumUIKit,add=K.iconButton("plus","Add a key for "+title,{size:"sm",run:()=>record(tr,keyCell,cmd,-1,null)});
      add.classList.add("km-add");act.append(add);
      if(src==="user")act.append(K.iconButton("undo","Reset "+title,{size:"sm",run:()=>{api.resetCommand(cmd.id);status(title+" reset.");}}));
      tr.append(name,keyCell,whenCell,srcCell,act);return tr;
    }
    function record(tr,cell,cmd,index,rec){
      stopRecording();
      const chords=[],box=el("span",null,"ui-shortcut-recorder"),keysOut=el("span"),help=el("small");
      const title=cmd.titles?.[scope.value]||cmd.title;
      help.append("Press keys · ",AtriumShortcut.render("Enter")," to finish · ",AtriumShortcut.render("Escape")," to cancel");
      help.id="km-recording-help";
      box.setAttribute("role","group");box.setAttribute("aria-label","Recording a shortcut for "+title);box.setAttribute("aria-describedby",help.id);
      keysOut.setAttribute("aria-live","polite");
      box.append(keysOut,help);box.tabIndex=-1;cell.replaceChildren(box);tr.classList.add("km-active");box.focus();
      let timer=0;
      const finish=()=>{
        stopRecording();
        try{
          if(!chords.length){render();return;}
          const text=chords.join(" ");
          if(index>=0)api.replaceBinding(cmd.id,index,text,rec?.when);else api.addBinding(cmd.id,text,rec?.when??"");
          const mine=api.conflicts().filter(c=>c.a.command===cmd.id&&c.a.key===api.normalize(text)||c.b.command===cmd.id&&c.b.key===api.normalize(text));
          status((mine.length?"⚠ ":"")+title+": "+api.display(text,true)+(mine.length?". "+mine.map(c=>c.message).join(" "):"."));
        }catch(e){status(e.message);render();}
        finally{
          const current=[...body.querySelectorAll("tr[data-command]")].find(row=>row.dataset.command===cmd.id);
          const opener=current?.querySelector(index>=0?'[data-binding="'+index+'"]':".km-add");
          (opener||current?.querySelector(".km-add")||search).focus();
        }
      };
      const onKey=e=>{
        e.preventDefault();e.stopPropagation();
        if(e.key==="Escape"&&!e.ctrlKey&&!e.metaKey&&!e.altKey){chords.length=0;finish();return;}
        if(e.key==="Enter"&&chords.length&&!e.ctrlKey&&!e.metaKey&&!e.altKey&&!e.shiftKey){finish();return;}
        if(e.repeat)return;
        const c=api.chordFromEvent(e);if(!c)return;
        chords.push(c);keysOut.replaceChildren(AtriumShortcut.render(chords.join(" ")));
        clearTimeout(timer);
        // A chord with Ctrl/Cmd/Alt usually stands alone; plain keys wait for more of a sequence.
        timer=setTimeout(finish,chords.length>=4?0:/^(Mod|Ctrl|Alt|Meta)\+/.test(c)&&chords.length===1?900:1300);
      };
      d.addEventListener("keydown",onKey,true);
      recording={stop(){clearTimeout(timer);d.removeEventListener("keydown",onKey,true);tr.classList.remove("km-active");}};
    }
    function stopRecording(){if(recording){recording.stop();recording=null;}}
    function editWhen(cell,cmd,rec){
      const input=el("input");input.value=rec.when;input.placeholder="e.g. pcb && !placing";input.setAttribute("aria-label","Context for "+cmd.title);
      cell.replaceChildren(input);input.focus();
      input.onkeydown=e=>{
        if(e.key==="Enter"){e.preventDefault();e.stopPropagation();try{api.setWhen(cmd.id,rec.index,input.value);status("Context updated.");}catch(err){status(err.message);input.focus();}}
        else if(e.key==="Escape"){e.preventDefault();e.stopPropagation();render();}
      };
      input.onblur=()=>{if(input.isConnected)render();};
    }
    async function importKeys(){
      try{
        const file=ctx.pickFile?await ctx.pickFile([".waffle-keys",".json"]):await pick();
        if(!file)return;
        const problems=api.importJSON(typeof file==="string"?file:await file.text());
        presetPick.value=I.presetName();status(problems.length?"Imported with "+problems.length+" skipped: "+problems.join("; "):"Key bindings imported.");
      }catch(e){status("Import failed: "+e.message);}
    }
    function pick(){
      return new Promise(resolve=>{const f=el("input");f.type="file";f.accept=".waffle-keys,.json";f.hidden=true;d.append(f);
        f.addEventListener("change",()=>{resolve(f.files[0]||null);f.remove();},{once:true});f.addEventListener("cancel",()=>{resolve(null);f.remove();},{once:true});f.click();});
    }
    async function exportKeys(){
      const text=api.exportJSON(),name="keybindings.waffle-keys";
      try{
        if(ctx.exportFile)await ctx.exportFile(name,text);
        else{const a=el("a");a.href=URL.createObjectURL(new Blob([text],{type:"application/json"}));a.download=name;d.append(a);a.click();a.remove();setTimeout(()=>URL.revokeObjectURL(a.href),1000);}
        status("Exported "+name+".");
      }catch(e){status("Export failed: "+e.message);}
    }
    let pending=0;const later=()=>{clearTimeout(pending);pending=setTimeout(render,60);};
    search.oninput=later;scope.onchange=render;conflictsOnly.onchange=render;modifiedOnly.onchange=render;
    const off=api.onChange(()=>{if(!recording)render();});
    if(ctx.kind==="pcb"||ctx.kind==="schematic")scope.value=ctx.kind;
    if(ctx.query)search.value=ctx.query;
    d.addEventListener("close",()=>{stopRecording();off();clearTimeout(pending);I.setOpen(null);d.remove();ctx.onClose?.();});
    render();doc.body.append(d);d.showModal?.();
    return d;
  }
  return Object.freeze({open,describeWhen});
})();
