"use strict";

// These sections are populated when their disclosure is first opened in Properties.
globalThis.AtriumDocumentInspector = (() => {
  const t=globalThis.AtriumI18n?.define({"props.hop_over_wire_crossings":"Hop-over wire crossings"});
  function layers(s,{d,defs,view,hidden,availableCopper,btn,el,toggle}){
      const layers=new Set([...availableCopper(),"Silk","Mechanical"]);
      for(const i of d.items){if(i.layer&&i.layer!=="Multi")layers.add(i.layer);if(i.kind==="part"){const g=defs.get(i.def)?.footprint;for(const p of [...(g?.shapes||[]),...(g?.pads||[])])if(p.layer&&p.layer!=="Multi")layers.add(p.layer);}}
      for(const k of layers){const b=btn(null,()=>toggle(k,true),"layer-row");b.setAttribute("aria-pressed",String(!hidden.has(k)));b.title=(hidden.has(k)?"Show ":"Hide ")+k;const sw=el("i",null,"layer-dot");sw.style.setProperty("--swatch", globalThis.AtriumPCBAppearance?.color(k)||"#888");b.append(sw,el("span",({Top:"Top copper",Bottom:"Bottom copper",Silk:"Silkscreen"})[k]||k),el("small",hidden.has(k)?"Hidden":"Visible"));s.append(b);}
      const state=view.pourState(d,defs);
      if(state!=="none"){
        const key="Source pours",visible=state==="source"&&!hidden.has(key);
        const visibility=btn(null,()=>toggle(key,false),"layer-row pour-visibility");
        visibility.disabled=state==="stale";visibility.setAttribute("aria-pressed",String(visible));
        visibility.append(el("span",key),el("small",state==="stale"?"Needs repour":visible?"Visible":"Hidden"));s.append(visibility);
      }
  }
  function connectivity(s,showUnrouted,el,btn){
    const actions=el("div",null,"inspect-actions");
      const toggle=btn("Unrouted connections","unrouted");toggle.setAttribute("aria-pressed",String(showUnrouted));
      actions.append(btn("Inspect","connectivity"),toggle);s.append(actions);
  }
  function settings(s,{d,project,pcb,field,edit,unitLabel,btn,el,outlineDialog}){
      const units=Atrium.units, {min}=units.gridLimits(d.kind);
      const minimum=pcb?units.format(min,"mm"):"1mil (0.0254mm)";
      field(s,"Name",d.name,v=>edit(()=>d.name=v));
      field(s,unitLabel("Grid"),d.grid,v=>edit(()=>d.grid=v),{length:true,min,minMessage:"The snap grid must be at least "+minimum+"."});
      if(pcb&&d.outline.length)s.append(btn("Edit perimeter",()=>outlineDialog(d)));
      if(!pcb&&globalThis.AtriumSchAppearance?.sheetSettings)AtriumSchAppearance.sheetSettings(s,d,edit,project);
      if(!pcb){
        const label=el("label",null,"field-row"),hops=el("input");
        const name=t?t("props.hop_over_wire_crossings"):"Hop-over wire crossings";
        hops.type="checkbox";hops.checked=!!d.hopOvers;hops.setAttribute("aria-label",name);
        hops.onchange=()=>edit(()=>{if(hops.checked)d.hopOvers=true;else delete d.hopOvers;});
        label.append(el("span",name),hops);s.append(label);
      }
  }
  function netList(s,{d,pcb,nets,highlight,setHighlight,field,row}){
    const names=pcb?[...new Set(d.items.flatMap(i=>[i.net,...Object.values(i.pinNets||{})]).filter(Boolean))]:nets().nets.map(n=>n.name);
      if(names.length)field(s,"Highlight",highlight||"None",v=>setHighlight(v==="None"?"":v),{values:["None",...names.sort()]});else row(s,"Nets","0");
  }
  return {layers,connectivity,settings,netList};
})();
