"use strict";
globalThis.AtriumKiCadSchematic = (() => {
  const A = Atrium, K = AtriumKiCad, q = K.quote;
  // KiCad's Datasheet field, from a Datasheet or Datasheet URL parameter in any spelling (KiCad imports store
  // DATASHEET; Altium and Eagle imports keep "Datasheet" as written).
  const datasheet = def => {
    for (const [k, v] of Object.entries(def?.parameters || {})) if (/^data[\s_]*sheet(?:[\s_]*url)?$/i.test(k.trim()) && typeof v === "string" && v) return v;
    return "";
  };
  const rounded = value => Math.round(value * 10000) / 10000;
  const positiveAngle = angle => ((angle % 360) + 360) % 360;
  const point = p => p.map(rounded).join(" ");
  const pos = (p, angle = 0) => "(at " + point(p) + " " + angle + ")";
  const pts = points => "(pts " + points.map(p => "(xy " + point(p) + ")").join(" ") + ")";
  const stroke = width => "(stroke (width " + rounded(width ?? 0) + ") (type default))";
  const effects = (size = 1.27, align = "", hide = false) => "(effects (font (size " +
    rounded(size) + " " + rounded(size) + "))" + (align ? " (justify " + align + ")" : "") + (hide ? " hide" : "") + ")";
  const property = (name, value, location, angle, size, hide, align = "") =>
    "(property " + q(name) + " " + q(value || "") + " " + pos(location, angle) + " " + effects(size, align, hide) + ")";
  const electrical = ["input", "bidirectional", "output", "open_collector", "passive", "tri_state", "open_emitter", "unspecified"];
  const same = (a,b) => point(a) === point(b);

  function makeLibrary(def, entry, local, pinPoints, report) {
    const lines = [], symbol = def.symbol, pinLines = [];
    // Multi-gate symbols become KiCad units (unit 0 holds pins shared by every gate) and De Morgan
    // art becomes body style 2 (style 0 = both). Sections are "<unit>_<style>".
    const gated = symbol.parts > 1 || !!symbol.alternate, sections = new Map();
    const unitOf = o => gated && o.part > 0 ? o.part : 0;
    const sec = (o, pin) => !gated ? "1_1" : unitOf(o) + "_" + (!symbol.alternate ? 1 : pin || o.alt == null ? 0 : o.alt ? 2 : 1);
    const put = (k, line) => { if (!sections.has(k)) sections.set(k, []); sections.get(k).push(line); };
    // Claim existing cardinal lead segments as native KiCad pins. A lead with
    // unrecorded direction retains its graphic and an editable zero-length pin.
    const leads = new Map();
    const pinAt = new Set(pinPoints.map((p, i) => point(p) + "|" + unitOf(symbol.pins[i])));
    const paths = symbol.shapes.map(shape => shape.points?.map(local));
    for (let i = 0; i < paths.length; i++) {
      const path = paths[i];
      if (!path || path.length < 2 || symbol.shapes[i].closed || symbol.shapes[i].fill) continue;
      for (const [end, next] of [[0,1],[path.length-1,path.length-2]]) {
        const a = path[end], b = path[next], u = "|" + unitOf(symbol.shapes[i]), key = point(a) + u;
        if (!pinAt.has(key) || pinAt.has(point(b) + u) || same(a,b) || a[0] !== b[0] && a[1] !== b[1]) continue;
        // Multiple geometries at the same terminal make direction ambiguous.
        const value = {path:i, end, angle:a[1] === b[1] ? (b[0]>a[0]?0:180) : (b[1]>a[1]?90:270), length:Math.hypot(b[0]-a[0],b[1]-a[1])};
        leads.set(key, leads.has(key) ? null : value);
      }
    }
    const trim = new Map(), seenNumbers = new Set();
    for (const [index,pin] of symbol.pins.entries()) {
      if (!pin.number) { report("Unnumbered electrical pins were omitted. Their source artwork remains visible."); continue; }
      const p = pinPoints[index], lead = pin.hidden ? null : leads.get(point(p) + "|" + unitOf(pin));
      if (lead) {
        if (!trim.has(lead.path)) trim.set(lead.path,new Set());
        trim.get(lead.path).add(lead.end);
      }
      if (seenNumbers.has(pin.number) && !gated) report("Repeated pin numbers in a symbol require review of stacked pins or multiple units.");
      seenNumbers.add(pin.number);
      const type = electrical[pin.electrical] || "unspecified";
      if (type === "unspecified") report("Pins without an unambiguous electrical type use KiCad unspecified. Review their ERC types.");
      put(sec(pin, true), "(pin " + type + " line " + pos(p, lead?.angle || 0) + " (length " + rounded(lead?.length || 0) +
        ")" + (pin.hidden ? " hide" : "") + " (name " + q(pin.name || "~") + " " + effects() + ") (number " + q(pin.number) + " " + effects() + "))");
    }
    for (const [index,s] of symbol.shapes.entries()) {
      const fill = "(fill (type " + (s.fill ? "background" : "none") + "))";
      if (s.kind === "path") {
        const path = paths[index].filter((_,j)=>!trim.get(index)?.has(j));
        if (path.length < 2) continue;
        if ((s.closed || s.fill) && !same(path[0],path.at(-1))) path.push(path[0]);
        put(sec(s), "(polyline " + pts(path) + " " + stroke(s.width) + " " + fill + ")");
      } else if (s.kind === "circle") {
        put(sec(s), "(circle (center " + point(local([s.x,s.y])) + ") (radius " + rounded(s.r) + ") " + stroke(s.width) + " " + fill + ")");
      } else if (s.kind === "text") {
        const p = local([s.x,s.y]);
        const a = local([s.x+1,s.y]), angle = positiveAngle(Math.round(Math.atan2(a[1]-p[1],a[0]-p[0])*180/Math.PI-(s.angle||0)));
        put(sec(s), "(text " + q(s.text) + " " + pos(p,angle*10) + " " + effects(s.size || 1.27, s.align==="center"?"bottom":s.align==="right"?"right bottom":"left bottom") + ")");
      } else report("Unsupported library shape " + s.kind + " omitted.");
    }
    const props = [["Reference",def.prefix||"U"],["Value",def.value||def.name],["Footprint",def.footprint?.name?K.footprintId(def.footprint.name):""],["Datasheet",datasheet(def)]];
    return ["(symbol "+q("Waffle:"+entry),"(pin_names (offset 0) hide) (pin_numbers hide) (in_bom yes) (on_board yes)",
      ...props.map(([key,value],i)=>property(key,value,[0,0],0,1.27,i>1)),
      ...[...sections].sort(([a],[b])=>a<b?-1:a>b?1:0).flatMap(([k,body])=>["(symbol "+q(entry+"_"+k),...body,")"]),...lines,...pinLines,")"].join("\n      ");
  }

  // KiCad power symbols for Waffle power ports: a hidden power-in pin whose name, like the
  // Value field, is the global net name. Graphics follow the port style.
  const POWER_ART = {
    gnd:["(polyline (pts (xy 0 0) (xy 0 -1.27) (xy 1.27 -1.27) (xy 0 -2.54) (xy -1.27 -1.27) (xy 0 -1.27))"],
    signal:["(polyline (pts (xy 0 0) (xy 0 -1.27) (xy 1.27 -1.27) (xy 0 -2.54) (xy -1.27 -1.27) (xy 0 -1.27))"],
    earth:["(polyline (pts (xy 0 0) (xy 0 -1.27))","(polyline (pts (xy -1.27 -1.27) (xy 1.27 -1.27))","(polyline (pts (xy -1.27 -1.27) (xy -1.9 -2.2))","(polyline (pts (xy 0 -1.27) (xy -0.63 -2.2))","(polyline (pts (xy 1.27 -1.27) (xy 0.63 -2.2))"],
    bar:["(polyline (pts (xy 0 0) (xy 0 1.27))","(polyline (pts (xy -0.762 1.27) (xy 0.762 1.27))"],
    arrow:["(polyline (pts (xy 0 0) (xy 0 1.27))","(polyline (pts (xy -0.762 0.762) (xy 0 1.27) (xy 0.762 0.762))"],
    circle:["(polyline (pts (xy 0 0) (xy 0 1.27))","(circle (center 0 1.778) (radius 0.508))"],
    wave:["(polyline (pts (xy 0 0) (xy 0 1.27))","(polyline (pts (xy -0.762 1.27) (xy -0.381 1.524) (xy 0.381 1.016) (xy 0.762 1.27))"]
  };
  const DOWN_STYLES = new Set(["gnd","signal","earth"]);
  function powerLibrary(entry, net, style) {
    // Each art string lacks its final ")" when it is a polyline; a circle arrives closed.
    const art = (POWER_ART[style] || POWER_ART.bar).map(a => {
      const open = (a.match(/\(/g) || []).length - (a.match(/\)/g) || []).length;
      return (open > 0 ? a : a.slice(0, -1)) + " " + stroke(0) + " (fill (type none)))";
    });
    const down = DOWN_STYLES.has(style);
    return ["(symbol "+q("Atrium_Power:"+entry)+" (power) (pin_names (offset 0)) (in_bom no) (on_board no)",
      property("Reference","#PWR",[0,down?-3.81:3.81],0,1.27,true),property("Value",net,[0,down?-3.81:2.54],0,1.27),
      "(symbol "+q(entry+"_0_1"),...art,")",
      "(symbol "+q(entry+"_1_1"),"(pin power_in line (at 0 0 "+(down?270:90)+") (length 0) hide (name "+q(net)+" "+effects()+") (number \"1\" "+effects()+"))",")",
      ")"].join("\n      ");
  }
  const labelShape = io => ({input:"input", output:"output", bidirectional:"bidirectional"})[io] || "passive";

  function exportSheet(project, requested, observer, hierarchy, snapshot) {
    const doc = typeof requested === "string" ? project.documents.find(d=>d.id===requested) : requested;
    if (doc?.kind !== "schematic") throw Error("Choose a schematic sheet to export.");
    const defs = new Map(project.library.map(d=>[d.id,d])), diagnostics = new Set(doc.notes || []);
    const notebookValues = globalThis.AtriumCalculationRecords, fidelity = [];
    const evaluations = snapshot || notebookValues?.frozen(project,doc);
    const note = message => diagnostics.add(message), report = observer ? observer.diagnostics(note) : note, lib = new Map(), objects = [], entries = new Map();
    const counts = {symbols:0, pins:0, wires:0, junctions:0, labels:0, graphics:0, librarySymbols:0};
    const usedSources = new Set(doc.items.map(i=>defs.get(i.def)?.sourceName).filter(Boolean));
    for (const note of project.importNotes || []) if (usedSources.has(note.split(" — ")[0])) report(note);
    const hierarchical = project.documents.some(d=>d.kind==="schematic"&&d.items.some(i=>i.kind==="sheetsymbol"));
    if (project.documents.filter(d=>d.kind==="schematic"&&d.items.length).length>1)
      report(hierarchical?"Only the selected sheet is exported. Export each child sheet too; sheet symbols name them as <sheet>.kicad_sch.":
        "Only the selected sheet is exported. Sheet hierarchy and cross-sheet connections require reconstruction.");
    const isChild = !!project.documents.some(d=>d.kind==="schematic"&&d.items.some(i=>i.kind==="sheetsymbol"&&i.sheet===doc.id));
    let powerCount = 0;
    const extents = A.docBounds(doc,defs), positions = [extents.slice(0,2),extents.slice(2)];
    for (const part of doc.items.filter(i=>i.kind==="part")) {
      positions.push([part.x,part.y]);
      if (part.refAt) positions.push(A.world(part.refAt,part));
      if (part.valueAt) positions.push(A.world(part.valueAt,part));
    }
    const box = A.bounds(positions), layout = globalThis.AtriumSchematicOutput?.page(doc,defs,"kicad");
    // A common whole-grid translation keeps negative SchDoc coordinates on the
    // page and preserves the grid phase of the source drawing.
    const offset = layout ? [-layout.left,-layout.top] : box.slice(0,2).map(v=>rounded(Math.ceil((16-v)/1.27)*1.27));
    const page = p => p.map((v,k)=>rounded(v+offset[k]));
    const width = Math.ceil(box[2]+offset[0]+30), height = Math.ceil(box[3]+offset[1]+25);
    const format = [["A4",297,210],["A3",420,297],["A2",594,420],["A1",841,594],["A0",1189,841]].find(([,w,h])=>w>=width && h>=height);
    let paper;
    if (layout) {
      const {width:w,height:h} = layout;
      /** @type {Array<[string, number, number]>} */
      const standards = [["A5",210,148],["A4",297,210],["A3",420,297],["A2",594,420],["A1",841,594],["A0",1189,841],
        ["A",279.4,215.9],["B",431.8,279.4],["C",558.8,431.8],["D",863.6,558.8],["E",1117.6,863.6],["USLegal",355.6,215.9]];
      const named = !layout.infinite && standards.find(([,a,b]) => Math.abs(a-Math.max(w,h))<.001 && Math.abs(b-Math.min(w,h))<.001);
      paper = named ? q(named[0]) + (w<h ? " portrait" : "") : '"User" '+w+' '+h;
      report(layout.note);
    } else {
      paper = format ? q(format[0]) : '"User" '+Math.min(3048,width)+' '+Math.min(3048,height);
      if (width>3048||height>3048) report("The drawing extends beyond KiCad’s maximum custom paper size. Its full geometry is exported.");
    }
    const root = K.uid(doc.id+"/sheet"), stamp = key=>"(uuid "+K.uid(doc.id+"\u001f"+key)+")";
    const baseName = observer?.fileStem?.(doc) || K.nameFor(doc.name,""), labels = new Set(), anchors = new Map(), joints = new Map(), degree = new Map(), pinsAt = new Map();
    const instances = (ref,unit) => "(instances (project "+q(hierarchy?.name || baseName)+" "+
      (hierarchy?.paths || ["/"+root]).map(path=>"(path "+q(path)+" (reference "+q(ref)+") (unit "+unit+"))").join(" ")+"))";
    const anchor = p=>{anchors.set(point(p),p);return p;};
    const addLabel=(name,p,id,angle=0)=>{
      if (!name) return;
      const key=JSON.stringify([point(p),name]);
      if(labels.has(key))return;
      labels.add(key);anchor(p);
      objects.push("(label "+q(name)+" "+pos(p,angle)+" "+effects(1.27,"left bottom")+" "+stamp(id)+")");counts.labels++;
    };
    const linked=new Map();
    for(const board of project.documents.filter(d=>d.kind==="pcb"))
      for(const i of board.items.filter(i=>i.kind==="part"&&i.link))linked.set(i.link,linked.has(i.link)?null:defs.get(i.def)?.footprint?.name);
    const refs=new Set();
    for (const i of observer ? observer.items(doc,doc.items,() => objects.length) : doc.items) {
      const art=observer?.notebook?.(doc,i);
      if(art?.type==="child"){
        observer.observed(doc,i,i.kind,art.represented?"approximated":"dropped",art.represented?art.reason:"The owner has no drawable image.");continue;
      }
      if(art || i.kind==="image"&&i.asset){
        const box=art?.box||[i.x,i.y,i.x+i.w,i.y+i.h];
        if(art?.type==="image"){
          const center=page([(box[0]+box[2])/2,(box[1]+box[3])/2]);
          const bytes=Uint8Array.from(atob(art.data),c=>c.charCodeAt(0));
          const density=globalThis.AtriumSexpr?.pngInfo(bytes)?.ppi||300;
          const size=(box[2]-box[0])*density/(25.4*art.width);
          objects.push("(image (at "+point(center)+") (scale "+size.toFixed(9)+") "+stamp(i.id)+" (data "+
            art.data.match(/.{1,76}/g).map(q).join("\n    ")+"))");
          report("The notebook object is flattened into a static PNG.");
        }else{
          objects.push("(text "+q(art?.text||i.alt||i.caption||i.name||"Image")+" "+pos(page(box.slice(0,2)),0)+" "+effects(1.27,"left top")+" "+stamp(i.id)+")");
          report(art?.reason||"Image pixels unavailable. The text identifies the source.");
        }
        counts.graphics++;continue;
      }
      if(i.kind==="wire"){
        i.points.forEach(p=>anchor(page(p)));
        if(i.net && i.points.length)addLabel(i.net,page(i.points[0]),i.id+"/net");
      }else if(i.kind==="junction"){
        const p=anchor(page([i.x,i.y]));joints.set(point(p),{p,id:i.id,item:i});
      }else if(i.kind==="netlabel"&&!A.isOffsheet(i)){
        if(i.autoName)report("Pin-based automatic net names export as literal net labels. Review the net names in repeated channels.");
        const angle=positiveAngle(-(i.angle||0));
        addLabel(i.text,page([i.x,i.y]),i.id,Math.round(angle/90)*90%360);
        if(angle%90)report("Net-label text rotations were rounded to the nearest KiCad cardinal angle.");
      }else if(i.kind==="label"){
        objects.push("(text "+q(i.text)+" "+pos(page([i.x,i.y]),observer?.precision?.angle(i) ?? globalThis.AtriumTranslatorPrecision?.angle(i.angle) ?? positiveAngle(-(i.angle||0)))+" "+effects(i.size||1.6,"left bottom")+" "+stamp(i.id)+")");counts.graphics++;
      }else if(i.kind==="graphic"){
        const ps=i.points.map(page);
        if((i.closed||i.fill)&&!same(ps[0],ps.at(-1)))ps.push(ps[0]);
        objects.push("(polyline "+pts(ps)+" "+stroke(i.width)+" "+stamp(i.id)+")");counts.graphics++;
        if(i.fill)report("Sheet-level filled paths are exported as editable outlines.");
      }else if(i.kind==="part"){
        const def=defs.get(i.def);
        if(!def?.symbol){report("Components with missing symbol geometry were omitted.");continue;}
        const angle=positiveAngle(i.angle||0),cardinal=angle%90===0?angle:0,bake=angle-cardinal;
        if(bake)report("Non-cardinal placements use orientation-specific embedded symbols to preserve their electrical endpoints.");
        const unit=def.symbol.parts>1?(i.unit||i.part||1):1;if(refs.has(i.ref+"\u0000"+unit)||!i.ref||i.ref.includes("?"))report("Duplicate or unannotated references require annotation or unit assignment in KiCad.");
        refs.add(i.ref+"\u0000"+unit);
        const origin=page([i.x,i.y]);
        const local=p=>{const r=A.rotate(i.mirror?[-p[0],p[1]]:p,bake);return [rounded(r[0]),rounded(-r[1])];};
        for(const pin of A.pins(i,def,"schematic"))if(pin.number){const p=page(pin.at);anchor(p);pinsAt.set(point(p),(pinsAt.get(point(p))||0)+1);}
        const pinPoints=def.symbol.pins.map(pin=>{
          const p=page(A.world([pin.x,pin.y],i));
          const r=A.rotate([p[0]-origin[0],p[1]-origin[1]],-cardinal);
          return [rounded(r[0]),rounded(-r[1])];
        });
        const key=JSON.stringify([def.id,bake,pinPoints,!!i.mirror]);
        let entry=entries.get(key);
        if(!entry){
          entry=String(def.name||"Symbol").replace(/[\x00-\x20:\/\\"]/g,"_")+"_"+K.uid(key).slice(0,8);
          entries.set(key,entry);lib.set(entry,makeLibrary(def,entry,local,pinPoints,report));
        }
        const bounds=A.bounds(A.itemPoints(i,def,"schematic"))||[i.x,i.y,i.x,i.y],vertical=angle%180===90;
        const fallback=(j)=>vertical?[bounds[2]+.9,i.y+(j?1.65:-.4)]:[(bounds[0]+bounds[2])/2,bounds[1]-2.75+(j?1.85:0)];
        const textAt=(off,j)=>page(off?A.world(off,i):fallback(j));
        const footprint=linked.get(i.link)||def.footprint?.name||def.footprintName||"";
        if(footprint)report("Assigned footprints use the Waffle library nickname. Linked exported boards embed their footprints. Adding fresh footprints in KiCad requires a matching footprint library or reassignment.");
        const propAngle=cardinal%180;
        const fields=[property("Reference",i.ref,textAt(i.refAt,0),propAngle,1.72,i.showRef===false,i.refAt||vertical?"left":""),
          property("Value",i.value,textAt(i.valueAt,1),propAngle,1.45,i.showValue===false,i.valueAt||vertical?"left":""),
          property("Footprint",footprint?K.footprintId(footprint):"",origin,0,1.27,true),property("Datasheet",datasheet(def),origin,0,1.27,true)];
        const uuid=K.symbolUuid(doc,i);
        const pinIds=def.symbol.pins.flatMap((p,j)=>p.number&&!(def.symbol.parts>1&&p.part>0&&p.part!==unit)?["(pin "+q(p.number)+" "+stamp(i.id+"/pin/"+p.number+"/"+j)+")"]:[]);
        objects.push(["(symbol (lib_id "+q("Waffle:"+entry)+") "+pos(origin,positiveAngle(-cardinal))+" (unit "+unit+")"+(def.symbol.alternate&&i.alt?" (convert 2)":"")+" (in_bom yes) (on_board yes) (uuid "+uuid+")",
          ...fields,...pinIds,instances(i.ref,unit)+")"].join("\n    "));
        counts.symbols++;counts.pins+=pinIds.length;
      }else if(i.kind==="power"){
        const style=i.style||"bar",entry=String(i.text).replace(/[\x00-\x20:\/\\"]/g,"_")+"_"+style;
        if(!lib.has("power/"+entry))lib.set("power/"+entry,powerLibrary(entry,i.text,style));
        const p=anchor(page([i.x,i.y])),ref="#PWR"+String(++powerCount).padStart(3,"0");
        const angle=positiveAngle(((i.direction||0)-(DOWN_STYLES.has(style)?3:1))*90);
        objects.push(["(symbol (lib_id "+q("Atrium_Power:"+entry)+") "+pos(p,angle)+" (unit 1) (in_bom no) (on_board no) "+stamp(i.id),
          property("Reference",ref,p,0,1.27,true),property("Value",i.text,p,0,1.27,i.showName===false),
          "(pin \"1\" "+stamp(i.id+"/pin")+")",instances(ref,1)+")"].join("\n    "));
        counts.labels++;
      }else if(i.kind==="port"||A.isOffsheet(i)){
        const p=anchor(page([i.x,i.y])),turn=positiveAngle(-A.offsheetAngle(i)),angle=Math.round(turn/90)*90%360;
        const kind=i.kind==="port"&&isChild?"hierarchical_label":"global_label";
        const shape=labelShape(i.io);
        if(A.isOffsheet(i)&&shape==="passive"&&i.io!=null&&i.io!=="unspecified")report("Unknown off-sheet connector direction was written as a passive KiCad global label.");
        if(turn%90)report("Connector rotation was rounded to the nearest KiCad cardinal angle.");
        objects.push("("+kind+" "+q(i.text)+" (shape "+shape+") "+pos(p,angle)+" "+effects(1.27,angle===180||angle===270?"right":"left")+" "+stamp(i.id)+")");
        counts.labels++;
      }else if(i.kind==="sheetsymbol"){
        const at=page([i.x,i.y]),child=project.documents.find(d=>d.id===i.sheet);
        const file=(child?(observer?.fileStem?.(child)||K.nameFor(child.name,"")):String(i.file||"sheet").replace(/\.[^.]*$/,""))+".kicad_sch";
        const pins=(i.entries||[]).map(e=>{
          const pt=anchor(page(globalThis.AtriumSchObjects?AtriumSchObjects.entryPoint(i,e):[i.x,i.y+e.offset]));
          const angle={left:180,right:0,top:90,bottom:270}[e.side]??180;
          return "(pin "+q(e.name)+" "+labelShape(e.io)+" "+pos(pt,angle)+" "+effects(1.27,e.side==="right"?"right":"left")+" "+stamp(i.id+"/"+e.id)+")";
        });
        if(/^\s*repeat\s*\(/i.test(i.name||"")||i.repeat)report("Repeated (multi-channel) sheet symbols export as one sheet instance.");
        const paths=hierarchy?.children.get(i.id);
        const placed=paths ? ["(instances (project "+q(hierarchy.name)+" "+paths.map(x=>"(path "+q(x.path)+" (page "+q(String(x.page))+"))").join(" ")+"))"] : [];
        objects.push(["(sheet "+"(at "+point(at)+") (size "+rounded(i.w)+" "+rounded(i.h)+") (fields_autoplaced) "+stroke(0.1524)+" (fill (color 0 0 0 0.0000)) "+stamp(i.id),
          "(property \"Sheetname\" "+q(i.name||"Sheet")+" (at "+point([at[0],at[1]-0.7])+" 0) "+effects(1.27,"left bottom")+")",
          "(property \"Sheetfile\" "+q(file)+" (at "+point([at[0],at[1]+i.h+0.6])+" 0) "+effects(1.27,"left top")+")",...pins,...placed,")"].join("\n    "));
        counts.graphics++;
      }else if(i.kind==="bus"){
        objects.push("(bus "+pts(i.points.map(page))+" "+stroke(0)+" "+stamp(i.id)+")");counts.wires++;
      }else if(i.kind==="busentry"){
        const a=page([i.x,i.y]),b=page(globalThis.AtriumSchObjects?AtriumSchObjects.busEntryEnd(i):[i.x+2.54,i.y-2.54]);anchor(a);
        objects.push("(bus_entry (at "+point(a)+") (size "+point([b[0]-a[0],b[1]-a[1]])+") "+stroke(0)+" "+stamp(i.id)+")");counts.graphics++;
      }else if(i.kind==="noerc"){
        objects.push("(no_connect (at "+point(anchor(page([i.x,i.y])))+") "+stamp(i.id)+")");counts.graphics++;
      }else if(i.kind==="textframe" && i.math===true){
        const value=globalThis.AtriumMath?.layout(i.text,{display:true}).plain || i.text;
        objects.push("(text "+q(value)+" (at "+point(page([i.x,i.y]))+" 0) "+effects(i.size||3.5,"left top")+" "+stamp(i.id)+")");
        counts.graphics++;report("Equation "+i.id+" was converted to static text.");
      }else if(i.kind==="textframe"){
        if (i.role==="frame") report("Named frame written as an editable graphical text box.");
        let frameText = i.text;
        if (i.calculation && notebookValues) {
          const projected = notebookValues.staticOutput(notebookValues.read(i),evaluations.get(i.id),"KiCad");
          frameText = projected.text; fidelity.push(projected.fidelity); report(projected.message);
        }
        const rich=i.richText || i.math || i.widget || i.sticky || i.callout;
        const note=rich && !i.calculation && globalThis.AtriumNotebook?.describe(project,doc,i);
        if(rich)report(note?"Notebook content was exported as a static text box with its current field values.":"Notebook content used its plain-text projection because its field reader was unavailable.");
        objects.push("(text_box "+q(note?.text ?? frameText)+" (at "+point(page([i.x,i.y]))+" 0) (size "+rounded(i.w)+" "+rounded(i.h)+") "+stroke(0)+
          " (fill (type "+(i.note?"background":"none")+")) "+effects(i.size||1.27,"left top")+" "+stamp(i.id)+")");counts.graphics++;
      }else if(i.kind==="image"){
        report("Embedded images are not exported. Place them again in KiCad.");
      }else report("Unsupported sheet item "+i.kind+" omitted.");
    }
    // KiCad requires explicit wire endpoints at T connections. Split at source
    // electrical anchors only, so an unmarked wire crossing stays separate.
    const rows=new Map(),cols=new Map();
    const add=(m,k,v)=>{if(!m.has(k))m.set(k,[]);m.get(k).push(v);};
    for(const p of anchors.values()){add(rows,p[1],p);add(cols,p[0],p);}
    const edges=new Set();
    function neighbor(p,k){const key=point(p);if(!degree.has(key))degree.set(key,new Set());degree.get(key).add(k);}
    const wires=doc.items.filter(i=>i.kind==="wire");
    for(const w of observer?observer.items(doc,wires,()=>objects.length,"wire"):wires){
      for(let n=1;n<w.points.length;n++){
        const a=page(w.points[n-1]),b=page(w.points[n]);
        if(same(a,b))continue;
        const points=a[0]===b[0]?cols.get(a[0]):a[1]===b[1]?rows.get(a[1]):anchors.values();
        const dx=b[0]-a[0],dy=b[1]-a[1],order=p=>(p[0]-a[0])*dx+(p[1]-a[1])*dy;
        const line=[...points].filter(p=>order(p)>=0&&order(p)<=dx*dx+dy*dy&&A.nearSegment(p,a,b)<.00011).sort((l,r)=>order(l)-order(r));
        for(let j=1;j<line.length;j++){
          const p=line[j-1],r=line[j],pk=point(p),rk=point(r),edge=[pk,rk].sort().join("|");
          if(edges.has(edge))continue;
          edges.add(edge);neighbor(p,rk);neighbor(r,pk);
          objects.push("(wire "+pts([p,r])+" "+stroke(w.width)+" "+stamp(w.id+"/wire/"+n+"/"+j)+")");counts.wires++;
        }
      }
    }
    for(const [key,neighbors] of degree)if(neighbors.size+(pinsAt.get(key)||0)>2&&!joints.has(key))joints.set(key,{p:anchors.get(key),id:"junction/"+key});
    for(const {p,id,item} of joints.values()){
      if(item)observer?.observed(doc,item,"junction","kept");
      objects.push("(junction (at "+point(p)+") (diameter 0) (color 0 0 0 0) "+stamp(id)+")");counts.junctions++;
    }
    if(A.connectivity(doc,defs).nets.some(n=>n.conflict))report("A connected net has conflicting source labels. Resolve its name in KiCad.");
    counts.librarySymbols=lib.size;
    const content=["(kicad_sch (version 20230121) (generator waffle)","  (uuid "+root+")","  (paper "+paper+")","  (title_block (title "+q(doc.name)+"))",
      "  (lib_symbols",...[...lib.values()].map(s=>"    "+s),"  )",...objects.map(s=>"  "+s),'  (sheet_instances (path "/" (page "1")))',")",""].join("\n");
    return {name:baseName+".kicad_sch",content,diagnostics:[...diagnostics],counts,offset,...(layout ? {page:layout} : {}),...(fidelity.length ? {fidelity} : {})};
  }
  return {exportSheet};
})();
