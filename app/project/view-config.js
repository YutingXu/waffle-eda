"use strict";

// View Configuration panel for the 2D board view, modelled on Altium's
// Ctrl+L panel: layers grouped as signal, mechanical and other layers with
// visibility, colors and opacity, system colors, object transparency and the
// single-layer mode. Colors persist through AtriumPCBAppearance; visibility
// edits the editor's own hidden-layer set so layer tabs and the inspector agree.
//
// ctx (all optional except hidden and redraw):
//   hidden       Set of hidden layer keys, or a function returning it
//   redraw()     called after any visibility change
//   layers       layer keys used by the board, or a function returning them
//   doc, defs    used to discover layers when `layers` is absent (or functions)
//   layer        current layer key, or a function returning it
//   layerMode    "all" | "dim" | "single", or a function returning it
//   setLayerMode(mode)   enables the single-layer mode control
//   changed(kind)        called after any change ("visibility", "color", ...)
globalThis.AtriumViewConfig=(()=>{
  const PCB=globalThis.AtriumPCBAppearance;
  let panel=null,ctx=null,tab="layers",picker=null,pickTarget=null;
  const value=v=>typeof v==="function"?v():v;
  const hiddenSet=()=>value(ctx?.hidden)||new Set();
  // Altium's standard non-copper layers, always listed like its layer stack.
  const standardOther=["Silk","Bottom silk","Top paste","Bottom paste","Top mask","Bottom mask","Drill guide","Keepout","Drill drawing","Multi"];
  const otherRank=new Map(standardOther.map((k,i)=>[k,i]));
  function discover(){
    const listed=value(ctx?.layers);
    const names=new Set(Array.isArray(listed)?listed:[]);
    const doc=value(ctx?.doc),defs=value(ctx?.defs);
    if(!Array.isArray(listed) && doc?.kind==="pcb"){
      if(globalThis.AtriumCanvas?.routingLayers)for(const k of AtriumCanvas.routingLayers(doc,defs||new Map()))names.add(k);
      const add=k=>{if(typeof k==="string"&&k)names.add(k);};
      const seen=new Set();
      for(const i of doc.items||[]){
        add(i.layer);
        if(i.kind==="part"&&defs&&!seen.has(i.def)){
          seen.add(i.def);const g=defs.get(i.def)?.footprint;
          for(const s of g?.shapes||[])add(PCB.shapeLayer(i,s));
          for(const p of g?.pads||[])add(PCB.padLayer(i,p));
        }
      }
      for(const r of doc.pcbDrawing?.pours||[])add(r.layer);
    }
    names.add("Top");names.add("Bottom");names.add("Mechanical");
    for(const k of standardOther)names.add(k);
    const groups={"Signal Layers":[],"Mechanical Layers":[],"Other Layers":[]};
    for(const k of names)(groups[PCB.group(k)]||groups["Other Layers"]).push(k);
    groups["Signal Layers"].sort((a,b)=>PCB.index(a)-PCB.index(b));
    const mech=k=>k==="Mechanical"?1:+(/\d+$/.exec(k)?.[0]||99);
    groups["Mechanical Layers"]=[...new Set(groups["Mechanical Layers"])].sort((a,b)=>mech(a)-mech(b));
    groups["Other Layers"].sort((a,b)=>(otherRank.get(a)??99)-(otherRank.get(b)??99)||a.localeCompare(b));
    // Large stacks (up to 128 copper layers): signal layers in groups of 16.
    const sig=groups["Signal Layers"];if(sig.length<=32)return groups;
    const out={};for(let i=0;i<sig.length;i+=16)out["Signal Layers L"+(i+1)+"–L"+Math.min(sig.length,i+16)]=sig.slice(i,i+16);
    delete groups["Signal Layers"];return Object.assign(out,groups);
  }
  function el(tag,cls,text){ return AtriumNavCommon.classedElement(document, tag, cls, text); }
  // Icon-bank style: 24-unit grid, 1.6 stroke, round caps, currentColor (the .icon class).
  const EYE_PATH='<path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12Z"/>';
  const EYE='<svg class="icon" viewBox="0 0 24 24" aria-hidden="true">'+EYE_PATH+'<circle cx="12" cy="12" r="2.8"/></svg>';
  const EYE_OFF='<svg class="icon" viewBox="0 0 24 24" aria-hidden="true"><g opacity=".45">'+EYE_PATH+'</g><path d="m4 20 16-16"/></svg>';
  function notify(kind){
    try{ctx?.changed?.(kind);}catch{}
    try{ctx?.redraw?.();}catch{}
  }
  function setHidden(keys,hide){
    const hidden=hiddenSet();
    for(const k of keys){if(hide)hidden.add(k);else hidden.delete(k);}
    notify("visibility");render();
  }
  function eye(keys,label){
    const hidden=hiddenSet(),shown=keys.some(k=>!hidden.has(k));
    const b=el("button","vc-eye");b.type="button";b.innerHTML=shown?EYE:EYE_OFF;
    b.setAttribute("aria-pressed",String(shown));b.title=(shown?"Hide ":"Show ")+label;b.setAttribute("aria-label",b.title);
    b.onclick=()=>setHidden(keys,shown);
    return b;
  }
  function choose(current,apply,label,anchor){
    if(!picker){
      picker=el("input","vc-picker");picker.type="color";picker.tabIndex=-1;picker.setAttribute("aria-hidden","true");
      picker.addEventListener("input",()=>pickTarget?.(picker.value));
      picker.addEventListener("change",()=>{pickTarget?.(picker.value);render();});
      document.body.append(picker);
    }
    picker.value=current;picker.title=label;pickTarget=apply;
    // The native color popup opens beside its input, so park it on the swatch.
    const r=anchor?.getBoundingClientRect?.();
    if(r){picker.style.left=r.left+"px";picker.style.top=r.bottom+"px";}
    try{picker.showPicker?picker.showPicker():picker.click();}catch{picker.click();}
  }
  function swatch(ink,apply,label,custom){
    const b=el("button","vc-swatch"+(custom?" custom":""));b.type="button";b.style.setProperty("--swatch", ink);
    b.title="Change color of "+label+" ("+ink.toUpperCase()+")";b.setAttribute("aria-label",b.title);
    b.onclick=()=>choose(ink,apply,label,b);
    return b;
  }
  function section(parent,title,keys){
    const box=el("section","vc-group"),head=el("div","vc-group-head");
    const open=el("button","vc-disclose",title);open.type="button";open.setAttribute("aria-expanded","true");
    const list=el("div","vc-rows");
    open.onclick=()=>{const on=open.getAttribute("aria-expanded")!=="true";open.setAttribute("aria-expanded",String(on));list.hidden=!on;};
    if(keys?.length)head.append(eye(keys,title.toLowerCase()));else head.append(el("span","vc-eye-space"));
    head.append(open);box.append(head,list);parent.append(box);
    return list;
  }
  function layerRow(list,k,current){
    const hidden=hiddenSet(),row=el("div","vc-row"+(hidden.has(k)?" off":"")+(k===current?" current":""));
    row.dataset.layer=k;
    row.append(eye([k],PCB.name(k)),swatch(PCB.color(k),v=>{if(PCB.setColor(k,v))notify("color");},PCB.name(k),PCB.isCustom(k)),
      el("span","vc-name",PCB.name(k)));
    if(k===current)row.append(el("small","vc-tag","Current"));
    row.append(layerAlpha(k));
    list.append(row);
  }
  // Layer opacity, multiplied by the object-kind transparency (View Options). Stored with the colours.
  function layerAlpha(k){
    const v=Math.round((PCB.layerAlpha?PCB.layerAlpha(k):1)*100),label=PCB.name(k)+" opacity";
    const input=el("input","vc-alpha"+(v<100?" custom":""));input.type="range";input.min="0";input.max="100";input.step="5";input.value=String(v);
    input.setAttribute("aria-label",label);input.title=label+": "+v+"%";
    input.oninput=()=>{if(PCB.setLayerOpacity?.(k,+input.value/100)){input.title=label+": "+input.value+"%";input.classList.toggle("custom",+input.value<100);notify("opacity");}};
    input.ondblclick=()=>{input.value="100";input.oninput();};
    return input;
  }
  function layersTab(body){
    const groups=discover(),current=value(ctx?.layer);
    for(const [title,keys] of Object.entries(groups)){
      if(!keys.length)continue;
      const list=section(body,title,keys);
      for(const k of keys)layerRow(list,k,current);
    }
    const sys=section(body,"System Colors");
    for(const [key,label] of Object.entries(PCB.systemNames)){
      const row=el("div","vc-row");
      row.append(el("span","vc-eye-space"),swatch(PCB.system[key],v=>{if(PCB.setSystem(key,v))notify("system");},label,PCB.isCustomSystem?PCB.isCustomSystem(key):PCB.system[key]!==PCB.defaultSystem[key]),el("span","vc-name",label));
      sys.append(row);
    }
  }
  function optionsTab(body){
    if(typeof ctx?.setLayerMode==="function"){
      const list=section(body,"General Settings"),row=el("div","vc-field");
      row.append(el("span","vc-name","Single Layer Mode"));
      const seg=el("div","vc-segment ui-segmented vc-layer-mode"),mode=value(ctx.layerMode)||"all";
      for(const [m,label,tip] of [["all","Off","Show all layers"],["dim","Monochrome","Other layers in monochrome"],["single","Hide","Hide other layers"]]){
        const b=el("button","ui-segment",label);b.type="button";b.dataset.size="sm";b.dataset.layerHelp=tip;b.setAttribute("aria-pressed",String(m===mode));
        b.onclick=()=>{ctx.setLayerMode(m);notify("mode");render();};seg.append(b);
      }
      row.append(seg);list.append(row);
      layerModeShortcuts();
    }
    const list=section(body,"Object Visibility");
    const doc=value(ctx?.doc);
    for(const [key,label,layer] of [["track","Tracks"],["pad","Pads"],["via","Vias"],["pour","Polygons","Source pours"]]){
      const row=el("div","vc-field vc-slider");
      if(layer && doc?.pcbDrawing?.pours?.length)row.append(eye([layer],label.toLowerCase()));else row.append(el("span","vc-eye-space"));
      const caption=el("span","vc-name",label);caption.id="vc-opacity-"+key;row.append(caption);
      const input=el("input");input.type="range";input.min="0";input.max="100";input.step="5";
      input.value=String(Math.round(PCB.opacity[key]*100));input.setAttribute("aria-label",label+" opacity");
      const out=el("output","vc-value",input.value+"%");out.setAttribute("aria-labelledby",caption.id);
      input.oninput=()=>{PCB.setOpacity(key,+input.value/100);out.textContent=input.value+"%";notify("opacity");};
      row.append(input,out);list.append(row);
    }
    themeSection(body);
  }
  // Canvas colours and the UI theme: the theme can supply system colours (a black
  // workspace in high contrast); this switch keeps the standard palette instead.
  function layerModeShortcuts(){
    if(!panel || panel.hidden)return;
    const key=globalThis.AtriumKeymap?.hintKey("layer-mode","pcb");
    for(const b of panel.querySelectorAll(".vc-layer-mode button"))
      AtriumNavCommon.shortcutTitle(b,b.dataset.layerHelp,key," cycles");
  }
  globalThis.AtriumKeymap?.onChange(layerModeShortcuts);

  function themeSection(body){
    const T=globalThis.AtriumTheme;if(!T?.get)return;
    const list=section(body,"Theme"),row=el("div","vc-field");
    row.append(el("span","vc-name","Canvas colours"));
    const seg=el("div","vc-segment ui-segmented"),follow=T.get().canvas.follow;
    for(const [on,label,tip] of [[true,"Follow theme","System colours follow the UI theme"],[false,"Standard","Keep the standard canvas palette in every theme"]]){
      const b=el("button","ui-segment",label);b.type="button";b.dataset.size="sm";b.title=tip;b.setAttribute("aria-pressed",String(on===follow));
      b.onclick=()=>{try{T.set({canvas:{follow:on}});}catch{}notify("theme");render();};seg.append(b);
    }
    row.append(seg);list.append(row);
    const more=el("div","vc-field"),open=el("button","vc-reset ui-button","Appearance preferences…");open.type="button";
    open.onclick=()=>T.open?.();more.append(open);list.append(more);
  }
  // Theme changes move system colours under an open panel; show them.
  PCB.onChange?.(kind=>{if(kind==="theme"&&panel&&!panel.hidden)render();});
  let lastSignature="";
  function signature(){
    const layers=value(ctx?.layers),doc=value(ctx?.doc);
    return [...hiddenSet()].sort().join("|")+"/"+value(ctx?.layer)+"/"+value(ctx?.layerMode)+"/"+
      (Array.isArray(layers)?layers.join("|"):"")+"/"+(doc?.id||"")+"/"+(doc?.items?.length??"");
  }
  function render(){
    if(!panel)return;
    lastSignature=signature();
    const body=panel.querySelector(".vc-body"),scroll=body.scrollTop;
    body.replaceChildren();
    for(const b of panel.querySelectorAll(".vc-tabs button")){
      const selected=b.dataset.tab===tab;
      b.setAttribute("aria-selected",String(selected));b.tabIndex=selected?0:-1;
      if(selected)body.setAttribute("aria-labelledby",b.id);
    }
    if(tab==="layers")layersTab(body);else optionsTab(body);
    body.scrollTop=scroll;
  }
  function build(){
    panel=el("div","vc-panel ui-popover");panel.dataset.anchor="right";
    panel.setAttribute("role","dialog");panel.setAttribute("aria-labelledby","vc-title");
    const head=el("div","vc-head");
    const title=el("span","vc-title","View Configuration");title.id="vc-title";head.append(title);
    const close=el("button","ui-button ui-close vc-close","×");close.type="button";close.dataset.variant="quiet";close.dataset.size="sm";AtriumNavCommon.shortcutTitle(close,"Close","Escape");close.setAttribute("aria-label","Close View Configuration");
    close.onclick=()=>api.close();head.append(close);
    const tabs=el("div","vc-tabs ui-tabs");tabs.dataset.strip="";tabs.setAttribute("role","tablist");tabs.setAttribute("aria-labelledby",title.id);
    for(const [id,label] of [["layers","Layers & Colors"],["options","View Options"]]){
      const b=el("button","ui-tab",label);b.type="button";b.dataset.tab=id;b.setAttribute("role","tab");
      b.id="vc-tab-"+id;b.setAttribute("aria-controls","vc-tab-panel");
      b.onclick=()=>{tab=id;render();};tabs.append(b);
    }
    tabs.addEventListener("keydown",e=>{
      const index=[...tabs.children].indexOf(e.target);
      if(index<0 || !["ArrowLeft","ArrowRight","Home","End"].includes(e.key))return;
      e.preventDefault();e.stopPropagation();
      const next=e.key==="Home"?tabs.firstElementChild:e.key==="End"?tabs.lastElementChild:tabs.children[1-index];
      next.click();next.focus({preventScroll:true});
    });
    const body=el("div","vc-body");body.id="vc-tab-panel";body.setAttribute("role","tabpanel");
    const foot=el("div","vc-foot"),reset=el("button","vc-reset ui-button","Reset to Altium®-style defaults");reset.type="button";
    reset.title="Restore the Altium-style default layer colors and transparency, and the theme's system colors";
    reset.onclick=()=>{PCB.reset();notify("reset");render();};
    foot.append(reset);
    panel.append(head,tabs,body,foot);
    panel.addEventListener("keydown",e=>{if(e.key==="Escape"&&!e.isComposing){e.preventDefault();e.stopPropagation();api.close();}});
    // Drag by the title bar, like a floating Altium panel.
    head.addEventListener("pointerdown",e=>{
      if(e.target.closest("button"))return;
      const r=panel.getBoundingClientRect(),dx=e.clientX-r.left,dy=e.clientY-r.top;
      head.setPointerCapture?.(e.pointerId);
      const move=m=>{
        panel.style.left=Math.max(0,Math.min(innerWidth-60,m.clientX-dx))+"px";
        panel.style.top=Math.max((parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--window-caption-height")) || 0),Math.min(innerHeight-40,m.clientY-dy))+"px"; // below the title barpanel.style.right="auto";
      };
      const up=()=>{head.removeEventListener("pointermove",move);head.removeEventListener("pointerup",up);};
      head.addEventListener("pointermove",move);head.addEventListener("pointerup",up);
    });
    document.body.append(panel);
  }
  function showPanel(open) {
    const surface=globalThis.AtriumSurfaceMotion;
    if(surface)surface.popover(panel,open);
    else panel.hidden=!open;
  }
  const api={
    open(next){
      ctx=next||ctx||{};
      if(!panel)build();
      showPanel(true);
      render();
      panel.querySelector(".vc-tabs button[aria-selected=true]")?.focus({preventScroll:true});
      return panel;
    },
    close(){if(panel){const inside=panel.contains(document.activeElement);showPanel(false);if(inside)globalThis.AtriumNavHost?.canvas?.()?.focus();try{ctx?.closed?.();}catch{}}},
    toggle(next){return api.isOpen()?api.close():api.open(next);},
    isOpen:()=>!!panel && !panel.hidden,
    // Re-read visibility, layers and colors, e.g. after the active document,
    // layer or layer mode changes in the editor.
    // Cheap when nothing it shows has changed, so callers may run it on every
    // editor sync.
    refresh(next){
      if(next)ctx=next;
      if(!api.isOpen())return;
      if(signature()!==lastSignature)render();
    }
  };
  return Object.freeze(api);
})();
