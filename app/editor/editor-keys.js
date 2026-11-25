"use strict";

// Accelerator letters are separate keystrokes. Keep their state until a command,
// an unrelated key, a pointer interaction, or a change of editor resolves them.
globalThis.AtriumEditorKeys = (() => {
  const KM=globalThis.AtriumKeymap,PRINT=new Set(["print","export-pdf"]);
  const isForm=el=>!!(el?.isContentEditable||el?.closest?.("input,textarea,select,[contenteditable=true],[contenteditable=plaintext-only],[role=textbox]"));
  // Dispatch runs through AtriumKeymap's compiled table: one Map lookup per key, then the
  // first binding whose context passes. A live sequence prefix wins over a single key.
  function create(run,hint,passThrough=null){
    let prefix=null,owner=null,ownerTable=null;
    const {MODS,MODIFIER,SPACE,ESCAPE}=KM;
    function clear(){
      if(prefix){prefix=null;owner=null;ownerTable=null;hint("");}
    }
    function fire(e,rec){
      clear();
      if(passThrough?.(e,rec.command))return true;
      e.preventDefault();
      if(!e.repeat || rec.repeatable)KM.invoke(rec,run);
      return true;
    }
    function invokeLead(rec,n,s,canvas){
      const next=globalThis.AtriumKeymapPresets?.continuation(rec,n,s,canvas,hint);
      KM.invoke(rec,(action,param)=>run(action,param,next));
    }
    function begin(e,s,canvas,n,t){
      e.preventDefault();
      if(!e.repeat){prefix=n;owner=s.documentId;ownerTable=t;hint(KM.hintText(n,s,canvas));
        const lead=KM.leadOf?.(n,s,canvas);if(lead)invokeLead(lead,n,s,canvas);}
      return true;
    }
    function formBinding(e,s,t,k){
      if(k<0)return null;
      const n=t.root.get(k*16+KM.eventMask(e,k));
      if(n)for(const rec of n.bindings)if((PRINT.has(rec.command.action)||!s.modal&&rec.inForms)&&rec.test(s,false))return {n,rec};
      return null;
    }
    // Preserve normal text editing while a saved preset loads. Possible in-form shortcuts
    // include a saved custom binding and the primary modified letters used by other presets.
    function waitsForPreset(e,s){
      if(e.defaultPrevented||e.isComposing||e.key==="Process"||!e.key)return false;
      const k=KM.eventKey(e);
      if(k<0)return false;
      if(s.modal||isForm(e.target)){
        if(formBinding(e,s,KM.table(),k))return true;
        return !s.modal&&(e.metaKey||!KM.mac&&e.ctrlKey)&&!e.altKey&&/^[a-z]$/i.test(e.key)&&!/[acvxyz]/i.test(e.key);
      }
      const m=KM.eventMask(e,k),canvas=!!(s.canvas||e.target?.tagName==="BODY");
      if(k===SPACE&&!canvas&&e.target?.closest?.("button,summary,[role=button]"))return false;
      // Let native controls keep their focus and activation keys unless the map owns them.
      const tab=e.key==="Tab"&&!(m&MODS)&&!s.canProperties&&!s.tuning&&!s.dragging&&!s.sticky;
      const activate=k===KM.ENTER&&!canvas&&e.target?.closest?.("a[href],button,summary,[role=button],[role^=menuitem]");
      if(!tab&&!activate)return true;
      const n=KM.table().root.get(k*16+m);
      return !!n&&KM.live(n,s,canvas);
    }
    function sameBindings(before,after){
      return before.length===after.length&&before.every((a,i)=>{
        const b=after[i];
        return a.command===b.command&&a.key===b.key&&a.when===b.when&&a.source===b.source&&
          a.anyShift===b.anyShift&&a.lead===b.lead;
      });
    }
    function handle(e,s){
      if(e.defaultPrevented || e.isComposing || e.key==="Process" || !e.key)return false;
      const t=KM.table(),k=KM.eventKey(e);
      if(s.modal || isForm(e.target)){
        clear();
        // Save commits the active inspector field. Text editing retains native undo/clipboard handling.
        // Print also runs over dialogs and fields: it prints the dialog's report (editor.js printTarget).
        const found=formBinding(e,s,t,k);
        if(found){
          const {n,rec}=found;
          e.preventDefault();
          if(!e.repeat){if(rec.lead&&KM.isPrefix(n,s,false))invokeLead(rec,n,s,false);else KM.invoke(rec,run);}
          return true;
        }
        return false;
      }
      if(k===MODIFIER)return false;
      const m=k>=0?KM.eventMask(e,k):0,canvas=!!(s.canvas || e.target?.tagName==="BODY");
      if(owner!==s.documentId)clear();
      else if(prefix&&ownerTable!==t){
        // Optional commands may register between two strokes. Keep an active prefix when
        // the selected bindings are unchanged, and look up continuations in the new table.
        const current=ownerTable.bindingRevision===t.bindingRevision&&
          prefix.path.reduce((at,chord)=>at?.children?.get(chord),t.rootNode);
        if(current&&KM.isPrefix(current,s,canvas)&&sameBindings(prefix.any,current.any)){prefix=current;ownerTable=t;}
        else clear();
      }
      if(prefix){
        if(e.repeat && !e.shiftKey && !(m&MODS)){e.preventDefault();return true;}
        const child=k>=0&&prefix.children.get(k*16+m);
        if(child && KM.live(child,s,canvas)){
          if(KM.isPrefix(child,s,canvas))return begin(e,s,canvas,child,t);
          const rec=KM.firstPass(child.bindings,s,canvas);
          if(rec)return fire(e,rec);
        }
        if(k===ESCAPE && !(m&MODS)){clear();e.preventDefault();if(!e.repeat)run("prefix-cancel");return true;}
        // Other modified keys end the sequence; an unrelated letter is swallowed; a shifted
        // key (or one such as ? that implies Shift) falls through with the sequence pending.
        if(m&MODS)clear();
        else if(!e.shiftKey && !KM.impliesShift(k)){clear();if(e.key.length===1){e.preventDefault();return true;}}
      }
      if(k<0)return false;
      if(k===SPACE && !canvas && e.target?.closest?.("button,summary,[role=button]"))return false;
      const n=t.root.get(k*16+m);
      if(!n)return false;
      if(KM.isPrefix(n,s,canvas))return begin(e,s,canvas,n,t);
      const rec=KM.firstPass(n.bindings,s,canvas);
      return rec?fire(e,rec):false;
    }
    return {clear,handle,waitsForPreset};
  }
  let pendingDialog=0;
  function showDialog(open){
    const request=++pendingDialog,host=globalThis.AtriumNavHost,doc=host?.doc?.();
    const ready=globalThis.AtriumEditorKeyDialogs;
    if(ready)return open(ready);
    return globalThis.AtriumLazy?.need("AtriumEditorKeyDialogs").then(ui=>{
      if(request===pendingDialog&&doc===host?.doc?.())open(ui);
    },e=>host?.info?.(e.message));
  }
  const gridPicker=(current,customFirst,apply,opt={})=>showDialog(ui=>ui.gridPicker(current,customFirst,apply,opt));
  return {create,gridPicker};
})();
