"use strict";
// Selection facts for the Calculators panel. Model distances stay in mm. A view contains
// only numbers, names and the identities needed to review an edit, never a live write handle.
globalThis.AtriumCalculatorContext = (() => {
  const G = globalThis;
  const round = x => Number(x.toPrecision(12));
  const positive = x => Number.isFinite(x) && x > 0;
  const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
  const named = new Set(["netlabel", "power", "port", "offsheet", "directive"]);
  const electrical = new Set([...named, "part", "wire", "junction", "busentry", "bus", "sheetsymbol", "noerc"]);
  function boardFor(project, doc) {
    if (doc.kind === "pcb") return doc;
    const boards = project.documents.filter(d => d.kind === "pcb" && !G.Atrium.pristineImportPlaceholder(d));
    return boards.length === 1 ? boards[0] : null;
  }
  function trackInputs(board, item, defs) {
    if (!positive(item.width) || !item.points || item.points.length < 2 || !item.points.every(p => p?.length === 2 && p.every(Number.isFinite))) return null;
    const key = item.layer || "Top", S = G.AtriumStackup, layer = S.layerInfo(board, key, defs);
    if (!layer?.copper) return null;
    // True arc primitives retain their physical length even when painted with chords.
    const length = G.Atrium.pathLength ? G.Atrium.pathLength(item) :
      item.points.slice(1).reduce((sum,[x,y],n) => sum + Math.hypot(x-item.points[n][0],y-item.points[n][1]),0);
    const copper = round(layer.thickness / S.OZ), side = layer.side === "Inner" ? "internal" : "external";
    return {track_resistance: {width:item.width, length:round(length), copper, layer:side},
      current_capacity: {solve:"current", width:item.width, copper, layer:side},
      track_width: {length:round(length), copper, layer:side}};
  }
  function ruleResolver(view, types) {
    const {project,board} = view, rules = G.AtriumRules;
    if (!rules) return null;
    if (!G.AtriumDesignQuery && G.AtriumLazy?.needsRuleQuery) {
      const book = rules.stored(board,project);
      const used = book?.list ? {...book,list:book.list.filter(rule=>types.includes(rule.type))} : book;
      if (G.AtriumLazy.needsRuleQuery(used,"pcb")) view.needsRuleQuery = true;
    }
    return rules.resolver(board,{project});
  }
  function viaInputs(view, item) {
    const {board,defs} = view;
    if (!positive(item.drill) || item.plated === false) return null;
    const S = G.AtriumStackup, V = G.AtriumViaStack;
    const sub = board.stackup?.regions?.length && S.stackAt(board,[item.x,item.y],defs);
    const stack = sub ? S.substacks(board,defs).find(s => s.id === sub) : S.get(board,defs);
    if (!stack) return null;
    const measure = V.measure(item,stack,defs), removed = measure.backdrill, [first,last] = V.spanOf(item);
    if (!measure.physical.copper.has(first) || !measure.physical.copper.has(last) || first === last) return null;
    const from = removed?.side === "top" ? removed.stopLayer : first, to = removed?.side === "bottom" ? removed.stopLayer : last;
    const depth = measure.depth - (removed?.depth || 0);
    if (!positive(depth)) return null;
    const fields = {drill:item.drill, from, to, length:round(depth)};
    const rule = ruleResolver(view,["currentCapacity"])?.("currentCapacity",{net:item.net || "",layer:from});
    if (positive(rule?.plating)) fields.plating = rule.plating; // rule stores µm
    else if (positive(board.thermal?.plating)) fields.plating = round(board.thermal.plating * 1000);
    if (positive(rule?.maxRise)) fields.rise = rule.maxRise;
    return {fields, diameter:V.minDiameter(item,measure.physical.keys)};
  }
  function profileFor(view, net, layer, source, track) {
    const {project,board,defs} = view;
    if (!board?.stackup?.impedanceProfiles?.length || !net) return null;
    const S = G.AtriumStackup, sigs = G.AtriumSignals.model(project, board, {defs});
    const pair = sigs.pairOf(net), opts = {net, layer, pairName:pair?.name, at:track?.points?.[0]};
    const query = ruleResolver(view,pair ? ["width","diffPairsRouting"] : ["width"]);
    const routing = pair && query?.("diffPairsRouting", opts)?.impedanceProfile || query?.("width", opts)?.impedanceProfile;
    const decl = sigs.byNet.get(net)?.sig.decl;
    let id = routing || source?.impedance?.profile || decl?.impedance?.profile;
    if (!id) {
      const tagged = sigs.tagsOf(net), profiles = new Set();
      for (const tag of sigs.store.tags || []) if (tagged.has(tag.name.toLowerCase()) && tag.impedance?.profile) profiles.add(tag.impedance.profile);
      for (const r of G.AtriumSignals.directives(project).records) if (r.net === net && r.impedance?.profile) profiles.add(r.impedance.profile);
      if (profiles.size === 1) [id] = profiles;
    }
    const p = id && S.impedanceProfiles(board, defs).find(p => p.id === id || p.name === id);
    if (!p) return null;
    if (!p.layers[layer] || p.layers[layer].enabled === false) {
      if (track) return null; // Never substitute another copper layer for a routed track.
      const targeted = Object.keys(p.layers).filter(k => p.layers[k].enabled !== false);
      if (!targeted.length) return null;
      layer = targeted[0];
    }
    const stack = opts.at && S.stackAt(board, opts.at, defs), row = S.profileValues(board, p.id, layer, defs, stack);
    if (!row || row.error) return null;
    const g = row.geom, diff = p.type.includes("diff"), width = track?.width ?? row.width;
    const fields = {layer, target:p.target, mode:diff ? "differential" : "single", width, structure:g.structure,
      thickness:g.t, er:g.er, etch:g.etch || 0, ground:g.g || 0};
    if (diff) fields.gap = row.gap;
    if (g.structure === "stripline") Object.assign(fields, {h1:g.h1, h2:g.h2});
    else Object.assign(fields, {height:g.h, mask:g.cover?.t || 0, mask_er:g.cover?.er || 3.5});
    return {name:p.name, id:p.id, fields, preferred:row.width, fixed:positive(p.layers[layer].width) && (!stack || stack === (p.stack || "main")),
      minimum:row.limits?.track ?? 0, multipleStacks:!!(track && board.stackup?.regions?.length && new Set(S.profileAlong(board,p.id,layer,track.points,defs).map(r => r.stack)).size > 1)};
  }
  const passiveMemo = new WeakMap();
  function passiveIndex(facts) {
    let byNet = passiveMemo.get(facts);
    if (byNet) return byNet;
    byNet = new Map();
    for (const entry of facts.two) {
      const {part, def, nets} = entry;
      if (part.fitted === false || part.dnp || !nets[0] || !nets[1] || nets[0] === nets[1]) continue;
      const family = def?.generic?.family || def?.category || "", ref = part.ref || "";
      const kind = /capacitor|polarised|electrolytic/i.test(family) || /^C\d/i.test(ref) ? "capacitor"
        : /resistor/i.test(family) || /^R\d/i.test(ref) ? "resistor" : null;
      if (!kind || /array|network|thermistor|varistor|potentiometer|trimmer/i.test(family)) continue;
      const params = G.Atrium.partParameters.parameters(part, def), name = kind === "capacitor" ? "capacitance" : "resistance";
      const prop = Object.keys(params).find(key => key.toLowerCase() === name);
      const value = G.AtriumGenericParts.parseValue(prop ? params[prop] : part.value || def?.value, kind)?.value;
      if (!positive(value)) continue;
      const leg = {part, kind, value, nets};
      for (const net of nets) {
        if (!byNet.has(net)) byNet.set(net, []);
        byNet.get(net).push(leg);
      }
    }
    passiveMemo.set(facts, byNet);
    return byNet;
  }
  function circuit(project, doc, defs, selected, net) {
    const facts = G.AtriumNetIntentIndex.localTerminals(project, doc, defs);
    const dividers = facts.dividers.filter(d => selected.length ? selected.every(i => i === d.top.pin.part || i === d.bottom.pin.part || i === d.regulator) : net === d.net);
    if (dividers.length === 1) {
      const d = dividers[0], top = d.top.pin.part, bottom = d.bottom.pin.part;
      const fields = {solve:"voltage", top:d.top.v, bottom:d.bottom.v, vref:d.vref || 0};
      if (d.vref) fields.vout = round(d.vref * (1 + d.top.v / d.bottom.v));
      // A displayed value can originate in a shared definition or explicit parameter.
      // Never replace a different field underneath that value.
      const writable = (part, ohms) => !part.locked && !Object.keys(G.Atrium.partParameters.parameters(part,defs.get(part.def))).some(k => /^resistance(?:ohms?)?$/i.test(k.replace(/\s/g,""))) &&
        G.AtriumGenericParts.parseValue(part.value,"resistor")?.value === ohms;
      return {id:"divider", label:[d.regulator.ref, d.net, top.ref + " / " + bottom.ref].filter(Boolean).join(" · "), fields:{divider:fields},
        divider:{top:top.id, bottom:bottom.id, upper:top.ref, lower:bottom.ref, values:[top.value,bottom.value], writable:writable(top,d.top.v) && writable(bottom,d.bottom.v)}};
    }
    const byNet = passiveIndex(facts), matches = [];
    const candidates = selected.length ? facts.two.find(e => e.part === selected[0])?.nets || [] : [net];
    for (const n of candidates) {
      if (!n || G.AtriumNetIntent.isSupply(n) || facts.names.get(n)?.power) continue;
      const legs = byNet.get(n) || [];
      if (legs.length !== 2 || !selected.every(i => legs.some(l => l.part === i))) continue;
      const r = legs.find(l => l.kind === "resistor"), c = legs.find(l => l.kind === "capacitor");
      if (r && c && r.nets.filter(x => c.nets.includes(x)).length === 1) matches.push({id:"rclc", label:[r.part.ref,c.part.ref,n].join(" · "),
        fields:{rclc:{r:r.value, c:round(c.value * 1e9), l:0}}});
    }
    return matches.length === 1 ? matches[0] : null;
  }
  function context(project, doc, defs, ids, highlight, activeLayer, preferNet = false) {
    const board = boardFor(project, doc);
    const view = {project, doc, board, defs, selection:JSON.stringify([ids,highlight,activeLayer,preferNet]), facts:null};
    if (!["pcb","schematic"].includes(doc.kind) || ids.length > 2 && !(preferNet && highlight)) return view;
    const selected = preferNet && highlight ? [] : ids.map(id => doc.items.find(i => i.id === id)).filter(Boolean);
    if (selected.length !== ids.length && !(preferNet && highlight)) return view;
    const item = selected.length === 1 ? selected[0] : null, onBoard = doc.kind === "pcb";
    let net = !selected.length ? highlight : item?.net || (named.has(item?.kind) ? item.text : null);
    if (item?.kind === "wire" && !onBoard) net = G.Atrium.sheetNets(project, doc, defs).byWire.get(item.id) || net;
    const track = onBoard && item?.kind === "track" && !item.fill && !item.keepout ? item : null;
    if (onBoard && item?.kind === "via") {
      const v = viaInputs(view, item);
      if (v) view.facts = {id:"via_current", label:["Via",net,v.fields.from+"–"+v.fields.to].filter(Boolean).join(" · "), fields:{via_current:v.fields}, item:{id:item.id, drill:item.drill, diameter:v.diameter, locked:!!item.locked}};
      return view;
    }
    let physical = null;
    if (track) {
      const fields = trackInputs(board, track, defs);
      if (fields) physical = {id:"track_resistance", label:["Track", net, track.layer || "Top"].filter(Boolean).join(" · "), fields,
        item:{id:track.id, width:track.width, locked:!!track.locked}};
    }
    if (onBoard && selected.length === 2 && board.stackup?.impedanceProfiles?.length &&
        selected.every(i => i.kind === "track" && !i.fill && !i.keepout) && selected[0].layer === selected[1].layer) {
      const [a,b] = selected, pair = G.AtriumSignals.model(project,board,{defs}).pairOf(a.net);
      if (pair && a.net !== b.net && [pair.positive,pair.negative].includes(b.net)) {
        const p = profileFor(view,pair.positive,a.layer || "Top",null,null);
        if (p?.fields.mode === "differential" && p.fields.layer === (a.layer || "Top")) {
          view.facts = {id:"impedance",label:[pair.name,p.name,p.fields.layer,"Routing profile"].join(" · "),profile:p,fields:{impedance:p.fields}};
          return view;
        }
      }
    }
    if (board && net) {
      const p = profileFor(view,net,track?.layer || activeLayer || "Top",item,track);
      if (p) {
        view.facts = {...physical,id:"impedance",label:[net,p.name,p.fields.layer].join(" · "),profile:p,fields:{...physical?.fields, impedance:p.fields}};
        return view;
      }
    }
    if (physical) view.facts = physical;
    else if (selected.length ? selected.every(i => i.kind === "part") || !onBoard && net : net) {
      view.facts = circuit(project,doc,defs,selected.every(i => i.kind === "part") ? selected : [],net);
    }
    return view;
  }
  // Only consult documents whose electrical content can change this context. A gap in
  // the undo journal always requests a fresh read. Non-electrical styling is ignored.
  function dependencies(view) {
    const docs = new Set([view.doc]);
    if (view.board) docs.add(view.board);
    if (view.board?.stackup?.impedanceProfiles?.length) for (const d of view.project.documents) if (d.kind === "schematic") docs.add(d);
    return [...docs];
  }
  const schematicKeys = ["kind","id","ref","def","value","parameters","type","partType","description","alt","dnp","fitted","locked","x","y","angle","mirror","part","unit","alternate","points","text","net","pinNets","impedance","tags","netClass","diffPair","signal","polarity","name","sheet","ports","entries","repeat","style","electrical"];
  const boardKeys = [...schematicKeys,"width","layer","fromLayer","toLayer","drill","diameter","plated","padStack","padStackMode","backdrill","arc","fill","keepout"];
  function relevant(a,b,keys) { return keys.some(k => a[k] !== b[k] && !same(a[k],b[k])); }
  function createReader(host) {
    let last = null, versions = new Map(), revision = null, unit = null;
    function read({fresh = false, preferNet = false} = {}) {
      const p = host.project(), d = host.doc(), ids = host.selection(), highlight = host.highlight?.() || "", layer = host.activeLayer?.() || "Top";
      const selection = JSON.stringify([ids,highlight,layer,preferNet]), u = G.AtriumUndoStore;
      const sameView = last?.project === p && last.doc === d && last.selection === selection;
      let needs = fresh || !sameView || unit !== host.units();
      if (!needs && revision === host.revision()) return last;
      if (!needs) for (const dep of dependencies(last)) {
        const old = versions.get(dep), v = u?.documentVersions?.(dep,p);
        if (!v || !old || old.seq < v.floor || old.outer !== v.outer || old.library !== v.library || old.project !== v.project) { needs = true; break; }
        if (old.items !== v.items) {
          const profile = !!last.board?.stackup?.impedanceProfiles?.length, own = new Set(ids);
          const circuitMode = !!(highlight || ids.length) && (!last.facts || ["divider","rclc"].includes(last.facts.id));
          const skip = u.onlyRecordedItemUpdates(dep,old.seq,(a,b) => {
            if (dep.kind === "schematic") return (!electrical.has(a.kind) && !electrical.has(b.kind)) || !relevant(a,b,schematicKeys);
            if (dep === d && (own.has(a.id) || own.has(b.id))) return !relevant(a,b,boardKeys);
            if ((profile || circuitMode) && (a.kind === "part" || b.kind === "part")) return !relevant(a,b,schematicKeys);
            return !!dep.stackup || !relevant(a,b,["layer","fromLayer","toLayer","def"]);
          });
          if (!skip) { needs = true; break; }
        }
      }
      if (needs) last = context(p,d,host.defs(),ids,highlight,layer,preferNet);
      versions = new Map(dependencies(last).map(dep => [dep,u?.documentVersions?.(dep,p)]));
      revision = host.revision(); unit = host.units();
      return last;
    }
    return {read};
  }
  function plan(view, id, result) {
    const f = view.facts, item = f?.item, board = view.board, doc = view.doc, inputs = result.inputs, values = result.values;
    const locks = G.AtriumCollabLock?.manager?.();
    if (!f?.fields[id] || view.needsRuleQuery || !result.ok || item?.locked || view.project.atriumCompat?.readOnly ||
        G.AtriumRevisions?.guard?.(view.project,true) || locks?.blocked(doc.id)) return null;
    const ops = [], field = (id,key,before,after) => ({op:"set",target:"item",document:doc.id,id,path:[key],before,after});
    let text, owner = doc;
    const len = n => G.Atrium.units.format(n,view.project.units);
    if (id === "divider" && inputs.solve === "resistors" && f.divider?.writable) {
      const d = f.divider;
      for (const [n,k] of ["top","bottom"].entries()) if (values[k] !== f.fields.divider[k]) ops.push(field(d[k],"value",d.values[n],G.AtriumGenericParts.formatValue(values[k],"Ω")));
      text = [d.upper+" "+G.AtriumCalc.format(values.top,"Ω"), d.lower+" "+G.AtriumCalc.format(values.bottom,"Ω")].join(", ");
    } else if (id === "via_current" && item && !Object.is(inputs.drill,item.drill)) {
      if (!positive(item.diameter) || inputs.drill >= item.diameter) return null;
      ops.push(field(item.id,"drill",item.drill,inputs.drill)); text = "Via drill " + len(item.drill) + " → " + len(inputs.drill);
    } else {
      let width;
      if (id === "impedance" && inputs.target > 0 && values.synthesized && !f.profile?.multipleStacks) {
        if (f.profile && Object.entries(f.profile.fields).some(([k,v]) => k !== "width" && (typeof v === "number" ? Math.abs(inputs[k]-v) > 1e-8 * Math.max(1,Math.abs(v)) : inputs[k] !== v))) return null;
        width = Math.round(values.width * 1e4) / 1e4;
        if (width < (f.profile?.minimum || 0)) return null;
      } else if (id === "track_width" || id === "current_capacity" && inputs.solve === "width") width = Math.round(values.width * 1e4) / 1e4;
      if (!positive(width)) return null;
      if (item && Math.abs(item.width-width) >= .00005) {
        ops.push(field(item.id,"width",item.width,width)); text = "Track width " + len(item.width) + " → " + len(width);
      } else if (!item && id === "impedance" && f.profile.fixed && Math.abs(width-f.profile.preferred) >= .00005) {
        if (G.AtriumStackup.newerStack(board.stackup)) return null;
        const before = board.stackup.impedanceProfiles, layer = f.profile.fields.layer;
        const profile = before.find(p => p.id === f.profile.id || p.name === f.profile.name);
        if (!profile?.layers[layer]) return null;
        const after = before.map(p => p !== profile ? p : {...p,layers:{...p.layers,[layer]:{...p.layers[layer],width}}});
        ops.push({op:"set",target:"document",id:board.id,path:["stackup","impedanceProfiles"],before:structuredCopy(before),after:structuredCopy(after)});
        owner = board; text = f.profile.name + " · " + layer + " width " + len(f.profile.preferred) + " → " + len(width);
      }
    }
    if (!ops.length || owner !== doc && locks?.blocked(owner.id)) return null;
    return {text, owner:owner.id, proposal:{format:"atrium-ai",version:2,project:view.project.name,document_ids:view.project.documents.map(d => d.id).sort(),ops}};
  }
  const structuredCopy = x => JSON.parse(JSON.stringify(x));
  return Object.freeze({context,createReader,plan});
})();
