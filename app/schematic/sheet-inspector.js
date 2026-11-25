"use strict";

globalThis.AtriumSheetInspector = (() => {
  // Inspector controls for a native sheet's template. `apply(fn)` is the editor's
  // undoable edit; every change goes through it. Blank fields fall back to defaults.
  const PARAMETERS={
    standard:[["Title","Title"],["DocumentNumber","Number"],["Revision","Revision"],["DrawnBy","Drawn by"],["CompanyName","Company"]],
    ansi:[["Title","Title"],["DocumentNumber","Drawing number"],["Revision","Revision"],["CompanyName","Company"],["CAGE","FSCM / CAGE code"],
      ["Scale","Scale"],["DrawnBy","Drawn by"],["DrawnDate","Drawn date"],["CheckedBy","Checked by"],["CheckedDate","Checked date"],
      ["ApprovedBy","Approved by"],["ApprovedDate","Approved date"]]
  };
  function fill(container,doc,apply,project,{plain,count,inch}){
    const {sheetOf, sheetSizes, resolveSpecialStrings} = globalThis.AtriumSchAppearance;
    const node=(tag,text,cls)=>AtriumNavCommon.el(tag, text, cls);
    const source=doc.schDrawing||doc.schRestored?.sheet;
    const current=sheetOf(doc);
    const change=fn=>apply(()=>{if(!plain(doc.sheet))doc.sheet={};fn(doc.sheet);});
    function row(label,input){const l=node("label",null,"field-row");l.append(node("span",label),input);input.setAttribute("aria-label",label);container.append(l);return input;}
    function choice(label,options,value,update){
      const s=node("select");
      for(const [group,rows] of options){
        const parent=group?node("optgroup"):s;if(group){parent.label=group;s.append(parent);}
        for(const [v,t] of rows)parent.append(new Option(t,v));
      }
      s.value=value;s.onchange=()=>change(sheet=>update(sheet,s.value));return row(label,s);
    }
    const measure=s=>s.family==="ISO"?s.width+" × "+s.height+" mm":+(s.width/inch).toFixed(2)+" × "+(+(s.height/inch).toFixed(2))+" in";
    const families=["ISO","ANSI","Altium","OrCAD"].map(f=>[f==="Altium"||f==="OrCAD"?f+"®-style legacy sizes":f,sheetSizes.filter(s=>s.family===f).map(s=>[s.name,(s.name.startsWith(f+" ")?s.label+" ("+f+" legacy size)":s.name)+" · "+measure(s)])]);
    const infiniteChoice=[null,[["none","None (infinite)"]]];
    const sizes=source?[[null,[["source","Source sheet · "+Number(source.width.toFixed(2))+" × "+Number(source.height.toFixed(2))+" mm"]]],infiniteChoice]:[...families,infiniteChoice];
    choice("Sheet size",sizes,source&&current.size!=="none"?"source":current.size,(sheet,v)=>{
      if(v==="none"){sheet.infinite=true;return;}
      delete sheet.infinite;
      if(v!=="source"){sheet.size=v;delete sheet.zones;}
    });
    if(source&&current.size!=="none"){
      container.append(node("p","This sheet keeps the frame and title block of its source document.","side-note"));return;
    }
    if(current.size!=="none")choice("Orientation",[[null,[["landscape","Landscape"],["portrait","Portrait"]]]],current.orientation,(sheet,v)=>{sheet.orientation=v;delete sheet.zones;});
    choice("Title block",[[null,[["standard","Standard (Altium®-style)"],["ansi","ANSI (ASME Y14.1)"],["none","None"]]]],current.titleBlock,(sheet,v)=>{sheet.titleBlock=v;});
    if(current.size!=="none")for(const [axis,label,max] of [["x","Zones across",32],["y","Zones down",26]]){
      const input=node("input");input.type="number";input.min="1";input.max=String(max);input.step="1";
      const given=plain(doc.sheet?.zones)?count(doc.sheet.zones[axis],max):null;
      input.value=given?String(given):"";input.placeholder=String(axis==="x"?current.zonesX:current.zonesY);
      input.onchange=()=>{
        const v=input.value.trim()===""?null:Number(input.value);
        if(v!=null&&!count(v,max)){input.value=given?String(given):"";return;}
        change(sheet=>{const z=plain(sheet.zones)?sheet.zones:{};if(v==null)delete z[axis];else z[axis]=v;
          if(Object.keys(z).length)sheet.zones=z;else delete sheet.zones;});
      };
      row(label,input);
    }
    if(current.titleBlock==="none")return;
    container.append(node("p","Title block values. Use =Name to insert another parameter.","side-note"));
    for(const [name,label] of PARAMETERS[current.titleBlock]){
      const input=node("input");input.type="text";input.value=current.params[name]??"";input.spellcheck=false;
      input.placeholder=resolveSpecialStrings("="+name,project,doc,{missing:"",sheetParams:false});
      input.onchange=()=>{const v=input.value;change(sheet=>{const params=plain(sheet.params)?sheet.params:{};
        if(v==="")delete params[name];else params[name]=v;if(Object.keys(params).length)sheet.params=params;else delete sheet.params;});};
      row(label,input);
    }
  }

  return {fill};
})();
