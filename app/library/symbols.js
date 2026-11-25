"use strict";
globalThis.AtriumSymbols = (() => {
  const families = new Set(["resistor", "capacitor"]);
  const choices = {
    resistor: [["source","Library drawing"],["iec","IEC rectangle"],["ansi","ANSI zigzag"]],
    capacitor: [["source","Library drawing"],["parallel","Parallel plates"]]
  };
  const options = [["","Keep library drawing"],["resistor","Resistor"],["capacitor","Non-polar capacitor"]];
  function keyFor(def) {
    // Component instances of the same source library symbol can have different
    // geometry and IDs across documents. Each adapts to its own pin endpoints.
    const template = def.catalogueId || def.id;
    if (!def.sourceName && ["std-r","std-c"].includes(template)) return template;
    return JSON.stringify([def.name.trim().toLowerCase(),(def.prefix || "").trim().toUpperCase()]);
  }
  function preferences(project) {
    const stored = project.symbolPreferences || {};
    const mapped = new Map([["std-r","resistor"],["std-c","capacitor"]]);
    for (const row of Array.isArray(stored.mappings) ? stored.mappings : []) {
      if (Array.isArray(row) && typeof row[0] === "string" && (row[1] === "" || families.has(row[1]))) mapped.set(row[0],row[1]);
    }
    const preset = kind => choices[kind].some(([value]) => value === stored[kind]) ? stored[kind] : "source";
    return {resistor:preset("resistor"),capacitor:preset("capacitor"),mappings:[...mapped]};
  }
  function incompatibility(symbol, family) {
    const pins=symbol.pins;
    if (pins.length !== 2) return "requires exactly two pins";
    if (pins.some(p=>!String(p.number).trim()) || pins[0].number===pins[1].number) return "requires two distinct pin numbers";
    if (pins.some(p=>p.hidden)) return "contains a hidden pin";
    if (pins.some(p=>p.electrical!=null && p.electrical!==4)) return "contains an electrically active pin";
    if (family==="capacitor" && pins.some(p=>/^(\+|-|−|pos(itive)?|neg(ative)?|anode|cathode)$/i.test(String(p.name||"").trim()) ||
      /^(\+|-|−)$/.test(p.number))) return "has marked polarity";
    const [[x1,y1],[x2,y2]]=pins.map(p=>[p.x,p.y]);
    if (![x1,y1,x2,y2].every(Number.isFinite) || Math.hypot(x2-x1,y2-y1)<0.01) return "has overlapping or invalid pin positions";
    return "";
  }
  function drawing(symbol, style) {
    const [a,b]=symbol.pins;
    const span=Math.hypot(b.x-a.x,b.y-a.y), c=(b.x-a.x)/span, s=(b.y-a.y)/span;
    const cx=(a.x+b.x)/2, cy=(a.y+b.y)/2, factor=Math.min(1,span/7.62);
    const map=([x,y])=>[cx+factor*(x*c-y*s),cy+factor*(x*s+y*c)];
    const path=(points,closed=false,fill=false,role="body")=>({kind:"path",style:role,points,closed,fill});
    const shape=(points,closed=false,fill=false)=>path(points.map(map),closed,fill);
    const edge=style==="parallel" ? .54 : 2.54;
    // Leads are pins: Altium draws them black, apart from the navy device artwork.
    const leads=[path([[a.x,a.y],map([-edge,0])],false,false,"pin"),path([map([edge,0]),[b.x,b.y]],false,false,"pin")];
    if (style==="parallel") return [...leads,shape([[-edge,-1.85],[-edge,1.85]]),shape([[edge,-1.85],[edge,1.85]])];
    if (style==="iec") return [...leads,shape([[-edge,-.95],[edge,-.95],[edge,.95],[-edge,.95]],true)];
    const zig=[[-edge,0]];
    for(let n=0;n<6;n++)zig.push([-edge+(n+.5)*2*edge/6,n%2?.93:-.93]);
    return [...leads,shape([...zig,[edge,0]])];
  }
  function applyPreferences(project,settings) {
    if(!settings && !project.symbolPreferences)return {changed:0,skipped:[]};
    const chosen=preferences({symbolPreferences:settings || project.symbolPreferences});
    const mapped=new Map(chosen.mappings), skipped=new Set();
    let changed=0;
    for(const def of project.library){
      if(!def.symbol)continue;
      const family=mapped.get(keyFor(def)),style=family?chosen[family]:"source";
      if(!style || style==="source"){
        if(def.sourceSymbolShapes){
          def.symbol={...def.symbol,shapes:def.sourceSymbolShapes};
          delete def.sourceSymbolShapes;changed++;
        }
        continue;
      }
      const why=incompatibility(def.symbol,family);
      if(why){skipped.add(def.name+" — "+why);continue;}
      const shapes=drawing(def.symbol,style);
      if(JSON.stringify(def.symbol.shapes)===JSON.stringify(shapes))continue;
      if(!def.sourceSymbolShapes)def.sourceSymbolShapes=def.symbol.shapes;
      def.symbol={...def.symbol,shapes};
      changed++;
    }
    project.symbolPreferences=chosen;
    return {changed,skipped:[...skipped]};
  }
  function open(ctx) {
    const {project,edit,info}=ctx, prefs=preferences(project), mapped=new Map(prefs.mappings);
    const node=(tag,text)=>AtriumNavCommon.el(tag, text);
    function dropdown(values,value,label,update) {
      const s=node("select");s.setAttribute("aria-label",label);
      for(const [v,t] of values)s.add(new Option(t,v));
      s.value=value;s.onchange=()=>update(s.value);
      return s;
    }
    const dialog=node("dialog");dialog.className="work-dialog symbol-styles-dialog";dialog.setAttribute("aria-labelledby","symbol-styles-title");
    const heading=node("h2","Symbol styles");heading.id="symbol-styles-title";
    const explanation=node("p","Choose the drawings used by mapped symbols across this project.");
    dialog.append(heading,explanation);
    const groups=new Map();
    for(const d of project.library){
      if(!d.symbol)continue;
      const key=keyFor(d);if(!groups.has(key))groups.set(key,{key,def:d,count:0});groups.get(key).count++;
    }
    function field(text,input) {
      const label=node("label");label.append(node("span",text),input);return label;
    }
    const previews=node("div");previews.className="symbol-previews";
    function redraw(){
      previews.replaceChildren();
      for(const [family,id] of [["resistor","std-r"],["capacitor","std-c"]]){
        const base=globalThis.AtriumParts?.catalogue.find(d=>d.id===id);
        if(!base||!globalThis.AtriumCanvas?.preview)continue;
        const canvas=node("canvas");canvas.width=100;canvas.height=44;canvas.setAttribute("aria-label",family+" preview");
        const def=prefs[family]==="source"?base:{...base,symbol:{...base.symbol,shapes:drawing(base.symbol,prefs[family])}};
        previews.append(canvas);AtriumCanvas.preview(canvas,def,"schematic");
      }
    }
    const styles=node("div");styles.className="work-form";
    for(const [family,label] of [["resistor","Resistors"],["capacitor","Non-polar capacitors"]]){
      styles.append(field(label,dropdown(choices[family],prefs[family],label,v=>{prefs[family]=v;redraw();})));
    }
    dialog.append(styles);
    dialog.append(previews,node("h3","Library mappings"));
    const search=node("input");search.type="search";search.placeholder="Find a symbol";search.setAttribute("aria-label","Find a library symbol");
    const rows=node("div");rows.className="work-form work-list symbol-mappings";
    function renderRows(){
      rows.replaceChildren();
      const term=search.value.trim().toLowerCase();
      const entries=[...groups.values()].filter(({def})=>(def.name+" "+(def.prefix||"")).toLowerCase().includes(term));
      entries.sort((a,b)=>Number(Boolean(mapped.get(b.key)))-Number(Boolean(mapped.get(a.key)))||a.def.name.localeCompare(b.def.name));
      for(const {key,def,count} of entries){
        const name=def.name+(count>1?" ("+count+")":"");
        rows.append(field(name,dropdown(options,mapped.get(key)||"","Mapping for "+name,v=>mapped.set(key,v))));
      }
      if(!entries.length)rows.append(node("p",groups.size?"No library symbols match “"+search.value.trim()+"”.":"This project has no library symbols to map yet. Place a component first."));
    }
    search.oninput=renderRows;renderRows();search.className="symbol-search";dialog.append(search,rows);
    const actions=node("div");actions.className="work-actions";
    const cancel=node("button","Cancel"),apply=node("button","Apply to project");
    cancel.type="button";apply.type="button";apply.className="is-primary";cancel.onclick=()=>dialog.close();
    apply.onclick=()=>{
      const settings={...prefs,mappings:[...mapped]};
      let report;edit(()=>{report=applyPreferences(project,settings);});
      const msg=report.changed+" symbol definition"+(report.changed===1?"":"s")+" updated.";
      info(msg);if(!report.skipped.length){dialog.close();return;}
      dialog.replaceChildren(heading,node("p",msg),node("p","These symbols kept their library drawings."));
      const ul=node("ul");for(const message of report.skipped)ul.append(node("li",message));dialog.append(ul);
      const footer=node("div"),done=node("button","Done");footer.className="work-actions";done.type="button";done.className="is-primary";
      done.onclick=()=>dialog.close();footer.append(done);dialog.append(footer);
      globalThis.AtriumShell?.adoptDialog?.(dialog, {title:heading, body:ul, actions:footer});
      done.focus();
    };
    actions.append(cancel,apply);dialog.append(actions);document.body.append(dialog);
    globalThis.AtriumShell?.adoptDialog?.(dialog, {title:heading, body:[explanation,styles,previews,search,rows], actions});
    dialog.addEventListener("close",()=>dialog.remove(),{once:true});dialog.showModal();redraw();
  }
  return {open,applyPreferences,preferences,keyFor};
})();
