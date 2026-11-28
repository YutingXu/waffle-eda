"use strict";
// Navigator panel (Panels › Navigator): the compiled design as one tree, as in Altium's
// Navigator. Groups: Sheets, Components, Nets / Buses (each net expands to its pins on every
// sheet) and Ports. Clicking a row probes it on its sheet or board with the chosen
// interactive-navigation options (Zoom, Select, Mask) and, in a split view, shows the
// counterpart in the other pane; nets are also highlighted.
//
// Built for large designs: rows are cached per document and rebuilt for affected documents
// (after the edit frame, and only while the panel is open); the list is virtualised (fixed
// row height, a small pool of row nodes); search filters cached lower-case keys.
//
// Headless API (pure):
//   AtriumNavigatorPanel.model(project, defs, cache?, journal?) -> {sheets, parts, nets, buses, ports}
//   AtriumNavigatorPanel.flatten(model, {query, expanded, collapsed}) -> visible rows
globalThis.AtriumNavigatorPanel = (() => {
  const ROW = 22, OVERSCAN = 8;
  const natural = new Intl.Collator(undefined, {numeric:true, sensitivity:"base"});
  const lower = s => String(s ?? "").toLowerCase();

  // ------------------------------------------------------------------ model
  // Per-document rows (parts, ports, board nets), cached by item list and committed document version.
  function docRows(doc, defs) {
    const parts = [], ports = [], frames = [], boardNets = new Map(), buses = new Set();
    const isBus = t => globalThis.AtriumSchObjects?.isBus?.(t) ?? /\[\d+\.\.\d+\]$/.test(String(t || ""));
    for (const i of doc.items) {
      if (i.kind === "part" && i.ref) {
        parts.push({type:"part", id:i.id, docId:doc.id, label:i.ref, detail:(i.value || defs.get(i.def)?.name || "") , link:i.link || null});
        if (doc.kind === "pcb") {
          let pins = null;
          for (const [pin, net] of Object.entries(i.pinNets || {})) if (net) {
            if (!boardNets.has(net)) boardNets.set(net, []);
            boardNets.get(net).push({type:"pin", docId:doc.id, partId:i.id, pin, label:i.ref + "-" + pin});
            pins = true;
          }
          if (!pins) for (const p of defs.get(i.def)?.footprint?.pads || []) if (p.net) {
            if (!boardNets.has(p.net)) boardNets.set(p.net, []);
            boardNets.get(p.net).push({type:"pin", docId:doc.id, partId:i.id, pin:String(p.number), label:i.ref + "-" + p.number});
          }
        }
      } else if (globalThis.AtriumSchObjects?.isFrame(i)) frames.push({type:"frame", id:i.id, docId:doc.id, label:i.text, detail:doc.name});
      else if (doc.kind === "pcb" && i.net && !boardNets.has(i.net)) boardNets.set(i.net, []);
      else if (i.kind === "port" || i.kind === "offsheet") {
        const name = i.text || i.name || "";
        if (name) ports.push({type:"port", id:i.id, docId:doc.id, label:name, detail:(i.kind === "offsheet" ? "Off-sheet · " : "Port · ") + doc.name});
        if (isBus(name)) buses.add(name);
      } else if (i.kind === "netlabel" && isBus(i.text)) buses.add(i.text);
    }
    return {parts, ports, frames, boardNets, buses};
  }
  function partTextOnly(before, current) {
    if (before.kind !== "part" || current.kind !== "part") return false;
    const otherFields = ({value, comment, ...fields}) => JSON.stringify(fields);
    return otherFields(before) === otherFields(current);
  }
  function model(project, defs, cache = new Map(), journal, schematicsReady = true) {
    const docs = project.documents.filter(d => d.kind === "schematic" || d.kind === "pcb");
    const schematic = docs.filter(d => d.kind === "schematic"), hierarchy = globalThis.AtriumHierarchy;
    const stamp = journal?.hierarchyVersion?.(project), memo = cache.get("#nets");
    const netInputs = [project, defs, hierarchy, globalThis.AtriumSchObjects, globalThis.AtriumMultichannel, journal, stamp];
    let reuseNets = schematicsReady && !!memo && (!journal || stamp != null) && memo.inputs.every((input, i) => input === netInputs[i]) &&
      memo.documents.length === schematic.length && memo.documents.every((doc, i) => doc === schematic[i]);
    const per = new Map();
    for (const d of docs) {
      let c = cache.get(d.id);
      const version = journal?.documentVersions?.(d, project), prior = c?.version;
      // Bulk edits can touch sheets outside either pane. Rebuild if the journal
      // cannot confirm the cached rows cover the current document and library.
      const structure = !c || c.doc !== d || c.defs !== defs || c.items !== d.items || c.length !== d.items.length;
      const metadata = journal && (!version || !prior || prior.seq < version.floor ||
        prior.outer !== version.outer || prior.library !== version.library || prior.project !== version.project);
      if (structure || metadata || prior?.items !== version?.items) {
        // A component's comment can change its row without changing any compiled pin or net.
        if (reuseNets && d.kind === "schematic" && (structure || metadata || !journal?.onlyRecordedItemUpdates?.(d, prior.seq, partTextOnly))) reuseNets = false;
        c = {doc:d, defs, items:d.items, length:d.items.length, version, rows:docRows(d, defs)};
        cache.set(d.id, c);
      } else c.version = version;
      per.set(d.id, c.rows);
    }
    for (const k of [...cache.keys()]) if (!per.has(k) && k !== "#nets") cache.delete(k);
    // Sheets in hierarchy order, then boards.
    const sheets = [];
    let order = [];
    try {order = hierarchy?.tree(project).map(r => ({doc:r.doc, depth:r.depth, channels:r.channels})) || [];} catch {order = [];}
    const seen = new Set(order.map(r => r.doc.id));
    for (const d of docs) if (!seen.has(d.id)) order.push({doc:d, depth:0, channels:0});
    for (const r of order) if (r.doc.kind !== "panel") sheets.push({type:"sheet", docId:r.doc.id, label:r.doc.name, indent:r.depth,
      detail:r.doc.kind === "pcb" ? "Board" : "Sheet" + (r.channels > 1 ? " ×" + r.channels : "")});
    const sheetName = new Map(docs.map(d => [d.id, d.name]));
    const parts = [];
    const schParts = schematic.flatMap(d => per.get(d.id).parts);
    for (const p of schParts.length ? schParts : docs.filter(d => d.kind === "pcb").flatMap(d => per.get(d.id).parts)) parts.push({...p, detail:(p.detail ? p.detail + " · " : "") + sheetName.get(p.docId)});
    parts.sort((a, b) => natural.compare(a.label, b.label));
    // Nets: compiled across sheets when there are schematics, else the board's nets.
    let nets = [];
    if (reuseNets) nets = memo.nets;
    else if (schematic.length && schematicsReady) {
      try {
        const compiled = journal === globalThis.AtriumUndoStore && journal
          ? hierarchy.compileCached(project, {defs, publish:false}) : hierarchy.compile(project, {defs});
        nets = compiled.nets.map(n => {
          const pins = n.pins.map(p => ({type:"pin", docId:p.doc.id, partId:p.part.id, instanceId:p.instance, pin:String(p.pin.number),
            label:p.ref + "-" + p.pin.number, detail:(p.pin.name && p.pin.name !== String(p.pin.number) ? p.pin.name + " · " : "") + p.doc.name}));
          const row = {type:"net", name:n.name, label:n.name, pins:pins.sort((a,b) => natural.compare(a.label,b.label))};
          Object.defineProperty(row, "compiled", {value:n});
          return row;
        });
        cache.set("#nets", {inputs:netInputs, documents:schematic, nets});
      } catch {cache.delete("#nets");}
    } else cache.delete("#nets");
    if (!nets.length && schematicsReady) {
      const all = new Map();
      for (const d of docs.filter(x => x.kind === "pcb")) for (const [n, pins] of per.get(d.id).boardNets) {if (!all.has(n)) all.set(n, []); all.get(n).push(...pins.map(p => ({...p, detail:sheetName.get(d.id)})));}
      nets = [...all].map(([name, pins]) => ({type:"net", name, label:name, pins:pins.sort((a, b) => natural.compare(a.label, b.label))}));
    }
    if (!reuseNets || nets !== memo.nets) {
      for (const n of nets) n.detail = n.pins.length + (n.pins.length === 1 ? " pin" : " pins");
      nets.sort((a, b) => natural.compare(a.label, b.label));
    }
    const buses = [...new Set(schematic.flatMap(d => [...per.get(d.id).buses]))].sort(natural.compare).map(b => ({type:"bus", name:b, label:b, detail:"Bus"}));
    const ports = schematic.flatMap(d => per.get(d.id).ports).sort((a, b) => natural.compare(a.label, b.label));
    const frames = schematic.flatMap(d => per.get(d.id).frames).sort((a,b) => natural.compare(a.label,b.label));
    return {sheets, parts, nets, buses, ports, frames};
  }
  const GROUPS = [["sheets", "Sheets"], ["parts", "Components"], ["nets", "Nets / Buses"], ["ports", "Ports"], ["frames", "Frames"]];
  const keyOf = r => r._k ??= lower(r.label + " " + (r.detail || ""));
  // Visible rows: group headers, entries and (for expanded nets) their pins.
  function flatten(m, {query = "", expanded = new Set(), collapsed = new Set()} = {}) {
    const q = lower(query).trim(), words = q ? q.split(/\s+/) : [];
    const hit = r => {if (!words.length) return true; const k = keyOf(r); for (const w of words) if (!k.includes(w)) return false; return true;};
    const out = [];
    for (const [g, title] of GROUPS) {
      const list = g === "nets" ? [...m.nets, ...m.buses] : m[g];
      if(g==="frames" && !list?.length)continue;
      const head = {type:"group", group:g, label:title, depth:0, count:0, id:"g:" + g};
      out.push(head);
      const open = !collapsed.has(g), start = out.length;
      let count = 0;
      for (const r of list) {
        const own = hit(r), pins = !own && r.type === "net" ? r.pins.filter(hit) : null;
        if (!own && !pins?.length) continue;
        count++;
        if (!open) continue;
        const id = r.type === "net" ? "n:" + r.name : r.type === "bus" ? "b:" + r.name : r.type === "sheet" ? "s:" + r.docId : r.docId + ":" + r.id;
        const isOpen = r.type === "net" && (expanded.has(id) || !!pins?.length && !own);
        out.push({...r, depth:1, id, open:isOpen, expandable:r.type === "net" && r.pins.length > 0, entry:r});
        if (isOpen) for (const p of (own ? r.pins : pins)) out.push({...p, depth:2, id:id + "/" + (p.instanceId || p.docId) + ":" + p.partId + "/" + p.pin, net:r.name, entry:p});
      }
      head.count = count; head.open = open;
      if (words.length && !count) out.splice(start - 1, 1);
    }
    return out;
  }

  // ------------------------------------------------------------------ UI
  let host = null, panel = null, ui = null, rows = [], current = null, dirty = true, frame = 0, active = -1;
  let projectLoad, modelOwner, unfilteredRows, cancelRefresh, pendingProbe;
  let filteredQuery = "";
  const cache = new Map(), expanded = new Set(), collapsed = new Set();
  const MODES_KEY = "atrium.navigator.modes.v1";
  let modes = {zoom:true, select:true, mask:false};
  try {modes = {...modes, ...JSON.parse(globalThis.localStorage?.getItem(MODES_KEY) || "{}")};} catch {}
  const el = (tag, text, cls) => AtriumNavCommon.el(tag, text, cls);
  const pool = [];

  function compute() {
    const project = host.project(), defs = host.defs();
    const load = globalThis.AtriumNetsPanel?.ensureSchematicProject(host);
    if (load && projectLoad !== load) {
      projectLoad = load;
      const settled = error => {
        if (projectLoad !== load) return;
        projectLoad = null;
        if (host.project() !== project || panel.hidden) return;
        if (error) host.info(error.message);
        else changed();
      };
      load.then(() => settled(), settled);
    }
    // A cancelled drag can restore the live geometry without an undo record.
    const live = host.drag?.()?.before;
    current = model(project, defs, live ? undefined : cache, live ? undefined : globalThis.AtriumUndoStore || {}, !load);
    modelOwner = {project, documents:project.documents.slice(), stamp:globalThis.AtriumUndoStore?.hierarchyVersion?.(project)};
    unfilteredRows = null;
    dirty = false;
  }
  function refresh(keepActive = true) {
    if (!panel || panel.hidden || !current) return;
    const prev = keepActive ? rows[active]?.id : null;
    filteredQuery = ui.search.value;
    rows = filteredQuery.trim() ? flatten(current, {query:filteredQuery, expanded, collapsed})
      : (unfilteredRows ??= flatten(current, {expanded, collapsed}));
    active = prev ? rows.findIndex(r => r.id === prev) : -1;
    if (active < 0 && rows.length) active = Math.min(rows.length - 1, Math.max(0, keepActive ? 0 : -1));
    const total = current.parts.length + current.nets.length + current.ports.length + current.frames.length;
    const counted = ui.search.value.trim() ? rows.filter(r => r.depth === 1).length + " of " + total : String(total);
    if (ui.find.setCount) ui.find.setCount(counted); else ui.count.textContent = counted;
    ui.inner.style.height = rows.length * ROW + "px";
    ui.empty.hidden = rows.length > 0;
    paint();
  }
  function paint() {
    if (!panel || panel.hidden) return;
    const top = ui.scroller.scrollTop, h = ui.scroller.clientHeight || 400;
    const first = Math.max(0, Math.floor(top / ROW) - OVERSCAN), last = Math.min(rows.length, Math.ceil((top + h) / ROW) + OVERSCAN);
    const need = Math.max(0, last - first);
    while (pool.length < need) {
      const n = el("div", null, "navp-row"); n.setAttribute("role", "treeitem"); n.tabIndex = -1;
      const tw = el("span", null, "navp-twisty"), ic = el("span", null, "navp-icon"), lb = el("span", null, "navp-label"), dt = el("span", null, "navp-detail");
      tw.setAttribute("aria-hidden", "true"); ic.setAttribute("aria-hidden", "true");
      n.append(tw, ic, lb, dt); pool.push(n);
    }
    // Keep recycled rows for the next search, outside the live tree until needed.
    while (ui.inner.childElementCount > need) ui.inner.lastElementChild.remove();
    while (ui.inner.childElementCount < need) ui.inner.append(pool[ui.inner.childElementCount]);
    const lit = host.highlight?.() || "";
    for (let k = 0; k < need; k++) {
      const n = pool[k], idx = first + k, r = rows[idx];
      if (n.navigatorRow !== r || +n.dataset.index !== idx) {
        n.navigatorRow = r;
        n.style.top = idx * ROW + "px"; n.dataset.index = String(idx);
        n.dataset.type = r.type; n.dataset.depth = String(r.depth);
        n.setAttribute("aria-level", String(r.depth + 1));
        if (r.type === "group" || r.expandable) n.setAttribute("aria-expanded", String(!!r.open)); else n.removeAttribute("aria-expanded");
        const [tw, , lb, dt] = n.children;
        tw.dataset.state = r.type === "group" || r.expandable ? (r.open ? "open" : "closed") : "";
        lb.textContent = r.label;
        dt.textContent = r.type === "group" ? String(r.count) : r.detail || "";
        n.style.paddingLeft = (4 + r.depth * 12 + (r.indent || 0) * 10) + "px";
      }
      const id = idx === active ? "navp-active" : "", selected = String(idx === active);
      if (n.id !== id) n.id = id;
      if (n.getAttribute("aria-selected") !== selected) n.setAttribute("aria-selected", selected);
      n.classList.toggle("is-lit", (r.type === "net" && r.name === lit) || (r.type === "pin" && r.net === lit && !!lit));
    }
    if (active >= 0) ui.scroller.setAttribute("aria-activedescendant", "navp-active"); else ui.scroller.removeAttribute("aria-activedescendant");
  }
  function schedulePaint() {
    if (!frame) frame = (globalThis.requestAnimationFrame || (f => setTimeout(f, 16)))(() => {frame = 0; paint();});
  }
  function choose(i, scroll = true) {
    active = Math.max(-1, Math.min(rows.length - 1, i));
    if (scroll && active >= 0) {
      const y = active * ROW, s = ui.scroller, h = s.clientHeight;
      if (y < s.scrollTop) s.scrollTop = y; else if (y + ROW > s.scrollTop + h) s.scrollTop = y + ROW - h;
    }
    paint();
  }
  function toggleRow(r, open) {
    if (r.type === "group") {if (open ?? collapsed.has(r.group)) collapsed.delete(r.group); else collapsed.add(r.group);}
    else if (r.expandable) {if (open ?? !expanded.has(r.id)) expanded.add(r.id); else expanded.delete(r.id);}
    else return false;
    unfilteredRows = null;
    refresh(); return true;
  }
  // ------------------------------------------------------------------ probing
  function boxFor(doc, part, pin) {
    const sub = globalThis.AtriumCrossProbe.terminal(doc,host.defs(),part,{pin,includeNet:false});
    if (!sub) return null;
    const [x,y]=sub.at, r=Math.max(sub.w || 0,sub.h || 0,doc.kind === "pcb" ? .3 : 1)/2;
    return {sub,box:[x-r,y-r,x+r,y+r]};
  }
  function memberOn(docs, docId) {
    const instances = docs.get(docId), active = globalThis.AtriumNavCommon.paletteInstance(host, docId);
    return instances?.get(active) || instances?.values().next().value;
  }
  function memberPins(member) {
    return member?.pins.flatMap(p => boxFor(member.doc, p.part, String(p.pin.number))?.sub || []) || [];
  }
  function activateInstance(doc, instanceId, net) {
    if (!instanceId || instanceId === doc.id) return;
    const activate = preview => {
      if (host.doc() !== doc || host.highlight() !== net) return;
      preview.activateInstance(doc.id, instanceId);
    };
    const preview = globalThis.AtriumConnectionPreview;
    if (preview) activate(preview);
    else globalThis.AtriumLazy?.need("AtriumConnectionPreview").then(activate, error => host.info(error.message));
  }
  function onDocument(doc, fn) {
    const project = host.project(), pending = doc !== host.doc() && host.selectDocument(doc.id);
    if (pending?.then) pending.then(() => {if (host.project() === project && host.doc() === doc) fn();});
    else fn();
  }
  function counterpart(docId, target, members) {
    const CP = globalThis.AtriumCrossProbe, panes = host.panes?.() || [];
    if (!CP || panes.length < 2) return;
    let res = null;
    if (members && host.docById(docId)?.kind === "pcb") {
      const other = panes.find(p => !p.active);
      const member = memberOn(members, other?.docId) || memberOn(members, members.keys().next().value);
      if (member) {
        const shapes = globalThis.AtriumQuery.shapesOf(member.doc, host.defs(), [...member.ids], memberPins(member));
        res = {docId:member.doc.id, box:shapes.box};
      }
    } else try {res = CP.resolve(host.project(), host.defs(), docId, target);} catch {res = null;}
    if (!res || res.docId === docId) return;
    if (host.showInOther(res.docId)) {
      const other = host.panes().find(p => !p.active);
      if (other?.view && res.box) other.view.restoreCamera(globalThis.AtriumNavCommon.cameraFor(res.box, other.canvas.clientWidth || 800, other.canvas.clientHeight || 600, other.view.camera()));
      host.invalidate();
    }
  }
  function probeCompiledNet(row, modes) {
    const CP = globalThis.AtriumCrossProbe, Q = globalThis.AtriumQuery, defs = host.defs();
    const members = CP.compiledNetMembers(row.compiled), active = host.doc();
    for (const doc of [active, ...host.project().documents.filter(d => d !== active)]) {
      const member = doc.kind === "schematic" ? memberOn(members, doc.id) : null;
      const ids = member ? [...member.ids] : doc.kind === "pcb" ? CP?.netObjects(doc, defs, row.name)?.ids || [] : [];
      const subs = memberPins(member);
      if (!ids.length && !subs.length) continue;
      onDocument(doc, () => {
        Q?.applyIds(doc.id, ids, subs, {...modes, highlight:!modes.mask});
        host.setHighlight(row.name, members);
        activateInstance(doc, member?.instance, row.name);
        counterpart(doc.id, {kind:"net", net:row.name, docId:doc.id}, members);
        host.info("Navigator: net " + row.name + " · " + row.pins.length + " pins");
      });
      return;
    }
    host.setHighlight(row.name, members);
    host.info("Net " + row.name + " has no objects to show.");
  }
  function probe(r) {
    const Q = globalThis.AtriumQuery, m = {select:modes.select, zoom:modes.zoom, mask:modes.mask, highlight:false};
    if (!r || r.type === "group") return;
    if (dirty && (r.type === "net" || r.type === "pin")) {
      const id = r.id;
      compute();
      refresh();
      r = rows.find(row => row.id === id);
      if (!r) return;
    }
    pendingProbe = null;
    if (r.type === "sheet") {
      host.selectDocument(r.docId);
      if(m.zoom && globalThis.AtriumSchAppearance?.isInfinite(host.doc()))host.act("fit-document");
      host.info("Navigator: " + r.label); return;
    }
    if(r.type==="frame"){
      const doc=host.docById(r.docId), item=doc?.items.find(i=>i.id===r.entry.id);
      if(!item)return;
      host.selectDocument(r.docId);
      Q?.applyIds(r.docId,[item.id],[],{...m,zoom:false});
      host.zoomTo(AtriumSchObjects.frameBounds(item),{maxFactor:Infinity});
      host.info("Navigator: " + item.text + " on " + doc.name);return;
    }
    if (r.type === "part" || r.type === "port") {
      const doc = host.docById(r.docId); if (!doc) return;
      const id = r.entry.id;
      Q?.applyIds(r.docId, [id], [], m);
      if (r.type === "part") {const p = doc.items.find(i => i.id === id); if (p) counterpart(r.docId, {kind:"part", ref:p.ref, link:p.link, docId:r.docId});}
      host.info("Navigator: " + r.label + " on " + doc.name);
      return;
    }
    if (r.type === "pin") {
      const doc = host.docById(r.docId), part = doc?.items.find(i => i.id === r.partId); if (!part) return;
      const b = boxFor(doc, part, r.pin);
      onDocument(doc, () => {
        Q?.applyIds(r.docId, [part.id], b ? [b.sub] : [], {...m, zoom:m.zoom && !b, highlight:!m.mask});
        const compiled = current?.nets.find(n => n.name === r.net)?.compiled;
        if (r.net) host.setHighlight(r.net, compiled ? AtriumCrossProbe.compiledNetMembers(compiled) : null);
        activateInstance(doc, r.instanceId, r.net);
        if (b && m.zoom) host.zoomTo(b.box);
        counterpart(r.docId, {kind:"pin", ref:part.ref, link:part.link, pin:r.pin, docId:r.docId});
        host.info("Navigator: pin " + r.label + (r.net ? " · net " + r.net : ""));
      });
      return;
    }
    if (r.type === "net" && r.entry?.compiled) return probeCompiledNet(r.entry, m);
    if (r.type === "net" || r.type === "bus") {
      const name = r.name, CP = globalThis.AtriumCrossProbe, defs = host.defs();
      const docs = [host.doc(), ...host.project().documents.filter(d => d !== host.doc() && (d.kind === "pcb" || d.kind === "schematic"))];
      const members = r.type === "bus" ? (globalThis.AtriumSchObjects?.busMembers?.(name) || [name]) : [name];
      host.setHighlight(r.type === "net" ? name : "");
      for (const d of docs) {
        const ids = [], subs = [], found = CP?.netObjectsBatch(d,defs,members);
        let byId = null; // parts by id, built once per document (a net can have hundreds of pins)
        for (const net of members) {
          for (const id of found?.get(net)?.ids || []) ids.push(id);
          for (const p of r.pins || []) if (p.docId === d.id) {
            if (!byId) {byId = new Map(); for (const i of d.items) if (!byId.has(i.id)) byId.set(i.id, i);}
            const part = byId.get(p.partId), b = part && boxFor(d, part, p.pin); if (b) subs.push(b.sub);
          }
        }
        if (!ids.length && !subs.length) continue;
        Q?.applyIds(d.id, m.select ? ids : [], subs, {...m, highlight:!m.mask});
        if (r.type === "net") counterpart(d.id, {kind:"net", net:name, docId:d.id});
        host.info("Navigator: " + (r.type === "bus" ? "bus " : "net ") + name + " · " + (r.pins?.length || 0) + " pins");
        return;
      }
      host.info("Net " + name + " has no objects to show.");
    }
  }
  // ------------------------------------------------------------------ build
  function modeButton(k, label, tip) {
    const b = el("button", label, "navp-mode ui-button"); b.type = "button"; b.dataset.size = "sm"; b.title = tip; b.setAttribute("aria-pressed", String(!!modes[k]));
    b.onclick = () => {modes[k] = !modes[k]; b.setAttribute("aria-pressed", String(modes[k])); try {globalThis.localStorage?.setItem(MODES_KEY, JSON.stringify(modes));} catch {} if (!modes.mask) globalThis.AtriumQuery?.clear(true);};
    return b;
  }
  function build() {
    const nav = document.getElementById("navigator");
    if (!nav) return false;
    panel = el("section", null, "panel panel-navp"); panel.setAttribute("aria-labelledby", "navp-heading"); panel.hidden = true;
    const head = el("header", null, "pane-heading"), h2 = el("h2", "Navigator"); h2.id = "navp-heading";
    const close = el("button", "×", "ui-close navp-close"); close.type = "button"; close.title = "Close Navigator"; close.setAttribute("aria-label", "Close Navigator"); close.onclick = () => toggle(false);
    head.append(h2, close);
    const tools = el("div", null, "navp-tools");
    const search = el("input", null, "ui-field"); search.type = "search"; search.placeholder = "Search components, nets, pins, ports, frames"; search.setAttribute("aria-label", "Search the Navigator");
    const filter = () => {pendingProbe = null; ui.scroller.scrollTop = 0; refresh(false);};
    const firstResult = () => {const i = rows.findIndex(x => x.depth > 0); if (i >= 0) {choose(i); probe(rows[i]);}};
    search.oninput = filter;
    search.onkeydown = e => {
      if ((e.key === "Enter" || e.key === "ArrowDown") && search.value !== filteredQuery) filter();
      if (e.key === "ArrowDown") {e.preventDefault(); ui.scroller.focus(); choose(Math.max(0, active));}
      else if (e.key === "Enter") {
        e.preventDefault();
        if (dirty) {pendingProbe = firstResult; scheduleRefresh();}
        else firstResult();
      }
      else if (e.key === "Escape" && search.value) {e.preventDefault(); search.value = ""; filter();}
      e.stopPropagation();
    };
    const modesRow = el("div", null, "navp-modes"); modesRow.setAttribute("role", "group"); modesRow.setAttribute("aria-label", "On click");
    modesRow.append(el("span", "On click", "navp-modes-label"), modeButton("zoom", "Zoom", "Zoom to the object"), modeButton("select", "Select", "Select the object"), modeButton("mask", "Mask", "Dim everything else"));
    // The library search field: static .ui-search markup that AtriumUIKit adopts (clear button, count, Escape).
    // The match count lives in the field (.ui-search-count), not in the heading.
    const count = el("span", null, "ui-search-count");
    const find = el("div", null, "ui-search navp-search"); find.append(AtriumNavCommon.icon("search"), search, count); globalThis.AtriumUIKit?.adoptSearch(search);
    tools.append(find, modesRow);
    const scroller = el("div", null, "navp-scroll pane-scroll"); scroller.tabIndex = 0;
    scroller.setAttribute("role", "tree"); scroller.setAttribute("aria-label", "Compiled design");
    const inner = el("div", null, "navp-inner"); inner.setAttribute("role", "presentation");
    const empty = el("p", "Nothing matches.", "navp-empty"); empty.hidden = true;
    scroller.append(inner, empty);
    panel.append(head, tools, scroller);
    nav.append(panel);
    ui = {search, find, scroller, inner, count, empty};
    scroller.addEventListener("scroll", schedulePaint, {passive:true});
    inner.addEventListener("click", e => {
      const n = e.target.closest(".navp-row"); if (!n) return;
      const i = +n.dataset.index, r = rows[i]; if (!r) return;
      if (r.type === "group" || e.target.closest(".navp-twisty") && r.expandable) {active = i; toggleRow(r); return;}
      choose(i, false);
      probe(r);
    });
    inner.addEventListener("dblclick", e => {const n = e.target.closest(".navp-row"); const r = n && rows[+n.dataset.index]; if (r?.expandable) toggleRow(r);});
    scroller.addEventListener("keydown", keys);
    return true;
  }
  function keys(e) {
    const r = rows[active], page = Math.max(1, Math.floor((ui.scroller.clientHeight || 400) / ROW) - 1);
    const step = {ArrowDown:1, ArrowUp:-1, PageDown:page, PageUp:-page}[e.key];
    if (step) {e.preventDefault(); choose(Math.max(0, (active < 0 ? 0 : active) + step));}
    else if (e.key === "Home") {e.preventDefault(); choose(0);}
    else if (e.key === "End") {e.preventDefault(); choose(rows.length - 1);}
    else if (e.key === "ArrowRight" && r) {e.preventDefault(); if (!((r.type === "group" ? collapsed.has(r.group) : r.expandable && !r.open) && toggleRow(r, true))) choose(active + 1);}
    else if (e.key === "ArrowLeft" && r) {
      e.preventDefault();
      if ((r.type === "group" && r.open || r.expandable && r.open)) toggleRow(r, false);
      else {for (let k = active - 1; k >= 0; k--) if (rows[k].depth < r.depth) {choose(k); break;}}
    } else if ((e.key === "Enter" || e.key === " ") && r) {e.preventDefault(); if (r.type === "group") toggleRow(r); else probe(r);}
    else if (e.key === "Escape") {e.preventDefault(); pendingProbe = null; globalThis.AtriumQuery?.clear(true); host.setHighlight(""); host.canvas()?.focus();}
    else if (e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) {ui.search.focus(); return;}
    else return;
    e.stopPropagation();
  }
  function toggle(show) {
    if (!panel && !build()) return;
    cancelRefresh?.(); cancelRefresh = pendingProbe = null;
    const on = show ?? panel.hidden;
    panel.hidden = !on;
    document.body.classList.remove("hide-left");
    globalThis.AtriumNavCommon?.setChecked("navigator-panel", on);
    if (on) {compute(); refresh(); ui.scroller.focus({preventScroll:true}); host.info("Navigator: " + (current.parts.length) + " components, " + current.nets.length + " nets");}
    else {unfilteredRows = null; host.canvas()?.focus();}
  }
  function scheduleRefresh() {
    if (!panel || panel.hidden || !dirty || cancelRefresh) return;
    const run = () => {
      cancelRefresh = null;
      if (panel.hidden || !dirty) return;
      if (host.drag?.()?.before) {scheduleRefresh(); return;}
      // The undo recorder may be queued separately. Certify this generation once
      // here so Navigator and the live check can share the compiled result.
      const journal = globalThis.AtriumUndoStore;
      if (journal?.unrecorded?.()) journal.sync?.(host.project());
      compute();
      refresh();
      const action = pendingProbe;
      pendingProbe = null;
      if (!projectLoad) action?.();
    };
    if (host.stageEdit) {
      const task = host.stageEdit("idle", "navigator:model", current => {if (current()) run();});
      cancelRefresh = () => task?.cancel?.();
    } else {
      const timer = setTimeout(run, 0);
      cancelRefresh = () => clearTimeout(timer);
    }
  }
  function changed() {
    cancelRefresh?.(); cancelRefresh = null;
    dirty = true; pendingProbe = null;
    scheduleRefresh();
  }
  function attach(h) {
    host = h;
    host.registerAction("navigator-panel", () => toggle());
    host.on("change", changed);
    host.on("folder-owner", changed);
    host.on("replace", changed);
    host.on("document", () => {
      pendingProbe = null;
      if (!panel || panel.hidden) return;
      const project = host.project(), docs = project.documents, stamp = globalThis.AtriumUndoStore?.hierarchyVersion?.(project);
      // Native folders can hydrate another owner in the background before it is opened.
      if (modelOwner?.project !== project || modelOwner.stamp !== stamp ||
          modelOwner.documents.length !== docs.length || docs.some((d, i) => d !== modelOwner.documents[i])) changed();
      schedulePaint();
    });
    host.on("highlight", () => {if (panel && !panel.hidden) schedulePaint();});
  }
  if (typeof document !== "undefined") globalThis.AtriumNavCommon?.ready(attach);
  return {model, flatten, toggle, attach, isOpen:() => !!panel && !panel.hidden, rows:() => rows.slice(), modes:() => ({...modes})};
})();
