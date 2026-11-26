"use strict";
// Project-level schematic connectivity across sheets and the sheet hierarchy.
//
// Sheet instances: every schematic sheet that no sheet symbol references is a root.
// A sheet symbol (AtriumSchObjects, kind "sheetsymbol") instantiates its child sheet once,
// or once per channel when it repeats (designator Repeat(CH,1,4)). Parts on a repeated
// sheet get channel designators R1_CH1, R1_CH2, ...
//
// Net identifier scope (Project Options, Altium's names):
//   global        net labels, ports and power ports all connect across sheets by name;
//                 sheet entries also connect to the child's ports
//   flat          ports, off-sheet connectors and power ports connect by name across
//                 all sheets; net labels stay on their sheet; sheet entries are ignored
//   hierarchical  a port connects only to the matching sheet entry on the parent's sheet
//                 symbol; off-sheet connectors join sibling sheets; net labels are local
//   automatic     hierarchical when any sheet symbol has entries, else flat when any
//                 port exists, else global (Altium's default rule)
// Power ports (and imported power objects) are always global.
//
// Bus names D[0..7] (and KiCad groups USB{DP DM}: USB.DP, USB.DM) on ports, off-sheet
// connectors and sheet entries expand to their members, which meet the sheet's net labels
// D0..D7. Two bus names on one drawn bus alias their members (vectors by index, groups by name).
// A sheet entry Repeat(SIG) on a repeated symbol connects channel k to the parent's net SIG<k>.
globalThis.AtriumHierarchy = (() => {
  const A = Atrium;
  const SO = () => globalThis.AtriumSchObjects;
  const SCOPES = ["automatic", "global", "flat", "hierarchical"];
  const isBus = t => SO()?.isBus(t) ?? /\[\d+\.\.\d+\]$/.test(String(t || ""));
  const members = t => SO()?.busMembers(t) ?? [t];
  const repeatOf = s => SO()?.repeatOf(s) ?? null;
  const repeatEntry = n => SO()?.repeatEntry(n) ?? null;
  const entryPoint = (s, e) => SO()?.entryPoint(s, e) ?? [s.x, s.y + e.offset];
  // An imported port or power object is a net label carrying its source appearance.
  function sourceType(i) {
    if (i.kind === "power") return "power";
    if (i.kind === "port") return "port";
    if (i.kind === "offsheet") return "offsheet";
    if (i.kind === "netlabel") return i.schPaint?.offSheet ? "offsheet" : i.schPaint?.type === "power" ? "power" : i.schPaint?.type === "port" ? "port" : "label";
    return null;
  }

  // ------------------------------------------------------------------ one sheet
  // The same physical rules as Atrium.connectivity: wires join at terminals, junctions and
  // where a segment passes through a connection point; identical names on a sheet join.
  function local(doc, defs) {
    const parent = new Map(), coords = new Map(), contacts = [], sources = [], wires = [], entries = [], buses = [];
    const node = p => {const k = A.pointKey(p); if (!parent.has(k)) {parent.set(k, k); coords.set(k, p);} return k;};
    const root = k => {let r = k; while (parent.get(r) !== r) r = parent.get(r); while (k !== r) {const n = parent.get(k); parent.set(k, r); k = n;} return r;};
    const join = (a, b) => {const x = root(a), y = root(b); if (x !== y) parent.set(y, x);};
    let order = 0;
    for (const i of doc.items) {
      if (i.kind === "part") for (const pin of A.pins(i, defs.get(i.def), "schematic")) contacts.push({i, pin, key:node(pin.at), order:order++});
      else if (i.kind === "wire" && i.points.length > 1) {
        const keys = i.points.map(node); for (const k of keys.slice(1)) join(keys[0], k);
        wires.push([i, keys[0]]); if (i.net) sources.push({key:keys[0], name:i.net, type:"label", item:i, order:order++});
      } else if (i.kind === "junction") node([i.x, i.y]);
      else if (i.kind === "sheetsymbol") {
        for (const e of i.entries || []) {
          const k = node(entryPoint(i, e));
          if (isBus(e.name) || repeatEntry(e.name)) buses.push({type:"entry", name:e.name, symbol:i, entry:e, key:k});
          else entries.push({key:k, symbol:i, entry:e});
        }
      } else {
        const type = sourceType(i);
        if (!type || !i.text) continue;
        const k = node([i.x, i.y]);
        if (isBus(i.text)) {buses.push({type, name:i.text, item:i, key:k}); continue;}
        sources.push({key:k, name:i.text, type, item:i, io:i.io, order:order++});
      }
    }
    const rows = new Map(), cols = new Map();
    const add = (m, k, v) => {if (!m.has(k)) m.set(k, []); m.get(k).push(v);};
    for (const [k, p] of coords) {add(rows, Math.round(p[1] * 10000), [k, p]); add(cols, Math.round(p[0] * 10000), [k, p]);}
    for (const [w, k] of wires) for (let n = 1; n < w.points.length; n++) {
      const a = w.points[n - 1], b = w.points[n];
      const candidates = a[1] === b[1] ? rows.get(Math.round(a[1] * 10000)) : a[0] === b[0] ? cols.get(Math.round(a[0] * 10000)) : coords;
      for (const [j, p] of candidates || []) if (A.nearSegment(p, a, b) < 0.00011) join(k, j);
    }
    const byName = new Map();
    for (const s of sources) {if (byName.has(s.name)) join(s.key, byName.get(s.name)); else byName.set(s.name, s.key);}
    const groups = new Map(), nets = [];
    const group = k => {
      const r = root(k);
      if (!groups.has(r)) {const g = {index:nets.length, pins:[], sources:[], entries:[], wires:[]}; groups.set(r, g); nets.push(g);}
      return groups.get(r);
    };
    for (const c of contacts) group(c.key).pins.push(c);
    for (const s of sources) group(s.key).sources.push(s);
    for (const e of entries) group(e.key).entries.push(e);
    for (const [w, k] of wires) group(k).wires.push(w);
    const netNamed = new Map();
    for (const g of nets) {
      g.names = [...new Set(g.sources.map(s => s.name))];
      for (const n of g.names) if (!netNamed.has(n)) netNamed.set(n, g.index);
    }
    // Differently named buses drawn as one bus alias their members (KiCad): DQ[0..31] on
    // DPC[0..7] joins DQ0..DQ7 with DPC0..DPC7; UART{TX RX} on UART_TRG{TX RX} joins .TX and .RX.
    const aliases = [];
    for (const net of SO()?.busNetworks?.(doc) || []) {
      const names = [...new Set(net.names.map(n => repeatEntry(n.name) ? "" : n.name).filter(Boolean))];
      for (let x = 0; x < names.length; x++) for (let y = x + 1; y < names.length; y++) aliases.push(...SO().busAlias(names[x], names[y]));
    }
    return {doc, nets, buses, aliases, netNamed, netOfKey:k => parent.has(k) ? groups.get(root(k))?.index : undefined};
  }

  // ------------------------------------------------------------------ instances
  function symbolsOf(doc) {return doc.items.filter(i => i.kind === "sheetsymbol");}
  function instances(project) {
    const sheets = project.documents.filter(d => d.kind === "schematic"), byId = new Map(sheets.map(d => [d.id, d]));
    const symbols = new Map(sheets.map(d => [d, symbolsOf(d)]));
    const referenced = new Set();
    for (const d of sheets) for (const s of symbols.get(d)) if (byId.has(s.sheet) && s.sheet !== d.id) referenced.add(s.sheet);
    const out = [], issues = [], reached = new Set();
    function visit(doc, parent, symbol, channel, stack) {
      const label = channel ? channel.label : symbol ? symbol.name : "";
      const inst = {id:(parent ? parent.id + "/" : "") + (symbol ? symbol.id + (channel ? "#" + channel.index : "") : doc.id), doc, parent, symbol, channel,
        depth:parent ? parent.depth + 1 : 0, label, suffix:(parent?.suffix || "") + (channel ? "_" + channel.label : ""), children:[], order:out.length};
      out.push(inst); reached.add(doc.id); parent?.children.push(inst);
      for (const s of symbols.get(doc)) {
        const child = byId.get(s.sheet);
        if (!s.sheet || !child) {issues.push({kind:"missingSheet", doc, item:s, text:"Sheet symbol " + (s.name || "(unnamed)") + " has no child sheet" + (s.file ? " (" + s.file + ")" : "")}); continue;}
        if (stack.has(child.id)) {issues.push({kind:"cycle", doc, item:s, text:"Sheet symbol " + s.name + " creates a hierarchy loop through " + child.name}); continue;}
        const rep = repeatOf(s);
        if (rep) {
          const count = Math.abs(rep.to - rep.from) + 1, limit = 256;
          if (!Number.isSafeInteger(rep.from) || !Number.isSafeInteger(rep.to) || count > limit) {
            issues.push({kind:"channelLimit", doc, item:s, text:"Cannot expand " + s.name + ". Use valid channel numbers and at most " + limit + " channels."});
            continue;
          }
          const step = rep.from <= rep.to ? 1 : -1;
          for (let k = 0; k < count; k++) {
            const n = rep.from + step * k;
            visit(child, inst, s, {index:k, number:n, label:rep.name + n}, new Set([...stack, child.id]));
          }
        } else visit(child, inst, s, null, new Set([...stack, child.id]));
      }
      return inst;
    }
    const roots = sheets.filter(d => !referenced.has(d.id)).map(d => visit(d, null, null, null, new Set([d.id])));
    // Sheets only reachable through a loop still compile, as roots.
    for (const d of sheets) if (!reached.has(d.id)) roots.push(visit(d, null, null, null, new Set([d.id])));
    globalThis.AtriumMultichannel?.decorate(project, out); // channel suffixes, scopes and designators
    return {instances:out, roots, issues};
  }
  // A navigation request needs the same occurrences as a compile, without solving the nets.
  // Only a committed editor journal can certify that the symbol paths still describe these sheets.
  const structures = new WeakMap();
  function instancesCached(project) {
    const host = globalThis.AtriumNavHost;
    const preview = host?.project?.() === project && host.drag?.()?.before;
    const stamp = preview ? null : globalThis.AtriumUndoStore?.hierarchyVersion?.(project);
    if (stamp == null) return instances(project);
    const docs = project.documents, old = structures.get(project), channels = globalThis.AtriumMultichannel;
    const naming = JSON.stringify(project.multichannel || null);
    if (old?.stamp === stamp && old.channels === channels && old.naming === naming &&
        docs.length === old.docs.length && docs.every((d, i) => old.docs[i][0] === d && old.docs[i][1] === d.id && old.docs[i][2] === d.kind)) return old.structure;
    const structure = instances(project);
    structures.set(project, {stamp, channels, naming, docs:docs.map(d => [d, d.id, d.kind]), structure});
    return structure;
  }
  function hasPorts(project) {
    return project.documents.some(d => d.kind === "schematic" && d.items.some(i => sourceType(i) === "port"));
  }
  function effectiveScope(project, scope) {
    scope = SCOPES.includes(scope) ? scope : "global";
    if (scope !== "automatic") return scope;
    const entries = project.documents.some(d => d.kind === "schematic" && d.items.some(i => i.kind === "sheetsymbol" && i.entries?.length));
    return entries ? "hierarchical" : hasPorts(project) ? "flat" : "global";
  }
  function allRuleObjects(scope) {
    if (!globalThis.AtriumDesignQueryRecord && typeof importScripts === "function") importScripts("../checks/design-query-record.js");
    // @ts-ignore Standalone CommonJS callers need just the scope record when a rule is present.
    if (!globalThis.AtriumDesignQueryRecord && typeof require === "function") require("../checks/design-query-record.js");
    return globalThis.AtriumDesignQueryRecord.isAll(scope);
  }
  function scopeRule(book) {
    // The same enabled, project-wide rule and priority order used by ProjectRules.erc.
    let best;
    for (const r of book?.list || []) if (r.type === "ercNetScope" && r.enabled !== false &&
        !r.sheets && allRuleObjects(r.scope) && (!best || (r.priority || 1) < (best.priority || 1))) best = r;
    return best;
  }
  // A pending Automatic decision only changes the active rule's existing value.
  function withScope(book, value) {
    const rule = scopeRule(book);
    return {...book, list:book.list.map(r => r === rule ? {...r, netScope:value} : r)};
  }
  function scopeSetting(project) {
    const raw = scopeRule(project?.rules)?.netScope;
    return SCOPES.includes(raw) ? raw : "global";
  }

  function sourceAutomatic(project) {
    const rule = scopeRule(project.rules);
    return rule?.origin?.kind === "import" && rule.origin.tool === "Altium" && project.documents.some(d => d.netScope === "automatic");
  }

  // The result's one callable member should retain only its published pin maps.
  // A closure in compile's scope also keeps scratch tables and the prior cache generation.
  function pinLookup(byDoc, byInstance) {
    return (docId, partId, pin, instanceId) => (instanceId ? byInstance.get(instanceId) : byDoc.get(docId))?.byPin.get(partId + "/" + pin) || "";
  }
  // A converted frame in a repeated channel can expose an unnamed wire whose
  // original name follows the physical pin (Net-U1_CH1-1, NetU1_CH1_1). Sheet port
  // text alone puts the suffix at the end. A generated label can keep the source
  // pin and spelling. Its literal text remains the fallback on a detached endpoint.
  function autoNameOf(net) {
    const hint = net.candidates.find(c => c.autoName && ["hyphen","underscore"].includes(c.autoName.style));
    if (!hint) return null;
    const explicit = net.candidates.find(c => !c.autoName && (c.type !== "port" || c.name !== hint.name));
    if (explicit) return {best:explicit};
    for (const c of net.candidates) {
      const h = c.autoName;
      if (!h || !["hyphen","underscore"].includes(h.style)) continue;
      const matches = net.pins.filter(p => p.part.id === h.part && String(p.pin.number) === h.pin);
      const pin = matches.find(p => p.instance === c.inst.id) || (matches.length === 1 ? matches[0] : null);
      if (pin) return {name:h.style === "hyphen" ? "Net-"+pin.ref+"-"+h.pin : "Net"+pin.ref+"_"+h.pin};
    }
    return null;
  }
  // ------------------------------------------------------------------ compile
  function compile(project, opts = {}) {
    const span = globalThis.AtriumDiagnostics?.performance?.begin("schematic", "build");
    return span ? span.run(compileInstances, project, opts) : compileInstances(project, opts);
  }
  function compileInstances(project, opts = {}) {
    const defs = opts.defs || new Map(project.library.map(d => [d.id, d]));
    const scope = opts.scope || scopeSetting(project), effective = effectiveScope(project, scope);
    const {instances:insts, roots, issues:structureIssues} = opts.structure || instances(project);
    const issues = [...structureIssues];
    const locals = new Map();
    // opts.local(doc, build): a caller's cache of a sheet's own connectivity (live ERC keeps it while the sheet is unchanged).
    const L = doc => {if (!locals.has(doc.id)) locals.set(doc.id, opts.local ? opts.local(doc, () => local(doc, defs)) : local(doc, defs)); return locals.get(doc.id);};
    const parent = new Map();
    const make = k => {if (!parent.has(k)) parent.set(k, k); return k;};
    const root = k => {let r = make(k); while (parent.get(r) !== r) r = parent.get(r); while (k !== r) {const n = parent.get(k); parent.set(k, r); k = n;} return r;};
    const J = (a, b) => {const x = root(a), y = root(b); if (x !== y) parent.set(y, x);};
    const key = (inst, index) => make(inst.id + "#" + index);
    const named = (inst, name) => {const g = L(inst.doc).netNamed.get(name); return g === undefined ? make("V:" + inst.id + ":" + name) : key(inst, g);};
    const global = effective === "global", flat = effective === "flat", hier = effective === "hierarchical";
    const portKeys = (inst, name) => [...(global || flat ? ["R:" + name] : []), ...(global || hier ? ["H:" + inst.id + ":" + name] : [])];
    const offKey = (inst, name) => hier ? "O:" + (inst.parent?.id || "") + ":" + name : "O:" + name;
    const childInstances = new Map();
    for (const inst of insts) if (inst.parent) {
      const k = inst.parent.id + "|" + inst.symbol.id;
      if (!childInstances.has(k)) childInstances.set(k, []);
      childInstances.get(k).push(inst);
    }
    const children = (inst, symbol) => childInstances.get(inst.id + "|" + symbol.id) || [];
    // A bus need not have a scalar pin or wire. Keep the actual member groups for
    // navigation too, including the virtual nets on an otherwise empty child.
    const busLinks = [];
    for (const inst of insts) {
      const loc = L(inst.doc);
      for (const g of loc.nets) {
        const k = key(inst, g.index);
        for (const s of g.sources) {
          if (s.type === "power") J(k, "P:" + s.name);
          else if (s.type === "label") {if (global) J(k, "L:" + s.name + (inst.channelScope ? "@" + inst.channelScope : ""));}
          else if (s.type === "port") for (const p of portKeys(inst, s.name)) J(k, p);
          else if (s.type === "offsheet") J(k, offKey(inst, s.name));
        }
        if (!flat) for (const e of g.entries) for (const c of children(inst, e.symbol)) J(k, "H:" + c.id + ":" + e.entry.name);
      }
      for (const b of loc.buses) {
        if (b.type === "entry") {
          const rep = repeatEntry(b.name);
          const keys = rep ? [] : members(b.name).map(m => named(inst, m));
          if (!flat) for (const c of children(inst, b.symbol)) {
            if (rep) {
              const k = named(inst, rep + (c.channel ? c.channel.number : ""));
              keys.push(k); J(k, "H:" + c.id + ":" + rep);
            } else members(b.name).forEach((m, i) => J(keys[i], "H:" + c.id + ":" + m));
          }
          busLinks.push({inst, item:b.symbol, entry:b.entry, keys});
        } else {
          const keys = members(b.name).map(m => {
            const k = named(inst, m);
            if (b.type === "port") for (const p of portKeys(inst, m)) J(k, p);
            else if (b.type === "offsheet") J(k, offKey(inst, m));
            return k;
          });
          busLinks.push({inst, item:b.item, keys});
        }
      }
      for (const [x, y] of loc.aliases) J(named(inst, x), named(inst, y));
    }
    // Gather global nets.
    const groups = new Map(), list = [];
    for (const inst of insts) for (const g of L(inst.doc).nets) {
      const r = root(key(inst, g.index));
      if (!groups.has(r)) {const n = {key:r, parts:[], pins:[], candidates:[], wires:0, conflict:false, local:[]}; groups.set(r, n); list.push(n);}
      const n = groups.get(r);
      n.local.push({inst, net:g});
      for (const c of g.pins) n.pins.push({doc:inst.doc, instance:inst.id, part:c.i, pin:c.pin, ref:inst.designator ? inst.designator(c.i) : c.i.ref + inst.suffix, order:[inst.order, c.order]});
      for (const s of g.sources) {
        const c = {name:s.name, rank:{power:0, label:1, port:2, offsheet:3}[s.type], depth:inst.depth, order:[inst.order,s.order], inst, type:s.type};
        if (s.type === "label" && s.item.kind === "netlabel" && s.item.autoName) {c.autoName = s.item.autoName; n.hasAutoName = true;}
        n.candidates.push(c);
      }
      n.wires += g.wires.length;
      if (g.names.length > 1) n.conflict = true;
      if (g.entries.length) n.hierarchical = true;
    }
    const cmp = (a, b) => a.rank - b.rank || a.depth - b.depth || a.order[0] - b.order[0] || a.order[1] - b.order[1];
    const used = new Map(), nets = [];
    for (const n of list) {
      // Same rule as a sheet's own nets: skip lone pins and empty groups.
      if (n.pins.length < 2 && !n.wires && !n.candidates.length && !n.hierarchical) continue;
      n.candidates.sort(cmp);
      const hint = n.hasAutoName ? autoNameOf(n) : null;
      const best = hint?.best || n.candidates[0];
      let name;
      if (hint?.name) name = hint.name;
      else if (best) {
        // A label or port inside a channel is local to that channel.
        name = best.name + (best.type !== "power" && best.inst.suffix && (!global || best.type === "label" && best.inst.channelScope) ? best.inst.suffix : "");
      } else {
        const first = n.pins.slice().sort((a, b) => a.order[0] - b.order[0] || a.order[1] - b.order[1])[0];
        name = first ? A.autoNetName(first.doc, n.pins.map(p => [p.ref, p.pin.number])) || "Net-" + first.ref + "-" + first.pin.number : "Net-" + (nets.length + 1);
      }
      n.sourceName = name;
      if (used.has(name)) {
        const inst = best?.inst || n.local[0].inst;
        let alt = name + "_" + (inst.label || inst.doc.name).replace(/\s+/g, "_"), k = 2;
        while (used.has(alt)) alt = name + "_" + k++;
        n.duplicate = name; name = alt;
      }
      used.set(name, n); n.name = name;
      n.names = [...new Set(n.candidates.map(c => c.name))];
      n.global = n.candidates.some(c => c.type !== "label") || !!n.hierarchical;
      nets.push(n);
    }
    // Per-document maps for the first instance of each sheet (what the editor shows).
    const byDoc = new Map(), byInstance = new Map();
    for (const inst of insts) {
      const byPin = new Map(), byWire = new Map();
      for (const g of L(inst.doc).nets) {
        const n = groups.get(root(key(inst, g.index)));
        if (!n?.name) continue;
        for (const c of g.pins) byPin.set(c.i.id + "/" + c.pin.number, n.name);
        for (const w of g.wires) byWire.set(w.id, n.name);
      }
      const m = {instance:inst, byPin, byWire};
      byInstance.set(inst.id, m);
      if (!byDoc.has(inst.doc.id)) byDoc.set(inst.doc.id, m);
    }
    // Entries and ports that do not meet.
    if (hier) for (const inst of insts) for (const s of symbolsOf(inst.doc)) for (const c of children(inst, s)) {
      if (c.channel && c.channel.index) continue;
      const ports = new Set(), childLoc = L(c.doc);
      for (const g of childLoc.nets) for (const src of g.sources) if (src.type === "port") ports.add(src.name);
      for (const b of childLoc.buses) if (b.type === "port") {ports.add(b.name); members(b.name).forEach(m => ports.add(m));}
      const entries = new Set((s.entries || []).map(e => repeatEntry(e.name) || e.name));
      for (const e of s.entries || []) {
        const n = repeatEntry(e.name) || e.name;
        if (!ports.has(n) && !members(n).every(m => ports.has(m))) issues.push({kind:"unmatchedEntry", doc:inst.doc, item:s, entry:e, text:"Sheet entry " + e.name + " on " + s.name + " has no port on " + c.doc.name});
      }
      for (const p of ports) if (!entries.has(p) && !isBusMember(p, entries)) issues.push({kind:"unmatchedPort", doc:c.doc, port:p, text:"Port " + p + " on " + c.doc.name + " has no sheet entry on " + s.name});
    }
    for (const link of busLinks) link.keys = [...new Set(link.keys.map(root))];
    return {scope, effective, instances:insts, roots, nets, busLinks, byDoc, byInstance, issues, netOf:pinLookup(byDoc, byInstance)};
  }
  // Share the per-sheet topology across the two project compilers. A project result also
  // depends on sheet order, net scope and multichannel naming, even for a repeated child.
  const published = new WeakMap();
  function publish(project, result) {
    const host = globalThis.AtriumNavHost;
    if (host?.project?.() === project && !host.drag?.()?.before && result.scope === scopeSetting(project)) {
      const rev = host.revision?.(), last = published.get(project);
      if (last?.result !== result || last.rev !== rev) {
        published.set(project, {result, rev});
        globalThis.AtriumConnectionPreview?.compiled?.(project, result);
      }
    }
    return result;
  }
  function peek(project, revision) {
    const last = published.get(project);
    return last?.rev === revision ? last?.result : null;
  }
  const invalidatePublished = project => published.delete(project);
  function compileCached(project, opts = {}) {
    const defs = opts.defs || new Map(project.library.map(d => [d.id, d]));
    const scope = opts.scope || scopeSetting(project);
    const docs = project.documents.filter(d => d.kind === "schematic");
    const entries = new Map(docs.map(d => [d, A.sheetEntry(project, d, defs)]));
    const certified = docs.length && docs.every(d => entries.get(d));
    const channels = globalThis.AtriumMultichannel, tree = globalThis.AtriumUndoStore?.hierarchyVersion?.(project);
    const owner = entries.get(docs[0])?.projectCache, last = owner?.compiled;
    const naming = JSON.stringify(project.multichannel ?? null);
    if (certified && last?.scope === scope && last.channels === channels && last.tree === tree && last.naming === naming &&
        last.entries.length === docs.length && docs.every((d, k) => entries.get(d) === last.entries[k]))
      return opts.publish === false ? last.result : publish(project, last.result);
    const local = (doc, build) => {
      const e = entries.get(doc);
      return e ? (e.local ??= build()) : build();
    };
    const result = compile(project, {defs, scope, local, structure:instancesCached(project)});
    if (certified) {
      owner.compiled = {scope, channels, tree, naming, entries:[...entries.values()], result};
      return opts.publish === false ? result : publish(project, result);
    }
    // An explicit editor idle task can precede initial undo recording. Other
    // uncertified callers include transient gestures and in-transaction reads.
    return opts.publish !== false && opts.editorRevision != null && opts.editorRevision === globalThis.AtriumNavHost?.revision?.() ?
      publish(project,result) : result;
  }
  function isBusMember(name, entries) {
    for (const e of entries) if (isBus(e) && members(e).includes(name)) return true;
    return false;
  }

  // ------------------------------------------------------------------ navigation helpers
  function parentOf(project, docId) {
    for (const d of project.documents) if (d.kind === "schematic") for (const s of symbolsOf(d)) if (s.sheet === docId && d.id !== docId) return {doc:d, symbol:s};
    return null;
  }
  // Sheet nets for one document, falling back to the sheet's own connectivity.
  function sheetNets(project, doc, defs) {
    try {const m = compileCached(project, {defs}).byDoc.get(doc.id); if (m) return m;} catch {}
    return A.sheetNets(project, doc, defs);
  }
  // Depth-first document order for the Projects panel: [{doc, depth, channels}]
  function tree(project) {
    const {instances:insts} = instancesCached(project), seen = new Map(), out = [];
    for (const inst of insts) {
      if (seen.has(inst.doc.id)) {const row = seen.get(inst.doc.id); if (inst.channel) row.channels++; continue;}
      const row = {doc:inst.doc, depth:inst.depth, channels:inst.channel ? 1 : 0, symbol:inst.symbol};
      seen.set(inst.doc.id, row); out.push(row);
    }
    return out;
  }
  return {SCOPES, local, instances, instancesCached, effectiveScope, scopeRule, withScope, scopeSetting, sourceAutomatic, compile, compileCached, peek, invalidatePublished, parentOf, sheetNets, tree, sourceType};
})();
