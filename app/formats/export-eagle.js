"use strict";
// EAGLE XML 6+ design exchange. Rebuild electrical and geometric records from the
// selected project, using linked originals only for independently safe source data.
globalThis.AtriumEagleExport = (() => {
  const A = Atrium, libraryName = "Waffle";
  const n = (value, fallback = 0) => String(+(Number.isFinite(value) ? value : fallback).toFixed(6));
  const rotation = (angle, mirror = false) => (mirror ? "MR" : "R") + n(((angle % 360) + 360) % 360);
  const pos = (x, y) => ({x:n(x),y:n(-y)});
  const esc = value => String(value).replace(/[^\t\n\r\u0020-\uD7FF\uE000-\uFFFD\u{10000}-\u{10FFFF}]/gu,"�")
    .replace(/[&<>"'\t\r]/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&apos;","\t":"&#9;","\r":"&#13;"})[c]);
  const el = (name,attrs = {},children = []) => ({name,attrs,children});
  function xml({name,attrs,children},depth = 0) {
    const indent = "  ".repeat(depth);
    const head = indent+"<"+name+Object.entries(attrs).filter(([,v])=>v != null).map(([k,v])=>" "+k+'="'+esc(v).replace(/\n/g,"&#10;")+'"').join("");
    if (!children.length) return head+"/>\n";
    if (typeof children[0] === "string") return head+">"+esc(children[0])+"</"+name+">\n";
    return head+">\n"+children.map(child=>xml(child,depth+1)).join("")+indent+"</"+name+">\n";
  }
  const get = (node, name) => node?.children.find(child=>child.name === name);
  const list = (node,name) => node?.children.filter(child=>child.name === name) || [];
  const body = (node, ...names) => names.reduce(get,node);
  const container = (name, children) => el(name,{},children);
  const xy = p => Array.isArray(p) ? p : [p.x,p.y];
  const pt = p => pos(...xy(p));
  const near = (a,b) => Math.hypot(a[0]-b[0],a[1]-b[1]) < 1e-6;
  const positive = (v,d) => Number.isFinite(v) && v > 0 ? v : d;
  const SLOT = "EAGLE drills are round: the slot was written as a hole of its width.";
  const fileStem = name => (String(name || "Waffle").split(/[\\/]/).pop().replace(/\.(sch|brd)$/i,"")
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g,"-").replace(/[. ]+$/,"").trim() || "Waffle");
  const token = (name,fallback) => (String(name || "").trim().replace(/[\s\u0000-\u001f/\\]/g,"_").slice(0,120) || fallback);
  function names() {
    const used = new Set();
    return (value, fallback) => {
      const stem = token(value,fallback);
      let name = stem;
      for (let i = 2; used.has(name.toUpperCase()); i++) name = stem + "_" + i;
      used.add(name.toUpperCase());
      return name;
    };
  }
  const src = (doc,item) => ({file:doc.sourceName || doc.name || "Untitled",object:item?.id || doc.id});
  const say = (sink,doc,item,status,reason,kind = item?.kind || (doc.kind === "pcb" ? "PCB document" : "Schematic document")) =>
    sink.add(kind,status,src(doc,item),reason);
  const tech = {"Silk":21,"Bottom silk":22,"Top mask":29,"Bottom mask":30,"Top paste":31,"Bottom paste":32,
    "Mechanical":48,"Mechanical 13":51,"Mechanical 14":52,"Mechanical 15":39,"Mechanical 16":40,"Mechanical 17":35,"Mechanical 18":36,
    "Keepout":41,"Edge.Cuts":20};
  const swaps = {1:16,16:1,21:22,22:21,25:26,26:25,27:28,28:27,29:30,30:29,31:32,32:31,35:36,36:35,
    39:40,40:39,41:42,42:41,51:52,52:51};
  const palette = {1:"Top",16:"Bottom",17:"Pads",18:"Vias",19:"Unrouted",20:"Dimension",21:"tPlace",22:"bPlace",
    25:"tNames",26:"bNames",27:"tValues",28:"bValues",29:"tStop",30:"bStop",31:"tCream",32:"bCream",35:"tGlue",36:"bGlue",
    39:"tKeepout",40:"bKeepout",41:"tRestrict",42:"bRestrict",43:"vRestrict",44:"Drills",45:"Holes",46:"Milling",47:"Measures",
    48:"Document",49:"Reference",51:"tDocu",52:"bDocu",91:"Nets",92:"Busses",93:"Pins",94:"Symbols",95:"Names",
    96:"Values",97:"Info",98:"Guide"};
  function copper(layer) {
    if (layer === "Top") return 1;
    if (layer === "Bottom") return 16;
    const inner = /^Inner (\d+)$/.exec(layer || "");
    return inner && +inner[1] >= 1 && +inner[1] <= 14 ? +inner[1] + 1 : null;
  }
  const layerNumber = layer => copper(layer) || tech[layer] || null;
  const wire = (a,b,width,layer,curve) => el("wire",{x1:n(a[0]),y1:n(-a[1]),x2:n(b[0]),y2:n(-b[1]),
    width:n(width),layer,curve:curve == null ? undefined : n(curve)});
  function wires(raw,width,layer,map = xy,closed = false) {
    const points = (raw || []).map(map), result = [];
    for (let i=1;i<points.length;i++) result.push(wire(points[i-1],points[i],width,layer));
    if (closed && points.length > 2 && !near(points[0],points.at(-1))) result.push(wire(points.at(-1),points[0],width,layer));
    return result;
  }
  function polygon(raw, attrs, map = xy) {
    const points = (raw || []).map(map);
    if (points.length > 2 && near(points[0],points.at(-1))) points.pop();
    return points.length >= 3 ? el("polygon",attrs,points.map(point=>el("vertex",pt(point)))) : null;
  }
  function text(item, layer, map = xy, angle = -(item.angle || 0)) {
    return el("text",{...pt(map([item.x,item.y])),size:n(positive(item.size,1.27)),layer,rot:rotation(angle)},[String(item.text ?? "")]);
  }
  function art(item,layer,map = xy,angleFactor = -1) {
    if (!layer) return [];
    if (item.kind === "label" || item.kind === "text") return item.text == null ? [] : [text(item,layer,map,angleFactor*(item.angle || 0))];
    if (item.kind === "circle" && item.r > 0) {
      const center = pt(map([item.x,item.y]));
      return [el("circle",{...center,radius:n(item.fill ? 0 : item.r),width:n(item.fill ? 2*item.r : item.width ?? .1524),layer})];
    }
    const points = item.points;
    if (!points?.length) return [];
    if (item.fill) {
      const p = polygon(points,{width:n(item.width ?? 0),layer},map);
      return p ? [p] : [];
    }
    return wires(points,item.width ?? .1524,layer,map,item.closed);
  }
  function drawings(content, layers, grid, original) {
    const used = new Set(layers);
    function collect(row) {
      if (typeof row === "string") return;
      const number = Number(row.attrs.layer);
      if (Number.isInteger(number) && number > 0 && number < 256) used.add(number);
      for (const child of row.children) collect(child);
    }
    collect(content);
    const defined = new Map([...used].sort((a,b)=>a-b).map(number=>[number,el("layer",{
      number,name:palette[number] || "Route"+number,color:number === 1 ? 4 : number === 16 ? 1 : number === 91 ? 2 : 7,
      fill:1,visible:"yes",active:"yes"})]));
    for (const row of list(get(original,"layers"),"layer")) {
      const number = +row.attrs.number;
      if (!defined.has(number) || number > 1 && number < 16) continue;
      for (const key of ["color","fill"])
        if (/^\d+$/.test(row.attrs[key] || "") && +row.attrs[key] < 256) defined.get(number).attrs[key] = row.attrs[key];
      for (const key of ["visible","active"])
        if (/^(yes|no)$/.test(row.attrs[key] || "")) defined.get(number).attrs[key] = row.attrs[key];
    }
    const settings = list(get(original,"settings"),"setting").map(row=>el("setting",{
      alwaysvectorfont:/^(yes|no)$/.test(row.attrs.alwaysvectorfont) ? row.attrs.alwaysvectorfont : undefined,
      verticaltext:/^(up|down)$/.test(row.attrs.verticaltext) ? row.attrs.verticaltext : undefined,
    })).filter(row=>Object.values(row.attrs).some(v=>v != null));
    return '<?xml version="1.0" encoding="utf-8"?>\n<!DOCTYPE eagle SYSTEM "eagle.dtd">\n'+xml(el("eagle",{version:"7.7.0"},[
      container("drawing",[container("settings",settings),el("grid",{distance:n(positive(grid,.25)),unitdist:"mm",unit:"mm",
        style:"lines",multiple:1,display:"no",altdistance:n(positive(grid,.25)/2),altunitdist:"mm",altunit:"mm"}),
        container("layers",[...defined.values()]),content])
    ]));
  }
  const padLayer = (pad,bottom) => {
    const l = copper(pad.layer) || (bottom ? 16 : 1);
    return bottom ? swaps[l] || l : l;
  };
  function packageGeometry(def,name,bottom,mirror,doc,sink) {
    const footprint = def.footprint, angleFactor = bottom === mirror ? -1 : 1;
    const padNames = new Map(), reservePad = names();
    const transform = p => [xy(p)[0]*(bottom === mirror ? 1 : -1),xy(p)[1]], children = [];
    for (const [index,pad] of (footprint.pads || []).entries()) {
      const attrs = pt(transform([pad.x,pad.y])), drill = positive(pad.drill,0), rawName = String(pad.number ?? "");
      const quality = (status,reason) => {
        if (sink) say(sink,doc,{id:def.id+"/pad/"+(index+1)},status,reason,"Footprint pad");
      };
      if (drill && pad.plated === false) { children.push(el("hole",{...attrs,drill:n(drill)})); pad.slotLength > drill ? quality("approximated",SLOT) : quality("kept"); continue; }
      const padName = reservePad(rawName,"P"), w = positive(pad.w,0), h = positive(pad.h,0);
      if (!w || !h || drill && Math.min(w,h) <= drill) {
        quality("dropped","The pad diameter or dimensions do not admit the drill."); continue;
      }
      if (!padNames.has(rawName)) padNames.set(rawName,[]);
      padNames.get(rawName).push(padName);
      const common = {name:padName,...attrs,rot:rotation(angleFactor*(pad.angle || 0))};
      const offset = !!(pad.offset || pad.holeOffset || pad.slot || pad.drillLength > drill || pad.slotLength > drill);
      if (drill) {
        const ratio = w/h, long = pad.shape === "oval" && Math.abs(ratio-2) < 1e-5;
        const square = Math.abs(w-h) < 1e-6, shape = long ? "long" : pad.shape === "octagon" ? "octagon" :
          pad.shape === "rect" && square ? "square" : "round";
        children.push(el("pad",{...common,drill:n(drill),diameter:n(Math.min(w,h)),shape,
          stop:pad.mask === false ? "no" : undefined,thermals:pad.thermals === false ? "no" : undefined}));
        const exact = !offset && rawName === padName && (long || square && ["round","rect","octagon"].includes(pad.shape));
        quality(exact ? "kept" : "approximated",exact ? undefined : "EAGLE through pads use fixed pad profiles and a round drill.");
      } else {
        const roundness = ["round","oval"].includes(pad.shape) ? 100 : pad.shape === "roundrect" ? (pad.roundness ?? 25) : 0;
        children.push(el("smd",{...common,dx:n(w),dy:n(h),layer:padLayer(pad,bottom),
          roundness:n(roundness),stop:pad.mask === false ? "no" : undefined,cream:pad.paste === false ? "no" : undefined,
          thermals:pad.thermals === false ? "no" : undefined}));
        const exact = !offset && rawName === padName && ["rect","round","oval","roundrect"].includes(pad.shape) && !!copper(pad.layer);
        quality(exact ? "kept" : "approximated",exact ? undefined : "EAGLE surface pads use a single copper layer and rectangular or rounded profiles.");
      }
    }
    for (const [index,shape] of (footprint.shapes || []).entries()) {
      const layer = layerNumber(shape.layer) || (shape.style === "package" ? (bottom ? 52 : 51) : (bottom ? 22 : 21));
      const out = shape.layer && !layerNumber(shape.layer) ? [] : art(shape,bottom ? swaps[layer] || layer : layer,transform,angleFactor);
      children.push(...out);
      const reason = !out.length ? "The footprint graphic or its layer has no EAGLE counterpart." :
        out.length > 1 ? "The footprint graphic was split into EAGLE wire segments." : undefined;
      say(sink,doc,{id:def.id+"/shape/"+(index+1)},!out.length ? "dropped" : reason ? "approximated" : "kept",reason,"Footprint graphic");
    }
    for (const [index] of (footprint.bodies3d || []).entries())
      say(sink,doc,{id:def.id+"/3d/"+(index+1)},"dropped","Embedded STEP geometry cannot be written as an EAGLE managed package identifier.","3D body");
    if (footprint.netTie || footprint.netTieGroups?.length)
      say(sink,doc,{id:def.id},"approximated","Copper remains present, but the native net-tie exemption is not an EAGLE rule.","Net tie");
    children.push(text({x:-1,y:-1,size:1,text:">NAME"},25),text({x:-1,y:1,size:1,text:">VALUE"},27));
    return {name,pads:padNames,node:el("package",{name},children)};
  }
  function boardLibraries(doc,defs,sink) {
    const reserve = names(), reserveRef = names(), packages = new Map(), elements = [], refs = new Map(), refsByLink = new Map();
    for (const item of doc.items) {
      if (item.kind !== "part") continue;
      const def = defs.get(item.def), footprint = def?.footprint;
      if (!footprint) { say(sink,doc,item,"dropped","The component has no footprint geometry."); continue; }
      const bottom = item.layer === "Bottom", mirror = !!item.mirror;
      const key = JSON.stringify([def.id,bottom,mirror]);
      let entry = packages.get(key);
      if (!entry) {
        const name = reserve(footprint.name || def.name,"Package");
        packages.set(key,entry=packageGeometry(def,name,bottom,mirror,doc,sink));
      }
      const name = reserveRef(item.ref,def.prefix || "U"), attributes = fieldPositions(item,bottom ? [26,28] : [25,27]);
      elements.push(el("element",{name,library:libraryName,package:entry.name,value:item.value ?? def.value ?? "",
        ...pos(item.x,item.y),rot:rotation(bottom ? item.angle || 0 : -(item.angle || 0),bottom),
        locked:item.locked ? "yes" : undefined,smashed:attributes.length ? "yes" : undefined},attributes));
      const record = {name,package:entry,item};
      refs.set(item.id,record);
      if (item.link && !refsByLink.has(item.link)) refsByLink.set(item.link,record);
      const changed = name !== item.ref;
      say(sink,doc,item,changed ? "approximated" : "kept",changed ? "The reference was assigned a unique EAGLE name." : undefined);
    }
    for (const item of doc.items) {
      if (item.kind !== "pad" || item.plated === false) continue;
      const number = String(item.number || "1"), bottom = item.layer === "Bottom";
      const geometry = {...item,x:0,y:0,angle:0,number};
      const name = reserveRef(item.ref,"PAD"), pkgName = reserve("Standalone-Pad","Pad");
      const pkg = packageGeometry({id:item.id,footprint:{pads:[geometry]}},pkgName,bottom,false,doc,null);
      if (!pkg.pads.size) {
        say(sink,doc,item,"dropped","The standalone pad dimensions cannot be exported.");
        continue;
      }
      packages.set(item.id,pkg);
      const pad = {...item,pinNets:item.net ? {[number]:item.net} : {}};
      refs.set(item.id,{name,package:pkg,item:pad});
      elements.push(el("element",{name,library:libraryName,package:pkg.name,value:"",...pos(item.x,item.y),
        rot:rotation(bottom ? item.angle || 0 : -(item.angle || 0),bottom)}));
      say(sink,doc,item,"approximated","The standalone pad is represented by an EAGLE element with one pad.");
    }
    const byRef = new Map();
    for (const row of refs.values()) if (row.item.kind === "part" && !byRef.has(row.item.ref)) byRef.set(row.item.ref,row);
    return {packages:[...packages.values()].map(p=>p.node),elements,refs,refsByLink,byRef};
  }
  function fieldPositions(item,layers) {
    return [["NAME",item.refAt,item.showRef,layers[0]],["VALUE",item.valueAt,item.showValue,layers[1]]].flatMap(([name,where,show,layer])=>{
      if (!where && show !== false) return [];
      const at = A.world(where || [0,0],item);
      return [el("attribute",{name,...pt(at),size:1.27,layer,rot:rotation(-(item.angle || 0)),display:show === false ? "off" : "value"})];
    });
  }
  function outline(doc,sink) {
    const S = globalThis.AtriumBoardShape, shape = S.current(doc);
    const result = [];
    if (!shape) return result;
    for (const [ringIndex,ring] of [shape.contour,...(shape.cutouts || [])].entries()) {
      const before = result.length;
      for (const segment of ring) {
        const [a,b] = S.ends(segment);
        if (segment.kind !== "arc") result.push(wire(a,b,0,20));
        else {
          const sweep = S.sweep(segment);
          if (Math.abs(sweep) >= 359.999) {
            const halves = S.splitArc(segment,[segment.start+sweep/2]);
            for (const half of halves) result.push(wire(...S.ends(half),0,20,S.sweep(half)));
          } else result.push(wire(a,b,0,20,sweep));
        }
      }
      if (result.length > before) say(sink,doc,{id:doc.id+"/outline/"+ringIndex},"kept",undefined,ringIndex ? "Board cutout" : "Board outline");
    }
    return result;
  }
  const clearanceKeys = ["WireWire","WirePad","WireVia","PadPad","PadVia","ViaVia","SmdPad","SmdVia","SmdSmd"];
  function rules(doc,project,signalNames,layers,sink) {
    const R = globalThis.AtriumRules, active = R?.stored(doc,project) || doc.rules;
    const author = active?.list && active.ruleSets?.some(set=>set.enabled === false) && R?.ruleActive ?
      R.normalize({...active,list:active.list.filter(rule=>R.ruleActive(active,rule))}) : active;
    const defaults = author?.defaults || {}, classes = [el("class",{number:0,name:"default",width:n(defaults.trackWidth),drill:n(defaults.viaDrill)})];
    const assigned = new Map(), sets = new Map();
    for (const net of signalNames) {
      const set = Object.hasOwn(author?.nets || {},net) && author.nets[net];
      if (!set) continue;
      const [width,drill,gap] = [set.trackWidth ?? defaults.trackWidth,set.viaDrill ?? defaults.viaDrill,set.clearance];
      const key = JSON.stringify([width,drill,gap]);
      let number = sets.get(key);
      if (number == null) {
        number = classes.length;
        if (number >= 16) {say(sink,doc,{id:net},"dropped","EAGLE supports up to 16 net classes.","Net rule override"); continue;}
        sets.set(key,number);
        classes.push(el("class",{number,name:"Class"+number,width:n(width),drill:n(drill)},
          gap > 0 ? [el("clearance",{class:number,value:n(gap)})] : []));
      }
      assigned.set(net,number);
      say(sink,doc,{id:net},"kept",undefined,"Net rule override");
    }
    const properties = {layerSetup:"("+layers.join("*")+")",msWidth:n(positive(defaults.trackWidth,.25))+"mm",msDrill:n(positive(defaults.viaDrill,.3))+"mm"};
    for (const key of clearanceKeys) properties["md"+key] = n(positive(defaults.clearance,.2))+"mm";
    return {classes:container("classes",classes),assigned,parameters:Object.entries(properties).map(([name,value])=>el("param",{name,value}))};
  }
  function board(doc,project,defs,sink,source) {
    const catalogue = boardLibraries(doc,defs,sink), plain = outline(doc,sink), signals = new Map(), layers = new Set([1,16]);
    const signal = name => {
      if (!signals.has(name)) signals.set(name,{contacts:[],wires:[],vias:[],polygons:[]});
      return signals.get(name);
    };
    // EAGLE keeps every via in a signal: an unconnected via gets a signal of its own, as EAGLE names one.
    const netNames = new Set(doc.items.flatMap(i=>[i.net,...Object.values(i.pinNets || {})]).filter(Boolean).map(v=>String(v).toUpperCase()));
    let freeSignals = 0;
    const freeSignal = () => { let name; do name = "N$"+(++freeSignals); while (netNames.has(name)); return name; };
    for (const {item,name,package:pkg} of catalogue.refs.values()) for (const [pad,net] of Object.entries(item.pinNets || {})) {
      if (!net) continue;
      const mapped = pkg.pads.get(pad);
      if (!mapped) {say(sink,doc,{id:item.id+"/"+pad},"dropped","No exported package pad matches this contact.","Pad net assignment"); continue;}
      for (const pin of mapped) signal(net).contacts.push(el("contactref",{element:name,pad:pin}));
      say(sink,doc,{id:item.id+"/"+pad},"kept",undefined,"Pad net assignment");
    }
    for (const item of doc.items) {
      if (item.kind === "part" || item.kind === "pad" && item.plated !== false) continue;
      const layer = layerNumber(item.layer), net = item.net;
      let status = "kept", reason;
      if (item.kind === "track" && copper(item.layer) && item.points?.length >= 2) {
        layers.add(layer);
        const target = net ? signal(net).wires : plain, shape = A.pathArc(item), sweep = shape && A.arcSweep(shape);
        if (shape && Math.abs(sweep) < 359.999)
          target.push(wire(xy(item.points[0]),xy(item.points.at(-1)),positive(item.width,.254),layer,sweep));
        else target.push(...wires(item.points,positive(item.width,.254),layer,xy,item.closed));
        if (!shape && item.points.length > 2 || item.closed) {status = "approximated"; reason = "The track was split into EAGLE wire segments.";}
      } else if (item.kind === "via") {
        const drill = positive(item.drill,.3), a = copper(item.fromLayer) || 1, b = copper(item.toLayer) || 16;
        const from = Math.min(a,b), to = Math.max(a,b);
        if (from === to) {say(sink,doc,item,"dropped","The via does not span two copper layers."); continue;}
        layers.add(from); layers.add(to);
        signal(net || freeSignal()).vias.push(el("via",{...pos(item.x,item.y),extent:from+"-"+to,drill:n(drill),diameter:n(Math.max(positive(item.diameter,2*drill),drill+.001)),shape:"round"}));
        if (item.stack || item.padstack || item.backdrill || item.holeType || item.fromLayer && !copper(item.fromLayer) || item.toLayer && !copper(item.toLayer)) {
          status = "approximated"; reason = "EAGLE retains the via span and drill without native via-stack details.";
        }
        if (!net) {status = "approximated"; reason = (reason ? reason+" " : "")+"The unconnected via is written in a signal of its own.";}
      } else if (item.kind === "polygon" && layer) {
        const hatched = item.fillMode === "hatched", p = polygon(item.points,{width:n(positive(item.hatchWidth,.254)),layer,
          pour:hatched ? "hatch" : "solid",spacing:hatched ? n(positive(item.hatchPitch,1.27)) : undefined,
          isolate:item.clearance > 0 ? n(item.clearance) : undefined,
          rank:item.pourIndex > 0 ? Math.min(6,Math.trunc(item.pourIndex)) : undefined,
          thermals:item.connectStyle === "direct" ? "no" : "yes",orphans:item.removeDeadCopper === false ? "yes" : "no"});
        if (!p) {say(sink,doc,item,"dropped","The pour boundary needs three vertices.");continue;}
        if (copper(item.layer)) layers.add(layer);
        (net && copper(item.layer) ? signal(net).polygons : plain).push(p);
        status = "approximated"; reason = "The boundary is preserved. EAGLE recalculates the fill with its own thermal and hatch rules.";
      } else if (item.kind === "pad" && item.plated === false && item.drill > 0) {
        plain.push(el("hole",{...pos(item.x,item.y),drill:n(item.drill)}));
        if (item.slotLength > item.drill) {status = "approximated"; reason = SLOT;}
      } else if (["graphic","label","circle","text"].includes(item.kind)) {
        const graphic = art(item,layer);
        if (!graphic.length) {say(sink,doc,item,"dropped","The geometry or its layer has no EAGLE counterpart.");continue;}
        plain.push(...graphic);
        if (graphic.length > 1) {status = "approximated"; reason = "The graphic was split into EAGLE wire segments.";}
      } else {say(sink,doc,item,"dropped","This PCB object has no EAGLE representation in the exporter.");continue;}
      say(sink,doc,item,status,reason);
    }
    for (const p of catalogue.packages) for (const pad of p.children) {
      if (pad.name === "smd" && pad.attrs.layer >= 1 && pad.attrs.layer <= 16) layers.add(+pad.attrs.layer);
    }
    const usedLayers = [...layers].sort((a,b)=>a-b);
    const {classes,parameters,assigned} = rules(doc,project,signals.keys(),usedLayers,sink);
    const supported = new Set(parameters.map(p=>p.attrs.name));
    const retained = sourceNodes(source,doc,sink,"board",supported);
    plain.push(...retained.dimensions);
    const libraries = container("libraries",[el("library",{name:libraryName},[container("packages",catalogue.packages)])]);
    const out = el("board",{},[...retained.descriptions,container("plain",plain),libraries,classes,
      el("designrules",{name:"Waffle"},parameters),container("autorouter",[]),container("elements",catalogue.elements),
      container("signals",[...signals].map(([name,s])=>el("signal",{name,class:assigned.get(name) ?? 0},[...s.contacts,...s.wires,...s.vias,...s.polygons])))]);
    return {content:out,catalogue,layers:[...new Set([...usedLayers,...Object.keys(palette).map(Number).filter(l=>l>16&&l<91)])].sort((a,b)=>a-b)};
  }
  const direction = ["in","io","out","oc","pas","hiz","pas","pwr"];
  function pinSymbols(geo,pkg,gate,doc,id,sink) {
    const reserve = names(), groups = new Map(), byNumber = new Map(), nodes = [], connects = [];
    for (const pin of geo.pins || []) {
      const number = String(pin.number ?? ""), label = String(pin.name || number || "Pin");
      const key = JSON.stringify([label,pin.x,pin.y,pin.electrical]);
      if (!groups.has(key)) groups.set(key,{pin,label,numbers:[]});
      groups.get(key).numbers.push(number);
    }
    for (const [index,{pin,label,numbers}] of [...groups.values()].entries()) {
      const pads = [...new Set(numbers.flatMap(number=>pkg?.pads.get(number) || []))];
      const name = reserve(pads.length ? label : numbers[0] || label,"Pin");
      for (const number of numbers) if (!byNumber.has(number)) byNumber.set(number,name);
      nodes.push(el("pin",{name,...pos(pin.x,pin.y),visible:"off",length:"point",direction:direction[pin.electrical] || "pas"}));
      if (pads.length) connects.push(el("connect",{gate,pin:name,pad:pads.join(" ")}));
      const approx = !!pin.hidden || !pads.length && name !== label || !!pkg && !pads.length || pin.electrical === 6;
      say(sink,doc,{id:id+"/"+gate+"/pin/"+(index+1)},approx ? "approximated" : "kept",
        approx ? "The pin connection point is preserved. Some pin naming, display, or pad mapping cannot be carried into this device." : undefined,"Symbol pin");
    }
    return {nodes,byNumber,connects};
  }
  function packageCatalog(source) {
    const result = new Map();
    for (const library of list(body(source?.drawing,"schematic","libraries"),"library")) {
      for (const pkg of list(get(library,"packages"),"package")) {
        const name = pkg.attrs.name;
        if (!name) continue;
        if (result.has(name)) {result.set(name,null); continue;}
        result.set(name,pkg);
      }
    }
    return result;
  }
  function retainedPackage(node,reserve) {
    const children = [];
    const allowed = new Set(["description","smd","pad","hole","wire","text","circle","rectangle","polygon","vertex","dimension"]);
    const attrs = new Set(("name x y x1 y1 x2 y2 x3 y3 x4 y4 dx dy drill diameter width radius size ratio layer rot shape first roundness " +
      "stop cream thermals curve cap style pour isolate spacing rank orphans font align dtype unit precision visible language").split(" "));
    function convert(o) {
      if (!allowed.has(o.name)) return null;
      const fields = Object.fromEntries(Object.entries(o.attrs).filter(([key])=>attrs.has(key)));
      const vertices = o.name === "polygon" ? o.children.filter(row=>row.name === "vertex").map(convert) : [];
      const content = o.name === "text" || o.name === "description" ? [o.text] : vertices.map(v=>v.row);
      return {row:el(o.name,fields,content),complete:o.children.every(c=>c.name === "vertex") &&
        vertices.every(v=>v.complete) && Object.keys(fields).length === Object.keys(o.attrs).length};
    }
    const pads = new Map();
    let complete = true;
    for (const child of node.children) {
      const mapped = convert(child);
      if (!mapped) {complete = false; continue;}
      complete &&= mapped.complete;
      children.push(mapped.row);
      if ((child.name === "smd" || child.name === "pad") && child.attrs.name) pads.set(child.attrs.name,[child.attrs.name]);
    }
    const name = reserve(node.attrs.name,"Package");
    return {name,pads,node:el("package",{name},children),complete};
  }
  function schematic(docs,defs,sink,source,linkedBoard) {
    const reservePart = names(), reserveSet = names(), reserveSymbol = names(), reservePackage = names();
    const parts = [], symbols = [], sets = [], packages = new Map(), devices = new Map(), placements = new Map();
    const originalPackages = packageCatalog(source), importedPackages = new Map(), byPart = new Map(), livePackages = new Map();
    for (const pkg of linkedBoard?.packages || []) reservePackage(pkg.attrs.name,"Package");
    const packageFor = (item,def,doc) => {
      const found = (item.link && linkedBoard?.refsByLink.get(item.link)) || linkedBoard?.byRef.get(item.ref);
      if (found) {packages.set(found.package.name,found.package.node); return found;}
      if (def.footprint) {
        if (!livePackages.has(def.id)) {
          const name = reservePackage(def.footprint.name || def.name,"Package");
          const pkg = packageGeometry(def,name,false,false,doc,sink);
          livePackages.set(def.id,pkg); packages.set(name,pkg.node);
        }
        return {package:livePackages.get(def.id)};
      }
      const preferred = def.footprintName || def.footprint?.name;
      if (!preferred) return null;
      const original = originalPackages.get(preferred);
      if (!original) {
        if (!importedPackages.has(preferred)) say(sink,doc,{id:def.id},"dropped",
          "The schematic refers to a package with no verified geometry available.", "Schematic package association");
        importedPackages.set(preferred,null);
        return null;
      }
      if (!importedPackages.has(preferred)) {
        const pkg = retainedPackage(original,reservePackage);
        packages.set(pkg.name,pkg.node);
        importedPackages.set(preferred,pkg);
        say(sink,doc,{id:def.id},"approximated",pkg.complete ? "The undrawn package was reconstructed from its verified source geometry." :
          "The verified source package was retained with supported EAGLE graphics and pads.","Schematic package association");
      }
      return {package:importedPackages.get(preferred)};
    };
    function device(def,pkg,doc,alternate) {
      const key = JSON.stringify([def.id,pkg?.name || "",alternate]), saved = devices.get(key);
      if (saved) return saved;
      const name = reserveSet(def.name,"Device"), gates = [], connects = [], pinMaps = new Map();
      for (let unit=1;unit<=Math.max(1,def.symbol.parts || 1);unit++) {
        const gate = "G$"+unit, symbol = reserveSymbol(def.name+"-"+unit,"Symbol");
        const ofUnit = row => !row.part || row.part === unit;
        const geo = {pins:(def.symbol.pins || []).filter(ofUnit),shapes:(def.symbol.shapes || []).filter(row=>ofUnit(row) && (row.alt == null || !!row.alt === alternate))};
        const {nodes,byNumber,connects:links} = pinSymbols(geo,pkg,gate,doc,def.id,sink);
        connects.push(...links);
        const shapes = geo.shapes.flatMap((shape,index)=>{
          const output = art(shape.kind === "text" && /^\.designator$/i.test(shape.text) ? {...shape,text:">NAME"} :
            shape.kind === "text" && /^\.comment$/i.test(shape.text) ? {...shape,text:">VALUE"} : shape,94);
          const reason = !output.length ? "The symbol graphic has no EAGLE counterpart." :
            output.length > 1 ? "The symbol graphic was split into EAGLE wire segments." : undefined;
          say(sink,doc,{id:def.id+"/"+gate+"/graphic/"+(index+1)},!output.length ? "dropped" : reason ? "approximated" : "kept",reason,"Symbol graphic");
          return output;
        });
        if (!shapes.some(s=>s.name === "text" && s.children[0] === ">NAME")) shapes.push(text({x:0,y:-2.54,size:1.778,text:">NAME"},95));
        if (!shapes.some(s=>s.name === "text" && s.children[0] === ">VALUE")) shapes.push(text({x:0,y:2.54,size:1.778,text:">VALUE"},96));
        symbols.push(el("symbol",{name:symbol},[...shapes,...nodes]));
        gates.push(el("gate",{name:gate,symbol,x:0,y:0,addlevel:unit === 1 ? "next" : "request"}));
        pinMaps.set(unit,byNumber);
      }
      const device = el("device",{name:"",package:pkg?.name},[...(pkg && connects.length ? [container("connects",connects)] : []),
        container("technologies",[el("technology",{name:""})])]);
      sets.push(el("deviceset",{name,prefix:token(def.prefix,"U"),uservalue:"yes"},[
        container("gates",gates),container("devices",[device])]));
      const record = {name,pinMaps};
      devices.set(key,record);
      if (def.symbol.netTie)
        say(sink,doc,{id:def.id},"approximated","The symbol and pins are retained without a native net-tie exemption.","Net tie");
      return record;
    }
    const supplies = new Map();
    function addSupply(item,doc) {
      const net = String(item.text || "");
      if (!net) {
        say(sink,doc,item,"dropped","A supply port requires a net name.");
        return;
      }
      const inferred = /gnd|vss|ground/i.test(net) ? "gnd" : /earth|chassis/i.test(net) ? "earth" : "bar";
      const key = net+"\u001f"+inferred;
      let spec = supplies.get(key);
      if (!spec) {
        const name = reserveSet(net+"-supply","Supply"), symbol = reserveSymbol(net+"-supply","Supply");
        const lines = inferred === "bar" ? [[[0,0],[0,2.54]],[[-1.27,2.54],[1.27,2.54]]] :
          [[[0,0],[0,-2.54]],[[-1.27,-2.54],[1.27,-2.54]],[[-.8,-3.175],[.8,-3.175]],[[-.35,-3.81],[.35,-3.81]]];
        const pin = token(net,"SUPPLY");
        symbols.push(el("symbol",{name:symbol},[...lines.map(([a,b])=>wire(a,b,.1524,94)),
          el("pin",{name:pin,x:0,y:0,direction:"sup",length:"point",visible:"off"})]));
        sets.push(el("deviceset",{name,prefix:"SUPPLY"},[container("gates",[el("gate",{name:"1",symbol,x:0,y:0})]),
          container("devices",[el("device",{name:""},[container("technologies",[el("technology",{name:""})])])])]));
        supplies.set(key,spec={name,pin});
      }
      const part = reservePart("","SUPPLY"), base = inferred === "bar" ? 1 : 3, r = ((item.direction ?? base)-base)*90;
      parts.push(el("part",{name:part,library:libraryName,deviceset:spec.name,device:"",value:net}));
      placements.set(item.id,{name:part,gate:"1",pin:spec.pin,instance:el("instance",{part,gate:"1",...pos(item.x,item.y),rot:rotation(r)})});
      const approx = !!item.style && item.style !== inferred || inferred === "earth";
      say(sink,doc,item,approx ? "approximated" : "kept",approx ? "The named supply is represented using a standard EAGLE symbol." : undefined);
    }
    for (const doc of docs) for (const item of doc.items) {
      if (item.kind === "power") {addSupply(item,doc);continue;}
      if (item.kind !== "part") continue;
      const def = defs.get(item.def);
      if (!def?.symbol) {say(sink,doc,item,"dropped","The component has no schematic symbol geometry.");continue;}
      const match = packageFor(item,def,doc), unit = item.unit || item.part || 1;
      const value = item.value ?? def.value ?? "", chosen = device(def,match?.package,doc,!!item.alt);
      const pins = chosen.pinMaps.get(unit);
      if (!pins) {say(sink,doc,item,"dropped","The placed gate does not exist in its library definition.");continue;}
      const groupKey = JSON.stringify([item.ref,chosen.name,value]), group = byPart.get(groupKey) || [];
      let part = group.find(p=>!p.units.has(unit));
      if (!part) {
        part = {name:reservePart(match?.name || item.ref,def.prefix || "U"),units:new Set()};
        group.push(part);
        byPart.set(groupKey,group);
        parts.push(el("part",{name:part.name,library:libraryName,deviceset:chosen.name,device:"",value}));
      }
      part.units.add(unit);
      const gate = "G$"+unit, attributes = fieldPositions(item,[95,96]);
      const nativeAngle = item.angle || 0, angle = Math.round(nativeAngle/90)*90;
      const instance = el("instance",{part:part.name,gate,...pos(item.x,item.y),rot:rotation(item.mirror ? angle : -angle,!!item.mirror),
        smashed:attributes.length ? "yes" : undefined},attributes);
      placements.set(item.id,{name:part.name,gate,pins,instance});
      const approximation = Math.abs(nativeAngle-angle) > 1e-6 ? "EAGLE schematic instances can only rotate in 90-degree steps." :
        part.name !== item.ref ? "The reference was assigned a unique EAGLE name." : item.alt ? "The placed alternate symbol was written as a separate EAGLE device." : undefined;
      say(sink,doc,item,approximation ? "approximated" : "kept",approximation);
    }
    const library = el("library",{name:libraryName},[container("packages",[...packages.values()]),container("symbols",symbols),
      container("devicesets",sets)]);
    const retained = sourceNodes(source,docs[0],sink,"schematic");
    const sheetNodes = docs.map(doc=>sheet(doc,defs,sink,placements,source));
    return el("schematic",retained.crossReferences,[
      ...retained.descriptions,container("libraries",[library]),container("parts",parts),container("sheets",sheetNodes)]);
  }
  function sheet(doc,defs,sink,placements,source) {
    const graph = AtriumERC.graph(doc,defs), nets = new Map(), logical = new Set(graph.nets);
    const instances = [], plain = [], busses = [], busName = names();
    const add = (net,key,kind,node) => {
      if (!nets.has(net)) nets.set(net,new Map());
      const segments = nets.get(net);
      if (!segments.has(key)) segments.set(key,{pinref:[],wire:[],junction:[],label:[],pins:new Set()});
      const segment = segments.get(key);
      if (kind === "pinref") {
        const value = JSON.stringify(node.attrs);
        if (segment.pins.has(value)) return;
        segment.pins.add(value);
      }
      segment[kind].push(node);
    };
    const fromKey = at => {
      const key = A.pointKey(at), net = graph.netOf(key);
      return {key:graph.physicalOf(key) || key,net:logical.has(net) ? net.name : null};
    };
    for (const {i,pin,key} of graph.contacts) {
      const place = placements.get(i.id), name = place?.pins.get(String(pin.number ?? "")), net = graph.netOf(key);
      if (!name || !logical.has(net)) continue;
      add(net.name,graph.physicalOf(key),"pinref",el("pinref",{part:place.name,gate:place.gate,pin:name}));
    }
    for (const item of doc.items) {
      const placed = placements.get(item.id);
      if (item.kind === "part" || item.kind === "power") {
        if (placed) {
          instances.push(placed.instance);
          if (placed.pin) {
            const {key,net} = fromKey([item.x,item.y]);
            add(net || item.text,key,"pinref",el("pinref",{part:placed.name,gate:placed.gate,pin:placed.pin}));
          }
        }
        continue;
      }
      let reason;
      if (item.kind === "wire" && item.points?.length > 1) {
        const {key,net} = fromKey(xy(item.points[0]));
        const name = net || item.net || "N$"+(nets.size+1);
        const segments = wires(item.points,positive(item.width,.1524),91);
        if (item.points.length === 2 && near(xy(item.points[0]),xy(item.points[1])) && nets.get(name)?.get(key)?.pinref.length) {
          // EAGLE represents direct pin joins through pin references without a zero-length wire.
          reason = "Direct pin connection written without a redundant zero-length segment.";
        } else for (const segment of segments) add(name,key,"wire",segment);
        reason ||= item.net && item.net !== name ? "Conflicting wire names were replaced with the connected net name." :
          segments.length > 1 ? "The wire was split into EAGLE wire segments." : undefined;
      } else if (item.kind === "junction") {
        const {key,net} = fromKey([item.x,item.y]);
        if (!net) {say(sink,doc,item,"dropped","The junction touches no exported net.");continue;}
        add(net,key,"junction",el("junction",pos(item.x,item.y)));
      } else if (item.kind === "netlabel" || item.kind === "port" || A.isOffsheet(item)) {
        const {key,net} = fromKey([item.x,item.y]), name = net || item.text;
        if (!name) {say(sink,doc,item,"dropped","The label has no net name.");continue;}
        add(name,key,"label",el("label",{...pos(item.x,item.y),size:n(positive(item.size,1.778)),layer:95,rot:rotation(-(item.angle || 0))}));
        if (item.kind !== "netlabel" || A.isOffsheet(item) || item.text && item.text !== name)
          reason = "The connector is represented as an EAGLE named net label.";
      } else if (item.kind === "bus" && item.points?.length >= 2) {
        const name = busName(item.name,"BUS");
        busses.push(el("bus",{name},[container("segment",wires(item.points,positive(item.width,.254),92))]));
        reason = "The bus geometry is retained without a native bus membership expression.";
      } else if (["graphic","label","circle","text"].includes(item.kind)) {
        const graphics = art(item,item.kind === "label" || item.kind === "text" ? 97 : 94);
        if (!graphics.length) {say(sink,doc,item,"dropped","The drawing object has no EAGLE geometry.");continue;}
        plain.push(...graphics);
        if (graphics.length > 1) reason = "The graphic was split into EAGLE wire segments.";
      } else {say(sink,doc,item,"dropped","This schematic object has no EAGLE representation in the exporter.");continue;}
      say(sink,doc,item,reason ? "approximated" : "kept",reason);
    }
    const sourceIndex = source?.documents.indexOf(doc.id) ?? -1;
    const original = list(body(source?.drawing,"schematic","sheets"),"sheet")[sourceIndex];
    for (const dimension of list(get(original,"plain"),"dimension")) {
      const kept = retainedDimension(dimension);
      if (kept) plain.push(kept.node);
      say(sink,doc,{id:"source/"+dimension.sourceOffset},kept?.status || "dropped",
        kept?.reason || "The original dimension has fields outside the supported EAGLE format.","Original EAGLE dimension");
    }
    return container("sheet",[...(get(original,"description") ? [description(get(original,"description"))] : []),
      container("plain",plain),container("instances",instances),container("busses",busses),
      container("nets",[...nets].map(([name,segments])=>el("net",{name,class:0},[...segments.values()].map(segment=>
        container("segment",[...segment.pinref,...segment.wire,...segment.junction,...segment.label])))))]);
  }
  const description = row => el("description",{language:row.attrs.language},[row.text]);
  const dimensionAttrs = new Set("x1 y1 x2 y2 x3 y3 layer dtype width extwidth extlength extoffset textsize textratio unit precision visible".split(" "));
  function retainedDimension(row) {
    if (row.children.length || Object.keys(row.attrs).some(key=>!dimensionAttrs.has(key)) ||
        !["x1","y1","x2","y2","x3","y3","layer"].every(key=>Number.isFinite(Number(row.attrs[key]))) ||
        row.attrs.dtype && !/^(parallel|horizontal|vertical|radius|diameter|leader)$/.test(row.attrs.dtype) ||
        row.attrs.unit && !/^(mic|mm|mil|inch)$/.test(row.attrs.unit)) return null;
    const current = row.attrs.width != null && row.attrs.textsize != null;
    return {node:el("dimension",{width:"0.1524",textsize:"1.27",...row.attrs}),status:current ? "kept" : "approximated",
      reason:current ? "Retained standalone source dimension." : "The original dimension uses the older EAGLE line and text size defaults."};
  }
  function sourceNodes(source,doc,sink,kind,parameters = new Set()) {
    const root = get(source?.drawing,kind), descriptions = list(root,"description").map(description), dimensions = [];
    const original = (row,status,reason,which = row.name) =>
      say(sink,doc,{id:"source/"+row.sourceOffset},status,reason,"Original EAGLE "+which.slice(0,90));
    for (const row of list(root,"description")) original(row,"kept","Retained source description.");
    if (kind === "board") for (const row of list(get(root,"plain"),"dimension")) {
      const dimension = retainedDimension(row);
      if (dimension) dimensions.push(dimension.node);
      original(row,dimension?.status || "dropped",dimension?.reason || "The source dimension includes unsupported fields.");
    }
    const knownRoot = new Set((kind === "board" ? "description plain libraries classes designrules autorouter elements signals" :
      "description libraries parts sheets").split(" "));
    for (const row of root?.children || []) {
      if (!knownRoot.has(row.name) && row.children.length + row.text.length > 0)
        original(row,"dropped","This retained EAGLE section cannot be regenerated from the selected design.");
    }
    for (const row of list(get(root,"designrules"),"param")) if (!parameters.has(row.attrs.name)) {
      const automatic = /^(?:rv|rlMin|rlMax)(?:PadTop|ViaOuter)$/.test(row.attrs.name || "");
      original(row,automatic ? "approximated" : "dropped",automatic ?
        "Existing pad and via dimensions are written explicitly without the original automatic sizing rule." :
        "The original router or manufacturing rule has no editable Waffle equivalent.", "rule parameter");
    }
    for (const row of get(root,"autorouter")?.children || [])
      original(row,"dropped","Author-specific autorouter passes were not transferred.");
    const plainLists = kind === "board" ? [get(root,"plain")] : list(get(root,"sheets"),"sheet").map(s=>get(s,"plain"));
    for (const plain of plainLists) for (const row of plain?.children || []) {
      if (!["wire","text","rectangle","circle","polygon","frame","hole","dimension"].includes(row.name))
        original(row,"dropped","The original drawing element has no supported mapping.");
    }
    const crossReferences = {};
    for (const key of ["xreflabel","xrefpart"]) if (typeof root?.attrs[key] === "string") crossReferences[key] = root.attrs[key];
    return {descriptions,dimensions,crossReferences};
  }
  function originals(provenance,selected,sink) {
    const groups = (Array.isArray(provenance) ? provenance : [provenance]).filter(Boolean);
    const byOwner = new Map(), wanted = new Set(selected.map(doc=>doc.id));
    for (const source of groups.flatMap(group=>group.files || [])) {
      if (!/\.(sch|brd)$/i.test(source.name || source.path || "") || !source.documents?.some(id=>wanted.has(id)) ||
          !(source.bytes instanceof Uint8Array)) continue;
      const file = source.path || source.name;
      try {
        if (!source.sha256 || AtriumSourceFile.sha256(source.bytes) !== source.sha256) throw Error("The retained bytes differ from the import digest.");
        const tree = AtriumEagleImport.parseXML(new TextDecoder("utf-8",{fatal:true}).decode(source.bytes),{see(row,offset){row.sourceOffset=offset;}});
        const drawing = body(tree,"eagle","drawing");
        if (!drawing) throw Error("The retained file is not an EAGLE XML drawing.");
        for (const id of source.documents) {
          if (byOwner.has(id)) byOwner.set(id,null);
          else byOwner.set(id,{drawing,documents:source.documents,file});
        }
      } catch (error) {
        sink.add("Original EAGLE data","dropped",{file},error.message);
      }
    }
    return byOwner;
  }
  function reportRules(project,selected,sink) {
    if (!project.rules?.list?.length) return;
    const R = globalThis.AtriumRules;
    const boards = selected.filter(doc=>doc.kind === "pcb").map(doc=>{
      const nets = new Set();
      for (const item of doc.items) {
        if (item.net) nets.add(item.net);
        for (const net of Object.values(item.pinNets || {})) if (net) nets.add(net);
      }
      return {doc,nets,rules:R?.stored(doc,project)};
    });
    if (!boards.length) return;
    function normal(value) {
      if (Array.isArray(value)) return value.map(normal);
      if (!value || typeof value !== "object") return value;
      return Object.fromEntries(Object.keys(value).sort().map(key=>[key,normal(value[key])]));
    }
    const selector = scope => scope?.languageVersion === undefined ? scope || {kind:"all"} :
      globalThis.AtriumDesignQueryRecord?.toSelector(scope);
    // Rule-book adoption assigns a native ID and can bind the same stock template to each imported board.
    const signature = ({id,origin,priority,boards,exceptBoards,scope,scope2,...values}) =>
      JSON.stringify(normal({...values,scope:selector(scope) ?? scope,...(scope2 ? {scope2:selector(scope2) ?? scope2} : {})}));
    const defaults = new Map((R?.migrate(null).list || []).map(rule=>[rule.id,signature(rule)]));
    const supplied = {clearance:["gap","objects"],width:["min","max","preferred","neckLength","impedanceProfile"],
      viaStyle:["holeMin","holeMax","holePreferred","diameterMin","diameterMax","diameterPreferred","style"]};
    for (const rule of project.rules.list) {
      if (!rule.enabled || rule.severity === "off" || rule.where === "schematic") continue;
      const template = rule.origin?.kind === "default" ? rule.origin.key : rule.id;
      if ((!rule.origin || rule.origin.kind === "default") && defaults.get(template) === signature(rule)) continue;
      const scope = selector(rule.scope), other = selector(rule.scope2);
      const used = boards.some(({doc,nets,rules})=>
        (!rule.boards?.length || rule.boards.includes(doc.id)) && !rule.exceptBoards?.includes(doc.id) &&
        (!R?.ruleActive || R.ruleActive(rules,rule)) &&
        (scope?.kind !== "net" || nets.has(scope.value)) && (other?.kind !== "net" || nets.has(other.value)));
      if (!used) continue;
      const fields = Object.hasOwn(supplied,rule.type) && supplied[rule.type];
      const mapped = fields && rule[fields[0]] > 0 && ["all","net"].includes(scope?.kind) && other?.kind === "all";
      if (mapped && !fields.slice(1).some(key=>rule[key] != null && rule[key] !== "" && rule[key] !== 0)) continue;
      sink.add("Design rule",mapped ? "approximated" : "dropped",{file:project.name || "Project",object:rule.id},
        mapped ? "EAGLE retains the exported minimum but cannot express the additional constraints of this rule." :
          "This Waffle rule does not map to an EAGLE board rule or net class.");
    }
  }
  function prepare(model,options,sink) {
    const project = globalThis.AtriumTranslatorProvenance?.toLegacy(model,options.provenance) || model;
    const scope = options.scope || (options.documentId ? "document" : "project");
    if (!["project","document","documents"].includes(scope)) throw Error("Unknown EAGLE export scope.");
    const selected = scope === "document" ? project.documents.filter(doc=>doc.id === options.documentId) : project.documents;
    if (!selected.length) throw Error("Choose an existing schematic or PCB document.");
    const defs = new Map(project.library.map(def=>[def.id,def])), byOwner = originals(options.provenance,selected,sink);
    const plans = new Map(), used = new Set(), entries = [];
    for (const doc of selected) {
      if (A.pristineImportPlaceholder(doc) && scope !== "document") continue;
      if (doc.kind !== "pcb" && doc.kind !== "schematic") {
        if (scope === "document") throw Error("Choose an existing schematic or PCB document.");
        say(sink,doc,doc,"dropped","An EAGLE project contains schematic sheets and boards.",doc.kind);
        for (const item of doc.items || []) say(sink,doc,item,"dropped","The owning document has no EAGLE equivalent.");
        continue;
      }
      const original = byOwner.get(doc.id)?.file || doc.sourceName;
      const eagle = original && /\.(sch|brd)$/i.test(original);
      const stem = fileStem(scope !== "project" ? doc.name : eagle ? original : project.name);
      const key = scope === "project" ? eagle ? original.replace(/\.(sch|brd)$/i,"").toLowerCase() : stem.toLowerCase() : doc.id;
      if (!plans.has(key)) plans.set(key,{stem,boards:[],sheets:[]});
      plans.get(key)[doc.kind === "pcb" ? "boards" : "sheets"].push(doc);
    }
    const filename = (stem,suffix) => {
      let name = stem+suffix;
      for (let index=2;used.has(name.toUpperCase());index++) name=stem+"-"+index+suffix;
      used.add(name.toUpperCase());
      return name;
    };
    const add = (name,docs,content,layers,source) => {
      for (const doc of docs) say(sink,doc,null,"kept","Written to "+name+".");
      entries.push({file:{name,text:drawings(content,layers,docs[0].grid,source?.drawing)},
        detail:{name,documentId:docs[0].id,documentIds:docs.map(doc=>doc.id),kind:docs[0].kind}});
    };
    for (const {stem,boards,sheets} of plans.values()) {
      const boardFiles = boards.map(doc=>{
        const source = byOwner.get(doc.id), result = board(doc,project,defs,sink,source);
        return {doc,source,result,name:filename(stem,".brd")};
      });
      if (sheets.length) {
        const source = byOwner.get(sheets[0].id), primary = boardFiles[0]?.result.catalogue;
        add(filename(stem,".sch"),sheets,schematic(sheets,defs,sink,source,primary),
          [91,92,93,94,95,96,97,98],source);
      }
      for (const {doc,source,result,name} of boardFiles) add(name,[doc],result.content,result.layers,source);
    }
    if (!entries.length) throw Error("This project has no schematic or PCB documents to export as EAGLE XML.");
    reportRules(project,selected,sink);
    const prefix = fileStem(project.name);
    return {files:entries.map(entry=>entry.file),details:{name:entries.length === 1 ? entries[0].file.name : prefix+"-eagle.zip",
      archivePrefix:prefix,outputs:entries.map(entry=>entry.detail)}};
  }
  return Object.freeze({export:prepare});
})();
